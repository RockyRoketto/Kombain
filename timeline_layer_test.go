package main

import (
	"fmt"
	"math"
	"os/exec"
	"testing"
)

// gradeCalc: те же формулы, что в tlGradeChain и CHROMA_FRAG: по ним сверяется результат ffmpeg
func gradeCalc(rgb [3]float64, c Clip) [3]float64 {
	clip := func(v float64) float64 { return min(max(v, 0), 1) }
	gain := [3]float64{1 + 0.3*c.ColTemp, 1 - 0.3*c.ColTint, 1 - 0.3*c.ColTemp}
	for i := range rgb {
		v := math.Pow(clip(rgb[i]/255*gain[i]), math.Pow(2, -c.ColMid))
		rgb[i] = clip((v-0.5)*math.Pow(2, 2*c.ColCon) + 0.5 + c.ColBri/2)
	}
	l, s := 0.2126*rgb[0]+0.7152*rgb[1]+0.0722*rgb[2], 1+c.ColSat
	for i := range rgb {
		rgb[i] = clip(l+(rgb[i]-l)*s) * 255
	}
	return rgb
}

// rgbOf: средний цвет первого кадра
func (m *montFixture) rgbOf(p string) [3]float64 {
	m.t.Helper()
	out, err := exec.Command(m.ffm, "-hide_banner", "-loglevel", "error", "-i", p, "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-").Output()
	if err != nil || len(out) < 3 {
		m.t.Fatalf("кадр из %s: %v", p, err)
	}
	return [3]float64{float64(out[0]), float64(out[1]), float64(out[2])}
}

// Цветокоррекция: результат ffmpeg сходится с формулами просмотра, одна и в паре с удалением фона
func TestTimelineGrade(t *testing.T) {
	m := newMontFixture(t)
	src := m.color("src.mp4", "0x806040", 320, 240, 30, 1, 0)
	orig := m.rgbOf(src)
	for _, c := range []Clip{
		{ColBri: 0.3}, {ColBri: -0.4}, {ColCon: 0.5}, {ColCon: -0.5}, {ColMid: 0.6}, {ColMid: -0.6},
		{ColSat: 0.8}, {ColSat: -1}, {ColTemp: 0.7}, {ColTint: -0.7},
		{ColBri: 0.1, ColCon: 0.2, ColMid: -0.2, ColSat: 0.3, ColTemp: -0.4, ColTint: 0.3},
	} {
		c.Path = src
		got, want := m.rgbOf(m.render(tracks([]Clip{c}), "mp4")), gradeCalc(orig, c)
		for i := range got {
			if math.Abs(got[i]-want[i]) > 5 {
				t.Errorf("%+v: получилось %v, по формулам %v", c, got, want)
				break
			}
		}
	}
	// 10 бит не падает и остаётся 10 бит
	deep := m.make("deep.mov", "-f", "lavfi", "-i", "color=c=0x806040:s=320x240:r=30:d=1", "-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le")
	if got := m.rgbOf(m.render(tracks([]Clip{{Path: deep, ColBri: 0.3}}), "prores422")); got[0] <= orig[0]+20 {
		t.Errorf("10 бит: яркость не прибавилась: %v, было %v", got, orig)
	}
	// вместе с удалением фона: ключ смотрит на исходный цвет, коррекция не возвращает вырезанное
	under := m.color("under.mp4", "white", 320, 240, 30, 1, 0)
	green := m.color("green.mp4", "0x00ff00", 320, 240, 30, 1, 0)
	key := Clip{Path: green, KeyColor: "#00ff00", KeySim: 0.2, KeyBlend: 0.05, ColSat: -1, ColBri: -0.5}
	if got := m.lumaAt(m.render(tracks([]Clip{{Path: under}}, []Clip{key}), "mp4"), 0.5, 0.5, 0.5); got < 200 {
		t.Errorf("коррекция не должна мешать удалению фона: яркость %d", got)
	}
	// значения вне пределов обрезаются
	over := Project{Tracks: []Track{{Clips: []Clip{{ColBri: 5, ColTint: -5}}}}}
	over.fit()
	if c := over.Tracks[0].Clips[0]; c.ColBri != 1 || c.ColTint != -1 {
		t.Errorf("пределы: %+v", c)
	}
}

