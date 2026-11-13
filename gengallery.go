package main

// Галерея генератора: всё, что лежит в <папка ИИ>\gallery\ГГГГ-ММ\ парами «картинка.png + картинка.json».
// Список читается с диска при каждом запросе, но .json разбирается только у новых и изменённых файлов (galIndex).
// Поиск, избранное и фильтр по модели — здесь, страница получает уже готовую страницу списка.
// Миниатюры (/gen-thumb) — JPEG по длинной стороне 384, лежат в gallery\.thumbs\ и пересобираются, если картинка новее.
// Удаление — в корзину Windows (moveToTrash), чтобы случайный щелчок можно было вернуть.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/image/draw"
)

func genGalleryRoot() string { return filepath.Join(aiRoot(), "gallery") }

// genInGallery: путь — PNG внутри галереи (страница присылает пути, чужие файлы трогать нельзя)
func genInGallery(p string) bool {
	if p == "" || !strings.EqualFold(filepath.Ext(p), ".png") {
		return false
	}
	rel, err := filepath.Rel(genGalleryRoot(), filepath.Clean(p))
	return err == nil && rel != "." && !strings.HasPrefix(rel, "..") && !filepath.IsAbs(rel) && !strings.HasPrefix(rel, ".thumbs")
}

func genSidecar(p string) string { return strings.TrimSuffix(p, filepath.Ext(p)) + ".json" }

func genThumbPath(p string) string {
	return filepath.Join(genGalleryRoot(), ".thumbs", strings.TrimSuffix(filepath.Base(p), filepath.Ext(p))+".jpg")
}

// galItem: картинка галереи, как её видит страница
type galItem struct {
	Path string  `json:"path"`
	Mod  int64   `json:"mod"` // для адреса миниатюры: сменилась картинка — браузер не возьмёт старую из кэша
	Size int64   `json:"size"`
	Meta GenMeta `json:"meta"`
	hay  string  // строчными: по чему искать
}

type galEntry struct {
	mod  time.Time
	item galItem
}

var galIndex = struct {
	sync.Mutex
	m map[string]galEntry
}{m: map[string]galEntry{}}

// genGalleryAll: все картинки галереи, новые сверху
func genGalleryAll(root string) []galItem {
	months, _ := os.ReadDir(root)
	galIndex.Lock()
	defer galIndex.Unlock()
	seen := map[string]bool{}
	var out []galItem
	for _, d := range months {
		if !d.IsDir() || strings.HasPrefix(d.Name(), ".") {
			continue
		}
		dir := filepath.Join(root, d.Name())
		ents, _ := os.ReadDir(dir)
		have := map[string]bool{}
		for _, e := range ents {
			have[strings.ToLower(e.Name())] = true
		}
		for _, e := range ents {
			n := e.Name()
			if e.IsDir() || !strings.EqualFold(filepath.Ext(n), ".json") || !have[strings.ToLower(strings.TrimSuffix(n, filepath.Ext(n))+".png")] {
				continue
			}
			js := filepath.Join(dir, n)
			img := strings.TrimSuffix(js, filepath.Ext(js)) + ".png"
			info, err := e.Info()
			if err != nil {
				continue
			}
			seen[img] = true
			if c, ok := galIndex.m[img]; ok && c.mod.Equal(info.ModTime()) {
				out = append(out, c.item)
				continue
			}
			b, err := os.ReadFile(js)
			var m GenMeta
			if err != nil || json.Unmarshal(b, &m) != nil {
				continue
			}
			it := galItem{Path: img, Meta: m}
			if st, err := os.Stat(img); err == nil {
				it.Mod, it.Size = st.ModTime().UnixMilli(), st.Size()
			}
			if m.Created.IsZero() {
				it.Meta.Created = info.ModTime()
			}
			hay := []string{m.Params.Prompt, m.Model}
			if m.Request != nil {
				hay = append(hay, m.Request.Prompt, m.Request.Preset)
			}
			it.hay = strings.ToLower(strings.Join(hay, " "))
			galIndex.m[img] = galEntry{mod: info.ModTime(), item: it}
			out = append(out, it)
		}
	}
	for k := range galIndex.m {
		if !seen[k] {
			delete(galIndex.m, k)
		}
	}
	slices.SortStableFunc(out, func(a, b galItem) int { return b.Meta.Created.Compare(a.Meta.Created) })
	return out
}

