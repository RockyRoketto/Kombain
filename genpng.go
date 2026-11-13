package main

// Параметры генерации внутри PNG. Пишем два текстовых куска:
//   - "parameters" — как у A1111: его понимают Civitai, ComfyUI и почти все просмотрщики;
//   - "kombain" — наш GenMeta целиком в JSON: запрос как его написал человек, стиль, пропорция.
// Перетащил картинку обратно во вкладку — настройки восстановились (genRestoreFrom). Если .json рядом с
// картинкой потерялся, галерея всё равно знает, как её повторить.

import (
	"bytes"
	"compress/zlib"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"math"
	"regexp"
	"strconv"
	"strings"
)

var pngSig = []byte("\x89PNG\r\n\x1a\n")

func pngChunk(typ string, data []byte) []byte {
	out := make([]byte, 8, 12+len(data))
	binary.BigEndian.PutUint32(out, uint32(len(data)))
	copy(out[4:], typ)
	out = append(out, data...)
	return binary.BigEndian.AppendUint32(out, crc32.ChecksumIEEE(out[4:]))
}

// pngEach обходит куски PNG; fn получает тип, данные и сам кусок целиком. false из fn — стоп.
func pngEach(b []byte, fn func(typ string, data, raw []byte) bool) error {
	if !bytes.HasPrefix(b, pngSig) {
		return errors.New("not a PNG")
	}
	for i := len(pngSig); i+12 <= len(b); {
		n := int(binary.BigEndian.Uint32(b[i:]))
		if n < 0 || i+12+n > len(b) {
			return errors.New("broken PNG")
		}
		typ := string(b[i+4 : i+8])
		if !fn(typ, b[i+8:i+8+n], b[i:i+12+n]) || typ == "IEND" {
			return nil
		}
		i += 12 + n
	}
	return nil
}

// pngTextKey: ключ текстового куска (tEXt, zTXt, iTXt), иначе пусто
func pngTextKey(typ string, data []byte) string {
	if typ != "tEXt" && typ != "zTXt" && typ != "iTXt" {
		return ""
	}
	k, _, ok := bytes.Cut(data, []byte{0})
	if !ok {
		return ""
	}
	return string(k)
}