// Коррекция не сдвигает цвета файла с тегами BT.709: ровно то, что покажет просмотр
func TestTimelineGradeBT709(t *testing.T) {
	m := newMontFixture(t)
	src := m.make("hd.mp4", "-f", "lavfi", "-i", "color=c=0xc03030:s=1280x720:r=30:d=1",
		"-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p", "-c:v", "libx264", "-preset", "ultrafast",
		"-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709")
	plain, tiny := m.rgbOf(m.render(tracks([]Clip{{Path: src}}), "mp4")), m.rgbOf(m.render(tracks([]Clip{{Path: src, ColBri: 0.001}}), "mp4"))
	for i := range plain {
		if math.Abs(plain[i]-tiny[i]) > 4 {
			t.Fatalf("цвет съехал: без коррекции %v, с коррекцией %v", plain, tiny)
		}
	}
}

// Кадрирование срезает край на месте: остальная картинка не растягивается и не съезжает
func TestTimelineCrop(t *testing.T) {
	m := newMontFixture(t)
	under := m.color("under.mp4", "black", 320, 240, 30, 1, 0)
	top := m.color("top.mp4", "white", 320, 240, 30, 1, 0)
	out := m.render(tracks([]Clip{{Path: under}}, []Clip{{Path: top, X: 0, Y: 0, W: 1, H: 1, CropL: 0.5, CropB: 0.25}}), "mp4")
	for _, c := range []struct {
		x, y   float64
		bright bool
	}{{0.25, 0.3, false}, {0.75, 0.3, true}, {0.75, 0.9, false}} {
		if got := m.lumaAt(out, 0.5, c.x, c.y); (got > 128) != c.bright {
			t.Errorf("точка %.2f, %.2f: яркость %d", c.x, c.y, got)
		}
	}
	// без своей рамки слой кадрируется там, где вписан в кадр
	out = m.render(tracks([]Clip{{Path: under}}, []Clip{{Path: top, CropR: 0.5}}), "mp4")
	if got := m.lumaAt(out, 0.5, 0.25, 0.5); got < 200 {
		t.Errorf("левая половина должна остаться: яркость %d", got)
	}
	if got := m.lumaAt(out, 0.5, 0.75, 0.5); got > 60 {
		t.Errorf("правая половина срезана: яркость %d", got)
	}
}

// Удаление фона: на верхней дорожке видно нижнюю, на нижней в MP4 чёрный, в WebM прозрачность
func TestTimelineKey(t *testing.T) {
	m := newMontFixture(t)
	under := m.color("under.mp4", "white", 320, 240, 30, 1, 0)
	green := m.color("green.mp4", "0x00ff00", 320, 240, 30, 1, 0)
	key := Clip{Path: green, KeyColor: "#00ff00", KeySim: 0.2, KeyBlend: 0.05, KeySpill: 0.5}
	out := m.render(tracks([]Clip{{Path: under}}, []Clip{key}), "mp4")
	if got := m.lumaAt(out, 0.5, 0.5, 0.5); got < 200 {
		t.Errorf("сквозь вырезанное должно быть видно нижний слой: яркость %d", got)
	}
	out = m.render(tracks([]Clip{key}), "mp4")
	if got := m.lumaAt(out, 0.5, 0.5, 0.5); got > 40 {
		t.Errorf("без слоя под клипом в MP4 должно быть чёрное: яркость %d", got)
	}
	// формат с прозрачностью её сохраняет
	out = m.render(tracks([]Clip{key}), "webm")
	if !m.info(out).alpha {
		t.Error("в WebM вырезанное должно остаться прозрачным")
	}
	// другой цвет не трогается
	key.KeyColor = "#ff0000"
	key.KeySpill = 0
	out = m.render(tracks([]Clip{{Path: under}}, []Clip{key}), "mp4")
	if got := m.lumaAt(out, 0.5, 0.5, 0.5); got > 200 {
		t.Errorf("зелёный при красном ключе должен остаться: яркость %d", got)
	}
	// испорченный цвет не попадает в граф, клип остаётся как есть
	key.KeyColor = "#0f0:evil"
	out = m.render(tracks([]Clip{key}), "mp4")
	if got := m.lumaAt(out, 0.5, 0.5, 0.5); got < 90 {
		t.Errorf("с неверным цветом клип не должен вырезаться: яркость %d", got)
	}
}

