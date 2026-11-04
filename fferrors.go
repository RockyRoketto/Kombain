package main

// Понятный текст ошибок ffmpeg: friendlyErr для человека, errSummary для лога.

import (
	"regexp"
	"strings"
)

// friendlyErr переводит типичные ошибки ffmpeg на человеческий
func friendlyErr(stderr string, err error) string {
	low := strings.ToLower(stderr)
	has := func(ss ...string) bool {
		for _, x := range ss {
			if strings.Contains(low, x) {
				return true
			}
		}
		return false
	}
	switch {
	case has("no space left"):
		return "На диске кончилось место."
	case has("permission denied", "access is denied"):
		return "Нет доступа к файлу или папке. Возможно, файл открыт в другой программе, или в эту папку нельзя писать — выбери другую."
	case has("no such file or directory"):
		return "Файл не найден — его переместили, переименовали или удалили."
	case has("invalid data found when processing input", "moov atom not found"):
		return "Файл повреждён или недокачан, ffmpeg не смог его прочитать."
	case has("does not contain any stream", "matches no streams", "stream map", "output file is empty"):
		return "В файле нет нужной дорожки: например, у аудиофайла нет картинки для видео или GIF."
	case has("unknown encoder", "encoder not found"):
		return "В этой сборке ffmpeg нет нужного кодека. Обнови ffmpeg."
	case has("not divisible by 2", "width not divisible", "height not divisible"):
		return "Неудобное разрешение для кодека (нечётная ширина или высота). Попробуй указать высоту, например 720."
	case has("too many packets buffered", "non monotonous dts", "non-monotonic dts"):
		return "Внутри файла сбиты метки времени. Попробуй другой формат или «MKV без перекодирования»."
	case has("unrecognized option", "error splitting the argument list", "option not found"):
		return "Ошибка в своих аргументах ffmpeg — проверь поле «Свои аргументы»."
	case has("could not open encoder", "error while opening encoder", "incorrect parameters"):
		return "Кодек не принял параметры (разрешение, частота кадров или звук). Попробуй другую высоту/FPS или другой формат."
	case has("error opening input", "error opening input file"):
		return "Не удалось открыть файл."
	}
	if err != nil && stderr == "" {
		return "ffmpeg не запустился: " + err.Error()
	}
	return "ffmpeg не справился с этим файлом. Подробности — в логе."
}

// errSummary: самые полезные строки ошибки (сначала причина, а не последствия)
var addrRe = regexp.MustCompile(` @ 0x[0-9a-f]+\]`)

func errSummary(stderr string, err error, max int) string {
	var key, rest []string
	seen := map[string]bool{}
	for _, l := range strings.Split(strings.TrimSpace(stderr), "\n") {
		l = strings.TrimSpace(addrRe.ReplaceAllString(l, "]"))
		if l == "" || seen[l] {
			continue
		}
		seen[l] = true
		low := strings.ToLower(l)
		if strings.Contains(low, "additional information") || strings.Contains(low, "failed") ||
			strings.Contains(low, "unsupported") || strings.Contains(low, "not supported") ||
			strings.Contains(low, "invalid") || strings.Contains(low, "no such") || strings.Contains(low, "unrecognized") {
			key = append(key, l)
		} else {
			rest = append(rest, l)
		}
	}
	lines := append(key, rest...)
	if len(lines) == 0 {
		return err.Error()
	}
	if len(lines) > max {
		lines = lines[:max]
	}
	return strings.Join(lines, "\n    ")
}
