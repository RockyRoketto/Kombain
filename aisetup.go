package main

// Установка генератора картинок со страницы: окно первого запуска и менеджер моделей во вкладке «Генератор».
// Одна задача скачивания за раз (aiJob): движок под видеокарту (если нужен) и модели с зависимостями, общий прогресс,
// скорость, отмена. Страница спрашивает состояние (ai-setup), пока задача идёт. Удаление моделей — здесь же и
// в «Хранилище» настроек (storage.go).

import (
	"context"
	"encoding/json"
	"net/http"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

// aiFirstRun: что ставится в окне первого запуска. Помощник запросов (LLM) — по галочке (включена).
var (
	aiFirstImage = "zimage-turbo"
	aiFirstLLM   = "gemma3-4b"
)

type aiJobState struct {
	Active bool     `json:"active"`
	Items  []string `json:"items"` // что ставится: id моделей и «engine:sd», «engine:llm»
	Cur    string   `json:"cur"`
	Done   int64    `json:"done"`
	Total  int64    `json:"total"`
	Speed  float64  `json:"speed"` // байт в секунду
	Err    string   `json:"err,omitempty"`
	OK     bool     `json:"ok"` // последняя задача закончилась успешно
}

type aiJob struct {
	mu     sync.Mutex
	st     aiJobState
	cancel context.CancelFunc
	t0     time.Time
	d0     int64
}

var aiInstaller = &aiJob{}

func (j *aiJob) state() aiJobState {
	j.mu.Lock()
	defer j.mu.Unlock()
	s := j.st
	s.Items = slices.Clone(s.Items)
	return s
}

func (j *aiJob) progress(cur string, done, total int64) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.st.Cur, j.st.Done, j.st.Total = cur, done, total
	// скорость по окну в 2 с, чтобы цифра не прыгала
	if el := time.Since(j.t0); el >= 2*time.Second {
		j.st.Speed = float64(done-j.d0) / el.Seconds()
		j.t0, j.d0 = time.Now(), done
	}
}

// aiEngineFor: сборка движка kind под эту видеокарту; без подходящей карты — запасной Vulkan
func aiEngineFor(c Catalog, kind string) (CatEngine, bool) {
	gpu, _ := regGPU()
	flavor := hwFlavor(hwVendor(gpu))
	if flavor == "" {
		flavor = "vulkan"
	}
	var alt CatEngine
	found := false
	for _, e := range c.Engines {
		if e.Kind != kind {
			continue
		}
		if e.Flavor == flavor {
			return e, true
		}
		if !found {
			alt, found = e, true
		}
	}
	return alt, found
}

// aiSteps: что придётся сделать для набора моделей: движки и сами модели, с объёмом скачивания
type aiStep struct {
	ID     string
	Engine *CatEngine
	Size   int64 // сколько всего скачать (для прогресса)
	Need   int64 // сколько места на диске ещё нужно: без докачанного, с учётом распаковки
}

func aiSteps(c Catalog, in Installed, ids []string) ([]aiStep, error) {
	var steps []aiStep
	kinds := map[string]bool{}
	for _, id := range ids {
		m, ok := c.model(id)
		if !ok {
			return nil, errT("ai.unknownModel", id)
		}
		switch m.Kind {
		case "image":
			kinds["sd"] = true
		case "llm":
			kinds["llm"] = true
		}
	}
	for _, k := range []string{"sd", "llm"} {
		if !kinds[k] {
			continue
		}
		if e, ok := aiEngineFor(c, k); ok && !aiEngineReady(e) {
			var size int64
			for _, f := range e.Files {
				size += f.Size
			}
			steps = append(steps, aiStep{ID: "engine:" + k, Engine: &e, Size: size, Need: aiEngineNeed(e)})
		}
	}
	for _, id := range ids {
		plan, err := aiPlan(c, in, id)
		if err != nil {
			return nil, err
		}
		if len(plan) > 0 {
			steps = append(steps, aiStep{ID: id, Size: aiPlanSize(plan, in), Need: aiPlanNeed(plan, in)})
		}
	}
	return steps, nil
}

// aiStepsNeed: место на диске под набор шагов
func aiStepsNeed(steps []aiStep) int64 {
	var n int64
	for _, s := range steps {
		n += s.Need
	}
	return n
}

func aiStepsSize(steps []aiStep) int64 {
	var n int64
	for _, s := range steps {
		n += s.Size
	}
	return n
}

