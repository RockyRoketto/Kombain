package main

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed index.html
var indexHTML string

//go:embed hero.jpg
var heroJPG []byte

//go:embed favicon.png
var faviconPNG []byte

// ---------- форматы ----------

type Format struct {
	Ext  string
	Kind string // video, audio, image, gif, copy
	Args []string
}

var formats = map[string]Format{
	"mp4":     {"mp4", "video", []string{"-c:v", "libx264", "-preset", "{preset}", "-crf", "{crf}", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "{abr}k", "-movflags", "+faststart"}},
	"mp4h265": {"mp4", "video", []string{"-c:v", "libx265", "-preset", "{preset}", "-crf", "{crf}", "-pix_fmt", "yuv420p", "-tag:v", "hvc1", "-c:a", "aac", "-b:a", "{abr}k", "-movflags", "+faststart"}},
	"webm":    {"webm", "video", []string{"-c:v", "libvpx-vp9", "-crf", "{crf}", "-b:v", "0", "-c:a", "libopus", "-b:a", "{abr}k"}},
	"mov":     {"mov", "video", []string{"-c:v", "libx264", "-preset", "{preset}", "-crf", "{crf}", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "{abr}k"}},
	"mkv":     {"mkv", "copy", []string{"-c", "copy"}},
	"gif":     {"gif", "gif", nil},
	"mp3":     {"mp3", "audio", []string{"-vn", "-c:a", "libmp3lame", "-b:a", "{abr}k"}},
	"m4a":     {"m4a", "audio", []string{"-vn", "-c:a", "aac", "-b:a", "{abr}k"}},
	"ogg":     {"ogg", "audio", []string{"-vn", "-c:a", "libopus", "-b:a", "{abr}k"}},
	"wav":     {"wav", "audio", []string{"-vn", "-c:a", "pcm_s16le"}},
	"flac":    {"flac", "audio", []string{"-vn", "-c:a", "flac"}},
	"png":     {"png", "image", nil},
	"jpg":     {"jpg", "image", []string{"-q:v", "2"}},
	"webp":    {"webp", "image", []string{"-quality", "85"}},
}

var presets = map[string]bool{"ultrafast": true, "veryfast": true, "fast": true, "medium": true, "slow": true}

var mediaExt = map[string]bool{
	".mp4": true, ".mov": true, ".mkv": true, ".avi": true, ".webm": true, ".flv": true, ".wmv": true,
	".m4v": true, ".mpg": true, ".mpeg": true, ".ts": true, ".mts": true, ".3gp": true, ".gif": true,
	".mp3": true, ".wav": true, ".flac": true, ".m4a": true, ".aac": true, ".ogg": true, ".opus": true,
	".wma": true, ".png": true, ".jpg": true, ".jpeg": true, ".webp": true, ".bmp": true, ".tif": true, ".tiff": true,
}

// ---------- состояние ----------

type FileInfo struct {
	Path string `json:"path"`
	Size int64  `json:"size"`
}

type FileState struct {
	Path    string  `json:"path"`
	Name    string  `json:"name"`
	Dst     string  `json:"dst"`
	Status  string  `json:"status"` // pending, running, ok, error, skipped, canceled
	Pct     float64 `json:"pct"`
	Msg     string  `json:"msg"`
	Hint    string  `json:"hint"` // понятное человеку объяснение ошибки
	SrcSize int64   `json:"srcSize"`
	DstSize int64   `json:"dstSize"`
}

type DL struct {
	Active bool    `json:"active"`
	Pct    float64 `json:"pct"`
	Err    string  `json:"err"`
}

type Server struct {
	mu      sync.Mutex
	token   string
	host    string
	last    time.Time
	ffmpeg  string
	dl      DL
	running bool
	files   []*FileState
	log     []string
	summary string
	cancel  context.CancelFunc

	ffv      FFVer       // версии ffmpeg: своя и свежая
	ffURLs   []string    // откуда качать свежий ffmpeg (по порядку)
	settings Settings    // settings.json
	inst     InstallInfo // установлена ли программа
	appUpd   AppUpd      // новая версия самой программы
}

type StartReq struct {
	Files     []string `json:"files"`
	Format    string   `json:"format"`
	CRF       int      `json:"crf"`
	ABR       int      `json:"abr"`
	Preset    string   `json:"preset"`
	Height    string   `json:"height"`
	FPS       string   `json:"fps"`
	Extra     string   `json:"extra"`
	OutDir    string   `json:"outDir"`
	DropOut   string   `json:"dropOut"` // куда класть перетащенные файлы в режиме «рядом с оригиналом»
	SameDir   bool     `json:"sameDir"`
	Overwrite bool     `json:"overwrite"`
	Copy      bool     `json:"copy"` // если результат уже есть — сделать копию «имя (1).mp4»
	Jobs      int      `json:"jobs"`
}

