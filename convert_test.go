package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// a.mov → a.mp4 не должен затереть a.mp4 из той же пачки, даже с «перезаписать»
func TestOutPathKeepsOtherSources(t *testing.T) {
	dir := t.TempDir()
	mov, mp4 := filepath.Join(dir, "a.mov"), filepath.Join(dir, "a.mp4")
	used := map[string]bool{strings.ToLower(mov): true, strings.ToLower(mp4): true}
	got := outPath(mov, StartReq{SameDir: true, Overwrite: true}, "mp4", used)
	if want := filepath.Join(dir, "a_converted.mp4"); got != want {
		t.Fatalf("получили %s, ждали %s", got, want)
	}
}

func TestOutPathAbsolute(t *testing.T) {
	src := filepath.Join(t.TempDir(), "a.mov")
	wd, _ := os.Getwd()
	rel := "testdata-out-" + strings.ReplaceAll(t.Name(), "/", "_")
	defer os.RemoveAll(filepath.Join(wd, rel))
	got := outPath(src, StartReq{OutDir: rel}, "mp4", map[string]bool{})
	if !filepath.IsAbs(got) {
		t.Fatalf("путь не абсолютный: %s", got)
	}
}

// «Стоп» до начала файла: прошлый результат остаётся на месте даже с «перезаписать»
func TestConvertCanceledKeepsResult(t *testing.T) {
	dir := t.TempDir()
	dst := filepath.Join(dir, "a.mp4")
	if err := os.WriteFile(dst, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := &Server{files: []*FileState{{Path: filepath.Join(dir, "a.mov"), Dst: dst, Status: "pending", f: formats["mp4"]}}}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	s.convert(ctx, 0, StartReq{Format: "mp4", Overwrite: true}, "ffmpeg-not-used")
	if s.files[0].Status != "canceled" {
		t.Errorf("статус %q", s.files[0].Status)
	}
	if !fileExists(dst) {
		t.Error("прошлый результат удалён")
	}
}

// из одновременных запусков проходит ровно один
func TestBeginOnlyOnce(t *testing.T) {
	s := &Server{ffmpeg: "ffmpeg", files: []*FileState{{Status: "ok"}}}
	var mu sync.Mutex
	ok := 0
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := s.begin("занято"); err == nil {
				mu.Lock()
				ok++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if ok != 1 {
		t.Fatalf("запустилось %d раз", ok)
	}
	if s.files != nil {
		t.Error("статусы прошлой пачки не сброшены")
	}
}

func TestDownloadStall(t *testing.T) {
	old := dlStall
	dlStall = 100 * time.Millisecond
	defer func() { dlStall = old }()
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "1000")
		w.Write([]byte("начало"))
		w.(http.Flusher).Flush()
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()
	defer close(release)

	path := filepath.Join(t.TempDir(), "f.part")
	start := time.Now()
	_, err := download(srv.URL, path, 0, 1<<20, nil, func(float64) {})
	if err == nil || !strings.Contains(err.Error(), "зависла") {
		t.Fatalf("ошибка: %v", err)
	}
	if time.Since(start) > 5*time.Second {
		t.Error("слишком долго ждали")
	}
	if fileExists(path) {
		t.Error("недокачанный файл не удалён")
	}
}
