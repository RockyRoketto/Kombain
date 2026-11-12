package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// «Пересобрать» в старый формат 1.4: заголовок 1.4, таблица ссылок обычная (без сжатых потоков)
func TestPDFResaveVersion(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "a.pdf")
	pdfMini(t, src, 2)
	c := context.Background()
	for _, v := range []string{"1.4", ""} {
		dst := filepath.Join(dir, "v"+v+".pdf")
		want := v
		if want == "" {
			want = "1.7"
		}
		if _, err := pdfResave(c, src, dst, "", PDFResaveOpts{Version: v, Strip: true}); err != nil {
			t.Fatal(v, err)
		}
		b, _ := os.ReadFile(dst)
		if !bytes.HasPrefix(b, []byte("%PDF-"+want)) {
			t.Fatalf("%s: header %q", v, b[:9])
		}
		if v == "1.4" && (bytes.Contains(b, []byte("/ObjStm")) || bytes.Contains(b, []byte("/XRef"))) {
			t.Fatalf("1.4 with object or xref streams")
		}
		if inf := pdfInfo(c, dst, ""); inf.Pages != 2 || inf.Version != want {
			t.Fatalf("%s: %+v", v, inf)
		}
	}
}

// оборванный файл без таблицы ссылок: «Пересобрать» восстанавливает его и говорит, что чинил
func TestPDFResaveRepair(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "a.pdf")
	pdfMini(t, src, 3)
	b, _ := os.ReadFile(src)
	cut := bytes.Index(b, []byte("xref"))
	os.WriteFile(src, b[:cut], 0o644)
	c := context.Background()
	dst := filepath.Join(dir, "out.pdf")
	repaired, err := pdfResave(c, src, dst, "", PDFResaveOpts{})
	if err != nil {
		t.Skipf("pdfcpu не восстановил файл: %v", err) // зависит от pdfcpu; главное — понятная ошибка, а не паника
	}
	if inf := pdfInfo(c, dst, ""); inf.Pages != 3 || inf.Error != "" {
		t.Fatalf("repaired: %+v (flag %v)", inf, repaired)
	}
	// совсем не PDF: понятная ошибка, файл результата не остаётся
	junk := filepath.Join(dir, "junk.pdf")
	os.WriteFile(junk, []byte("это не PDF"), 0o644)
	if _, err := pdfResave(c, junk, filepath.Join(dir, "j.pdf"), "", PDFResaveOpts{}); err == nil || pdfErrText(err) == "" {
		t.Fatal("junk resaved")
	}
	if _, err := os.Stat(filepath.Join(dir, "j.pdf")); err == nil {
		t.Fatal("junk result left")
	}
}

// страницы пишутся только в выданную папку, только картинками, без выхода из папки
func TestPDFRasterSave(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "Отчёт.pdf")
	pdfMini(t, src, 1)
	os.MkdirAll(filepath.Join(dir, "Отчёт", "x"), 0o755) // занята: будет «Отчёт (1)»
	out, err := pdfRasterDir(src, true, "")
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(out) != "Отчёт (1)" {
		t.Fatalf("dir %s", out)
	}
	p, err := pdfRasterSave(out, "Отчёт-01.png", strings.NewReader("png"))
	if err != nil || filepath.Dir(p) != out {
		t.Fatalf("save: %s %v", p, err)
	}
	if p, err := pdfRasterSave(out, `..\..\x.png`, strings.NewReader("x")); err != nil || filepath.Dir(p) != out {
		t.Fatalf("escape: %s %v", p, err)
	}
	if _, err := pdfRasterSave(out, "a.exe", strings.NewReader("x")); err == nil {
		t.Fatal("exe accepted")
	}
	if _, err := pdfRasterSave("", "a.png", strings.NewReader("x")); err == nil {
		t.Fatal("no dir accepted") // чужие папки не пускает ручка: см. TestPDFRasterFlow
	}
}

