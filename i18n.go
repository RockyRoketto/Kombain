package main

// Язык интерфейса. Выбор лежит в settings.json; русский — основной, системный язык Windows не учитывается.
// Тексты для Go — в i18n_strings.go, тексты страницы — в web/i18n.json.

import (
	"errors"
	"fmt"
	"sync/atomic"
)

const (
	langRU = "ru"
	langEN = "en"
)

func validLang(l string) bool { return l == langRU || l == langEN }

// normLang: пустое и неизвестное значение (старый или испорченный settings.json) — русский
func normLang(l string) string {
	if validLang(l) {
		return l
	}
	return langRU
}

// Тексты нужны и там, где нет Server (ошибки ffmpeg, удаление программы), поэтому язык общий на всю программу.
var curLang atomic.Value

func setLang(l string) { curLang.Store(normLang(l)) }

func currentLang() string {
	if l, ok := curLang.Load().(string); ok {
		return l
	}
	return langRU
}

// tr: текст по ключу на текущем языке. С аргументами текст — это формат для fmt.Sprintf.
func tr(key string, a ...any) string {
	s, ok := goDict[currentLang()][key]
	if !ok {
		s, ok = goDict[langRU][key]
	}
	if !ok {
		return key
	}
	if len(a) == 0 {
		return s
	}
	return fmt.Sprintf(s, a...)
}

func errT(key string, a ...any) error { return errors.New(tr(key, a...)) }