type galQuery struct {
	Q      string `json:"q"`
	Fav    bool   `json:"fav"`
	Model  string `json:"model"`
	Offset int    `json:"offset"`
	Limit  int    `json:"limit"`
}

type galModel struct {
	ID string `json:"id"`
	N  int    `json:"n"`
}

type galPage struct {
	Items  []galItem  `json:"items"`
	Total  int        `json:"total"` // подходит под поиск и фильтры
	All    int        `json:"all"`
	Favs   int        `json:"favs"`
	Models []galModel `json:"models"`
}

// genGalleryFind: поиск по словам (все слова должны найтись в запросе, развёрнутом промте, стиле или модели)
func genGalleryFind(all []galItem, q galQuery) galPage {
	words := strings.Fields(strings.ToLower(q.Q))
	pg := galPage{Items: []galItem{}, All: len(all), Models: []galModel{}}
	count := map[string]int{}
	var hit []galItem
	for _, it := range all {
		count[it.Meta.Model]++
		if it.Meta.Fav {
			pg.Favs++
		}
		if q.Fav && !it.Meta.Fav || q.Model != "" && it.Meta.Model != q.Model {
			continue
		}
		ok := true
		for _, w := range words {
			if !strings.Contains(it.hay, w) {
				ok = false
				break
			}
		}
		if ok {
			hit = append(hit, it)
		}
	}
	for id, n := range count {
		pg.Models = append(pg.Models, galModel{id, n})
	}
	slices.SortFunc(pg.Models, func(a, b galModel) int { return b.N - a.N })
	pg.Total = len(hit)
	lim := q.Limit
	if lim <= 0 || lim > 500 {
		lim = 120
	}
	off := min(max(q.Offset, 0), len(hit))
	pg.Items = append(pg.Items, hit[off:min(off+lim, len(hit))]...)
	return pg
}

// genSetFav переписывает .json с новой отметкой избранного
func genSetFav(p string, fav bool) error {
	js := genSidecar(p)
	b, err := os.ReadFile(js)
	if err != nil {
		return err
	}
	var raw map[string]any // через map: поля, которых эта версия не знает, не теряются
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	if fav {
		raw["fav"] = true
	} else {
		delete(raw, "fav")
	}
	out, _ := json.MarshalIndent(raw, "", "  ")
	tmp := js + ".tmp"
	if err := os.WriteFile(tmp, out, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, js)
}

// genReadInit: картинка из галереи для «Вариаций» и её размер
func genReadInit(p string) ([]byte, int, int, error) {
	if !genInGallery(p) {
		return nil, 0, 0, errT("err.noFile")
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return nil, 0, 0, errT("err.noFile")
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(b))
	if err != nil || cfg.Width < 64 || cfg.Height < 64 {
		return nil, 0, 0, errT("err.noFile")
	}
	return b, cfg.Width &^ 7, cfg.Height &^ 7, nil
}

var genThumbSem = make(chan struct{}, 3)

