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
	"regexp"

	xdraw "golang.org/x/image/draw"
)

// genOutpaintStrength: насколько менять начальную заливку новой полосы. Заливка — только размытые цвета краёв,
// сохранять в ней нечего; меньше 1 оставляет мутные пятна вместо предметов.
const genOutpaintStrength = 1.0

// genOutWholeMax: сторона квадрата, по площади которого klein рисует весь холст (~2,2 Мп; модель держит до 4 Мп,
// но дольше и жаднее до видеопамяти)
var genOutWholeMax = 1472

// genOutMaxSide: предел стороны готовой картинки (как у увеличения)
const genOutMaxSide = 8192

// genOutpaintPrep: ext — сколько точек добавить слева, сверху, справа, снизу. Каждая сторона не больше
// размера картинки по этой оси (холст вырастает максимум втрое).
func genOutpaintPrep(src []byte, ext []int, nw, nh int, whole bool) (patch *genPatch, init, msk []byte, w, h int, err error) {
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
	f := genOutFeather(W, H)
	minSide := max(nw, nh) / 2
	if whole {
		// klein видит холст целиком: широкая кромка, которую она перерисует, выходит своей версией (человек у края
		// сдвинут), и вклейка смешивает обе в полупрозрачного двойника. Узкая кромка только прячет шаг пересчёта.
		minSide, f = max(W2, H2), genFeather(W, H)
		// весь холст в родные 1 Мп: дорисованное второй-третий раз (3,5 Мп) ужималось вдвое, и модель путала
		// пропорции людей у края и мазала. Рабочий размер — как у холста, но не больше genOutWholeMax в квадрате.
		s := int(math.Sqrt(float64(min(max(W2*H2, nw*nh), genOutWholeMax*genOutWholeMax))))
		nw, nh = s, s
	}
	patch, init, msk, w, h, err = genPatchPrep(canvas, mg, nw, nh, f, minSide)
	if err == nil {
		patch.keep = image.Rect(l, t, l+W, t+H)
		genOutAlpha(patch, patch.keep, 2*f)
	}
	return
}

// genOutAlpha: исходная картинка остаётся нетронутой целиком (общая вклейка переводила бы к новому уже внутри неё,
// и края рук, стоящих у границы, перерисовывались с нуля), а переход к новому идёт только по новой полосе:
// 0 на границе исходной, 1 через ramp точек от неё.
func genOutAlpha(p *genPatch, in image.Rectangle, ramp int) {
	cw, ch := p.crop.Dx(), p.crop.Dy()
	for y := 0; y < ch; y++ {
		py := p.crop.Min.Y + y
		dy := max(in.Min.Y-py, py-(in.Max.Y-1), 0)
		for x := 0; x < cw; x++ {
			px := p.crop.Min.X + x
			d := max(in.Min.X-px, px-(in.Max.X-1), dy)
			p.alpha[y*cw+x] = min(1, float32(d)/float32(max(ramp, 1)))
		}
	}
}

// genOutAlphaRef: вклейка для модели, которая видит холст референсом (FLUX.2 klein). Новая полоса целиком из
// нарисованного: смешивать её с заливкой незачем, это давало мутную рамку вокруг исходной. Переход идёт по кромке
// исходной шириной r (genFeather, несколько точек), которую движок и так перерисовал (маска расширена на r): от
// нового на границе к исходной пиксель в пиксель через r точек. Klein видит исходную целиком, поэтому руки
// у края не рисуются заново, как было у Z-Image и SDXL (поэтому у них genOutAlpha оставляет исходную нетронутой).
func genOutAlphaRef(p *genPatch, ext []int) {
	W, H := p.orig.Rect.Dx()-ext[0]-ext[2], p.orig.Rect.Dy()-ext[1]-ext[3]
	in := image.Rect(ext[0], ext[1], ext[0]+W, ext[1]+H)
	r := float32(max(genFeather(W, H), 1)) // как кромка в genOutpaintPrep при whole
	cw, ch := p.crop.Dx(), p.crop.Dy()
	for y := 0; y < ch; y++ {
		py := p.crop.Min.Y + y
		for x := 0; x < cw; x++ {
			px := p.crop.Min.X + x
			a := float32(1)
			if (image.Point{px, py}).In(in) {
				a = max(0, 1-float32(genOutEdgeDist(px, py, in, ext))/r)
			}
			p.alpha[y*cw+x] = a
		}
	}
}

// genOutEdgeDist: расстояние от точки внутри исходной до ближайшей раздвинутой стороны. Стороны, к которым ничего
// не добавляли, не считаются: там край картинки, переходить не к чему.
func genOutEdgeDist(px, py int, in image.Rectangle, ext []int) int {
	d := 1 << 30
	if ext[0] > 0 {
		d = min(d, px-in.Min.X)
	}
	if ext[1] > 0 {
		d = min(d, py-in.Min.Y)
	}
	if ext[2] > 0 {
		d = min(d, in.Max.X-1-px)
	}
	if ext[3] > 0 {
		d = min(d, in.Max.Y-1-py)
	}
	return d
}

