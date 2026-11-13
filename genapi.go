package main

// Ручки вкладки генератора картинок: что установлено (gen-info), поставить запрос (gen-add), состояние очереди
// и железа (gen-state, страница спрашивает раз в 0,7 с, пока вкладка открыта), отмена и уборка списка.
// Кадр предпросмотра отдаётся отдельно (/gen-frame, токен в адресе, как у /media), чтобы его можно было
// поставить прямо в <img>: PNG 1024×1024 весит около 1,4 МБ, в JSON состояния ему не место.
// Готовые картинки показываются через /media.

import (
	"context"
	"encoding/json"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	genOnce   sync.Once
	genQ      *genQueue
	genEng    *sdServer
	genCancel context.CancelFunc
)

// genQueueGet: очередь создаётся при первом обращении вкладки, а не при запуске программы
func genQueueGet() *genQueue {
	genOnce.Do(func() {
		genEng = newSDServer()
		resolve := func(id string) (ModelSet, error) { return aiModelSet(aiLoadInstalled(), id, genLowVRAM()) }
		genQ = newGenQueue(genEng, resolve, genSave(aiGalleryDir), aiGPU)
		ctx, cancel := context.WithCancel(context.Background())
		genCancel = cancel
		go genQ.Run(ctx)
	})
	return genQ
}

// genShutdown: при выходе из программы. Движок и так в объекте задания, но выгрузить его сразу — вежливо.
func genShutdown() {
	llmSrv.Stop()
	if genCancel != nil {
		genCancel()
		genEng.Stop()
	}
}

// genLowVRAM: меньше 10 ГБ видеопамяти — модель частично в обычной памяти и VAE по кусочкам (замеры сессии 1:
// SDXL на пике берёт 10–11 ГБ). Неизвестно — считаем, что памяти хватает.
func genLowVRAM() bool {
	t := hwVRAMTotal()
	return t > 0 && t < 10*1024
}

type genModelInfo struct {
	ID     string      `json:"id"`
	Name   string      `json:"name"`
	Arch   string      `json:"arch"`
	Def    GenDefaults `json:"def"`
	Native bool        `json:"tae"` // есть TAE: кадры сборки будут чёткими, иначе мутные (proj)
}

// genModels: установленные модели картинок с настройками по умолчанию
func genModels() []genModelInfo {
	in := aiLoadInstalled()
	cat, _ := aiCatalog()
	out := []genModelInfo{}
	for _, m := range in.Models {
		if m.Kind != "image" {
			continue
		}
		name := m.Name
		def := genArchDefaults(m.Arch)
		if cm, ok := cat.model(m.ID); ok {
			name = cm.Name.String()
			if cm.Defaults != nil {
				def = *cm.Defaults
			}
		}
		if m.Defaults != nil {
			def = *m.Defaults
		}
		if name == "" {
			name = m.ID
		}
		set, err := aiModelSet(in, m.ID, false)
		out = append(out, genModelInfo{ID: m.ID, Name: name, Arch: m.Arch, Def: def, Native: err == nil && set.TAE != ""})
	}
	return out
}

func genModelByID(id string) (genModelInfo, bool) {
	list := genModels()
	for _, m := range list {
		if m.ID == id {
			return m, true
		}
	}
	if id == "" && len(list) > 0 {
		return list[0], true
	}
	return genModelInfo{}, false
}

// genAddReq: запрос со страницы. Нули — «как задумано моделью».
type genAddReq struct {
	Model    string  `json:"model"`
	Prompt   string  `json:"prompt"`
	Negative string  `json:"negative"`
	Preset   string  `json:"preset"`
	Ratio    string  `json:"ratio"`
	Count    int     `json:"count"`
	Seed     int64   `json:"seed"` // -1 — случайное
	Steps    int     `json:"steps"`
	CFG      float64 `json:"cfg"`
	Preview  bool    `json:"preview"`            // показывать сборку картинки
	Init     string  `json:"init,omitempty"`     // «Вариации»: картинка из галереи, по которой рисовать
	Expanded string  `json:"expanded,omitempty"` // промт от помощника (пишется при «Создать», правится под картинкой); пусто — модель получает запрос как есть
}

// genVarStrength: насколько вариация уходит от исходной картинки (0 — копия, 1 — с нуля). 0,5 сохраняет
// композицию и цвета, но меняет детали.
const genVarStrength = 0.5

