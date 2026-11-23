package main

// Помощник запросов во вкладке «Генератор» (пишет промт при каждом «Создать»): llama-server с маленькой текстовой моделью (Gemma 3 4B, каталог) переписывает
// короткий запрос на любом языке в подробный английский промт. Сервер запускается по требованию (старт 3–7 с,
// ответ ~1 с, замеры сессии 2) и гаснет после минуты простоя. На карте меньше 14 ГБ он берёт видеопамять через aiGPU
// и тем выгружает модель картинок; на большой карте они помещаются вместе.

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// llmIdle: столько сервер ждёт следующего запроса, прежде чем отдать память
var llmIdle = 60 * time.Second

type llmServer struct {
	mu    sync.Mutex
	cmd   *exec.Cmd
	done  chan struct{}
	base  string
	model string
	eyes  bool // запущен с проектором картинок (--mmproj)
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

// llmReady: помощник скачан и может писать промт
func llmReady() bool { return fileExists(llmExe()) && llmModelPath() != "" }

// llmEyesPath: проектор картинок («Глаза помощника»); пусто — помощник картинок не видит
func llmEyesPath() string {
	for _, m := range aiLoadInstalled().Models {
		if m.Kind == "llm" {
			for _, f := range m.Files {
				if f.Role == "mmproj" {
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

// llmEyesReady: помощник может описывать референсы
func llmEyesReady() bool { return llmReady() && llmEyesPath() != "" }

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
	l.cmd, l.done, l.base, l.model, l.eyes = nil, nil, "", "", false
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

// running: процесс помощника запущен (может ещё держать видеопамять)
func (l *llmServer) running() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.cmd != nil
}

// llmShareGPU: карте хватает места и на модель картинок, и на LLM (SDXL 10–11 ГБ на пике + 3–4 ГБ)
func llmShareGPU() bool { return hwVRAMTotal() >= 14*1024 }

// start поднимает сервер, если он не запущен. eyes: нужен проектор картинок; без нужды он не грузится
// (лишние ~0,9 ГБ видеопамяти), а уже запущенный с ним сервер годится и для обычных запросов.
func (l *llmServer) start(ctx context.Context, eyes bool) (string, error) {
	model := llmModelPath()
	if model == "" || !fileExists(llmExe()) {
		return "", errT("llm.notInstalled")
	}
	mmproj := ""
	if eyes {
		if mmproj = llmEyesPath(); mmproj == "" {
			return "", errT("llm.notInstalled")
		}
	}
	l.mu.Lock()
	if l.alive() && l.model == model && (l.eyes || !eyes) {
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
	args := []string{"-m", model, "--host", "127.0.0.1", "--port", strconv.Itoa(port), "-ngl", "99", "-c", "4096", "--no-webui"}
	if mmproj != "" {
		args = append(args, "--mmproj", mmproj)
	}
	cmd := exec.Command(llmExe(), args...)
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
	l.cmd, l.done, l.base, l.model, l.eyes = cmd, done, base, model, mmproj != ""
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
// 2026-11-20 (жалоба автора: «Seen from a low angle», камни и горы, стеклянное сердечко вместо жеста): короче, жесты буквально,
// простой фон без выдуманных пейзажей, подсказка «Variation:» не в начало, формат кадра от стиля строкой «Format:».
const llmSystem = `You write prompts for a text-to-image model. The user gives a short request, possibly in Russian or another language.
Rewrite it as ONE clear English image prompt of 25-70 words (a short simple request gets a short prompt). Start with the main subject and what it does, exactly as the request says (if the request is a landscape, a place or an atmosphere, start with the place itself). Then add only what helps to draw it: plain looks of the subject, a fitting background, light.
Rules:
- Keep every fact from the request. Do not change the number, age, gender or kind of objects (a cat stays a cat, not a kitten).
- Spend most words on the subject and the action from the request. Describe actions, gestures and poses literally and physically, what the body and hands do. Never turn a gesture into a separate object or symbol floating in the air. Never add a gesture, sign or symbol that the request does not name; if a reference shows a pose, keep that pose as it is.
- Describe people plainly and briefly (hair, clothes). Do not invent backstory, emotions, scars, "weathered" skin or a precise age the request does not give.
- BACKGROUND: if the request names no place, keep the background short, simple and neutral, one phrase at most. NEVER invent a place, scenery, weather or dramatic sky that the request does not mention.
- NEVER add a person, animal, vehicle, building or any other main object that the request does not mention. A request about a place, weather or mood has NO people and NO animals in it: describe only the empty place itself, with no one in it. Do not name a brand or car model unless the request does.
- If the request has several people, describe each one separately (left / center / right, clothing or uniform, pose, what they hold). Give them clearly different clothes and colors, never identical uniforms, unless the request says they are a team.
- Do not impose a color palette unless the request names colors.
- If the request names several objects, mention EVERY one of them, each once, as one composition (side by side or overlapping, with the main one in front); no object may be left out and none added.
- The user message may have a "Colors:" line with the real colors of a country's flag. When the request says "in the colors of" a country, or names a team or a country for an object, paint the object or its panels and stripes with exactly those colors. Draw the flag itself (with its stars or emblem) only if the request asks for a flag.
- The user message may have a "Flag:" line that says exactly how each country's flag looks. When the request asks for a flag, describe the flag the way that line says (stripes, colors, cross, emblem), nothing else.
- Only if the request pits two teams or countries against each other ("A vs B", a match between A and B; NOT a list of different objects), give each side its own object of equal size: the first on the left, the second on the right, with an empty gap between them in the middle.
- COUNT: an object without a number in the request is exactly ONE. Russian nouns in the genitive are still one each. "3D" (Russian "3д") is a look, not a number: never turn it into "three" or "3" objects.
- Take every word in its most common everyday meaning for the language it is written in, and describe each object by its standard real-world shape and the features that make it recognizable (for example its form, parts, pattern and proportions), so the model cannot confuse it with a similar object. Never swap an object for a different one.
- Do not add text, letters, captions or logos.
- Do not add generic tags like "8k", "masterpiece", "best quality", "trending on artstation".
- Describe only the subject, scene, composition, lighting and colors. Do not name an art style, medium, camera, lens or render type: the style is added separately, so the prompt must work with any style.
- The user message may have a "Format:" line: what this kind of picture needs (for example one object on a plain background). Follow it over the background rule, but never name the style itself.
- The user message may have a "Variation:" line: a framing and a light to make this picture a bit different. Use them quietly, in your own words, in the middle or end of the prompt. Never start the prompt with the framing, never write "Seen from", never repeat the "Variation:" line. Use its light only if the request does not set the time of day or weather and the "Format:" line does not forbid lighting. It never adds objects, places or backgrounds.
- Output only the prompt: no quotes, no explanations, no lists.
- The user message may have a "References:" block: images the user attached, already described in words. "@N" in the request means reference N: write what that reference shows instead, never the "@N" itself.
- A "character" reference: put that same character into the scene of the request with the looks from its description (kind, age, face, hair, body, clothes and their colors). The request decides the pose, action and place.
- A "base" reference: the picture is drawn over that image. Keep its composition, main objects and colors and change only what the request asks.
- "follow closely" means keep almost every detail of the reference, "follow loosely" keep its main features, "light hint" borrow only a little.`

// llmSystemObject: указания для стилей «один предмет» (GenPreset.Object: стикер, значок, 3D-иконка). Замер 2026-11-20 на Gemma 4B:
// с общими указаниями и строкой «Format: no background» она всё равно ставила апельсин «на серую поверхность в утреннем свете»,
// фон спорил с белым фоном стиля. Короткие указания без слова о сцене она держит.
const llmSystemObject = `You write prompts for a text-to-image model. The picture shows only what the request names, nothing else; the background, lighting and art style are added separately.
The user gives a short request, possibly in Russian or another language. Translate it into ONE short English description of only that subject, 10-35 words (up to 55 if the request names several objects): what it is, its shape, colors, the parts that are visible from outside, its pose or action if it is a character.
Rules:
- Keep every fact from the request: the number, kind, age and gender stay the same. Add no other objects, no people and no hands: an object lies alone, nobody holds it.
- If the request names several objects, mention EVERY one of them, each once, as one group floating close together or overlapping (no object may be left out, none added), and give each its own color.
- The user message may have a "Colors:" line with the real colors of a country's flag. When the request says "in the colors of" a country, or names a team or a country for an object, paint the object or its panels and stripes with exactly those colors. Draw the flag itself (with its stars or emblem) only if the request asks for a flag.
- The user message may have a "Flag:" line that says exactly how each country's flag looks. When the request asks for a flag, describe the flag the way that line says (stripes, colors, cross, emblem), nothing else.
- Only if the request pits two teams or countries against each other ("A vs B", a match between A and B; NOT a list of different objects), give each side its own object of equal size: the first on the left, the second on the right, with an empty gap between them in the middle.
- COUNT: an object without a number in the request is exactly ONE. Russian nouns in the genitive are still one each. "3D" (Russian "3д") is a look, not a number: never turn it into "three" or "3" objects.
- Take every word in its most common everyday meaning for the language it is written in, and describe each object by its standard real-world shape and the features that make it recognizable (form, parts, pattern, proportions), so the model cannot confuse it with a similar object. Never swap an object for a different one.
- Only if the subject is a person or an animal doing something: describe the gesture literally, what the body does, never as a separate symbol. Do not invent an age.
- Never mention a background, table, surface, ground, scene, shadow, light, camera, art style or medium.
- No quotes, no lists, no explanations, no tags like "8k" or "masterpiece". Output only the description.
- A "References:" block describes images the user attached. "@N" means reference N: write what it shows instead of "@N". A "character" reference gives the looks of the subject.`

// llmLook: что спросить у помощника про картинку-референс каждой роли
var llmLook = map[string]string{
	"style":     "Describe only the visual style of this image so another picture can be made in the same style: medium, technique, color palette, lighting, texture, mood. Do not describe the objects or the scene. One line of 25-50 English words, no lists.",
	"character": "Describe the main character of this image (person, animal, creature or mascot) so it can be drawn again in another scene: kind, age, gender if visible, face, hair, body, clothes and their colors, distinctive features. Do not describe the background, the pose or the art style. One line of 30-60 English words, no lists.",
	"base":      "Describe what this image shows: main objects, where they are in the frame, setting and main colors. One line of 30-60 English words, no lists.",
}

const llmHasChar = "Is there a person, an animal, a creature or a mascot clearly visible in this image? Answer only yes or no."

// llmLooks: описания референсов, чтобы одну картинку не описывать при каждом «Создать» (ключ: id|роль)
var llmLooks = struct {
	sync.Mutex
	m map[string]string
}{m: map[string]string{}}

// llmCloseness: «насколько похоже» словами для помощника
func llmCloseness(w float64) string {
	switch {
	case w >= 0.67:
		return "follow closely"
	case w >= 0.34:
		return "follow loosely"
	}
	return "light hint"
}

// llmImgChar: вместо описания «Персонажа», которого модель берёт картинкой (FLUX.2 klein). Внешность словами
// спорила с картинкой: на запрос «мужик показывает сердечко» помощник дописывал причёску, щетину и рубашку,
// и klein рисовала другого человека (ручной замер 2026-11-20: без слов то же лицо и жилет, со словами чужое лицо).
const llmImgChar = "the same person as in the picture. The drawing model gets the picture itself, so never describe his or her face, hair, age, build or clothes: write only the pose, action and place."

// llmRefBlock: блок «References:» для помощника. desc[i] — описание refs[i]; без описания референс пропускается.
// Номер @N — место в списке, как на плитках. Замеры 2026-11-13 на Gemma 4B: предложение о стиле она в промт
// не дописывает, а персонажа, на которого запрос не ссылается через @N, теряет даже с прямым указанием
// и исключением из правила «не добавляй животных». Поэтому сюда идут только основа и персонажи из запроса,
// а стиль и остальных персонажей дописывает llmTail.
func llmRefBlock(request string, refs []GenRef, desc []string) string {
	var b strings.Builder
	for i, r := range refs {
		if i >= len(desc) || desc[i] == "" || r.Role == "style" || r.Role == "character" && !llmMentions(request, i+1) {
			continue
		}
		if b.Len() == 0 {
			b.WriteString("References:")
		}
		fmt.Fprintf(&b, "\n@%d %s, %s: %s", i+1, r.Role, llmCloseness(r.Weight), desc[i])
	}
	return b.String()
}

// llmMentions: в запросе есть ссылка @n (и не начало @12 при n = 1)
func llmMentions(request string, n int) bool {
	tag := "@" + strconv.Itoa(n)
	for s := request; ; {
		i := strings.Index(s, tag)
		if i < 0 {
			return false
		}
		s = s[i+len(tag):]
		if s == "" || s[0] < '0' || s[0] > '9' {
			return true
		}
	}
}

// llmTail: что дописываем к промту сами: персонажей, на которых запрос не ссылается (mention — ссылка есть,
// помощник уже вплёл), и стили. «Лёгкий намёк» — только первая фраза описания.
func llmTail(refs []GenRef, desc []string, mention func(n int) bool) string {
	var chars, styles []string
	for i, r := range refs {
		if i >= len(desc) || desc[i] == "" || r.Role == "character" && r.Img {
			continue
		}
		d := strings.TrimRight(desc[i], ". ")
		if r.Weight < 0.34 {
			if k := strings.Index(d, ". "); k > 0 {
				d = d[:k]
			}
		}
		switch {
		case r.Role == "character" && !mention(i+1):
			chars = append(chars, d+".")
		case r.Role == "style":
			styles = append(styles, d)
		}
	}
	out := strings.Join(chars, " ")
	if len(styles) > 0 {
		out = strings.TrimSpace(out + " Style: " + strings.Join(styles, ". ") + ".")
	}
	return out
}

// llmDescribe: описания референсов словами (помощник должен быть запущен с глазами). Порядок как у refs.
func (l *llmServer) llmDescribe(ctx context.Context, base string, refs []GenRef) ([]string, error) {
	out := make([]string, len(refs))
	for i, r := range refs {
		key := r.ID + "|" + r.Role
		llmLooks.Lock()
		d, ok := llmLooks.m[key]
		llmLooks.Unlock()
		if !ok {
			png, err := genRefRead(r.ID, llmLookSide)
			if err != nil {
				return nil, err
			}
			// Gemma 4B на просьбу описать персонажа выдумывает его и там, где его нет (пейзаж — «девушка в тумане»),
			// а на прямой вопрос «есть ли» отвечает верно (замер 2026-11-13). Нет персонажа — пустое описание.
			seen := true
			if r.Role == "character" {
				yes, err := l.look(ctx, base, llmHasChar, png, 0, 3)
				if err != nil {
					return nil, err
				}
				seen = !strings.HasPrefix(strings.ToLower(yes), "no")
			}
			if seen {
				if d, err = l.look(ctx, base, llmLook[r.Role], png, 0.2, 160); err != nil {
					return nil, err
				}
			}
			llmLooks.Lock()
			llmLooks.m[key] = d
			llmLooks.Unlock()
		}
		out[i] = d
	}
	return out, nil
}

// llmLookSide: до какой стороны уменьшать картинку для помощника (проектор Gemma 3 всё равно видит 896×896)
const llmLookSide = 896

// Разнообразие при повторном «Создать» (турбо-модели почти не меняют композицию от зерна, поэтому меняем сам промт):
// к запросу дописывается случайная пара «кадр + свет». Новых объектов они не добавляют, свет — только если запрос его не задал.
// Жалоба автора 2026-11-20: «low angle from near the ground» и «wide shot from far away» каждый раз давали «Seen from a low
// angle» в начале промта, землю, камни и горы вокруг. Поэтому здесь только спокойные кадры, а в начало промта они не идут.
var llmViews = []string{
	"medium shot",
	"closer framing",
	"front view",
	"three-quarter view",
	"slightly off-center framing",
	"slightly from above",
}

var llmLights = []string{
	"soft diffused light",
	"warm daylight",
	"cool morning light",
	"soft window light",
	"bright even light",
	"gentle side light",
}

// llmVariations: n разных подсказок для одной пачки картинок. framed — кадр задаёт сам стиль (Framed: один предмет на фоне,
// вид сверху), меняется только свет.
func llmVariations(n int, framed bool) []string {
	views, lights := rand.Perm(len(llmViews)), rand.Perm(len(llmLights))
	out := make([]string, n)
	for i := range out {
		l := llmLights[lights[i%len(lights)]]
		if framed {
			out[i] = "Variation: " + l + "."
		} else {
			out[i] = fmt.Sprintf("Variation: %s, %s.", llmViews[views[i%len(views)]], l)
		}
	}
	return out
}

type llmChatReq struct {
	Messages    []map[string]any `json:"messages"`
	Temperature float64          `json:"temperature"`
	MaxTokens   int              `json:"max_tokens"`
	Seed        int64            `json:"seed"`
}

var reLLMClean = regexp.MustCompile(`(?is)^\s*(?:prompt\s*:\s*)?["'«“]?(.*?)["'»”]?\s*$`)

// llmEnhance: n развёрнутых английских промтов из запроса человека, у каждого своя подсказка разнообразия
// (картинки одной пачки и повторные «Создать» выходят разными). refs — референсы: помощник (если у него
// есть глаза) описывает их словами и вплетает в промт. own — «Писать промт самому»: запрос не переписывается,
// к нему только дописываются описания персонажа и стиля. noChar — id референсов «Персонаж», на которых персонажа не нашлось.
// preset — выбранный стиль: его строка «Format:» говорит помощнику, какой кадр нужен (у 3D-иконки — один предмет без сцены).
// part — промт для части готовой картинки (перерисовать часть, дорисовать за краями): без подсказки разнообразия
// и без «Format:». Иначе в новую полосу просились «крупный план» и «один предмет по центру на пустом фоне»,
// и модель рисовала там второго героя или другой свет.
func llmEnhance(ctx context.Context, request, preset string, n int, refs []GenRef, own, part bool) (prompts, noChar []string, err error) {
	request = strings.TrimSpace(request)
	if request == "" {
		return nil, nil, errT("ai.noPrompt")
	}
	n = min(max(n, 1), 16)
	if own { // своему промту описание основы не нужно: она и так в картинке
		refs = slices.DeleteFunc(slices.Clone(refs), func(r GenRef) bool { return r.Role == "base" })
	}
	eyes := len(refs) > 0 && llmEyesPath() != ""
	if own && !eyes {
		return []string{request}, nil, nil
	}
	l := llmSrv
	l.busy.Lock()
	defer l.busy.Unlock()
	base, err := l.start(ctx, eyes)
	if err != nil {
		return nil, nil, err
	}
	block := ""
	var desc []string
	if eyes {
		if desc, err = l.llmDescribe(ctx, base, refs); err != nil {
			return nil, nil, err
		}
		for i, r := range refs {
			if r.Role == "character" && desc[i] == "" {
				noChar = append(noChar, r.ID)
			}
			if r.Role == "character" && r.Img && desc[i] != "" {
				desc[i] = llmImgChar
			}
		}
		block = llmRefBlock(request, refs, desc)
	}
	if own { // свой промт: помощник его не трогает, описания персонажей и стиля дописываются в конец
		return []string{llmJoin(request, llmTail(refs, desc, func(int) bool { return false }))}, noChar, nil
	}
	mention := func(n int) bool { return llmMentions(request, n) }
	out := make([]string, 0, n)
	pre := genPreset(preset)
	sys := llmSystem
	if pre.Object && !part {
		sys = llmSystemObject
	}
	imgChar := slices.ContainsFunc(refs, func(r GenRef) bool { return r.Role == "character" && r.Img })
	if imgChar {
		// Gemma 4B из блока «References» это правило не слушалась: дописывала «blue denim shirt» (2026-11-20)
		sys += "\n- The person's looks come from a picture the drawing model sees. NEVER write his or her hair, beard, age, build, skin or clothes, not even one word like \"shirt\" or \"short hair\". Write only the pose, action, expression, place and light."
	}
	for _, v := range llmVariations(n, pre.Framed) {
		user := request + "\n\n" + v
		if part || pre.Object { // стикер, значок, 3D-иконка: кадр, свет и фон задаёт стиль, подсказка только мешает
			user = request
		} else if pre.Format != "" {
			user += "\nFormat: " + pre.Format
		}
		if h := countryColorsHint(request); h != "" {
			user += "\n" + h
		}
		if block != "" {
			user += "\n\n" + block
		}
		p, err := l.ask(ctx, base, sys, user)
		if err != nil {
			return nil, nil, err
		}
		if imgChar {
			p = llmStripLooks(p)
		}
		out = append(out, llmJoin(p, llmTail(refs, desc, mention)))
	}
	return out, noChar, nil
}

// llmJoin: промт и дописанный хвост через точку
func llmJoin(p, tail string) string {
	if tail == "" {
		return p
	}
	return strings.TrimRight(p, ". ") + ". " + tail
}

// ask: один промт от помощника по указаниям sys
func (l *llmServer) ask(ctx context.Context, base, sys, user string) (string, error) {
	s, err := l.chat(ctx, base, []map[string]any{{"role": "system", "content": sys}, {"role": "user", "content": user}}, 0.9, 260)
	return llmClean(s), err
}

// look: помощник описывает картинку (нужен сервер с глазами)
func (l *llmServer) look(ctx context.Context, base, ask string, png []byte, temp float64, maxTok int) (string, error) {
	content := []map[string]any{
		{"type": "text", "text": ask},
		{"type": "image_url", "image_url": map[string]string{"url": "data:image/png;base64," + base64.StdEncoding.EncodeToString(png)}},
	}
	s, err := l.chat(ctx, base, []map[string]any{{"role": "user", "content": content}}, temp, maxTok)
	return strings.Join(strings.Fields(strings.Trim(s, "\"' \n")), " "), err
}

// idle: сервер погаснет после минуты простоя
func (l *llmServer) idle() {
	l.mu.Lock()
	if l.timer != nil {
		l.timer.Stop()
	}
	l.timer = time.AfterFunc(llmIdle, l.Stop)
	l.mu.Unlock()
}

// chat: один ответ модели как есть
func (l *llmServer) chat(ctx context.Context, base string, msgs []map[string]any, temp float64, maxTok int) (string, error) {
	body, _ := json.Marshal(llmChatReq{Messages: msgs, Temperature: temp, MaxTokens: maxTok, Seed: rand.Int64N(1 << 31)})
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
	l.idle()
	return out.Choices[0].Message.Content, nil
}

// llmClean: без кавычек, «Prompt:», переводов строк и повтора подсказок «Variation:»/«Format:» (Gemma иногда дописывает их в конец)
func llmClean(s string) string {
	for _, tag := range []string{"Variation:", "Format:", "Camera:"} {
		if i := strings.Index(s, tag); i > 0 {
			s = s[:i]
		}
	}
	s = strings.Join(strings.Fields(s), " ")
	if m := reLLMClean.FindStringSubmatch(s); m != nil {
		s = m[1]
	}
	return strings.TrimSpace(s)
}

// Внешность «Персонажа», которого модель берёт картинкой (klein), в промте только мешает: Gemma 4B всё равно
// дописывает «blue shirt», «short brown hair» (запрет в инструкции не слушает), и одежда с картинки заменяется
// на выдуманную (жалоба автора 2026-11-20). Поэтому такие слова вырезаются из готового промта.
const llmLookWords = `hair|hairstyle|beard|stubble|mustache|shirt|t-shirt|tee|jacket|vest|waistcoat|suit|coat|sweater|hoodie|tie|dress|blouse|clothes|clothing|outfit`

var (
	llmLookClause = regexp.MustCompile(`(?i)\s+(?:with|wearing|dressed in)\s+(?:(?:an?|the|his|her|their)\s+)?(?:[\w-]+\s+){0,3}(?:` + llmLookWords + `)\b(?:\s+and\s+(?:(?:an?|the|his|her)\s+)?(?:[\w-]+\s+){0,3}(?:` + llmLookWords + `)\b)*`)
	llmLookSent   = regexp.MustCompile(`(?i)\b(?:wears?|wearing|dressed|` + llmLookWords + `)\b`)
)

// llmStripLooks: убирает из промта описание внешности (причёска, борода, одежда): и оборот «with short hair and a
// shirt», и целые предложения «He wears a blue shirt.»
func llmStripLooks(p string) string {
	p = llmLookClause.ReplaceAllString(p, "")
	var keep []string
	for _, s := range strings.SplitAfter(p, ". ") {
		if !llmLookSent.MatchString(s) {
			keep = append(keep, s)
		}
	}
	if len(keep) == 0 {
		return p
	}
	return strings.TrimSpace(strings.Join(keep, ""))
}
