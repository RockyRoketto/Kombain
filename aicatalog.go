package main

// Каталог ИИ: что можно поставить (ai_catalog.json в репозитории, вшит в программу) и что уже стоит (catalog.json в папке ИИ).
// Каждый файл качается с проверкой размера и sha256 и встаёт на место только проверенным. Один файл может быть нужен
// нескольким моделям (общий текстовый энкодер, VAE): он качается один раз и удаляется, когда не нужен никому.
// Свои модели продвинутых пользователей опознаются по заголовку safetensors (safetensorsGuess).

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
)

//go:embed ai_catalog.json
var aiCatalogJSON []byte

// CatText: текст на двух языках
type CatText struct {
	RU string `json:"ru"`
	EN string `json:"en"`
}

func (t CatText) String() string {
	if currentLang() == langEN && t.EN != "" {
		return t.EN
	}
	return t.RU
}

// CatFile: один файл. Role говорит движку, чем этот файл служит (см. aiRoles).
type CatFile struct {
	Name   string `json:"name"`          // имя на диске
	Cat    string `json:"cat,omitempty"` // папка models\<cat>; у движков пусто
	Role   string `json:"role,omitempty"`
	URL    string `json:"url"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

// aiRoles: роль файла → поле ModelSet (aiModelSet). mmproj — проектор картинок у LLM.
var aiRoles = []string{"checkpoint", "diffusion", "vae", "clip_l", "clip_g", "t5xxl", "llm", "tae", "lora", "upscale", "mmproj", "bgremove", "controlnet"}

// GenDefaults: настройки, с которыми модель рисует лучше всего
type GenDefaults struct {
	Steps     int     `json:"steps"`
	CFG       float64 `json:"cfg"`
	Sampler   string  `json:"sampler,omitempty"`
	Scheduler string  `json:"scheduler,omitempty"`
	Width     int     `json:"width"` // родное разрешение
	Height    int     `json:"height"`
	Negative  string  `json:"negative,omitempty"`
}

type CatModel struct {
	ID         string       `json:"id"`
	Kind       string       `json:"kind"` // см. aiKinds
	Arch       string       `json:"arch"` // sd15, sdxl, flux, zimage, gemma3…: с чем совместимы LoRA и TAE
	Name       CatText      `json:"name"`
	Purpose    CatText      `json:"purpose"`
	License    CatText      `json:"license"` // простыми словами
	LicenseURL string       `json:"licenseUrl"`
	Commercial bool         `json:"commercial"` // можно ли продавать результат
	Preview    string       `json:"preview,omitempty"`
	VRAM       float64      `json:"vram"` // ГБ видеопамяти, меньше которых не стоит и пробовать
	Files      []CatFile    `json:"files"`
	Defaults   *GenDefaults `json:"defaults,omitempty"`
	Needs      []string     `json:"needs,omitempty"` // id того, что ставится вместе (TAE для предпросмотра и т. п.)
}

var aiKinds = []string{"image", "lora", "tae", "upscale", "llm", "bgremove", "controlnet"}

// CatEngine: сборка движка под один вид видеокарт. Files — архивы zip, из них берутся exe и dll.
type CatEngine struct {
	ID     string    `json:"id"`
	Kind   string    `json:"kind"`   // sd, llm
	Flavor string    `json:"flavor"` // cuda, vulkan, cpu
	Tag    string    `json:"tag"`    // версия сборки: другая — пора обновить
	Exe    string    `json:"exe"`    // главный exe, без него архив не годится
	Files  []CatFile `json:"files"`
}

type Catalog struct {
	Version int         `json:"version"`
	Engines []CatEngine `json:"engines"`
	Models  []CatModel  `json:"models"`
}

func (c Catalog) model(id string) (CatModel, bool) {
	for _, m := range c.Models {
		if m.ID == id {
			return m, true
		}
	}
	return CatModel{}, false
}

// aiCatalog: каталог, вшитый в программу
func aiCatalog() (Catalog, error) { return parseCatalog(aiCatalogJSON) }

var (
	reSHA256 = regexp.MustCompile(`^[0-9a-f]{64}$`)
	reID     = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*$`)
)

