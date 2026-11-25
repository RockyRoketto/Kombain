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
		resolve := func(id string) (ModelSet, error) {
			in := aiLoadInstalled()
			m, _ := in.model(id)
			return aiModelSet(in, id, genLowVRAMFor(hwVRAMTotal(), m))
		}
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
	bgSrv.Stop()
	if genCancel != nil {
		genCancel()
		genEng.Stop()
	}
}

// genLowVRAMFor: меньше 10 ГБ видеопамяти — модель частично в обычной памяти и VAE по кусочкам (замеры сессии 1:
// SDXL на пике берёт 10–11 ГБ). Тяжёлая модель (Qwen-Image около 18 ГБ) целиком не влезет и в 16 ГБ: если её файлы
// вместе с запасом 2 ГБ на расчёт больше видеопамяти — тоже, движок гоняет её по частям. Неизвестно — считаем, что хватает.
func genLowVRAMFor(vramMB float64, m InstModel) bool {
	if vramMB <= 0 {
		return false
	}
	if vramMB < 10*1024 {
		return true
	}
	var size int64
	for _, f := range m.Files {
		size += f.Size
	}
	return float64(size)/(1<<20)+2048 > vramMB
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
	Model       string   `json:"model"`
	Prompt      string   `json:"prompt"`
	Negative    string   `json:"negative"`
	Preset      string   `json:"preset"`
	Ratio       string   `json:"ratio"`
	Count       int      `json:"count"`
	Seed        int64    `json:"seed"` // -1 — случайное
	Steps       int      `json:"steps"`
	CFG         float64  `json:"cfg"`
	Preview     bool     `json:"preview"`               // показывать сборку картинки
	Init        string   `json:"init,omitempty"`        // «Вариации»: картинка из галереи, по которой рисовать
	Inpaint     bool     `json:"inpaint,omitempty"`     // перерисована часть Init (маска кистью, geninpaint.go)
	InpStrength float64  `json:"inpStrength,omitempty"` // «насколько менять» у кисти (0,3–1); 0 — genInpaintStrength
	Outpaint    []int    `json:"outpaint,omitempty"`    // Init дорисована за краями: точек слева, сверху, справа, снизу (genoutpaint.go)
	OutNew      bool     `json:"outNew,omitempty"`      // дорисовка: промт — что нарисовать в новой полосе, а не вся сцена (genOutLead)
	Expanded    string   `json:"expanded,omitempty"`    // промт от помощника (пишется при «Создать», правится под картинкой); пусто — модель получает запрос как есть
	Variants    []string `json:"variants,omitempty"`    // при 2–4 картинках у каждой свой промт от помощника; Expanded — первый из них
	Refs        []GenRef `json:"refs,omitempty"`        // референсы (genref.go): «Основа» рисуется поверх, остальное уже в промте помощника
}

