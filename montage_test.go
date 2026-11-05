package main

import (
	"context"
	"math"
	"os/exec"
	"path/filepath"
	"strconv"
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

// run запускает монтаж как настоящая пачка и возвращает результат первой строки
func (m *montFixture) run(req MontageReq) string {
	m.t.Helper()
	s, st := m.runState(req)
	if st.Status != "ok" {
		m.t.Fatalf("статус %s: %s\n%s", st.Status, st.Msg, strings.Join(s.log, "\n"))
	}
	return st.Dst
}

func (m *montFixture) runState(req MontageReq) (*Server, *FileState) {
	m.t.Helper()
	req.CRF, req.ABR, req.Preset = 20, 192, "ultrafast"
	if !montFormat(req.Format) {
		m.t.Fatalf("формат %s не для монтажа", req.Format)
	}
	req.fit()
	s := &Server{}
	s.runMontage(req, m.ffm)
	return s, s.files[0]
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
		if !montFormat(id) {
			t.Errorf("%s должен подходить", id)
		}
	}
	for _, id := range []string{"mkv", "small", "png", "pngseq", "dv", "нет такого"} {
		if montFormat(id) {
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

// Разные кодеки, размеры, частоты кадров, файл без звука: всё приводится к первому файлу
func TestMontageGlue(t *testing.T) {
	m := newMontFixture(t)
	a := m.make("a.mp4", "-f", "lavfi", "-i", "color=black:s=640x360:r=25:d=2", "-f", "lavfi", "-i", "sine=f=440:d=2", "-c:v", "libx264", "-c:a", "aac", "-shortest")
	b := m.make("b.mov", "-f", "lavfi", "-i", "color=white:s=1280x720:r=30:d=1", "-c:v", "prores_ks", "-profile:v", "2")
	c := m.make("c.webm", "-f", "lavfi", "-i", "color=gray:s=320x400:r=24:d=1", "-f", "lavfi", "-i", "sine=f=880:r=22050:d=1", "-c:v", "libvpx-vp9", "-c:a", "libopus", "-shortest")

	out := m.run(MontageReq{StartReq: StartReq{Files: []string{a, b, c}, Format: "mp4"}, Glue: true})
	si := m.info(out)
	if si.w != 640 || si.h != 360 {
		t.Errorf("размер %dx%d", si.w, si.h)
	}
	nearly(t, "длина", si.dur, 4, 0.15)
	nearly(t, "fps", si.fps, 25, 0.01)
	if !si.audio {
		t.Error("нет звука")
	}
	if !strings.Contains(filepath.Base(out), "a"+tr("mont.suffix")) {
		t.Errorf("имя %s", out)
	}
	if l := m.firstLuma(out); l > 40 {
		t.Errorf("первым должен идти чёрный файл, яркость %d", l)
	}

	// весь результат задом наперёд: первым идёт последний файл, серый, потом белый
	out = m.run(MontageReq{StartReq: StartReq{Files: []string{a, b}, Format: "mp4"}, Glue: true, Reverse: true})
	if l := m.firstLuma(out); l < 200 {
		t.Errorf("реверс склейки: первым должен идти белый файл, яркость %d", l)
	}
	nearly(t, "длина реверса", m.info(out).dur, 3, 0.15)

	// исходники на месте, второй запуск делает копию, а не затирает
	again := m.run(MontageReq{StartReq: StartReq{Files: []string{a, b}, Format: "mp4"}, Glue: true, Reverse: true})
	if again == out {
		t.Errorf("второй запуск записал в тот же файл %s", again)
	}
}

func TestMontageSpeedRepeatReverse(t *testing.T) {
	m := newMontFixture(t)
	a := m.make("fade.mp4", "-f", "lavfi", "-i", "color=white:s=320x240:r=25:d=2,fade=in:st=0:d=2", "-f", "lavfi", "-i", "sine=f=440:d=2", "-c:v", "libx264", "-c:a", "aac", "-shortest")
	if l := m.firstLuma(a); l > 40 {
		t.Fatalf("исходник должен начинаться с тёмного, яркость %d", l)
	}
	for _, tc := range []struct {
		name    string
		speed   float64
		reverse bool
		repeat  int
		dur     float64
	}{
		{"2x", 2, false, 1, 1},
		{"8x", 8, false, 1, 0.25},
		{"0.25x", 0.25, false, 1, 8},
		{"повтор", 1, false, 3, 6},
		{"всё вместе", 2, true, 2, 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			out := m.run(MontageReq{StartReq: StartReq{Files: []string{a}, Format: "mp4"}, Speed: tc.speed, Reverse: tc.reverse, Repeat: tc.repeat})
			si := m.info(out)
			nearly(t, "длина", si.dur, tc.dur, 0.2)
			nearly(t, "fps", si.fps, 25, 0.5)
			if !si.audio {
				t.Error("нет звука")
			}
		})
	}
	out := m.run(MontageReq{StartReq: StartReq{Files: []string{a}, Format: "mp4"}, Reverse: true})
	if l := m.firstLuma(out); l < 200 {
		t.Errorf("реверс: первым должен идти светлый кадр, яркость %d", l)
	}
}

// Каждый файл отдельно, обрезка и формат результата
func TestMontageEachFile(t *testing.T) {
	m := newMontFixture(t)
	a := m.make("a.mp4", "-f", "lavfi", "-i", "color=black:s=320x240:r=25:d=3", "-f", "lavfi", "-i", "sine=f=440:d=3", "-c:v", "libx264", "-c:a", "aac", "-shortest")
	b := m.make("b.mp3", "-f", "lavfi", "-i", "sine=f=440:d=2", "-c:a", "libmp3lame")

	s, _ := m.runState(MontageReq{StartReq: StartReq{Files: []string{a, b}, Format: "mp3"}, Speed: 2})
	if len(s.files) != 2 {
		t.Fatalf("строк %d", len(s.files))
	}
	for i, want := range []float64{1.5, 1} {
		if s.files[i].Status != "ok" {
			t.Fatalf("%s: %s", s.files[i].Name, s.files[i].Msg)
		}
		nearly(t, s.files[i].Name, m.info(s.files[i].Dst).dur, want, 0.15)
	}

	out := m.run(MontageReq{StartReq: StartReq{Files: []string{a}, Format: "mp4", Trims: map[string]Trim{a: {Start: 1, End: 2}}}, Repeat: 2})
	nearly(t, "обрезка и повтор", m.info(out).dur, 2, 0.15)

	for _, id := range []string{"gif", "prores422", "prores4444", "webm", "mpg2", "animwebp", "flac"} {
		out := m.run(MontageReq{StartReq: StartReq{Files: []string{a}, Format: id}, Speed: 2, Reverse: true})
		if d := m.info(out).dur; d <= 0 && id != "animwebp" {
			t.Errorf("%s: длина %v", id, d)
		}
	}
}

// Звук не должен уехать: кусок без звука заполняется тишиной нужной длины
func TestMontageSilentClip(t *testing.T) {
	m := newMontFixture(t)
	mute := m.make("mute.mp4", "-f", "lavfi", "-i", "color=black:s=320x240:r=25:d=2", "-c:v", "libx264")
	loud := m.make("loud.mp4", "-f", "lavfi", "-i", "color=black:s=320x240:r=25:d=1", "-f", "lavfi", "-i", "sine=f=440:d=1", "-c:v", "libx264", "-c:a", "aac", "-shortest")
	out := m.run(MontageReq{StartReq: StartReq{Files: []string{mute, loud}, Format: "mp4"}, Glue: true})
	si := m.info(out)
	nearly(t, "длина", si.dur, 3, 0.15)
	if !si.audio {
		t.Fatal("нет звука")
	}
	vol := func(from float64) float64 {
		res, _ := exec.Command(m.ffm, "-hide_banner", "-ss", strconv.FormatFloat(from, 'f', 2, 64), "-t", "0.5", "-i", out, "-vn", "-af", "volumedetect", "-f", "null", "-").CombinedOutput()
		i := strings.Index(string(res), "mean_volume: ")
		if i < 0 {
			t.Fatalf("громкость:\n%s", res)
		}
		v, _ := strconv.ParseFloat(strings.Fields(string(res)[i+len("mean_volume: "):])[0], 64)
		return v
	}
	if v := vol(0.5); v > -60 {
		t.Errorf("первая часть должна быть тихой, %v дБ", v)
	}
	if v := vol(2.3); v < -40 {
		t.Errorf("вторая часть должна звучать, %v дБ", v)
	}
}

// Вертикальное видео с телефона: в файле кадр лежит боком и есть метка поворота
func TestMontageRotated(t *testing.T) {
	m := newMontFixture(t)
	plain := m.make("plain.mp4", "-f", "lavfi", "-i", "color=black:s=640x360:r=25:d=1", "-c:v", "libx264")
	rot := filepath.Join(m.dir, "rot.mp4")
	if out, err := exec.Command(m.ffm, "-hide_banner", "-loglevel", "error", "-y", "-display_rotation", "90", "-i", plain, "-c", "copy", rot).CombinedOutput(); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if !m.info(rot).rotated {
		t.Fatal("метка поворота не определилась")
	}
	out := m.run(MontageReq{StartReq: StartReq{Files: []string{rot, plain}, Format: "mp4"}, Glue: true})
	si := m.info(out)
	if si.w != 360 || si.h != 640 {
		t.Errorf("размер %dx%d, ждали вертикальный кадр 360x640", si.w, si.h)
	}
}

func TestMontageErrors(t *testing.T) {
	m := newMontFixture(t)
	snd := m.make("s.mp3", "-f", "lavfi", "-i", "sine=f=440:d=1", "-c:a", "libmp3lame")
	mute := m.make("m.mp4", "-f", "lavfi", "-i", "color=black:s=320x240:r=25:d=1", "-c:v", "libx264")
	pic := m.make("p.png", "-f", "lavfi", "-i", "color=black:s=32x32", "-frames:v", "1")
	bad := filepath.Join(m.dir, "bad.mp4")
	for _, tc := range []struct {
		files  []string
		format string
		key    string
	}{
		{[]string{snd}, "mp4", "mont.noVideo"},
		{[]string{mute}, "mp3", "mont.noAudio"},
		{[]string{pic}, "mp4", "mont.image"},
		{[]string{bad}, "mp4", "mont.unreadable"},
	} {
		_, st := m.runState(MontageReq{StartReq: StartReq{Files: tc.files, Format: tc.format}})
		name := filepath.Base(tc.files[0])
		if st.Status != "error" || st.Msg != tr(tc.key, name) {
			t.Errorf("%s в %s: статус %s, %q", name, tc.format, st.Status, st.Msg)
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