func parseCatalog(b []byte) (Catalog, error) {
	var c Catalog
	if err := json.Unmarshal(b, &c); err != nil {
		return c, err
	}
	return c, c.validate()
}

// validate ловит ошибки в каталоге до того, как они дойдут до пользователя: проверяется в тестах
func (c Catalog) validate() error {
	if c.Version != 1 {
		return fmt.Errorf("catalog version %d", c.Version)
	}
	ids := map[string]bool{}
	for _, e := range c.Engines {
		if !reID.MatchString(e.ID) || ids[e.ID] {
			return fmt.Errorf("engine id %q", e.ID)
		}
		ids[e.ID] = true
		if e.Kind != "sd" && e.Kind != "llm" || !slices.Contains([]string{"cuda", "vulkan", "cpu"}, e.Flavor) || e.Tag == "" || e.Exe == "" || len(e.Files) == 0 {
			return fmt.Errorf("engine %s: kind, flavor, tag, exe or files", e.ID)
		}
		for _, f := range e.Files {
			if err := f.check(false); err != nil {
				return fmt.Errorf("engine %s: %w", e.ID, err)
			}
		}
	}
	for _, m := range c.Models {
		if !reID.MatchString(m.ID) || ids[m.ID] {
			return fmt.Errorf("model id %q", m.ID)
		}
		ids[m.ID] = true
		if !slices.Contains(aiKinds, m.Kind) || m.Arch == "" || m.Name.RU == "" || m.Name.EN == "" || m.License.RU == "" || m.License.EN == "" || len(m.Files) == 0 {
			return fmt.Errorf("model %s: kind, arch, name, license or files", m.ID)
		}
		for _, f := range m.Files {
			if err := f.check(true); err != nil {
				return fmt.Errorf("model %s: %w", m.ID, err)
			}
		}
		if m.Kind == "image" && !slices.ContainsFunc(m.Files, func(f CatFile) bool { return f.Role == "checkpoint" || f.Role == "diffusion" }) {
			return fmt.Errorf("model %s: no checkpoint or diffusion file", m.ID)
		}
	}
	for _, m := range c.Models {
		for _, n := range m.Needs {
			if _, ok := c.model(n); !ok || n == m.ID {
				return fmt.Errorf("model %s needs unknown %q", m.ID, n)
			}
		}
	}
	return nil
}

func (f CatFile) check(model bool) error {
	if f.Name == "" || f.Name != filepath.Base(f.Name) || f.Name != path.Base(f.Name) || strings.HasPrefix(f.Name, ".") {
		return fmt.Errorf("file name %q", f.Name)
	}
	if u, err := url.Parse(f.URL); err != nil || u.Scheme != "https" || u.Host == "" {
		return fmt.Errorf("file %s: url must be https", f.Name)
	}
	if f.Size <= 0 || !reSHA256.MatchString(f.SHA256) {
		return fmt.Errorf("file %s: size or sha256", f.Name)
	}
	if model && (!slices.Contains(aiModelCats, f.Cat) || !slices.Contains(aiRoles, f.Role)) {
		return fmt.Errorf("file %s: cat %q or role %q", f.Name, f.Cat, f.Role)
	}
	return nil
}

// ---- установленное ----

// InstFile: путь внутри models\ через «/»
type InstFile struct {
	Path   string `json:"path"`
	Role   string `json:"role"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256,omitempty"` // у своих моделей не считаем: это минуты на большом файле
}

type InstModel struct {
	ID       string       `json:"id"`
	Kind     string       `json:"kind"`
	Arch     string       `json:"arch"`
	Name     string       `json:"name,omitempty"` // только у своих; у моделей каталога имя берётся из каталога на нужном языке
	Source   string       `json:"source"`         // catalog, user
	Files    []InstFile   `json:"files"`
	Defaults *GenDefaults `json:"defaults,omitempty"`
	Added    time.Time    `json:"added"`
}

