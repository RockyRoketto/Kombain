package main

import (
	"bytes"
	"compress/zlib"
	"context"
	"image"
	"image/jpeg"
	"math"
	"math/rand/v2"
	"os"
	"path/filepath"
	"testing"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/types"
)

// testScan: «скан» w×h — плавный фон с шумом, как у бумаги, и тёмные полосы-строки
func testScan(w, h int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	r := rand.New(rand.NewPCG(1, 2))
	for y := range h {
		for x := range w {
			v := 225 + int(20*math.Sin(float64(x+y)/90)) + r.IntN(18) - 9
			if (y/12)%3 == 0 && (x/7)%5 != 0 {
				v = 40 + r.IntN(30)
			}
			v = min(255, max(0, v))
			i := img.PixOffset(x, y)
			img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3] = byte(v), byte(v-8), byte(v-20), 255
		}
	}
	return img
}

// testScanPDF: PDF из двух страниц A4 без полей: JPEG 95 и сырые RGB во Flate
func testScanPDF(t *testing.T, path string, w, h int) {
	t.Helper()
	img := testScan(w, h)
	var jb bytes.Buffer
	if err := jpeg.Encode(&jb, img, &jpeg.Options{Quality: 95}); err != nil {
		t.Fatal(err)
	}
	var fb bytes.Buffer
	zw := zlib.NewWriter(&fb)
	for i := 0; i < len(img.Pix); i += 4 {
		zw.Write(img.Pix[i : i+3])
	}
	zw.Close()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	p := newPDFWriter(f)
	o := ImgPDFOpts{Page: "a4", Orient: "auto"}
	p.addPage(&pdfImg{data: jb.Bytes(), filter: "DCTDecode", w: w, h: h, orient: 1}, o)
	p.addPage(&pdfImg{data: fb.Bytes(), filter: "FlateDecode", w: w, h: h, orient: 1}, o)
	if err := p.finish(); err != nil {
		t.Fatal(err)
	}
}

