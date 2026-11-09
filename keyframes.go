package main

// Ключевые кадры рамки слоя: середина, ширина и поворот меняются со временем по кривым.
// Те же формулы в просмотре: web/js/keyframes.js (kfEase, kfAt). Проверка: keyframes_test.go.
//
// Слой с ключами собирается иначе, чем неподвижный (tlBoxChain): один раз сжимается до самой большой своей рамки
// и ложится на холст с запасом по краям (kfPrep), а на каждом кадре фильтр perspective ставит углы холста на место (kfPlace).

import (
	"cmp"
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"
)

type Key struct {
	S float64 `json:"s"`           // секунда файла, у фото от начала клипа: ключ держится за кадр, как метка клипа
	V float64 `json:"v"`           // значение
	E string  `json:"e,omitempty"` // кривая до следующего ключа, см. kfEases; пусто — прямая
}

type Keys struct {
	X []Key `json:"x,omitempty"` // середина рамки по горизонтали, доли кадра
	Y []Key `json:"y,omitempty"` // по вертикали
	W []Key `json:"w,omitempty"` // ширина рамки, доли кадра; высота меняется в той же пропорции, что у рамки клипа
	R []Key `json:"r,omitempty"` // поворот, градусы по часовой
	O []Key `json:"o,omitempty"` // непрозрачность слоя, 0…1 (tlOpChain)
}

const kfMax = 500 // ключей у одного свойства

// kfEases: кривые: in — разгон, out — торможение, inout — то и другое, bounce — отскок в конце
var kfEases = map[string]bool{"": true, "in": true, "out": true, "inout": true, "bounce": true}

func (k *Keys) any() bool { return k.moves() || (k != nil && len(k.O) > 0) }

// moves: есть ключи рамки. Ключи одной прозрачности слой не двигают, собирать его через perspective незачем
func (k *Keys) moves() bool { return k != nil && len(k.X)+len(k.Y)+len(k.W)+len(k.R) > 0 }

// fit: значения из интерфейса в допустимые пределы, по порядку времени, без двух ключей на одном месте
func (k *Keys) fit() {
	clean := func(list []Key, lo, hi float64) []Key {
		var out []Key
		for _, x := range list {
			if math.IsNaN(x.S) || math.IsInf(x.S, 0) || math.IsNaN(x.V) || math.IsInf(x.V, 0) || x.S < 0 {
				continue
			}
			if !kfEases[x.E] { // значение идёт в граф ffmpeg, поэтому только из списка
				x.E = ""
			}
			x.V = min(max(x.V, lo), hi)
			out = append(out, x)
		}
		slices.SortStableFunc(out, func(a, b Key) int { return cmp.Compare(a.S, b.S) })
		out = slices.CompactFunc(out, func(a, b Key) bool { return math.Abs(a.S-b.S) < 1e-4 })
		return out[:min(len(out), kfMax)]
	}
	far := tlFarOut + tlMaxBox/2 // середина рамки уходит за кадр не дальше, чем позволяет tlFarOut
	k.X, k.Y = clean(k.X, -far, 1+far), clean(k.Y, -far, 1+far)
	k.W = clean(k.W, 0.002, tlMaxBox)
	k.R = clean(k.R, -36000, 36000)
	k.O = clean(k.O, 0, 1)
}

// kfTrack: ключи по времени клипа на дорожке, секунды от его начала. Скорость и реверс клипа тянут ключи за собой.
func (c tlClip) kfTrack(list []Key) []Key {
	n := c.Len
	if n <= 0 {
		n = c.srcLen()
	}
	out := make([]Key, 0, len(list))
	for _, k := range list {
		s := k.S - c.From
		if c.Reverse {
			s = c.From + n - k.S
		}
		k.S = s / c.Speed
		out = append(out, k)
	}
	slices.SortStableFunc(out, func(a, b Key) int { return cmp.Compare(a.S, b.S) })
	return out
}

