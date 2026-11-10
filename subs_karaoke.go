package main

// Эффект субтитров «Караоке»: за произносимым словом плашка со скруглёнными углами или заливка букв.
// Режимы (SubFx.M): "grow" — плашка растёт вправо по строке, сказанное остаётся на ней; "jump" — плашка переезжает
// со слова на слово; "fill" — буквы заливаются цветом. Smooth у grow и fill: плавно в такт речи, иначе по словам рывком.
// Просмотр считает то же: subFxKar* в web/js/subfx.js. Правила менять в обоих местах.

import (
	"fmt"
	"slices"
	"strings"
)

const (
	subsKarPillC = "#e9b872"
	subsKarOnC   = "#1b1b1b"
	subsKarR     = 0.5  // скругление по умолчанию, доля половины высоты плашки
	subsKarSlide = 0.12 // рывок к следующему слову, с
	subsKarLast  = 0.6  // время последнего слова реплики (конца слова whisper не даёт), с
	subsKarFrame = 0.02 // шаг событий плашки, пока она движется, с
	subsKarPadX  = 0.15 // плашка шире слова на столько с каждой стороны, доля высоты строки
	subsKarPadY  = 0.03 // и ниже ячейки строки сверху и снизу
)

// subsKChunk: кусок реплики, который подсвечивается одним толчком: слово или группа (subsFxWordHeads) в пределах одной строки текста.
type subsKChunk struct {
	from, to int     // байты текста реплики: начало первого слова и конец последнего
	text     string  // слова через пробел
	para     int     // номер строки текста (разрывы \n)
	t, d     float64 // начало от начала реплики и время перехода к куску
	line     int     // строка на экране (после переноса)
	x0, x1   float64 // края текста куска в пикселях кадра
}

// subsKarChunks: куски и их время. d: плавно — до следующего куска (у последнего subsKarLast, не дальше конца реплики),
// по словам — subsKarSlide, но не дольше того же промежутка.
func subsKarChunks(c SubCue, text string, smooth bool) []subsKChunk {
	idx := subsWord.FindAllStringIndex(text, -1)
	words := make([]string, len(idx))
	for i, m := range idx {
		words[i] = text[m[0]:m[1]]
	}
	at := subsFxWordTimes(c, words)
	heads := subsFxWordHeads(words)
	var out []subsKChunk
	para, prevEnd := 0, 0
	for i, m := range idx {
		p := para + strings.Count(text[prevEnd:m[0]], "\n")
		prevEnd = m[1]
		if i > 0 && heads[i] != i && p == para {
			k := &out[len(out)-1]
			k.to, k.text = m[1], k.text+" "+words[i]
			continue
		}
		para = p
		out = append(out, subsKChunk{from: m[0], to: m[1], text: words[i], para: p, t: at[i]})
	}
	subsKarTimes(out, c.End-c.Start, smooth)
	return out
}

// subsKarTimes: время перехода каждого куска (см. subsKarChunks)
func subsKarTimes(ch []subsKChunk, dur float64, smooth bool) {
	for i := range ch {
		gap := -1.0
		for j := i + 1; j < len(ch); j++ {
			if ch[j].t > ch[i].t {
				gap = ch[j].t - ch[i].t
				break
			}
		}
		if gap < 0 {
			gap = max(min(dur-ch[i].t, subsKarLast), 0.01)
		}
		ch[i].d = gap
		if !smooth {
			ch[i].d = min(subsKarSlide, gap)
		}
	}
}

// subsKarBreak: перенос строки текста из кусков шириной w (пробел space) в ширину limit. Сначала сколько строк
// нужно жадным переносом, потом самая узкая ширина, при которой строк не больше: строки выходят ровные, как у libass.
// Кусок не делится. Возвращает номера кусков, с которых начинаются строки. Зеркало: subFxKarBreak в web/js/subfx.js.
func subsKarBreak(w []float64, space, limit float64) []int {
	greedy := func(l float64) []int {
		starts, cur := []int{0}, 0.0
		for i, v := range w {
			if i > 0 && cur+space+v > l+1e-6 {
				starts, cur = append(starts, i), v
				continue
			}
			if i > 0 {
				cur += space
			}
			cur += v
		}
		return starts
	}
	n := len(greedy(limit))
	lo, hi := 0.0, limit
	for _, v := range w {
		lo = max(lo, v)
	}
	if hi < lo {
		return greedy(lo)
	}
	for it := 0; it < 24; it++ {
		mid := (lo + hi) / 2
		if len(greedy(mid)) <= n {
			hi = mid
		} else {
			lo = mid
		}
	}
	return greedy(hi)
}

// subsKarRect: плашка на строке line от a до b (пиксели кадра, с отступами)
type subsKarRect struct {
	line int
	a, b float64
}

