package main

// Вкладка «Баннеры»: набор PNG одного проекта одной кнопкой.
// 1) любой PNG больше 500 КБ уменьшаем до размера из имени (1380x248_R → 1380×248) и перезаписываем,
//    если всё ещё больше — переводим в 256 цветов;
// 2) файлы из списка bannerNames → JPG в одну папку;
// 3) эти JPG → WebP в другую папку.

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var bannerNames = []string{
	"4056x496_R", "2008x328_R", "1380x248_R", "1030x460_R", "800x260_R",
	"925x460_R", "945x370_R", "344x157_R", "344x157_C", "315x250",
}

const bannerLimit = 500 << 10 // PNG больше этого пережимаем

type BannerReq struct {
	Files    []string `json:"files"`
	JpgDir   string   `json:"jpgDir"`
	WebpDir  string   `json:"webpDir"`
	AutoDirs bool     `json:"autoDirs"` // папки JPEG и WebP рядом с папкой PNG вместо JpgDir и WebpDir
}

// bannerBase: папка первого PNG из списка. У копий из браузера настоящей папки нет, для них "".
func bannerBase(files []string) string {
	for _, p := range files {
		if bannerWanted(p) != "" && !isTemp(p) {
			return filepath.Dir(p)
		}
	}
	return ""
}

// BannerDirs: куда сохранять баннеры для этих PNG. *Found: папка уже есть на диске.
type BannerDirs struct {
	Base      string `json:"base"`
	JpgDir    string `json:"jpgDir"`
	WebpDir   string `json:"webpDir"`
	JpgFound  bool   `json:"jpgFound"`
	WebpFound bool   `json:"webpFound"`
}

// bannerFind: сначала там, где папку выбирали в прошлый раз (rel — путь от папки PNG),
// потом соседняя с папкой PNG с обычным именем. Если нигде нет — куда её создать: соседняя, names[0].
func bannerFind(base, rel string, names ...string) (string, bool) {
	var cands []string
	if rel != "" {
		cands = append(cands, filepath.Join(base, rel))
	}
	parent := filepath.Dir(base)
	for _, n := range names {
		cands = append(cands, filepath.Join(parent, n))
	}
	for _, c := range cands {
		if st, err := os.Stat(c); err == nil && st.IsDir() {
			return c, true
		}
	}
	return filepath.Join(parent, names[0]), false
}

// bannerDirs ищет папки JPEG и WebP для этих PNG. ok == false: настоящей папки у файлов нет.
func bannerDirs(files []string, st Settings) (d BannerDirs, ok bool) {
	d.Base = bannerBase(files)
	if d.Base == "" {
		return d, false
	}
	d.JpgDir, d.JpgFound = bannerFind(d.Base, st.BannerJpgRel, "JPEG", "JPG")
	d.WebpDir, d.WebpFound = bannerFind(d.Base, st.BannerWebpRel, "WebP")
	return d, true
}

// bannerDirsNow — bannerDirs с запомненным положением папок
func (s *Server) bannerDirsNow(files []string) (BannerDirs, bool) {
	s.mu.Lock()
	st := s.settings
	s.mu.Unlock()
	return bannerDirs(files, st)
}

