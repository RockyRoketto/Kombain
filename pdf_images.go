package main

// «Картинки → PDF» в инструменте «PDF»: JPG, PNG, WebP в один PDF или каждый в свой.
// PDF пишется здесь же, без pdfcpu: на страницу одна картинка. JPEG при качестве «как есть» кладётся байт в байт,
// поворот с телефона (EXIF) делается матрицей страницы, без пережатия.

import (
	"bufio"
	"bytes"
	"compress/zlib"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	_ "image/png"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	xdraw "golang.org/x/image/draw"
	"golang.org/x/image/webp"
)

// ImgPDFOpts: настройки «Картинки → PDF»
type ImgPDFOpts struct {
	Page     string `json:"page"`     // "a4", "a5" или "fit" (страница по размеру картинки)
	Orient   string `json:"orient"`   // "auto", "portrait", "landscape" (для A4 и A5)
	Margin   int    `json:"margin"`   // поля, мм
	Quality  string `json:"quality"`  // "orig" как есть, "high", "mid", "low"
	Separate bool   `json:"separate"` // каждая картинка отдельным PDF
}

var imgPDFExts = map[string]bool{".jpg": true, ".jpeg": true, ".png": true, ".webp": true}

func isImgForPDF(p string) bool { return imgPDFExts[strings.ToLower(filepath.Ext(p))] }

var errImgTooBig = errors.New("image too big")

// pdfImg: картинка, готовая лечь в PDF
type pdfImg struct {
	data   []byte
	filter string // DCTDecode или FlateDecode
	gray   bool
	w, h   int // в файле, до поворота
	orient int // EXIF 1..8
}

// размеры на странице: при повороте на 90° ширина и высота меняются местами
func (im *pdfImg) shown() (float64, float64) {
	if im.orient >= 5 {
		return float64(im.h), float64(im.w)
	}
	return float64(im.w), float64(im.h)
}

// пресеты качества: JPEG и наибольшая сторона в точках (0 — не уменьшать)
func imgQuality(q string) (jq, maxSide int) {
	switch q {
	case "high":
		return 90, 3508 // A4 при 300 dpi
	case "mid":
		return 80, 2339 // 200 dpi
	case "low":
		return 65, 1600
	}
	return 92, 0 // «как есть»: JPEG не трогаем, остальное без потерь или JPEG 92 для WebP
}

// prepImage: прочитать картинку и подготовить к записи
func prepImage(path, quality string) (*pdfImg, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width*cfg.Height > 150_000_000 {
		return nil, errImgTooBig
	}
	jq, maxSide := imgQuality(quality)
	fits := maxSide == 0 || max(cfg.Width, cfg.Height) <= maxSide
	orient := 1
	if format == "jpeg" {
		orient = jpegOrientation(data)
		// CMYK из Фотошопа часто с инвертированными цветами, надёжнее перекодировать
		cmyk := cfg.ColorModel == color.CMYKModel
		if !cmyk && fits && (quality == "orig" || quality == "high" || quality == "") {
			return &pdfImg{data: data, filter: "DCTDecode", gray: cfg.ColorModel == color.GrayModel, w: cfg.Width, h: cfg.Height, orient: orient}, nil
		}
	}
	var img image.Image
	switch format {
	case "webp":
		img, err = webp.Decode(bytes.NewReader(data))
	default:
		img, _, err = image.Decode(bytes.NewReader(data))
	}
	if err != nil {
		return nil, err
	}
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if !fits {
		k := float64(maxSide) / float64(max(w, h))
		w, h = max(1, int(float64(w)*k+0.5)), max(1, int(float64(h)*k+0.5))
	}
	// прозрачное — на белый, заодно приводим к RGB
	rgb := image.NewRGBA(image.Rect(0, 0, w, h))
	for i := range rgb.Pix {
		rgb.Pix[i] = 255
	}
	if fits {
		xdraw.Draw(rgb, rgb.Bounds(), img, b.Min, xdraw.Over)
	} else {
		xdraw.CatmullRom.Scale(rgb, rgb.Bounds(), img, b, xdraw.Over, nil)
	}
	img = nil
	out := &pdfImg{w: w, h: h, orient: orient}
	if quality == "orig" && format == "png" {
		// без потерь: сырые RGB через Flate
		var buf bytes.Buffer
		zw, _ := zlib.NewWriterLevel(&buf, zlib.BestSpeed)
		row := make([]byte, w*3)
		for y := 0; y < h; y++ {
			p := rgb.Pix[y*rgb.Stride:]
			for x := 0; x < w; x++ {
				row[x*3], row[x*3+1], row[x*3+2] = p[x*4], p[x*4+1], p[x*4+2]
			}
			zw.Write(row)
		}
		zw.Close()
		out.data, out.filter = buf.Bytes(), "FlateDecode"
		return out, nil
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, rgb, &jpeg.Options{Quality: jq}); err != nil {
		return nil, err
	}
	out.data, out.filter = buf.Bytes(), "DCTDecode"
	return out, nil
}

