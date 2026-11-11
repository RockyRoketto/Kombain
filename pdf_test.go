package main

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
)

// pdfMini: простейший PDF на n страниц, собранный вручную (смещения в xref считаются)
func pdfMini(t *testing.T, path string, n int) {
	t.Helper()
	var objs []string
	kids := ""
	for i := 0; i < n; i++ {
		kids += " " + strconv.Itoa(3+i) + " 0 R"
	}
	objs = append(objs, "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids ["+kids+" ] /Count "+strconv.Itoa(n)+" >>")
	for i := 0; i < n; i++ {
		objs = append(objs, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>")
	}
	b := []byte("%PDF-1.4\n")
	var offs []int
	for i, o := range objs {
		offs = append(offs, len(b))
		b = append(b, []byte(strconv.Itoa(i+1)+" 0 obj\n"+o+"\nendobj\n")...)
	}
	x := len(b)
	b = append(b, []byte("xref\n0 "+strconv.Itoa(len(objs)+1)+"\n0000000000 65535 f \n")...)
	for _, off := range offs {
		s := strconv.Itoa(off)
		for len(s) < 10 {
			s = "0" + s
		}
		b = append(b, []byte(s+" 00000 n \n")...)
	}
	b = append(b, []byte("trailer\n<< /Size "+strconv.Itoa(len(objs)+1)+" /Root 1 0 R >>\nstartxref\n"+strconv.Itoa(x)+"\n%%EOF\n")...)
	if err := os.WriteFile(path, b, 0o644); err != nil {
		t.Fatal(err)
	}
}

// кириллица и пробелы в имени и папке: прочитать, пересобрать рядом с оригиналом, не затерев его
func TestPDFCyrillicName(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "Папка с PDF")
	os.MkdirAll(dir, 0o755)
	src := filepath.Join(dir, "Отчёт № 1 (итог).pdf")
	pdfMini(t, src, 3)
	c := context.Background()

	inf := pdfInfo(c, src, "")
	if inf.Error != "" || inf.Pages != 3 || inf.NeedPass {
		t.Fatalf("pdfInfo: %+v", inf)
	}
	got := pdfList([]string{filepath.Dir(dir)})
	if len(got) != 1 || got[0].Path != src {
		t.Fatalf("pdfList: %+v", got)
	}

	req := PDFReq{Op: "resave", SameDir: true}
	used := map[string]bool{}
	dst := pdfOutPath(src, req, used)
	if dst != filepath.Join(dir, "Отчёт № 1 (итог) (1).pdf") {
		t.Fatalf("pdfOutPath: %s", dst)
	}
	if err := pdfResave(c, src, dst, ""); err != nil {
		t.Fatal(err)
	}
	if inf := pdfInfo(c, dst, ""); inf.Pages != 3 {
		t.Fatalf("result: %+v", inf)
	}
	if _, err := os.Stat(dst + ".part"); err == nil {
		t.Fatal(".part left behind")
	}
	// второй файл с тем же именем не затирает первый
	if d2 := pdfOutPath(src, req, map[string]bool{}); d2 != filepath.Join(dir, "Отчёт № 1 (итог) (2).pdf") {
		t.Fatalf("second: %s", d2)
	}
	// своя папка
	out := filepath.Join(t.TempDir(), "Готово")
	if d := pdfOutPath(src, PDFReq{OutDir: out}, map[string]bool{}); d != filepath.Join(out, "Отчёт № 1 (итог).pdf") {
		t.Fatalf("outDir: %s", d)
	}
}

func TestPDFPassword(t *testing.T) {
	dir := t.TempDir()
	src, enc := filepath.Join(dir, "открытый.pdf"), filepath.Join(dir, "закрытый.pdf")
	pdfMini(t, src, 2)
	conf := model.NewAESConfiguration("секрет", "секрет", 256)
	if err := api.EncryptFile(context.Background(), src, enc, conf); err != nil {
		t.Fatal(err)
	}
	c := context.Background()
	if inf := pdfInfo(c, enc, ""); !inf.NeedPass {
		t.Fatalf("no password: %+v", inf)
	}
	if inf := pdfInfo(c, enc, "не тот"); !inf.NeedPass {
		t.Fatalf("wrong password: %+v", inf)
	}
	if inf := pdfInfo(c, enc, "секрет"); inf.NeedPass || inf.Pages != 2 || !inf.Encrypted {
		t.Fatalf("right password: %+v", inf)
	}
	if err := pdfResave(c, enc, filepath.Join(dir, "out.pdf"), ""); err != errPDFPassword {
		t.Fatalf("resave without password: %v", err)
	}
	if err := pdfResave(c, enc, filepath.Join(dir, "out.pdf"), "секрет"); err != nil {
		t.Fatalf("resave with password: %v", err)
	}
}

func TestPDFBroken(t *testing.T) {
	p := filepath.Join(t.TempDir(), "битый.pdf")
	os.WriteFile(p, []byte("это не PDF"), 0o644)
	if inf := pdfInfo(context.Background(), p, ""); inf.Error == "" {
		t.Fatalf("broken: %+v", inf)
	}
}