// kfEase и kfAt: те же кривые числом, для проверки графа и как образец для web/js/keyframes.js
func kfEase(e string, p float64) float64 {
	switch e {
	case "in":
		return p * p * p
	case "out":
		return 1 - math.Pow(1-p, 3)
	case "inout":
		if p < 0.5 {
			return 4 * p * p * p
		}
		return 1 - math.Pow(2-2*p, 3)/2
	case "bounce":
		const n, d = 7.5625, 2.75
		switch {
		case p < 1/d:
			return n * p * p
		case p < 2/d:
			return n*math.Pow(p-1.5/d, 2) + 0.75
		case p < 2.5/d:
			return n*math.Pow(p-2.25/d, 2) + 0.9375
		}
		return n*math.Pow(p-2.625/d, 2) + 0.984375
	}
	return p
}

// kfAt: значение в секунду t по ключам на времени дорожки
func kfAt(list []Key, t float64) float64 {
	for i := 0; i+1 < len(list); i++ {
		a, b := list[i], list[i+1]
		if t < b.S && b.S > a.S {
			return a.V + (b.V-a.V)*kfEase(a.E, min(max((t-a.S)/(b.S-a.S), 0), 1))
		}
	}
	return list[len(list)-1].V
}

func kfNum(v float64) string { return strconv.FormatFloat(v, 'g', 10, 64) }

// kfEaseExpr: кривая от 0 до 1 на отрезке, p — доля отрезка, выражением ffmpeg
func kfEaseExpr(e, p string) string {
	switch e {
	case "in":
		return fmt.Sprintf("pow(%s,3)", p)
	case "out":
		return fmt.Sprintf("(1-pow(1-%s,3))", p)
	case "inout":
		return fmt.Sprintf("if(lt(%[1]s,0.5),4*pow(%[1]s,3),1-pow(2-2*%[1]s,3)/2)", p)
	case "bounce": // как easeOutBounce: три отскока, каждый ниже предыдущего
		const n, d = 7.5625, 2.75
		return fmt.Sprintf("if(lt(%[1]s,%[2]s),%[6]s*%[1]s*%[1]s,if(lt(%[1]s,%[3]s),%[6]s*pow(%[1]s-%[7]s,2)+0.75,if(lt(%[1]s,%[4]s),%[6]s*pow(%[1]s-%[8]s,2)+0.9375,%[6]s*pow(%[1]s-%[5]s,2)+0.984375)))",
			p, kfNum(1/d), kfNum(2/d), kfNum(2.5/d), kfNum(2.625/d), kfNum(n), kfNum(1.5/d), kfNum(2.25/d))
	}
	return p
}

// kfExpr: значение свойства выражением ffmpeg от T, номера кадра клипа. Ключи по времени дорожки (kfTrack).
// До первого ключа держится его значение, после последнего — значение последнего.
func kfExpr(list []Key, fps float64, T string) string {
	expr := kfNum(list[len(list)-1].V)
	for i := len(list) - 2; i >= 0; i-- {
		a, b := list[i], list[i+1]
		d := (b.S - a.S) * fps
		if d <= 1e-9 {
			continue
		}
		p := fmt.Sprintf("clip((%s-%s)/%s,0,1)", T, kfNum(a.S*fps), kfNum(d))
		seg := fmt.Sprintf("%s+%s*%s", kfNum(a.V), kfNum(b.V-a.V), kfEaseExpr(a.E, p))
		expr = fmt.Sprintf("if(lt(%s,%s),%s,%s)", T, kfNum(b.S*fps), seg, expr)
	}
	return expr
}

// kfLayer: размеры слоя на холсте: сам слой lw×lh с отступом m, холст pw×ph не меньше кадра
type kfLayer struct{ lw, lh, pw, ph, m int }

