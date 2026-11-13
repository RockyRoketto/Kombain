package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// докачка: .part подхватывается с места обрыва, сумма считается по всему файлу
func TestDownloadResume(t *testing.T) {
	data := make([]byte, 100000)
	for i := range data {
		data[i] = byte(i * 7)
	}
	ranged := true
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if ranged {
			http.ServeContent(w, r, "f.bin", time.Time{}, bytes.NewReader(data))
			return
		}
		w.Write(data) // сервер Range не знает
	}))
	defer srv.Close()

	for _, ranged = range []bool{true, false} {
		path := filepath.Join(t.TempDir(), "f.bin.part")
		os.WriteFile(path, data[:30000], 0o644)
		h := sha256.New()
		n, err := downloadResume(context.Background(), srv.URL, path, int64(len(data)), int64(len(data))+1, h, func(float64) {})
		if err != nil || n != int64(len(data)) {
			t.Fatalf("ranged=%v: n=%d err=%v", ranged, n, err)
		}
		want := sha256.Sum256(data)
		if string(h.Sum(nil)) != string(want[:]) {
			t.Fatalf("ranged=%v: сумма не сошлась", ranged)
		}
		got, _ := os.ReadFile(path)
		if string(got) != string(data) {
			t.Fatalf("ranged=%v: файл не тот", ranged)
		}
	}
}
