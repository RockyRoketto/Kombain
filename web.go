package main

// Страница интерфейса собирается из web/ при запуске: разметка + стили + скрипты.
// Скрипты — обычные (не модули), общие переменные видны между файлами, поэтому порядок в webJS важен.

import (
	"embed"
	"strings"
)

//go:embed web
var webFS embed.FS

//go:embed hero.jpg
var heroJPG []byte

//go:embed favicon.png
var faviconPNG []byte

var webJS = []string{
	"core.js", "settings.js", "filelist.js", "drop.js", "start.js", "toasts.js",
	"preview.js", "setup.js", "updates.js", "poll.js", "bannertab.js", "boot.js",
}

var indexHTML = buildPage()

func buildPage() string {
	read := func(name string) string {
		b, err := webFS.ReadFile("web/" + name)
		if err != nil {
			panic(err)
		}
		return string(b)
	}
	var js strings.Builder
	for _, f := range webJS {
		js.WriteString(read("js/" + f))
	}
	return strings.NewReplacer(
		"__CSS__\n", read("style.css"),
		"__JS__\n", js.String(),
	).Replace(read("index.html"))
}
