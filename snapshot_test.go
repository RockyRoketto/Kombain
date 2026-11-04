package main

import (
	"bytes"
	"fmt"
	"image"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestSnapPlan(t *testing.T) {
	cases := []struct{ name, out, dec, pix string }{
		{"vp9 alpha", "  Stream #0:0: Video: vp9 (Profile 0), yuv420p(tv), 320x240\n    Metadata:\n      alpha_mode      : 1\n      DURATION : 1\n", "libvpx-vp9", "rgba"},
		{"vp8 alpha", "  Stream #0:0: Video: vp8, yuv420p(tv), 320x240\n      ALPHA_MODE      : 1\n", "libvpx", "rgba"},
		{"vp9 no alpha", "  Stream #0:0: Video: vp9 (Profile 0), yuv420p(tv), 320x240\n", "", ""},
		{"alpha_mode of another stream", "  Stream #0:0: Video: vp9, yuv420p(tv), 320x240\n  Stream #0:1: Audio: opus\n      alpha_mode      : 1\n", "", ""},
		{"prores", "  Stream #0:0: Video: prores (4444) (ap4h / 0x68347061), yuva444p12le(tv), 320x240\n", "", "rgba64be"},
		{"qtrle", "  Stream #0:0: Video: qtrle (rle  / 0x20656C72), argb(progressive), 320x240\n", "", "rgba"},
		{"apng", "  Stream #0:0: Video: apng, rgba(pc), 320x240\n", "", "rgba"},
		{"h264", "  Stream #0:0: Video: h264 (High), yuv420p(progressive), 320x240\n", "", ""},
		{"10 bit", "  Stream #0:0: Video: hevc (Main 10), yuv420p10le(tv), 320x240\n", "", ""},
		{"palette", "  Stream #0:0: Video: gif, pal8, 320x240\n", "", ""},
		{"audio only", "  Stream #0:0: Audio: mp3, 44100 Hz\n", "", ""},
	}
	for _, c := range cases {
		dec, pix := snapPlan(c.out)
		if dec != c.dec || pix != c.pix {
			t.Errorf("%s: %q %q, want %q %q", c.name, dec, pix, c.dec, c.pix)
		}
	}
}

func TestSnapName(t *testing.T) {
	if got := snapName(`D:\a\видео.mov`, 83.456); got != "видео_00-01-23-456.png" && got != `D:\a\видео_00-01-23-456.png` {
		t.Error(got)
	}
	if got := snapName("x.mp4", 3723.0005); got != "x_01-02-03-001.png" {
		t.Error(got)
	}
}

func TestSnapPublishKeepsExisting(t *testing.T) {
	d := t.TempDir()
	dst := filepath.Join(d, "a.png")
	os.WriteFile(dst, []byte("старый"), 0o644)
	tmp := filepath.Join(d, "tmp")
	os.WriteFile(tmp, []byte("новый"), 0o644)
	p, err := snapPublish(tmp, dst)
	if err != nil || filepath.Base(p) != "a (1).png" {
		t.Fatal(p, err)
	}
	if b, _ := os.ReadFile(dst); string(b) != "старый" {
		t.Error("перезаписан существующий файл")
	}
	if b, _ := os.ReadFile(p); string(b) != "новый" {
		t.Error("новый файл не на месте")
	}
}

func snapFF(t *testing.T) string {
	t.Helper()
	ffm, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("нет ffmpeg")
	}
	return ffm
}

func snapMake(t *testing.T, ffm string, args ...string) {
	t.Helper()
	if out, err := exec.Command(ffm, append([]string{"-hide_banner", "-loglevel", "error", "-y"}, args...)...).CombinedOutput(); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
}

