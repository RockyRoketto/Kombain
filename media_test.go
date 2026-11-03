package main

import (
	"os"
	"os/exec"
	"testing"
)

func TestParseMediaInfo(t *testing.T) {
	out := `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'a.mov':
  Duration: 00:01:23.45, start: 0.000000, bitrate: 3093 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1920x1080 [SAR 1:1 DAR 16:9], 2947 kb/s, 29.97 fps, 30 tbr
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 128 kb/s`
	mi := parseMediaInfo(out)
	if mi.W != 1920 || mi.H != 1080 || mi.VCodec != "h264" || mi.ACodec != "aac" || mi.AHz != 48000 || mi.ACh != "stereo" || mi.FPS != 29.97 || mi.Dur < 83.4 || mi.Dur > 83.5 {
		t.Fatalf("%+v", mi)
	}
	mp3 := `  Duration: 00:03:00.00, start: 0.025057, bitrate: 320 kb/s
  Stream #0:0: Audio: mp3 (mp3float), 44100 Hz, stereo, fltp, 320 kb/s
  Stream #0:1: Video: mjpeg (Baseline), yuvj420p(pc, bt470bg/unknown/unknown), 500x500 [SAR 1:1 DAR 1:1], 90k tbr, 90k tbn (attached pic)`
	mi = parseMediaInfo(mp3)
	if !mi.Cover || mi.ACodec != "mp3" || mi.W != 500 {
		t.Fatalf("%+v", mi)
	}
}

// с настоящим ffmpeg (если есть в системе): превью видео и волна звука
func TestThumbs(t *testing.T) {
	ffm, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("нет ffmpeg")
	}
	dir := t.TempDir()
	v, a := dir+"/v.mp4", dir+"/a.mp3"
	if exec.Command(ffm, "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x240:d=3", "-pix_fmt", "yuv420p", v).Run() != nil ||
		exec.Command(ffm, "-v", "error", "-f", "lavfi", "-i", "sine=d=2", a).Run() != nil {
		t.Skip("не удалось сделать тестовые файлы")
	}
	for _, p := range []string{v, a} {
		b := makeThumb(ffm, p, 0.5, 160)
		if len(b) < 100 || b[0] != 0xFF || b[1] != 0xD8 {
			t.Errorf("%s: нет JPEG (%d байт)", p, len(b))
		}
	}
	os.WriteFile(dir+"/bad.mp4", []byte("not a video"), 0o644)
	if b := makeThumb(ffm, dir+"/bad.mp4", 0.1, 160); len(b) != 0 {
		t.Errorf("битый файл дал превью")
	}
}
