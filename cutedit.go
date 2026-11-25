package main

// «Поправить вырезку»: ручная доработка картинки после «Убрать фон» (web/js/cutedit.js).
// Кисти, край и сборка прозрачности — на странице; сервер ищет оригинал для кисти «Вернуть»
// и сохраняет готовый PNG отдельным файлом: в галерее — новой записью, с диска — рядом с правленым.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"regexp"
	"strings"
)

// хвосты имён, которые программа дописывает к картинке: -nobg, -fix, -x2/-x4 и номер повтора -2, -3…
var cutTail = regexp.MustCompile(`(?i)(-(nobg|fix|x[0-9]+))(-[0-9]+)?$`)

// cutBase: имя без расширения и без хвостов программы: «cat-nobg-2-fix» → «cat»
func cutBase(stem string) string {
	for {
		s := cutTail.ReplaceAllString(stem, "")
		if s == stem || s == "" {
			return stem
		}
		stem = s
	}
}

// cutSrcOf: оригинал вырезки p. В галерее — по ссылке Src в .json; иначе (и у старых вырезок) —
// файл с тем же именем без хвостов в той же папке, в галерее — и в папках других месяцев.
func cutSrcOf(p string) string {
	gal := genInGallery(p)
	if gal {
		if m := genMetaOf(p); m.Src != "" && m.Src != p && fileExists(m.Src) {
			return m.Src
		}
	}
	stem := cutBase(strings.TrimSuffix(filepath.Base(p), filepath.Ext(p)))
	dirs := []string{filepath.Dir(p)}
	if gal {
		if ms, err := filepath.Glob(filepath.Join(genGalleryRoot(), "*")); err == nil {
			dirs = append(dirs, ms...)
		}
	}
	for _, d := range dirs {
		for _, ext := range []string{".png", ".jpg", ".jpeg", ".webp", ".gif"} {
			c := filepath.Join(d, stem+ext)
			if strings.EqualFold(c, p) || !fileExists(c) {
				continue
			}
			if gal && genInGallery(c) && genMetaOf(c).Cutout {
				continue
			}
			return c
		}
	}
	return ""
}

var fixTail = regexp.MustCompile(`(?i)-fix(-[0-9]+)?$`)

// cutFixStem: имя правленой копии без расширения; повторная правка не копит хвосты: «cat-nobg-fix-2» → «cat-nobg-fix»
func cutFixStem(stem string) string { return fixTail.ReplaceAllString(stem, "") + "-fix" }

// cutOutPath: куда сохранить правленую копию файла с диска: рядом, <имя>-fix.png, существующие не трогаем
func cutOutPath(p string) string {
	base := cutFixStem(strings.TrimSuffix(p, filepath.Ext(p)))
	out := base + ".png"
	for i := 2; fileExists(out); i++ {
		out = fmt.Sprintf("%s-%d.png", base, i)
	}
	return out
}

// cutSave: PNG data (уже с прозрачностью) — отдельным файлом; правленый p не трогаем
func cutSave(p string, data []byte) (string, error) {
	if !bytes.HasPrefix(data, pngMagic) {
		return "", errT("ce.bad")
	}
	if genInGallery(p) {
		name := cutFixStem(strings.TrimSuffix(filepath.Base(p), filepath.Ext(p)))
		return genDeriveAs(p, name, data, func(m *GenMeta) {
			m.Cutout = true
			if m.Src == "" {
				m.Src = cutSrcOf(p)
			}
		})
	}
	out := cutOutPath(p)
	if err := writeFileAtomic(out, data); err != nil {
		return "", err
	}
	return out, nil
}

func (s *Server) cutRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/cut-src", s.api(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Path string `json:"path"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if !bgFileOK(body.Path) || !fileExists(body.Path) {
			writeJSON(w, map[string]any{"error": tr("err.noFile")})
			return
		}
		writeJSON(w, map[string]any{"src": cutSrcOf(body.Path)})
	}))
	mux.HandleFunc("/api/cut-save", s.api(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Path string `json:"path"`
			Data string `json:"data"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<20)).Decode(&body); err != nil {
			writeJSON(w, map[string]any{"error": tr("err.badRequest")})
			return
		}
		if !bgFileOK(body.Path) || !fileExists(body.Path) {
			writeJSON(w, map[string]any{"error": tr("err.noFile")})
			return
		}
		data, err := genMaskData(body.Data)
		if err != nil {
			writeJSON(w, map[string]any{"error": tr("ce.bad")})
			return
		}
		out, err := cutSave(body.Path, data)
		if err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, map[string]any{"ok": true, "path": out, "gallery": genInGallery(out)})
	}))
}
