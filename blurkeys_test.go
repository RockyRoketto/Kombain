package main

import (
	"math"
	"testing"
)

// Ключи размытия: σ меняется от кадра к кадру по тем же кривым, что и в просмотре. Край белого на чёрном размыт по кривой Гаусса:
// на σ снаружи остаётся 16% яркости.
func TestBlurKeysRender(t *testing.T) {
	m := newMontFixture(t)
	black := m.color("black.mp4", "black", 640, 480, 30, 3, 0)
	white := m.color("white.mp4", "white", 640, 480, 30, 3, 0)
	// σ в точках кадра по ширине: доля высоты × 480 / 640
	out := func(clip Clip) string {
		clip.Path, clip.X, clip.Y, clip.W, clip.H = white, 0.5, 0, 0.5, 1
		return m.render(tracks([]Clip{{Path: black}}, []Clip{clip}), "mp4")
	}
	near := func(name string, got int, want, slack float64) {
		t.Helper()
		if math.Abs(float64(got)-want) > slack {
			t.Errorf("%s: яркость %d, должно быть %.0f", name, got, want)
		}
	}
	// размытие растёт от 0 до 0,05 за секунду: через 0,5 с σ 0,025 высоты = 0,01875 ширины
	keys := &Keys{B: []Key{{S: 0, V: 0}, {S: 1, V: 0.05}}}
	o := out(Clip{Keys: keys})
	ds := 0.025 * 480 / 640
	near("в начале резко", m.lumaAt(o, 0.0, 0.5-0.02, 0.5), 0, 8)
	near("посередине на σ снаружи", m.lumaAt(o, 0.5, 0.5-ds, 0.5), 41, 14)
	near("посередине на 2σ снаружи", m.lumaAt(o, 0.5, 0.5-2*ds, 0.5), 6, 10)
	near("в конце на 2σ снаружи резкость уже ушла", m.lumaAt(o, 1.5, 0.5-ds, 0.5), 79, 16) // σ 0,0375 ширины, расстояние 0,5σ
	// ключи вместо Blur: статичное размытие с ключами не складывается
	o = out(Clip{Blur: 0.1, Keys: &Keys{B: []Key{{S: 0, V: 0.0001}}}})
	near("ключи вместо Blur", m.lumaAt(o, 0.5, 0.5-0.02, 0.5), 0, 8)
	// кривая «разгон»: на половине пути σ мало, а на статичном размытии 0,025 было бы 41
	o = out(Clip{Keys: &Keys{B: []Key{{S: 0, V: 0, E: "in"}, {S: 1, V: 0.05}}}})
	near("разгон", m.lumaAt(o, 0.5, 0.5-ds, 0.5), 0, 12)
	// скорость 2× и обрезка начала: клип с From 0,5 идёт вдвое быстрее, ключи 0,5…1,5 файла ложатся на 0…0,5 с дорожки
	o = out(Clip{From: 0.5, Len: 1, Speed: 2, Keys: &Keys{B: []Key{{S: 0.5, V: 0}, {S: 1.5, V: 0.05}}}})
	near("скорость 2×, начало", m.lumaAt(o, 0.0, 0.5-0.02, 0.5), 0, 8)
	near("скорость 2×, конец ключей", m.lumaAt(o, 0.45, 0.5-0.0375*1.0, 0.5), 41, 40) // σ у конца почти 0,05 высоты, край заметно размыт
}

// Ключи размытия из проекта: значения в пределах 0…tlMaxBlur, они делают клип «живым», старые ключи читаются как раньше
func TestBlurKeysFit(t *testing.T) {
	k := &Keys{B: []Key{{S: 1, V: 5}, {S: -1, V: 0.1}, {S: 0, V: -3, E: "bad"}}}
	k.fit()
	if len(k.B) != 2 || k.B[0].V != 0 || k.B[0].E != "" || k.B[1].V != tlMaxBlur {
		t.Errorf("после fit: %+v", k.B)
	}
	if !k.any() || k.moves() || !k.fxKeyed() {
		t.Error("ключи размытия: any и fxKeyed истинны, moves ложна")
	}
}

