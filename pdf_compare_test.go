package main

import (
	"bytes"
	"context"
	"path/filepath"
	"slices"
	"testing"

	"github.com/pdfcpu/pdfcpu/pkg/api"
)

// файл: страница без картинок, две страницы со сканами, ещё одна без картинок
func testMixedPDF(t *testing.T, dir string) string {
	t.Helper()
	txt, scan, out := filepath.Join(dir, "t.pdf"), filepath.Join(dir, "s.pdf"), filepath.Join(dir, "смесь.pdf")
	pdfMini(t, txt, 1)
	testScanPDF(t, scan, 900, 1200)
	if err := api.MergeCreateFile(context.Background(), []string{txt, scan, txt}, out, false, nil); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestPDFPageMarks(t *testing.T) {
	src := testMixedPDF(t, t.TempDir())
	r := pdfPageMarks(context.Background(), src, "")
	if r.Error != "" || r.Pages != 4 || !slices.Equal(r.Img, []int{2, 3}) || !slices.Equal(r.Any, []int{2, 3}) {
		t.Fatalf("%+v", r)
	}
}

func TestPDFComparePage(t *testing.T) {
	src := testMixedPDF(t, t.TempDir())
	c := context.Background()
	r, out := pdfComparePage(c, src, "", PDFCompress{Preset: "strong"}, 2, 0, 0)
	if r.Error != "" || r.Images != 1 || r.Recoded != 1 || r.After >= r.Before || r.Quality != 50 || r.DPI != 150 {
		t.Fatalf("%+v", r)
	}
	n, err := api.PageCount(c, bytes.NewReader(out), nil)
	if err != nil || n != 1 {
		t.Fatalf("страница не прочиталась: %d %v", n, err)
	}
	// страница без картинок: сравнивать нечего, но страница есть
	r, out = pdfComparePage(c, src, "", PDFCompress{Preset: "strong"}, 1, 0, 0)
	if r.Error != "" || r.Images != 0 || r.Recoded != 0 || len(out) == 0 {
		t.Fatalf("%+v", r)
	}
	// «До размера» с готовой ступенью из прогноза
	r, _ = pdfComparePage(c, src, "", PDFCompress{Preset: "target", Target: 0.1}, 3, 40, 96)
	if r.Error != "" || r.Quality != 40 || r.DPI != 96 || r.Recoded != 1 {
		t.Fatalf("%+v", r)
	}
	// нет такой страницы
	if r, _ = pdfComparePage(c, src, "", PDFCompress{}, 9, 0, 0); r.Error == "" {
		t.Fatal("ждали ошибку")
	}
	// одна ячейка: новая страница заменяет прежнюю
	a := pdfCompareOne(c, src, "", PDFCompress{}, 2, 0, 0)
	b := pdfCompareOne(c, src, "", PDFCompress{}, 3, 0, 0)
	if a.ID == "" || b.ID == a.ID || pdfCmpGet(a.ID) != nil || pdfCmpGet(b.ID) == nil {
		t.Fatalf("%+v %+v", a, b)
	}
	pdfCmpDrop()
	if pdfCmpGet(b.ID) != nil {
		t.Fatal("после закрытия страница осталась")
	}
}

// «После» для «Оформления»: одна страница с водяным знаком, номером «2 из 3» и обрезкой
func TestPDFDecorPage(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "Отчёт.pdf")
	pdfMiniW(t, src, 300, 300, 300)
	c := context.Background()
	var d PDFDecor
	d.WM.On, d.WM.Kind, d.WM.Text = true, "text", "Черновик"
	d.Num.On, d.Num.Format, d.Num.SkipFirst = true, "%p / %P", true
	d.Crop.On, d.Crop.Top = true, 20
	d.Pass.Mode, d.Pass.New = "set", "не применяется"
	r, out := pdfDecorPage(c, src, "", d, 2)
	if r.Error != "" || len(out) == 0 {
		t.Fatalf("%+v", r)
	}
	n, err := api.PageCount(c, bytes.NewReader(out), nil)
	if err != nil || n != 1 {
		t.Fatalf("страница не прочиталась: %d %v", n, err)
	}
	// первая страница при «не ставить на первой»: номер пропускается, остальное есть
	if r, out = pdfDecorPage(c, src, "", d, 1); r.Error != "" || len(out) == 0 {
		t.Fatalf("%+v", r)
	}
	if r, _ = pdfDecorPage(c, src, "", d, 5); r.Error == "" {
		t.Fatal("ждали ошибку")
	}
	a := pdfDecorOne(c, src, "", d, 3)
	if a.ID == "" || pdfCmpGet(a.ID) == nil {
		t.Fatalf("%+v", a)
	}
	pdfCmpDrop()
}