// rememberBannerDirs запоминает, где папки лежат относительно папки PNG, чтобы найти их в следующем проекте.
// Пустой путь — без изменений. На другом диске относительного пути нет: в следующем проекте такой папки всё равно не найти.
func (s *Server) rememberBannerDirs(files []string, jpg, webp string) {
	base := bannerBase(files)
	if base == "" || (jpg == "" && webp == "") {
		return
	}
	rel := func(p string) string {
		r, err := filepath.Rel(base, p)
		if err != nil {
			return ""
		}
		return r
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if jpg != "" {
		s.settings.BannerJpgRel = rel(jpg)
	}
	if webp != "" {
		s.settings.BannerWebpRel = rel(webp)
	}
	saveSettings(s.settings) // под замком: порядок записи не перепутается
}

// x в имени бывает латинская, «×» или русская «х»
var bannerX = regexp.MustCompile(`[×хХ]`)
var bannerSize = regexp.MustCompile(`(\d+)x(\d+)`)

// bannerKey: имя без расширения в нижнем регистре, с латинской x и без пробелов
func bannerKey(path string) string {
	n := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	n = bannerX.ReplaceAllString(strings.ToLower(n), "x")
	return strings.Join(strings.Fields(n), "")
}

// bannerWanted: имя из списка, которому соответствует файл, или ""
func bannerWanted(path string) string {
	k := bannerKey(path)
	for _, n := range bannerNames {
		if strings.ToLower(n) == k {
			return n
		}
	}
	return ""
}

// bannerDims: ширина и высота из имени файла («4056x496_R» → 4056, 496)
func bannerDims(path string) (string, string, bool) {
	m := bannerSize.FindStringSubmatch(bannerKey(path))
	if m == nil {
		return "", "", false
	}
	return m[1], m[2], true
}

func ffQuiet(ctx context.Context, ffm string, args ...string) error {
	args = append([]string{"-hide_banner", "-nostdin", "-loglevel", "error", "-y"}, args...)
	cmd := exec.CommandContext(ctx, ffm, args...)
	hide(cmd)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s", errSummary(string(out), err, 2))
	}
	return nil
}

// replaceWait: сколько replaceFile ждёт, пока файл освободится
var replaceWait = 5 * time.Second

// replaceFile заменяет to файлом from. Пока to читает другой процесс (ffmpeg миниатюры, антивирус),
// Windows отвечает Access is denied, обычно это доли секунды, поэтому пробуем ещё. При отказе to не меняется.
func replaceFile(ctx context.Context, from, to string) error {
	end := time.Now().Add(replaceWait)
	for {
		err := os.Rename(from, to)
		if err == nil || !time.Now().Before(end) {
			return err
		}
		select {
		case <-ctx.Done():
			return err
		case <-time.After(50 * time.Millisecond):
		}
	}
}

// Границы подбора качества: от лучшего к худшему разумному. JPG: -q:v (меньше = лучше), WebP: -quality (больше = лучше).
var (
	bannerJpgQ  = [2]int{2, 12}
	bannerWebpQ = [2]int{100, 45}
)

// fitUnderLimit подбирает самое высокое качество, при котором файл path ≤ bannerLimit.
// best и worst — лучшее и худшее допустимое значение параметра (в любом порядке). enc кодирует с этим значением в path.
// Проб не больше 6 плюс финальное кодирование; сначала пробуем лучшее, большинство баннеров влезает сразу. Не влезло даже на худшем → false,
// файл остаётся с худшим качеством. Цель «не больше 500 КБ», а не «пожать посильнее».
func fitUnderLimit(ctx context.Context, rng [2]int, enc func(q int) error, path string) (bool, error) {
	dir := 1
	if rng[1] < rng[0] {
		dir = -1
	}
	// шаг i от 0 (лучшее) до n (худшее)
	n := (rng[1] - rng[0]) * dir
	at := func(i int) int { return rng[0] + i*dir }
	last := -1
	try := func(i int) (bool, error) {
		if err := enc(at(i)); err != nil {
			return false, err
		}
		last = i
		return fileSize(path) <= bannerLimit, nil
	}
	if fits, err := try(0); err != nil || fits {
		return fits, err
	}
	if fits, err := try(n); err != nil {
		return false, err
	} else if !fits {
		return false, nil // осталось худшее качество
	}
	lo, hi := 0, n // lo не влезает, hi влезает
	for probes := 0; probes < 4 && hi-lo > 1; probes++ {
		mid := (lo + hi) / 2
		fits, err := try(mid)
		if err != nil {
			return false, err
		}
		if fits {
			hi = mid
		} else {
			lo = mid
		}
		if ctx.Err() != nil {
			return false, ctx.Err()
		}
	}
	if last != hi {
		if err := enc(at(hi)); err != nil {
			return false, err
		}
	}
	return true, nil
}

