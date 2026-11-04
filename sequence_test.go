package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
)

func ffmpegOrSkip(t *testing.T) string {
	t.Helper()
	ffm, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("нет ffmpeg")
	}
	return ffm
}

func mustFF(t *testing.T, ffm string, args ...string) {
	t.Helper()
	a := append([]string{"-hide_banner", "-loglevel", "error", "-y"}, args...)
	if out, err := exec.Command(ffm, a...).CombinedOutput(); err != nil {
		t.Fatalf("%v\n%s\n%s", err, strings.Join(args, " "), out)
	}
}

// Значение прозрачности кадра посередине картинки. Формат пикселей ничего не доказывает:
// плоскость прозрачности может быть, но быть сплошной.
func alphaOf(t *testing.T, ffm, file string) int {
	t.Helper()
	si := probe(context.Background(), ffm, file)
	args := []string{"-hide_banner", "-loglevel", "error"}
	if si.decoder != "" {
		args = append(args, "-c:v", si.decoder)
	}
	args = append(args, "-i", file, "-frames:v", "1", "-vf", "format=rgba,crop=2:2:iw/2:ih/2", "-f", "rawvideo", "-")
	out, err := exec.Command(ffm, args...).Output()
	if err != nil || len(out) < 4 {
		t.Fatalf("%s: %v, %d байт", file, err, len(out))
	}
	return int(out[3])
}

// Полупрозрачность в исходнике должна дойти до пикселей результата
func TestAlphaSurvives(t *testing.T) {
	ffm := ffmpegOrSkip(t)
	dir := t.TempDir()
	gen := []string{"-f", "lavfi", "-i", "testsrc2=s=64x48:d=1:r=10,format=rgba,colorchannelmixer=aa=0.5"}
	sources := map[string][]string{
		"vp9.webm": {"-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p"},
		"vp8.webm": {"-c:v", "libvpx", "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", "-b:v", "1M"},
		"pr.mov":   {"-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuva444p10le"},
	}
	req := StartReq{CRF: 23, ABR: 128, Preset: "ultrafast"}
	for name, enc := range sources {
		src := filepath.Join(dir, name)
		mustFF(t, ffm, append(append(slices.Clone(gen), enc...), src)...)
		si := probe(context.Background(), ffm, src)
		if !si.alpha {
			t.Fatalf("%s: прозрачность не определилась", name)
		}
		for _, id := range []string{"webm", "webmvp8", "prores4444", "qtrle", "png", "webp", "apng", "animwebp"} {
			f := formats[id]
			dst := filepath.Join(dir, name+"-"+id+"."+f.Ext)
			args := buildArgs(f, req, src, dst, si, false, nil)
			if out, err := exec.Command(ffm, args...).CombinedOutput(); err != nil {
				t.Errorf("%s → %s: %v\n%s", name, id, err, lastLines(out))
				continue
			}
			if a := alphaOf(t, ffm, dst); a < 110 || a > 145 {
				t.Errorf("%s → %s: прозрачность %d, ждали около 128", name, id, a)
			}
		}
		// «уложить в N МБ»: два прохода тоже не теряют прозрачность
		dst := filepath.Join(dir, name+"-limit.webm")
		for pass := 1; pass <= 2; pass++ {
			to := dst
			if pass == 1 {
				to = os.DevNull
			}
			args := buildArgs(formats["webm"], req, src, to, si, false, &rate{vk: 500, ak: 96, pass: pass, dir: dir})
			cmd := exec.Command(ffm, args...)
			cmd.Dir = dir
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("%s, проход %d: %v\n%s", name, pass, err, lastLines(out))
			}
		}
		if a := alphaOf(t, ffm, dst); a < 110 || a > 145 {
			t.Errorf("%s, лимит: прозрачность %d", name, a)
		}
	}
}

