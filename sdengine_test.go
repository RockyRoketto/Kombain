package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestSDServerArgs(t *testing.T) {
	a := sdServerArgs(ModelSet{Checkpoint: `C:\m\x.safetensors`, TAE: `C:\m\t.safetensors`}, 4321, `C:\m`)
	s := strings.Join(a, " ")
	for _, want := range []string{"--listen-ip 127.0.0.1", "--listen-port 4321", `-m C:\m\x.safetensors`, "--taesd-preview-only", "--lora-model-dir"} {
		if !strings.Contains(s, want) {
			t.Errorf("no %q in %s", want, s)
		}
	}
	if slices.Contains(a, "--diffusion-model") || slices.Contains(a, "--offload-to-cpu") {
		t.Error(s)
	}
	a = sdServerArgs(ModelSet{Diffusion: "d.gguf", VAE: "ae", LLM: "qwen3", LowVRAM: true}, 1, "m")
	s = strings.Join(a, " ")
	for _, want := range []string{"--diffusion-model d.gguf", "--vae ae", "--llm qwen3", "--offload-to-cpu", "--vae-tiling"} {
		if !strings.Contains(s, want) {
			t.Errorf("no %q in %s", want, s)
		}
	}
	if slices.Contains(a, "-m") || slices.Contains(a, "--tae") || slices.Contains(a, "--clip_l") {
		t.Error(s)
	}
}

func TestSDRequest(t *testing.T) {
	b, _ := json.Marshal(sdRequest(GenParams{Prompt: "fox", Width: 1024, Height: 768, Steps: 20, CFG: 7, Seed: 5, Preview: "bogus"}))
	var m map[string]any
	json.Unmarshal(b, &m)
	if _, ok := m["init_image"]; ok {
		t.Error("init_image sent without a picture")
	}
	if m["preview"] != "none" || m["batch_count"].(float64) != 1 || m["embed_image_metadata"] != true {
		t.Errorf("%s", b)
	}
	sp := m["sample_params"].(map[string]any)
	if _, ok := sp["sample_method"]; ok || sp["sample_steps"].(float64) != 20 {
		t.Errorf("sample params %v", sp)
	}

	r := sdRequest(GenParams{Init: []byte("img"), Mask: []byte("msk"), Strength: 0.6, Preview: "tae", PreviewEvery: 3,
		Loras: []LoraUse{{Path: "style/a.safetensors", Weight: 0.8}}})
	if r.Init == nil || *r.Init != base64.StdEncoding.EncodeToString([]byte("img")) || r.Mask == nil || r.Strength != 0.6 {
		t.Errorf("img2img %+v", r)
	}
	if r.Preview != "tae" || r.PreviewInt != 3 || len(r.Lora) != 1 || r.Lora[0].Multiplier != 0.8 {
		t.Errorf("%+v", r)
	}
	if r := sdRequest(GenParams{Mask: []byte("m")}); r.Mask != nil {
		t.Error("mask without init sent")
	}
}

func TestSDErrText(t *testing.T) {
	for in, want := range map[string]string{
		`{"error":"No model is loaded","code":"model_not_loaded"}`: "No model is loaded",
		`{"error":{"code":"x","message":"bad width"}}`:             "bad width",
		`plain text`: "plain text",
	} {
		if got := sdErrText([]byte(in)); got != want {
			t.Errorf("%s: %q", in, got)
		}
	}
}

// fakeSD — подставной sd-server: задача идёт steps опросов, потом готова (или падает)
type fakeSD struct {
	mu        sync.Mutex
	steps     int
	polls     int
	fail      bool
	cancelled bool
	lastReq   map[string]any
}