type InstEngine struct {
	Kind   string `json:"kind"`
	Flavor string `json:"flavor"`
	Tag    string `json:"tag"`
}

type Installed struct {
	Version int          `json:"version"`
	Models  []InstModel  `json:"models"`
	Engines []InstEngine `json:"engines"`
}

func (in Installed) model(id string) (InstModel, bool) {
	for _, m := range in.Models {
		if m.ID == id {
			return m, true
		}
	}
	return InstModel{}, false
}

// usedBy: сколько установленных моделей (кроме skip) держат файл
func (in Installed) usedBy(p, skip string) int {
	n := 0
	for _, m := range in.Models {
		if m.ID != skip && slices.ContainsFunc(m.Files, func(f InstFile) bool { return f.Path == p }) {
			n++
		}
	}
	return n
}

var instMu sync.Mutex // чтение, правка и запись catalog.json — одним куском

func aiLoadInstalled() Installed {
	in := Installed{Version: 1}
	if b, err := os.ReadFile(aiCatalogPath()); err == nil {
		json.Unmarshal(b, &in)
	}
	in.Version = 1
	return in
}

func aiSaveInstalled(in Installed) error {
	b, err := json.MarshalIndent(in, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(aiCatalogPath(), b)
}

// aiUpdateInstalled: прочитать, поправить, записать, не пуская других между этими шагами
func aiUpdateInstalled(fn func(*Installed) error) error {
	instMu.Lock()
	defer instMu.Unlock()
	in := aiLoadInstalled()
	if err := fn(&in); err != nil {
		return err
	}
	return aiSaveInstalled(in)
}

// aiFetch качает файл каталога, сверяет размер и сумму и только потом ставит на место
func aiFetch(ctx context.Context, f CatFile, dst string, progress func(done int64)) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	part := dst + ".part"
	h := sha256.New()
	n, err := downloadResume(ctx, f.URL, part, f.Size, f.Size+1, h, func(pct float64) { progress(int64(pct / 100 * float64(f.Size))) })
	if err != nil {
		return err
	}
	if n != f.Size || hex.EncodeToString(h.Sum(nil)) != f.SHA256 {
		os.Remove(part)
		return errT("ai.badFile", f.Name)
	}
	os.Remove(dst)
	return os.Rename(part, dst)
}

// aiPlan: модель и всё, что ей нужно, в порядке установки (сначала зависимости). Уже стоящее не входит.
func aiPlan(c Catalog, in Installed, id string) ([]CatModel, error) {
	var out []CatModel
	seen := map[string]bool{}
	var add func(id string) error
	add = func(id string) error {
		if seen[id] {
			return nil
		}
		seen[id] = true
		m, ok := c.model(id)
		if !ok {
			return errT("ai.unknownModel", id)
		}
		for _, n := range m.Needs {
			if err := add(n); err != nil {
				return err
			}
		}
		if _, ok := in.model(id); !ok {
			out = append(out, m)
		}
		return nil
	}
	return out, add(id)
}

// aiPlanSize: сколько придётся скачать. Файл, который уже лежит у другой модели, второй раз не качается.
func aiPlanSize(plan []CatModel, in Installed) int64 {
	var total int64
	seen := map[string]bool{}
	for _, m := range plan {
		for _, f := range m.Files {
			p := f.Cat + "/" + f.Name
			if !seen[p] && in.usedBy(p, "") == 0 {
				total += f.Size
			}
			seen[p] = true
		}
	}
	return total
}

// aiPartLeft: сколько уже лежит в недокачанном .part файла f (докачка продолжит с этого места)
func aiPartLeft(f CatFile, dst string) int64 {
	if st, err := os.Stat(dst + ".part"); err == nil && st.Size() < f.Size {
		return st.Size()
	}
	return 0
}

