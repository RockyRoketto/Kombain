package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
)

// Шаги обучающих туров (web/js/tour.js): id уникальны, тексты есть на двух языках,
// каждый простой селектор #id или .class есть в index.html (ловит переименования).
func TestTourSteps(t *testing.T) {
	b, err := webFS.ReadFile("web/js/tour.js")
	if err != nil {
		t.Fatal(err)
	}
	src := string(b)
	start := strings.Index(src, "const TOURS = {")
	end := strings.Index(src, "const TOUR_AUTO_DELAY")
	if start < 0 || end < start {
		t.Fatal("не нашёл таблицу TOURS в tour.js")
	}
	table := src[start:end]
	html, err := webFS.ReadFile("web/index.html")
	if err != nil {
		t.Fatal(err)
	}
	page := string(html)

	stepRe := regexp.MustCompile(`\{id: '([^']+)', sel: (\[[^\]]*\]|'[^']*')`)
	selRe := regexp.MustCompile(`'([^']+)'`)
	seen := map[string]bool{}
	steps := stepRe.FindAllStringSubmatch(table, -1)
	if len(steps) < 10 {
		t.Fatalf("найдено только %d шагов, разбор сломался?", len(steps))
	}
	for _, m := range steps {
		id := m[1]
		if seen[id] {
			t.Errorf("шаг %q повторяется", id)
		}
		seen[id] = true
		for _, lang := range []string{langRU, langEN} {
			for _, suf := range []string{".h", ".d"} {
				if _, ok := pageDict()[lang]["tour."+id+suf]; !ok {
					t.Errorf("%s: нет ключа tour.%s%s", lang, id, suf)
				}
			}
		}
		for _, s := range selRe.FindAllStringSubmatch(m[2], -1) {
			sel := s[1]
			if i := strings.Index(sel, " "); i >= 0 {
				sel = sel[:i] // составной селектор: проверяем первый элемент
			}
			if i := strings.Index(sel, "["); i >= 0 {
				sel = sel[:i]
			}
			switch {
			case strings.HasPrefix(sel, "#"):
				if !strings.Contains(page, `id="`+sel[1:]+`"`) && !strings.Contains(page, `id='`+sel[1:]+`'`) {
					t.Errorf("шаг %s: в index.html нет %s", id, s[1])
				}
			case strings.HasPrefix(sel, "."):
				if !strings.Contains(page, sel[1:]) {
					t.Errorf("шаг %s: в index.html нет класса %s", id, s[1])
				}
			}
		}
	}
}

// Тумблер автопоказа и «Сбросить всё» из настроек («Обучение»): off и reset сохраняются на диск.
func TestToursAutoAndReset(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir()) // настоящие настройки не трогаем
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	s := &Server{host: "h", token: "t"}
	mux := http.NewServeMux()
	s.toursRoute(mux)
	call := func(body string) TourState {
		r := httptest.NewRequest("POST", "/api/tours", strings.NewReader(body))
		r.Host, r.Header = "h", http.Header{"X-Token": {"t"}}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		var res struct{ Tours TourState }
		if err := json.Unmarshal(w.Body.Bytes(), &res); err != nil {
			t.Fatal(err, w.Body.String())
		}
		return res.Tours
	}
	if st := call(`{"seen":["a","b"],"decline":"mont"}`); len(st.Seen) != 2 || st.Declined["mont"] != 1 {
		t.Fatalf("после отметок: %+v", st)
	}
	if st := call(`{"auto":false}`); !st.Off || !loadSettings().Tours.Off {
		t.Fatalf("автопоказ не выключился: %+v", st)
	}
	if st := call(`{"auto":true}`); st.Off || loadSettings().Tours.Off {
		t.Fatalf("автопоказ не включился: %+v", st)
	}
	call(`{"auto":false}`)
	st := call(`{"reset":true}`)
	if len(st.Seen) != 0 || len(st.Declined) != 0 || st.Gen != 1 || !st.Off {
		t.Fatalf("после сброса (тумблер должен остаться): %+v", st)
	}
	if d := loadSettings().Tours; d == nil || len(d.Seen) != 0 || d.Gen != 1 {
		t.Fatalf("сброс не дошёл до диска: %+v", d)
	}
}
