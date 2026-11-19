package main

import "testing"

// Ключи кадрирования: срезанная часть слоя пропускает нижний слой, граница двигается по ключам. Серый слой на белом.
func TestCropKeysRender(t *testing.T) {
	m := newMontFixture(t)
	white := m.color("white.mp4", "white", 640, 480, 30, 3, 0)
	gray := m.color("gray.mp4", "gray", 640, 480, 30, 3, 0)
	render := func(c Clip) string {
		c.Path = gray
		return m.render(tracks([]Clip{{Path: white}}, []Clip{c}), "mp4")
	}
	base := m.lumaAt(gray, 0.5, 0.5, 0.5)
	is := func(name string, o string, at, x, y float64, cut bool) {
		t.Helper()
		got, want := m.lumaAt(o, at, x, y), base
		if cut {
			want = 255
		}
		if d := got - want; d < -14 || d > 14 {
			t.Errorf("%s: яркость %d, должно быть %d", name, got, want)
		}
	}
	// левая сторона 0 → 0,5 за секунду, дальше держится
	o := render(Clip{Keys: &Keys{KL: []Key{{S: 0, V: 0}, {S: 1, V: 0.5}}}})
	is("в начале слой целый", o, 0.02, 0.05, 0.5, false)
	is("посередине срезано слева", o, 0.5, 0.2, 0.5, true)
	is("посередине правее среза слой есть", o, 0.5, 0.4, 0.5, false)
	is("в конце срез до половины", o, 1.5, 0.4, 0.5, true)
	is("в конце правая половина цела", o, 1.5, 0.6, 0.5, false)
	// верх постоянен, низ по ключам, справа тоже: стороны с числом и с ключами вместе
	o = render(Clip{CropT: 0.2, CropR: 0.25, Keys: &Keys{KB: []Key{{S: 0, V: 0, E: "in"}, {S: 1, V: 0.5}}}})
	is("постоянный верх", o, 0.5, 0.4, 0.1, true)
	is("постоянная правая", o, 0.5, 0.9, 0.5, true)
	is("низ в начале цел", o, 0, 0.4, 0.95, false)
	is("низ в конце срезан", o, 1.5, 0.4, 0.8, true)
	is("середина слоя", o, 1.5, 0.4, 0.4, false)
	// скорость 2× и обрезка начала: ключи по времени файла, 1…2 с файла идут на 0…0,5 с дорожки
	o = render(Clip{From: 1, Len: 1, Speed: 2, Keys: &Keys{KL: []Key{{S: 1, V: 0}, {S: 2, V: 0.5}}}})
	is("скорость, начало", o, 0, 0.1, 0.5, false)
	is("скорость, конец", o, 0.45, 0.2, 0.5, true)
	// на нижней дорожке срезанное становится чёрным фоном
	if got := m.lumaAt(m.render(tracks([]Clip{{Path: gray, Keys: &Keys{KL: []Key{{S: 0, V: 0.5}}}}}), "mp4"), 0.5, 0.2, 0.5); got > 12 {
		t.Errorf("нижняя дорожка: срез должен быть чёрным, яркость %d", got)
	}
}

func TestCropKeysFit(t *testing.T) {
	k := &Keys{KL: []Key{{S: 0, V: 3}}, KR: []Key{{S: 0, V: -1}}, KT: []Key{{S: 0, V: 0.5}}, KB: []Key{{S: 0, V: 9}}}
	k.fit()
	if k.KL[0].V != tlMaxCrop || k.KR[0].V != 0 || k.KT[0].V != 0.5 || k.KB[0].V != tlMaxCrop || !k.cropKeyed() || !k.any() || k.moves() {
		t.Errorf("после fit: %+v", k)
	}
}
