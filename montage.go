package main

// Вкладка «Монтаж»: склейка, скорость, реверс и повтор. Всё идёт одной командой ffmpeg с filter_complex,
// аргументы кодека даёт buildArgs. Результат всегда отдельным файлом с приставкой: исходники не трогаем.

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
)

type MontageReq struct {
	StartReq
	Glue    bool    `json:"glue"`    // склеить всё в один файл; иначе каждый файл отдельно
	Speed   float64 `json:"speed"`   // 1 — как есть
	Reverse bool    `json:"reverse"` // задом наперёд
	Repeat  int     `json:"repeat"`  // сколько раз подряд
}

const (
	montMinSpeed  = 0.25
	montMaxSpeed  = 8
	montMaxRepeat = 20
)

// fit: значения из интерфейса в допустимые пределы. Качество задаёт страница, остальные настройки конвертера здесь ни при чём.
func (m *MontageReq) fit() {
	if m.Speed <= 0 {
		m.Speed = 1
	}
	m.Speed = min(max(m.Speed, montMinSpeed), montMaxSpeed)
	m.Repeat = min(max(m.Repeat, 1), montMaxRepeat)
	m.Height, m.FPS, m.Extra, m.TargetMB, m.Join = "", "", "", 0, false
	m.Overwrite, m.Copy, m.SameDir, m.OutDir = false, true, true, ""
}

// montFormat: годится ли формат для монтажа. Картинки и копирование потоков не годятся: нужен движущийся результат или звук.
func montFormat(id string) bool {
	f, ok := formats[id]
	if !ok {
		return false
	}
	return f.moving() || f.Kind == "gif" || f.Kind == "anim" || f.audioOnly()
}

func (f Format) audioOnly() bool {
	return (f.Kind == "audio" || f.Kind == "fixed") && slices.Contains(f.Args, "-vn")
}

// montClip: один кусок будущего результата
type montClip struct {
	path string
	si   srcInfo
	from float64 // обрезка: откуда
	cut  float64 // и сколько секунд; 0 — файл целиком
}

func (c montClip) dur() float64 {
	if c.cut > 0 {
		if c.si.dur > 0 {
			return min(c.cut, max(c.si.dur-c.from, 0))
		}
		return c.cut
	}
	return c.si.dur
}

// size: размер кадра, каким его увидят фильтры: ffmpeg сам поворачивает кадр по метке из файла
func (c montClip) size() (int, int) {
	if c.si.rotated {
		return c.si.h, c.si.w
	}
	return c.si.w, c.si.h
}

// reverseRAM: примерно сколько байт памяти съест реверс. Фильтр reverse держит все кадры в памяти, причём замер на ProRes
// показал, что складываются все куски склейки: 2 куска по 0,92 ГБ заняли 2 ГБ.
func reverseRAM(clips []montClip, repeat int) float64 {
	need := 0.0
	for _, c := range clips {
		if !c.si.video {
			continue
		}
		perPixel := 1.5
		if c.si.deep {
			perPixel = 4
		}
		need += c.dur() * c.si.fps * float64(c.si.w) * float64(c.si.h) * perPixel
	}
	return need * float64(repeat)
}

// atempoChain: один фильтр atempo надёжно работает в пределах от 0,5 до 2, дальше их ставят цепочкой
func atempoChain(s float64) []string {
	var out []string
	for s > 2 {
		out = append(out, "atempo=2")
		s /= 2
	}
	for s < 0.5 {
		out = append(out, "atempo=0.5")
		s *= 2
	}
	if s != 1 {
		out = append(out, "atempo="+strconv.FormatFloat(s, 'f', -1, 64))
	}
	return out
}

// montOrder: порядок кусков в результате. Реверс всего результата — это куски в обратном порядке, каждый задом наперёд.
func montOrder(clips []montClip, reverse bool, repeat int) []montClip {
	once := clips
	if reverse {
		once = slices.Clone(clips)
		slices.Reverse(once)
	}
	var list []montClip
	for i := 0; i < repeat; i++ {
		list = append(list, once...)
	}
	return list
}

