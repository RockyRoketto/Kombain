package main

// Эффекты субтитров как в TikTok и Reels: «Неон», «Тряска», «Глитч», «Переворот».
// Рендер через ASS (libass), по образцу «Активного слова» (subs_active.go): строки переносит программа (subsKarLayout),
// каждый кусок или строка — своё событие \an5 в середине своего места. Просмотр: web/js/subfx.js (subFxPop*), числа и формулы там те же.
// Случайность — не случайная: subsHash даёт одно и то же число в просмотре и в файле (зеркало: subFxHash).

import (
	"fmt"
	"math"
	"strings"
	"unicode"
)

const (
	subsStrDef       = 0.5  // сила эффекта по умолчанию (при первом выборе, на странице)
	subsShakeSteps   = 8    // тряска слова после его начала: шагов по subsPopStep (0,32 с)
	subsPopStep      = 0.04 // шаг тряски и глитча, с
	subsGlitchSteps  = 5    // длина одного сбоя в шагах (0,2 с)
	subsGlitchPeriod = 1.2  // сбой в начале реплики и дальше через столько секунд
)

// subsHash: детерминированное число в [-1, 1) по двум целым; зеркало subFxHash (Math.imul там даёт то же, что uint32 здесь)
func subsHash(a, b int) float64 {
	x := uint32(a)*374761393 + uint32(b)*668265263 + 144665
	x = (x ^ x>>13) * 1274126177
	x ^= x >> 16
	return float64(x&0xffff)/32768 - 1
}

// subsHit: «громкий» кусок для тряски: есть «!» или слово из двух и более букв целиком ВЕРХНИМ РЕГИСТРОМ. Зеркало subFxHit.
func subsHit(text string) bool {
	if strings.Contains(text, "!") {
		return true
	}
	for _, w := range strings.Fields(text) {
		n, up := 0, true
		for _, r := range w {
			if unicode.IsLetter(r) {
				n++
				up = up && unicode.IsUpper(r)
			}
		}
		if n >= 2 && up {
			return true
		}
	}
	return false
}

// subsPopEv: помогает писать события реплики: время от начала реплики → сотые секунды файла
type subsPopEv struct {
	sb  *strings.Builder
	c   SubCue
	pre string // \3a&HFF& при подложке: плашку рисует слой 0
	lay int
}

func (e subsPopEv) cs(v float64) int { return int((e.c.Start+v)*100 + 0.5) }

// put: событие от a до b (секунды от начала реплики); пустой отрезок пропускается
func (e subsPopEv) put(a, b float64, tags, text string) {
	from, to := e.cs(a), e.cs(b)
	if to <= from {
		return
	}
	fmt.Fprintf(e.sb, "Dialogue: %d,%s,%s,Default,,0,0,0,,{\\an5\\q2%s%s}%s\n", e.lay, subsAssClock(float64(from)/100), subsAssClock(float64(to)/100), e.pre, tags, text)
}

// subsPopSetup: куски, раскладка и подложка, общие для тряски, глитча и переворота. ok = false: текста нет, надо обычное событие.
func subsPopSetup(c SubCue, text string, s Subs, w, h int, esc *strings.Replacer, sb *strings.Builder) (ch []subsKChunk, lines [][2]int, lineTop func(int) float64, ev subsPopEv, ok bool) {
	ch = subsKarChunks(c, text, false)
	if len(ch) == 0 {
		return
	}
	lines, lineTop = subsKarLayout(ch, s, w, h)
	ev = subsPopEv{sb: sb, c: c}
	if s.Back != "" {
		subsKarBackFlat(sb, c, ch, lines, lineTop, s.Size*float64(h), esc)
		ev.lay, ev.pre = 1, `\3a&HFF&`
	}
	return ch, lines, lineTop, ev, true
}

// subsKarBackFlat: подложка без растяжения (у «Активного слова» она растягивается): прозрачный текст строки слоем 0
func subsKarBackFlat(sb *strings.Builder, c SubCue, ch []subsKChunk, lines [][2]int, lineTop func(int) float64, size float64, esc *strings.Replacer) {
	for n, l := range lines {
		parts := make([]string, 0, l[1]-l[0])
		for k := l[0]; k < l[1]; k++ {
			parts = append(parts, ch[k].text)
		}
		cx := (ch[l[0]].x0 + ch[l[1]-1].x1) / 2
		fmt.Fprintf(sb, "Dialogue: 0,%s,%s,Default,,0,0,0,,{\\an5\\q2\\pos(%.1f,%.1f)\\1a&HFF&}%s\n", subsAssClock(c.Start), subsAssClock(c.End),
			cx, lineTop(n)+size/2, esc.Replace(strings.Join(parts, " ")))
	}
}

func subsPopPlain(c SubCue, text, place string, esc *strings.Replacer) string {
	return fmt.Sprintf("Dialogue: 0,%s,%s,Default,,0,0,0,,%s%s\n", subsAssClock(c.Start), subsAssClock(c.End), place, esc.Replace(text))
}

