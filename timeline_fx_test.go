package main

import (
	"math"
	"testing"
)

// Край белого на чёрном после размытия идёт по кривой Гаусса: на расстоянии σ внутрь 84%, на краю 50%, на σ наружу 16%
func TestTimelineBlurEdge(t *testing.T) {
	m := newMontFixture(t)
	black := m.color("black.mp4", "black", 640, 480, 30, 1, 0)
	white := m.color("white.mp4", "white", 640, 480, 30, 1, 0)
	const sigma = 0.05 // 24 точки при высоте 480
	layer := Clip{Path: white, X: 0.5, Y: 0, W: 0.5, H: 1, Blur: sigma}
	near := func(name string, got int, want, slack float64) {
		t.Helper()
		if math.Abs(float64(got)-want) > slack {
			t.Errorf("%s: яркость %d, должно быть %.0f", name, got, want)
		}
	}
	for _, p := range []Project{tracks([]Clip{{Path: black}}, []Clip{layer}), tracks([]Clip{layer})} { // на верхней и на нижней дорожке, там под слоем чёрный фон
		out := m.render(p, "mp4")
		ds := sigma * 480 / 640
		near("внутри на σ", m.lumaAt(out, 0.5, 0.5+ds, 0.5), 214, 14)
		near("на краю", m.lumaAt(out, 0.5, 0.5, 0.5), 128, 14)
		near("снаружи на σ", m.lumaAt(out, 0.5, 0.5-ds, 0.5), 41, 14)
		near("далеко снаружи", m.lumaAt(out, 0.5, 0.1, 0.5), 0, 8)
		near("край кадра в прозрачность", m.lumaAt(out, 0.5, 0.995, 0.5), 128, 40)
	}
	// белый слой не темнеет у края, если под ним белое: чёрный цвет полей не должен просачиваться
	out := m.render(tracks([]Clip{{Path: white}}, []Clip{layer}), "mp4")
	near("без тёмной каймы", m.lumaAt(out, 0.5, 0.5, 0.5), 255, 8)
}

func TestTimelineShadow(t *testing.T) {
	m := newMontFixture(t)
	white := m.color("white.mp4", "white", 640, 480, 30, 1, 0)
	gray := m.color("gray.mp4", "gray", 640, 480, 30, 1, 0)
	box := Clip{Path: gray, X: 0.25, Y: 0.25, W: 0.5, H: 0.5, ShadowA: 1, ShadowX: 0.1, ShadowY: 0.1, ShadowC: "#000000"}
	out := m.render(tracks([]Clip{{Path: white}}, []Clip{box}), "mp4")
	base := m.lumaAt(gray, 0.5, 0.5, 0.5)
	dark := func(x, y float64, want int) {
		t.Helper()
		if got := m.lumaAt(out, 0.5, x, y); math.Abs(float64(got-want)) > 12 {
			t.Errorf("точка %.2f, %.2f: яркость %d, должно быть %d", x, y, got, want)
		}
	}
	dark(0.5, 0.5, base)  // сам слой поверх тени
	dark(0.78, 0.5, 0)    // тень справа
	dark(0.5, 0.82, 0)    // и снизу
	dark(0.2, 0.5, 255)   // слева тени нет
	dark(0.5, 0.2, 255)   // и сверху
	dark(0.95, 0.95, 255) // за пределами смещения тоже
	// непрозрачность и цвет
	half := box
	half.ShadowA, half.ShadowC = 0.5, "#ff0000"
	out = m.render(tracks([]Clip{{Path: white}}, []Clip{half}), "mp4")
	if got := m.rgbAt(out, 0.78, 0.5); math.Abs(got[0]-255) > 12 || math.Abs(got[1]-128) > 14 || math.Abs(got[2]-128) > 14 {
		t.Errorf("красная тень 50%%: %v", got)
	}
	// на нижней дорожке тень ложится на чёрный фон, размытая и цветная видна
	red := box
	red.ShadowC, red.ShadowB = "#ff0000", 0.01
	got := m.rgbAt(m.render(tracks([]Clip{red}), "mp4"), 0.78, 0.5)
	if got[0] < 200 || got[1] > 40 {
		t.Errorf("тень на нижней дорожке: %v", got)
	}
	// вне слоя и тени на нижней дорожке чёрное
	if m.lumaAt(m.render(tracks([]Clip{red}), "mp4"), 0.5, 0.05, 0.05) > 20 {
		t.Error("вне слоя и тени должно быть чёрное")
	}
	// хромакей на нижней дорожке вместе с тенью: вырезанное чёрное, сам клип не падает
	m.render(tracks([]Clip{{Path: white, KeyColor: "#00ff00", KeySim: 0.2, ShadowA: 0.5, ShadowX: 0.02}}), "mp4")
	// вместе с кадрированием, поворотом, режимом и 10 битами не падает
	mix := box
	mix.Rot, mix.CropL, mix.Blur, mix.Blend = 20, 0.2, 0.01, "multiply"
	m.render(tracks([]Clip{{Path: white}}, []Clip{mix}), "mp4")
	deep := m.make("deep.mov", "-f", "lavfi", "-i", "color=c=gray:s=640x480:r=30:d=1", "-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le")
	m.render(tracks([]Clip{{Path: deep, Blur: 0.01, ShadowA: 0.5, ShadowX: 0.02, ShadowC: "#000000"}}), "prores422")
	if _, err := saveMontFrame(m.ffm, tracks([]Clip{{Path: white}}, []Clip{mix}), 0.5); err != nil {
		t.Error("кадр в PNG: ", err)
	}
	// пределы и неверный цвет
	over := tracks([]Clip{{Path: white, Blur: 9, ShadowB: -1, ShadowA: 5, ShadowX: 7, ShadowC: "red;x"}})
	over.fit()
	if c := over.Tracks[0].Clips[0]; c.Blur != tlMaxBlur || c.ShadowB != 0 || c.ShadowA != 1 || c.ShadowX != 1 || c.ShadowC != "#000000" {
		t.Errorf("пределы: %+v", c)
	}
}
