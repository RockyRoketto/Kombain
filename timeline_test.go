package main

import (
	"context"
	"encoding/binary"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// кадр: сплошной цвет заданной длины, со звуком или без
func (m *montFixture) color(name, c string, w, h int, fps, dur float64, tone int) string {
	m.t.Helper()
	src := fmt.Sprintf("color=c=%s:s=%dx%d:r=%g:d=%g", c, w, h, fps, dur)
	if tone == 0 {
		return m.make(name, "-f", "lavfi", "-i", src, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p")
	}
	return m.make(name, "-f", "lavfi", "-i", src, "-f", "lavfi", "-i", fmt.Sprintf("sine=f=%d:d=%g", tone, dur),
		"-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac")
}

// serial: файл, в котором сначала одна яркость, потом другая: по нему видно обрезку и реверс
func (m *montFixture) serial(name string) string {
	m.t.Helper()
	return m.make(name, "-f", "lavfi", "-i", "color=black:s=160x120:r=30:d=1", "-f", "lavfi", "-i", "color=white:s=160x120:r=30:d=1",
		"-filter_complex", "[0][1]concat=n=2:v=1:a=0", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p")
}

// lumaAt: яркость кадра в момент t, в точке (x, y) от 0 до 1
func (m *montFixture) lumaAt(p string, t, x, y float64) int {
	m.t.Helper()
	vf := fmt.Sprintf("crop=2:2:(iw-2)*%g:(ih-2)*%g,scale=1:1", x, y)
	out, err := exec.Command(m.ffm, "-hide_banner", "-loglevel", "error", "-ss", secs(t), "-i", p, "-frames:v", "1", "-vf", vf, "-f", "rawvideo", "-pix_fmt", "gray", "-").Output()
	if err != nil || len(out) == 0 {
		m.t.Fatalf("кадр %.2f из %s: %v", t, p, err)
	}
	return int(out[0])
}

// alphaAt: прозрачность кадра в момент t в середине кадра
func (m *montFixture) alphaAt(p string, t float64) int {
	m.t.Helper()
	out, err := exec.Command(m.ffm, "-hide_banner", "-loglevel", "error", "-ss", secs(t), "-i", p, "-frames:v", "1",
		"-vf", "crop=2:2,scale=1:1,format=rgba", "-f", "rawvideo", "-pix_fmt", "rgba", "-").Output()
	if err != nil || len(out) < 4 {
		m.t.Fatalf("кадр %.2f из %s: %v", t, p, err)
	}
	return int(out[3])
}

// pcm: весь звук файла как числа от -1 до 1, 48 кГц, моно
func (m *montFixture) pcm(p string) []float64 {
	m.t.Helper()
	out, err := exec.Command(m.ffm, "-hide_banner", "-loglevel", "error", "-i", p, "-vn", "-ac", "1", "-ar", "48000", "-f", "s16le", "-").Output()
	if err != nil {
		m.t.Fatalf("звук из %s: %v", p, err)
	}
	s := make([]float64, len(out)/2)
	for i := range s {
		s[i] = float64(int16(binary.LittleEndian.Uint16(out[i*2:]))) / 32768
	}
	return s
}

// rms: средняя громкость куска от a до b секунд
func rms(s []float64, a, b float64) float64 {
	from, to := int(a*48000), min(int(b*48000), len(s))
	if to <= from {
		return 0
	}
	sum := 0.0
	for _, v := range s[from:to] {
		sum += v * v
	}
	return math.Sqrt(sum / float64(to-from))
}

// render собирает проект напрямую, без очереди
func (m *montFixture) render(p Project, format string) string {
	m.t.Helper()
	out, err := m.tryRender(p, format)
	if err != nil {
		m.t.Fatal(err)
	}
	return out
}

func (m *montFixture) tryRender(p Project, format string) (string, error) {
	m.t.Helper()
	f := formats[format]
	si, err := timelineInfo(context.Background(), m.ffm, p, f)
	if err != nil {
		return "", err
	}
	dst := filepath.Join(m.dir, fmt.Sprintf("out%d.%s", len(mustRead(m.t, m.dir)), f.Ext))
	req := StartReq{CRF: 20, ABR: 192, Preset: "ultrafast", Overwrite: true}
	args, clean, err := spillGraph(buildArgs(f, req, "", dst, si, false, nil))
	if err != nil {
		m.t.Fatal(err)
	}
	defer clean()
	if out, err := exec.Command(m.ffm, args...).CombinedOutput(); err != nil {
		m.t.Fatalf("ffmpeg: %v\n%s\n%s", err, out, strings.Join(args, " "))
	}
	return dst, nil
}

func mustRead(t *testing.T, dir string) []os.DirEntry {
	t.Helper()
	list, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	return list
}

func tracks(rows ...[]Clip) Project {
	var p Project
	for _, r := range rows {
		p.Tracks = append(p.Tracks, Track{Clips: r})
	}
	return p
}

func TestTimelineGapsAreBlack(t *testing.T) {
	m := newMontFixture(t)
	white := m.color("white.mp4", "white", 320, 240, 30, 1, 440)
	out := m.render(tracks([]Clip{{Path: white, At: 1}, {Path: white, At: 3}}), "mp4")
	si := m.info(out)
	nearly(t, "длина", si.dur, 4, 0.1)
	for _, c := range []struct {
		at   float64
		lit  bool
		what string
	}{{0.5, false, "пустота в начале"}, {1.5, true, "первый клип"}, {2.5, false, "пустота в середине"}, {3.5, true, "второй клип"}} {
		if got := m.lumaAt(out, c.at, 0.5, 0.5); (got > 128) != c.lit {
			t.Errorf("%s: яркость %d", c.what, got)
		}
	}
	s := m.pcm(out)
	if v := rms(s, 2.2, 2.8); v > 0.001 {
		t.Errorf("в пустоте звук: %.4f", v)
	}
	if v := rms(s, 1.2, 1.8); v < 0.05 {
		t.Errorf("в клипе нет звука: %.4f", v)
	}
}

// Верхняя дорожка закрывает нижнюю только на своё время, а там, где клип меньше кадра, нижняя видна
func TestTimelineLayers(t *testing.T) {
	m := newMontFixture(t)
	white := m.color("white.mp4", "white", 640, 360, 30, 3, 0)
	gray := m.color("top.mp4", "black", 100, 100, 25, 1, 0)
	out := m.render(tracks([]Clip{{Path: white}}, []Clip{{Path: gray, At: 1}}), "mp4")
	nearly(t, "длина", m.info(out).dur, 3, 0.1)
	if w, h := m.info(out).w, m.info(out).h; w != 640 || h != 360 {
		t.Errorf("размер %dx%d", w, h)
	}
	for _, c := range []struct {
		at, x float64
		lit   bool
		what  string
	}{
		{0.5, 0.5, true, "до верхнего клипа"},
		{1.5, 0.5, false, "верхний клип в середине"},
		{1.5, 0.02, true, "края верхнего клипа прозрачны"},
		{2.5, 0.5, true, "после верхнего клипа"},
	} {
		if got := m.lumaAt(out, c.at, c.x, 0.5); (got > 128) != c.lit {
			t.Errorf("%s: яркость %d", c.what, got)
		}
	}
}

// На верхней дорожке несколько клипов с пустотой между ними: в пустоте видно нижнюю
func TestTimelineUpperGap(t *testing.T) {
	m := newMontFixture(t)
	white := m.color("white.mp4", "white", 320, 240, 30, 5, 0)
	dark := m.color("dark.mp4", "black", 320, 240, 30, 1, 0)
	out := m.render(tracks([]Clip{{Path: white}}, []Clip{{Path: dark, At: 1}, {Path: dark, At: 3}}), "mp4")
	for at, lit := range map[float64]bool{0.5: true, 1.5: false, 2.5: true, 3.5: false, 4.5: true} {
		if got := m.lumaAt(out, at, 0.5, 0.5); (got > 128) != lit {
			t.Errorf("на %.1f яркость %d", at, got)
		}
	}
}

func TestTimelineMix(t *testing.T) {
	m := newMontFixture(t)
	a := m.make("a.wav", "-f", "lavfi", "-i", "sine=f=440:d=2", "-ac", "2")
	b := m.make("b.wav", "-f", "lavfi", "-i", "sine=f=1000:d=2", "-ac", "2")
	out := m.render(tracks([]Clip{{Path: a}}, []Clip{{Path: b, At: 1}}), "wav")
	nearly(t, "длина", m.info(out).dur, 3, 0.02)
	s := m.pcm(out)
	solo := rms(m.pcm(a), 0.2, 1.8)
	nearly(t, "первый звук один, не приглушён", rms(s, 0.2, 0.8), solo, 0.01)
	nearly(t, "второй звук один", rms(s, 2.2, 2.8), solo, 0.01)
	if both := rms(s, 1.2, 1.8); both < solo*1.2 {
		t.Errorf("оба звука: %.3f, один: %.3f", both, solo)
	}
}

// Две полные громкости не должны давать пики за пределами шкалы
func TestTimelineMixPeaks(t *testing.T) {
	m := newMontFixture(t)
	loud := m.make("loud.wav", "-f", "lavfi", "-i", "sine=f=440:d=2", "-af", "volume=5:precision=float", "-ac", "2", "-c:a", "pcm_f32le")
	out := m.render(tracks([]Clip{{Path: loud}}, []Clip{{Path: loud}}, []Clip{{Path: loud}}), "wav")
	s := m.pcm(out)
	peak := 0.0
	for _, v := range s {
		peak = max(peak, math.Abs(v))
	}
	if peak > 0.98 {
		t.Errorf("пик %.3f, лимитер должен держать 0,95", peak)
	}
	if v := rms(s, 0.2, 1.8); v < 0.5 {
		t.Errorf("лимитер слишком придавил звук: %.3f", v)
	}
	nearly(t, "длина не поменялась", float64(len(s))/48000, 2, 0.02)
}

// Клипы с разным размером и частотой, один без звука, один без картинки
func TestTimelineMixedSources(t *testing.T) {
	m := newMontFixture(t)
	mute := m.color("mute.mp4", "white", 640, 360, 25, 1, 0)
	loud := m.color("loud.mp4", "white", 320, 320, 60, 1, 440)
	music := m.make("music.mp3", "-f", "lavfi", "-i", "sine=f=660:d=1")
	out := m.render(tracks([]Clip{{Path: mute}, {Path: loud, At: 1}}, []Clip{{Path: music, At: 2}}), "mp4")
	si := m.info(out)
	if si.w != 640 || si.h != 360 {
		t.Errorf("размер %dx%d", si.w, si.h)
	}
	nearly(t, "частота как у первого", si.fps, 25, 0.01)
	nearly(t, "длина", si.dur, 3, 0.1)
	s := m.pcm(out)
	if v := rms(s, 0.2, 0.8); v > 0.001 {
		t.Errorf("у клипа без звука громкость %.4f", v)
	}
	if v := rms(s, 1.2, 1.8); v < 0.05 {
		t.Errorf("у клипа со звуком громкость %.4f", v)
	}
	if v := rms(s, 2.2, 2.8); v < 0.05 {
		t.Errorf("у музыки громкость %.4f", v)
	}
	if got := m.lumaAt(out, 2.5, 0.5, 0.5); got > 30 {
		t.Errorf("под музыкой пустота, а яркость %d", got)
	}
	if got := m.lumaAt(out, 1.5, 0.05, 0.5); got > 30 {
		t.Errorf("поля у квадратного клипа: яркость %d", got)
	}
}

// Размер и частота из проекта важнее первого видео
func TestTimelineCanvasSettings(t *testing.T) {
	m := newMontFixture(t)
	a := m.color("a.mp4", "white", 320, 240, 25, 1, 0)
	p := tracks([]Clip{{Path: a}})
	p.W, p.H, p.FPS = 200, 200, 10
	si := m.info(m.render(p, "mp4"))
	if si.w != 200 || si.h != 200 {
		t.Errorf("размер %dx%d", si.w, si.h)
	}
	nearly(t, "частота", si.fps, 10, 0.01)
}

// Склейка, скорость, реверс, обрезка и повтор из первого захода
func TestTimelineClipTools(t *testing.T) {
	m := newMontFixture(t)
	two := m.serial("two.mp4")
	for _, c := range []struct {
		name  string
		clips []Clip
		dur   float64
		first bool // первый кадр светлый
		last  bool
	}{
		{"как есть", []Clip{{Path: two}}, 2, false, true},
		{"обрезка", []Clip{{Path: two, From: 1, Len: 0.5}}, 0.5, true, true},
		{"скорость 2", []Clip{{Path: two, Speed: 2}}, 1, false, true},
		{"скорость 0,5", []Clip{{Path: two, Len: 1, Speed: 0.5}}, 2, false, false},
		{"реверс", []Clip{{Path: two, Reverse: true}}, 2, true, false},
		{"обрезка и реверс", []Clip{{Path: two, From: 0.5, Len: 1, Reverse: true}}, 1, true, false},
		{"скорость и реверс", []Clip{{Path: two, Reverse: true, Speed: 2}}, 1, true, false},
		{"повтор копиями", []Clip{{Path: two}, {Path: two, At: 2}, {Path: two, At: 4}}, 6, false, true},
	} {
		t.Run(c.name, func(t *testing.T) {
			out := m.render(tracks(c.clips), "mp4")
			dur := m.info(out).dur
			nearly(t, "длина", dur, c.dur, 0.1)
			if got := m.lumaAt(out, 0, 0.5, 0.5); (got > 128) != c.first {
				t.Errorf("первый кадр: яркость %d", got)
			}
			if got := m.lumaAt(out, dur-0.1, 0.5, 0.5); (got > 128) != c.last {
				t.Errorf("последний кадр: яркость %d", got)
			}
		})
	}
}

// Звук идёт за картинкой: скорость, реверс, обрезка
func TestTimelineClipSound(t *testing.T) {
	m := newMontFixture(t)
	// первая секунда тихая, вторая громкая
	src := m.make("step.wav", "-f", "lavfi", "-i", "sine=f=440:d=2", "-af", "volume='if(lt(t,1),0,1)':eval=frame")
	out := m.render(tracks([]Clip{{Path: src, Reverse: true}}), "wav")
	s := m.pcm(out)
	if rms(s, 0.2, 0.8) < 0.05 || rms(s, 1.2, 1.8) > 0.01 {
		t.Errorf("реверс звука: %.3f, потом %.3f", rms(s, 0.2, 0.8), rms(s, 1.2, 1.8))
	}
	s = m.pcm(m.render(tracks([]Clip{{Path: src, Speed: 2}}), "wav"))
	nearly(t, "ускорение", float64(len(s))/48000, 1, 0.02)
	if rms(s, 0.1, 0.4) > 0.01 || rms(s, 0.6, 0.9) < 0.05 {
		t.Errorf("ускорение звука: %.3f, потом %.3f", rms(s, 0.1, 0.4), rms(s, 0.6, 0.9))
	}
	s = m.pcm(m.render(tracks([]Clip{{Path: src, From: 0.5, Len: 1, At: 1}}), "wav"))
	nearly(t, "обрезка с места на дорожке", float64(len(s))/48000, 2, 0.02)
	if rms(s, 0.2, 0.8) > 0.001 || rms(s, 1.1, 1.4) > 0.01 || rms(s, 1.6, 1.9) < 0.05 {
		t.Errorf("обрезка звука: %.3f, %.3f, %.3f", rms(s, 0.2, 0.8), rms(s, 1.1, 1.4), rms(s, 1.6, 1.9))
	}
}

// Клип заехал на следующий на той же дорожке: ранний обрывается
func TestTimelineSameTrackOverlap(t *testing.T) {
	m := newMontFixture(t)
	white := m.color("white.mp4", "white", 160, 120, 30, 3, 0)
	dark := m.color("dark.mp4", "gray", 160, 120, 30, 1, 0)
	out := m.render(tracks([]Clip{{Path: dark, At: 1}, {Path: white}}), "mp4")
	nearly(t, "длина: важен порядок по времени, а не в списке", m.info(out).dur, 2, 0.1)
	if got := m.lumaAt(out, 1.5, 0.5, 0.5); got > 200 {
		t.Errorf("поздний клип должен победить: яркость %d", got)
	}
}

// Картинка в файле короче звука: следующий клип всё равно приходит вовремя, а пауза держит последний кадр
func TestTimelineVideoShorterThanAudio(t *testing.T) {
	m := newMontFixture(t)
	short := m.make("short.mp4", "-f", "lavfi", "-i", "color=white:s=160x120:r=30:d=1", "-f", "lavfi", "-i", "sine=f=440:d=2",
		"-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac")
	dark := m.color("dark.mp4", "black", 160, 120, 30, 1, 0)
	out := m.render(tracks([]Clip{{Path: short}, {Path: dark, At: 2}}), "mp4")
	nearly(t, "длина", m.info(out).dur, 3, 0.1)
	if got := m.lumaAt(out, 1.5, 0.5, 0.5); got < 128 {
		t.Errorf("последний кадр должен держаться: яркость %d", got)
	}
	if got := m.lumaAt(out, 2.5, 0.5, 0.5); got > 40 {
		t.Errorf("следующий клип опоздал: яркость %d", got)
	}
}

func TestTimelinePhoto(t *testing.T) {
	m := newMontFixture(t)
	white := m.color("white.mp4", "white", 320, 240, 30, 3, 0)
	logo := m.make("logo.png", "-f", "lavfi", "-i", "color=c=black@0.0:s=64x48,format=rgba,drawbox=x=16:y=12:w=32:h=24:color=black:t=fill:replace=1", "-frames:v", "1")
	out := m.render(tracks([]Clip{{Path: white}}, []Clip{{Path: logo, At: 1, Len: 1}}), "mp4")
	nearly(t, "длина", m.info(out).dur, 3, 0.1)
	if got := m.lumaAt(out, 1.5, 0.5, 0.5); got > 40 {
		t.Errorf("логотип в середине: яркость %d", got)
	}
	if got := m.lumaAt(out, 1.5, 0.05, 0.5); got < 200 {
		t.Errorf("вокруг логотипа прозрачно: яркость %d", got)
	}
	if got := m.lumaAt(out, 2.5, 0.5, 0.5); got < 200 {
		t.Errorf("логотип должен исчезнуть: яркость %d", got)
	}
	// одно фото, длина по умолчанию
	nearly(t, "фото без длины", m.info(m.render(tracks([]Clip{{Path: logo}}), "mp4")).dur, tlPhotoLen, 0.1)
}

// Пустота прозрачна только там, где есть слой с прозрачностью
func TestTimelineAlpha(t *testing.T) {
	m := newMontFixture(t)
	logo := m.make("logo.png", "-f", "lavfi", "-i", "color=c=white:s=64x48,format=rgba", "-frames:v", "1")
	plain := m.color("plain.mp4", "white", 64, 48, 30, 1, 0)

	out := m.render(tracks([]Clip{{Path: logo, At: 1, Len: 1}}), "prores4444")
	if a := m.alphaAt(out, 0.5); a > 10 {
		t.Errorf("пустота при слое с прозрачностью: альфа %d", a)
	}
	if a := m.alphaAt(out, 1.5); a < 245 {
		t.Errorf("сам слой: альфа %d", a)
	}
	out = m.render(tracks([]Clip{{Path: plain, At: 1}}), "prores4444")
	if a := m.alphaAt(out, 0.5); a < 245 {
		t.Errorf("пустота без слоя с прозрачностью должна быть чёрной: альфа %d", a)
	}
	out = m.render(tracks([]Clip{{Path: logo, At: 1, Len: 1}}), "webm")
	nearly(t, "WebM с прозрачностью, длина", m.info(out).dur, 2, 0.1)
	out = m.render(tracks([]Clip{{Path: logo, At: 1, Len: 1}}), "mp4")
	if got := m.lumaAt(out, 0.5, 0.5, 0.5); got > 30 {
		t.Errorf("в MP4 пустота чёрная: яркость %d", got)
	}
}

// Больше 8 бит на канал: слои не ломают граф
func TestTimelineDeep(t *testing.T) {
	m := newMontFixture(t)
	deep := m.make("deep.mov", "-f", "lavfi", "-i", "color=white:s=320x240:r=25:d=1", "-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le")
	if !m.info(deep).deep {
		t.Fatal("тестовый файл должен быть 10-битным")
	}
	small := m.color("small.mp4", "black", 100, 100, 25, 1, 0)
	for _, format := range []string{"mp4", "prores422"} {
		out := m.render(tracks([]Clip{{Path: deep}}, []Clip{{Path: small}}), format)
		if got := m.lumaAt(out, 0.5, 0.02, 0.5); got < 128 {
			t.Errorf("%s: края: яркость %d", format, got)
		}
		if got := m.lumaAt(out, 0.5, 0.5, 0.5); got > 40 {
			t.Errorf("%s: середина: яркость %d", format, got)
		}
	}
}

func TestTimelineFormats(t *testing.T) {
	m := newMontFixture(t)
	a := m.color("a.mp4", "white", 322, 240, 25, 1, 440)
	b := m.color("b.mp4", "gray", 100, 100, 30, 1, 880)
	p := tracks([]Clip{{Path: a}, {Path: a, At: 1.5, Speed: 2, Reverse: true}}, []Clip{{Path: b, At: 0.5, Len: 0.5}})
	for _, id := range []string{"mp4", "webm", "prores422", "prores4444", "gif", "apng", "mp3", "wav", "flac"} {
		t.Run(id, func(t *testing.T) {
			out := m.render(p, id)
			if fileSize(out) == 0 {
				t.Fatal("пустой файл")
			}
			si := m.info(out)
			if id != "gif" && id != "apng" { // у анимации длину считают по-своему, важно, что она собралась
				nearly(t, "длина", si.dur, 2, 0.15)
			}
		})
	}
}

func TestTimelineErrors(t *testing.T) {
	m := newMontFixture(t)
	mute := m.color("mute.mp4", "white", 160, 120, 25, 1, 0)
	snd := m.make("snd.mp3", "-f", "lavfi", "-i", "sine=f=440:d=1")
	bad := filepath.Join(m.dir, "bad.mp4")
	os.WriteFile(bad, []byte("not a video"), 0o644)
	for _, c := range []struct {
		name   string
		p      Project
		format string
		want   string
	}{
		{"нет картинки", tracks([]Clip{{Path: snd}}), "mp4", tr("mont.noVideo", "snd.mp3")},
		{"нет звука", tracks([]Clip{{Path: mute}}), "mp3", tr("mont.noAudio", "mute.mp4")},
		{"не читается", tracks([]Clip{{Path: bad}}), "mp4", tr("mont.unreadable", "bad.mp4")},
		{"пусто", Project{}, "mp4", tr("mont.noClips")},
		{"за концом файла", tracks([]Clip{{Path: mute, From: 50}}), "mp4", tr("mont.noClips")},
	} {
		t.Run(c.name, func(t *testing.T) {
			_, err := timelineInfo(context.Background(), m.ffm, c.p, formats[c.format])
			if err == nil || err.Error() != c.want {
				t.Errorf("ошибка %v, ждали %q", err, c.want)
			}
		})
	}
}

// Строка монтажа в настоящей очереди, рядом с обычным файлом
func TestTimelineQueue(t *testing.T) {
	m := newMontFixture(t)
	a := m.color("a.mp4", "white", 160, 120, 25, 1, 440)
	b := m.color("b.mp4", "black", 160, 120, 25, 1, 880)
	proj := tracks([]Clip{{Path: a}, {Path: b, At: 2}})

	run := func(format string, tune func(*StartReq)) *Server {
		req := StartReq{Files: []string{"montage:1", a}, Format: format, CRF: 20, ABR: 192, Preset: "ultrafast", SameDir: true, Copy: true, Jobs: 2,
			Montages: map[string]Project{"montage:1": proj}}
		if tune != nil {
			tune(&req)
		}
		s := &Server{}
		s.run(req, m.ffm)
		return s
	}

	t.Run("формат и качество общие", func(t *testing.T) {
		s := run("webm", nil)
		row, plain := s.files[0], s.files[1]
		if row.Status != "ok" || plain.Status != "ok" {
			t.Fatalf("статусы %s %s: %s\n%s", row.Status, plain.Status, row.Msg, strings.Join(s.log, "\n"))
		}
		if row.Name != tr("mont.rowName", "a") || !strings.HasSuffix(row.Dst, "a"+tr("mont.suffix")+".webm") {
			t.Errorf("строка %q, файл %q", row.Name, row.Dst)
		}
		nearly(t, "длина строки", m.info(row.Dst).dur, 3, 0.1)
		nearly(t, "длина файла", m.info(plain.Dst).dur, 1, 0.1)
	})
	t.Run("настройки конвертера доходят", func(t *testing.T) {
		s := run("mp4", func(r *StartReq) { r.Height, r.FPS = "60", "10" })
		si := m.info(s.files[0].Dst)
		if si.h != 60 {
			t.Errorf("высота %d", si.h)
		}
		nearly(t, "частота", si.fps, 10, 0.01)
	})
	t.Run("уложить в размер", func(t *testing.T) {
		// исходники тяжелее цели, значит пойдут два прохода: первый без звука, а граф со звуком
		heavy := m.make("heavy.mp4", "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=3", "-f", "lavfi", "-i", "sine=f=440:d=3",
			"-c:v", "libx264", "-preset", "ultrafast", "-crf", "1", "-pix_fmt", "yuv420p", "-c:a", "aac")
		if fileSize(heavy) < 3<<20 {
			t.Fatalf("тестовый файл слишком лёгкий: %d", fileSize(heavy))
		}
		s := &Server{}
		s.run(StartReq{Files: []string{"montage:1"}, Format: "mp4", CRF: 20, ABR: 128, Preset: "ultrafast", SameDir: true, TargetMB: 2,
			Montages: map[string]Project{"montage:1": tracks([]Clip{{Path: heavy}, {Path: heavy, At: 3}})}}, m.ffm)
		st := s.files[0]
		if st.Status != "ok" {
			t.Fatalf("статус %s: %s\n%s", st.Status, st.Msg, strings.Join(s.log, "\n"))
		}
		if fileSize(st.Dst) > 2<<20+1<<18 {
			t.Errorf("размер %d", fileSize(st.Dst))
		}
		if !m.info(st.Dst).audio {
			t.Error("пропал звук")
		}
	})
	t.Run("режим Сжать", func(t *testing.T) {
		s := run("small", func(r *StartReq) { r.Codec = "h264" })
		st := s.files[0]
		if st.Status != "ok" || !strings.HasSuffix(st.Dst, ".mp4") {
			t.Fatalf("статус %s, файл %s: %s", st.Status, st.Dst, st.Msg)
		}
		nearly(t, "длина", m.info(st.Dst).dur, 3, 0.1)
	})
	t.Run("формат не подходит", func(t *testing.T) {
		s := run("jpg", nil)
		if s.files[0].Status != "error" || s.files[0].Msg != tr("mont.rowFormat") {
			t.Errorf("строка монтажа: %s %s", s.files[0].Status, s.files[0].Msg)
		}
		if s.files[1].Status != "ok" {
			t.Errorf("обычный файл не должен страдать: %s %s", s.files[1].Status, s.files[1].Msg)
		}
	})
	t.Run("битый проект", func(t *testing.T) {
		s := &Server{}
		s.run(StartReq{Files: []string{"montage:1"}, Format: "mp4", CRF: 20, ABR: 192, Preset: "ultrafast", SameDir: true,
			Montages: map[string]Project{"montage:1": tracks([]Clip{{Path: filepath.Join(m.dir, "нет.mp4")}})}}, m.ffm)
		if s.files[0].Status != "error" {
			t.Errorf("статус %s", s.files[0].Status)
		}
	})
}

// Кадр с меткой поворота: монтаж видит его таким, каким его покажет ffmpeg
func TestTimelineRotated(t *testing.T) {
	m := newMontFixture(t)
	plain := m.color("plain.mp4", "black", 640, 360, 25, 1, 0)
	rot := filepath.Join(m.dir, "rot.mp4")
	if out, err := exec.Command(m.ffm, "-hide_banner", "-loglevel", "error", "-y", "-display_rotation", "90", "-i", plain, "-c", "copy", rot).CombinedOutput(); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	out := m.render(tracks([]Clip{{Path: rot, At: 0}, {Path: plain, At: 1}}), "mp4")
	if si := m.info(out); si.w != 360 || si.h != 640 {
		t.Errorf("размер %dx%d, ждали вертикальный кадр 360x640", si.w, si.h)
	}
}

// Больше сотни клипов: граф не помещается в командную строку Windows и уходит в файл
func TestTimelineManyClips(t *testing.T) {
	m := newMontFixture(t)
	a := m.color("a.mp4", "white", 64, 48, 10, 1, 440)
	const n = 90
	var low, high []Clip
	for i := 0; i < n; i++ {
		low = append(low, Clip{Path: a, At: float64(i) * 0.1, Len: 0.1})
		if i%2 == 0 {
			high = append(high, Clip{Path: a, At: float64(i) * 0.1, Len: 0.1})
		}
	}
	p := tracks(low, high)
	si, err := timelineInfo(context.Background(), m.ffm, p, formats["mp4"])
	if err != nil {
		t.Fatal(err)
	}
	if len(si.graph) < 33000 {
		t.Fatalf("граф всего %d символов, проверка ничего не проверяет", len(si.graph))
	}
	args, clean, err := spillGraph(buildArgs(formats["mp4"], StartReq{CRF: 20, ABR: 192, Preset: "ultrafast"}, "", filepath.Join(m.dir, "x.mp4"), si, false, nil))
	if err != nil {
		t.Fatal(err)
	}
	clean()
	if cmdLen(args) > 32000 {
		t.Errorf("команда %d символов, в Windows не запустится", cmdLen(args))
	}
	out := m.render(p, "mp4")
	nearly(t, "длина", m.info(out).dur, 9, 0.15)
}

func TestSpillGraph(t *testing.T) {
	short := []string{"-i", "a", "-filter_complex", "[0:v]null[v]", "b"}
	out, clean, err := spillGraph(short)
	if err != nil || !slices.Equal(out, short) {
		t.Fatalf("короткий граф должен остаться в команде: %v %v", out, err)
	}
	clean()

	long := strings.Repeat("g", tlGraphInline+1)
	out, clean, err = spillGraph([]string{"-i", "a", "-filter_complex", long, "b"})
	if err != nil {
		t.Fatal(err)
	}
	if out[2] != "-/filter_complex" {
		t.Fatalf("опция %q", out[2])
	}
	if b, err := os.ReadFile(out[3]); err != nil || string(b) != long {
		t.Fatalf("в файле не тот граф: %v", err)
	}
	clean()
	if _, err := os.Stat(out[3]); err == nil {
		t.Error("файл графа остался")
	}
}

// Входы файлом не передать: вместо непонятной ошибки запуска строка монтажа получает понятный текст
func TestTimelineTooManyInputs(t *testing.T) {
	m := newMontFixture(t)
	a := m.color("a.mp4", "white", 64, 48, 10, 1, 0)
	var list []Clip
	for i := 0; i < 700; i++ {
		list = append(list, Clip{Path: a, At: float64(i), Len: 1})
	}
	if _, err := timelineInfo(context.Background(), m.ffm, tracks(list), formats["mp4"]); err == nil || !strings.Contains(err.Error(), tr("mont.tooMany")) {
		t.Fatalf("ошибка %v", err)
	}
}

func TestProjectFile(t *testing.T) {
	dir := t.TempDir()
	s := &Server{}
	s.addIncoming([]string{filepath.Join(dir, "снаружи.K9000")})
	if s.incomingProject == "" || len(s.incoming) != 0 {
		t.Errorf("файл проекта снаружи: %q, в конвертер ушло %d", s.incomingProject, len(s.incoming))
	}
	p, err := writeProject(filepath.Join(dir, "мой проект"), []byte(`{"v":1}`))
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Ext(p) != projectExt {
		t.Errorf("расширение: %s", p)
	}
	if b, err := readProject(p); err != nil || string(b) != `{"v":1}` {
		t.Errorf("прочитано %q, %v", b, err)
	}
	if _, err := writeProject(p, []byte("не json")); err == nil {
		t.Error("записался не JSON")
	}
	if b, _ := readProject(p); string(b) != `{"v":1}` {
		t.Errorf("сбой записи испортил проект: %q", b)
	}
	os.WriteFile(p, []byte("мусор"), 0o644)
	if _, err := readProject(p); err == nil {
		t.Error("прочитался мусор")
	}
	if rest := mustRead(t, dir); len(rest) != 1 {
		t.Errorf("остались лишние файлы: %d", len(rest))
	}
}