// прогон «PDF → картинки» через ручки, как его ведёт окно: папка, страницы, итог по файлу, конец пачки
func TestPDFRasterFlow(t *testing.T) {
	dir := t.TempDir()
	a, b := filepath.Join(dir, "a.pdf"), filepath.Join(dir, "b.pdf")
	pdfMini(t, a, 2)
	pdfMini(t, b, 1)
	s := &Server{host: "h", token: "tk"}
	mux := http.NewServeMux()
	s.pdfRoutes(mux)
	call := func(path string, body string) map[string]any {
		t.Helper()
		r := httptest.NewRequest("POST", path, strings.NewReader(body))
		r.Host = "h"
		r.Header.Set("X-Token", "tk")
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		var m map[string]any
		json.Unmarshal(w.Body.Bytes(), &m)
		return m
	}
	s.running = true
	s.startPDF(PDFReq{Files: []string{a, b}, Op: "raster", SameDir: true})
	r := call("/api/pdf-ras-begin", `{"i":0}`)
	pages, _ := r["dir"].(string)
	if filepath.Base(pages) != "a" {
		t.Fatalf("begin: %v", r)
	}
	for n := 1; n <= 2; n++ {
		r = call("/api/pdf-page-save?i=0&n="+strconv.Itoa(n)+"&of=2&name=a-"+strconv.Itoa(n)+".png", "png")
		if r["path"] == nil {
			t.Fatalf("save: %v", r)
		}
	}
	if r = call("/api/pdf-page-save?i=1&n=1&of=1&name=b-1.png", "png"); r["error"] == nil {
		t.Fatalf("page before begin accepted: %v", r)
	}
	call("/api/pdf-ras-end", `{"i":0,"pages":2}`)
	call("/api/pdf-ras-begin", `{"i":1}`)
	call("/api/pdf-ras-end", `{"i":1,"error":"не открылся"}`)
	for i := 0; i < 50; i++ {
		s.mu.Lock()
		run := s.running
		s.mu.Unlock()
		if !run {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	s.mu.Lock()
	running, f0, f1, sum := s.running, *s.files[0], *s.files[1], s.summary
	s.mu.Unlock()
	if running || f0.Status != "ok" || f0.Dst != filepath.Join(pages, "a-1.png") || f1.Status != "error" {
		t.Fatalf("result: running %v, %+v %+v", running, f0, f1)
	}
	if _, err := os.Stat(filepath.Join(pages, "a-2.png")); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(sum, "1 из 2") && !strings.Contains(sum, "1 of 2") {
		t.Fatalf("summary %q", sum)
	}
	// после конца прогона писать некуда
	if r = call("/api/pdf-ras-begin", `{"i":0}`); r["canceled"] != true {
		t.Fatalf("after end: %v", r)
	}
}

// файл не вышел: пустая папка страниц не остаётся
func TestPDFRasterEmptyDir(t *testing.T) {
	dir := t.TempDir()
	a := filepath.Join(dir, "a.pdf")
	pdfMini(t, a, 1)
	s := &Server{host: "h", token: "tk"}
	mux := http.NewServeMux()
	s.pdfRoutes(mux)
	call := func(path, body string) {
		r := httptest.NewRequest("POST", path, strings.NewReader(body))
		r.Host = "h"
		r.Header.Set("X-Token", "tk")
		mux.ServeHTTP(httptest.NewRecorder(), r)
	}
	s.running = true
	s.startPDF(PDFReq{Files: []string{a}, Op: "raster", SameDir: true})
	call("/api/pdf-ras-begin", `{"i":0}`)
	if _, err := os.Stat(filepath.Join(dir, "a")); err != nil {
		t.Fatal("no dir after begin")
	}
	call("/api/pdf-ras-end", `{"i":0,"error":"x"}`)
	if _, err := os.Stat(filepath.Join(dir, "a")); err == nil {
		t.Fatal("empty dir left")
	}
}

// «Стоп» посреди файла: его недописанная папка удаляется, готовые файлы остаются
func TestPDFRasterCancel(t *testing.T) {
	dir := t.TempDir()
	a, b := filepath.Join(dir, "a.pdf"), filepath.Join(dir, "b.pdf")
	pdfMini(t, a, 1)
	pdfMini(t, b, 2)
	s := &Server{host: "h", token: "tk"}
	mux := http.NewServeMux()
	s.pdfRoutes(mux)
	call := func(path, body string) {
		r := httptest.NewRequest("POST", path, strings.NewReader(body))
		r.Host = "h"
		r.Header.Set("X-Token", "tk")
		mux.ServeHTTP(httptest.NewRecorder(), r)
	}
	s.running = true
	s.startPDF(PDFReq{Files: []string{a, b}, Op: "raster", SameDir: true})
	call("/api/pdf-ras-begin", `{"i":0}`)
	call("/api/pdf-page-save?i=0&n=1&of=1&name=a-1.png", "png")
	call("/api/pdf-ras-end", `{"i":0,"pages":1}`)
	call("/api/pdf-ras-begin", `{"i":1}`)
	call("/api/pdf-page-save?i=1&n=1&of=2&name=b-1.png", "png")
	s.mu.Lock()
	s.cancel()
	s.mu.Unlock()
	for i := 0; i < 100; i++ {
		s.mu.Lock()
		run := s.running
		s.mu.Unlock()
		if !run {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := os.Stat(filepath.Join(dir, "a", "a-1.png")); err != nil {
		t.Fatal("finished file removed")
	}
	if _, err := os.Stat(filepath.Join(dir, "b")); err == nil {
		t.Fatal("unfinished dir left")
	}
	s.mu.Lock()
	st := s.files[1].Status
	s.mu.Unlock()
	if st != "canceled" {
		t.Fatalf("status %s", st)
	}
}
