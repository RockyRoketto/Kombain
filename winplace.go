package main

// Размер и положение окна между запусками. Отдельный файл, а не settings.json:
// окно пишется при каждом закрытии и настройкам темы и языка мешать не должно.

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// winPlace: прямоугольник обычного (не развёрнутого) окна и развёрнуто ли оно
type winPlace struct {
	X   int32 `json:"x"`
	Y   int32 `json:"y"`
	W   int32 `json:"w"`
	H   int32 `json:"h"`
	Max bool  `json:"max,omitempty"`
}

func winPlacePath() string { return filepath.Join(dataDir(), "window.json") }

// loadWinPlace: false, если файла нет или он испорчен; тогда окно откроется как при первом запуске
func loadWinPlace() (winPlace, bool) {
	var p winPlace
	b, err := os.ReadFile(winPlacePath())
	if err != nil || json.Unmarshal(b, &p) != nil || p.W <= 0 || p.H <= 0 {
		return winPlace{}, false
	}
	return p, true
}

func saveWinPlace(p winPlace) error {
	if err := os.MkdirAll(dataDir(), 0o755); err != nil {
		return err
	}
	b, _ := json.Marshal(p)
	tmp := winPlacePath() + ".part"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, winPlacePath())
}

// fit вписывает окно в монитор: не меньше минимального размера, не больше монитора, целиком на экране.
// Монитор могли сменить или настроить иначе, а заголовок окна должен оставаться доступным.
func (p winPlace) fit(left, top, right, bottom, minW, minH int32) winPlace {
	p.W, p.X = fitSpan(p.W, p.X, left, right, minW)
	p.H, p.Y = fitSpan(p.H, p.Y, top, bottom, minH)
	return p
}

func fitSpan(size, pos, lo, hi, minSize int32) (int32, int32) {
	size = min(max(size, minSize), hi-lo)
	pos = max(min(pos, hi-size), lo)
	return size, pos
}
