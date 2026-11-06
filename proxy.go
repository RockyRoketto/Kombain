package main

// Копия для просмотра. Встроенный проигрыватель не умеет ProRes, WMV, AVI и часто H.265,
// поэтому такие файлы пережимаются в лёгкий MP4 в служебную папку. Конвертируется и режется всё равно оригинал.
// Слой с прозрачностью идёт в WebM с VP9: H.264 прозрачность не хранит, и слой закрыл бы всё под собой.
// Реверс окно играть не умеет, поэтому для него готовится кусок файла задом наперёд.

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	proxyKeep    = 10 << 30 // сколько места могут занять копии; лишними становятся те, что дольше всего не смотрели
	proxyWorkers = 2        // сколько копий готовится одновременно, остальные ждут
)

type ProxyState struct {
	Ready bool    `json:"ready"`
	Pct   float64 `json:"pct"`
	Error string  `json:"error,omitempty"`
}

// proxyPiece: что нужно от файла. Пустой значит весь файл как есть, Rev — кусок From..From+Len задом наперёд.
type proxyPiece struct {
	Rev  bool    `json:"rev"`
	From float64 `json:"from"`
	Len  float64 `json:"len"`
}

type proxyJob struct {
	src, stem string
	piece     proxyPiece
	pct       float64
	failed    bool
	done      bool
	cancel    context.CancelFunc
	finished  chan struct{}
}

var (
	proxySegment = 8.0 // реверс считается такими кусками: фильтр reverse держит в памяти все кадры

	proxyMu    sync.Mutex
	proxyJobs  = map[string]*proxyJob{} // по имени копии без расширения
	proxySlots = make(chan struct{}, proxyWorkers)
)

func proxyDir() string { return filepath.Join(cacheDir(), "preview") }

// proxyStem: имя копии без расширения. Оно зависит от времени и размера оригинала, изменившийся файл получит новую.
func proxyStem(p string, piece proxyPiece) (string, bool) {
	key, ok := fileKey(p)
	if !ok {
		return "", false
	}
	if piece.Rev {
		key += fmt.Sprintf("|rev|%.3f|%.3f", piece.From, piece.Len)
	}
	sum := sha256.Sum256([]byte(key))
	return filepath.Join(proxyDir(), hex.EncodeToString(sum[:12])), true
}

func proxyReady(stem string) (string, bool) {
	for _, ext := range []string{".mp4", ".webm"} {
		if fileExists(stem + ext) {
			return stem + ext, true
		}
	}
	return stem + ".mp4", false
}

func proxyPiecePath(p string, piece proxyPiece) (string, bool) {
	stem, ok := proxyStem(p, piece)
	if !ok {
		return "", false
	}
	out, _ := proxyReady(stem)
	return out, true
}

func proxyPath(p string) (string, bool) { return proxyPiecePath(p, proxyPiece{}) }

// proxyOpts: как именно считать один кусок копии
type proxyOpts struct {
	video, alpha, rev bool
	decoder           string
	from, cut         float64
}

// proxyArgs: копия начинается с нуля и длится столько же, поэтому время на шкале совпадает с оригиналом
func proxyArgs(src, dst string, o proxyOpts) []string {
	args := []string{"-hide_banner", "-nostdin", "-loglevel", "error", "-progress", "pipe:1", "-nostats", "-y"}
	if o.video && o.decoder != "" {
		args = append(args, "-c:v", o.decoder)
	}
	if o.cut > 0 {
		args = append(args, "-ss", secs(o.from), "-t", secs(o.cut))
	}
	args = append(args, "-i", src)
	var flip []string
	if o.rev {
		flip = []string{"-af", "areverse"}
	}
	if !o.video {
		args = append(append(args, "-map", "0:a:0", "-vn"), flip...)
		return append(args, "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-movflags", "+faststart", "-f", "mp4", dst)
	}
	vf, pix := "scale='trunc(min(1280,iw)/2)*2':-2", "yuv420p"
	if o.alpha {
		pix = "yuva420p"
	}
	if o.rev {
		vf += ",reverse" // после уменьшения: так кадры займут меньше памяти
	}
	args = append(args, "-map", "0:v:0", "-map", "0:a:0?", "-vf", vf+",format="+pix)
	args = append(args, flip...)
	// частые опорные кадры: перемотка и шаг по кадрам без задержки
	if o.alpha {
		args = append(args, "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-b:v", "0", "-crf", "36", "-g", "15", "-auto-alt-ref", "0")
		return append(args, "-c:a", "libopus", "-b:a", "128k", "-ac", "2", "-f", "webm", dst)
	}
	args = append(args, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "26", "-g", "15")
	return append(args, "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-movflags", "+faststart", "-f", "mp4", dst)
}