// subsFxShake: кусок дрожит subsShakeDur после своего начала, амплитуда падает к нулю. Только громкие: см. subsHit.
func subsFxShake(c SubCue, text string, s Subs, w, h int, place string, esc *strings.Replacer) string {
	var sb strings.Builder
	ch, lines, lineTop, ev, ok := subsPopSetup(c, text, s, w, h, esc, &sb)
	if !ok {
		return subsPopPlain(c, text, place, esc)
	}
	size, str, dur := s.Size*float64(h), s.Fx.Str, c.End-c.Start
	for n, l := range lines {
		y := lineTop(n) + size/2
		for k := l[0]; k < l[1]; k++ {
			x := (ch[k].x0 + ch[k].x1) / 2
			txt := esc.Replace(ch[k].text)
			pos := func(dx, dy float64) string { return fmt.Sprintf(`\pos(%.1f,%.1f)`, x+dx, y+dy) }
			t0 := ch[k].t
			if s.Fx.Hit && !subsHit(ch[k].text) {
				ev.put(0, dur, pos(0, 0), txt)
				continue
			}
			ev.put(0, t0, pos(0, 0), txt)
			steps := subsShakeSteps
			for i := 0; i < steps; i++ {
				a := t0 + float64(i)*subsPopStep
				if a >= dur {
					break
				}
				amp := size * 0.2 * str * (1 - float64(i)/float64(steps))
				rot := 10 * str * (1 - float64(i)/float64(steps)) * subsHash(i, k*5+3)
				ev.put(a, min(a+subsPopStep, dur), pos(amp*subsHash(i, k*5+1), amp*0.6*subsHash(i, k*5+2))+fmt.Sprintf(`\frz%.1f`, rot), txt)
			}
			ev.put(t0+float64(steps)*subsPopStep, dur, pos(0, 0), txt)
		}
	}
	return sb.String()
}

// subsFxGlitch: в начале реплики и каждые subsGlitchPeriod с короткий сбой: красная и голубая копии строки разъезжаются
// в стороны, сама строка дёргается и сжимается или растягивается. Копии — слой над текстом, видны наполовину.
func subsFxGlitch(c SubCue, text string, s Subs, w, h int, place string, esc *strings.Replacer) string {
	var sb strings.Builder
	ch, lines, lineTop, ev, ok := subsPopSetup(c, text, s, w, h, esc, &sb)
	if !ok {
		return subsPopPlain(c, text, place, esc)
	}
	size, str, dur := s.Size*float64(h), s.Fx.Str, c.End-c.Start
	for n, l := range lines {
		y := lineTop(n) + size/2
		cx := (ch[l[0]].x0 + ch[l[1]-1].x1) / 2
		parts := make([]string, 0, l[1]-l[0])
		for k := l[0]; k < l[1]; k++ {
			parts = append(parts, ch[k].text)
		}
		txt := esc.Replace(strings.Join(parts, " "))
		base := func(dx, dy float64) string { return fmt.Sprintf(`\pos(%.1f,%.1f)`, cx+dx, y+dy) }
		last, j := 0.0, 0
		for b := 0.0; b < dur; b += subsGlitchPeriod {
			ev.put(last, b, base(0, 0), txt)
			steps := subsGlitchSteps
			for i := 0; i < steps; i++ {
				a := b + float64(i)*subsPopStep
				if a >= dur {
					break
				}
				e := min(a+subsPopStep, dur)
				sx := 100 + 10*str*subsHash(j, n*8+4)
				ev.put(a, e, base(size*0.03*str*subsHash(j, n*8+1), 0)+fmt.Sprintf(`\fscx%.1f`, sx), txt)
				d := size * 0.08 * str * (0.4 + 0.6*math.Abs(subsHash(j, n*8+3)))
				dy := size * 0.02 * str * subsHash(j, n*8+2)
				cp := subsPopEv{sb: ev.sb, c: c, lay: 2, pre: `\3a&HFF&`}
				cp.put(a, e, base(-d, dy)+`\1c&H0000FF&\1a&H60&`, txt)
				cp.put(a, e, base(d, -dy)+`\1c&HFFFF00&\1a&H60&`, txt)
				j++
			}
			last = min(b+float64(steps)*subsPopStep, dur)
		}
		ev.put(last, dur, base(0, 0), txt)
	}
	return sb.String()
}

// subsFxFlip: слово появляется, раскрываясь вокруг горизонтальной оси: \frx от 90° до 0 и проявление за Dur
func subsFxFlip(c SubCue, text string, s Subs, w, h int, place string, esc *strings.Replacer) string {
	var sb strings.Builder
	ch, lines, lineTop, ev, ok := subsPopSetup(c, text, s, w, h, esc, &sb)
	if !ok {
		return subsPopPlain(c, text, place, esc)
	}
	size, dur := s.Size*float64(h), c.End-c.Start
	for n, l := range lines {
		y := lineTop(n) + size/2
		for k := l[0]; k < l[1]; k++ {
			x := (ch[k].x0 + ch[k].x1) / 2
			txt := esc.Replace(ch[k].text)
			pos := fmt.Sprintf(`\pos(%.1f,%.1f)`, x, y)
			t0 := ch[k].t
			d := min(s.Fx.Dur, dur-t0)
			ms := int(d*1000 + 0.5)
			fade := `\1a&HFF&`
			back := `\1a&H00&`
			if s.Back == "" {
				fade, back = `\1a&HFF&\3a&HFF&`, `\1a&H00&\3a&H00&`
			}
			if ms > 0 {
				ev.put(t0, t0+d, pos+fmt.Sprintf(`\frx90%s\t(0,%d,\frx0%s)`, fade, ms, back), txt)
			}
			ev.put(t0+d, dur, pos, txt)
		}
	}
	return sb.String()
}