// subsKarEase: доля перехода. Плавно — равномерно, по словам — быстро и мягко к концу (кубическая)
func subsKarEase(p float64, smooth bool) float64 {
	p = min(max(p, 0), 1)
	if smooth {
		return p
	}
	return 1 - (1-p)*(1-p)*(1-p)
}

// subsKarPills: плашки в момент u от начала реплики. pad — отступ плашки от текста по ширине.
// Зеркало: subFxKarPills в web/js/subfx.js.
func subsKarPills(ch []subsKChunk, m string, smooth bool, u, pad float64) []subsKarRect {
	cur := -1
	for i := range ch {
		if ch[i].t <= u {
			cur = i
		}
	}
	if cur < 0 {
		return nil
	}
	prev := -1 // последний кусок раньше текущего
	for j := cur - 1; j >= 0; j-- {
		if ch[j].t < ch[cur].t {
			prev = j
			break
		}
	}
	c := ch[cur]
	k := subsKarEase((u-c.t)/c.d, smooth && m == "grow")
	lerp := func(x, y float64) float64 { return x + (y-x)*k }
	a1, b1 := c.x0-pad, c.x1+pad
	if m == "jump" {
		a0, b0 := (a1+b1)/2, (a1+b1)/2
		if prev >= 0 && ch[prev].line == c.line {
			a0, b0 = ch[prev].x0-pad, ch[prev].x1+pad
		}
		return []subsKarRect{{c.line, lerp(a0, a1), lerp(b0, b1)}}
	}
	// grow: строки выше текущей закрыты целиком, на текущей плашка от её начала до растущего края
	var out []subsKarRect
	first := map[int]int{}
	for i := 0; i <= cur; i++ {
		if _, ok := first[ch[i].line]; !ok {
			first[ch[i].line] = i
		}
	}
	for i := 0; i <= cur; i++ {
		if ch[i].line != c.line && (i == cur || ch[i+1].line != ch[i].line) {
			out = append(out, subsKarRect{ch[i].line, ch[first[ch[i].line]].x0 - pad, ch[i].x1 + pad})
		}
	}
	a := ch[first[c.line]].x0 - pad
	b0 := a
	if prev >= 0 && ch[prev].line == c.line {
		b0 = ch[prev].x1 + pad
	}
	return append(out, subsKarRect{c.line, a, lerp(b0, b1)})
}

// subsKarOn: когда слово куска i перекрашивается под плашку и когда обратно (-1 — до конца реплики).
// По словам — на середине рывка; «прыгает» — до рывка к следующему куску. Плавный grow красит буквы \kf, тут не нужен.
func subsKarOn(ch []subsKChunk, m string, i int) (on, off float64) {
	on, off = ch[i].t+ch[i].d/2, -1
	if m == "jump" && i+1 < len(ch) {
		off = ch[i+1].t + ch[i+1].d/2
	}
	return
}

// subsKarPath: скруглённые прямоугольники рисунком ASS (\p1), координаты кадра
func subsKarPath(rs []subsKarRect, top func(int) float64, size, round float64) string {
	const kappa = 0.5523
	var sb strings.Builder
	f := func(v float64) string { return fmt.Sprintf("%.1f", v) }
	for _, r := range rs {
		if r.b-r.a < 0.5 {
			continue
		}
		y0, y1 := top(r.line)+subsKarPadY*size, top(r.line)+size-subsKarPadY*size
		rad := min(round*(y1-y0)/2, (r.b-r.a)/2)
		q := rad * kappa
		a, b := r.a, r.b
		fmt.Fprintf(&sb, "m %s %s l %s %s b %s %s %s %s %s %s l %s %s b %s %s %s %s %s %s l %s %s b %s %s %s %s %s %s l %s %s b %s %s %s %s %s %s ",
			f(a+rad), f(y0), f(b-rad), f(y0),
			f(b-rad+q), f(y0), f(b), f(y0+rad-q), f(b), f(y0+rad),
			f(b), f(y1-rad),
			f(b), f(y1-rad+q), f(b-rad+q), f(y1), f(b-rad), f(y1),
			f(a+rad), f(y1),
			f(a+rad-q), f(y1), f(a), f(y1-rad+q), f(a), f(y1-rad),
			f(a), f(y0+rad),
			f(a), f(y0+rad-q), f(a+rad-q), f(y0), f(a+rad), f(y0))
	}
	return strings.TrimSpace(sb.String())
}

