package main

// Вкладка «Баннеры»: набор PNG одного проекта одной кнопкой.
// 1) любой PNG больше 500 КБ уменьшаем до размера из имени (1380x248_R → 1380×248) и перезаписываем,
//    если всё ещё больше — переводим в 256 цветов;
// 2) файлы из списка bannerNames → JPG в одну папку;
// 3) эти JPG → WebP в другую папку.

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

var bannerNames = []string{
	"4056x496_R", "2008x328_R", "1380x248_R", "1030x460_R", "800x260_R",
	"925x460_R", "945x370_R", "344x157_R", "344x157_C", "315x250",
}

const bannerLimit = 500 << 10 // PNG больше этого пережимаем

type BannerReq struct {
	Files   []string `json:"files"`
	JpgDir  string   `json:"jpgDir"`
	WebpDir string   `json:"webpDir"`
}

// x в имени бывает латинская, «×» или русская «х»
var bannerX = regexp.MustCompile(`[×хХ]`)
var bannerSize = regexp.MustCompile(`(\d+)x(\d+)`)

// bannerKey: имя без расширения в нижнем регистре, с латинской x и без пробелов
func bannerKey(path string) string {
	n := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	n = bannerX.ReplaceAllString(strings.ToLower(n), "x")
	return strings.Join(strings.Fields(n), "")
}

// bannerWanted: имя из списка, которому соответствует файл, или ""
func bannerWanted(path string) string {
	k := bannerKey(path)
	for _, n := range bannerNames {
		if strings.ToLower(n) == k {
			return n
		}
	}
	return ""
}

// bannerDims: ширина и высота из имени файла («4056x496_R» → 4056, 496)
func bannerDims(path string) (string, string, bool) {
	m := bannerSize.FindStringSubmatch(bannerKey(path))
	if m == nil {
		return "", "", false
	}
	return m[1], m[2], true
}

func ffQuiet(ctx context.Context, ffm string, args ...string) error {
	args = append([]string{"-hide_banner", "-nostdin", "-loglevel", "error", "-y"}, args...)
	cmd := exec.CommandContext(ctx, ffm, args...)
	hide(cmd)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s", errSummary(string(out), err, 2))
	}
	return nil
}

// shrinkPNG уменьшает PNG до размера из имени и перезаписывает его. Возвращает, что сделано.
func shrinkPNG(ctx context.Context, ffm, src string) (string, error) {
	w, h, ok := bannerDims(src)
	if !ok {
		return "", fmt.Errorf("в имени нет размера вида 800x260 — не знаю, до какого уменьшать")
	}
	dir, name := filepath.Dir(src), filepath.Base(src)
	tmp, tmp2 := filepath.Join(dir, "_tmp_"+name), filepath.Join(dir, "_tmp2_"+name)
	defer os.Remove(tmp)
	defer os.Remove(tmp2)
	if err := ffQuiet(ctx, ffm, "-i", src, "-vf", "scale="+w+":"+h+":flags=lanczos",
		"-frames:v", "1", "-compression_level", "9", "-pred", "mixed", tmp); err != nil {
		return "", err
	}
	done, out := "уменьшен до "+w+"×"+h, tmp
	if fileSize(tmp) > bannerLimit {
		if err := ffQuiet(ctx, ffm, "-i", tmp, "-filter_complex",
			"split[a][b];[a]palettegen=max_colors=256[p];[b][p]paletteuse=dither=none", "-frames:v", "1", tmp2); err != nil {
			return "", err
		}
		done, out = done+", 256 цветов", tmp2
	}
	if err := os.Rename(out, src); err != nil {
		return "", err
	}
	return done, nil
}