// start запускает установку в фоне. Уже идёт — ошибка.
func (j *aiJob) start(ids []string) error {
	c, err := aiCatalog()
	if err != nil {
		return err
	}
	if err := aiEnsure(); err != nil {
		return err
	}
	steps, err := aiSteps(c, aiLoadInstalled(), ids)
	if err != nil {
		return err
	}
	total := aiStepsSize(steps)
	if free := diskFreeAt(aiRoot()); free >= 0 && free < aiStepsNeed(steps) {
		return errT("hw.diskNo")
	}
	j.mu.Lock()
	if j.st.Active {
		j.mu.Unlock()
		return errT("ai.jobBusy")
	}
	ctx, cancel := context.WithCancel(context.Background())
	j.cancel = cancel
	j.st = aiJobState{Active: true, Total: total}
	for _, s := range steps {
		j.st.Items = append(j.st.Items, s.ID)
	}
	j.t0, j.d0 = time.Now(), 0
	j.mu.Unlock()
	go j.run(ctx, c, steps, total)
	return nil
}

func (j *aiJob) run(ctx context.Context, c Catalog, steps []aiStep, total int64) {
	var base int64
	var err error
	for _, s := range steps {
		cb := func(done, _ int64) { j.progress(s.ID, base+done, total) }
		if s.Engine != nil {
			// запущенный exe Windows не даст подменить папку движка
			if s.Engine.Kind == "sd" && genEng != nil {
				genEng.Stop()
			}
			if s.Engine.Kind == "llm" {
				llmSrv.Stop()
			}
			err = aiInstallEngine(ctx, *s.Engine, cb)
		} else {
			err = aiInstallModel(ctx, c, s.ID, cb)
		}
		if err != nil {
			break
		}
		base += s.Size
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	j.st.Active, j.st.Cur, j.cancel = false, "", nil
	switch {
	case ctx.Err() != nil:
		j.st.Err = "" // отменил сам человек: не ошибка
	case err != nil:
		j.st.Err = err.Error()
	default:
		j.st.OK, j.st.Done = true, total
	}
}

func (j *aiJob) stop() {
	j.mu.Lock()
	cancel := j.cancel
	j.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// ---- для страницы ----

// aiModelRow: строка менеджера моделей
type aiModelRow struct {
	ID         string  `json:"id"`
	Kind       string  `json:"kind"`
	Name       string  `json:"name"`
	Purpose    string  `json:"purpose"`
	License    string  `json:"license"`
	LicenseURL string  `json:"licenseUrl"`
	Commercial bool    `json:"commercial"`
	VRAM       float64 `json:"vram"`
	Size       int64   `json:"size"` // на диске (стоит) или сколько скачать вместе с движком (не стоит)
	Installed  bool    `json:"installed"`
	Source     string  `json:"source"` // catalog, user
	Fits       bool    `json:"fits"`   // видеопамяти хватает
}

// aiModelRows: каталог (без служебных TAE: они ставятся сами) и свои модели
func aiModelRows(c Catalog, in Installed) []aiModelRow {
	vram := hwVRAMTotal()
	rows := []aiModelRow{}
	for _, m := range c.Models {
		if m.Kind == "tae" {
			continue
		}
		r := aiModelRow{ID: m.ID, Kind: m.Kind, Name: m.Name.String(), Purpose: m.Purpose.String(), License: m.License.String(),
			LicenseURL: m.LicenseURL, Commercial: m.Commercial, VRAM: m.VRAM, Source: "catalog", Fits: vram < 0 || vram >= m.VRAM*1024-512}
		if im, ok := in.model(m.ID); ok {
			r.Installed = true
			for _, f := range im.Files {
				r.Size += f.Size
			}
		} else if steps, err := aiSteps(c, in, []string{m.ID}); err == nil {
			r.Size = aiStepsSize(steps)
		}
		rows = append(rows, r)
	}
	for _, im := range in.Models {
		if im.Source != "user" || im.Kind == "tae" {
			continue
		}
		r := aiModelRow{ID: im.ID, Kind: im.Kind, Name: im.Name, Installed: true, Source: "user", Fits: true}
		if r.Name == "" {
			r.Name = im.ID
		}
		for _, f := range im.Files {
			r.Size += f.Size
		}
		rows = append(rows, r)
	}
	return rows
}

// aiRemove: удалить модель; движки перед этим останавливаются (файл в работе Windows не удалит)
func aiRemove(id string) error {
	if aiInstaller.state().Active {
		return errT("ai.jobBusy")
	}
	if genEng != nil {
		genEng.Stop()
	}
	llmSrv.Stop()
	if err := aiRemoveModel(id); err != nil {
		return err
	}
	// TAE и прочее, что ставилось вместе и больше никому не нужно
	in := aiLoadInstalled()
	for _, m := range in.Models {
		if m.Kind != "tae" {
			continue
		}
		used := slices.ContainsFunc(in.Models, func(x InstModel) bool { return x.Kind == "image" && x.Arch == m.Arch })
		if !used {
			aiRemoveModel(m.ID)
		}
	}
	return nil
}

// genRetarget: папку ИИ сменили — движок картинок должен смотреть в новую
func genRetarget() {
	llmSrv.Stop()
	if genEng == nil {
		return
	}
	genEng.Stop()
	fresh := newSDServer()
	genEng.mu.Lock()
	genEng.exe, genEng.models, genEng.logPath = fresh.exe, fresh.models, fresh.logPath
	genEng.mu.Unlock()
}

func (s *Server) aiRoutes(mux *http.ServeMux) {
	setup := func() map[string]any {
		c, _ := aiCatalog()
		in := aiLoadInstalled()
		first := []string{aiFirstImage}
		if _, ok := c.model(aiFirstLLM); ok {
			first = append(first, aiFirstLLM)
		}
		stepsAll, _ := aiSteps(c, in, first)
		stepsImg, _ := aiSteps(c, in, first[:1])
		root := aiRoot()
		return map[string]any{
			"root": root, "chosen": aiRootChosen(), "default": aiDefaultRoot(),
			"check": hwCheckNow(root, aiStepsNeed(stepsAll)), "checkImg": hwCheckNow(root, aiStepsNeed(stepsImg)),
			"need":   map[string]int64{"all": aiStepsSize(stepsAll), "image": aiStepsSize(stepsImg)},
			"first":  first,
			"models": aiModelRows(c, in), "job": aiInstaller.state(),
			"used": dirSize(aiModelsDir()) + dirSize(filepath.Join(root, "engines")),
		}
	}
	mux.HandleFunc("/api/ai-setup", s.api(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, setup())
	}))

	// папка для данных ИИ: path — выбранная (пусто — открыть окно выбора)
	mux.HandleFunc("/api/ai-root", s.api(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Path string `json:"path"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if aiInstaller.state().Active {
			writeJSON(w, map[string]any{"error": tr("ai.jobBusy")})
			return
		}
		if body.Path == "" {
			dir, err := pickFolder()
			if err != nil {
				writeJSON(w, map[string]any{"error": err.Error()})
				return
			}
			if dir == "" {
				writeJSON(w, setup())
				return
			}
			body.Path = dir
		}
		if err := aiSetRoot(body.Path); err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		genRetarget()
		writeJSON(w, setup())
	}))

	mux.HandleFunc("/api/ai-install", s.api(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Models []string `json:"models"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if !aiRootChosen() { // поставил, не меняя папку: запоминаем, чтобы окно первого запуска больше не выходило
			if err := aiSetRoot(aiRoot()); err != nil {
				writeJSON(w, map[string]any{"error": err.Error()})
				return
			}
		}
		if err := aiInstaller.start(body.Models); err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, setup())
	}))

	mux.HandleFunc("/api/ai-cancel", s.api(func(w http.ResponseWriter, r *http.Request) {
		aiInstaller.stop()
		writeJSON(w, map[string]any{"ok": true})
	}))

	mux.HandleFunc("/api/ai-remove", s.api(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			ID string `json:"id"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if err := aiRemove(body.ID); err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, setup())
	}))

	// лицензия модели в браузере: адрес только из каталога, страница передаёт id
	mux.HandleFunc("/api/ai-license", s.api(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			ID string `json:"id"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		c, _ := aiCatalog()
		m, ok := c.model(body.ID)
		if !ok || !strings.HasPrefix(m.LicenseURL, "https://") {
			writeJSON(w, map[string]any{"error": tr("err.badRequest")})
			return
		}
		cmd := exec.Command("rundll32", "url.dll,FileProtocolHandler", m.LicenseURL)
		hide(cmd)
		cmd.Start()
		writeJSON(w, map[string]any{"ok": true})
	}))

	mux.HandleFunc("/api/gen-enhance", s.api(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Prompt string `json:"prompt"`
			Preset string `json:"preset"`
			Count  int    `json:"count"` // сколько картинок: у каждой свой промт
		}
		json.NewDecoder(r.Body).Decode(&body)
		p, err := llmEnhance(r.Context(), body.Prompt, body.Preset, body.Count)
		if err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, map[string]any{"prompt": p[0], "prompts": p})
	}))
}
