package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
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

// обрезка: -ss и -t стоят перед -i; у других файлов пачки их нет; пустой кусок значит «файл целиком»
func TestBuildArgsTrim(t *testing.T) {
	req := StartReq{CRF: 23, ABR: 128, Trims: map[string]Trim{"a.mp4": {Start: 1.5, End: 4}, "bad.mp4": {Start: 5, End: 2}}}
	args := strings.Join(buildArgs(formats["mp4"], req, "a.mp4", "o.mp4", srcInfo{}, false, nil), " ")
	if !strings.Contains(args, "-ss 1.500 -t 2.500 -i a.mp4") {
		t.Errorf("a.mp4: %s", args)
	}
	for _, src := range []string{"other.mp4", "bad.mp4"} {
		if args := strings.Join(buildArgs(formats["mp4"], req, src, "o.mp4", srcInfo{}, false, nil), " "); strings.Contains(args, "-ss") {
			t.Errorf("%s: %s", src, args)
		}
	}
}

// с настоящим ffmpeg: длительность результата равна куску, и видео, и звук
func TestConvertTrim(t *testing.T) {
	ffm, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg не найден")
	}
	dir := t.TempDir()
	vid, aud := filepath.Join(dir, "v.mov"), filepath.Join(dir, "a.wav")
	for _, c := range [][]string{
		{"-f", "lavfi", "-i", "testsrc=d=6:s=160x120:r=10", "-f", "lavfi", "-i", "sine=d=6", "-c:v", "libx264", "-c:a", "aac", vid},
		{"-f", "lavfi", "-i", "sine=d=6", aud},
	} {
		if out, err := exec.Command(ffm, append([]string{"-y", "-loglevel", "error"}, c...)...).CombinedOutput(); err != nil {
			t.Fatalf("%v: %s", err, out)
		}
	}
	for _, c := range []struct{ src, format, dst string }{{vid, "mp4", "v.mp4"}, {aud, "mp3", "a.mp3"}, {vid, "small", "v.mp4"}, {aud, "small", "a.mp3"}} {
		s := &Server{}
		req := StartReq{Files: []string{c.src}, Format: c.format, CRF: 28, ABR: 128, Preset: "ultrafast", SameDir: true, Overwrite: true, Jobs: 1,
			Trims: map[string]Trim{c.src: {Start: 1, End: 3}}}
		s.run(req, ffm)
		if fs := s.files[0]; fs.Status != "ok" {
			t.Fatalf("%s %s: %s %s", c.src, c.format, fs.Status, fs.Hint)
		}
		if d := getMediaInfo(ffm, filepath.Join(dir, c.dst)).Dur; d < 1.8 || d > 2.3 {
			t.Errorf("%s %s: длительность %.2f, ждали около 2", c.src, c.format, d)
		}
	}
}

// файлы снаружи: папки разворачиваются, не медиафайлы отсекаются, страница забирает список один раз
func TestAddIncoming(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "sub"), 0o755)
	for _, n := range []string{"a.mp4", "notes.txt", filepath.Join("sub", "b.png")} {
		os.WriteFile(filepath.Join(dir, n), []byte("x"), 0o644)
	}
	s := &Server{}
	s.addIncoming([]string{filepath.Join(dir, "a.mp4"), filepath.Join(dir, "notes.txt"), filepath.Join(dir, "sub"), filepath.Join(dir, "нет.mp4")})
	if len(s.incoming) != 2 || s.incoming[0].Path != filepath.Join(dir, "a.mp4") || s.incoming[1].Path != filepath.Join(dir, "sub", "b.png") {
		t.Errorf("%+v", s.incoming)
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