// genVariant: промт и запрос i-й картинки задачи. Готовая картинка запоминает только свой промт.
func genVariant(t GenTask, i int) (GenParams, genAddReq) {
	p, r := t.Params, t.Req
	p.Seed += int64(i)
	if i < len(t.Prompts) {
		p.Prompt = t.Prompts[i]
	}
	if i < len(r.Variants) && strings.TrimSpace(r.Variants[i]) != "" {
		r.Expanded = r.Variants[i]
	}
	r.Variants = nil
	return p, r
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
	// негатив при CFG 1 не работает: про руки и лица говорим позитивным хвостом (не для «предмет без людей»)
	if p.CFG <= 1 && !genPreset(r.Preset).Object {
		p.Prompt = genWithAnatomy(p.Prompt)
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
	s.genRefRoutes(mux)
	s.bgRoutes(mux)
	s.bgFileRoutes(mux)
	s.cutRoutes(mux)
	s.imgBatchRoutes(mux)
	s.upRoutes(mux)
	s.bmkRoutes(mux)
	mux.HandleFunc("/api/gen-info", s.api(func(w http.ResponseWriter, r *http.Request) {
		engine := fileExists(newSDServer().exe)
		models := genModels()
		presets := []string{}
		for _, p := range genPresets {
			presets = append(presets, p.ID)
		}
		writeJSON(w, map[string]any{
			"show": true, "ready": engine && len(models) > 0, "llm": llmReady(), "eyes": llmEyesReady(), "setup": !aiRootChosen() && !engine, "engine": engine, "models": models, "presets": presets,
			"ratios": genRatios, "gallery": filepath.Dir(aiGalleryDir(time.Now())),
		})
	}))

	mux.HandleFunc("/api/gen-add", s.api(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			genAddReq
			Mask string `json:"mask,omitempty"` // перерисовать часть Init: PNG data URL, закрашенное — перерисовать
		}
		json.NewDecoder(r.Body).Decode(&in)
		body := in.genAddReq
		if body.Inpaint != (in.Mask != "") || body.Inpaint && body.Init == "" { // повтор без маски не должен стать вариацией
			writeJSON(w, map[string]any{"error": tr("inp.bad")})
			return
		}
		if len(body.Outpaint) > 0 && (body.Inpaint || body.Init == "") {
			writeJSON(w, map[string]any{"error": tr("out.bad")})
			return
		}
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
		if len(body.Variants) > 0 {
			body.Expanded = body.Variants[0]
		}
		body.Refs = genRefsClean(body.Refs)
		kleinOut := len(body.Outpaint) > 0 && m.Arch == "flux2"
		if kleinOut { // указание дорисовки ставится ниже, перед промтом со стилем; прежнее из запроса убираем
			body.Prompt, body.Expanded = genOutScene(body.Prompt), genOutScene(body.Expanded)
		}
		p := genBuild(body, m)
		if kleinOut {
			p.Prompt = genOutLead(body.OutNew) + p.Prompt
		}
		var prompts []string
		for _, v := range body.Variants {
			one := body
			one.Expanded = v
			prompts = append(prompts, genBuild(one, m).Prompt)
		}
		if body.Init != "" {
			png, iw, ih, err := genReadInit(body.Init)
			if err != nil {
				writeJSON(w, map[string]any{"error": err.Error()})
				return
			}
			p.Init, p.Strength, p.Width, p.Height = png, genVarStrength, iw, ih
			if body.Inpaint {
				mask, err := genMaskData(in.Mask)
				var patch *genPatch
				if err == nil {
					patch, p.Init, p.Mask, p.Width, p.Height, err = genInpaintPrep(png, mask, m.Def.Width, m.Def.Height)
				}
				if err != nil {
					writeJSON(w, map[string]any{"error": err.Error()})
					return
				}
				p.Patch, p.Strength = patch, genInpStrength(body.InpStrength)
			} else if len(body.Outpaint) > 0 {
				klein := kleinOut
				patch, init, msk, w2, h2, err := genOutpaintPrep(png, body.Outpaint, m.Def.Width, m.Def.Height, klein)
				if err != nil {
					writeJSON(w, map[string]any{"error": err.Error()})
					return
				}
				p.Patch, p.Init, p.Mask, p.Width, p.Height, p.Strength = patch, init, msk, w2, h2, genOutpaintStrength
				if klein {
					// klein не inpaint-модель: по одной маске новая полоса выходит своей сценой. Весь холст референсом
					// (с заливкой на месте полос) показывает ей картинку целиком и на своих местах: руки и предметы у края
					// продолжаются. Исходник без полос она сдвигала и увеличивала, а по вырезке вокруг полосы (видно
					// только низ пальто) рисовала героя второй раз (ручная проверка 2026-11-16).
					p.Refs = [][]byte{init}
					genOutAlphaRef(patch, body.Outpaint)
				}
			}
		} else if b, ok := genRefBaseOf(body.Refs); ok {
			png, err := genRefBase(b.ID, p.Width, p.Height)
			if err != nil {
				writeJSON(w, map[string]any{"error": err.Error()})
				return
			}
			p.Init, p.Strength = png, genRefStrength(b.Weight)
		}
		if m.Arch == "flux2" && len(body.Outpaint) == 0 {
			imgs, note, err := genRefChars(body.Refs)
			if err != nil {
				writeJSON(w, map[string]any{"error": err.Error()})
				return
			}
			if len(imgs) > 0 {
				// указание первым: в хвосте после стиля («professional photograph…») klein его почти не слушала
				// (замер 2026-11-20: в хвосте чужое лицо и рукава, в начале то же лицо и жилет)
				p.Refs, p.Prompt = imgs, llmJoin(note, p.Prompt)
				for i := range prompts {
					prompts[i] = llmJoin(note, prompts[i])
				}
			}
		}
		id := genQueueGet().Add(m.ID, p, body.Count, body, prompts...)
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
