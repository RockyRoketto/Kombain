package main

import (
	"context"
	"image"
	"image/color"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestImgScaleExpr(t *testing.T) {
	if imgScaleExpr(imgOpts{}) != "" {
		t.Error("без размера фильтра быть не должно")
	}
	if imgScaleExpr(imgOpts{Resize: "percent", Value: 100}) != "" {
		t.Error("100% — ничего не менять")
	}
	if imgScaleExpr(imgOpts{Resize: "percent", Value: 150, NoUp: true}) != "" {
		t.Error("увеличение запрещено")
	}
	if !strings.Contains(imgScaleExpr(imgOpts{Resize: "width", Value: 800, NoUp: true}), "min(800,iw)") {
		t.Error("ширина с запретом увеличения")
	}
}

func TestImgOutPath(t *testing.T) {
	d := t.TempDir()
	src := filepath.Join(d, "a.PNG")
	os.WriteFile(src, []byte("x"), 0o644)
	if got := imgOutPath(src, imgOpts{Format: "jpg"}); filepath.Base(got) != "a-edit.jpg" {
		t.Errorf("получилось %s", got)
	}
	os.WriteFile(filepath.Join(d, "a-edit.png"), []byte("x"), 0o644)
	if got := imgOutPath(src, imgOpts{}); filepath.Base(got) != "a-edit-2.png" {
		t.Errorf("занятое имя не обошли: %s", got)
	}
	if imgOutExt("b.bmp", imgOpts{}) != ".png" {
		t.Error("bmp без смены формата должен стать png")
	}
}

func imgTestPNG(t *testing.T, p string, w, h int, c color.NRGBA) {
	t.Helper()
	im := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			im.SetNRGBA(x, y, c)
		}
	}
	f, err := os.Create(p)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	png.Encode(f, im)
}

func imgSize(t *testing.T, p string) (int, int) {
	t.Helper()
	f, err := os.Open(p)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	cfg, _, err := image.DecodeConfig(f)
	if err != nil {
		t.Fatal(err)
	}
	return cfg.Width, cfg.Height
}

// с настоящим ffmpeg: размер, формат и водяной знак
func TestImgFileReal(t *testing.T) {
	ffm, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg не найден")
	}
	d := t.TempDir()
	src := filepath.Join(d, "pic.png")
	imgTestPNG(t, src, 400, 301, color.NRGBA{200, 30, 30, 255})
	ctx := context.Background()

	out, err := runImgFile(ctx, ffm, src, imgOpts{Resize: "width", Value: 200, Format: "png"})
	if err != nil {
		t.Fatal(err)
	}
	if w, h := imgSize(t, out); w != 200 || h != 150 && h != 151 {
		t.Errorf("ширина 200: %dx%d", w, h)
	}

	out, err = runImgFile(ctx, ffm, src, imgOpts{Resize: "fit", Value: 100, NoUp: true, Format: "jpg", Quality: 70, Strip: true})
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Ext(out) != ".jpg" {
		t.Errorf("ждали jpg: %s", out)
	}

	out, err = runImgFile(ctx, ffm, src, imgOpts{Resize: "width", Value: 1000, NoUp: true})
	if err != nil {
		t.Fatal(err)
	}
	if w, _ := imgSize(t, out); w != 400 {
		t.Errorf("увеличение запрещено, а ширина %d", w)
	}

	// водяной знак: непрозрачный белый квадрат в углу
	wm := filepath.Join(d, "wm.png")
	imgTestPNG(t, wm, 50, 50, color.NRGBA{255, 255, 255, 255})
	out, err = runImgFile(ctx, ffm, src, imgOpts{WmPath: wm, WmPos: "br", WmSize: 25, WmAlpha: 100, Format: "png"})
	if err != nil {
		t.Fatal(err)
	}
	f, _ := os.Open(out)
	defer f.Close()
	im, err := png.Decode(f)
	if err != nil {
		t.Fatal(err)
	}
	if r, _, _, _ := im.At(385, 290).RGBA(); r>>8 < 240 {
		t.Errorf("в углу ждали белый знак, а там %d", r>>8)
	}
	if r, g, _, _ := im.At(10, 10).RGBA(); r>>8 < 190 || g>>8 > 40 {
		t.Error("угол вне знака испорчен")
	}

	// прозрачный PNG в JPG ложится на белый, а не на чёрный
	tr := filepath.Join(d, "tr.png")
	imgTestPNG(t, tr, 40, 40, color.NRGBA{0, 0, 0, 0})
	out, err = runImgFile(ctx, ffm, tr, imgOpts{Format: "jpg"})
	if err != nil {
		t.Fatal(err)
	}
	jf, _ := os.Open(out)
	defer jf.Close()
	jim, _, err := image.Decode(jf)
	if err != nil {
		t.Fatal(err)
	}
	if r, _, _, _ := jim.At(5, 5).RGBA(); r>>8 < 240 {
		t.Errorf("прозрачное стало не белым: %d", r>>8)
	}
}

// знак не квадратный: ширина 50% картинки, пропорции сохраняются
func TestImgWatermarkAspect(t *testing.T) {
	ffm, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg не найден")
	}
	d := t.TempDir()
	src := filepath.Join(d, "pic.png")
	imgTestPNG(t, src, 400, 300, color.NRGBA{200, 30, 30, 255})
	wm := filepath.Join(d, "wm.png")
	imgTestPNG(t, wm, 100, 40, color.NRGBA{255, 255, 255, 255})
	o := imgOpts{WmPath: wm, WmPos: "br", WmSize: 50, WmAlpha: 100, Format: "png"}
	out := filepath.Join(d, "o.png")
	if err := ffQuiet(context.Background(), ffm, imgArgs(src, out, o)...); err != nil {
		t.Fatal(err)
	}
	f, _ := os.Open(out)
	im, err := png.Decode(f)
	f.Close()
	if err != nil {
		t.Fatal(err)
	}
	white := func(x, y int) bool { r, _, _, _ := im.At(x, y).RGBA(); return r>>8 > 240 }
	// знак 200x80, отступ 8: x 192..392, y 212..292
	if !white(300, 250) || white(300, 200) || white(100, 250) || white(300, 296) {
		t.Error("знак стоит не там или не тех пропорций")
	}
}
