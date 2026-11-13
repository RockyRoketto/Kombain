package main

import "testing"

func TestHWJudge(t *testing.T) {
	const gb = 1 << 30
	cases := []struct {
		name       string
		gpu        string
		vram, ram  float64
		free, need int64
		vl, rl, dl string
		ok         bool
		flavor     string
	}{
		{"мощная NVIDIA", "NVIDIA GeForce RTX 4080 SUPER", 16376, 65000, 500 * gb, 10 * gb, "ok", "ok", "ok", true, "cuda"},
		{"8 ГБ видеопамяти — хватает", "NVIDIA GeForce RTX 3060 Ti", 8192, 16384, 30 * gb, 10 * gb, "ok", "ok", "ok", true, "cuda"},
		{"6 ГБ и 8 ГБ памяти — на пределе", "NVIDIA GeForce GTX 1660", 6144, 8192, 12 * gb, 10 * gb, "edge", "edge", "edge", true, "cuda"},
		{"AMD — Vulkan, на пределе", "AMD Radeon RX 7800 XT", 16368, 32768, 100 * gb, 10 * gb, "edge", "ok", "ok", true, "vulkan"},
		{"встроенная 2 ГБ", "Intel(R) UHD Graphics 630", 2048, 16384, 100 * gb, 10 * gb, "no", "ok", "ok", false, "vulkan"},
		{"нет видеокарты", "Microsoft Basic Display Adapter", -1, 16384, 100 * gb, 10 * gb, "no", "ok", "ok", false, ""},
		{"мало места", "NVIDIA GeForce RTX 4070", 12282, 32768, 3 * gb, 10 * gb, "ok", "ok", "no", false, "cuda"},
		{"мало памяти", "NVIDIA GeForce RTX 4070", 12282, 4096, 100 * gb, 10 * gb, "ok", "no", "ok", false, "cuda"},
	}
	for _, c := range cases {
		r := hwJudge(c.gpu, c.vram, c.ram, c.free, c.need)
		if r.VRAM.Level != c.vl || r.RAM.Level != c.rl || r.Disk.Level != c.dl || r.OK != c.ok || r.Flavor != c.flavor {
			t.Errorf("%s: vram %s ram %s disk %s ok %v flavor %q", c.name, r.VRAM.Level, r.RAM.Level, r.Disk.Level, r.OK, r.Flavor)
		}
		for _, v := range []HWVerdict{r.VRAM, r.RAM, r.Disk} {
			if v.Note == "" {
				t.Errorf("%s: нет объяснения", c.name)
			}
		}
	}
}

func TestLLMClean(t *testing.T) {
	for in, want := range map[string]string{
		`"A red fox in snow, golden light"`:      "A red fox in snow, golden light",
		"Prompt: a cat on a sofa,\n soft light ": "a cat on a sofa, soft light",
		"«a lighthouse at dusk»":                 "a lighthouse at dusk",
	} {
		if got := llmClean(in); got != want {
			t.Errorf("llmClean(%q) = %q, want %q", in, got, want)
		}
	}
}

// каталог: первый запуск ставит движок, SDXL с TAE и помощника; служебный TAE в списке моделей не виден
func TestAISteps(t *testing.T) {
	c, err := aiCatalog()
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{aiFirstImage, aiFirstLLM} {
		if _, ok := c.model(id); !ok {
			t.Fatalf("в каталоге нет %s", id)
		}
	}
	for _, k := range []string{"sd", "llm"} {
		for _, f := range []string{"cuda", "vulkan"} {
			if !slicesHas(c.Engines, func(e CatEngine) bool { return e.Kind == k && e.Flavor == f }) {
				t.Errorf("нет сборки %s %s", k, f)
			}
		}
	}
	plan, err := aiPlan(c, Installed{Version: 1}, aiFirstImage)
	if err != nil || len(plan) != 2 || plan[0].ID != "taesdxl" {
		t.Fatalf("план SDXL: %v %v", plan, err)
	}
	for _, r := range aiModelRows(c, Installed{Version: 1}) {
		if r.Kind == "tae" {
			t.Error("TAE не должен быть в списке моделей")
		}
		if r.Installed || r.Size <= 0 {
			t.Errorf("%s: installed %v size %d", r.ID, r.Installed, r.Size)
		}
	}
}

func slicesHas[T any](s []T, f func(T) bool) bool {
	for _, x := range s {
		if f(x) {
			return true
		}
	}
	return false
}
