package main

// Кадры: видео в папку PNG и картинки обратно в одно видео.

import (
	"errors"
	"fmt"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// ---------- видео в PNG ----------

func fileStem(p string) string {
	return strings.TrimSuffix(filepath.Base(p), filepath.Ext(p))
}

// seqPattern: шаблон имён кадров для ffmpeg. Процент в пути он понял бы как часть шаблона.
func seqPattern(dir, src string) string {
	return strings.ReplaceAll(filepath.Join(dir, fileStem(src)), "%", "%%") + "_%06d.png"
}

// seqFrames: кадры этого исходника в папке результата. Чужие файлы сюда не попадают.
func seqFrames(dir, src string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	prefix := fileStem(src) + "_"
	var out []string
	for _, e := range entries {
		num, ok := strings.CutSuffix(strings.TrimPrefix(e.Name(), prefix), ".png")
		if e.IsDir() || !ok || !strings.HasPrefix(e.Name(), prefix) || len(num) < 6 || strings.Trim(num, "0123456789") != "" {
			continue
		}
		out = append(out, filepath.Join(dir, e.Name()))
	}
	return out
}

// seqRemove убирает кадры этого исходника и папку, если в ней больше ничего нет
func seqRemove(dir, src string) {
	for _, p := range seqFrames(dir, src) {
		os.Remove(p)
	}
	os.Remove(dir)
}

// removeResult: убрать результат неудачной или отменённой конвертации
func removeResult(f Format, src, dst string) {
	if f.Kind == "seq" {
		seqRemove(dst, src)
		return
	}
	os.Remove(dst)
}

// partPath: временный файл рядом с результатом при перезаписи. Расширение то же, по нему ffmpeg выбирает формат.
func partPath(dst string) string {
	return filepath.Join(filepath.Dir(dst), "~"+filepath.Base(dst))
}

// hasResult: результат уже есть. Для файла это непустой файл, для папки кадров — непустая папка.
func hasResult(p string) bool {
	st, err := os.Stat(p)
	if err != nil {
		return false
	}
	if !st.IsDir() {
		return st.Size() > 0
	}
	entries, err := os.ReadDir(p)
	return err == nil && len(entries) > 0
}

// ---------- картинки в видео ----------

// canJoin: в такой формат можно собрать картинки
func canJoin(req StartReq, f Format) bool {
	return req.Join && (f.moving() || f.Kind == "gif" || f.Kind == "anim")
}

// joinRate: сколько кадров в секунду просили. Пустое или неверное значение — 25.
func joinRate(req StartReq) (string, float64) {
	s := num(req.JoinFPS)
	if v, err := strconv.ParseFloat(s, 64); err == nil && v > 0 && v <= 240 {
		return s, v
	}
	return "25", 25
}

// naturalLess сравнивает имена так, как их читает человек: кадр 2 раньше кадра 10
func naturalLess(a, b string) bool {
	a, b = strings.ToLower(a), strings.ToLower(b)
	digit := func(c byte) bool { return c >= '0' && c <= '9' }
	for a != "" && b != "" {
		if digit(a[0]) && digit(b[0]) {
			i, j := 0, 0
			for i < len(a) && digit(a[i]) {
				i++
			}
			for j < len(b) && digit(b[j]) {
				j++
			}
			x, y := strings.TrimLeft(a[:i], "0"), strings.TrimLeft(b[:j], "0")
			if len(x) != len(y) {
				return len(x) < len(y)
			}
			if x != y {
				return x < y
			}
			a, b = a[i:], b[j:]
			continue
		}
		if a[0] != b[0] {
			return a[0] < b[0]
		}
		a, b = a[1:], b[1:]
	}
	return len(a) < len(b)
}

// joinGroups делит картинки из списка на будущие видео: своё на папку и тип файла (разные типы ffmpeg в один поток не склеит).
// Одиночная картинка видео не образует и конвертируется как обычно. Кадры идут по порядку имён.
func joinGroups(files []string) [][]string {
	byKey := map[string][]string{}
	var keys []string
	for _, p := range files {
		e := strings.ToLower(filepath.Ext(p))
		if !imageExt[e] {
			continue
		}
		e = strings.NewReplacer(".jpeg", ".jpg", ".tiff", ".tif").Replace(e)
		dir := strings.ToLower(filepath.Dir(p))
		if isTemp(p) { // перетащенные файлы лежат каждый в своей временной папке
			dir = strings.ToLower(dropDir())
		}
		key := dir + "|" + e
		if byKey[key] == nil {
			keys = append(keys, key)
		}
		byKey[key] = append(byKey[key], p)
	}
	var out [][]string
	for _, key := range keys {
		g := byKey[key]
		if len(g) < 2 {
			continue
		}
		slices.SortFunc(g, func(a, b string) int {
			switch x, y := filepath.Base(a), filepath.Base(b); {
			case naturalLess(x, y):
				return -1
			case naturalLess(y, x):
				return 1
			}
			return strings.Compare(a, b)
		})
		out = append(out, g)
	}
	return out
}

// joinLeads: кадр → первый кадр его видео. По первому кадру страница показывает состояние всех строк группы.
func joinLeads(req StartReq) map[string]string {
	if !canJoin(req, formats[req.Format]) {
		return nil
	}
	leads := map[string]string{}
	for _, g := range joinGroups(req.Files) {
		for _, p := range g {
			leads[p] = g[0]
		}
	}
	return leads
}

var frameTailRe = regexp.MustCompile(`[\s._-]*\d+$`)

// joinStem: имя будущего видео. clip_000001.png → clip, а если имя из одних цифр — по имени папки.
func joinStem(first string) string {
	if s := frameTailRe.ReplaceAllString(fileStem(first), ""); s != "" {
		return s
	}
	if isTemp(first) {
		return "video"
	}
	return filepath.Base(filepath.Dir(first))
}

// writeFrameList пишет список кадров для ffmpeg. Длительностей в нём нет: время внутри списка округляется
// до шага 1/25 с, и при другой частоте кадры терялись бы. Частоту задаёт -r перед -i (buildArgs).
func writeFrameList(frames []string) (string, error) {
	var b strings.Builder
	b.WriteString("ffconcat version 1.0\n")
	for _, p := range frames {
		abs, err := filepath.Abs(p)
		if err != nil {
			return "", err
		}
		name := strings.ReplaceAll(filepath.ToSlash(abs), "'", `'\''`)
		fmt.Fprintf(&b, "file '%s'\n", name)
	}
	f, err := os.CreateTemp("", "konv-frames-*.txt")
	if err != nil {
		return "", err
	}
	defer f.Close()
	if _, err := f.WriteString(b.String()); err != nil {
		os.Remove(f.Name())
		return "", err
	}
	return f.Name(), nil
}

// checkFrameSizes: ffmpeg молча растянул бы кадр другого размера под первый.
// Смотрим только заголовки PNG и JPEG, поэтому это быстро и на тысячах кадров. Другие типы не проверяются.
func checkFrameSizes(frames []string) error {
	var w, h int
	for _, p := range frames {
		f, err := os.Open(p)
		if err != nil {
			return err
		}
		c, _, err := image.DecodeConfig(f)
		f.Close()
		if errors.Is(err, image.ErrFormat) {
			return nil
		}
		if err != nil {
			continue // повреждённый файл: про него скажет сам ffmpeg
		}
		if w == 0 {
			w, h = c.Width, c.Height
			continue
		}
		if c.Width != w || c.Height != h {
			return errT("seq.sizes", filepath.Base(p), c.Width, c.Height, w, h)
		}
	}
	return nil
}