// genThumb: миниатюра из кэша или свежая
func genThumb(p string) ([]byte, error) {
	st, err := os.Stat(p)
	if err != nil {
		return nil, err
	}
	tp := genThumbPath(p)
	if ts, err := os.Stat(tp); err == nil && !ts.ModTime().Before(st.ModTime()) {
		return os.ReadFile(tp)
	}
	genThumbSem <- struct{}{}
	defer func() { <-genThumbSem }()
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	src, _, err := image.Decode(f)
	f.Close()
	if err != nil {
		return nil, err
	}
	b := src.Bounds()
	k := 384 / float64(max(b.Dx(), b.Dy()))
	if k > 1 {
		k = 1
	}
	dst := image.NewRGBA(image.Rect(0, 0, max(1, int(float64(b.Dx())*k+.5)), max(1, int(float64(b.Dy())*k+.5))))
	draw.Draw(dst, dst.Bounds(), &image.Uniform{color.RGBA{24, 24, 28, 255}}, image.Point{}, draw.Src)
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, b, draw.Over, nil)
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, dst, &jpeg.Options{Quality: 84}); err != nil {
		return nil, err
	}
	out := buf.Bytes()
	if os.MkdirAll(filepath.Dir(tp), 0o755) == nil {
		os.WriteFile(tp, out, 0o644)
	}
	return out, nil
}

// genExport: копия картинки в PNG (с параметрами внутри), JPG или WebP (через ffmpeg)
func genExport(ctx context.Context, ffm, src, dst, format string) error {
	switch format {
	case "png":
		b, err := os.ReadFile(src)
		if err != nil {
			return err
		}
		return os.WriteFile(dst, b, 0o644)
	case "jpg":
		f, err := os.Open(src)
		if err != nil {
			return err
		}
		img, _, err := image.Decode(f)
		f.Close()
		if err != nil {
			return err
		}
		flat := image.NewRGBA(img.Bounds()) // прозрачное — на белом
		draw.Draw(flat, flat.Bounds(), image.White, image.Point{}, draw.Src)
		draw.Draw(flat, flat.Bounds(), img, img.Bounds().Min, draw.Over)
		out, err := os.Create(dst)
		if err != nil {
			return err
		}
		if err := jpeg.Encode(out, flat, &jpeg.Options{Quality: 92}); err != nil {
			out.Close()
			return err
		}
		return out.Close()
	case "webp":
		if ffm == "" {
			return errT("whisper.noFFmpeg")
		}
		return ffQuiet(ctx, ffm, "-i", src, "-frames:v", "1", "-c:v", "libwebp", "-quality", "90", dst)
	}
	return errors.New("format")
}