// Поворот вокруг середины рамки, по часовой, и с кадрированием, и на нижней дорожке
func TestTimelineRotate(t *testing.T) {
	m := newMontFixture(t)
	under := m.color("under.mp4", "black", 320, 240, 30, 1, 0)
	bar := m.color("bar.mp4", "white", 160, 30, 30, 1, 0)
	box := Clip{Path: bar, X: 0.25, Y: 0.4375, W: 0.5, H: 0.125, Rot: 90}

	check := func(what, out string, list ...[3]float64) {
		t.Helper()
		for _, c := range list {
			if got := m.lumaAt(out, 0.5, c[0], c[1]); (got > 128) != (c[2] > 0) {
				t.Errorf("%s, точка %.2f, %.2f: яркость %d", what, c[0], c[1], got)
			}
		}
	}
	out := m.render(tracks([]Clip{{Path: under}}, []Clip{box}), "mp4")
	check("поворот", out, [3]float64{0.5, 0.25, 1}, [3]float64{0.5, 0.75, 1}, [3]float64{0.3, 0.5, 0}, [3]float64{0.7, 0.5, 0})

	// от полосы осталась правая половина: после поворота по часовой она смотрит вниз
	cut := box
	cut.CropL = 0.5
	out = m.render(tracks([]Clip{{Path: under}}, []Clip{cut}), "mp4")
	check("поворот и кадрирование", out, [3]float64{0.5, 0.25, 0}, [3]float64{0.5, 0.7, 1})

	// нижняя дорожка: углы чёрные, формат остаётся без прозрачности
	lone := m.color("lone.mp4", "white", 320, 240, 30, 1, 0)
	out = m.render(tracks([]Clip{{Path: lone, X: 0, Y: 0, W: 1, H: 1, Rot: 45}}), "mp4")
	check("нижняя дорожка", out, [3]float64{0.5, 0.5, 1}, [3]float64{0.03, 0.03, 0})

	// слой целиком за кадром ничего не рисует, но кадр собирается
	out = m.render(tracks([]Clip{{Path: under}}, []Clip{{Path: bar, X: 0.99, Y: 0.4, W: 0.5, H: 0.1, CropL: 0.9}}), "mp4")
	check("за кадром", out, [3]float64{0.99, 0.45, 0})
}

// Слой можно увести за кадр целиком (для прилётов из-за края): кадр собирается, слоя в нём нет. Дальше размера кадра от края нельзя.
func TestTimelineFarOut(t *testing.T) {
	m := newMontFixture(t)
	under := m.color("under.mp4", "black", 320, 240, 30, 1, 0)
	bar := m.color("bar.mp4", "white", 160, 30, 30, 1, 0)
	for _, c := range []Clip{
		{Path: bar, X: 1.3, Y: 0.4, W: 0.5, H: 0.125},
		{Path: bar, X: -0.8, Y: 0.4, W: 0.5, H: 0.125},
		{Path: bar, X: 0.25, Y: -0.6, W: 0.5, H: 0.125},
		{Path: bar, X: 0.25, Y: 1.05, W: 0.5, H: 0.125, Rot: 30},
		{Path: bar, X: 1.2, Y: 0.4, W: 0.5, H: 0.125, CropL: 0.3},
	} {
		out := m.render(tracks([]Clip{{Path: under}}, []Clip{c}), "mp4")
		for _, p := range [][2]float64{{0.02, 0.5}, {0.5, 0.5}, {0.98, 0.5}, {0.5, 0.02}, {0.5, 0.98}} {
			if got := m.lumaAt(out, 0.5, p[0], p[1]); got > 60 {
				t.Errorf("X %.2f Y %.2f: точка %.2f, %.2f яркость %d, слоя в кадре быть не должно", c.X, c.Y, p[0], p[1], got)
			}
		}
	}
	// единственная дорожка целиком за кадром: чёрный кадр
	out := m.render(tracks([]Clip{{Path: bar, X: -1.2, Y: 0, W: 1, H: 1}}), "mp4")
	if got := m.lumaAt(out, 0.5, 0.5, 0.5); got > 60 {
		t.Errorf("нижняя дорожка за кадром: яркость %d", got)
	}
	// пределы: не дальше размера кадра от края
	far := tracks([]Clip{{Path: bar, X: 5, Y: -5, W: 0.5, H: 0.25}})
	far.fit()
	if c := far.Tracks[0].Clips[0]; c.X != 1+tlFarOut || c.Y != -tlFarOut-0.25 {
		t.Errorf("пределы: X %v Y %v", c.X, c.Y)
	}
}

