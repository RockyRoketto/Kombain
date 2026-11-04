package main

// Аргументы ffmpeg: разбор исходника (probe), расчёт битрейта под размер (planRate), сборка командной строки (buildArgs).

import (
	"context"
	"fmt"
	"math"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

var durRe = regexp.MustCompile(`Duration: (\d+):(\d+):(\d+(?:\.\d+)?)`)
var numRe = regexp.MustCompile(`^\d+(\.\d+)?$`)

var alphaRe = regexp.MustCompile(`\b(yuva\w*|rgba\w*|argb|bgra|abgr|gbrap\w*|ya8|ya16\w*|pal8)\b`)

type srcInfo struct {
	dur   float64
	alpha bool
	w, h  int
	fps   float64
	audio bool
}

func probe(ctx context.Context, ffm, src string) srcInfo {
	cmd := exec.CommandContext(ctx, ffm, "-hide_banner", "-i", src)
	hide(cmd)
	out, _ := cmd.CombinedOutput()
	mi := parseMediaInfo(string(out))
	si := srcInfo{dur: mi.Dur, w: mi.W, h: mi.H, fps: mi.FPS, audio: mi.ACodec != ""}
	for _, line := range strings.Split(string(out), "\n") {
		if strings.Contains(line, "Stream #") && strings.Contains(line, "Video:") {
			si.alpha = alphaRe.MatchString(line)
			break
		}
	}
	return si
}

// скорость VP9: чем больше cpu-used, тем быстрее (по умолчанию libvpx жутко медленный)
var vp9Speed = map[string]string{"ultrafast": "5", "veryfast": "4", "fast": "3", "medium": "2", "slow": "1"}

// скорость AV1: libaom ещё медленнее, на малых значениях минуты превращаются в часы
var aomSpeed = map[string]string{"ultrafast": "8", "veryfast": "8", "fast": "7", "medium": "6", "slow": "5"}

// MPEG-1, MPEG-2 и MXF знают только телевизионные частоты кадров
func isStandardFPS(v float64) bool {
	for _, s := range []float64{24000.0 / 1001, 24, 25, 30000.0 / 1001, 30, 50, 60000.0 / 1001, 60} {
		if math.Abs(v-s) < 0.01 {
			return true
		}
	}
	return false
}

// Какой битрейт звука принимает кодек, кбит/с. Меньше минимума AC3 и Vorbis падают на многоканальном звуке.
var audioRateLimits = map[string][2]int{"ac3": {192, 640}, "eac3": {192, 640}, "libvorbis": {128, 480}}

// MP2 принимает только значения из стандарта
var mp2Rates = []int{64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384}

// fitCodecLimits подгоняет настройки из интерфейса к тому, что кодек вообще принимает
func fitCodecLimits(a []string) {
	value := func(key string) int {
		if i := slices.Index(a, key); i >= 0 && i+1 < len(a) {
			return i + 1
		}
		return -1
	}
	if c, b := value("-c:a"), value("-b:a"); c > 0 && b > 0 {
		if k, err := strconv.Atoi(strings.TrimSuffix(a[b], "k")); err == nil {
			if lim, ok := audioRateLimits[a[c]]; ok {
				k = min(max(k, lim[0]), lim[1])
			} else if a[c] == "mp2" {
				pick := mp2Rates[0]
				for _, r := range mp2Rates {
					if r <= k {
						pick = r
					}
				}
				k = pick
			}
			a[b] = strconv.Itoa(k) + "k"
		}
	}
	if c, q := value("-c:v"), value("-crf"); c > 0 && q > 0 && a[c] == "libvpx" { // у VP8 CRF от 4
		if v, err := strconv.Atoi(a[q]); err == nil && v < 4 {
			a[q] = "4"
		}
	}
}

func num(s string) string {
	s = strings.TrimSpace(s)
	if numRe.MatchString(s) {
		return s
	}
	return ""
}

// ---------- «уложить в N МБ»: два прохода с рассчитанным битрейтом ----------

type rate struct {
	vk, ak int    // битрейт видео и звука, кбит/с
	height string // уменьшенная высота, если битрейта мало для исходного разрешения
	pass   int    // 1 или 2
	dir    string // папка для журналов первого прохода
}

// planRate: битрейт, при котором видео длиной si.dur уложится в target байт
func planRate(target int64, si srcInfo, req StartReq) (rate, error) {
	if si.dur <= 0 {
		return rate{}, errT("rate.noDuration")
	}
	total := float64(target) * 8 / 1000 / si.dur * 0.96 // кбит/с, 4% — запас на контейнер
	ak := req.ABR
	if ak <= 0 {
		ak = 128
	}
	if lim := int(total * 0.12); ak > lim { // звуку — не больше 12% места
		ak = max(lim, 32)
	}
	vk := int(total)
	if si.audio {
		vk -= ak
	}
	if vk < 60 {
		need := (60 + float64(ak)) * 1000 / 8 * si.dur / 0.96 / (1 << 20)
		return rate{}, errT("rate.tooSmall", mbStr(float64(target)/(1<<20)), need+1)
	}
	r := rate{vk: vk, ak: ak, height: num(req.Height)}
	if r.height != "" || si.w <= 0 || si.h <= 0 {
		return r, nil
	}
	fps := si.fps
	if v, err := strconv.ParseFloat(num(req.FPS), 64); err == nil && v > 0 {
		fps = v
	}
	if fps <= 0 || fps > 120 {
		fps = 30
	}
	// мало бит на пиксель — картинка развалится на квадраты, лучше уменьшить разрешение
	short0 := min(si.w, si.h) // меньшая сторона: у вертикального видео это ширина
	cur := short0
	for _, s := range []int{1080, 720, 540, 480, 360} {
		k := float64(cur) / float64(short0)
		if float64(vk)*1000/(float64(si.w*si.h)*k*k*fps) >= 0.045 {
			break
		}
		if s < cur {
			cur = s
			r.height = strconv.Itoa(si.h * s / short0 / 2 * 2)
		}
	}
	return r, nil
}

func mbStr(mb float64) string {
	s := strconv.FormatFloat(mb, 'f', -1, 64)
	if currentLang() == langRU {
		s = strings.Replace(s, ".", ",", 1)
	}
	return s
}

// rateArgs: аргументы кодека с CRF → с битрейтом и номером прохода.
// В первом проходе звука и настоящего файла нет — убираем всё, что к ним относится.
func rateArgs(a []string, r *rate) []string {
	var out []string
	x265 := false
	for j := 0; j < len(a); j++ {
		k := a[j]
		switch k {
		case "-crf", "-b:v":
			j++
			continue
		case "-c:a", "-movflags", "-tag:v":
			if r.pass == 1 {
				j++
				continue
			}
		case "-b:a":
			j++
			if r.pass == 2 {
				out = append(out, k, strconv.Itoa(r.ak)+"k")
			}
			continue
		case "-c:v":
			x265 = j+1 < len(a) && a[j+1] == "libx265"
		}
		out = append(out, k)
	}
	out = append(out, "-b:v", strconv.Itoa(r.vk)+"k")
	if x265 { // у libx265 свои параметры; путь без «C:», он ломает x265-params — журнал лежит в рабочей папке
		out = append(out, "-x265-params", fmt.Sprintf("pass=%d:stats=x265.log", r.pass))
	} else {
		out = append(out, "-pass", strconv.Itoa(r.pass), "-passlogfile", filepath.Join(r.dir, "pass"))
	}
	if r.pass == 1 {
		out = append(out, "-an", "-f", "null")
	}
	return out
}

func buildArgs(f Format, req StartReq, src, dst string, si srcInfo, safe bool, rc *rate) []string {
	preset := req.Preset
	if !presets[preset] {
		preset = "medium"
	}
	rep := strings.NewReplacer("{crf}", strconv.Itoa(req.CRF), "{abr}", strconv.Itoa(req.ABR), "{preset}", preset)
	var fargs []string
	for _, a := range f.Args {
		fargs = append(fargs, rep.Replace(a))
	}
	h, fps := num(req.Height), num(req.FPS)
	if rc != nil && f.Kind == "video" {
		fargs = rateArgs(fargs, rc)
		h = rc.height
	}
	fitCodecLimits(fargs)
	if f.standardFPS() {
		want := si.fps
		if v, err := strconv.ParseFloat(fps, 64); err == nil {
			want = v
		}
		if want > 0 && !isStandardFPS(want) {
			fps = "25"
		}
	}

	args := []string{"-hide_banner", "-nostdin", "-loglevel", "error", "-progress", "pipe:1", "-nostats"}
	if req.Overwrite || (rc != nil && rc.pass == 1) {
		args = append(args, "-y")
	} else if fileExists(dst) && fileSize(dst) == 0 {
		args = append(args, "-y") // пустой огрызок от прошлой попытки
	} else {
		args = append(args, "-n")
	}
	if start, length, ok := req.trim(src); ok { // до -i: быстро и точно, при копировании потоков — по ключевым кадрам
		args = append(args, "-ss", strconv.FormatFloat(start, 'f', 3, 64), "-t", strconv.FormatFloat(length, 'f', 3, 64))
	}
	args = append(args, "-i", src)

	switch f.Kind {
	case "gif":
		if fps == "" {
			fps = "15"
		}
		if h == "" {
			h = "480"
		}
		fc := fmt.Sprintf("[0:v]fps=%s,scale=-1:%s:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse", fps, h)
		args = append(args, "-filter_complex", fc, "-loop", "0")
	case "image":
		args = append(args, "-frames:v", "1")
		var vf []string
		if h != "" {
			vf = append(vf, "scale=-1:"+h)
		}
		if f.Filter != "" {
			vf = append(vf, f.Filter)
		}
		if len(vf) > 0 {
			args = append(args, "-vf", strings.Join(vf, ","))
		}
		args = append(args, fargs...)
	case "anim":
		var vf []string
		if h != "" {
			vf = append(vf, "scale=-2:"+h)
		}
		if fps != "" {
			vf = append(vf, "fps="+fps)
		}
		if len(vf) > 0 {
			args = append(args, "-vf", strings.Join(vf, ","))
		}
		args = append(args, fargs...)
	case "video", "vfix", "pro":
		args = append(args, fargs...)
		switch f.codec() {
		case "libvpx-vp9", "libvpx":
			// 8 бит (profile 0): работает в любой сборке ffmpeg и в любом браузере.
			// 10-битные исходники (HDR с iPhone) иначе падают с "Invalid argument"
			pf := "yuv420p"
			if si.alpha {
				pf = "yuva420p"
			}
			args = append(args, "-pix_fmt", pf, "-deadline", "good", "-cpu-used", vp9Speed[preset])
			if f.codec() == "libvpx-vp9" {
				args = append(args, "-row-mt", "1")
			}
		case "libaom-av1":
			args = append(args, "-row-mt", "1", "-cpu-used", aomSpeed[preset])
		}
		if safe {
			// повтор: ровная частота кадров и стандартный формат пикселей
			args = append(args, "-fps_mode", "cfr", "-max_muxing_queue_size", "4096")
			if f.Ext != "webm" && f.Kind != "pro" {
				args = append(args, "-pix_fmt", "yuv420p")
			}
		}
		var vf []string
		if h != "" {
			vf = append(vf, "scale=-2:"+h)
		} else if f.Filter == "" && (si.w%2 != 0 || si.h%2 != 0) {
			vf = append(vf, "scale=trunc(iw/2)*2:trunc(ih/2)*2") // нечётный размер кадра многие кодеки не принимают
		}
		if fps != "" {
			vf = append(vf, "fps="+fps)
		}
		if f.Filter != "" {
			vf = append(vf, f.Filter)
		}
		if len(vf) > 0 {
			args = append(args, "-vf", strings.Join(vf, ","))
		}
	default:
		args = append(args, fargs...)
	}
	if e := strings.TrimSpace(req.Extra); e != "" {
		args = append(args, strings.Fields(e)...)
	}
	return append(args, dst)
}
