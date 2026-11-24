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
	"strings"
	"testing"
)

// у каждого слота есть шаблон ровно того размера, что в имени, и сейв-зона внутри шаблона
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
		if sl.ZW <= 0 || sl.ZH <= 0 || sl.X < 0 || sl.Y < 0 || sl.X+sl.ZW > sl.W || sl.Y+sl.ZH > sl.H {
			t.Errorf("%s: сейв-зона выходит за шаблон", sl.Name)
		}
	}
}

// фоновые элементы: PNG с прозрачностью, имя без странных знаков (оно идёт в адрес /bannershapes/)
func TestBmkShapes(t *testing.T) {
	list := bmkShapes()
	if len(list) == 0 {
		t.Fatal("нет ни одного элемента в web/bannershapes")
	}
	for _, n := range list {
		if strings.ContainsAny(n, `/\?#%`) || !bmkShapeOK(n) {
			t.Errorf("%q: плохое имя", n)
		}
		raw, err := webFS.ReadFile("web/bannershapes/" + n + ".png")
		if err != nil {
			t.Errorf("%s: %v", n, err)
			continue
		}
		img, err := png.Decode(bytes.NewReader(raw))
		if err != nil {
			t.Errorf("%s: не PNG: %v", n, err)
			continue
		}
		b, clear := img.Bounds(), false
		for y := b.Min.Y; y < b.Max.Y && !clear; y += 7 {
			for x := b.Min.X; x < b.Max.X; x += 7 {
				if _, _, _, a := img.At(x, y).RGBA(); a < 0xffff {
					clear = true
					break
				}
			}
		}
		if !clear {
			t.Errorf("%s: без прозрачности закроет весь фон", n)
		}
	}
	if bmkShapeOK("../bannerbg/315x250") || bmkShapeOK("") {
		t.Error("принято чужое имя")
	}
}

// фигура не обрезана краем своего файла: иначе посреди баннера виден ровный срез (кусок конфетти, хвост свечения).
// Касаться края можно только острым углом — вершина треугольника, пара пикселей на сторону
func TestBmkShapesEdge(t *testing.T) {
	for _, n := range bmkShapes() {
		raw, err := webFS.ReadFile("web/bannershapes/" + n + ".png")
		if err != nil {
			t.Fatal(err)
		}
		img, err := png.Decode(bytes.NewReader(raw))
		if err != nil {
			t.Fatalf("%s: %v", n, err)
		}
		b := img.Bounds()
		solid := func(x, y int) bool { _, _, _, a := img.At(x, y).RGBA(); return a > 24*0x101 }
		count := func(pts func(i int) (int, int), n int) (c int) {
			for i := 0; i < n; i++ {
				if solid(pts(i)) {
					c++
				}
			}
			return
		}
		W, H := b.Dx(), b.Dy()
		sides := map[string]int{
			"слева":  count(func(i int) (int, int) { return b.Min.X, b.Min.Y + i }, H),
			"справа": count(func(i int) (int, int) { return b.Max.X - 1, b.Min.Y + i }, H),
			"сверху": count(func(i int) (int, int) { return b.Min.X + i, b.Min.Y }, W),
			"снизу":  count(func(i int) (int, int) { return b.Min.X + i, b.Max.Y - 1 }, W),
		}
		for s, c := range sides {
			if c > 3 {
				t.Errorf("%s: %s упирается в край файла (%d px), срез будет виден", n, s, c)
			}
		}
	}
}

// страница присылает баннер не того размера или чужое имя — ошибка, файлы не пишутся
func TestBmkOneBad(t *testing.T) {
	dir := t.TempDir()
	for _, c := range []struct {
		name string
		w, h int
	}{{"315x250", 100, 100}, {"315x250", 250, 315}, {"nope", 315, 250}} {
		if _, err := bmkOne(context.Background(), "ffmpeg", dir, c.name, image.NewNRGBA(image.Rect(0, 0, c.w, c.h))); err == nil {
			t.Errorf("%s %dx%d: ждали ошибку", c.name, c.w, c.h)
		}
	}
	if ents, _ := os.ReadDir(dir); len(ents) != 0 {
		t.Error("что-то записано")
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
	for _, name := range []string{"4056x496_R", "105x167"} {
		sl, _ := bmkSlotOf(name)
		img := image.NewNRGBA(image.Rect(0, 0, sl.W, sl.H))
		for y := 0; y < sl.H; y++ {
			for x := 0; x < sl.W; x++ {
				img.Set(x, y, color.NRGBA{uint8(x), uint8(y), uint8(x ^ y), 255})
			}
		}
		res, err := bmkOne(context.Background(), ffm, dir, name, img)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
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
