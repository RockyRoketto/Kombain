package main

// Движок дорожек: проект из дорожек и клипов со временем превращается в один граф ffmpeg.
// Дорожка собирается фильтром concat, верхние дорожки ложатся на нижние через overlay, звук всех клипов смешивает amix.
// Все границы клипов стоят на сетке кадров: так длина результата точная, а дорожка не уезжает от накопленных округлений.

import (
	"cmp"
	"context"
	"fmt"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
)

// Project: монтаж целиком. Дорожка с меньшим номером лежит ниже, верхняя закрывает её картинкой.
type Project struct {
	W      int     `json:"w"` // размер кадра; 0 — как у первого видео
	H      int     `json:"h"`
	FPS    float64 `json:"fps"` // кадров в секунду; 0 — как у первого видео
	Tracks []Track `json:"tracks"`
}

type Track struct {
	Clips []Clip `json:"clips"`
}

// Clip: кусок файла на дорожке. Повтор — это копии клипа.
type Clip struct {
	Path    string  `json:"path"`
	At      float64 `json:"at"`      // секунда на дорожке, с которой клип начинается
	From    float64 `json:"from"`    // откуда брать в файле
	Len     float64 `json:"len"`     // сколько секунд файла взять; 0 — до конца; у фото — сколько показывать
	Speed   float64 `json:"speed"`   // 0 и 1 — как есть
	Reverse bool    `json:"reverse"` // задом наперёд
}

const (
	tlPhotoLen  = 5.0  // секунд, если у фото не задана длина
	tlRate      = 30.0 // кадров в секунду, если видео нет и взять её неоткуда
	tlSoundGrid = 1000 // в монтаже только со звуком сетка в миллисекунду
	tlMaxFPS    = 240
	tlAudioHz   = 48000
)

// fit: значения из интерфейса в допустимые пределы
func (p *Project) fit() {
	if p.W <= 0 || p.H <= 0 {
		p.W, p.H = 0, 0
	}
	p.FPS = min(max(p.FPS, 0), tlMaxFPS)
	for t := range p.Tracks {
		for i := range p.Tracks[t].Clips {
			c := &p.Tracks[t].Clips[i]
			c.At, c.From, c.Len = max(c.At, 0), max(c.From, 0), max(c.Len, 0)
			if c.Speed <= 0 {
				c.Speed = 1
			}
			c.Speed = min(max(c.Speed, montMinSpeed), montMaxSpeed)
		}
	}
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
				kept = append(kept, c)
				total = max(total, c.end)
			}
		}
		out = append(out, kept)
	}
	return out, total
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
	var anyAudio, anyVideo, alpha, deep bool
	var first string
	var reversed []montClip
	for _, list := range tracks {
		for _, c := range list {
			if first == "" {
				first = c.path
			}
			anyAudio = anyAudio || c.si.audio
			anyVideo = anyVideo || c.si.video
			alpha = alpha || (c.si.video && c.si.alpha)
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
		graph = append(graph, tlVideoGraph(tracks, w, h, fps, total, alpha, deep)...)
	}
	if wantA {
		graph = append(graph, tlAudioGraph(tracks, fps, total)...)
	}
	si.graph = strings.Join(graph, ";")
	return si, nil
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
func tlVideoGraph(tracks [][]tlClip, w, h int, fps float64, total int, alpha, deep bool) []string {
	var layers [][]tlClip
	for _, list := range tracks {
		if slices.ContainsFunc(list, func(c tlClip) bool { return c.si.video }) {
			layers = append(layers, list)
		}
	}
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
	for l, layer := range layers {
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
			if !bottom && len(join) == 0 {
				pos, first = c.start, c.start
			}
			if c.start > pos {
				gap(c.start - pos)
			}
			label := fmt.Sprintf("[c%d_%d]", l, len(join))
			graph = append(graph, fmt.Sprintf("[%d:v:0]%s%s", c.input, tlClipChain(c, w, h, fps, pix, bg), label))
			join = append(join, label)
			pos = c.end
		}
		if bottom && pos < total {
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
		graph = append(graph, under+out+"overlay=format=auto:eof_action=pass"+next)
		under = next
	}
	return graph
}

// tlClipChain: кадры одного клипа: нужный размер и частота, реверс, скорость и точная длина.
// Картинка в файле бывает короче звука: последний кадр держится, иначе следующий клип приехал бы раньше времени.
func tlClipChain(c tlClip, w, h int, fps float64, pix, bg string) string {
	var chain []string
	if pix != "" {
		chain = append(chain, "format="+pix)
	}
	chain = append(chain, "setpts=PTS-STARTPTS")
	if cw, ch := c.size(); cw != w || ch != h {
		chain = append(chain, fmt.Sprintf("scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2:color=%s", w, h, w, h, bg))
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
	return strings.Join(chain, ",")
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
				"asetpts=PTS-STARTPTS",
				fmt.Sprintf("adelay=delays=%dS:all=1", samples(c.start)))
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
