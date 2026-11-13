package main

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func aiTestEnv(t *testing.T) {
	t.Helper()
	t.Setenv("LOCALAPPDATA", t.TempDir()) // настоящие настройки не трогаем
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
}

func TestAIRoot(t *testing.T) {
	aiTestEnv(t)
	if aiRootChosen() || aiRoot() != aiDefaultRoot() {
		t.Fatalf("default root: %q", aiRoot())
	}
	if aiSetRoot("relative/dir") == nil {
		t.Error("relative path accepted")
	}
	dir := filepath.Join(t.TempDir(), "ai data")
	if err := aiSetRoot(dir); err != nil {
		t.Fatal(err)
	}
	if !aiRootChosen() || aiRoot() != dir {
		t.Fatalf("root %q, want %q", aiRoot(), dir)
	}
	if err := aiEnsure(); err != nil {
		t.Fatal(err)
	}
	for _, c := range aiModelCats {
		if !dirExists(aiModelDir(c)) {
			t.Errorf("no folder %s", c)
		}
	}
	if aiModelDir("nonsense") != "" {
		t.Error("unknown category got a folder")
	}
	if !strings.HasSuffix(aiEngineDir("sd"), filepath.Join("engines", "sd")) {
		t.Error(aiEngineDir("sd"))
	}
}

func TestEmbeddedCatalog(t *testing.T) {
	if _, err := aiCatalog(); err != nil {
		t.Fatal("ai_catalog.json:", err)
	}
}

func testSum(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func goodCatalog() Catalog {
	f := CatFile{Name: "m.safetensors", Cat: "checkpoints", Role: "checkpoint", URL: "https://example.com/m", Size: 10, SHA256: strings.Repeat("a", 64)}
	tae := CatFile{Name: "tae.safetensors", Cat: "tae", Role: "tae", URL: "https://example.com/t", Size: 5, SHA256: strings.Repeat("b", 64)}
	lic := CatText{RU: "можно", EN: "ok"}
	return Catalog{Version: 1, Models: []CatModel{
		{ID: "sdxl-a", Kind: "image", Arch: "sdxl", Name: lic, License: lic, Files: []CatFile{f}, Needs: []string{"taesdxl"}},
		{ID: "taesdxl", Kind: "tae", Arch: "sdxl", Name: lic, License: lic, Files: []CatFile{tae}},
	}}
}

func TestCatalogValidate(t *testing.T) {
	if err := goodCatalog().validate(); err != nil {
		t.Fatal(err)
	}
	bad := map[string]func(c *Catalog){
		"duplicate id":  func(c *Catalog) { c.Models[1].ID = "sdxl-a" },
		"http url":      func(c *Catalog) { c.Models[0].Files[0].URL = "http://example.com/m" },
		"path in name":  func(c *Catalog) { c.Models[0].Files[0].Name = "../m.safetensors" },
		"short sha":     func(c *Catalog) { c.Models[0].Files[0].SHA256 = "abc" },
		"unknown cat":   func(c *Catalog) { c.Models[0].Files[0].Cat = "stuff" },
		"unknown needs": func(c *Catalog) { c.Models[0].Needs = []string{"nope"} },
		"no checkpoint": func(c *Catalog) { c.Models[0].Files[0].Role = "vae" },
		"no license":    func(c *Catalog) { c.Models[0].License = CatText{} },
		"bad version":   func(c *Catalog) { c.Version = 2 },
	}
	for name, spoil := range bad {
		c := goodCatalog()
		c.Models[0].Files = append([]CatFile(nil), c.Models[0].Files...)
		spoil(&c)
		if c.validate() == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

// catServer раздаёт файлы и считает запросы
func catServer(t *testing.T, files map[string][]byte) (*httptest.Server, *atomic.Int32) {
	var hits atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, ok := files[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		hits.Add(1)
		w.Write(b)
	}))
	t.Cleanup(ts.Close)
	return ts, &hits
}

func TestInstallModelShared(t *testing.T) {
	aiTestEnv(t)
	model, vae, other := []byte("model-bytes"), []byte("shared-vae"), []byte("other-model")
	ts, hits := catServer(t, map[string][]byte{"/m": model, "/v": vae, "/o": other})
	lic := CatText{RU: "да", EN: "yes"}
	vf := CatFile{Name: "vae.safetensors", Cat: "vae", Role: "vae", URL: ts.URL + "/v", Size: int64(len(vae)), SHA256: testSum(vae)}
	c := Catalog{Version: 1, Models: []CatModel{
		{ID: "a", Kind: "image", Arch: "flux", Name: lic, License: lic, Files: []CatFile{
			{Name: "a.gguf", Cat: "diffusion_models", Role: "diffusion", URL: ts.URL + "/m", Size: int64(len(model)), SHA256: testSum(model)}, vf}},
		{ID: "b", Kind: "image", Arch: "flux", Name: lic, License: lic, Files: []CatFile{
			{Name: "b.gguf", Cat: "diffusion_models", Role: "diffusion", URL: ts.URL + "/o", Size: int64(len(other)), SHA256: testSum(other)}, vf}},
	}}
	var last, total int64
	if err := aiInstallModel(context.Background(), c, "a", func(d, tot int64) { last, total = d, tot }); err != nil {
		t.Fatal(err)
	}
	if last != total || total != int64(len(model)+len(vae)) {
		t.Errorf("progress %d of %d", last, total)
	}
	in := aiLoadInstalled()
	plan, _ := aiPlan(c, in, "b")
	if got := aiPlanSize(plan, in); got != int64(len(other)) {
		t.Errorf("b would download %d bytes, the vae is already there", got)
	}
	if err := aiInstallModel(context.Background(), c, "b", func(int64, int64) {}); err != nil {
		t.Fatal(err)
	}
	if hits.Load() != 3 {
		t.Errorf("%d downloads, want 3 (shared vae once)", hits.Load())
	}
	set, err := aiModelSet(aiLoadInstalled(), "b", false)
	if err != nil || filepath.Base(set.Diffusion) != "b.gguf" || filepath.Base(set.VAE) != "vae.safetensors" || set.Checkpoint != "" {
		t.Fatalf("model set %+v, %v", set, err)
	}

	vaePath := filepath.Join(aiModelsDir(), "vae", "vae.safetensors")
	if err := aiRemoveModel("a"); err != nil {
		t.Fatal(err)
	}
	if !fileExists(vaePath) || fileExists(filepath.Join(aiModelsDir(), "diffusion_models", "a.gguf")) {
		t.Error("remove a: shared vae must stay, a.gguf must go")
	}
	if err := aiRemoveModel("b"); err != nil {
		t.Fatal(err)
	}
	if fileExists(vaePath) {
		t.Error("vae left after the last model")
	}
	if len(aiLoadInstalled().Models) != 0 {
		t.Error("catalog.json still lists models")
	}
}

func TestInstallModelBadSum(t *testing.T) {
	aiTestEnv(t)
	ts, _ := catServer(t, map[string][]byte{"/m": []byte("tampered!!")})
	lic := CatText{RU: "да", EN: "yes"}
	c := Catalog{Version: 1, Models: []CatModel{{ID: "a", Kind: "image", Arch: "sdxl", Name: lic, License: lic, Files: []CatFile{
		{Name: "a.safetensors", Cat: "checkpoints", Role: "checkpoint", URL: ts.URL + "/m", Size: 10, SHA256: strings.Repeat("0", 64)}}}}}
	if aiInstallModel(context.Background(), c, "a", func(int64, int64) {}) == nil {
		t.Fatal("tampered file accepted")
	}
	dir := filepath.Join(aiModelsDir(), "checkpoints")
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Errorf("left files: %v", entries)
	}
	if _, ok := aiLoadInstalled().model("a"); ok {
		t.Error("broken model recorded as installed")
	}
}

