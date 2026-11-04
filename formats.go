package main

// Форматы вывода: аргументы ffmpeg по каждому формату, выбор формата в режиме «Сжать», список медиа-расширений.

import (
	"path/filepath"
	"strings"
)

type Format struct {
	Ext  string
	Kind string // video, audio, image, gif, copy
	Args []string
}

var formats = map[string]Format{
	"mp4":     {"mp4", "video", []string{"-c:v", "libx264", "-preset", "{preset}", "-crf", "{crf}", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "{abr}k", "-movflags", "+faststart"}},
	"mp4h265": {"mp4", "video", []string{"-c:v", "libx265", "-preset", "{preset}", "-crf", "{crf}", "-pix_fmt", "yuv420p", "-tag:v", "hvc1", "-c:a", "aac", "-b:a", "{abr}k", "-movflags", "+faststart"}},
	"webm":    {"webm", "video", []string{"-c:v", "libvpx-vp9", "-crf", "{crf}", "-b:v", "0", "-c:a", "libopus", "-b:a", "{abr}k"}},
	"mov":     {"mov", "video", []string{"-c:v", "libx264", "-preset", "{preset}", "-crf", "{crf}", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "{abr}k"}},
	"mkv":     {"mkv", "copy", []string{"-c", "copy"}},
	"gif":     {"gif", "gif", nil},
	"mp3":     {"mp3", "audio", []string{"-vn", "-c:a", "libmp3lame", "-b:a", "{abr}k"}},
	"m4a":     {"m4a", "audio", []string{"-vn", "-c:a", "aac", "-b:a", "{abr}k"}},
	"ogg":     {"ogg", "audio", []string{"-vn", "-c:a", "libopus", "-b:a", "{abr}k"}},
	"wav":     {"wav", "audio", []string{"-vn", "-c:a", "pcm_s16le"}},
	"flac":    {"flac", "audio", []string{"-vn", "-c:a", "flac"}},
	"png":     {"png", "image", nil},
	"jpg":     {"jpg", "image", []string{"-q:v", "2"}},
	"webp":    {"webp", "image", []string{"-quality", "85"}},
	"small":   {"", "compress", nil}, // «Сжать»: формат выбирается по исходнику, см. compressFormat
}

// compressFormat: во что сжимать файл в режиме «Сжать». Видео → MP4, картинки и звук — в свой же формат
// (WAV/FLAC/WMA → MP3, BMP/TIFF → PNG без потерь). Пустой Ext — сжимать не умеем, причина во втором значении.
func compressFormat(src string, req StartReq) (Format, string) {
	switch strings.ToLower(filepath.Ext(src)) {
	case ".jpg", ".jpeg":
		return Format{"jpg", "image", []string{"-q:v", "4"}}, ""
	case ".png", ".bmp", ".tif", ".tiff":
		return Format{"png", "image", []string{"-compression_level", "9", "-pred", "mixed"}}, ""
	case ".webp":
		return Format{"webp", "image", []string{"-quality", "80"}}, ""
	case ".gif":
		return Format{}, "GIF не сжимаю — сделай из него MP4, будет в разы меньше"
	case ".mp3", ".wav", ".flac", ".wma":
		return formats["mp3"], ""
	case ".m4a", ".aac":
		return formats["m4a"], ""
	case ".ogg", ".opus":
		return formats["ogg"], ""
	}
	if req.Codec == "h264" {
		return formats["mp4"], ""
	}
	return formats["mp4h265"], ""
}

var presets = map[string]bool{"ultrafast": true, "veryfast": true, "fast": true, "medium": true, "slow": true}

var mediaExt = map[string]bool{
	".mp4": true, ".mov": true, ".mkv": true, ".avi": true, ".webm": true, ".flv": true, ".wmv": true,
	".m4v": true, ".mpg": true, ".mpeg": true, ".ts": true, ".mts": true, ".3gp": true, ".gif": true,
	".mp3": true, ".wav": true, ".flac": true, ".m4a": true, ".aac": true, ".ogg": true, ".opus": true,
	".wma": true, ".png": true, ".jpg": true, ".jpeg": true, ".webp": true, ".bmp": true, ".tif": true, ".tiff": true,
}