// jpegOrientation: тег Orientation из EXIF (1, если нет)
func jpegOrientation(d []byte) int {
	if len(d) < 4 || d[0] != 0xFF || d[1] != 0xD8 {
		return 1
	}
	for i := 2; i+4 <= len(d); {
		if d[i] != 0xFF {
			return 1
		}
		m := d[i+1]
		if m == 0xDA || m == 0xD9 { // дальше данные картинки
			return 1
		}
		n := int(binary.BigEndian.Uint16(d[i+2:]))
		seg := i + 4
		if n < 2 || seg+n-2 > len(d) {
			return 1
		}
		if m == 0xE1 && n >= 8 && string(d[seg:seg+6]) == "Exif\x00\x00" {
			return exifOrientation(d[seg+6 : seg+n-2])
		}
		i = seg + n - 2
	}
	return 1
}

func exifOrientation(t []byte) int {
	if len(t) < 8 {
		return 1
	}
	var bo binary.ByteOrder
	switch string(t[:2]) {
	case "II":
		bo = binary.LittleEndian
	case "MM":
		bo = binary.BigEndian
	default:
		return 1
	}
	off := int(bo.Uint32(t[4:]))
	if off < 8 || off+2 > len(t) {
		return 1
	}
	cnt := int(bo.Uint16(t[off:]))
	for k := 0; k < cnt; k++ {
		e := off + 2 + k*12
		if e+12 > len(t) {
			return 1
		}
		if bo.Uint16(t[e:]) == 0x0112 {
			if v := int(bo.Uint16(t[e+8:])); v >= 1 && v <= 8 {
				return v
			}
			return 1
		}
	}
	return 1
}

// orientMatrix: куда уходят оси картинки (s вправо, t вверх, обе 0..1) на странице:
// u = u0 + us*s + ut*t, v = v0 + vs*s + vt*t. По таблице EXIF 1..8.
func orientMatrix(o int) (u0, us, ut, v0, vs, vt float64) {
	switch o {
	case 2:
		return 1, -1, 0, 0, 0, 1
	case 3:
		return 1, -1, 0, 1, 0, -1
	case 4:
		return 0, 1, 0, 1, 0, -1
	case 5:
		return 1, 0, -1, 1, -1, 0
	case 6:
		return 0, 0, 1, 1, -1, 0
	case 7:
		return 0, 0, 1, 0, 1, 0
	case 8:
		return 1, 0, -1, 0, 1, 0
	}
	return 0, 1, 0, 0, 0, 1
}

// pageLayout: размер страницы (pt) и прямоугольник картинки на ней
func pageLayout(o ImgPDFOpts, dw, dh float64) (pw, ph, x, y, w, h float64) {
	m := float64(max(0, min(o.Margin, 50))) * 72 / 25.4
	if o.Page != "a4" && o.Page != "a5" {
		w, h = dw*0.75, dh*0.75 // 96 точек на дюйм
		return w + 2*m, h + 2*m, m, m, w, h
	}
	pw, ph = 595.276, 841.890
	if o.Page == "a5" {
		pw, ph = 419.528, 595.276
	}
	if o.Orient == "landscape" || (o.Orient != "portrait" && dw > dh) {
		pw, ph = ph, pw
	}
	bw, bh := pw-2*m, ph-2*m
	k := min(bw/dw, bh/dh)
	w, h = dw*k, dh*k
	return pw, ph, (pw - w) / 2, (ph - h) / 2, w, h
}

