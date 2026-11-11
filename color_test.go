package main

import (
	"encoding/base64"
	"testing"
)

func TestColorFileBytes(t *testing.T) {
	png := append(append([]byte{}, pngMagic...), 1, 2, 3)
	if b, err := colorFileBytes("png", base64.StdEncoding.EncodeToString(png)); err != nil || len(b) != len(png) {
		t.Fatalf("PNG не принят: %v", err)
	}
	for _, bad := range []string{"", "!!!", base64.StdEncoding.EncodeToString([]byte("GIF89a"))} {
		if _, err := colorFileBytes("png", bad); err == nil {
			t.Errorf("негодный PNG %q принят", bad)
		}
	}
	svg := `<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"></svg>`
	if b, err := colorFileBytes("svg", "  "+svg+"\n"); err != nil || string(b) != svg+"\n" {
		t.Fatalf("SVG не принят: %v %q", err, b)
	}
	for _, bad := range []string{"", "<html></html>", "<svg>"} {
		if _, err := colorFileBytes("svg", bad); err == nil {
			t.Errorf("негодный SVG %q принят", bad)
		}
	}
	if _, err := colorFileBytes("exe", "x"); err == nil {
		t.Error("неизвестный вид файла принят")
	}
}

func TestColorFileName(t *testing.T) {
	for _, c := range [][3]string{
		{"gradient-1920x1080", "png", "gradient-1920x1080.png"},
		{"g.svg", "svg", "g.svg"},
		{"", "png", "gradient.png"},
		{"  ", "svg", "gradient.svg"},
		{`a:b/c`, "png", "c.png"},
	} {
		if got := colorFileName(c[0], c[1]); got != c[2] {
			t.Errorf("colorFileName(%q, %q) = %q, ждали %q", c[0], c[1], got, c[2])
		}
	}
}
