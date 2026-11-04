package main

import (
	"context"
	"crypto/rand"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestBannerNames(t *testing.T) {
	cases := map[string]string{
		`1380x248_R.png`:  "1380x248_R",
		`1380×248_r.PNG`:  "1380x248_R", // знак умножения
		`1380х248_R.png`:  "1380x248_R", // русская х
		`344x157 _C.png`:  "344x157_C",
		`315x250.png`:     "315x250",
		`315x250_R.png`:   "",
		`1380x248_R1.png`: "",
	}
	for p, want := range cases {
		if got := bannerWanted(p); got != want {
			t.Errorf("%s: %q, want %q", p, got, want)
		}
	}
	if w, h, ok := bannerDims(`4056х496_R.png`); !ok || w != "4056" || h != "496" {
		t.Errorf("dims: %s %s %v", w, h, ok)
	}
	if _, _, ok := bannerDims(`logo.png`); ok {
		t.Error("logo.png: размера в имени нет")
	}
}

// с настоящим ffmpeg: большой PNG пережимается на месте, файлы из списка → JPG и WebP
func TestRunBanners(t *testing.T) {
	ffm, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg не найден")
	}
	dir := t.TempDir()
	src := filepath.Join(dir, "src")
	os.MkdirAll(filepath.Join(src, "sub"), 0o755)
	big := filepath.Join(src, "sub", "800x260_R.png")
	noise := filepath.Join(dir, "noise.bin")
	b := make([]byte, 1600*520*3)
	rand.Read(b)
	os.WriteFile(noise, b, 0o644)
	// шум 1600×520 — PNG заведомо больше 500 КБ и не того размера, что в имени
	run := func(args ...string) {
		if out, err := exec.Command(ffm, append([]string{"-y", "-loglevel", "error"}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("%v: %s", err, out)
		}
	}
	run("-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "1600x520", "-i", noise, "-frames:v", "1", big)
	small := filepath.Join(src, "315x250.png")
	run("-f", "lavfi", "-i", "color=red:s=315x250", "-frames:v", "1", small)
	other := filepath.Join(src, "logo.png")
	run("-f", "lavfi", "-i", "color=blue:s=64x64", "-frames:v", "1", other)
	if fileSize(big) <= bannerLimit {
		t.Fatalf("тестовый PNG слишком мал: %d", fileSize(big))
	}

	s := &Server{}
	jpg, webp := filepath.Join(dir, "jpg"), filepath.Join(dir, "webp")
	s.runBanners(BannerReq{Files: []string{big, small, other}, JpgDir: jpg, WebpDir: webp}, ffm)

	for _, fs := range s.files {
		if fs.Status != "ok" {
			t.Errorf("%s: %s %s %s", fs.Name, fs.Status, fs.Msg, fs.Hint)
		}
	}
	if n := fileSize(big); n == 0 || n > bannerLimit {
		t.Errorf("PNG не пережат: %d", n)
	}
	if mi := getMediaInfo(ffm, big); mi.W != 800 || mi.H != 260 {
		t.Errorf("PNG %dx%d, want 800x260", mi.W, mi.H)
	}
	for _, p := range []string{
		filepath.Join(jpg, "800x260_R.jpg"), filepath.Join(jpg, "315x250.jpg"),
		filepath.Join(webp, "800x260_R.webp"), filepath.Join(webp, "315x250.webp"),
	} {
		if fileSize(p) == 0 {
			t.Errorf("нет %s", p)
		}
	}
	if fileExists(filepath.Join(jpg, "logo.jpg")) {
		t.Error("logo.png не из списка, JPG не нужен")
	}
	if left, _ := filepath.Glob(filepath.Join(src, "sub", "_tmp*")); len(left) > 0 {
		t.Errorf("остались временные файлы: %v", left)
	}
}

// файл заняли, как ffmpeg миниатюры: простая замена получает отказ, replaceFile дожидается
func TestReplaceFileBusy(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("занятый файл мешает замене только в Windows")
	}
	wait := replaceWait
	defer func() { replaceWait = wait }()
	dir := t.TempDir()
	from, to := filepath.Join(dir, "new.png"), filepath.Join(dir, "old.png")
	os.WriteFile(from, []byte("new"), 0o644)
	os.WriteFile(to, []byte("old"), 0o644)
	content := func(p string) string { b, _ := os.ReadFile(p); return string(b) }

	h, err := os.Open(to)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	if os.Rename(from, to) == nil {
		t.Fatal("занятый файл заменился, тест ничего не проверяет")
	}

	// файл не освободился: ошибка, оригинал и новый файл целы
	replaceWait = 150 * time.Millisecond
	if replaceFile(context.Background(), from, to) == nil {
		t.Error("ждали ошибку: файл занят всё время")
	}
	if content(to) != "old" || content(from) != "new" {
		t.Errorf("после отказа: to=%q from=%q", content(to), content(from))
	}

	// «Стоп» не ждёт весь срок
	replaceWait = time.Minute
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	st := time.Now()
	if replaceFile(ctx, from, to) == nil {
		t.Error("ждали ошибку после отмены")
	}
	if d := time.Since(st); d > 5*time.Second {
		t.Errorf("отмена заняла %v", d)
	}

	// файл освободился: замена проходит
	time.AfterFunc(200*time.Millisecond, func() { h.Close() })
	if err := replaceFile(context.Background(), from, to); err != nil {
		t.Fatal(err)
	}
	if content(to) != "new" || fileExists(from) {
		t.Errorf("после замены: to=%q, from есть: %v", content(to), fileExists(from))
	}
}
