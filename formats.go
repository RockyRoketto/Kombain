package main

// Форматы вывода: аргументы ffmpeg по каждому формату, выбор формата в режиме «Сжать», список медиа-расширений.
// Здесь только то, что умеет сборка ffmpeg, которую программа скачивает сама (essentials с gyan.dev).

import (
	"path/filepath"
	"slices"
	"strings"
)

// Что можно настроить, зависит от Kind (поля с data-k в index.html):
//
//	video  — CRF, скорость, лимит в МБ, битрейт звука, высота, FPS
//	vfix   — качество задано в аргументах: битрейт звука, высота, FPS
//	pro    — для монтажа, звук без сжатия: высота, FPS
//	anim   — анимация без звука: высота, FPS
//	gif    — то же, но со своей палитрой и значениями по умолчанию
//	image  — один кадр: высота
//	audio  — битрейт звука
//	fixed  — настраивать нечего, всё определяет сам формат
//	copy   — дорожки копируются как есть
type Format struct {
	Ext    string
	Kind   string
	Args   []string
	Filter string // фильтр, без которого кодек не примет кадр; идёт после масштаба из настроек
}

// fm: аргументы пишутся одной строкой через пробел
func fm(ext, kind, args string) Format {
	return Format{Ext: ext, Kind: kind, Args: strings.Fields(args)}
}

func (f Format) vf(filter string) Format {
	f.Filter = filter
	return f
}

// moving: обычное видео, для него работают масштаб, FPS и повтор с ровной частотой кадров
func (f Format) moving() bool {
	return f.Kind == "video" || f.Kind == "vfix" || f.Kind == "pro"
}

// standardFPS: кодек или контейнер принимает только телевизионные частоты кадров
func (f Format) standardFPS() bool {
	return f.Ext == "mxf" || f.codec() == "mpeg1video" || f.codec() == "mpeg2video"
}

// codec: чем кодируется видео
func (f Format) codec() string {
	if i := slices.Index(f.Args, "-c:v"); i >= 0 && i+1 < len(f.Args) {
		return f.Args[i+1]
	}
	return ""
}

const (
	x264  = "-c:v libx264 -preset {preset} -crf {crf} -pix_fmt yuv420p "
	x265  = "-c:v libx265 -preset {preset} -crf {crf} -pix_fmt yuv420p "
	aom   = "-c:v libaom-av1 -crf {crf} -b:v 0 -pix_fmt yuv420p "
	aacA  = "-c:a aac -b:a {abr}k"
	fast  = " -movflags +faststart"
	pcmA  = " -c:a pcm_s16le"
	pcm48 = " -c:a pcm_s16le -ar 48000" // MXF принимает звук только в 48 кГц
)

