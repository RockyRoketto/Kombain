package main

// Удаление фона нейросетью (BiRefNet-matting в fp16 через ONNX Runtime + DirectML).
// Считает отдельный процесс — та же программа с ключом --bg-worker (bgWorkerMain): ORT и драйвер живут не в
// окне программы, а выход процесса гарантированно отдаёт видеопамять. Программа говорит с ним строками JSON
// через stdin/stdout: {"in","out"} → {"ok","ms"} или {"err"}. Процесс поднимается при первой картинке и
// уходит, простояв bgIdle.
// Подготовка (замеры прототипа 2026-11-16): вход 1024×1024, нормализация ImageNet, выход — логиты (сигмоида).
// Пересчёт цвета краёв (bgDefringe) обязателен: без него на прядях остаётся дымка старого фона.

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/draw"
	_ "image/jpeg"
	"image/png"
	"io"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	_ "golang.org/x/image/webp"
)

const bgSide = 1024 // сторона входа модели

// bgIdle: столько обработчик ждёт следующую картинку, прежде чем отдать видеопамять
var bgIdle = 90 * time.Second

// bgShareGPU: видеопамяти хватает и модели картинок, и удалению фона. Замер 2026-11-16 (RTX 4080 S): модель
// грузится в ~1,2 ГБ, на первой картинке DirectML добирает до ~10,4 ГБ и держит, SDXL на пике 10–11 ГБ.
func bgShareGPU() bool { return hwVRAMTotal() >= 24*1024 }

// bgModelPath: файл установленной модели удаления фона; пусто — не установлена
func bgModelPath() string {
	for _, m := range aiLoadInstalled().Models {
		if m.Kind != "bgremove" {
			continue
		}
		for _, f := range m.Files {
			if f.Role == "bgremove" {
				if p := filepath.Join(aiModelsDir(), filepath.FromSlash(f.Path)); fileExists(p) {
					return p
				}
			}
		}
	}
	return ""
}

func bgEngineDir() string { return aiEngineDir("ort") }

// bgReady: движок и модель на месте
func bgReady() bool {
	return fileExists(filepath.Join(bgEngineDir(), "onnxruntime.dll")) && bgModelPath() != ""
}

// ---- обработка картинки (без видеокарты, проверяется тестами) ----

// bgToNRGBA: любая картинка → NRGBA с началом в нуле
func bgToNRGBA(im image.Image) *image.NRGBA {
	b := im.Bounds()
	n := image.NewNRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(n, n.Bounds(), im, b.Min, draw.Src)
	return n
}

// bgInput: картинка → тензор NCHW S×S, нормализация ImageNet. Уменьшение усреднением по площади, чтобы на больших
// картинках тонкие пряди не терялись между выборками.
func bgInput(img *image.NRGBA, s int) []float32 {
	small := bgResizeRGB(img, s, s)
	mean := [3]float32{0.485, 0.456, 0.406}
	std := [3]float32{0.229, 0.224, 0.225}
	x := make([]float32, 3*s*s)
	for i := 0; i < s*s; i++ {
		for c := 0; c < 3; c++ {
			x[c*s*s+i] = (small[i*3+c] - mean[c]) / std[c]
		}
	}
	return x
}

// bgResizeRGB: RGB в 0..1, уменьшение по площади, увеличение билинейно
func bgResizeRGB(src *image.NRGBA, w, h int) []float32 {
	sw, sh := src.Bounds().Dx(), src.Bounds().Dy()
	out := make([]float32, w*h*3)
	px := func(x, y, c int) float32 {
		x = min(max(x, 0), sw-1)
		y = min(max(y, 0), sh-1)
		return float32(src.Pix[y*src.Stride+x*4+c]) / 255
	}
	if sw <= w && sh <= h {
		for y := 0; y < h; y++ {
			fy := (float64(y)+0.5)*float64(sh)/float64(h) - 0.5
			y0 := int(math.Floor(fy))
			ty := float32(fy - float64(y0))
			for x := 0; x < w; x++ {
				fx := (float64(x)+0.5)*float64(sw)/float64(w) - 0.5
				x0 := int(math.Floor(fx))
				tx := float32(fx - float64(x0))
				for c := 0; c < 3; c++ {
					out[(y*w+x)*3+c] = (px(x0, y0, c)*(1-tx)+px(x0+1, y0, c)*tx)*(1-ty) + (px(x0, y0+1, c)*(1-tx)+px(x0+1, y0+1, c)*tx)*ty
				}
			}
		}
		return out
	}
	for y := 0; y < h; y++ {
		y0, y1 := y*sh/h, max((y+1)*sh/h, y*sh/h+1)
		for x := 0; x < w; x++ {
			x0, x1 := x*sw/w, max((x+1)*sw/w, x*sw/w+1)
			var acc [3]float32
			for yy := y0; yy < y1; yy++ {
				for xx := x0; xx < x1; xx++ {
					for c := 0; c < 3; c++ {
						acc[c] += px(xx, yy, c)
					}
				}
			}
			n := float32((y1 - y0) * (x1 - x0))
			for c := 0; c < 3; c++ {
				out[(y*w+x)*3+c] = acc[c] / n
			}
		}
	}
	return out
}

