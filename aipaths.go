package main

// Папка ИИ: движки картинок и текста, модели, галерея. Всё это весит гигабайты, поэтому папку выбирает пользователь;
// выбор хранится в ai.json рядом с settings.json. Пока не выбрал — папка ai внутри dataDir.
//
//	<папка ИИ>\
//	  engines\sd\        sd-server.exe, sd-cli.exe + dll, version.json
//	  engines\llm\       llama-server.exe + dll, version.json
//	  models\<вид>\      см. aiModelCats
//	  models\_previews\  картинки-примеры моделей
//	  gallery\ГГГГ-ММ\   готовые картинки + .json с параметрами
//	  logs\              вывод движков (последний запуск)
//	  catalog.json       что установлено (aicatalog.go)

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"
)

// aiModelCats: папки моделей. Имена совпадают с категориями sd-server (--model-dir), чтобы он находил файлы сам.
var aiModelCats = []string{"checkpoints", "diffusion_models", "loras", "vae", "text_encoders", "tae", "upscale", "bgremove", "llm", "controlnet"}

type aiConfig struct {
	Root string `json:"root"`
}

var aiMu sync.Mutex

func aiConfigPath() string  { return filepath.Join(dataDir(), "ai.json") }
func aiDefaultRoot() string { return filepath.Join(dataDir(), "ai") }

func aiReadConfig() aiConfig {
	var c aiConfig
	if b, err := os.ReadFile(aiConfigPath()); err == nil {
		json.Unmarshal(b, &c)
	}
	return c
}

// aiRoot: выбранная папка или папка по умолчанию, если выбора нет или он испорчен
func aiRoot() string {
	aiMu.Lock()
	defer aiMu.Unlock()
	if c := aiReadConfig(); c.Root != "" && filepath.IsAbs(c.Root) {
		return filepath.Clean(c.Root)
	}
	return aiDefaultRoot()
}

// aiRootChosen: пользователь уже выбрал папку (окно первого запуска больше не нужно)
func aiRootChosen() bool {
	aiMu.Lock()
	defer aiMu.Unlock()
	return aiReadConfig().Root != ""
}

// aiSetRoot проверяет, что в папку можно писать, и запоминает её. Уже скачанное не переносится: это решает тот, кто зовёт.
func aiSetRoot(dir string) error {
	if !filepath.IsAbs(dir) {
		return errT("ai.badRoot")
	}
	dir = filepath.Clean(dir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return errT("ai.badRoot")
	}
	probe := filepath.Join(dir, ".kombain-probe")
	if err := os.WriteFile(probe, nil, 0o644); err != nil {
		return errT("ai.badRoot")
	}
	os.Remove(probe)
	b, _ := json.Marshal(aiConfig{Root: dir})
	aiMu.Lock()
	defer aiMu.Unlock()
	return writeFileAtomic(aiConfigPath(), b)
}

func aiEngineDir(kind string) string { return filepath.Join(aiRoot(), "engines", kind) }
func aiModelsDir() string            { return filepath.Join(aiRoot(), "models") }
func aiPreviewsDir() string          { return filepath.Join(aiModelsDir(), "_previews") }
func aiLogDir() string               { return filepath.Join(aiRoot(), "logs") }
func aiCatalogPath() string          { return filepath.Join(aiRoot(), "catalog.json") }

// aiModelDir: папка одного вида моделей; неизвестный вид — пусто, чтобы опечатка не создала лишнюю папку
func aiModelDir(cat string) string {
	if !slices.Contains(aiModelCats, cat) {
		return ""
	}
	return filepath.Join(aiModelsDir(), cat)
}

// aiGalleryDir: картинки складываются по месяцам, чтобы в одной папке не копились тысячи файлов
func aiGalleryDir(t time.Time) string {
	return filepath.Join(aiRoot(), "gallery", t.Format("2006-01"))
}

// aiEnsure создаёт все папки разом (перед первой установкой)
func aiEnsure() error {
	dirs := []string{aiEngineDir("sd"), aiEngineDir("llm"), aiPreviewsDir(), aiLogDir()}
	for _, c := range aiModelCats {
		dirs = append(dirs, aiModelDir(c))
	}
	for _, d := range dirs {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return err
		}
	}
	return nil
}

// writeFileAtomic: сначала во временный файл, потом подмена, чтобы сбой посередине не оставил полфайла
func writeFileAtomic(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}