var formats = map[string]Format{
	// Видео
	"mp4":     fm("mp4", "video", x264+aacA+fast),
	"mp4h265": fm("mp4", "video", x265+"-tag:v hvc1 "+aacA+fast),
	"mp4av1":  fm("mp4", "video", aom+aacA+fast),
	"webm":    fm("webm", "video", "-c:v libvpx-vp9 -crf {crf} -b:v 0 -c:a libopus -b:a {abr}k"),
	"webmvp8": fm("webm", "video", "-c:v libvpx -crf {crf} -b:v 20M -c:a libvorbis -b:a {abr}k"),
	"webmav1": fm("webm", "video", aom+"-c:a libopus -b:a {abr}k"),
	"mov":     fm("mov", "video", x264+aacA),
	"mov265":  fm("mov", "video", x265+"-tag:v hvc1 "+aacA),
	"mkv":     fm("mkv", "copy", "-c copy"),
	"mkv264":  fm("mkv", "video", x264+aacA),
	"mkv265":  fm("mkv", "video", x265+aacA),
	"m4v":     fm("m4v", "video", x264+aacA),
	"avi264":  fm("avi", "video", x264+"-c:a libmp3lame -b:a {abr}k"),
	"avixvid": fm("avi", "vfix", "-c:v libxvid -q:v 3 -pix_fmt yuv420p -c:a libmp3lame -b:a {abr}k"),
	"wmv":     fm("wmv", "vfix", "-c:v wmv2 -q:v 3 -c:a wmav2 -b:a {abr}k -ac 2"),
	"flv":     fm("flv", "video", x264+aacA),
	"mpg1":    fm("mpg", "vfix", "-c:v mpeg1video -q:v 3 -c:a mp2 -b:a {abr}k -ar 44100 -ac 2"),
	"mpg2":    fm("mpg", "vfix", "-c:v mpeg2video -q:v 3 -c:a mp2 -b:a {abr}k -ar 44100 -ac 2"),
	"vob":     fm("vob", "vfix", "-c:v mpeg2video -q:v 3 -c:a ac3 -b:a {abr}k -ar 48000"),
	"ts":      fm("ts", "video", x264+aacA),
	"m2ts":    fm("m2ts", "video", x264+"-c:a ac3 -b:a {abr}k"),
	"3gp":     fm("3gp", "video", x264+aacA),
	"ogv":     fm("ogv", "vfix", "-c:v libtheora -q:v 7 -c:a libvorbis -b:a {abr}k"),

	// Для монтажа
	"prores422":  fm("mov", "pro", "-c:v prores_ks -profile:v 2 -pix_fmt yuv422p10le"+pcmA),
	"prores4444": fm("mov", "pro", "-c:v prores_ks -profile:v 4 -pix_fmt yuva444p10le"+pcmA),
	"dnxhr":      fm("mov", "pro", "-c:v dnxhd -profile:v dnxhr_hq -pix_fmt yuv422p"+pcmA),
	"dnxhrmxf":   fm("mxf", "pro", "-c:v dnxhd -profile:v dnxhr_hq -pix_fmt yuv422p"+pcm48),
	"mxf":        fm("mxf", "pro", "-c:v mpeg2video -q:v 3"+pcm48),
	"cineform":   fm("mov", "pro", "-c:v cfhd -quality 3"+pcmA).vf("scale=trunc(iw/16)*16:trunc(ih/8)*8"),
	"ffv1":       fm("mkv", "pro", "-c:v ffv1 -level 3 -c:a flac"),
	"utvideo":    fm("avi", "pro", "-c:v utvideo"+pcmA),
	"huffyuv":    fm("avi", "pro", "-c:v huffyuv"+pcmA),
	"qtrle":      fm("mov", "pro", "-c:v qtrle"+pcmA),
	"x264ll":     fm("mkv", "pro", "-c:v libx264 -qp 0 -preset ultrafast -c:a flac"),
	"mjpeg":      fm("avi", "pro", "-c:v mjpeg -q:v 3 -pix_fmt yuvj420p"+pcmA),

	// Картинки
	"png":  fm("png", "image", ""),
	"jpg":  fm("jpg", "image", "-q:v 2"),
	"webp": fm("webp", "image", "-quality 85"),
	"avif": fm("avif", "image", "-c:v libaom-av1 -crf 30 -still-picture 1 -pix_fmt yuv420p -an"),
	"tiff": fm("tiff", "image", "-c:v tiff -compression_algo lzw"),
	"bmp":  fm("bmp", "image", "-c:v bmp"),
	"tga":  fm("tga", "image", "-c:v targa"),
	"jp2":  fm("jp2", "image", "-c:v libopenjpeg"),
	"ico":  fm("ico", "image", "").vf("scale='min(256,iw)':'min(256,ih)':force_original_aspect_ratio=decrease"),
	"dpx":  fm("dpx", "image", "-c:v dpx"),
	"exr":  fm("exr", "image", "-c:v exr -pix_fmt gbrpf32le"),
	"hdr":  fm("hdr", "image", "-c:v hdr"),
	"qoi":  fm("qoi", "image", "-c:v qoi"),

	// Анимация
	"gif":      fm("gif", "gif", ""),
	"apng":     fm("apng", "anim", "-c:v apng -plays 0 -an -f apng"),
	"animwebp": fm("webp", "anim", "-c:v libwebp_anim -loop 0 -quality 80 -an"),
	"animavif": fm("avif", "anim", "-c:v libaom-av1 -crf 30 -cpu-used 6 -row-mt 1 -pix_fmt yuv420p -an"),

	// Звук со сжатием
	"mp3":    fm("mp3", "audio", "-vn -c:a libmp3lame -b:a {abr}k"),
	"m4a":    fm("m4a", "audio", "-vn -c:a aac -b:a {abr}k"),
	"aac":    fm("aac", "audio", "-vn -c:a aac -b:a {abr}k"),
	"ogg":    fm("ogg", "audio", "-vn -c:a libopus -b:a {abr}k"),
	"opus":   fm("opus", "audio", "-vn -c:a libopus -b:a {abr}k"),
	"vorbis": fm("ogg", "audio", "-vn -c:a libvorbis -b:a {abr}k"),
	"wma":    fm("wma", "audio", "-vn -c:a wmav2 -b:a {abr}k -ac 2"),
	"ac3":    fm("ac3", "audio", "-vn -c:a ac3 -b:a {abr}k"),
	"eac3":   fm("eac3", "audio", "-vn -c:a eac3 -b:a {abr}k"),
	"mp2":    fm("mp2", "audio", "-vn -c:a mp2 -b:a {abr}k -ar 44100 -ac 2"),
	"dts":    fm("dts", "fixed", "-vn -c:a dca -strict -2 -ar 48000 -b:a 768k"),
	"amr":    fm("amr", "fixed", "-vn -c:a libopencore_amrnb -ar 8000 -ac 1 -b:a 12.2k"),

	// Звук без потерь
	"wav":  fm("wav", "fixed", "-vn -c:a pcm_s16le"),
	"flac": fm("flac", "fixed", "-vn -c:a flac"),
	"alac": fm("m4a", "fixed", "-vn -c:a alac"),
	"aiff": fm("aiff", "fixed", "-vn -c:a pcm_s16be"),
	"wv":   fm("wv", "fixed", "-vn -c:a wavpack"),
	"tta":  fm("tta", "fixed", "-vn -c:a tta"),
	"mka":  fm("mka", "fixed", "-vn -c:a flac"),
	"caf":  fm("caf", "fixed", "-vn -c:a alac"),
	"w64":  fm("w64", "fixed", "-vn -c:a pcm_s24le"),

	// Редкие (в окне свёрнуты под «Ещё»)
	"dv":  fm("dv", "fixed", "-vf scale=720:576,fps=25,setsar=16/15 -c:v dvvideo -pix_fmt yuv420p -c:a pcm_s16le -ar 48000 -ac 2"),
	"nut": fm("nut", "video", x264+aacA),
	"3g2": fm("3g2", "video", x264+aacA),
	"asf": fm("asf", "vfix", "-c:v wmv2 -q:v 3 -c:a wmav2 -b:a {abr}k -ac 2"),
	"swf": fm("swf", "vfix", "-c:v flv -q:v 4 -c:a libmp3lame -ar 44100 -b:a {abr}k"),
	"rm":  fm("rm", "vfix", "-c:v rv20 -q:v 4 -c:a ac3 -b:a {abr}k").vf("scale=trunc(iw/4)*4:trunc(ih/4)*4"),
	"ppm": fm("ppm", "image", "-c:v ppm"),
	"pam": fm("pam", "image", "-c:v pam"),
	"pcx": fm("pcx", "image", "-c:v pcx"),
	"sgi": fm("sgi", "image", "-c:v sgi"),
	"ras": fm("ras", "image", "-c:v sunrast"),
	"xbm": fm("xbm", "image", "-c:v xbm"),
	"xwd": fm("xwd", "image", "-c:v xwd"),
	"au":  fm("au", "fixed", "-vn -c:a pcm_s16be"),
	"voc": fm("voc", "fixed", "-vn -c:a pcm_u8"),
	"gsm": fm("gsm", "fixed", "-vn -c:a libgsm -ar 8000 -ac 1"),
	"spx": fm("spx", "fixed", "-vn -c:a libspeex -ar 16000 -ac 1"),
	"mmf": fm("mmf", "fixed", "-vn -c:a adpcm_yamaha -ar 8000 -ac 1"),

	"small": {Kind: "compress"}, // «Сжать»: формат выбирается по исходнику, см. compressFormat
}