// Плавность: на нижней дорожке из чёрного, на верхней из того, что под ней, и с того же места, если голову клипа срезала метка
func TestTimelineFade(t *testing.T) {
	m := newMontFixture(t)
	white := m.color("white.mp4", "white", 320, 240, 30, 2, 0)
	black := m.color("black.mp4", "black", 320, 240, 30, 2, 0)
	near := func(what string, got, want int) {
		t.Helper()
		if got < want-30 || got > want+30 {
			t.Errorf("%s: яркость %d, ждали около %d", what, got, want)
		}
	}
	out := m.render(tracks([]Clip{{Path: white, FadeIn: 1, FadeOut: 0.5}}), "mp4")
	near("появление, середина", m.lumaAt(out, 0.5, 0.5, 0.5), 128)
	near("появилось", m.lumaAt(out, 1.2, 0.5, 0.5), 235)
	near("исчезание, середина", m.lumaAt(out, 1.75, 0.5, 0.5), 128)

	out = m.render(tracks([]Clip{{Path: white}}, []Clip{{Path: black, FadeIn: 1}}), "mp4")
	near("верхний слой появляется", m.lumaAt(out, 0.5, 0.5, 0.5), 128)
	near("верхний слой появился", m.lumaAt(out, 1.5, 0.5, 0.5), 16)

	p := tracks([]Clip{{Path: white, FadeIn: 1}})
	p.In = 0.5
	out = m.render(p, "mp4")
	near("метка внутри появления", m.lumaAt(out, 0, 0.5, 0.5), 128)
	near("после метки", m.lumaAt(out, 0.8, 0.5, 0.5), 235)
}

func TestTimelineSoundLevel(t *testing.T) {
	m := newMontFixture(t)
	src := m.color("tone.mp4", "black", 160, 120, 30, 2, 440)
	level := func(c Clip) []float64 {
		t.Helper()
		return m.pcm(m.render(tracks([]Clip{c}), "mp3"))
	}
	base := rms(level(Clip{Path: src}), 0.2, 1.8)
	half, none := 0.5, 0.0
	nearly(t, "громкость 50%", rms(level(Clip{Path: src, Vol: &half}), 0.2, 1.8)/base, 0.5, 0.03)
	if got := rms(level(Clip{Path: src, Vol: &none}), 0.2, 1.8); got > 0.001 {
		t.Errorf("громкость 0: %.4f", got)
	}
	s := level(Clip{Path: src, FadeIn: 1, FadeOut: 0.5})
	if a, b := rms(s, 0, 0.1), rms(s, 1.1, 1.3); a > b/3 {
		t.Errorf("появление: начало %.3f, потом %.3f", a, b)
	}
	if a, b := rms(s, 1.92, 2), rms(s, 1.1, 1.3); a > b/3 {
		t.Errorf("исчезание: конец %.3f, раньше %.3f", a, b)
	}
}

// Холст задаёт размер результата, клип вписывается по центру; нечётное значение становится чётным
func TestTimelineCanvasSize(t *testing.T) {
	m := newMontFixture(t)
	src := m.color("wide.mp4", "white", 320, 180, 30, 1, 0)
	p := tracks([]Clip{{Path: src}})
	p.W, p.H = 201, 401
	out := m.render(p, "mp4")
	i := m.info(out)
	if i.w != 200 || i.h != 400 {
		t.Errorf("размер %d×%d", i.w, i.h)
	}
	if got := m.lumaAt(out, 0.5, 0.5, 0.5); got < 200 {
		t.Errorf("клип в середине: яркость %d", got)
	}
	if got := m.lumaAt(out, 0.5, 0.5, 0.1); got > 40 {
		t.Errorf("сверху пусто: яркость %d", got)
	}
}

// rgbAt: цвет маленького куска кадра на отметке 0,5 с
func (m *montFixture) rgbAt(p string, x, y float64) [3]float64 {
	m.t.Helper()
	vf := fmt.Sprintf("crop=4:4:(iw-4)*%g:(ih-4)*%g,scale=1:1", x, y)
	out, err := exec.Command(m.ffm, "-hide_banner", "-loglevel", "error", "-ss", "0.5", "-i", p, "-frames:v", "1", "-vf", vf, "-f", "rawvideo", "-pix_fmt", "rgb24", "-").Output()
	if err != nil || len(out) < 3 {
		m.t.Fatalf("кадр из %s: %v", p, err)
	}
	return [3]float64{float64(out[0]), float64(out[1]), float64(out[2])}
}
