package main

// «Сжать» в инструменте «PDF»: pdfcpu сам картинки не пережимает, поэтому здесь
// картинки достаются из таблицы объектов, пережимаются в JPEG (или ч/б Flate), уменьшаются
// до заданного DPI и подменяются на месте. Размер картинки на странице берётся из
// содержимого страниц (операторы q/Q/cm/Do, вложенные формы); не нашли — DPI не трогаем.

import (
	"bytes"
	"compress/zlib"
	"context"
	"fmt"
	"image"
	"image/jpeg"
	"math"
	"os"
	"runtime"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/types"
	xdraw "golang.org/x/image/draw"
)

// PDFCompress: настройки «Сжать»
type PDFCompress struct {
	Preset  string `json:"preset"`  // "strong", "medium", "light" или "custom"
	Quality int    `json:"quality"` // JPEG 10…95, только для "custom"
	DPI     int    `json:"dpi"`     // предел точек на дюйм, 0 — не уменьшать; только для "custom"
	Color   string `json:"color"`   // "" как есть, "gray" оттенки серого, "bw" чёрно-белое
	Strip   bool   `json:"strip"`   // убрать метаданные, миниатюры страниц, служебные данные редакторов
}

// params: качество JPEG и предел DPI
func (o PDFCompress) params() (q, dpi int) {
	switch o.Preset {
	case "strong":
		return 50, 150
	case "light":
		return 85, 300
	case "custom":
		q, dpi = o.Quality, o.DPI
		if q < 10 || q > 95 {
			q = 70
		}
		if dpi != 0 && (dpi < 50 || dpi > 1200) {
			dpi = 200
		}
		return
	}
	return 70, 200 // "medium"
}

// pdfCompStats: что сделали с картинками
type pdfCompStats struct {
	Images  int // картинок в файле
	Recoded int // пережато и подменено
	Failed  int // не прочитались (остались как были)
}

// pdfMat: матрица PDF [a b c d e f]
type pdfMat [6]float64

var pdfIdent = pdfMat{1, 0, 0, 1, 0, 0}

// mul: m, затем n (порядок cm в PDF: новая CTM = m × старая)
func (m pdfMat) mul(n pdfMat) pdfMat {
	return pdfMat{
		m[0]*n[0] + m[1]*n[2], m[0]*n[1] + m[1]*n[3],
		m[2]*n[0] + m[3]*n[2], m[2]*n[1] + m[3]*n[3],
		m[4]*n[0] + m[5]*n[2] + n[4], m[4]*n[1] + m[5]*n[3] + n[5],
	}
}

// pdfScanContent: пройти содержимое страницы и вызвать op для каждого оператора с его операндами.
// Строки, словари, массивы и встроенные картинки (BI…ID…EI) пропускаются, операнды у них — заглушки.
func pdfScanContent(b []byte, op func(name string, args []string)) {
	var args []string
	isWS := func(c byte) bool { return c == ' ' || c == '\n' || c == '\r' || c == '\t' || c == '\f' || c == 0 }
	isDelim := func(c byte) bool { return strings.IndexByte("()<>[]{}/%", c) >= 0 }
	for i := 0; i < len(b); {
		c := b[i]
		switch {
		case isWS(c):
			i++
		case c == '%':
			for i < len(b) && b[i] != '\n' && b[i] != '\r' {
				i++
			}
		case c == '(':
			depth := 0
			for ; i < len(b); i++ {
				if b[i] == '\\' {
					i++
					continue
				}
				if b[i] == '(' {
					depth++
				} else if b[i] == ')' {
					if depth--; depth == 0 {
						i++
						break
					}
				}
			}
			args = append(args, "()")
		case c == '<' && i+1 < len(b) && b[i+1] == '<', c == '>' && i+1 < len(b) && b[i+1] == '>':
			i += 2
		case c == '<':
			for i < len(b) && b[i] != '>' {
				i++
			}
			i++
			args = append(args, "<>")
		case c == '[' || c == ']' || c == '{' || c == '}' || c == '>':
			i++
		case c == '/':
			j := i + 1
			for j < len(b) && !isWS(b[j]) && !isDelim(b[j]) {
				j++
			}
			args = append(args, string(b[i:j]))
			i = j
		default:
			j := i
			for j < len(b) && !isWS(b[j]) && !isDelim(b[j]) {
				j++
			}
			if j == i {
				j++
			}
			tok := string(b[i:j])
			i = j
			if (tok[0] >= '0' && tok[0] <= '9') || tok[0] == '-' || tok[0] == '+' || tok[0] == '.' {
				if len(args) < 64 {
					args = append(args, tok)
				}
				continue
			}
			if tok == "BI" {
				// встроенная картинка: до ID, потом данные до « EI»
				k := bytes.Index(b[i:], []byte("ID"))
				if k < 0 {
					return
				}
				i += k + 3
				for i < len(b) {
					k = bytes.Index(b[i:], []byte("EI"))
					if k < 0 {
						return
					}
					i += k + 2
					if isWS(b[i-3]) && (i >= len(b) || isWS(b[i]) || isDelim(b[i])) {
						break
					}
				}
				args = args[:0]
				continue
			}
			op(tok, args)
			args = args[:0]
		}
	}
}

