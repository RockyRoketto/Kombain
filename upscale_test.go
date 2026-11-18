package main

import (
	"bytes"
	"image"
	"image/color"
	_ "image/jpeg"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	xdraw "golang.org/x/image/draw"
)

// upFake: подставная нейросеть — ×4 «по пикселям»; заодно проверяет, что на вход пришла непрозрачная картинка
func upFake(t *testing.T) func(in, out string) error {
	return func(in, out string) error {
		b, err := os.ReadFile(in)
		if err != nil {
			return err
		}
		im, err := png.Decode(bytes.NewReader(b))
		if err != nil {
			return err
		}
		src := bgToNRGBA(im)
		if upHasAlpha(src) {
			t.Error("на вход нейросети ушла прозрачность")
		}
		w, h := src.Rect.Dx(), src.Rect.Dy()
		ob, _ := upPNG(upScale(src, w*4, h*4, xdraw.NearestNeighbor))
		return os.WriteFile(out, ob, 0o644)
	}
}

func upDecode(t *testing.T, b []byte) *image.NRGBA {
	t.Helper()
	im, err := png.Decode(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	return bgToNRGBA(im)
}

func TestUpscaleOpaque(t *testing.T) {
	src := image.NewNRGBA(image.Rect(0, 0, 10, 6))
	for i := range src.Pix {
		src.Pix[i] = 255
	}
	src.SetNRGBA(3, 2, color.NRGBA{200, 10, 10, 255})
	for _, f := range []int{2, 4} {
		b, err := upWith(src, f, t.TempDir(), upFake(t))
		if err != nil {
			t.Fatal(err)
		}
		out := upDecode(t, b)
		if out.Rect.Dx() != 10*f || out.Rect.Dy() != 6*f {
			t.Fatalf("×%d: размер %v", f, out.Rect)
		}
		if upHasAlpha(out) {
			t.Fatalf("×%d: появилась прозрачность", f)
		}
	}
}

func TestUpscaleKeepsAlpha(t *testing.T) {
	// красный квадрат посередине, вокруг полностью прозрачно (цвет там чёрный, как после удаления фона)
	src := image.NewNRGBA(image.Rect(0, 0, 16, 16))
	for y := 4; y < 12; y++ {
		for x := 4; x < 12; x++ {
			src.SetNRGBA(x, y, color.NRGBA{220, 20, 20, 255})
		}
	}
	b, err := upWith(src, 2, t.TempDir(), upFake(t))
	if err != nil {
		t.Fatal(err)
	}
	out := upDecode(t, b)
	if out.Rect.Dx() != 32 {
		t.Fatalf("размер %v", out.Rect)
	}
	if a := out.NRGBAAt(1, 1).A; a != 0 {
		t.Fatalf("угол должен остаться прозрачным, альфа %d", a)
	}
	if c := out.NRGBAAt(16, 16); c.A != 255 || c.R < 200 {
		t.Fatalf("середина: %v", c)
	}
	// край квадрата: полупрозрачный, но красный, а не тёмный (заливка краёв)
	for x := 0; x < 32; x++ {
		if c := out.NRGBAAt(x, 16); c.A > 0 && c.A < 255 && c.R < 150 {
			t.Fatalf("тёмная кайма в %d: %v", x, c)
		}
	}
}

func TestUpFillRGB(t *testing.T) {
	src := image.NewNRGBA(image.Rect(0, 0, 40, 40))
	src.SetNRGBA(20, 20, color.NRGBA{10, 200, 30, 255})
	out := upFillRGB(src)
	if upHasAlpha(out) {
		t.Fatal("остались прозрачные")
	}
	if c := out.NRGBAAt(0, 0); c.G < 150 {
		t.Fatalf("дальний угол не залит цветом края: %v", c)
	}
	if c := out.NRGBAAt(20, 20); c != (color.NRGBA{10, 200, 30, 255}) {
		t.Fatalf("видимая точка изменилась: %v", c)
	}
}

func TestUpscalePixelAndLimits(t *testing.T) {
	src := image.NewNRGBA(image.Rect(0, 0, 4, 4))
	src.SetNRGBA(1, 1, color.NRGBA{255, 0, 0, 255})
	var b bytes.Buffer
	png.Encode(&b, src)
	got, err := upImage(t.Context(), b.Bytes(), 4, "pixel")
	if err != nil {
		t.Fatal(err)
	}
	out := upDecode(t, got)
	// по пикселям: точка (1,1) стала квадратом 4×4 без размытия
	if out.NRGBAAt(4, 4) != (color.NRGBA{255, 0, 0, 255}) || out.NRGBAAt(7, 7) != (color.NRGBA{255, 0, 0, 255}) || out.NRGBAAt(8, 8).A != 0 {
		t.Fatal("пиксельный стиль размылся")
	}
	if _, err := upImage(t.Context(), b.Bytes(), 3, ""); err == nil {
		t.Fatal("×3 не бывает")
	}
	if upFits(2049, 100, 4) || !upFits(2048, 2048, 4) || !upFits(4096, 4096, 2) {
		t.Fatal("предел upMaxSide")
	}
}

func TestGenDeriveUpscaleMeta(t *testing.T) {
	m := GenMeta{Upscale: 2, Cutout: true}
	mod := func(m *GenMeta) { m.Upscale = max(m.Upscale, 1) * 4 }
	mod(&m)
	if m.Upscale != 8 || !m.Cutout {
		t.Fatalf("%+v", m)
	}
}

// TestUpscaleLive: настоящий sd-cli. KOMBAIN_UP_CLI — sd-cli.exe, KOMBAIN_UP_MODEL — .pth,
// KOMBAIN_UP_IN — картинка (лучше прозрачная), KOMBAIN_UP_OUT — куда положить результат ×2.
func TestUpscaleLive(t *testing.T) {
	cli, model, in, outp := os.Getenv("KOMBAIN_UP_CLI"), os.Getenv("KOMBAIN_UP_MODEL"), os.Getenv("KOMBAIN_UP_IN"), os.Getenv("KOMBAIN_UP_OUT")
	if cli == "" {
		t.Skip("KOMBAIN_UP_CLI не задан")
	}
	b, err := os.ReadFile(in)
	if err != nil {
		t.Fatal(err)
	}
	im, _, err := image.Decode(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	src := bgToNRGBA(im)
	run := func(i, o string) error {
		cmd := exec.Command(cli, "-M", "upscale", "--upscale-model", model, "-i", i, "-o", o)
		hide(cmd)
		return cmd.Run()
	}
	start := time.Now()
	res, err := upWith(src, 2, t.TempDir(), run)
	if err != nil {
		t.Fatal(err)
	}
	out := upDecode(t, res)
	t.Logf("%v → %v за %v, прозрачность %v, %d КБ", src.Rect.Size(), out.Rect.Size(), time.Since(start), upHasAlpha(out), len(res)/1024)
	if upHasAlpha(src) != upHasAlpha(out) {
		t.Fatal("прозрачность не сохранилась")
	}
	os.WriteFile(outp, res, 0o644)
}

func TestUpOutPathAndStyle(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "pic.jpg")
	if got := upOutPath(src, 2, ""); got != filepath.Join(dir, "pic-x2.png") {
		t.Fatalf("upOutPath = %s", got)
	}
	os.WriteFile(filepath.Join(dir, "pic-x2.png"), []byte("x"), 0o644)
	if got := upOutPath(src, 2, ""); got != filepath.Join(dir, "pic-x2-2.png") {
		t.Fatalf("существующий файл не должен затираться: %s", got)
	}
	if upOutPath(src, 4, "") != filepath.Join(dir, "pic-x4.png") {
		t.Fatal("×4 — своё имя")
	}
	out := filepath.Join(dir, "out")
	if got := upOutPath(src, 2, out); got != filepath.Join(out, "pic-x2.png") {
		t.Fatalf("в свою папку: %s", got)
	}
	if got := bgOutPath(src, out); got != filepath.Join(out, "pic-nobg.png") {
		t.Fatalf("убрать фон в свою папку: %s", got)
	}
	if upStyleOf("photo") != "" || upStyleOf("drawn") != "illus" || upStyleOf("pixel") != "pixel" || !upDrawnStyles[upStyleOf("drawn")] {
		t.Fatal("upStyleOf")
	}
}
