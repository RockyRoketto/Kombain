package main

// Референсы вкладки «Генератор»: до 8 картинок, у каждой роль и «насколько похоже».
// «Основа» (base) — img2img: картинка подгоняется под выбранную пропорцию и рисуется поверх (одна на запрос).
// «Стиль» и «Персонаж» помощник с глазами (mmproj) описывает словами и вплетает в промт (llm.go), поэтому они
// работают с любой моделью картинок. Картинки лежат в <ai>\refs\<id>.png, id — начало sha256 исходного файла.

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"image"
	"image/draw"
	_ "image/gif"
	_ "image/jpeg"
	"image/png"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

// GenRef: референс в запросе. Weight — «насколько похоже», 0…1.
type GenRef struct {
	ID     string  `json:"id"`
	Role   string  `json:"role"` // style, character, base
	Weight float64 `json:"weight"`
}

const (
	genRefMax     = 8                   // плиток в блоке
	genRefSide    = 1536                // длинная сторона хранимой картинки
	genRefMaxSize = 40 << 20            // больше не принимаем
	genRefKeep    = 60 * 24 * time.Hour // столько хранится референс, к которому не обращались
)

var (
	genRefRoles = []string{"style", "character", "base"}
	reRefID     = regexp.MustCompile(`^[0-9a-f]{16}$`)
)

func genRefPath(id string) string {
	if !reRefID.MatchString(id) {
		return ""
	}
	return filepath.Join(aiRefsDir(), id+".png")
}

// genRefSave: картинка любого обычного формата → PNG в папке референсов (длинная сторона не больше genRefSide)
func genRefSave(b []byte) (string, int, int, error) {
	img, _, err := image.Decode(bytes.NewReader(b))
	if err != nil {
		return "", 0, 0, errT("gn.ref.bad")
	}
	if r := img.Bounds(); r.Dx() < 32 || r.Dy() < 32 {
		return "", 0, 0, errT("gn.ref.bad")
	}
	img = genRefFit(img, genRefSide)
	sum := sha256.Sum256(b)
	id := hex.EncodeToString(sum[:8])
	p := genRefPath(id)
	if !fileExists(p) {
		os.MkdirAll(aiRefsDir(), 0o755)
		var out bytes.Buffer
		if err := png.Encode(&out, img); err != nil {
			return "", 0, 0, err
		}
		if err := writeFileAtomic(p, out.Bytes()); err != nil {
			return "", 0, 0, err
		}
		go genRefPrune()
	} else {
		now := time.Now()
		os.Chtimes(p, now, now)
	}
	return id, img.Bounds().Dx(), img.Bounds().Dy(), nil
}

// genRefPrune: убрать референсы, которыми давно не пользовались
func genRefPrune() {
	list, _ := os.ReadDir(aiRefsDir())
	for _, e := range list {
		if st, err := e.Info(); err == nil && time.Since(st.ModTime()) > genRefKeep && strings.HasSuffix(e.Name(), ".png") {
			os.Remove(filepath.Join(aiRefsDir(), e.Name()))
		}
	}
}

// genRefFit: уменьшить так, чтобы длинная сторона была не больше side
func genRefFit(img image.Image, side int) image.Image {
	r := img.Bounds()
	w, h := r.Dx(), r.Dy()
	if max(w, h) <= side {
		return img
	}
	if w >= h {
		w, h = side, max(1, h*side/w)
	} else {
		w, h = max(1, w*side/h), side
	}
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	xdraw.CatmullRom.Scale(dst, dst.Bounds(), img, r, draw.Src, nil)
	return dst
}

func genRefLoad(id string) (image.Image, error) {
	p := genRefPath(id)
	if p == "" {
		return nil, errT("gn.ref.gone")
	}
	f, err := os.Open(p)
	if err != nil {
		return nil, errT("gn.ref.gone")
	}
	defer f.Close()
	img, err := png.Decode(f)
	if err != nil {
		return nil, errT("gn.ref.gone")
	}
	return img, nil
}

// genRefRead: PNG референса, уменьшенный до side (0 — как хранится)
func genRefRead(id string, side int) ([]byte, error) {
	img, err := genRefLoad(id)
	if err != nil {
		return nil, err
	}
	var out bytes.Buffer
	err = png.Encode(&out, genRefFit(img, side))
	return out.Bytes(), err
}

// genRefCover: картинка ровно w×h — растянута с сохранением пропорций до заполнения, лишнее срезано по краям
func genRefCover(img image.Image, w, h int) image.Image {
	r := img.Bounds()
	sw, sh := r.Dx(), r.Dy()
	// какая часть исходника попадёт в кадр
	cw, ch := sw, sw*h/w
	if ch > sh {
		cw, ch = sh*w/h, sh
	}
	x0, y0 := r.Min.X+(sw-cw)/2, r.Min.Y+(sh-ch)/2
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	xdraw.CatmullRom.Scale(dst, dst.Bounds(), img, image.Rect(x0, y0, x0+cw, y0+ch), draw.Src, nil)
	return dst
}

