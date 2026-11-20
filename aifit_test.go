package main

import "testing"

func TestAiFit(t *testing.T) {
	gb := func(n float64) []CatFile { return []CatFile{{Size: int64(n * (1 << 30))}} }
	qwen := CatModel{VRAM: 20, Good: 24, Files: gb(18)} // ram для «медленно» — 22 ГБ
	flux := CatModel{VRAM: 6, Good: 8, Files: gb(7)}    // 11 ГБ
	plain := CatModel{VRAM: 3}                          // good = 5, вес неизвестен
	cases := []struct {
		name      string
		vram, ram float64
		m         CatModel
		fit, why  string
	}{
		{"qwen на 16 ГБ", 16 * 1024, 64 * 1024, qwen, "bad", "vram"},
		{"qwen на 24 ГБ (карта отдаёт чуть меньше)", 24*1024 - 300, 16 * 1024, qwen, "good", ""},
		{"qwen на 20 ГБ", 20 * 1024, 32 * 1024, qwen, "mid", "vram"},
		{"qwen на 20 ГБ, памяти 16", 20 * 1024, 16 * 1024, qwen, "bad", "ram"},
		{"flux на 16 ГБ", 16 * 1024, 8 * 1024, flux, "good", ""},
		{"flux на 6 ГБ", 6 * 1024, 16 * 1024, flux, "mid", "vram"},
		{"flux на 6 ГБ, памяти 8", 6 * 1024, 8 * 1024, flux, "bad", "ram"},
		{"flux на 6 ГБ, память неизвестна", 6 * 1024, -1, flux, "mid", "vram"},
		{"flux на 4 ГБ", 4 * 1024, 32 * 1024, flux, "bad", "vram"},
		{"без good", 5 * 1024, 16 * 1024, plain, "good", ""},
		{"без веса, медленно", 4 * 1024, 2 * 1024, plain, "mid", "vram"},
		{"видеопамять неизвестна", -1, 32 * 1024, qwen, "unknown", ""},
		{"нет требований", 4 * 1024, 8 * 1024, CatModel{}, "", ""},
	}
	for _, c := range cases {
		if fit, why := aiFit(c.vram, c.ram, c.m); fit != c.fit || why != c.why {
			t.Errorf("%s: %q %q, ждали %q %q", c.name, fit, why, c.fit, c.why)
		}
	}
}

// у модели в каталоге требования к видеопамяти не больше, чем нужно для комфортной работы
func TestAiCatalogVRAM(t *testing.T) {
	c, err := parseCatalog(aiCatalogJSON)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range c.Models {
		if m.Good > 0 && m.Good < m.VRAM {
			t.Errorf("%s: good %v меньше vram %v", m.ID, m.Good, m.VRAM)
		}
	}
}
