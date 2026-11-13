package main

// Очередь генератора картинок. Одна строка очереди — один запрос на N картинок; картинки рисуются по одной
// (у каждой своё зерно seed+i и свой предпросмотр), готовая сразу ложится в галерею вместе с .json параметров.
// Работает одна задача за раз: видеокарта одна. Движок (sdengine.go) выгружается, если очередь простаивает genIdle,
// или если видеопамять понадобилась модели промтов (gpuGate).
// Страница будет опрашивать genQueue.State и забирать кадр предпросмотра через Preview по номеру кадра.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

// gpuGate: видеопамять одна на всех. Модель картинок и LLM вместе на 8 ГБ не помещаются, поэтому кто берёт карту,
// тот выгружает прежнего хозяина. LLM пишет промт за секунду и сама уходит, так что спорить они почти не будут.
type gpuGate struct {
	mu      sync.Mutex
	owner   string
	release func()
}

func (g *gpuGate) take(owner string, release func()) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.owner != "" && g.owner != owner && g.release != nil {
		g.release()
	}
	g.owner, g.release = owner, release
}

func (g *gpuGate) drop(owner string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.owner == owner {
		g.owner, g.release = "", nil
	}
}

func (g *gpuGate) holder() string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.owner
}

var aiGPU = &gpuGate{}

// GenTask: строка очереди, как её видит страница
type GenTask struct {
	ID         int         `json:"id"`
	Model      string      `json:"model"` // id установленной модели
	Params     GenParams   `json:"params"`
	Count      int         `json:"count"`
	Status     string      `json:"status"` // queued, loading, running, done, failed, cancelled
	Index      int         `json:"index"`  // какая картинка рисуется (с 0)
	Progress   GenProgress `json:"progress"`
	PreviewSeq int         `json:"previewSeq"`        // растёт с каждым новым кадром
	Images     []string    `json:"images"`            // готовые файлы
	Err        string      `json:"err,omitempty"`     // технический текст ошибки («Подробности»)
	ErrKind    string      `json:"errKind,omitempty"` // vram, disk, model, engine, other: страница по нему пишет понятный текст
	Added      time.Time   `json:"added"`
	Req        genAddReq   `json:"req"` // как попросил человек: запрос без шаблона стиля, стиль, пропорция
}

func (t *GenTask) finished() bool {
	return t.Status == "done" || t.Status == "failed" || t.Status == "cancelled"
}

// genIdle: столько очередь может простаивать, прежде чем движок выгрузится и отдаст видеопамять
var genIdle = 5 * time.Minute

type genQueue struct {
	engine  ImageEngine
	resolve func(model string) (ModelSet, error)               // id → файлы (aiModelSet)
	save    func(t GenTask, i int, png []byte) (string, error) // куда класть готовую картинку
	gpu     *gpuGate
	idle    time.Duration

	mu      sync.Mutex
	tasks   []*GenTask
	nextID  int
	preview map[int][]byte // последний кадр каждой работающей задачи
	cancel  context.CancelFunc
	current int    // id задачи, которая сейчас работает
	loaded  string // id модели, которую последней загрузили в движок
	wake    chan struct{}
}

func newGenQueue(e ImageEngine, resolve func(string) (ModelSet, error), save func(GenTask, int, []byte) (string, error), gpu *gpuGate) *genQueue {
	return &genQueue{engine: e, resolve: resolve, save: save, gpu: gpu, idle: genIdle, preview: map[int][]byte{}, wake: make(chan struct{}, 1)}
}

func (q *genQueue) poke() {
	select {
	case q.wake <- struct{}{}:
	default:
	}
}

// Add ставит запрос в очередь. Случайное зерно выбирается здесь, чтобы его можно было записать и повторить картинку.
func (q *genQueue) Add(model string, p GenParams, count int, req genAddReq) int {
	if p.Seed < 0 {
		p.Seed = rand.Int64N(1 << 32)
	}
	q.mu.Lock()
	q.nextID++
	t := &GenTask{ID: q.nextID, Model: model, Params: p, Count: min(max(count, 1), 16), Status: "queued", Images: []string{}, Added: time.Now(), Req: req}
	q.tasks = append(q.tasks, t)
	q.mu.Unlock()
	q.poke()
	return t.ID
}

