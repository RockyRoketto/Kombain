package main

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
)

// у каждого слота есть шаблон ровно того размера, что в имени, и квадрат внутри шаблона
func TestBmkSlots(t *testing.T) {
	seen := map[string]bool{}
	for _, sl := range bmkSlots {
		if seen[sl.Name] {
			t.Errorf("%s дважды", sl.Name)
		}
		seen[sl.Name] = true
		raw, err := webFS.ReadFile("web/bannerbg/" + sl.Name + ".png")
		if err != nil {
			t.Errorf("%s: нет шаблона: %v", sl.Name, err)
			continue
		}
		cfg, err := png.DecodeConfig(bytes.NewReader(raw))
		if err != nil || cfg.Width != sl.W || cfg.Height != sl.H {
			t.Errorf("%s: шаблон %dx%d, ждали %dx%d (%v)", sl.Name, cfg.Width, cfg.Height, sl.W, sl.H, err)
		}
		if w, h, ok := bannerDims(sl.Name + ".png"); !ok || w != strconv.Itoa(sl.W) || h != strconv.Itoa(sl.H) {
			t.Errorf("%s: размер в имени не совпадает с %dx%d", sl.Name, sl.W, sl.H)
		}
		if sl.X < 0 || sl.Y < 0 || sl.X+sl.S > sl.W || sl.Y+sl.S > sl.H {
			t.Errorf("%s: квадрат выходит за шаблон", sl.Name)
		}
	}
}

func TestBmkFit(t *testing.T) {
	sl := bmkSlot{X: 100, Y: 10, S: 200}
	cases := []struct {
		w, h int
		adj  bmkAdj
		want image.Rectangle
	}{
		{50, 50, bmkAdj{}, image.Rect(100, 10, 300, 210)},
		{400, 200, bmkAdj{}, image.Rect(100, 60, 300, 160)},
		{100, 400, bmkAdj{}, image.Rect(175, 10, 225, 210)},
		{50, 50, bmkAdj{K: 0.5}, image.Rect(150, 60, 250, 160)},
		{50, 50, bmkAdj{K: 1, DX: 0.5, DY: -0.25}, image.Rect(200, -40, 400, 160)},
		{50, 50, bmkAdj{K: 100}, image.Rect(-200, -290, 600, 510)},
	}
	for _, c := range cases {
		if got := bmkFit(sl, c.w, c.h, c.adj); got != c.want {
			t.Errorf("%dx%d: %v, ждали %v", c.w, c.h, got, c.want)
		}
	}
}

// прозрачные поля обрезаются, картинка встаёт в квадрат, фон вне квадрата не тронут
func TestBmkTrimCompose(t *testing.T) {
	art := image.NewNRGBA(image.Rect(0, 0, 100, 60))
	for y := 20; y < 40; y++ {
		for x := 30; x < 70; x++ {
			art.Set(x, y, color.NRGBA{255, 0, 0, 255})
		}
	}
	tr := bmkTrim(art)
	if b := tr.Bounds(); b.Dx() != 40 || b.Dy() != 20 {
		t.Fatalf("обрезка: %v", b)
	}
	sl, _ := bmkSlotOf("315x250")
	img, err := bmkCompose(sl, tr, bmkAdj{})
	if err != nil {
		t.Fatal(err)
	}
	if img.Bounds().Dx() != 315 || img.Bounds().Dy() != 250 {
		t.Fatalf("размер %v", img.Bounds())
	}
	r := bmkFit(sl, 40, 20, bmkAdj{})
	c := img.NRGBAAt((r.Min.X+r.Max.X)/2, (r.Min.Y+r.Max.Y)/2)
	if c.R < 240 || c.G > 15 {
		t.Errorf("в середине квадрата не картинка: %v", c)
	}
	raw, _ := webFS.ReadFile("web/bannerbg/315x250.png")
	tpl, _ := png.Decode(bytes.NewReader(raw))
	r0, g0, b0, _ := tpl.At(5, 5).RGBA()
	r1, g1, b1, _ := img.At(5, 5).RGBA()
	if r0 != r1 || g0 != g1 || b0 != b1 {
		t.Errorf("фон в углу изменился")
	}
}

func TestBmkDirAndName(t *testing.T) {
	root := t.TempDir()
	dir, err := bmkDir(root, 11, 29, "  Arsenal vs Manchester City  ")
	if err != nil || dir != filepath.Join(root, "11", "29", "Arsenal vs Manchester City") {
		t.Errorf("%q %v", dir, err)
	}
	if dir, _ := bmkDir(root, 3, 5, "A/B: C?"); filepath.Base(dir) != "A B C" || filepath.Base(filepath.Dir(dir)) != "05" {
		t.Errorf("имя или день: %q", dir)
	}
	for _, c := range []struct {
		m, d  int
		match string
	}{{0, 1, "x"}, {13, 1, "x"}, {4, 31, "x"}, {2, 30, "x"}, {1, 1, " .. "}, {1, 1, "con"}} {
		if _, err := bmkDir(root, c.m, c.d, c.match); err == nil {
			t.Errorf("%d.%d %q: ждали ошибку", c.d, c.m, c.match)
		}
	}
	if _, err := bmkDir("", 1, 1, "x"); err == nil {
		t.Error("пустой корень принят")
	}
	if _, err := bmkDir(root, 2, 29, "x"); err != nil {
		t.Error("29 февраля:", err)
	}
}

// целиком через ffmpeg: три папки, все форматы, не больше 500 КБ
func TestBmkOneFfmpeg(t *testing.T) {
	ffm, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("нет ffmpeg")
	}
	dir := t.TempDir()
	for _, s := range bmkSub {
		os.MkdirAll(filepath.Join(dir, s), 0o755)
	}
	art := image.NewNRGBA(image.Rect(0, 0, 300, 300))
	for y := 0; y < 300; y++ {
		for x := 0; x < 300; x++ {
			art.Set(x, y, color.NRGBA{uint8(x), uint8(y), 200, 255})
		}
	}
	for _, name := range []string{"4056x496_R", "105x167"} {
		res, err := bmkOne(context.Background(), ffm, dir, art, name, bmkAdj{K: 1.3, DX: 0.2})
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		sl, _ := bmkSlotOf(name)
		for i, p := range []string{"png/" + name + ".png", "jpeg/" + name + ".jpg", "webp/" + name + ".webp"} {
			n := fileSize(filepath.Join(dir, p))
			if i > 0 && !sl.Site {
				if n > 0 {
					t.Errorf("%s: не баннер сайта, а %s есть", name, p)
				}
				continue
			}
			if n <= 0 || n > bannerLimit {
				t.Errorf("%s: %d байт", p, n)
			}
		}
		if _, has := res["jpg"]; has != sl.Site {
			t.Errorf("%s: jpg в ответе %v, сайт %v", name, has, sl.Site)
		}
	}
}

// JPEG и WebP — ровно для баннеров старой вкладки «Баннеры»
func TestBmkSite(t *testing.T) {
	n := 0
	for _, sl := range bmkSlots {
		if sl.Site {
			n++
		}
	}
	if n != len(bannerNames) {
		t.Errorf("баннеров сайта %d, в bannerNames %d", n, len(bannerNames))
	}
}
