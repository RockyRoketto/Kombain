package main

// Субтитры монтажа из файла .srt: вжечь в кадр или положить дорожкой в файл.
// Файл читается здесь, а не фильтром ffmpeg: кодировку и метки вывода (Project.In) считает программа,
// и в ffmpeg идёт уже готовый временный файл с нужными временами.
// Просмотр: mvSubsDraw в web/js/viewport.js. Размер, шрифт и отступы там должны совпадать с subsASS.

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"
)

const (
	subsMaxFile  = 20 << 20
	subsSize     = 0.05 // высота строки от высоты кадра, если не задана
	subsMinSize  = 0.01
	subsMaxSize  = 0.2
	subsMargin   = 0.05 // отступ от края кадра: доля той же стороны
	subsOutline  = 0.06 // толщина обводки от высоты строки
	subsFont     = "Arial"
	subsModeBurn = "burn"
	subsModeTrk  = "track"
	subsModeBoth = "both"
)

// Subs: настройки субтитров проекта. Шрифт, размер и положение важны только при вжигании:
// дорожку рисует плеер по своим настройкам.
type Subs struct {
	Path string   `json:"path"`
	Cues []SubCue `json:"cues"`           // реплики после правок; nil — взять из файла Path
	Mode string   `json:"mode"`           // subsModeBurn, subsModeTrk или subsModeBoth
	Font string   `json:"font,omitempty"` // название шрифта Windows
	Size float64  `json:"size,omitempty"` // высота строки, доля высоты кадра
	Pos  string   `json:"pos,omitempty"`  // bottom, center, top
	// Вид. Просмотр: mvSubsDraw в web/js/viewport.js. Подложка рисуется на каждую строку, тогда обводки у букв нет.
	Color string  `json:"color,omitempty"` // цвет текста #rrggbb, пусто — белый
	Back  string  `json:"back,omitempty"`  // цвет подложки #rrggbb, пусто — без неё
	BackA float64 `json:"backA,omitempty"` // её непрозрачность, 0–1
	// Контейнер: ширина и середина в долях кадра, Y — нижний край в долях высоты. Y задан — Pos не важен.
	// H — своя высота рамки, не зависит от шрифта, текст стоит по её центру; 0 — рамка по тексту, Y тогда нижний край текста.
	W float64 `json:"w,omitempty"`
	X float64 `json:"x,omitempty"`
	Y float64 `json:"y,omitempty"`
	H float64 `json:"h,omitempty"`
	// Join: разрывы строк внутри реплик не учитываются при вжигании, текст переносится только по ширине рамки
	Join bool `json:"join,omitempty"`
	// Chunk: «Слов на экране» (subs_chunks.go). 0 — реплика целиком, 1–3 — куски не длиннее стольких слов, -1 — авто
	Chunk int `json:"chunk,omitempty"`
	// Эффект сразу на все реплики. Просмотр считает те же моменты: subFxState в web/js/subfx.js
	Fx SubFx `json:"fx"`
}

// SubFx: эффект субтитров. K: "" — без эффекта, "type" — печатная машинка (буквы по одной, курсор |),
// "word" — по слову (слова копятся, каждое появляется с отскоком)
type SubFx struct {
	K     string  `json:"k,omitempty"`
	Cps   float64 `json:"cps,omitempty"`   // букв в секунду; не успевает — печатает быстрее, чтобы закончить к subsFxTypeEnd длины реплики
	Cur   string  `json:"cur,omitempty"`   // цвет курсора #rrggbb, пусто — без курсора
	Blink bool    `json:"blink,omitempty"` // курсор мигает: subsFxBlink виден, столько же нет
	// «по слову»: Dur — сколько секунд слово появляется, Bounce — насколько оно вырастает больше 100%, прежде чем вернуться (0–0,3)
	Dur    float64 `json:"dur,omitempty"`
	Bounce float64 `json:"bounce,omitempty"`
	// «караоке» (subs_karaoke.go): M — "grow", "jump" или "fill"; Pill — цвет плашки или заливки; On — цвет слова на плашке;
	// R — скругление плашки, доля половины высоты (0 — прямые углы); Smooth — плавно в такт речи (grow и fill), иначе по словам рывком
	M      string  `json:"m,omitempty"`
	Pill   string  `json:"pill,omitempty"`
	On     string  `json:"on,omitempty"`
	R      float64 `json:"r,omitempty"`
	Smooth bool    `json:"smooth,omitempty"`
	// «активное слово» (subs_active.go): Hi — цвет произносимого слова; Big — насколько оно крупнее, 0–0,3;
	// Keep — сказанные слова остаются цвета Hi; Soft — смена слова плавным переходом subsActSlide, иначе мгновенно
	Hi   string  `json:"hi,omitempty"`
	Big  float64 `json:"big,omitempty"`
	Keep bool    `json:"keep,omitempty"`
	Soft bool    `json:"soft,omitempty"`
}