// GIF хранит только «есть или нет», поэтому фон должен остаться прозрачным, а предмет — нет
func TestGifKeepsTransparency(t *testing.T) {
	ffm := ffmpegOrSkip(t)
	dir := t.TempDir()
	src := filepath.Join(dir, "a.webm")
	mustFF(t, ffm, "-f", "lavfi", "-i", "color=red:s=64x48:d=1:r=10,format=rgba,colorchannelmixer=aa=0", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", src)
	si := probe(context.Background(), ffm, src)
	for _, pal := range []string{"", "frame"} {
		dst := filepath.Join(dir, "out"+pal+".gif")
		args := buildArgs(formats["gif"], StartReq{GifPalette: pal}, src, dst, si, false, nil)
		if out, err := exec.Command(ffm, args...).CombinedOutput(); err != nil {
			t.Fatalf("%v\n%s", err, lastLines(out))
		}
		if a := alphaOf(t, ffm, dst); a != 0 {
			t.Errorf("палитра %q: прозрачность %d, ждали 0", pal, a)
		}
	}
}

func TestGifFilter(t *testing.T) {
	if s := gifFilter("15", "480", false); !strings.Contains(s, "[s0]palettegen[p]") || !strings.Contains(s, "[p]paletteuse") {
		t.Error(s)
	}
	if s := gifFilter("15", "480", true); !strings.Contains(s, "stats_mode=single") || !strings.Contains(s, "new=1") {
		t.Error(s)
	}
}

func TestNaturalLess(t *testing.T) {
	names := []string{"a10.png", "a2.png", "A1.png", "b.png", "a002.png", "a.png"}
	slices.SortFunc(names, func(x, y string) int {
		if naturalLess(x, y) {
			return -1
		}
		if naturalLess(y, x) {
			return 1
		}
		return 0
	})
	if i, j := slices.Index(names, "a2.png"), slices.Index(names, "a10.png"); i > j {
		t.Errorf("%v", names)
	}
	if names[0] != "a.png" && names[0] != "A1.png" || names[len(names)-1] != "b.png" {
		t.Errorf("%v", names)
	}
}

func TestJoinGroups(t *testing.T) {
	d := filepath.Join("x", "shots")
	files := []string{
		filepath.Join(d, "f10.png"), filepath.Join(d, "f2.png"), filepath.Join(d, "f1.png"),
		filepath.Join(d, "one.jpg"),                                                 // один JPG: видео не образует
		filepath.Join("x", "other", "a.jpeg"), filepath.Join("x", "other", "b.JPG"), // расширения одного типа
		filepath.Join("x", "clip.mp4"), filepath.Join("x", "anim.gif"),
	}
	g := joinGroups(files)
	if len(g) != 2 {
		t.Fatalf("%v", g)
	}
	if g[0][0] != filepath.Join(d, "f1.png") || g[0][2] != filepath.Join(d, "f10.png") || len(g[1]) != 2 {
		t.Errorf("%v", g)
	}
	for in, want := range map[string]string{
		"clip_000001.png":              "clip",
		"shot 12.png":                  "shot",
		filepath.Join("r", "0001.png"): "r",
		"v2_final.png":                 "v2_final",
	} {
		if got := joinStem(in); got != want {
			t.Errorf("%s: %s, ждали %s", in, got, want)
		}
	}
}

func TestJoinRate(t *testing.T) {
	for in, want := range map[string]string{"": "25", "abc": "25", "0": "25", "1000": "25", "30": "30", "23.976": "23.976"} {
		if s, _ := joinRate(StartReq{JoinFPS: in}); s != want {
			t.Errorf("%q: %s", in, s)
		}
	}
}

func frameCount(t *testing.T, ffm, file string) int {
	t.Helper()
	out, _ := exec.Command(ffm, "-hide_banner", "-i", file, "-map", "0:v:0", "-f", "null", "-").CombinedOutput()
	i := strings.LastIndex(string(out), "frame=")
	if i < 0 {
		t.Fatalf("%s: нет счётчика кадров\n%s", file, out)
	}
	fields := strings.Fields(string(out)[i+len("frame="):])
	n, err := strconv.Atoi(fields[0])
	if err != nil {
		t.Fatal(err)
	}
	return n
}

// Туда и обратно через программу целиком, с прозрачностью и неудобными именами
func TestSequenceRoundTrip(t *testing.T) {
	ffm := ffmpegOrSkip(t)
	dir := filepath.Join(t.TempDir(), "100% проба's")
	os.MkdirAll(dir, 0o755)
	src := filepath.Join(dir, "кли%п 1.webm")
	mustFF(t, ffm, "-f", "lavfi", "-i", "testsrc2=s=64x48:d=2:r=25,format=rgba,colorchannelmixer=aa=0.5", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", src)

	s := &Server{}
	base := StartReq{Format: "pngseq", SameDir: true, Jobs: 1, CRF: 23, ABR: 128, Preset: "ultrafast"}
	req := base
	req.Files = []string{src}
	s.run(req, ffm)
	fs := s.files[0]
	if fs.Status != "ok" {
		t.Fatalf("%s %s\n%s", fs.Status, fs.Hint, strings.Join(s.log, "\n"))
	}
	frames := seqFrames(fs.Dst, src)
	if len(frames) != 50 {
		t.Fatalf("кадров %d, ждали 50 в %s", len(frames), fs.Dst)
	}
	if want := "кли%п 1_000001.png"; filepath.Base(frames[0]) != want {
		t.Errorf("%s, ждали %s", filepath.Base(frames[0]), want)
	}
	if a := alphaOf(t, ffm, frames[0]); a < 110 || a > 145 {
		t.Errorf("прозрачность кадра %d", a)
	}
	if fs.DstSize == 0 || fs.Msg == "" {
		t.Errorf("%+v", fs)
	}

	// второй раз без перезаписи: пропуск, папка не тронута
	s.run(req, ffm)
	if s.files[0].Status != "skipped" {
		t.Errorf("повтор: %s", s.files[0].Status)
	}
	// копия: новая папка рядом
	copyReq := req
	copyReq.Copy = true
	s.run(copyReq, ffm)
	if s.files[0].Dst == fs.Dst || s.files[0].Status != "ok" {
		t.Errorf("копия: %+v", s.files[0])
	}
	os.RemoveAll(s.files[0].Dst)
	// обрезка точно по кадрам, и перезапись не оставляет старые кадры, а чужой файл не трогает
	foreign := filepath.Join(fs.Dst, "заметка.png")
	os.WriteFile(foreign, []byte("x"), 0o644)
	cut := req
	cut.Overwrite = true
	cut.Trims = map[string]Trim{src: {Start: 0.4, End: 1.4}}
	s.run(cut, ffm)
	if got := len(seqFrames(fs.Dst, src)); got != 25 {
		t.Errorf("после обрезки кадров %d, ждали 25: %s %s", got, s.files[0].Status, s.files[0].Hint)
	}
	if !fileExists(foreign) {
		t.Error("чужой файл удалён")
	}
	os.Remove(foreign)

	// частота: 10 кадров в секунду из 25 даёт 10 кадров на секунду обрезки
	fpsReq := cut
	fpsReq.FPS = "10"
	s.run(fpsReq, ffm)
	if got := len(seqFrames(fs.Dst, src)); got != 10 {
		t.Errorf("FPS 10: кадров %d", got)
	}
	s.run(req, ffm) // пропуск: кадры уже есть
	full := cut
	full.Trims = nil
	s.run(full, ffm)

	// обратно: прозрачность и число кадров
	for _, id := range []string{"webm", "webmvp8", "prores4444"} {
		back := base
		back.Format, back.Join, back.JoinFPS, back.Files, back.Overwrite = id, true, "25", seqFrames(fs.Dst, src), true
		s.run(back, ffm)
		if len(s.files) != 1 {
			t.Fatalf("%s: результатов %d", id, len(s.files))
		}
		r := s.files[0]
		if r.Status != "ok" {
			t.Fatalf("%s: %s %s\n%s", id, r.Status, r.Hint, strings.Join(s.log, "\n"))
		}
		if !strings.HasPrefix(filepath.Base(r.Dst), "кли%п 1.") {
			t.Errorf("имя %s", r.Dst)
		}
		if n := frameCount(t, ffm, r.Dst); n != 50 {
			t.Errorf("%s: кадров %d, ждали 50", id, n)
		}
		if a := alphaOf(t, ffm, r.Dst); a < 110 || a > 145 {
			t.Errorf("%s: прозрачность %d", id, a)
		}
	}
}

// Кадры с пропуском в нумерации и без дополнения нулями; частота не из целых
func TestJoinOrderAndRate(t *testing.T) {
	ffm := ffmpegOrSkip(t)
	dir := t.TempDir()
	var files []string
	for i, n := range []int{1, 2, 3, 10, 20} { // пропуски; яркость растёт с номером
		p := filepath.Join(dir, fmt.Sprintf("f%d.png", n))
		mustFF(t, ffm, "-f", "lavfi", "-i", fmt.Sprintf("color=0x%02x%02x%02x:s=16x16", i*50, i*50, i*50), "-frames:v", "1", p)
		files = append(files, p)
	}
	slices.Reverse(files)
	s := &Server{}
	for _, fps := range []string{"12", "25", "29.97", "60"} { // каждый кадр ровно один раз при любой частоте
		req := StartReq{Format: "qtrle", Join: true, JoinFPS: fps, SameDir: true, Jobs: 1, Overwrite: true, Files: files}
		s.run(req, ffm)
		if s.files[0].Status != "ok" {
			t.Fatalf("%s: %s %s", fps, s.files[0].Status, s.files[0].Hint)
		}
		dst := s.files[0].Dst
		if n := frameCount(t, ffm, dst); n != 5 {
			t.Errorf("%s: кадров %d, ждали 5", fps, n)
		}
		out := filepath.Join(dir, "chk_%d.bmp")
		mustFF(t, ffm, "-i", dst, "-fps_mode", "passthrough", "-pix_fmt", "bgr24", out)
		prev := -1
		for i := 1; i <= 5; i++ {
			b, err := os.ReadFile(filepath.Join(dir, fmt.Sprintf("chk_%d.bmp", i)))
			if err != nil {
				t.Fatal(err)
			}
			v := int(b[len(b)-1])
			if v <= prev {
				t.Errorf("%s: кадр %d не по порядку: %d после %d", fps, i, v, prev)
			}
			prev = v
		}
	}
}

func TestJoinRejectsDifferentSizes(t *testing.T) {
	ffm := ffmpegOrSkip(t)
	dir := t.TempDir()
	a, b := filepath.Join(dir, "f1.png"), filepath.Join(dir, "f2.png")
	mustFF(t, ffm, "-f", "lavfi", "-i", "color=red:s=16x16", "-frames:v", "1", a)
	mustFF(t, ffm, "-f", "lavfi", "-i", "color=red:s=32x16", "-frames:v", "1", b)
	s := &Server{}
	s.run(StartReq{Format: "mp4", Join: true, SameDir: true, Jobs: 1, CRF: 23, ABR: 128, Preset: "ultrafast", Files: []string{a, b}}, ffm)
	if s.files[0].Status != "error" || !strings.Contains(s.files[0].Hint, "32×16") {
		t.Errorf("%+v", s.files[0])
	}
}

// Отмена и ошибка не оставляют пустую папку и чужой след; без галочки картинки конвертируются поштучно
func TestSeqCleanupAndNoJoin(t *testing.T) {
	ffm := ffmpegOrSkip(t)
	dir := t.TempDir()
	audio := filepath.Join(dir, "a.wav")
	mustFF(t, ffm, "-f", "lavfi", "-i", "sine=d=0.2", audio)
	s := &Server{}
	s.run(StartReq{Format: "pngseq", SameDir: true, Jobs: 1, Files: []string{audio}}, ffm)
	if s.files[0].Status != "error" {
		t.Errorf("звук: %s", s.files[0].Status)
	}
	if st, err := os.Stat(s.files[0].Dst); err == nil && st.IsDir() {
		t.Errorf("осталась папка %s", s.files[0].Dst)
	}

	a, b := filepath.Join(dir, "f1.png"), filepath.Join(dir, "f2.png")
	mustFF(t, ffm, "-f", "lavfi", "-i", "color=red:s=16x16", "-frames:v", "1", a)
	mustFF(t, ffm, "-f", "lavfi", "-i", "color=red:s=16x16", "-frames:v", "1", b)
	s.run(StartReq{Format: "mp4", SameDir: true, Jobs: 1, CRF: 23, ABR: 128, Preset: "ultrafast", Files: []string{a, b}}, ffm)
	if len(s.files) != 2 {
		t.Errorf("без галочки результатов %d", len(s.files))
	}
	// галочка при формате, который не умеет видео, ничего не меняет
	s.run(StartReq{Format: "jpg", Join: true, SameDir: true, Jobs: 1, Overwrite: true, Files: []string{a, b}}, ffm)
	if len(s.files) != 2 {
		t.Errorf("jpg с галочкой: результатов %d", len(s.files))
	}
}
