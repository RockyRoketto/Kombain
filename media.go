package main

// Превью файлов: кадр из видео / картинка / волна звука, и сведения о файле
// (разрешение, длительность, кодеки) для окна просмотра.

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

type MediaInfo struct {
	Rotated bool `json:"rotated"` // метка поворота на 90°: w и h надо поменять местами

	Dur    float64 `json:"dur"`
	W      int     `json:"w"`
	H      int     `json:"h"`
	FPS    float64 `json:"fps"`
	VCodec string  `json:"vcodec"`
	ACodec string  `json:"acodec"`
	AHz    int     `json:"ahz"`
	ACh    string  `json:"ach"`
	Cover  bool    `json:"cover"` // «видео» — это обложка (mp3 и т.п.)
	Size   int64   `json:"size"`
	Error  string  `json:"error,omitempty"`
}

var (
	vStreamRe = regexp.MustCompile(`Video: (\w+)`)
	sizeRe    = regexp.MustCompile(`, (\d{2,5})x(\d{2,5})[ ,\[]`)
	fpsRe     = regexp.MustCompile(`([\d.]+) fps`)
	aStreamRe = regexp.MustCompile(`Audio: (\w+)[^,]*(?:, (\d+) Hz)?(?:, ([^,]+))?`)
)

func parseMediaInfo(out string) MediaInfo {
	var mi MediaInfo
	mi.Rotated = rotatedRe.MatchString(out)
	if m := durRe.FindStringSubmatch(out); m != nil {
		h, _ := strconv.ParseFloat(m[1], 64)
		mn, _ := strconv.ParseFloat(m[2], 64)
		sec, _ := strconv.ParseFloat(m[3], 64)
		mi.Dur = h*3600 + mn*60 + sec
	}
	for _, line := range strings.Split(out, "\n") {
		if !strings.Contains(line, "Stream #") {
			continue
		}
		if mi.VCodec == "" && strings.Contains(line, "Video:") {
			if m := vStreamRe.FindStringSubmatch(line); m != nil {
				mi.VCodec = m[1]
			}
			if m := sizeRe.FindStringSubmatch(line + " "); m != nil {
				mi.W, _ = strconv.Atoi(m[1])
				mi.H, _ = strconv.Atoi(m[2])
			}
			if m := fpsRe.FindStringSubmatch(line); m != nil {
				mi.FPS, _ = strconv.ParseFloat(m[1], 64)
			}
			mi.Cover = strings.Contains(line, "attached pic")
		}
		if mi.ACodec == "" && strings.Contains(line, "Audio:") {
			if m := aStreamRe.FindStringSubmatch(line); m != nil {
				mi.ACodec = m[1]
				mi.AHz, _ = strconv.Atoi(m[2])
				mi.ACh = strings.TrimSpace(m[3])
			}
		}
	}
	return mi
}

// кэш: превью и сведения по пути + времени изменения файла
type mediaCache struct {
	mu    sync.Mutex
	info  map[string]MediaInfo
	thumb map[string][]byte
}

var (
	mcache   = &mediaCache{info: map[string]MediaInfo{}, thumb: map[string][]byte{}}
	thumbSem = make(chan struct{}, 2) // не больше двух ffmpeg на превью одновременно
)

func fileKey(p string) (string, bool) {
	st, err := os.Stat(p)
	if err != nil || st.IsDir() {
		return "", false
	}
	return fmt.Sprintf("%s|%d|%d", p, st.ModTime().UnixNano(), st.Size()), true
}

func runQuiet(ffm string, timeout time.Duration, args ...string) ([]byte, []byte) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, ffm, args...)
	hide(cmd)
	var out, errb strings.Builder
	cmd.Stdout = &out
	cmd.Stderr = &errb
	cmd.Run()
	return []byte(out.String()), []byte(errb.String())
}

func getMediaInfo(ffm, p string) MediaInfo {
	key, ok := fileKey(p)
	if !ok {
		return MediaInfo{Error: tr("media.notFound")}
	}
	mcache.mu.Lock()
	mi, hit := mcache.info[key]
	mcache.mu.Unlock()
	if hit {
		return withMediaError(mi)
	}
	_, e := runQuiet(ffm, 20*time.Second, "-hide_banner", "-i", p)
	mi = parseMediaInfo(string(e))
	mi.Size = fileSize(p)
	mcache.mu.Lock()
	if len(mcache.info) > 2000 {
		mcache.info = map[string]MediaInfo{}
	}
	mcache.info[key] = mi
	mcache.mu.Unlock()
	return withMediaError(mi)
}

