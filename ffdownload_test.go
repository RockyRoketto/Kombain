package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParseSum(t *testing.T) {
	h1 := strings.Repeat("a", 64)
	h2 := strings.Repeat("B", 64)
	txt := h1 + "  one.zip\r\n" + h2 + " *two.zip\n"
	if got := parseSum(txt, "two.zip"); got != strings.ToLower(h2) {
		t.Fatalf("two.zip: %q", got)
	}
	if got := parseSum(txt, "one.zip"); got != h1 {
		t.Fatalf("one.zip: %q", got)
	}
	if got := parseSum(txt, "none.zip"); got != "" {
		t.Fatalf("нет файла: %q", got)
	}
	if got := parseSum(h1+"\n", ""); got != h1 {
		t.Fatalf("одна сумма: %q", got)
	}
	if got := parseSum("мусор\n", ""); got != "" {
		t.Fatalf("мусор: %q", got)
	}
}

func TestFetchFFSum(t *testing.T) {
	h := strings.Repeat("c", 64)
	mux := http.NewServeMux()
	mux.HandleFunc("/a.zip.sha256", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(h + "\n")) })
	mux.HandleFunc("/dir/checksums.sha256", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(h + "  b.zip\n"))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	if got := fetchFFSum(srv.URL + "/a.zip"); got != h {
		t.Fatalf("gyan: %q", got)
	}
	if got := fetchFFSum(srv.URL + "/dir/b.zip"); got != h {
		t.Fatalf("btbn: %q", got)
	}
	if got := fetchFFSum(srv.URL + "/dir/zzz.zip"); got != "" {
		t.Fatalf("нет суммы: %q", got)
	}
}