// pdfName: имя из содержимого («/Im#201» → «Im 1»)
func pdfName(s string) string {
	s = strings.TrimPrefix(s, "/")
	if !strings.Contains(s, "#") {
		return s
	}
	var out strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '#' && i+2 < len(s) {
			if v, err := strconv.ParseUint(s[i+1:i+3], 16, 8); err == nil {
				out.WriteByte(byte(v))
				i += 2
				continue
			}
		}
		out.WriteByte(s[i])
	}
	return out.String()
}

// pdfImageSizes: самый крупный показ каждой картинки на страницах, в пунктах (ширина, высота).
// Картинки только из аннотаций, узоров и масок сюда не попадают — для них DPI не считается.
func pdfImageSizes(c context.Context, ctx *model.Context) map[int][2]float64 {
	sizes := map[int][2]float64{}
	xref := ctx.XRefTable
	budget := 20_000 // вызовов форм на файл: защита от зацикленных и огромных файлов
	var walk func(content []byte, res types.Dict, base pdfMat, depth int)
	walk = func(content []byte, res types.Dict, base pdfMat, depth int) {
		var xobj types.Dict
		if res != nil {
			xobj, _ = xref.DereferenceDict(res["XObject"])
		}
		ctm, stack := base, []pdfMat{}
		pdfScanContent(content, func(name string, args []string) {
			switch name {
			case "q":
				if len(stack) < 256 {
					stack = append(stack, ctm)
				}
			case "Q":
				if n := len(stack); n > 0 {
					ctm, stack = stack[n-1], stack[:n-1]
				}
			case "cm":
				if len(args) < 6 {
					return
				}
				var m pdfMat
				for k := range 6 {
					m[k], _ = strconv.ParseFloat(args[len(args)-6+k], 64)
				}
				ctm = m.mul(ctm)
			case "Do":
				if len(args) == 0 || xobj == nil || depth > 8 || budget <= 0 {
					return
				}
				ir, ok := xobj[pdfName(args[len(args)-1])].(types.IndirectRef)
				if !ok {
					return
				}
				sd, _, err := xref.DereferenceStreamDict(ir)
				if err != nil || sd == nil {
					return
				}
				nr := ir.ObjectNumber.Value()
				switch st := sd.Subtype(); {
				case st != nil && *st == "Image":
					w, h := math.Hypot(ctm[0], ctm[1]), math.Hypot(ctm[2], ctm[3])
					old := sizes[nr]
					sizes[nr] = [2]float64{max(old[0], w), max(old[1], h)}
				case st != nil && *st == "Form":
					budget--
					f := *sd
					if err := f.DecodeWithLimit(64 << 20); err != nil {
						return
					}
					m := pdfIdent
					if arr, err := xref.DereferenceArray(sd.Dict["Matrix"]); err == nil && len(arr) == 6 {
						for k := range 6 {
							m[k], _ = xref.DereferenceNumber(arr[k])
						}
					}
					fres, _ := xref.DereferenceDict(sd.Dict["Resources"])
					if fres == nil {
						fres = res
					}
					walk(f.Content, fres, m.mul(ctm), depth+1)
				}
			}
		})
	}
	for p := 1; p <= ctx.PageCount && c.Err() == nil; p++ {
		d, _, inh, err := xref.PageDict(c, p, false)
		if err != nil || d == nil {
			continue
		}
		content, err := xref.PageContent(d, p)
		if err != nil || len(content) == 0 {
			continue
		}
		var res types.Dict
		if inh != nil {
			res = inh.Resources
		}
		if res == nil {
			res, _ = xref.DereferenceDict(d["Resources"])
		}
		walk(content, res, pdfIdent, 0)
	}
	return sizes
}

