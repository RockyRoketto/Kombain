package main

// Файлы и папки: где что лежит, поиск ffmpeg, разбор выбранных путей, имя результата.

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

func ffName() string {
	if runtime.GOOS == "windows" {
		return "ffmpeg.exe"
	}
	return "ffmpeg"
}

func dataDir() string {
	d, err := os.UserCacheDir()
	if err != nil {
		d = os.TempDir()
	}
	return filepath.Join(d, "ffmpeg-batch")
}

// сюда копируются файлы, перетащенные в окно браузера (пути у них недоступны)
func dropDir() string { return filepath.Join(dataDir(), "drop") }

func defaultOut() string {
	home, err := os.UserHomeDir()
	if err != nil {
		home = os.TempDir()
	}
	return filepath.Join(home, "Videos", "Konvertor")
}

func isTemp(p string) bool {
	rel, err := filepath.Rel(dropDir(), p)
	return err == nil && rel != "." && !filepath.IsAbs(rel) && !strings.HasPrefix(rel, "..")
}

func cleanupTemp(p string) {
	d := filepath.Dir(p)
	if isTemp(p) && d != dropDir() {
		os.RemoveAll(d)
	}
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

func fileSize(p string) int64 {
	if st, err := os.Stat(p); err == nil {
		return st.Size()
	}
	return 0
}

// порядок: скачанный программой (его она умеет обновлять) → рядом с exe → PATH
func findFFmpeg() string {
	p := filepath.Join(dataDir(), ffName())
	if fileExists(p) {
		return p
	}
	if exe, err := os.Executable(); err == nil {
		p := filepath.Join(filepath.Dir(exe), ffName())
		if fileExists(p) {
			return p
		}
	}
	if p, err := exec.LookPath("ffmpeg"); err == nil {
		return p
	}
	return ""
}

func infos(paths []string) []FileInfo {
	res := make([]FileInfo, 0, len(paths))
	for _, p := range paths {
		res = append(res, FileInfo{Path: p, Size: fileSize(p)})
	}
	return res
}

func walkMedia(dir string) []FileInfo {
	var found []string
	filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() && mediaExt[strings.ToLower(filepath.Ext(p))] {
			found = append(found, p)
		}
		return nil
	})
	return infos(found)
}

// expandPaths: файлы берём как есть, папки разворачиваем в медиафайлы
func expandPaths(paths []string) []FileInfo {
	var out []FileInfo
	seen := map[string]bool{}
	for _, p := range paths {
		st, err := os.Stat(p)
		if err != nil {
			continue
		}
		var list []FileInfo
		if st.IsDir() {
			list = walkMedia(p)
		} else {
			list = []FileInfo{{Path: p, Size: st.Size()}}
		}
		for _, f := range list {
			if !seen[f.Path] {
				seen[f.Path] = true
				out = append(out, f)
			}
		}
	}
	return out
}

func openFolder(dir string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("explorer", dir)
	case "darwin":
		cmd = exec.Command("open", dir)
	default:
		cmd = exec.Command("xdg-open", dir)
	}
	cmd.Start()
}

var badName = regexp.MustCompile(`[<>:"/\\|?*\x00-\x1f]`)

func safeName(n string) string {
	n = badName.ReplaceAllString(filepath.Base(strings.ReplaceAll(n, "\\", "/")), "_")
	n = strings.Trim(n, " .")
	if n == "" {
		n = "file"
	}
	return n
}

func outPath(src string, req StartReq, ext string, used map[string]bool) string {
	stem := strings.TrimSuffix(filepath.Base(src), filepath.Ext(src))
	od := strings.TrimSpace(req.OutDir)
	folder := filepath.Dir(src)
	switch {
	case isTemp(src): // перетащенные файлы: у них нет исходной папки
		switch {
		case od != "" && !req.SameDir:
			folder = od
		case strings.TrimSpace(req.DropOut) != "":
			folder = strings.TrimSpace(req.DropOut)
		default:
			folder = defaultOut()
		}
	case od != "" && !req.SameDir:
		folder = od
	}
	// путь из поля ввода может быть относительным, а два прохода работают из временной папки
	if abs, err := filepath.Abs(folder); err == nil {
		folder = abs
	}
	os.MkdirAll(folder, 0o755)
	copyMode := req.Copy && !req.Overwrite
	for n := 0; ; n++ {
		name := stem
		switch {
		case n >= 1 && copyMode:
			name = fmt.Sprintf("%s (%d)", stem, n)
		case n == 1:
			name = stem + "_converted"
		case n > 1:
			name = fmt.Sprintf("%s_converted_%d", stem, n)
		}
		dst := filepath.Join(folder, name+"."+ext)
		key := strings.ToLower(dst)
		if strings.EqualFold(dst, src) || used[key] || (copyMode && fileSize(dst) > 0) {
			continue
		}
		used[key] = true
		return dst
	}
}
