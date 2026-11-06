package main

// HTTP: отдача страницы и картинок, все ручки /api/*.

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(v)
}

func (s *Server) api(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Host != s.host || r.Header.Get("X-Token") != s.token {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		s.mu.Lock()
		s.last = time.Now()
		s.mu.Unlock()
		h(w, r)
	}
}

func (s *Server) routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" || r.Host != s.host {
			http.NotFound(w, r)
			return
		}
		s.mu.Lock()
		s.last = time.Now()
		theme, lang := normTheme(s.settings.Theme), normLang(s.settings.Lang)
		s.mu.Unlock()
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		// __VER__ в адресах картинок: после обновления окно не покажет старые из своего кэша
		strings.NewReplacer("__TOKEN__", s.token, "__THEME__", theme, "__VER__", appVersion).WriteString(w, pages[lang])
	})

	mux.HandleFunc("/favicon.png", func(w http.ResponseWriter, r *http.Request) {
		if r.Host != s.host {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Cache-Control", "max-age=86400")
		w.Write(faviconPNG)
	})

	mux.HandleFunc("/thumb", s.thumbHandler)
	mux.HandleFunc("/wave", s.waveHandler)
	mux.HandleFunc("/media", s.mediaHandler)

	mux.HandleFunc("/api/info", s.api(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Path string `json:"path"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		s.mu.Lock()
		ffm := s.ffmpeg
		s.mu.Unlock()
		if ffm == "" {
			writeJSON(w, MediaInfo{Error: tr("err.ffmpegMissing")})
			return
		}
		writeJSON(w, getMediaInfo(ffm, body.Path))
	}))

	// копия для просмотра того, что проигрыватель не умеет: первый запрос запускает, следующие узнают процент
	mux.HandleFunc("/api/proxy", s.api(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Path string `json:"path"`
			proxyPiece
		}
		json.NewDecoder(r.Body).Decode(&body)
		s.mu.Lock()
		ffm := s.ffmpeg
		s.mu.Unlock()
		if ffm == "" || !mediaExt[strings.ToLower(filepath.Ext(body.Path))] {
			writeJSON(w, ProxyState{Error: tr("media.noPlayback")})
			return
		}
		writeJSON(w, proxyStatus(ffm, body.Path, body.proxyPiece))
	}))

	mux.HandleFunc("/api/proxy-stop", s.api(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Path string `json:"path"`
			proxyPiece
		}
		json.NewDecoder(r.Body).Decode(&body)
		proxyStop(body.Path, body.proxyPiece)
		writeJSON(w, map[string]any{"ok": true})
	}))

	// сколько места занимают копии и кнопка, которая их удаляет
	mux.HandleFunc("/api/proxy-usage", s.api(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"bytes": proxyUsage()})
	}))

	mux.HandleFunc("/api/proxy-clear", s.api(func(w http.ResponseWriter, r *http.Request) {
		proxyClear()
		writeJSON(w, map[string]any{"bytes": proxyUsage()})
	}))

	mux.HandleFunc("/api/snapshot-montage", s.api(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Project Project `json:"project"`
			At      float64 `json:"at"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		s.mu.Lock()
		ffm := s.ffmpeg
		s.mu.Unlock()
		if ffm == "" {
			writeJSON(w, map[string]any{"error": tr("snap.noFrame")})
			return
		}
		p, err := saveMontFrame(ffm, body.Project, body.At)
		if err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, map[string]any{"name": filepath.Base(p), "dir": filepath.Dir(p)})
	}))

	mux.HandleFunc("/api/snapshot", s.api(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Path  string  `json:"path"`
			At    float64 `json:"at"`
			Proxy bool    `json:"proxy"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		s.mu.Lock()
		ffm := s.ffmpeg
		s.mu.Unlock()
		if ffm == "" || !mediaExt[strings.ToLower(filepath.Ext(body.Path))] {
			writeJSON(w, map[string]any{"error": tr("snap.noFrame")})
			return
		}
		p, err := saveFrame(ffm, body.Path, body.At, body.Proxy)
		if err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, map[string]any{"name": filepath.Base(p), "dir": filepath.Dir(p)})
	}))

	mux.HandleFunc("/api/state", s.api(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		incoming := s.incoming
		project := s.incomingProject
		s.incomingProject = ""
		s.incoming = nil
		writeJSON(w, map[string]any{
			"incoming":   incoming,
			"project":    project,
			"batchSeq":   s.batchSeq,
			"ffmpeg":     s.ffmpeg,
			"dl":         s.dl,
			"running":    s.running,
			"files":      s.files,
			"log":        s.log,
			"summary":    s.summary,
			"batch":      s.batch,
			"banner":     bannerNames,
			"defaultOut": defaultOut(),
			"ffv":        s.ffv,
			"appUpd":     s.appUpd,
			"news":       s.news,
			"newsEn":     s.newsEn,
			"app": map[string]any{
				"version":   appVersion,
				"install":   s.inst,
				"setupSeen": s.settings.SetupDeclined == appVersion,
			},
		})
	}))

	// настройки интерфейса: что пришло, то сохраняется; пустой запрос только читает.
	// Новая настройка — ещё одно поле с указателем (нет поля = не менять).
	mux.HandleFunc("/api/settings", s.api(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Theme *string `json:"theme"`
			Lang  *string `json:"lang"`
			Reset bool    `json:"reset"` // кнопка «Сбросить настройки»: язык и отметки об обновлениях остаются
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil && err != io.EOF {
			writeJSON(w, map[string]any{"error": tr("err.badRequest")})
			return
		}
		if body.Theme != nil && !validTheme(*body.Theme) {
			writeJSON(w, map[string]any{"error": tr("err.unknownTheme")})
			return
		}
		if body.Lang != nil && !validLang(*body.Lang) {
			writeJSON(w, map[string]any{"error": tr("err.unknownLang")})
			return
		}
		s.mu.Lock()
		var saveErr error
		if body.Theme != nil {
			s.settings.Theme = *body.Theme
		}
		if body.Lang != nil {
			s.settings.Lang = *body.Lang
			setLang(*body.Lang)
		}
		if body.Reset {
			s.settings.Theme, s.settings.BannerJpgRel, s.settings.BannerWebpRel = "", "", ""
		}
		if body.Theme != nil || body.Lang != nil || body.Reset {
			saveErr = saveSettings(s.settings) // под замком: быстрые переключения не перепутают порядок записи
		}
		theme, lang := normTheme(s.settings.Theme), normLang(s.settings.Lang)
		s.mu.Unlock()
		if body.Theme != nil || body.Reset {
			windowThemeChanged()
		}
		if body.Lang != nil {
			windowLangChanged()
		}
		if saveErr != nil {
			writeJSON(w, map[string]any{"error": saveErr.Error(), "theme": theme, "lang": lang})
			return
		}
		writeJSON(w, map[string]any{"ok": true, "theme": theme, "lang": lang})
	}))

	mux.HandleFunc("/api/download-ffmpeg", s.api(func(w http.ResponseWriter, r *http.Request) {
		if err := s.downloadFFmpeg(); err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, map[string]any{"ok": true})
	}))

	// «пропустить эту версию ffmpeg»
	mux.HandleFunc("/api/ffmpeg-skip", s.api(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.settings.SkipFFmpeg = s.ffv.Latest
		st := s.settings
		s.refreshFFLocked()
		s.mu.Unlock()
		saveSettings(st)
		writeJSON(w, map[string]any{"ok": true})
	}))

	// новая версия программы: скачать, заменить себя и перезапуститься
	mux.HandleFunc("/api/app-update", s.api(func(w http.ResponseWriter, r *http.Request) {
		if err := s.updateApp(); err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, map[string]any{"ok": true})
	}))

	mux.HandleFunc("/api/app-skip", s.api(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.settings.SkipApp = s.appUpd.Latest
		st := s.settings
		s.refreshAppLocked()
		s.mu.Unlock()
		saveSettings(st)
		writeJSON(w, map[string]any{"ok": true})
	}))

	mux.HandleFunc("/api/news-seen", s.api(func(w http.ResponseWriter, r *http.Request) {
		if err := s.newsSeen(); err != nil {
			s.addLog("news-seen: %v", err)
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, map[string]any{"ok": true})
	}))

	// установка на компьютер (+ по желанию скачать/обновить ffmpeg)
	mux.HandleFunc("/api/install", s.api(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Desktop bool `json:"desktop"`
			FFmpeg  bool `json:"ffmpeg"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if err := doInstall(body.Desktop); err != nil {
			s.logT("log.install", err)
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		inst := installInfo()
		s.mu.Lock()
		s.inst = inst
		s.mu.Unlock()
		s.logT("log.installed", inst.Dir)
		res := map[string]any{"ok": true, "dir": inst.Dir}
		if body.FFmpeg {
			if err := s.downloadFFmpeg(); err != nil {
				res["ffError"] = err.Error()
			}
		}
		writeJSON(w, res)
	}))

	// «без установки»: больше не спрашивать (до следующей версии программы)
	mux.HandleFunc("/api/setup-later", s.api(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.settings.SetupDeclined = appVersion
		st := s.settings
		s.mu.Unlock()
		saveSettings(st)
		writeJSON(w, map[string]any{"ok": true})
	}))

	mux.HandleFunc("/api/pick-files", s.api(func(w http.ResponseWriter, r *http.Request) {
		paths, err := pickFiles()
		res := map[string]any{"files": infos(paths)}
		if err != nil {
			res["error"] = err.Error()
		}
		writeJSON(w, res)
	}))

	mux.HandleFunc("/api/pick-folder", s.api(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Purpose string `json:"purpose"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		dir, err := pickFolder()
		res := map[string]any{}
		if err != nil {
			res["error"] = err.Error()
		} else if dir != "" {
			if body.Purpose == "add" {
				res["files"] = walkMedia(dir)
			} else {
				res["path"] = dir
			}
		}
		writeJSON(w, res)
	}))

	mux.HandleFunc("/api/sounds", s.api(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"sounds": systemSounds()})
	}))

	mux.HandleFunc("/api/pick-sound", s.api(func(w http.ResponseWriter, r *http.Request) {
		p, err := pickSound()
		res := map[string]any{"path": p}
		if err != nil {
			res["error"] = err.Error()
		}
		writeJSON(w, res)
	}))

	// перетащенные в окно файлы: копируем во временную папку
	mux.HandleFunc("/api/upload", s.api(func(w http.ResponseWriter, r *http.Request) {
		name := safeName(r.URL.Query().Get("name"))
		sub := make([]byte, 6)
		rand.Read(sub)
		dir := filepath.Join(dropDir(), hex.EncodeToString(sub))
		if err := os.MkdirAll(dir, 0o755); err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		dst := filepath.Join(dir, name)
		f, err := os.Create(dst)
		if err != nil {
			os.RemoveAll(dir)
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		n, err := io.Copy(f, r.Body)
		f.Close()
		if err != nil {
			os.RemoveAll(dir)
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, FileInfo{Path: dst, Size: n})
	}))

	mux.HandleFunc("/api/discard", s.api(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Paths []string `json:"paths"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		for _, p := range body.Paths {
			cleanupTemp(p)
		}
		writeJSON(w, map[string]any{"ok": true})
	}))

	mux.HandleFunc("/api/start", s.api(func(w http.ResponseWriter, r *http.Request) {
		var req StartReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, map[string]any{"error": tr("err.badRequest")})
			return
		}
		if _, ok := formats[req.Format]; !ok || len(req.Files) == 0 {
			writeJSON(w, map[string]any{"error": tr("err.noFilesOrFormat")})
			return
		}
		ffm, err := s.begin(tr("err.busyConvert"))
		if err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		go s.run(req, ffm)
		writeJSON(w, map[string]any{"ok": true, "joined": joinLeads(req)})
	}))

	// файл проекта монтажа: path пустой — сначала спросить, куда сохранить
	mux.HandleFunc("/api/project-save", s.api(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Path string          `json:"path"`
			Data json.RawMessage `json:"data"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, map[string]any{"error": tr("err.badRequest")})
			return
		}
		path := body.Path
		if path == "" {
			p, err := pickProjectSave()
			if err != nil {
				writeJSON(w, map[string]any{"error": err.Error()})
				return
			}
			if p == "" {
				writeJSON(w, map[string]any{})
				return
			}
			path = p
		}
		path, err := writeProject(path, body.Data)
		if err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, map[string]any{"path": path})
	}))

	mux.HandleFunc("/api/whisper-info", s.api(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, whisperInstalled())
	}))

	mux.HandleFunc("/api/whisper-state", s.api(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, whisperState())
	}))

	mux.HandleFunc("/api/whisper-start", s.api(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Project Project `json:"project"`
			Model   string  `json:"model"`
			Lang    string  `json:"lang"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		s.mu.Lock()
		ffm := s.ffmpeg
		s.mu.Unlock()
		if err := whisperStart(ffm, body.Project, body.Model, body.Lang); err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, whisperState())
	}))

	mux.HandleFunc("/api/whisper-cancel", s.api(func(w http.ResponseWriter, r *http.Request) {
		whisperStop()
		writeJSON(w, map[string]any{})
	}))

	mux.HandleFunc("/api/fonts", s.api(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"fonts": systemFonts()})
	}))

	// Картинка клипа «Текст»: её рисует страница, потому что только она знает все шрифты и письмо справа налево
	mux.HandleFunc("/api/text-png", s.api(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Data string `json:"data"`
		}
		json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<20)).Decode(&body)
		path, fresh, err := saveTextPNG(body.Data)
		if err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, map[string]any{"path": path, "fresh": fresh})
	}))

	mux.HandleFunc("/api/subs-pick", s.api(func(w http.ResponseWriter, r *http.Request) {
		path, err := pickSubs()
		if err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, map[string]any{"path": path})
	}))

	mux.HandleFunc("/api/subs-save", s.api(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Cues []SubCue `json:"cues"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		path, err := pickSubsSave()
		if err == nil && path != "" {
			err = os.WriteFile(path, []byte(subsSRT(subsRange(body.Cues, 0, math.MaxFloat64))), 0o644)
		}
		if err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, map[string]any{"path": path})
	}))

	mux.HandleFunc("/api/subs-read", s.api(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Path string `json:"path"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		cues, err := subsRead(body.Path)
		if err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, map[string]any{"cues": cues})
	}))

	mux.HandleFunc("/api/project-open", s.api(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Path string `json:"path"` // файл открыли снаружи; пусто — спросить
		}
		json.NewDecoder(r.Body).Decode(&body)
		path, err := body.Path, error(nil)
		if path == "" {
			path, err = pickProjectOpen()
		}
		if err == nil && path == "" {
			writeJSON(w, map[string]any{})
			return
		}
		var data []byte
		if err == nil {
			data, err = readProject(path)
		}
		if err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, map[string]any{"path": path, "data": json.RawMessage(data)})
	}))

	mux.HandleFunc("/api/banners", s.api(func(w http.ResponseWriter, r *http.Request) {
		var req BannerReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, map[string]any{"error": tr("err.badRequest")})
			return
		}
		req.JpgDir, req.WebpDir = strings.TrimSpace(req.JpgDir), strings.TrimSpace(req.WebpDir)
		if req.AutoDirs {
			d, ok := s.bannerDirsNow(req.Files)
			if !ok {
				writeJSON(w, map[string]any{"error": tr("err.bannerNoSource")})
				return
			}
			req.JpgDir, req.WebpDir = d.JpgDir, d.WebpDir
		}
		switch {
		case len(req.Files) == 0:
			writeJSON(w, map[string]any{"error": tr("err.noFiles")})
			return
		case req.JpgDir == "" || req.WebpDir == "":
			writeJSON(w, map[string]any{"error": tr("err.pickBannerDirs")})
			return
		}
		ffm, err := s.begin(tr("err.busyBanner"))
		if err != nil {
			writeJSON(w, map[string]any{"error": err.Error()})
			return
		}
		s.rememberBannerDirs(req.Files, req.JpgDir, req.WebpDir)
		go s.runBanners(req, ffm)
		writeJSON(w, map[string]any{"ok": true, "jpgDir": req.JpgDir, "webpDir": req.WebpDir})
	}))

	// где папки JPEG и WebP для этих PNG; jpgDir и webpDir в запросе — их только что выбрали, запомнить
	mux.HandleFunc("/api/banner-dirs", s.api(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Files   []string `json:"files"`
			JpgDir  string   `json:"jpgDir"`
			WebpDir string   `json:"webpDir"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		s.rememberBannerDirs(body.Files, strings.TrimSpace(body.JpgDir), strings.TrimSpace(body.WebpDir))
		d, _ := s.bannerDirsNow(body.Files)
		writeJSON(w, d)
	}))

	mux.HandleFunc("/api/cancel", s.api(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		if s.cancel != nil {
			s.cancel()
		}
		s.mu.Unlock()
		writeJSON(w, map[string]any{"ok": true})
	}))

	mux.HandleFunc("/api/open-output", s.api(func(w http.ResponseWriter, r *http.Request) {
		dir := ""
		s.mu.Lock()
		for _, fs := range s.files {
			if fs.Status == "ok" && fs.Dst != "" {
				dir = filepath.Dir(fs.Dst)
				break
			}
		}
		s.mu.Unlock()
		if dir == "" {
			writeJSON(w, map[string]any{"error": tr("err.noDoneFiles")})
			return
		}
		openFolder(dir)
		writeJSON(w, map[string]any{"ok": true})
	}))

	mux.HandleFunc("/api/open-dir", s.api(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Path string `json:"path"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if st, err := os.Stat(body.Path); err != nil || !st.IsDir() {
			writeJSON(w, map[string]any{"error": tr("err.noFolder")})
			return
		}
		openFolder(body.Path)
		writeJSON(w, map[string]any{"ok": true})
	}))

	mux.HandleFunc("/api/open-data", s.api(func(w http.ResponseWriter, r *http.Request) {
		os.MkdirAll(dataDir(), 0o755)
		openFolder(dataDir())
		writeJSON(w, map[string]any{"ok": true})
	}))

	mux.HandleFunc("/api/session", s.api(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"crashed": lastCrashed})
	}))

	mux.HandleFunc("/api/close-ack", s.api(func(w http.ResponseWriter, r *http.Request) {
		closeAck()
		writeJSON(w, map[string]any{"ok": true})
	}))

	mux.HandleFunc("/api/close-go", s.api(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"ok": true})
		closeFromPage()
	}))

	mux.HandleFunc("/api/exit", s.api(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"ok": true})
		go func() {
			time.Sleep(200 * time.Millisecond)
			s.stopAll()
			markStopped()
			os.Exit(0)
		}()
	}))
	return mux
}