func ffName() string {
	if runtime.GOOS == "windows" {
		return "ffmpeg.exe"
	}
	return "ffmpeg"
}

func dataDir() string {
	d, err := os.UserCacheDir()
	if err != nil {
		d = os.TempDir()
	}
	return filepath.Join(d, "ffmpeg-batch")
}

// сюда копируются файлы, перетащенные в окно браузера (пути у них недоступны)
func dropDir() string { return filepath.Join(dataDir(), "drop") }

func defaultOut() string {
	home, err := os.UserHomeDir()
	if err != nil {
		home = os.TempDir()
	}
	return filepath.Join(home, "Videos", "Konvertor")
}

func isTemp(p string) bool {
	rel, err := filepath.Rel(dropDir(), p)
	return err == nil && rel != "." && !filepath.IsAbs(rel) && !strings.HasPrefix(rel, "..")
}

func cleanupTemp(p string) {
	d := filepath.Dir(p)
	if isTemp(p) && d != dropDir() {
		os.RemoveAll(d)
	}
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

func fileSize(p string) int64 {
	if st, err := os.Stat(p); err == nil {
		return st.Size()
	}
	return 0
}

// порядок: скачанный программой (его она умеет обновлять) → рядом с exe → PATH
func findFFmpeg() string {
	p := filepath.Join(dataDir(), ffName())
	if fileExists(p) {
		return p
	}
	if exe, err := os.Executable(); err == nil {
		p := filepath.Join(filepath.Dir(exe), ffName())
		if fileExists(p) {
			return p
		}
	}
	if p, err := exec.LookPath("ffmpeg"); err == nil {
		return p
	}
	return ""
}

func (s *Server) addLog(format string, a ...any) {
	line := fmt.Sprintf(format, a...)
	s.mu.Lock()
	s.log = append(s.log, line)
	if len(s.log) > 500 {
		s.log = s.log[len(s.log)-500:]
	}
	s.mu.Unlock()
}

// ---------- скачивание ffmpeg ----------

type countReader struct {
	r     io.Reader
	n     int64
	total int64
	cb    func(float64)
}

func (c *countReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	if c.total > 0 {
		c.cb(float64(c.n) / float64(c.total) * 100)
	}
	return n, err
}

// downloadFFmpeg скачивает (или обновляет) ffmpeg в dataDir. Пока идёт конвертация — нельзя:
// работающий ffmpeg.exe Windows заменить не даст.
func (s *Server) downloadFFmpeg() error {
	s.mu.Lock()
	if s.dl.Active {
		s.mu.Unlock()
		return nil
	}
	if s.running {
		s.mu.Unlock()
		return fmt.Errorf("сначала дождись конца конвертации")
	}
	s.dl = DL{Active: true}
	urls := s.ffURLs
	s.mu.Unlock()
	if len(urls) == 0 {
		urls = []string{gyanZipURL, btbnMasterURL}
	}

	go func() {
		var lastErr error
		for _, u := range urls {
			if err := s.tryDownload(u); err != nil {
				s.addLog("ffmpeg: %s — %v", u, err)
				lastErr = err
				continue
			}
			lastErr = nil
			break
		}
		s.mu.Lock()
		if lastErr == nil {
			s.ffmpeg = findFFmpeg()
		}
		s.mu.Unlock()
		if lastErr == nil {
			s.setLocalFF()
		}
		s.mu.Lock()
		s.dl.Active = false
		if lastErr != nil {
			s.dl.Err = lastErr.Error()
		} else {
			s.dl.Err = ""
			s.dl.Pct = 100
		}
		ver := s.ffv.LocalRaw
		s.mu.Unlock()
		if lastErr == nil {
			s.addLog("ffmpeg готов: %s", ver)
		}
	}()
	return nil
}

func (s *Server) tryDownload(url string) error {
	dir := dataDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "Konvertor9000/"+appVersion)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	zipPath := filepath.Join(dir, "ffmpeg.zip.part")
	out, err := os.Create(zipPath)
	if err != nil {
		return err
	}
	cr := &countReader{r: resp.Body, total: resp.ContentLength, cb: func(p float64) {
		s.mu.Lock()
		s.dl.Pct = p
		s.mu.Unlock()
	}}
	if _, err := io.Copy(out, cr); err != nil {
		out.Close()
		os.Remove(zipPath)
		return err
	}
	out.Close()
	defer os.Remove(zipPath)

	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return err
	}
	defer zr.Close()
	for _, f := range zr.File {
		name := strings.ToLower(f.Name)
		if strings.HasSuffix(name, "bin/ffmpeg.exe") || strings.HasSuffix(name, "bin/ffmpeg") {
			rc, err := f.Open()
			if err != nil {
				return err
			}
			tmp := filepath.Join(dir, ffName()+".part")
			w, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
			if err != nil {
				rc.Close()
				return err
			}
			_, err = io.Copy(w, rc)
			rc.Close()
			w.Close()
			if err != nil {
				os.Remove(tmp)
				return err
			}
			return os.Rename(tmp, filepath.Join(dir, ffName()))
		}
	}
	return fmt.Errorf("ffmpeg не найден в архиве")
}