// pdfStrip: убрать метаданные XMP, словарь Info, миниатюры страниц и служебные данные редакторов
func pdfStrip(c context.Context, ctx *model.Context) {
	xref := ctx.XRefTable
	xref.Info = nil
	if root, err := xref.Catalog(); err == nil && root != nil {
		for _, k := range []string{"Metadata", "PieceInfo"} {
			root.Delete(k)
		}
	}
	for p := 1; p <= ctx.PageCount; p++ {
		if d, _, _, err := xref.PageDict(c, p, false); err == nil && d != nil {
			for _, k := range []string{"Thumb", "PieceInfo", "Metadata"} {
				d.Delete(k)
			}
		}
	}
	for _, e := range xref.Table {
		if e == nil || e.Free {
			continue
		}
		if sd, ok := e.Object.(types.StreamDict); ok {
			if st := sd.Subtype(); st != nil && (*st == "Image" || *st == "Form") {
				sd.Delete("Metadata")
				sd.Delete("PieceInfo")
			}
		}
	}
}

// pdfImgJob: картинка, которую можно пережать
type pdfImgJob struct {
	nr       int
	sd       types.StreamDict // копия: декодируется в потоке пережатия
	w, h     int
	comp     int  // 1 — серое, 3 — RGB
	dct      bool // JPEG как есть
	ptW, ptH float64
	// результат
	data     []byte
	filter   string
	outComp  int
	outBPC   int
	nw, nh   int
	recolor  bool
	replaced bool
	err      error
}

// pdfColorComps: число компонент цвета, если это серое или RGB (иначе 0 — такие картинки не трогаем)
func pdfColorComps(xref *model.XRefTable, o types.Object) int {
	o, _ = xref.Dereference(o)
	switch v := o.(type) {
	case types.Name:
		switch v {
		case "DeviceRGB", "CalRGB":
			return 3
		case "DeviceGray", "CalGray":
			return 1
		}
	case types.Array:
		if len(v) == 2 {
			if n, ok := v[0].(types.Name); ok && n == "ICCBased" {
				if sd, _, err := xref.DereferenceStreamDict(v[1]); err == nil && sd != nil {
					if n := sd.IntEntry("N"); n != nil && (*n == 1 || *n == 3) {
						return *n
					}
				}
			}
		}
		if len(v) >= 2 {
			if n, ok := v[0].(types.Name); ok && (n == "CalRGB" || n == "CalGray") {
				return map[types.Name]int{"CalRGB": 3, "CalGray": 1}[n]
			}
		}
	}
	return 0
}

// фильтры без потерь, которые pdfcpu умеет распаковать
var pdfLossless = map[string]bool{"FlateDecode": true, "LZWDecode": true, "RunLengthDecode": true, "ASCII85Decode": true, "ASCIIHexDecode": true}

// pdfImageJobs: картинки, которые можно пережать без риска.
// Пропускаем: маски (SMask и Mask на них ссылаются), трафареты (ImageMask), цветовой ключ (Mask-массив),
// свой Decode, не 8 бит, CMYK, палитры, JPEG 2000, JBIG2, CCITT, совсем маленькие.
func pdfImageJobs(ctx *model.Context, sizes map[int][2]float64) (jobs []*pdfImgJob, total int) {
	xref := ctx.XRefTable
	masks := map[int]bool{}
	var nrs []int
	for nr, e := range xref.Table {
		if e == nil || e.Free {
			continue
		}
		sd, ok := e.Object.(types.StreamDict)
		if !ok {
			continue
		}
		if st := sd.Subtype(); st == nil || *st != "Image" {
			continue
		}
		nrs = append(nrs, nr)
		for _, k := range []string{"SMask", "Mask"} {
			if ir, ok := sd.Dict[k].(types.IndirectRef); ok {
				masks[ir.ObjectNumber.Value()] = true
			}
		}
	}
	sort.Ints(nrs)
	total = len(nrs)
	for _, nr := range nrs {
		sd := xref.Table[nr].Object.(types.StreamDict)
		if masks[nr] || sd.Dict["Decode"] != nil || sd.Dict["Alternates"] != nil {
			continue
		}
		if b := sd.BooleanEntry("ImageMask"); b != nil && *b {
			continue
		}
		if _, ok := sd.Dict["Mask"].(types.Array); ok {
			continue
		}
		w, h, bpc := sd.IntEntry("Width"), sd.IntEntry("Height"), sd.IntEntry("BitsPerComponent")
		if w == nil || h == nil || *w < 16 || *h < 16 || int64(*w)*int64(*h) > 150_000_000 || len(sd.Raw) < 2048 {
			continue
		}
		fpl := sd.FilterPipeline
		dct := len(fpl) == 1 && fpl[0].Name == "DCTDecode"
		if !dct && slices.ContainsFunc(fpl, func(f types.PDFFilter) bool { return !pdfLossless[f.Name] }) {
			continue
		}
		if !dct && (bpc == nil || *bpc != 8) {
			continue
		}
		comp := pdfColorComps(xref, sd.Dict["ColorSpace"])
		if comp == 0 {
			continue
		}
		sz := sizes[nr]
		jobs = append(jobs, &pdfImgJob{nr: nr, sd: sd, w: *w, h: *h, comp: comp, dct: dct, ptW: sz[0], ptH: sz[1]})
	}
	return
}