// aiPlanNeed: сколько места на диске ещё понадобится под модели плана: размер минус уже докачанное
func aiPlanNeed(plan []CatModel, in Installed) int64 {
	var total int64
	seen := map[string]bool{}
	for _, m := range plan {
		for _, f := range m.Files {
			p := f.Cat + "/" + f.Name
			if !seen[p] && in.usedBy(p, "") == 0 {
				total += f.Size - aiPartLeft(f, filepath.Join(aiModelsDir(), filepath.FromSlash(p)))
			}
			seen[p] = true
		}
	}
	return total
}

// aiEngineNeed: место под установку движка. Архив и распакованное лежат рядом, пока архив не удалён,
// поэтому к докачиваемому добавляем распаковку (примерно размер архивов).
func aiEngineNeed(e CatEngine) int64 {
	var total, left int64
	dl := aiEngineDir(e.Kind) + ".dl"
	for _, f := range e.Files {
		total += f.Size
		left += aiPartLeft(f, filepath.Join(dl, f.Name))
	}
	return total - left + total
}

// aiInstallModel ставит модель из каталога вместе с зависимостями. progress получает скачанное и всего, в байтах.
func aiInstallModel(ctx context.Context, c Catalog, id string, progress func(done, total int64)) error {
	instMu.Lock()
	in := aiLoadInstalled()
	instMu.Unlock()
	plan, err := aiPlan(c, in, id)
	if err != nil {
		return err
	}
	total := aiPlanSize(plan, in)
	var done int64
	for _, m := range plan {
		inst := InstModel{ID: m.ID, Kind: m.Kind, Arch: m.Arch, Source: "catalog", Defaults: m.Defaults, Added: time.Now()}
		for _, f := range m.Files {
			rel := f.Cat + "/" + f.Name
			dst := filepath.Join(aiModelsDir(), filepath.FromSlash(rel))
			if !aiHaveFile(rel, f, dst) {
				base := done
				if err := aiFetch(ctx, f, dst, func(d int64) { progress(base+d, total) }); err != nil {
					return err
				}
				done += f.Size
			}
			inst.Files = append(inst.Files, InstFile{Path: rel, Role: f.Role, Size: f.Size, SHA256: f.SHA256})
		}
		// модель записывается целиком, когда все её файлы на месте: недокачанная не считается установленной
		if err := aiUpdateInstalled(func(in *Installed) error {
			in.Models = slices.DeleteFunc(in.Models, func(x InstModel) bool { return x.ID == inst.ID })
			in.Models = append(in.Models, inst)
			return nil
		}); err != nil {
			return err
		}
	}
	progress(total, total)
	return nil
}

// aiHaveFile: файл уже скачан для другой модели с той же суммой и размер на диске совпадает
func aiHaveFile(rel string, f CatFile, dst string) bool {
	st, err := os.Stat(dst)
	if err != nil || st.Size() != f.Size {
		return false
	}
	in := aiLoadInstalled()
	for _, m := range in.Models {
		for _, x := range m.Files {
			if x.Path == rel && x.SHA256 == f.SHA256 {
				return true
			}
		}
	}
	return false
}

// aiRemoveModel удаляет модель и те её файлы, которые больше никому не нужны
func aiRemoveModel(id string) error {
	return aiUpdateInstalled(func(in *Installed) error {
		m, ok := in.model(id)
		if !ok {
			return nil
		}
		for _, f := range m.Files {
			if in.usedBy(f.Path, id) == 0 {
				if err := os.Remove(filepath.Join(aiModelsDir(), filepath.FromSlash(f.Path))); err != nil && !errors.Is(err, os.ErrNotExist) {
					return err
				}
			}
		}
		in.Models = slices.DeleteFunc(in.Models, func(x InstModel) bool { return x.ID == id })
		return nil
	})
}

