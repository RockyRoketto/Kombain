package main

// Прослойка «движок» генератора картинок. Очередь (imagegen.go) знает только ImageEngine: создать картинку
// (с нуля, по картинке, по маске) и увеличить. Сейчас движок один — stable-diffusion.cpp в режиме сервера:
// постоянный sd-server.exe на локальном порту держит модель в видеопамяти, Go ходит в его родной асинхронный API /sdcpp/v1/…
// (прогресс, кадры предпросмотра и отмена приходят JSON). Потом сюда же можно подключить ComfyUI, не трогая очередь и страницу.

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type ImageEngine interface {
	// Load готовит движок к работе с набором моделей; тот же набор — ничего не делает
	Load(ctx context.Context, m ModelSet) error
	// Generate рисует одну картинку и отдаёт PNG. progress зовётся на каждом опросе, кадр предпросмотра — только новый
	Generate(ctx context.Context, p GenParams, progress func(GenProgress)) ([]byte, error)
	// Upscale увеличивает картинку моделью ESRGAN из models\upscale (имя без расширения)
	Upscale(ctx context.Context, png []byte, upscaler string, repeats int) ([]byte, error)
	// Loaded: какой набор сейчас в видеопамяти
	Loaded() (ModelSet, bool)
	// Stop выгружает всё и освобождает видеопамять
	Stop()
}

// ModelSet: полные пути к файлам. Модель одним файлом (SD 1.5, SDXL) — Checkpoint; по частям (FLUX, Z-Image) — Diffusion и остальные.
type ModelSet struct {
	Checkpoint string `json:"checkpoint,omitempty"`
	Diffusion  string `json:"diffusion,omitempty"`
	VAE        string `json:"vae,omitempty"`
	ClipL      string `json:"clipL,omitempty"`
	ClipG      string `json:"clipG,omitempty"`
	T5XXL      string `json:"t5xxl,omitempty"`
	LLM        string `json:"llm,omitempty"` // текстовый энкодер-LLM (Qwen3 у Z-Image), не путать с моделью промтов
	TAE        string `json:"tae,omitempty"` // маленький декодер для кадров предпросмотра
	LowVRAM    bool   `json:"lowVram,omitempty"`
}

func (m ModelSet) empty() bool { return m.Checkpoint == "" && m.Diffusion == "" }

// GenParams: всё, что нужно для одной картинки. Это же пишется в .json рядом с картинкой (кроме самих входных картинок).
type GenParams struct {
	Prompt    string  `json:"prompt"`
	Negative  string  `json:"negative,omitempty"`
	Width     int     `json:"width"`
	Height    int     `json:"height"`
	Steps     int     `json:"steps"`
	CFG       float64 `json:"cfg"`
	Sampler   string  `json:"sampler,omitempty"`   // пусто — как задумано моделью
	Scheduler string  `json:"scheduler,omitempty"` // то же
	Seed      int64   `json:"seed"`

	Init     []byte  `json:"-"` // PNG: рисовать по картинке
	Mask     []byte  `json:"-"` // PNG: белое перерисовать (только вместе с Init)
	Strength float64 `json:"strength,omitempty"`

	Loras []LoraUse `json:"loras,omitempty"`

	Preview      string `json:"-"` // none, proj, tae, vae
	PreviewEvery int    `json:"-"` // через сколько шагов кадр
	VAETiling    bool   `json:"-"` // для слабых карт: VAE по кусочкам
}

type LoraUse struct {
	Path   string  `json:"path"` // путь внутри models\loras, через /
	Weight float64 `json:"weight"`
}

// GenProgress: шаг Step из Total текущего прохода. Preview — PNG, только когда кадр сменился.
type GenProgress struct {
	Stage       string `json:"stage"`
	Step        int    `json:"step"`
	Total       int    `json:"total"`
	ElapsedMs   int64  `json:"elapsedMs"`
	Preview     []byte `json:"-"`
	PreviewStep int    `json:"previewStep"`
}

// sdServer: движок stable-diffusion.cpp. Модель меняется перезапуском процесса: старт сервера 0,8 с, это меньше загрузки модели,
// зато не нужны рецепты его API смены модели.
type sdServer struct {
	exe     string // sd-server.exe
	models  string // models\ (там loras и upscale)
	logPath string
	poll    time.Duration
	client  *http.Client

	mu   sync.Mutex
	cmd  *exec.Cmd
	done chan struct{} // закрыт — процесс завершился
	base string        // http://127.0.0.1:порт
	set  ModelSet
}

func newSDServer() *sdServer {
	return &sdServer{
		exe:     filepath.Join(aiEngineDir("sd"), "sd-server.exe"),
		models:  aiModelsDir(),
		logPath: filepath.Join(aiLogDir(), "sd-server.log"),
		poll:    700 * time.Millisecond,
		client:  &http.Client{Timeout: 5 * time.Minute}, // увеличение 4× большой картинки синхронное и может идти долго
	}
}

