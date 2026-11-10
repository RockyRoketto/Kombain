package main

import (
	"math"
	"strings"
	"testing"
)

func chunkTexts(cs []SubCue) []string {
	var out []string
	for _, c := range cs {
		out = append(out, c.Text)
	}
	return out
}

func TestSubsChunks(t *testing.T) {
	// время whisper: каждое слово 0,3 с, перед «в гараже» пауза
	c := SubCue{Start: 10, End: 13, Text: "Ты не поверишь, что я нашёл\nв гараже.",
		W: []float64{10, 10.3, 10.6, 11.0, 11.3, 11.5, 12.4, 12.5}}
	cases := []struct {
		mode int
		want string
	}{
		{0, "Ты не поверишь, что я нашёл\nв гараже."},
		{1, "Ты|не поверишь,|что|я нашёл|в гараже."},
		{2, "Ты|не поверишь,|что|я нашёл|в гараже."},
		{3, "Ты не поверишь,|что я нашёл|в гараже."},
		{subsChunkAuto, "Ты не поверишь,|что я нашёл|в гараже."},
	}
	for _, k := range cases {
		got := strings.Join(chunkTexts(subsChunks([]SubCue{c}, k.mode)), "|")
		if got != k.want {
			t.Errorf("режим %d: %q, ждали %q", k.mode, got, k.want)
		}
	}
	// времена: первый кусок с начала реплики, дальше с первого слова, последний до конца; свои времена слов
	cs := subsChunks([]SubCue{c}, 3)
	want := [][2]float64{{10, 11}, {11, 12.4}, {12.4, 13}}
	for i, w := range want {
		if math.Abs(cs[i].Start-w[0]) > 1e-9 || math.Abs(cs[i].End-w[1]) > 1e-9 {
			t.Errorf("кусок %d: %v–%v, ждали %v", i, cs[i].Start, cs[i].End, w)
		}
	}
	if len(cs[1].W) != 3 || cs[1].W[0] != 11 {
		t.Errorf("времена слов куска: %v", cs[1].W)
	}
	// «авто» режет по паузе: «раз два» без знаков, но между ними тишина
	p := SubCue{Start: 0, End: 3, Text: "раз два три", W: []float64{0, 1.5, 1.7}}
	if got := strings.Join(chunkTexts(subsChunks([]SubCue{p}, subsChunkAuto)), "|"); got != "раз|два три" {
		t.Errorf("пауза: %q", got)
	}
	// «авто» режет по длине: больше subsChunkChars знаков
	l := SubCue{Start: 0, End: 3, Text: "огромнейшие возможности"}
	if got := len(subsChunks([]SubCue{l}, subsChunkAuto)); got != 2 {
		t.Errorf("длина: %d кусков", got)
	}
	// без времени слов — равномерно по буквам, без W у кусков
	u := SubCue{Start: 0, End: 4, Text: "аааа бббб вввв гггг"}
	us := subsChunks([]SubCue{u}, 1)
	if len(us) != 4 || math.Abs(us[1].Start-1) > 1e-9 || us[1].W != nil {
		t.Errorf("равномерно: %+v", us)
	}
	// слова в одно время не дают кусков нулевой длины
	z := SubCue{Start: 0, End: 1, Text: "a b c", W: []float64{0, 0, 0.5}}
	for _, k := range subsChunks([]SubCue{z}, 1) {
		if k.End <= k.Start {
			t.Errorf("кусок нулевой длины: %+v", k)
		}
	}
	// плохое значение из проекта сбрасывается
	if s := (Subs{Chunk: 7}).fit(); s.Chunk != 0 {
		t.Errorf("fit: %d", s.Chunk)
	}
}