// bgMask: выход модели (последние две оси — квадрат маски) → прозрачность 0..1. Логиты проходят сигмоиду.
func bgMask(out []float32, dims []int64) ([]float32, int, error) {
	if len(dims) < 2 {
		return nil, 0, errors.New("bgremove: bad output")
	}
	ms := int(dims[len(dims)-1])
	if ms <= 0 || int(dims[len(dims)-2]) != ms || len(out) < ms*ms {
		return nil, 0, errors.New("bgremove: bad output")
	}
	m := slices32(out[len(out)-ms*ms:])
	logits := false
	for _, v := range m {
		if v < 0 || v > 1 {
			logits = true
			break
		}
	}
	for i, v := range m {
		if logits {
			v = float32(1 / (1 + math.Exp(-float64(v))))
		}
		m[i] = min(max(v, 0), 1)
	}
	return m, ms, nil
}

func slices32(s []float32) []float32 { return append([]float32(nil), s...) }

// bgResizeMask: маска s×s → w×h билинейно
func bgResizeMask(m []float32, s, w, h int) []float32 {
	out := make([]float32, w*h)
	g := func(x, y int) float32 { return m[min(max(y, 0), s-1)*s+min(max(x, 0), s-1)] }
	for y := 0; y < h; y++ {
		fy := (float64(y)+0.5)*float64(s)/float64(h) - 0.5
		y0 := int(math.Floor(fy))
		ty := float32(fy - float64(y0))
		for x := 0; x < w; x++ {
			fx := (float64(x)+0.5)*float64(s)/float64(w) - 0.5
			x0 := int(math.Floor(fx))
			tx := float32(fx - float64(x0))
			out[y*w+x] = (g(x0, y0)*(1-tx)+g(x0+1, y0)*tx)*(1-ty) + (g(x0, y0+1)*(1-tx)+g(x0+1, y0+1)*tx)*ty
		}
	}
	return out
}

// bgCutout: исходник с пересчитанными краями и прозрачностью a
func bgCutout(img *image.NRGBA, a []float32) *image.NRGBA {
	o := bgDefringe(img, a)
	for i := range a {
		o.Pix[i*4+3] = uint8(min(max(a[i], 0), 1)*float32(o.Pix[i*4+3])/255*255 + 0.5)
	}
	return o
}

// bgDefringe убирает цвет старого фона из полупрозрачных краёв: фон B — размытие исходника с весом (1−a)²,
// цвет объекта F = (I − (1−a)·B) / a. Размытие по уровням (крупное, потом мельче уточняет) на картинке в 4 раза меньше.
func bgDefringe(img *image.NRGBA, a []float32) *image.NRGBA {
	w, h := img.Bounds().Dx(), img.Bounds().Dy()
	o := image.NewNRGBA(img.Bounds())
	copy(o.Pix, img.Pix)
	const k = 4
	sw, sh := (w+k-1)/k, (h+k-1)/k
	acc := make([]float64, sw*sh*4)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			wt := float64(1 - min(max(a[y*w+x], 0), 1))
			wt *= wt
			i := ((y/k)*sw + x/k) * 4
			s := img.Pix[y*img.Stride+x*4:]
			acc[i] += float64(s[0]) * wt
			acc[i+1] += float64(s[1]) * wt
			acc[i+2] += float64(s[2]) * wt
			acc[i+3] += wt
		}
	}
	bg := make([]float64, sw*sh*3)
	for _, r := range []int{24, 8, 3} {
		bl := bgBoxBlur4(acc, sw, sh, r)
		for i := 0; i < sw*sh; i++ {
			if bl[i*4+3] > 1e-3 {
				for c := 0; c < 3; c++ {
					bg[i*3+c] = bl[i*4+c] / bl[i*4+3]
				}
			}
		}
	}
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			al := float64(min(max(a[y*w+x], 0), 1))
			if al < 0.02 || al > 0.98 {
				continue
			}
			bi := ((y/k)*sw + x/k) * 3
			p := o.Pix[y*o.Stride+x*4:]
			for c := 0; c < 3; c++ {
				f := (float64(p[c]) - (1-al)*bg[bi+c]) / max(al, 0.15)
				p[c] = uint8(min(max(f, 0), 255) + 0.5)
			}
		}
	}
	return o
}

