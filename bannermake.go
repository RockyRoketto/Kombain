package main

// «Сборка баннеров» в «Утилитах»: одна картинка ложится на все шаблоны баннеров (web/bannerbg),
// результат — папка матча <корень>\<месяц>\<день>\<матч>\ с подпапками png, jpeg и webp.
// Страница шлёт картинку один раз (bmk-begin), потом баннеры по одному (bmk-one), чтобы показывать ход.

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"image/draw"
	"image/png"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	xdraw "golang.org/x/image/draw"
)

// bmkSlot: шаблон и его сейв-зона X, Y, ZW×ZH: туда вписывается непрозрачная часть картинки, по центру,
// не выходя за зону ни по ширине, ни по высоте. Зоны сняты с образцов автора «сейв зоны»: где нарисованы
// красные полосы (315x250, отступ 45 px сверху и снизу), зона между ними; у остальных — по белой подложке
// картинки на образце. Цветные заливки на образцах — место фона, не картинки.
type bmkSlot struct {
	Name string `json:"name"`
	W    int    `json:"w"`
	H    int    `json:"h"`
	X    int    `json:"x"`
	Y    int    `json:"y"`
	ZW   int    `json:"zw"`
	ZH   int    `json:"zh"`
	Site bool   `json:"site"` // JPEG и WebP нужны только для баннеров сайта (bannerNames)
}

var bmkSlots = []bmkSlot{
	{"4056x496_R", 4056, 496, 3333, 21, 548, 461, false},
	{"2008x328_R", 2008, 328, 1781, 77, 218, 184, false},
	{"1380x248_R", 1380, 248, 1038, 16, 260, 219, false},
	{"1030x460_R", 1030, 460, 680, 100, 307, 253, false},
	{"925x460_R", 925, 460, 554, 114, 280, 236, false},
	{"945x370_R", 945, 370, 568, 69, 280, 236, false},
	{"800x260_R", 800, 260, 513, 56, 180, 152, false},
	{"344x157_R", 344, 157, 223, 32, 97, 80, false},
	{"344x157_C", 344, 157, 119, 34, 110, 92, false},
	{"315x250", 315, 250, 0, 45, 315, 160, false},
	{"640x640", 640, 640, 187, 146, 273, 229, false},
	{"1080x390", 1080, 390, 482, 58, 120, 100, false},
	{"180x180", 180, 180, 51, 56, 81, 68, false},
	{"105x167", 105, 167, 27, 9, 53, 44, false},
}

// Подпапки матча
var bmkSub = [3]string{"png", "jpeg", "webp"}

// Site: баннер из списка старой вкладки «Баннеры», его JPEG и WebP заказчик грузит на сайт
func init() {
	for i := range bmkSlots {
		bmkSlots[i].Site = bannerWanted(bmkSlots[i].Name+".png") != ""
	}
}

func bmkSlotOf(name string) (bmkSlot, bool) {
	for _, s := range bmkSlots {
		if s.Name == name {
			return s, true
		}
	}
	return bmkSlot{}, false
}

// bmkMatchName: имя папки матча из того, что ввёл человек. Запрещённые в Windows знаки — пробелом,
// лишние пробелы и точки по краям убираем. "" — имени нет.
func bmkMatchName(s string) string {
	s = badName.ReplaceAllString(s, " ")
	s = strings.Join(strings.Fields(s), " ")
	s = strings.Trim(s, " .")
	switch strings.ToUpper(s) {
	case "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "LPT1", "LPT2", "LPT3":
		return ""
	}
	if len([]rune(s)) > 120 {
		s = strings.TrimRight(string([]rune(s)[:120]), " .")
	}
	return s
}

// bmkDir: папка матча. Месяц и день всегда двумя цифрами (11, 03), чтобы папки шли по порядку.
func bmkDir(root string, month, day int, match string) (string, error) {
	root = strings.TrimSpace(root)
	switch {
	case root == "" || !filepath.IsAbs(root):
		return "", errT("bmk.noRoot")
	case month < 1 || month > 12 || day < 1 || day > bmkDays(month):
		return "", errT("bmk.badDate")
	}
	m := bmkMatchName(match)
	if m == "" {
		return "", errT("bmk.noMatch")
	}
	return filepath.Join(root, fmt.Sprintf("%02d", month), fmt.Sprintf("%02d", day), m), nil
}

// bmkDays: дней в месяце; у февраля 29, год в пути не участвует
func bmkDays(month int) int {
	switch month {
	case 2:
		return 29
	case 4, 6, 9, 11:
		return 30
	}
	return 31
}