// montPlan собирает входы и граф фильтров. На выходе граф даёт метки [v] и [a], что из них есть, говорит srcInfo.
// Размер и частоту кадров задаёт первый файл, остальные приводятся к ним: иначе фильтр concat не соединит куски.
func montPlan(clips []montClip, f Format, speed float64, reverse bool, repeat int) (srcInfo, error) {
	wantV := !f.audioOnly()
	anyAudio := false
	for _, c := range clips {
		anyAudio = anyAudio || c.si.audio
		if wantV && !c.si.video {
			return srcInfo{}, errT("mont.noVideo", filepath.Base(c.path))
		}
	}
	wantA := anyAudio && f.Kind != "gif" && f.Kind != "anim"
	if !wantV && !anyAudio {
		return srcInfo{}, errT("mont.noAudio", filepath.Base(clips[0].path))
	}

	lead := clips[0]
	w, h := lead.size()
	fps := lead.si.fps
	sameSize, sameRate, sameSound := true, true, true
	for _, c := range clips {
		cw, ch := c.size()
		sameSize = sameSize && cw == w && ch == h
		sameRate = sameRate && (c.si.fps == fps || fps <= 0)
		sameSound = sameSound && c.si.audio && c.si.ahz == lead.si.ahz && c.si.ach == lead.si.ach
	}
	fpsStr := strconv.FormatFloat(fps, 'f', 3, 64)

	si := srcInfo{w: w, h: h, fps: fps, audio: wantA, video: wantV}
	var graph, joinIn []string
	list := montOrder(clips, reverse, repeat)
	for i, c := range list {
		if c.si.decoder != "" {
			si.inputs = append(si.inputs, "-c:v", c.si.decoder)
		}
		if c.cut > 0 {
			si.inputs = append(si.inputs, "-ss", strconv.FormatFloat(c.from, 'f', 3, 64), "-t", strconv.FormatFloat(c.cut, 'f', 3, 64))
		}
		si.inputs = append(si.inputs, "-i", c.path)
		si.dur += c.dur() / speed
		si.alpha = si.alpha || c.si.alpha

		if wantV {
			chain := []string{"setpts=PTS-STARTPTS"}
			cw, ch := c.size()
			if cw != w || ch != h {
				chain = append(chain, fmt.Sprintf("scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2:color=black@0", w, h, w, h))
			}
			if !sameSize {
				chain = append(chain, "setsar=1")
			}
			if !sameRate && c.si.fps != fps {
				chain = append(chain, "fps="+fpsStr)
			}
			if reverse {
				chain = append(chain, "reverse")
			}
			if speed != 1 {
				chain = append(chain, "setpts=PTS/"+strconv.FormatFloat(speed, 'f', -1, 64))
				if fps > 0 { // иначе 8x давал бы файл с частотой 240 кадров; при замедлении кадры повторяются
					chain = append(chain, "fps="+fpsStr)
				}
			}
			graph = append(graph, fmt.Sprintf("[%d:v:0]%s[v%d]", i, strings.Join(chain, ","), i))
			joinIn = append(joinIn, fmt.Sprintf("[v%d]", i))
		}
		if wantA {
			var chain []string
			src := fmt.Sprintf("[%d:a:0]", i)
			if !c.si.audio { // кусок без звука: тишина той же длины, иначе звук следующих кусков уедет
				src = ""
				silence := c.dur()
				if silence <= 0 {
					silence = 0.01 // длина неизвестна: остаток тишины допишет concat по длине картинки
				}
				chain = append(chain, "anullsrc=r=48000:cl=stereo", "atrim=duration="+strconv.FormatFloat(silence, 'f', 3, 64))
			}
			chain = append(chain, "asetpts=PTS-STARTPTS")
			if !sameSound {
				chain = append(chain, "aformat=sample_rates=48000:channel_layouts=stereo")
			}
			if reverse {
				chain = append(chain, "areverse")
			}
			chain = append(chain, atempoChain(speed)...)
			graph = append(graph, fmt.Sprintf("%s%s[a%d]", src, strings.Join(chain, ","), i))
			joinIn = append(joinIn, fmt.Sprintf("[a%d]", i))
		}
	}
	vN, aN, out := 0, 0, ""
	if wantV {
		vN, out = 1, "[v]"
	}
	if wantA {
		aN, out = 1, out+"[a]"
	}
	graph = append(graph, fmt.Sprintf("%sconcat=n=%d:v=%d:a=%d%s", strings.Join(joinIn, ""), len(list), vN, aN, out))
	si.graph = strings.Join(graph, ";")
	return si, nil
}

// montGraphArgs: готовый граф плюс фильтры формата vf на выходе картинки (они у buildArgs те же, что для обычной конвертации)
func montGraphArgs(si srcInfo, tail string) []string {
	g, vOut := si.graph, "[v]"
	if tail != "" && si.video {
		g += ";[v]" + tail + "[vo]"
		vOut = "[vo]"
	}
	args := []string{"-filter_complex", g}
	if si.video {
		args = append(args, "-map", vOut)
	}
	if si.audio {
		args = append(args, "-map", "[a]")
	}
	return args
}