// pdfDecodeJob: картинка в пикселях (*image.Gray или *image.RGBA / YCbCr из JPEG)
func pdfDecodeJob(j *pdfImgJob) (image.Image, error) {
	if j.dct {
		img, err := jpeg.Decode(bytes.NewReader(j.sd.Raw))
		if err != nil {
			return nil, err
		}
		b := img.Bounds()
		if b.Dx() != j.w || b.Dy() != j.h {
			return nil, fmt.Errorf("jpeg %dx%d, dict %dx%d", b.Dx(), b.Dy(), j.w, j.h)
		}
		switch img.(type) {
		case *image.Gray, *image.YCbCr:
			return img, nil
		}
		return nil, fmt.Errorf("jpeg %T", img) // CMYK и прочее не трогаем
	}
	sd := j.sd
	need := int64(j.w) * int64(j.h) * int64(j.comp)
	if err := sd.DecodeWithLimit(need + 4096); err != nil {
		return nil, err
	}
	px := sd.Content
	if int64(len(px)) < need {
		return nil, fmt.Errorf("short data: %d of %d", len(px), need)
	}
	if j.comp == 1 {
		return &image.Gray{Pix: px[:need], Stride: j.w, Rect: image.Rect(0, 0, j.w, j.h)}, nil
	}
	rgba := image.NewRGBA(image.Rect(0, 0, j.w, j.h))
	for i, k := 0, 0; i < int(need); i, k = i+3, k+4 {
		rgba.Pix[k], rgba.Pix[k+1], rgba.Pix[k+2], rgba.Pix[k+3] = px[i], px[i+1], px[i+2], 255
	}
	return rgba, nil
}

// toGray: оттенки серого
func toGray(img image.Image) *image.Gray {
	if g, ok := img.(*image.Gray); ok {
		return g
	}
	b := img.Bounds()
	g := image.NewGray(image.Rect(0, 0, b.Dx(), b.Dy()))
	xdraw.Draw(g, g.Bounds(), img, b.Min, xdraw.Src)
	return g
}

// otsu: порог для чёрно-белого по гистограмме (серая бумага скана уходит в белое)
func otsu(g *image.Gray) uint8 {
	var hist [256]int
	for _, v := range g.Pix {
		hist[v]++
	}
	total := len(g.Pix)
	var sum float64
	for i, n := range hist {
		sum += float64(i * n)
	}
	var sumB, best float64
	var wB int
	th := 128
	for i, n := range hist {
		if wB += n; wB == 0 {
			continue
		}
		wF := total - wB
		if wF == 0 {
			break
		}
		sumB += float64(i * n)
		mB, mF := sumB/float64(wB), (sum-sumB)/float64(wF)
		if v := float64(wB) * float64(wF) * (mB - mF) * (mB - mF); v > best {
			best, th = v, i
		}
	}
	return uint8(th)
}

// encodeBW: 1 бит на точку, Flate (0 — чёрный)
func encodeBW(g *image.Gray) []byte {
	w, h := g.Rect.Dx(), g.Rect.Dy()
	th := otsu(g)
	row := make([]byte, (w+7)/8)
	var buf bytes.Buffer
	zw, _ := zlib.NewWriterLevel(&buf, zlib.BestCompression)
	for y := range h {
		clear(row)
		p := g.Pix[y*g.Stride:]
		for x := range w {
			if p[x] > th {
				row[x>>3] |= 0x80 >> (x & 7)
			}
		}
		zw.Write(row)
	}
	zw.Close()
	return buf.Bytes()
}

