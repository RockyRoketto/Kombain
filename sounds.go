package main

// Звуки Windows для конца пачки. Сами файлы не вшиваем: они принадлежат системе и лежат на каждом компьютере.

import (
	"os"
	"path/filepath"
	"strings"
)

type SystemSound struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

// короткие звуки, 1–2 секунды; стандартные выбирает web/js/sounds.js (SOUND_STD)
var systemSoundFiles = []string{
	"tada.wav", "chimes.wav", "chord.wav", "ding.wav", "notify.wav",
	"Windows Notify.wav", "Windows Ding.wav", "Windows Print complete.wav",
	"Windows Critical Stop.wav", "Windows Error.wav", "Windows Exclamation.wav", "Windows Hardware Fail.wav",
}

// systemSounds: только те, что есть на этом компьютере; набор зависит от версии Windows
func systemSounds() []SystemSound {
	out := []SystemSound{}
	root := os.Getenv("SystemRoot")
	if root == "" {
		return out
	}
	for _, f := range systemSoundFiles {
		p := filepath.Join(root, "Media", f)
		if fileExists(p) {
			out = append(out, SystemSound{Name: strings.TrimSuffix(f, ".wav"), Path: p})
		}
	}
	return out
}
