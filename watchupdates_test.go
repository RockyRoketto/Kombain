package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestUpdateDue(t *testing.T) {
	last := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		after time.Duration
		want  bool
	}{
		{time.Minute, false},
		{updateEvery - time.Second, false},
		{updateEvery, true},
		{3 * 24 * time.Hour, true}, // компьютер спал
		{-time.Hour, true},         // часы перевели назад
	}
	for _, c := range cases {
		if got := updateDue(last, last.Add(c.after)); got != c.want {
			t.Errorf("через %v: got %v", c.after, got)
		}
	}
}

// Повторная проверка находит новую версию, не теряет данные при сбое сети и не засоряет лог.
func TestCheckAppRepeated(t *testing.T) {
	release := ""
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if release == "" {
			w.WriteHeader(500)
			return
		}
		fmt.Fprint(w, release)
	}))
	defer srv.Close()
	old := appReleaseURL
	appReleaseURL = srv.URL
	defer func() { appReleaseURL = old }()
	rel := func(ver string) string {
		return `{"tag_name":"v` + ver + `","assets":[{"name":"Konvertor.exe","browser_download_url":"u` + ver + `","size":1}]}`
	}

	s := &Server{}
	release = rel("99.1.0")
	s.checkApp()
	if !s.appUpd.Update || s.appUpd.Latest != "99.1.0" || len(s.log) != 1 {
		t.Fatalf("первая проверка: %+v, лог %q", s.appUpd, s.log)
	}
	s.checkApp()
	if len(s.log) != 1 {
		t.Fatalf("та же версия попала в лог ещё раз: %q", s.log)
	}

	s.appUpd.Err = "старая ошибка"
	release = rel("99.2.0")
	s.checkApp()
	if s.appUpd.Latest != "99.2.0" || s.appUpd.url != "u99.2.0" || s.appUpd.Err != "" || len(s.log) != 2 {
		t.Fatalf("новая версия: %+v, лог %q", s.appUpd, s.log)
	}

	release = ""
	s.checkApp()
	s.checkApp()
	if !s.appUpd.Update || s.appUpd.Latest != "99.2.0" || s.appUpd.url != "u99.2.0" || s.appUpd.CheckErr == "" {
		t.Fatalf("сбой сети стёр данные: %+v", s.appUpd)
	}
	if len(s.log) != 3 {
		t.Fatalf("одна и та же ошибка попала в лог несколько раз: %q", s.log)
	}

	release = rel("99.2.0")
	s.checkApp()
	if s.appUpd.CheckErr != "" || len(s.log) != 3 {
		t.Fatalf("после восстановления сети: %+v, лог %q", s.appUpd, s.log)
	}
}

func TestCheckLatestFFRepeated(t *testing.T) {
	ver := ""
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if ver == "" || r.URL.Path != "/ver" {
			w.WriteHeader(500)
			return
		}
		fmt.Fprint(w, ver)
	}))
	defer srv.Close()
	oldVer, oldBtbn, oldZip := gyanVersionURL, btbnAPIURL, gyanZipURL
	gyanVersionURL, btbnAPIURL, gyanZipURL = srv.URL+"/ver", srv.URL+"/btbn", "zip"
	defer func() { gyanVersionURL, btbnAPIURL, gyanZipURL = oldVer, oldBtbn, oldZip }()

	s := &Server{ffmpeg: "ffmpeg"}
	s.ffv.Local = "7.0"
	ver = "8.0"
	s.checkLatestFF()
	s.checkLatestFF()
	if !s.ffv.Update || s.ffv.Latest != "8.0" || len(s.log) != 1 {
		t.Fatalf("проверка: %+v, лог %q", s.ffv, s.log)
	}

	ver = ""
	s.checkLatestFF()
	s.checkLatestFF()
	if !s.ffv.Update || s.ffv.Latest != "8.0" || s.ffv.CheckErr == "" || len(s.ffURLs) == 0 || s.ffURLs[0] != "zip" {
		t.Fatalf("сбой сети стёр данные: %+v, %q", s.ffv, s.ffURLs)
	}
	if len(s.log) != 2 {
		t.Fatalf("одна и та же ошибка попала в лог несколько раз: %q", s.log)
	}
}
