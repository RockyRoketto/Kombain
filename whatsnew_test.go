package main

import (
	"regexp"
	"slices"
	"strings"
	"testing"
)

const testChangelog = "# Что нового\r\n\r\nВступление.\r\n\r\n## 1.9.0\r\n\r\n- девять\r\n\r\n## 1.8.0\r\n\r\n- восемь\r\n- ещё восемь\r\n\r\n## 1.7.0\r\n\r\n- семь\r\n"

func TestChangelogSince(t *testing.T) {
	cases := []struct{ since, upTo, want string }{
		{"1.8.0", "1.9.0", "- девять"},
		{"", "1.8.0", "- восемь\n- ещё восемь"},
		{"1.7.0", "1.9.0", "1.9.0\n- девять\n\n1.8.0\n- восемь\n- ещё восемь"},
		{"1.7.0", "1.8.0", "- восемь\n- ещё восемь"}, // версии новее текущей не показываем
		{"1.9.0", "1.9.0", ""},
		{"", "2.0.0", ""},
	}
	for _, c := range cases {
		if got := changelogSince(testChangelog, c.since, c.upTo); got != c.want {
			t.Errorf("%q..%q: got %q, want %q", c.since, c.upTo, got, c.want)
		}
	}
}

// Выпуск без раздела в CHANGELOG.md оставил бы плашку пустой
func TestChangelogHasCurrentVersion(t *testing.T) {
	if strings.TrimSpace(changelogSince(changelogMD, "", appVersion)) == "" {
		t.Fatalf("в CHANGELOG.md нет раздела %s", appVersion)
	}
}

// Английский журнал ведётся вручную вместе с русским: в них должны быть одни и те же версии
func TestChangelogEnglish(t *testing.T) {
	re := regexp.MustCompile(`(?m)^## (\S+)`)
	versions := func(md string) []string {
		var out []string
		for _, m := range re.FindAllStringSubmatch(md, -1) {
			out = append(out, m[1])
		}
		return out
	}
	if ru, en := versions(changelogMD), versions(changelogEnMD); !slices.Equal(ru, en) {
		t.Errorf("разные версии в журналах: %v и %v", ru, en)
	}
	if cyrillic.MatchString(changelogEnMD) {
		t.Errorf("кириллица в CHANGELOG.en.md: %s", cyrillic.FindString(changelogEnMD))
	}
	if strings.TrimSpace(changelogSince(changelogEnMD, "", appVersion)) == "" {
		t.Fatalf("в CHANGELOG.en.md нет раздела %s", appVersion)
	}
}

func TestSplitNotes(t *testing.T) {
	cases := []struct{ body, ru, en string }{
		{"- новое", "- новое", ""}, // старый релиз
		{"- новое\n\n### English\n\n- new\n", "- новое", "- new"},
		{"- новое\r\n\r\n### English\r\n\r\n- new\r\n", "- новое", "- new"},
		{"- новое ### English", "- новое ### English", ""}, // только отдельной строкой
		{"", "", ""},
	}
	for _, c := range cases {
		if ru, en := splitNotes(c.body); ru != c.ru || en != c.en {
			t.Errorf("%q: %q, %q", c.body, ru, en)
		}
	}
	// русский текст не должен съедать место английского: длина считается отдельно
	long := strings.Repeat("я", 2000)
	ru, en := splitNotes(long + "\n### English\n" + long)
	if len([]rune(ru)) != 1501 || len([]rune(en)) != 1501 {
		t.Errorf("обрезка: %d и %d", len([]rune(ru)), len([]rune(en)))
	}
}

func TestWhatsNewSince(t *testing.T) {
	cases := []struct {
		name, seen, installed string
		updated               bool
		since                 string
		show                  bool
	}{
		{"новая установка", "", "", false, "", false},
		{"уже видел эту версию", appVersion, appVersion, false, appVersion, false},
		{"обновился", "0.0.1", "", true, "0.0.1", true},
		{"настройки важнее записи об установке", "0.0.2", "0.0.1", true, "0.0.2", true},
		{"запустил более старую версию", "99.0.0", "", false, "99.0.0", false},
		{"старая установка без настройки", "", "0.0.1", true, "0.0.1", true},
		{"не установлена, только что обновилась", "", "", true, "", true},
		{"установлена та же версия", "", appVersion, false, "", false},
	}
	for _, c := range cases {
		since, show := whatsNewSince(c.seen, c.installed, c.updated)
		if since != c.since || show != c.show {
			t.Errorf("%s: got %q %v", c.name, since, show)
		}
	}
}

func TestNewsLifecycle(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())

	s := &Server{settings: Settings{SeenVersion: "0.0.1"}}
	s.initNews("", true)
	if s.news == "" || s.newsEn == "" || s.news == s.newsEn {
		t.Fatalf("плашка не появилась на обоих языках: %q, %q", s.news, s.newsEn)
	}
	if got := loadSettings().SeenVersion; got == appVersion {
		t.Fatal("версия отмечена просмотренной до «Понятно»")
	}
	s.newsSeen()
	if s.news != "" || s.newsEn != "" || loadSettings().SeenVersion != appVersion {
		t.Fatalf("после «Понятно»: %q, %q, %+v", s.news, s.newsEn, loadSettings())
	}

	s = &Server{settings: loadSettings()}
	s.initNews(appVersion, false)
	if s.news != "" {
		t.Fatalf("плашка появилась снова: %q", s.news)
	}

	// новая установка: ничего не показываем, но версию запоминаем, чтобы следующее обновление было с чем сравнить
	saveSettings(Settings{})
	s = &Server{settings: loadSettings()}
	s.initNews("", false)
	if s.news != "" || loadSettings().SeenVersion != appVersion {
		t.Fatalf("новая установка: %q, %+v", s.news, loadSettings())
	}
}
