package main

import (
	"encoding/json"
	"math"
	"testing"
)

// Ключи громкости: в каждый момент уровень звука такой, какой даёт kfAt (и просмотр), с кривыми, на нескольких режимах клипа.
// Звук ровный (синус), поэтому rms куска пропорционален громкости.
func TestVolumeKeysRender(t *testing.T) {
	m := newMontFixture(t)
	snd := m.color("tone.mp4", "black", 160, 120, 30, 3, 440)
	base := rms(m.pcm(m.render(tracks([]Clip{{Path: snd}}), "mp4")), 0.5, 1.5)
	if base < 0.05 {
		t.Fatalf("тест без звука: rms %.3f", base)
	}
	level := func(p Project, a, b float64) float64 { return rms(m.pcm(m.render(p, "mp4")), a, b) / base }
	near := func(name string, got, want float64) {
		t.Helper()
		if math.Abs(got-want) > 0.08 {
			t.Errorf("%s: громкость %.2f, должна быть %.2f", name, got, want)
		}
	}
	// плавное затихание 1 → 0 за секунду, потом тишина; до первого ключа держится его значение
	keys := &Keys{V: []Key{{S: 0.5, V: 1}, {S: 1.5, V: 0}}}
	p := tracks([]Clip{{Path: snd, Keys: keys}})
	near("до ключей", level(p, 0.1, 0.4), 1)
	near("середина", level(p, 0.95, 1.05), 0.5)
	near("после", level(p, 1.7, 2.5), 0)
	// кривая «разгон»: на половине пути ещё далеко от половины
	keys = &Keys{V: []Key{{S: 0, V: 0, E: "in"}, {S: 2, V: 1}}}
	near("разгон", level(tracks([]Clip{{Path: snd, Keys: keys}}), 0.95, 1.05), kfAt(keys.V, 1))
	// громкость выше 100% и ключи на клипе, сдвинутом на дорожке: время ключей от начала клипа
	keys = &Keys{V: []Key{{S: 0, V: 2}, {S: 1, V: 0.5}}}
	p = tracks([]Clip{{Path: m.color("b.mp4", "black", 160, 120, 30, 4, 0)}}, []Clip{{Path: snd, At: 1, Keys: keys}})
	near("со сдвигом, начало", level(p, 1.05, 1.15), 1.9)
	near("со сдвигом, конец ключей", level(p, 2.1, 2.5), 0.5)
	// ключи вместо Vol: Vol не складывается с ключами
	vol := 0.5
	near("ключи вместо Vol", level(tracks([]Clip{{Path: snd, Vol: &vol, Keys: &Keys{V: []Key{{S: 0, V: 1}}}}}), 0.5, 1.5), 1)
	// ключи рамки и громкости вместе, обрезка начала клипа и скорость 2×
	keys = &Keys{X: []Key{{S: 0, V: 0.4}, {S: 1, V: 0.6}}, V: []Key{{S: 0.5, V: 1}, {S: 1.5, V: 0}}}
	p = tracks([]Clip{{Path: snd, From: 0.5, Len: 1, Speed: 2, Keys: keys}})
	// по файлу: клип 0,5…2,5 на скорости 2× идёт 1 с; ключ 0,5 → время клипа 0, ключ 1,5 → 0,5 с дорожки
	near("скорость 2×, начало", level(p, 0.02, 0.1), 0.95)
	near("скорость 2×, затихло", level(p, 0.5, 0.95), 0)
}

// Ключи громкости из проекта: значения в пределах 0…tlMaxVol, лишние отбрасываются, ключи одной громкости клип «живым» делают,
// старый проект без поля v читается как раньше
func TestVolumeKeysFit(t *testing.T) {
	k := &Keys{V: []Key{{S: 1, V: 5}, {S: -1, V: 1}, {S: 0, V: -3, E: "bad"}, {S: 1, V: 0.5}}}
	k.fit()
	if len(k.V) != 2 || k.V[0].V != 0 || k.V[0].E != "" || k.V[1].V != tlMaxVol {
		t.Errorf("после fit: %+v", k.V)
	}
	if !k.any() || k.moves() {
		t.Error("ключи громкости: any должен быть истиной, moves — ложью (слой они не двигают)")
	}
	var old Keys
	if err := json.Unmarshal([]byte(`{"x":[{"s":0,"v":0.5}],"o":[{"s":0,"v":1}]}`), &old); err != nil || len(old.V) != 0 || !old.moves() {
		t.Errorf("старые ключи: %+v, %v", old, err)
	}
}