const (
	subsFxCps     = 20
	subsFxBlink   = 0.5
	subsFxTypeEnd = 0.85
	subsFxCurW    = 0.06 // ширина курсора от высоты строки
	subsFxCurDown = 0.2  // сколько курсор уходит ниже базовой линии, от высоты строки
	subsFxDur     = 0.3
	// Рост слова: от 0 до 1+Bounce за subsFxPeak долю Dur, потом обратно к 1. Ускорение \t в ASS: k = доля^accel,
	// меньше 1 — быстро, к концу плавно. Просмотр: subFxWordAt в web/js/subfx.js
	subsFxPeak  = 0.6
	subsFxAccel = 0.5
)

var subsWord = regexp.MustCompile(`\S+`)

// subsFxWordTimes: когда начинается каждое слово, секунды от начала реплики. Времена whisper, если слов столько же,
// иначе равномерно по буквам до subsFxTypeEnd длины. Не раньше предыдущего слова и не позже subsFxTypeEnd длины.
// Слова группы (subsFxWordHeads) получают время первого слова группы: время самих слов (SubCue.W) не меняется.
func subsFxWordTimes(c SubCue, words []string) []float64 {
	n := len(words)
	dur := c.End - c.Start
	out := make([]float64, n)
	letters := make([]int, n)
	total := 0
	for i, w := range words {
		letters[i] = utf8.RuneCountInString(w)
		total += letters[i]
	}
	before := 0
	for i := range out {
		if len(c.W) == n {
			out[i] = c.W[i] - c.Start
		} else if total > 0 {
			out[i] = subsFxTypeEnd * dur * float64(before) / float64(total)
		}
		before += letters[i]
		out[i] = min(max(out[i], 0), subsFxTypeEnd*dur)
		if i > 0 {
			out[i] = max(out[i], out[i-1])
		}
	}
	for i, h := range subsFxWordHeads(words) {
		out[i] = out[h]
	}
	return out
}

var (
	subsPunctOnly = regexp.MustCompile(`^[\p{P}\p{S}]+$`)
	subsShortWord = regexp.MustCompile(`^[\p{P}\p{S}]*[\p{L}\p{N}]+$`) // слово без знака после букв: «в», но не «в,»
	// служебные слова длиннее двух букв (короткие подклеиваются и так). Зеркало: SUBFX_GLUE в web/js/subfx.js
	subsGlueWords = strings.Fields("для без над под при про или the and for with")
)

// subsFxWordHeads: какие слова появляются одним толчком. Для каждого слова — номер первого слова его группы.
// Слово только из знаков (тире тоже) липнет к предыдущему; короткое служебное (1–2 буквы или из subsGlueWords,
// без знака после букв) — к следующему. Зеркало: subFxWordHeads в web/js/subfx.js, правила менять в обоих местах.
func subsFxWordHeads(words []string) []int {
	heads := make([]int, len(words))
	forward := false // предыдущее слово просит следующее в свою группу
	for i, w := range words {
		punct := subsPunctOnly.MatchString(w)
		switch {
		case i > 0 && (punct || forward):
			heads[i] = heads[i-1]
		default:
			heads[i] = i
		}
		if !punct || i == 0 {
			core := strings.TrimLeftFunc(w, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsNumber(r) })
			forward = punct || (subsShortWord.MatchString(w) && (utf8.RuneCountInString(core) <= 2 || slices.Contains(subsGlueWords, strings.ToLower(core))))
		}
	}
	return heads
}