// pdfRecode: пережать одну картинку; replaced=false — оставить как было
func pdfRecode(j *pdfImgJob, q, dpi int, color string) error {
	img, err := pdfDecodeJob(j)
	if err != nil {
		return err
	}
	nw, nh := j.w, j.h
	if dpi > 0 && j.ptW > 0 && j.ptH > 0 {
		// сколько точек нужно, чтобы на странице было dpi; по оси, где нужно больше, — чтобы не мылить
		k := max(j.ptW/72*float64(dpi)/float64(j.w), j.ptH/72*float64(dpi)/float64(j.h))
		if k < 0.85 {
			nw, nh = max(1, int(float64(j.w)*k+0.5)), max(1, int(float64(j.h)*k+0.5))
		}
	}
	resized := nw != j.w || nh != j.h
	if resized {
		var dst xdraw.Image
		if j.comp == 1 || color != "" {
			dst = image.NewGray(image.Rect(0, 0, nw, nh))
		} else {
			dst = image.NewRGBA(image.Rect(0, 0, nw, nh))
		}
		xdraw.CatmullRom.Scale(dst, dst.Bounds(), img, img.Bounds(), xdraw.Src, nil)
		img = dst
	}
	recolor := (color == "gray" && j.comp == 3) || color == "bw"
	out, filter, comp, bpc := []byte(nil), "DCTDecode", j.comp, 8
	switch {
	case color == "bw":
		out, filter, comp, bpc = encodeBW(toGray(img)), "FlateDecode", 1, 1
	default:
		if color == "gray" {
			img, comp = toGray(img), 1
		}
		var buf bytes.Buffer
		if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: q}); err != nil {
			return err
		}
		out = buf.Bytes()
	}
	// стало больше — оставляем старое; цвет меняли по просьбе — подменяем всё равно
	if len(out) >= len(j.sd.Raw) && !recolor {
		return nil
	}
	j.data, j.filter, j.outComp, j.outBPC, j.nw, j.nh, j.recolor, j.replaced = out, filter, comp, bpc, nw, nh, recolor, true
	return nil
}

// pdfApplyJob: подменить картинку в таблице объектов
func pdfApplyJob(ctx *model.Context, j *pdfImgJob) {
	e := ctx.XRefTable.Table[j.nr]
	sd := e.Object.(types.StreamDict)
	sd.Raw, sd.Content = j.data, nil
	sd.FilterPipeline = []types.PDFFilter{{Name: j.filter}}
	sd.Dict["Filter"] = types.Name(j.filter)
	delete(sd.Dict, "DecodeParms")
	sd.Dict["Width"], sd.Dict["Height"] = types.Integer(j.nw), types.Integer(j.nh)
	sd.Dict["BitsPerComponent"] = types.Integer(j.outBPC)
	if j.recolor {
		sd.Dict["ColorSpace"] = types.Name("DeviceGray")
	}
	l := int64(len(j.data))
	sd.StreamLength, sd.StreamLengthObjNr = &l, nil
	sd.Dict["Length"] = types.Integer(l)
	sd.CSComponents = j.outComp
	e.Object = sd
}

// pdfFlateRaw: несжатые потоки (кроме XMP-метаданных) — в Flate, если так меньше
func pdfFlateRaw(ctx *model.Context) {
	for _, e := range ctx.XRefTable.Table {
		if e == nil || e.Free {
			continue
		}
		sd, ok := e.Object.(types.StreamDict)
		if !ok || len(sd.FilterPipeline) > 0 || len(sd.Raw) < 256 {
			continue
		}
		if t := sd.Type(); t != nil && (*t == "Metadata" || *t == "XRef" || *t == "ObjStm") {
			continue
		}
		var buf bytes.Buffer
		zw, _ := zlib.NewWriterLevel(&buf, zlib.BestCompression)
		zw.Write(sd.Raw)
		zw.Close()
		if buf.Len() >= len(sd.Raw) {
			continue
		}
		sd.Content = nil
		sd.Raw = buf.Bytes()
		sd.FilterPipeline = []types.PDFFilter{{Name: "FlateDecode"}}
		sd.Dict["Filter"] = types.Name("FlateDecode")
		l := int64(len(sd.Raw))
		sd.StreamLength, sd.StreamLengthObjNr = &l, nil
		sd.Dict["Length"] = types.Integer(l)
		e.Object = sd
	}
}

