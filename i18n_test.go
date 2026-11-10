package main

import (
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"testing"
)

var (
	cyrillic   = regexp.MustCompile(`[А-Яа-яЁё]`)
	goVerbRe   = regexp.MustCompile(`%[-+# 0-9.]*[a-zA-Z]`)
	pageVarRe  = regexp.MustCompile(`\{\w+\}`)
	jsKeyRe    = regexp.MustCompile(`\bt\('([^']+)'|\btn\([^,()]+, '([^']+)'\)|\b[nd]:'(preset\.[^']+)'|\bi:'([^']+)'|\['(group\.[^']+)'`)
	scriptRe   = regexp.MustCompile(`(?s)<(script|style)\b.*?</(script|style)>`)
	htmlNoteRe = regexp.MustCompile(`(?s)<!--.*?-->`)
)

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// метки подстановки должны совпадать: иначе на одном из языков вместо значения покажется мусор
func checkDict(t *testing.T, name string, ru, en map[string]string, marks func(string) []string) {
	t.Helper()
	if !slices.Equal(sortedKeys(ru), sortedKeys(en)) {
		for k := range ru {
			if _, ok := en[k]; !ok {
				t.Errorf("%s: нет английского текста для %q", name, k)
			}
		}
		for k := range en {
			if _, ok := ru[k]; !ok {
				t.Errorf("%s: нет русского текста для %q", name, k)
			}
		}
	}
	for k, r := range ru {
		e, ok := en[k]
		if !ok {
			continue
		}
		if strings.TrimSpace(r) == "" || strings.TrimSpace(e) == "" {
			t.Errorf("%s: пустой текст у %q", name, k)
		}
		if !slices.Equal(marks(r), marks(e)) {
			t.Errorf("%s: разные метки у %q: %v и %v", name, k, marks(r), marks(e))
		}
		if cyrillic.MatchString(e) {
			t.Errorf("%s: кириллица в английском тексте %q: %s", name, k, e)
		}
	}
}

func TestDictionariesMatch(t *testing.T) {
	checkDict(t, "Go", goDict[langRU], goDict[langEN], func(s string) []string { return goVerbRe.FindAllString(s, -1) })
	page := pageDict()
	checkDict(t, "страница", page[langRU], page[langEN], func(s string) []string {
		m := pageVarRe.FindAllString(s, -1)
		sort.Strings(m) // порядок слов в языках разный
		return m
	})
	for k := range page[langRU] {
		if strings.HasPrefix(k, "n.") {
			if n := strings.Count(page[langRU][k], "|"); n != 2 {
				t.Errorf("%s: в русском нужно 3 формы слова", k)
			}
			if n := strings.Count(page[langEN][k], "|"); n != 1 {
				t.Errorf("%s: в английском нужно 2 формы слова", k)
			}
		}
	}
	// подпись вставляется в строку внутри onerror=""
	for _, l := range []string{langRU, langEN} {
		if strings.ContainsAny(page[l]["pv.noImage"], `'"<`) {
			t.Errorf("pv.noImage нельзя с кавычками: %s", page[l]["pv.noImage"])
		}
	}
}

