package main

import (
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestPlanRate(t *testing.T) {
	// 5 минут 1080p в 25 МБ: звук урезается, разрешение — до 480p
	si := srcInfo{dur: 300, w: 1920, h: 1080, fps: 30, audio: true}
	r, err := planRate(25<<20, si, StartReq{ABR: 192})
	if err != nil || r.ak != 80 || r.vk < 550 || r.vk > 600 || r.height != "480" {
		t.Fatalf("%+v %v", r, err)
	}
	// вертикальное видео: меньшая сторона — ширина
	si.w, si.h = 1080, 1920
	if r, _ = planRate(25<<20, si, StartReq{ABR: 192}); r.height != "852" {
		t.Fatalf("вертикальное: %+v", r)
	}
	// места хватает — разрешение не трогаем; своя высота важнее
	if r, _ = planRate(200<<20, si, StartReq{ABR: 192}); r.height != "" || r.ak != 192 {
		t.Fatalf("с запасом: %+v", r)
	}
	if r, _ = planRate(25<<20, si, StartReq{ABR: 192, Height: "720"}); r.height != "720" {
		t.Fatalf("своя высота: %+v", r)
	}
	if _, err = planRate(5<<20, srcInfo{dur: 3600, audio: true}, StartReq{ABR: 128}); err == nil || !strings.Contains(err.Error(), "хотя бы") {
		t.Fatalf("час в 5 МБ: %v", err)
	}
	if _, err = planRate(5<<20, srcInfo{}, StartReq{}); err == nil {
		t.Fatal("без длительности должна быть ошибка")
	}
}

func TestRateArgs(t *testing.T) {
	a := formats["mp4"].Args
	p1 := rateArgs(a, &rate{vk: 500, ak: 64, pass: 1, dir: "d"})
	for _, bad := range []string{"-crf", "-c:a", "-b:a", "-movflags"} {
		if slices.Contains(p1, bad) {
			t.Errorf("первый проход: лишний %s в %v", bad, p1)
		}
	}
	if !slices.Contains(p1, "-an") || !slices.Contains(p1, "-pass") || !slices.Contains(p1, "500k") {
		t.Errorf("первый проход: %v", p1)
	}
	p2 := strings.Join(rateArgs(a, &rate{vk: 500, ak: 64, pass: 2, dir: "d"}), " ")
	if !strings.Contains(p2, "-b:a 64k") || !strings.Contains(p2, "-c:a aac") || !strings.Contains(p2, "-pass 2") || strings.Contains(p2, "-an") {
		t.Errorf("второй проход: %s", p2)
	}
	h := strings.Join(rateArgs(formats["mp4h265"].Args, &rate{vk: 500, ak: 64, pass: 2}), " ")
	if !strings.Contains(h, "-x265-params pass=2:stats=x265.log") || strings.Contains(h, "-pass ") {
		t.Errorf("x265: %s", h)
	}
	w := strings.Join(rateArgs(formats["webm"].Args, &rate{vk: 500, ak: 64, pass: 2}), " ")
	if strings.Contains(w, "-b:v 0") || !strings.Contains(w, "-b:v 500k") {
		t.Errorf("webm: %s", w)
	}
}

// с настоящим ffmpeg: «Сжать», защита «не больше оригинала» и «уложить в N МБ»
func TestCompressFFmpeg(t *testing.T) {
	ffm, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("нет ffmpeg")
	}
	dir := t.TempDir()
	mk := func(name string, args ...string) string {
		p := filepath.Join(dir, name)
		a := append([]string{"-v", "error", "-y"}, args...)
		if out, err := exec.Command(ffm, append(a, p)...).CombinedOutput(); err != nil {
			t.Skipf("не удалось сделать %s: %s", name, out)
		}
		return p
	}
	src := []string{"-f", "lavfi", "-i", "testsrc2=s=1280x720:d=8", "-f", "lavfi", "-i", "sine=d=8", "-pix_fmt", "yuv420p", "-c:v", "libx264"}
	big := mk("big.mp4", append(src, "-crf", "2", "-preset", "ultrafast")...)
	tiny := mk("tiny.mp4", append(src, "-crf", "51", "-preset", "veryslow", "-c:a", "aac", "-b:a", "16k")...)
	gif := mk("a.gif", "-f", "lavfi", "-i", "testsrc2=s=64x64:d=1")
	jpg := mk("a.jpg", "-f", "lavfi", "-i", "testsrc2=s=800x600", "-frames:v", "1", "-q:v", "1")

	s := &Server{}
	base := StartReq{Format: "small", Codec: "h264", CRF: 23, ABR: 128, Preset: "ultrafast", SameDir: true, Jobs: 2}
	run := func(req StartReq) []*FileState {
		s.run(req, ffm)
		return s.files
	}
	req := base
	req.Files = []string{big, tiny, gif, jpg}
	fs := run(req)
	want := []string{"ok", "kept", "kept", "ok"}
	for i, f := range fs {
		if f.Status != want[i] {
			t.Errorf("%s: %s (%s %s), ждали %s\n%s", f.Name, f.Status, f.Msg, f.Hint, want[i], strings.Join(s.log, "\n"))
		}
	}
	if fs[0].DstSize == 0 || fs[0].DstSize >= fs[0].SrcSize || filepath.Ext(fs[3].Dst) != ".jpg" {
		t.Errorf("сжатие: %+v %+v", fs[0], fs[3])
	}
	if fileExists(fs[1].Dst) {
		t.Errorf("не сжавшийся результат остался: %s", fs[1].Dst)
	}

	// уложить в 0,4 МБ — два прохода, H.264 и H.265
	for _, codec := range []string{"h264", "h265"} {
		req = base
		req.Codec, req.TargetMB, req.Overwrite, req.Files = codec, 0.4, true, []string{big}
		f := run(req)[0]
		if f.Status != "ok" || f.DstSize > 4<<20/10 || f.DstSize < 1<<20/10 {
			t.Errorf("%s в 0,4 МБ: %+v\n%s", codec, f, strings.Join(s.log, "\n"))
		}
	}
	// обычный формат с размером: уже влезает — один проход по CRF
	req = base
	req.Format, req.TargetMB, req.Overwrite, req.Files = "webm", 5, true, []string{tiny}
	if f := run(req)[0]; f.Status != "ok" || f.DstSize > 5<<20 {
		t.Errorf("webm: %+v", f)
	}
}
