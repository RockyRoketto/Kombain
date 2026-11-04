package main

// Обновление самой программы: свежий релиз на GitHub (Releases) → скачать Konvertor.exe → заменить себя → перезапуск.
// Релизы собирает GitHub Actions (.github/workflows/release.yml) по тегу vX.Y.Z.

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const updateRepo = "RockyRoketto/Konverter-9000"

// FFB_FEED подменяет и этот адрес (/app-release.json) — только для тестов
var appReleaseURL = "https://api.github.com/repos/" + updateRepo + "/releases/latest"

func init() {
	if f := strings.TrimRight(os.Getenv("FFB_FEED"), "/"); f != "" {
		appReleaseURL = f + "/app-release.json"
	}
}

// AppUpd — что известно о новой версии программы (уходит в интерфейс)
type AppUpd struct {
	Supported bool    `json:"supported"` // умеем ли заменить себя (только Windows)
	Checked   bool    `json:"checked"`
	CheckErr  string  `json:"checkErr,omitempty"`
	Latest    string  `json:"latest"`  // «1.5.0»; пусто — не знаем
	Notes     string  `json:"notes"`   // что нового (текст релиза)
	NotesEn   string  `json:"notesEn"` // то же по-английски; пусто, если в релизе его нет
	Page      string  `json:"page"`    // страница релиза
	Update    bool    `json:"update"`  // есть версия новее нашей
	Skipped   bool    `json:"skipped"`
	Active    bool    `json:"active"` // качается
	Pct       float64 `json:"pct"`
	Err       string  `json:"err,omitempty"`
	Restart   bool    `json:"restart"` // заменили, перезапускаемся

	url    string
	size   int64
	sha256 string
}

type appRelease struct {
	ver, notes, notesEn, page, url, sha256 string
	size                                   int64
}

// В тексте релиза сначала идёт русский раздел, потом после этой строки английский (см. release.yml).
var notesEnRe = regexp.MustCompile(`(?m)^### English[ \t\r]*$`)

// splitNotes делит текст релиза по языкам. У старых релизов английской части нет.
func splitNotes(body string) (ru, en string) {
	short := func(s string) string {
		s = strings.TrimSpace(s)
		if r := []rune(s); len(r) > 1500 {
			return string(r[:1500]) + "…"
		}
		return s
	}
	if loc := notesEnRe.FindStringIndex(body); loc != nil {
		return short(body[:loc[0]]), short(body[loc[1]:])
	}
	return short(body), ""
}

// latestApp разбирает ответ GitHub: тег «v1.5.0», файл Konvertor.exe
func latestApp() (appRelease, error) {
	b, err := httpGet(appReleaseURL, 4<<20)
	if err != nil {
		return appRelease{}, err
	}
	var rel struct {
		Tag    string `json:"tag_name"`
		Body   string `json:"body"`
		Page   string `json:"html_url"`
		Draft  bool   `json:"draft"`
		Pre    bool   `json:"prerelease"`
		Assets []struct {
			Name   string `json:"name"`
			URL    string `json:"browser_download_url"`
			Size   int64  `json:"size"`
			Digest string `json:"digest"` // «sha256:…»
		} `json:"assets"`
	}
	if err := json.Unmarshal(b, &rel); err != nil {
		return appRelease{}, errT("upd.badAnswer")
	}
	ver := strings.TrimPrefix(strings.TrimPrefix(strings.TrimSpace(rel.Tag), "v"), "V")
	if !plainVerRe.MatchString(ver) || rel.Draft || rel.Pre {
		return appRelease{}, errT("upd.noVersion")
	}
	r := appRelease{ver: ver, page: rel.Page}
	r.notes, r.notesEn = splitNotes(rel.Body)
	for _, a := range rel.Assets {
		if strings.EqualFold(a.Name, "Konvertor.exe") {
			r.url, r.size = a.URL, a.Size
			if d, ok := strings.CutPrefix(a.Digest, "sha256:"); ok {
				r.sha256 = strings.ToLower(d)
			}
		}
	}
	if r.url == "" {
		return appRelease{}, errT("upd.noExe", ver)
	}
	return r, nil
}

func (s *Server) refreshAppLocked() {
	u := &s.appUpd
	u.Update = u.Latest != "" && cmpVer(u.Latest, appVersion) > 0
	u.Skipped = u.Latest != "" && u.Latest == s.settings.SkipApp
}

