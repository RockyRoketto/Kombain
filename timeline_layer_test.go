package main

import "testing"

// Кадрирование срезает край на месте: остальная картинка не растягивается и не съезжает
func TestTimelineCrop(t *testing.T) {
	m := newMontFixture(t)
	under := m.color("under.mp4", "black", 320, 240, 30, 1, 0)
	top := m.color("top.mp4", "white", 320, 240, 30, 1, 0)
	out := m.render(tracks([]Clip{{Path: under}}, []Clip{{Path: top, X: 0, Y: 0, W: 1, H: 1, CropL: 0.5, CropB: 0.25}}), "mp4")
	for _, c := range []struct {
		x, y   float64
		bright bool
	}{{0.25, 0.3, false}, {0.75, 0.3, true}, {0.75, 0.9, false}} {
		if got := m.lumaAt(out, 0.5, c.x, c.y); (got > 128) != c.bright {
			t.Errorf("точка %.2f, %.2f: яркость %d", c.x, c.y, got)
		}
	}
	// без своей рамки слой кадрируется там, где вписан в кадр
	out = m.render(tracks([]Clip{{Path: under}}, []Clip{{Path: top, CropR: 0.5}}), "mp4")
	if got := m.lumaAt(out, 0.5, 0.25, 0.5); got < 200 {
		t.Errorf("левая половина должна остаться: яркость %d", got)
	}
	if got := m.lumaAt(out, 0.5, 0.75, 0.5); got > 60 {
		t.Errorf("правая половина срезана: яркость %d", got)
	}
}

// Поворот вокруг середины рамки, по часовой, и с кадрированием, и на нижней дорожке
func TestTimelineRotate(t *testing.T) {
	m := newMontFixture(t)
	under := m.color("under.mp4", "black", 320, 240, 30, 1, 0)
	bar := m.color("bar.mp4", "white", 160, 30, 30, 1, 0)
	box := Clip{Path: bar, X: 0.25, Y: 0.4375, W: 0.5, H: 0.125, Rot: 90}

	check := func(what, out string, list ...[3]float64) {
		t.Helper()
		for _, c := range list {
			if got := m.lumaAt(out, 0.5, c[0], c[1]); (got > 128) != (c[2] > 0) {
				t.Errorf("%s, точка %.2f, %.2f: яркость %d", what, c[0], c[1], got)
			}
		}
	}
	out := m.render(tracks([]Clip{{Path: under}}, []Clip{box}), "mp4")
	check("поворот", out, [3]float64{0.5, 0.25, 1}, [3]float64{0.5, 0.75, 1}, [3]float64{0.3, 0.5, 0}, [3]float64{0.7, 0.5, 0})

	// от полосы осталась правая половина: после поворота по часовой она смотрит вниз
	cut := box
	cut.CropL = 0.5
	out = m.render(tracks([]Clip{{Path: under}}, []Clip{cut}), "mp4")
	check("поворот и кадрирование", out, [3]float64{0.5, 0.25, 0}, [3]float64{0.5, 0.7, 1})

	// нижняя дорожка: углы чёрные, формат остаётся без прозрачности
	lone := m.color("lone.mp4", "white", 320, 240, 30, 1, 0)
	out = m.render(tracks([]Clip{{Path: lone, X: 0, Y: 0, W: 1, H: 1, Rot: 45}}), "mp4")
	check("нижняя дорожка", out, [3]float64{0.5, 0.5, 1}, [3]float64{0.03, 0.03, 0})

	// слой целиком за кадром ничего не рисует, но кадр собирается
	out = m.render(tracks([]Clip{{Path: under}}, []Clip{{Path: bar, X: 0.99, Y: 0.4, W: 0.5, H: 0.1, CropL: 0.9}}), "mp4")
	check("за кадром", out, [3]float64{0.99, 0.45, 0})
}

// Плавность: на нижней дорожке из чёрного, на верхней из того, что под ней, и с того же места, если голову клипа срезала метка
func TestTimelineFade(t *testing.T) {
	m := newMontFixture(t)
	white := m.color("white.mp4", "white", 320, 240, 30, 2, 0)
	black := m.color("black.mp4", "black", 320, 240, 30, 2, 0)
	near := func(what string, got, want int) {
		t.Helper()
		if got < want-30 || got > want+30 {
			t.Errorf("%s: яркость %d, ждали около %d", what, got, want)
		}
	}
	out := m.render(tracks([]Clip{{Path: white, FadeIn: 1, FadeOut: 0.5}}), "mp4")
	near("появление, середина", m.lumaAt(out, 0.5, 0.5, 0.5), 128)
	near("появилось", m.lumaAt(out, 1.2, 0.5, 0.5), 235)
	near("исчезание, середина", m.lumaAt(out, 1.75, 0.5, 0.5), 128)

	out = m.render(tracks([]Clip{{Path: white}}, []Clip{{Path: black, FadeIn: 1}}), "mp4")
	near("верхний слой появляется", m.lumaAt(out, 0.5, 0.5, 0.5), 128)
	near("верхний слой появился", m.lumaAt(out, 1.5, 0.5, 0.5), 16)

	p := tracks([]Clip{{Path: white, FadeIn: 1}})
	p.In = 0.5
	out = m.render(p, "mp4")
	near("метка внутри появления", m.lumaAt(out, 0, 0.5, 0.5), 128)
	near("после метки", m.lumaAt(out, 0.8, 0.5, 0.5), 235)
}

func TestTimelineSoundLevel(t *testing.T) {
	m := newMontFixture(t)
	src := m.color("tone.mp4", "black", 160, 120, 30, 2, 440)
	level := func(c Clip) []float64 {
		t.Helper()
		return m.pcm(m.render(tracks([]Clip{c}), "mp3"))
	}
	base := rms(level(Clip{Path: src}), 0.2, 1.8)
	half, none := 0.5, 0.0
	nearly(t, "громкость 50%", rms(level(Clip{Path: src, Vol: &half}), 0.2, 1.8)/base, 0.5, 0.03)
	if got := rms(level(Clip{Path: src, Vol: &none}), 0.2, 1.8); got > 0.001 {
		t.Errorf("громкость 0: %.4f", got)
	}
	s := level(Clip{Path: src, FadeIn: 1, FadeOut: 0.5})
	if a, b := rms(s, 0, 0.1), rms(s, 1.1, 1.3); a > b/3 {
		t.Errorf("появление: начало %.3f, потом %.3f", a, b)
	}
	if a, b := rms(s, 1.92, 2), rms(s, 1.1, 1.3); a > b/3 {
		t.Errorf("исчезание: конец %.3f, раньше %.3f", a, b)
	}
}

// Холст задаёт размер результата, клип вписывается по центру; нечётное значение становится чётным
func TestTimelineCanvasSize(t *testing.T) {
	m := newMontFixture(t)
	src := m.color("wide.mp4", "white", 320, 180, 30, 1, 0)
	p := tracks([]Clip{{Path: src}})
	p.W, p.H = 201, 401
	out := m.render(p, "mp4")
	i := m.info(out)
	if i.w != 200 || i.h != 400 {
		t.Errorf("размер %d×%d", i.w, i.h)
	}
	if got := m.lumaAt(out, 0.5, 0.5, 0.5); got < 200 {
		t.Errorf("клип в середине: яркость %d", got)
	}
	if got := m.lumaAt(out, 0.5, 0.5, 0.1); got > 40 {
		t.Errorf("сверху пусто: яркость %d", got)
	}
}
