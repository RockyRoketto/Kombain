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
	X  []Key `json:"x,omitempty"`  // середина рамки по горизонтали, доли кадра
	Y  []Key `json:"y,omitempty"`  // по вертикали
	W  []Key `json:"w,omitempty"`  // ширина рамки, доли кадра; высота меняется в той же пропорции, что у рамки клипа
	R  []Key `json:"r,omitempty"`  // поворот, градусы по часовой
	O  []Key `json:"o,omitempty"`  // непрозрачность слоя, 0…1 (tlOpChain)
	V  []Key `json:"v,omitempty"`  // громкость клипа, 0…tlMaxVol; считает звуковая цепочка (tlAudioGraph), вместо Clip.Vol
	B  []Key `json:"b,omitempty"`  // размытие, доли высоты кадра, 0…tlMaxBlur (tlFxChain)
	SA []Key `json:"sa,omitempty"` // тень: непрозрачность 0…1, смещение по горизонтали и вертикали (доли высоты кадра, −1…1), мягкость (0…tlMaxBlur)
	SX []Key `json:"sx,omitempty"`
	SY []Key `json:"sy,omitempty"`
	SB []Key `json:"sb,omitempty"`
	GB []Key `json:"gb,omitempty"` // цветокоррекция, как поля ColBri…ColTint, −1…1: яркость, контраст, средние тона, насыщенность, температура, оттенок (tlGradeChain)
	GC []Key `json:"gc,omitempty"`
	GM []Key `json:"gm,omitempty"`
	GS []Key `json:"gs,omitempty"`
	GT []Key `json:"gt,omitempty"`
	GN []Key `json:"gn,omitempty"`
	KL []Key `json:"kl,omitempty"` // кадрирование: левая, правая, верхняя, нижняя стороны, доли слоя 0…tlMaxCrop; считает kfPrep полосами drawbox
	KR []Key `json:"kr,omitempty"`
	KT []Key `json:"kt,omitempty"`
	KB []Key `json:"kb,omitempty"`
}

const kfMax = 500 // ключей у одного свойства

// kfEases: кривые: in — разгон, out — торможение, inout — то и другое, bounce — отскок в конце
var kfEases = map[string]bool{"": true, "in": true, "out": true, "inout": true, "bounce": true}

func (k *Keys) any() bool {
	return k.moves() || (k != nil && len(k.O)+len(k.V)+len(k.B)+len(k.SA)+len(k.SX)+len(k.SY)+len(k.SB)+len(k.GB)+len(k.GC)+len(k.GM)+len(k.GS)+len(k.GT)+len(k.GN)+len(k.KL)+len(k.KR)+len(k.KT)+len(k.KB) > 0)
}

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
	k.V = clean(k.V, 0, tlMaxVol)
	k.B = clean(k.B, 0, tlMaxBlur)
	k.SA, k.SB = clean(k.SA, 0, 1), clean(k.SB, 0, tlMaxBlur)
	k.SX, k.SY = clean(k.SX, -1, 1), clean(k.SY, -1, 1)
	k.GB, k.GC, k.GM = clean(k.GB, -1, 1), clean(k.GC, -1, 1), clean(k.GM, -1, 1)
	k.GS, k.GT, k.GN = clean(k.GS, -1, 1), clean(k.GT, -1, 1), clean(k.GN, -1, 1)
	k.KL, k.KR, k.KT, k.KB = clean(k.KL, 0, tlMaxCrop), clean(k.KR, 0, tlMaxCrop), clean(k.KT, 0, tlMaxCrop), clean(k.KB, 0, tlMaxCrop)
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
// Ключи кадрирования: слой целиком на холсте, а срезанное закрашивают четыре полосы drawbox (kfCropBars).
func kfPrep(tc tlClip, c Clip, w, h int, fps float64, bg string) ([]string, kfLayer) {
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
	chain := []string{fmt.Sprintf("scale=%d:%d", L.lw, L.lh)}
	if c.Keys.cropKeyed() {
		chain = append(chain, fmt.Sprintf("pad=%d:%d:%d:%d:color=%s", L.pw, L.ph, L.m, L.m, bg))
		return append(chain, kfCropBars(tc, c, L, fps, bg)...), L
	}
	cl, ct := even(c.CropL*float64(L.lw)), even(c.CropT*float64(L.lh))
	sw, sh := max(even((1-c.CropL-c.CropR)*float64(L.lw)), 2), max(even((1-c.CropT-c.CropB)*float64(L.lh)), 2)
	sw, sh = min(sw, L.lw-cl), min(sh, L.lh-ct)
	if sw != L.lw || sh != L.lh {
		chain = append(chain, fmt.Sprintf("crop=%d:%d:%d:%d", sw, sh, cl, ct))
	}
	// края холста — фон: perspective за пределами картинки повторяет крайние точки
	return append(chain, fmt.Sprintf("pad=%d:%d:%d:%d:color=%s", L.pw, L.ph, L.m+cl, L.m+ct, bg)), L
}