// pngWithText кладёт текстовые куски сразу после IHDR; прежние куски с теми же ключами убираются
// (sd-server пишет свой "parameters"). Только ASCII — tEXt, его читают все; иначе iTXt в UTF-8.
func pngWithText(b []byte, kv [][2]string) ([]byte, error) {
	keys := map[string]bool{}
	for _, p := range kv {
		keys[p[0]] = true
	}
	out := bytes.NewBuffer(make([]byte, 0, len(b)+4096))
	out.Write(pngSig)
	seenIHDR := false
	err := pngEach(b, func(typ string, data, raw []byte) bool {
		if keys[pngTextKey(typ, data)] {
			return true
		}
		out.Write(raw)
		if typ == "IHDR" && !seenIHDR {
			seenIHDR = true
			for _, p := range kv {
				out.Write(pngTextChunk(p[0], p[1]))
			}
		}
		return true
	})
	if err == nil && !seenIHDR {
		err = errors.New("broken PNG")
	}
	if err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func pngTextChunk(key, val string) []byte {
	ascii := true
	for i := 0; i < len(val); i++ {
		if val[i] >= 0x80 {
			ascii = false
			break
		}
	}
	if ascii {
		return pngChunk("tEXt", append([]byte(key+"\x00"), val...))
	}
	// ключ, 0, без сжатия, метод 0, язык "", 0, перевод ключа "", 0, текст
	return pngChunk("iTXt", append([]byte(key+"\x00\x00\x00\x00\x00"), val...))
}

// pngTexts: все текстовые куски PNG (ключ → текст)
func pngTexts(b []byte) (map[string]string, error) {
	out := map[string]string{}
	err := pngEach(b, func(typ string, data, _ []byte) bool {
		key := pngTextKey(typ, data)
		if key == "" {
			return true
		}
		rest := data[len(key)+1:]
		switch typ {
		case "tEXt":
			out[key] = latin1(rest)
		case "zTXt":
			if len(rest) > 1 {
				if s, err := inflate(rest[1:]); err == nil {
					out[key] = latin1(s)
				}
			}
		case "iTXt":
			if len(rest) < 2 {
				return true
			}
			comp := rest[0] == 1
			parts := bytes.SplitN(rest[2:], []byte{0}, 3) // язык, перевод ключа, текст
			if len(parts) < 3 {
				return true
			}
			txt := parts[2]
			if comp {
				var err error
				if txt, err = inflate(txt); err != nil {
					return true
				}
			}
			out[key] = string(txt)
		}
		return true
	})
	return out, err
}

func latin1(b []byte) string {
	r := make([]rune, len(b))
	for i, c := range b {
		r[i] = rune(c)
	}
	return string(r)
}

func inflate(b []byte) ([]byte, error) {
	zr, err := zlib.NewReader(bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	defer zr.Close()
	return io.ReadAll(io.LimitReader(zr, 1<<20))
}

// genA1111 — строка "parameters" в формате A1111
func genA1111(m GenMeta) string {
	p := m.Params
	var sb strings.Builder
	sb.WriteString(p.Prompt)
	if p.Negative != "" {
		sb.WriteString("\nNegative prompt: " + p.Negative)
	}
	f := []string{fmt.Sprintf("Steps: %d", p.Steps)}
	if p.Sampler != "" {
		f = append(f, "Sampler: "+a1111Val(p.Sampler))
	}
	if p.Scheduler != "" {
		f = append(f, "Schedule type: "+a1111Val(p.Scheduler))
	}
	f = append(f, "CFG scale: "+strconv.FormatFloat(p.CFG, 'f', -1, 64), fmt.Sprintf("Seed: %d", p.Seed), fmt.Sprintf("Size: %dx%d", p.Width, p.Height))
	if m.Model != "" {
		f = append(f, "Model: "+a1111Val(m.Model))
	}
	if p.Strength > 0 {
		f = append(f, "Denoising strength: "+strconv.FormatFloat(p.Strength, 'f', -1, 64))
	}
	if m.App != "" {
		f = append(f, "Version: "+a1111Val(m.App))
	}
	sb.WriteString("\n" + strings.Join(f, ", "))
	return sb.String()
}

func a1111Val(s string) string {
	if strings.ContainsAny(s, ",:\"\n") {
		return strconv.Quote(s)
	}
	return s
}

var a1111Field = regexp.MustCompile(`\s*([\w ][\w \-/]*):\s*("(?:\\.|[^\\"])*"|[^,]*)(?:,|$)`)

// genRestore: что вернуть в поля вкладки. Exact — картинка из Kombain: запрос как его написали и стиль известны.
type genRestore struct {
	Prompt   string  `json:"prompt"`
	Negative string  `json:"negative"`
	Preset   string  `json:"preset"`
	Ratio    string  `json:"ratio"`
	Model    string  `json:"model"`
	Steps    int     `json:"steps"` // 0 — как задумано моделью
	CFG      float64 `json:"cfg"`
	Seed     int64   `json:"seed"`
	Width    int     `json:"width"`
	Height   int     `json:"height"`
	Expanded string  `json:"expanded,omitempty"`
	Exact    bool    `json:"exact"`
}

// genParseA1111 разбирает чужую строку "parameters": запрос, негатив и строку настроек в конце
func genParseA1111(s string) (genRestore, bool) {
	s = strings.ReplaceAll(strings.TrimSpace(s), "\r\n", "\n")
	lines := strings.Split(s, "\n")
	last := len(lines) - 1
	fields := map[string]string{}
	if last >= 0 && strings.HasPrefix(lines[last], "Steps: ") {
		for _, m := range a1111Field.FindAllStringSubmatch(lines[last], -1) {
			v := strings.TrimSpace(m[2])
			if u, err := strconv.Unquote(v); err == nil && strings.HasPrefix(v, `"`) {
				v = u
			}
			fields[strings.TrimSpace(m[1])] = v
		}
		lines = lines[:last]
	}
	var pr, neg []string
	inNeg := false
	for _, l := range lines {
		if !inNeg && strings.HasPrefix(l, "Negative prompt:") {
			inNeg = true
			l = strings.TrimSpace(strings.TrimPrefix(l, "Negative prompt:"))
		}
		if inNeg {
			neg = append(neg, l)
		} else {
			pr = append(pr, l)
		}
	}
	r := genRestore{Prompt: strings.TrimSpace(strings.Join(pr, "\n")), Negative: strings.TrimSpace(strings.Join(neg, "\n")), Preset: "none"}
	if r.Prompt == "" {
		return r, false
	}
	r.Steps, _ = strconv.Atoi(fields["Steps"])
	r.CFG, _ = strconv.ParseFloat(fields["CFG scale"], 64)
	r.Seed, _ = strconv.ParseInt(fields["Seed"], 10, 64)
	if r.Seed < 0 {
		r.Seed = 0
	}
	fmt.Sscanf(fields["Size"], "%dx%d", &r.Width, &r.Height)
	r.Model = fields["Model"]
	r.Ratio = genNearestRatio(r.Width, r.Height)
	return r, true
}

// genNearestRatio: пропорция из списка вкладки, ближайшая к размеру
func genNearestRatio(w, h int) string {
	if w <= 0 || h <= 0 {
		return ""
	}
	best, bd := "", math.Inf(1)
	for _, q := range genRatios {
		var a, b float64
		if _, err := fmt.Sscanf(q, "%g:%g", &a, &b); err != nil || b == 0 {
			continue
		}
		if d := math.Abs(math.Log(a / b * float64(h) / float64(w))); d < bd {
			best, bd = q, d
		}
	}
	return best
}

// genRestoreMeta: из нашего GenMeta. Шаги и строгость — как просил человек (пусто = как у модели), зерно — точное.
func genRestoreMeta(m GenMeta) genRestore {
	p := m.Params
	r := genRestore{Prompt: p.Prompt, Negative: "", Preset: "none", Model: m.Model, Steps: p.Steps, CFG: p.CFG, Seed: p.Seed,
		Width: p.Width, Height: p.Height, Ratio: genNearestRatio(p.Width, p.Height)}
	if q := m.Request; q != nil {
		r.Prompt, r.Negative, r.Preset, r.Steps, r.CFG, r.Exact, r.Expanded = q.Prompt, q.Negative, q.Preset, q.Steps, q.CFG, true, q.Expanded
		if q.Ratio != "" && q.Init == "" {
			r.Ratio = q.Ratio
		}
	}
	return r
}

// genRestoreFrom: настройки картинки — из .json рядом, из куска "kombain" или из чужого "parameters"
func genRestoreFrom(png []byte, sidecar []byte) (genRestore, bool) {
	var m GenMeta
	if len(sidecar) > 0 && json.Unmarshal(sidecar, &m) == nil && m.Params.Prompt != "" {
		return genRestoreMeta(m), true
	}
	tx, _ := pngTexts(png)
	if s := tx["kombain"]; s != "" && json.Unmarshal([]byte(s), &m) == nil && m.Params.Prompt != "" {
		return genRestoreMeta(m), true
	}
	if s := tx["parameters"]; s != "" {
		return genParseA1111(s)
	}
	return genRestore{}, false
}
