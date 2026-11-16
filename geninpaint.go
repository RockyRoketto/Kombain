package main

// Перерисовка части картинки (кисть-маска в окне просмотра галереи).
// Страница присылает маску: закрашенное (светлое или непрозрачное) — перерисовать. Вокруг выделенного берётся
// вырезка с запасом и растягивается до родной площади модели: мелкая деталь получает всё разрешение модели,
// а увеличенная ×4 картинка не переполняет видеопамять. Движок перерисовывает вырезку по маске, очередь
// вклеивает результат обратно с мягким краем (genPatch.apply). Всё вне выделенного остаётся пиксель в пиксель.

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/draw"
	"image/png"
	"math"
	"strings"

	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

// genInpaintStrength: насколько менять выделенное (1 — с нуля, старое не учитывается). Обычная модель
// (не inpaint) при 1 хуже стыкует свет и цвет с соседями, при 0,6 часто оставляет прежний предмет.
const genInpaintStrength = 0.9

// genPatch: куда и как вклеить перерисованную вырезку
type genPatch struct {
	orig  *image.NRGBA    // целая картинка
	crop  image.Rectangle // вырезка в координатах картинки
	alpha []float32       // мягкая маска вырезки (0 — оставить, 1 — новое), crop.Dx()*crop.Dy()
}

// Size: размер готовой картинки (целой, а не вырезки)
func (p *genPatch) Size() (int, int) { return p.orig.Rect.Dx(), p.orig.Rect.Dy() }

// genMaskData: маска со страницы приходит как data:image/png;base64,…
func genMaskData(s string) ([]byte, error) {
	if _, after, ok := strings.Cut(s, ","); ok && strings.HasPrefix(s, "data:") {
		s = after
	}
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil || len(b) == 0 {
		return nil, errT("inp.bad")
	}
	return b, nil
}

// genInpaintPrep: из картинки и маски — вырезка и маска для движка (размер w×h под модель с родным nw×nh)
// и сведения для вклейки
func genInpaintPrep(src, mask []byte, nw, nh int) (patch *genPatch, init, msk []byte, w, h int, err error) {
	orig, err := genDecodeNRGBA(src)
	if err != nil {
		return nil, nil, nil, 0, 0, err
	}

	mi, _, err := image.Decode(bytes.NewReader(mask))
	if err != nil {
		return nil, nil, nil, 0, 0, errT("inp.bad")
	}
	// в серое: прозрачное и чёрное — 0, белое непрозрачное — 255 (подходят обе привычные записи маски)
	mg := image.NewGray(orig.Rect)
	xdraw.BiLinear.Scale(mg, mg.Rect, mi, mi.Bounds(), xdraw.Src, nil)
	return genPatchPrep(orig, mg, nw, nh, genFeather(orig.Rect.Dx(), orig.Rect.Dy()))
}

// genDecodeNRGBA: картинка из файла в NRGBA с началом в 0,0
func genDecodeNRGBA(src []byte) (*image.NRGBA, error) {
	img, _, err := image.Decode(bytes.NewReader(src))
	if err != nil {
		return nil, errT("err.noFile")
	}
	b := img.Bounds()
	orig := image.NewNRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(orig, orig.Rect, img, b.Min, draw.Src)
	return orig, nil
}

// genPatchPrep: общее для перерисовки и дорисовки за краями. mg — маска размером с картинку (больше 127 — нарисовать заново),
// r — ширина мягкого края: движок перерисует на r дальше маски, вклейка переходит от старого к новому на 2r.
func genPatchPrep(orig *image.NRGBA, mg *image.Gray, nw, nh, r int) (patch *genPatch, init, msk []byte, w, h int, err error) {
	W, H := orig.Rect.Dx(), orig.Rect.Dy()
	box := image.Rectangle{}
	for y := 0; y < H; y++ {
		row := mg.Pix[y*mg.Stride : y*mg.Stride+W]
		for x, v := range row {
			if v > 127 {
				box = box.Union(image.Rect(x, y, x+1, y+1))
			}
		}
	}
	if box.Empty() {
		return nil, nil, nil, 0, 0, errT("inp.empty")
	}
	if nw <= 0 || nh <= 0 {
		nw, nh = 1024, 1024
	}
	crop := genCropAround(box, W, H, r, max(nw, nh)/2)
	cw, ch := crop.Dx(), crop.Dy()

	// выделенное внутри вырезки, расширенное на r: движок перерисует чуть больше, чем закрашено,
	// а мягкий край вклейки ляжет на эту полосу
	bin := make([]float32, cw*ch)
	for y := 0; y < ch; y++ {
		for x := 0; x < cw; x++ {
			if mg.GrayAt(crop.Min.X+x, crop.Min.Y+y).Y > 127 {
				bin[y*cw+x] = 1
			}
		}
	}
	dil := genBoxBlur(bin, cw, ch, r)
	for i, v := range dil {
		if v > 0 {
			dil[i] = 1
		} else {
			dil[i] = 0
		}
	}
	alpha := genBoxBlur(dil, cw, ch, r)
	for i, v := range bin { // закрашенное целиком новое, даже у края картинки
		if v == 1 {
			alpha[i] = 1
		}
	}

	s := math.Sqrt(float64(nw*nh) / float64(cw*ch))
	r64 := func(v float64) int { return max(256, int(math.Round(v/64))*64) }
	w, h = r64(float64(cw)*s), r64(float64(ch)*s)

	in := image.NewNRGBA(image.Rect(0, 0, w, h))
	xdraw.CatmullRom.Scale(in, in.Rect, orig, crop, draw.Src, nil)
	for i := 3; i < len(in.Pix); i += 4 { // движку нужна непрозрачная картинка
		in.Pix[i] = 255
	}
	dm := image.NewGray(image.Rect(0, 0, cw, ch))
	for i, v := range dil {
		dm.Pix[i] = uint8(v * 255)
	}
	out := image.NewGray(image.Rect(0, 0, w, h))
	xdraw.BiLinear.Scale(out, out.Rect, dm, dm.Rect, draw.Src, nil)

	var ib, mb bytes.Buffer
	if err := png.Encode(&ib, in); err != nil {
		return nil, nil, nil, 0, 0, err
	}
	if err := png.Encode(&mb, out); err != nil {
		return nil, nil, nil, 0, 0, err
	}
	return &genPatch{orig: orig, crop: crop, alpha: alpha}, ib.Bytes(), mb.Bytes(), w, h, nil
}

