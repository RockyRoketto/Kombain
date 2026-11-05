package main

// Конвертация пачки: run → convert → encodeTarget/runFF.

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

func (s *Server) set(i int, fn func(fs *FileState)) {
	s.mu.Lock()
	fn(s.files[i])
	s.mu.Unlock()
}

// kept: файл не трогаем — результат удалён, оригинал остаётся как есть
func (s *Server) kept(i int, msg string) {
	name := ""
	s.set(i, func(fs *FileState) { fs.Status = "kept"; fs.Pct = 100; fs.Msg = msg; name = fs.Name })
	s.logT("log.kept", name, msg)
}

// encodeTarget: два прохода с битрейтом из r. Если файл всё же вышел больше target — ещё раз с поправкой.
func (s *Server) encodeTarget(ctx context.Context, i int, ffm string, f Format, req StartReq, src, dst string, si srcInfo, safe bool, r rate, target int64) (string, error) {
	dir, err := os.MkdirTemp("", "konv-pass-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(dir)
	r.dir = dir
	for try := 0; ; try++ {
		r.pass = 1
		stderr, err := s.runFF(ctx, i, ffm, buildArgs(f, req, src, os.DevNull, si, safe, &r), si.dur, dir, 0, 0.4)
		if err != nil {
			return stderr, err
		}
		r.pass = 2
		stderr, err = s.runFF(ctx, i, ffm, buildArgs(f, req, src, dst, si, safe, &r), si.dur, dir, 0.4, 0.6)
		size := fileSize(dst)
		if err != nil || try == 1 || size <= target {
			return stderr, err
		}
		r.vk = int(float64(r.vk) * float64(target) / float64(size) * 0.97)
		req.Overwrite = true
		s.set(i, func(fs *FileState) { fs.Pct = 0; fs.Msg = tr("conv.squeezeMore") })
	}
}

func (s *Server) convert(ctx context.Context, i int, req StartReq, ffm string) {
	s.mu.Lock()
	src, dst, f, name, status := s.files[i].Path, s.files[i].Dst, s.files[i].f, s.files[i].Name, s.files[i].Status
	frames, framesSize, project := s.files[i].frames, s.files[i].SrcSize, s.files[i].project
	s.mu.Unlock()
	if status != "pending" { // «как есть» решено заранее
		return
	}
	if ctx.Err() != nil { // нажали «Стоп» до начала: файл не трогаем, прошлый результат остаётся
		s.set(i, func(fs *FileState) { fs.Status = "canceled" })
		return
	}

	if !req.Overwrite && hasResult(dst) {
		s.set(i, func(fs *FileState) { fs.Status = "skipped"; fs.Msg = tr("conv.exists") })
		s.logT("log.skipped", name)
		return
	}
	s.set(i, func(fs *FileState) { fs.Status = "running"; fs.Msg = "" })
	fail := func(err error) {
		s.set(i, func(fs *FileState) { fs.Status = "error"; fs.Msg = err.Error(); fs.Hint = err.Error() })
		s.logT("log.error", name, err)
	}
	var si srcInfo
	var srcSize int64
	if project != nil { // строка монтажа: входы и граф вместо одного файла
		var err error
		if si, err = timelineInfo(ctx, ffm, *project, f); err != nil {
			fail(err)
			return
		}
		srcSize = framesSize
	} else {
		si = probe(ctx, ffm, src) // у списка кадров берём сведения с первого: размер и прозрачность
		srcSize = fileSize(src)
	}
	if len(frames) > 0 {
		if err := checkFrameSizes(frames); err != nil {
			fail(err)
			return
		}
		rateStr, rateVal := joinRate(req)
		list, err := writeFrameList(frames)
		if err != nil {
			fail(err)
			return
		}
		defer os.Remove(list)
		src, srcSize = list, framesSize
		si.joinFPS, si.fps, si.dur = rateStr, rateVal, float64(len(frames))/rateVal
	}
	if f.Kind == "seq" {
		seqRemove(dst, src) // перезапись: кадры прошлой, более длинной версии не должны остаться
		if err := os.MkdirAll(dst, 0o755); err != nil {
			fail(err)
			return
		}
	}
	// монтаж сравнивать с исходниками незачем: он нужен в любом случае
	small := req.Format == "small" && project == nil
	expect := srcSize // сколько весит то, что кодируем
	start, length, trimmed := req.trim(src)
	if trimmed {
		if si.dur > 0 {
			length = min(length, max(si.dur-start, 0))
			expect = int64(float64(srcSize) * length / si.dur)
		}
		si.dur = length // прогресс и расчёт битрейта идут по куску, а не по всему файлу
	}

	var target int64
	if f.Kind == "video" && req.TargetMB > 0 {
		target = int64(req.TargetMB * (1 << 20))
	}
	if small && !trimmed && target > 0 && srcSize <= target {
		s.kept(i, tr("conv.alreadySmaller", mbStr(req.TargetMB)))
		return
	}
	var r rate
	twoPass := false
	if target > 0 {
		var err error
		if r, err = planRate(target, si, req); err != nil {
			fail(err)
			return
		}
		twoPass = expect > target // уже влезает — пробуем обычным способом, он быстрее
	}
	encode := func(req StartReq, safe bool) (string, error) {
		if twoPass {
			return s.encodeTarget(ctx, i, ffm, f, req, src, dst, si, safe, r, target)
		}
		return s.runFF(ctx, i, ffm, buildArgs(f, req, src, dst, si, safe, nil), si.dur, "", 0, 1)
	}

	stderr, err := encode(req, false)
	if err != nil && ctx.Err() == nil && (f.moving() || f.Kind == "gif") && !strings.Contains(stderr, "Error opening input") {
		os.Remove(dst)
		s.logT("log.retry", name, errSummary(stderr, err, 6))
		s.set(i, func(fs *FileState) { fs.Pct = 0; fs.Msg = tr("conv.retry") })
		rq := req
		rq.Overwrite = true // файл от первой попытки уже удалён
		stderr, err = encode(rq, true)
	}
	if err == nil && ctx.Err() == nil && target > 0 && !twoPass && fileSize(dst) > target {
		s.set(i, func(fs *FileState) {
			fs.Pct = 0
			fs.Msg = tr("conv.refit")
		})
		twoPass = true
		rq := req
		rq.Overwrite = true
		stderr, err = encode(rq, false)
	}

	if ctx.Err() != nil {
		removeResult(f, src, dst)
		s.set(i, func(fs *FileState) { fs.Status = "canceled"; fs.Msg = "" })
		return
	}
	if err != nil {
		removeResult(f, src, dst)
		short, hint := errSummary(stderr, err, 2), friendlyErr(stderr, err)
		s.set(i, func(fs *FileState) { fs.Status = "error"; fs.Msg = short; fs.Hint = hint })
		s.logT("log.errorLong", name, errSummary(stderr, err, 8))
		return
	}
	if f.Kind == "seq" {
		made := seqFrames(dst, src)
		if len(made) == 0 { // например, кусок обрезки целиком за концом файла
			seqRemove(dst, src)
			fail(errors.New(tr("snap.noFrame")))
			return
		}
		var size int64
		for _, p := range made {
			size += fileSize(p)
		}
		s.set(i, func(fs *FileState) {
			fs.Status, fs.Pct, fs.DstSize, fs.Msg = "ok", 100, size, tr("seq.done", len(made))
		})
		s.addLog("[ok] %s", filepath.Base(dst))
		return
	}
	size := fileSize(dst)
	if small && !trimmed && size >= srcSize { // обрезанный кусок нужен, даже если не стал легче
		os.Remove(dst)
		s.kept(i, tr("conv.noGain"))
		return
	}
	msg := ""
	if twoPass && r.height != "" && r.height != num(req.Height) {
		msg = tr("conv.heightReduced", r.height)
	}
	if target > 0 && size > target {
		msg = tr("conv.slightlyOver", mbStr(req.TargetMB))
	}
	s.set(i, func(fs *FileState) { fs.Status = "ok"; fs.Pct = 100; fs.DstSize = size; fs.Msg = msg })
	s.addLog("[ok] %s", filepath.Base(dst))
}

// runFF запускает ffmpeg и обновляет процент выполнения: lo..lo+span от всей работы над файлом
// (у двух проходов — две части). dir — рабочая папка ffmpeg (пусто — как у программы).
func (s *Server) runFF(ctx context.Context, i int, ffm string, args []string, dur float64, dir string, lo, span float64) (string, error) {
	args, clean, err := spillGraph(args)
	if err != nil {
		return "", err
	}
	defer clean()
	cmd := exec.CommandContext(ctx, ffm, args...)
	cmd.Dir = dir
	hide(cmd)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err == nil {
		err = cmd.Start()
	}
	if err != nil {
		return "", err
	}
	sc := bufio.NewScanner(stdout)
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "out_time_us=") && dur > 0 {
			us, e := strconv.ParseFloat(strings.TrimPrefix(line, "out_time_us="), 64)
			if e == nil {
				p := (lo + us/1e6/dur*span) * 100
				if p > 99 {
					p = 99
				}
				if p < 0 {
					p = 0
				}
				s.set(i, func(fs *FileState) { fs.Pct = p })
			}
		}
	}
	err = cmd.Wait()
	return stderr.String(), err
}

