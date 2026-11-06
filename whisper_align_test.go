package main

import (
	"context"
	"math"
	"os/exec"
	"path/filepath"
	"testing"
)

func near(a, b, eps float64) bool { return math.Abs(a-b) <= eps }

// На настоящем файле первые слова фразы встали на 0,74 и 7,2 с, а сама фраза звучит с 17 с
func TestWhisperRepair(t *testing.T) {
	w := func(a, b float64, s string) whisperWord { return whisperWord{Start: a, End: b, Text: s} }
	got := whisperRepair([]whisperWord{w(.74, 1.5, "Есть"), w(7.2, 8.05, "идея,"), w(18, 18.8, "которая"), w(19, 20, "изменит?"), w(30, 31, "Ставь.")})
	if got[1].End != 18 || got[0].End != got[1].Start || got[0].Start < 16 {
		t.Errorf("первые слова не подтянулись: %+v", got[:2])
	}
	if got[3].Start != 19 || got[4].Start != 30 {
		t.Errorf("конец предложения не должен тянуться к следующему: %+v", got[3:])
	}
	plain := []whisperWord{w(1, 2, "ла"), w(20, 21, "ла")}
	if whisperRepair(plain)[0].Start != 1 {
		t.Error("без знаков препинания границ предложений нет, менять нечего")
	}
}

func TestWhisperAlign(t *testing.T) {
	spans := []speechSpan{{17.1, 20.3}, {21.2, 22.1}, {22.8, 25.1}}
	cues := whisperAlign([]SubCue{{Start: 16.4, End: 21, Text: "a"}, {Start: 21, End: 22.48, Text: "b"}, {Start: 22.59, End: 25.36, Text: "c"}}, spans)
	want := [][2]float64{{17.1, 20.3}, {21.2, 22.1}, {22.8, 25.1}}
	for i, c := range cues {
		if !near(c.Start, want[i][0], 1e-9) || !near(c.End, want[i][1], 1e-9) {
			t.Errorf("реплика %d: %v–%v, ждали %v", i, c.Start, c.End, want[i])
		}
	}
	// граница посреди сплошной речи остаётся: края куска далеко
	mid := whisperAlign([]SubCue{{Start: 5, End: 7, Text: "a"}, {Start: 7, End: 9, Text: "b"}}, []speechSpan{{1, 12}})
	if mid[0].Start != 5 || mid[0].End != 7 || mid[1].Start != 7 || mid[1].End != 9 {
		t.Errorf("сплошная речь: %+v", mid)
	}
	// реплика вдали от речи не трогается, короткая держится минимум
	none := whisperAlign([]SubCue{{Start: 40, End: 41, Text: "a"}}, spans)
	if none[0].Start != 40 || none[0].End != 41 {
		t.Errorf("без речи: %+v", none)
	}
	// Настоящий конец ролика: последняя реплика в тишине, её речь чуть раньше, а дальше музыка. Предыдущая задела кусок на 0,07 с
	end := whisperAlign([]SubCue{{Start: 49.69, End: 50.81, Text: "a"}, {Start: 54.52, End: 56.27, Text: "b"}}, []speechSpan{{49.68, 50.2}, {50.74, 51.76}, {58, 59.8}})
	if !near(end[0].End, 50.39, .01) || end[1].Start != 50.74 || end[1].End != 51.76 {
		t.Errorf("конец ролика: %+v", end)
	}
	short := whisperAlign([]SubCue{{Start: 1, End: 1.5, Text: "a"}}, []speechSpan{{1.1, 1.3}})
	if short[0].End < short[0].Start+cueMinHold-1e-9 {
		t.Errorf("короткая реплика: %+v", short)
	}
}

// Настоящим ffmpeg: тихий фон, по бокам тишина, посередине громкий тон в полосе голоса
func TestSpeechSpans(t *testing.T) {
	ffm, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("нет ffmpeg")
	}
	wav := filepath.Join(t.TempDir(), "a.wav")
	f := "aevalsrc='if(between(t,3,5),0.3*sin(2*PI*1000*t),0.002*sin(2*PI*1000*t))':d=8:s=16000"
	if b, err := exec.Command(ffm, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", f, "-c:a", "pcm_s16le", wav).CombinedOutput(); err != nil {
		t.Fatal(string(b))
	}
	spans, err := speechSpans(context.Background(), ffm, wav)
	if err != nil {
		t.Fatal(err)
	}
	if len(spans) != 1 || !near(spans[0].Start, 3, .1) || !near(spans[0].End, 5, .1) {
		t.Errorf("куски речи: %+v", spans)
	}
	// ровный звук без пауз: речь не отличить
	if got := spansOfLevels(make([]float64, 1000)); got != nil {
		t.Errorf("ровный уровень: %+v", got)
	}
}
