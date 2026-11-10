package main

import (
	"strings"
	"unicode/utf8"
)

// Куски субтитров («Слов на экране»): реплика показывается не целиком, а короткими кусками, которые сменяются в такт речи.
// Режим общий для всех эффектов: каждый кусок становится своей репликой, и эффект работает на ней как на обычной.
// Subs.Chunk: 0 — реплика целиком, 1–3 — не больше стольких слов, subsChunkAuto — по смыслу (паузы, знаки, длина).
// Зеркало: subChunks в web/js/subfx.js, правила и числа менять в обоих местах.
const (
	subsChunkAuto   = -1
	subsChunkWords  = 3      // «авто»: не больше стольких слов
	subsChunkChars  = 16     // «авто»: и не длиннее стольких знаков с пробелами
	subsChunkPause  = 0.3    // «авто»: пауза перед словом, с которой начинается новый кусок, секунды
	subsChunkLetter = 0.07   // звучание слова для паузы: столько секунд на букву...
	subsChunkLong   = 0.6    // ...но не дольше
	subsChunkEnd    = ".!?…" // после такого знака кусок кончается в любом режиме (конец фразы)
	subsChunkSoft   = ",;:"  // а после такого — только в «авто»
)

// subsChunkTimes: начала слов от начала реплики. Время whisper, если слов столько же, иначе равномерно по буквам на всю длину.
func subsChunkTimes(c SubCue, words []string) []float64 {
	n, dur := len(words), c.End-c.Start
	out := make([]float64, n)
	total, before := 0, 0
	for _, w := range words {
		total += utf8.RuneCountInString(w)
	}
	for i, w := range words {
		if len(c.W) == n {
			out[i] = c.W[i] - c.Start
		} else if total > 0 {
			out[i] = dur * float64(before) / float64(total)
		}
		before += utf8.RuneCountInString(w)
		out[i] = min(max(out[i], 0), dur)
		if i > 0 {
			out[i] = max(out[i], out[i-1])
		}
	}
	return out
}

// subsEndsWith: последний знак слова из набора
func subsEndsWith(w, set string) bool {
	r, _ := utf8.DecodeLastRuneInString(w)
	return strings.ContainsRune(set, r)
}

// subsChunks: реплики, порезанные на куски. Группа subsFxWordHeads («в гараже», «место -») не рвётся;
// группа длиннее предела встаёт отдельным куском. Кусок начинается со своего первого слова (первый — с начала реплики)
// и длится до следующего; последний — до конца реплики. Кусок, который начался бы одновременно с предыдущим, прилипает к нему.
// Паузы «авто» видит только по времени whisper: у равномерного времени их нет.
func subsChunks(cues []SubCue, mode int) []SubCue {
	if mode == 0 {
		return cues
	}
	limit := mode
	if mode == subsChunkAuto {
		limit = subsChunkWords
	}
	var out []SubCue
	for _, c := range cues {
		words := strings.Fields(c.Text)
		if len(words) == 0 || c.End <= c.Start {
			out = append(out, c)
			continue
		}
		at, heads := subsChunkTimes(c, words), subsFxWordHeads(words)
		own := len(c.W) == len(words)
		type piece struct{ from, to int }
		var ps []piece
		for i := 0; i < len(words); {
			j := i + 1 // группа слов i..j-1
			for j < len(words) && heads[j] == heads[i] {
				j++
			}
			// цепочка коротких слов («ты не поверишь») длиннее куска делится с конца парами: короткое слово
			// остаётся со следующим, а кусок не раздувается. Нечётное начало — одно слово.
			if big := max(limit, 2); j-i > big {
				j = i + 2 - (j-i)%2
			}
			if len(ps) > 0 {
				p := &ps[len(ps)-1]
				last := words[p.to-1]
				cut := p.to-p.from+j-i > limit || subsEndsWith(last, subsChunkEnd)
				if mode == subsChunkAuto && !cut {
					sound := min(subsChunkLetter*float64(utf8.RuneCountInString(last)), subsChunkLong)
					cut = utf8.RuneCountInString(strings.Join(words[p.from:j], " ")) > subsChunkChars ||
						subsEndsWith(last, subsChunkSoft) || own && at[i]-at[p.to-1]-sound >= subsChunkPause
				}
				if !cut || at[i] <= at[p.from] {
					p.to = j
					i = j
					continue
				}
			}
			ps = append(ps, piece{i, j})
			i = j
		}
		for k, p := range ps {
			a, b := c.Start, c.End
			if k > 0 {
				a = c.Start + at[p.from]
			}
			if k+1 < len(ps) {
				b = c.Start + at[ps[k+1].from]
			}
			var w []float64
			if own {
				w = append(w, c.W[p.from:p.to]...)
			}
			out = append(out, SubCue{Start: a, End: b, Text: strings.Join(words[p.from:p.to], " "), W: w})
		}
	}
	return out
}