func TestModelSetTAE(t *testing.T) {
	aiTestEnv(t)
	mk := func(rel string) {
		p := filepath.Join(aiModelsDir(), filepath.FromSlash(rel))
		os.MkdirAll(filepath.Dir(p), 0o755)
		os.WriteFile(p, []byte("x"), 0o644)
	}
	mk("checkpoints/x.safetensors")
	mk("tae/taesdxl.safetensors")
	mk("tae/taesd.safetensors")
	in := Installed{Models: []InstModel{
		{ID: "x", Kind: "image", Arch: "sdxl", Files: []InstFile{{Path: "checkpoints/x.safetensors", Role: "checkpoint"}}},
		{ID: "t15", Kind: "tae", Arch: "sd15", Files: []InstFile{{Path: "tae/taesd.safetensors", Role: "tae"}}},
		{ID: "txl", Kind: "tae", Arch: "sdxl", Files: []InstFile{{Path: "tae/taesdxl.safetensors", Role: "tae"}}},
	}}
	set, err := aiModelSet(in, "x", true)
	if err != nil || filepath.Base(set.TAE) != "taesdxl.safetensors" || !set.LowVRAM {
		t.Fatalf("%+v %v", set, err)
	}
	os.Remove(filepath.Join(aiModelsDir(), "checkpoints", "x.safetensors"))
	if _, err := aiModelSet(in, "x", false); err == nil {
		t.Error("missing file not noticed")
	}
	if _, err := aiModelSet(in, "t15", false); err == nil {
		t.Error("tae accepted as an image model")
	}
}

func testZip(t *testing.T, files map[string]string) []byte {
	p := filepath.Join(t.TempDir(), "a.zip")
	f, _ := os.Create(p)
	zw := zip.NewWriter(f)
	for name, body := range files {
		w, _ := zw.Create(name)
		w.Write([]byte(body))
	}
	zw.Close()
	f.Close()
	b, _ := os.ReadFile(p)
	return b
}

