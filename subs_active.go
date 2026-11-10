package main

// Эффект субтитров «Активное слово» (стиль Хормози): произносимое слово другим цветом и крупнее, без плашки.
// Слово растёт от своей середины во все стороны, соседи по строке расступаются на половину прироста каждый
// (левые влево, правые вправо), строка остаётся по центру, перенос и соседние строки не меняются.
// Строки переносит программа, как у караоке (subsKarLayout), каждый кусок — своё событие \an5 в середине своего места.
// Куски — слова или группы subsFxWordHeads (подсвечиваются вместе). Всё движется линейно, поэтому время делится на отрезки
// по началам и концам переходов: в отрезке кусок стоит (\pos) или едет (\move) и меняет размер и цвет одним \t.
// Просмотр считает то же: subFxAct* в web/js/subfx.js.

import (
	"fmt"
	"math"
	"slices"
	"strings"
)

const (
	subsActHiC   = "#ffe000" // цвет произносимого слова по умолчанию
	subsActBig   = 0.15      // насколько крупнее по умолчанию (при первом выборе, на странице)
	subsActSlide = 0.12      // плавная смена слова, с
)

// subsActTime: когда кусок становится активным (on) и перестаёт (off, -1 — до конца реплики), сколько длятся переходы (0 — мгновенно)
type subsActTime struct{ on, off, dOn, dOff float64 }

// subsActTimes: кусок активен до начала следующего по времени куска; куски с одним временем активны вместе
// (группа, разорванная строкой текста, или слова, прижатые к концу реплики). Переход не длиннее промежутка до следующего.
// Зеркало: subFxActTimes.
func subsActTimes(ch []subsKChunk, dur float64, soft bool) []subsActTime {
	next := func(i int) (int, float64) {
		for j := i + 1; j < len(ch); j++ {
			if ch[j].t > ch[i].t {
				return j, ch[j].t
			}
		}
		return -1, dur
	}
	slide := func(i int) float64 {
		if !soft {
			return 0
		}
		_, e := next(i)
		return min(subsActSlide, e-ch[i].t)
	}
	out := make([]subsActTime, len(ch))
	for i := range ch {
		out[i] = subsActTime{on: ch[i].t, off: -1, dOn: slide(i)}
		if j, e := next(i); j >= 0 {
			out[i].off, out[i].dOff = e, slide(j)
		}
	}
	return out
}

// subsActRamp: доля перехода, начатого в a длиной d, к моменту u (d = 0 — скачок ровно в a)
func subsActRamp(u, a, d float64) float64 {
	if d <= 0 {
		if u >= a {
			return 1
		}
		return 0
	}
	return min(max((u-a)/d, 0), 1)
}

// subsActLevel: насколько кусок активен (размер) и насколько окрашен в момент u
func subsActLevel(t subsActTime, u float64, keep bool) (size, color float64) {
	size = subsActRamp(u, t.on, t.dOn)
	color = size
	if t.off >= 0 {
		size -= subsActRamp(u, t.off, t.dOff)
		if !keep {
			color = size
		}
	}
	return
}

// subsActMix: цвет ASS (&HBBGGRR&) между a и b (#rrggbb), доля k
func subsActMix(a, b string, k float64) string {
	ch := func(s string, i int) float64 {
		var v int
		fmt.Sscanf(s[1+2*i:3+2*i], "%02x", &v)
		return float64(v)
	}
	c := func(i int) int { return int(math.Round(ch(a, i) + (ch(b, i)-ch(a, i))*k)) }
	return fmt.Sprintf("&H%02X%02X%02X&", c(2), c(1), c(0))
}