// pdfImgDims: размеры и цвет всех картинок в файле
func pdfImgDims(t *testing.T, path string) (out [][3]string) {
	t.Helper()
	ctx, err := api.ReadContextFile(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	if err := api.ValidateContext(context.Background(), ctx); err != nil {
		t.Fatalf("не проходит проверку: %v", err)
	}
	for _, e := range ctx.XRefTable.Table {
		if sd, ok := e.Object.(types.StreamDict); ok {
			if st := sd.Subtype(); st != nil && *st == "Image" {
				out = append(out, [3]string{sd.Dict["Width"].String(), sd.Dict["Height"].String(), sd.Dict["ColorSpace"].String()})
			}
		}
	}
	return
}

func TestPDFCompressScan(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "Скан договора.pdf")
	testScanPDF(t, src, 1240, 1754) // A4 при 150 dpi
	before := fileSize(src)

	// средний пресет: DPI 200 больше исходных 150 — размер прежний, только качество
	dst := filepath.Join(dir, "medium.pdf")
	st, err := pdfCompress(context.Background(), src, dst, "", PDFCompress{Preset: "medium"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	after := fileSize(dst)
	t.Logf("medium: %d → %d, картинок %d, пережато %d", before, after, st.Images, st.Recoded)
	if st.Images != 2 || st.Recoded != 2 || after*2 > before {
		t.Fatalf("medium: картинок %d, пережато %d, %d → %d", st.Images, st.Recoded, before, after)
	}
	for _, d := range pdfImgDims(t, dst) {
		if d[0] != "1240" || d[1] != "1754" {
			t.Fatalf("medium не должен уменьшать: %v", d)
		}
	}

	// свой: 72 dpi на A4 — 595×842, оттенки серого
	dst = filepath.Join(dir, "custom.pdf")
	if _, err := pdfCompress(context.Background(), src, dst, "", PDFCompress{Preset: "custom", Quality: 60, DPI: 72, Color: "gray", Strip: true}, nil); err != nil {
		t.Fatal(err)
	}
	for _, d := range pdfImgDims(t, dst) {
		if d[0] != "595" || d[1] != "842" || d[2] != "DeviceGray" {
			t.Fatalf("custom: %v", d)
		}
	}
	if after2 := fileSize(dst); after2 >= after {
		t.Fatalf("72 dpi серое не меньше среднего: %d ≥ %d", after2, after)
	}

	// чёрно-белое: 1 бит
	dst = filepath.Join(dir, "bw.pdf")
	if _, err := pdfCompress(context.Background(), src, dst, "", PDFCompress{Preset: "strong", Color: "bw"}, nil); err != nil {
		t.Fatal(err)
	}
	ctx, err := api.ReadContextFile(context.Background(), dst)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range ctx.XRefTable.Table {
		if sd, ok := e.Object.(types.StreamDict); ok && sd.Subtype() != nil && *sd.Subtype() == "Image" {
			if b := sd.IntEntry("BitsPerComponent"); b == nil || *b != 1 {
				t.Fatalf("ч/б: BitsPerComponent %v", sd.Dict["BitsPerComponent"])
			}
		}
	}
}

// PDF без картинок: ошибок нет, картинок 0
func TestPDFCompressNoImages(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "текст.pdf")
	pdfMini(t, src, 3)
	dst := filepath.Join(dir, "out.pdf")
	st, err := pdfCompress(context.Background(), src, dst, "", PDFCompress{Preset: "strong", Strip: true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if st.Images != 0 || st.Recoded != 0 {
		t.Fatalf("%+v", st)
	}
	if _, err := api.ReadContextFile(context.Background(), dst); err != nil {
		t.Fatal(err)
	}
}

// уже сжатый файл: прогон оставляет оригинал и пишет «как есть»
func TestRunCompressKept(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "a.pdf")
	testScanPDF(t, src, 600, 848)
	small := filepath.Join(dir, "small.pdf")
	if _, err := pdfCompress(context.Background(), src, small, "", PDFCompress{Preset: "strong", Color: "gray"}, nil); err != nil {
		t.Fatal(err)
	}
	s := &Server{}
	s.files = []*FileState{{Path: small, Name: "small.pdf", SrcSize: fileSize(small)}}
	ok, bad, before, after := s.runCompress(context.Background(), s.files, PDFReq{SameDir: true, Comp: PDFCompress{Preset: "light"}})
	if ok != 0 || bad != 0 || s.files[0].Status != "kept" || before != after {
		t.Fatalf("ok %d bad %d status %s %d→%d", ok, bad, s.files[0].Status, before, after)
	}
	if m, _ := filepath.Glob(filepath.Join(dir, "small (*).pdf")); len(m) != 0 {
		t.Fatalf("лишний файл: %v", m)
	}
}

// размер картинки на странице: cm, q/Q и вложенная форма со своей матрицей
func TestPDFImageSizes(t *testing.T) {
	var got []string
	pdfScanContent([]byte("q 1 0 0 1 5 5 cm (a\\) b (c)) Tj [(x) 3 (y)] TJ <</MCID 0>> BDC BI /W 2 /H 2 ID \x00EI\x01 EI Q 200 0 0 100 0 0 cm /Im#201 Do % comment Do\n"), func(n string, a []string) {
		if n == "cm" || n == "Do" {
			got = append(got, n+":"+a[len(a)-1])
		}
	})
	want := []string{"cm:5", "cm:0", "Do:/Im#201"}
	if len(got) != len(want) {
		t.Fatalf("%v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("%v", got)
		}
	}
	if pdfName("/Im#201") != "Im 1" {
		t.Fatal(pdfName("/Im#201"))
	}
	m := pdfMat{0.5, 0, 0, 0.5, 10, 10}.mul(pdfMat{2, 0, 0, 4, 0, 0})
	if m != (pdfMat{1, 0, 0, 2, 20, 40}) {
		t.Fatalf("%v", m)
	}
}

// закрытый паролем: без пароля понятная ошибка, с паролем сжимается и остаётся закрытым
func TestPDFCompressPassword(t *testing.T) {
	dir := t.TempDir()
	src, enc := filepath.Join(dir, "скан.pdf"), filepath.Join(dir, "закрытый.pdf")
	testScanPDF(t, src, 600, 848)
	if err := api.EncryptFile(context.Background(), src, enc, model.NewAESConfiguration("секрет", "секрет", 256)); err != nil {
		t.Fatal(err)
	}
	c, dst := context.Background(), filepath.Join(dir, "out.pdf")
	if _, err := pdfCompress(c, enc, dst, "", PDFCompress{Preset: "strong"}, nil); err != errPDFPassword {
		t.Fatalf("без пароля: %v", err)
	}
	st, err := pdfCompress(c, enc, dst, "секрет", PDFCompress{Preset: "strong"}, nil)
	if err != nil || st.Recoded != 2 {
		t.Fatalf("с паролем: %v %+v", err, st)
	}
	if inf := pdfInfo(c, dst, ""); !inf.NeedPass {
		t.Fatalf("результат без пароля открылся: %+v", inf)
	}
	if inf := pdfInfo(c, dst, "секрет"); inf.Pages != 2 || fileSize(dst) >= fileSize(enc) {
		t.Fatalf("результат: %+v, %d ≥ %d", inf, fileSize(dst), fileSize(enc))
	}
}
