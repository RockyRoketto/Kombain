package main

// Вкладка «Цвет». Градиент рисует страница (web/js/color.js), здесь только проверка готового файла
// и запись туда, куда укажет диалог «Сохранить».

import (
	"bytes"
	"encoding/base64"
	"os"
	"strings"
)

var pngMagic = []byte("\x89PNG\r\n\x1a\n")

// colorFileBytes: содержимое файла от страницы. PNG приходит в base64, SVG — текстом.
// Негодное (не та подпись, пусто, неизвестный вид) — ошибка.
func colorFileBytes(ext, data string) ([]byte, error) {
	switch ext {
	case "png":
		b, err := base64.StdEncoding.DecodeString(data)
		if err != nil || !bytes.HasPrefix(b, pngMagic) {
			return nil, errT("err.colorFile")
		}
		return b, nil
	case "svg":
		s := strings.TrimSpace(data)
		if !strings.HasPrefix(s, "<svg") || !strings.HasSuffix(s, "</svg>") {
			return nil, errT("err.colorFile")
		}
		return []byte(s + "\n"), nil
	}
	return nil, errT("err.badRequest")
}

// colorFileName: имя, которое диалог предложит сразу: основа без запрещённых знаков и нужное расширение
func colorFileName(name, ext string) string {
	name = strings.TrimSuffix(strings.TrimSpace(name), "."+ext)
	if name == "" {
		name = "gradient"
	}
	return safeName(name) + "." + ext
}

// saveColorFile: спросить, куда сохранить, и записать. Пустой путь — передумали.
func saveColorFile(ext, name, data string) (string, error) {
	b, err := colorFileBytes(ext, data)
	if err != nil {
		return "", err
	}
	path, err := pickColorSave(ext, colorFileName(name, ext))
	if err != nil || path == "" {
		return "", err
	}
	return path, os.WriteFile(path, b, 0o644)
}
