package main

import (
	"context"
	"math"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

type montFixture struct {
	t   *testing.T
	ffm string
	dir string
}

func newMontFixture(t *testing.T) *montFixture {
	t.Helper()
	ffm, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("нет ffmpeg")
	}
	return &montFixture{t, ffm, t.TempDir()}
}

func (m *montFixture) make(name string, args ...string) string {
	m.t.Helper()
	p := filepath.Join(m.dir, name)
	out, err := exec.Command(m.ffm, append(append([]string{"-hide_banner", "-loglevel", "error", "-y"}, args...), p)...).CombinedOutput()
	if err != nil {
		m.t.Fatalf("%s: %v\n%s", name, err, out)
	}
	return p
}

// яркость первого кадра, 0–255
func (m *montFixture) firstLuma(p string) int {
	m.t.Helper()
	out, err := exec.Command(m.ffm, "-hide_banner", "-loglevel", "error", "-i", p, "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "gray", "-").Output()
	if err != nil || len(out) == 0 {
		m.t.Fatalf("кадр из %s: %v", p, err)
	}
	return int(out[0])
}

func (m *montFixture) info(p string) srcInfo { return probe(context.Background(), m.ffm, p) }

func nearly(t *testing.T, what string, got, want, delta float64) {
	t.Helper()
	if math.Abs(got-want) > delta {
		t.Errorf("%s: %.3f, ждали %.3f", what, got, want)
	}
}

func TestMontageFormats(t *testing.T) {
	for _, id := range []string{"mp4", "prores422", "prores4444", "gif", "apng", "mp3", "wav", "flac"} {
		if !formats[id].forMontage() {
			t.Errorf("%s должен подходить", id)
		}
	}
	for _, id := range []string{"mkv", "small", "png", "pngseq", "dv", "нет такого"} {
		if formats[id].forMontage() {
			t.Errorf("%s не должен подходить", id)
		}
	}
}

func TestAtempoChain(t *testing.T) {
	for s, want := range map[float64]string{1: "", 1.5: "atempo=1.5", 4: "atempo=2,atempo=2", 8: "atempo=2,atempo=2,atempo=2", 0.25: "atempo=0.5,atempo=0.5", 0.75: "atempo=0.75"} {
		if got := strings.Join(atempoChain(s), ","); got != want {
			t.Errorf("%v: %q, ждали %q", s, got, want)
		}
	}
}

func TestReverseRAM(t *testing.T) {
	c := montClip{si: srcInfo{video: true, dur: 10, fps: 25, w: 1920, h: 1080}}
	nearly(t, "8 бит", reverseRAM([]montClip{c}, 1), 10*25*1920*1080*1.5, 1)
	c.si.deep = true
	nearly(t, "10 бит", reverseRAM([]montClip{c}, 1), 10*25*1920*1080*4, 1)
	c.cut = 1
	nearly(t, "обрезанный, два раза и два куска", reverseRAM([]montClip{c, c}, 2), 4*25*1920*1080*4, 1)
}

func TestDeepRe(t *testing.T) {
	for line, want := range map[string]bool{
		"Video: prores (HQ) (apch / 0x68637061), yuv422p10le(tv), 1280x720": true,
		"Video: h264 (High), yuv420p(tv, bt709), 1920x1080":                 false,
		"Video: png, rgba64be(pc), 32x32":                                   true,
		"Video: hevc (Main 10), yuv420p10le(tv), 1920x1080":                 true,
	} {
		if deepRe.MatchString(line) != want {
			t.Errorf("%s: ждали %v", line, want)
		}
	}
}
