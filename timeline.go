package main

// Движок дорожек: проект из дорожек и клипов со временем превращается в один граф ffmpeg.
// Дорожка собирается фильтром concat, верхние дорожки ложатся на нижние через overlay, звук всех клипов смешивает amix.
// Все границы клипов стоят на сетке кадров: так длина результата точная, а дорожка не уезжает от накопленных округлений.

import (
	"cmp"
	"context"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Project: монтаж целиком. Дорожка с меньшим номером лежит ниже, верхняя закрывает её картинкой.
type Project struct {
	W      int     `json:"w"` // размер кадра; 0 — как у первого видео
	H      int     `json:"h"`
	FPS    float64 `json:"fps"`           // кадров в секунду; 0 — как у первого видео
	In     float64 `json:"in,omitempty"`  // метка начала вывода, секунда на дорожках
	Out    float64 `json:"out,omitempty"` // метка конца; 0 — до конца монтажа
	Tracks []Track `json:"tracks"`
	Subs   *Subs   `json:"subs,omitempty"` // субтитры из файла, см. subtitles.go
}

type Track struct {
	Clips []Clip `json:"clips"`
}

// Clip: кусок файла на дорожке. Повтор — это копии клипа.
type Clip struct {
	Path    string  `json:"path"`
	At      float64 `json:"at"`             // секунда на дорожке, с которой клип начинается
	From    float64 `json:"from"`           // откуда брать в файле
	Len     float64 `json:"len"`            // сколько секунд файла взять; 0 — до конца; у фото — сколько показывать
	Speed   float64 `json:"speed"`          // 0 и 1 — как есть
	Reverse bool    `json:"reverse"`        // задом наперёд
	Part    string  `json:"part,omitempty"` // что брать из файла: "v" картинку, "a" звук, пусто всё сразу
	// Рамка слоя в долях кадра: левый верхний угол и размер. Без W слой вписан в кадр по центру.
	// Предпросмотр ставит картинку по тем же долям (mvBox в web/js/viewport.js).
	X float64 `json:"x,omitempty"`
	Y float64 `json:"y,omitempty"`
	W float64 `json:"w,omitempty"`
	H float64 `json:"h,omitempty"`
	// Поворот вокруг середины рамки, градусы по часовой. Кадрирование: сколько срезано с каждой стороны, доли слоя. Рамка при этом не меняется.
	Rot   float64 `json:"rot,omitempty"`
	CropL float64 `json:"cl,omitempty"`
	CropT float64 `json:"ct,omitempty"`
	CropR float64 `json:"cr,omitempty"`
	CropB float64 `json:"cb,omitempty"`
	// Громкость, 1 — как в файле; без значения тоже 1. Указатель, потому что 0 это тишина.
	Vol *float64 `json:"vol,omitempty"`
	// Плавное появление и исчезание, секунды на дорожке: у картинки прозрачность, у звука громкость
	FadeIn  float64 `json:"fadeIn,omitempty"`
	FadeOut float64 `json:"fadeOut,omitempty"`
	// Удаление фона по цвету: цвет #rrggbb (пусто — выключено), допуск, мягкость края и подавление отсвета, доли. Просмотр: web/js/chroma.js
	KeyColor string  `json:"key,omitempty"`
	KeySim   float64 `json:"keySim,omitempty"`
	KeyBlend float64 `json:"keyBlend,omitempty"`
	KeySpill float64 `json:"keySpill,omitempty"`
	// Цветокоррекция, каждое значение от -1 до 1, 0 — как в файле. Просмотр: web/js/chroma.js
	ColBri  float64 `json:"cBri,omitempty"`  // яркость
	ColCon  float64 `json:"cCon,omitempty"`  // контраст
	ColMid  float64 `json:"cMid,omitempty"`  // средние тона
	ColSat  float64 `json:"cSat,omitempty"`  // насыщенность
	ColTemp float64 `json:"cTemp,omitempty"` // температура: больше нуля теплее
	ColTint float64 `json:"cTint,omitempty"` // оттенок: больше нуля в пурпурный, меньше в зелёный
	Blend   string  `json:"blend,omitempty"` // режим наложения, см. tlBlends; пусто: обычный
	// Размытие и тень. Длины в долях высоты кадра: σ гауссианы и смещение. Просмотр: mvFx в web/js/viewport.js
	Blur    float64 `json:"blur,omitempty"`
	ShadowA float64 `json:"shA,omitempty"` // непрозрачность тени, 0 — тени нет
	ShadowX float64 `json:"shX,omitempty"`
	ShadowY float64 `json:"shY,omitempty"`
	ShadowB float64 `json:"shB,omitempty"` // мягкость
	ShadowC string  `json:"shC,omitempty"` // цвет
}

func (c Clip) volume() float64 {
	if c.Vol == nil {
		return 1
	}
	return *c.Vol
}

func (c Clip) cropped() bool { return c.CropL > 0 || c.CropT > 0 || c.CropR > 0 || c.CropB > 0 }

const (
	tlPhotoLen  = 5.0  // секунд, если у фото не задана длина
	tlRate      = 30.0 // кадров в секунду, если видео нет и взять её неоткуда
	tlSoundGrid = 1000 // в монтаже только со звуком сетка в миллисекунду
	tlMaxFPS    = 240
	tlAudioHz   = 48000

	tlMaxBox  = 4.0  // рамка слоя не больше стольких кадров: дальше ffmpeg не хватит памяти на кадр
	tlMinSeen = 0.01 // какая часть кадра всегда остаётся за слоем, иначе его не поймать мышью
	tlMaxCrop = 0.98 // сколько слоя можно срезать: что-то должно остаться
	tlMaxVol  = 2.0  // громкость не больше 200%
	tlMaxSide = 7680 // сторона холста
	tlMinSide = 16

	tlGraphInline = 2000  // граф длиннее этого передаётся файлом (spillGraph)
	tlMaxInputs   = 28000 // входы файлом не передать: это их предел в командной строке, остальное место занимают настройки кодека
)

// fit: значения из интерфейса в допустимые пределы
func (p *Project) fit() {
	if p.W <= 0 || p.H <= 0 {
		p.W, p.H = 0, 0
	} else { // чётный размер: иначе yuv420p не собрать
		p.W = min(max(p.W, tlMinSide), tlMaxSide) &^ 1
		p.H = min(max(p.H, tlMinSide), tlMaxSide) &^ 1
	}
	p.FPS = min(max(p.FPS, 0), tlMaxFPS)
	p.In, p.Out = max(p.In, 0), max(p.Out, 0)
	if p.Out > 0 && p.Out <= p.In {
		p.In, p.Out = 0, 0
	}
	for t := range p.Tracks {
		for i := range p.Tracks[t].Clips {
			c := &p.Tracks[t].Clips[i]
			c.At, c.From, c.Len = max(c.At, 0), max(c.From, 0), max(c.Len, 0)
			if c.Speed <= 0 {
				c.Speed = 1
			}
			c.Speed = min(max(c.Speed, montMinSpeed), montMaxSpeed)
			if c.W > 0 && c.H > 0 {
				c.W, c.H = min(c.W, tlMaxBox), min(c.H, tlMaxBox)
				c.X = min(max(c.X, tlMinSeen-c.W), 1-tlMinSeen)
				c.Y = min(max(c.Y, tlMinSeen-c.H), 1-tlMinSeen)
			} else {
				c.X, c.Y, c.W, c.H = 0, 0, 0, 0
			}
			c.Rot = math.Mod(c.Rot, 360)
			c.CropL, c.CropR = tlCropPair(c.CropL, c.CropR)
			c.CropT, c.CropB = tlCropPair(c.CropT, c.CropB)
			if c.Vol != nil {
				v := min(max(*c.Vol, 0), tlMaxVol)
				c.Vol = &v
			}
			c.FadeIn, c.FadeOut = max(c.FadeIn, 0), max(c.FadeOut, 0)
			if !tlKeyRe.MatchString(c.KeyColor) { // значение идёт в граф ffmpeg, поэтому только настоящий цвет
				c.KeyColor = ""
			}
			c.KeySim = min(max(c.KeySim, 0.001), 1)
			c.KeyBlend = min(max(c.KeyBlend, 0), 1)
			c.KeySpill = min(max(c.KeySpill, 0), 1)
			if _, ok := tlBlends[c.Blend]; !ok { // значение идёт в граф ffmpeg, поэтому только из списка
				c.Blend = ""
			}
			c.Blur, c.ShadowB = min(max(c.Blur, 0), tlMaxBlur), min(max(c.ShadowB, 0), tlMaxBlur)
			c.ShadowA = min(max(c.ShadowA, 0), 1)
			c.ShadowX, c.ShadowY = min(max(c.ShadowX, -1), 1), min(max(c.ShadowY, -1), 1)
			if !tlKeyRe.MatchString(c.ShadowC) {
				c.ShadowC = "#000000"
			}
			for _, v := range []*float64{&c.ColBri, &c.ColCon, &c.ColMid, &c.ColSat, &c.ColTemp, &c.ColTint} {
				*v = min(max(*v, -1), 1)
			}
		}
	}
}

// tlCropPair: две противоположные стороны кадрирования, вместе они не съедают весь слой
func tlCropPair(a, b float64) (float64, float64) {
	a, b = min(max(a, 0), tlMaxCrop), min(max(b, 0), tlMaxCrop)
	if over := a + b - tlMaxCrop; over > 0 {
		a, b = a-over*a/(a+b), b-over*b/(a+b)
	}
	return a, b
}

// paths: файлы проекта без повторов, в порядке появления
func (p Project) paths() []string {
	var out []string
	for _, t := range p.Tracks {
		for _, c := range t.Clips {
			if !slices.Contains(out, c.Path) {
				out = append(out, c.Path)
			}
		}
	}
	return out
}

// lead: файл, по которому назван результат: самый ранний клип самой нижней непустой дорожки
func (p Project) lead() string {
	for _, t := range p.Tracks {
		if len(t.Clips) > 0 {
			return slices.MinFunc(t.Clips, func(a, b Clip) int { return cmp.Compare(a.At, b.At) }).Path
		}
	}
	return ""
}

// tlClip: клип, про файл которого уже всё известно
type tlClip struct {
	Clip
	montClip
	photo      bool
	start, end int // границы на дорожке, в кадрах
	whole      int // длина клипа в кадрах до меток вывода: плавность считается от неё
	head       int // сколько кадров клипа срезала метка начала
	input      int // номер входа ffmpeg
}

func (c tlClip) frames() int { return c.end - c.start }

// srcLen: сколько секунд файла реально достанется клипу. За концом файла не остаётся ничего.
func (c tlClip) srcLen() float64 {
	if c.cut <= 0 {
		return 0
	}
	return c.dur()
}

// tlRead читает сведения о файлах. Копии одного клипа не заставляют читать файл второй раз.
func tlRead(ctx context.Context, ffm string, p Project) ([][]tlClip, error) {
	known := map[string]srcInfo{}
	var tracks [][]tlClip
	for _, t := range p.Tracks {
		var list []tlClip
		for _, c := range t.Clips {
			si, ok := known[c.Path]
			if !ok {
				si = probe(ctx, ffm, c.Path)
				known[c.Path] = si
			}
			if !si.video && !si.audio {
				return nil, errT("mont.unreadable", filepath.Base(c.Path))
			}
			item, err := tlPrepare(c, si)
			if err != nil {
				return nil, err
			}
			list = append(list, item)
		}
		tracks = append(tracks, list)
	}
	return tracks, nil
}

// tlPrepare определяет, какой кусок файла берёт клип. У фото нет ни скорости, ни реверса, есть только время показа.
func tlPrepare(c Clip, si srcInfo) (tlClip, error) {
	switch c.Part {
	case "v":
		si.audio = false
	case "a":
		si.video = false
	}
	item := tlClip{Clip: c, montClip: montClip{path: c.Path, si: si}}
	if imageExt[strings.ToLower(filepath.Ext(c.Path))] {
		item.photo, item.Speed, item.Reverse = true, 1, false
		item.si.dur = c.Len
		if item.si.dur <= 0 {
			item.si.dur = tlPhotoLen
		}
		item.cut = item.si.dur
		return item, nil
	}
	if c.Len <= 0 && si.dur <= 0 {
		return tlClip{}, errT("mont.noLength", filepath.Base(c.Path))
	}
	item.from, item.cut = c.From, c.Len
	if c.Len <= 0 {
		item.cut = si.dur - c.From
	}
	return item, nil
}

// tlFirst: самый ранний подходящий клип самой нижней дорожки, где такой есть
func tlFirst(tracks [][]tlClip, fits func(tlClip) bool) (tlClip, bool) {
	for _, list := range tracks {
		var best tlClip
		found := false
		for _, c := range list {
			if fits(c) && (!found || c.At < best.At) {
				best, found = c, true
			}
		}
		if found {
			return best, true
		}
	}
	return tlClip{}, false
}

// tlCanvas: размер кадра и частота результата. Фото частоту не задают, у них она ничего не значит.
func tlCanvas(tracks [][]tlClip, p Project) (w, h int, fps float64) {
	lead, ok := tlFirst(tracks, func(c tlClip) bool { return c.si.video && !c.photo })
	fps = tlRate
	if ok && lead.si.fps > 0 {
		fps = min(lead.si.fps, tlMaxFPS)
	}
	if !ok {
		lead, ok = tlFirst(tracks, func(c tlClip) bool { return c.si.video })
	}
	if !ok {
		return 0, 0, tlSoundGrid
	}
	w, h = lead.size()
	if p.W > 0 {
		w, h = p.W, p.H
	}
	if p.FPS > 0 {
		fps = p.FPS
	}
	return w, h, fps
}

// tlPlace ставит клипы на сетку кадров. Если клипы одной дорожки заехали друг на друга, ранний обрывается там, где начался поздний.
func tlPlace(tracks [][]tlClip, fps float64) ([][]tlClip, int) {
	frame := func(sec float64) int { return int(sec*fps + 0.5) }
	var out [][]tlClip
	total := 0
	for _, list := range tracks {
		list = slices.Clone(list)
		slices.SortStableFunc(list, func(a, b tlClip) int { return cmp.Compare(a.At, b.At) })
		var kept []tlClip
		for i, c := range list {
			c.start = frame(c.At)
			c.end = frame(c.At + c.srcLen()/c.Speed)
			if i+1 < len(list) {
				c.end = min(c.end, frame(list[i+1].At))
			}
			if c.end > c.start {
				c.whole = c.end - c.start
				kept = append(kept, c)
				total = max(total, c.end)
			}
		}
		out = append(out, kept)
	}
	return out, total
}

// tlRange оставляет от монтажа кусок между метками: лишние клипы не попадают во входы, крайние начинаются и кончаются на метке.
// Кадры до метки начала никто не считает, поэтому короткая область из длинного монтажа собирается быстро.
func tlRange(tracks [][]tlClip, p Project, fps float64, total int) ([][]tlClip, int, error) {
	if p.In <= 0 && p.Out <= 0 {
		return tracks, total, nil
	}
	a, b := int(p.In*fps+0.5), total
	if p.Out > 0 {
		b = min(b, max(int(p.Out*fps+0.5), a+1))
	}
	var out [][]tlClip
	found := false
	for _, list := range tracks {
		var kept []tlClip
		for _, c := range list {
			lo, hi := max(c.start, a), min(c.end, b)
			if hi <= lo {
				continue
			}
			length := c.srcLen()
			skip := float64(lo-c.start) / fps * c.Speed // сколько секунд файла осталось до метки начала
			rest := float64(int((c.At+length/c.Speed)*fps+0.5)-hi) / fps * c.Speed
			switch {
			case c.photo:
				c.cut = float64(hi-lo) / fps
				c.si.dur = c.cut
			case c.Reverse: // кадры идут от конца куска: до метки начала лежит его конец, после метки конца его начало
				c.from += rest
				c.cut = max(length-skip-rest, c.Speed/fps)
			default:
				c.from += skip
				c.cut = max(length-skip, c.Speed/fps)
			}
			c.head = lo - c.start
			c.start, c.end = lo-a, hi-a
			kept = append(kept, c)
			found = true
		}
		out = append(out, kept)
	}
	if !found {
		return nil, 0, errT("mont.rangeEmpty")
	}
	return out, b - a, nil
}

// tlOffset: с какой секунды дорожек начинается результат: метка начала на сетке кадров, как в tlRange
func tlOffset(p Project, fps float64) float64 {
	if p.In <= 0 && p.Out <= 0 {
		return 0
	}
	return float64(int(p.In*fps+0.5)) / fps
}

// timelineInfo: всё, что нужно buildArgs, чтобы собрать проект в формат f
func timelineInfo(ctx context.Context, ffm string, p Project, f Format) (srcInfo, error) {
	p.fit()
	tracks, err := tlRead(ctx, ffm, p)
	if err != nil {
		return srcInfo{}, err
	}
	return tlPlan(tracks, p, f)
}

// tlPlan собирает входы и граф. На выходе те же метки [v] и [a], что у montPlan.
func tlPlan(tracks [][]tlClip, p Project, f Format) (srcInfo, error) {
	w, h, fps := tlCanvas(tracks, p)
	tracks, total := tlPlace(tracks, fps)
	if total == 0 {
		return srcInfo{}, errT("mont.noClips")
	}
	tracks, total, err := tlRange(tracks, p, fps, total)
	if err != nil {
		return srcInfo{}, err
	}
	var anyAudio, anyVideo, alpha, deep bool
	keep := tlKeepsAlpha(f)
	var first string
	var reversed []montClip
	for _, list := range tracks {
		for _, c := range list {
			if first == "" {
				first = c.path
			}
			anyAudio = anyAudio || c.si.audio
			anyVideo = anyVideo || c.si.video
			alpha = alpha || (c.si.video && (c.si.alpha || (c.KeyColor != "" && keep)))
			deep = deep || (c.si.video && c.si.deep)
			if c.Reverse {
				reversed = append(reversed, c.montClip)
			}
		}
	}
	wantV, wantA := !f.audioOnly(), anyAudio && f.Kind != "gif" && f.Kind != "anim"
	if wantV && !anyVideo {
		return srcInfo{}, errT("mont.noVideo", filepath.Base(first))
	}
	if !wantV && !anyAudio {
		return srcInfo{}, errT("mont.noAudio", filepath.Base(first))
	}
	if wantV {
		if err := checkReverseRAM(reversed, 1); err != nil {
			return srcInfo{}, err
		}
	}

	si := srcInfo{w: w, h: h, fps: fps, video: wantV, audio: wantA, dur: float64(total) / fps, alpha: wantV && alpha}
	inputs := 0
	for t := range tracks {
		for i := range tracks[t] { // только те клипы, что что-то дают результату
			if c := &tracks[t][i]; (wantV && c.si.video) || (wantA && c.si.audio) {
				c.input = inputs
				inputs++
				si.inputs = append(si.inputs, tlInput(*c, fps)...)
			}
		}
	}
	var graph []string
	if wantV {
		graph = append(graph, tlVideoGraph(tracks, w, h, fps, total, alpha, deep, keep)...)
	}
	if wantA {
		graph = append(graph, tlAudioGraph(tracks, fps, total)...)
	}
	si.graph = strings.Join(graph, ";")
	if p.Subs != nil && wantV {
		if err := subsPlan(&si, *p.Subs, f, tlOffset(p, fps), inputs); err != nil {
			return srcInfo{}, err
		}
	}
	if cmdLen(si.inputs) > tlMaxInputs {
		return srcInfo{}, errT("mont.tooMany")
	}
	return si, nil
}

// cmdLen: сколько символов займут аргументы в командной строке, с запасом на кавычки и пробелы
func cmdLen(args []string) int {
	n := 0
	for _, a := range args {
		n += utf8.RuneCountInString(a) + 3
	}
	return n
}

// spillGraph: граф длиннее tlGraphInline уходит в файл: в Windows командная строка не длиннее 32 тысяч символов.
// clean убирает этот файл. Короткий граф остаётся в команде: так его видно в логе, и старый ffmpeg его поймёт.
func spillGraph(args []string) (out []string, clean func(), err error) {
	clean = func() {}
	at := slices.Index(args, "-filter_complex")
	if at < 0 || at+1 >= len(args) || len(args[at+1]) <= tlGraphInline {
		return args, clean, nil
	}
	f, err := os.CreateTemp("", "konvertor-graph-*.txt")
	if err != nil {
		return nil, clean, err
	}
	name := f.Name()
	clean = func() { os.Remove(name) }
	_, err = f.WriteString(args[at+1])
	if e := f.Close(); err == nil {
		err = e
	}
	if err != nil {
		clean()
		return nil, func() {}, err
	}
	out = slices.Clone(args)
	out[at], out[at+1] = "-/filter_complex", name
	return out, clean, nil
}

func secs(v float64) string { return strconv.FormatFloat(v, 'f', 6, 64) }

func rateStr(fps float64) string { return strconv.FormatFloat(fps, 'f', 3, 64) }

func tlInput(c tlClip, fps float64) []string {
	var a []string
	if c.si.decoder != "" {
		a = append(a, "-c:v", c.si.decoder)
	}
	if c.photo {
		return append(a, "-loop", "1", "-framerate", rateStr(fps), "-t", secs(c.cut), "-i", c.path)
	}
	return append(a, "-ss", secs(c.from), "-t", secs(c.cut), "-i", c.path)
}

// tlVideoGraph: у каждой дорожки своя склейка, потом они ложатся друг на друга.
// Нижняя занимает всё время, пустоты в ней чёрные (прозрачные, если в монтаже есть слой с прозрачностью).
// Верхняя начинается со своего первого клипа и заканчивается с последним: вне их overlay отдаёт то, что ниже.
func tlVideoGraph(tracks [][]tlClip, w, h int, fps float64, total int, alpha, deep, keep bool) []string {
	layers := tlLayers(tracks)
	// одна непрозрачная дорожка формат не трогает: 10 бит исходника доходят до результата как в обычной склейке
	mainFmt, upperFmt := "", "yuva420p"
	if deep {
		upperFmt = "yuva444p10le"
	}
	if alpha {
		mainFmt = upperFmt
	} else if len(layers) > 1 {
		mainFmt = "yuv420p"
		if deep {
			mainFmt = "yuv444p10le"
		}
	}
	var graph []string
	under := ""
	for l, lay := range layers {
		layer, blend := lay.clips, tlBlends[lay.blend]
		bottom := l == 0
		bg, pix := "black@0", upperFmt
		if bottom {
			pix = mainFmt
			if !alpha {
				bg = "black"
			}
		}
		var join []string
		gap := func(n int) {
			label := fmt.Sprintf("[g%d_%d]", l, len(join))
			chain := []string{fmt.Sprintf("color=c=%s:s=%dx%d:r=%s", bg, w, h, rateStr(fps))}
			if pix != "" {
				chain = append(chain, "format="+pix)
			}
			graph = append(graph, strings.Join(append(chain, fmt.Sprintf("trim=end_frame=%d", n)), ",")+label)
			join = append(join, label)
		}
		pos, first := 0, 0
		for _, c := range layer {
			if !c.si.video {
				continue
			}
			if !bottom && blend == "" && len(join) == 0 {
				pos, first = c.start, c.start
			}
			if c.start > pos {
				gap(c.start - pos)
			}
			label := fmt.Sprintf("[c%d_%d]", l, len(join))
			graph = append(graph, fmt.Sprintf("[%d:v:0]%s%s", c.input, tlClipChain(c, w, h, fps, pix, bg, bottom && !keep), label))
			join = append(join, label)
			pos = c.end
		}
		if (bottom || blend != "") && pos < total { // blend ждёт кадры обоих входов, поэтому слой с режимом идёт всю длину монтажа
			gap(total - pos)
		}
		out := fmt.Sprintf("[t%d]", l)
		if len(layers) == 1 {
			out = "[v]"
		}
		concat := fmt.Sprintf("%sconcat=n=%d:v=1:a=0", strings.Join(join, ""), len(join))
		if first > 0 {
			concat += fmt.Sprintf(",setpts=PTS+%s/TB", secs(float64(first)/fps))
		}
		graph = append(graph, concat+out)
		if bottom {
			under = out
			continue
		}
		next := fmt.Sprintf("[o%d]", l)
		if l == len(layers)-1 {
			next = "[v]"
		}
		if blend != "" {
			rgb := "format=gbrp"
			if deep {
				rgb = "format=gbrp10le"
			}
			base, top := fmt.Sprintf("[u%d]", l), fmt.Sprintf("[m%d]", l)
			graph = append(graph, tlBlendGraph(under, out, base, top, l, upperFmt, rgb, blend)...)
			under, out = base, top
		}
		graph = append(graph, under+out+"overlay=format=auto:eof_action=pass"+next)
		under = next
	}
	return graph
}

// tlBlends: режимы наложения: значение mix-blend-mode в просмотре → режим фильтра blend. Числа совпадают по формулам,
// проверка в TestTimelineBlend. Названия overlay и hardlight у ffmpeg поменяны местами относительно CSS: так и надо.
// soft-light нет: формула ffmpeg считает совсем другое (0xE0 поверх 0x60: 216 против 142 в браузере).
var tlBlends = map[string]string{
	"":             "",
	"screen":       "screen",
	"plus-lighter": "addition",
	"lighten":      "lighten",
	"multiply":     "multiply",
	"darken":       "darken",
	"overlay":      "hardlight",
	"hard-light":   "overlay",
	"difference":   "difference",
}

type tlLayer struct {
	clips []tlClip
	blend string
}

// tlLayers: слои графа снизу вверх. Клипы одной дорожки во времени не пересекаются, поэтому клипы с разными режимами
// можно разнести по отдельным слоям. Под самым нижним режимом лежит пустой слой: режим считается от чёрного кадра, как в просмотре.
func tlLayers(tracks [][]tlClip) []tlLayer {
	var layers []tlLayer
	for _, list := range tracks {
		var modes []string
		for _, c := range list {
			if c.si.video && !slices.Contains(modes, c.Blend) {
				modes = append(modes, c.Blend)
			}
		}
		slices.Sort(modes) // обычный режим первым
		for _, m := range modes {
			var clips []tlClip
			for _, c := range list {
				if c.si.video && c.Blend == m {
					clips = append(clips, c)
				}
			}
			layers = append(layers, tlLayer{clips, m})
		}
	}
	if len(layers) > 0 && layers[0].blend != "" {
		layers = slices.Insert(layers, 0, tlLayer{})
	}
	return layers
}

// tlBlendGraph: слой top смешивается с тем, что под ним. У blend нет прозрачности, поэтому его результат берёт
// прозрачность слоя и обычным overlay ложится на нижнее: вне рамки и в плавности слоя видно нижнее как есть.
// Формат перед split и scale на ветках обязательны: у split на всех выходах один формат, и без них ffmpeg мог перевести
// весь слой в gbrp ещё до split, а тогда alphaextract падает. Какой выход победит, зависит от остального графа (в PNG падало, в MP4 нет).
func tlBlendGraph(under, top, base, out string, l int, pix, rgb, mode string) []string {
	name := func(s string) string { return fmt.Sprintf("[%s%d]", s, l) }
	return []string{
		under + "split=2" + base + name("ub"),
		top + "format=" + pix + ",split=2" + name("ta") + name("tb"),
		name("ub") + "scale," + rgb + name("uc"),
		name("ta") + "scale," + rgb + name("tc"),
		name("tc") + name("uc") + "blend=all_mode=" + mode + name("bl"),
		name("tb") + "alphaextract" + name("am"),
		name("bl") + name("am") + "alphamerge" + out,
	}
}

// tlClipChain: кадры одного клипа: нужный размер и частота, реверс, скорость и точная длина.
// Картинка в файле бывает короче звука: последний кадр держится, иначе следующий клип приехал бы раньше времени.
// flat: под клипом ничего нет, а формат не хранит прозрачность, поэтому вырезанное становится чёрным.
func tlClipChain(c tlClip, w, h int, fps float64, pix, bg string, flat bool) string {
	var chain []string
	keyed, graded := c.KeyColor != "", c.graded()
	deep := c.si.deep && !keyed // удаление фона считается в 8 битах, больше тут не сохранить
	if keyed {
		chain = append(chain, tlKeyChain(c.Clip)...)
	}
	if graded { // после удаления фона: ключ смотрит на цвета файла, как в просмотре
		chain = append(chain, tlGradeChain(c.Clip, deep)...)
	}
	fx := c.Blur > 0 || c.ShadowA > 0
	if keyed && flat && !fx { // с эффектами чёрное подставляется после них
		chain = append(chain, "format=yuva444p", "premultiply=inplace=1")
	}
	if (keyed || graded || fx) && pix == "" {
		pix = "yuv420p"
		if deep {
			pix = "yuv444p10le"
		}
	}
	// Эффекты считаются на слое с прозрачностью размером с кадр, а нужный формат и фон появляются после них
	work, boxBg := pix, bg
	if fx {
		work, boxBg = "yuva444p", "black@0"
		if deep {
			work = "yuva444p10le"
		}
	}
	if work != "" {
		chain = append(chain, "format="+work)
	}
	chain = append(chain, "setpts=PTS-STARTPTS")
	box := c.Clip
	if cw, ch := c.size(); box.W <= 0 && (box.Rot != 0 || box.cropped() || fx) && cw > 0 && ch > 0 {
		box.X, box.Y, box.W, box.H = tlFitBox(cw, ch, w, h)
	}
	if box.W > 0 {
		chain = append(chain, tlBoxChain(box, w, h, boxBg)...)
	} else if cw, ch := c.size(); cw != w || ch != h {
		chain = append(chain, fmt.Sprintf("scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2:color=%s", w, h, w, h, boxBg))
	}
	if fx {
		chain = append(chain, tlFxChain(c, w, h, work)...)
		if bg == "black" { // под слоем ничего нет: прозрачное становится чёрным
			chain = append(chain, "premultiply=inplace=1")
		}
		chain = append(chain, "format="+pix)
	}
	rate := rateStr(fps)
	chain = append(chain, "setsar=1", "fps="+rate)
	if c.Reverse {
		chain = append(chain, "reverse")
	}
	if c.Speed != 1 {
		chain = append(chain, "setpts=PTS/"+strconv.FormatFloat(c.Speed, 'f', -1, 64), "fps="+rate)
	}
	chain = append(chain,
		"tpad=stop_mode=clone:stop_duration="+secs(float64(c.frames()+1)/fps),
		fmt.Sprintf("trim=end_frame=%d", c.frames()),
		"setpts=PTS-STARTPTS")
	// у нижней дорожки под клипом чёрный фон, у верхней слой уходит в прозрачность
	chain = append(chain, tlFades(c, fps, "fade", "setpts", bg != "black")...)
	return strings.Join(chain, ",")
}

const tlMaxBlur = 0.2 // размытие и мягкость тени: σ не больше этой доли высоты кадра

// tlFxChain: размытие, потом тень, в том же порядке, что filter в просмотре (mvFx). На входе кадр с прозрачностью.
// Поля вокруг кадра нужны, чтобы край размывался в прозрачность, как в браузере: gblur сам повторил бы крайние точки.
func tlFxChain(c tlClip, w, h int, pix string) []string {
	var chain []string
	sigma := func(v float64) string { return strconv.FormatFloat(v*float64(h), 'f', 3, 64) }
	margin := func(s, off float64) int { return int(math.Ceil((3.5*s+math.Abs(off))*float64(h))) + 2 }
	if c.Blur > 0 {
		m := margin(c.Blur, 0)
		chain = append(chain, "premultiply=inplace=1", // иначе цвет прозрачных полей затемняет край
			fmt.Sprintf("pad=%d:%d:%d:%d:color=black@0", w+2*m, h+2*m, m, m),
			"gblur=sigma="+sigma(c.Blur)+":steps=3",
			fmt.Sprintf("crop=%d:%d:%d:%d", w, h, m, m),
			"unpremultiply=inplace=1")
	}
	if c.ShadowA > 0 {
		var r, g, b int
		fmt.Sscanf(c.ShadowC, "#%02x%02x%02x", &r, &g, &b)
		m := margin(c.ShadowB, max(math.Abs(c.ShadowX), math.Abs(c.ShadowY)))
		dx, dy := int(math.Round(c.ShadowX*float64(h))), int(math.Round(c.ShadowY*float64(h)))
		// тень: сплошной цвет, прозрачность от слоя; цвет везде одинаковый, поэтому размывать можно без premultiply
		soft := ""
		if c.ShadowB > 0 {
			soft = ",gblur=sigma=" + sigma(c.ShadowB) + ":steps=3"
		}
		a, s, o := fmt.Sprintf("[fa%d]", c.input), fmt.Sprintf("[fb%d]", c.input), fmt.Sprintf("[fc%d]", c.input)
		chain = append(chain, fmt.Sprintf("split=2%s%s;%sformat=rgba,pad=%d:%d:%d:%d:color=black@0,lutrgb=r=%d:g=%d:b=%d:a=val*%s%s,crop=%d:%d:%d:%d,format=%s%s;%s%soverlay=format=auto,format=%s",
			a, s, a, w+2*m, h+2*m, m, m, r, g, b, strconv.FormatFloat(c.ShadowA, 'f', 4, 64), soft, w, h, m-dx, m-dy, pix, o, o, s, pix))
	}
	return chain
}

var tlKeyRe = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// tlKeepsAlpha: хранит ли формат результата прозрачность
func tlKeepsAlpha(f Format) bool {
	switch f.codec() {
	case "libvpx-vp9", "libvpx", "qtrle", "apng", "libwebp_anim":
		return true
	}
	return f.Ext == "png" || f.Ext == "webp" || slices.Contains(f.Args, "yuva444p10le")
}

// tlKeyChain: удаление фона по цвету. Считается в RGB, те же формулы в просмотре (web/js/chroma.js).
// Отсвет убирается у того канала, который в цвете фона главный: зелёного или синего.
func tlKeyChain(c Clip) []string {
	hex := strings.ToLower(c.KeyColor[1:])
	chain := []string{"format=rgba", fmt.Sprintf("colorkey=0x%s:%s:%s", hex, secs(c.KeySim), secs(c.KeyBlend))}
	if c.KeySpill > 0 {
		var r, g, b int
		fmt.Sscanf(hex, "%02x%02x%02x", &r, &g, &b)
		if g >= r && g >= b {
			chain = append(chain, fmt.Sprintf("despill=type=green:mix=0.5:expand=0:red=0:green=%s:blue=0", secs(-c.KeySpill)))
		} else if b >= r {
			chain = append(chain, fmt.Sprintf("despill=type=blue:mix=0.5:expand=0:red=0:green=0:blue=%s", secs(-c.KeySpill)))
		}
	}
	return chain
}

func (c Clip) graded() bool {
	return c.ColBri != 0 || c.ColCon != 0 || c.ColMid != 0 || c.ColSat != 0 || c.ColTemp != 0 || c.ColTint != 0
}

// tlGradeChain: цветокоррекция в RGB, те же формулы и тот же порядок в просмотре (CHROMA_FRAG в web/js/chroma.js):
// баланс белого, средние тона, контраст, яркость, насыщенность. Прозрачность не трогается.
func tlGradeChain(c Clip, deep bool) []string {
	num := func(v float64) string { return strconv.FormatFloat(v, 'f', 5, 64) }
	pix := "format=rgba"
	if deep {
		pix = "format=rgba64le"
	}
	chain := []string{pix}
	if c.ColBri != 0 || c.ColCon != 0 || c.ColMid != 0 || c.ColTemp != 0 || c.ColTint != 0 {
		// запятые внутри выражения экранированы для графа ffmpeg
		curve := func(gain float64) string {
			return fmt.Sprintf(`maxval*clip((pow(clip(val/maxval*%s\,0\,1)\,%s)-0.5)*%s+0.5+(%s)\,0\,1)+0.5`,
				num(gain), num(math.Pow(2, -c.ColMid)), num(math.Pow(2, 2*c.ColCon)), num(c.ColBri/2))
		}
		chain = append(chain, fmt.Sprintf("lutrgb=r=%s:g=%s:b=%s", curve(1+0.3*c.ColTemp), curve(1-0.3*c.ColTint), curve(1-0.3*c.ColTemp)))
	}
	if c.ColSat != 0 {
		const lr, lg, lb = 0.2126, 0.7152, 0.0722 // вклад каналов в яркость
		s := 1 + c.ColSat
		chain = append(chain, fmt.Sprintf("colorchannelmixer=rr=%s:rg=%s:rb=%s:gr=%s:gg=%s:gb=%s:br=%s:bg=%s:bb=%s",
			num(lr*(1-s)+s), num(lg*(1-s)), num(lb*(1-s)),
			num(lr*(1-s)), num(lg*(1-s)+s), num(lb*(1-s)),
			num(lr*(1-s)), num(lg*(1-s)), num(lb*(1-s)+s)))
	}
	return chain
}

// tlFades: плавное появление и исчезание клипа. Время считается от начала целого клипа: если метка вывода срезала
// его голову, метки времени на это время сдвигаются вперёд, и плавность идёт с того же места, что на дорожке.
func tlFades(c tlClip, fps float64, fade, setpts string, alpha bool) []string {
	whole := float64(c.whole) / fps
	head := float64(c.head) / fps
	shownTo := head + float64(c.frames())/fps
	in, out := min(c.FadeIn, whole), min(c.FadeOut, whole)
	wantIn, wantOut := in > head, out > 0 && whole-out < shownTo
	if !wantIn && !wantOut {
		return nil
	}
	tail := ""
	if alpha {
		tail = ":alpha=1"
	}
	var chain []string
	if head > 0 {
		chain = append(chain, fmt.Sprintf("%s=PTS+%s/TB", setpts, secs(head)))
	}
	if wantIn {
		chain = append(chain, fmt.Sprintf("%s=t=in:st=0:d=%s%s", fade, secs(in), tail))
	}
	if wantOut {
		chain = append(chain, fmt.Sprintf("%s=t=out:st=%s:d=%s%s", fade, secs(whole-out), secs(out), tail))
	}
	if head > 0 {
		chain = append(chain, setpts+"=PTS-STARTPTS")
	}
	return chain
}

// tlFitBox: рамка слоя, вписанного в кадр по центру, в долях кадра
func tlFitBox(cw, ch, w, h int) (x, y, bw, bh float64) {
	s := min(float64(w)/float64(cw), float64(h)/float64(ch))
	bw, bh = float64(cw)*s/float64(w), float64(ch)*s/float64(h)
	return (1 - bw) / 2, (1 - bh) / 2, bw, bh
}

// tlBoxChain: слой в своей рамке на кадре w×h. Порядок как в предпросмотре (mvPlace в web/js/viewport.js): кадрирование, поворот вокруг
// середины рамки, место на кадре. Что вышло за край кадра, отрезается, вокруг остаётся фон.
// Числа чётные: у yuv420p цветность на два пикселя, нечётное значение фильтры всё равно округлили бы.
func tlBoxChain(c Clip, w, h int, bg string) []string {
	even := func(v float64) int { return int(math.Round(v/2)) * 2 }
	bw, bh := max(even(c.W*float64(w)), 2), max(even(c.H*float64(h)), 2)
	// что осталось от слоя после кадрирования, в пикселях слоя
	cl, ct := even(c.CropL*float64(bw)), even(c.CropT*float64(bh))
	sw, sh := max(even((1-c.CropL-c.CropR)*float64(bw)), 2), max(even((1-c.CropT-c.CropB)*float64(bh)), 2)
	sw, sh = min(sw, bw-cl), min(sh, bh-ct)
	chain := []string{fmt.Sprintf("scale=%d:%d", bw, bh)}
	// место куска на кадре: rx, ry, rw, rh; ox, oy — откуда его брать после предыдущих шагов
	rx, ry, rw, rh, ox, oy := even(c.X*float64(w))+cl, even(c.Y*float64(h))+ct, sw, sh, cl, ct
	if c.Rot != 0 {
		if sw != bw || sh != bh {
			chain = append(chain, fmt.Sprintf("crop=%d:%d:%d:%d", sw, sh, cl, ct))
		}
		a := c.Rot * math.Pi / 180
		sin, cos := math.Sin(a), math.Cos(a)
		rw = max(even(math.Abs(float64(sw)*cos)+math.Abs(float64(sh)*sin)+1), 2)
		rh = max(even(math.Abs(float64(sw)*sin)+math.Abs(float64(sh)*cos)+1), 2)
		chain = append(chain, fmt.Sprintf("rotate=a=%s:ow=%d:oh=%d:c=%s", strconv.FormatFloat(a, 'f', 6, 64), rw, rh, bg))
		// середина рамки стоит на месте, середина куска поворачивается вокруг неё
		dx, dy := float64(cl)+float64(sw)/2-float64(bw)/2, float64(ct)+float64(sh)/2-float64(bh)/2
		px := (c.X+c.W/2)*float64(w) + dx*cos - dy*sin
		py := (c.Y+c.H/2)*float64(h) + dx*sin + dy*cos
		rx, ry, ox, oy = even(px-float64(rw)/2), even(py-float64(rh)/2), 0, 0
	}
	vx, vy := min(max(rx, 0), max(w-2, 0)), min(max(ry, 0), max(h-2, 0))
	vw, vh := min(rx+rw, w)-vx, min(ry+rh, h)-vy
	gone := vw <= 0 || vh <= 0 // кусок целиком за кадром: кадр собрать всё равно надо, но без него
	vw, vh = max(vw, 2), max(vh, 2)
	vw, vh = min(vw, rw), min(vh, rh)
	// до этого шага у кадра размер целого слоя, а после поворота размер rw×rh
	inW, inH := bw, bh
	if c.Rot != 0 {
		inW, inH = rw, rh
	}
	if vw != inW || vh != inH {
		chain = append(chain, fmt.Sprintf("crop=%d:%d:%d:%d", vw, vh, ox+min(max(vx-rx, 0), rw-vw), oy+min(max(vy-ry, 0), rh-vh)))
	}
	if gone {
		chain = append(chain, "drawbox=t=fill:c="+bg+":replace=1")
	}
	return append(chain, fmt.Sprintf("pad=%d:%d:%d:%d:color=%s", w, h, vx, vy, bg))
}

// tlAudioGraph: каждый клип встаёт на своё место задержкой, потом всё смешивается. Сумма не приглушается:
// громкость клипа не должна зависеть от числа клипов на других дорожках. Где звуки накладываются, пики сдерживает лимитер.
func tlAudioGraph(tracks [][]tlClip, fps float64, total int) []string {
	var graph, mix []string
	var sounds []tlClip
	samples := func(frames int) int { return int(float64(frames)/fps*tlAudioHz + 0.5) }
	for _, list := range tracks {
		for _, c := range list {
			if !c.si.audio {
				continue
			}
			sounds = append(sounds, c)
			chain := []string{"asetpts=PTS-STARTPTS", fmt.Sprintf("aformat=sample_rates=%d:channel_layouts=stereo", tlAudioHz)}
			if c.Reverse {
				chain = append(chain, "areverse")
			}
			chain = append(chain, atempoChain(c.Speed)...)
			chain = append(chain,
				fmt.Sprintf("atrim=end_sample=%d", samples(c.frames())),
				"asetpts=PTS-STARTPTS")
			if v := c.volume(); v != 1 {
				chain = append(chain, "volume="+strconv.FormatFloat(v, 'f', 4, 64))
			}
			chain = append(chain, tlFades(c, fps, "afade", "asetpts", false)...)
			chain = append(chain, fmt.Sprintf("adelay=delays=%dS:all=1", samples(c.start)))
			label := fmt.Sprintf("[s%d]", len(mix))
			graph = append(graph, fmt.Sprintf("[%d:a:0]%s%s", c.input, strings.Join(chain, ","), label))
			mix = append(mix, label)
		}
	}
	end := secs(float64(total) / fps)
	tail := "apad=whole_dur=" + end + ",atrim=end=" + end + "[a]"
	if len(mix) == 1 {
		return append(graph, mix[0]+tail)
	}
	limiter := ""
	if tlSoundsMeet(sounds) {
		limiter = "alimiter=level=0:limit=0.95:latency=1,"
	}
	return append(graph, fmt.Sprintf("%samix=inputs=%d:duration=longest:normalize=0,%s%s", strings.Join(mix, ""), len(mix), limiter, tail))
}

// tlSoundsMeet: звучат ли какие-нибудь два клипа одновременно
func tlSoundsMeet(list []tlClip) bool {
	for i, a := range list {
		for _, b := range list[i+1:] {
			if a.start < b.end && b.start < a.end {
				return true
			}
		}
	}
	return false
}

// montRow: строка монтажа в очереди конвертера. Формат и качество у неё общие со всей пачкой.
// Если выбранный формат монтажу не подходит, ошибку получает только эта строка: остальные файлы идут своим чередом.
func montRow(key string, p Project, req StartReq, f Format, used map[string]bool) *FileState {
	lead := p.lead()
	st := &FileState{Path: key, Name: tr("mont.rowName", fileStem(lead)), Status: "pending", f: f, project: &p}
	for _, path := range p.paths() {
		st.SrcSize += fileSize(path)
	}
	if f.Kind == "compress" {
		st.f, _ = compressFormat("montage.mp4", req)
	}
	why := ""
	switch {
	case lead == "":
		why = tr("mont.noClips")
	case !st.f.forMontage():
		why = tr("mont.rowFormat")
	default:
		st.Dst = outPathNamed(lead, fileStem(lead)+tr("mont.suffix"), "."+st.f.Ext, req, used)
	}
	if why != "" {
		st.Status, st.Msg, st.Hint = "error", why, why
	}
	return st
}