// Cancel: ждущая задача сразу помечается отменённой, работающая останавливается (уже готовые картинки остаются)
func (q *genQueue) Cancel(id int) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for _, t := range q.tasks {
		if t.ID != id || t.finished() {
			continue
		}
		if id == q.current && q.cancel != nil {
			q.cancel()
		} else {
			t.Status = "cancelled"
		}
	}
}

// Clear убирает из списка законченные задачи
func (q *genQueue) Clear() {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.tasks = slices.DeleteFunc(q.tasks, func(t *GenTask) bool { return t.finished() })
}

// State: копия очереди для страницы
func (q *genQueue) State() []GenTask {
	q.mu.Lock()
	defer q.mu.Unlock()
	out := make([]GenTask, len(q.tasks))
	for i, t := range q.tasks {
		out[i] = *t
		out[i].Images = slices.Clone(t.Images)
	}
	return out
}

// Preview: последний кадр задачи и его номер (тот же, что PreviewSeq)
func (q *genQueue) Preview(id int) ([]byte, int) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for _, t := range q.tasks {
		if t.ID == id {
			return q.preview[id], t.PreviewSeq
		}
	}
	return nil, 0
}

// LoadedModel: id модели в видеопамяти; пусто — движок выгружен (простоем или ради LLM)
func (q *genQueue) LoadedModel() string {
	if _, ok := q.engine.Loaded(); !ok {
		return ""
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.loaded
}

func (q *genQueue) next() *GenTask {
	q.mu.Lock()
	defer q.mu.Unlock()
	for _, t := range q.tasks {
		if t.Status == "queued" {
			return t
		}
	}
	return nil
}

func (q *genQueue) set(t *GenTask, fn func(t *GenTask)) {
	q.mu.Lock()
	fn(t)
	q.mu.Unlock()
}

// Run — рабочий цикл, живёт до отмены ctx. На выходе движок выгружается.
func (q *genQueue) Run(ctx context.Context) {
	defer q.unload()
	idle := time.NewTimer(q.idle)
	defer idle.Stop()
	for {
		t := q.next()
		if t == nil {
			select {
			case <-ctx.Done():
				return
			case <-q.wake:
				continue
			case <-idle.C:
				q.unload()
				continue
			}
		}
		q.runTask(ctx, t)
		idle.Reset(q.idle)
		if ctx.Err() != nil {
			return
		}
	}
}

func (q *genQueue) unload() {
	if _, ok := q.engine.Loaded(); ok {
		q.engine.Stop()
	}
	q.gpu.drop("sd")
}

// genErrKind: вид ошибки для страницы. phase: model (выбор модели), load (запуск движка), gen (кадр), save (запись файла).
func genErrKind(err error, phase string) string {
	s := strings.ToLower(err.Error())
	has := func(w ...string) bool {
		for _, x := range w {
			if strings.Contains(s, x) {
				return true
			}
		}
		return false
	}
	switch {
	case has("out of memory", "capacity check", "no results", "cudamalloc", "failed to allocate", "not enough memory"):
		return "vram"
	case has("no space left", "not enough space", "disk full"):
		return "disk"
	case phase == "model", has(strings.ToLower(tr("ai.noModel"))):
		return "model"
	case phase == "load", has(strings.ToLower(tr("ai.noEngine"))):
		return "engine"
	case phase == "save":
		return "disk"
	}
	return "other"
}

// genRetryPause: пауза перед повтором упавшего кадра (в проверках обнуляется)
var genRetryPause = 4 * time.Second

func (q *genQueue) runTask(parent context.Context, t *GenTask) {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	q.mu.Lock()
	if t.Status != "queued" { // отменили, пока брали
		q.mu.Unlock()
		return
	}
	t.Status, q.current, q.cancel = "loading", t.ID, cancel
	q.mu.Unlock()
	defer func() {
		q.mu.Lock()
		q.current, q.cancel = 0, nil
		delete(q.preview, t.ID)
		q.mu.Unlock()
	}()

	fail := func(err error, phase string) {
		q.set(t, func(t *GenTask) {
			if errors.Is(err, context.Canceled) || ctx.Err() != nil {
				t.Status = "cancelled"
			} else {
				t.Status, t.Err, t.ErrKind = "failed", err.Error(), genErrKind(err, phase)
			}
		})
	}
	set, err := q.resolve(t.Model)
	if err != nil {
		fail(err, "model")
		return
	}
	// помощник «Улучшить» на картах от 14 ГБ живёт рядом с моделью (минуту после запроса) и съедает память,
	// которой потом не хватает на кадр: sd-server падает с «generate_image returned no results». Перед рисованием выгружаем его.
	llmSrv.Stop()
	q.gpu.take("sd", q.engine.Stop)
	if err := q.engine.Load(ctx, set); err != nil {
		fail(err, "load")
		return
	}
	q.mu.Lock()
	q.loaded = t.Model
	q.mu.Unlock()
	q.set(t, func(t *GenTask) { t.Status = "running" })
	for i := 0; i < t.Count; i++ {
		p := t.Params
		p.Seed += int64(i)
		q.set(t, func(t *GenTask) { t.Index, t.Progress = i, GenProgress{} })
		onProgress := func(g GenProgress) {
			q.mu.Lock()
			if g.Preview != nil {
				q.preview[t.ID] = g.Preview
				t.PreviewSeq++
			}
			g.Preview = nil
			t.Progress = g
			q.mu.Unlock()
		}
		png, err := q.engine.Generate(ctx, p, onProgress)
		// Нехватка видеопамяти на старте кадра (в логе sd-server: свободно 0.6–1.1 ГБ из 16, нужно 1.5 ГБ) бывает случайной:
		// другие программы или драйвер ещё не вернули память. Повтор через паузу, потом ещё раз в экономном режиме
		// (часть модели в обычной памяти, VAE по плиткам).
		for try := 1; err != nil && ctx.Err() == nil && try <= 2; try++ {
			select {
			case <-ctx.Done():
			case <-time.After(genRetryPause):
			}
			if try == 2 {
				if set.LowVRAM {
					break
				}
				set.LowVRAM = true
				if lerr := q.engine.Load(ctx, set); lerr != nil {
					break
				}
			}
			q.set(t, func(t *GenTask) { t.Progress = GenProgress{} })
			png, err = q.engine.Generate(ctx, p, onProgress)
		}
		if err != nil {
			fail(err, "gen")
			return
		}
		q.mu.Lock()
		snap := *t
		q.mu.Unlock()
		path, err := q.save(snap, i, png)
		if err != nil {
			fail(err, "save")
			return
		}
		q.set(t, func(t *GenTask) { t.Images = append(t.Images, path) })
	}
	q.set(t, func(t *GenTask) { t.Status = "done" })
}

// GenMeta: .json рядом с картинкой. По нему галерея ищет по промту, а «ещё такие же» повторяет настройки.
type GenMeta struct {
	Model   string     `json:"model"`
	Params  GenParams  `json:"params"` // Seed — зерно именно этой картинки
	Request *genAddReq `json:"request,omitempty"`
	Created time.Time  `json:"created"`
	App     string     `json:"app"`
	Fav     bool       `json:"fav,omitempty"` // избранное в галерее
}

// genSave кладёт картинку в gallery\ГГГГ-ММ\ под именем «дата-время-задача-зерно.png» и .json рядом.
// Параметры дублируются внутри PNG (genpng.go): картинку можно унести, а настройки останутся с ней.
func genSave(root func(time.Time) string) func(GenTask, int, []byte) (string, error) {
	return func(t GenTask, i int, png []byte) (string, error) {
		now := time.Now()
		dir := root(now)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return "", err
		}
		p := t.Params
		p.Seed += int64(i)
		req := t.Req
		m := GenMeta{Model: t.Model, Params: p, Request: &req, Created: now, App: "Kombain " + appVersion}
		inner, _ := json.Marshal(m)
		if b, err := pngWithText(png, [][2]string{{"parameters", genA1111(m)}, {"kombain", string(inner)}}); err == nil {
			png = b
		}
		name := fmt.Sprintf("%s-%d-%d", now.Format("20060102-150405"), t.ID, p.Seed)
		img := filepath.Join(dir, name+".png")
		if err := os.WriteFile(img, png, 0o644); err != nil {
			return "", err
		}
		meta, _ := json.MarshalIndent(m, "", "  ")
		if err := os.WriteFile(filepath.Join(dir, name+".json"), meta, 0o644); err != nil {
			os.Remove(img)
			return "", err
		}
		return img, nil
	}
}
