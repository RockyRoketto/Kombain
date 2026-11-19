package main

import (
	"math"
	"testing"
)

// Готовые анимации «Проявление», «Тряска» и «Наезд камеры» ставят обычные ключи (kfAPath в web/js/keyframes.js).
// Ниже те же формулы числом: проверяем, что такие ключи проходят проверку (fit) и ffmpeg рисует по ним то, что считает kfAt.

// presetFade: ключи непрозрачности «Проявление» длиной d, поза отдыха rest
func presetFade(d, rest float64, e string) []Key {
	return []Key{{S: 0, V: 0, E: e}, {S: d, V: rest}}
}

// presetPush: ширина растёт от rw до rw*(1.05+0.4*st) за d секунд и остаётся такой
func presetPush(d, rw, st float64, e string) []Key {
	return []Key{{S: 0, V: rw, E: e}, {S: d, V: math.Min(rw*(1.05+0.4*st), tlMaxBox)}}
}

// presetShake: ключи середины рамки; ~14 рывков в секунду, на краях отрезка слой на месте
func presetShake(d, restX, restY, st, aspect float64) (xs, ys []Key) {
	n := min(max(int(math.Round(d*14)), 4), 150)
	ax := 0.06 * st
	ay := ax * aspect
	xs, ys = []Key{{S: 0, V: restX}}, []Key{{S: 0, V: restY}}
	for j := 1; j <= n; j++ {
		u := float64(j) / float64(n+1)
		env := math.Sin(math.Pi * u)
		sign := -1.0
		if j%2 == 1 {
			sign = 1
		}
		fj := float64(j)
		xs = append(xs, Key{S: u * d, V: restX + ax*env*sign*(0.6+0.4*math.Abs(math.Sin(fj*2.1+0.5)))})
		ys = append(ys, Key{S: u * d, V: restY + ay*env*math.Sin(fj*3.7+1)*(0.6+0.4*math.Abs(math.Cos(fj*1.3)))})
	}
	return append(xs, Key{S: d, V: restX}), append(ys, Key{S: d, V: restY})
}

func TestPresetFadeRender(t *testing.T) {
	m := newMontFixture(t)
	black := m.color("black.mp4", "black", 320, 240, 30, 2, 0)
	white := m.color("white.mp4", "white", 320, 240, 30, 2, 0)
	for _, e := range []string{"", "out"} {
		keys := &Keys{O: presetFade(1, 1, e)}
		out := m.render(tracks([]Clip{{Path: black}}, []Clip{{Path: white, Keys: keys}}), "mp4")
		for _, n := range []int{0, 8, 15, 24, 40} {
			want := 255 * kfAt(keys.O, float64(n)/30)
			if got := m.midGray(out, n); math.Abs(got-want) > 8 {
				t.Errorf("проявление %q, кадр %d: яркость %.0f, должно быть %.0f", e, n, got, want)
			}
		}
	}
	// исчезание: те же ключи задом наперёд
	keys := &Keys{O: []Key{{S: 1, V: 1, E: "in"}, {S: 2, V: 0}}}
	out := m.render(tracks([]Clip{{Path: black}}, []Clip{{Path: white, Keys: keys}}), "mp4")
	for _, n := range []int{10, 35, 45, 58} {
		want := 255 * kfAt(keys.O, float64(n)/30)
		if got := m.midGray(out, n); math.Abs(got-want) > 8 {
			t.Errorf("затухание, кадр %d: яркость %.0f, должно быть %.0f", n, got, want)
		}
	}
}

func TestPresetPushRender(t *testing.T) {
	m := newMontFixture(t)
	black := m.color("black.mp4", "black", 640, 480, 30, 2, 0)
	white := m.color("white.mp4", "white", 640, 480, 30, 2, 0)
	keys := &Keys{W: presetPush(1.5, 0.25, 0.5, "inout")}
	layer := Clip{Path: white, X: 0.375, Y: 0.375, W: 0.25, H: 0.25, Keys: keys}
	out := m.render(tracks([]Clip{{Path: black}}, []Clip{layer}), "mp4")
	for _, n := range []int{0, 10, 22, 35, 45, 55} {
		mid, width := whiteSpan(m.rowAt(out, n))
		want := kfAt(keys.W, float64(n)/30) * 640
		if math.Abs(width-want) > 3 || math.Abs(mid-320) > 2 {
			t.Errorf("наезд, кадр %d: середина %.1f, ширина %.1f; должно быть 320 и %.1f", n, mid, width, want)
		}
	}
}

func TestPresetShakeRender(t *testing.T) {
	m := newMontFixture(t)
	black := m.color("black.mp4", "black", 640, 480, 30, 2, 0)
	white := m.color("white.mp4", "white", 640, 480, 30, 2, 0)
	xs, ys := presetShake(1, 0.5, 0.5, 0.5, 640.0/480)
	keys := &Keys{X: xs, Y: ys}
	layer := Clip{Path: white, X: 0.375, Y: 0.375, W: 0.25, H: 0.25, Keys: keys}
	out := m.render(tracks([]Clip{{Path: black}}, []Clip{layer}), "mp4")
	for _, n := range []int{0, 5, 9, 14, 20, 26, 29, 40} {
		mid, width := whiteSpan(m.rowAt(out, n))
		want := kfAt(keys.X, float64(n)/30) * 640
		if math.Abs(mid-want) > 2.5 || math.Abs(width-160) > 3 {
			t.Errorf("тряска, кадр %d: середина %.1f, ширина %.1f; должно быть %.1f и 160", n, mid, width, want)
		}
	}
	if mid, _ := whiteSpan(m.rowAt(out, 45)); math.Abs(mid-320) > 1.5 {
		t.Errorf("после тряски слой должен стоять на месте, середина %.1f", mid)
	}
}

// Ключи готовых анимаций проходят проверку без потерь: порядок, число, границы
func TestPresetKeysFit(t *testing.T) {
	for _, d := range []float64{0.1, 0.5, 3, 60} {
		xs, ys := presetShake(d, 0.5, 0.5, 1, 16.0/9)
		k := &Keys{X: xs, Y: ys, W: presetPush(d, 0.5, 1, "out"), O: presetFade(d, 0.5, "in")}
		nx, nw := len(k.X), len(k.W)
		k.fit()
		if len(k.X) != nx || len(k.Y) != nx || len(k.W) != nw || len(k.O) != 2 {
			t.Errorf("d=%v: после проверки ключей X %d из %d, Y %d, W %d из %d, O %d", d, len(k.X), nx, len(k.Y), len(k.W), nw, len(k.O))
		}
		if nx > kfMax {
			t.Errorf("d=%v: %d ключей, больше kfMax", d, nx)
		}
	}
}