// ---------- выбор файлов ----------

func infos(paths []string) []FileInfo {
	res := make([]FileInfo, 0, len(paths))
	for _, p := range paths {
		res = append(res, FileInfo{Path: p, Size: fileSize(p)})
	}
	return res
}

func walkMedia(dir string) []FileInfo {
	var found []string
	filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() && mediaExt[strings.ToLower(filepath.Ext(p))] {
			found = append(found, p)
		}
		return nil
	})
	return infos(found)
}

// expandPaths: файлы берём как есть, папки разворачиваем в медиафайлы
func expandPaths(paths []string) []FileInfo {
	var out []FileInfo
	seen := map[string]bool{}
	for _, p := range paths {
		st, err := os.Stat(p)
		if err != nil {
			continue
		}
		var list []FileInfo
		if st.IsDir() {
			list = walkMedia(p)
		} else {
			list = []FileInfo{{Path: p, Size: st.Size()}}
		}
		for _, f := range list {
			if !seen[f.Path] {
				seen[f.Path] = true
				out = append(out, f)
			}
		}
	}
	return out
}

func openFolder(dir string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("explorer", dir)
	case "darwin":
		cmd = exec.Command("open", dir)
	default:
		cmd = exec.Command("xdg-open", dir)
	}
	cmd.Start()
}

// ---------- конвертация ----------

var durRe = regexp.MustCompile(`Duration: (\d+):(\d+):(\d+(?:\.\d+)?)`)
var numRe = regexp.MustCompile(`^\d+(\.\d+)?$`)
var badName = regexp.MustCompile(`[<>:"/\\|?*\x00-\x1f]`)

var alphaRe = regexp.MustCompile(`\b(yuva\w*|rgba\w*|argb|bgra|abgr|gbrap\w*|ya8|ya16\w*|pal8)\b`)

type srcInfo struct {
	dur   float64
	alpha bool
}

func probe(ffm, src string) srcInfo {
	cmd := exec.Command(ffm, "-hide_banner", "-i", src)
	hide(cmd)
	out, _ := cmd.CombinedOutput()
	var si srcInfo
	if m := durRe.FindSubmatch(out); m != nil {
		h, _ := strconv.ParseFloat(string(m[1]), 64)
		mi, _ := strconv.ParseFloat(string(m[2]), 64)
		sec, _ := strconv.ParseFloat(string(m[3]), 64)
		si.dur = h*3600 + mi*60 + sec
	}
	for _, line := range strings.Split(string(out), "\n") {
		if strings.Contains(line, "Stream #") && strings.Contains(line, "Video:") {
			si.alpha = alphaRe.MatchString(line)
			break
		}
	}
	return si
}

// скорость VP9: чем больше cpu-used, тем быстрее (по умолчанию libvpx жутко медленный)
var vp9Speed = map[string]string{"ultrafast": "5", "veryfast": "4", "fast": "3", "medium": "2", "slow": "1"}

func num(s string) string {
	s = strings.TrimSpace(s)
	if numRe.MatchString(s) {
		return s
	}
	return ""
}

