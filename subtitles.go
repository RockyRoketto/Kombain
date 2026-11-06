package main

// Субтитры монтажа из файла .srt: вжечь в кадр или положить дорожкой в файл.
// Файл читается здесь, а не фильтром ffmpeg: кодировку и метки вывода (Project.In) считает программа,
// и в ffmpeg идёт уже готовый временный файл с нужными временами.
// Просмотр: mvSubsDraw в web/js/viewport.js. Размер, шрифт и отступы там должны совпадать с subsASS.

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

const (
	subsMaxFile  = 20 << 20
	subsSize     = 0.05 // высота строки от высоты кадра, если не задана
	subsMinSize  = 0.01
	subsMaxSize  = 0.2
	subsMargin   = 0.05 // отступ от края кадра: доля той же стороны
	subsOutline  = 0.06 // толщина обводки от высоты строки
	subsFont     = "Arial"
	subsModeBurn = "burn"
	subsModeTrk  = "track"
)

// Subs: настройки субтитров проекта. Шрифт, размер и положение важны только при вжигании:
// дорожку рисует плеер по своим настройкам.
type Subs struct {
	Path string   `json:"path"`
	Cues []SubCue `json:"cues"`           // реплики после правок; nil — взять из файла Path
	Mode string   `json:"mode"`           // subsModeBurn или subsModeTrk
	Font string   `json:"font,omitempty"` // название шрифта Windows
	Size float64  `json:"size,omitempty"` // высота строки, доля высоты кадра
	Pos  string   `json:"pos,omitempty"`  // bottom, center, top
	// Вид. Просмотр: mvSubsDraw в web/js/viewport.js. Подложка рисуется на каждую строку, тогда обводки у букв нет.
	Color string  `json:"color,omitempty"` // цвет текста #rrggbb, пусто — белый
	Back  string  `json:"back,omitempty"`  // цвет подложки #rrggbb, пусто — без неё
	BackA float64 `json:"backA,omitempty"` // её непрозрачность, 0–1
	// Контейнер: ширина и середина в долях кадра, Y — нижний край текста в долях высоты. Y задан — Pos не важен.
	W float64 `json:"w,omitempty"`
	X float64 `json:"x,omitempty"`
	Y float64 `json:"y,omitempty"`
}

var subsHex = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// subsAssColor: #rrggbb и непрозрачность в формат ASS &HAABBGGRR, где AA — наоборот, прозрачность
func subsAssColor(c string, opacity float64) string {
	return fmt.Sprintf("&H%02X%s%s%s", int((1-opacity)*255+0.5), strings.ToUpper(c[5:7]), strings.ToUpper(c[3:5]), strings.ToUpper(c[1:3]))
}

type SubCue struct {
	Start float64 `json:"a"`
	End   float64 `json:"b"`
	Text  string  `json:"t"`
}

var (
	subsTime = regexp.MustCompile(`^\s*(\d+):(\d{1,2}):(\d{1,2})[,.](\d{1,3})\s*-->\s*(\d+):(\d{1,2}):(\d{1,2})[,.](\d{1,3})`)
	subsTags = regexp.MustCompile(`</?[a-zA-Z][^>]*>|\{\\[^}]*\}`)
)

// cp1251High: символы 0x80–0xBF. С 0xC0 идут заглавные и строчные русские буквы подряд, от U+0410.
var cp1251High = []rune{
	0x0402, 0x0403, 0x201A, 0x0453, 0x201E, 0x2026, 0x2020, 0x2021, 0x20AC, 0x2030, 0x0409, 0x2039, 0x040A, 0x040C, 0x040B, 0x040F,
	0x0452, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0xFFFD, 0x2122, 0x0459, 0x203A, 0x045A, 0x045C, 0x045B, 0x045F,
	0x00A0, 0x040E, 0x045E, 0x0408, 0x00A4, 0x0490, 0x00A6, 0x00A7, 0x0401, 0x00A9, 0x0404, 0x00AB, 0x00AC, 0x00AD, 0x00AE, 0x0407,
	0x00B0, 0x00B1, 0x0406, 0x0456, 0x0491, 0x00B5, 0x00B6, 0x00B7, 0x0451, 0x2116, 0x0454, 0x00BB, 0x0458, 0x0405, 0x0455, 0x0457,
}