func (f *fakeSD) handler(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	switch {
	case r.Method == "POST" && r.URL.Path == "/sdcpp/v1/img_gen":
		json.NewDecoder(r.Body).Decode(&f.lastReq)
		w.WriteHeader(202)
		fmt.Fprint(w, `{"id":"job_1","kind":"img_gen","status":"queued"}`)
	case r.Method == "POST" && r.URL.Path == "/sdcpp/v1/jobs/job_1/cancel":
		f.cancelled = true
		fmt.Fprint(w, `{"cancel_requested":true}`)
	case r.URL.Path == "/sdcpp/v1/jobs/job_1":
		f.polls++
		step := min(f.polls, f.steps)
		pv := base64.StdEncoding.EncodeToString([]byte(fmt.Sprintf("frame%d", step/2*2))) // кадр раз в 2 шага
		status, result, errv := "generating", "null", "null"
		switch {
		case f.cancelled:
			status, errv = "cancelled", `{"code":"cancelled","message":"job cancelled by client"}`
		case f.polls > f.steps && f.fail:
			status, errv = "failed", `{"code":"generation_failed","message":"out of memory"}`
		case f.polls > f.steps:
			status, result = "completed", `{"output_format":"png","images":[{"index":0,"b64_json":"`+base64.StdEncoding.EncodeToString([]byte("PNGDATA"))+`"}]}`
		}
		fmt.Fprintf(w, `{"id":"job_1","status":%q,"progress":{"stage":"sampling","completed":%d,"total":%d,"elapsed_ms":%d},
			"preview":{"pass":1,"step":%d,"total_steps":%d,"b64_json":%q},"result":%s,"error":%s}`,
			status, step, f.steps, step*100, step/2*2, f.steps, pv, result, errv)
	case r.URL.Path == "/sdcpp/v1/upscale":
		json.NewDecoder(r.Body).Decode(&f.lastReq)
		fmt.Fprint(w, `{"images":[{"index":0,"b64_json":"`+base64.StdEncoding.EncodeToString([]byte("BIG"))+`"}],"scale":4}`)
	default:
		http.NotFound(w, r)
	}
}

func fakeServer(t *testing.T, f *fakeSD) *sdServer {
	ts := httptest.NewServer(http.HandlerFunc(f.handler))
	t.Cleanup(ts.Close)
	return &sdServer{base: ts.URL, client: ts.Client(), poll: 5 * time.Millisecond}
}

func TestSDGenerate(t *testing.T) {
	f := &fakeSD{steps: 6}
	s := fakeServer(t, f)
	var frames []string
	var last GenProgress
	png, err := s.Generate(context.Background(), GenParams{Prompt: "fox", Preview: "tae"}, func(g GenProgress) {
		if g.Preview != nil {
			frames = append(frames, string(g.Preview))
		}
		last = g
	})
	if err != nil || string(png) != "PNGDATA" {
		t.Fatalf("%q %v", png, err)
	}
	if !slices.Equal(frames, []string{"frame0", "frame2", "frame4", "frame6"}) {
		t.Errorf("frames %v: each must come once", frames)
	}
	if last.Step != 6 || last.Total != 6 || last.Stage != "sampling" {
		t.Errorf("progress %+v", last)
	}
	if f.lastReq["prompt"] != "fox" || f.lastReq["preview"] != "tae" {
		t.Errorf("request %v", f.lastReq)
	}
}

func TestSDGenerateFail(t *testing.T) {
	s := fakeServer(t, &fakeSD{steps: 1, fail: true})
	if _, err := s.Generate(context.Background(), GenParams{}, nil); err == nil || !strings.Contains(err.Error(), "out of memory") {
		t.Fatalf("err %v", err)
	}
}

func TestSDGenerateCancel(t *testing.T) {
	f := &fakeSD{steps: 1000}
	s := fakeServer(t, f)
	ctx, cancel := context.WithCancel(context.Background())
	_, err := s.Generate(ctx, GenParams{}, func(g GenProgress) {
		if g.Step >= 3 {
			cancel()
		}
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err %v", err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.cancelled {
		t.Error("cancel not sent to the engine")
	}
}

func TestSDUpscale(t *testing.T) {
	f := &fakeSD{}
	s := fakeServer(t, f)
	out, err := s.Upscale(context.Background(), []byte("small"), "RealESRGAN_x4plus", 9)
	if err != nil || string(out) != "BIG" {
		t.Fatalf("%q %v", out, err)
	}
	if f.lastReq["repeats"].(float64) != 4 || f.lastReq["upscaler"] != "RealESRGAN_x4plus" {
		t.Errorf("request %v", f.lastReq)
	}
}

func TestSDNotLoaded(t *testing.T) {
	s := &sdServer{client: http.DefaultClient}
	if _, err := s.Generate(context.Background(), GenParams{}, nil); err == nil {
		t.Error("generate without a server")
	}
	if _, ok := s.Loaded(); ok {
		t.Error("loaded without a server")
	}
	if err := s.Load(context.Background(), ModelSet{}); err == nil {
		t.Error("empty model set accepted")
	}
}
