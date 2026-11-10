package main

import (
	"reflect"
	"strings"
	"testing"
)

func TestSubsKarBreak(t *testing.T) {
	// жадно влезает 3+1, ровнее 2+2
	if got := subsKarBreak([]float64{3, 3, 3, 3}, 1, 11.5); !reflect.DeepEqual(got, []int{0, 2}) {
		t.Fatalf("break %v", got)
	}
	if got := subsKarBreak([]float64{20, 1}, 1, 10); !reflect.DeepEqual(got, []int{0, 1}) {
		t.Fatalf("wide chunk %v", got)
	}
}

func TestSubsKarPills(t *testing.T) {
	ch := []subsKChunk{{t: 0, d: 0.1, x0: 0, x1: 10}, {t: 1, d: 0.1, x0: 20, x1: 30}, {t: 2, d: 0.1, line: 1, x0: 0, x1: 5}}
	if p := subsKarPills(ch, "jump", false, 1.05, 0); len(p) != 1 || p[0].a <= 0 || p[0].a >= 20 {
		t.Fatalf("jump mid %v", p)
	}
	if p := subsKarPills(ch, "jump", false, 1.5, 0); p[0] != (subsKarRect{0, 20, 30}) {
		t.Fatalf("jump end %v", p)
	}
	// grow: первая строка закрыта целиком, на второй растёт
	if p := subsKarPills(ch, "grow", false, 2.5, 0); !reflect.DeepEqual(p, []subsKarRect{{0, 0, 30}, {1, 0, 5}}) {
		t.Fatalf("grow %v", p)
	}
	if p := subsKarPills(ch, "grow", false, -1, 0); p != nil {
		t.Fatalf("before %v", p)
	}
}

func TestSubsFxKar(t *testing.T) {
	c := []SubCue{{Start: 1, End: 3, Text: "раз два в доме", W: []float64{1.1, 1.5, 2, 2.2}}}
	for _, m := range []string{"grow", "jump"} {
		s := Subs{Fx: SubFx{K: "kar", M: m, R: 0.5}}.fit()
		out := subsASS(c, s, 640, 360)
		if !strings.Contains(out, `\p1}m `) || strings.Count(out, "Dialogue: 2,") != 3 {
			t.Fatalf("%s: %s", m, out)
		}
		if strings.Contains(out, `\t(0,0`) || !strings.Contains(out, `}в доме`) {
			t.Fatalf("%s: tags %s", m, out)
		}
	}
	s := Subs{Back: "#000000", Fx: SubFx{K: "kar", M: "grow", Smooth: true}}.fit()
	if out := subsASS(c, s, 640, 360); !strings.Contains(out, `\kf`) || strings.Count(out, "Dialogue: 0,") != 1 {
		t.Fatalf("smooth: %s", out)
	}
	s = Subs{Fx: SubFx{K: "kar", M: "fill"}}.fit()
	out := subsASS(c, s, 640, 360)
	if strings.Count(out, "Dialogue:") != 1 || !strings.Contains(out, `{\k10\kf12}раз`) || !strings.Contains(out, `{\kf12}в доме`) {
		t.Fatalf("fill: %s", out)
	}
	if f := (Subs{Fx: SubFx{K: "kar", M: "x", Smooth: true, R: 3}}).fit().Fx; f.M != "jump" || f.Smooth || f.R != 1 || f.Pill != subsKarPillC {
		t.Fatalf("fit %+v", f)
	}
}