// fileSecond: секунда файла у кадра, который стоит в цепочке клипа до скорости и реверса на t секунд от первого кадра.
// -ss ставит начало на метку клипа; у картинки время идёт от начала клипа с поправкой на метку начала вывода.
func (c tlClip) fileSecond(t, fps float64) float64 {
	if c.photo {
		return t + float64(c.head)/fps
	}
	return c.from + t
}

// kfCropBars: кадрирование по ключам. Каждая сторона — полоса drawbox фоновым цветом поверх слоя на холсте, её размеры sendcmd
// меняет по сетке времени файла (двух кадров, не больше 300 обновлений на клип). Значения берутся тем же kfAt, что и просмотр.
// Пара противоположных сторон вместе не съедает больше tlMaxCrop слоя. Полоса нулевого размера уходит за край холста:
// ширина 0 у drawbox означает «во весь кадр».
func kfCropBars(tc tlClip, c Clip, L kfLayer, fps float64, bg string) []string {
	k := c.Keys
	lists := [4][]Key{k.KL, k.KR, k.KT, k.KB}
	stat := [4]float64{c.CropL, c.CropR, c.CropT, c.CropB}
	// доли сторон в секунду t
	sides := func(t float64) [4]float64 {
		var v [4]float64
		s := tc.fileSecond(t, fps)
		for i := range v {
			v[i] = stat[i]
			if len(lists[i]) > 0 {
				v[i] = kfAt(lists[i], s)
			}
			v[i] = min(max(v[i], 0), tlMaxCrop)
		}
		v[1] = min(v[1], tlMaxCrop-v[0])
		v[3] = min(v[3], tlMaxCrop-v[2])
		return v
	}
	// геометрия полос: x, y, w, h в точках холста
	geo := func(v [4]float64) [4][4]int {
		l, r := int(math.Round(v[0]*float64(L.lw))), int(math.Round(v[1]*float64(L.lw)))
		t, b := int(math.Round(v[2]*float64(L.lh))), int(math.Round(v[3]*float64(L.lh)))
		out := [4][4]int{
			{L.m, L.m, l, L.lh}, {L.m + L.lw - r, L.m, r, L.lh},
			{L.m, L.m, L.lw, t}, {L.m, L.m + L.lh - b, L.lw, b},
		}
		for i := range out {
			if out[i][2] <= 0 || out[i][3] <= 0 {
				out[i] = [4]int{-8, -8, 1, 1}
			}
		}
		return out
	}
	name := func(i int) string { return fmt.Sprintf("drawbox@k%d%d", tc.input, i) }
	var cmds strings.Builder
	last := geo(sides(0))
	step := max(2/fps, tc.cut/300)
	for t := step; t < tc.cut+step; t += step {
		now := geo(sides(t))
		var parts []string
		for i := range now {
			for j, p := range []string{"x", "y", "w", "h"} {
				if now[i][j] != last[i][j] {
					parts = append(parts, fmt.Sprintf("%s %s %d", name(i), p, now[i][j]))
				}
			}
		}
		last = now
		if len(parts) > 0 {
			fmt.Fprintf(&cmds, "%s %s;", kfNum(max(t-step/2, 0.0001)), strings.Join(parts, ","))
		}
	}
	chain := []string{"setpts=PTS-STARTPTS"}
	if cmds.Len() > 0 {
		chain = append(chain, "sendcmd=c='"+cmds.String()+"'")
	}
	for i, g := range geo(sides(0)) {
		chain = append(chain, fmt.Sprintf("%s=x=%d:y=%d:w=%d:h=%d:color=%s:t=fill:replace=1", name(i), g[0], g[1], g[2], g[3], bg))
	}
	return chain
}