func buildArgs(f Format, req StartReq, src, dst string, si srcInfo, safe bool) []string {
	preset := req.Preset
	if !presets[preset] {
		preset = "medium"
	}
	rep := strings.NewReplacer("{crf}", strconv.Itoa(req.CRF), "{abr}", strconv.Itoa(req.ABR), "{preset}", preset)
	var fargs []string
	for _, a := range f.Args {
		fargs = append(fargs, rep.Replace(a))
	}
	h, fps := num(req.Height), num(req.FPS)

	args := []string{"-hide_banner", "-nostdin", "-loglevel", "error", "-progress", "pipe:1", "-nostats"}
	if req.Overwrite {
		args = append(args, "-y")
	} else if fileExists(dst) && fileSize(dst) == 0 {
		args = append(args, "-y") // пустой огрызок от прошлой попытки
	} else {
		args = append(args, "-n")
	}
	args = append(args, "-i", src)

	switch f.Kind {
	case "gif":
		if fps == "" {
			fps = "15"
		}
		if h == "" {
			h = "480"
		}
		fc := fmt.Sprintf("[0:v]fps=%s,scale=-1:%s:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse", fps, h)
		args = append(args, "-filter_complex", fc, "-loop", "0")
	case "image":
		args = append(args, "-frames:v", "1")
		if h != "" {
			args = append(args, "-vf", "scale=-1:"+h)
		}
		args = append(args, fargs...)
	case "video":
		args = append(args, fargs...)
		if f.Ext == "webm" {
			// 8 бит (profile 0): работает в любой сборке ffmpeg и в любом браузере.
			// 10-битные исходники (HDR с iPhone) иначе падают с "Invalid argument"
			pf := "yuv420p"
			if si.alpha {
				pf = "yuva420p"
			}
			args = append(args, "-pix_fmt", pf, "-row-mt", "1", "-deadline", "good", "-cpu-used", vp9Speed[preset])
		}
		if safe {
			// повтор: ровная частота кадров и стандартный формат пикселей
			args = append(args, "-fps_mode", "cfr", "-max_muxing_queue_size", "4096")
			if f.Ext != "webm" {
				args = append(args, "-pix_fmt", "yuv420p")
			}
		}
		var vf []string
		if h != "" {
			vf = append(vf, "scale=-2:"+h)
		}
		if fps != "" {
			vf = append(vf, "fps="+fps)
		}
		if len(vf) > 0 {
			args = append(args, "-vf", strings.Join(vf, ","))
		}
	default:
		args = append(args, fargs...)
	}
	if e := strings.TrimSpace(req.Extra); e != "" {
		args = append(args, strings.Fields(e)...)
	}
	return append(args, dst)
}

func outPath(src string, req StartReq, ext string, used map[string]bool) string {
	stem := strings.TrimSuffix(filepath.Base(src), filepath.Ext(src))
	od := strings.TrimSpace(req.OutDir)
	folder := filepath.Dir(src)
	switch {
	case isTemp(src): // перетащенные файлы: у них нет исходной папки
		switch {
		case od != "" && !req.SameDir:
			folder = od
		case strings.TrimSpace(req.DropOut) != "":
			folder = strings.TrimSpace(req.DropOut)
		default:
			folder = defaultOut()
		}
	case od != "" && !req.SameDir:
		folder = od
	}
	os.MkdirAll(folder, 0o755)
	copyMode := req.Copy && !req.Overwrite
	for n := 0; ; n++ {
		name := stem
		switch {
		case n >= 1 && copyMode:
			name = fmt.Sprintf("%s (%d)", stem, n)
		case n == 1:
			name = stem + "_converted"
		case n > 1:
			name = fmt.Sprintf("%s_converted_%d", stem, n)
		}
		dst := filepath.Join(folder, name+"."+ext)
		key := strings.ToLower(dst)
		if strings.EqualFold(dst, src) || used[key] || (copyMode && fileSize(dst) > 0) {
			continue
		}
		used[key] = true
		return dst
	}
}

func (s *Server) set(i int, fn func(fs *FileState)) {
	s.mu.Lock()
	fn(s.files[i])
	s.mu.Unlock()
}