// sdLoadLimit: дольше модель с диска не грузится даже на медленном диске; дальше считаем, что движок завис
var sdLoadLimit = 10 * time.Minute

// sdServerArgs: аргументы запуска. Проверено на sd.cpp master-1086 (сессия 1 прототипа).
func sdServerArgs(m ModelSet, port int, models string) []string {
	a := []string{"--listen-ip", "127.0.0.1", "--listen-port", strconv.Itoa(port)}
	if m.Checkpoint != "" {
		a = append(a, "-m", m.Checkpoint)
	} else {
		a = append(a, "--diffusion-model", m.Diffusion)
	}
	for _, f := range []struct{ flag, path string }{
		{"--vae", m.VAE}, {"--clip_l", m.ClipL}, {"--clip_g", m.ClipG}, {"--t5xxl", m.T5XXL}, {"--llm", m.LLM},
	} {
		if f.path != "" {
			a = append(a, f.flag, f.path)
		}
	}
	if m.TAE != "" {
		// без --taesd-preview-only сервер и готовую картинку собирает маленьким декодером, а это заметно хуже
		a = append(a, "--tae", m.TAE, "--taesd-preview-only")
	}
	a = append(a, "--lora-model-dir", filepath.Join(models, "loras"), "--hires-upscalers-dir", filepath.Join(models, "upscale"),
		"--flash-attn", "off,diffusion=on") // как --diffusion-fa в замерах: быстрее и меньше памяти
	if m.LowVRAM {
		a = append(a, "--offload-to-cpu", "--vae-tiling")
	}
	return a
}

func freePort() (int, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port, nil
}

func (s *sdServer) Loaded() (ModelSet, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.set, s.aliveLocked()
}

func (s *sdServer) aliveLocked() bool {
	if s.base == "" {
		return false
	}
	if s.done == nil { // в проверках сервер подставной, без процесса
		return true
	}
	select {
	case <-s.done:
		return false
	default:
		return true
	}
}

func (s *sdServer) Stop() {
	s.mu.Lock()
	cmd, done := s.cmd, s.done
	s.cmd, s.done, s.base, s.set = nil, nil, "", ModelSet{}
	s.mu.Unlock()
	if cmd != nil && cmd.Process != nil {
		cmd.Process.Kill()
		<-done
	}
}

func (s *sdServer) Load(ctx context.Context, m ModelSet) error {
	if m.empty() {
		return errT("ai.noModel")
	}
	if cur, ok := s.Loaded(); ok && cur == m {
		return nil
	}
	s.Stop()
	if !fileExists(s.exe) {
		return errT("ai.noEngine")
	}
	port, err := freePort()
	if err != nil {
		return err
	}
	os.MkdirAll(filepath.Dir(s.logPath), 0o755)
	logf, err := os.Create(s.logPath)
	if err != nil {
		return err
	}
	cmd := exec.Command(s.exe, sdServerArgs(m, port, s.models)...)
	cmd.Dir = filepath.Dir(s.exe) // рядом его dll
	cmd.Stdout, cmd.Stderr = logf, logf
	hide(cmd)
	if err := cmd.Start(); err != nil {
		logf.Close()
		return err
	}
	dieWithUs(cmd)
	done := make(chan struct{})
	go func() {
		cmd.Wait()
		logf.Close()
		close(done)
	}()
	s.mu.Lock()
	s.cmd, s.done, s.base, s.set = cmd, done, "http://127.0.0.1:"+strconv.Itoa(port), m
	s.mu.Unlock()
	if err := s.waitReady(ctx); err != nil {
		s.Stop()
		return err
	}
	return nil
}

type sdStatus struct {
	State string  `json:"state"` // empty, loading, ready, error
	Error *string `json:"error"`
}

// waitReady ждёт, пока сервер ответит и модель загрузится
func (s *sdServer) waitReady(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, sdLoadLimit)
	defer cancel()
	s.mu.Lock()
	done := s.done
	s.mu.Unlock()
	t := time.NewTicker(200 * time.Millisecond)
	defer t.Stop()
	for {
		var st sdStatus
		code, err := s.call(ctx, "GET", "/sdcpp/v1/models/status", nil, &st)
		if err == nil && code == 200 {
			switch st.State {
			case "error":
				msg := ""
				if st.Error != nil {
					msg = *st.Error
				}
				return errT("ai.loadFailed", msg)
			case "ready", "empty": // empty: модель грузится при первом запросе
				return nil
			}
		}
		select {
		case <-ctx.Done():
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return errT("ai.loadFailed", "timeout")
			}
			return ctx.Err()
		case <-done:
			return errT("ai.loadFailed", logTail(s.logPath, 400))
		case <-t.C:
		}
	}
}

