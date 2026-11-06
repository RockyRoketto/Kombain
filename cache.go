package main

import (
	"os"
	"path/filepath"
	"slices"
	"time"
)

// Сколько живут картинки клипов «Текст». Удалять их не страшно: страница рисует картинку заново, когда открывает проект.
const (
	textKeepAge  = 14 * 24 * time.Hour
	textKeepSize = 100 << 20
)

func textDir() string { return filepath.Join(cacheDir(), "text") }

// cacheTidy убирает хвосты при запуске. Звать только тем, кто занял порт, и до того, как страница что-нибудь попросит.
// Копии просмотра здесь не трогаем: у них свой предел, см. proxyPrune.
func cacheTidy() {
	os.RemoveAll(dropDir())
	os.RemoveAll(subsDir())
	os.RemoveAll(filepath.Join(cacheDir(), "update"))  // недокачанное обновление
	os.RemoveAll(filepath.Join(cacheDir(), "whisper")) // звук распознавания, если программу закрыли посреди работы
	textPrune(time.Now())
}

// textPrune удаляет картинки, которые давно не использовались, и самые старые сверх предела.
// Дата файла означает последнее использование: её обновляет saveTextPNG, в том числе при каждом открытии проекта.
func textPrune(now time.Time) {
	entries, err := os.ReadDir(textDir())
	if err != nil {
		return
	}
	type item struct {
		path string
		size int64
		at   time.Time
	}
	var list []item
	for _, e := range entries {
		if st, err := e.Info(); err == nil && !e.IsDir() {
			list = append(list, item{filepath.Join(textDir(), e.Name()), st.Size(), st.ModTime()})
		}
	}
	slices.SortFunc(list, func(a, b item) int { return b.at.Compare(a.at) })
	var sum int64
	for _, it := range list {
		if sum += it.size; sum > textKeepSize || now.Sub(it.at) > textKeepAge {
			os.Remove(it.path)
		}
	}
}
