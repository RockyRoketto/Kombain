package main

import (
	"context"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

// Прозрачный PNG (после «Убрать фон») в JPG ложится на белый, а не на чёрный.
func TestGenExportTransparentJPG(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "a-nobg.png")
	im := image.NewNRGBA(image.Rect(0, 0, 8, 8))
	im.SetNRGBA(4, 4, color.NRGBA{200, 0, 0, 255}) // остальное: полностью прозрачное, цвет 0,0,0
	f, _ := os.Create(src)
	png.Encode(f, im)
	f.Close()
	dst := filepath.Join(dir, "a.jpg")
	if err := genExport(context.Background(), "", src, dst, "jpg"); err != nil {
		t.Fatal(err)
	}
	g, _ := os.Open(dst)
	defer g.Close()
	out, err := jpeg.Decode(g)
	if err != nil {
		t.Fatal(err)
	}
	r, gg, b, _ := out.At(0, 0).RGBA()
	if r>>8 < 240 || gg>>8 < 240 || b>>8 < 240 {
		t.Fatalf("фон не белый: %d %d %d", r>>8, gg>>8, b>>8)
	}
}
