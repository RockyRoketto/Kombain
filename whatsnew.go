package main

// Плашка «Что нового» после обновления: показывает пункты CHANGELOG.md (или CHANGELOG.en.md)
// от последней версии, которую пользователь уже видел, до текущей.

import (
	_ "embed"
	"strings"
)

//go:embed CHANGELOG.md
var changelogMD string

//go:embed CHANGELOG.en.md
var changelogEnMD string

// changelogSince собирает разделы версий новее since и не новее upTo, свежие сверху.
// since пусто — только раздел upTo. Если версий несколько, перед пунктами стоит номер версии.
func changelogSince(md, since, upTo string) string {
	type section struct{ ver, notes string }
	var all []section
	var ver string
	var lines []string
	flush := func() {
		if ver == "" {
			return
		}
		fits := ver == upTo
		if since != "" {
			fits = cmpVer(ver, since) > 0 && cmpVer(ver, upTo) <= 0
		}
		if n := strings.TrimSpace(strings.Join(lines, "\n")); fits && n != "" {
			all = append(all, section{ver, n})
		}
	}
	for _, line := range strings.Split(md, "\n") {
		line = strings.TrimRight(line, " \t\r")
		if v, ok := strings.CutPrefix(line, "## "); ok {
			flush()
			ver, lines = "", nil
			if plainVerRe.MatchString(v) {
				ver = v
			}
			continue
		}
		lines = append(lines, line)
	}
	flush()

	if len(all) == 1 {
		return all[0].notes
	}
	parts := make([]string, len(all))
	for i, sec := range all {
		parts[i] = sec.ver + "\n" + sec.notes
	}
	return strings.Join(parts, "\n\n")
}

// whatsNewSince решает, что показать при запуске: since — граница для changelogSince.
// seen — последняя просмотренная версия из настроек. Пусто оно у новой установки и у тех,
// кто обновился с версии без этой плашки: тогда прошлую версию подсказывает запись об установке,
// а если программа не установлена, но только что обновилась, показываем хотя бы текущий раздел.
func whatsNewSince(seen, installed string, updated bool) (since string, show bool) {
	switch {
	case seen != "":
		return seen, cmpVer(appVersion, seen) > 0
	case installed != "" && cmpVer(appVersion, installed) > 0:
		return installed, true
	case updated:
		return "", true
	}
	return "", false
}

// initNews вызывается при запуске, installed — версия из записи об установке до её обновления.
// Просмотренной версия считается только после «Понятно»: перезапуск или новое обновление плашку не теряют.
func (s *Server) initNews(installed string, updated bool) {
	if since, show := whatsNewSince(s.settings.SeenVersion, installed, updated); show {
		s.news = changelogSince(changelogMD, since, appVersion)
		s.newsEn = changelogSince(changelogEnMD, since, appVersion) // оба языка: выбор можно сменить, пока плашка открыта
	}
	if s.news == "" && s.settings.SeenVersion != appVersion {
		s.settings.SeenVersion = appVersion
		saveSettings(s.settings)
	}
}

// newsSeen: пользователь закрыл плашку
func (s *Server) newsSeen() {
	s.mu.Lock()
	s.news, s.newsEn = "", ""
	s.settings.SeenVersion = appVersion
	st := s.settings
	s.mu.Unlock()
	saveSettings(st)
}