// genRefBase: PNG «Основы» под размер будущей картинки
func genRefBase(id string, w, h int) ([]byte, error) {
	img, err := genRefLoad(id)
	if err != nil {
		return nil, err
	}
	var out bytes.Buffer
	err = png.Encode(&out, genRefCover(img, w, h))
	return out.Bytes(), err
}

// genRefStrength: «насколько похоже» → сила img2img (0 — копия основы, 1 — с нуля).
// Совсем копию не даём (иначе рисовать нечего), совсем с нуля — тоже (иначе основа не видна).
// Замер 2026-11-13 (SDXL): при 0,48 маяк на основу-пейзаж не встал, композиция осталась как была;
// поэтому середина ползунка — 0,65: новое появляется, расположение пятен и цвета основы остаются.
func genRefStrength(w float64) float64 {
	return min(max(0.95-w*0.6, 0.35), 0.95)
}

// genRefCharSide: сторона картинки «Персонажа», которую видит FLUX.2 klein (больше — дольше, похожее не становится)
const genRefCharSide = 1024

// genRefChars: картинки «Персонажей» для модели, которая берёт референсы сама (FLUX.2 klein), и строка для
// промта, которая на них ссылается. Словами (llm.go) лицо не передать: по описанию «мужчина 30 лет, борода,
// жилет» модель рисует похожего человека в той же одежде, но другого (жалоба автора 2026-11-20 «референсы не
// работают»). Ручная проверка klein 4B 2026-11-20: с картинкой выходят то же лицо, причёска и одежда и в чужом
// стиле (3D-иконка). «Стиль» картинкой не передаётся: klein рисовала обычное фото, поэтому он остаётся словами.
// «Лёгкий намёк» (меньше трети ползунка) — только словами.
func genRefChars(refs []GenRef) (imgs [][]byte, note string, err error) {
	var nums []string
	for _, r := range refs {
		if r.Role != "character" || r.Weight < 0.34 {
			continue
		}
		b, err := genRefRead(r.ID, genRefCharSide)
		if err != nil {
			return nil, "", err
		}
		imgs = append(imgs, b)
		nums = append(nums, "image "+strconv.Itoa(len(imgs)))
	}
	if len(imgs) == 0 {
		return nil, "", nil
	}
	note = "The character has the same face, hair, body and clothes as the person in reference " + strings.Join(nums, " and ") + "."
	return imgs, note, nil
}

// genRefsClean: только годные референсы: известная роль, файл на месте, не больше genRefMax, одна «Основа»
func genRefsClean(refs []GenRef) []GenRef {
	var out []GenRef
	base := false
	for _, r := range refs {
		if len(out) == genRefMax {
			break
		}
		p := genRefPath(r.ID)
		if p == "" || !fileExists(p) || !genRefRole(r.Role) || r.Role == "base" && base {
			continue
		}
		base = base || r.Role == "base"
		r.Weight = min(max(r.Weight, 0), 1)
		out = append(out, r)
	}
	return out
}

func genRefRole(s string) bool {
	for _, r := range genRefRoles {
		if r == s {
			return true
		}
	}
	return false
}

// genRefBaseOf: «Основа» среди референсов
func genRefBaseOf(refs []GenRef) (GenRef, bool) {
	for _, r := range refs {
		if r.Role == "base" {
			return r, true
		}
	}
	return GenRef{}, false
}

func (s *Server) genRefRoutes(mux *http.ServeMux) {
	// новая картинка: тело — сам файл (перетаскивание, буфер, выбор файла) или {"path"} картинки из галереи
	mux.HandleFunc("/api/gen-ref", s.api(func(w http.ResponseWriter, r *http.Request) {
		var b []byte
		var err error
		if strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
			var body struct {
				Path string `json:"path"`
			}
			json.NewDecoder(r.Body).Decode(&body)
			if !genInGallery(body.Path) {
				writeJSON(w, map[string]any{"error": tr("err.noFile")})
				return
			}
			b, err = os.ReadFile(body.Path)
		} else {
			b, err = io.ReadAll(http.MaxBytesReader(w, r.Body, genRefMaxSize))
			var tooBig *http.MaxBytesError
			if errors.As(err, &tooBig) {
				err = errT("gn.ref.big")
			}
		}
		if err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		id, iw, ih, err := genRefSave(b)
		if err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, map[string]any{"id": id, "w": iw, "h": ih})
	}))

	// картинка плитки
	mux.HandleFunc("/gen-ref", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if r.Host != s.host || q.Get("t") != s.token {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		p := genRefPath(q.Get("id"))
		if p == "" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Cache-Control", "max-age=86400")
		http.ServeFile(w, r, p)
	})
}