func goFiles(t *testing.T) (*token.FileSet, map[string]*ast.File) {
	t.Helper()
	names, _ := filepath.Glob("*.go")
	fset, out := token.NewFileSet(), map[string]*ast.File{}
	for _, name := range names {
		if strings.HasSuffix(name, "_test.go") {
			continue
		}
		f, err := parser.ParseFile(fset, name, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		out[name] = f
	}
	return fset, out
}

// опечатка в ключе вылезла бы только в работе, поэтому проверяем все вызовы
func TestGoKeysExist(t *testing.T) {
	fset, files := goFiles(t)
	calls := 0
	for _, f := range files {
		ast.Inspect(f, func(n ast.Node) bool {
			c, ok := n.(*ast.CallExpr)
			if !ok || len(c.Args) == 0 {
				return true
			}
			name := ""
			switch fn := c.Fun.(type) {
			case *ast.Ident:
				name = fn.Name
			case *ast.SelectorExpr:
				name = fn.Sel.Name
			}
			if name != "tr" && name != "errT" && name != "logT" {
				return true
			}
			calls++
			lit, ok := c.Args[0].(*ast.BasicLit)
			if !ok {
				return true
			}
			key, _ := strconv.Unquote(lit.Value)
			if _, ok := goDict[langRU][key]; !ok {
				t.Errorf("%s: нет ключа %q", fset.Position(c.Pos()), key)
			}
			return true
		})
	}
	if calls < 50 {
		t.Errorf("найдено только %d вызовов tr, разбор сломался?", calls)
	}
}

func TestPageKeysExist(t *testing.T) {
	dict := pageDict()[langRU]
	found := 0
	for _, name := range webJS {
		b, err := webFS.ReadFile("web/js/" + name)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range jsKeyRe.FindAllStringSubmatch(string(b), -1) {
			key := strings.Join(m[1:], "")
			if key == "ключ" {
				continue // пример в комментарии i18n.js
			}
			found++
			if _, ok := dict[key]; !ok {
				t.Errorf("%s: нет ключа %q", name, key)
			}
		}
	}
	if found < 100 {
		t.Errorf("найдено только %d ключей, разбор сломался?", found)
	}
}

// Текст мимо словаря: кириллица в коде разрешена только там, где это не текст для человека.
func TestNoStrayRussian(t *testing.T) {
	fset, files := goFiles(t)
	allowed := map[string]bool{
		"`[×хХ]`":              true, // banner.go: русская х в именах файлов
		`"Конвертор 9000.lnk"`: true, // install_windows.go: старые имена ярлыка, их ищем на диске
		`"Конвертер 9000.lnk"`: true,
		`"для без над под при про или the and for with"`: true, // subtitles.go: служебные слова эффекта «по слову»
	}
	for name, f := range files {
		if name == "i18n_strings.go" {
			continue
		}
		ast.Inspect(f, func(n ast.Node) bool {
			if lit, ok := n.(*ast.BasicLit); ok && lit.Kind == token.STRING && cyrillic.MatchString(lit.Value) && !allowed[lit.Value] {
				t.Errorf("%s: текст мимо словаря: %s", fset.Position(lit.Pos()), lit.Value)
			}
			return true
		})
	}

	for _, name := range webJS {
		b, _ := webFS.ReadFile("web/js/" + name)
		for i, line := range strings.Split(string(b), "\n") {
			if c := strings.Index(line, "// "); c >= 0 {
				line = line[:c]
			}
			if cyrillic.MatchString(line) && !strings.Contains(line, "const bKey") { // bKey: русская х в именах файлов
				t.Errorf("web/js/%s:%d: текст мимо словаря: %s", name, i+1, strings.TrimSpace(line))
			}
		}
	}

	// разметка уже переведена сервером, в ней не должно быть другого языка
	markup := func(page string) string {
		return htmlNoteRe.ReplaceAllString(scriptRe.ReplaceAllString(page, ""), "")
	}
	en := strings.ReplaceAll(markup(pages[langEN]), "Русский", "")
	if m := regexp.MustCompile(`.*[А-Яа-яЁё].*`).FindString(en); m != "" {
		t.Errorf("кириллица в английской странице: %s", m)
	}
	ru := markup(pages[langRU])
	for _, want := range []string{`<html lang="ru">`, "<title data-i18n=\"app.name\">Kombain</title>", ">Конвертировать</button>", ">Рядом с оригиналом</b>", "by Dmitrii Trudnikov"} {
		if !strings.Contains(ru, want) {
			t.Errorf("в русской странице нет %q", want)
		}
	}
	for _, want := range []string{`<html lang="en">`, ">Kombain</title>", ">Convert</button>", ">Converter</button>", ">Banners</button>", "by Dmitrii Trudnikov"} {
		if !strings.Contains(markup(pages[langEN]), want) {
			t.Errorf("в английской странице нет %q", want)
		}
	}
	for _, l := range []string{langRU, langEN} {
		if strings.Contains(pages[l], "__LANG__") || strings.Contains(pages[l], "__I18N__") {
			t.Errorf("%s: в странице остались метки", l)
		}
		if !strings.Contains(pages[l], "let lang = '"+l+"'") {
			t.Errorf("%s: скрипт не знает язык страницы", l)
		}
	}
}

func useLang(t *testing.T, l string) {
	t.Helper()
	setLang(l)
	t.Cleanup(func() { setLang(langRU) })
}

func TestNormLang(t *testing.T) {
	for in, want := range map[string]string{
		"ru": langRU, "en": langEN, "": langRU, "EN": langRU, "de": langRU, "en-US": langRU, "'</script>": langRU,
	} {
		if got := normLang(in); got != want {
			t.Errorf("normLang(%q) = %q, нужно %q", in, got, want)
		}
	}
	useLang(t, "de")
	if currentLang() != langRU {
		t.Errorf("setLang с неверным значением: %q", currentLang())
	}
}

func TestLangSetting(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	useLang(t, langRU)
	s := &Server{host: testHost, token: "tok", settings: loadSettings()}
	page := func() string { return pageBody(t, s) }

	if !strings.Contains(page(), `<html lang="ru">`) {
		t.Error("по умолчанию нужен русский")
	}
	if w := themeRequest(s, "tok", `{}`); !strings.Contains(w.Body.String(), `"lang":"ru"`) {
		t.Errorf("чтение: %s", w.Body)
	}

	if w := themeRequest(s, "tok", `{"lang":"en"}`); !strings.Contains(w.Body.String(), `"ok":true`) {
		t.Fatalf("en: %s", w.Body)
	}
	if !strings.Contains(page(), `<html lang="en">`) || currentLang() != langEN {
		t.Errorf("язык не применился: %q", currentLang())
	}
	if got := loadSettings().Lang; got != langEN { // после перезапуска настройка читается из файла
		t.Errorf("settings.json: %q", got)
	}
	if got := tr("batch.done"); got != "Done" {
		t.Errorf("Go не перешёл на английский: %q", got)
	}

	// смена языка не трогает тему, и наоборот
	themeRequest(s, "tok", `{"theme":"light"}`)
	if st := loadSettings(); st.Lang != langEN || st.Theme != themeLight {
		t.Errorf("настройки перепутались: %+v", st)
	}

	// неверное значение: ошибка, настройка и файл не меняются, ошибка на текущем языке
	for _, body := range []string{`{"lang":"de"}`, `{"lang":""}`, `{"lang":"EN"}`, `{"lang":1}`} {
		if w := themeRequest(s, "tok", body); !strings.Contains(w.Body.String(), `"error"`) {
			t.Errorf("%s принято: %s", body, w.Body)
		}
	}
	if w := themeRequest(s, "tok", `{"lang":"de"}`); !strings.Contains(w.Body.String(), "unknown language") {
		t.Errorf("ошибка не на английском: %s", w.Body)
	}
	if s.settings.Lang != langEN || loadSettings().Lang != langEN || currentLang() != langEN {
		t.Errorf("неверное значение сменило язык: %q", s.settings.Lang)
	}

	// неверная тема вместе с языком: не применяется ничего
	if w := themeRequest(s, "tok", `{"lang":"ru","theme":"purple"}`); !strings.Contains(w.Body.String(), `"error"`) {
		t.Errorf("принято: %s", w.Body)
	}
	if currentLang() != langEN {
		t.Error("язык сменился, хотя запрос отклонён")
	}

	// испорченный settings.json — русская страница
	s.settings.Lang = "'</script>"
	if !strings.Contains(page(), `<html lang="ru">`) {
		t.Error("испорченное значение: нужен русский")
	}
}

func TestTranslatedErrors(t *testing.T) {
	stderr := "Conversion failed: No space left on device"
	useLang(t, langRU)
	if got := friendlyErr(stderr, nil); got != "На диске кончилось место." {
		t.Errorf("ru: %q", got)
	}
	if got := friendlyErr("", errors.New("boom")); got != "ffmpeg не запустился: boom" {
		t.Errorf("ru: %q", got)
	}
	if got := mbStr(2.5); got != "2,5" {
		t.Errorf("ru: %q", got)
	}
	if got := withMediaError(MediaInfo{}).Error; got != "ffmpeg не смог прочитать файл" {
		t.Errorf("ru: %q", got)
	}

	// разбор вывода ffmpeg не зависит от языка интерфейса: тот же stderr, другой текст для человека
	setLang(langEN)
	if got := friendlyErr(stderr, nil); got != "The disk is full." {
		t.Errorf("en: %q", got)
	}
	if got := friendlyErr("", errors.New("boom 100%")); got != "ffmpeg did not start: boom 100%" {
		t.Errorf("en: %q", got)
	}
	if got := mbStr(2.5); got != "2.5" {
		t.Errorf("en: %q", got)
	}
	if got := fmtKB(2048); got != "2 KB" {
		t.Errorf("en: %q", got)
	}
	if got := withMediaError(MediaInfo{}).Error; got != "ffmpeg could not read the file" {
		t.Errorf("кэш отдал бы ошибку на старом языке: %q", got)
	}
	if got := withMediaError(MediaInfo{VCodec: "h264"}).Error; got != "" {
		t.Errorf("ошибка у читаемого файла: %q", got)
	}
	if got := tr("нет такого ключа"); got != "нет такого ключа" {
		t.Errorf("неизвестный ключ: %q", got)
	}
}