// montClips читает сведения о файлах этой работы
func montClips(ctx context.Context, ffm string, req MontageReq, paths []string) ([]montClip, error) {
	var clips []montClip
	for _, p := range paths {
		if imageExt[strings.ToLower(filepath.Ext(p))] {
			return nil, errT("mont.image", filepath.Base(p))
		}
		c := montClip{path: p, si: probe(ctx, ffm, p)}
		if !c.si.video && !c.si.audio {
			return nil, errT("mont.unreadable", filepath.Base(p))
		}
		if from, cut, ok := req.trim(p); ok {
			c.from, c.cut = from, cut
		}
		clips = append(clips, c)
	}
	return clips, nil
}

// runMontage: своя пачка «mont», статусы лежат там же, где у конвертера
func (s *Server) runMontage(req MontageReq, ffm string) {
	f := formats[req.Format]
	ctx, cancel := context.WithCancel(context.Background())
	used := map[string]bool{}
	for _, p := range req.Files {
		used[strings.ToLower(p)] = true
	}
	var states []*FileState
	var jobs [][]string
	outOf := func(p string) string {
		return outPathNamed(p, fileStem(p)+tr("mont.suffix"), "."+f.Ext, req.StartReq, used)
	}
	if req.Glue {
		first := req.Files[0]
		st := &FileState{Path: first, Name: tr("mont.glueName", fileStem(first), len(req.Files)), Status: "pending", f: f, Dst: outOf(first)}
		for _, p := range req.Files {
			st.SrcSize += fileSize(p)
		}
		states, jobs = append(states, st), append(jobs, req.Files)
	} else {
		for _, p := range req.Files {
			states = append(states, &FileState{Path: p, Name: filepath.Base(p), Status: "pending", SrcSize: fileSize(p), f: f, Dst: outOf(p)})
			jobs = append(jobs, []string{p})
		}
	}
	s.mu.Lock()
	s.files = states
	s.batch = "mont"
	s.running = true
	s.cancel = cancel
	s.summary = ""
	s.mu.Unlock()

	for i, paths := range jobs { // по очереди: реверс требует много памяти
		if ctx.Err() != nil {
			break
		}
		s.montageOne(ctx, i, req, paths, ffm)
	}
	s.finishBatch()
	cancel()
}

func (s *Server) montageOne(ctx context.Context, i int, req MontageReq, paths []string, ffm string) {
	var dst, name string
	var f Format
	s.mu.Lock()
	dst, name, f = s.files[i].Dst, s.files[i].Name, s.files[i].f
	s.files[i].Status = "running"
	s.mu.Unlock()
	fail := func(err error) {
		s.set(i, func(fs *FileState) { fs.Status = "error"; fs.Msg = err.Error(); fs.Hint = err.Error() })
		s.logT("log.error", name, err)
	}
	clips, err := montClips(ctx, ffm, req, paths)
	if err != nil {
		fail(err)
		return
	}
	if req.Reverse && !f.audioOnly() {
		need, have := reverseRAM(clips, req.Repeat), availableRAM()
		if have > 0 && need > float64(have)*0.8 {
			const gb = 1 << 30
			fail(errT("mont.reverseRAM", mbStr(float64(int(need/gb*10))/10), mbStr(float64(int(float64(have)/gb*10))/10)))
			return
		}
	}
	si, err := montPlan(clips, f, req.Speed, req.Reverse, req.Repeat)
	if err != nil {
		fail(err)
		return
	}
	rq := req.StartReq
	rq.Trims = nil // обрезка уже во входах
	stderr, err := s.runFF(ctx, i, ffm, buildArgs(f, rq, "", dst, si, false, nil), si.dur, "", 0, 1)
	if err != nil && ctx.Err() == nil && (f.moving() || f.Kind == "gif") {
		os.Remove(dst)
		s.logT("log.retry", name, errSummary(stderr, err, 6))
		s.set(i, func(fs *FileState) { fs.Pct = 0; fs.Msg = tr("conv.retry") })
		rq.Overwrite = true
		stderr, err = s.runFF(ctx, i, ffm, buildArgs(f, rq, "", dst, si, true, nil), si.dur, "", 0, 1)
	}
	if ctx.Err() != nil {
		os.Remove(dst)
		s.set(i, func(fs *FileState) { fs.Status = "canceled"; fs.Msg = "" })
		return
	}
	if err != nil {
		os.Remove(dst)
		short, hint := errSummary(stderr, err, 2), friendlyErr(stderr, err)
		s.set(i, func(fs *FileState) { fs.Status = "error"; fs.Msg = short; fs.Hint = hint })
		s.logT("log.errorLong", name, errSummary(stderr, err, 8))
		return
	}
	if fileSize(dst) == 0 {
		os.Remove(dst)
		fail(errors.New(tr("mont.empty")))
		return
	}
	size := fileSize(dst)
	s.set(i, func(fs *FileState) { fs.Status = "ok"; fs.Pct = 100; fs.DstSize = size; fs.Msg = "" })
	s.addLog("[ok] %s", filepath.Base(dst))
}