func (s *Server) convert(ctx context.Context, i int, req StartReq, f Format, ffm string) {
	var src, dst string
	s.mu.Lock()
	src, dst = s.files[i].Path, s.files[i].Dst
	s.mu.Unlock()
	name := s.files[i].Name

	if !req.Overwrite && fileExists(dst) && fileSize(dst) > 0 {
		s.set(i, func(fs *FileState) { fs.Status = "skipped"; fs.Msg = "уже существует" })
		s.addLog("[пропуск] %s (результат уже есть)", name)
		return
	}
	s.set(i, func(fs *FileState) { fs.Status = "running"; fs.Msg = "" })
	si := probe(ffm, src)

	stderr, err := s.runFF(ctx, i, ffm, buildArgs(f, req, src, dst, si, false), si.dur)
	if err != nil && ctx.Err() == nil && (f.Kind == "video" || f.Kind == "gif") && !strings.Contains(stderr, "Error opening input") {
		os.Remove(dst)
		s.addLog("[повтор] %s: первая попытка не удалась, пробую в безопасном режиме\n    %s", name, errSummary(stderr, err, 6))
		s.set(i, func(fs *FileState) { fs.Pct = 0; fs.Msg = "повтор в безопасном режиме" })
		r := req
		r.Overwrite = true // файл от первой попытки уже удалён
		stderr, err = s.runFF(ctx, i, ffm, buildArgs(f, r, src, dst, si, true), si.dur)
	}

	if ctx.Err() != nil {
		os.Remove(dst)
		s.set(i, func(fs *FileState) { fs.Status = "canceled"; fs.Msg = "" })
		return
	}
	if err != nil {
		os.Remove(dst)
		short, hint := errSummary(stderr, err, 2), friendlyErr(stderr, err)
		s.set(i, func(fs *FileState) { fs.Status = "error"; fs.Msg = short; fs.Hint = hint })
		s.addLog("[ошибка] %s:\n    %s", name, errSummary(stderr, err, 8))
		return
	}
	size := fileSize(dst)
	s.set(i, func(fs *FileState) { fs.Status = "ok"; fs.Pct = 100; fs.DstSize = size; fs.Msg = "" })
	s.addLog("[ok] %s", filepath.Base(dst))
}

// runFF запускает ffmpeg и обновляет процент выполнения
func (s *Server) runFF(ctx context.Context, i int, ffm string, args []string, dur float64) (string, error) {
	cmd := exec.CommandContext(ctx, ffm, args...)
	hide(cmd)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err == nil {
		err = cmd.Start()
	}
	if err != nil {
		return "", err
	}
	sc := bufio.NewScanner(stdout)
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "out_time_us=") && dur > 0 {
			us, e := strconv.ParseFloat(strings.TrimPrefix(line, "out_time_us="), 64)
			if e == nil {
				p := us / 1e6 / dur * 100
				if p > 99 {
					p = 99
				}
				if p < 0 {
					p = 0
				}
				s.set(i, func(fs *FileState) { fs.Pct = p })
			}
		}
	}
	err = cmd.Wait()
	return stderr.String(), err
}

// friendlyErr переводит типичные ошибки ffmpeg на человеческий
func friendlyErr(stderr string, err error) string {
	low := strings.ToLower(stderr)
	has := func(ss ...string) bool {
		for _, x := range ss {
			if strings.Contains(low, x) {
				return true
			}
		}
		return false
	}
	switch {
	case has("no space left"):
		return "На диске кончилось место."
	case has("permission denied", "access is denied"):
		return "Нет доступа к файлу или папке. Возможно, файл открыт в другой программе, или в эту папку нельзя писать — выбери другую."
	case has("no such file or directory"):
		return "Файл не найден — его переместили, переименовали или удалили."
	case has("invalid data found when processing input", "moov atom not found"):
		return "Файл повреждён или недокачан, ffmpeg не смог его прочитать."
	case has("does not contain any stream", "matches no streams", "stream map", "output file is empty"):
		return "В файле нет нужной дорожки: например, у аудиофайла нет картинки для видео или GIF."
	case has("unknown encoder", "encoder not found"):
		return "В этой сборке ffmpeg нет нужного кодека. Обнови ffmpeg."
	case has("not divisible by 2", "width not divisible", "height not divisible"):
		return "Неудобное разрешение для кодека (нечётная ширина или высота). Попробуй указать высоту, например 720."
	case has("too many packets buffered", "non monotonous dts", "non-monotonic dts"):
		return "Внутри файла сбиты метки времени. Попробуй другой формат или «MKV без перекодирования»."
	case has("unrecognized option", "error splitting the argument list", "option not found"):
		return "Ошибка в своих аргументах ffmpeg — проверь поле «Свои аргументы»."
	case has("could not open encoder", "error while opening encoder", "incorrect parameters"):
		return "Кодек не принял параметры (разрешение, частота кадров или звук). Попробуй другую высоту/FPS или другой формат."
	case has("error opening input", "error opening input file"):
		return "Не удалось открыть файл."
	}
	if err != nil && stderr == "" {
		return "ffmpeg не запустился: " + err.Error()
	}
	return "ffmpeg не справился с этим файлом. Подробности — в логе."
}

