package main

import (
	"strings"
	"testing"
)

func TestSubsFxAct(t *testing.T) {
	// «в доме» — одна группа: подсвечивается вместе
	c := []SubCue{{Start: 1, End: 3, Text: "раз два в доме", W: []float64{1.1, 1.5, 2, 2.2}}}
	s := Subs{Fx: SubFx{K: "act", Big: 0.2}}.fit()
	if s.Fx.Hi != subsActHiC {
		t.Fatalf("fit hi %+v", s.Fx)
	}
	out := subsASS(c, s, 640, 360)
	if strings.Contains(out, "\\t(") || strings.Contains(out, `\move`) || !strings.Contains(out, `}в доме`) {
		t.Fatalf("jump: %s", out)
	}
	// рывком: «раз» с 1,1 с жёлтое и крупнее, с 1,5 с снова белое
	for _, want := range []string{
		`0:00:01.00,0:00:01.10,Default,,0,0,0,,{\an5\q2\pos(`,
		`\fscx100\fscy100\1c&HFFFFFF&}раз`,
		`0:00:01.10,0:00:01.50,Default,,0,0,0,,{\an5\q2\pos(`,
		`\fscx120\fscy120\1c&H00E0FF&}раз`,
		`0:00:02.00,0:00:03.00,Default,,0,0,0,,{\an5\q2\pos(`, // последний кусок активен до конца реплики
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("jump %q: %s", want, out)
		}
	}
	// соседи расступаются: «раз» левее, пока активно «два»
	x := func(out, from, word string) string {
		i := strings.Index(out, from+",Default,,0,0,0,,{\\an5\\q2\\pos(")
		for i >= 0 && !strings.HasPrefix(out[strings.Index(out[i:], "}")+i+1:], word+"\n") {
			j := strings.Index(out[i+1:], from+",Default,,0,0,0,,{\\an5\\q2\\pos(")
			if j < 0 {
				return ""
			}
			i += j + 1
		}
		if i < 0 {
			return ""
		}
		return out[i+len(from)+30 : i+len(from)+36]
	}
	if a, b := x(out, "0:00:01.10,0:00:01.50", "раз"), x(out, "0:00:01.50,0:00:02.00", "раз"); a == "" || b == "" || a <= b {
		t.Fatalf("push %q %q: %s", a, b, out)
	}
	// плавно, сказанные остаются цветными: переходы 0,12 с, соседи едут \move; с подложкой она растягивается по ширине
	s = Subs{Back: "#000000", Fx: SubFx{K: "act", Big: 0.2, Soft: true, Keep: true}}.fit()
	out = subsASS(c, s, 640, 360)
	for _, want := range []string{
		`0:00:01.10,0:00:01.22,Default,,0,0,0,,{\an5\q2\pos(`,
		`\3a&HFF&\fscx100\fscy100\1c&HFFFFFF&\t(\fscx120\fscy120\1c&H00E0FF&)}раз`,
		`\fscx120\fscy120\1c&H00E0FF&\t(\fscx100\fscy100\1c&H00E0FF&)}раз`,
		`\move(`,
		`Dialogue: 0,0:00:01.10,0:00:01.22,Default,,0,0,0,,{\an2\q2\pos(`,
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("soft %q: %s", want, out)
		}
	}
	if strings.Contains(out, "Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\an5") {
		t.Fatalf("back layer: %s", out)
	}
	// переход не длиннее промежутка до следующего слова
	c = []SubCue{{Start: 0, End: 1, Text: "раз два", W: []float64{0, 0.05}}}
	out = subsASS(c, Subs{Fx: SubFx{K: "act", Soft: true}}.fit(), 640, 360)
	if !strings.Contains(out, "0:00:00.00,0:00:00.05,Default,,0,0,0,,{\\an5\\q2\\pos(") {
		t.Fatalf("short: %s", out)
	}
	if f := (Subs{Fx: SubFx{K: "act", Big: 2, Hi: "red", Pill: "#ffffff"}}).fit().Fx; f.Big != 0.3 || f.Hi != subsActHiC || f.Pill != "" {
		t.Fatalf("fit %+v", f)
	}
	if v := subsActMix("#ffffff", "#000000", 0.5); v != "&H808080&" {
		t.Fatal(v)
	}
}