// withMediaError: текст ошибки добавляется уже после кэша, чтобы после смены языка не отдать его на старом
func withMediaError(mi MediaInfo) MediaInfo {
	if mi.VCodec == "" && mi.ACodec == "" {
		mi.Error = tr("media.cantRead")
	}
	return mi
}

// makeThumb: JPEG шириной w. at — доля длительности (0..1), откуда брать кадр.
// Для звука без обложки рисуем волну.
func makeThumb(ffm, p string, at float64, w int) []byte {
	key, ok := fileKey(p)
	if !ok {
		return nil
	}
	key += fmt.Sprintf("|%.3f|%d", at, w)
	mcache.mu.Lock()
	b, hit := mcache.thumb[key]
	mcache.mu.Unlock()
	if hit {
		return b
	}

	mi := getMediaInfo(ffm, p)
	thumbSem <- struct{}{}
	defer func() { <-thumbSem }()

	scale := fmt.Sprintf("scale=%d:-2:flags=bicubic", w)
	frame := func(ss float64) []byte {
		args := []string{"-hide_banner", "-loglevel", "error", "-nostdin"}
		if ss > 0 {
			args = append(args, "-ss", strconv.FormatFloat(ss, 'f', 2, 64))
		}
		args = append(args, "-i", p, "-map", "0:v:0", "-frames:v", "1", "-vf", scale,
			"-c:v", "mjpeg", "-q:v", "4", "-f", "image2pipe", "-")
		out, _ := runQuiet(ffm, 25*time.Second, args...)
		return out
	}
	if mi.VCodec != "" && at >= 0 { // at < 0: нужна волна, даже если в файле есть картинка
		ss := 0.0
		if !mi.Cover && mi.Dur > 1 {
			ss = mi.Dur * at
			if ss > mi.Dur-0.5 {
				ss = mi.Dur - 0.5
			}
		}
		b = frame(ss)
		if len(b) == 0 && ss > 0 {
			b = frame(0)
		}
	}
	if len(b) == 0 && mi.ACodec != "" {
		h := w * 9 / 16
		b, _ = runQuiet(ffm, 25*time.Second, "-hide_banner", "-loglevel", "error", "-nostdin", "-i", p,
			"-filter_complex", fmt.Sprintf("[0:a:0]showwavespic=s=%[1]dx%[2]d:colors=0xe9b872[w];color=c=0x151518:s=%[1]dx%[2]d[bg];[bg][w]overlay=shortest=1:format=auto,format=yuvj420p", w, h),
			"-frames:v", "1", "-c:v", "mjpeg", "-q:v", "4", "-f", "image2pipe", "-")
	}
	mcache.mu.Lock()
	if len(mcache.thumb) > 600 {
		mcache.thumb = map[string][]byte{}
	}
	mcache.thumb[key] = b
	mcache.mu.Unlock()
	return b
}

// mediaHandler отдаёт файл целиком для просмотра, а с proxy=1 его копию для просмотра (proxy.go);
// ServeContent сам умеет перемотку (Range)
func (s *Server) mediaHandler(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if r.Host != s.host || q.Get("t") != s.token {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	p := q.Get("p")
	if !mediaExt[strings.ToLower(filepath.Ext(p))] {
		http.NotFound(w, r)
		return
	}
	if q.Get("proxy") == "1" {
		var piece proxyPiece
		if q.Get("rev") == "1" {
			piece.Rev = true
			piece.From, _ = strconv.ParseFloat(q.Get("from"), 64)
			piece.Len, _ = strconv.ParseFloat(q.Get("len"), 64)
		}
		out, ok := proxyPiecePath(p, piece)
		if !ok {
			http.NotFound(w, r)
			return
		}
		p = out
	}
	f, err := os.Open(p)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		http.NotFound(w, r)
		return
	}
	http.ServeContent(w, r, filepath.Base(p), st.ModTime(), f)
}

func (s *Server) thumbHandler(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if r.Host != s.host || q.Get("t") != s.token {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	s.mu.Lock()
	ffm := s.ffmpeg
	s.mu.Unlock()
	if ffm == "" {
		http.NotFound(w, r)
		return
	}
	at, _ := strconv.ParseFloat(q.Get("at"), 64)
	if (at < 0 && at != -1) || at > 1 { // -1: волна вместо кадра
		at = 0.1
	}
	width, _ := strconv.Atoi(q.Get("w"))
	if width < 32 || width > 1280 {
		width = 160
	}
	b := makeThumb(ffm, q.Get("p"), at, width)
	if len(b) == 0 {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "private, max-age=3600")
	w.Write(b)
}
