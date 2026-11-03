package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestParseFFVersion(t *testing.T) {
	cases := []struct{ in, ver, raw string }{
		{"ffmpeg version 7.0.2-essentials_build-www.gyan.dev Copyright (c) 2000-2024", "7.0.2", "7.0.2-essentials_build-www.gyan.dev"},
		{"ffmpeg version 8.0 Copyright", "8.0", "8.0"},
		{"ffmpeg version n7.1.1-6-g48c0f071d4-20250405 Copyright", "7.1.1", "n7.1.1-6-g48c0f071d4-20250405"},
		{"ffmpeg version N-117000-gabcdef-20250101 Copyright", "", "N-117000-gabcdef-20250101"},
		{"ffmpeg version 2025-10-30-git-0f2b5f2-essentials_build-www.gyan.dev", "", "2025-10-30-git-0f2b5f2-essentials_build-www.gyan.dev"},
		{"мусор", "", ""},
	}
	for _, c := range cases {
		v, r := parseFFVersion(c.in)
		if v != c.ver || r != c.raw {
			t.Errorf("%q: got %q %q, want %q %q", c.in, v, r, c.ver, c.raw)
		}
	}
}

func TestCmpVer(t *testing.T) {
	for _, c := range []struct {
		a, b string
		w    int
	}{{"8.0", "7.1.1", 1}, {"7.1", "7.1.0", 0}, {"7.0.2", "7.1", -1}, {"10.0", "9.9", 1}} {
		if g := cmpVer(c.a, c.b); g != c.w {
			t.Errorf("cmpVer(%s,%s)=%d want %d", c.a, c.b, g, c.w)
		}
	}
}

func feed(t *testing.T, gyan string, btbnOK bool) func() {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/release-version":
			if gyan == "" {
				http.Error(w, "no", 503)
				return
			}
			fmt.Fprint(w, gyan+"\n")
		case "/btbn.json":
			if !btbnOK {
				http.Error(w, "no", 403)
				return
			}
			fmt.Fprint(w, `{"assets":[
			 {"name":"ffmpeg-master-latest-win64-gpl.zip","browser_download_url":"u-master"},
			 {"name":"ffmpeg-n7.1-latest-win64-gpl-7.1.zip","browser_download_url":"u-71"},
			 {"name":"ffmpeg-n8.0-latest-win64-gpl-8.0.zip","browser_download_url":"u-80"},
			 {"name":"ffmpeg-n8.0-latest-win64-lgpl-8.0.zip","browser_download_url":"u-80-lgpl"},
			 {"name":"ffmpeg-n8.0-latest-linux64-gpl-8.0.tar.xz","browser_download_url":"u-linux"}]}`)
		}
	}))
	old := []string{gyanVersionURL, gyanZipURL, btbnAPIURL, btbnMasterURL}
	gyanVersionURL, gyanZipURL, btbnAPIURL, btbnMasterURL = srv.URL+"/release-version", "gyan-zip", srv.URL+"/btbn.json", "master-zip"
	return func() {
		srv.Close()
		gyanVersionURL, gyanZipURL, btbnAPIURL, btbnMasterURL = old[0], old[1], old[2], old[3]
	}
}

func TestLatestFFmpeg(t *testing.T) {
	check := func(name, gyan string, btbn bool, wantVer string, wantURLs []string, wantErr bool) {
		defer feed(t, gyan, btbn)()
		v, u, err := latestFFmpeg()
		if v != wantVer || fmt.Sprint(u) != fmt.Sprint(wantURLs) || (err != nil) != wantErr {
			t.Errorf("%s: got %q %v %v", name, v, u, err)
		}
	}
	check("both", "8.0.1", true, "8.0.1", []string{"gyan-zip", "u-80", "master-zip"}, false)
	check("gyan only", "8.0.1", false, "8.0.1", []string{"gyan-zip", "master-zip"}, false)
	check("btbn only", "", true, "8.0", []string{"u-80", "master-zip"}, false)
	check("offline", "", false, "", []string{"gyan-zip", "master-zip"}, true)
	check("garbage", "<html>", false, "", []string{"gyan-zip", "master-zip"}, true)
}