func snapDecode(t *testing.T, p string) image.Image {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	img, err := png.Decode(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	return img
}

// половина кадра прозрачна: файл с прозрачностью должен дать PNG, где она настоящая
func TestSaveFrameAlpha(t *testing.T) {
	ffm := snapFF(t)
	d := t.TempDir()
	src := `testsrc2=s=320x240:r=25:d=1,format=rgba,geq=r=r(X\,Y):g=g(X\,Y):b=b(X\,Y):a=if(lt(X\,160)\,0\,255)`
	cases := []struct {
		file string
		enc  []string
	}{
		{"vp9.webm", []string{"-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p"}},
		{"vp8.webm", []string{"-c:v", "libvpx", "-pix_fmt", "yuva420p", "-b:v", "2M", "-auto-alt-ref", "0"}},
		{"prores.mov", []string{"-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuva444p10le"}},
		{"rle.mov", []string{"-c:v", "qtrle", "-pix_fmt", "argb"}},
		{"anim.apng", []string{"-c:v", "apng", "-f", "apng"}},
	}
	for _, c := range cases {
		t.Run(c.file, func(t *testing.T) {
			p := filepath.Join(d, c.file)
			snapMake(t, ffm, append(append([]string{"-f", "lavfi", "-i", src}, c.enc...), p)...)
			out, err := saveFrame(ffm, p, .5, false)
			if err != nil {
				t.Fatal(err)
			}
			img := snapDecode(t, out)
			if img.Bounds().Dx() != 320 || img.Bounds().Dy() != 240 {
				t.Fatal("размер", img.Bounds())
			}
			if _, _, _, a := img.At(40, 120).RGBA(); a > 0x0800 {
				t.Errorf("слева должно быть прозрачно, альфа %#x", a)
			}
			if _, _, _, a := img.At(280, 120).RGBA(); a < 0xf000 {
				t.Errorf("справа должно быть непрозрачно, альфа %#x", a)
			}
		})
	}
}

// без прозрачности в файле не должно появиться лишнего канала
func TestSaveFrameNoAlpha(t *testing.T) {
	ffm := snapFF(t)
	p := filepath.Join(t.TempDir(), "100% кадр.mp4")
	snapMake(t, ffm, "-f", "lavfi", "-i", "testsrc2=s=320x240:r=25:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", p)
	out, err := saveFrame(ffm, p, .5, false)
	if err != nil {
		t.Fatal(err)
	}
	if want := "100% кадр_00-00-00-500.png"; filepath.Base(out) != want {
		t.Error(filepath.Base(out))
	}
	// тип цвета в заголовке PNG: 2 — RGB без альфы (декодер Go этого не различает)
	if b, _ := os.ReadFile(out); len(b) < 26 || b[25] != 2 {
		t.Error("лишний канал")
	}
	// второй раз: тот же кадр не затирает первый
	again, err := saveFrame(ffm, p, .5, false)
	if err != nil || again == out {
		t.Errorf("%q %v", again, err)
	}
}

// в PNG должен попасть кадр, видимый в момент at, в том числе когда at между кадрами,
// и для файла, у которого время начинается не с нуля (копия для просмотра начинается с нуля)
func TestSaveFrameExact(t *testing.T) {
	ffm := snapFF(t)
	d := t.TempDir()
	srcs := map[string][]string{
		"a.mp4": {"-c:v", "libx264", "-pix_fmt", "yuv420p", "-qp", "0"},
		"a.ts":  {"-c:v", "libx264", "-pix_fmt", "yuv420p", "-qp", "0"},
	}
	for name, enc := range srcs {
		p := filepath.Join(d, name)
		snapMake(t, ffm, append(append([]string{"-f", "lavfi", "-i", "testsrc2=s=320x240:r=25:d=4"}, enc...), p)...)
		// at → номер кадра при 25 кадрах в секунду
		for at, n := range map[float64]int{0: 0, .04: 1, .059: 1, 1: 25, 1.019: 25, 1.039: 25, 2.5: 62, 3.96: 99, 5: 99} {
			ref := filepath.Join(d, fmt.Sprintf("ref-%s-%d.png", name, n))
			snapMake(t, ffm, "-i", p, "-vf", fmt.Sprintf(`select=eq(n\,%d)`, n), "-frames:v", "1", "-fps_mode", "passthrough", ref)
			out, err := saveFrame(ffm, p, at, name == "a.ts") // TS окно само не играет, только через копию
			if err != nil {
				t.Fatalf("%s %v: %v", name, at, err)
			}
			a, _ := os.ReadFile(ref)
			b, _ := os.ReadFile(out)
			if !bytes.Equal(a, b) {
				t.Errorf("%s в момент %v: не кадр %d", name, at, n)
			}
		}
	}
}

// плеер показывает оригинал по его меткам времени, а копию для просмотра с нуля
func TestSaveFrameStartOffset(t *testing.T) {
	ffm := snapFF(t)
	d := t.TempDir()
	p := filepath.Join(d, "off.mp4")
	snapMake(t, ffm, "-f", "lavfi", "-i", "testsrc2=s=320x240:r=25:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-qp", "0", "-output_ts_offset", "3", p)
	ref := filepath.Join(d, "ref.png")
	snapMake(t, ffm, "-i", p, "-vf", `select=eq(n\,25)`, "-frames:v", "1", "-fps_mode", "passthrough", ref)
	want, _ := os.ReadFile(ref)
	for _, c := range []struct {
		at    float64
		proxy bool
		name  string
	}{{4.01, false, "off_00-00-04-010.png"}, {1.01, true, "off_00-00-01-010.png"}} {
		out, err := saveFrame(ffm, p, c.at, c.proxy)
		if err != nil {
			t.Fatal(err)
		}
		if filepath.Base(out) != c.name {
			t.Error(filepath.Base(out))
		}
		if got, _ := os.ReadFile(out); !bytes.Equal(got, want) {
			t.Errorf("момент %v, копия %v: не тот кадр", c.at, c.proxy)
		}
	}
}
