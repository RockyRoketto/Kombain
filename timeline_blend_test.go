package main

import (
	"math"
	"testing"
)

// те же формулы считает браузер для mix-blend-mode (спецификация W3C compositing); s верхний слой, b нижний, от 0 до 1
func blendCalc(mode string, s, b float64) float64 {
	screen := func(x, y float64) float64 { return x + y - x*y }
	hard := func(s, b float64) float64 {
		if s <= 0.5 {
			return b * 2 * s
		}
		return screen(b, 2*s-1)
	}
	switch mode {
	case "screen":
		return screen(s, b)
	case "plus-lighter":
		return min(s+b, 1)
	case "lighten":
		return max(s, b)
	case "multiply":
		return s * b
	case "darken":
		return min(s, b)
	case "overlay":
		return hard(b, s)
	case "hard-light":
		return hard(s, b)
	case "difference":
		return math.Abs(s - b)
	}
	return s
}

func TestTimelineBlend(t *testing.T) {
	m := newMontFixture(t)
	under := m.color("under.mp4", "0x6080c0", 320, 240, 30, 1, 0)
	top := m.color("top.mp4", "0xe04080", 320, 240, 30, 1, 0)
	a, b := m.rgbOf(top), m.rgbOf(under)
	check := func(name string, got [3]float64, want func(i int) float64) {
		t.Helper()
		for i := range got {
			if math.Abs(got[i]-want(i)) > 5 {
				t.Errorf("%s: получилось %v, канал %d должен быть %.0f", name, got, i, want(i))
				return
			}
		}
	}
	for mode := range tlBlends {
		if mode == "" {
			continue
		}
		got := m.rgbOf(m.render(tracks([]Clip{{Path: under}}, []Clip{{Path: top, Blend: mode}}), "mp4"))
		check(mode, got, func(i int) float64 { return 255 * blendCalc(mode, a[i]/255, b[i]/255) })
	}
	// Другие выходы: кадр монтажа в PNG (там граф падал на alphaextract), прозрачные форматы, GIF. Цвет тот же, что в MP4
	p := tracks([]Clip{{Path: under}}, []Clip{{Path: top, Blend: "multiply"}})
	want := func(i int) float64 { return 255 * blendCalc("multiply", a[i]/255, b[i]/255) }
	shot, err := saveMontFrame(m.ffm, p, 0.5)
	if err != nil {
		t.Fatal("кадр в PNG: ", err)
	}
	check("кадр в PNG", m.rgbOf(shot), want)
	for _, f := range []string{"webm", "mov", "gif"} {
		if _, ok := formats[f]; ok {
			check(f, m.rgbOf(m.render(p, f)), want)
		}
	}
	// неизвестное значение в граф не попадает
	bad := tracks([]Clip{{Path: under}}, []Clip{{Path: top, Blend: "x;drop"}})
	bad.fit()
	if bad.Tracks[1].Clips[0].Blend != "" {
		t.Error("чужое значение режима осталось")
	}
	// огонь на чёрном: в Screen чёрное исчезает, нижний слой виден как есть
	black := m.color("black.mp4", "black", 320, 240, 30, 1, 0)
	got := m.rgbOf(m.render(tracks([]Clip{{Path: under}}, []Clip{{Path: black, Blend: "screen"}}), "mp4"))
	check("чёрное в screen", got, func(i int) float64 { return b[i] })
}

// Клип с режимом действует только там, где он есть: и во времени, и в кадре
func TestTimelineBlendPlace(t *testing.T) {
	m := newMontFixture(t)
	under := m.color("under.mp4", "gray", 320, 240, 30, 3, 0)
	top := m.color("top.mp4", "gray", 320, 240, 30, 1, 0)
	base := m.lumaAt(under, 0.5, 0.5, 0.5)
	want := float64(base) * float64(base) / 255
	near := func(name string, got int, v float64) {
		t.Helper()
		if math.Abs(float64(got)-v) > 8 {
			t.Errorf("%s: яркость %d, должно быть %.0f", name, got, v)
		}
	}
	// посередине монтажа: до и после клипа нижний слой не меняется, длина прежняя
	out := m.render(tracks([]Clip{{Path: under}}, []Clip{{Path: top, At: 1, Blend: "multiply"}}), "mp4")
	near("до клипа", m.lumaAt(out, 0.5, 0.5, 0.5), float64(base))
	near("в клипе", m.lumaAt(out, 1.5, 0.5, 0.5), want)
	near("после клипа", m.lumaAt(out, 2.5, 0.5, 0.5), float64(base))
	if d := m.info(out).dur; math.Abs(d-3) > 0.1 {
		t.Errorf("длина %.2f", d)
	}
	// рамка на левую половину: справа нижний слой как есть
	out = m.render(tracks([]Clip{{Path: under}}, []Clip{{Path: top, X: 0, Y: 0, W: 0.5, H: 1, Blend: "multiply"}}), "mp4")
	near("в рамке", m.lumaAt(out, 0.5, 0.25, 0.5), want)
	near("вне рамки", m.lumaAt(out, 0.5, 0.75, 0.5), float64(base))
	// плавное появление: в начале почти нижний слой, а не чёрный
	out = m.render(tracks([]Clip{{Path: under}}, []Clip{{Path: top, Blend: "multiply", FadeIn: 1}}), "mp4")
	near("начало плавности", m.lumaAt(out, 0, 0.5, 0.5), float64(base))
	// две дорожки в одной: обычный клип и клип с режимом друг другу не мешают
	out = m.render(tracks([]Clip{{Path: under}}, []Clip{{Path: top, Blend: "multiply"}, {Path: top, At: 1}}), "mp4")
	near("режим на дорожке", m.lumaAt(out, 0.5, 0.5, 0.5), want)
	near("обычный на дорожке", m.lumaAt(out, 1.5, 0.5, 0.5), float64(base))
	// самая нижняя дорожка: режим считается от чёрного, как в просмотре
	out = m.render(tracks([]Clip{{Path: top, Blend: "multiply"}}), "mp4")
	near("multiply на чёрном", m.lumaAt(out, 0.5, 0.5, 0.5), 0)
	out = m.render(tracks([]Clip{{Path: top, Blend: "screen"}}), "mp4")
	near("screen на чёрном", m.lumaAt(out, 0.5, 0.5, 0.5), float64(base))
	// 10 бит не падает
	deep := m.make("deep.mov", "-f", "lavfi", "-i", "color=c=gray:s=320x240:r=30:d=1", "-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le")
	near("10 бит", m.lumaAt(m.render(tracks([]Clip{{Path: deep}}, []Clip{{Path: deep, Blend: "multiply"}}), "prores422"), 0.5, 0.5, 0.5), want)
	// BT.709: режим не сдвигает цвет
	hd := m.make("hd.mp4", "-f", "lavfi", "-i", "color=c=0xc03030:s=1280x720:r=30:d=1",
		"-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p", "-c:v", "libx264", "-preset", "ultrafast",
		"-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709")
	black := m.color("black.mp4", "black", 1280, 720, 30, 1, 0)
	plain, mixed := m.rgbOf(m.render(tracks([]Clip{{Path: hd}}), "mp4")), m.rgbOf(m.render(tracks([]Clip{{Path: hd}}, []Clip{{Path: black, Blend: "screen"}}), "mp4"))
	for i := range plain {
		if math.Abs(plain[i]-mixed[i]) > 5 {
			t.Fatalf("цвет съехал: %v и %v", plain, mixed)
		}
	}
}