// subsKarTop: верх блока из n строк высотой size и середина по ширине — как libass ставит обычную реплику
func subsKarTop(s Subs, w, h, n int) (cx, top float64) {
	size := s.Size * float64(h)
	block := float64(n) * size
	marginV := int(subsMargin*float64(h) + 0.5)
	marginL, marginR := int((s.X-s.W/2)*float64(w)+0.5), int((1-s.X-s.W/2)*float64(w)+0.5)
	cx = float64(marginL+w-marginR) / 2
	switch {
	case s.H > 0:
		return s.X * float64(w), (s.Y-s.H/2)*float64(h) - block/2
	case s.Y > 0:
		return cx, float64(h-int((1-s.Y)*float64(h)+0.5)) - block
	case s.Pos == "top":
		return cx, float64(marginV)
	case s.Pos == "center":
		return cx, float64(h)/2 - block/2
	}
	return cx, float64(h-marginV) - block
}

// subsFxKar: события караоке одной реплики
func subsFxKar(c SubCue, text string, s Subs, w, h int, place string, esc *strings.Replacer) string {
	fx := s.Fx
	smooth := fx.Smooth && fx.M != "jump"
	ch := subsKarChunks(c, text, smooth)
	if len(ch) == 0 {
		return fmt.Sprintf("Dialogue: 0,%s,%s,Default,,0,0,0,,%s%s\n", subsAssClock(c.Start), subsAssClock(c.End), place, esc.Replace(text))
	}
	cs := func(v float64) int { return int(v*100 + 0.5) }
	if fx.M == "fill" {
		return subsKarFill(c, text, ch, s, place, esc, cs)
	}
	size := s.Size * float64(h)
	lines, lineTop := subsKarLayout(ch, s, w, h)
	start, end := cs(c.Start), cs(c.End)
	var sb strings.Builder
	pre := ""
	if s.Back != "" {
		// подложка слоем 0 построчно, буквы слоем 2 без неё (\3a), плашка между ними
		subsKarBack(&sb, c, ch, lines, lineTop, size, esc)
		pre = `\3a&HFF&`
	}
	// плашка: пока движется — событие на каждый шаг subsKarFrame, между рывками одно
	pad := subsKarPadX * size
	pts := map[int]bool{start: true, end: true}
	for _, k := range ch {
		for v := 0.0; v < k.d+subsKarFrame/2; v += subsKarFrame {
			pts[cs(c.Start+k.t+min(v, k.d))] = true
		}
	}
	keys := make([]int, 0, len(pts))
	for k := range pts {
		if k >= start && k <= end {
			keys = append(keys, k)
		}
	}
	slices.Sort(keys)
	pill := `\1c&H` + subsAssColor(fx.Pill, 1)[4:] + `&\1a&H00&`
	last, from := "", 0
	flush := func(to int) {
		if last != "" && to > from {
			fmt.Fprintf(&sb, "Dialogue: 1,%s,%s,Default,,0,0,0,,{\\an7\\pos(0,0)\\bord0\\shad0\\3a&HFF&\\4a&HFF&%s\\p1}%s\n",
				subsAssClock(float64(from)/100), subsAssClock(float64(to)/100), pill, last)
		}
	}
	for i := 0; i+1 < len(keys); i++ {
		// вид на конце шага: на первом же шаге рывка плашка уже сдвинулась
		path := subsKarPath(subsKarPills(ch, fx.M, smooth, float64(keys[i+1])/100-c.Start, pad), lineTop, size, fx.R)
		if path != last {
			flush(keys[i])
			last, from = path, keys[i]
		}
	}
	flush(keys[len(keys)-1])
	// слова: каждый кусок своим событием в посчитанном месте, тогда текст и плашка не расходятся
	base := start * 10
	ms := func(v float64) int { return max(int((c.Start+v)*1000+0.5)-base, 1) } // \t(0,0) libass понимает как «на всё событие»
	on := subsAssColor(fx.On, 1)
	onc := "&H" + on[4:] + "&"
	pc := "&H" + subsAssColor(fx.Pill, 1)[4:] + "&"
	tc := "&H" + subsAssColor(s.Color, 1)[4:] + "&"
	for i, k := range ch {
		tags := ""
		if smooth {
			// плавный рост: буквы красятся \kf вместе с краем плашки, обводка — когда слово закрыто целиком
			tags = fmt.Sprintf(`\1c%s\2c%s\t(%d,%d,\3c%s)\k%d\kf%d`, onc, tc, ms(k.t+k.d), ms(k.t+k.d)+1, pc,
				max(cs(c.Start+k.t)-start, 0), max(cs(c.Start+k.t+k.d)-cs(c.Start+k.t), 1))
		} else {
			t0, t1 := subsKarOn(ch, fx.M, i)
			if t1 < 0 || t1 > t0 {
				tags = fmt.Sprintf(`\t(%d,%d,\1c%s\3c%s)`, ms(t0), ms(t0)+1, onc, pc)
				if t1 >= 0 {
					tags += fmt.Sprintf(`\t(%d,%d,\1c%s\3c&H000000&)`, ms(t1), ms(t1)+1, tc)
				}
			}
		}
		fmt.Fprintf(&sb, "Dialogue: 2,%s,%s,Default,,0,0,0,,{\\an1\\q2\\pos(%.1f,%.1f)%s%s}%s\n", subsAssClock(c.Start), subsAssClock(c.End),
			k.x0, lineTop(k.line)+size, pre, tags, esc.Replace(k.text))
	}
	return sb.String()
}

