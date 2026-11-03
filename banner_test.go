package main

import (
	"crypto/rand"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
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
