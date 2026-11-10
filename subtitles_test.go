package main

import (
	"encoding/binary"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"testing"
	"unicode/utf16"
)

func TestSubsDecode(t *testing.T) {
	want := "Привет, ёж №1"
	utf16le := []byte{0xFF, 0xFE}
	for _, u := range utf16.Encode([]rune(want)) {
		utf16le = binary.LittleEndian.AppendUint16(utf16le, u)
	}
	cp1251 := []byte{0xCF, 0xF0, 0xE8, 0xE2, 0xE5, 0xF2, ',', ' ', 0xB8, 0xE6, ' ', 0xB9, '1'}
	for name, in := range map[string][]byte{
		"utf8": []byte(want), "bom": append([]byte{0xEF, 0xBB, 0xBF}, want...), "utf16": utf16le, "cp1251": cp1251,
	} {
		if got := subsDecode(in); got != want {
			t.Errorf("%s: %q", name, got)
		}
	}
}

func TestSubsParse(t *testing.T) {
	got := subsParse("1\r\n00:00:01,500 --> 00:00:02,000\r\n<i>первая</i>\r\nстрока\r\n\r\n" +
		"2\n00:00:03.5 --> 00:00:04.000 X1:0\n{\\an8}вторая\n\n" +
		"3\n00:00:05,000 --> 00:00:05,000\nнулевая длина\n\n" +
		"мусор\n\n4\n01:00:00,000 --> 01:00:01,000\nбез пустой строки в конце")
	want := []SubCue{{1.5, 2, "первая\nстрока"}, {3.5, 4, "вторая"}, {3600, 3601, "без пустой строки в конце"}}
	if !slices.Equal(got, want) {
		t.Fatalf("%+v", got)
	}
}

func TestSubsRange(t *testing.T) {
	got := subsRange([]SubCue{{0, 1, "до"}, {1.5, 2.5, "край"}, {3, 4, "внутри"}, {6, 8, "конец"}, {9, 10, "после"}}, 2, 5)
	want := []SubCue{{0, 0.5, "край"}, {1, 2, "внутри"}, {4, 5, "конец"}}
	if !slices.Equal(got, want) {
		t.Fatalf("%+v", got)
	}
}

// Плоская папка старых версий переезжает. Настройки и данные окна на месте, недокачанное убрано, повторный запуск ничего не портит.
func TestMigrateData(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("без .exe файл ffmpeg и папка ffmpeg носят одно имя")
	}
	base := t.TempDir()
	t.Setenv("LOCALAPPDATA", base)
	t.Setenv("XDG_CACHE_HOME", base)
	root := dataDir()
	put := func(rel, text string) {
		p := filepath.Join(root, rel)
		os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	put(ffName(), "ff")
	put("settings.json", "{}")
	put(filepath.Join("webview", "x"), "w")
	put(filepath.Join("preview", "copy.mp4"), "c")
	put(filepath.Join("drop", "a", "b.mp4"), "d")
	put(filepath.Join("update", "Konvertor.exe"), "u")
	put("ffmpeg.zip.part", "z")

	migrateData()
	migrateData()

	for _, rel := range []string{filepath.Join("ffmpeg", ffName()), "settings.json", filepath.Join("webview", "x"), filepath.Join("cache", "preview", "copy.mp4")} {
		if !fileExists(filepath.Join(root, rel)) {
			t.Errorf("нет %s", rel)
		}
	}
	for _, rel := range []string{ffName(), "preview", "drop", "update", "ffmpeg.zip.part"} {
		if _, err := os.Stat(filepath.Join(root, rel)); err == nil {
			t.Errorf("остался %s", rel)
		}
	}
	for _, rel := range []string{"models", "tools"} {
		if !dirExists(filepath.Join(root, rel)) {
			t.Errorf("нет папки %s", rel)
		}
	}
	if findFFmpeg() != ffPath() {
		t.Errorf("findFFmpeg: %s", findFFmpeg())
	}
	if modelDir("whisper") != filepath.Join(root, "models", "whisper") || toolDir("whisper") != filepath.Join(root, "tools", "whisper") {
		t.Error("папки моделей и программ не там")
	}

	// откат на старую версию скачал ffmpeg в корень: остаётся новый
	put(ffName(), "старый")
	migrateData()
	if b, _ := os.ReadFile(ffPath()); string(b) != "ff" || fileExists(filepath.Join(root, ffName())) {
		t.Errorf("ffmpeg: %q", b)
	}
	// старый ещё не перенесён: всё равно найдётся
	os.Remove(ffPath())
	put(ffName(), "старый")
	if findFFmpeg() != filepath.Join(root, ffName()) {
		t.Errorf("findFFmpeg без переноса: %s", findFFmpeg())
	}
}