// subsFxWord: по слову — одно событие на реплику, у каждого слова свои \t от начала события.
// До своего времени слово прозрачное, но полного размера и держит место. Потом растёт по ширине и высоте от 0 до 1+Bounce
// и возвращается к 1. Растущее слово libass раздвигало бы строку, поэтому по бокам слова две распорки (см. strut),
// у которых \fsp меняется теми же \t: (1−s)·W/2 каждая, при s > 1 меньше нуля. Ширина места s·W + (1−s)·W
// постоянна. W меряет textWidth; его ошибка умножается на (1−s) и на глаз не видна. Слово растёт от своей середины,
// по высоте от базовой линии.
func subsFxWord(c SubCue, text string, s Subs, h int, place string, esc *strings.Replacer) string {
	idx := subsWord.FindAllStringIndex(text, -1)
	words := make([]string, len(idx))
	for i, m := range idx {
		words[i] = text[m[0]:m[1]]
	}
	at := subsFxWordTimes(c, words)
	size := s.Size * float64(h)
	// Распорка — невидимый неразрывный пробел (по нему строка не переносится) с \fsp минус его ширина:
	// в покое места не занимает. \fsp у libass умножается на \fscx, поэтому распорка по ширине не сжимается, меняется только \fsp.
	// На рисунок \fsp не действует — потому буква, а не полоска.
	// Высотой распорка 1+Bounce: libass считает высоту строки по растянутым буквам, и без неё строки над выросшим словом
	// подскакивали бы. Так строка заранее рассчитана на вершину отскока: с отскоком строки чуть дальше друг от друга,
	// просмотр (subFxWordPaint) ставит такой же межстрочный.
	b := s.Fx.Bounce
	const nbsp = " "
	nb := textWidth(s.Font, size, nbsp)
	tall := fmt.Sprintf(`%g`, math.Round(1000+1000*b)/10)
	strut := func(anim string) string {
		return fmt.Sprintf(`{\fscx100\fscy%s\alpha&HFF&\fsp%.2f%s}`+nbsp+`{\fscy100\fsp0}`, tall, -nb, anim)
	}
	alpha := `\alpha` // с подложкой прозрачность только у букв: обводка слоя 1 должна остаться невидимой
	var sb strings.Builder
	layer, pre := 0, ""
	if s.Back != "" {
		// подложка слоем 0: весь текст той же высоты, что распорки (\fscy ширину не меняет) — строки стоят как в слое 1,
		// а подложка ровная и чуть выше. Распорки в этом слое дали бы под каждой свою плашку.
		fmt.Fprintf(&sb, "Dialogue: 0,%s,%s,Default,,0,0,0,,%s{\\1a&HFF&\\fscy%s}%s\n", subsAssClock(c.Start), subsAssClock(c.End), place, tall, esc.Replace(text))
		layer, pre, alpha = 1, `{\3a&HFF&}`, `\1a`
	}
	base := int(c.Start*100+0.5) * 10 // начало события в мс, как его округлит файл
	var body strings.Builder
	body.WriteString(place + pre)
	from := 0
	for i, m := range idx {
		body.WriteString(esc.Replace(text[from:m[0]]))
		t0 := int((c.Start+at[i])*1000+0.5) - base
		t1 := t0 + int(s.Fx.Dur*1000+0.5)
		tm := t1 // вершина: без отскока рост сразу до 100%
		if b > 0 {
			tm = t0 + int(subsFxPeak*s.Fx.Dur*1000+0.5)
		}
		raw := text[m[0]:m[1]]
		word := esc.Replace(raw)
		jump := t0 // мгновенная смена \t(t0,t0); но \t(0,0) libass понимает как «на всё событие», поэтому у начала 0..1 мс
		if t0 == 0 {
			jump = 1
		}
		half := textWidth(s.Font, size, raw) / 2
		sp := fmt.Sprintf(`\t(%d,%d,\fsp%.2f)\t(%d,%d,%g,\fsp%.2f)`, t0, jump, half-nb, t0, tm, subsFxAccel, -b*half-nb)
		peak := fmt.Sprintf(`%g`, math.Round(1000+1000*b)/10)
		grow := fmt.Sprintf(`{%s&HFF&\t(%d,%d,%s&H00&\fscx0\fscy0)\t(%d,%d,%g,\fscx%s\fscy%s)`, alpha, t0, jump, alpha, t0, tm, subsFxAccel, peak, peak)
		if b > 0 {
			sp += fmt.Sprintf(`\t(%d,%d,%g,\fsp%.2f)`, tm, t1, subsFxAccel, -nb)
			grow += fmt.Sprintf(`\t(%d,%d,%g,\fscx100\fscy100)`, tm, t1, subsFxAccel)
		}
		body.WriteString(strut(sp) + grow + "}" + word + strut(sp))
		from = m[1]
	}
	body.WriteString(esc.Replace(text[from:]))
	fmt.Fprintf(&sb, "Dialogue: %d,%s,%s,Default,,0,0,0,,%s\n", layer, subsAssClock(c.Start), subsAssClock(c.End), body.String())
	return sb.String()
}