// logTail: конец вывода движка, чтобы в ошибке было видно причину
func logTail(path string, n int) string {
	b, _ := os.ReadFile(path)
	if len(b) > n {
		b = b[len(b)-n:]
	}
	return strings.TrimSpace(string(b))
}

func (s *sdServer) url(path string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.aliveLocked() {
		return "", errT("ai.notLoaded")
	}
	return s.base + path, nil
}

// call: запрос к серверу; ответ разбирается в out (если не nil). Код ответа отдаётся как есть, ошибкой он не считается.
func (s *sdServer) call(ctx context.Context, method, path string, body, out any) (int, error) {
	u, err := s.url(path)
	if err != nil {
		return 0, err
	}
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return 0, err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rd)
	if err != nil {
		return 0, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 512<<20))
	if err != nil {
		return resp.StatusCode, err
	}
	if out != nil && resp.StatusCode < 300 {
		if err := json.Unmarshal(data, out); err != nil {
			return resp.StatusCode, err
		}
	}
	if resp.StatusCode >= 300 {
		return resp.StatusCode, fmt.Errorf("HTTP %d: %s", resp.StatusCode, sdErrText(data))
	}
	return resp.StatusCode, nil
}

// sdErrText достаёт текст ошибки из ответа: {"error": "…"} или {"error": {"message": "…"}}
func sdErrText(data []byte) string {
	var v struct {
		Error json.RawMessage `json:"error"`
	}
	if json.Unmarshal(data, &v) == nil && len(v.Error) > 0 {
		var s string
		if json.Unmarshal(v.Error, &s) == nil {
			return s
		}
		var o struct {
			Message string `json:"message"`
		}
		if json.Unmarshal(v.Error, &o) == nil && o.Message != "" {
			return o.Message
		}
	}
	s := strings.TrimSpace(string(data))
	if len(s) > 300 {
		s = s[:300]
	}
	return s
}

// Тело POST /sdcpp/v1/img_gen. Необязательное не посылаем: тогда сервер берёт значения модели.
type sdGenReq struct {
	Prompt     string   `json:"prompt"`
	Negative   string   `json:"negative_prompt"`
	Width      int      `json:"width"`
	Height     int      `json:"height"`
	Seed       int64    `json:"seed"`
	BatchCount int      `json:"batch_count"`
	Strength   float64  `json:"strength,omitempty"`
	Init       *string  `json:"init_image,omitempty"`
	Mask       *string  `json:"mask_image,omitempty"`
	Sample     sdSample `json:"sample_params"`
	Lora       []sdLora `json:"lora"`
	VAETiling  sdTiling `json:"vae_tiling_params"`
	Preview    string   `json:"preview"`
	PreviewInt int      `json:"preview_interval"`
	Format     string   `json:"output_format"`
	Metadata   bool     `json:"embed_image_metadata"`
}

type sdSample struct {
	Steps     int        `json:"sample_steps"`
	Method    string     `json:"sample_method,omitempty"`
	Scheduler string     `json:"scheduler,omitempty"`
	Guidance  sdGuidance `json:"guidance"`
}

type sdGuidance struct {
	TxtCFG float64 `json:"txt_cfg"`
}

type sdLora struct {
	Path       string  `json:"path"`
	Multiplier float64 `json:"multiplier"`
}

type sdTiling struct {
	Enabled bool `json:"enabled"`
}

func sdRequest(p GenParams) sdGenReq {
	r := sdGenReq{
		Prompt: p.Prompt, Negative: p.Negative, Width: p.Width, Height: p.Height, Seed: p.Seed, BatchCount: 1,
		Sample:    sdSample{Steps: p.Steps, Method: p.Sampler, Scheduler: p.Scheduler, Guidance: sdGuidance{TxtCFG: p.CFG}},
		Lora:      []sdLora{},
		VAETiling: sdTiling{Enabled: p.VAETiling},
		Preview:   "none", PreviewInt: 1,
		Format: "png", Metadata: true, // параметры в PNG, как у A1111: перетащил картинку обратно — настройки вернулись
	}
	switch p.Preview {
	case "proj", "tae", "vae":
		r.Preview = p.Preview
		r.PreviewInt = max(p.PreviewEvery, 1)
	}
	if len(p.Init) > 0 {
		s := base64.StdEncoding.EncodeToString(p.Init)
		r.Init, r.Strength = &s, p.Strength
		if len(p.Mask) > 0 {
			m := base64.StdEncoding.EncodeToString(p.Mask)
			r.Mask = &m
		}
	}
	for _, l := range p.Loras {
		r.Lora = append(r.Lora, sdLora{Path: l.Path, Multiplier: l.Weight})
	}
	return r
}