// bgBoxBlur4: размытие квадратом радиуса r (скользящая сумма) по 4 каналам
func bgBoxBlur4(src []float64, w, h, r int) []float64 {
	tmp := make([]float64, len(src))
	out := make([]float64, len(src))
	for y := 0; y < h; y++ {
		for c := 0; c < 4; c++ {
			s := 0.0
			for d := -r; d <= r; d++ {
				s += src[(y*w+min(max(d, 0), w-1))*4+c]
			}
			for x := 0; x < w; x++ {
				tmp[(y*w+x)*4+c] = s
				s += src[(y*w+min(x+r+1, w-1))*4+c] - src[(y*w+max(x-r, 0))*4+c]
			}
		}
	}
	for x := 0; x < w; x++ {
		for c := 0; c < 4; c++ {
			s := 0.0
			for d := -r; d <= r; d++ {
				s += tmp[(min(max(d, 0), h-1)*w+x)*4+c]
			}
			for y := 0; y < h; y++ {
				out[(y*w+x)*4+c] = s
				s += tmp[(min(y+r+1, h-1)*w+x)*4+c] - tmp[(max(y-r, 0)*w+x)*4+c]
			}
		}
	}
	return out
}

// bgRun: вся обработка одной картинки; infer — модель (в проверках подставная)
func bgRun(img *image.NRGBA, infer func(x []float32, shape []int64) ([]float32, []int64, error)) (*image.NRGBA, error) {
	w, h := img.Bounds().Dx(), img.Bounds().Dy()
	out, dims, err := infer(bgInput(img, bgSide), []int64{1, 3, bgSide, bgSide})
	if err != nil {
		return nil, err
	}
	m, ms, err := bgMask(out, dims)
	if err != nil {
		return nil, err
	}
	return bgCutout(img, bgResizeMask(m, ms, w, h)), nil
}

// ---- отдельный процесс ----

type bgReq struct {
	In  string `json:"in"`
	Out string `json:"out"`
}

type bgResp struct {
	Ready   bool   `json:"ready,omitempty"`
	OK      bool   `json:"ok,omitempty"`
	MS      int64  `json:"ms,omitempty"`
	Adapter string `json:"adapter,omitempty"`
	Err     string `json:"err,omitempty"`
}

// bgWorkerMain: Konvertor.exe --bg-worker <папка движка> <модель>
func bgWorkerMain(args []string) {
	enc := json.NewEncoder(os.Stdout)
	if len(args) < 2 {
		enc.Encode(bgResp{Err: "usage"})
		return
	}
	sess, err := ortOpen(args[0], args[1])
	if err != nil {
		enc.Encode(bgResp{Err: err.Error()})
		return
	}
	defer sess.Close()
	enc.Encode(bgResp{Ready: true, Adapter: sess.Adapter})
	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		var r bgReq
		if json.Unmarshal(sc.Bytes(), &r) != nil {
			continue
		}
		t0 := time.Now()
		if err := bgFile(r.In, r.Out, sess.Run); err != nil {
			enc.Encode(bgResp{Err: err.Error()})
			continue
		}
		enc.Encode(bgResp{OK: true, MS: time.Since(t0).Milliseconds()})
	}
}

func bgFile(in, out string, infer func([]float32, []int64) ([]float32, []int64, error)) error {
	f, err := os.Open(in)
	if err != nil {
		return err
	}
	im, _, err := image.Decode(f)
	f.Close()
	if err != nil {
		return err
	}
	res, err := bgRun(bgToNRGBA(im), infer)
	if err != nil {
		return err
	}
	tmp := out + ".tmp"
	w, err := os.Create(tmp)
	if err != nil {
		return err
	}
	err = (&png.Encoder{CompressionLevel: png.BestSpeed}).Encode(w, res)
	if e := w.Close(); err == nil {
		err = e
	}
	if err == nil {
		os.Remove(out)
		err = os.Rename(tmp, out)
	}
	if err != nil {
		os.Remove(tmp)
	}
	return err
}

// ---- сторона программы ----

type bgWorker struct {
	mu      sync.Mutex // процесс: запуск, остановка
	busy    sync.Mutex // одна картинка за раз
	cmd     *exec.Cmd
	in      io.WriteCloser
	out     *bufio.Scanner
	done    chan struct{}
	model   string
	adapter string
	timer   *time.Timer
}

