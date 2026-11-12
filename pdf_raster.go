package main

// «PDF → картинки»: страницы рисует pdf.js в окне (web/js/pdfraster.js), сюда они приходят готовыми файлами.
// Прогон при этом обычная пачка «pdf» (op "raster"): общий прогресс, «Стоп» и итог, как у остальных действий.
// Окно на каждый файл просит папку (pdf-ras-begin), шлёт страницы (pdf-page-save) и сообщает итог (pdf-ras-end).
// Писать можно только в папку, выданную под этот файл в этом прогоне.
// Здесь же раздача самого pdf.js и PDF-файла для просмотра и миниатюр.

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// rasterJob: идущий прогон «PDF → картинки»
type rasterJob struct {
	c     context.Context
	req   PDFReq
	dirs  []string // папка страниц каждого файла, пусто — ещё не начат
	first []string // первая записанная страница (её папку откроет «Открыть папку»)
	ended []bool
	left  int
	ok    int
	bad   int
	last  time.Time // последняя весточка от окна
	done  chan struct{}
}

var (
	rasterMu  sync.Mutex
	curRaster *rasterJob
)

// сколько ждать окно, прежде чем считать прогон брошенным (окно закрыли или страница перезагрузилась)
var rasterIdle = 2 * time.Minute

var rasterExt = map[string]bool{".png": true, ".jpg": true, ".webp": true}

// pdfRasterDir: новая папка для страниц этого PDF («имя», при занятой — «имя (1)»)
func pdfRasterDir(src string, sameDir bool, outDir string) (string, error) {
	dir := outPathNamed(src, fileStem(src), "", StartReq{SameDir: sameDir, OutDir: outDir, Copy: true}, map[string]bool{})
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return dir, nil
}

// pdfRasterSave: записать одну страницу в папку dir (через .part, чтобы не осталось обрубка).
// От имени берётся только последняя часть: выйти из папки нельзя
func pdfRasterSave(dir, name string, body io.Reader) (string, error) {
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	if dir == "" || name == "." || !rasterExt[strings.ToLower(filepath.Ext(name))] {
		return "", errT("err.badRequest")
	}
	dst := filepath.Join(dir, name)
	tmp := dst + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		return "", err
	}
	_, err = io.Copy(f, body)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp, dst)
	}
	if err != nil {
		os.Remove(tmp)
		return "", err
	}
	return dst, nil
}

// newRasterJob: завести прогон на n файлов; с этого момента окно может слать страницы
func newRasterJob(c context.Context, req PDFReq, n int) *rasterJob {
	job := &rasterJob{c: c, req: req, dirs: make([]string, n), first: make([]string, n), ended: make([]bool, n), left: n, last: time.Now(), done: make(chan struct{})}
	if n == 0 {
		close(job.done)
	}
	rasterMu.Lock()
	curRaster = job
	rasterMu.Unlock()
	return job
}

// runRaster: ждать, пока окно пройдёт все файлы, нажмут «Стоп» или окно пропадёт
func (s *Server) runRaster(job *rasterJob) (ok, bad int) {
	c := job.c
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
wait:
	for {
		select {
		case <-job.done:
			break wait
		case <-c.Done():
			break wait
		case <-tick.C:
			rasterMu.Lock()
			idle := time.Since(job.last) > rasterIdle
			rasterMu.Unlock()
			if idle {
				break wait
			}
		}
	}
	rasterMu.Lock()
	curRaster = nil
	ok, bad = job.ok, job.bad
	for i, d := range job.dirs {
		switch {
		case d == "" || job.ended[i]:
		case c.Err() != nil:
			// «Стоп» посреди файла: недоделанный результат убираем, как у остальных действий.
			// Папку завели пустой под этот прогон (outPathNamed не отдаёт непустую), чужого в ней нет
			os.RemoveAll(d)
		case job.first[i] == "":
			os.Remove(d)
		}
	}
	// окно пропало посреди файла: он не готов, папку с тем, что успело записаться, не трогаем
	if c.Err() == nil {
		for i, d := range job.dirs {
			if d != "" && !job.ended[i] {
				bad++
				s.set(i, func(fs *FileState) { fs.Status = "error"; fs.Msg = tr("pdf.rasLost"); fs.Hint = fs.Msg })
			}
		}
	}
	rasterMu.Unlock()
	return ok, bad
}

// rasterGet: идущий прогон и номер файла в нём; nil — прогона нет, отменён или номер чужой.
// Вызывать под rasterMu
func rasterGet(i int) *rasterJob {
	j := curRaster
	if j == nil || j.c.Err() != nil || i < 0 || i >= len(j.dirs) || j.ended[i] {
		return nil
	}
	j.last = time.Now()
	return j
}

// pdfJSFiles: что отдаётся из web/pdfjs (остальное не отдаём)
var pdfJSFiles = map[string]string{"pdf.min.js": "text/javascript; charset=utf-8", "pdf.worker.min.js": "text/javascript; charset=utf-8"}

