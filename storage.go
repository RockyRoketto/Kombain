package main

// Что занимает программа на диске (окно настроек, раздел «Хранилище»), очистка кэша, удаление моделей
// и статистика работы: сколько файлов сделано и сколько места сэкономлено.

import (
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"
)

// StoragePart: один кусок полосы. Kind задаёт цвет и подпись на странице; Name — модель или пусто.
type StoragePart struct {
	Kind  string `json:"kind"`
	Name  string `json:"name,omitempty"`
	Bytes int64  `json:"bytes"`
}

// dirSize: вес папки со всем содержимым; нет папки — ноль
func dirSize(dir string) int64 {
	var sum int64
	filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			if st, e := d.Info(); e == nil {
				sum += st.Size()
			}
		}
		return nil
	})
	return sum
}

// storageParts раскладывает папку программы по частям. Модели распознавания идут каждая своей строкой,
// чтобы их можно было удалить по одной. Что не узнали, попадает в «прочее».
func storageParts() []StoragePart {
	var parts []StoragePart
	add := func(kind, name string, n int64) {
		if n > 0 {
			parts = append(parts, StoragePart{kind, name, n})
		}
	}
	if exe, err := os.Executable(); err == nil {
		add("app", "", fileSize(exe))
	}
	add("ffmpeg", "", dirSize(ffDir()))
	names := make([]string, 0, len(whisperModels))
	for name := range whisperModels {
		names = append(names, name)
	}
	slices.SortFunc(names, func(a, b string) int { return int(whisperModels[a].size - whisperModels[b].size) })
	var known int64
	for _, name := range names {
		n := fileSize(whisperModelPath(name))
		known += n
		add("model", name, n)
	}
	// недокачанные и чужие файлы в папке моделей тоже место занимают
	add("models", "", dirSize(filepath.Join(dataDir(), "models"))-known)
	add("tools", "", dirSize(filepath.Join(dataDir(), "tools")))
	add("preview", "", dirSize(proxyDir()))
	add("cache", "", dirSize(cacheDir())-dirSize(proxyDir()))
	add("webview", "", dirSize(filepath.Join(dataDir(), "webview")))
	var top int64 // settings.json, window.json, stats.json
	if entries, err := os.ReadDir(dataDir()); err == nil {
		for _, e := range entries {
			if st, err := e.Info(); err == nil && !e.IsDir() {
				top += st.Size()
			}
		}
	}
	add("other", "", top)
	return parts
}

// cacheClear стирает то, что программа сделает заново: копии для просмотра, картинки надписей,
// сырые времена распознавания. Перетащенные файлы и правки субтитров
// и недокачанное обновление могут быть в работе прямо сейчас, их чистит cacheTidy при запуске.
func cacheClear() {
	proxyClear()
	os.RemoveAll(textDir())
	os.Remove(filepath.Join(cacheDir(), "whisper-last.json"))
}

// whisperRemove удаляет модель (name) или саму программу распознавания (пустое имя)
func whisperRemove(name string) error {
	if whisperState().Active {
		return errT("store.whisperBusy")
	}
	if name == "" {
		return os.RemoveAll(toolDir("whisper"))
	}
	if _, ok := whisperModels[name]; !ok {
		return errT("err.badRequest")
	}
	p := whisperModelPath(name)
	os.Remove(p + ".part")
	if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// Stats копится с версии, где появилось окно хранилища; раньше программа ничего не считала.
type Stats struct {
	Files int64     `json:"files"` // сколько готовых файлов сделано
	In    int64     `json:"in"`    // сколько весили исходники этих файлов
	Out   int64     `json:"out"`   // сколько весят результаты
	Saved int64     `json:"saved"` // на сколько результаты легче исходников, считая только те, что полегчали
	Since time.Time `json:"since"` // с какого дня считаем
}

var statsMu sync.Mutex

func statsPath() string { return filepath.Join(dataDir(), "stats.json") }

func loadStats() Stats {
	var st Stats
	if b, err := os.ReadFile(statsPath()); err == nil {
		json.Unmarshal(b, &st)
	}
	return st
}

// statsAdd дописывает итог пачки. Файлы без размера исходника (например, монтаж) считаются, но в экономию не входят.
func statsAdd(files []FileState) {
	var add Stats
	for _, f := range files {
		if f.Status != "ok" {
			continue
		}
		add.Files++
		if f.SrcSize > 0 && f.DstSize > 0 {
			add.In += f.SrcSize
			add.Out += f.DstSize
			if d := f.SrcSize - f.DstSize; d > 0 {
				add.Saved += d
			}
		}
	}
	if add.Files == 0 {
		return
	}
	statsMu.Lock()
	defer statsMu.Unlock()
	st := loadStats()
	if st.Since.IsZero() {
		st.Since = time.Now()
	}
	st.Files += add.Files
	st.In += add.In
	st.Out += add.Out
	st.Saved += add.Saved
	if b, err := json.Marshal(st); err == nil {
		os.MkdirAll(dataDir(), 0o755)
		tmp := statsPath() + ".tmp"
		if os.WriteFile(tmp, b, 0o644) == nil {
			os.Rename(tmp, statsPath())
		}
	}
}

func readStats() Stats {
	statsMu.Lock()
	defer statsMu.Unlock()
	return loadStats()
}
