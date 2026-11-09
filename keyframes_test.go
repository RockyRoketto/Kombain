package main

import (
	"fmt"
	"math"
	"os/exec"
	"testing"
)

// rowAt: строка яркости через середину кадра n (при 30 кадрах в секунду). Точный -ss отдаёт первый кадр не раньше отметки
func (m *montFixture) rowAt(p string, n int) []byte {
	m.t.Helper()
	out, err := exec.Command(m.ffm, "-hide_banner", "-loglevel", "error", "-ss", secs(max(float64(n)/30-0.004, 0)), "-i", p, "-frames:v", "1",
		"-vf", "format=gray,crop=iw:1:0:ih/2", "-f", "rawvideo", "-pix_fmt", "gray", "-").Output()
	if err != nil || len(out) == 0 {
		m.t.Fatalf("кадр %d из %s: %v", n, p, err)
	}
	return out
}

// whiteSpan: середина и ширина белого на строке, в точках
func whiteSpan(row []byte) (mid, width float64) {
	var sum, n float64
	for x, v := range row {
		f := float64(v) / 255
		sum += f * (float64(x) + 0.5)
		n += f
	}
	if n == 0 {
		return -1, 0
	}
	return sum / n, n
}

// Белый квадрат на чёрном едет и растёт по ключам: середина и ширина на кадрах те же, что считает kfAt (и окно просмотра)
func TestKeysRender(t *testing.T) {
	m := newMontFixture(t)
	black := m.color("black.mp4", "black", 640, 480, 30, 2, 0)
	white := m.color("white.mp4", "white", 640, 480, 30, 2, 0)
	for _, e := range []string{"", "in", "out", "inout", "bounce"} {
		{
			keys := &Keys{X: []Key{{S: 0.2, V: 0.25, E: e}, {S: 1.2, V: 0.75}}, W: []Key{{S: 0.2, V: 0.25, E: e}, {S: 1.2, V: 0.5}}}
			layer := Clip{Path: white, X: 0, Y: 0.375, W: 0.25, H: 0.25, Keys: keys}
			out := m.render(tracks([]Clip{{Path: black}}, []Clip{layer}), "mp4")
			for _, n := range []int{0, 6, 12, 18, 21, 27, 33, 40, 50} {
				tt := float64(n) / 30
				mid, width := whiteSpan(m.rowAt(out, n))
				wantMid, wantW := kfAt(keys.X, tt)*640, kfAt(keys.W, tt)*640
				if math.Abs(mid-wantMid) > 2 || math.Abs(width-wantW) > 3 {
					t.Errorf("кривая %q, кадр %d: середина %.1f, ширина %.1f; должно быть %.1f и %.1f", e, n, mid, width, wantMid, wantW)
				}
			}
		}
	}
}

// Поворот по ключам вместе с меткой начала вывода: время ключей считается от начала клипа, а не от начала результата
func TestKeysRotateHead(t *testing.T) {
	m := newMontFixture(t)
	black := m.color("black.mp4", "black", 640, 480, 30, 2, 0)
	white := m.color("white.mp4", "white", 640, 480, 30, 2, 0)
	keys := &Keys{R: []Key{{S: 0, V: 0, E: "inout"}, {S: 1, V: 90}}}
	layer := Clip{Path: white, X: 0.25, Y: 0.25, W: 0.5, H: 0.5, Keys: keys} // 320×240
	p := tracks([]Clip{{Path: black}}, []Clip{layer})
	p.In = 0.5
	out := m.render(p, "mp4")
	for _, n := range []int{0, 5, 10, 15, 20} {
		a := kfAt(keys.R, float64(n)/30+0.5) * math.Pi / 180
		// ширина белого на горизонтали через середину повёрнутого прямоугольника 320×240
		want := 2 * math.Min(160/math.Max(math.Abs(math.Cos(a)), 1e-9), 120/math.Max(math.Abs(math.Sin(a)), 1e-9))
		if _, width := whiteSpan(m.rowAt(out, n)); math.Abs(width-want) > 4 {
			t.Errorf("кадр %d (поворот %.1f°): ширина %.1f, должно быть %.1f", n, a*180/math.Pi, width, want)
		}
	}
}

