package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCutNames(t *testing.T) {
	for in, want := range map[string]string{
		"cat":               "cat",
		"cat-nobg":          "cat",
		"cat-nobg-2":        "cat",
		"cat-nobg-fix":      "cat",
		"cat-nobg-fix-3":    "cat",
		"cat-x2-nobg":       "cat",
		"my-photo-nobg":     "my-photo",
		"20261125-1-7-nobg": "20261125-1-7",
	} {
		if got := cutBase(in); got != want {
			t.Errorf("cutBase(%q) = %q, want %q", in, got, want)
		}
	}
	for in, want := range map[string]string{
		"cat-nobg":       "cat-nobg-fix",
		"cat-nobg-fix":   "cat-nobg-fix",
		"cat-nobg-fix-2": "cat-nobg-fix",
	} {
		if got := cutFixStem(in); got != want {
			t.Errorf("cutFixStem(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestCutSaveAndSrc(t *testing.T) {
	dir := t.TempDir()
	orig := filepath.Join(dir, "cat.jpg")
	cut := filepath.Join(dir, "cat-nobg.png")
	os.WriteFile(orig, []byte("jpg"), 0o644)
	os.WriteFile(cut, pngMagic, 0o644)
	if got := cutSrcOf(cut); got != orig {
		t.Fatalf("cutSrcOf = %q, want %q", got, orig)
	}
	if _, err := cutSave(cut, []byte("not png")); err == nil {
		t.Fatal("cutSave принял не PNG")
	}
	data := append(append([]byte{}, pngMagic...), 1, 2, 3)
	p1, err := cutSave(cut, data)
	if err != nil || filepath.Base(p1) != "cat-nobg-fix.png" {
		t.Fatalf("cutSave = %q, %v", p1, err)
	}
	p2, _ := cutSave(p1, data)
	if filepath.Base(p2) != "cat-nobg-fix-2.png" {
		t.Fatalf("повторная правка = %q", p2)
	}
	if b, _ := os.ReadFile(cut); len(b) != len(pngMagic) {
		t.Fatal("правленый файл изменился")
	}
	if got := cutSrcOf(p2); got != orig {
		t.Fatalf("cutSrcOf(fix-2) = %q", got)
	}
}
