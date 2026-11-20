package main

// Увеличение картинки нейросетью Real-ESRGAN (×2 и ×4). Считает sd-cli из пакета движка sd.cpp в режиме
// -M upscale: модель картинок для этого не нужна, процесс живёт секунды и с выходом отдаёт видеопамять.
// Модель всегда даёт ×4; ×2 — это ×4 с уменьшением (Catmull-Rom), так чище, чем растянуть вдвое.
// Прозрачность sd-cli (сборка master-1086) теряет, поэтому альфа растягивается здесь отдельно и
// накладывается обратно, а прозрачные места перед увеличением заливаются цветом соседних краёв (иначе по
// контуру вылезает тёмная кайма). Пиксельный стиль увеличивается без нейросети, «по пикселям».

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	xdraw "golang.org/x/image/draw"
)

// upMaxSide: больше по стороне не увеличиваем (4096² RGBA — уже 64 МБ в памяти, а PNG 8192² весит сотни МБ)
const upMaxSide = 8192

// upDrawnStyles: стили, где рисованная модель (anime_6B) чище и вдвое быстрее фото-модели
var upDrawnStyles = map[string]bool{"illus": true, "icon3d": true, "flat": true, "anime": true, "comic": true, "lowpoly": true, "minimal": true,
	"cartoon": true, "popart": true, "ink": true, "render3d": true, "isometric": true, "sticker": true, "flaticon": true, "lineart": true, "poster": true, "blueprint": true}

func upCLI() string { return filepath.Join(aiEngineDir("sd"), "sd-cli.exe") }

// upModelPath: файл модели увеличения; drawn — для рисунков. Нет нужной — берём любую установленную.
func upModelPath(drawn bool) string {
	var alt string
	for _, m := range aiLoadInstalled().Models {
		if m.Kind != "upscale" {
			continue
		}
		for _, f := range m.Files {
			p := filepath.Join(aiModelsDir(), filepath.FromSlash(f.Path))
			if f.Role != "upscale" || !fileExists(p) {
				continue
			}
			if strings.Contains(strings.ToLower(filepath.Base(p)), "anime") == drawn {
				return p
			}
			if alt == "" {
				alt = p
			}
		}
	}
	return alt
}

// upReady: движок и хотя бы одна модель на месте
func upReady() bool { return fileExists(upCLI()) && upModelPath(false) != "" }

// upFits: влезет ли результат в upMaxSide
func upFits(w, h, f int) bool { return w*f <= upMaxSide && h*f <= upMaxSide }

// upHasAlpha: есть ли хоть один не совсем непрозрачный пиксель
func upHasAlpha(img *image.NRGBA) bool {
	for i := 3; i < len(img.Pix); i += 4 {
		if img.Pix[i] != 255 {
			return true
		}
	}
	return false
}

// upFillRGB: непрозрачная копия, где цвет совсем прозрачных точек взят у ближайших видимых (размытие с весом альфы,
// радиусы растут, пока не заполнится всё). Полупрозрачные края свой цвет сохраняют: его уже поправил bgDefringe.
func upFillRGB(img *image.NRGBA) *image.NRGBA {
	w, h := img.Rect.Dx(), img.Rect.Dy()
	out := image.NewNRGBA(image.Rect(0, 0, w, h))
	copy(out.Pix, img.Pix)
	n := w * h
	pm := make([]float64, n*4) // R·a, G·a, B·a, a — одним массивом для bgBoxBlur4
	todo := 0
	for i := 0; i < n; i++ {
		al := float64(img.Pix[i*4+3]) / 255
		for k := 0; k < 3; k++ {
			pm[i*4+k] = float64(img.Pix[i*4+k]) * al
		}
		pm[i*4+3] = al
		if img.Pix[i*4+3] == 0 {
			todo++
		}
	}
	for r := 4; todo > 0; r *= 2 {
		bl := bgBoxBlur4(pm, w, h, r)
		for i := 0; i < n; i++ {
			ba := bl[i*4+3]
			if out.Pix[i*4+3] != 0 || ba < 1e-6 {
				continue
			}
			for k := 0; k < 3; k++ {
				out.Pix[i*4+k] = uint8(min(255, max(0, bl[i*4+k]/ba+.5)))
			}
			out.Pix[i*4+3] = 1 // помечено: заполнено (ниже станет 255)
			todo--
		}
		if r >= max(w, h) { // радиус накрыл всю картинку: дальше заливать нечем (вся прозрачная)
			break
		}
	}
	for i := 0; i < n; i++ {
		out.Pix[i*4+3] = 255
	}
	return out
}

