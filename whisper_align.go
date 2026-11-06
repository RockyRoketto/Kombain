package main

// Границы реплик по самому звуку. Времена whisper неточные: слова в начале фразы могут стоять на десятки секунд раньше речи,
// а конца слова у него нет вовсе. В полосе голоса речь обычно громче музыки под ней, поэтому границу можно поставить туда, где речь слышна.

import (
	"context"
	"encoding/binary"
	"math"
	"os/exec"
	"sort"
	"strings"
	"unicode/utf8"
)

const (
	alignFrame    = 0.02 // секунд в одном замере
	alignFloorWin = 8.0  // уровень фона считается в такой окрестности в каждую сторону
	alignAbove    = 10.0 // речь: на столько дБ громче фона
	alignRange    = 10.0 // меньше этой разницы между тихим и громким речь от музыки не отличить
	alignJoin     = 0.15 // такая пауза не разрывает кусок речи
	alignMinSpan  = 0.2  // короче: щелчок, а не речь
	alignInside   = 0.5  // граница внутри куска речи притягивается к его краю только с такого расстояния
	alignTouch    = 0.15 // задетый так мало кусок речи реплике не принадлежит
	alignOrphan   = 4.0  // реплика без речи ищет свой кусок не дальше этого
	sentenceGap   = 1.5  // внутри предложения пауза длиннее не верится: время слова посчитано неверно
)

type speechSpan struct{ Start, End float64 }

// speechSpans: где слышна речь. Пусто, если отличить её от остального нельзя.
func speechSpans(ctx context.Context, ffm, wav string) ([]speechSpan, error) {
	cmd := exec.CommandContext(ctx, ffm, "-hide_banner", "-loglevel", "error", "-nostdin", "-i", wav, "-af", "highpass=f=300,lowpass=f=3400", "-ac", "1", "-ar", "16000", "-f", "s16le", "-")
	hide(cmd)
	b, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	return spansOfLevels(pcmLevels(b)), nil
}

// pcmLevels: уровень в дБ на каждый замер, вход 16 бит, 16 кГц
func pcmLevels(pcm []byte) []float64 {
	n := int(16000 * alignFrame * 2)
	out := make([]float64, 0, len(pcm)/n)
	for at := 0; at+n <= len(pcm); at += n {
		sum := 0.0
		for i := at; i < at+n; i += 2 {
			v := float64(int16(binary.LittleEndian.Uint16(pcm[i:]))) / 32768
			sum += v * v
		}
		out = append(out, 10*math.Log10(sum/float64(n/2)+1e-10))
	}
	return out
}

func percentile(v []float64, p float64) float64 {
	s := append([]float64(nil), v...)
	sort.Float64s(s)
	return s[int(p*float64(len(s)-1))]
}

func spansOfLevels(lv []float64) []speechSpan {
	if len(lv) == 0 || percentile(lv, .95)-percentile(lv, .15) < alignRange {
		return nil
	}
	win := int(alignFloorWin / alignFrame)
	const step = 25
	var spans []speechSpan
	on := false
	var start float64
	floor := 0.0
	for i, v := range lv {
		if i%step == 0 {
			floor = percentile(lv[max(i-win, 0):min(i+win, len(lv))], .1)
		}
		t := float64(i) * alignFrame
		if loud := v > floor+alignAbove; loud && !on {
			on, start = true, t
		} else if !loud && on {
			on = false
			spans = append(spans, speechSpan{start, t})
		}
	}
	if on {
		spans = append(spans, speechSpan{start, float64(len(lv)) * alignFrame})
	}
	var joined []speechSpan
	for _, s := range spans {
		if n := len(joined); n > 0 && s.Start-joined[n-1].End < alignJoin {
			joined[n-1].End = s.End
		} else {
			joined = append(joined, s)
		}
	}
	out := joined[:0]
	for _, s := range joined {
		if s.End-s.Start >= alignMinSpan {
			out = append(out, s)
		}
	}
	return out
}