func TestInstallEngine(t *testing.T) {
	aiTestEnv(t)
	z1 := testZip(t, map[string]string{"bin/sd-server.exe": "v1", "bin/ggml.dll": "dll", "README.md": "skip", "../evil.dll": "evil"})
	z2 := testZip(t, map[string]string{"sd-server.exe": "v2"})
	ts, _ := catServer(t, map[string][]byte{"/1": z1, "/2": z2})
	e := CatEngine{ID: "sd-cuda", Kind: "sd", Flavor: "cuda", Tag: "t1", Exe: "sd-server.exe",
		Files: []CatFile{{Name: "sd.zip", URL: ts.URL + "/1", Size: int64(len(z1)), SHA256: testSum(z1)}}}
	if aiEngineReady(e) {
		t.Fatal("ready before install")
	}
	if err := aiInstallEngine(context.Background(), e, func(int64, int64) {}); err != nil {
		t.Fatal(err)
	}
	dir := aiEngineDir("sd")
	if !aiEngineReady(e) || !fileExists(filepath.Join(dir, "ggml.dll")) || fileExists(filepath.Join(dir, "README.md")) {
		t.Fatal("engine files")
	}
	if fileExists(filepath.Join(filepath.Dir(dir), "evil.dll")) {
		t.Fatal("zip slip")
	}
	e2 := e
	e2.Tag = "t2"
	e2.Files = []CatFile{{Name: "sd.zip", URL: ts.URL + "/2", Size: int64(len(z2)), SHA256: testSum(z2)}}
	if aiEngineReady(e2) {
		t.Fatal("new tag counted as ready")
	}
	if err := aiInstallEngine(context.Background(), e2, func(int64, int64) {}); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(filepath.Join(dir, "sd-server.exe"))
	if string(b) != "v2" || fileExists(filepath.Join(dir, "ggml.dll")) || fileExists(dir+".old") {
		t.Error("engine folder not replaced whole")
	}
	if in := aiLoadInstalled(); len(in.Engines) != 1 || in.Engines[0].Tag != "t2" {
		t.Errorf("engines in catalog.json: %+v", in.Engines)
	}
}

func writeSafetensors(t *testing.T, keys ...string) string {
	h := map[string]any{"__metadata__": map[string]string{"format": "pt"}}
	for _, k := range keys {
		h[k] = map[string]any{"dtype": "F16", "shape": []int{1}, "data_offsets": []int{0, 2}}
	}
	b, _ := json.Marshal(h)
	p := filepath.Join(t.TempDir(), "m.safetensors")
	f, _ := os.Create(p)
	binary.Write(f, binary.LittleEndian, uint64(len(b)))
	f.Write(b)
	f.Write([]byte{0, 0})
	f.Close()
	return p
}

func TestSafetensorsGuess(t *testing.T) {
	cases := []struct {
		keys       []string
		kind, arch string
	}{
		{[]string{"conditioner.embedders.1.model.ln_final.weight", "model.diffusion_model.input_blocks.0.0.weight"}, "image", "sdxl"},
		{[]string{"cond_stage_model.transformer.text_model.embeddings.position_ids", "model.diffusion_model.out.2.weight"}, "image", "sd15"},
		{[]string{"double_blocks.0.img_attn.proj.weight", "single_blocks.0.linear1.weight"}, "image", "flux"},
		{[]string{"lora_te1_text_model_encoder_layers_0_mlp_fc1.lora_down.weight", "lora_te2_text_model_encoder_layers_0_mlp_fc1.lora_up.weight"}, "lora", "sdxl"},
		{[]string{"lora_unet_down_blocks_0_attentions_0_proj_in.lora_down.weight"}, "lora", "sd15"},
		{[]string{"transformer.single_transformer_blocks.0.attn.to_k.lora_A.weight"}, "lora", "flux"},
		{[]string{"decoder.layers.0.weight", "encoder.layers.0.weight"}, "tae", ""},
		{[]string{"decoder.conv_in.weight", "encoder.conv_in.weight", "decoder.up.0.block.0.conv1.weight"}, "vae", ""},
		{[]string{"something.else"}, "", ""},
	}
	for _, c := range cases {
		h, err := safetensorsHeader(writeSafetensors(t, c.keys...))
		if err != nil {
			t.Fatal(err)
		}
		if k, a := safetensorsGuess(h); k != c.kind || a != c.arch {
			t.Errorf("%v: got %s/%s, want %s/%s", c.keys, k, a, c.kind, c.arch)
		}
	}
	junk := filepath.Join(t.TempDir(), "junk.bin")
	os.WriteFile(junk, []byte("\xff\xff\xff\xff\xff\xff\xff\x7fjunk"), 0o644)
	if _, err := safetensorsHeader(junk); err == nil {
		t.Error("junk accepted")
	}
}
