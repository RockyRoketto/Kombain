package main

import (
	"context"
	"crypto/rand"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestBannerNames(t *testing.T) {
	cases := map[string]string{
		`1380x248_R.png`:  "1380x248_R",
		`1380×248_r.PNG`:  "1380x248_R", // знак умножения
		`1380х248_R.png`:  "1380x248_R", // русская х
		`344x157 _C.png`:  "344x157_C",
		`315x250.png`:     "315x250",
		`315x250_R.png`:   "",
		`1380x248_R1.png`: "",
	}
	for p, want := range cases {
		if got := bannerWanted(p); got != want {
			t.Errorf("%s: %q, want %q", p, got, want)
		}
	}
	if w, h, ok := bannerDims(`4056х496_R.png`); !ok || w != "4056" || h != "496" {
		t.Errorf("dims: %s %s %v", w, h, ok)
	}
	if _, _, ok := bannerDims(`logo.png`); ok {
		t.Error("logo.png: размера в имени нет")
	}
}

func TestBannerDirs(t *testing.T) {
	root := t.TempDir()
	png := filepath.Join(root, "project", "PNG")
	os.MkdirAll(png, 0o755)
	files := []string{
		filepath.Join(root, "logo.png"),                // не из списка: его папка не считается
		filepath.Join(dropDir(), "x", "800x260_R.png"), // копия из браузера: настоящей папки нет
		filepath.Join(png, "315x250.png"),
	}
	if _, ok := bannerDirs(files[:2], Settings{}); ok {
		t.Error("среди файлов нет настоящей папки, ждали отказ")
	}

	// папок нет: их место рядом с папкой PNG, а не внутри неё
	side := filepath.Join(root, "project")
	d, ok := bannerDirs(files, Settings{})
	if !ok || d.Base != png || d.JpgDir != filepath.Join(side, "JPEG") || d.WebpDir != filepath.Join(side, "WebP") || d.JpgFound || d.WebpFound {
		t.Errorf("папок нет: %+v %v", d, ok)
	}

	// соседняя папка JPG уже есть, берём её вместо новой JPEG
	os.MkdirAll(filepath.Join(side, "JPG"), 0o755)
	os.MkdirAll(filepath.Join(side, "WebP"), 0o755)
	d, _ = bannerDirs(files, Settings{})
	if d.JpgDir != filepath.Join(side, "JPG") || !d.JpgFound || d.WebpDir != filepath.Join(side, "WebP") || !d.WebpFound {
		t.Errorf("соседние папки: %+v", d)
	}

	// запомненное положение важнее обычных имён, но только если там есть папка
	os.MkdirAll(filepath.Join(side, "out", "j"), 0o755)
	st := Settings{BannerJpgRel: filepath.Join("..", "out", "j"), BannerWebpRel: filepath.Join("..", "out", "w")}
	d, _ = bannerDirs(files, st)
	if d.JpgDir != filepath.Join(side, "out", "j") || !d.JpgFound {
		t.Errorf("запомненная JPEG: %+v", d)
	}
	if d.WebpDir != filepath.Join(side, "WebP") || !d.WebpFound {
		t.Errorf("запомненной WebP нет на диске, ждали соседнюю: %+v", d)
	}
}

// положение папок, выбранное в одном проекте, находит папки в другом
func TestRememberBannerDirs(t *testing.T) {
	root := t.TempDir()
	t.Setenv("LOCALAPPDATA", t.TempDir()) // настоящие настройки не трогаем
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	s := &Server{}
	a, b := filepath.Join(root, "a", "PNG"), filepath.Join(root, "b", "PNG")
	for _, p := range []string{a, b, filepath.Join(root, "a", "ready", "jpeg"), filepath.Join(root, "b", "ready", "jpeg")} {
		os.MkdirAll(p, 0o755)
	}
	s.rememberBannerDirs([]string{filepath.Join(a, "315x250.png")}, filepath.Join(root, "a", "ready", "jpeg"), "")
	if want := filepath.Join("..", "ready", "jpeg"); s.settings.BannerJpgRel != want || loadSettings().BannerJpgRel != want {
		t.Fatalf("запомнено %q, в файле %q", s.settings.BannerJpgRel, loadSettings().BannerJpgRel)
	}
	d, ok := s.bannerDirsNow([]string{filepath.Join(b, "315x250.png")})
	if !ok || d.JpgDir != filepath.Join(root, "b", "ready", "jpeg") || !d.JpgFound || d.WebpFound {
		t.Errorf("второй проект: %+v %v", d, ok)
	}
}

// с настоящим ffmpeg: большой PNG пережимается на месте, файлы из списка → JPG и WebP
func TestRunBanners(t *testing.T) {
	ffm, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg не найден")
	}
	dir := t.TempDir()
	src := filepath.Join(dir, "src")
	os.MkdirAll(filepath.Join(src, "sub"), 0o755)
	big := filepath.Join(src, "sub", "800x260_R.png")
	noise := filepath.Join(dir, "noise.bin")
	b := make([]byte, 1600*520*3)
	rand.Read(b)
	os.WriteFile(noise, b, 0o644)
	// шум 1600×520 — PNG заведомо больше 500 КБ и не того размера, что в имени
	run := func(args ...string) {
		if out, err := exec.Command(ffm, append([]string{"-y", "-loglevel", "error"}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("%v: %s", err, out)
		}
	}
	run("-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "1600x520", "-i", noise, "-frames:v", "1", big)
	small := filepath.Join(src, "315x250.png")
	run("-f", "lavfi", "-i", "color=red:s=315x250", "-frames:v", "1", small)
	other := filepath.Join(src, "logo.png")
	run("-f", "lavfi", "-i", "color=blue:s=64x64", "-frames:v", "1", other)
	if fileSize(big) <= bannerLimit {
		t.Fatalf("тестовый PNG слишком мал: %d", fileSize(big))
	}

	s := &Server{}
	jpg, webp := filepath.Join(dir, "jpg"), filepath.Join(dir, "webp")
	s.runBanners(BannerReq{Files: []string{big, small, other}, JpgDir: jpg, WebpDir: webp}, ffm)

	for _, fs := range s.files {
		if fs.Status != "ok" {
			t.Errorf("%s: %s %s %s", fs.Name, fs.Status, fs.Msg, fs.Hint)
		}
	}
	if n := fileSize(big); n == 0 || n > bannerLimit {
		t.Errorf("PNG не пережат: %d", n)
	}
	if mi := getMediaInfo(ffm, big); mi.W != 800 || mi.H != 260 {
		t.Errorf("PNG %dx%d, want 800x260", mi.W, mi.H)
	}
	for _, p := range []string{
		filepath.Join(jpg, "800x260_R.jpg"), filepath.Join(jpg, "315x250.jpg"),
		filepath.Join(webp, "800x260_R.webp"), filepath.Join(webp, "315x250.webp"),
	} {
		if fileSize(p) == 0 {
			t.Errorf("нет %s", p)
		}
	}
	// шум не сжимается: JPG и WebP подобраны под лимит, а не оставлены на максимуме или худшем
	for _, p := range []string{filepath.Join(jpg, "800x260_R.jpg"), filepath.Join(webp, "800x260_R.webp")} {
		if n := fileSize(p); n > bannerLimit || n < bannerLimit/3 {
			t.Errorf("%s: %d байт, ждали близко к %d", p, n, bannerLimit)
		}
	}
	if fileExists(filepath.Join(jpg, "logo.jpg")) {
		t.Error("logo.png не из списка, JPG не нужен")
	}
	if left, _ := filepath.Glob(filepath.Join(src, "sub", "_tmp*")); len(left) > 0 {
		t.Errorf("остались временные файлы: %v", left)
	}
}

// файл заняли, как ffmpeg миниатюры: простая замена получает отказ, replaceFile дожидается
func TestReplaceFileBusy(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("занятый файл мешает замене только в Windows")
	}
	wait := replaceWait
	defer func() { replaceWait = wait }()
	dir := t.TempDir()
	from, to := filepath.Join(dir, "new.png"), filepath.Join(dir, "old.png")
	os.WriteFile(from, []byte("new"), 0o644)
	os.WriteFile(to, []byte("old"), 0o644)
	content := func(p string) string { b, _ := os.ReadFile(p); return string(b) }

	h, err := os.Open(to)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	if os.Rename(from, to) == nil {
		t.Fatal("занятый файл заменился, тест ничего не проверяет")
	}

	// файл не освободился: ошибка, оригинал и новый файл целы
	replaceWait = 150 * time.Millisecond
	if replaceFile(context.Background(), from, to) == nil {
		t.Error("ждали ошибку: файл занят всё время")
	}
	if content(to) != "old" || content(from) != "new" {
		t.Errorf("после отказа: to=%q from=%q", content(to), content(from))
	}

	// «Стоп» не ждёт весь срок
	replaceWait = time.Minute
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	st := time.Now()
	if replaceFile(ctx, from, to) == nil {
		t.Error("ждали ошибку после отмены")
	}
	if d := time.Since(st); d > 5*time.Second {
		t.Errorf("отмена заняла %v", d)
	}

	// файл освободился: замена проходит
	time.AfterFunc(200*time.Millisecond, func() { h.Close() })
	if err := replaceFile(context.Background(), from, to); err != nil {
		t.Fatal(err)
	}
	if content(to) != "new" || fileExists(from) {
		t.Errorf("после замены: to=%q, from есть: %v", content(to), fileExists(from))
	}
}

// fitUnderLimit: берёт самое высокое качество из влезающих, не больше семи кодирований
func TestFitUnderLimit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "f")
	// размер растёт с качеством: q КБ·6
	mk := func(calls *int, cur *int) func(q int) error {
		return func(q int) error {
			*calls++
			*cur = q
			return os.WriteFile(path, make([]byte, q*6<<10), 0o644)
		}
	}
	var calls, cur int
	fit, err := fitUnderLimit(context.Background(), [2]int{100, 45}, mk(&calls, &cur), path)
	if err != nil || !fit || cur < 78 || cur > 83 || fileSize(path) > bannerLimit || calls > 7 {
		t.Errorf("fit=%v err=%v q=%d calls=%d size=%d", fit, err, cur, calls, fileSize(path))
	}
	calls = 0
	fit, _ = fitUnderLimit(context.Background(), [2]int{70, 45}, mk(&calls, &cur), path)
	if !fit || cur != 70 || calls != 1 {
		t.Errorf("влезает сразу: fit=%v q=%d calls=%d", fit, cur, calls)
	}
	calls = 0
	fit, _ = fitUnderLimit(context.Background(), [2]int{200, 150}, mk(&calls, &cur), path)
	if fit || cur != 150 {
		t.Errorf("не влезает: fit=%v q=%d", fit, cur)
	}
}
