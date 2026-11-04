package main

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

const testHost = "test.local"

func themeRequest(s *Server, token, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest("POST", "http://"+testHost+"/api/settings", strings.NewReader(body))
	r.Header.Set("X-Token", token)
	w := httptest.NewRecorder()
	s.routes().ServeHTTP(w, r)
	return w
}

func pageBody(t *testing.T, s *Server) string {
	t.Helper()
	w := httptest.NewRecorder()
	s.routes().ServeHTTP(w, httptest.NewRequest("GET", "http://"+testHost+"/", nil))
	res := w.Result()
	b, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("страница: %d", res.StatusCode)
	}
	return string(b)
}

func pageTheme(t *testing.T, s *Server) string {
	t.Helper()
	body := pageBody(t, s)
	if strings.Contains(body, "__THEME__") || strings.Contains(body, "__TOKEN__") {
		t.Error("в странице остались метки")
	}
	_, rest, ok := strings.Cut(body, "let themePref = '")
	if !ok {
		t.Fatal("в странице нет themePref")
	}
	return rest[:strings.IndexByte(rest, '\'')]
}

func TestThemeSetting(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir()) // Windows
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	s := &Server{host: testHost, token: "tok", settings: loadSettings()}

	if got := pageTheme(t, s); got != themeDark {
		t.Errorf("по умолчанию %q, а нужна тёмная", got)
	}

	// только чтение: файл не появляется
	if w := themeRequest(s, "tok", `{}`); !strings.Contains(w.Body.String(), `"theme":"dark"`) {
		t.Errorf("чтение: %s", w.Body)
	}
	if _, err := os.Stat(settingsPath()); err == nil {
		t.Error("чтение записало settings.json")
	}

	// без токена и с чужим Host — отказ
	if w := themeRequest(s, "чужой", `{"theme":"light"}`); w.Code != http.StatusForbidden {
		t.Errorf("без токена: %d", w.Code)
	}
	r := httptest.NewRequest("POST", "http://evil.test/api/settings", strings.NewReader(`{"theme":"light"}`))
	r.Header.Set("X-Token", "tok")
	w := httptest.NewRecorder()
	s.routes().ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Errorf("чужой Host: %d", w.Code)
	}
	if s.settings.Theme != "" {
		t.Errorf("отказ всё равно сменил тему: %q", s.settings.Theme)
	}

	for _, theme := range []string{themeLight, themeSystem, themeDark} {
		if w := themeRequest(s, "tok", `{"theme":"`+theme+`"}`); !strings.Contains(w.Body.String(), `"ok":true`) {
			t.Errorf("%s: %s", theme, w.Body)
		}
		if got := pageTheme(t, s); got != theme {
			t.Errorf("страница: %q, а выбрано %q", got, theme)
		}
		// после перезапуска настройка читается из файла
		if got := loadSettings().Theme; got != theme {
			t.Errorf("settings.json: %q, а выбрано %q", got, theme)
		}
	}

	// неверное значение: ошибка, настройка и файл не меняются
	themeRequest(s, "tok", `{"theme":"light"}`)
	for _, body := range []string{`{"theme":"purple"}`, `{"theme":""}`, `{"theme":"LIGHT"}`, `{"theme":1}`, `не json`} {
		if w := themeRequest(s, "tok", body); !strings.Contains(w.Body.String(), `"error"`) {
			t.Errorf("%s принято: %s", body, w.Body)
		}
	}
	if s.settings.Theme != themeLight || loadSettings().Theme != themeLight {
		t.Errorf("неверное значение сменило тему: %q, %q", s.settings.Theme, loadSettings().Theme)
	}

	// испорченный settings.json не должен попасть на страницу как есть
	s.settings.Theme = "'</script>"
	if got := pageTheme(t, s); got != themeDark {
		t.Errorf("испорченное значение: %q", got)
	}
}

// Цвета окна до загрузки страницы и --bg в CSS должны совпадать, иначе окно мигнёт при запуске.
func TestThemeWindowColours(t *testing.T) {
	_, light, ok := strings.Cut(pages[langRU], `:root[data-theme="light"]{`)
	if !ok {
		t.Fatal("в странице нет светлой темы")
	}
	want := func(c [3]uint8) string { return fmt.Sprintf("--bg:#%02x%02x%02x", c[0], c[1], c[2]) }
	if !strings.Contains(pages[langRU][:len(pages[langRU])-len(light)], want(bgDark)) {
		t.Errorf("тёмная тема: нет %s", want(bgDark))
	}
	if !strings.Contains(light, want(bgLight)) {
		t.Errorf("светлая тема: нет %s", want(bgLight))
	}
}