func (s *Server) run(req StartReq, ffm string) {
	f := formats[req.Format]
	ctx, cancel := context.WithCancel(context.Background())

	used := map[string]bool{}
	for _, p := range req.Files { // результат не должен затереть другой исходник из этой же пачки (a.mov → a.mp4)
		used[strings.ToLower(p)] = true
	}
	groups := map[string][]string{} // первый кадр → все кадры будущего видео
	inGroup := map[string]bool{}
	if canJoin(req, f) {
		for _, g := range joinGroups(req.Files) {
			groups[g[0]] = g
			for _, p := range g {
				inGroup[p] = true
			}
		}
	}
	var states []*FileState
	for _, p := range req.Files {
		if inGroup[p] && groups[p] == nil {
			continue
		}
		if project, ok := req.Montages[p]; ok {
			states = append(states, montRow(p, project, req, f, used))
			continue
		}
		st := &FileState{Path: p, Name: filepath.Base(p), Status: "pending", SrcSize: fileSize(p), f: f}
		why := ""
		if f.Kind == "compress" {
			st.f, why = compressFormat(p, req)
		}
		switch g := groups[p]; {
		case why != "":
			st.Status, st.Msg = "kept", why
		case g != nil:
			stem := joinStem(p)
			st.frames, st.Name, st.SrcSize = g, tr("seq.joinName", stem, len(g)), 0
			for _, frame := range g {
				st.SrcSize += fileSize(frame)
			}
			st.Dst = outPath(filepath.Join(filepath.Dir(p), stem+".frames"), req, f.Ext, used)
		case f.Kind == "seq":
			st.Dst = seqOutPath(p, req, used)
		default:
			st.Dst = outPath(p, req, st.f.Ext, used)
		}
		states = append(states, st)
	}
	s.mu.Lock()
	s.files = states
	s.batch = "conv"
	s.running = true
	s.cancel = cancel
	s.summary = ""
	s.mu.Unlock()

	jobs := req.Jobs
	if jobs < 1 {
		jobs = 1
	}
	if jobs > 8 {
		jobs = 8
	}
	idx := make(chan int)
	var wg sync.WaitGroup
	for w := 0; w < jobs; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range idx {
				s.convert(ctx, i, req, ffm)
			}
		}()
	}
	for i := range states {
		if ctx.Err() != nil {
			break
		}
		idx <- i
	}
	close(idx)
	wg.Wait()
	s.finishBatch()
	cancel()
}

// finishBatch: итог пачки и конец работы
func (s *Server) finishBatch() {
	s.mu.Lock()
	var ok, bad, skip, kept, canc int
	for _, fs := range s.files {
		switch fs.Status {
		case "ok":
			ok++
		case "error":
			bad++
		case "skipped":
			skip++
		case "kept":
			kept++
		default:
			fs.Status = "canceled"
			canc++
		}
	}
	title := tr("batch.done")
	if canc > 0 {
		title = tr("batch.stopped")
	}
	s.summary = tr("batch.summary", title, ok, bad, skip)
	if kept > 0 {
		s.summary += tr("batch.summaryKept", kept)
	}
	s.running = false
	s.cancel = nil
	s.mu.Unlock()
	s.addLog("%s", s.summary)
}
