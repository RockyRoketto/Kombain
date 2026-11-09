package main

import (
	"math"
	"testing"
)

// midGray: яркость в середине кадра n, 0…255
func (m *montFixture) midGray(p string, n int) float64 {
	row := m.rowAt(p, n)
	return float64(row[len(row)/2])
}

func opv(v float64) *float64 { return &v }

// Белый слой на чёрном: своя непрозрачность и ключи дают ту же яркость, что считает kfAt (и окно просмотра)
func TestOpacityRender(t *testing.T) {
	m := newMontFixture(t)
	black := m.color("black.mp4", "black", 320, 240, 30, 2, 0)
	white := m.color("white.mp4", "white", 320, 240, 30, 2, 0)
	near := func(name string, got, want float64) {
		t.Helper()
		if math.Abs(got-want) > 8 {
			t.Errorf("%s: яркость %.0f, должно быть %.0f", name, got, want)
		}
	}
	// верхняя дорожка, постоянная непрозрачность
	out := m.render(tracks([]Clip{{Path: black}}, []Clip{{Path: white, Op: opv(0.5)}}), "mp4")
	near("верхняя 50%", m.midGray(out, 10), 128)
	// нижняя дорожка без прозрачности в результате: темнеет к чёрному
	out = m.render(tracks([]Clip{{Path: white, Op: opv(0.25)}}), "mp4")
	near("нижняя 25%", m.midGray(out, 10), 64)
	// ключи с кривой, на верхней дорожке и вместе с ключами рамки
	for _, e := range []string{"", "inout"} {
		keys := &Keys{O: []Key{{S: 0.2, V: 0, E: e}, {S: 1.2, V: 1}}}
		out = m.render(tracks([]Clip{{Path: black}}, []Clip{{Path: white, Keys: keys}}), "mp4")
		for _, n := range []int{0, 9, 15, 21, 30, 40} {
			near("ключи "+e+" кадр "+secs(float64(n)), m.midGray(out, n), 255*kfAt(keys.O, float64(n)/30))
		}
	}
	move := &Keys{X: []Key{{S: 0, V: 0.4}, {S: 1, V: 0.6}}, O: []Key{{S: 0, V: 1}, {S: 1, V: 0.5}}}
	out = m.render(tracks([]Clip{{Path: black}}, []Clip{{Path: white, X: 0.25, Y: 0.25, W: 0.5, H: 0.5, Keys: move, ShadowA: 0.5, ShadowX: 0.02}}), "mp4")
	near("с движением и тенью", m.midGray(out, 15), 255*kfAt(move.O, 0.5))
}

// Метка начала вывода: время ключей считается от начала клипа, а не результата
func TestOpacityHead(t *testing.T) {
	m := newMontFixture(t)
	white := m.color("white.mp4", "white", 320, 240, 30, 2, 0)
	keys := &Keys{O: []Key{{S: 0, V: 0}, {S: 1, V: 1}}}
	p := tracks([]Clip{{Path: white, Keys: keys}})
	p.In = 0.5
	out := m.render(p, "mp4")
	for _, n := range []int{0, 6, 12} {
		want := 255 * kfAt(keys.O, float64(n)/30+0.5)
		if got := m.midGray(out, n); math.Abs(got-want) > 8 {
			t.Errorf("кадр %d: яркость %.0f, должно быть %.0f", n, got, want)
		}
	}
}

// В формате с прозрачностью непрозрачность уходит в альфу, а не в чёрное
func TestOpacityAlpha(t *testing.T) {
	m := newMontFixture(t)
	white := m.color("white.mp4", "white", 320, 240, 30, 1, 0)
	out := m.render(tracks([]Clip{{Path: white, X: 0.25, Y: 0.25, W: 0.5, H: 0.5, Op: opv(0.5)}}), "prores4444")
	if a := m.alphaAt(out, 0.5); math.Abs(float64(a)-128) > 4 {
		t.Errorf("ProRes 4444: прозрачность %d, должно быть около 128", a)
	}
	m.render(tracks([]Clip{{Path: white, Op: opv(0.5), Keys: &Keys{O: []Key{{S: 0, V: 0}, {S: 1, V: 1}}}}}), "webm")
}

func TestOpacityFit(t *testing.T) {
	p := tracks([]Clip{{Op: opv(3), Keys: &Keys{O: []Key{{S: 0, V: -1}, {S: 1, V: 2}}}}})
	p.fit()
	c := p.Tracks[0].Clips[0]
	if *c.Op != 1 || c.Keys.O[0].V != 0 || c.Keys.O[1].V != 1 || c.Keys.moves() {
		t.Errorf("после проверки: %v %v", *c.Op, c.Keys.O)
	}
}
