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
	case has("dimensions too small"):
		return tr("ff.tooSmall")
	case has("no space left"):
		return tr("ff.noSpace")
	case has("permission denied", "access is denied"):
		return tr("ff.denied")
	case has("no such file or directory"):
		return tr("ff.notFound")
	case has("invalid data found when processing input", "moov atom not found"):
		return tr("ff.corrupt")
	case has("does not contain any stream", "matches no streams", "stream map", "output file is empty"):
		return tr("ff.noStream")
	case has("unknown encoder", "encoder not found"):
		return tr("ff.noEncoder")
	case has("not divisible by 2", "width not divisible", "height not divisible"):
		return tr("ff.oddSize")
	case has("too many packets buffered", "non monotonous dts", "non-monotonic dts"):
		return tr("ff.timestamps")
	case has("unrecognized option", "error splitting the argument list", "option not found"):
		return tr("ff.badArgs")
	case has("could not open encoder", "error while opening encoder", "incorrect parameters"):
		return tr("ff.badParams")
	case has("error opening input", "error opening input file"):
		return tr("ff.cantOpen")
	}
	if err != nil && stderr == "" {
		return tr("ff.notStarted", err.Error())
	}
	return tr("ff.generic")
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