// compressFormat: во что сжимать файл в режиме «Сжать». Видео → MP4, картинки и звук — в свой же формат
// (звук без своего сжатого варианта → MP3, картинки без него → PNG без потерь). Пустой Ext — сжимать не умеем, причина во втором значении.
func compressFormat(src string, req StartReq) (Format, string) {
	ext := strings.ToLower(filepath.Ext(src))
	switch ext {
	case ".jpg", ".jpeg":
		return fm("jpg", "image", "-q:v 4"), ""
	case ".webp":
		return fm("webp", "image", "-quality 80"), ""
	case ".gif":
		return Format{}, tr("compress.gifNo")
	case ".apng":
		return Format{}, tr("compress.animNo")
	case ".m4a", ".aac", ".m4b":
		return formats["m4a"], ""
	case ".ogg", ".opus", ".oga", ".spx":
		return formats["ogg"], ""
	}
	if imageExt[ext] {
		return fm("png", "image", "-compression_level 9 -pred mixed"), ""
	}
	if audioExt[ext] {
		return formats["mp3"], ""
	}
	if req.Codec == "h264" {
		return formats["mp4"], ""
	}
	return formats["mp4h265"], ""
}

var presets = map[string]bool{"ultrafast": true, "veryfast": true, "fast": true, "medium": true, "slow": true}

func extSet(list string) map[string]bool {
	m := map[string]bool{}
	for _, e := range strings.Fields(list) {
		m["."+e] = true
	}
	return m
}

// Расширения исходников. Меняешь — поправь MEDIA в web/js/core.js и TRIMMABLE в web/js/trim.js (сверяет тест).
var (
	videoExt = extSet("mp4 mov mkv avi webm flv wmv m4v mpg mpeg ts mts m2ts mxf vob ogv dv nut 3gp 3g2 asf f4v rm rmvb divx swf")
	audioExt = extSet("mp3 wav flac m4a m4b aac ogg oga opus wma aiff aif ac3 eac3 dts mp2 wv tta mka caf au w64 amr awb spx gsm voc mmf ra ape")
	imageExt = extSet("png jpg jpeg webp bmp tif tiff avif jp2 j2k tga ico dpx exr hdr qoi ppm pgm pbm pam pcx sgi ras xbm xwd")
	mediaExt = func() map[string]bool {
		m := extSet("gif apng")
		for _, set := range []map[string]bool{videoExt, audioExt, imageExt} {
			for e := range set {
				m[e] = true
			}
		}
		return m
	}()
)

// mediaFilter: маска для диалога выбора файлов, «*.mp4;*.mov;…»
func mediaFilter() string {
	var list []string
	for e := range mediaExt {
		list = append(list, "*"+e)
	}
	slices.Sort(list)
	return strings.Join(list, ";")
}
