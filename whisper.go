package main

// Автосубтитры: речь монтажа превращается в файл .srt рядом с первым исходником, дальше он работает как любой другой (subtitles.go).
// Распознаёт отдельная программа whisper.cpp (лицензия MIT). Её и модель качаем при первом использовании и всегда сверяем сумму.
// Кнопка в интерфейсе: web/js/montage.js (mtAuto).

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
)

type whisperFile struct {
	url  string
	size int64
	sum  string // sha256
}

// Обновляя пакет, менять и тег: по нему программа видит, что пора скачать новый
const whisperTag = "b5454"

var whisperPkg = whisperFile{"https://github.com/ggml-org/whisper.cpp/releases/download/" + whisperTag + "/whisper-bin-x64.zip", 8928640,
	"6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb"}

var whisperModels = map[string]whisperFile{
	"tiny":  {whisperModelURL + "ggml-tiny.bin", 77691713, "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21"},
	"base":  {whisperModelURL + "ggml-base.bin", 147951465, "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe"},
	"small": {whisperModelURL + "ggml-small.bin", 487601967, "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b"},
}

const whisperModelURL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/"

// WhisperJob: что видит страница. Stage: tool, model, audio, speech; пусто — не работает.
type WhisperJob struct {
	Active bool    `json:"active"`
	Stage  string  `json:"stage"`
	Pct    float64 `json:"pct"`
	Err    string  `json:"err"`
	Path   string  `json:"path"` // готовый файл .srt
	Seq    int     `json:"seq"`  // номер запуска: страница так узнаёт конец своего
}

var (
	whisperMu     sync.Mutex
	whisperNow    WhisperJob
	whisperCancel context.CancelFunc
)

func whisperState() WhisperJob {
	whisperMu.Lock()
	defer whisperMu.Unlock()
	return whisperNow
}

func whisperSet(stage string, pct float64) {
	whisperMu.Lock()
	whisperNow.Stage, whisperNow.Pct = stage, pct
	whisperMu.Unlock()
}

func whisperStop() {
	whisperMu.Lock()
	c := whisperCancel
	whisperMu.Unlock()
	if c != nil {
		c()
	}
}

func whisperExe() string     { return filepath.Join(toolDir("whisper"), "whisper-cli.exe") }
func whisperTagPath() string { return filepath.Join(toolDir("whisper"), "version.txt") }
func whisperModelPath(name string) string {
	return filepath.Join(modelDir("whisper"), "ggml-"+name+".bin")
}

func whisperToolReady() bool {
	b, err := os.ReadFile(whisperTagPath())
	return err == nil && string(b) == whisperTag && fileExists(whisperExe())
}

// whisperFetch качает файл, сверяет размер и сумму. На нужное место он встаёт только проверенным.
func whisperFetch(ctx context.Context, f whisperFile, dst string, progress func(float64)) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	part := dst + ".part"
	h := sha256.New()
	n, err := downloadCtx(ctx, f.url, part, f.size, f.size+1, h, progress)
	if err != nil {
		return err
	}
	if n != f.size || hex.EncodeToString(h.Sum(nil)) != f.sum {
		os.Remove(part)
		return errT("whisper.badFile")
	}
	return os.Rename(part, dst)
}

