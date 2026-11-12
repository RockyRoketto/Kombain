package main

import (
	"context"
	"image"
	"image/color"
	gopng "image/png"
	"os"
	"path/filepath"
	"testing"
)

func TestPDFDecorAll(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "Отчёт.pdf")
	pdfMiniW(t, src, 300, 300, 300)
	dst := filepath.Join(dir, "out.pdf")
	var d PDFDecor
	d.WM.On, d.WM.Kind, d.WM.Text, d.WM.Rotate, d.WM.OnTop = true, "text", "Черновик", 45, true
	d.Num.On, d.Num.Format, d.Num.Pos = true, "Стр. %p из %P", "bc"
	d.Num.SkipFirst = true
	d.Meta.On, d.Meta.Title, d.Meta.Author = true, "Отчёт", "Дмитрий"
	d.Crop.On, d.Crop.Top, d.Crop.Bottom = true, 5, 5
	if _, err := pdfDecor(context.Background(), src, dst, "", d); err != nil {
		t.Fatal(err)
	}
	if inf := pdfInfo(context.Background(), dst, ""); inf.Pages != 3 || inf.Error != "" {
		t.Fatalf("%+v", inf)
	}
	ctx, _ := pdfOpen(context.Background(), dst, "")
	p := map[string]string{"Title": ctx.Title, "Author": ctx.Author}
	t.Logf("props %v size %d", p, fileSize(dst))
	if p["Title"] != "Отчёт" || p["Author"] != "Дмитрий" {
		t.Fatalf("props %v", p)
	}
}

func TestPDFDecorPassword(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "а.pdf")
	pdfMiniW(t, src, 300, 300)
	c := context.Background()
	var d PDFDecor
	d.Pass.Mode, d.Pass.New = "set", "пароль1"
	closed := filepath.Join(dir, "closed.pdf")
	if _, err := pdfDecor(c, src, closed, "", d); err != nil {
		t.Fatal(err)
	}
	if inf := pdfInfo(c, closed, ""); !inf.NeedPass {
		t.Fatalf("not locked %+v", inf)
	}
	if inf := pdfInfo(c, closed, "пароль1"); inf.Pages != 2 {
		t.Fatalf("wrong pw %+v", inf)
	}
	// водяной знак на закрытом файле: остаётся закрытым тем же паролем
	var w PDFDecor
	w.WM.On, w.WM.Kind, w.WM.Text = true, "text", "Копия"
	wm := filepath.Join(dir, "wm.pdf")
	if _, err := pdfDecor(c, closed, wm, "пароль1", w); err != nil {
		t.Fatal(err)
	}
	if inf := pdfInfo(c, wm, ""); !inf.NeedPass {
		t.Fatalf("wm lost password %+v", inf)
	}
	// смена пароля
	var ch PDFDecor
	ch.Pass.Mode, ch.Pass.New = "set", "другой"
	re := filepath.Join(dir, "re.pdf")
	if _, err := pdfDecor(c, closed, re, "пароль1", ch); err != nil {
		t.Fatal(err)
	}
	if inf := pdfInfo(c, re, "другой"); inf.Pages != 2 {
		t.Fatalf("changed %+v", inf)
	}
	// снять
	var rm PDFDecor
	rm.Pass.Mode = "remove"
	open := filepath.Join(dir, "open.pdf")
	if _, err := pdfDecor(c, closed, open, "пароль1", rm); err != nil {
		t.Fatal(err)
	}
	if inf := pdfInfo(c, open, ""); inf.NeedPass || inf.Pages != 2 || inf.Encrypted {
		t.Fatalf("not removed %+v", inf)
	}
	// неверный пароль
	if _, err := pdfDecor(c, closed, filepath.Join(dir, "x.pdf"), "не тот", rm); err == nil {
		t.Fatal("wrong password accepted")
	}
}

// картинка как водяной знак; закрытый файл с кириллическим именем остаётся закрытым
func TestPDFDecorImage(t *testing.T) {
	dir := t.TempDir()
	png := filepath.Join(dir, "знак.png")
	im := image.NewNRGBA(image.Rect(0, 0, 60, 30))
	for x := 0; x < 60; x++ {
		for y := 0; y < 30; y++ {
			im.Set(x, y, color.NRGBA{200, 30, 30, 255})
		}
	}
	f, _ := os.Create(png)
	if err := gopng.Encode(f, im); err != nil {
		t.Fatal(err)
	}
	f.Close()
	src := filepath.Join(dir, "Отчёт.pdf")
	pdfMiniW(t, src, 300, 300)
	var d PDFDecor
	d.WM.On, d.WM.Kind, d.WM.Image, d.WM.Pos = true, "image", png, "br"
	dst := filepath.Join(dir, "o.pdf")
	if _, err := pdfDecor(context.Background(), src, dst, "", d); err != nil {
		t.Fatal(err)
	}
	if inf := pdfInfo(context.Background(), dst, ""); inf.Pages != 2 || inf.Error != "" {
		t.Fatalf("%+v", inf)
	}
	// без картинки и без текста: понятная ошибка, файл не создаётся
	d.WM.Image = ""
	if _, err := pdfDecor(context.Background(), src, filepath.Join(dir, "x.pdf"), "", d); err == nil {
		t.Fatal("empty watermark accepted")
	}
}