// subsFxStep: время на одну букву реплики из n букв длиной dur
func subsFxStep(fx SubFx, n int, dur float64) float64 {
	if n <= 0 {
		return dur
	}
	return min(1/fx.Cps, subsFxTypeEnd*dur/float64(n))
}

// subsFxState: сколько букв видно в момент t от начала реплики и виден ли курсор. Первая буква сразу.
func subsFxState(fx SubFx, n int, dur, t float64) (int, bool) {
	k := min(n, int(t/subsFxStep(fx, n, dur)+1e-9)+1) // 1e-9: ровно на границе буквы деление дробей даёт 13,999…
	cur := fx.Cur != "" && (!fx.Blink || int(t/subsFxBlink+1e-9)%2 == 0)
	return k, cur
}

// subsFxType: печатная машинка — реплика делится на события, в каждом вся строка, ненапечатанное прозрачно,
// поэтому строка не прыгает. Подложка стоит сразу во всю строку, как в просмотре.
func subsFxType(c SubCue, text string, s Subs, h int, place string, esc *strings.Replacer) string {
	runes := []rune(text)
	n := 0
	for _, r := range runes {
		if r != '\n' {
			n++
		}
	}
	dur := c.End - c.Start
	hide := `{\alpha&HFF&}`
	// границы событий в сотых секунды, как в файле ASS
	cs := func(v float64) int { return int(v*100 + 0.5) }
	cuts := map[int]bool{cs(c.Start): true, cs(c.End): true}
	step := subsFxStep(s.Fx, n, dur)
	for i := 1; i < n; i++ {
		cuts[cs(c.Start+float64(i)*step)] = true
	}
	if s.Fx.Cur != "" && s.Fx.Blink {
		for t := subsFxBlink; t < dur; t += subsFxBlink {
			cuts[cs(c.Start+t)] = true
		}
	}
	keys := make([]int, 0, len(cuts))
	for k := range cuts {
		if k >= cs(c.Start) && k <= cs(c.End) {
			keys = append(keys, k)
		}
	}
	slices.Sort(keys)
	// курсор — полоска-рисунок нулевой ширины: \fsp вычитает её ширину, поэтому строки переносятся как у готовой реплики
	// и не прыгают, пока курсор идёт по тексту. Высота — строка, низ на нижнем краю строки (\pbo — доля под базовой линией).
	cur := ""
	if s.Fx.Cur != "" {
		size := s.Size * float64(h)
		w, ht := max(1, int(subsFxCurW*size+0.5)), int(size+0.5)
		cur = fmt.Sprintf(`{\p1\fsp-%d\bord0\shad0\1a&H00&\1c&H%s%s%s&\pbo%d}m 0 0 l %d 0 %d %d 0 %d{\p0\fsp0}`, w,
			strings.ToUpper(s.Fx.Cur[5:7]), strings.ToUpper(s.Fx.Cur[3:5]), strings.ToUpper(s.Fx.Cur[1:3]), int(subsFxCurDown*size+0.5), w, w, ht, ht)
	}
	var sb strings.Builder
	layer, pre := 0, ""
	if s.Back != "" {
		// подложка: libass рисует её под каждым куском с другой прозрачностью отдельно, и края кусков темнеют.
		// Поэтому вся подложка — слой 0 на всю реплику, а буквы — слой 1 без подложки; текст в слоях один, раскладка совпадает.
		fmt.Fprintf(&sb, "Dialogue: 0,%s,%s,Default,,0,0,0,,%s{\\1a&HFF&}%s\n", subsAssClock(c.Start), subsAssClock(c.End), place, esc.Replace(text))
		layer, pre = 1, `{\3a&HFF&}`
	}
	line, from := "", 0
	flush := func(to int) {
		if line != "" && to > from {
			fmt.Fprintf(&sb, "Dialogue: %d,%s,%s,Default,,0,0,0,,%s%s%s\n", layer, subsAssClock(float64(from)/100), subsAssClock(float64(to)/100), place, pre, line)
		}
	}
	for i := 0; i+1 < len(keys); i++ {
		k, on := subsFxState(s.Fx, n, dur, (float64(keys[i]+keys[i+1])/200)-c.Start)
		cut := 0
		for seen := 0; cut < len(runes) && seen < k; cut++ {
			if runes[cut] != '\n' {
				seen++
			}
		}
		body := esc.Replace(string(runes[:cut]))
		if on {
			body += cur
		}
		if cut < len(runes) {
			body += hide + esc.Replace(string(runes[cut:]))
		}
		if body != line {
			flush(keys[i])
			line, from = body, keys[i]
		}
	}
	flush(keys[len(keys)-1])
	return sb.String()
}

