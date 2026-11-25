package main

// Обучающие туры по вкладкам (web/js/tour.js). Учёт по шагам, а не по версиям:
// в настройках лежат id показанных шагов, поэтому после долгого перерыва и многих обновлений
// человек увидит всё новое, а уже виденное не повторится.

import (
	"encoding/json"
	"io"
	"net/http"
	"sort"
)

type TourState struct {
	Seen     []string       `json:"seen,omitempty"`     // id шагов, до которых дошли
	Declined map[string]int `json:"declined,omitempty"` // вкладка → сколько раз тур закрыли, не досмотрев
	Off      bool           `json:"off,omitempty"`      // автопоказ выключен (кроме шагов must)
	Fresh    bool           `json:"fresh,omitempty"`    // новая установка: страница отметит шаги «new» просмотренными
	Gen      int            `json:"gen,omitempty"`      // растёт при «Сбросить всё»: старый список с диска не возвращается
}

// initTours при запуске: первая версия с турами. Новая установка (ещё ни разу не показывали «Что нового»)
// получает отметку Fresh: новинки для неё не новинки. У прежних пользователей всё непросмотрено.
func (s *Server) initTours() {
	if s.settings.Tours != nil {
		return
	}
	s.settings.Tours = &TourState{Fresh: s.settings.SeenVersion == ""}
	saveSettings(s.settings)
}

// mergeTours: другая открытая копия программы могла отметить шаги — просмотренное не теряем
func mergeTours(disk, mem *TourState) *TourState {
	if disk == nil || mem == nil {
		if mem == nil {
			return disk
		}
		return mem
	}
	if disk.Gen != mem.Gen { // между ними был сброс: верен более новый
		if disk.Gen > mem.Gen {
			return disk
		}
		return mem
	}
	out := *mem
	set := map[string]bool{}
	for _, id := range append(append([]string{}, mem.Seen...), disk.Seen...) {
		set[id] = true
	}
	out.Seen = make([]string, 0, len(set))
	for id := range set {
		out.Seen = append(out.Seen, id)
	}
	sort.Strings(out.Seen)
	out.Declined = map[string]int{}
	for k, v := range disk.Declined {
		out.Declined[k] = v
	}
	for k, v := range mem.Declined {
		if v > out.Declined[k] {
			out.Declined[k] = v
		}
	}
	return &out
}

func (s *Server) toursRoute(mux *http.ServeMux) {
	// пустой запрос только читает. seen — добавить показанные шаги, decline — тур на вкладке закрыли,
	// fresh — отметка новой установки обработана, auto — тумблер автопоказа, reset — «Сбросить всё»
	mux.HandleFunc("/api/tours", s.api(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Seen    []string `json:"seen"`
			Decline string   `json:"decline"`
			Fresh   bool     `json:"freshDone"`
			Auto    *bool    `json:"auto"`
			Reset   bool     `json:"reset"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil && err != io.EOF {
			writeJSON(w, map[string]any{"error": tr("err.badRequest")})
			return
		}
		s.mu.Lock()
		ts := s.settings.Tours
		if ts == nil {
			ts = &TourState{}
			s.settings.Tours = ts
		}
		changed := false
		if body.Reset {
			// «Сбросить всё»: туры заново; новые установки тоже видят новинки
			*ts = TourState{Off: ts.Off, Gen: ts.Gen + 1}
			changed = true
		}
		have := map[string]bool{}
		for _, id := range ts.Seen {
			have[id] = true
		}
		for _, id := range body.Seen {
			if id != "" && len(id) <= 80 && !have[id] {
				ts.Seen = append(ts.Seen, id)
				have[id] = true
				changed = true
			}
		}
		if body.Decline != "" && len(body.Decline) <= 20 {
			if ts.Declined == nil {
				ts.Declined = map[string]int{}
			}
			ts.Declined[body.Decline]++
			changed = true
		}
		if body.Fresh && ts.Fresh {
			ts.Fresh = false
			changed = true
		}
		if body.Auto != nil && ts.Off == *body.Auto {
			ts.Off = !*body.Auto
			changed = true
		}
		var err error
		if changed {
			err = saveSettings(s.settings)
		}
		out := *ts
		s.mu.Unlock()
		res := map[string]any{"ok": err == nil, "tours": out}
		if err != nil {
			res["error"] = err.Error()
		}
		writeJSON(w, res)
	}))
}