// whisperUnpack: из архива нужна только сама программа и её библиотеки. Папки внутри архива не учитываются, поэтому выйти за dir нельзя.
func whisperUnpack(archive, dir string) error {
	zr, err := zip.OpenReader(archive)
	if err != nil {
		return err
	}
	defer zr.Close()
	found := false
	for _, f := range zr.File {
		name := strings.ToLower(filepath.Base(filepath.FromSlash(f.Name)))
		if name != "whisper-cli.exe" && !strings.HasSuffix(name, ".dll") {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		w, err := os.Create(filepath.Join(dir, name))
		if err == nil {
			_, err = io.Copy(w, rc)
			if e := w.Close(); err == nil {
				err = e
			}
		}
		rc.Close()
		if err != nil {
			return err
		}
		found = found || name == "whisper-cli.exe"
	}
	if !found {
		return errT("whisper.badFile")
	}
	return nil
}

func whisperInstall(ctx context.Context) error {
	dir := toolDir("whisper")
	os.RemoveAll(dir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	archive := filepath.Join(dir, "package.zip")
	if err := whisperFetch(ctx, whisperPkg, archive, func(p float64) { whisperSet("tool", p) }); err != nil {
		return err
	}
	defer os.Remove(archive)
	if err := whisperUnpack(archive, dir); err != nil {
		return err
	}
	return os.WriteFile(whisperTagPath(), []byte(whisperTag), 0o644) // последним: без него пакет считается недокачанным
}

var whisperProgress = regexp.MustCompile(`progress\s*=\s*(\d+)%`)

// whisperPct: процент из вывода программы; -1, если в строке его нет
func whisperPct(line string) float64 {
	if m := whisperProgress.FindStringSubmatch(line); m != nil {
		v, _ := strconv.ParseFloat(m[1], 64)
		return v
	}
	return -1
}

// whisperArgs: пути относительно папки программы, потому что она сама запускается оттуда: пути с кириллицей ей лучше не передавать
// dtw: название модели для времён отдельных слов, пусто — без них
func whisperArgs(model, wav, out, lang string, threads int, dtw string) []string {
	args := []string{"-m", model, "-f", wav, "-l", lang, "-t", strconv.Itoa(threads), "-osrt", "--output-json-full", "-of", out, "-pp"}
	if dtw != "" {
		args = append(args, "--dtw", dtw)
	}
	return args
}

// splitLines: строки вывода кончаются и на \r
func splitLines(data []byte, atEOF bool) (int, []byte, error) {
	if i := bytes.IndexAny(data, "\r\n"); i >= 0 {
		return i + 1, data[:i], nil
	}
	if atEOF && len(data) > 0 {
		return len(data), data, nil
	}
	return 0, nil, nil
}

func whisperSpeech(ctx context.Context, model, wav, out, lang, dtw string) error {
	tool := toolDir("whisper")
	rel := func(p string) string {
		r, err := filepath.Rel(tool, p)
		if err != nil {
			return p
		}
		return r
	}
	cmd := exec.CommandContext(ctx, whisperExe(), whisperArgs(rel(model), rel(wav), rel(out), lang, min(max(runtime.NumCPU()-1, 1), 8), dtw)...)
	cmd.Dir = tool
	hide(cmd)
	pr, pw := io.Pipe()
	cmd.Stdout, cmd.Stderr = pw, pw
	if err := cmd.Start(); err != nil {
		return err
	}
	var tail []string
	done := make(chan struct{})
	go func() {
		defer close(done)
		sc := bufio.NewScanner(pr)
		sc.Buffer(make([]byte, 64<<10), 1<<20)
		sc.Split(splitLines)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if line == "" {
				continue
			}
			if p := whisperPct(line); p >= 0 {
				whisperSet("speech", p)
				continue
			}
			if tail = append(tail, line); len(tail) > 4 {
				tail = tail[1:]
			}
		}
		io.Copy(io.Discard, pr)
	}()
	err := cmd.Wait()
	pw.Close()
	<-done
	if err != nil && ctx.Err() == nil {
		return errors.New(tr("whisper.failed", err) + "\n" + strings.Join(tail, "\n"))
	}
	return err
}

// whisperAudio: весь монтаж без меток вывода: времена реплик совпадут с дорожками
func whisperAudio(ctx context.Context, ffm string, p Project, wav string) error {
	p.In, p.Out, p.Subs = 0, 0, nil
	si, err := timelineInfo(ctx, ffm, p, formats["wav"])
	if err != nil {
		return err
	}
	args := append([]string{"-hide_banner", "-loglevel", "error", "-nostdin", "-y"}, si.inputs...)
	args = append(args, montGraphArgs(si, "")...)
	args, clean, err := spillGraph(append(args, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav))
	if err != nil {
		return err
	}
	defer clean()
	cmd := exec.CommandContext(ctx, ffm, args...)
	hide(cmd)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if msg := strings.TrimSpace(stderr.String()); msg != "" && ctx.Err() == nil {
			return errors.New(msg)
		}
		return err
	}
	return nil
}

// whisperPlace кладёт готовый файл рядом с первым исходником. Чужой файл с таким именем не трогает.
func whisperPlace(cues []SubCue, lead string) (string, error) {
	if len(cues) == 0 {
		return "", errT("whisper.noSpeech")
	}
	b := []byte(subsSRT(cues))
	dir := filepath.Dir(lead)
	if isTemp(lead) {
		dir = defaultOut()
	}
	try := func(dir string) (string, error) {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return "", err
		}
		stem := strings.TrimSuffix(filepath.Base(lead), filepath.Ext(lead))
		for i := 1; i < 1000; i++ {
			name := stem + ".srt"
			if i > 1 {
				name = fmt.Sprintf("%s_%d.srt", stem, i)
			}
			p := filepath.Join(dir, name)
			f, err := os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
			if os.IsExist(err) {
				continue
			}
			if err != nil {
				return "", err
			}
			_, err = f.Write(b)
			if e := f.Close(); err == nil {
				err = e
			}
			return p, err
		}
		return "", os.ErrExist
	}
	p, err := try(dir)
	if err != nil { // папка исходника только для чтения, например на сетевом диске
		return try(defaultOut())
	}
	return p, nil
}