func pf(v float64) string { return strconv.FormatFloat(v, 'f', 3, 64) }

// pdfWriter: простой PDF, объекты пишутся сразу в файл, оглавление (xref) в конце
type pdfWriter struct {
	w     *bufio.Writer
	pos   int64
	offs  map[int]int64
	next  int
	kids  []int
	pages int // номер объекта /Pages
}

func newPDFWriter(f io.Writer) *pdfWriter {
	p := &pdfWriter{w: bufio.NewWriterSize(f, 1<<20), offs: map[int]int64{}, next: 3, pages: 2}
	p.out("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
	return p
}

func (p *pdfWriter) out(s string) {
	n, _ := p.w.WriteString(s)
	p.pos += int64(n)
}

func (p *pdfWriter) obj(num int, body string) {
	p.offs[num] = p.pos
	p.out(fmt.Sprintf("%d 0 obj\n%s\nendobj\n", num, body))
}

func (p *pdfWriter) stream(num int, dict string, data []byte) {
	p.offs[num] = p.pos
	p.out(fmt.Sprintf("%d 0 obj\n<<%s /Length %d>>\nstream\n", num, dict, len(data)))
	n, _ := p.w.Write(data)
	p.pos += int64(n)
	p.out("\nendstream\nendobj\n")
}

func (p *pdfWriter) addPage(im *pdfImg, o ImgPDFOpts) {
	imgN, contN, pageN := p.next, p.next+1, p.next+2
	p.next += 3
	cs := "/DeviceRGB"
	if im.gray {
		cs = "/DeviceGray"
	}
	p.stream(imgN, fmt.Sprintf("/Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace %s /BitsPerComponent 8 /Filter /%s",
		im.w, im.h, cs, im.filter), im.data)
	dw, dh := im.shown()
	pw, ph, x, y, w, h := pageLayout(o, dw, dh)
	u0, us, ut, v0, vs, vt := orientMatrix(im.orient)
	cm := strings.Join([]string{pf(w * us), pf(h * vs), pf(w * ut), pf(h * vt), pf(x + w*u0), pf(y + h*v0)}, " ")
	p.stream(contN, "", []byte("q "+cm+" cm /Im0 Do Q"))
	p.obj(pageN, fmt.Sprintf("<</Type /Page /Parent %d 0 R /MediaBox [0 0 %s %s] /Resources <</XObject <</Im0 %d 0 R>>>> /Contents %d 0 R>>",
		p.pages, pf(pw), pf(ph), imgN, contN))
	p.kids = append(p.kids, pageN)
}

func (p *pdfWriter) finish() error {
	var kids strings.Builder
	for i, k := range p.kids {
		if i > 0 {
			kids.WriteByte(' ')
		}
		fmt.Fprintf(&kids, "%d 0 R", k)
	}
	p.obj(p.pages, fmt.Sprintf("<</Type /Pages /Kids [%s] /Count %d>>", kids.String(), len(p.kids)))
	p.obj(1, fmt.Sprintf("<</Type /Catalog /Pages %d 0 R>>", p.pages))
	info := p.next
	p.next++
	p.obj(info, "<</Producer (Kombain)>>")
	xref := p.pos
	p.out(fmt.Sprintf("xref\n0 %d\n0000000000 65535 f \n", p.next))
	for n := 1; n < p.next; n++ {
		p.out(fmt.Sprintf("%010d 00000 n \n", p.offs[n]))
	}
	p.out(fmt.Sprintf("trailer\n<</Size %d /Root 1 0 R /Info %d 0 R>>\nstartxref\n%d\n%%%%EOF\n", p.next, info, xref))
	return p.w.Flush()
}

// imgPDFJob: один выходной PDF; пишется во временный .part и переименовывается в конце
type imgPDFJob struct {
	dst string
	f   *os.File
	pw  *pdfWriter
}

func openImgPDF(dst string) (*imgPDFJob, error) {
	f, err := os.Create(dst + ".part")
	if err != nil {
		return nil, err
	}
	return &imgPDFJob{dst: dst, f: f, pw: newPDFWriter(f)}, nil
}

func (j *imgPDFJob) abort() {
	j.f.Close()
	os.Remove(j.dst + ".part")
}

func (j *imgPDFJob) close() error {
	err := j.pw.finish()
	if e := j.f.Close(); err == nil {
		err = e
	}
	if err == nil {
		err = os.Rename(j.dst+".part", j.dst)
	}
	if err != nil {
		os.Remove(j.dst + ".part")
	}
	return err
}

// imgPDFName: имя общего PDF — по папке, где лежат все картинки, иначе по первой картинке
func imgPDFName(files []string) string {
	dir := filepath.Dir(files[0])
	same := !isTemp(files[0])
	for _, f := range files[1:] {
		if !strings.EqualFold(filepath.Dir(f), dir) {
			same = false
		}
	}
	if b := filepath.Base(dir); same && len(files) > 1 && b != "." && b != string(filepath.Separator) && !strings.HasSuffix(b, ":\\") && !strings.HasSuffix(b, ":") {
		return b
	}
	return fileStem(files[0])
}

// runImg2PDF: картинки по порядку из списка; битые пропускаются с ошибкой у файла
func (s *Server) runImg2PDF(c context.Context, states []*FileState, req PDFReq) (ok, bad int) {
	o := req.Img
	used := map[string]bool{}
	var job *imgPDFJob
	var pages []int // номера состояний в общем PDF
	fail := func(i int, err error) {
		bad++
		msg := tr("pdf.imgBad")
		if errors.Is(err, errImgTooBig) {
			msg = tr("pdf.imgTooBig")
		} else if errors.Is(err, os.ErrNotExist) {
			msg = tr("pdf.noFile")
		}
		s.set(i, func(fs *FileState) { fs.Status = "error"; fs.Msg = msg; fs.Hint = msg })
		s.addLog("[pdf] %s: %v", states[i].Name, err)
	}
	for i, st := range states {
		if c.Err() != nil {
			break
		}
		s.set(i, func(fs *FileState) { fs.Status = "running" })
		im, err := prepImage(st.Path, o.Quality)
		if err != nil {
			fail(i, err)
			continue
		}
		if o.Separate {
			dst := outPathNamed(st.Path, fileStem(st.Path), ".pdf", StartReq{SameDir: req.SameDir, OutDir: req.OutDir, Copy: true}, used)
			j, err := openImgPDF(dst)
			if err == nil {
				j.pw.addPage(im, o)
				err = j.close()
			}
			if err != nil {
				fail(i, err)
				continue
			}
			ok++
			size := fileSize(dst)
			msg := fmt.Sprintf("%s → %s", fmtKB(st.SrcSize), fmtKB(size))
			s.set(i, func(fs *FileState) { fs.Status = "ok"; fs.Pct = 100; fs.Dst = dst; fs.DstSize = size; fs.Msg = msg })
			s.addLog("[pdf] %s → %s", st.Name, dst)
			continue
		}
		if job == nil {
			var paths []string
			for _, x := range states {
				paths = append(paths, x.Path)
			}
			dst := outPathNamed(st.Path, imgPDFName(paths), ".pdf", StartReq{SameDir: req.SameDir, OutDir: req.OutDir, Copy: true}, used)
			if job, err = openImgPDF(dst); err != nil {
				job = nil
				fail(i, err)
				continue
			}
		}
		job.pw.addPage(im, o)
		pages = append(pages, i)
		n := len(pages)
		s.set(i, func(fs *FileState) { fs.Pct = 100; fs.Msg = tr("pdf.imgPage", n) })
	}
	if job == nil {
		return
	}
	if c.Err() != nil {
		job.abort()
		return
	}
	if err := job.close(); err != nil {
		for _, i := range pages {
			fail(i, err)
		}
		return
	}
	size := fileSize(job.dst)
	for _, i := range pages {
		ok++
		s.set(i, func(fs *FileState) { fs.Status = "ok"; fs.Dst = job.dst; fs.DstSize = size })
	}
	s.addLog("[pdf] %d → %s", len(pages), job.dst)
	return
}
