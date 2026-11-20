package main

import "testing"

func TestAiFit(t *testing.T) {
	qwen := CatModel{VRAM: 20, Good: 24}
	flux := CatModel{VRAM: 6, Good: 8}
	plain := CatModel{VRAM: 3} // good = 5
	cases := []struct {
		name string
		vram float64
		m    CatModel
		want string
	}{
		{"qwen на 16 ГБ", 16 * 1024, qwen, "bad"},
		{"qwen на 24 ГБ (карта отдаёт чуть меньше)", 24*1024 - 300, qwen, "good"},
		{"qwen на 20 ГБ", 20 * 1024, qwen, "mid"},
		{"flux на 16 ГБ", 16 * 1024, flux, "good"},
		{"flux на 6 ГБ", 6 * 1024, flux, "mid"},
		{"flux на 4 ГБ", 4 * 1024, flux, "bad"},
		{"без good", 5 * 1024, plain, "good"},
		{"видеопамять неизвестна", -1, qwen, ""},
		{"нет требований", 4 * 1024, CatModel{}, ""},
	}
	for _, c := range cases {
		if got := aiFit(c.vram, c.m); got != c.want {
			t.Errorf("%s: %q, ждали %q", c.name, got, c.want)
		}
	}
}