// subsDecode: UTF-8 или UTF-16 с меткой, UTF-8 без метки, остальное считаем CP1251: так обычно сохранены старые русские субтитры.
func subsDecode(b []byte) string {
	switch {
	case len(b) >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF:
		return string(b[3:])
	case len(b) >= 2 && ((b[0] == 0xFF && b[1] == 0xFE) || (b[0] == 0xFE && b[1] == 0xFF)):
		big := b[0] == 0xFE
		units := make([]uint16, 0, len(b)/2)
		for i := 2; i+1 < len(b); i += 2 {
			if big {
				units = append(units, uint16(b[i])<<8|uint16(b[i+1]))
			} else {
				units = append(units, uint16(b[i+1])<<8|uint16(b[i]))
			}
		}
		return string(utf16.Decode(units))
	case utf8.Valid(b):
		return string(b)
	}
	var sb strings.Builder
	for _, c := range b {
		switch {
		case c < 0x80:
			sb.WriteByte(c)
		case c < 0xC0:
			sb.WriteRune(cp1251High[c-0x80])
		default:
			sb.WriteRune(0x0410 + rune(c-0xC0))
		}
	}
	return sb.String()
}

func subsClock(h, m, s, ms string) float64 {
	hh, _ := strconv.Atoi(h)
	mm, _ := strconv.Atoi(m)
	ss, _ := strconv.Atoi(s)
	frac, _ := strconv.Atoi((ms + "00")[:3]) // ",5" это 500 мс
	return float64(hh)*3600 + float64(mm)*60 + float64(ss) + float64(frac)/1000
}

// subsParse разбирает текст .srt. Оформление вроде <i> убирается: вжигание и просмотр рисуют все строки одинаково.
func subsParse(text string) []SubCue {
	var cues []SubCue
	var cur *SubCue
	var body []string
	flush := func() {
		if cur != nil {
			cur.Text = strings.TrimSpace(subsTags.ReplaceAllString(strings.Join(body, "\n"), ""))
			if cur.Text != "" && cur.End > cur.Start {
				cues = append(cues, *cur)
			}
		}
		cur, body = nil, nil
	}
	for _, line := range strings.Split(strings.ReplaceAll(text, "\r", ""), "\n") {
		if m := subsTime.FindStringSubmatch(line); m != nil {
			flush()
			cur = &SubCue{Start: subsClock(m[1], m[2], m[3], m[4]), End: subsClock(m[5], m[6], m[7], m[8])}
			continue
		}
		if strings.TrimSpace(line) == "" {
			flush()
			continue
		}
		if cur != nil {
			body = append(body, line)
		}
	}
	flush()
	slices.SortStableFunc(cues, func(a, b SubCue) int {
		switch {
		case a.Start < b.Start:
			return -1
		case a.Start > b.Start:
			return 1
		}
		return 0
	})
	return cues
}

