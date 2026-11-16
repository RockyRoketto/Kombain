package main

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"testing"
)

func inpPNG(t *testing.T, img image.Image) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func inpFill(w, h int, c color.NRGBA) *image.NRGBA {
	m := image.NewNRGBA(image.Rect(0, 0, w, h))
	for i := 0; i < len(m.Pix); i += 4 {
		m.Pix[i], m.Pix[i+1], m.Pix[i+2], m.Pix[i+3] = c.R, c.G, c.B, c.A
	}
	return m
}

func TestGenInpaintPatch(t *testing.T) {
	red := color.NRGBA{200, 10, 10, 255}
	src := inpPNG(t, inpFill(1000, 600, red))
	// маска вдвое меньше картинки (страница может прислать уменьшенную): закрашен квадрат 50..70 → 100..140 на картинке
	mask := image.NewNRGBA(image.Rect(0, 0, 500, 300))
	for y := 50; y < 70; y++ {
		for x := 50; x < 70; x++ {
			mask.Set(x, y, color.NRGBA{255, 255, 255, 255})
		}
	}
	patch, init, msk, w, h, err := genInpaintPrep(src, inpPNG(t, mask), 512, 512)
	if err != nil {
		t.Fatal(err)
	}
	if w%64 != 0 || h%64 != 0 || w*h < 512*512*3/4 || w*h > 512*512*4/3 {
		t.Errorf("size %dx%d", w, h)
	}
	for _, b := range [][]byte{init, msk} {
		c, err := png.DecodeConfig(bytes.NewReader(b))
		if err != nil || c.Width != w || c.Height != h {
			t.Errorf("engine input %+v %v", c, err)
		}
	}
	cr := patch.crop
	if !image.Rect(100, 100, 140, 140).In(cr) || !cr.In(image.Rect(0, 0, 1000, 600)) || cr.Dx() < 256 || cr.Dy() < 256 {
		t.Errorf("crop %v", cr)
	}
	if pw, ph := patch.Size(); pw != 1000 || ph != 600 {
		t.Errorf("patch size %dx%d", pw, ph)
	}

	out, err := patch.apply(inpPNG(t, inpFill(w, h, color.NRGBA{10, 10, 200, 255})))
	if err != nil {
		t.Fatal(err)
	}
	img, err := png.Decode(bytes.NewReader(out))
	if err != nil || img.Bounds().Dx() != 1000 || img.Bounds().Dy() != 600 {
		t.Fatalf("out %v %v", img.Bounds(), err)
	}
	at := func(x, y int) color.NRGBA { return color.NRGBAModel.Convert(img.At(x, y)).(color.NRGBA) }
	if c := at(120, 120); c.B < 190 || c.R > 20 { // закрашенное — новое
		t.Errorf("inside %v", c)
	}
	if c := at(100, 100); c.B < 190 { // и у самого края закрашенного
		t.Errorf("mask edge %v", c)
	}
	for _, p := range [][2]int{{900, 500}, {0, 0}, {120, 160}, {160, 120}} { // дальше мягкого края — как было
		if c := at(p[0], p[1]); c != red {
			t.Errorf("outside %v: %v", p, c)
		}
	}
	if c := at(141, 120); c == red || c.B > 190 { // полоса мягкого края — смесь
		t.Errorf("feather %v", c)
	}
}

func TestGenInpaintEmpty(t *testing.T) {
	src := inpPNG(t, inpFill(300, 300, color.NRGBA{1, 2, 3, 255}))
	// чёрная непрозрачная маска — ничего не выделено, как и прозрачная
	for _, m := range []image.Image{inpFill(300, 300, color.NRGBA{0, 0, 0, 255}), image.NewNRGBA(image.Rect(0, 0, 300, 300))} {
		if _, _, _, _, _, err := genInpaintPrep(src, inpPNG(t, m), 1024, 1024); err == nil {
			t.Error("empty mask accepted")
		}
	}
	if _, _, _, _, _, err := genInpaintPrep(src, []byte("junk"), 1024, 1024); err == nil {
		t.Error("junk mask accepted")
	}
}

func TestGenInpaintEdge(t *testing.T) {
	// закрашено до самого края: край картинки тоже новый (размытие не подмешивает старое из-за границы)
	src := inpPNG(t, inpFill(512, 512, color.NRGBA{200, 0, 0, 255}))
	mask := image.NewNRGBA(image.Rect(0, 0, 512, 512))
	for y := 0; y < 60; y++ {
		for x := 0; x < 512; x++ {
			mask.Set(x, y, color.White)
		}
	}
	patch, _, _, w, h, err := genInpaintPrep(src, inpPNG(t, mask), 1024, 1024)
	if err != nil {
		t.Fatal(err)
	}
	out, _ := patch.apply(inpPNG(t, inpFill(w, h, color.NRGBA{0, 0, 200, 255})))
	img, _ := png.Decode(bytes.NewReader(out))
	for _, p := range [][2]int{{0, 0}, {511, 0}, {256, 59}} {
		if r, _, _, _ := img.At(p[0], p[1]).RGBA(); r>>8 > 10 {
			t.Errorf("edge %v not replaced", p)
		}
	}
}

func TestGenCropAround(t *testing.T) {
	// маленькое выделение в углу: вырезка не меньше minSide и не выходит за картинку
	c := genCropAround(image.Rect(5, 5, 15, 15), 4096, 4096, 16, 512)
	if c.Min.X != 0 || c.Min.Y != 0 || c.Dx() != 512 || c.Dy() != 512 {
		t.Errorf("corner %v", c)
	}
	// длинная полоса: не уже 1:2
	c = genCropAround(image.Rect(100, 500, 1900, 520), 2000, 1000, 4, 512)
	if c.Dx() > 2*c.Dy() || !image.Rect(100, 500, 1900, 520).In(c) {
		t.Errorf("strip %v", c)
	}
	// картинка меньше minSide — вся картинка
	if c = genCropAround(image.Rect(10, 10, 20, 20), 300, 200, 3, 512); c != image.Rect(0, 0, 300, 200) {
		t.Errorf("small %v", c)
	}
}

func TestGenMaskData(t *testing.T) {
	if b, err := genMaskData("data:image/png;base64,aGk="); err != nil || string(b) != "hi" {
		t.Errorf("%q %v", b, err)
	}
	if _, err := genMaskData("data:image/png;base64,***"); err == nil {
		t.Error("bad base64 accepted")
	}
}

func TestGenInpStrength(t *testing.T) {
	for _, c := range []struct{ in, want float64 }{{0, genInpaintStrength}, {0.1, genInpaintStrength}, {1.5, genInpaintStrength}, {0.3, 0.3}, {0.65, 0.65}, {1, 1}} {
		if got := genInpStrength(c.in); got != c.want {
			t.Errorf("genInpStrength(%v) = %v, want %v", c.in, got, c.want)
		}
	}
}