func (s *Server) pdfRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/pdfjs/", func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/pdfjs/")
		ct, ok := pdfJSFiles[name]
		if r.Host != s.host || !ok {
			http.NotFound(w, r)
			return
		}
		b, err := webFS.ReadFile("web/pdfjs/" + name)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", ct)
		w.Header().Set("Cache-Control", "max-age=86400")
		w.Write(b)
	})

	// сам PDF для pdf.js (ServeContent умеет частичные запросы)
	mux.HandleFunc("/pdf", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		p := q.Get("p")
		if r.Host != s.host || q.Get("t") != s.token {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if id := q.Get("c"); id != "" { // страница сравнения после «Сжать» (pdf_compare.go), из памяти
			rd := pdfCmpGet(id)
			if rd == nil {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Type", "application/pdf")
			w.Header().Set("Cache-Control", "no-store")
			http.ServeContent(w, r, "page.pdf", time.Time{}, rd)
			return
		}
		if !strings.EqualFold(filepath.Ext(p), ".pdf") {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
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
		w.Header().Set("Content-Type", "application/pdf")
		w.Header().Set("Cache-Control", "no-store") // файл могли пересобрать на месте
		http.ServeContent(w, r, filepath.Base(p), st.ModTime(), f)
	})

	// начать файл i: завести папку для его страниц
	mux.HandleFunc("/api/pdf-ras-begin", s.api(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			I int `json:"i"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		rasterMu.Lock()
		defer rasterMu.Unlock()
		j := rasterGet(body.I)
		if j == nil {
			writeJSON(w, map[string]any{"canceled": true})
			return
		}
		if j.dirs[body.I] == "" {
			s.mu.Lock()
			src := s.files[body.I].Path
			s.mu.Unlock()
			dir, err := pdfRasterDir(src, j.req.SameDir, j.req.OutDir)
			if err != nil {
				writeJSON(w, map[string]any{"error": err.Error()})
				return
			}
			j.dirs[body.I] = dir
			s.set(body.I, func(fs *FileState) { fs.Status = "running" })
		}
		writeJSON(w, map[string]any{"dir": j.dirs[body.I]})
	}))

	// одна страница: тело запроса — готовая картинка; номер файла, страница по счёту, сколько всего и имя в адресе
	mux.HandleFunc("/api/pdf-page-save", s.api(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		i, _ := strconv.Atoi(q.Get("i"))
		n, _ := strconv.Atoi(q.Get("n"))
		of, _ := strconv.Atoi(q.Get("of"))
		rasterMu.Lock()
		j := rasterGet(i)
		dir := ""
		if j != nil {
			dir = j.dirs[i]
		}
		rasterMu.Unlock()
		if j == nil {
			writeJSON(w, map[string]any{"canceled": true})
			return
		}
		dst, err := pdfRasterSave(dir, q.Get("name"), http.MaxBytesReader(w, r.Body, 512<<20))
		if err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		rasterMu.Lock()
		if j.first[i] == "" {
			j.first[i] = dst
		}
		rasterMu.Unlock()
		if of > 0 {
			pct := float64(n) * 100 / float64(of)
			s.set(i, func(fs *FileState) { fs.Pct = pct })
		}
		writeJSON(w, map[string]any{"path": dst})
	}))

	// файл i закончен: error — что не вышло (текст уже переведён окном), pages — сколько страниц записано
	mux.HandleFunc("/api/pdf-ras-end", s.api(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			I     int    `json:"i"`
			Error string `json:"error"`
			Pages int    `json:"pages"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		rasterMu.Lock()
		defer rasterMu.Unlock()
		j := rasterGet(body.I)
		if j == nil {
			writeJSON(w, map[string]any{"canceled": true})
			return
		}
		i := body.I
		j.ended[i] = true
		j.left--
		s.mu.Lock()
		name := s.files[i].Name
		s.mu.Unlock()
		if body.Error != "" || j.first[i] == "" {
			j.bad++
			if j.first[i] == "" {
				os.Remove(j.dirs[i]) // ничего не записалось: пустую папку не оставляем (Remove не трогает непустую)
			}
			msg := body.Error
			if msg == "" {
				msg = tr("pdf.broken")
			}
			s.set(i, func(fs *FileState) { fs.Status = "error"; fs.Msg = msg; fs.Hint = msg })
			s.addLog("[pdf] %s: %s", name, msg)
		} else {
			j.ok++
			dir, first := j.dirs[i], j.first[i]
			msg := tr("pdf.rasPages", body.Pages, filepath.Base(dir))
			s.set(i, func(fs *FileState) { fs.Status = "ok"; fs.Pct = 100; fs.Dst = first; fs.Msg = msg })
			s.addLog("[pdf] %s → %s (%d)", name, dir, body.Pages)
		}
		if j.left == 0 {
			close(j.done)
		}
		writeJSON(w, map[string]any{"ok": true})
	}))
}