func whisperRun(ctx context.Context, ffm string, p Project, model, lang string) (string, error) {
	if !whisperToolReady() {
		whisperSet("tool", 0)
		if err := whisperInstall(ctx); err != nil {
			return "", err
		}
	}
	mp := whisperModelPath(model)
	if !fileExists(mp) {
		whisperSet("model", 0)
		if err := whisperFetch(ctx, whisperModels[model], mp, func(v float64) { whisperSet("model", v) }); err != nil {
			return "", err
		}
	}
	work := filepath.Join(cacheDir(), "whisper")
	os.RemoveAll(work)
	if err := os.MkdirAll(work, 0o755); err != nil {
		return "", err
	}
	defer os.RemoveAll(work)
	whisperSet("audio", 0)
	wav := filepath.Join(work, "audio.wav")
	if err := whisperAudio(ctx, ffm, p, wav); err != nil {
		return "", err
	}
	whisperSet("speech", 0)
	out := filepath.Join(work, "out")
	err := whisperSpeech(ctx, mp, wav, out, lang, model)
	if err != nil && ctx.Err() == nil { // времена слов экспериментальные: лучше грубые субтитры, чем никаких
		whisperSet("speech", 0)
		err = whisperSpeech(ctx, mp, wav, out, lang, "")
	}
	if err != nil {
		return "", err
	}
	var cues []SubCue
	if b, err := os.ReadFile(out + ".json"); err == nil {
		os.WriteFile(filepath.Join(cacheDir(), "whisper-last.json"), b, 0o644) // сырые времена последнего запуска: без них сдвиг не разобрать
		if words, err := whisperWords(b); err == nil {
			cues = whisperGroup(whisperRepair(words))
		}
	}
	if len(cues) == 0 {
		if b, err := os.ReadFile(out + ".srt"); err == nil {
			cues = whisperClean(subsParse(subsDecode(b)))
		}
	}
	if spans, err := speechSpans(ctx, ffm, wav); err == nil { // не вышло: остаются времена whisper
		cues = whisperAlign(cues, spans)
	}
	return whisperPlace(cues, p.lead())
}

var whisperLang = regexp.MustCompile(`^(auto|[a-z]{2,3})$`)

// whisperStart запускает работу в фоне. Ход и результат отдаёт whisperState.
func whisperStart(ffm string, p Project, model, lang string) error {
	if runtime.GOOS != "windows" {
		return errT("dlg.onlyWindows")
	}
	if ffm == "" {
		return errT("whisper.noFFmpeg")
	}
	if _, ok := whisperModels[model]; !ok {
		model = "small"
	}
	if !whisperLang.MatchString(lang) {
		lang = "auto"
	}
	if p.lead() == "" {
		return errT("mont.noClips")
	}
	ctx, cancel := context.WithCancel(context.Background())
	whisperMu.Lock()
	if whisperNow.Active {
		whisperMu.Unlock()
		cancel()
		return nil
	}
	whisperNow = WhisperJob{Active: true, Seq: whisperNow.Seq + 1}
	whisperCancel = cancel
	whisperMu.Unlock()
	go func() {
		defer cancel()
		path, err := whisperRun(ctx, ffm, p, model, lang)
		whisperMu.Lock()
		defer whisperMu.Unlock()
		whisperNow.Active, whisperNow.Stage, whisperNow.Path, whisperCancel = false, "", path, nil
		if err != nil && ctx.Err() == nil {
			whisperNow.Err = err.Error()
		}
	}()
	return nil
}

// whisperInstalled: какие модели уже скачаны и нужно ли ещё качать саму программу
func whisperInstalled() map[string]any {
	have := map[string]bool{}
	for name := range whisperModels {
		have[name] = fileExists(whisperModelPath(name))
	}
	return map[string]any{"tool": whisperToolReady(), "toolSize": whisperPkg.size, "models": have}
}
