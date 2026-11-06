package main

// Точка входа: запуск сервера, окна и завершение работы.

import (
	"crypto/rand"
	"encoding/hex"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	hide(cmd)
	cmd.Start()
}

// stopAll: останавливает конвертацию и чистит временные копии (при закрытии программы)
func (s *Server) stopAll() {
	s.mu.Lock()
	c := s.cancel
	s.mu.Unlock()
	if c != nil {
		c()
		for i := 0; i < 40; i++ { // даём ffmpeg завершиться и удалить недоделанные файлы
			time.Sleep(50 * time.Millisecond)
			s.mu.Lock()
			r := s.running
			s.mu.Unlock()
			if !r {
				break
			}
		}
	}
	if s.ownsDrop {
		os.RemoveAll(dropDir())
		os.RemoveAll(subsDir())
		proxyCleanup()
	}
}

// idleExit: в браузерном режиме выключаемся, если вкладку закрыли
func (s *Server) idleExit() {
	for {
		time.Sleep(5 * time.Second)
		s.mu.Lock()
		idle := !s.running && !s.dl.Active && time.Since(s.last) > 150*time.Second
		s.mu.Unlock()
		if idle {
			s.stopAll()
			os.Exit(0)
		}
	}
}

func startServer() *Server {
	tok := make([]byte, 16)
	rand.Read(tok)

	fixed := true
	ln, err := net.Listen("tcp", "127.0.0.1:47831")
	// после обновления прошлая версия ещё закрывается и держит порт — ждём её
	for i := 0; err != nil && hasArg("--updated") && i < 40; i++ {
		time.Sleep(250 * time.Millisecond)
		ln, err = net.Listen("tcp", "127.0.0.1:47831")
	}
	if err != nil {
		fixed = false
		ln, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			os.Exit(1)
		}
	}
	if fixed { // чистим хвосты от прошлого запуска (только если нет другого живого экземпляра)
		migrateData()
		os.RemoveAll(dropDir())
		os.RemoveAll(subsDir())
	}
	inst := installInfo()
	prevInstalled := "" // запись об установке afterUpdate перепишет, а прошлая версия нужна для «Что нового»
	if inst.Installed {
		prevInstalled = inst.Version
	}
	s := &Server{token: hex.EncodeToString(tok), host: ln.Addr().String(), ownsDrop: fixed, last: time.Now(), ffmpeg: findFFmpeg(),
		settings: loadSettings(), inst: afterUpdate(inst)}
	s.initNews(prevInstalled, hasArg("--updated"))
	s.addLog("%s %s", tr("app.name"), appVersion)
	go s.checkFFmpeg()
	go s.checkApp()
	go s.watchUpdates()
	go http.Serve(ln, s.routes())
	return s
}

func (s *Server) url() string { return "http://" + s.host + "/" }

func hasArg(a string) bool {
	for _, x := range os.Args[1:] {
		if x == a {
			return true
		}
	}
	return false
}

func main() {
	setLang(loadSettings().Lang)
	if len(os.Args) > 1 && os.Args[1] == "--uninstall" {
		runUninstall()
		return
	}
	paths := argPaths()
	// программа уже открыта: файлы туда, окно наверх. После обновления прошлая версия ещё закрывается, её не трогаем
	if !hasArg("--updated") && activateRunning(paths) {
		return
	}
	s := startServer()
	go s.addIncoming(paths)
	runUI(s) // окно программы (Windows) или вкладка браузера
}

// argPaths: файлы и папки из командной строки («Отправить», перетаскивание на значок).
// Пути полные: у второго запуска своя рабочая папка.
func argPaths() []string {
	var out []string
	for _, a := range os.Args[1:] {
		if strings.HasPrefix(a, "--") {
			continue
		}
		if abs, err := filepath.Abs(a); err == nil {
			out = append(out, abs)
		}
	}
	return out
}