// pdfCompress: сжать src в dst. prog получает долю готовых картинок (0…1)
func pdfCompress(c context.Context, src, dst, pw string, o PDFCompress, prog func(float64)) (st pdfCompStats, err error) {
	ctx, err := pdfOpen(c, src, pw)
	if err != nil {
		return st, err
	}
	if err := api.OptimizeContext(c, ctx); err != nil { // повторы шрифтов и картинок
		return st, err
	}
	if o.Strip {
		pdfStrip(c, ctx)
	}
	q, dpi := o.params()
	color := o.Color
	if color != "gray" && color != "bw" {
		color = ""
	}
	jobs, total := pdfImageJobs(ctx, pdfImageSizes(c, ctx))
	st.Images = total

	// пережатие параллельно: каждый поток работает со своей копией словаря, таблицу объектов не трогает
	var (
		mu   sync.Mutex
		done int
		wg   sync.WaitGroup
	)
	ch := make(chan *pdfImgJob)
	for range min(max(1, runtime.NumCPU()), 4) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range ch {
				if c.Err() == nil {
					j.err = pdfRecode(j, q, dpi, color)
				}
				mu.Lock()
				done++
				if prog != nil {
					prog(float64(done) / float64(len(jobs)))
				}
				mu.Unlock()
			}
		}()
	}
	for _, j := range jobs {
		if c.Err() != nil {
			break
		}
		ch <- j
	}
	close(ch)
	wg.Wait()
	if err := c.Err(); err != nil {
		return st, err
	}
	for _, j := range jobs {
		if j.replaced {
			pdfApplyJob(ctx, j)
			st.Recoded++
		}
		if j.err != nil {
			st.Failed++
		}
		j.data = nil
	}
	pdfFlateRaw(ctx)

	tmp := dst + ".part"
	if err := api.WriteContextFile(c, ctx, tmp); err != nil {
		os.Remove(tmp)
		return st, err
	}
	if err := os.Rename(tmp, dst); err != nil {
		os.Remove(tmp)
		return st, err
	}
	return st, nil
}

// fmtSizeH: «840 КБ», «12,4 МБ»
func fmtSizeH(n int64) string {
	if n < 1<<20 {
		return fmtKB(n)
	}
	v := strconv.FormatFloat(float64(n)/(1<<20), 'f', 1, 64)
	if currentLang() == langRU {
		v = strings.Replace(v, ".", ",", 1)
	}
	return tr("unit.mb", v)
}

// pdfSaved: «12,4 МБ → 3,1 МБ (−75%)»
func pdfSaved(src, dst int64) string {
	s := fmtSizeH(src) + " → " + fmtSizeH(dst)
	if src > 0 && dst < src {
		s += fmt.Sprintf(" (−%d%%)", int(math.Round(float64(src-dst)*100/float64(src))))
	}
	return s
}

// runCompress: «Сжать» каждый PDF. Стало не меньше — результат удаляем, оригинал остаётся («как есть»)
func (s *Server) runCompress(c context.Context, states []*FileState, req PDFReq) (ok, bad int, before, after int64) {
	used := map[string]bool{}
	for i, st := range states {
		if c.Err() != nil {
			break
		}
		s.set(i, func(fs *FileState) { fs.Status = "running" })
		dst := pdfOutPath(st.Path, req, used)
		stats, err := pdfCompress(c, st.Path, dst, req.Password, req.Comp, func(f float64) {
			s.set(i, func(fs *FileState) { fs.Pct = 95 * f })
		})
		if c.Err() != nil {
			os.Remove(dst)
			break
		}
		if err != nil {
			bad++
			msg := pdfErrText(err)
			s.set(i, func(fs *FileState) { fs.Status = "error"; fs.Msg = msg; fs.Hint = msg })
			s.addLog("[pdf] %s: %v", st.Name, err)
			continue
		}
		size := fileSize(dst)
		s.addLog("%s", tr("pdf.compLog", st.Name, stats.Images, stats.Recoded, stats.Failed, pdfSaved(st.SrcSize, size)))
		before += st.SrcSize
		if size >= st.SrcSize {
			os.Remove(dst)
			after += st.SrcSize
			s.kept(i, tr("pdf.compKept"))
			continue
		}
		ok++
		after += size
		msg := pdfSaved(st.SrcSize, size)
		s.set(i, func(fs *FileState) { fs.Status = "ok"; fs.Pct = 100; fs.Dst = dst; fs.DstSize = size; fs.Msg = msg })
	}
	return
}