// shrinkPNG уменьшает PNG до размера из имени и перезаписывает его. Возвращает, что сделано.
func shrinkPNG(ctx context.Context, ffm, src string) (string, error) {
	w, h, ok := bannerDims(src)
	if !ok {
		return "", errT("banner.noDims")
	}
	dir, name := filepath.Dir(src), filepath.Base(src)
	tmp, tmp2 := filepath.Join(dir, "_tmp_"+name), filepath.Join(dir, "_tmp2_"+name)
	defer os.Remove(tmp)
	defer os.Remove(tmp2)
	if err := ffQuiet(ctx, ffm, "-i", src, "-vf", "scale="+w+":"+h+":flags=lanczos",
		"-frames:v", "1", "-compression_level", "9", "-pred", "mixed", tmp); err != nil {
		return "", err
	}
	done, out := tr("banner.shrunk", w, h), tmp
	if fileSize(tmp) > bannerLimit {
		if err := ffQuiet(ctx, ffm, "-i", tmp, "-filter_complex",
			"split[a][b];[a]palettegen=max_colors=256[p];[b][p]paletteuse=dither=none", "-frames:v", "1", tmp2); err != nil {
			return "", err
		}
		done, out = done+tr("banner.colors"), tmp2
	}
	// пережатие теряет текстовые куски (parameters, kombain из галереи): переносим их в новый файл
	if err := copyPNGText(src, out); err != nil {
		return "", err
	}
	if err := replaceFile(ctx, out, src); err != nil {
		return "", err
	}
	return done, nil
}