func (s *Server) genGalleryRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/gen-gallery", s.api(func(w http.ResponseWriter, r *http.Request) {
		var q galQuery
		json.NewDecoder(r.Body).Decode(&q)
		writeJSON(w, genGalleryFind(genGalleryAll(genGalleryRoot()), q))
	}))

	type pathsBody struct {
		Path  string   `json:"path"`
		Paths []string `json:"paths"`
		Fav   bool     `json:"fav"`
		Fmt   string   `json:"format"`
		Text  string   `json:"text"`
	}
	read := func(r *http.Request) pathsBody {
		var b pathsBody
		json.NewDecoder(r.Body).Decode(&b)
		return b
	}
	bad := func(w http.ResponseWriter) { writeJSON(w, map[string]any{"error": tr("err.noFile")}) }

	mux.HandleFunc("/api/gen-fav", s.api(func(w http.ResponseWriter, r *http.Request) {
		b := read(r)
		if !genInGallery(b.Path) {
			bad(w)
			return
		}
		if err := genSetFav(b.Path, b.Fav); err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, map[string]any{"ok": true})
	}))

	mux.HandleFunc("/api/gen-delete", s.api(func(w http.ResponseWriter, r *http.Request) {
		b := read(r)
		var list []string
		for _, p := range b.Paths {
			if !genInGallery(p) {
				bad(w)
				return
			}
			list = append(list, p)
			if fileExists(genSidecar(p)) {
				list = append(list, genSidecar(p))
			}
		}
		if err := moveToTrash(list); err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		for _, p := range b.Paths {
			os.Remove(genThumbPath(p))
		}
		writeJSON(w, map[string]any{"ok": true})
	}))

	mux.HandleFunc("/api/gen-copy", s.api(func(w http.ResponseWriter, r *http.Request) {
		b := read(r)
		data, err := os.ReadFile(b.Path)
		if !genInGallery(b.Path) || err != nil {
			bad(w)
			return
		}
		img, err := png.Decode(bytes.NewReader(data))
		if err != nil {
			bad(w)
			return
		}
		if err := copyImage(data, genDIB(img)); err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, map[string]any{"ok": true})
	}))

	// gen-copy-text: текст (промт, настройки) в буфер обмена
	mux.HandleFunc("/api/gen-copy-text", s.api(func(w http.ResponseWriter, r *http.Request) {
		b := read(r)
		if b.Text == "" {
			bad(w)
			return
		}
		if err := copyText(b.Text); err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, map[string]any{"ok": true})
	}))

	mux.HandleFunc("/api/gen-reveal", s.api(func(w http.ResponseWriter, r *http.Request) {
		b := read(r)
		if !fileExists(b.Path) {
			bad(w)
			return
		}
		revealFile(b.Path)
		writeJSON(w, map[string]any{"ok": true})
	}))

	// gen-restore: настройки картинки для полей вкладки. Путь любой: картинку могли бросить из любой папки.
	mux.HandleFunc("/api/gen-restore", s.api(func(w http.ResponseWriter, r *http.Request) {
		b := read(r)
		f, err := os.Open(b.Path)
		if err != nil {
			bad(w)
			return
		}
		head, _ := io.ReadAll(io.LimitReader(f, 64<<20))
		f.Close()
		side, _ := os.ReadFile(genSidecar(b.Path))
		res, ok := genRestoreFrom(head, side)
		if !ok {
			writeJSON(w, map[string]any{"error": tr("ai.noParams")})
			return
		}
		writeJSON(w, map[string]any{"restore": res})
	}))

	mux.HandleFunc("/api/gen-export", s.api(func(w http.ResponseWriter, r *http.Request) {
		b := read(r)
		if !genInGallery(b.Path) || (b.Fmt != "png" && b.Fmt != "jpg" && b.Fmt != "webp") {
			bad(w)
			return
		}
		name := strings.TrimSuffix(filepath.Base(b.Path), filepath.Ext(b.Path)) + "." + b.Fmt
		dst, err := pickGenSave(b.Fmt, name)
		if err != nil || dst == "" {
			writeJSON(w, map[string]any{"cancel": true})
			return
		}
		s.mu.Lock()
		ffm := s.ffmpeg
		s.mu.Unlock()
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		if err := genExport(ctx, ffm, b.Path, dst, b.Fmt); err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, map[string]any{"ok": true, "path": dst})
	}))

	mux.HandleFunc("/gen-thumb", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if r.Host != s.host || q.Get("t") != s.token {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		p := q.Get("p")
		if !genInGallery(p) {
			http.NotFound(w, r)
			return
		}
		b, err := genThumb(p)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "image/jpeg")
		w.Header().Set("Cache-Control", "private, max-age=86400")
		w.Header().Set("Content-Length", strconv.Itoa(len(b)))
		w.Write(b)
	})
}

// genDIB: картинка в виде CF_DIB — заголовок BITMAPINFOHEADER и строки BGRA снизу вверх
func genDIB(img image.Image) []byte {
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	out := make([]byte, 40, 40+w*h*4)
	le := func(off int, v uint32) {
		out[off], out[off+1], out[off+2], out[off+3] = byte(v), byte(v>>8), byte(v>>16), byte(v>>24)
	}
	le(0, 40)
	le(4, uint32(w))
	le(8, uint32(h))
	out[12], out[14] = 1, 32 // плоскостей 1, бит на точку 32; сжатия нет (BI_RGB)
	le(20, uint32(w*h*4))
	for y := h - 1; y >= 0; y-- {
		for x := 0; x < w; x++ {
			c := color.NRGBAModel.Convert(img.At(b.Min.X+x, b.Min.Y+y)).(color.NRGBA)
			out = append(out, c.B, c.G, c.R, c.A)
		}
	}
	return out
}