type sdJob struct {
	ID       string `json:"id"`
	Status   string `json:"status"` // queued, generating, completed, failed, cancelled
	Progress struct {
		Stage     string `json:"stage"`
		Completed *int   `json:"completed"`
		Total     *int   `json:"total"`
		ElapsedMs int64  `json:"elapsed_ms"`
	} `json:"progress"`
	Preview *struct {
		Pass  int    `json:"pass"`
		Step  int    `json:"step"`
		Total int    `json:"total_steps"`
		B64   string `json:"b64_json"`
	} `json:"preview"`
	Result *struct {
		Images []struct {
			B64 string `json:"b64_json"`
		} `json:"images"`
	} `json:"result"`
	Error *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func (j sdJob) terminal() bool {
	return j.Status == "completed" || j.Status == "failed" || j.Status == "cancelled"
}

// sdCancelWait: столько ждём, пока движок остановится после отмены (в замерах ~0,2 с)
var sdCancelWait = 15 * time.Second

func (s *sdServer) Generate(ctx context.Context, p GenParams, progress func(GenProgress)) ([]byte, error) {
	var sub sdJob
	if _, err := s.call(ctx, "POST", "/sdcpp/v1/img_gen", sdRequest(p), &sub); err != nil {
		return nil, errT("ai.genFailed", err)
	}
	if sub.ID == "" {
		return nil, errT("ai.genFailed", "no job id")
	}
	jobPath := "/sdcpp/v1/jobs/" + sub.ID
	t := time.NewTicker(s.poll)
	defer t.Stop()
	lastPass, lastStep := -1, -1
	for {
		select {
		case <-ctx.Done():
			s.cancelJob(jobPath)
			return nil, ctx.Err()
		case <-t.C:
		}
		var j sdJob
		if _, err := s.call(ctx, "GET", jobPath, nil, &j); err != nil {
			if ctx.Err() != nil {
				s.cancelJob(jobPath)
				return nil, ctx.Err()
			}
			return nil, errT("ai.genFailed", err)
		}
		if progress != nil {
			g := GenProgress{Stage: j.Progress.Stage, ElapsedMs: j.Progress.ElapsedMs}
			if j.Progress.Stage == "sampling" && j.Progress.Completed != nil && j.Progress.Total != nil {
				g.Step, g.Total = *j.Progress.Completed, *j.Progress.Total
			}
			if pv := j.Preview; pv != nil && pv.B64 != "" && (pv.Pass != lastPass || pv.Step != lastStep) {
				if png, err := base64.StdEncoding.DecodeString(pv.B64); err == nil {
					g.Preview, g.PreviewStep = png, pv.Step
					lastPass, lastStep = pv.Pass, pv.Step
					if g.Total == 0 { // шаги кончились, идёт сборка картинки: показываем шаги последнего кадра
						g.Step, g.Total = pv.Step, pv.Total
					}
				}
			}
			progress(g)
		}
		switch j.Status {
		case "completed":
			if j.Result == nil || len(j.Result.Images) == 0 {
				return nil, errT("ai.genFailed", "empty result")
			}
			return base64.StdEncoding.DecodeString(j.Result.Images[0].B64)
		case "failed":
			msg := "failed"
			if j.Error != nil {
				msg = j.Error.Message
			}
			return nil, errT("ai.genFailed", msg)
		case "cancelled":
			return nil, context.Canceled
		}
	}
}

// cancelJob просит движок остановиться и ждёт, пока он правда остановится: иначе следующая задача встанет за отменённой
func (s *sdServer) cancelJob(jobPath string) {
	ctx, cancel := context.WithTimeout(context.Background(), sdCancelWait)
	defer cancel()
	s.call(ctx, "POST", jobPath+"/cancel", nil, nil)
	for ctx.Err() == nil {
		var j sdJob
		if _, err := s.call(ctx, "GET", jobPath, nil, &j); err != nil || j.terminal() {
			return
		}
		select {
		case <-ctx.Done():
		case <-time.After(s.poll / 3):
		}
	}
}

func (s *sdServer) Upscale(ctx context.Context, png []byte, upscaler string, repeats int) ([]byte, error) {
	body := map[string]any{
		"image":         base64.StdEncoding.EncodeToString(png),
		"repeats":       min(max(repeats, 1), 4),
		"output_format": "png",
	}
	if upscaler != "" {
		body["upscaler"] = upscaler
	}
	var out struct {
		Images []struct {
			B64 string `json:"b64_json"`
		} `json:"images"`
	}
	if _, err := s.call(ctx, "POST", "/sdcpp/v1/upscale", body, &out); err != nil {
		return nil, errT("ai.upscaleFailed", err)
	}
	if len(out.Images) == 0 {
		return nil, errT("ai.upscaleFailed", "empty result")
	}
	return base64.StdEncoding.DecodeString(out.Images[0].B64)
}
