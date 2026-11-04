package main

// Аргументы ffmpeg: разбор исходника (probe), расчёт битрейта под размер (planRate), сборка командной строки (buildArgs).

import (
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"regexp"
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

	args := []string{"-hide_banner", "-nostdin", "-loglevel", "error", "-progress", "pipe:1", "-nostats"}
	if req.Overwrite || (rc != nil && rc.pass == 1) {
		args = append(args, "-y")
	} else if fileExists(dst) && fileSize(dst) == 0 {
		args = append(args, "-y") // пустой огрызок от прошлой попытки
	} else {
		args = append(args, "-n")
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
		if h != "" {
			args = append(args, "-vf", "scale=-1:"+h)
		}
		args = append(args, fargs...)
	case "video":
		args = append(args, fargs...)
		if f.Ext == "webm" {
			// 8 бит (profile 0): работает в любой сборке ffmpeg и в любом браузере.
			// 10-битные исходники (HDR с iPhone) иначе падают с "Invalid argument"
			pf := "yuv420p"
			if si.alpha {
				pf = "yuva420p"
			}
			args = append(args, "-pix_fmt", pf, "-row-mt", "1", "-deadline", "good", "-cpu-used", vp9Speed[preset])
		}
		if safe {
			// повтор: ровная частота кадров и стандартный формат пикселей
			args = append(args, "-fps_mode", "cfr", "-max_muxing_queue_size", "4096")
			if f.Ext != "webm" {
				args = append(args, "-pix_fmt", "yuv420p")
			}
		}
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
	default:
		args = append(args, fargs...)
	}
	if e := strings.TrimSpace(req.Extra); e != "" {
		args = append(args, strings.Fields(e)...)
	}
	return append(args, dst)
}