// errSummary: самые полезные строки ошибки (сначала причина, а не последствия)
var addrRe = regexp.MustCompile(` @ 0x[0-9a-f]+\]`)

func errSummary(stderr string, err error, max int) string {
	var key, rest []string
	seen := map[string]bool{}
	for _, l := range strings.Split(strings.TrimSpace(stderr), "\n") {
		l = strings.TrimSpace(addrRe.ReplaceAllString(l, "]"))
		if l == "" || seen[l] {
			continue
		}
		seen[l] = true
		low := strings.ToLower(l)
		if strings.Contains(low, "additional information") || strings.Contains(low, "failed") ||
			strings.Contains(low, "unsupported") || strings.Contains(low, "not supported") ||
			strings.Contains(low, "invalid") || strings.Contains(low, "no such") || strings.Contains(low, "unrecognized") {
			key = append(key, l)
		} else {
			rest = append(rest, l)
		}
	}
	lines := append(key, rest...)
	if len(lines) == 0 {
		return err.Error()
	}
	if len(lines) > max {
		lines = lines[:max]
	}
	return strings.Join(lines, "\n    ")
}

func (s *Server) run(req StartReq, ffm string) {
	f := formats[req.Format]
	ctx, cancel := context.WithCancel(context.Background())

	used := map[string]bool{}
	var states []*FileState
	for _, p := range req.Files {
		states = append(states, &FileState{
			Path: p, Name: filepath.Base(p), Dst: outPath(p, req, f.Ext, used),
			Status: "pending", SrcSize: fileSize(p),
		})
	}
	s.mu.Lock()
	s.files = states
	s.running = true
	s.cancel = cancel
	s.summary = ""
	s.mu.Unlock()

	jobs := req.Jobs
	if jobs < 1 {
		jobs = 1
	}
	if jobs > 8 {
		jobs = 8
	}
	idx := make(chan int)
	var wg sync.WaitGroup
	for w := 0; w < jobs; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range idx {
				s.convert(ctx, i, req, f, ffm)
			}
		}()
	}
	for i := range states {
		if ctx.Err() != nil {
			break
		}
		idx <- i
	}
	close(idx)
	wg.Wait()

	s.mu.Lock()
	var ok, bad, skip, canc int
	for _, fs := range s.files {
		switch fs.Status {
		case "ok":
			ok++
		case "error":
			bad++
		case "skipped":
			skip++
		default:
			fs.Status = "canceled"
			canc++
		}
	}
	title := "Готово"
	if canc > 0 {
		title = "Остановлено"
	}
	s.summary = fmt.Sprintf("%s: успешно %d, ошибок %d, пропущено %d", title, ok, bad, skip)
	s.running = false
	s.cancel = nil
	s.mu.Unlock()
	cancel()
	s.addLog("%s", s.summary)
}

// ---------- HTTP ----------

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(v)
}

func (s *Server) api(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Host != s.host || r.Header.Get("X-Token") != s.token {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		s.mu.Lock()
		s.last = time.Now()
		s.mu.Unlock()
		h(w, r)
	}
}

func safeName(n string) string {
	n = badName.ReplaceAllString(filepath.Base(strings.ReplaceAll(n, "\\", "/")), "_")
	n = strings.Trim(n, " .")
	if n == "" {
		n = "file"
	}
	return n
}

