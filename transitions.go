package main

import "fmt"

// Переходы на краю клипа. Переход лежит в поле TrIn клипа (из соседа слева) и TrOut (в пустоту справа).
// Если слева вплотную стоит клип той же дорожки, TrIn — переход между ними: он стоит по центру стыка и берёт
// кадры файлов за краями клипов. Где их нет, недостающее заполняет стоп-кадр, длина монтажа не меняется.
// TrOut у клипа, за которым вплотную идёт другой, не действует: стык решает TrIn правого.
// Если соседа нет, переход идёт внутри клипа: появление из пустоты или уход в неё (чёрное у нижней дорожки, прозрачное выше).
// Картинка смешивается фильтром xfade, звук плавно перетекает (afade с кривой qsin: сумма мощности постоянна).

type Trans struct {
	Kind string  `json:"k"` // вид: значение transition у xfade, см. tlTransKinds
	Dur  float64 `json:"d"` // длительность, секунды на дорожке
}

const tlMaxTrans = 10.0 // секунд

// tlTransKinds: виды, которые просмотр умеет повторить в браузере. Значение идёт в граф ffmpeg, поэтому только из списка.
var tlTransKinds = map[string]bool{
	"fade": true, "fadeblack": true, "fadewhite": true,
	"wipeleft": true, "wiperight": true, "wipeup": true, "wipedown": true,
	"slideleft": true, "slideright": true, "slideup": true, "slidedown": true,
	"circleopen": true, "circleclose": true, "zoomin": true,
}

// fit: переход с неверным видом или длиной пропадает
func (t *Trans) fit() *Trans {
	if t == nil || !tlTransKinds[t.Kind] || !(t.Dur > 0) {
		return nil
	}
	t.Dur = min(t.Dur, tlMaxTrans)
	return t
}

// tlEdge: переход на одном краю клипа, уже в кадрах
type tlEdge struct {
	kind string
	n    int  // у стыка — половина перехода: столько кадров за краем и столько же до него; у свободного края — весь переход
	cut  bool // стык с соседом
}

// ext: сколько кадров клип показывает за своим краем
func (e tlEdge) ext() int {
	if e.cut {
		return e.n
	}
	return 0
}

// span: сколько кадров собранного клипа занимает переход
func (e tlEdge) span() int {
	if e.cut {
		return 2 * e.n
	}
	return e.n
}

// tlMeet: стоят ли клипы вплотную так, что между ними возможен переход. Картинка с картинкой одного режима наложения
// (клипы с разными режимами собираются в разных слоях), звук со звуком.
func tlMeet(a, b tlClip) bool {
	if a.end != b.start {
		return false
	}
	if a.si.video || b.si.video {
		return a.si.video && b.si.video && a.Blend == b.Blend
	}
	return true
}

// tlTransitions раскладывает переходы по краям клипов и берёт для стыков кусок файла за краем. Вызывать после tlRange:
// метки вывода уже срезали клипы. Свободный край, срезанный меткой, остаётся без перехода.
func tlTransitions(tracks [][]tlClip, fps float64) {
	frames := func(s float64) int { return int(s*fps + 0.5) }
	for _, list := range tracks {
		for i := range list {
			c := &list[i]
			prev := i > 0 && tlMeet(list[i-1], *c)
			next := i+1 < len(list) && tlMeet(*c, list[i+1])
			if t := c.TrIn; t != nil {
				if prev {
					c.tin = tlEdge{t.Kind, frames(t.Dur / 2), true}
				} else if c.head == 0 {
					c.tin = tlEdge{kind: t.Kind, n: frames(t.Dur)}
				}
			}
			if t := c.TrOut; t != nil && !next && c.head+c.frames() == c.whole {
				c.tout = tlEdge{kind: t.Kind, n: frames(t.Dur)}
			}
			if i > 0 && c.tin.cut {
				list[i-1].tout = c.tin
			}
		}
		// переходы клипа не заходят друг на друга: оба края вместе не больше самого клипа
		for i := range list {
			c := &list[i]
			if a, b := c.tin.n, c.tout.n; a+b > c.frames() {
				c.tin.n, c.tout.n = a*c.frames()/(a+b), b*c.frames()/(a+b)
			}
		}
		// у стыка половина одна на двоих
		for i := 1; i < len(list); i++ {
			if c := &list[i]; c.tin.cut {
				n := min(c.tin.n, list[i-1].tout.n)
				c.tin.n, list[i-1].tout.n = n, n
			}
		}
		for i := range list {
			c := &list[i]
			if c.tin.n <= 0 {
				c.tin = tlEdge{}
			}
			if c.tout.n <= 0 {
				c.tout = tlEdge{}
			}
			c.extend(fps)
		}
	}
}

// extend: клип читает файл дальше своих краёв на длину стыков. Сколько в файле нет, добирает стоп-кадр:
// в конце его даёт tpad в tlClipChain, в начале — поле pad. У фото кадр один и тот же, его хватает всегда.
func (c *tlClip) extend(fps float64) {
	if n := c.tin.ext(); n > 0 {
		take := float64(n) / fps * c.Speed
		if !c.photo {
			avail := c.from // в начале клипа: что в файле раньше куска, у реверса — что позже
			if c.Reverse {
				avail = c.si.dur - c.from - c.cut
			}
			take = min(take, max(avail, 0))
			if !c.Reverse {
				c.from -= take
			}
		}
		c.cut += take
		c.pad = max(n-int(take/c.Speed*fps+0.5), 0)
	}
	if n := c.tout.ext(); n > 0 {
		take := float64(n) / fps * c.Speed
		if !c.photo {
			avail := c.si.dur - c.from - c.cut
			if c.Reverse {
				avail = c.from
			}
			take = min(take, max(avail, 0))
			if c.Reverse {
				c.from -= take
			}
		}
		c.cut += take
	}
	if c.photo {
		c.si.dur = c.cut
	}
}

// shown: сколько кадров даёт собранный клип вместе с кусками за краями
func (c tlClip) shown() int { return c.frames() + c.tin.ext() + c.tout.ext() }

// tlTransFades: звук клипа плавно входит и уходит на краях с переходом. На стыке громкости двух клипов в сумме
// дают постоянную мощность. Звук берётся из файла, а где файла не хватило (pad), в начале тишина.
func tlTransFades(c tlClip, fps float64) []string {
	var chain []string
	n := c.shown()
	if d := c.tin.span(); d > 0 {
		chain = append(chain, fmt.Sprintf("afade=t=in:st=0:d=%s:curve=qsin", secs(float64(d)/fps)))
	}
	if d := c.tout.span(); d > 0 {
		chain = append(chain, fmt.Sprintf("afade=t=out:st=%s:d=%s:curve=qsin", secs(float64(n-d)/fps), secs(float64(d)/fps)))
	}
	return chain
}