// kfPrep: слой с ключами до времени клипа: размер самой большой рамки, кадрирование, холст с запасом.
// Срезанное кадрированием становится фоном, рамка при этом не меняется, как в tlBoxChain.
func kfPrep(c Clip, w, h int, bg string) ([]string, kfLayer) {
	even := func(v float64) int { return int(math.Round(v/2)) * 2 }
	big := c.W
	if len(c.Keys.W) > 0 {
		big = 0
		for _, k := range c.Keys.W {
			big = max(big, k.V)
		}
	}
	L := kfLayer{lw: max(even(big*float64(w)), 2), lh: max(even(big*c.H/c.W*float64(h)), 2), m: 2}
	L.pw, L.ph = max(w, L.lw+2*L.m), max(h, L.lh+2*L.m)
	cl, ct := even(c.CropL*float64(L.lw)), even(c.CropT*float64(L.lh))
	sw, sh := max(even((1-c.CropL-c.CropR)*float64(L.lw)), 2), max(even((1-c.CropT-c.CropB)*float64(L.lh)), 2)
	sw, sh = min(sw, L.lw-cl), min(sh, L.lh-ct)
	chain := []string{fmt.Sprintf("scale=%d:%d", L.lw, L.lh)}
	if sw != L.lw || sh != L.lh {
		chain = append(chain, fmt.Sprintf("crop=%d:%d:%d:%d", sw, sh, cl, ct))
	}
	// края холста — фон: perspective за пределами картинки повторяет крайние точки
	return append(chain, fmt.Sprintf("pad=%d:%d:%d:%d:color=%s", L.pw, L.ph, L.m+cl, L.m+ct, bg)), L
}

// kfPlace: слой с ключами после времени клипа: углы холста на своё место в каждом кадре, потом кадр нужного размера.
// Порядок как в просмотре (mvPlace): размер вокруг середины рамки, поворот вокруг неё же, место на кадре.
func kfPlace(c tlClip, L kfLayer, w, h int, fps float64) []string {
	T := fmt.Sprintf("(in+%d)", c.head-1) // in у perspective считает кадры с единицы
	prop := func(list []Key, static float64) string {
		if len(list) == 0 {
			return kfNum(static)
		}
		return "(" + kfExpr(c.kfTrack(list), fps, T) + ")"
	}
	k := c.Keys
	cx, cy := prop(k.X, c.X+c.W/2), prop(k.Y, c.Y+c.H/2)
	bw, rot := prop(k.W, c.W), prop(k.R, c.Rot)
	kx := fmt.Sprintf("%s*%s", bw, kfNum(float64(w)/float64(L.lw)))         // точек кадра на точку слоя
	ky := fmt.Sprintf("%s*%s", bw, kfNum(c.H/c.W*float64(h)/float64(L.lh))) // по вертикали
	a := fmt.Sprintf("(%s)*%s", rot, kfNum(math.Pi/180))
	var opts []string
	for i, sy := range []int{0, L.ph} {
		for j, sx := range []int{0, L.pw} {
			ax, ay := kfNum(float64(sx-L.m)-float64(L.lw)/2), kfNum(float64(sy-L.m)-float64(L.lh)/2)
			x := fmt.Sprintf("%s*%d+%s*%s*cos(%s)-%s*%s*sin(%s)", cx, w, kx, ax, a, ky, ay, a)
			y := fmt.Sprintf("%s*%d+%s*%s*sin(%s)+%s*%s*cos(%s)", cy, h, kx, ax, a, ky, ay, a)
			n := i*2 + j
			opts = append(opts, fmt.Sprintf("x%d=%s:y%d=%s", n, x, n, y))
		}
	}
	// запятые внутри выражений экранированы для графа ffmpeg
	expr := strings.ReplaceAll(strings.Join(opts, ":"), ",", `\,`)
	return []string{"perspective=" + expr + ":sense=destination:eval=frame", fmt.Sprintf("crop=%d:%d:0:0", w, h)}
}
