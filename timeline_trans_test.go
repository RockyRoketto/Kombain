package main

import "testing"

// Переход на стыке: стоит по центру, берёт кадры за краями, длина монтажа не меняется
func TestTimelineTransCut(t *testing.T) {
	m := newMontFixture(t)
	black := m.color("black.mp4", "black", 160, 120, 30, 2, 0)
	white := m.color("white.mp4", "white", 160, 120, 30, 2, 0)
	for _, c := range []struct {
		what string
		a, b Clip
	}{
		{"с запасом", Clip{Path: black, Len: 1}, Clip{Path: white, From: 0.5, Len: 1, At: 1}},
		{"без запаса: стоп-кадр", Clip{Path: black, From: 1}, Clip{Path: white, Len: 1, At: 1}},
		{"реверс", Clip{Path: black, Len: 1, Reverse: true}, Clip{Path: white, From: 0.5, Len: 1, At: 1, Reverse: true}},
	} {
		c.b.TrIn = &Trans{Kind: "fade", Dur: 1}
		out := m.render(tracks([]Clip{c.a, c.b}), "mp4")
		nearly(t, c.what+": длина", m.info(out).dur, 2, 0.1)
		for _, p := range []struct {
			at     float64
			lo, hi int
		}{{0.3, 0, 40}, {1.0, 90, 170}, {1.7, 215, 255}} {
			if got := m.lumaAt(out, p.at, 0.5, 0.5); got < p.lo || got > p.hi {
				t.Errorf("%s: в %.1f с яркость %d, ждали %d…%d", c.what, p.at, got, p.lo, p.hi)
			}
		}
	}
}

// Свободный край: появление из чёрного и уход в него внутри клипа; шторка делит кадр
func TestTimelineTransEdge(t *testing.T) {
	m := newMontFixture(t)
	white := m.color("white.mp4", "white", 160, 120, 30, 2, 0)
	out := m.render(tracks([]Clip{{Path: white, TrIn: &Trans{"fade", 1}, TrOut: &Trans{"fadeblack", 0.5}}}), "mp4")
	nearly(t, "длина", m.info(out).dur, 2, 0.1)
	for _, p := range []struct {
		at     float64
		lo, hi int
	}{{0.03, 0, 40}, {0.5, 90, 170}, {1.2, 215, 255}, {1.94, 0, 70}} {
		if got := m.lumaAt(out, p.at, 0.5, 0.5); got < p.lo || got > p.hi {
			t.Errorf("в %.2f с яркость %d, ждали %d…%d", p.at, got, p.lo, p.hi)
		}
	}
	out = m.render(tracks([]Clip{{Path: white, TrIn: &Trans{"wiperight", 1}}}), "mp4")
	if l, r := m.lumaAt(out, 0.5, 0.1, 0.5), m.lumaAt(out, 0.5, 0.9, 0.5); (l > 128) == (r > 128) {
		t.Errorf("шторка: слева %d, справа %d", l, r)
	}
}

// Звук на стыке плавно перетекает без провала, верхняя дорожка уходит в прозрачность, метка вывода внутри перехода не ломает сборку
func TestTimelineTransSoundAndLayers(t *testing.T) {
	m := newMontFixture(t)
	low := m.color("low.mp4", "black", 160, 120, 30, 2, 440)
	high := m.color("high.mp4", "white", 160, 120, 30, 2, 880)
	cut := []Clip{{Path: low, Len: 1}, {Path: high, From: 0.5, Len: 1, At: 1, TrIn: &Trans{"fade", 1}}}
	s := m.pcm(m.render(tracks(cut), "mp4"))
	steady := rms(s, 0.1, 0.4)
	for _, at := range []float64{0.6, 0.9, 1.1, 1.4} {
		if v := rms(s, at, at+0.1); v < steady*0.7 || v > steady*1.45 {
			t.Errorf("звук в %.1f с: %.3f при обычном %.3f", at, v, steady)
		}
	}

	red := m.color("red.mp4", "red", 160, 120, 30, 2, 0)
	p := tracks([]Clip{{Path: red, Len: 2}}, []Clip{{Path: high, Part: "v", Len: 2, TrOut: &Trans{"fade", 2}}})
	out := m.render(p, "mp4")
	if a, b := m.lumaAt(out, 0.1, 0.5, 0.5), m.lumaAt(out, 1.9, 0.5, 0.5); a < 200 || b > 120 {
		t.Errorf("верхний клип не ушёл в нижний: в начале %d, в конце %d", a, b)
	}

	q := tracks(cut)
	q.In = 0.9
	nearly(t, "длина с меткой", m.info(m.render(q, "mp4")).dur, 1.1, 0.1)
}