func (s *Server) runBanners(req BannerReq, ffm string) {
	ctx, cancel := context.WithCancel(context.Background())
	var states []*FileState
	wanted := map[string]int{} // имя из списка → номер файла (дубли не берём)
	for i, p := range req.Files {
		st := &FileState{Path: p, Name: filepath.Base(p), Status: "pending", SrcSize: fileSize(p)}
		if n := bannerWanted(p); n != "" {
			if _, dup := wanted[n]; dup {
				st.Msg = "такое имя уже есть в списке — беру первый файл"
			} else {
				wanted[n] = i
				st.Dst = filepath.Join(req.JpgDir, strings.TrimSuffix(st.Name, filepath.Ext(st.Name))+".jpg")
			}
		}
		states = append(states, st)
	}
	s.mu.Lock()
	s.files = states
	s.batch = "banner"
	s.running = true
	s.cancel = cancel
	s.summary = ""
	s.mu.Unlock()

	os.MkdirAll(req.JpgDir, 0o755)
	os.MkdirAll(req.WebpDir, 0o755)
	var ok, shrunk, bad int
	fail := func(i int, what string, err error) {
		bad++
		s.set(i, func(fs *FileState) { fs.Status = "error"; fs.Msg = what; fs.Hint = what + ": " + err.Error() })
		s.addLog("[ошибка] %s — %s: %v", states[i].Name, what, err)
	}
	for i, st := range states {
		if ctx.Err() != nil {
			break
		}
		s.set(i, func(fs *FileState) { fs.Status = "running" })
		var notes []string
		if st.Msg != "" {
			notes = append(notes, st.Msg)
		}
		if st.SrcSize > bannerLimit {
			if isTemp(st.Path) {
				notes = append(notes, "больше 500 КБ, но это копия из браузера — оригинал не пережат")
			} else if done, err := shrinkPNG(ctx, ffm, st.Path); err != nil {
				if ctx.Err() == nil {
					fail(i, "не удалось пережать PNG", err)
				}
				continue
			} else {
				shrunk++
				notes = append(notes, fmt.Sprintf("PNG %s → %s, %s", fmtKB(st.SrcSize), fmtKB(fileSize(st.Path)), done))
				s.addLog("[png] %s: %s", st.Name, notes[len(notes)-1])
			}
		}
		if st.Dst != "" {
			stem := strings.TrimSuffix(st.Name, filepath.Ext(st.Name))
			webp := filepath.Join(req.WebpDir, stem+".webp")
			if err := ffQuiet(ctx, ffm, "-i", st.Path, "-frames:v", "1", "-q:v", "2", st.Dst); err != nil {
				if ctx.Err() == nil {
					fail(i, "не получился JPG", err)
				}
				continue
			}
			if err := ffQuiet(ctx, ffm, "-i", st.Dst, "-frames:v", "1", "-c:v", "libwebp", "-quality", "80", webp); err != nil {
				if ctx.Err() == nil {
					fail(i, "не получился WebP", err)
				}
				continue
			}
			ok++
			notes = append(notes, fmt.Sprintf("JPG %s · WebP %s", fmtKB(fileSize(st.Dst)), fmtKB(fileSize(webp))))
			s.addLog("[ok] %s → JPG + WebP", st.Name)
		} else if bannerWanted(st.Path) == "" {
			notes = append(notes, "не из списка — только проверка размера")
		}
		msg := strings.Join(notes, " · ")
		s.set(i, func(fs *FileState) { fs.Status = "ok"; fs.Pct = 100; fs.Msg = msg; fs.DstSize = fileSize(fs.Path) })
	}

	s.mu.Lock()
	canc := false
	for _, fs := range s.files {
		if fs.Status == "pending" || fs.Status == "running" {
			fs.Status = "canceled"
			canc = true
		}
	}
	title := "Готово"
	if canc {
		title = "Остановлено"
	}
	s.summary = fmt.Sprintf("%s: JPG и WebP — %d из %d, пережато PNG %d, ошибок %d", title, ok, len(wanted), shrunk, bad)
	s.running = false
	s.cancel = nil
	s.mu.Unlock()
	cancel()
	s.addLog("%s", s.summary)
}

func fmtKB(n int64) string { return fmt.Sprintf("%d КБ", (n+512)>>10) }