var subsBreak = regexp.MustCompile(`\s*\n\s*`)

var subsHex = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// subsAssColor: #rrggbb и непрозрачность в формат ASS &HAABBGGRR, где AA — наоборот, прозрачность
func subsAssColor(c string, opacity float64) string {
	return fmt.Sprintf("&H%02X%s%s%s", int((1-opacity)*255+0.5), strings.ToUpper(c[5:7]), strings.ToUpper(c[3:5]), strings.ToUpper(c[1:3]))
}

type SubCue struct {
	Start float64 `json:"a"`
	End   float64 `json:"b"`
	Text  string  `json:"t"`
	// W: начала слов в секундах монтажа из whisper, по одному на слово текста (strings.Fields).
	// Число слов разошлось с текстом (правка, .srt) — эффект «по слову» раскладывает время равномерно по буквам.
	W []float64 `json:"w,omitempty"`
}

var (
	subsTime = regexp.MustCompile(`^\s*(\d+):(\d{1,2}):(\d{1,2})[,.](\d{1,3})\s*-->\s*(\d+):(\d{1,2}):(\d{1,2})[,.](\d{1,3})`)
	subsTags = regexp.MustCompile(`</?[a-zA-Z][^>]*>|\{\\[^}]*\}`)
)

// cp1251High: символы 0x80–0xBF. С 0xC0 идут заглавные и строчные русские буквы подряд, от U+0410.
var cp1251High = []rune{
	0x0402, 0x0403, 0x201A, 0x0453, 0x201E, 0x2026, 0x2020, 0x2021, 0x20AC, 0x2030, 0x0409, 0x2039, 0x040A, 0x040C, 0x040B, 0x040F,
	0x0452, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0xFFFD, 0x2122, 0x0459, 0x203A, 0x045A, 0x045C, 0x045B, 0x045F,
	0x00A0, 0x040E, 0x045E, 0x0408, 0x00A4, 0x0490, 0x00A6, 0x00A7, 0x0401, 0x00A9, 0x0404, 0x00AB, 0x00AC, 0x00AD, 0x00AE, 0x0407,
	0x00B0, 0x00B1, 0x0406, 0x0456, 0x0491, 0x00B5, 0x00B6, 0x00B7, 0x0451, 0x2116, 0x0454, 0x00BB, 0x0458, 0x0405, 0x0455, 0x0457,
}

// subsDecode: UTF-8 или UTF-16 с меткой, UTF-8 без метки, остальное считаем CP1251: так обычно сохранены старые русские субтитры.
func subsDecode(b []byte) string {
	switch {
	case len(b) >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF:
		return string(b[3:])
	case len(b) >= 2 && ((b[0] == 0xFF && b[1] == 0xFE) || (b[0] == 0xFE && b[1] == 0xFF)):
		big := b[0] == 0xFE
		units := make([]uint16, 0, len(b)/2)
		for i := 2; i+1 < len(b); i += 2 {
			if big {
				units = append(units, uint16(b[i])<<8|uint16(b[i+1]))
			} else {
				units = append(units, uint16(b[i+1])<<8|uint16(b[i]))
			}
		}
		return string(utf16.Decode(units))
	case utf8.Valid(b):
		return string(b)
	}
	var sb strings.Builder
	for _, c := range b {
		switch {
		case c < 0x80:
			sb.WriteByte(c)
		case c < 0xC0:
			sb.WriteRune(cp1251High[c-0x80])
		default:
			sb.WriteRune(0x0410 + rune(c-0xC0))
		}
	}
	return sb.String()
}

func subsClock(h, m, s, ms string) float64 {
	hh, _ := strconv.Atoi(h)
	mm, _ := strconv.Atoi(m)
	ss, _ := strconv.Atoi(s)
	frac, _ := strconv.Atoi((ms + "00")[:3]) // ",5" это 500 мс
	return float64(hh)*3600 + float64(mm)*60 + float64(ss) + float64(frac)/1000
}