// subsFxAct: события «Активного слова» одной реплики
func subsFxAct(c SubCue, text string, s Subs, w, h int, place string, esc *strings.Replacer) string {
	fx := s.Fx
	ch := subsKarChunks(c, text, false)
	if len(ch) == 0 {
		return fmt.Sprintf("Dialogue: 0,%s,%s,Default,,0,0,0,,%s%s\n", subsAssClock(c.Start), subsAssClock(c.End), place, esc.Replace(text))
	}
	size := s.Size * float64(h)
	lines, lineTop := subsKarLayout(ch, s, w, h)
	dur := c.End - c.Start
	times := subsActTimes(ch, dur, fx.Soft)
	cs := func(v float64) int { return int((c.Start+v)*100 + 0.5) }
	clock := func(v int) string { return subsAssClock(float64(v) / 100) }
	pct := func(v float64) string { return fmt.Sprintf("%g", math.Round(v*10000)/100) }
	var sb strings.Builder
	layer, pre := 0, ""
	if s.Back != "" {
		layer, pre = 1, `\3a&HFF&`
	}
	for n, l := range lines {
		// отрезки: начала и концы переходов кусков строки — между ними всё меняется линейно
		bs := []float64{0, dur}
		for k := l[0]; k < l[1]; k++ {
			t := times[k]
			bs = append(bs, t.on, t.on+t.dOn)
			if t.off >= 0 {
				bs = append(bs, t.off, t.off+t.dOff)
			}
		}
		slices.Sort(bs)
		bs = slices.Compact(bs)
		type seg struct {
			from, to int // сотые секунды, как в файле
			a, b     float64
		}
		var segs []seg
		for i := 0; i+1 < len(bs); i++ {
			a, b := min(max(bs[i], 0), dur), min(max(bs[i+1], 0), dur)
			if from, to := cs(a), cs(b); to > from {
				segs = append(segs, seg{from, to, a, b - 1e-9}) // конец — перед скачком на границе
			}
		}
		// grow: на сколько пикселей шире кусок k в момент u
		grow := func(k int, u float64) float64 {
			v, _ := subsActLevel(times[k], u, fx.Keep)
			return v * fx.Big * (ch[k].x1 - ch[k].x0)
		}
		y := lineTop(n) + size/2
		type look struct {
			x, sc, col float64
		}
		at := func(k int, u float64) look {
			x := (ch[k].x0 + ch[k].x1) / 2
			for j := l[0]; j < l[1]; j++ {
				if j < k {
					x += grow(j, u) / 2
				} else if j > k {
					x -= grow(j, u) / 2
				}
			}
			sz, col := subsActLevel(times[k], u, fx.Keep)
			return look{x, 1 + fx.Big*sz, col}
		}
		// событие на отрезок; соседние отрезки, где кусок стоит одинаково, сливаются
		emit := func(lay int, from, to int, p, q look, tail string, extra string) {
			pos := fmt.Sprintf(`\pos(%.1f,%.1f)`, p.x, y)
			if math.Abs(p.x-q.x) >= 0.05 {
				pos = fmt.Sprintf(`\move(%.1f,%.1f,%.1f,%.1f)`, p.x, y, q.x, y)
			}
			tags := fmt.Sprintf(`\fscx%s\fscy%s\1c%s`, pct(p.sc), pct(p.sc), subsActMix(s.Color, fx.Hi, p.col))
			if p.sc != q.sc || p.col != q.col {
				tags += fmt.Sprintf(`\t(\fscx%s\fscy%s\1c%s)`, pct(q.sc), pct(q.sc), subsActMix(s.Color, fx.Hi, q.col))
			}
			fmt.Fprintf(&sb, "Dialogue: %d,%s,%s,Default,,0,0,0,,{\\an5\\q2%s%s%s}%s\n", lay, clock(from), clock(to), pos, extra, tags, tail)
		}
		if s.Back != "" {
			// подложка строки: прозрачный текст строки, по ширине растянут на сумму приростов, середина на месте
			parts := make([]string, 0, l[1]-l[0])
			for k := l[0]; k < l[1]; k++ {
				parts = append(parts, ch[k].text)
			}
			lw := ch[l[1]-1].x1 - ch[l[0]].x0
			wide := func(u float64) float64 {
				g := 0.0
				for k := l[0]; k < l[1]; k++ {
					g += grow(k, u)
				}
				return 1 + g/lw
			}
			cx := (ch[l[0]].x0 + ch[l[1]-1].x1) / 2
			txt := esc.Replace(strings.Join(parts, " "))
			for i := 0; i < len(segs); i++ {
				g := segs[i]
				p, q := wide(g.a), wide(g.b)
				for i+1 < len(segs) && p == q && wide(segs[i+1].a) == p && wide(segs[i+1].b) == p {
					i++
					g.to = segs[i].to
				}
				sx := fmt.Sprintf(`\fscx%s`, pct(p))
				if p != q {
					sx += fmt.Sprintf(`\t(\fscx%s)`, pct(q))
				}
				fmt.Fprintf(&sb, "Dialogue: 0,%s,%s,Default,,0,0,0,,{\\an2\\q2\\pos(%.1f,%.1f)\\1a&HFF&%s}%s\n", clock(g.from), clock(g.to), cx, lineTop(n)+size, sx, txt)
			}
		}
		for k := l[0]; k < l[1]; k++ {
			txt := esc.Replace(ch[k].text)
			for i := 0; i < len(segs); i++ {
				g := segs[i]
				p, q := at(k, g.a), at(k, g.b)
				for i+1 < len(segs) && p == q && at(k, segs[i+1].a) == p && at(k, segs[i+1].b) == p {
					i++
					g.to = segs[i].to
				}
				emit(layer, g.from, g.to, p, q, txt, pre)
			}
		}
	}
	return sb.String()
}
