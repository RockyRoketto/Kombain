package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func waitProxy(t *testing.T, ffm, src string) ProxyState {
	t.Helper()
	for i := 0; i < 300; i++ {
		st := proxyStatus(ffm, src, proxyPiece{})
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

func waitPiece(t *testing.T, ffm, src string, piece proxyPiece) ProxyState {
	t.Helper()
	for i := 0; i < 600; i++ {
		st := proxyStatus(ffm, src, piece)
		if st.Ready || st.Error != "" {
			return st
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("копия не готова")
	return ProxyState{}
}

// Несколько копий готовятся вместе, реверс длиннее одной части склеивается, слой с прозрачностью её не теряет
func TestProxyManyAndReverse(t *testing.T) {
	m := newMontFixture(t)
	t.Setenv("LOCALAPPDATA", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	defer proxyCleanup()

	serial := m.serial("serial.mkv") // 1 с чёрного, 1 с белого
	other := m.color("other.mkv", "gray", 160, 120, 30, 1, 440)
	alpha := m.make("alpha.mov", "-f", "lavfi", "-i", "color=white@0.0:s=160x120:r=30:d=1,format=argb", "-c:v", "qtrle")
	proxyStatus(m.ffm, serial, proxyPiece{})
	proxyStatus(m.ffm, other, proxyPiece{})
	if st := waitPiece(t, m.ffm, serial, proxyPiece{}); !st.Ready {
		t.Fatalf("первая копия: %+v", st)
	}
	if st := waitPiece(t, m.ffm, other, proxyPiece{}); !st.Ready {
		t.Fatalf("вторая копия: %+v", st)
	}

	proxySegment = 0.75 // чтобы реверс шёл несколькими частями
	defer func() { proxySegment = 8 }()
	piece := proxyPiece{Rev: true, From: 0, Len: 2}
	if st := waitPiece(t, m.ffm, serial, piece); !st.Ready {
		t.Fatalf("реверс: %+v", st)
	}
	out, _ := proxyPiecePath(serial, piece)
	nearly(t, "длина реверса", m.info(out).dur, 2, 0.15)
	if got := m.lumaAt(out, 0.5, 0.5, 0.5); got < 128 {
		t.Errorf("начало реверса должно быть белым: яркость %d", got)
	}
	if got := m.lumaAt(out, 1.5, 0.5, 0.5); got > 128 {
		t.Errorf("конец реверса должен быть чёрным: яркость %d", got)
	}

	if st := waitPiece(t, m.ffm, alpha, proxyPiece{}); !st.Ready {
		t.Fatalf("прозрачность: %+v", st)
	}
	out, _ = proxyPath(alpha)
	if !strings.HasSuffix(out, ".webm") {
		t.Fatalf("копия слоя с прозрачностью: %s", out)
	}
	if !m.info(out).alpha {
		t.Error("копия потеряла прозрачность")
	}

	if proxyUsage() == 0 {
		t.Error("место под копии не посчитано")
	}
	proxyClear()
	if proxyUsage() != 0 {
		t.Error("копии не удалены")
	}
}

// Качество просмотра: у уменьшенной копии своё имя и свой размер, обычная копия не меняется
func TestProxyScale(t *testing.T) {
	src := filepath.Join(t.TempDir(), "a.mp4")
	if err := os.WriteFile(src, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	plain, _ := proxyStem(src, proxyPiece{})
	half, _ := proxyStem(src, proxyPiece{Scale: 2})
	wrong, _ := proxyStem(src, proxyPiece{Scale: 3})
	if half == plain || wrong != plain {
		t.Fatalf("имена копий: %s %s %s", plain, half, wrong)
	}
	has := func(o proxyOpts, want string) {
		t.Helper()
		if s := strings.Join(proxyArgs(src, "o.mp4", o), " "); !strings.Contains(s, want) {
			t.Fatalf("нет %q в %s", want, s)
		}
	}
	has(proxyOpts{video: true}, "min(1280,iw)/2")
	has(proxyOpts{video: true, scale: 4}, "min(1280,iw/4)/2")
}