// genOutMatch: подогнать нарисованное по цвету к исходной у её края. Модель рисует новую полосу (а klein и
// весь холст заново) чуть другим светом и цветом, и по границе исходной выходила ровная черта (жалоба автора
// 2026-11-20: светлая полоса неба справа). Разница «исходная минус нарисованное» берётся в узкой полосе
// исходной у раздвинутых сторон (точки, где модель сдвинула предмет и разница большая, не считаются),
// размывается вдоль края и переносится в новую полосу, затухая за 2·band от исходной: у края цвета сходятся,
// дальше остаётся нарисованное как есть. Мелкие детали не трогаются, только плавный сдвиг цвета.
// sc — вырезка от движка в размере crop. Замер на klein: по всей исходной сразу оценка ловила
// сдвинутые предметы и делала шов хуже.
func genOutMatch(sc *image.NRGBA, p *genPatch) {
	cw, ch := p.crop.Dx(), p.crop.Dy()
	W2, H2 := p.orig.Rect.Dx(), p.orig.Rect.Dy()
	ext := []int{p.keep.Min.X, p.keep.Min.Y, W2 - p.keep.Max.X, H2 - p.keep.Max.Y}
	if p.keep.Intersect(p.crop).Empty() || cw == 0 || ch == 0 {
		return
	}
	band := max(8, min(p.keep.Dx(), p.keep.Dy())/16) // 1024 → 64: сдвиг гаснет за 128 точек, шире перехода вклейки
	// считаем на сетке клеток s×s: так быстро и на 8192
	s := max(1, min(band/2, max(cw, ch)/192))
	sw, sh := (cw+s-1)/s, (ch+s-1)/s
	n := sw * sh
	known, tot := make([]float32, n), make([]float32, n)
	var diff [3][]float32
	for c := range diff {
		diff[c] = make([]float32, n)
	}
	for y := 0; y < ch; y++ {
		py := p.crop.Min.Y + y
		for x := 0; x < cw; x++ {
			px := p.crop.Min.X + x
			i := (y/s)*sw + x/s
			tot[i]++
			if !(image.Point{px, py}).In(p.keep) || genOutEdgeDist(px, py, p.keep, ext) >= band {
				continue
			}
			oi, si := p.orig.PixOffset(px, py), sc.PixOffset(x, y)
			var d [3]float32
			for c := range d {
				d[c] = float32(p.orig.Pix[oi+c]) - float32(sc.Pix[si+c])
			}
			if abs32(d[0])+abs32(d[1])+abs32(d[2]) > 90 { // тут модель нарисовала другое, а не другим светом
				continue
			}
			known[i]++
			for c := range d {
				diff[c][i] += d[c]
			}
		}
	}
	for i := range tot {
		known[i] /= tot[i]
		for c := range diff {
			diff[c][i] /= tot[i]
		}
	}
	rs := max(1, band/s)
	blur := func(v []float32) []float32 { return genBoxBlur(genBoxBlur(v, sw, sh, rs), sw, sh, rs) }
	bk := blur(known)
	var corr [3][]float32
	for c := range diff {
		corr[c] = blur(diff[c])
		for i, k := range bk {
			if k < 0.02 {
				corr[c][i] = 0
			} else {
				corr[c][i] /= k
			}
		}
	}
	at := func(v []float32, fx, fy float32) float32 {
		fx, fy = max(0, min(fx, float32(sw-1))), max(0, min(fy, float32(sh-1)))
		x0, y0 := int(fx), int(fy)
		x1, y1 := min(x0+1, sw-1), min(y0+1, sh-1)
		ax, ay := fx-float32(x0), fy-float32(y0)
		top := v[y0*sw+x0]*(1-ax) + v[y0*sw+x1]*ax
		bot := v[y1*sw+x0]*(1-ax) + v[y1*sw+x1]*ax
		return top*(1-ay) + bot*ay
	}
	for y := 0; y < ch; y++ {
		py := p.crop.Min.Y + y
		fy := (float32(y)+0.5)/float32(s) - 0.5
		dy := max(p.keep.Min.Y-py, py-(p.keep.Max.Y-1), 0)
		for x := 0; x < cw; x++ {
			if p.alpha[y*cw+x] <= 0 {
				continue
			}
			px := p.crop.Min.X + x
			// внутри исходной (кромка перехода) — полный сдвиг, в новой полосе гаснет за 2·band
			f := 1 - float32(max(p.keep.Min.X-px, px-(p.keep.Max.X-1), dy))/float32(2*band)
			if f <= 0 {
				continue
			}
			fx := (float32(x)+0.5)/float32(s) - 0.5
			si := sc.PixOffset(x, y)
			for c := 0; c < 3; c++ {
				sc.Pix[si+c] = uint8(max(0, min(255, float32(sc.Pix[si+c])+f*at(corr[c], fx, fy)+0.5)))
			}
		}
	}
}

func abs32(v float32) float32 { return max(v, -v) }

// genOutLead: начало промта дорисовки для klein (она видит холст референсом). Ставится перед промтом, уже
// обёрнутым стилем: раньше страница клеила его сама и стиль оборачивал и указание («low poly 3d render of
// Outpainting: …»), а «same photo … grain» спорило с негативом рисованных стилей «photo, photorealistic».
// newArea — человек написал, что нарисовать в новой полосе; иначе продолжаем всё, что обрезано краем.
func genOutLead(newArea bool) string {
	s := "Outpainting: the blurred area at the edges is unfinished. Replace it with a sharp, natural continuation of this same image " +
		"in exactly the same style, matching perspective, light, colours and texture. "
	if newArea {
		return s + "In the new area: "
	}
	return s + "Continue everything that is cut off by the edges (people, furniture, objects); do not duplicate the main subject. Scene: "
}

// reOutLead: прежние указания в начале промта (картинки, дорисованные раньше, хранят их в запросе)
var reOutLead = regexp.MustCompile(`^(?:.*?Outpainting: [\s\S]*?(?:Scene|In the new area): )+`)

// genOutScene: промт без указаний дорисовки, которые туда попали раньше
func genOutScene(s string) string { return reOutLead.ReplaceAllString(s, "") }

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