func subsRead(path string) ([]SubCue, error) {
	st, err := os.Stat(path)
	if err != nil {
		return nil, errT("subs.notFound", filepath.Base(path))
	}
	if st.Size() > subsMaxFile {
		return nil, errT("subs.tooBig", filepath.Base(path))
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	cues := subsParse(subsDecode(b))
	if len(cues) == 0 {
		return nil, errT("subs.empty", filepath.Base(path))
	}
	return cues, nil
}

// subsRange: реплики между метками вывода, время от начала результата
func subsRange(cues []SubCue, offset, dur float64) []SubCue {
	var out []SubCue
	for _, c := range cues {
		a, b := max(c.Start-offset, 0), min(c.End-offset, dur)
		if text := strings.TrimSpace(c.Text); b > a && text != "" {
			out = append(out, SubCue{a, b, text})
		}
	}
	return out
}

// subsFit: значения из проекта в допустимые пределы. Шрифт попадает в строку стиля, где запятая делит поля.
func (s Subs) fit() Subs {
	if s.Size <= 0 {
		s.Size = subsSize
	}
	s.Size = min(max(s.Size, subsMinSize), subsMaxSize)
	s.Font = strings.NewReplacer(",", "", "\n", "", "\r", "").Replace(s.Font)
	if s.Font == "" {
		s.Font = subsFont
	}
	if !subsHex.MatchString(s.Color) {
		s.Color = "#ffffff"
	}
	if !subsHex.MatchString(s.Back) {
		s.Back = ""
	}
	if s.BackA <= 0 {
		s.BackA = 0.6
	}
	s.BackA = min(s.BackA, 1)
	if s.W <= 0 {
		s.W = 1 - 2*subsMargin
	}
	s.W = min(max(s.W, 0.1), 1)
	if s.X <= 0 {
		s.X = 0.5
	}
	s.X = min(max(s.X, s.W/2), 1-s.W/2) // контейнер целиком в кадре
	s.Y = min(max(s.Y, 0), 1)
	return s
}

func subsAssClock(v float64) string {
	cs := int(v*100 + 0.5)
	return fmt.Sprintf("%d:%02d:%02d.%02d", cs/360000, cs/6000%60, cs/100%60, cs%100)
}

// subsASS: файл для вжигания. Размеры в пикселях кадра (PlayRes). Encoding -1: направление письма по самой строке, иначе у арабского уедет знак в конце.
func subsASS(cues []SubCue, s Subs, w, h int) string {
	align := 2
	switch s.Pos {
	case "center":
		align = 5
	case "top":
		align = 8
	}
	size := s.Size * float64(h)
	marginV := int(subsMargin*float64(h) + 0.5)
	if s.Y > 0 {
		align, marginV = 2, int((1-s.Y)*float64(h)+0.5)
	}
	marginL, marginR := int((s.X-s.W/2)*float64(w)+0.5), int((1-s.X-s.W/2)*float64(w)+0.5)
	border, outlineCol, outline := 1, "&H00000000", size*subsOutline
	if s.Back != "" {
		border, outlineCol, outline = 3, subsAssColor(s.Back, s.BackA), size*subsOutline*2
	}
	var sb strings.Builder
	fmt.Fprintf(&sb, "[Script Info]\nScriptType: v4.00+\nPlayResX: %d\nPlayResY: %d\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n", w, h)
	sb.WriteString("[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n")
	col := subsAssColor(s.Color, 1)
	fmt.Fprintf(&sb, "Style: Default,%s,%.2f,%s,%s,%s,&H00000000,0,0,0,0,100,100,0,0,%d,%.2f,0,%d,%d,%d,%d,-1\n\n",
		s.Font, size, col, col, outlineCol, border, outline, align, marginL, marginR, marginV)
	sb.WriteString("[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n")
	esc := strings.NewReplacer("\n", `\N`, "{", `\{`, "}", `\}`)
	for _, c := range cues {
		fmt.Fprintf(&sb, "Dialogue: 0,%s,%s,Default,,0,0,0,,%s\n", subsAssClock(c.Start), subsAssClock(c.End), esc.Replace(c.Text))
	}
	return sb.String()
}

func subsSRT(cues []SubCue) string {
	clock := func(v float64) string {
		ms := int(v*1000 + 0.5)
		return fmt.Sprintf("%02d:%02d:%02d,%03d", ms/3600000, ms/60000%60, ms/1000%60, ms%1000)
	}
	var sb strings.Builder
	for i, c := range cues {
		fmt.Fprintf(&sb, "%d\n%s --> %s\n%s\n\n", i+1, clock(c.Start), clock(c.End), c.Text)
	}
	return sb.String()
}

func subsDir() string { return filepath.Join(cacheDir(), "subs") }

// saveTextPNG: картинка клипа «Текст». Имя по содержимому: одинаковый текст даёт один файл. Настоящие данные лежат в проекте, страница рисует заново при открытии.
func saveTextPNG(b64 string) (string, error) {
	b, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return "", err
	}
	if !bytes.HasPrefix(b, []byte("\x89PNG\r\n\x1a\n")) {
		return "", errors.New("not a PNG")
	}
	dir := filepath.Join(cacheDir(), "text")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	sum := sha256.Sum256(b)
	p := filepath.Join(dir, hex.EncodeToString(sum[:12])+".png")
	if fileExists(p) {
		return p, nil
	}
	tmp, err := os.CreateTemp(dir, "*.part")
	if err != nil {
		return "", err
	}
	_, err = tmp.Write(b)
	if e := tmp.Close(); err == nil {
		err = e
	}
	if err == nil {
		err = os.Rename(tmp.Name(), p)
	}
	if err != nil {
		os.Remove(tmp.Name())
		return "", err
	}
	return p, nil
}