// bmkTrim: непрозрачная часть картинки (альфа больше 8 из 255). Совсем прозрачная — вся картинка.
func bmkTrim(img image.Image) image.Image {
	b := img.Bounds()
	x0, y0, x1, y1 := b.Max.X, b.Max.Y, b.Min.X-1, b.Min.Y-1
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			if _, _, _, a := img.At(x, y).RGBA(); a > 8*257 {
				if x < x0 {
					x0 = x
				}
				if x > x1 {
					x1 = x
				}
				if y < y0 {
					y0 = y
				}
				if y > y1 {
					y1 = y
				}
			}
		}
	}
	if x1 < x0 {
		return img
	}
	r := image.Rect(x0, y0, x1+1, y1+1)
	if r == b {
		return img
	}
	if si, ok := img.(interface {
		SubImage(image.Rectangle) image.Image
	}); ok {
		return si.SubImage(r)
	}
	return img
}

// bmkAdj: правка из редактора. K — размер (1 — вписана в зону), DX и DY — сдвиг центра в долях ширины и высоты зоны
type bmkAdj struct {
	K  float64 `json:"k"`
	DX float64 `json:"dx"`
	DY float64 `json:"dy"`
}

// ok: без правки или с разумной (размер 0.04–9: общая правка 0.2–3 на свою 0.2–3; сдвиг не дальше 16 ширин или высот зоны: у длинных баннеров до края до 8)
func (a bmkAdj) norm() bmkAdj {
	if a.K == 0 {
		a.K = 1
	}
	a.K = min(max(a.K, 0.04), 9)
	a.DX, a.DY = min(max(a.DX, -16), 16), min(max(a.DY, -16), 16)
	return a
}

// bmkFit: где картинка aw×ah встанет в баннер: вписана в сейв-зону слота по центру, потом правка adj.
// Так же считает bmFit в web/js/bannermake.js.
func bmkFit(sl bmkSlot, aw, ah int, adj bmkAdj) image.Rectangle {
	if aw <= 0 || ah <= 0 {
		return image.Rectangle{}
	}
	adj = adj.norm()
	zw, zh := float64(sl.ZW), float64(sl.ZH)
	k := math.Min(zw/float64(aw), zh/float64(ah))
	w, h := float64(aw)*k, float64(ah)*k
	w, h = math.Max(1, math.Round(w*adj.K)), math.Max(1, math.Round(h*adj.K))
	cx, cy := float64(sl.X)+zw/2+adj.DX*zw, float64(sl.Y)+zh/2+adj.DY*zh
	x, y := int(math.Round(cx-w/2)), int(math.Round(cy-h/2))
	return image.Rect(x, y, x+int(w), y+int(h))
}

// bmkCompose: шаблон с картинкой art в его слоте
func bmkCompose(sl bmkSlot, art image.Image, adj bmkAdj) (*image.NRGBA, error) {
	raw, err := webFS.ReadFile("web/bannerbg/" + sl.Name + ".png")
	if err != nil {
		return nil, err
	}
	tpl, err := png.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	dst := image.NewNRGBA(image.Rect(0, 0, sl.W, sl.H))
	draw.Draw(dst, dst.Bounds(), tpl, tpl.Bounds().Min, draw.Src)
	ab := art.Bounds()
	xdraw.CatmullRom.Scale(dst, bmkFit(sl, ab.Dx(), ab.Dy(), adj), art, ab, xdraw.Over, nil)
	return dst, nil
}

// одна сборка за раз: картинка из bmk-begin живёт, пока не пришла следующая
var bmk struct {
	sync.Mutex
	id  string
	dir string
	art image.Image
}

// bmkOthers: какие матчи уже лежат в папке дня
func bmkOthers(day, except string) []string {
	ents, _ := os.ReadDir(day)
	var out []string
	for _, e := range ents {
		if e.IsDir() && !strings.EqualFold(e.Name(), except) {
			out = append(out, e.Name())
		}
	}
	sort.Strings(out)
	return out
}

// bmkOne собирает баннер name: PNG (больше 500 КБ — в 256 цветов, как во вкладке «Баннеры»),
// у баннеров сайта ещё JPEG и WebP не больше 500 КБ.
func bmkOne(ctx context.Context, ffm, dir string, art image.Image, name string, adj bmkAdj) (map[string]any, error) {
	sl, ok := bmkSlotOf(name)
	if !ok {
		return nil, errT("err.badRequest")
	}
	img, err := bmkCompose(sl, art, adj)
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	if err := (&png.Encoder{CompressionLevel: png.BestCompression}).Encode(&buf, img); err != nil {
		return nil, err
	}
	pngPath := filepath.Join(dir, bmkSub[0], name+".png")
	if err := writeFileAtomic(pngPath, buf.Bytes()); err != nil {
		return nil, err
	}
	res := map[string]any{"ok": true}
	if fileSize(pngPath) > bannerLimit {
		if _, err := shrinkPNG(ctx, ffm, pngPath); err != nil {
			return nil, fmt.Errorf("%s: %w", tr("banner.shrinkFailed"), err)
		}
		res["colors"] = true
	}
	res["png"] = fileSize(pngPath)
	if !sl.Site {
		return res, nil
	}
	jpg := filepath.Join(dir, bmkSub[1], name+".jpg")
	jfit, err := fitUnderLimit(ctx, bannerJpgQ, func(q int) error { return encJpg(ctx, ffm, pngPath, jpg, q) }, jpg)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", tr("banner.jpgFailed"), err)
	}
	webp := filepath.Join(dir, bmkSub[2], name+".webp")
	wfit, err := fitUnderLimit(ctx, bannerWebpQ, func(q int) error { return encWebp(ctx, ffm, pngPath, webp, q) }, webp)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", tr("banner.webpFailed"), err)
	}
	res["jpg"], res["webp"] = fileSize(jpg), fileSize(webp)
	res["jpgBig"], res["webpBig"] = !jfit, !wfit
	return res, nil
}

