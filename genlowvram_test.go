package main

import "testing"

func TestGenLowVRAMFor(t *testing.T) {
	gb := int64(1 << 30)
	model := func(sizes ...int64) InstModel {
		m := InstModel{}
		for _, s := range sizes {
			m.Files = append(m.Files, InstFile{Size: s})
		}
		return m
	}
	sdxl := model(7 * gb)
	qwen := model(13*gb, 4*gb+gb/2, gb/4)
	for _, c := range []struct {
		name string
		vram float64
		m    InstModel
		want bool
	}{
		{"неизвестная карта", -1, qwen, false},
		{"8 ГБ, лёгкая", 8 * 1024, sdxl, true},
		{"16 ГБ, лёгкая", 16 * 1024, sdxl, false},
		{"16 ГБ, Qwen", 16 * 1024, qwen, true},
		{"24 ГБ, Qwen", 24 * 1024, qwen, false},
	} {
		if got := genLowVRAMFor(c.vram, c.m); got != c.want {
			t.Errorf("%s: %v, нужно %v", c.name, got, c.want)
		}
	}
}
