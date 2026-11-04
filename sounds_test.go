package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSystemSounds(t *testing.T) {
	root := t.TempDir()
	t.Setenv("SystemRoot", root)
	if got := systemSounds(); got == nil || len(got) != 0 {
		t.Fatalf("без папки Media ждали пустой список, а не nil: %#v", got)
	}
	media := filepath.Join(root, "Media")
	os.MkdirAll(media, 0o755)
	os.WriteFile(filepath.Join(media, "tada.wav"), []byte("x"), 0o644)
	os.WriteFile(filepath.Join(media, "other.wav"), []byte("x"), 0o644)
	got := systemSounds()
	if len(got) != 1 || got[0].Name != "tada" || got[0].Path != filepath.Join(media, "tada.wav") {
		t.Fatalf("ждали только tada: %#v", got)
	}
	t.Setenv("SystemRoot", "")
	if got := systemSounds(); len(got) != 0 {
		t.Fatalf("без SystemRoot ждали пустой список: %#v", got)
	}
}
