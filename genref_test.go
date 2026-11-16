package main

import (
	"bytes"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func refTestImage(w, h int) image.Image {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{uint8(x), uint8(y), 90, 255})
		}
	}
	return img
}

func TestGenRefSaveAndBase(t *testing.T) {
	aiTestEnv(t)
	var jb bytes.Buffer
	jpeg.Encode(&jb, refTestImage(3000, 1000), nil)
	id, w, h, err := genRefSave(jb.Bytes())
	if err != nil || w != genRefSide || h != 512 {
		t.Fatalf("save: %v %d×%d", err, w, h)
	}
	if !fileExists(genRefPath(id)) {
		t.Fatal("файла нет")
	}
	id2, _, _, _ := genRefSave(jb.Bytes())
	if id2 != id {
		t.Errorf("та же картинка — другой id: %s %s", id, id2)
	}
	b, err := genRefBase(id, 832, 1216)
	if err != nil {
		t.Fatal(err)
	}
	cfg, _ := png.DecodeConfig(bytes.NewReader(b))
	if cfg.Width != 832 || cfg.Height != 1216 {
		t.Errorf("основа %d×%d, ждали 832×1216", cfg.Width, cfg.Height)
	}
	small, _ := genRefRead(id, llmLookSide)
	cfg, _ = png.DecodeConfig(bytes.NewReader(small))
	if max(cfg.Width, cfg.Height) != llmLookSide {
		t.Errorf("для помощника %d×%d", cfg.Width, cfg.Height)
	}
	if _, _, _, err := genRefSave([]byte("not an image")); err == nil {
		t.Error("мусор принят")
	}
	var tiny bytes.Buffer
	png.Encode(&tiny, refTestImage(8, 8))
	if _, _, _, err := genRefSave(tiny.Bytes()); err == nil {
		t.Error("крошечная картинка принята")
	}
}

func TestGenRefsClean(t *testing.T) {
	aiTestEnv(t)
	os.MkdirAll(aiRefsDir(), 0o755)
	ids := []string{"0000000000000001", "0000000000000002", "0000000000000003"}
	for _, id := range ids {
		os.WriteFile(filepath.Join(aiRefsDir(), id+".png"), []byte("x"), 0o644)
	}
	got := genRefsClean([]GenRef{
		{ID: ids[0], Role: "base", Weight: 2},
		{ID: ids[1], Role: "base", Weight: 0.5},  // вторая основа не нужна
		{ID: ids[2], Role: "magic", Weight: 0.5}, // неизвестная роль
		{ID: "../../evil", Role: "style"},        // не id
		{ID: "00000000000000ff", Role: "style"},  // файла нет
		{ID: ids[2], Role: "character", Weight: -1},
	})
	if len(got) != 2 || got[0].Weight != 1 || got[1].Role != "character" || got[1].Weight != 0 {
		t.Fatalf("%+v", got)
	}
	if genRefPath("../x") != "" {
		t.Error("путь из чужого id")
	}
}

func TestGenRefStrength(t *testing.T) {
	if s := genRefStrength(0); s != 0.95 {
		t.Errorf("0 → %v", s)
	}
	if s := genRefStrength(1); s < 0.349 || s > 0.351 {
		t.Errorf("1 → %v", s)
	}
	if genRefStrength(0.3) <= genRefStrength(0.7) {
		t.Error("похожее должно рисоваться слабее")
	}
}

func TestLLMRefText(t *testing.T) {
	refs := []GenRef{{Role: "character", Weight: 0.8}, {Role: "style", Weight: 0.2}, {Role: "base", Weight: 0.5}, {Role: "character", Weight: 0.5}}
	desc := []string{"A red fox.", "Soft watercolor. Pale palette.", "A room with a window.", "A grey cat."}
	req := "@1 reads a book"
	block := llmRefBlock(req, refs, desc)
	for _, want := range []string{"@1 character, follow closely: A red fox.", "@3 base, follow loosely: A room"} {
		if !strings.Contains(block, want) {
			t.Errorf("в блоке нет %q:\n%s", want, block)
		}
	}
	if strings.Contains(block, "watercolor") || strings.Contains(block, "@4") {
		t.Errorf("стиль и персонаж без ссылки — не помощнику:\n%s", block)
	}
	tail := llmTail(refs, desc, func(n int) bool { return llmMentions(req, n) })
	if tail != "A grey cat. Style: Soft watercolor." {
		t.Errorf("хвост: %q", tail)
	}
	if got := llmJoin("A fox in a cafe.", tail); got != "A fox in a cafe. A grey cat. Style: Soft watercolor." {
		t.Errorf("join: %q", got)
	}
	if llmMentions("@12 and @3", 1) || !llmMentions("@12 and @1.", 1) || !llmMentions("x @3", 3) {
		t.Error("llmMentions")
	}
	if llmCloseness(0.9) != "follow closely" || llmCloseness(0.1) != "light hint" {
		t.Error("llmCloseness")
	}
}
