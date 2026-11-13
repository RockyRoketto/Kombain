package main

// «Улучшить» во вкладке «ИИ-картинки»: llama-server с маленькой текстовой моделью (Gemma 3 4B, каталог) переписывает
// короткий запрос на любом языке в подробный английский промт. Сервер запускается по требованию (старт 3–7 с,
// ответ ~1 с, замеры сессии 2) и гаснет после минуты простоя. На карте меньше 14 ГБ он берёт видеопамять через aiGPU
// и тем выгружает модель картинок; на большой карте они помещаются вместе.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// llmIdle: столько сервер ждёт следующего «Улучшить», прежде чем отдать память
var llmIdle = 60 * time.Second

type llmServer struct {
	mu    sync.Mutex
	cmd   *exec.Cmd
	done  chan struct{}
	base  string
	model string
	timer *time.Timer
	busy  sync.Mutex // один запрос за раз: модель маленькая, очередь не нужна
}

var llmSrv = &llmServer{}

func llmExe() string     { return filepath.Join(aiEngineDir("llm"), "llama-server.exe") }
func llmLogPath() string { return filepath.Join(aiLogDir(), "llama-server.log") }

// llmModelPath: файл установленной текстовой модели; пусто — не установлена
func llmModelPath() string {
	for _, m := range aiLoadInstalled().Models {
		if m.Kind == "llm" {
			for _, f := range m.Files {
				if f.Role == "llm" {
					p := filepath.Join(aiModelsDir(), filepath.FromSlash(f.Path))
					if fileExists(p) {
						return p
					}
				}
			}
		}
	}
	return ""
}

// llmReady: «Улучшить» можно показывать
func llmReady() bool { return fileExists(llmExe()) && llmModelPath() != "" }

func (l *llmServer) alive() bool {
	if l.base == "" || l.done == nil {
		return false
	}
	select {
	case <-l.done:
		return false
	default:
		return true
	}
}

func (l *llmServer) Stop() {
	l.mu.Lock()
	cmd, done := l.cmd, l.done
	l.cmd, l.done, l.base, l.model = nil, nil, "", ""
	if l.timer != nil {
		l.timer.Stop()
	}
	l.mu.Unlock()
	if cmd != nil && cmd.Process != nil {
		cmd.Process.Kill()
		<-done
	}
	aiGPU.drop("llm")
}

// llmShareGPU: карте хватает места и на модель картинок, и на LLM (SDXL 10–11 ГБ на пике + 3–4 ГБ)
func llmShareGPU() bool { return hwVRAMTotal() >= 14*1024 }

// start поднимает сервер, если он не запущен
func (l *llmServer) start(ctx context.Context) (string, error) {
	model := llmModelPath()
	if model == "" || !fileExists(llmExe()) {
		return "", errT("llm.notInstalled")
	}
	l.mu.Lock()
	if l.alive() && l.model == model {
		base := l.base
		l.mu.Unlock()
		return base, nil
	}
	l.mu.Unlock()
	l.Stop()
	if !llmShareGPU() {
		aiGPU.take("llm", func() { go l.Stop() })
	}
	port, err := freePort()
	if err != nil {
		return "", err
	}
	os.MkdirAll(aiLogDir(), 0o755)
	logf, err := os.Create(llmLogPath())
	if err != nil {
		return "", err
	}
	cmd := exec.Command(llmExe(), "-m", model, "--host", "127.0.0.1", "--port", strconv.Itoa(port), "-ngl", "99", "-c", "4096", "--no-webui")
	cmd.Dir = filepath.Dir(llmExe())
	cmd.Stdout, cmd.Stderr = logf, logf
	hide(cmd)
	if err := cmd.Start(); err != nil {
		logf.Close()
		return "", err
	}
	dieWithUs(cmd)
	done := make(chan struct{})
	go func() {
		cmd.Wait()
		logf.Close()
		close(done)
	}()
	base := "http://127.0.0.1:" + strconv.Itoa(port)
	l.mu.Lock()
	l.cmd, l.done, l.base, l.model = cmd, done, base, model
	l.mu.Unlock()
	// готовность: /health отвечает 200, когда модель загружена (503 — ещё грузится)
	wait, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	for {
		req, _ := http.NewRequestWithContext(wait, "GET", base+"/health", nil)
		if resp, err := http.DefaultClient.Do(req); err == nil {
			resp.Body.Close()
			if resp.StatusCode == 200 {
				return base, nil
			}
		}
		select {
		case <-wait.Done():
			l.Stop()
			if errors.Is(wait.Err(), context.DeadlineExceeded) {
				return "", errT("llm.failed", "timeout")
			}
			return "", wait.Err()
		case <-done:
			l.Stop()
			return "", errT("llm.failed", logTail(llmLogPath(), 300))
		case <-time.After(250 * time.Millisecond):
		}
	}
}

// llmSystem: указания модели. Выводы сессии 2: без запрета шаблонных тегов Gemma дописывает «8k, masterpiece» даже
// логотипу, иногда меняет возраст и число объектов («котёнок» вместо «кот»), а размытый запрос додумывает сюжетом.
const llmSystem = `You write prompts for a text-to-image model (Stable Diffusion XL). The user gives a short request, possibly in Russian or another language.
Rewrite it as ONE detailed English image prompt of 40-70 words: the main subject first, then setting, composition, viewpoint, lighting, colors, mood.
Rules:
- Keep every fact from the request. Do not change the number, age, gender or kind of objects (a cat stays a cat, not a kitten).
- Do not add text, letters, captions or logos.
- Do not add generic tags like "8k", "masterpiece", "best quality", "trending on artstation".
- Describe only the subject, scene, composition, lighting and colors. Do not name an art style, medium, camera, lens or render type: the style is added separately, so the prompt must work with any style.
- Output only the prompt: no quotes, no explanations, no lists.`

type llmChatReq struct {
	Messages    []map[string]string `json:"messages"`
	Temperature float64             `json:"temperature"`
	MaxTokens   int                 `json:"max_tokens"`
}

var reLLMClean = regexp.MustCompile(`(?is)^\s*(?:prompt\s*:\s*)?["'«“]?(.*?)["'»”]?\s*$`)

// llmEnhance: развёрнутый английский промт из запроса человека
func llmEnhance(ctx context.Context, request, _ string) (string, error) {
	request = strings.TrimSpace(request)
	if request == "" {
		return "", errT("ai.noPrompt")
	}
	l := llmSrv
	l.busy.Lock()
	defer l.busy.Unlock()
	base, err := l.start(ctx)
	if err != nil {
		return "", err
	}
	body, _ := json.Marshal(llmChatReq{
		Messages:    []map[string]string{{"role": "system", "content": llmSystem}, {"role": "user", "content": request}},
		Temperature: 0.7, MaxTokens: 200,
	})
	cctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	req, _ := http.NewRequestWithContext(cctx, "POST", base+"/v1/chat/completions", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", errT("llm.failed", err.Error())
	}
	defer resp.Body.Close()
	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil || len(out.Choices) == 0 {
		return "", errT("llm.failed", fmt.Sprintf("HTTP %d", resp.StatusCode))
	}
	l.mu.Lock()
	if l.timer != nil {
		l.timer.Stop()
	}
	l.timer = time.AfterFunc(llmIdle, l.Stop)
	l.mu.Unlock()
	return llmClean(out.Choices[0].Message.Content), nil
}

// llmClean: без кавычек, «Prompt:» и переводов строк
func llmClean(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if m := reLLMClean.FindStringSubmatch(s); m != nil {
		s = m[1]
	}
	return strings.TrimSpace(s)
}