func (s *Server) routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" || r.Host != s.host {
			http.NotFound(w, r)
			return
		}
		s.mu.Lock()
		s.last = time.Now()
		s.mu.Unlock()
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		io.WriteString(w, strings.ReplaceAll(indexHTML, "__TOKEN__", s.token))
	})

	mux.HandleFunc("/hero.jpg", func(w http.ResponseWriter, r *http.Request) {
		if r.Host != s.host {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "image/jpeg")
		w.Header().Set("Cache-Control", "max-age=86400")
		w.Write(heroJPG)
	})

	mux.HandleFunc("/favicon.png", func(w http.ResponseWriter, r *http.Request) {
		if r.Host != s.host {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Cache-Control", "max-age=86400")
		w.Write(faviconPNG)
	})

	mux.HandleFunc("/thumb", s.thumbHandler)

	mux.HandleFunc("/api/info", s.api(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Path string `json:"path"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		s.mu.Lock()
		ffm := s.ffmpeg
		s.mu.Unlock()
		if ffm == "" {
			writeJSON(w, MediaInfo{Error: "ffmpeg не найден"})
			return
		}
		writeJSON(w, getMediaInfo(ffm, body.Path))
	}))

	mux.HandleFunc("/api/state", s.api(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		writeJSON(w, map[string]any{
			"ffmpeg":     s.ffmpeg,
			"dl":         s.dl,
			"running":    s.running,
			"files":      s.files,
			"log":        s.log,
			"summary":    s.summary,
			"defaultOut": defaultOut(),
			"ffv":        s.ffv,
			"appUpd":     s.appUpd,
			"app": map[string]any{
				"version":   appVersion,
				"install":   s.inst,
				"setupSeen": s.settings.SetupDeclined == appVersion,
			},
		})
	}))

	mux.HandleFunc("/api/download-ffmpeg", s.api(func(w http.ResponseWriter, r *http.Request) {
		if err := s.downloadFFmpeg(); err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, map[string]any{"ok": true})
	}))

	// «пропустить эту версию ffmpeg»
	mux.HandleFunc("/api/ffmpeg-skip", s.api(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.settings.SkipFFmpeg = s.ffv.Latest
		st := s.settings
		s.refreshFFLocked()
		s.mu.Unlock()
		saveSettings(st)
		writeJSON(w, map[string]any{"ok": true})
	}))

	// новая версия Конвертора: скачать, заменить себя и перезапуститься
	mux.HandleFunc("/api/app-update", s.api(func(w http.ResponseWriter, r *http.Request) {
		if err := s.updateApp(); err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, map[string]any{"ok": true})
	}))

	mux.HandleFunc("/api/app-skip", s.api(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.settings.SkipApp = s.appUpd.Latest
		st := s.settings
		s.refreshAppLocked()
		s.mu.Unlock()
		saveSettings(st)
		writeJSON(w, map[string]any{"ok": true})
	}))

	// установка на компьютер (+ по желанию скачать/обновить ffmpeg)
	mux.HandleFunc("/api/install", s.api(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Desktop bool `json:"desktop"`
			FFmpeg  bool `json:"ffmpeg"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if err := doInstall(body.Desktop); err != nil {
			s.addLog("Установка: %v", err)
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		inst := installInfo()
		s.mu.Lock()
		s.inst = inst
		s.mu.Unlock()
		s.addLog("Установлено в %s", inst.Dir)
		res := map[string]any{"ok": true, "dir": inst.Dir}
		if body.FFmpeg {
			if err := s.downloadFFmpeg(); err != nil {
				res["ffError"] = err.Error()
			}
		}
		writeJSON(w, res)
	}))

	// «без установки»: больше не спрашивать (до следующей версии программы)
	mux.HandleFunc("/api/setup-later", s.api(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.settings.SetupDeclined = appVersion
		st := s.settings
		s.mu.Unlock()
		saveSettings(st)
		writeJSON(w, map[string]any{"ok": true})
	}))

	mux.HandleFunc("/api/pick-files", s.api(func(w http.ResponseWriter, r *http.Request) {
		paths, err := pickFiles()
		res := map[string]any{"files": infos(paths)}
		if err != nil {
			res["error"] = err.Error()
		}
		writeJSON(w, res)
	}))

	mux.HandleFunc("/api/pick-folder", s.api(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Purpose string `json:"purpose"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		dir, err := pickFolder()
		res := map[string]any{}
		if err != nil {
			res["error"] = err.Error()
		} else if dir != "" {
			if body.Purpose == "add" {
				res["files"] = walkMedia(dir)
			} else {
				res["path"] = dir
			}
		}
		writeJSON(w, res)
	}))

	// перетащенные в окно файлы: копируем во временную папку
	mux.HandleFunc("/api/upload", s.api(func(w http.ResponseWriter, r *http.Request) {
		name := safeName(r.URL.Query().Get("name"))
		sub := make([]byte, 6)
		rand.Read(sub)
		dir := filepath.Join(dropDir(), hex.EncodeToString(sub))
		if err := os.MkdirAll(dir, 0o755); err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		dst := filepath.Join(dir, name)
		f, err := os.Create(dst)
		if err != nil {
			os.RemoveAll(dir)
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		n, err := io.Copy(f, r.Body)
		f.Close()
		if err != nil {
			os.RemoveAll(dir)
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, FileInfo{Path: dst, Size: n})
	}))

	mux.HandleFunc("/api/discard", s.api(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Paths []string `json:"paths"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		for _, p := range body.Paths {
			cleanupTemp(p)
		}
		writeJSON(w, map[string]any{"ok": true})
	}))

	mux.HandleFunc("/api/start", s.api(func(w http.ResponseWriter, r *http.Request) {
		var req StartReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, map[string]any{"error": "bad request"})
			return
		}
		s.mu.Lock()
		ffm, running, dl, upd := s.ffmpeg, s.running, s.dl.Active, s.appUpd.Active || s.appUpd.Restart
		s.mu.Unlock()
		if upd {
			writeJSON(w, map[string]any{"error": "подожди, ставится новая версия Конвертора"})
			return
		}
		if running {
			writeJSON(w, map[string]any{"error": "уже идёт конвертация"})
			return
		}
		if dl {
			writeJSON(w, map[string]any{"error": "подожди, ffmpeg ещё скачивается"})
			return
		}
		if ffm == "" {
			writeJSON(w, map[string]any{"error": "ffmpeg не найден"})
			return
		}
		if _, ok := formats[req.Format]; !ok || len(req.Files) == 0 {
			writeJSON(w, map[string]any{"error": "нет файлов или неизвестный формат"})
			return
		}
		go s.run(req, ffm)
		writeJSON(w, map[string]any{"ok": true})
	}))

	mux.HandleFunc("/api/cancel", s.api(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		if s.cancel != nil {
			s.cancel()
		}
		s.mu.Unlock()
		writeJSON(w, map[string]any{"ok": true})
	}))

	mux.HandleFunc("/api/open-output", s.api(func(w http.ResponseWriter, r *http.Request) {
		dir := ""
		s.mu.Lock()
		for _, fs := range s.files {
			if fs.Status == "ok" {
				dir = filepath.Dir(fs.Dst)
				break
			}
		}
		s.mu.Unlock()
		if dir == "" {
			writeJSON(w, map[string]any{"error": "нет готовых файлов"})
			return
		}
		openFolder(dir)
		writeJSON(w, map[string]any{"ok": true})
	}))

	mux.HandleFunc("/api/exit", s.api(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"ok": true})
		go func() {
			time.Sleep(200 * time.Millisecond)
			s.stopAll()
			os.Exit(0)
		}()
	}))
	return mux
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	hide(cmd)
	cmd.Start()
}

