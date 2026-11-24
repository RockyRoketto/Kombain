package main

import (
	"math"
	"strings"
	"testing"
)

func TestSubsHash(t *testing.T) {
	// значения сверены с subFxHash в web/js/subfx.js: при правке формулы менять в обоих местах
	for _, w := range []struct {
		a, b int
		v    float64
	}{{0, 1, 0.448578}, {3, 8, -0.454956}, {7, 33, 0.219818}, {12, 4, -0.257050}} {
		if v := subsHash(w.a, w.b); math.Abs(v-w.v) > 1e-6 {
			t.Fatalf("hash(%d,%d) = %f, want %f", w.a, w.b, v, w.v)
		}
	}
	for _, c := range []struct {
		s  string
		ok bool
	}{{"ЭТО просто", true}, {"смотри!", true}, {"Это ok", false}, {"я Я", false}, {"OK", true}} {
		if subsHit(c.s) != c.ok {
			t.Fatalf("hit %q", c.s)
		}
	}
}

func TestSubsFxPopFit(t *testing.T) {
	s := Subs{Fx: SubFx{K: "shake", Str: 5, Hit: true, Cps: 9}}.fit()
	if s.Fx.Str != 1 || !s.Fx.Hit || s.Fx.Cps != 0 {
		t.Fatalf("shake %+v", s.Fx)
	}
	if s = (Subs{Fx: SubFx{K: "flip", Dur: 9}}).fit(); s.Fx.Dur != 0.6 {
		t.Fatalf("flip %+v", s.Fx)
	}
}

func TestSubsFxShake(t *testing.T) {
	c := []SubCue{{Start: 1, End: 3, Text: "раз ДВА", W: []float64{1, 1.5}}}
	out := subsASS(c, Subs{Fx: SubFx{K: "shake", Hit: true}}.fit(), 640, 360)
	// «раз» тихое: одно событие на всю реплику; «ДВА» громкое: до 1,5 стоит, потом шаги дрожи и снова стоит
	if n := strings.Count(out, "}раз\n"); n != 1 {
		t.Fatalf("тихое слово: %d событий: %s", n, out)
	}
	if n := strings.Count(out, "}ДВА\n"); n != 1+subsShakeSteps+1 {
		t.Fatalf("громкое слово: %d событий: %s", n, out)
	}
	for _, want := range []string{"0:00:01.50,0:00:01.54,Default,,0,0,0,,{\\an5\\q2\\pos(", "\\frz", "0:00:01.82,0:00:03.00,Default"} {
		if !strings.Contains(out, want) {
			t.Fatalf("%q: %s", want, out)
		}
	}
	// без «только громких» трясутся оба слова
	out = subsASS(c, Subs{Fx: SubFx{K: "shake"}}.fit(), 640, 360)
	if n := strings.Count(out, "}раз\n"); n != subsShakeSteps+1 { // со времени 0 события «до начала» нет
		t.Fatalf("все слова: %d: %s", n, out)
	}
	// тряска не выходит за конец реплики
	c = []SubCue{{Start: 0, End: 1, Text: "раз", W: []float64{0.9}}}
	out = subsASS(c, Subs{Fx: SubFx{K: "shake"}}.fit(), 640, 360)
	if strings.Contains(out, "0:00:01.04") {
		t.Fatalf("конец: %s", out)
	}
}

func TestSubsFxGlitch(t *testing.T) {
	c := []SubCue{{Start: 0, End: 2, Text: "привет мир"}}
	out := subsASS(c, Subs{Fx: SubFx{K: "glitch"}}.fit(), 640, 360)
	// сбой в начале (5 шагов) и в 1,2 с; в каждом шаге строка и две копии
	for _, want := range []string{
		"Dialogue: 2,0:00:00.00,0:00:00.04,Default,,0,0,0,,{\\an5\\q2\\3a&HFF&\\pos(", `\1c&H0000FF&\1a&H60&}привет мир`, `\1c&HFFFF00&\1a&H60&}привет мир`,
		"Dialogue: 0,0:00:00.20,0:00:01.20,Default,,0,0,0,,{\\an5\\q2\\pos(", // между сбоями строка стоит
		"Dialogue: 2,0:00:01.20,0:00:01.24,Default",
		"Dialogue: 0,0:00:01.40,0:00:02.00,Default",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("%q: %s", want, out)
		}
	}
	if n := strings.Count(out, "Dialogue: 2,"); n != 2*2*subsGlitchSteps {
		t.Fatalf("копий %d: %s", n, out)
	}
}

func TestSubsFxFlip(t *testing.T) {
	c := []SubCue{{Start: 0, End: 2, Text: "раз два", W: []float64{0, 1}}}
	out := subsASS(c, Subs{Fx: SubFx{K: "flip", Dur: 0.3}}.fit(), 640, 360)
	for _, want := range []string{
		`0:00:00.00,0:00:00.30,Default,,0,0,0,,{\an5\q2\pos(`,
		`\frx90\1a&HFF&\3a&HFF&\t(0,300,\frx0\1a&H00&\3a&H00&)}раз`,
		`0:00:00.30,0:00:02.00,Default,,0,0,0,,{\an5\q2\pos(`,
		`0:00:01.00,0:00:01.30,Default`, // «два» раскрывается со своего времени
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("%q: %s", want, out)
		}
	}
	// с подложкой проявляется только заливка: плашка у слоя 0
	out = subsASS(c, Subs{Back: "#000000", Fx: SubFx{K: "flip"}}.fit(), 640, 360)
	if !strings.Contains(out, `\frx90\1a&HFF&\t(0,300,\frx0\1a&H00&)}раз`) || !strings.Contains(out, `\q2\3a&HFF&\pos(`) {
		t.Fatalf("back: %s", out)
	}
}
