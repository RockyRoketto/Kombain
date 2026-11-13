package main

import (
	"bytes"
	"context"
	"image/png"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Проверка на настоящем движке, вручную: в CI его нет, поэтому без переменных тест пропускается.
//
//	KOMBAIN_SD_EXE    путь к sd-server.exe
//	KOMBAIN_SD_MODEL  модель SDXL одним файлом
//	KOMBAIN_SD_TAE    taesdxl (необязательно)
//	KOMBAIN_SD_UPSCALE папка моделей, в ней upscale/RealESRGAN_x4plus.pth (необязательно)
func TestSDLive(t *testing.T) {
	exe, model := os.Getenv("KOMBAIN_SD_EXE"), os.Getenv("KOMBAIN_SD_MODEL")
	if exe == "" || model == "" {
		t.Skip("no KOMBAIN_SD_EXE / KOMBAIN_SD_MODEL")
	}
	models := t.TempDir()
	if up := os.Getenv("KOMBAIN_SD_UPSCALE"); up != "" {
		models = up
	}
	s := newSDServer()
	s.exe, s.models, s.logPath = exe, models, filepath.Join(t.TempDir(), "sd.log")
	defer s.Stop()

	set := ModelSet{Checkpoint: model, TAE: os.Getenv("KOMBAIN_SD_TAE")}
	start := time.Now()
	if err := s.Load(context.Background(), set); err != nil {
		t.Fatal(err, logTail(s.logPath, 2000))
	}
	t.Logf("server up in %v", time.Since(start))

	frames := 0
	p := GenParams{Prompt: "a red fox in the snow, photo", Width: 1024, Height: 1024, Steps: 12, CFG: 7, Seed: 1}
	if set.TAE != "" {
		p.Preview, p.PreviewEvery = "tae", 3
	}
	start = time.Now()
	img, err := s.Generate(context.Background(), p, func(g GenProgress) {
		if g.Preview != nil {
			frames++
			t.Logf("frame at step %d/%d, %d bytes", g.PreviewStep, g.Total, len(g.Preview))
		}
	})
	if err != nil {
		t.Fatal(err, logTail(s.logPath, 2000))
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(img))
	if err != nil || cfg.Width != 1024 || cfg.Height != 1024 {
		t.Fatalf("png %v %+v", err, cfg)
	}
	t.Logf("image in %v, %d preview frames", time.Since(start), frames)
	if out := os.Getenv("KOMBAIN_SD_OUT"); out != "" {
		os.WriteFile(filepath.Join(out, "live.png"), img, 0o644)
	}

	// отмена посреди шагов
	ctx, cancel := context.WithCancel(context.Background())
	start = time.Now()
	_, err = s.Generate(ctx, GenParams{Prompt: "cat", Width: 1024, Height: 1024, Steps: 30, CFG: 7, Seed: 2}, func(g GenProgress) {
		if g.Step >= 3 {
			cancel()
		}
	})
	if ctx.Err() == nil || err == nil {
		t.Fatalf("cancel: %v", err)
	}
	t.Logf("cancelled in %v", time.Since(start))

	if os.Getenv("KOMBAIN_SD_UPSCALE") != "" {
		small, _ := s.Generate(context.Background(), GenParams{Prompt: "cat", Width: 512, Height: 512, Steps: 8, CFG: 7, Seed: 3}, nil)
		start = time.Now()
		big, err := s.Upscale(context.Background(), small, "", 1)
		if err != nil {
			t.Fatal(err)
		}
		cfg, _ := png.DecodeConfig(bytes.NewReader(big))
		t.Logf("upscale 512 -> %dx%d in %v", cfg.Width, cfg.Height, time.Since(start))
	}
}