// subsKarLayout: перенос кусков по ширине рамки программой (каждая строка текста отдельно) и места кусков ch[k].line, x0, x1
// в пикселях кадра. Возвращает куски каждой строки экрана (с какого по какой) и верх строки n; высота строки у libass — размер шрифта.
// Общая для караоке и «Активного слова». Зеркало: subFxKarLay в web/js/subfx.js.
func subsKarLayout(ch []subsKChunk, s Subs, w, h int) (lines [][2]int, lineTop func(int) float64) {
	size := s.Size * float64(h)
	sp := textWidth(s.Font, size, "a b") - textWidth(s.Font, size, "ab")
	line := 0
	for i := 0; i < len(ch); {
		j := i
		for j < len(ch) && ch[j].para == ch[i].para {
			j++
		}
		ws := make([]float64, j-i)
		for k := range ws {
			ws[k] = textWidth(s.Font, size, ch[i+k].text)
		}
		starts := append(subsKarBreak(ws, sp, s.W*float64(w)), j-i)
		for n := 0; n+1 < len(starts); n++ {
			x := 0.0
			for k := i + starts[n]; k < i+starts[n+1]; k++ {
				ch[k].line, ch[k].x0 = line, x
				x += ws[k-i]
				ch[k].x1 = x
				x += sp
			}
			lines = append(lines, [2]int{i + starts[n], i + starts[n+1]})
			line++
		}
		i = j
	}
	cx, top := subsKarTop(s, w, h, len(lines))
	for _, l := range lines {
		lw := ch[l[1]-1].x1
		for k := l[0]; k < l[1]; k++ {
			ch[k].x0 += cx - lw/2
			ch[k].x1 += cx - lw/2
		}
	}
	return lines, func(n int) float64 { return top + float64(n)*size }
}

// subsKarBack: подложка слоем 0 построчно: текст строки прозрачный (\1a), видна только плашка BorderStyle 3
func subsKarBack(sb *strings.Builder, c SubCue, ch []subsKChunk, lines [][2]int, lineTop func(int) float64, size float64, esc *strings.Replacer) {
	for n, l := range lines {
		parts := make([]string, 0, l[1]-l[0])
		for k := l[0]; k < l[1]; k++ {
			parts = append(parts, ch[k].text)
		}
		fmt.Fprintf(sb, "Dialogue: 0,%s,%s,Default,,0,0,0,,{\\an1\\q2\\pos(%.1f,%.1f)\\1a&HFF&}%s\n", subsAssClock(c.Start), subsAssClock(c.End),
			ch[l[0]].x0, lineTop(n)+size, esc.Replace(strings.Join(parts, " ")))
	}
}

// subsKarFill: заливка букв — одно событие, перенос как у обычной реплики. \kf красит от \2c (цвет текста) к \1c (цвет заливки).
// По словам: заливка за d, потом пустой \k до следующего куска.
func subsKarFill(c SubCue, text string, ch []subsKChunk, s Subs, place string, esc *strings.Replacer, cs func(float64) int) string {
	var body strings.Builder
	fmt.Fprintf(&body, `%s{\1c&H%s&\2c&H%s&}`, place, subsAssColor(s.Fx.Pill, 1)[4:], subsAssColor(s.Color, 1)[4:])
	body.WriteString(esc.Replace(text[:ch[0].from]))
	at := cs(c.Start) // сколько уже прошло, в сотых: так ошибки округления не копятся
	for i, k := range ch {
		t0, t1 := cs(c.Start+k.t), cs(c.Start+k.t+k.d)
		next := t1
		if i+1 < len(ch) {
			next = max(cs(c.Start+ch[i+1].t), t1)
		}
		tag := ""
		if t0 > at {
			tag = fmt.Sprintf(`\k%d`, t0-at)
		}
		tag += fmt.Sprintf(`\kf%d`, max(t1-t0, 1))
		body.WriteString("{" + tag + "}" + esc.Replace(text[k.from:k.to]))
		at = t0 + max(t1-t0, 1)
		if next > at && i+1 < len(ch) {
			fmt.Fprintf(&body, `{\k%d}`, next-at)
			at = next
		}
		tail := len(text)
		if i+1 < len(ch) {
			tail = ch[i+1].from
		}
		body.WriteString(esc.Replace(text[k.to:tail]))
	}
	return fmt.Sprintf("Dialogue: 0,%s,%s,Default,,0,0,0,,%s\n", subsAssClock(c.Start), subsAssClock(c.End), body.String())
}
