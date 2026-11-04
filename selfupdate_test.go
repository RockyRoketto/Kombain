package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

func TestLatestApp(t *testing.T) {
	exe := []byte("MZ fake exe")
	sum := sha256.Sum256(exe)
	release := ""
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/rel":
			fmt.Fprint(w, release)
		case "/Konvertor.exe":
			w.Write(exe)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	old := appReleaseURL
	appReleaseURL = srv.URL + "/rel"
	defer func() { appReleaseURL = old }()

	release = `{"tag_name":"v9.1.0","body":"- новое\r\n\r\n### English\r\n\r\n- new\r\n","html_url":"page","assets":[
	 {"name":"notes.txt","browser_download_url":"x"},
	 {"name":"Konvertor.exe","browser_download_url":"` + srv.URL + `/Konvertor.exe","size":11,"digest":"sha256:` + hex.EncodeToString(sum[:]) + `"}]}`
	r, err := latestApp()
	if err != nil || r.ver != "9.1.0" || r.notes != "- новое" || r.notesEn != "- new" || r.size != 11 || r.sha256 != hex.EncodeToString(sum[:]) {
		t.Fatalf("got %+v %v", r, err)
	}

	t.Setenv("LOCALAPPDATA", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	s := &Server{}
	p, err := s.fetchApp(r.url, r.size, r.sha256)
	if err != nil {
		t.Fatalf("fetchApp: %v", err)
	}
	if b, _ := os.ReadFile(p); string(b) != string(exe) {
		t.Fatalf("скачалось %q", b)
	}
	if _, err := s.fetchApp(r.url, r.size, "00"); err == nil {
		t.Fatal("контрольная сумма не проверяется")
	}
	if _, err := s.fetchApp(r.url, 5, ""); err == nil {
		t.Fatal("размер не проверяется")
	}

	for name, body := range map[string]string{
		"нет exe":  `{"tag_name":"v9.1.0","assets":[]}`,
		"нет тега": `{"tag_name":"latest","assets":[{"name":"Konvertor.exe","browser_download_url":"u"}]}`,
		"черновик": `{"tag_name":"v9.1.0","draft":true,"assets":[{"name":"Konvertor.exe","browser_download_url":"u"}]}`,
		"не json":  `<html>`,
	} {
		release = body
		if _, err := latestApp(); err == nil {
			t.Errorf("%s: нет ошибки", name)
		}
	}

	s.settings.SkipApp = "9.1.0"
	s.appUpd.Latest = "9.1.0"
	s.refreshAppLocked()
	if !s.appUpd.Update || !s.appUpd.Skipped {
		t.Errorf("refresh: %+v", s.appUpd)
	}
}
