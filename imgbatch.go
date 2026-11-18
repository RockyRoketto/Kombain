package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// «Пакет картинок» в «Утилитах»: размер, формат, качество, метаданные и водяной знак для любых картинок с диска.
// Всё делает ffmpeg по одной картинке; результат рядом с оригиналом с суффиксом -edit, оригинал не меняется.

type imgOpts struct {
	Resize  string `json:"resize"`  // "" не менять | width | height | fit (длинная сторона) | percent
	Value   int    `json:"value"`   // пикселей или процентов
	NoUp    bool   `json:"noUp"`    // не увеличивать маленькие
	Format  string `json:"format"`  // "" как был | jpg | png | webp
	Quality int    `json:"quality"` // 1..100 для jpg и webp
	Strip   bool   `json:"strip"`   // убрать метаданные (EXIF, GPS, камера)
	WmPath  string `json:"wmPath"`  // водяной знак: картинка, лучше PNG с прозрачностью
	WmPos   string `json:"wmPos"`   // tl tr bl br c
	WmSize  int    `json:"wmSize"`  // ширина знака, % ширины картинки
	WmAlpha int    `json:"wmAlpha"` // непрозрачность знака, %
	OutDir  string `json:"outDir"`  // "" рядом с оригиналом (имя-edit) | папка для результатов
}

