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
			if i := strings.Index(sel, ":"); i >= 0 {
				sel = sel[:i] // .sw:has(#id), .card:first-child
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

// Туры инструментов «Утилит» и список «Обучения»: у каждого инструмента (UT_TOUR) свой тур из 2–4 шагов,
// каждый тур из TOURS есть на странице «Обучение» (LEARN_TABS) с названием на двух языках.
func TestTourToolsAndLearn(t *testing.T) {
	b, err := webFS.ReadFile("web/js/tour.js")
	if err != nil {
		t.Fatal(err)
	}
	src := string(b)
	start := strings.Index(src, "const TOURS = {")
	end := -1
	if start >= 0 {
		end = strings.Index(src[start:], "\n};\n") + start
	}
	if start < 0 || end <= start {
		t.Fatal("не нашёл таблицу TOURS в tour.js")
	}
	keyRe := regexp.MustCompile(`(?m)^  (\w+): \[`)
	stepRe := regexp.MustCompile(`\{id: '`)
	table := src[start:end]
	locs := keyRe.FindAllStringSubmatchIndex(table, -1)
	steps := map[string]int{}
	var keys []string
	for i, l := range locs {
		k, to := table[l[2]:l[3]], len(table)
		if i+1 < len(locs) {
			to = locs[i+1][0]
		}
		keys = append(keys, k)
		steps[k] = len(stepRe.FindAllString(table[l[0]:to], -1))
	}
	if len(keys) < 10 {
		t.Fatalf("найдено только %d туров: %v", len(keys), keys)
	}
	section := func(name string) string {
		i := strings.Index(src, name)
		if i < 0 {
			t.Fatalf("нет %s в tour.js", name)
		}
		j := strings.Index(src[i:], ";\n")
		return src[i : i+j]
	}
	pairRe := regexp.MustCompile(`(\w+): '([^']+)'`)
	tools := pairRe.FindAllStringSubmatch(section("const UT_TOUR = "), -1)
	if len(tools) < 7 {
		t.Fatalf("UT_TOUR: найдено %d инструментов", len(tools))
	}
	page, _ := webFS.ReadFile("web/index.html")
	for _, m := range tools {
		if !strings.Contains(string(page), `class="cl-tool" data-tool="`+m[1]+`"`) {
			t.Errorf("UT_TOUR: инструмента %s нет в #utTools", m[1])
		}
		if n := steps[m[2]]; n < 2 || n > 4 {
			t.Errorf("тур инструмента %s (%s): %d шагов, нужно 2–4", m[1], m[2], n)
		}
	}
	learn := section("const LEARN_TABS = ")
	names := map[string]string{}
	for _, m := range pairRe.FindAllStringSubmatch(section("const LEARN_NAME = "), -1) {
		names[m[1]] = m[2]
	}
	for _, k := range keys {
		if !strings.Contains(learn, "['"+k+"'") {
			t.Errorf("тура %s нет в LEARN_TABS (страница «Обучение»)", k)
		}
		for _, lang := range []string{langRU, langEN} {
			if _, ok := pageDict()[lang][names[k]]; names[k] == "" || !ok {
				t.Errorf("%s: нет названия тура %s (LEARN_NAME → %q)", lang, k, names[k])
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

// Бейдж «Новое» гаснет через 3 запуска: счётчик на id растёт раз за запуск (перезагрузка страницы не считается),
// при слиянии с диском берётся больший, «Сбросить всё» обнуляет.
func TestToursBeaconLaunches(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	beaconRun = map[string]bool{}
	defer func() { beaconRun = map[string]bool{} }()
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
	for launch := 1; launch <= 4; launch++ {
		beaconRun = map[string]bool{} // новый запуск программы
		call(`{"beacon":["mt.anim"]}`)
		st := call(`{"beacon":["mt.anim","cl.from"]}`) // перезагрузка страницы в том же запуске
		if st.Beacons["mt.anim"] != launch || st.Beacons["cl.from"] != launch {
			t.Fatalf("запуск %d: %v", launch, st.Beacons)
		}
	}
	if d := loadSettings().Tours; d == nil || d.Beacons["mt.anim"] != 4 {
		t.Fatalf("счётчик не дошёл до диска: %+v", d)
	}
	m := mergeTours(&TourState{Beacons: map[string]int{"a": 5, "b": 1}}, &TourState{Beacons: map[string]int{"b": 2}})
	if m.Beacons["a"] != 5 || m.Beacons["b"] != 2 {
		t.Fatalf("слияние: %v", m.Beacons)
	}
	if st := call(`{"reset":true}`); len(st.Beacons) != 0 {
		t.Fatalf("сброс не обнулил бейджи: %v", st.Beacons)
	}
	if st := call(`{"beacon":["mt.anim"]}`); st.Beacons["mt.anim"] != 1 {
		t.Fatalf("после сброса бейдж считается заново: %v", st.Beacons)
	}
}

// Советы «!» (TIPS в tour.js): селектор есть в index.html, текст tip.<id> на двух языках, id уникальны,
// на вкладку 1–3 совета, вкладка есть в TIP_TABS (список на странице «Обучение»).
func TestTourTips(t *testing.T) {
	b, err := webFS.ReadFile("web/js/tour.js")
	if err != nil {
		t.Fatal(err)
	}
	src := string(b)
	i := strings.Index(src, "const TIPS = [")
	j := strings.Index(src, "const TIP_TABS = ")
	if i < 0 || j < i {
		t.Fatal("не нашёл TIPS в tour.js")
	}
	tabsLine := src[j : j+strings.Index(src[j:], ";")]
	page, _ := webFS.ReadFile("web/index.html")
	tipRe := regexp.MustCompile(`\{id: '([^']+)', tab: '([^']+)', sel: '#([\w-]+)'\}`)
	tips := tipRe.FindAllStringSubmatch(src[i:j], -1)
	if len(tips) < 5 {
		t.Fatalf("найдено только %d советов, разбор сломался?", len(tips))
	}
	per, seen := map[string]int{}, map[string]bool{}
	for _, m := range tips {
		id, tab, sel := m[1], m[2], m[3]
		if seen[id] {
			t.Errorf("совет %q повторяется", id)
		}
		seen[id] = true
		per[tab]++
		if !strings.Contains(tabsLine, "'"+tab+"'") {
			t.Errorf("совет %s: вкладки %s нет в TIP_TABS", id, tab)
		}
		if !strings.Contains(string(page), `id="`+sel+`"`) {
			t.Errorf("совет %s: в index.html нет #%s", id, sel)
		}
		for _, lang := range []string{langRU, langEN} {
			if _, ok := pageDict()[lang]["tip."+id]; !ok {
				t.Errorf("%s: нет текста tip.%s", lang, id)
			}
		}
	}
	for tab, n := range per {
		if n > 3 {
			t.Errorf("на вкладке %s %d советов, нужно не больше 3", tab, n)
		}
	}
	for _, k := range []string{"tip.mark", "learn.tips", "learn.tipsHint", "tour.new"} {
		for _, lang := range []string{langRU, langEN} {
			if _, ok := pageDict()[lang][k]; !ok {
				t.Errorf("%s: нет ключа %s", lang, k)
			}
		}
	}
}