// subsTemp: у каждого запуска свой файл, их убирает следующий запуск программы и её закрытие (startServer, stopAll)
func subsTemp(ext, text string) (string, error) {
	dir := subsDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	f, err := os.CreateTemp(dir, "*"+ext)
	if err != nil {
		return "", err
	}
	_, err = f.WriteString(text)
	if e := f.Close(); err == nil {
		err = e
	}
	if err != nil {
		os.Remove(f.Name())
		return "", err
	}
	return f.Name(), nil
}

// subsFilterPath: путь как значение параметра фильтра внутри графа. Экранирование двойное: для параметра и для самого графа.
func subsFilterPath(p string) string {
	p = strings.NewReplacer(`\`, `\\`, `'`, `\'`, `:`, `\:`).Replace(filepath.ToSlash(p))
	return strings.NewReplacer(`\`, `\\`, `'`, `\'`, `[`, `\[`, `]`, `\]`, `,`, `\,`, `;`, `\;`).Replace(p)
}

// subsTrackCodec: чем записать дорожку в этот контейнер; пусто, если такой дорожки в нём быть не может
func subsTrackCodec(f Format) string {
	if f.Kind == "gif" || f.Kind == "anim" {
		return ""
	}
	switch strings.ToLower(f.Ext) {
	case "mp4", "m4v", "mov":
		return "mov_text"
	case "mkv":
		return "srt"
	case "webm":
		return "webvtt"
	}
	return ""
}

// subsPlan дополняет готовый план монтажа субтитрами. inputs — сколько входов уже занято.
// Реплик между метками нет: результат просто без субтитров.
func subsPlan(si *srcInfo, sub Subs, f Format, offset float64, inputs int) error {
	sub = sub.fit()
	if sub.Mode == subsModeTrk && subsTrackCodec(f) == "" {
		return errT("mont.subsTrack")
	}
	all := sub.Cues
	if all == nil {
		var err error
		if all, err = subsRead(sub.Path); err != nil {
			return err
		}
	}
	cues := subsRange(all, offset, si.dur)
	if len(cues) == 0 {
		return nil
	}
	if sub.Mode == subsModeTrk {
		name, err := subsTemp(".srt", subsSRT(cues))
		if err != nil {
			return err
		}
		si.inputs = append(si.inputs, "-i", name)
		// default: без этой отметки многие плееры дорожку не включают, и кажется, что её нет
		si.subsMap = []string{"-map", fmt.Sprintf("%d:0", inputs), "-c:s", subsTrackCodec(f), "-disposition:s:0", "default"}
		return nil
	}
	name, err := subsTemp(".ass", subsASS(cues, sub, si.w, si.h))
	if err != nil {
		return err
	}
	if !strings.Contains(si.graph, "[v]") {
		return errors.New("subs: no video output")
	}
	// [v] в графе всего один: это конец видео. Метка меняется на промежуточную, субтитры встают последним шагом.
	si.graph = strings.Replace(si.graph, "[v]", "[vb]", 1) + ";[vb]ass=filename=" + subsFilterPath(name) + "[v]"
	return nil
}