// aiModelSet: из установленной модели картинок — набор файлов для движка. TAE для предпросмотра берётся любой установленный той же архитектуры.
func aiModelSet(in Installed, id string, lowVRAM bool) (ModelSet, error) {
	m, ok := in.model(id)
	if !ok || m.Kind != "image" {
		return ModelSet{}, errT("ai.unknownModel", id)
	}
	abs := func(p string) string { return filepath.Join(aiModelsDir(), filepath.FromSlash(p)) }
	set := ModelSet{LowVRAM: lowVRAM}
	for _, f := range m.Files {
		p := abs(f.Path)
		switch f.Role {
		case "checkpoint":
			set.Checkpoint = p
		case "diffusion":
			set.Diffusion = p
		case "vae":
			set.VAE = p
		case "clip_l":
			set.ClipL = p
		case "clip_g":
			set.ClipG = p
		case "t5xxl":
			set.T5XXL = p
		case "llm":
			set.LLM = p
		case "tae":
			set.TAE = p
		}
	}
	if set.TAE == "" {
		for _, t := range in.Models {
			if t.Kind == "tae" && t.Arch == m.Arch && len(t.Files) > 0 {
				set.TAE = abs(t.Files[0].Path)
				break
			}
		}
	}
	for _, p := range []string{set.Checkpoint, set.Diffusion, set.VAE, set.ClipL, set.ClipG, set.T5XXL, set.LLM, set.TAE} {
		if p != "" && !fileExists(p) {
			return ModelSet{}, errT("ai.missingFile", filepath.Base(p))
		}
	}
	if set.empty() {
		return ModelSet{}, errT("ai.unknownModel", id)
	}
	return set, nil
}

// ---- движки ----

type engineVersion struct {
	Tag    string `json:"tag"`
	Flavor string `json:"flavor"`
}

// aiEngineReady: движок стоит и это нужная сборка
func aiEngineReady(e CatEngine) bool {
	dir := aiEngineDir(e.Kind)
	b, err := os.ReadFile(filepath.Join(dir, "version.json"))
	if err != nil {
		return false
	}
	var v engineVersion
	json.Unmarshal(b, &v)
	return v.Tag == e.Tag && v.Flavor == e.Flavor && fileExists(filepath.Join(dir, e.Exe))
}

// aiInstallEngine качает архивы сборки и подменяет папку движка целиком. Движок перед этим нужно остановить:
// запущенный exe Windows не даст убрать.
func aiInstallEngine(ctx context.Context, e CatEngine, progress func(done, total int64)) error {
	dir := aiEngineDir(e.Kind)
	fresh, old := dir+".new", dir+".old"
	os.RemoveAll(fresh)
	os.RemoveAll(old)
	if err := os.MkdirAll(fresh, 0o755); err != nil {
		return err
	}
	// архивы лежат в отдельной папке: при обрыве недокачанное остаётся, и следующая установка продолжит с этого места
	dl := dir + ".dl"
	if err := os.MkdirAll(dl, 0o755); err != nil {
		return err
	}
	var total, done int64
	for _, f := range e.Files {
		total += f.Size
	}
	for _, f := range e.Files {
		archive := filepath.Join(dl, f.Name)
		base := done
		if err := aiFetch(ctx, f, archive, func(d int64) { progress(base+d, total) }); err != nil {
			os.RemoveAll(fresh)
			return err
		}
		done += f.Size
		err := aiUnpack(archive, fresh)
		os.Remove(archive)
		if err != nil {
			os.RemoveAll(fresh)
			os.RemoveAll(dl)
			return err
		}
	}
	os.RemoveAll(dl)
	if !fileExists(filepath.Join(fresh, e.Exe)) {
		os.RemoveAll(fresh)
		return errT("ai.badFile", e.Exe)
	}
	b, _ := json.Marshal(engineVersion{Tag: e.Tag, Flavor: e.Flavor})
	if err := os.WriteFile(filepath.Join(fresh, "version.json"), b, 0o644); err != nil {
		os.RemoveAll(fresh)
		return err
	}
	if dirExists(dir) {
		if err := os.Rename(dir, old); err != nil {
			os.RemoveAll(fresh)
			return errT("ai.engineBusy")
		}
	}
	if err := os.Rename(fresh, dir); err != nil {
		os.Rename(old, dir)
		return err
	}
	os.RemoveAll(old)
	progress(total, total)
	return aiUpdateInstalled(func(in *Installed) error {
		in.Engines = slices.DeleteFunc(in.Engines, func(x InstEngine) bool { return x.Kind == e.Kind })
		in.Engines = append(in.Engines, InstEngine{Kind: e.Kind, Flavor: e.Flavor, Tag: e.Tag})
		return nil
	})
}