// proxyStatus: первый вызов запускает копию, следующие сообщают, как идут дела
func proxyStatus(ffm, src string, piece proxyPiece) ProxyState {
	stem, ok := proxyStem(src, piece)
	if !ok {
		return ProxyState{Error: tr("media.notFound")}
	}
	proxyMu.Lock()
	defer proxyMu.Unlock()
	if j := proxyJobs[stem]; j != nil {
		if j.failed {
			return ProxyState{Error: tr("media.noPlayback")}
		}
		return ProxyState{Pct: j.pct}
	}
	if out, found := proxyReady(stem); found {
		now := time.Now() // смотрели только что: при нехватке места эта копия уйдёт последней
		os.Chtimes(out, now, now)
		return ProxyState{Ready: true}
	}
	ctx, cancel := context.WithCancel(context.Background())
	j := &proxyJob{src: src, stem: stem, piece: piece, cancel: cancel, finished: make(chan struct{})}
	proxyJobs[stem] = j
	go j.run(ctx, ffm)
	return ProxyState{}
}

func (j *proxyJob) run(ctx context.Context, ffm string) {
	defer close(j.finished)
	defer j.cancel()
	var err error
	select {
	case proxySlots <- struct{}{}:
		defer func() { <-proxySlots }()
	case <-ctx.Done():
		err = ctx.Err()
	}
	if err == nil {
		err = j.make(ctx, ffm)
	}
	proxyMu.Lock()
	j.done = true
	j.failed = err != nil && ctx.Err() == nil
	if !j.failed && proxyJobs[j.stem] == j {
		delete(proxyJobs, j.stem) // готовую копию дальше находит proxyReady; ошибка остаётся, чтобы не повторять её по кругу
	}
	proxyMu.Unlock()
	if err == nil {
		proxyPrune()
	}
}

func (j *proxyJob) make(ctx context.Context, ffm string) error {
	if err := os.MkdirAll(proxyDir(), 0o755); err != nil {
		return err
	}
	mi := getMediaInfo(ffm, j.src)
	o := proxyOpts{video: mi.VCodec != "" && !mi.Cover, rev: j.piece.Rev, from: j.piece.From, cut: j.piece.Len}
	ext := ".mp4"
	if o.video {
		si := probe(ctx, ffm, j.src)
		o.decoder = si.decoder
		if si.alpha {
			o.alpha, ext = true, ".webm"
		}
	}
	// своё имя у каждого запуска: прерванный ffmpeg ещё может держать свой файл
	tmp := fmt.Sprintf("%s%s.%d.tmp", j.stem, ext, time.Now().UnixNano())
	var err error
	if j.piece.Rev {
		err = j.encodeReverse(ctx, ffm, tmp, o)
	} else {
		err = j.encode(ctx, ffm, proxyArgs(j.src, tmp, o), 0, mi.Dur, mi.Dur)
	}
	if err == nil {
		err = os.Rename(tmp, j.stem+ext)
	}
	if err != nil {
		os.Remove(tmp)
	}
	return err
}

// encodeReverse считает кусок с конца по частям и склеивает их: так реверс длинного клипа не съедает всю память
func (j *proxyJob) encodeReverse(ctx context.Context, ffm, tmp string, o proxyOpts) error {
	dir := tmp + ".d"
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	ext := ".mp4"
	if o.alpha {
		ext = ".webm"
	}
	total := max(o.cut, 0.001)
	n := max(int(math.Ceil(total/proxySegment)), 1)
	var list strings.Builder
	for i := 0; i < n; i++ {
		end := o.from + total - float64(i)*proxySegment
		start := max(o.from, end-proxySegment)
		part := o
		part.from, part.cut = start, end-start
		name := fmt.Sprintf("p%d%s", i, ext)
		fmt.Fprintf(&list, "file '%s'\n", name)
		if err := j.encode(ctx, ffm, proxyArgs(j.src, filepath.Join(dir, name), part), float64(i)*proxySegment, part.cut, total); err != nil {
			return err
		}
	}
	listFile := filepath.Join(dir, "list.txt")
	if err := os.WriteFile(listFile, []byte(list.String()), 0o644); err != nil {
		return err
	}
	args := []string{"-hide_banner", "-nostdin", "-loglevel", "error", "-progress", "pipe:1", "-nostats", "-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy"}
	if o.alpha {
		args = append(args, "-f", "webm", tmp)
	} else {
		args = append(args, "-movflags", "+faststart", "-f", "mp4", tmp)
	}
	return j.encode(ctx, ffm, args, total, 0, total)
}

