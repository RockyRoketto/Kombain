package main

import (
	"bytes"
	"encoding/json"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func tinyPNG(t *testing.T) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := png.Encode(&b, image.NewRGBA(image.Rect(0, 0, 8, 8))); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func TestPNGText(t *testing.T) {
	src := tinyPNG(t)
	// чужой "parameters" (так пишет sd-server) должен замениться, а не задвоиться
	old, err := pngWithText(src, [][2]string{{"parameters", "old"}})
	if err != nil {
		t.Fatal(err)
	}
	b, err := pngWithText(old, [][2]string{{"parameters", "fox, sunset"}, {"kombain", `{"prompt":"лиса на закате"}`}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := png.Decode(bytes.NewReader(b)); err != nil {
		t.Fatalf("PNG испорчен: %v", err)
	}
	tx, err := pngTexts(b)
	if err != nil {
		t.Fatal(err)
	}
	if tx["parameters"] != "fox, sunset" || tx["kombain"] != `{"prompt":"лиса на закате"}` {
		t.Fatalf("тексты: %q", tx)
	}
	if bytes.Count(b, []byte("parameters")) != 1 {
		t.Fatal("parameters задвоился")
	}
	if _, err := pngWithText([]byte("not png"), nil); err == nil {
		t.Fatal("не PNG должен дать ошибку")
	}
}

func TestA1111RoundTrip(t *testing.T) {
	m := GenMeta{Model: "sdxl", App: "Kombain 5.0", Params: GenParams{Prompt: "a red fox, golden hour\nsecond line", Negative: "blurry, text",
		Width: 1216, Height: 832, Steps: 25, CFG: 6.5, Sampler: "euler_a", Seed: 4294967000}}
	s := genA1111(m)
	r, ok := genParseA1111(s)
	if !ok {
		t.Fatalf("не разобрал:\n%s", s)
	}
	if r.Prompt != m.Params.Prompt || r.Negative != "blurry, text" || r.Steps != 25 || r.CFG != 6.5 || r.Seed != 4294967000 ||
		r.Width != 1216 || r.Height != 832 || r.Model != "sdxl" || r.Ratio != "3:2" || r.Exact {
		t.Fatalf("%+v", r)
	}
	// как пишет A1111: без негатива, с кавычками
	r, ok = genParseA1111("cat\nSteps: 30, Sampler: DPM++ 2M, CFG scale: 7, Seed: 12, Size: 512x768, Model hash: abc, Model: \"my, model\", Lora hashes: \"x: 1, y: 2\"")
	if !ok || r.Prompt != "cat" || r.Negative != "" || r.Steps != 30 || r.Seed != 12 || r.Model != "my, model" || r.Ratio != "2:3" {
		t.Fatalf("%+v", r)
	}
	if _, ok := genParseA1111(""); ok {
		t.Fatal("пустая строка разобралась")
	}
}

func TestGenRestoreFrom(t *testing.T) {
	req := &genAddReq{Prompt: "лиса", Preset: "photo", Ratio: "16:9", Negative: "dog", Steps: 0, CFG: 0}
	m := GenMeta{Model: "sdxl", Request: req, Params: GenParams{Prompt: "photo of лиса, 35mm", Width: 1344, Height: 768, Steps: 20, CFG: 5, Seed: 77}}
	inner, _ := json.Marshal(m)
	b, _ := pngWithText(tinyPNG(t), [][2]string{{"parameters", genA1111(m)}, {"kombain", string(inner)}})

	r, ok := genRestoreFrom(b, nil) // .json потерялся — хватит куска в PNG
	if !ok || !r.Exact || r.Prompt != "лиса" || r.Preset != "photo" || r.Ratio != "16:9" || r.Negative != "dog" || r.Seed != 77 || r.Steps != 0 {
		t.Fatalf("%+v", r)
	}
	side, _ := json.Marshal(GenMeta{Model: "flux", Params: GenParams{Prompt: "other", Seed: 5}})
	if r, _ := genRestoreFrom(b, side); r.Prompt != "other" || r.Model != "flux" || r.Exact {
		t.Fatalf(".json рядом важнее: %+v", r)
	}
	plain, _ := pngWithText(tinyPNG(t), [][2]string{{"parameters", genA1111(m)}})
	if r, _ := genRestoreFrom(plain, nil); r.Prompt != "photo of лиса, 35mm" || r.Preset != "none" || r.Seed != 77 {
		t.Fatalf("чужая картинка: %+v", r)
	}
	if _, ok := genRestoreFrom(tinyPNG(t), nil); ok {
		t.Fatal("в пустой картинке нашлись настройки")
	}
}

func TestGallery(t *testing.T) {
	root := t.TempDir()
	put := func(month, name string, m GenMeta) string {
		dir := filepath.Join(root, month)
		os.MkdirAll(dir, 0o755)
		p := filepath.Join(dir, name+".png")
		os.WriteFile(p, tinyPNG(t), 0o644)
		b, _ := json.Marshal(m)
		os.WriteFile(filepath.Join(dir, name+".json"), b, 0o644)
		return p
	}
	t0 := time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC)
	a := put("2026-10", "a", GenMeta{Model: "sdxl", Created: t0.AddDate(0, -1, 0), Params: GenParams{Prompt: "photo of a red fox"}, Request: &genAddReq{Prompt: "лиса"}})
	b := put("2026-11", "b", GenMeta{Model: "flux", Created: t0, Params: GenParams{Prompt: "blue car"}})
	put("2026-11", "c", GenMeta{Model: "sdxl", Created: t0.Add(time.Hour), Params: GenParams{Prompt: "red car"}, Fav: true})
	os.WriteFile(filepath.Join(root, "2026-11", "lonely.png"), tinyPNG(t), 0o644) // без .json — не наша
	os.MkdirAll(filepath.Join(root, ".thumbs"), 0o755)

	all := genGalleryAll(root)
	if len(all) != 3 || filepath.Base(all[0].Path) != "c.png" || all[2].Path != a {
		t.Fatalf("порядок: %v", all)
	}
	if pg := genGalleryFind(all, galQuery{Q: "RED"}); pg.Total != 2 || pg.All != 3 || pg.Favs != 1 {
		t.Fatalf("%+v", pg)
	}
	if pg := genGalleryFind(all, galQuery{Q: "лиса fox"}); pg.Total != 1 || pg.Items[0].Path != a {
		t.Fatalf("поиск по запросу человека: %+v", pg)
	}
	if pg := genGalleryFind(all, galQuery{Fav: true}); pg.Total != 1 {
		t.Fatalf("избранное: %+v", pg)
	}
	if pg := genGalleryFind(all, galQuery{Model: "flux"}); pg.Total != 1 || pg.Items[0].Path != b || len(pg.Models) != 2 || pg.Models[0].ID != "sdxl" {
		t.Fatalf("модель: %+v", pg)
	}
	if pg := genGalleryFind(all, galQuery{Offset: 2, Limit: 5}); len(pg.Items) != 1 || pg.Total != 3 {
		t.Fatalf("страницы: %+v", pg)
	}

	if err := genSetFav(b, true); err != nil {
		t.Fatal(err)
	}
	future := time.Now().Add(time.Minute) // время .json могло не смениться за ту же миллисекунду
	os.Chtimes(genSidecar(b), future, future)
	if pg := genGalleryFind(genGalleryAll(root), galQuery{Fav: true}); pg.Total != 2 {
		t.Fatalf("избранное не записалось: %+v", pg)
	}
	raw, _ := os.ReadFile(genSidecar(b))
	if !bytes.Contains(raw, []byte(`"model": "flux"`)) {
		t.Fatalf("поля потерялись: %s", raw)
	}
	os.Remove(b)
	if len(genGalleryAll(root)) != 2 {
		t.Fatal("удалённая картинка осталась в списке")
	}
}