func (s *Server) runBanners(req BannerReq, ffm string) {
	ctx, cancel := context.WithCancel(context.Background())
	var states []*FileState
	wanted := map[string]int{} // имя из списка → номер файла (дубли не берём)
	for i, p := range req.Files {
		st := &FileState{Path: p, Name: filepath.Base(p), Status: "pending", SrcSize: fileSize(p)}
		if n := bannerWanted(p); n != "" {
			if _, dup := wanted[n]; dup {
				st.Msg = tr("banner.dup")
			} else {
				wanted[n] = i
				st.Dst = filepath.Join(req.JpgDir, strings.TrimSuffix(st.Name, filepath.Ext(st.Name))+".jpg")
			}
		}
		states = append(states, st)
	}
	s.mu.Lock()
	s.files = states
	s.batch = "banner"
	s.running = true
	s.cancel = cancel
	s.summary = ""
	s.mu.Unlock()

	os.MkdirAll(req.JpgDir, 0o755)
	os.MkdirAll(req.WebpDir, 0o755)
	var ok, shrunk, bad int
	fail := func(i int, what string, err error) {
		bad++
		s.set(i, func(fs *FileState) { fs.Status = "error"; fs.Msg = what; fs.Hint = what + ": " + err.Error() })
		s.logT("log.bannerError", states[i].Name, what, err)
	}
	for i, st := range states {
		if ctx.Err() != nil {
			break
		}
		s.set(i, func(fs *FileState) { fs.Status = "running" })
		var notes []string
		if st.Msg != "" {
			notes = append(notes, st.Msg)
		}
		if st.SrcSize > bannerLimit {
			if isTemp(st.Path) {
				notes = append(notes, tr("banner.browserCopy"))
			} else if done, err := shrinkPNG(ctx, ffm, st.Path); err != nil {
				if ctx.Err() == nil {
					fail(i, tr("banner.shrinkFailed"), err)
				}
				continue
			} else {
				shrunk++
				notes = append(notes, fmt.Sprintf("PNG %s → %s, %s", fmtKB(st.SrcSize), fmtKB(fileSize(st.Path)), done))
				s.addLog("[png] %s: %s", st.Name, notes[len(notes)-1])
			}
		}
		if st.Dst != "" {
			stem := strings.TrimSuffix(st.Name, filepath.Ext(st.Name))
			webp := filepath.Join(req.WebpDir, stem+".webp")
			// JPG и WebP кодируем из исходного PNG, не друг из друга
			jfit, err := fitUnderLimit(ctx, bannerJpgQ, func(q int) error {
				return ffQuiet(ctx, ffm, "-i", st.Path, "-frames:v", "1", "-q:v", strconv.Itoa(q), st.Dst)
			}, st.Dst)
			if err != nil {
				if ctx.Err() == nil {
					fail(i, tr("banner.jpgFailed"), err)
				}
				continue
			}
			wfit, err := fitUnderLimit(ctx, bannerWebpQ, func(q int) error {
				return ffQuiet(ctx, ffm, "-i", st.Path, "-frames:v", "1", "-c:v", "libwebp", "-quality", strconv.Itoa(q), webp)
			}, webp)
			if err != nil {
				if ctx.Err() == nil {
					fail(i, tr("banner.webpFailed"), err)
				}
				continue
			}
			ok++
			notes = append(notes, fmt.Sprintf("JPG %s · WebP %s", fmtKB(fileSize(st.Dst)), fmtKB(fileSize(webp))))
			if !jfit {
				notes = append(notes, tr("banner.jpgBig"))
			}
			if !wfit {
				notes = append(notes, tr("banner.webpBig"))
			}
			s.addLog("[ok] %s → JPG + WebP", st.Name)
		} else if bannerWanted(st.Path) == "" {
			notes = append(notes, tr("banner.notListed"))
		}
		msg := strings.Join(notes, " · ")
		s.set(i, func(fs *FileState) { fs.Status = "ok"; fs.Pct = 100; fs.Msg = msg; fs.DstSize = fileSize(fs.Path) })
	}

	s.mu.Lock()
	canc := false
	for _, fs := range s.files {
		if fs.Status == "pending" || fs.Status == "running" {
			fs.Status = "canceled"
			canc = true
		}
	}
	title := tr("batch.done")
	if canc {
		title = tr("batch.stopped")
	}
	s.summary = tr("banner.summary", title, ok, len(wanted), shrunk, bad)
	s.running = false
	s.cancel = nil
	s.mu.Unlock()
	cancel()
	s.addLog("%s", s.summary)
}

func fmtKB(n int64) string { return tr("unit.kb", (n+512)>>10) }

// copyPNGText переносит текстовые куски (tEXt, zTXt, iTXt) из PNG from в PNG to сразу после IHDR.
// Нужен, чтобы пережатая картинка из галереи не теряла записанные в ней настройки генерации.
// Если в from кусков нет или он не читается как PNG, to не меняется.
func copyPNGText(from, to string) error {
	src, err := os.ReadFile(from)
	if err != nil {
		return err
	}
	var texts [][]byte
	if pngEach(src, func(typ string, data, raw []byte) bool {
		if pngTextKey(typ, data) != "" {
			texts = append(texts, raw)
		}
		return true
	}) != nil || len(texts) == 0 {
		return nil
	}
	dst, err := os.ReadFile(to)
	if err != nil {
		return err
	}
	var out bytes.Buffer
	out.Grow(len(dst) + 4096)
	out.Write(pngSig)
	done := false
	if pngEach(dst, func(typ string, data, raw []byte) bool {
		if pngTextKey(typ, data) != "" { // тот же кусок, что уже есть, не дублируем
			for _, t := range texts {
				if bytes.Equal(t, raw) {
					return true
				}
			}
		}
		out.Write(raw)
		if typ == "IHDR" && !done {
			done = true
			for _, t := range texts {
				out.Write(t)
			}
		}
		return true
	}) != nil || !done {
		return nil // странный результат ffmpeg: оставляем как есть
	}
	return os.WriteFile(to, out.Bytes(), 0o644)
}