// aiUnpack достаёт из архива exe и dll прямо в dir. Папки внутри архива не учитываются, поэтому выйти за dir нельзя.
func aiUnpack(archive, dir string) error {
	zr, err := zip.OpenReader(archive)
	if err != nil {
		return err
	}
	defer zr.Close()
	for _, f := range zr.File {
		name := filepath.Base(filepath.FromSlash(strings.ReplaceAll(f.Name, `\`, "/")))
		low := strings.ToLower(name)
		if f.FileInfo().IsDir() || !strings.HasSuffix(low, ".exe") && !strings.HasSuffix(low, ".dll") {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		w, err := os.Create(filepath.Join(dir, name))
		if err == nil {
			_, err = io.Copy(w, rc)
			if e := w.Close(); err == nil {
				err = e
			}
		}
		rc.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

// ---- свои модели: заголовок safetensors ----

// safetensorsHeader читает заголовок: 8 байт длины, дальше JSON с именами тензоров и __metadata__.
// Сами веса не читаются, поэтому это мгновенно даже для файла в 7 ГБ.
func safetensorsHeader(p string) (map[string]json.RawMessage, error) {
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var n uint64
	if err := binary.Read(f, binary.LittleEndian, &n); err != nil {
		return nil, errT("ai.notSafetensors")
	}
	if n < 2 || n > 100<<20 {
		return nil, errT("ai.notSafetensors")
	}
	b := make([]byte, n)
	if _, err := io.ReadFull(f, b); err != nil {
		return nil, errT("ai.notSafetensors")
	}
	var h map[string]json.RawMessage
	if err := json.Unmarshal(b, &h); err != nil {
		return nil, errT("ai.notSafetensors")
	}
	return h, nil
}

// safetensorsGuess: что это за файл по именам тензоров. Пусто — не узнали, тогда спросить пользователя.
// Признаки: SDXL — второй текстовый энкодер conditioner.embedders.1, SD 1.5 — cond_stage_model, FLUX — double_blocks,
// Z-Image — cap_embedder (не проверено на настоящем файле). LoRA — ключи lora_*, VAE — только encoder/decoder.
func safetensorsGuess(h map[string]json.RawMessage) (kind, arch string) {
	has := func(sub string) bool {
		for k := range h {
			if strings.Contains(k, sub) {
				return true
			}
		}
		return false
	}
	switch {
	case has("lora_down") || has("lora_up") || has(".lora_A.") || has(".lora_B.") || has("lora_unet_") || has("lora_te"):
		switch {
		case has("lora_te2_") || has("lora_unet_input_blocks_4_1_transformer_blocks_1") || has("lora_unet_down_blocks_2_attentions_0_transformer_blocks_1"):
			return "lora", "sdxl"
		case has("double_blocks") || has("single_blocks") || has("single_transformer_blocks"):
			return "lora", "flux"
		}
		return "lora", "sd15"
	case has("conditioner.embedders.1."):
		return "image", "sdxl"
	case has("cond_stage_model."):
		return "image", "sd15"
	case has("double_blocks.") || has("double_stream_modulation"):
		return "image", "flux"
	case has("cap_embedder."):
		return "image", "zimage"
	case has("decoder.layers.") && !has("decoder.up."): // TAESD: маленький декодер из простых слоёв
		return "tae", ""
	case has("decoder.conv_in.") && has("encoder.conv_in.") && !has("model.diffusion_model."):
		return "vae", ""
	}
	return "", ""
}