// cropKeyed: есть ключи кадрирования
func (k *Keys) cropKeyed() bool { return k != nil && len(k.KL)+len(k.KR)+len(k.KT)+len(k.KB) > 0 }

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

// tlVolKeys: громкость по ключам. Выражение volume считается на каждый кусок звука (eval=frame): куски по 1024 отсчёта,
// около 21 мс, этого хватает для плавных кривых, ступеньки не слышны. t — метка куска от начала звука клипа (до финальной
// задержки на место клипа), в кадрах монтажа плюс начало клипа с учётом метки начала вывода и запаса перехода, как у tlOpChain.
func tlVolKeys(c tlClip, fps float64) []string {
	T := fmt.Sprintf("(t*%s+%d)", kfNum(fps), c.head-c.tin.ext())
	expr := strings.ReplaceAll(kfExpr(c.kfTrack(c.Keys.V), fps, T), ",", `\,`)
	return []string{"asetnsamples=n=1024:p=0", "volume=" + expr + ":eval=frame:precision=float"}
}

// fxKeyed: есть ключи размытия или тени. Такие эффекты считаются после выбора кадров клипа (tlClipChain)
func (k *Keys) fxKeyed() bool {
	return k != nil && len(k.B)+len(k.SA)+len(k.SX)+len(k.SY)+len(k.SB)+len(k.GB)+len(k.GC)+len(k.GM)+len(k.GS)+len(k.GT)+len(k.GN)+len(k.KL)+len(k.KR)+len(k.KT)+len(k.KB) > 0
}

// blur: ключи размытия, у пустого Keys их нет
func (k *Keys) blur() []Key {
	if k == nil {
		return nil
	}
	return k.B
}

// ключи тени, у пустого Keys их нет
func (k *Keys) shadowA() []Key { return k.pick(func(k *Keys) []Key { return k.SA }) }
func (k *Keys) shadowX() []Key { return k.pick(func(k *Keys) []Key { return k.SX }) }
func (k *Keys) shadowY() []Key { return k.pick(func(k *Keys) []Key { return k.SY }) }
func (k *Keys) shadowB() []Key { return k.pick(func(k *Keys) []Key { return k.SB }) }
func (k *Keys) pick(f func(*Keys) []Key) []Key {
	if k == nil {
		return nil
	}
	return f(k)
}

// gradeKeyed: есть ключи цветокоррекции
func (k *Keys) gradeKeyed() bool {
	return k != nil && len(k.GB)+len(k.GC)+len(k.GM)+len(k.GS)+len(k.GT)+len(k.GN)+len(k.KL)+len(k.KR)+len(k.KT)+len(k.KB) > 0
}

// pickG: ключи i-й цветовой настройки: 0 яркость, 1 контраст, 2 средние тона, 3 насыщенность, 4 температура, 5 оттенок
func (k *Keys) pickG(i int) []Key {
	if k == nil {
		return nil
	}
	return [][]Key{k.GB, k.GC, k.GM, k.GS, k.GT, k.GN}[i]
}