// Слой с ключами в разных местах графа: один на дорожке, с кадрированием и эффектами, с прозрачностью в результате
func TestKeysCombos(t *testing.T) {
	m := newMontFixture(t)
	black := m.color("black.mp4", "black", 640, 480, 30, 1, 0)
	white := m.color("white.mp4", "white", 640, 480, 30, 1, 0)
	move := &Keys{X: []Key{{S: 0, V: 0.3, E: "bounce"}, {S: 0.8, V: 0.7}}, R: []Key{{S: 0, V: -30}, {S: 0.8, V: 30}}}
	// один на дорожке, без своей рамки: рамка вписанного слоя, вокруг чёрное
	out := m.render(tracks([]Clip{{Path: white, Keys: &Keys{W: []Key{{S: 0, V: 1}, {S: 1, V: 0.5}}}}}), "mp4")
	if _, width := whiteSpan(m.rowAt(out, 15)); math.Abs(width-kfAt([]Key{{S: 0, V: 1}, {S: 1, V: 0.5}}, 0.5)*640) > 3 {
		t.Errorf("один на дорожке: ширина %.1f", width)
	}
	// кадрирование: слева срезана половина, середина белого сдвигается вправо на четверть рамки
	crop := Clip{Path: white, X: 0.25, Y: 0.25, W: 0.5, H: 0.5, CropL: 0.5, Keys: &Keys{Y: []Key{{S: 0, V: 0.4}, {S: 1, V: 0.6}}}}
	out = m.render(tracks([]Clip{{Path: black}}, []Clip{crop}), "mp4")
	if mid, width := whiteSpan(m.rowAt(out, 15)); math.Abs(mid-400) > 2 || math.Abs(width-160) > 3 {
		t.Errorf("кадрирование: середина %.1f, ширина %.1f", mid, width)
	}
	fx := Clip{Path: white, X: 0.25, Y: 0.25, W: 0.5, H: 0.5, Blur: 0.01, ShadowA: 0.5, ShadowX: 0.02, Keys: move}
	m.render(tracks([]Clip{{Path: black}}, []Clip{fx}), "mp4")
	m.render(tracks([]Clip{fx}), "webm")
	if a := m.alphaAt(m.render(tracks([]Clip{{Path: white, X: 0.25, Y: 0.25, W: 0.5, H: 0.5, Keys: move}}), "prores4444"), 0); a != 255 {
		t.Errorf("prores4444: середина непрозрачна, а прозрачность %d", a)
	}
}

// Время ключей идёт за кадром файла: у реверса и ускорения отрезки переворачиваются и сжимаются
func TestKeysTrackTime(t *testing.T) {
	keys := []Key{{S: 1, V: 0, E: "out"}, {S: 3, V: 1}}
	c := tlClip{Clip: Clip{From: 1, Len: 4, Speed: 2}}
	got := c.kfTrack(keys)
	if got[0].S != 0 || got[1].S != 1 {
		t.Errorf("ускорение: %v", got)
	}
	c.Reverse = true
	got = c.kfTrack(keys)
	if got[0].S != 1 || got[0].V != 1 || got[1].S != 2 || got[1].V != 0 || got[0].E != "" {
		t.Errorf("реверс: %v", got)
	}
}

func TestKeysFit(t *testing.T) {
	k := &Keys{X: []Key{{S: 2, V: 9, E: "x;y"}, {S: 1, V: 0.5}, {S: 1, V: 0.6}, {S: math.NaN(), V: 1}, {S: -1, V: 1}}}
	k.fit()
	if fmt.Sprint(k.X) != "[{1 0.5 } {2 4 }]" {
		t.Errorf("ключи после проверки: %v", k.X)
	}
}