// subsParse разбирает текст .srt. Оформление вроде <i> убирается: вжигание и просмотр рисуют все строки одинаково.
func subsParse(text string) []SubCue {
	var cues []SubCue
	var cur *SubCue
	var body []string
	flush := func() {
		if cur != nil {
			cur.Text = strings.TrimSpace(subsTags.ReplaceAllString(strings.Join(body, "\n"), ""))
			if cur.Text != "" && cur.End > cur.Start {
				cues = append(cues, *cur)
			}
		}
		cur, body = nil, nil
	}
	for _, line := range strings.Split(strings.ReplaceAll(text, "\r", ""), "\n") {
		if m := subsTime.FindStringSubmatch(line); m != nil {
			flush()
			cur = &SubCue{Start: subsClock(m[1], m[2], m[3], m[4]), End: subsClock(m[5], m[6], m[7], m[8])}
			continue
		}
		if strings.TrimSpace(line) == "" {
			flush()
			continue
		}
		if cur != nil {
			body = append(body, line)
		}
	}
	flush()
	slices.SortStableFunc(cues, func(a, b SubCue) int {
		switch {
		case a.Start < b.Start:
			return -1
		case a.Start > b.Start:
			return 1
		}
		return 0
	})
	return cues
}

func subsRead(path string) ([]SubCue, error) {
	st, err := os.Stat(path)
	if err != nil {
		return nil, errT("subs.notFound", filepath.Base(path))
	}
	if st.Size() > subsMaxFile {
		return nil, errT("subs.tooBig", filepath.Base(path))
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	cues := subsParse(subsDecode(b))
	if len(cues) == 0 {
		return nil, errT("subs.empty", filepath.Base(path))
	}
	return cues, nil
}

// subsRange: реплики между метками вывода, время от начала результата
func subsRange(cues []SubCue, offset, dur float64) []SubCue {
	var out []SubCue
	for _, c := range cues {
		a, b := max(c.Start-offset, 0), min(c.End-offset, dur)
		if text := strings.TrimSpace(c.Text); b > a && text != "" {
			var w []float64
			for _, v := range c.W {
				w = append(w, v-offset)
			}
			out = append(out, SubCue{a, b, text, w})
		}
	}
	return out
}

// subsFit: значения из проекта в допустимые пределы. Шрифт попадает в строку стиля, где запятая делит поля.
func (s Subs) fit() Subs {
	if s.Size <= 0 {
		s.Size = subsSize
	}
	s.Size = min(max(s.Size, subsMinSize), subsMaxSize)
	s.Font = strings.NewReplacer(",", "", "\n", "", "\r", "").Replace(s.Font)
	if s.Font == "" {
		s.Font = subsFont
	}
	if !subsHex.MatchString(s.Color) {
		s.Color = "#ffffff"
	}
	if !subsHex.MatchString(s.Back) {
		s.Back = ""
	}
	if s.BackA <= 0 {
		s.BackA = 0.6
	}
	s.BackA = min(s.BackA, 1)
	if s.W <= 0 {
		s.W = 1 - 2*subsMargin
	}
	s.W = min(max(s.W, 0.1), 1)
	if s.X <= 0 {
		s.X = 0.5
	}
	s.X = min(max(s.X, s.W/2), 1-s.W/2) // контейнер целиком в кадре
	s.Y = min(max(s.Y, 0), 1)
	if s.Y <= 0 || s.H <= 0 {
		s.H = 0 // высота без нижнего края ничего не значит
	} else {
		s.H = min(max(s.H, 0.02), 1)
		s.Y = max(s.Y, s.H) // рамка целиком в кадре
	}
	if s.Chunk < subsChunkAuto || s.Chunk > subsChunkWords {
		s.Chunk = 0
	}
	switch s.Fx.K {
	case "type":
		s.Fx = SubFx{K: "type", Cps: s.Fx.Cps, Cur: s.Fx.Cur, Blink: s.Fx.Blink}
		if s.Fx.Cps <= 0 {
			s.Fx.Cps = subsFxCps
		}
		s.Fx.Cps = min(max(s.Fx.Cps, 1), 100)
		if !subsHex.MatchString(s.Fx.Cur) {
			s.Fx.Cur = ""
		}
	case "word":
		s.Fx = SubFx{K: "word", Dur: s.Fx.Dur, Bounce: min(max(s.Fx.Bounce, 0), 0.3)}
		if s.Fx.Dur <= 0 {
			s.Fx.Dur = subsFxDur
		}
		s.Fx.Dur = min(max(s.Fx.Dur, 0.1), 0.6) // появление всегда быстрое
	case "kar":
		f := s.Fx
		s.Fx = SubFx{K: "kar", M: f.M, Pill: f.Pill, On: f.On, R: min(max(f.R, 0), 1), Smooth: f.Smooth}
		if !slices.Contains([]string{"grow", "jump", "fill"}, s.Fx.M) {
			s.Fx.M = "jump"
		}
		s.Fx.Smooth = s.Fx.Smooth && s.Fx.M != "jump"
		if !subsHex.MatchString(s.Fx.Pill) {
			s.Fx.Pill = subsKarPillC
		}
		if !subsHex.MatchString(s.Fx.On) {
			s.Fx.On = subsKarOnC
		}
	case "act":
		f := s.Fx
		s.Fx = SubFx{K: "act", Hi: f.Hi, Big: min(max(f.Big, 0), 0.3), Keep: f.Keep, Soft: f.Soft}
		if !subsHex.MatchString(s.Fx.Hi) {
			s.Fx.Hi = subsActHiC
		}
	default:
		s.Fx = SubFx{}
	}
	return s
}

func subsAssClock(v float64) string {
	cs := int(v*100 + 0.5)
	return fmt.Sprintf("%d:%02d:%02d.%02d", cs/360000, cs/6000%60, cs/100%60, cs%100)
}

// subsASS: файл для вжигания. Размеры в пикселях кадра (PlayRes). Encoding -1: направление письма по самой строке, иначе у арабского уедет знак в конце.
func subsASS(cues []SubCue, s Subs, w, h int) string {
	align := 2
	switch s.Pos {
	case "center":
		align = 5
	case "top":
		align = 8
	}
	size := s.Size * float64(h)
	marginV := int(subsMargin*float64(h) + 0.5)
	if s.Y > 0 {
		align, marginV = 2, int((1-s.Y)*float64(h)+0.5)
	}
	marginL, marginR := int((s.X-s.W/2)*float64(w)+0.5), int((1-s.X-s.W/2)*float64(w)+0.5)
	border, outlineCol, outline := 1, "&H00000000", size*subsOutline
	if s.Back != "" {
		border, outlineCol, outline = 3, subsAssColor(s.Back, s.BackA), size*subsOutline*2
	}
	var sb strings.Builder
	fmt.Fprintf(&sb, "[Script Info]\nScriptType: v4.00+\nPlayResX: %d\nPlayResY: %d\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n", w, h)
	sb.WriteString("[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n")
	col := subsAssColor(s.Color, 1)
	fmt.Fprintf(&sb, "Style: Default,%s,%.2f,%s,%s,%s,&H00000000,0,0,0,0,100,100,0,0,%d,%.2f,0,%d,%d,%d,%d,-1\n\n",
		s.Font, size, col, col, outlineCol, border, outline, align, marginL, marginR, marginV)
	sb.WriteString("[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n")
	esc := strings.NewReplacer("\n", `\N`, "{", `\{`, "}", `\}`)
	place := "" // у рамки своей высоты текст по её центру; ширину переноса задают те же поля MarginL и MarginR
	if s.H > 0 {
		place = fmt.Sprintf(`{\an5\pos(%.1f,%.1f)}`, s.X*float64(w), (s.Y-s.H/2)*float64(h))
	}
	for _, c := range cues {
		text := c.Text
		if s.Join {
			text = subsBreak.ReplaceAllString(text, " ")
		}
		if s.Fx.K == "type" && c.End > c.Start {
			sb.WriteString(subsFxType(c, text, s, h, place, esc))
			continue
		}
		if s.Fx.K == "word" && c.End > c.Start {
			sb.WriteString(subsFxWord(c, text, s, h, place, esc))
			continue
		}
		if s.Fx.K == "kar" && c.End > c.Start {
			sb.WriteString(subsFxKar(c, text, s, w, h, place, esc))
			continue
		}
		if s.Fx.K == "act" && c.End > c.Start {
			sb.WriteString(subsFxAct(c, text, s, w, h, place, esc))
			continue
		}
		fmt.Fprintf(&sb, "Dialogue: 0,%s,%s,Default,,0,0,0,,%s%s\n", subsAssClock(c.Start), subsAssClock(c.End), place, esc.Replace(text))
	}
	return sb.String()
}

func subsSRT(cues []SubCue) string {
	clock := func(v float64) string {
		ms := int(v*1000 + 0.5)
		return fmt.Sprintf("%02d:%02d:%02d,%03d", ms/3600000, ms/60000%60, ms/1000%60, ms%1000)
	}
	var sb strings.Builder
	for i, c := range cues {
		fmt.Fprintf(&sb, "%d\n%s --> %s\n%s\n\n", i+1, clock(c.Start), clock(c.End), c.Text)
	}
	return sb.String()
}

func subsDir() string { return filepath.Join(cacheDir(), "subs") }

// saveTextPNG: картинка клипа «Текст». Имя по содержимому: одинаковый текст даёт один файл. Настоящие данные лежат в проекте, страница рисует заново при открытии.
// fresh: файла не было. Если страница уже пробовала его показать, ей надо загрузить его снова. Дата файла отмечает последнее использование (textPrune).
func saveTextPNG(b64 string) (path string, fresh bool, err error) {
	b, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return "", false, err
	}
	if !bytes.HasPrefix(b, []byte("\x89PNG\r\n\x1a\n")) {
		return "", false, errors.New("not a PNG")
	}
	dir := textDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", false, err
	}
	sum := sha256.Sum256(b)
	p := filepath.Join(dir, hex.EncodeToString(sum[:12])+".png")
	if fileExists(p) {
		now := time.Now()
		os.Chtimes(p, now, now)
		return p, false, nil
	}
	tmp, err := os.CreateTemp(dir, "*.part")
	if err != nil {
		return "", false, err
	}
	_, err = tmp.Write(b)
	if e := tmp.Close(); err == nil {
		err = e
	}
	if err == nil {
		err = os.Rename(tmp.Name(), p)
	}
	if err != nil {
		os.Remove(tmp.Name())
		return "", false, err
	}
	return p, true, nil
}