// checkApp спрашивает GitHub, нет ли версии новее: при запуске и потом из watchUpdates.
// В лог пишем только перемены, иначе открытая неделями программа засорит его одним и тем же.
func (s *Server) checkApp() {
	rel, err := latestApp()
	s.mu.Lock()
	u := &s.appUpd
	wasErr, prev := u.CheckErr != "", u.Latest
	u.Supported = canSelfUpdate()
	u.Checked = true
	if err != nil {
		u.CheckErr = err.Error()
	} else {
		u.CheckErr = ""
		if rel.ver != prev {
			u.Err = "" // ошибка прошлой попытки обновиться относилась к старой версии
		}
		u.Latest, u.Notes, u.NotesEn, u.Page = rel.ver, rel.notes, rel.notesEn, rel.page
		u.url, u.size, u.sha256 = rel.url, rel.size, rel.sha256
	}
	s.refreshAppLocked()
	upd := u.Update
	s.mu.Unlock()
	if err != nil {
		if !wasErr {
			s.logT("log.appCheckFailed", err)
		}
	} else if upd && rel.ver != prev {
		s.logT("log.appNew", rel.ver)
	}
}

// Пока программа открыта, обновления проверяются раз в updateEvery.
// На один запуск это несколько запросов к GitHub за сутки: лимит без входа считается на адрес, а в офисе он общий.
const (
	updateEvery = 6 * time.Hour
	updateTick  = time.Minute
)

// updateDue: пора ли проверять снова. Часы перевели назад — тоже пора, иначе ждали бы их долго.
func updateDue(last, now time.Time) bool {
	d := now.Sub(last)
	return d >= updateEvery || d < 0
}

// watchUpdates повторяет проверку, пока программа открыта.
// Round(0) убирает монотонные часы: сравниваем обычное время, и после спящего режима проверка не опоздает.
func (s *Server) watchUpdates() {
	last := time.Now().Round(0)
	for {
		time.Sleep(updateTick)
		now := time.Now().Round(0)
		if updateDue(last, now) {
			last = now
			s.recheckUpdates()
		}
	}
}

// recheckUpdates не трогает то, что сейчас скачивается: плашка не должна менять текст на ходу
func (s *Server) recheckUpdates() {
	s.mu.Lock()
	app := !s.appUpd.Active && !s.appUpd.Restart
	ff := !s.dl.Active
	s.mu.Unlock()
	if app {
		s.checkApp()
	}
	if ff {
		s.checkLatestFF()
	}
}

// updateApp качает новый exe и ставит его на место текущего, потом перезапускает программу
func (s *Server) updateApp() error {
	s.mu.Lock()
	u := &s.appUpd
	switch {
	case u.Active || u.Restart:
		s.mu.Unlock()
		return nil
	case !u.Supported:
		s.mu.Unlock()
		return errT("upd.onlyWindows")
	case !u.Update || u.url == "":
		s.mu.Unlock()
		return errT("upd.noUpdate")
	case s.running:
		s.mu.Unlock()
		return errT("err.waitConvert")
	}
	u.Active, u.Pct, u.Err = true, 0, ""
	url, size, sum, ver := u.url, u.size, u.sha256, u.Latest
	s.mu.Unlock()

	go func() {
		path, err := s.fetchApp(url, size, sum)
		if err == nil {
			s.mu.Lock()
			if s.running { // вдруг успели запустить конвертацию, пока качалось
				err = errT("err.waitConvert")
			}
			// «без установки» нажимали на этой версии — не спрашиваем снова на новой
			st := s.settings
			if st.SetupDeclined == appVersion {
				st.SetupDeclined = ver
				s.settings = st
			}
			s.mu.Unlock()
			if err == nil {
				saveSettings(st)
				err = replaceSelf(path)
			}
		}
		if err != nil {
			os.Remove(filepath.Join(dataDir(), "update", "Konvertor.exe"))
			s.mu.Lock()
			s.appUpd.Active, s.appUpd.Err = false, err.Error()
			s.mu.Unlock()
			s.logT("log.appUpdateFailed", err)
			return
		}
		s.mu.Lock()
		s.appUpd.Active, s.appUpd.Pct, s.appUpd.Restart = false, 100, true
		s.mu.Unlock()
		s.logT("log.appUpdated", ver)
		restartSelf(s)
	}()
	return nil
}

// fetchApp скачивает exe в dataDir/update и проверяет размер, сумму и что это вообще exe
func (s *Server) fetchApp(url string, size int64, sum string) (string, error) {
	dir := filepath.Join(dataDir(), "update")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(dir, "Konvertor.exe")
	h := sha256.New()
	n, err := download(url, path, size, 200<<20, h, func(p float64) {
		s.mu.Lock()
		s.appUpd.Pct = p
		s.mu.Unlock()
	})
	if err != nil {
		return "", err
	}
	if size > 0 && n != size {
		return "", errT("upd.shortFile", n, size)
	}
	if sum != "" && hex.EncodeToString(h.Sum(nil)) != sum {
		return "", errT("upd.badSum")
	}
	head := make([]byte, 2)
	if f, err := os.Open(path); err == nil {
		io.ReadFull(f, head)
		f.Close()
	}
	if !bytes.Equal(head, []byte("MZ")) {
		return "", errT("upd.notExe")
	}
	return path, nil
}