func imgFileOK(p string) bool {
	switch strings.ToLower(filepath.Ext(p)) {
	case ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".gif":
		return true
	}
	return false
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// imgOutExt: расширение результата
func imgOutExt(src string, o imgOpts) string {
	switch o.Format {
	case "jpg":
		return ".jpg"
	case "png":
		return ".png"
	case "webp":
		return ".webp"
	}
	switch e := strings.ToLower(filepath.Ext(src)); e {
	case ".jpeg":
		return ".jpg"
	case ".png", ".jpg", ".webp":
		return e
	}
	return ".png" // bmp, tiff и gif без смены формата уходят в PNG
}

// imgOutPath: без OutDir (или если OutDir та же папка) результат лежит рядом с суффиксом -edit,
// в другую папку кладётся под тем же именем; занятое имя получает номер
func imgOutPath(src string, o imgOpts) string {
	base := strings.TrimSuffix(src, filepath.Ext(src)) + "-edit"
	if d := strings.TrimSpace(o.OutDir); d != "" && !strings.EqualFold(filepath.Clean(d), filepath.Clean(filepath.Dir(src))) {
		name := strings.TrimSuffix(filepath.Base(src), filepath.Ext(src))
		base = filepath.Join(d, name)
	}
	ext := imgOutExt(src, o)
	out := base + ext
	for i := 2; fileExists(out); i++ {
		out = fmt.Sprintf("%s-%d%s", base, i, ext)
	}
	return out
}

// imgScaleExpr: фильтр размера или "" если менять нечего
func imgScaleExpr(o imgOpts) string {
	n := clampInt(o.Value, 1, 20000)
	switch o.Resize {
	case "width":
		if o.NoUp {
			return fmt.Sprintf("scale=w='min(%d,iw)':h=-1:flags=lanczos", n)
		}
		return fmt.Sprintf("scale=w=%d:h=-1:flags=lanczos", n)
	case "height":
		if o.NoUp {
			return fmt.Sprintf("scale=w=-1:h='min(%d,ih)':flags=lanczos", n)
		}
		return fmt.Sprintf("scale=w=-1:h=%d:flags=lanczos", n)
	case "fit":
		if o.NoUp {
			return fmt.Sprintf("scale=w='if(gte(iw,ih),min(%d,iw),-1)':h='if(gte(iw,ih),-1,min(%d,ih))':flags=lanczos", n, n)
		}
		return fmt.Sprintf("scale=w='if(gte(iw,ih),%d,-1)':h='if(gte(iw,ih),-1,%d)':flags=lanczos", n, n)
	case "percent":
		p := clampInt(o.Value, 1, 400)
		if p == 100 {
			return ""
		}
		if o.NoUp && p > 100 {
			return ""
		}
		return fmt.Sprintf("scale=w='max(1,round(iw*%d/100))':h='max(1,round(ih*%d/100))':flags=lanczos", p, p)
	}
	return ""
}

func imgWmXY(pos string) (string, string) {
	const m = "W*0.02"
	switch pos {
	case "tl":
		return m, m
	case "tr":
		return "W-w-" + m, m
	case "bl":
		return m, "H-h-" + m
	case "c":
		return "(W-w)/2", "(H-h)/2"
	}
	return "W-w-" + m, "H-h-" + m // br
}

// imgArgs: аргументы ffmpeg для одной картинки
func imgArgs(in, out string, o imgOpts) []string {
	ext := strings.ToLower(filepath.Ext(out))
	chain := []string{}
	if sc := imgScaleExpr(o); sc != "" {
		chain = append(chain, sc)
	}
	var args []string
	args = append(args, "-i", in)
	wm := o.WmPath != ""
	if wm {
		args = append(args, "-i", o.WmPath)
	}
	// JPEG не умеет прозрачность: кладём на белый, иначе прозрачное станет чёрным
	flatten := ext == ".jpg"
	parts := []string{}
	cur := "0:v"
	n := 0
	next := func() string { n++; return fmt.Sprintf("v%d", n) }
	if len(chain) > 0 {
		nx := next()
		parts = append(parts, fmt.Sprintf("[%s]%s[%s]", cur, strings.Join(chain, ","), nx))
		cur = nx
	}
	if wm {
		a := clampInt(o.WmAlpha, 5, 100)
		s := clampInt(o.WmSize, 2, 100)
		x, y := imgWmXY(o.WmPos)
		parts = append(parts, fmt.Sprintf("[1:v]format=rgba,colorchannelmixer=aa=%.2f[wa]", float64(a)/100))
		parts = append(parts,
			fmt.Sprintf("[%s]split[ref][rf]", cur),
			fmt.Sprintf("[wa][rf]scale=w='rw*%d/100':h=-1[wb]", s)) // нужен ffmpeg 8+: scale с опорным входом
		parts = append(parts, fmt.Sprintf("[ref][wb]overlay=x='%s':y='%s':format=auto[%s]", x, y, "v"+fmt.Sprint(n+1)))
		n++
		cur = fmt.Sprintf("v%d", n)
	}
	if flatten {
		nx := next()
		parts = append(parts,
			fmt.Sprintf("[%s]split[fa][fb]", cur),
			"[fa]drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill[fw]",
			fmt.Sprintf("[fw][fb]overlay=format=auto,format=yuvj420p[%s]", nx))
		cur = nx
	}
	if len(parts) > 0 {
		args = append(args, "-filter_complex", strings.Join(parts, ";"), "-map", "["+cur+"]")
	}
	q := clampInt(o.Quality, 1, 100)
	if q == 0 {
		q = 85
	}
	switch ext {
	case ".jpg":
		args = append(args, "-c:v", "mjpeg", "-q:v", fmt.Sprint(clampInt(2+(100-q)*29/100, 2, 31)))
	case ".webp":
		args = append(args, "-c:v", "libwebp", "-quality", fmt.Sprint(q))
	case ".png":
		args = append(args, "-c:v", "png", "-compression_level", "9")
	}
	if o.Strip {
		args = append(args, "-map_metadata", "-1", "-fflags", "+bitexact")
	}
	args = append(args, "-frames:v", "1", "-update", "1", out)
	return args
}

func runImgFile(ctx context.Context, ffm, in string, o imgOpts) (string, error) {
	out := imgOutPath(in, o)
	if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
		return "", err
	}
	if err := ffQuiet(ctx, ffm, imgArgs(in, out, o)...); err != nil {
		os.Remove(out)
		return "", err
	}
	if fileSize(out) == 0 {
		os.Remove(out)
		return "", fmt.Errorf("%s", tr("img.empty"))
	}
	return out, nil
}

func (s *Server) imgBatchRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/img-file", s.api(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Path string  `json:"path"`
			Opts imgOpts `json:"opts"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if !imgFileOK(body.Path) || !fileExists(body.Path) {
			writeJSON(w, map[string]any{"error": tr("err.noFile")})
			return
		}
		if s.ffmpeg == "" {
			writeJSON(w, map[string]any{"error": tr("whisper.noFFmpeg")})
			return
		}
		if body.Opts.WmPath != "" && !fileExists(body.Opts.WmPath) {
			writeJSON(w, map[string]any{"error": tr("img.noWm")})
			return
		}
		out, err := runImgFile(r.Context(), s.ffmpeg, body.Path, body.Opts)
		if err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, map[string]any{"ok": true, "path": out})
	}))
}