// genFeather: ширина мягкого края вклейки, от размера картинки (1024 → 4 точки, 4096 → 16)
func genFeather(w, h int) int { return max(3, max(w, h)/256) }

// genCropAround: вырезка вокруг выделенного с запасом на окружение (модели нужно видеть, что рядом),
// не меньше minSide по сторонам, не уже 1:2, в пределах картинки
func genCropAround(box image.Rectangle, W, H, r, minSide int) image.Rectangle {
	pad := max(2*r+8, 32, max(box.Dx(), box.Dy())/3)
	cw, ch := box.Dx()+2*pad, box.Dy()+2*pad
	cw, ch = max(cw, minSide), max(ch, minSide)
	cw, ch = max(cw, ch/2), max(ch, cw/2)
	place := func(lo, hi, want, limit int) (int, int) {
		want = min(want, limit)
		c := (lo + hi) / 2
		a := c - want/2
		a = max(0, min(a, limit-want))
		return a, a + want
	}
	x0, x1 := place(box.Min.X, box.Max.X, cw, W)
	y0, y1 := place(box.Min.Y, box.Max.Y, ch, H)
	return image.Rect(x0, y0, x1, y1)
}

// genBoxBlur: среднее по квадрату (2r+1)², двумя проходами скользящей суммой. За краем — значение края.
// Для масок из 0 и 1 суммы целые и считаются точно, делим только в конце: где рядом не было единиц, будет ровно 0.
func genBoxBlur(src []float32, w, h, r int) []float32 {
	tmp := make([]float32, len(src))
	dst := make([]float32, len(src))
	pass := func(in, out []float32, cnt, step, lines, lstep int) {
		for l := 0; l < lines; l++ {
			base := l * lstep
			at := func(i int) float32 { return in[base+max(0, min(i, cnt-1))*step] }
			var sum float32
			for i := -r; i <= r; i++ {
				sum += at(i)
			}
			for i := 0; i < cnt; i++ {
				out[base+i*step] = sum
				sum += at(i+r+1) - at(i-r)
			}
		}
	}
	pass(src, tmp, w, 1, h, w) // по строкам
	pass(tmp, dst, h, w, w, 1) // по столбцам
	k := 1 / float32((2*r+1)*(2*r+1))
	for i := range dst {
		dst[i] *= k
	}
	return dst
}

// apply: перерисованную вырезку (PNG от движка) — в целую картинку
func (p *genPatch) apply(gen []byte) ([]byte, error) {
	g, _, err := image.Decode(bytes.NewReader(gen))
	if err != nil {
		return nil, err
	}
	cw, ch := p.crop.Dx(), p.crop.Dy()
	sc := image.NewNRGBA(image.Rect(0, 0, cw, ch))
	xdraw.CatmullRom.Scale(sc, sc.Rect, g, g.Bounds(), draw.Src, nil)
	out := image.NewNRGBA(p.orig.Rect)
	copy(out.Pix, p.orig.Pix)
	for y := 0; y < ch; y++ {
		for x := 0; x < cw; x++ {
			a := p.alpha[y*cw+x]
			if a <= 0 {
				continue
			}
			oi := out.PixOffset(p.crop.Min.X+x, p.crop.Min.Y+y)
			si := sc.PixOffset(x, y)
			for c := 0; c < 3; c++ {
				out.Pix[oi+c] = uint8(float32(out.Pix[oi+c])*(1-a) + float32(sc.Pix[si+c])*a + 0.5)
			}
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, out); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