func (s *Server) bmkRoutes(mux *http.ServeMux) {
	// шаблоны для просмотра на странице
	mux.HandleFunc("/bannerbg/", func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/bannerbg/"), ".png")
		if _, ok := bmkSlotOf(name); r.Host != s.host || !ok {
			http.NotFound(w, r)
			return
		}
		b, err := webFS.ReadFile("web/bannerbg/" + name + ".png")
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Cache-Control", "max-age=86400")
		w.Write(b)
	})

	mux.HandleFunc("/api/bmk-list", s.api(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"slots": bmkSlots})
	}))

	// куда лягут баннеры и что из папок уже есть
	mux.HandleFunc("/api/bmk-check", s.api(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Root  string `json:"root"`
			Month int    `json:"month"`
			Day   int    `json:"day"`
			Match string `json:"match"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		root := strings.TrimSpace(body.Root)
		out := map[string]any{"rootOk": root != "" && filepath.IsAbs(root) && dirExists(root)}
		if body.Month >= 1 && body.Month <= 12 && root != "" {
			mon := filepath.Join(root, fmt.Sprintf("%02d", body.Month))
			day := filepath.Join(mon, fmt.Sprintf("%02d", body.Day))
			out["monthOk"], out["dayOk"] = dirExists(mon), dirExists(day)
			m := bmkMatchName(body.Match)
			out["others"] = bmkOthers(day, m)
			out["matchName"] = m
		}
		if dir, err := bmkDir(root, body.Month, body.Day, body.Match); err == nil {
			out["dir"], out["matchOk"] = dir, dirExists(dir)
		}
		writeJSON(w, out)
	}))

	// картинка (PNG в base64) и папка: создаёт папки и запоминает картинку для bmk-one
	mux.HandleFunc("/api/bmk-begin", s.api(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Root  string `json:"root"`
			Month int    `json:"month"`
			Day   int    `json:"day"`
			Match string `json:"match"`
			Image []byte `json:"image"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, map[string]any{"error": tr("err.badRequest")})
			return
		}
		root := strings.TrimSpace(body.Root)
		dir, err := bmkDir(root, body.Month, body.Day, body.Match)
		if err == nil && !dirExists(root) {
			err = errT("bmk.noRoot")
		}
		if err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		art, _, err := image.Decode(bytes.NewReader(body.Image))
		if err != nil {
			writeJSON(w, map[string]any{"error": tr("bmk.badImage")})
			return
		}
		for _, sub := range bmkSub {
			if err := os.MkdirAll(filepath.Join(dir, sub), 0o755); err != nil {
				writeJSON(w, map[string]any{"error": err.Error()})
				return
			}
		}
		var id [8]byte
		rand.Read(id[:])
		bmk.Lock()
		bmk.id, bmk.dir, bmk.art = hex.EncodeToString(id[:]), dir, bmkTrim(art)
		out := map[string]any{"id": bmk.id, "dir": dir}
		bmk.Unlock()
		writeJSON(w, out)
	}))

	mux.HandleFunc("/api/bmk-one", s.api(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			ID   string `json:"id"`
			Name string `json:"name"`
			Adj  bmkAdj `json:"adj"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		bmk.Lock()
		dir, art, cur := bmk.dir, bmk.art, bmk.id
		bmk.Unlock()
		if body.ID == "" || body.ID != cur || art == nil {
			writeJSON(w, map[string]any{"error": tr("err.badRequest")})
			return
		}
		s.mu.Lock()
		ffm := s.ffmpeg
		s.mu.Unlock()
		if ffm == "" {
			writeJSON(w, map[string]any{"error": tr("err.ffmpegMissing")})
			return
		}
		res, err := bmkOne(r.Context(), ffm, dir, art, body.Name, body.Adj)
		if err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, res)
	}))
}
