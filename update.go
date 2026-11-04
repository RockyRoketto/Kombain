package main

// Версии: своя версия программы, настройки, проверка свежего ffmpeg.

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	appVersion = "1.8.0"
	appAuthor  = "Dmitrii Trudnikov"
)

// источники ffmpeg (FFB_FEED подменяет их локальным сервером — только для тестов)
var (
	gyanVersionURL = "https://www.gyan.dev/ffmpeg/builds/release-version"
	gyanZipURL     = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
	btbnAPIURL     = "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/tags/latest"
	btbnMasterURL  = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
)

func init() {
	if f := strings.TrimRight(os.Getenv("FFB_FEED"), "/"); f != "" {
		gyanVersionURL = f + "/release-version"
		gyanZipURL = f + "/ffmpeg.zip"
		btbnAPIURL = f + "/btbn.json"
		btbnMasterURL = f + "/master.zip"
	}
}

// ---------- настройки ----------

type Settings struct {
	SkipFFmpeg    string `json:"skipFFmpeg,omitempty"`    // «пропустить эту версию ffmpeg»
	SetupDeclined string `json:"setupDeclined,omitempty"` // версия программы, на которой нажали «без установки»
	SkipApp       string `json:"skipApp,omitempty"`       // «пропустить эту версию Конвертера»
	SeenVersion   string `json:"seenVersion,omitempty"`   // до какой версии показали «Что нового», см. whatsnew.go
	Theme         string `json:"theme,omitempty"`         // тема оформления, см. theme.go; пусто = тёмная
	Lang          string `json:"lang,omitempty"`          // язык интерфейса, см. i18n.go; пусто = русский
	BannerJpgRel  string `json:"bannerJpgRel,omitempty"`  // где папка JPEG относительно папки PNG, см. banner.go
	BannerWebpRel string `json:"bannerWebpRel,omitempty"` // то же для WebP
}

func settingsPath() string { return filepath.Join(dataDir(), "settings.json") }

func loadSettings() Settings {
	var st Settings
	if b, err := os.ReadFile(settingsPath()); err == nil {
		json.Unmarshal(b, &st)
	}
	return st
}

var settingsMu sync.Mutex

func saveSettings(st Settings) error {
	settingsMu.Lock()
	defer settingsMu.Unlock()
	if err := os.MkdirAll(dataDir(), 0o755); err != nil {
		return err
	}
	// копия программы, открытая раньше, держит в памяти старые настройки: «Что нового» не должно от этого вернуться
	if seen := loadSettings().SeenVersion; seen != "" && cmpVer(seen, st.SeenVersion) > 0 {
		st.SeenVersion = seen
	}
	b, _ := json.MarshalIndent(st, "", "  ")
	f, err := os.CreateTemp(dataDir(), "settings-*.part") // своё имя: другая копия не подменит файл на полпути
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	_, err = f.Write(b)
	if e := f.Close(); err == nil {
		err = e
	}
	if err != nil {
		return err
	}
	return replaceFile(context.Background(), tmp, settingsPath()) // антивирус может держать файл долю секунды
}

// ---------- версии ----------

var (
	ffVerLineRe = regexp.MustCompile(`ffmpeg version (\S+)`)
	relVerRe    = regexp.MustCompile(`^[nN]?(\d+(?:\.\d+)+)`)
	plainVerRe  = regexp.MustCompile(`^\d+(?:\.\d+)+$`)
	btbnAssetRe = regexp.MustCompile(`^ffmpeg-n(\d+(?:\.\d+)+)-latest-win64-gpl-[\d.]+\.zip$`)
)

// cmpVer сравнивает «7.1» и «7.0.2» по числам: -1, 0, 1
func cmpVer(a, b string) int {
	pa, pb := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var x, y int
		if i < len(pa) {
			x, _ = strconv.Atoi(pa[i])
		}
		if i < len(pb) {
			y, _ = strconv.Atoi(pb[i])
		}
		if x != y {
			if x < y {
				return -1
			}
			return 1
		}
	}
	return 0
}

// parseFFVersion: из «ffmpeg version 7.0.2-essentials_build-www.gyan.dev ...» достаёт
// raw = «7.0.2-essentials_build-www.gyan.dev» и ver = «7.0.2».
// У сборок из git («N-117000-g…», «2025-10-30-git-…») ver пустой: номер релиза неизвестен.
func parseFFVersion(out string) (ver, raw string) {
	m := ffVerLineRe.FindStringSubmatch(out)
	if m == nil {
		return "", ""
	}
	raw = m[1]
	if v := relVerRe.FindStringSubmatch(raw); v != nil {
		ver = v[1]
	}
	return ver, raw
}

func localFFVersion(ffm string) (ver, raw string) {
	if ffm == "" {
		return "", ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, ffm, "-version")
	hide(cmd)
	out, _ := cmd.Output()
	return parseFFVersion(string(out))
}

var httpc = &http.Client{Timeout: 15 * time.Second}

