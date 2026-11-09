package main

import (
	"os"
	"path/filepath"
	"testing"
)

func storageTemp(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
}

func put(t *testing.T, p string, n int) {
	t.Helper()
	os.MkdirAll(filepath.Dir(p), 0o755)
	if err := os.WriteFile(p, make([]byte, n), 0o644); err != nil {
		t.Fatal(err)
	}
}

func partOf(parts []StoragePart, kind, name string) int64 {
	for _, p := range parts {
		if p.Kind == kind && p.Name == name {
			return p.Bytes
		}
	}
	return 0
}

// Каждая часть считается один раз: копии не попадают в «кэш», модели не попадают в «прочее в моделях»
func TestStorageParts(t *testing.T) {
	storageTemp(t)
	put(t, ffPath(), 100)
	put(t, whisperModelPath("tiny"), 30)
	put(t, whisperModelPath("small")+".part", 7)
	put(t, filepath.Join(toolDir("whisper"), "whisper-cli.exe"), 20)
	put(t, filepath.Join(proxyDir(), "a.mp4"), 50)
	put(t, filepath.Join(textDir(), "a.png"), 5)
	put(t, filepath.Join(dataDir(), "settings.json"), 3)
	parts := storageParts()
	for _, c := range []struct {
		kind, name string
		want       int64
	}{{"ffmpeg", "", 100}, {"model", "tiny", 30}, {"model", "small", 0}, {"models", "", 7}, {"tools", "", 20}, {"preview", "", 50}, {"cache", "", 5}, {"other", "", 3}} {
		if got := partOf(parts, c.kind, c.name); got != c.want {
			t.Errorf("%s %s: %d, ждали %d", c.kind, c.name, got, c.want)
		}
	}
}

func TestCacheClear(t *testing.T) {
	storageTemp(t)
	gone := []string{filepath.Join(proxyDir(), "a.mp4"), filepath.Join(textDir(), "a.png"), filepath.Join(cacheDir(), "whisper-last.json")}
	kept := []string{filepath.Join(dropDir(), "x", "a.mp4"), filepath.Join(subsDir(), "a.ass"), whisperModelPath("tiny"), ffPath()}
	for _, p := range append(gone, kept...) {
		put(t, p, 1)
	}
	cacheClear()
	for _, p := range gone {
		if fileExists(p) {
			t.Errorf("остался %s", p)
		}
	}
	for _, p := range kept {
		if !fileExists(p) {
			t.Errorf("пропал %s", p)
		}
	}
}

func TestWhisperRemove(t *testing.T) {
	storageTemp(t)
	put(t, whisperModelPath("base"), 1)
	put(t, whisperExe(), 1)
	if err := whisperRemove("../../settings"); err == nil {
		t.Error("чужое имя должно быть ошибкой")
	}
	if err := whisperRemove("base"); err != nil || fileExists(whisperModelPath("base")) {
		t.Errorf("модель не удалилась: %v", err)
	}
	if err := whisperRemove("base"); err != nil {
		t.Errorf("повторное удаление: %v", err)
	}
	if err := whisperRemove(""); err != nil || fileExists(whisperExe()) {
		t.Errorf("программа не удалилась: %v", err)
	}
}

// Экономия только от полегчавших файлов; монтаж без размера исходника считается штукой
func TestStatsAdd(t *testing.T) {
	storageTemp(t)
	statsAdd([]FileState{
		{Status: "ok", SrcSize: 1000, DstSize: 400},
		{Status: "ok", SrcSize: 100, DstSize: 300},
		{Status: "ok", DstSize: 50},
		{Status: "error", SrcSize: 999},
		{Status: "kept", SrcSize: 999},
	})
	statsAdd([]FileState{{Status: "canceled"}})
	statsAdd([]FileState{{Status: "ok", SrcSize: 10, DstSize: 5}})
	st := readStats()
	if st.Files != 4 || st.In != 1110 || st.Out != 705 || st.Saved != 605 || st.Since.IsZero() {
		t.Errorf("%+v", st)
	}
}
