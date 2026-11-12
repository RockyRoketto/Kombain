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

// pdfMiniW: PDF, у которого страницы различаются шириной (по ней в тестах узнаём страницу)
func pdfMiniW(t *testing.T, path string, widths ...int) {
	t.Helper()
	n := len(widths)
	kids := ""
	for i := 0; i < n; i++ {
		kids += " " + strconv.Itoa(3+i) + " 0 R"
	}
	objs := []string{"<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [" + kids + " ] /Count " + strconv.Itoa(n) + " >>"}
	for _, w := range widths {
		objs = append(objs, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 "+strconv.Itoa(w)+" 200] >>")
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

// ширины страниц результата с учётом поворота (после поворота на 90° ширина и высота меняются местами)
func pdfWidths(t *testing.T, path, pw string) []int {
	t.Helper()
	ctx, err := pdfOpen(context.Background(), path, pw)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	dims, err := ctx.PageDims(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var w []int
	for _, d := range dims {
		w = append(w, int(d.Width))
	}
	return w
}

func eqInts(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// два PDF в нужном порядке: страницы вперемешку, повторы, поворот, пропуск; кириллица в именах
func TestPDFPagesMerge(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "Папка с PDF")
	os.MkdirAll(dir, 0o755)
	a, b := filepath.Join(dir, "Первый №1.pdf"), filepath.Join(dir, "Второй.pdf")
	pdfMiniW(t, a, 101, 102, 103)
	pdfMiniW(t, b, 201, 202)
	refs := []PDFPageRef{{a, 3, 0}, {b, 2, 0}, {a, 1, 0}, {a, 1, 90}, {b, 1, 0}}
	dst := filepath.Join(dir, "итог.pdf")
	if err := pdfBuildPages(context.Background(), refs, dst, "", nil); err != nil {
		t.Fatal(err)
	}
	// после поворота дубля страницы 101 ширина 200 (высота исходной), остальные как были
	if got, want := pdfWidths(t, dst, ""), []int{103, 202, 101, 200, 201}; !eqInts(got, want) {
		t.Fatalf("widths %v, want %v", got, want)
	}
	if _, err := os.Stat(dst + ".part"); err == nil {
		t.Fatal(".part left behind")
	}
	if err := api.ValidateFile(context.Background(), dst, pdfConf(""), nil); err != nil {
		t.Fatalf("validate: %v", err)
	}
	// оригиналы не тронуты
	if w := pdfWidths(t, a, ""); !eqInts(w, []int{101, 102, 103}) {
		t.Fatalf("source changed: %v", w)
	}
}

// ошибки: страницы за пределами файла, пустой список, битый файл
func TestPDFPagesErrors(t *testing.T) {
	dir := t.TempDir()
	a := filepath.Join(dir, "a.pdf")
	pdfMiniW(t, a, 101, 102)
	c := context.Background()
	if err := pdfBuildPages(c, []PDFPageRef{{a, 3, 0}}, filepath.Join(dir, "o.pdf"), "", nil); err == nil {
		t.Fatal("page 3 of 2 accepted")
	}
	if err := pdfBuildPages(c, nil, filepath.Join(dir, "o.pdf"), "", nil); err == nil {
		t.Fatal("empty plan accepted")
	}
	bad := filepath.Join(dir, "битый.pdf")
	os.WriteFile(bad, []byte("не PDF"), 0o644)
	if err := pdfBuildPages(c, []PDFPageRef{{a, 1, 0}, {bad, 1, 0}}, filepath.Join(dir, "o.pdf"), "", nil); err == nil {
		t.Fatal("broken source accepted")
	}
	if _, err := os.Stat(filepath.Join(dir, "o.pdf")); err == nil {
		t.Fatal("result left after error")
	}
	if _, err := pdfPagesPlan(PDFPagesOpts{Docs: []PDFPagesDoc{{Pages: []PDFPageRef{{"чужой.pdf", 1, 0}}}}}, []string{a}); err == nil {
		t.Fatal("foreign source accepted")
	}
	if _, err := pdfPagesPlan(PDFPagesOpts{Docs: []PDFPagesDoc{{Pages: []PDFPageRef{{a, 1, 45}}}}}, []string{a}); err == nil {
		t.Fatal("rotation 45 accepted")
	}
	if p, err := pdfPagesPlan(PDFPagesOpts{Docs: []PDFPagesDoc{{Pages: []PDFPageRef{{a, 1, -90}}}}}, []string{a}); err != nil || p[0].Pages[0].Rot != 270 {
		t.Fatalf("rotation -90: %v %v", p, err)
	}
}

// закрытый паролем источник: результат остаётся закрытым тем же паролем
func TestPDFPagesPassword(t *testing.T) {
	dir := t.TempDir()
	src, enc, open := filepath.Join(dir, "a.pdf"), filepath.Join(dir, "закрытый.pdf"), filepath.Join(dir, "b.pdf")
	pdfMiniW(t, src, 101, 102)
	pdfMiniW(t, open, 301)
	if err := api.EncryptFile(context.Background(), src, enc, model.NewAESConfiguration("секрет", "секрет", 256)); err != nil {
		t.Fatal(err)
	}
	dst := filepath.Join(dir, "o.pdf")
	c := context.Background()
	if err := pdfBuildPages(c, []PDFPageRef{{enc, 2, 0}, {open, 1, 0}}, dst, "", nil); err != errPDFPassword {
		t.Fatalf("without password: %v", err)
	}
	if err := pdfBuildPages(c, []PDFPageRef{{enc, 2, 0}, {open, 1, 0}}, dst, "секрет", nil); err != nil {
		t.Fatal(err)
	}
	if inf := pdfInfo(c, dst, ""); !inf.NeedPass {
		t.Fatalf("result is not locked: %+v", inf)
	}
	if got := pdfWidths(t, dst, "секрет"); !eqInts(got, []int{102, 301}) {
		t.Fatalf("widths %v", got)
	}
}

// весь прогон через сервер: склейка двух файлов, разрезание на три, файл, не вошедший в результат
func TestPDFPagesRun(t *testing.T) {
	dir := t.TempDir()
	a, b, z := filepath.Join(dir, "а.pdf"), filepath.Join(dir, "б.pdf"), filepath.Join(dir, "в.pdf")
	pdfMiniW(t, a, 101, 102, 103)
	pdfMiniW(t, b, 201, 202)
	pdfMiniW(t, z, 301)
	s := &Server{}
	s.runPDF(PDFReq{Op: "pages", Files: []string{a, b, z}, SameDir: true, Pages: PDFPagesOpts{Docs: []PDFPagesDoc{
		{Name: "Склейка", Pages: []PDFPageRef{{a, 1, 0}, {b, 1, 0}, {a, 2, 0}}},
		{Name: "Хвост: части?", Pages: []PDFPageRef{{a, 3, 0}, {b, 2, 180}}},
	}}})
	s.mu.Lock()
	files, summary := s.files, s.summary
	s.mu.Unlock()
	if files[0].Status != "ok" || files[1].Status != "ok" || files[2].Status != "ok" || files[2].Dst != "" {
		t.Fatalf("states: %+v %+v %+v; %s", files[0], files[1], files[2], summary)
	}
	if got := pdfWidths(t, filepath.Join(dir, "Склейка.pdf"), ""); !eqInts(got, []int{101, 201, 102}) {
		t.Fatalf("merge: %v", got)
	}
	if got := pdfWidths(t, filepath.Join(dir, "Хвост_ части_.pdf"), ""); !eqInts(got, []int{103, 202}) {
		t.Fatalf("tail: %v (%s)", got, summary)
	}
	// второй прогон не затирает первый
	s.runPDF(PDFReq{Op: "pages", Files: []string{a}, SameDir: true, Pages: PDFPagesOpts{Docs: []PDFPagesDoc{{Name: "Склейка", Pages: []PDFPageRef{{a, 1, 0}}}}}})
	if _, err := os.Stat(filepath.Join(dir, "Склейка (1).pdf")); err != nil {
		t.Fatal("second run overwrote or misnamed:", err)
	}
}