func httpGet(url string, limit int64) ([]byte, error) {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Konvertor9000/"+appVersion)
	resp, err := httpc.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, &httpErr{resp.StatusCode}
	}
	return io.ReadAll(io.LimitReader(resp.Body, limit))
}

type httpErr struct{ code int }

func (e *httpErr) Error() string { return "HTTP " + strconv.Itoa(e.code) }

// latestFFmpeg узнаёт номер свежего релиза ffmpeg и откуда его качать (по порядку).
// Сначала gyan.dev (там же качаем), потом релизные сборки BtbN на GitHub.
func latestFFmpeg() (ver string, urls []string, err error) {
	if b, e := httpGet(gyanVersionURL, 64); e == nil {
		if v := strings.TrimSpace(string(b)); plainVerRe.MatchString(v) {
			ver = v
			urls = append(urls, gyanZipURL)
		}
	} else {
		err = e
	}

	if b, e := httpGet(btbnAPIURL, 4<<20); e == nil {
		var rel struct {
			Assets []struct {
				Name string `json:"name"`
				URL  string `json:"browser_download_url"`
			} `json:"assets"`
		}
		if json.Unmarshal(b, &rel) == nil {
			type cand struct{ ver, url string }
			var cs []cand
			for _, a := range rel.Assets {
				if m := btbnAssetRe.FindStringSubmatch(a.Name); m != nil {
					cs = append(cs, cand{m[1], a.URL})
				}
			}
			sort.Slice(cs, func(i, j int) bool { return cmpVer(cs[i].ver, cs[j].ver) > 0 })
			if len(cs) > 0 {
				if ver == "" {
					ver = cs[0].ver
				}
				urls = append(urls, cs[0].url)
			}
		}
	} else if err == nil {
		err = e
	}

	if ver != "" {
		err = nil
	}
	if len(urls) == 0 {
		urls = []string{gyanZipURL}
	}
	urls = append(urls, btbnMasterURL) // самый последний запасной вариант: свежая сборка из git
	return ver, urls, err
}

// FFVer — что известно о версиях ffmpeg (уходит в интерфейс)
type FFVer struct {
	Local    string `json:"local"`    // «7.0.2»; пусто, если ffmpeg нет или это сборка из git
	LocalRaw string `json:"localRaw"` // как ffmpeg сам себя называет
	Latest   string `json:"latest"`   // свежий релиз; пусто, если проверить не удалось
	Checking bool   `json:"checking"`
	Checked  bool   `json:"checked"`
	CheckErr string `json:"checkErr,omitempty"`
	Update   bool   `json:"update"`  // есть ffmpeg и есть версия новее
	Skipped  bool   `json:"skipped"` // эту версию просили пропустить
}

// refreshFF пересчитывает поля, зависящие от локального ffmpeg и настроек (под s.mu)
func (s *Server) refreshFFLocked() {
	v := &s.ffv
	v.Update = s.ffmpeg != "" && v.Local != "" && v.Latest != "" && cmpVer(v.Latest, v.Local) > 0
	v.Skipped = v.Latest != "" && v.Latest == s.settings.SkipFFmpeg
}

func (s *Server) setLocalFF() {
	s.mu.Lock()
	ffm := s.ffmpeg
	s.mu.Unlock()
	ver, raw := localFFVersion(ffm)
	s.mu.Lock()
	s.ffv.Local, s.ffv.LocalRaw = ver, raw
	s.refreshFFLocked()
	s.mu.Unlock()
}

// checkFFmpeg: при запуске смотрим локальную версию и свежий релиз (в фоне)
func (s *Server) checkFFmpeg() {
	s.mu.Lock()
	s.ffv.Checking = true
	s.mu.Unlock()
	s.setLocalFF()
	s.checkLatestFF()
}

// checkLatestFF узнаёт свежий релиз: при запуске и потом из watchUpdates. В лог пишем только перемены.
func (s *Server) checkLatestFF() {
	ver, urls, err := latestFFmpeg()
	s.mu.Lock()
	wasErr, prev := s.ffv.CheckErr != "", s.ffv.Latest
	s.ffv.Checking, s.ffv.Checked = false, true
	if ver != "" || prev == "" { // пропавшая сеть не стирает то, что уже узнали
		s.ffv.Latest = ver
		s.ffURLs = urls
	}
	s.ffv.CheckErr = ""
	if err != nil {
		s.ffv.CheckErr = err.Error()
	}
	s.refreshFFLocked()
	s.mu.Unlock()
	if err != nil {
		if !wasErr {
			s.logT("log.ffCheckFailed", err)
		}
	} else if ver != "" && ver != prev {
		s.logT("log.ffLatest", ver)
	}
}

// InstallInfo — установлена ли программа и что предложить
type InstallInfo struct {
	Supported bool   `json:"supported"`
	Installed bool   `json:"installed"` // запущена из папки установки
	Dir       string `json:"dir"`
	Version   string `json:"version"` // какая версия установлена ("" — никакая)
	Offer     string `json:"offer"`   // "", "install", "upgrade"
}