// genBuild: из запроса страницы — параметры движка
func genBuild(r genAddReq, m genModelInfo) GenParams {
	src := r.Prompt
	if e := strings.TrimSpace(r.Expanded); e != "" {
		src = e
	}
	prompt, neg := genPreset(r.Preset).apply(src, r.Negative)
	if m.Def.Negative != "" {
		neg += ", " + m.Def.Negative
	}
	p := GenParams{Prompt: prompt, Negative: neg, Steps: m.Def.Steps, CFG: m.Def.CFG, Sampler: m.Def.Sampler, Scheduler: m.Def.Scheduler, Seed: r.Seed}
	if r.Steps > 0 {
		p.Steps = min(r.Steps, 150)
	}
	if r.CFG > 0 {
		p.CFG = min(r.CFG, 30)
	}
	p.Width, p.Height = genSize(m.Def.Width, m.Def.Height, r.Ratio)
	p.Preview = "none"
	if r.Preview {
		p.Preview, p.PreviewEvery = "proj", genPreviewEvery(p.Steps)
		if m.Native {
			p.Preview = "tae"
		}
	}
	return p
}

func (s *Server) genRoutes(mux *http.ServeMux) {
	s.genGalleryRoutes(mux)
	mux.HandleFunc("/api/gen-info", s.api(func(w http.ResponseWriter, r *http.Request) {
		engine := fileExists(newSDServer().exe)
		models := genModels()
		presets := []string{}
		for _, p := range genPresets {
			presets = append(presets, p.ID)
		}
		writeJSON(w, map[string]any{
			"show": true, "ready": engine && len(models) > 0, "llm": llmReady(), "setup": !aiRootChosen() && !engine, "engine": engine, "models": models, "presets": presets,
			"ratios": genRatios, "gallery": filepath.Dir(aiGalleryDir(time.Now())),
		})
	}))

	mux.HandleFunc("/api/gen-add", s.api(func(w http.ResponseWriter, r *http.Request) {
		var body genAddReq
		json.NewDecoder(r.Body).Decode(&body)
		body.Prompt = strings.TrimSpace(body.Prompt)
		if body.Prompt == "" {
			writeJSON(w, map[string]any{"error": tr("ai.noPrompt")})
			return
		}
		m, ok := genModelByID(body.Model)
		if !ok {
			writeJSON(w, map[string]any{"error": tr("ai.noModel")})
			return
		}
		p := genBuild(body, m)
		if body.Init != "" {
			png, iw, ih, err := genReadInit(body.Init)
			if err != nil {
				writeJSON(w, map[string]any{"error": err.Error()})
				return
			}
			p.Init, p.Strength, p.Width, p.Height = png, genVarStrength, iw, ih
		}
		id := genQueueGet().Add(m.ID, p, body.Count, body)
		writeJSON(w, map[string]any{"id": id, "width": p.Width, "height": p.Height})
	}))

	mux.HandleFunc("/api/gen-state", s.api(func(w http.ResponseWriter, r *http.Request) {
		q := genQueueGet()
		writeJSON(w, map[string]any{"tasks": q.State(), "hw": hwMonitor.Get(), "model": q.LoadedModel(), "gpu": aiGPU.holder()})
	}))

	mux.HandleFunc("/api/gen-cancel", s.api(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			ID int `json:"id"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		genQueueGet().Cancel(body.ID)
		writeJSON(w, map[string]any{"ok": true})
	}))

	mux.HandleFunc("/api/gen-clear", s.api(func(w http.ResponseWriter, r *http.Request) {
		genQueueGet().Clear()
		writeJSON(w, map[string]any{"ok": true})
	}))

	// картинки-примеры стилей (web/styles/<id>.jpg); отдаём только для известных стилей
	mux.HandleFunc("/styles/", func(w http.ResponseWriter, r *http.Request) {
		id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/styles/"), ".jpg")
		if r.Host != s.host || genPreset(id).ID != id {
			http.NotFound(w, r)
			return
		}
		b, err := webFS.ReadFile("web/styles/" + id + ".jpg")
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "image/jpeg")
		w.Header().Set("Cache-Control", "max-age=86400")
		w.Write(b)
	})

	mux.HandleFunc("/gen-frame", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if r.Host != s.host || q.Get("t") != s.token {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		id, _ := strconv.Atoi(q.Get("id"))
		png, _ := genQueueGet().Preview(id)
		if png == nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Cache-Control", "no-store")
		w.Write(png)
	})
}