// subsTemp: у каждого запуска свой файл, их убирает следующий запуск программы и её закрытие (startServer, stopAll)
func subsTemp(ext, text string) (string, error) {
	dir := subsDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	f, err := os.CreateTemp(dir, "*"+ext)
	if err != nil {
		return "", err
	}
	_, err = f.WriteString(text)
	if e := f.Close(); err == nil {
		err = e
	}
	if err != nil {
		os.Remove(f.Name())
		return "", err
	}
	return f.Name(), nil
}

// subsFilterPath: путь как значение параметра фильтра внутри графа. Экранирование двойное: для параметра и для самого графа.
func subsFilterPath(p string) string {
	p = strings.NewReplacer(`\`, `\\`, `'`, `\'`, `:`, `\:`).Replace(filepath.ToSlash(p))
	return strings.NewReplacer(`\`, `\\`, `'`, `\'`, `[`, `\[`, `]`, `\]`, `,`, `\,`, `;`, `\;`).Replace(p)
}

// subsTrackCodec: чем записать дорожку в этот контейнер; пусто, если такой дорожки в нём быть не может
func subsTrackCodec(f Format) string {
	if f.Kind == "gif" || f.Kind == "anim" {
		return ""
	}
	switch strings.ToLower(f.Ext) {
	case "mp4", "m4v", "mov":
		return "mov_text"
	case "mkv":
		return "srt"
	case "webm":
		return "webvtt"
	}
	return ""
}

// subsPlan дополняет готовый план монтажа субтитрами. inputs — сколько входов уже занято.
// Реплик между метками нет: результат просто без субтитров.
func subsPlan(si *srcInfo, sub Subs, f Format, offset float64, inputs int) error {
	sub = sub.fit()
	track, burn := sub.Mode == subsModeTrk || sub.Mode == subsModeBoth, sub.Mode != subsModeTrk
	if track && subsTrackCodec(f) == "" {
		return errT("mont.subsTrack")
	}
	all := sub.Cues
	if all == nil {
		var err error
		if all, err = subsRead(sub.Path); err != nil {
			return err
		}
	}
	cues := subsChunks(subsRange(all, offset, si.dur), sub.Chunk) // куски и для дорожки в файле: там они так же сменяются
	if len(cues) == 0 {
		return nil
	}
	if track {
		name, err := subsTemp(".srt", subsSRT(cues))
		if err != nil {
			return err
		}
		si.inputs = append(si.inputs, "-i", name)
		// default: без этой отметки многие плееры дорожку не включают, и кажется, что её нет
		si.subsMap = []string{"-map", fmt.Sprintf("%d:0", inputs), "-c:s", subsTrackCodec(f), "-disposition:s:0", "default"}
	}
	if !burn {
		return nil
	}
	name, err := subsTemp(".ass", subsASS(cues, sub, si.w, si.h))
	if err != nil {
		return err
	}
	if !strings.Contains(si.graph, "[v]") {
		return errors.New("subs: no video output")
	}
	// [v] в графе всего один: это конец видео. Метка меняется на промежуточную, субтитры встают последним шагом.
	si.graph = strings.Replace(si.graph, "[v]", "[vb]", 1) + ";[vb]ass=filename=" + subsFilterPath(name) + "[v]"
	return nil
}

// textWidthGuess: ширина строки без шрифта — средняя буква в половину высоты строки
func textWidthGuess(px float64, s string) float64 {
	return 0.5 * px * float64(utf8.RuneCountInString(s))
}
