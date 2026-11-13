package main

import (
	"strings"
	"testing"
)

func TestGenSize(t *testing.T) {
	for _, c := range []struct {
		nw, nh int
		ratio  string
		w, h   int
	}{
		{1024, 1024, "1:1", 1024, 1024},
		{1024, 1024, "16:9", 1344, 768},
		{1024, 1024, "9:16", 768, 1344},
		{1024, 1024, "4:5", 896, 1152},
		{1024, 1024, "3:2", 1280, 832},
		{512, 512, "1:1", 512, 512},
		{1024, 1024, "мусор", 1024, 1024},
		{0, 0, "1:1", 1024, 1024},
	} {
		w, h := genSize(c.nw, c.nh, c.ratio)
		if w != c.w || h != c.h {
			t.Errorf("%d×%d %s: %d×%d, want %d×%d", c.nw, c.nh, c.ratio, w, h, c.w, c.h)
		}
		if w%64 != 0 || h%64 != 0 {
			t.Errorf("%s: not multiple of 64", c.ratio)
		}
	}
	for _, r := range genRatios {
		w, h := genSize(1024, 1024, r)
		if a := float64(w * h); a < 0.9*1024*1024 || a > 1.1*1024*1024 {
			t.Errorf("%s: area %v", r, a)
		}
	}
}

func TestGenPresets(t *testing.T) {
	seen := map[string]bool{}
	for _, p := range genPresets {
		for _, l := range []string{langRU, langEN} {
			if pageDict()[l]["gn.pre."+p.ID] == "" || pageDict()[l]["gn.preHint."+p.ID] == "" {
				t.Errorf("%s: no name in web/i18n.json (%s)", p.ID, l)
			}
		}
		if seen[p.ID] || p.ID == "" {
			t.Errorf("bad preset %+v", p)
		}
		seen[p.ID] = true
		if !strings.Contains(p.Template, "{p}") {
			t.Errorf("%s: template without {p}", p.ID)
		}
	}
	pr, neg := genPreset("photo").apply("  кот на окне ", "собака")
	if !strings.HasPrefix(pr, "кот на окне, professional photograph") || !strings.HasPrefix(neg, "собака, illustration") || !strings.Contains(neg, "watermark") {
		t.Fatalf("%q / %q", pr, neg)
	}
	if pr, _ := genPreset("нет такого").apply("кот", ""); pr != "кот" {
		t.Fatalf("unknown preset → none, got %q", pr)
	}
}

func TestGenBuild(t *testing.T) {
	m := genModelInfo{ID: "x", Arch: "sdxl", Def: GenDefaults{Steps: 20, CFG: 7, Width: 1024, Height: 1024, Negative: "ugly"}, Native: true}
	p := genBuild(genAddReq{Prompt: "кот", Preset: "none", Ratio: "16:9", Seed: 5, Preview: true}, m)
	if p.Width != 1344 || p.Height != 768 || p.Steps != 20 || p.CFG != 7 || p.Seed != 5 || p.Preview != "tae" || p.PreviewEvery != 4 {
		t.Fatalf("%+v", p)
	}
	if !strings.HasSuffix(p.Negative, ", ugly") {
		t.Fatalf("negative %q", p.Negative)
	}
	m.Native = false
	p = genBuild(genAddReq{Prompt: "кот", Steps: 500, CFG: 99, Preview: true}, m)
	if p.Steps != 150 || p.CFG != 30 || p.Preview != "proj" {
		t.Fatalf("%+v", p)
	}
	if p = genBuild(genAddReq{Prompt: "кот"}, m); p.Preview != "none" {
		t.Fatalf("preview off: %+v", p)
	}
}

func TestParseSMI(t *testing.T) {
	g, ok := parseSMI("0, NVIDIA GeForce RTX 4080 SUPER, 97, 10240, 16376, 61, 298.51")
	if !ok || g.Name != "NVIDIA GeForce RTX 4080 SUPER" || g.Util != 97 || g.Used != 10240 || g.Total != 16376 || g.Temp != 61 || g.Power != 298.51 {
		t.Fatalf("%+v %v", g, ok)
	}
	g, ok = parseSMI("1, Tesla, 5, 100, 8000, 40, [N/A]")
	if !ok || g.Power != -1 || g.Index != 1 {
		t.Fatalf("%+v", g)
	}
	for _, bad := range []string{"", "x, y", "a, b, 1, 2, 3, 4, 5", "0, X, 1, 2, 0, 4, 5"} {
		if _, ok := parseSMI(bad); ok {
			t.Errorf("%q parsed", bad)
		}
	}
}
