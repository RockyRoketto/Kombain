package main

// Общее состояние программы: типы Server, FileState, StartReq и журнал.

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
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

	f      Format   // во что конвертировать (в режиме «Сжать» — своё для каждого файла)
	frames []string // картинки, которые собираются в это видео; Path — первая из них

	project *Project // строка монтажа; Path — её номер в очереди, а не файл
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
	// номер пачки: страница узнаёт о конце пачки по нему, даже если вся пачка уложилась между двумя опросами
	batchSeq int
	cancel   context.CancelFunc

	ownsDrop bool // папка drop наша: занят постоянный порт, другого живого экземпляра нет

	ffv      FFVer       // версии ffmpeg: своя и свежая
	ffURLs   []string    // откуда качать свежий ffmpeg (по порядку)
	settings Settings    // settings.json
	inst     InstallInfo // установлена ли программа
	appUpd   AppUpd      // новая версия самой программы
	news     string      // текст плашки «Что нового», пусто — плашки нет
	newsEn   string      // он же по-английски

	incoming        []FileInfo // файлы снаружи («Отправить», второй запуск), страница заберёт их при опросе
	incomingProject string     // файл проекта монтажа снаружи: двойной щелчок по нему
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

	Join       bool   `json:"join"`       // собрать картинки каждой папки в одно видео
	JoinFPS    string `json:"joinFps"`    // кадров в секунду для такого видео
	GifPalette string `json:"gifPalette"` // "frame": своя палитра на каждый кадр

	Trims map[string]Trim `json:"trims"` // обрезка: путь исходника → какой кусок оставить

	Montages map[string]Project `json:"montages"` // строки монтажа: значение из Files → проект
}

// Trim: кусок файла в секундах от начала
type Trim struct {
	Start float64 `json:"start"`
	End   float64 `json:"end"`
}

// trim: откуда и сколько секунд брать из этого файла; ok == false — файл целиком
func (r StartReq) trim(src string) (start, length float64, ok bool) {
	t, ok := r.Trims[src]
	if !ok || t.End <= t.Start || t.End <= 0 {
		return 0, 0, false
	}
	start = max(t.Start, 0)
	return start, t.End - start, true
}

// addIncoming: файлы и папки, переданные программе снаружи. Не медиафайлы молча пропускаем.
func (s *Server) addIncoming(paths []string) {
	for _, p := range paths {
		if strings.EqualFold(filepath.Ext(p), projectExt) {
			s.mu.Lock()
			s.incomingProject = p
			s.mu.Unlock()
		}
	}
	var list []FileInfo
	for _, f := range expandPaths(paths) {
		if mediaExt[strings.ToLower(filepath.Ext(f.Path))] {
			list = append(list, f)
		}
	}
	s.mu.Lock()
	s.incoming = append(s.incoming, list...)
	s.mu.Unlock()
}

// logT: строка лога из словаря, на языке, выбранном в момент записи
func (s *Server) logT(key string, a ...any) { s.addLog("%s", tr(key, a...)) }

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
		return "", errT("err.updating")
	case s.running:
		return "", fmt.Errorf("%s", busy)
	case s.dl.Active:
		return "", errT("err.ffDownloading")
	case s.ffmpeg == "":
		return "", errT("err.ffmpegMissing")
	}
	s.running = true
	s.batchSeq++
	s.files = nil // пока новая пачка не готова, интерфейс не должен снова увидеть статусы прошлой
	s.summary = ""
	return s.ffmpeg, nil
}
