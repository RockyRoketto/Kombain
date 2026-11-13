package main

// Скачивание и обновление ffmpeg (откуда качать и какая версия свежая — в update.go).

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type countReader struct {
	r     io.Reader
	n     int64
	total int64
	cb    func(float64) // процент; 0, если общий размер неизвестен
}

func (c *countReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	pct := 0.0
	if c.total > 0 {
		pct = float64(c.n) / float64(c.total) * 100
	}
	c.cb(pct)
	return n, err
}

// dlStall: столько можно ждать новых данных при скачивании, потом считаем, что связь зависла
var dlStall = 60 * time.Second

// download качает url в path (не больше limit байт) и возвращает размер. size — размер, если сервер его не сообщит;
// extra (может быть nil) получает те же данные, например для контрольной суммы. При ошибке path удаляется.
func download(url, path string, size, limit int64, extra io.Writer, progress func(float64)) (int64, error) {
	return downloadCtx(context.Background(), url, path, size, limit, extra, progress)
}

// downloadCtx: то же, но скачивание можно прервать через parent
func downloadCtx(parent context.Context, url, path string, size, limit int64, extra io.Writer, progress func(float64)) (int64, error) {
	return downloadOpt(parent, url, path, size, limit, extra, progress, false)
}

// downloadResume: как downloadCtx, но недокачанный path (size известен) продолжается с места обрыва через Range.
// Уже лежащие байты сразу идут в extra (контрольную сумму), при обрыве файл остаётся для следующей попытки.
// Сервер не умеет докачку — качаем сначала. Возвращает размер всего файла.
func downloadResume(parent context.Context, url, path string, size, limit int64, extra io.Writer, progress func(float64)) (int64, error) {
	return downloadOpt(parent, url, path, size, limit, extra, progress, true)
}

func downloadOpt(parent context.Context, url, path string, size, limit int64, extra io.Writer, progress func(float64), resume bool) (int64, error) {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	stall := time.AfterFunc(dlStall, cancel)
	defer stall.Stop()

	var have int64
	if resume && size > 0 {
		if st, err := os.Stat(path); err == nil && st.Size() > 0 && st.Size() < size {
			have = st.Size()
		}
	}
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("User-Agent", "Konvertor9000/"+appVersion)
	if have > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", have))
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, stallErr(ctx, err)
	}
	defer resp.Body.Close()
	if have > 0 && resp.StatusCode == http.StatusRequestedRangeNotSatisfiable {
		os.Remove(path)
		return downloadOpt(parent, url, path, size, limit, extra, progress, false)
	}
	partial := have > 0 && resp.StatusCode == http.StatusPartialContent &&
		strings.HasPrefix(resp.Header.Get("Content-Range"), fmt.Sprintf("bytes %d-", have))
	if !partial {
		have = 0 // сервер отдал всё с начала (или кусок не тот): пишем заново
		if resp.StatusCode != 200 {
			return 0, fmt.Errorf("HTTP %d", resp.StatusCode)
		}
	}
	total := resp.ContentLength
	if total > 0 {
		total += have
	} else {
		total = size
	}
	var out *os.File
	if have > 0 {
		if extra != nil {
			f, err := os.Open(path)
			if err != nil {
				return 0, err
			}
			_, err = io.CopyN(extra, f, have)
			f.Close()
			if err != nil {
				return 0, err
			}
		}
		out, err = os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0o644)
	} else {
		out, err = os.Create(path)
	}
	if err != nil {
		return 0, err
	}
	var dst io.Writer = out
	if extra != nil {
		dst = io.MultiWriter(out, extra)
	}
	cr := &countReader{r: resp.Body, n: have, total: total, cb: func(p float64) {
		stall.Reset(dlStall)
		progress(p)
	}}
	n, err := io.Copy(dst, io.LimitReader(cr, limit-have))
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		if !resume {
			os.Remove(path)
		}
		return 0, stallErr(ctx, err)
	}
	return have + n, nil
}

func stallErr(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return errT("err.stalled", int(dlStall.Seconds()))
	}
	return err
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
		return errT("err.waitConvert")
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
			s.logT("log.ffReady", ver)
		}
	}()
	return nil
}

// parseSum достаёт sha256 из текста вида «hash  имя» (checksums.sha256) или просто «hash».
// name пустой — берём первую строку; иначе строку с этим файлом. Не нашли — пустая строка.
func parseSum(text, name string) string {
	for _, line := range strings.Split(text, "\n") {
		f := strings.Fields(line)
		if len(f) == 0 || len(f[0]) != 64 {
			continue
		}
		if name == "" || (len(f) > 1 && strings.TrimPrefix(f[1], "*") == name) {
			return strings.ToLower(f[0])
		}
	}
	return ""
}

// fetchFFSum спрашивает у того же сервера контрольную сумму архива: у gyan.dev это url+".sha256",
// у BtbN общий checksums.sha256 в папке релиза. Пустая строка — суммы нет (сервер не отдал).
func fetchFFSum(url string) string {
	if b, err := httpGet(url+".sha256", 4096); err == nil {
		if s := parseSum(string(b), ""); s != "" {
			return s
		}
	}
	if i := strings.LastIndex(url, "/"); i > 0 {
		if b, err := httpGet(url[:i]+"/checksums.sha256", 1<<20); err == nil {
			return parseSum(string(b), url[i+1:])
		}
	}
	return ""
}

func (s *Server) tryDownload(url string) error {
	dir := ffDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	zipPath := filepath.Join(dir, "ffmpeg.zip.part")
	want := fetchFFSum(url)
	h := sha256.New()
	if _, err := download(url, zipPath, 0, 2<<30, h, func(p float64) {
		s.mu.Lock()
		s.dl.Pct = p
		s.mu.Unlock()
	}); err != nil {
		return err
	}
	defer os.Remove(zipPath)
	if want == "" {
		s.logT("log.ffNoSum", url)
	} else if got := hex.EncodeToString(h.Sum(nil)); got != want {
		return errT("err.ffBadSum")
	}

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
	return errT("err.ffNotInArchive")
}