func wordEndsSentence(w string) bool {
	tail, _ := utf8.DecodeLastRuneInString(w)
	return strings.ContainsRune(".!?…؟。！？", tail)
}

// whisperRepair: внутри предложения слова идут друг за другом. Слово, оторванное от следующего, ставится прямо перед ним.
// Без знаков препинания (песни) границ предложений нет, и такая правка могла бы утащить целую строку: там ничего не меняется.
func whisperRepair(words []whisperWord) []whisperWord {
	marked := false
	for _, w := range words {
		marked = marked || wordEndsSentence(w.Text)
	}
	if !marked {
		return words
	}
	for i := len(words) - 2; i >= 0; i-- {
		w, next := &words[i], words[i+1]
		if wordEndsSentence(w.Text) || next.Start-w.End <= sentenceGap {
			continue
		}
		dur := wordBaseDur + wordCharDur*float64(utf8.RuneCountInString(w.Text))
		w.Start, w.End = max(next.Start-dur, 0), next.Start
	}
	return words
}

// whisperAlign двигает края реплик к настоящему началу и концу речи. Реплика без услышанной речи остаётся как была.
func whisperAlign(cues []SubCue, spans []speechSpan) []SubCue {
	if len(spans) == 0 {
		return cues
	}
	spanFrom := func(t float64) int { // первый кусок, который кончается позже t
		return sort.Search(len(spans), func(i int) bool { return spans[i].End > t })
	}
	claimed := func(s speechSpan, self int) bool {
		for i, c := range cues {
			if i != self && c.Start < s.End && c.End > s.Start {
				return true
			}
		}
		return false
	}
	for i := range cues {
		c := &cues[i]
		prevEnd := 0.0
		if i > 0 {
			prevEnd = cues[i-1].End
		}
		nextStart := math.Inf(1)
		if i+1 < len(cues) {
			nextStart = cues[i+1].Start
		}
		// Вся реплика в тишине: её слова звучат в ближайшем куске речи, который ни одной реплике не достался. Сначала смотрим назад:
		// позже реплики речи для неё обычно нет, а дальше часто музыка.
		if k := spanFrom(c.Start); k == len(spans) || spans[k].Start >= c.End {
			if k > 0 && c.Start-spans[k-1].End <= alignOrphan && spans[k-1].Start >= prevEnd && !claimed(spans[k-1], i) {
				c.Start, c.End = spans[k-1].Start, spans[k-1].End
			} else if k < len(spans) && spans[k].Start-c.End <= alignOrphan && spans[k].End <= nextStart && !claimed(spans[k], i) {
				c.Start, c.End = spans[k].Start, spans[k].End
			}
			c.End = max(c.End, min(c.Start+cueMinHold, nextStart))
			continue
		}
		if k := spanFrom(c.Start); k < len(spans) {
			s := spans[k]
			switch {
			case s.Start > c.Start: // началась в тишине: ждём речь
				c.Start = s.Start
			case s.End-c.Start <= alignTouch && k+1 < len(spans) && spans[k+1].Start < c.End: // задела конец чужого куска
				c.Start = spans[k+1].Start
			case c.Start-s.Start <= alignInside && s.Start >= prevEnd:
				c.Start = s.Start
			}
		}
		k := spanFrom(c.End)
		switch {
		case k < len(spans) && spans[k].Start <= c.End:
			s := spans[k]
			if c.End-s.Start <= alignTouch && k > 0 && spans[k-1].End > c.Start { // задела начало чужого куска
				c.End = spans[k-1].End
			} else if s.End-c.End <= alignInside && s.End <= nextStart {
				c.End = s.End
			}
		case k > 0 && spans[k-1].End > c.Start: // кончилась в тишине: речь кончилась раньше
			c.End = spans[k-1].End
		}
		c.End = max(c.End, min(c.Start+cueMinHold, nextStart))
	}
	return cues
}
