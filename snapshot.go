package main

// Сохранение кадра в PNG: кадр берётся из исходного файла в полном разрешении, а не снимком с экрана,
// поэтому и при показе через копию для просмотра (proxy.go) получается оригинал.

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var (
	alphaModeRe = regexp.MustCompile(`(?im)^\s*alpha_mode\s*:\s*1\s*$`)
	startRe     = regexp.MustCompile(`Duration: [^\n]*?, start: (\d+(?:\.\d+)?)`)
	deepPixRe   = regexp.MustCompile(`\b\w*p(9|1[0246])(le|be)\b|\brgba64\w*|\bya16\w*`)
)

// snapPlan читает вывод `ffmpeg -i`: каким декодером открыть файл и в каком формате писать PNG.
// Пустой формат: ffmpeg подберёт сам, без лишнего канала (rgb24, rgb48be, а pal8 сохранит палитру с прозрачностью).
func snapPlan(probeOut string) (decoder, pixFmt string) {
	_, rest, found := strings.Cut(probeOut, "Video:")
	if !found {
		return "", ""
	}
	line, meta, _ := strings.Cut(rest, "\n")
	meta, _, _ = strings.Cut(meta, "Stream #")
	alpha := false
	// VP8 и VP9 хранят прозрачность отдельно, и встроенные декодеры её отбрасывают: ffmpeg пишет yuv420p и метку alpha_mode
	if alphaModeRe.MatchString(meta) {
		switch codec := strings.Fields(line); {
		case len(codec) > 0 && codec[0] == "vp9":
			decoder, alpha = "libvpx-vp9", true
		case len(codec) > 0 && strings.TrimSuffix(codec[0], ",") == "vp8":
			decoder, alpha = "libvpx", true
		}
	}
	if m := alphaRe.FindString(line); m != "" && m != "pal8" {
		alpha = true
	}
	switch {
	case !alpha:
		return decoder, ""
	case deepPixRe.MatchString(line):
		return decoder, "rgba64be"
	}
	return decoder, "rgba"
}

// snapName: видео_00-01-23-456.png
func snapName(src string, at float64) string {
	stem := strings.TrimSuffix(filepath.Base(src), filepath.Ext(src))
	ms := int64(at*1000 + .5)
	return fmt.Sprintf("%s_%02d-%02d-%02d-%03d.png", stem, ms/3600000, ms/60000%60, ms/1000%60, ms%1000)
}

// snapArgs пишет кадры от from до at включительно поверх одного файла: в нём остаётся последний.
// Так выходит кадр, который виден в момент at. Обычный -ss отдал бы следующий, если at попало между кадрами.
func snapArgs(src, dst, decoder, pixFmt string, from, at float64) []string {
	args := []string{"-hide_banner", "-loglevel", "error", "-nostdin", "-y"}
	if decoder != "" {
		args = append(args, "-c:v", decoder)
	}
	// фильтр trim, а не -t: -t до -i неточен, а после -i время округляется до длины кадра, и нужный кадр может не пройти
	args = append(args, "-ss", strconv.FormatFloat(from, 'f', 6, 64), "-i", src, "-map", "0:v:0",
		"-vf", "trim=end="+strconv.FormatFloat(at-from+.0005, 'f', 6, 64), "-fps_mode", "passthrough")
	if pixFmt != "" {
		args = append(args, "-pix_fmt", pixFmt)
	}
	return append(args, "-update", "1", "-c:v", "png", "-f", "image2", dst)
}

// snapPublish даёт готовому файлу свободное имя: существующий файл не перезаписывается никогда
func snapPublish(tmp, dst string) (string, error) {
	stem := strings.TrimSuffix(dst, ".png")
	for n := 0; n < 10000; n++ {
		p := dst
		if n > 0 {
			p = fmt.Sprintf("%s (%d).png", stem, n)
		}
		f, err := os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		if err != nil {
			return "", err
		}
		f.Close()
		if err := os.Rename(tmp, p); err != nil {
			os.Remove(p)
			return "", err
		}
		return p, nil
	}
	return "", os.ErrExist
}

// saveFrame сохраняет рядом с оригиналом кадр, который плеер показывает в момент at. Время в имени файла то же, что в плеере.
// Копия для просмотра (proxy) всегда начинается с нуля, а оригинал плеер показывает по его собственным меткам времени.
func saveFrame(ffm, src string, at float64, proxy bool) (string, error) {
	if !fileExists(src) {
		return "", errors.New(tr("media.notFound"))
	}
	_, probeOut := runQuiet(ffm, 20*time.Second, "-hide_banner", "-i", src)
	decoder, pixFmt := snapPlan(string(probeOut))
	fps := parseMediaInfo(string(probeOut)).FPS
	if fps <= 0 {
		fps = 25
	}
	dir := filepath.Dir(src)
	if isTemp(src) { // перетащенный файл: его папка временная
		dir = defaultOut()
		os.MkdirAll(dir, 0o755)
	}
	at = max(at, 0)
	seek := at
	if m := startRe.FindSubmatch(probeOut); m != nil && !proxy {
		if start, _ := strconv.ParseFloat(string(m[1]), 64); start > 0 {
			seek = max(at-start, 0) // -ss считает от начала файла
		}
	}
	tmp := filepath.Join(dir, fmt.Sprintf(".frame-%d.tmp", time.Now().UnixNano()))
	defer os.Remove(tmp)
	// Обычно хватает пары кадров. Запас растёт для редких кадров: слайд-шоу или звук длиннее видео.
	for _, back := range []float64{2.5 / fps, 2, 30} {
		from := max(seek-back, 0)
		_, e := runQuiet(ffm, time.Minute, snapArgs(src, tmp, decoder, pixFmt, from, seek)...)
		if fileSize(tmp) > 0 {
			return snapPublish(tmp, filepath.Join(dir, snapName(src, at)))
		}
		if from == 0 {
			if msg := strings.TrimSpace(string(e)); msg != "" {
				return "", errors.New(msg)
			}
			break
		}
	}
	return "", errors.New(tr("snap.noFrame"))
}
