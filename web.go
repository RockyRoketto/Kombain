package main

// Страница интерфейса собирается из web/ при запуске: разметка + стили + скрипты.
// Скрипты — обычные (не модули), общие переменные видны между файлами, поэтому порядок в webJS важен.

import (
	"embed"
	"encoding/json"
	"html"
	"regexp"
	"strings"
)

//go:embed web
var webFS embed.FS

//go:embed favicon.png
var faviconPNG []byte

var webJS = []string{
	"i18n.js", "core.js", "settings.js", "filelist.js", "drop.js", "start.js", "toasts.js",
	"sliders.js", "kinetic.js", "player.js", "preview.js", "trim.js", "playertab.js", "tracks.js", "montage.js", "textclip.js", "subedit.js", "subfx.js", "ctxmenu.js", "vumeter.js", "viewport.js", "mvtrans.js", "trpanel.js", "rulers.js", "viewzoom.js", "chroma.js", "keyframes.js", "setup.js", "updates.js", "sounds.js", "poll.js", "bannertab.js", "session.js", "boot.js", "anim.js",
}

// страница на каждом языке: разметка переведена заранее, чтобы при запуске не мигал другой язык
var pages = map[string]string{langRU: buildPage(langRU), langEN: buildPage(langEN)}

// метки перевода в разметке: data-i18n (содержимое, HTML), data-i18n-title, -ph (placeholder), -aria (aria-label)
var (
	i18nTagRe  = regexp.MustCompile(`<[a-zA-Z][^<>]*\bdata-i18n[^<>]*>`)
	i18nAttrRe = regexp.MustCompile(`\bdata-i18n(-title|-ph|-aria)?="([^"]+)"`)
)

// localize вставляет тексты словаря в размеченные теги. Неизвестный ключ — паника: её сразу покажет любой тест.
func localize(page string, dict map[string]string) string {
	return i18nTagRe.ReplaceAllStringFunc(page, func(tag string) string {
		attrs, content := "", ""
		for _, m := range i18nAttrRe.FindAllStringSubmatch(tag, -1) {
			text, ok := dict[m[2]]
			if !ok {
				panic("web/i18n.json: no key " + m[2])
			}
			switch m[1] {
			case "":
				content = text
			case "-title":
				attrs += ` title="` + html.EscapeString(text) + `"`
			case "-ph":
				attrs += ` placeholder="` + html.EscapeString(text) + `"`
			case "-aria":
				attrs += ` aria-label="` + html.EscapeString(text) + `"`
			}
		}
		return tag[:len(tag)-1] + attrs + ">" + content
	})
}

func pageDict() map[string]map[string]string {
	b, err := webFS.ReadFile("web/i18n.json")
	if err != nil {
		panic(err)
	}
	var dict map[string]map[string]string
	if err := json.Unmarshal(b, &dict); err != nil {
		panic(err)
	}
	return dict
}

func buildPage(lang string) string {
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
	dict := pageDict()
	dictJSON, _ := json.Marshal(dict) // Marshal экранирует < и >, поэтому словарь не закроет тег script
	script := strings.NewReplacer("__I18N__", string(dictJSON), "__LANG__", lang).Replace(js.String())
	return strings.NewReplacer(
		"__LANG__", lang,
		"__CSS__\n", read("style.css"),
		"__JS__\n", script,
	).Replace(localize(read("index.html"), dict[lang]))
}
