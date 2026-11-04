package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// Списки форматов и расширений в Go и на странице должны совпадать.
func TestFormatsMatchPage(t *testing.T) {
	b, err := os.ReadFile("web/js/core.js")
	if err != nil {
		t.Fatal(err)
	}
	core := string(b)
	block := core[strings.Index(core, "const FORMATS"):strings.Index(core, "const fmtName")]
	page := map[string]string{}
	for _, m := range regexp.MustCompile(`'?([0-9a-z]+)'?:\{(?:n|i):'[^']*',k:'(\w+)'\}`).FindAllStringSubmatch(block, -1) {
		page[m[1]] = m[2]
	}
	groups := core[strings.Index(core, "const GROUPS"):strings.Index(core, "const PRESET_BASE")]
	for id, f := range formats {
		k, ok := page[id]
		if !ok {
			t.Errorf("%s нет в FORMATS", id)
			continue
		}
		if want := strings.Replace(f.Kind, "compress", "small", 1); k != want {
			t.Errorf("%s: на странице %s, в Go %s", id, k, want)
		}
		if !strings.Contains(groups, "'"+id+"'") {
			t.Errorf("%s нет в GROUPS", id)
		}
	}
	for id := range page {
		if _, ok := formats[id]; !ok {
			t.Errorf("%s есть на странице, но нет в formats", id)
		}
	}

	re := func(file, name string) *regexp.Regexp {
		b, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		m := regexp.MustCompile(`const ` + name + ` = /(.+)/i;`).FindSubmatch(b)
		if m == nil {
			t.Fatalf("нет %s в %s", name, file)
		}
		return regexp.MustCompile("(?i)" + string(m[1]))
	}
	media, trim, images := re("web/js/core.js", "MEDIA"), re("web/js/trim.js", "TRIMMABLE"), re("web/js/core.js", "IMAGES")
	for e := range mediaExt {
		if images.MatchString("a"+e) != imageExt[e] {
			t.Errorf("%s: IMAGES должен быть %v", e, imageExt[e])
		}
		if !media.MatchString("a" + e) {
			t.Errorf("%s нет в MEDIA", e)
		}
		if want := videoExt[e] || audioExt[e]; trim.MatchString("a"+e) != want {
			t.Errorf("%s: TRIMMABLE должен быть %v", e, want)
		}
	}
	for _, e := range []string{"avi", "aif", "j2k"} {
		if !strings.Contains(mediaFilter(), "*."+e) {
			t.Errorf("%s нет в маске диалога", e)
		}
	}
}

func TestCompressFormatNewInputs(t *testing.T) {
	for src, want := range map[string]string{"a.tga": "png", "a.avif": "png", "a.aiff": "mp3", "a.oga": "ogg", "a.m4b": "m4a", "a.m2ts": "mp4", "a.mxf": "mp4"} {
		if f, _ := compressFormat(src, StartReq{}); f.Ext != want {
			t.Errorf("%s: %s, ждали %s", src, f.Ext, want)
		}
	}
	if f, why := compressFormat("a.apng", StartReq{}); f.Ext != "" || why == "" {
		t.Errorf("apng: %+v %q", f, why)
	}
}

// Настоящая конвертация в каждый формат: неудобный исходник (нечётный размер, 12 кадров в секунду,
// звук 5.1 и 22 кГц) и крайние значения настроек. Результат должен читаться обратно.
func TestEveryFormatEncodes(t *testing.T) {
	ffm, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("нет ffmpeg")
	}
	dir := t.TempDir()
	src := filepath.Join(dir, "src.mkv")
	out, err := exec.Command(ffm, "-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-i", "testsrc2=d=1:s=321x241:r=12",
		"-f", "lavfi", "-i", "sine=f=440:d=1:r=22050",
		"-af", "pan=5.1|FL=c0|FR=c0|FC=c0|LFE=c0|BL=c0|BR=c0", "-c:v", "libx264", "-c:a", "flac", "-shortest", src).CombinedOutput()
	if err != nil {
		t.Fatalf("исходник: %v\n%s", err, out)
	}
	si := probe(context.Background(), ffm, src)
	reqs := map[string]StartReq{
		"обычно":   {CRF: 23, ABR: 192, Preset: "medium"},
		"минимум":  {CRF: 0, ABR: 32, Preset: "ultrafast", Height: "120", FPS: "10"},
		"максимум": {CRF: 51, ABR: 512, Preset: "ultrafast"},
	}
	for id, f := range formats {
		if f.Kind == "compress" || f.Kind == "seq" { // кадры проверяет sequence_test.go
			continue
		}
		if f.moving() {
			f := f
			t.Run(id+"/повтор", func(t *testing.T) { // аргументы второй попытки после ошибки
				t.Parallel()
				dst := filepath.Join(t.TempDir(), "out."+f.Ext)
				args := buildArgs(f, reqs["обычно"], src, dst, si, true, nil)
				if out, err := exec.Command(ffm, args...).CombinedOutput(); err != nil {
					t.Fatalf("%v\n%s", err, lastLines(out))
				}
			})
		}
		if f.Kind == "video" {
			f := f
			t.Run(id+"/лимит", func(t *testing.T) { // «уложить в N МБ»: два прохода
				t.Parallel()
				tmp := t.TempDir()
				dst := filepath.Join(tmp, "out."+f.Ext)
				for pass := 1; pass <= 2; pass++ {
					to := dst
					if pass == 1 {
						to = os.DevNull
					}
					args := buildArgs(f, reqs["обычно"], src, to, si, false, &rate{vk: 300, ak: 96, pass: pass, dir: tmp})
					cmd := exec.Command(ffm, args...)
					cmd.Dir = tmp
					if out, err := cmd.CombinedOutput(); err != nil {
						t.Fatalf("проход %d: %v\n%s\n%s", pass, err, strings.Join(args, " "), lastLines(out))
					}
				}
				if fileSize(dst) == 0 {
					t.Fatal("пустой результат")
				}
			})
		}
		for name, req := range reqs {
			f, req := f, req // подтесты идут параллельно
			t.Run(id+"/"+name, func(t *testing.T) {
				t.Parallel()
				dst := filepath.Join(t.TempDir(), "out."+f.Ext)
				args := buildArgs(f, req, src, dst, si, false, nil)
				if out, err := exec.Command(ffm, args...).CombinedOutput(); err != nil {
					if f.codec() == "dnxhd" && req.Height != "" && friendlyErr(string(out), err) == tr("ff.tooSmall") {
						return // кадр меньше 256×120 DNxHR не принимает: человек получит понятный текст
					}
					t.Fatalf("%v\n%s\n%s", err, strings.Join(args, " "), lastLines(out))
				}
				if fileSize(dst) == 0 {
					t.Fatal("пустой результат")
				}
				if out, err := exec.Command(ffm, "-v", "error", "-i", dst, "-f", "null", "-").CombinedOutput(); err != nil {
					t.Fatalf("не читается: %v\n%s", err, lastLines(out))
				}
			})
		}
	}
}

func lastLines(b []byte) string {
	l := strings.Split(strings.TrimSpace(string(b)), "\n")
	if len(l) > 4 {
		l = l[:4]
	}
	return strings.Join(l, "\n")
}