// stopAll: останавливает конвертацию и чистит временные копии (при закрытии программы)
func (s *Server) stopAll() {
	s.mu.Lock()
	c := s.cancel
	s.mu.Unlock()
	if c != nil {
		c()
		for i := 0; i < 40; i++ { // даём ffmpeg завершиться и удалить недоделанные файлы
			time.Sleep(50 * time.Millisecond)
			s.mu.Lock()
			r := s.running
			s.mu.Unlock()
			if !r {
				break
			}
		}
	}
	os.RemoveAll(dropDir())
}

// idleExit: в браузерном режиме выключаемся, если вкладку закрыли
func (s *Server) idleExit() {
	for {
		time.Sleep(5 * time.Second)
		s.mu.Lock()
		idle := !s.running && !s.dl.Active && time.Since(s.last) > 150*time.Second
		s.mu.Unlock()
		if idle {
			s.stopAll()
			os.Exit(0)
		}
	}
}

func startServer() *Server {
	tok := make([]byte, 16)
	rand.Read(tok)

	fixed := true
	ln, err := net.Listen("tcp", "127.0.0.1:47831")
	// после обновления прошлая версия ещё закрывается и держит порт — ждём её
	for i := 0; err != nil && hasArg("--updated") && i < 40; i++ {
		time.Sleep(250 * time.Millisecond)
		ln, err = net.Listen("tcp", "127.0.0.1:47831")
	}
	if err != nil {
		fixed = false
		ln, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			os.Exit(1)
		}
	}
	if fixed { // чистим хвосты от прошлого запуска (только если нет другого живого экземпляра)
		os.RemoveAll(dropDir())
	}
	s := &Server{token: hex.EncodeToString(tok), host: ln.Addr().String(), last: time.Now(), ffmpeg: findFFmpeg(),
		settings: loadSettings(), inst: afterUpdate(installInfo())}
	s.addLog("%s %s", appName, appVersion)
	go s.checkFFmpeg()
	go s.checkApp()
	go http.Serve(ln, s.routes())
	return s
}

func (s *Server) url() string { return "http://" + s.host + "/" }

func hasArg(a string) bool {
	for _, x := range os.Args[1:] {
		if x == a {
			return true
		}
	}
	return false
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--uninstall" {
		runUninstall()
		return
	}
	s := startServer()
	runUI(s) // окно программы (Windows) или вкладка браузера
}