// самая яркая точка нижней четверти кадра: белый текст на тёмном фоне
func (m *montFixture) bandMax(p string, at float64) int {
	m.t.Helper()
	out, err := exec.Command(m.ffm, "-hide_banner", "-loglevel", "error", "-ss", secs(at), "-i", p, "-frames:v", "1",
		"-vf", "crop=iw:ih/4:0:ih*3/4", "-f", "rawvideo", "-pix_fmt", "gray", "-").Output()
	if err != nil || len(out) == 0 {
		m.t.Fatalf("кадр %.2f из %s: %v", at, p, err)
	}
	return int(slices.Max(out))
}

func (m *montFixture) srt(name, text string) string {
	m.t.Helper()
	p := filepath.Join(m.dir, name)
	if err := os.WriteFile(p, []byte(text), 0o644); err != nil {
		m.t.Fatal(err)
	}
	return p
}

const subsSample = "1\n00:00:00,000 --> 00:00:01,000\nПервая\n\n2\n00:00:02,000 --> 00:00:03,000\nВторая\n"

// Вжигание: текст стоит там и тогда, где и когда надо. Метка начала сдвигает реплики вместе с результатом.
// Кавычка, запятая и скобки в пути к временному файлу не должны ломать граф.
func TestTimelineSubsBurn(t *testing.T) {
	m := newMontFixture(t)
	base := filepath.Join(t.TempDir(), "O'Brien, [a]; b")
	t.Setenv("LOCALAPPDATA", base)
	t.Setenv("XDG_CACHE_HOME", base)
	src := m.color("src.mp4", "black", 320, 240, 30, 3, 0)
	subs := &Subs{Path: m.srt("a.srt", subsSample), Mode: subsModeBurn}

	p := tracks([]Clip{{Path: src}})
	p.Subs = subs
	out := m.render(p, "mp4")
	for _, x := range []struct {
		at  float64
		lit bool
	}{{0.5, true}, {1.5, false}, {2.5, true}} {
		if got := m.bandMax(out, x.at); (got > 150) != x.lit {
			t.Errorf("%.1f с: яркость %d, текст ожидался: %v", x.at, got, x.lit)
		}
	}

	p.In = 2 // от второй реплики
	out = m.render(p, "mp4")
	if got := m.bandMax(out, 0.5); got < 150 {
		t.Errorf("после метки начала нет реплики: %d", got)
	}

	up := *subs
	up.Pos = "top"
	p = tracks([]Clip{{Path: src}})
	p.Subs = &up
	if got := m.bandMax(m.render(p, "mp4"), 0.5); got > 150 {
		t.Errorf("субтитры сверху попали вниз: %d", got)
	}
}

