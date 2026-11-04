package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func waitProxy(t *testing.T, ffm, src string) ProxyState {
	t.Helper()
	for i := 0; i < 300; i++ {
		st := proxyStatus(ffm, src)
		if st.Ready || st.Error != "" {
			return st
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("копия не готова за 30 секунд")
	return ProxyState{}
}

func TestProxy(t *testing.T) {
	ffm, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("нет ffmpeg")
	}
	t.Setenv("LOCALAPPDATA", t.TempDir()) // служебная папка на Windows
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	defer proxyCleanup()

	dir := t.TempDir()
	// нечётная ширина и MPEG-4 в AVI: проигрыватель такое не покажет, а x264 с нечётной шириной падает
	vid := filepath.Join(dir, "кадры.avi")
	wav := filepath.Join(dir, "звук.wav")
	for _, a := range [][]string{
		{"-f", "lavfi", "-i", "testsrc=d=2:s=321x241:r=10", "-f", "lavfi", "-i", "sine=d=2", "-c:v", "mpeg4", "-c:a", "mp3", vid},
		{"-f", "lavfi", "-i", "sine=d=2", wav},
	} {
		if out, err := exec.Command(ffm, append([]string{"-y", "-hide_banner", "-loglevel", "error"}, a...)...).CombinedOutput(); err != nil {
			t.Skipf("не удалось сделать тестовый файл: %s", out)
		}
	}

	if st := waitProxy(t, ffm, vid); !st.Ready {
		t.Fatalf("видео: %+v", st)
	}
	out, _ := proxyPath(vid)
	mi := getMediaInfo(ffm, out)
	if mi.VCodec != "h264" || mi.ACodec != "aac" || mi.Dur < 1.8 || mi.Dur > 2.3 {
		t.Fatalf("копия видео: %+v", mi)
	}

	if st := waitProxy(t, ffm, wav); !st.Ready {
		t.Fatalf("звук: %+v", st)
	}
	out, _ = proxyPath(wav)
	if mi = getMediaInfo(ffm, out); mi.VCodec != "" || mi.ACodec != "aac" {
		t.Fatalf("копия звука: %+v", mi)
	}

	// копия отдаётся по токену и только для файла с медиа-расширением
	s := &Server{token: "tok", host: "h"}
	get := func(q url.Values) int {
		r := httptest.NewRequest(http.MethodGet, "/media?"+q.Encode(), nil)
		r.Host = "h"
		w := httptest.NewRecorder()
		s.mediaHandler(w, r)
		return w.Code
	}
	if c := get(url.Values{"t": {"tok"}, "p": {wav}, "proxy": {"1"}}); c != http.StatusOK {
		t.Fatalf("копия: код %d", c)
	}
	if c := get(url.Values{"t": {"bad"}, "p": {wav}, "proxy": {"1"}}); c != http.StatusForbidden {
		t.Fatalf("чужой токен: код %d", c)
	}
	if c := get(url.Values{"t": {"tok"}, "p": {filepath.Join(dir, "a.txt")}, "proxy": {"1"}}); c != http.StatusNotFound {
		t.Fatalf("не медиа: код %d", c)
	}

	// файл, который не читается: ошибка, а не вечное ожидание
	bad := filepath.Join(dir, "битый.mp4")
	if err := os.WriteFile(bad, []byte("не видео"), 0o644); err != nil {
		t.Fatal(err)
	}
	if st := waitProxy(t, ffm, bad); st.Ready || st.Error == "" {
		t.Fatalf("битый файл: %+v", st)
	}
}
