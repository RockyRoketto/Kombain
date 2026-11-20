package main

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"strings"
	"testing"
)

func TestGenOutpaint(t *testing.T) {
	red := color.NRGBA{200, 10, 10, 255}
	src := inpPNG(t, inpFill(600, 400, red))
	patch, init, msk, w, h, err := genOutpaintPrep(src, []int{0, 0, 300, 100}, 512, 512, false)
	if err != nil {
		t.Fatal(err)
	}
	if pw, ph := patch.Size(); pw != 900 || ph != 500 {
		t.Fatalf("canvas %dx%d", pw, ph)
	}
	if w%64 != 0 || h%64 != 0 {
		t.Errorf("engine size %dx%d", w, h)
	}
	for _, b := range [][]byte{init, msk} {
		c, err := png.DecodeConfig(bytes.NewReader(b))
		if err != nil || c.Width != w || c.Height != h {
			t.Errorf("engine input %+v %v", c, err)
		}
	}
	// вырезка задевает и новую полосу, и картинку (модели нужно видеть, что продолжать)
	if cr := patch.crop; !image.Rect(600, 400, 900, 500).In(cr) || cr.Min.X >= 500 {
		t.Errorf("crop %v", cr)
	}
	// заливка новой полосы — продолжение однотонной картинки, без чёрного
	if c := patch.orig.NRGBAAt(890, 490); c.R < 150 || c.A != 255 {
		t.Errorf("fill %v", c)
	}

	out, err := patch.apply(inpPNG(t, inpFill(w, h, color.NRGBA{10, 10, 200, 255})))
	if err != nil {
		t.Fatal(err)
	}
	img, err := png.Decode(bytes.NewReader(out))
	if err != nil || img.Bounds().Dx() != 900 || img.Bounds().Dy() != 500 {
		t.Fatalf("out %v %v", img.Bounds(), err)
	}
	at := func(x, y int) color.NRGBA { return color.NRGBAModel.Convert(img.At(x, y)).(color.NRGBA) }
	for _, p := range [][2]int{{850, 200}, {300, 480}, {650, 450}, {899, 499}} { // новое (переход идёт по полосе, 32 точки от границы)
		if c := at(p[0], p[1]); c.B < 190 {
			t.Errorf("new %v: %v", p, c)
		}
	}
	for _, p := range [][2]int{{0, 0}, {300, 200}, {560, 360}, {599, 200}, {300, 399}} { // исходное до самой границы — как было
		if c := at(p[0], p[1]); c != red {
			t.Errorf("kept %v: %v", p, c)
		}
	}
}

func TestGenOutpaintBad(t *testing.T) {
	src := inpPNG(t, inpFill(200, 100, color.NRGBA{1, 2, 3, 255}))
	for _, ext := range [][]int{nil, {0, 0, 0}, {0, 0, 0, 0}, {-1, 0, 10, 0}, {201, 0, 0, 0}, {0, 101, 0, 0}} {
		if _, _, _, _, _, err := genOutpaintPrep(src, ext, 512, 512, false); err == nil {
			t.Errorf("%v: no error", ext)
		}
	}
	big := inpPNG(t, inpFill(5000, 10, color.NRGBA{1, 2, 3, 255}))
	if _, _, _, _, _, err := genOutpaintPrep(big, []int{2000, 0, 2000, 0}, 512, 512, false); err == nil {
		t.Error("over max side")
	}
	if _, _, _, _, _, err := genOutpaintPrep(src, []int{200, 100, 200, 100}, 512, 512, false); err != nil { // втрое по обеим осям можно
		t.Error(err)
	}
}

// модель нарисовала всё светлее исходной (другой свет): у границы новое подгоняется к исходной, дальше остаётся как есть
func TestGenOutMatch(t *testing.T) {
	gray := func(v uint8) color.NRGBA { return color.NRGBA{v, v, v, 255} }
	patch, _, _, w, h, err := genOutpaintPrep(inpPNG(t, inpFill(256, 256, gray(100))), []int{64, 0, 0, 0}, 512, 512, false)
	if err != nil {
		t.Fatal(err)
	}
	out, err := patch.apply(inpPNG(t, inpFill(w, h, gray(120))))
	if err != nil {
		t.Fatal(err)
	}
	img, _ := png.Decode(bytes.NewReader(out))
	at := func(x int) uint8 { return color.NRGBAModel.Convert(img.At(x, 128)).(color.NRGBA).R }
	if v := at(54); v > 104 { // без подгонки 110
		t.Errorf("у границы %d", v)
	}
	if v := at(5); v < 118 {
		t.Errorf("вдали %d", v)
	}
	if v := at(100); v != 100 {
		t.Errorf("исходная %d", v)
	}
}

func TestGenOutLead(t *testing.T) {
	scene := "a man in a vest"
	old := "Outpainting: the blurred area. Scene: Outpainting: again. Scene: " + scene
	if got := genOutScene(old); got != scene {
		t.Errorf("scene %q", got)
	}
	if got := genOutScene("low poly 3d render of " + old); got != scene {
		t.Errorf("styled %q", got)
	}
	if genOutScene(scene) != scene {
		t.Error("обычный промт изменился")
	}
	if !strings.HasSuffix(genOutLead(true), "In the new area: ") || !strings.HasSuffix(genOutLead(false), "Scene: ") {
		t.Error("lead")
	}
	if genOutScene(genOutLead(false)+scene) != scene || genOutScene(genOutLead(true)+scene) != scene {
		t.Error("своё указание не снимается")
	}
}