// Ключи тени: непрозрачность, смещение и мягкость меняются по кадрам. Серый квадрат на белом, тень чёрная.
func TestShadowKeysRender(t *testing.T) {
	m := newMontFixture(t)
	white := m.color("white.mp4", "white", 640, 480, 30, 3, 0)
	gray := m.color("gray.mp4", "gray", 640, 480, 30, 3, 0)
	render := func(clip Clip) string {
		clip.Path, clip.X, clip.Y, clip.W, clip.H = gray, 0.25, 0.25, 0.5, 0.5
		return m.render(tracks([]Clip{{Path: white}}, []Clip{clip}), "mp4")
	}
	near := func(name string, got int, want, slack float64) {
		t.Helper()
		if math.Abs(float64(got)-want) > slack {
			t.Errorf("%s: яркость %d, должно быть %.0f", name, got, want)
		}
	}
	// непрозрачность 0 → 1 за секунду
	o := render(Clip{ShadowA: 0.3, ShadowX: 0.1, ShadowY: 0.1, Keys: &Keys{SA: []Key{{S: 0, V: 0}, {S: 1, V: 1}}}})
	near("тени нет в начале", m.lumaAt(o, 0, 0.78, 0.5), 255, 10)
	near("тень наполовину", m.lumaAt(o, 0.5, 0.78, 0.5), 128, 16)
	near("тень полная", m.lumaAt(o, 1.5, 0.78, 0.5), 0, 10)
	// смещение вправо от 0 до 0,1 высоты за секунду: край тени идёт от 0,75 до 0,825 (ширины)
	o = render(Clip{ShadowA: 1, ShadowY: 0.1, Keys: &Keys{SX: []Key{{S: 0, V: 0}, {S: 1, V: 0.1}}}})
	near("без смещения, справа от слоя", m.lumaAt(o, 0, 0.78, 0.5), 255, 10)
	near("на полпути, внутри тени", m.lumaAt(o, 0.5, 0.77, 0.5), 0, 12)
	near("на полпути, за краем тени", m.lumaAt(o, 0.5, 0.81, 0.5), 255, 12)
	near("в конце, за прежним краем", m.lumaAt(o, 1.5, 0.81, 0.5), 0, 12)
	// мягкость тени растёт от 0 до 0,05 за секунду, правый край тени на 0,825
	o = render(Clip{ShadowA: 1, ShadowX: 0.1, ShadowY: 0.1, Keys: &Keys{SB: []Key{{S: 0, V: 0}, {S: 1, V: 0.05}}}})
	near("резкая тень", m.lumaAt(o, 0, 0.84, 0.5), 255, 10)
	near("мягкая тень", m.lumaAt(o, 1.5, 0.84, 0.5), 167, 25)
	// все четыре вместе на клипе со скоростью 2×: не падает и край тени там, где ждём
	o = render(Clip{From: 0.5, Len: 1, Speed: 2, ShadowC: "#000000", Keys: &Keys{
		SA: []Key{{S: 0.5, V: 1}}, SX: []Key{{S: 0.5, V: 0.1}}, SY: []Key{{S: 0.5, V: 0.1}}, SB: []Key{{S: 0.5, V: 0}}}})
	near("постоянные ключи", m.lumaAt(o, 0.3, 0.78, 0.5), 0, 12)
}

func TestShadowKeysFit(t *testing.T) {
	k := &Keys{SA: []Key{{S: 0, V: 3}}, SX: []Key{{S: 0, V: -9}}, SY: []Key{{S: 0, V: 9}}, SB: []Key{{S: 0, V: 9}}}
	k.fit()
	if k.SA[0].V != 1 || k.SX[0].V != -1 || k.SY[0].V != 1 || k.SB[0].V != tlMaxBlur || !k.fxKeyed() || k.moves() {
		t.Errorf("после fit: %+v", k)
	}
}
