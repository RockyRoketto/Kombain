package main

import (
	"image"
	"image/color"
	"testing"
)

// хромакей: зелёный фон прозрачный, серая тонкая спица и красный предмет остаются, обычная картинка не трогается
func TestBgKeyAlpha(t *testing.T) {
	img := image.NewNRGBA(image.Rect(0, 0, 60, 60))
	for y := 0; y < 60; y++ {
		for x := 0; x < 60; x++ {
			img.SetNRGBA(x, y, color.NRGBA{20, 220, 30, 255})
		}
	}
	for y := 10; y < 50; y++ {
		img.SetNRGBA(30, y, color.NRGBA{200, 200, 200, 255}) // спица в один пиксель
	}
	img.SetNRGBA(10, 10, color.NRGBA{200, 30, 30, 255})
	a := bgKeyAlpha(img)
	if a == nil {
		t.Fatal("хромакей не найден")
	}
	if a[5*60+5] != 0 || a[30*60+30] != 1 || a[10*60+10] != 1 {
		t.Fatal("фон", a[5*60+5], "спица", a[30*60+30], "красный", a[10*60+10])
	}
	white := image.NewNRGBA(image.Rect(0, 0, 60, 60))
	for i := range white.Pix {
		white.Pix[i] = 255
	}
	if bgKeyAlpha(white) != nil {
		t.Fatal("белый фон принят за хромакей")
	}
}

// зелёный засвет на краю оранжевого шара убирается, а зелёное в глубине предмета остаётся
func TestBgDespillGreen(t *testing.T) {
	img := image.NewNRGBA(image.Rect(0, 0, 100, 100))
	a := make([]float32, 100*100)
	for y := 0; y < 100; y++ {
		for x := 0; x < 100; x++ {
			if x < 20 {
				img.SetNRGBA(x, y, color.NRGBA{0, 255, 0, 255}) // фон
			} else {
				a[y*100+x] = 1
				img.SetNRGBA(x, y, color.NRGBA{230, 140, 40, 255})
			}
		}
	}
	img.SetNRGBA(21, 50, color.NRGBA{200, 230, 60, 255}) // засвет у края
	img.SetNRGBA(90, 50, color.NRGBA{20, 200, 20, 255})  // зелёная деталь вдали от фона
	bgDespillGreen(img, a)
	if g := img.NRGBAAt(21, 50).G; g > 150 {
		t.Fatal("засвет остался", g)
	}
	if g := img.NRGBAAt(90, 50).G; g != 200 {
		t.Fatal("зелёная деталь испорчена", g)
	}
}
