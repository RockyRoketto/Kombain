package main

// Реплики автосубтитров из времён отдельных слов (полный JSON whisper.cpp с --dtw).
// Куски самого whisper для субтитров грубые: первый захватывает всю музыку до речи, конец режет фразу посередине.

import (
	"bytes"
	"encoding/json"
	"regexp"
	"strings"
	"unicode/utf8"
)

const (
	cueMaxChars = 60  // длиннее реплика не становится
	cueBreakAt  = 30  // после запятой можно закончить, если уже столько набралось
	cueMaxDur   = 6.0 // секунд
	cuePause    = 0.7 // такая пауза между словами начинает новую реплику
	cueMinHold  = 0.7 // короткая реплика всё равно держится столько, если не мешает следующая
	wordBaseDur = 0.4 // слово не длится дольше base + perChar на букву: иначе конец фразы уедет в паузу
	wordCharDur = 0.09
	wordMinDur  = 0.08
)

// Только пометка вместо речи: (upbeat music), [МУЗЫКА], ♪
var whisperNoise = regexp.MustCompile(`^\s*[\[(♪*][^\])♪*]*[\])♪*]?\s*$`)

type whisperWord struct {
	Start, End float64
	Text       string
}

type wjSpan struct {
	From int64 `json:"from"`
	To   int64 `json:"to"`
}

// whisperWords: слова всех кусков. Текст берётся сырыми байтами: многобайтовая буква может лежать в двух соседних частях слова,
// и по отдельности каждая часть не строка UTF-8.
func whisperWords(b []byte) ([]whisperWord, error) {
	var f struct {
		Transcription []struct {
			Offsets wjSpan `json:"offsets"`
			Tokens  []struct {
				Text    json.RawMessage `json:"text"`
				Offsets wjSpan          `json:"offsets"`
				DTW     *int64          `json:"t_dtw"` // сотые секунды; -1 или нет поля — не посчитано
			} `json:"tokens"`
		} `json:"transcription"`
	}
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, err
	}
	var out []whisperWord
	last := 0.0
	for _, seg := range f.Transcription {
		var words []whisperWord
		var raw []byte
		start := 0.0
		flush := func() {
			if len(raw) == 0 {
				return
			}
			var s string
			if json.Unmarshal(append(append([]byte{'"'}, raw...), '"'), &s) == nil {
				if s = strings.TrimSpace(s); s != "" {
					words = append(words, whisperWord{Start: start, Text: s})
				}
			}
			raw = nil
		}
		for _, tok := range seg.Tokens {
			if len(tok.Text) < 2 {
				continue
			}
			inner := tok.Text[1 : len(tok.Text)-1]
			if bytes.HasPrefix(inner, []byte("[_")) || bytes.HasPrefix(inner, []byte("<|")) || len(inner) == 0 {
				continue
			}
			if len(raw) == 0 || inner[0] == ' ' {
				flush()
				start = float64(tok.Offsets.From) / 1000
				if tok.DTW != nil && *tok.DTW >= 0 {
					start = float64(*tok.DTW) / 100
				}
				start = max(start, last)
				last = start
			}
			raw = append(raw, inner...)
		}
		flush()
		var text []string
		for _, w := range words {
			text = append(text, w.Text)
		}
		if whisperNoise.MatchString(strings.Join(text, " ")) {
			continue
		}
		segEnd := float64(seg.Offsets.To) / 1000
		for i := range words {
			w := &words[i]
			next := segEnd
			if i+1 < len(words) {
				next = words[i+1].Start
			}
			w.End = max(min(next, w.Start+wordBaseDur+wordCharDur*float64(utf8.RuneCountInString(w.Text))), w.Start+wordMinDur)
		}
		out = append(out, words...)
	}
	return out, nil
}

// whisperGroup собирает слова в реплики: граница на конце предложения, на паузе и при длинной строке
func whisperGroup(words []whisperWord) []SubCue {
	var cues []SubCue
	var cur []string
	var start, end float64
	chars := 0
	flush := func() {
		if len(cur) > 0 {
			cues = append(cues, SubCue{Start: start, End: end, Text: strings.Join(cur, " ")})
		}
		cur, chars = nil, 0
	}
	for i, w := range words {
		n := utf8.RuneCountInString(w.Text)
		if len(cur) > 0 && (chars+1+n > cueMaxChars || w.End-start > cueMaxDur || w.Start-end > cuePause) {
			flush()
		}
		if len(cur) == 0 {
			start = w.Start
		}
		cur = append(cur, w.Text)
		chars += n + 1
		end = w.End
		tail, _ := utf8.DecodeLastRuneInString(w.Text)
		if strings.ContainsRune(".!?…؟。！？", tail) || (strings.ContainsRune(",،;:，", tail) && chars >= cueBreakAt && i+1 < len(words)) {
			flush()
		}
	}
	flush()
	for i := range cues { // короткой реплике дать дочитать
		limit := cues[i].Start + cueMinHold
		if i+1 < len(cues) {
			limit = min(limit, cues[i+1].Start)
		}
		cues[i].End = max(cues[i].End, limit)
	}
	return cues
}

// whisperClean: то же для запасного пути, когда есть только .srt
func whisperClean(cues []SubCue) []SubCue {
	var out []SubCue
	for _, c := range cues {
		if !whisperNoise.MatchString(c.Text) {
			out = append(out, c)
		}
	}
	return out
}
