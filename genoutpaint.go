package main

// Дорисовка за краями (окно просмотра галереи, web/js/genoutpaint.js).
// Страница присылает, на сколько точек раздвинуть картинку с каждой стороны. Холст становится больше, новая полоса
// заливается размытым продолжением краёв (движку нужна начальная картинка, а резкая заливка дала бы полосы),
// маска — вся новая полоса. Дальше как у перерисовки части (geninpaint.go): вырезка вокруг полосы с запасом на
// окружение, движок рисует её, очередь вклеивает с мягким краем (genOutFeather); дальше от края исходная остаётся
// пиксель в пиксель.

import (
	"image"
	"image/draw"
	"math"

	xdraw "golang.org/x/image/draw"
)

// genOutpaintStrength: насколько менять начальную заливку новой полосы. Заливка — только размытые цвета краёв,
// сохранять в ней нечего; меньше 1 оставляет мутные пятна вместо предметов.
const genOutpaintStrength = 1.0

// genOutMaxSide: предел стороны готовой картинки (как у увеличения)
const genOutMaxSide = 8192

// genOutpaintPrep: ext — сколько точек добавить слева, сверху, справа, снизу. Каждая сторона не больше
// размера картинки по этой оси (холст вырастает максимум втрое).
func genOutpaintPrep(src []byte, ext []int, nw, nh int) (patch *genPatch, init, msk []byte, w, h int, err error) {
	orig, err := genDecodeNRGBA(src)
	if err != nil {
		return nil, nil, nil, 0, 0, err
	}
	W, H := orig.Rect.Dx(), orig.Rect.Dy()
	if len(ext) != 4 {
		return nil, nil, nil, 0, 0, errT("out.bad")
	}
	l, t, r, b := ext[0], ext[1], ext[2], ext[3]
	if min(l, t, r, b) < 0 || l > W || r > W || t > H || b > H || l+t+r+b == 0 {
		return nil, nil, nil, 0, 0, errT("out.bad")
	}
	W2, H2 := W+l+r, H+t+b
	if max(W2, H2) > genOutMaxSide {
		return nil, nil, nil, 0, 0, errT("out.big", genOutMaxSide)
	}
	canvas := genOutFill(orig, W2, H2, l, t)
	mg := image.NewGray(canvas.Rect)
	for i := range mg.Pix {
		mg.Pix[i] = 255
	}
	draw.Draw(mg, image.Rect(l, t, l+W, t+H), image.Black, image.Point{}, draw.Src)
	return genPatchPrep(canvas, mg, nw, nh, genOutFeather(W, H))
}

// genOutFeather: мягкий край дорисовки шире, чем у перерисовки части: по краю картинки новое часто другого
// цвета и света (тёмная скала, под ней светлая вода), узкий переход дал бы ровную черту. Движок перерисовывает
// полосу исходной шириной r, вклейка переходит на 2r (768 → 32 и 64 точки).
func genOutFeather(w, h int) int { return max(genFeather(w, h), min(w, h)/24) }

// genOutFill: холст W2×H2 с картинкой в (ox, oy); вокруг — продолжение краёв, которое с удалением от картинки
// уходит в её средний цвет, всё размыто. Считается на уменьшенной копии (до 96 точек), потом растягивается:
// так быстро и на 8192.
func genOutFill(orig *image.NRGBA, W2, H2, ox, oy int) *image.NRGBA {
	W, H := orig.Rect.Dx(), orig.Rect.Dy()
	k := math.Min(1, 96/float64(max(W2, H2)))
	rd := func(v int) int { return max(1, int(math.Round(float64(v)*k))) }
	sw, sh, ow, oh := rd(W2), rd(H2), rd(W), rd(H)
	sx, sy := min(int(math.Round(float64(ox)*k)), sw-ow), min(int(math.Round(float64(oy)*k)), sh-oh)
	so := image.NewNRGBA(image.Rect(0, 0, ow, oh))
	xdraw.ApproxBiLinear.Scale(so, so.Rect, orig, orig.Rect, draw.Src, nil)

	var mean [3]float32
	for i := 0; i < len(so.Pix); i += 4 {
		for c := 0; c < 3; c++ {
			mean[c] += float32(so.Pix[i+c])
		}
	}
	for c := range mean {
		mean[c] /= float32(ow * oh)
	}

	far := float32(max(ow, oh)) / 2 // на таком удалении от картинки — уже средний цвет
	var ch [3][]float32
	for c := range ch {
		ch[c] = make([]float32, sw*sh)
	}
	for y := 0; y < sh; y++ {
		cy := max(0, min(y-sy, oh-1))
		dy := max(sy-y, y-(sy+oh-1), 0)
		for x := 0; x < sw; x++ {
			cx := max(0, min(x-sx, ow-1))
			dx := max(sx-x, x-(sx+ow-1), 0)
			f := min(1, float32(max(dx, dy))/far)
			si := so.PixOffset(cx, cy)
			for c := 0; c < 3; c++ {
				ch[c][y*sw+x] = float32(so.Pix[si+c])*(1-f) + mean[c]*f
			}
		}
	}
	br := max(1, max(sw, sh)/16)
	small := image.NewNRGBA(image.Rect(0, 0, sw, sh))
	for c := range ch {
		v := genBoxBlur(genBoxBlur(ch[c], sw, sh, br), sw, sh, br)
		for i, x := range v {
			small.Pix[i*4+c] = uint8(max(0, min(255, x+0.5)))
		}
	}
	for i := 3; i < len(small.Pix); i += 4 {
		small.Pix[i] = 255
	}

	out := image.NewNRGBA(image.Rect(0, 0, W2, H2))
	xdraw.BiLinear.Scale(out, out.Rect, small, small.Rect, draw.Src, nil)
	draw.Draw(out, image.Rect(ox, oy, ox+W, oy+H), orig, image.Point{}, draw.Src)
	for i := 3; i < len(out.Pix); i += 4 { // вклейка смешивает только цвет: холст должен быть непрозрачным
		out.Pix[i] = 255
	}
	return out
}
