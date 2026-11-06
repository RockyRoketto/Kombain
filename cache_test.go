package main

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestTextPrune(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	os.MkdirAll(textDir(), 0o755)
	now := time.Now()
	put := func(name string, size int, age time.Duration) string {
		p := filepath.Join(textDir(), name)
		if err := os.WriteFile(p, make([]byte, size), 0o644); err != nil {
			t.Fatal(err)
		}
		os.Chtimes(p, now.Add(-age), now.Add(-age))
		return p
	}
	fresh := put("fresh.png", 10, time.Hour)
	young := put("young.png", 10, textKeepAge-time.Hour)
	old := put("old.png", 10, textKeepAge+time.Hour)
	textPrune(now)
	if !fileExists(fresh) || !fileExists(young) {
		t.Error("удалена картинка моложе срока")
	}
	if fileExists(old) {
		t.Error("старая картинка осталась")
	}
	// сверх предела уходят самые давние, даже если срок не вышел
	newest := put("a.png", textKeepSize-100, time.Minute)
	over := put("b.png", 1000, 2*time.Hour)
	textPrune(now)
	if !fileExists(newest) || !fileExists(fresh) {
		t.Error("предел удалил свежую картинку")
	}
	if fileExists(over) {
		t.Error("предел веса не сработал")
	}
}

// Картинка открытого проекта не должна стареть, а удалённая должна появиться снова с тем же именем
func TestTextPNGUse(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	png := base64.StdEncoding.EncodeToString([]byte("\x89PNG\r\n\x1a\nкартинка"))
	p, fresh, err := saveTextPNG(png)
	if err != nil || !fresh {
		t.Fatal(p, fresh, err)
	}
	long := time.Now().Add(-textKeepAge - time.Hour)
	os.Chtimes(p, long, long)
	if q, fresh, err := saveTextPNG(png); q != p || fresh || err != nil {
		t.Fatal(q, fresh, err)
	}
	textPrune(time.Now())
	if !fileExists(p) {
		t.Fatal("использованная картинка удалена")
	}
	os.Remove(p)
	if q, fresh, err := saveTextPNG(png); q != p || !fresh || err != nil || !fileExists(p) {
		t.Fatal(q, fresh, err)
	}
}

func TestCacheTidy(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	gone := []string{filepath.Join(dropDir(), "x", "a.mp4"), filepath.Join(subsDir(), "a.ass"), filepath.Join(cacheDir(), "update", "Konvertor.exe"), filepath.Join(cacheDir(), "whisper", "audio.wav")}
	kept := []string{filepath.Join(proxyDir(), "a.mp4"), filepath.Join(textDir(), "a.png"), filepath.Join(cacheDir(), "whisper-last.json")}
	for _, p := range append(gone, kept...) {
		os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	cacheTidy()
	for _, p := range gone {
		if fileExists(p) {
			t.Error("осталось:", p)
		}
	}
	for _, p := range kept {
		if !fileExists(p) {
			t.Error("удалено лишнее:", p)
		}
	}
}