// upScale: картинка src, растянутая до w×h; nearest — по пикселям, без сглаживания
func upScale(src image.Image, w, h int, k xdraw.Interpolator) *image.NRGBA {
	dst := image.NewNRGBA(image.Rect(0, 0, w, h))
	k.Scale(dst, dst.Bounds(), src, src.Bounds(), xdraw.Src, nil)
	return dst
}

// upPNG: PNG побыстрее (4096² по умолчанию жмётся несколько секунд)
func upPNG(img image.Image) ([]byte, error) {
	var b bytes.Buffer
	err := (&png.Encoder{CompressionLevel: png.BestSpeed}).Encode(&b, img)
	return b.Bytes(), err
}

// upRunCLI: один прогон sd-cli. Вывод идёт в журнал: при ошибке в нём видно, что не так.
var upRunCLI = func(ctx context.Context, model, in, out string) error {
	logf, _ := os.Create(filepath.Join(aiLogDir(), "sd-upscale.log"))
	if logf != nil {
		defer logf.Close()
	}
	cmd := exec.CommandContext(ctx, upCLI(), "-M", "upscale", "--upscale-model", model, "-i", in, "-o", out)
	cmd.Dir = filepath.Dir(upCLI())
	if logf != nil {
		cmd.Stdout, cmd.Stderr = logf, logf
	}
	hide(cmd)
	if err := cmd.Run(); err != nil {
		return errT("ai.upscaleFailed", err)
	}
	if !fileExists(out) {
		return errT("ai.upscaleFailed", "no output")
	}
	return nil
}

// upImage: увеличить картинку data в f раз (2 или 4); style — стиль генератора (по нему выбирается модель).
// Возвращает PNG. Видеокарту не делит: вызывать под aiWork.
func upImage(ctx context.Context, data []byte, f int, style string) ([]byte, error) {
	if f != 2 && f != 4 {
		return nil, fmt.Errorf("factor %d", f)
	}
	im, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, errT("err.noFile")
	}
	src := bgToNRGBA(im)
	w, h := src.Rect.Dx(), src.Rect.Dy()
	if !upFits(w, h, f) {
		return nil, errT("up.tooBig", upMaxSide)
	}
	if style == "pixel" {
		return upPNG(upScale(src, w*f, h*f, xdraw.NearestNeighbor))
	}
	model := upModelPath(upDrawnStyles[style])
	if model == "" || !fileExists(upCLI()) {
		return nil, errT("up.notInstalled")
	}
	tmp, err := os.MkdirTemp(aiRoot(), "up-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tmp)
	if !bgShareGPU() {
		// на карте меньше 24 ГБ модель картинок или обработчик фона уходят, пока идёт увеличение
		// (обработчик фона гасим сами и дожидаемся: его release выгружает в фоне)
		bgSrv.Stop()
		aiGPU.take("up", nil)
		defer aiGPU.drop("up")
	}
	return upWith(src, f, tmp, func(in, out string) error { return upRunCLI(ctx, model, in, out) })
}

// upWith: сама обработка вокруг нейросети run (×4 из файла in в файл out; в проверках — подставная).
// Прозрачные места заливаются цветом краёв, альфа растягивается отдельно; ×2 — уменьшенный ×4.
func upWith(src *image.NRGBA, f int, tmp string, run func(in, out string) error) ([]byte, error) {
	w, h := src.Rect.Dx(), src.Rect.Dy()
	alpha := upHasAlpha(src)
	in, out := filepath.Join(tmp, "in.png"), filepath.Join(tmp, "out.png")
	feed := image.Image(src)
	if alpha {
		feed = upFillRGB(src)
	}
	b, err := upPNG(feed)
	if err == nil {
		err = os.WriteFile(in, b, 0o644)
	}
	if err != nil {
		return nil, err
	}
	if err := run(in, out); err != nil {
		return nil, err
	}
	ob, err := os.ReadFile(out)
	if err != nil {
		return nil, err
	}
	if f == 4 && !alpha {
		return ob, nil
	}
	big, err := png.Decode(bytes.NewReader(ob))
	if err != nil {
		return nil, errT("ai.upscaleFailed", err)
	}
	res := bgToNRGBA(big)
	if f == 2 {
		res = upScale(res, w*2, h*2, xdraw.CatmullRom)
	}
	if alpha {
		al := image.NewAlpha(image.Rect(0, 0, w, h))
		for i := 0; i < w*h; i++ {
			al.Pix[i] = src.Pix[i*4+3]
		}
		ra := image.NewAlpha(res.Rect)
		xdraw.BiLinear.Scale(ra, ra.Rect, al, al.Rect, xdraw.Src, nil)
		for i := range ra.Pix {
			res.Pix[i*4+3] = ra.Pix[i]
		}
	}
	return upPNG(res)
}

