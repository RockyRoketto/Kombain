package main

import (
	"math"
	"os/exec"
	"testing"
)

// rgbTime: средний цвет кадра в секунду t
func (m *montFixture) rgbTime(p string, t float64) [3]float64 {
	m.t.Helper()
	out, err := exec.Command(m.ffm, "-hide_banner", "-loglevel", "error", "-ss", secs(t), "-i", p, "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-").Output()
	if err != nil || len(out) < 3 {
		m.t.Fatalf("кадр из %s в %.2f: %v", p, t, err)
	}
	return [3]float64{float64(out[0]), float64(out[1]), float64(out[2])}
}

// Ключи цветокоррекции: в каждый момент цвет такой, как даёт формула (gradeCalc) для значений из ключей (kfAt), как в просмотре.
func TestGradeKeysRender(t *testing.T) {
	m := newMontFixture(t)
	src := m.color("src.mp4", "0x806040", 320, 240, 30, 3, 0)
	orig := m.rgbOf(src)
	check := func(name string, p Project, at float64, c Clip) {
		t.Helper()
		got, want := m.rgbTime(m.render(p, "mp4"), at), gradeCalc(orig, c)
		for i := range got {
			if math.Abs(got[i]-want[i]) > 7 {
				t.Errorf("%s: получилось %v, по формулам %v", name, got, want)
				return
			}
		}
	}
	// яркость, насыщенность и температура меняются сразу, контраст остаётся постоянным числом
	keys := &Keys{GB: []Key{{S: 0, V: 0}, {S: 2, V: 0.6}}, GS: []Key{{S: 0, V: 0}, {S: 2, V: -1}}, GT: []Key{{S: 0, V: 0}, {S: 2, V: 0.5}}}
	p := tracks([]Clip{{Path: src, ColCon: 0.3, Keys: keys}})
	for _, at := range []float64{0.05, 1, 1.9, 2.6} {
		check("ключи в "+secs(at), p, at, Clip{ColCon: 0.3, ColBri: kfAt(keys.GB, at), ColSat: kfAt(keys.GS, at), ColTemp: kfAt(keys.GT, at)})
	}
	// кривая и средние тона с оттенком
	keys = &Keys{GM: []Key{{S: 0, V: -0.6, E: "in"}, {S: 2, V: 0.6}}, GN: []Key{{S: 1, V: 0}, {S: 2, V: 0.7}}}
	p = tracks([]Clip{{Path: src, Keys: keys}})
	for _, at := range []float64{0.4, 1.5} {
		check("кривая в "+secs(at), p, at, Clip{ColMid: kfAt(keys.GM, at), ColTint: kfAt(keys.GN, at)})
	}
	// обрезка начала, скорость 2× и реверс: ключи по времени файла
	keys = &Keys{GB: []Key{{S: 1, V: 0}, {S: 2, V: 0.6}}}
	for _, c := range []Clip{{From: 1, Len: 1, Speed: 2}, {From: 1, Len: 1, Reverse: true}} {
		c.Path, c.Keys = src, keys
		p = tracks([]Clip{c})
		// у клипа 1…2 с файла на скорости 2× дорожка идёт 0,5 с; в реверсе кадр t дорожки — это секунда 2−t файла
		if c.Reverse {
			check("реверс, начало", p, 0, Clip{ColBri: kfAt(keys.GB, 1.97)})
			check("реверс, конец", p, 0.9, Clip{ColBri: kfAt(keys.GB, 1.07)})
		} else {
			check("скорость, начало", p, 0.02, Clip{ColBri: kfAt(keys.GB, 1.04)})
			check("скорость, конец", p, 0.45, Clip{ColBri: kfAt(keys.GB, 1.9)})
		}
	}
}

func TestGradeKeysFit(t *testing.T) {
	k := &Keys{GB: []Key{{S: 0, V: 3}}, GC: []Key{{S: 0, V: -3}}, GM: []Key{{S: 0, V: 9}}, GS: []Key{{S: 0, V: -9}}, GT: []Key{{S: 0, V: 9}}, GN: []Key{{S: 0, V: -9}}}
	k.fit()
	if k.GB[0].V != 1 || k.GC[0].V != -1 || k.GM[0].V != 1 || k.GS[0].V != -1 || k.GT[0].V != 1 || k.GN[0].V != -1 || !k.gradeKeyed() || k.moves() || !k.any() {
		t.Errorf("после fit: %+v", k)
	}
}