// encode запускает ffmpeg. Этот запуск считает cut секунд из total, до него уже посчитано done.
func (j *proxyJob) encode(ctx context.Context, ffm string, args []string, done, cut, total float64) error {
	cmd := exec.CommandContext(ctx, ffm, args...)
	hide(cmd)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err == nil {
		err = cmd.Start()
	}
	if err != nil {
		return err
	}
	sc := bufio.NewScanner(stdout)
	for sc.Scan() {
		v, found := strings.CutPrefix(sc.Text(), "out_time_us=")
		if us, e := strconv.ParseFloat(v, 64); found && e == nil && total > 0 {
			proxyMu.Lock()
			j.pct = min(max((done+min(us/1e6, cut))/total*100, 0), 99)
			proxyMu.Unlock()
		}
	}
	if err := cmd.Wait(); err != nil {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return nil
}

// proxyStop: окно закрыли, готовить эту копию больше незачем
func proxyStop(src string, piece proxyPiece) {
	stem, ok := proxyStem(src, piece)
	if !ok {
		return
	}
	proxyMu.Lock()
	defer proxyMu.Unlock()
	if j := proxyJobs[stem]; j != nil && !j.failed {
		j.cancel()
		delete(proxyJobs, stem) // следующий просмотр запустит копию заново
	}
}

// proxyPrune следит за пределом места: файл, который сейчас играет, Windows удалить не даст
func proxyPrune() {
	entries, err := os.ReadDir(proxyDir())
	if err != nil {
		return
	}
	type item struct {
		path string
		size int64
		at   time.Time
	}
	var ready []item
	for _, e := range entries {
		if st, err := e.Info(); err == nil && isProxyFile(e.Name()) {
			ready = append(ready, item{filepath.Join(proxyDir(), e.Name()), st.Size(), st.ModTime()})
		}
	}
	slices.SortFunc(ready, func(a, b item) int { return b.at.Compare(a.at) })
	var sum int64
	for _, it := range ready {
		if sum += it.size; sum > proxyKeep {
			os.Remove(it.path)
		}
	}
}

func isProxyFile(name string) bool {
	return strings.HasSuffix(name, ".mp4") || strings.HasSuffix(name, ".webm")
}

// proxyUsage: сколько байт занимают готовые копии
func proxyUsage() int64 {
	entries, err := os.ReadDir(proxyDir())
	if err != nil {
		return 0
	}
	var sum int64
	for _, e := range entries {
		if st, err := e.Info(); err == nil && isProxyFile(e.Name()) {
			sum += st.Size()
		}
	}
	return sum
}

// proxyHalt останавливает всё, что готовится, и ждёт, пока ffmpeg отпустит файлы
func proxyHalt() {
	proxyMu.Lock()
	jobs := proxyJobs
	proxyJobs = map[string]*proxyJob{}
	proxyMu.Unlock()
	limit := time.After(2 * time.Second)
	for _, j := range jobs {
		j.cancel()
	}
	for _, j := range jobs {
		select {
		case <-j.finished:
		case <-limit:
			return
		}
	}
}

// proxyClear: кнопка «Очистить копии». Файл, который сейчас играет, остаётся до следующего раза.
func proxyClear() {
	proxyHalt()
	os.RemoveAll(proxyDir())
}

// proxyCleanup: при закрытии программы останавливает копии и убирает недоделанные. Готовые остаются до следующего запуска.
func proxyCleanup() {
	proxyHalt()
	entries, err := os.ReadDir(proxyDir())
	if err != nil {
		return
	}
	for _, e := range entries {
		if !isProxyFile(e.Name()) {
			os.RemoveAll(filepath.Join(proxyDir(), e.Name()))
		}
	}
}