// upGallerySave: увеличенная картинка — новая запись галереи рядом с исходной (<имя>-x2.png), параметры исходной.
func upGallerySave(src string, data []byte, f int) (string, error) {
	return genDerive(src, fmt.Sprintf("-x%d", f), data, func(m *GenMeta) { m.Upscale = max(m.Upscale, 1) * f })
}

// outStem: путь без расширения; при выбранной папке dir (не пустой) файл кладётся в неё под тем же именем
func outStem(src, dir string) string {
	stem := strings.TrimSuffix(src, filepath.Ext(src))
	if d := strings.TrimSpace(dir); d != "" {
		stem = filepath.Join(d, strings.TrimSuffix(filepath.Base(src), filepath.Ext(src)))
	}
	return stem
}

// upOutPath: куда класть увеличенную копию произвольного файла: рядом, <имя>-x2.png, существующие не трогаем
func upOutPath(src string, f int, dir string) string {
	base := fmt.Sprintf("%s-x%d", outStem(src, dir), f)
	out := base + ".png"
	for i := 2; fileExists(out); i++ {
		out = fmt.Sprintf("%s-%d.png", base, i)
	}
	return out
}

// upStyleOf: вид картинки из «Утилит» → стиль для upImage (по нему выбирается модель): photo — фото-модель,
// drawn — рисованная, pixel — без нейросети
func upStyleOf(kind string) string {
	switch kind {
	case "drawn":
		return "illus"
	case "pixel":
		return "pixel"
	}
	return ""
}

func (s *Server) upRoutes(mux *http.ServeMux) {
	// «Увеличить» в «Утилитах»: любая картинка с диска, результат — PNG рядом с оригиналом.
	// Обрыв запроса («Стоп») останавливает sd-cli.
	mux.HandleFunc("/api/up-file", s.api(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Path   string `json:"path"`
			Factor int    `json:"factor"`
			Kind   string `json:"kind"`
			OutDir string `json:"outDir"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if !bgFileOK(body.Path) || !fileExists(body.Path) {
			writeJSON(w, map[string]any{"error": tr("err.noFile")})
			return
		}
		if body.Kind != "pixel" && !upReady() {
			writeJSON(w, map[string]any{"error": tr("up.notInstalled"), "needModel": true})
			return
		}
		data, err := os.ReadFile(body.Path)
		if err == nil {
			aiWork.Lock()
			data, err = upImage(r.Context(), data, body.Factor, upStyleOf(body.Kind))
			aiWork.Unlock()
		}
		out := upOutPath(body.Path, body.Factor, body.OutDir)
		if err == nil && strings.TrimSpace(body.OutDir) != "" {
			err = os.MkdirAll(filepath.Dir(out), 0o755)
		}
		if err == nil {
			err = writeFileAtomic(out, data)
		}
		if err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, map[string]any{"ok": true, "path": out})
	}))

	// «Увеличить ×2 / ×4» у картинки галереи
	mux.HandleFunc("/api/gen-up", s.api(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Path   string `json:"path"`
			Factor int    `json:"factor"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if !genInGallery(body.Path) || !fileExists(body.Path) {
			writeJSON(w, map[string]any{"error": tr("err.noFile")})
			return
		}
		if !upReady() {
			writeJSON(w, map[string]any{"error": tr("up.notInstalled"), "needModel": true})
			return
		}
		var style string
		if b, err := os.ReadFile(genSidecar(body.Path)); err == nil {
			var m GenMeta
			if json.Unmarshal(b, &m) == nil && m.Request != nil {
				style = m.Request.Preset
			}
		}
		data, err := os.ReadFile(body.Path)
		if err == nil {
			// генератор рисует: ждём конца его задачи
			aiWork.Lock()
			data, err = upImage(r.Context(), data, body.Factor, style)
			aiWork.Unlock()
		}
		var p string
		if err == nil {
			p, err = upGallerySave(body.Path, data, body.Factor)
		}
		if err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, map[string]any{"ok": true, "path": p})
	}))
}
