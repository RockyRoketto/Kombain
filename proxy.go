package main

// Копия для просмотра. Встроенный проигрыватель не умеет ProRes, WMV, AVI и часто H.265,
// поэтому такие файлы пережимаются в лёгкий MP4 в служебную папку. Конвертируется и режется всё равно оригинал.

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// сколько готовых копий держать: окно обрезки и просмотр часто открывают один и тот же файл снова
const proxyKeep = 6

type ProxyState struct {
	Ready bool    `json:"ready"`
	Pct   float64 `json:"pct"`
	Error string  `json:"error,omitempty"`
}

type proxyJob struct {
	src, out string
	pct      float64
	failed   bool
	done     bool
	cancel   context.CancelFunc
	finished chan struct{}
}

var (
	proxyMu  sync.Mutex
	proxyCur *proxyJob // смотрят один файл за раз, поэтому и копия готовится одна
)

func proxyDir() string { return filepath.Join(dataDir(), "preview") }

// proxyPath: имя копии зависит от времени и размера оригинала, изменившийся файл получит новую
func proxyPath(p string) (string, bool) {
	key, ok := fileKey(p)
	if !ok {
		return "", false
	}
	sum := sha256.Sum256([]byte(key))
	return filepath.Join(proxyDir(), hex.EncodeToString(sum[:12])+".mp4"), true
}

// proxyArgs: копия начинается с нуля и длится столько же, поэтому время на шкале совпадает с оригиналом
func proxyArgs(src, dst string, video bool) []string {
	args := []string{"-hide_banner", "-nostdin", "-loglevel", "error", "-progress", "pipe:1", "-nostats", "-y", "-i", src}
	if video {
		args = append(args, "-map", "0:v:0", "-map", "0:a:0?",
			"-vf", "scale='trunc(min(1280,iw)/2)*2':-2,format=yuv420p",
			// частые опорные кадры: перемотка и шаг по кадрам без задержки
			"-c:v", "libx264", "-preset", "ultrafast", "-crf", "26", "-g", "15")
	} else {
		args = append(args, "-map", "0:a:0", "-vn")
	}
	return append(args, "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-movflags", "+faststart", "-f", "mp4", dst)
}

// proxyStatus: первый вызов запускает копию, следующие сообщают, как идут дела
func proxyStatus(ffm, src string) ProxyState {
	out, ok := proxyPath(src)
	if !ok {
		return ProxyState{Error: tr("media.notFound")}
	}
	proxyMu.Lock()
	defer proxyMu.Unlock()
	if j := proxyCur; j != nil && j.out == out {
		switch {
		case j.failed:
			return ProxyState{Error: tr("media.noPlayback")}
		case !j.done:
			return ProxyState{Pct: j.pct}
		}
	}
	if fileExists(out) {
		return ProxyState{Ready: true}
	}
	if proxyCur != nil && !proxyCur.done {
		proxyCur.cancel()
	}
	mi := getMediaInfo(ffm, src)
	ctx, cancel := context.WithCancel(context.Background())
	j := &proxyJob{src: src, out: out, cancel: cancel, finished: make(chan struct{})}
	proxyCur = j
	go j.run(ctx, ffm, mi)
	return ProxyState{}
}

func (j *proxyJob) run(ctx context.Context, ffm string, mi MediaInfo) {
	defer close(j.finished)
	defer j.cancel()
	err := os.MkdirAll(proxyDir(), 0o755)
	// своё имя у каждого запуска: прерванный ffmpeg ещё может держать свой файл
	tmp := fmt.Sprintf("%s.%d.tmp", j.out, time.Now().UnixNano())
	if err == nil {
		err = j.encode(ctx, ffm, tmp, mi)
	}
	if err == nil {
		err = os.Rename(tmp, j.out)
	}
	if err != nil {
		os.Remove(tmp)
	}
	proxyMu.Lock()
	j.done = true
	j.failed = err != nil && ctx.Err() == nil
	proxyMu.Unlock()
	if err == nil {
		proxyPrune()
	}
}

func (j *proxyJob) encode(ctx context.Context, ffm, tmp string, mi MediaInfo) error {
	cmd := exec.CommandContext(ctx, ffm, proxyArgs(j.src, tmp, mi.VCodec != "" && !mi.Cover)...)
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
		if us, e := strconv.ParseFloat(v, 64); found && e == nil && mi.Dur > 0 {
			proxyMu.Lock()
			j.pct = min(max(us/1e6/mi.Dur*100, 0), 99)
			proxyMu.Unlock()
		}
	}
	if err := cmd.Wait(); err != nil {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return nil
}

// proxyStop: окно закрыли, готовить копию этого файла больше незачем
func proxyStop(src string) {
	proxyMu.Lock()
	defer proxyMu.Unlock()
	if j := proxyCur; j != nil && j.src == src {
		j.cancel()
		proxyCur = nil // следующий просмотр запустит копию заново
	}
}

// proxyPrune оставляет только последние копии; файл, который сейчас играет, Windows удалить не даст
func proxyPrune() {
	entries, err := os.ReadDir(proxyDir())
	if err != nil {
		return
	}
	type item struct {
		path string
		at   time.Time
	}
	var ready []item
	for _, e := range entries {
		if st, err := e.Info(); err == nil && strings.HasSuffix(e.Name(), ".mp4") {
			ready = append(ready, item{filepath.Join(proxyDir(), e.Name()), st.ModTime()})
		}
	}
	slices.SortFunc(ready, func(a, b item) int { return b.at.Compare(a.at) })
	for i := proxyKeep; i < len(ready); i++ {
		os.Remove(ready[i].path)
	}
}

// proxyCleanup: при закрытии программы останавливает копию и удаляет папку
func proxyCleanup() {
	proxyMu.Lock()
	j := proxyCur
	proxyCur = nil
	proxyMu.Unlock()
	if j != nil {
		j.cancel()
		select {
		case <-j.finished:
		case <-time.After(2 * time.Second):
		}
	}
	os.RemoveAll(proxyDir())
}