// Вжигание поверх прозрачности и 10 бит: граф собирается
func TestTimelineSubsFormats(t *testing.T) {
	m := newMontFixture(t)
	t.Setenv("LOCALAPPDATA", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", os.Getenv("LOCALAPPDATA"))
	subs := &Subs{Path: m.srt("a.srt", subsSample), Mode: subsModeBurn}
	deep := m.make("deep.mov", "-f", "lavfi", "-i", "color=black:s=320x240:r=30:d=1", "-c:v", "prores_ks", "-profile:v", "3")
	p := tracks([]Clip{{Path: deep}})
	p.Subs = subs
	if got := m.bandMax(m.render(p, "mp4"), 0.5); got < 150 {
		t.Errorf("10 бит: %d", got)
	}
	clear := m.make("clear.webm", "-f", "lavfi", "-i", "color=black@0:s=320x240:r=30:d=1,format=yuva420p", "-c:v", "libvpx-vp9", "-b:v", "200k")
	p = tracks([]Clip{{Path: clear}})
	p.Subs = subs
	m.render(p, "webm")
}

// Дорожка: нужный кодек в каждом контейнере, картинка не тронута, неподходящий формат даёт понятную ошибку
func TestTimelineSubsTrack(t *testing.T) {
	m := newMontFixture(t)
	t.Setenv("LOCALAPPDATA", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", os.Getenv("LOCALAPPDATA"))
	src := m.color("src.mp4", "black", 320, 240, 30, 3, 0)
	subs := &Subs{Path: m.srt("a.srt", subsSample), Mode: subsModeTrk}
	p := tracks([]Clip{{Path: src}})
	p.Subs = subs
	for format, codec := range map[string]string{"mp4": "mov_text", "mov": "mov_text", "mkv264": "subrip", "webm": "webvtt"} {
		if _, ok := formats[format]; !ok {
			t.Errorf("нет формата %s", format)
			continue
		}
		out := m.render(p, format)
		info, _ := exec.Command(m.ffm, "-hide_banner", "-i", out).CombinedOutput()
		if !strings.Contains(string(info), "Subtitle: "+codec) || !regexp.MustCompile(`Subtitle:.*(default)`).Match(info) {
			t.Errorf("%s: нет дорожки %s:\n%s", format, codec, info)
		}
		if got := m.bandMax(out, 0.5); got > 40 {
			t.Errorf("%s: текст попал в кадр: %d", format, got)
		}
	}
	if _, err := m.tryRender(p, "avi264"); err == nil || !strings.Contains(err.Error(), "MP4") {
		t.Errorf("avi: %v", err)
	}

	p.Subs = &Subs{Path: subs.Path, Mode: subsModeBoth} // и в кадре, и дорожкой
	both := m.render(p, "mp4")
	if info, _ := exec.Command(m.ffm, "-hide_banner", "-i", both).CombinedOutput(); !strings.Contains(string(info), "Subtitle: mov_text") {
		t.Errorf("оба: нет дорожки:\n%s", info)
	}
	if got := m.bandMax(both, 0.5); got <= 40 {
		t.Errorf("оба: текста нет в кадре: %d", got)
	}
	if _, err := m.tryRender(p, "avi264"); err == nil {
		t.Error("оба: avi без дорожки должен дать ошибку")
	}
	p.Subs = subs

	p.In, p.Out = 1, 1.5 // между реплик: результат есть, дорожки нет
	out := m.render(p, "mp4")
	if info, _ := exec.Command(m.ffm, "-hide_banner", "-i", out).CombinedOutput(); strings.Contains(string(info), "Subtitle:") {
		t.Errorf("пустая дорожка:\n%s", info)
	}
}

func TestTimelineSubsMissing(t *testing.T) {
	m := newMontFixture(t)
	src := m.color("src.mp4", "black", 320, 240, 30, 1, 0)
	p := tracks([]Clip{{Path: src}})
	p.Subs = &Subs{Path: filepath.Join(m.dir, "нет.srt"), Mode: subsModeBurn}
	if _, err := m.tryRender(p, "mp4"); err == nil || !strings.Contains(err.Error(), "нет.srt") {
		t.Error(fmt.Sprint("ошибка: ", err))
	}
}

// Правки живут в проекте: файл на диске не важен, даже если его уже нет
func TestTimelineSubsEdited(t *testing.T) {
	m := newMontFixture(t)
	t.Setenv("LOCALAPPDATA", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", os.Getenv("LOCALAPPDATA"))
	src := m.color("src.mp4", "black", 320, 240, 30, 3, 0)
	p := tracks([]Clip{{Path: src}})
	p.Subs = &Subs{Path: filepath.Join(m.dir, "нет.srt"), Mode: subsModeBurn, Cues: []SubCue{{Start: 1, End: 2, Text: "Правка"}, {Start: 2, End: 3, Text: "   "}}}
	out := m.render(p, "mp4")
	if got := m.bandMax(out, 1.5); got < 150 {
		t.Errorf("правка не попала в кадр: %d", got)
	}
	if got := m.bandMax(out, 0.5); got > 40 {
		t.Errorf("текст там, где реплики нет: %d", got)
	}
	if got := m.bandMax(out, 2.5); got > 40 {
		t.Errorf("пустая реплика дала текст: %d", got)
	}
	p.Subs.Cues = []SubCue{} // всё удалили: субтитров нет, старый файл не возвращается
	if got := m.bandMax(m.render(p, "mp4"), 1.5); got > 40 {
		t.Errorf("удалённые реплики вернулись: %d", got)
	}
}

// Вид субтитров: цвет текста, подложка и контейнер, в той же раскладке, что считает просмотр
func TestTimelineSubsLook(t *testing.T) {
	m := newMontFixture(t)
	t.Setenv("LOCALAPPDATA", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", os.Getenv("LOCALAPPDATA"))
	src := m.color("src.mp4", "black", 640, 360, 30, 1, 0)
	cues := []SubCue{{Start: 0, End: 1, Text: "ММ ММ ММ ММ ММ ММ"}}
	frame := func(s Subs) []byte {
		s.Mode = subsModeBurn
		if s.Cues == nil {
			s.Cues = cues
		}
		if s.Size == 0 {
			s.Size = 0.1
		}
		p := tracks([]Clip{{Path: src}})
		p.Subs = &s
		out, err := exec.Command(m.ffm, "-hide_banner", "-loglevel", "error", "-ss", "0.5", "-i", m.render(p, "mp4"), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-").Output()
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	// самая насыщенная красным точка и общая рамка непустых точек
	box := func(b []byte) (x0, x1, y0, y1, red, green int) {
		x0, y0 = 640, 360
		for y := 0; y < 360; y++ {
			for x := 0; x < 640; x++ {
				r, g := int(b[(y*640+x)*3]), int(b[(y*640+x)*3+1])
				if r > 60 || g > 60 {
					x0, x1, y0, y1 = min(x0, x), max(x1, x), min(y0, y), max(y1, y)
				}
				red, green = max(red, r), max(green, g)
			}
		}
		return
	}
	if _, _, _, _, r, g := box(frame(Subs{Color: "#ff0000"})); r < 200 || g > 60 {
		t.Errorf("цвет текста: красный %d, зелёный %d", r, g)
	}
	x0, x1, _, y1, _, _ := box(frame(Subs{X: 0.25, W: 0.4, Y: 0.5}))
	if mid := (x0 + x1) / 2; mid < 145 || mid > 175 {
		t.Errorf("середина по X: %d", mid)
	}
	if y1 < 165 || y1 > 182 {
		t.Errorf("нижний край по Y: %d", y1)
	}
	// узкий контейнер переносит длинную строку
	_, _, wy0, wy1, _, _ := box(frame(Subs{W: 0.2}))
	if wy1-wy0 < 50 {
		t.Errorf("строка не перенеслась: высота %d", wy1-wy0)
	}
	// рамка своей высоты: текст по её центру при любом шрифте, рамка 36–180 px, центр 108
	for _, size := range []float64{0.1, 0.03} {
		_, _, y0, y1, _, _ := box(frame(Subs{Size: size, W: 0.9, Y: 0.5, H: 0.4}))
		if mid := (y0 + y1) / 2; mid < 102 || mid > 114 {
			t.Errorf("шрифт %v: середина текста %d, ждали около 108", size, mid)
		}
	}
	// ширина рамки по-прежнему переносит строку, мелкий шрифт в той же рамке помещается в одну
	_, _, py0, py1, _, _ := box(frame(Subs{W: 0.2, Y: 0.5, H: 0.4}))
	if py1-py0 < 50 {
		t.Errorf("в рамке своей высоты строка не перенеслась: высота %d", py1-py0)
	}
	_, _, py0, py1, _, _ = box(frame(Subs{Size: 0.03, W: 0.9, Y: 0.5, H: 0.4}))
	if py1-py0 > 25 {
		t.Errorf("мелкий шрифт не уместился в одну строку: высота %d", py1-py0)
	}
	// разрыв строки в реплике: держит две строки, пока его не уберут
	broken := []SubCue{{Start: 0, End: 1, Text: "ММ ММ\nММ ММ"}}
	_, _, jy0, jy1, _, _ := box(frame(Subs{Cues: broken}))
	if jy1-jy0 < 50 {
		t.Errorf("разрыв строки потерялся: высота %d", jy1-jy0)
	}
	_, _, jy0, jy1, _, _ = box(frame(Subs{Cues: broken, Join: true}))
	if jy1-jy0 > 45 {
		t.Errorf("разрыв строки не убран: высота %d", jy1-jy0)
	}
	// подложка: вокруг букв плотный цвет, а не только сами буквы
	f := frame(Subs{Color: "#000000", Back: "#00ff00", BackA: 1})
	_, _, _, _, r, g := box(f)
	if g < 200 || r > 120 {
		t.Errorf("подложка: красный %d, зелёный %d", r, g)
	}
}

// Печатная машинка: буквы появляются по одной, строка целиком в каждом событии (не прыгает), курсор мигает.
func TestSubsFxType(t *testing.T) {
	s := Subs{Fx: SubFx{K: "type", Cps: 10, Cur: "#ff0000", Blink: true}}.fit()
	out := subsASS([]SubCue{{Start: 1, End: 2, Text: "абв"}}, s, 640, 360)
	// курсор — полоска нулевой ширины (\fsp минус её ширина): строки переносятся как у готовой реплики
	c := `{\p1\fsp-1\bord0\shad0\1a&H00&\1c&H0000FF&\pbo4}m 0 0 l 1 0 1 18 0 18{\p0\fsp0}`
	want := []string{
		`Dialogue: 0,0:00:01.00,0:00:01.10,Default,,0,0,0,,а` + c + `{\alpha&HFF&}бв`,
		`Dialogue: 0,0:00:01.10,0:00:01.20,Default,,0,0,0,,аб` + c + `{\alpha&HFF&}в`,
		`Dialogue: 0,0:00:01.20,0:00:01.50,Default,,0,0,0,,абв` + c,
		`Dialogue: 0,0:00:01.50,0:00:02.00,Default,,0,0,0,,абв`,
	}
	for _, w := range want {
		if !strings.Contains(out, w+"\n") {
			t.Errorf("нет строки %s в\n%s", w, out)
		}
	}
	if n := strings.Count(out, "Dialogue:"); n != len(want) {
		t.Errorf("событий %d, ждали %d", n, len(want))
	}
	// без курсора, с подложкой и короткой репликой: подложка слоем 0 на всю реплику, буквы слоем 1 без неё; печать ускоряется до 85% длины
	s = Subs{Back: "#000000", Fx: SubFx{K: "type", Cps: 1}}.fit()
	out = subsASS([]SubCue{{Start: 0, End: 1, Text: "аб\nв"}}, s, 640, 360)
	for _, w := range []string{"Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,{\\1a&HFF&}аб\\Nв\n", `Dialogue: 1,0:00:00.00,0:00:00.28,Default,,0,0,0,,{\3a&HFF&}а{\alpha&HFF&}б\Nв`,
		`0:00:00.28,0:00:00.57,Default,,0,0,0,,{\3a&HFF&}аб{\alpha&HFF&}\Nв`, `,,{\3a&HFF&}аб\Nв` + "\n"} {
		if !strings.Contains(out, w) {
			t.Errorf("нет %q в\n%s", w, out)
		}
	}
	// неизвестный эффект сбрасывается
	if (Subs{Fx: SubFx{K: "x", Cps: 5}}).fit().Fx != (SubFx{}) {
		t.Error("неизвестный эффект не сброшен")
	}
}
