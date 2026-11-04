package main

// Общее состояние программы: типы Server, FileState, StartReq и журнал.

import (
	"context"
	"fmt"
	"sync"
	"time"
)

type FileInfo struct {
	Path string `json:"path"`
	Size int64  `json:"size"`
}

type FileState struct {
	Path    string  `json:"path"`
	Name    string  `json:"name"`
	Dst     string  `json:"dst"`
	Status  string  `json:"status"` // pending, running, ok, error, skipped, kept (сжимать не стал), canceled
	Pct     float64 `json:"pct"`
	Msg     string  `json:"msg"`
	Hint    string  `json:"hint"` // понятное человеку объяснение ошибки
	SrcSize int64   `json:"srcSize"`
	DstSize int64   `json:"dstSize"`

	f Format // во что конвертировать (в режиме «Сжать» — своё для каждого файла)
}

type DL struct {
	Active bool    `json:"active"`
	Pct    float64 `json:"pct"`
	Err    string  `json:"err"`
}

type Server struct {
	mu      sync.Mutex
	token   string
	host    string
	last    time.Time
	ffmpeg  string
	dl      DL
	running bool
	files   []*FileState
	log     []string
	summary string
	batch   string // что сейчас в files: "conv" — конвертер, "banner" — вкладка «Баннеры»
	cancel  context.CancelFunc

	ownsDrop bool // папка drop наша: занят постоянный порт, другого живого экземпляра нет

	ffv      FFVer       // версии ffmpeg: своя и свежая
	ffURLs   []string    // откуда качать свежий ffmpeg (по порядку)
	settings Settings    // settings.json
	inst     InstallInfo // установлена ли программа
	appUpd   AppUpd      // новая версия самой программы
}

type StartReq struct {
	Files     []string `json:"files"`
	Format    string   `json:"format"`
	CRF       int      `json:"crf"`
	ABR       int      `json:"abr"`
	Preset    string   `json:"preset"`
	Height    string   `json:"height"`
	FPS       string   `json:"fps"`
	Extra     string   `json:"extra"`
	OutDir    string   `json:"outDir"`
	DropOut   string   `json:"dropOut"` // куда класть перетащенные файлы в режиме «рядом с оригиналом»
	SameDir   bool     `json:"sameDir"`
	Overwrite bool     `json:"overwrite"`
	Copy      bool     `json:"copy"` // если результат уже есть — сделать копию «имя (1).mp4»
	Jobs      int      `json:"jobs"`
	Codec     string   `json:"codec"`    // режим «Сжать»: h265 (по умолчанию) или h264
	TargetMB  float64  `json:"targetMB"` // уложить видео в столько МБ (0 — не ограничивать)
}

func (s *Server) addLog(format string, a ...any) {
	line := fmt.Sprintf(format, a...)
	s.mu.Lock()
	s.log = append(s.log, line)
	if len(s.log) > 500 {
		s.log = s.log[len(s.log)-500:]
	}
	s.mu.Unlock()
}

// begin занимает программу под новую пачку и возвращает путь к ffmpeg. Проверка и занятие идут под одной
// блокировкой: иначе двойной клик запустил бы две пачки, и вторая подменила бы s.files под работающей первой.
func (s *Server) begin(busy string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case s.appUpd.Active || s.appUpd.Restart:
		return "", fmt.Errorf("подожди, ставится новая версия Конвертера")
	case s.running:
		return "", fmt.Errorf("%s", busy)
	case s.dl.Active:
		return "", fmt.Errorf("подожди, ffmpeg ещё скачивается")
	case s.ffmpeg == "":
		return "", fmt.Errorf("ffmpeg не найден")
	}
	s.running = true
	s.files = nil // пока новая пачка не готова, интерфейс не должен снова увидеть статусы прошлой
	s.summary = ""
	return s.ffmpeg, nil
}