var bgSrv = &bgWorker{}

func (b *bgWorker) Stop() {
	b.mu.Lock()
	cmd, done, in := b.cmd, b.done, b.in
	b.cmd, b.done, b.in, b.out, b.model = nil, nil, nil, nil, ""
	if b.timer != nil {
		b.timer.Stop()
	}
	b.mu.Unlock()
	if cmd != nil && cmd.Process != nil {
		in.Close()
		cmd.Process.Kill()
		<-done
	}
	aiGPU.drop("bg")
}

// Running: обработчик запущен (держит видеопамять)
func (b *bgWorker) Running() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.cmd != nil
}

func (b *bgWorker) start(model string) error {
	b.mu.Lock()
	if b.cmd != nil && b.model == model {
		select {
		case <-b.done:
		default:
			b.mu.Unlock()
			return nil
		}
	}
	b.mu.Unlock()
	b.Stop()
	if !bgShareGPU() {
		aiGPU.take("bg", func() { go b.Stop() })
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	os.MkdirAll(aiLogDir(), 0o755)
	logf, err := os.Create(filepath.Join(aiLogDir(), "bgremove.log"))
	if err != nil {
		return err
	}
	cmd := exec.Command(exe, "--bg-worker", bgEngineDir(), model)
	cmd.Dir = bgEngineDir()
	cmd.Stderr = logf
	in, err := cmd.StdinPipe()
	if err != nil {
		logf.Close()
		return err
	}
	outPipe, err := cmd.StdoutPipe()
	if err != nil {
		logf.Close()
		return err
	}
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
	sc := bufio.NewScanner(outPipe)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	b.mu.Lock()
	b.cmd, b.in, b.out, b.done, b.model = cmd, in, sc, done, model
	b.mu.Unlock()
	r, err := b.read(context.Background())
	if err == nil && !r.Ready {
		err = errors.New(r.Err)
	}
	if err != nil {
		b.Stop()
		return errT("bg.failed", err.Error())
	}
	b.mu.Lock()
	b.adapter = r.Adapter
	b.mu.Unlock()
	return nil
}

// read: следующий ответ обработчика. Строки не JSON (если библиотека что-то напечатала) пропускаются.
func (b *bgWorker) read(ctx context.Context) (bgResp, error) {
	b.mu.Lock()
	sc, done := b.out, b.done
	b.mu.Unlock()
	if sc == nil {
		return bgResp{}, errors.New("bgremove: not running")
	}
	type res struct {
		r   bgResp
		err error
	}
	ch := make(chan res, 1)
	go func() {
		for sc.Scan() {
			line := sc.Bytes()
			if len(line) == 0 || line[0] != '{' {
				continue
			}
			var r bgResp
			if json.Unmarshal(line, &r) == nil {
				ch <- res{r: r}
				return
			}
		}
		ch <- res{err: fmt.Errorf("bgremove: worker exited: %s", logTail(filepath.Join(aiLogDir(), "bgremove.log"), 300))}
	}()
	select {
	case x := <-ch:
		return x.r, x.err
	case <-ctx.Done():
		go b.Stop() // ответ уже не нужен: обработчик убираем, иначе следующий запрос прочтёт чужой ответ
		<-done
		return bgResp{}, ctx.Err()
	}
}

// Cut убирает фон у картинки in и пишет PNG с прозрачностью в out
func (b *bgWorker) Cut(ctx context.Context, in, out string) error {
	model := bgModelPath()
	if model == "" || !bgReady() {
		return errT("bg.notInstalled")
	}
	b.busy.Lock()
	defer b.busy.Unlock()
	if err := b.start(model); err != nil {
		return err
	}
	b.mu.Lock()
	if b.timer != nil {
		b.timer.Stop()
	}
	w := b.in
	b.mu.Unlock()
	line, _ := json.Marshal(bgReq{In: in, Out: out})
	if _, err := w.Write(append(line, '\n')); err != nil {
		b.Stop()
		return err
	}
	r, err := b.read(ctx)
	if err != nil {
		return err
	}
	b.mu.Lock()
	if b.cmd != nil {
		b.timer = time.AfterFunc(bgIdle, b.Stop)
	}
	b.mu.Unlock()
	if !r.OK {
		return errT("bg.failed", r.Err)
	}
	return nil
}

// CutPNG: то же для картинки в памяти
func (b *bgWorker) CutPNG(ctx context.Context, data []byte) ([]byte, error) {
	dir := filepath.Join(aiRoot(), "tmp")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	f, err := os.CreateTemp(dir, "bg-*.png")
	if err != nil {
		return nil, err
	}
	in := f.Name()
	out := strings.TrimSuffix(in, ".png") + "-cut.png"
	defer os.Remove(in)
	defer os.Remove(out)
	_, err = f.Write(data)
	if e := f.Close(); err == nil {
		err = e
	}
	if err != nil {
		return nil, err
	}
	if err := b.Cut(ctx, in, out); err != nil {
		return nil, err
	}
	return os.ReadFile(out)
}

// bgMetaOf: параметры картинки галереи с пометкой Cutout
func bgMetaOf(src string) GenMeta {
	var m GenMeta
	if b, err := os.ReadFile(genSidecar(src)); err == nil {
		json.Unmarshal(b, &m)
	}
	m.Cutout, m.App = true, "Kombain "+appVersion
	return m
}

// bgWrite кладёт PNG (параметры внутри, как у genSave) и .json рядом; оба файла подменяются целиком
func bgWrite(img string, data []byte, m GenMeta) error {
	inner, _ := json.Marshal(m)
	if b, err := pngWithText(data, [][2]string{{"parameters", genA1111(m)}, {"kombain", string(inner)}}); err == nil {
		data = b
	}
	if err := writeFileAtomic(img, data); err != nil {
		return err
	}
	meta, _ := json.MarshalIndent(m, "", "  ")
	return writeFileAtomic(genSidecar(img), meta)
}

// bgGallerySave: вырезанная картинка — новая запись галереи рядом с исходной (исходник не трогаем).
// Параметры берутся у исходной, с пометкой Cutout.
func bgGallerySave(src string, data []byte) (string, error) {
	m := bgMetaOf(src)
	now := time.Now()
	m.Created, m.Fav = now, false
	dir := aiGalleryDir(now)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	name := strings.TrimSuffix(filepath.Base(src), filepath.Ext(src)) + "-nobg"
	img := filepath.Join(dir, name+".png")
	for i := 2; fileExists(img); i++ {
		img = filepath.Join(dir, fmt.Sprintf("%s-%d.png", name, i))
	}
	if err := bgWrite(img, data, m); err != nil {
		os.Remove(img)
		return "", err
	}
	return img, nil
}

func (s *Server) bgRoutes(mux *http.ServeMux) {
	// «Убрать фон» у картинки галереи: новая картинка с прозрачностью ложится рядом
	mux.HandleFunc("/api/gen-bg", s.api(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Path string `json:"path"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if !genInGallery(body.Path) || !fileExists(body.Path) {
			writeJSON(w, map[string]any{"error": tr("err.noFile")})
			return
		}
		if !bgReady() {
			writeJSON(w, map[string]any{"error": tr("bg.notInstalled")})
			return
		}
		data, err := os.ReadFile(body.Path)
		if err == nil {
			// генератор рисует: ждём конца его задачи (вместе на видеокарте не помещаются)
			aiWork.Lock()
			data, err = bgSrv.CutPNG(r.Context(), data)
			aiWork.Unlock()
		}
		var p string
		if err == nil {
			p, err = bgGallerySave(body.Path, data)
		}
		if err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, map[string]any{"ok": true, "path": p})
	}))
}

// bgOutPath: куда класть вырезанную копию произвольного файла: рядом, <имя>-nobg.png, существующие не трогаем
func bgOutPath(src string) string {
	base := strings.TrimSuffix(src, filepath.Ext(src)) + "-nobg"
	out := base + ".png"
	for i := 2; fileExists(out); i++ {
		out = fmt.Sprintf("%s-%d.png", base, i)
	}
	return out
}

// bgFileOK: картинки, которые умеет читать обработчик
func bgFileOK(p string) bool {
	switch strings.ToLower(filepath.Ext(p)) {
	case ".png", ".jpg", ".jpeg", ".webp", ".gif":
		return true
	}
	return false
}

func (s *Server) bgFileRoutes(mux *http.ServeMux) {
	// «Убрать фон» в «Утилитах»: любая картинка с диска, результат — PNG рядом с оригиналом
	mux.HandleFunc("/api/bg-file", s.api(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Path string `json:"path"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if !bgFileOK(body.Path) || !fileExists(body.Path) {
			writeJSON(w, map[string]any{"error": tr("err.noFile")})
			return
		}
		if !bgReady() {
			writeJSON(w, map[string]any{"error": tr("bg.notInstalled"), "needModel": true})
			return
		}
		out := bgOutPath(body.Path)
		aiWork.Lock()
		err := bgSrv.Cut(r.Context(), body.Path, out)
		aiWork.Unlock()
		if err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, map[string]any{"ok": true, "path": out})
	}))
}
