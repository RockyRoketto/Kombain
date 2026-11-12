package main

import (
	"bytes"
	"context"
	"image"
	"image/jpeg"
	"math"
	"os"
	"path/filepath"
	"testing"
)

// testScansPDF: n страниц A4 со «сканами» w×h в JPEG 95, на каждой свой кусок, чтобы повторы не склеились
func testScansPDF(t *testing.T, path string, n, w, h int) {
	t.Helper()
	img := testScan(w, h+n*7)
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	p := newPDFWriter(f)
	for i := range n {
		var jb bytes.Buffer
		if err := jpeg.Encode(&jb, img.SubImage(image.Rect(0, i*7, w, i*7+h)), &jpeg.Options{Quality: 95}); err != nil {
			t.Fatal(err)
		}
		p.addPage(&pdfImg{data: jb.Bytes(), filter: "DCTDecode", w: w, h: h, orient: 1}, ImgPDFOpts{Page: "a4", Orient: "auto"})
	}
	if err := p.finish(); err != nil {
		t.Fatal(err)
	}
}

func relErr(est, real int64) float64 { return math.Abs(float64(est-real)) / float64(real) }

// все картинки в пробе — оценка совпадает с настоящим сжатием почти до байта
func TestPDFEstimateExact(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "скан.pdf")
	testScanPDF(t, src, 1240, 1754)
	for _, o := range []PDFCompress{{Preset: "medium"}, {Preset: "custom", Quality: 40, DPI: 72, Color: "gray", Strip: true}, {Preset: "strong", Color: "bw"}} {
		r := pdfEstimate(context.Background(), src, "", o)
		dst := filepath.Join(dir, "out.pdf")
		if _, err := pdfCompress(context.Background(), src, dst, "", o, nil); err != nil {
			t.Fatal(err)
		}
		real := fileSize(dst)
		os.Remove(dst)
		t.Logf("%+v: оценка %d, вышло %d", o, r.Size, real)
		if r.Error != "" || !r.Exact || r.Images != 2 || r.Kept || relErr(r.Size, real) > 0.01 {
			t.Fatalf("%+v: %+v, вышло %d", o, r, real)
		}
	}
}

// картинок больше пробы — оценка примерная, но близкая
func TestPDFEstimateSampled(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "many.pdf")
	testScansPDF(t, src, 14, 620, 877)
	o := PDFCompress{Preset: "strong"}
	r := pdfEstimate(context.Background(), src, "", o)
	dst := filepath.Join(dir, "out.pdf")
	if _, err := pdfCompress(context.Background(), src, dst, "", o, nil); err != nil {
		t.Fatal(err)
	}
	real := fileSize(dst)
	t.Logf("оценка %d, вышло %d, исходник %d", r.Size, real, r.Src)
	if r.Exact || r.Images != 14 || relErr(r.Size, real) > 0.05 {
		t.Fatalf("%+v, вышло %d", r, real)
	}
}

// без картинок: оценка есть, сжимать нечего — «как есть»; пароль не задан — needPass
func TestPDFEstimateNoImagesAndPassword(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "текст.pdf")
	pdfMini(t, src, 3)
	r := pdfEstimate(context.Background(), src, "", PDFCompress{Preset: "strong"})
	if r.Error != "" || r.Images != 0 || r.Size <= 0 {
		t.Fatalf("%+v", r)
	}
	if r := pdfEstimate(context.Background(), filepath.Join(dir, "нет.pdf"), "", PDFCompress{}); r.Error == "" {
		t.Fatalf("нет файла: %+v", r)
	}
}

// «сжать до N МБ»: укладывается — файл не больше цели; уже меньше — как есть; никак — честно говорит
func TestRunCompressTarget(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "скан.pdf")
	testScansPDF(t, src, 6, 1240, 1754)
	srcSize := fileSize(src)
	run := func(mb float64) *FileState {
		s := &Server{}
		s.files = []*FileState{{Path: src, Name: "скан.pdf", SrcSize: srcSize}}
		s.runCompress(context.Background(), s.files, PDFReq{SameDir: true, Comp: PDFCompress{Preset: "target", Target: mb}})
		return s.files[0]
	}
	// цель — треть исходника
	mb := float64(srcSize) / 3 / (1 << 20)
	r := pdfEstimate(context.Background(), src, "", PDFCompress{Preset: "target", Target: mb})
	fs := run(mb)
	t.Logf("цель %.2f МБ из %d: оценка %+v; %s %s", mb, srcSize, r, fs.Status, fs.Msg)
	if !r.Fit || fs.Status != "ok" || fs.DstSize > int64(mb*(1<<20)) || fs.Hint != "" {
		t.Fatalf("%+v %+v", r, fs)
	}
	os.Remove(fs.Dst)

	// цель больше файла — оставить как есть, ничего не писать
	if fs := run(float64(srcSize)/(1<<20) + 1); fs.Status != "kept" {
		t.Fatalf("уже меньше: %+v", fs)
	}
	// 1 КБ не достать никак
	r = pdfEstimate(context.Background(), src, "", PDFCompress{Preset: "target", Target: 0.001})
	if r.Fit {
		t.Fatalf("1 КБ: %+v", r)
	}
	fs = run(0.05)
	t.Logf("50 КБ: %s %s", fs.Status, fs.Msg)
	if fs.Status != "ok" || fs.Hint == "" {
		t.Fatalf("50 КБ: %+v", fs)
	}
}
