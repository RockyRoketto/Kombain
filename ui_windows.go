//go:build windows

package main

// Своё окно программы на WebView2 (встроенный в Windows движок Edge).
// Зачем: только так при перетаскивании видны настоящие пути файлов,
// и диалоги выбора открываются поверх окна, а не где-то за браузером.
// Если WebView2 нет, программа откроется во вкладке браузера, как раньше.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	"github.com/wailsapp/go-webview2/pkg/edge"
	"github.com/wailsapp/go-webview2/webviewloader"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

func init() { runtime.LockOSThread() } // окно и COM живут в главном потоке

var (
	user32   = windows.NewLazySystemDLL("user32.dll")
	gdi32    = windows.NewLazySystemDLL("gdi32.dll")
	ole32    = windows.NewLazySystemDLL("ole32.dll")
	kernel32 = windows.NewLazySystemDLL("kernel32.dll")
	dwmapi   = windows.NewLazySystemDLL("dwmapi.dll")

	pRegisterClassExW         = user32.NewProc("RegisterClassExW")
	pCreateWindowExW          = user32.NewProc("CreateWindowExW")
	pDefWindowProcW           = user32.NewProc("DefWindowProcW")
	pDestroyWindow            = user32.NewProc("DestroyWindow")
	pShowWindow               = user32.NewProc("ShowWindow")
	pUpdateWindow             = user32.NewProc("UpdateWindow")
	pGetMessageW              = user32.NewProc("GetMessageW")
	pTranslateMessage         = user32.NewProc("TranslateMessage")
	pDispatchMessageW         = user32.NewProc("DispatchMessageW")
	pPostMessageW             = user32.NewProc("PostMessageW")
	pPostQuitMessage          = user32.NewProc("PostQuitMessage")
	pLoadImageW               = user32.NewProc("LoadImageW")
	pLoadCursorW              = user32.NewProc("LoadCursorW")
	pGetSystemMetrics         = user32.NewProc("GetSystemMetrics")
	pGetDpiForSystem          = user32.NewProc("GetDpiForSystem")
	pGetDpiForWindow          = user32.NewProc("GetDpiForWindow")
	pSetForegroundWindow      = user32.NewProc("SetForegroundWindow")
	pGetForegroundWindow      = user32.NewProc("GetForegroundWindow")
	pGetWindowThreadProcessId = user32.NewProc("GetWindowThreadProcessId")
	pAttachThreadInput        = user32.NewProc("AttachThreadInput")
	pMessageBoxW              = user32.NewProc("MessageBoxW")
	pSetWindowPos             = user32.NewProc("SetWindowPos")
	pGetWindowPlacement       = user32.NewProc("GetWindowPlacement")
	pSetWindowPlacement       = user32.NewProc("SetWindowPlacement")
	pMonitorFromRect          = user32.NewProc("MonitorFromRect")
	pGetMonitorInfoW          = user32.NewProc("GetMonitorInfoW")
	pSetClassLongPtrW         = user32.NewProc("SetClassLongPtrW")
	pSetWindowTextW           = user32.NewProc("SetWindowTextW")
	pFindWindowW              = user32.NewProc("FindWindowW")
	pIsIconic                 = user32.NewProc("IsIconic")
	pSendMessageTimeoutW      = user32.NewProc("SendMessageTimeoutW")
	pCreateSolidBrush         = gdi32.NewProc("CreateSolidBrush")
	pCoInitializeEx           = ole32.NewProc("CoInitializeEx")
	pCoCreateInstance         = ole32.NewProc("CoCreateInstance")
	pCoTaskMemFree            = ole32.NewProc("CoTaskMemFree")
	pGetModuleHandleW         = kernel32.NewProc("GetModuleHandleW")
	pGetCurrentThreadId       = kernel32.NewProc("GetCurrentThreadId")
	pDwmSetWindowAttribute    = dwmapi.NewProc("DwmSetWindowAttribute")
)

const (
	wsOverlappedWindow = 0x00CF0000
	wsPopup            = 0x80000000
	wsExToolWindow     = 0x00000080
	wsExTopmost        = 0x00000008
	swHide             = 0
	swShowNormal       = 1
	swShowMinimized    = 2
	swShowMaximized    = 3
	swShow             = 5
	wpfRestoreMax      = 2
	swRestore          = 9
	wmCopyData         = 0x004A
	smtoAbortIfHung    = 0x0002
	windowClass        = "Konvertor9000"
	wmDestroy          = 0x0002
	wmMove             = 0x0003
	wmSize             = 0x0005
	wmSetFocus         = 0x0007
	wmClose            = 0x0010
	wmSettingChange    = 0x001A
	wmGetMinMaxInfo    = 0x0024
	wmMoving           = 0x0216
	swpNoSize          = 0x0001
	swpNoMove          = 0x0002
	swpNoZOrder        = 0x0004
	swpNoActivate      = 0x0010
	swpFrameChanged    = 0x0020
	gclpHbrBackground  = ^uintptr(9) // GCLP_HBRBACKGROUND (-10)
	wmAppCall          = 0x8001
	imageIcon          = 1
	smCxScreen         = 0
	smCyScreen         = 1
	smCxIcon           = 11
	smCyIcon           = 12
	smCxSmIcon         = 49
	smCySmIcon         = 50
	mbYesNo            = 0x04
	mbIconQuestion     = 0x20
	idYes              = 6
)

type wndClassEx struct {
	Size       uint32
	Style      uint32
	WndProc    uintptr
	ClsExtra   int32
	WndExtra   int32
	Instance   uintptr
	Icon       uintptr
	Cursor     uintptr
	Background uintptr
	MenuName   *uint16
	ClassName  *uint16
	IconSm     uintptr
}

type winMsg struct {
	Hwnd     uintptr
	Message  uint32
	WParam   uintptr
	LParam   uintptr
	Time     uint32
	PtX, PtY int32
	LPrivate uint32
}

var (
	srv         *Server
	mainHwnd    uintptr
	hInstance   uintptr
	chromium    *edge.Chromium
	webReady    atomic.Bool
	browserMode atomic.Bool
	uiQueue     = make(chan func(), 64)

	themeBrushes [2]uintptr
	windowThemed bool // тема окна уже применялась
	windowLight  bool // окно сейчас светлое
)

func u16(s string) *uint16 { p, _ := windows.UTF16PtrFromString(s); return p }

func dpiScale(v int) int {
	dpi := uintptr(96)
	if pGetDpiForWindow.Find() == nil && mainHwnd != 0 {
		if d, _, _ := pGetDpiForWindow.Call(mainHwnd); d != 0 {
			dpi = d
		}
	} else if pGetDpiForSystem.Find() == nil {
		if d, _, _ := pGetDpiForSystem.Call(); d != 0 {
			dpi = d
		}
	}
	return v * int(dpi) / 96
}

// runOnUI выполняет функцию в главном (оконном) потоке
func runOnUI(f func()) {
	uiQueue <- f
	pPostMessageW.Call(mainHwnd, wmAppCall, 0, 0)
}

// closeAcked: страница услышала просьбу закрыться и сама скажет, когда можно
var closeAcked atomic.Bool

func closeAck() { closeAcked.Store(true) }

func closeWindow() {
	saveWindowPlace()
	pDestroyWindow.Call(mainHwnd)
}

func closeFromPage() { runOnUI(closeWindow) }

func wndProc(hwnd, msg, wp, lp uintptr) uintptr {
	switch msg {
	case wmAppCall:
		for {
			select {
			case f := <-uiQueue:
				f()
			default:
				return 0
			}
		}
	case wmSize:
		if webReady.Load() {
			chromium.Resize()
		}
	case wmMove, wmMoving:
		if webReady.Load() {
			chromium.NotifyParentWindowPositionChanged()
		}
	case wmSetFocus:
		if webReady.Load() {
			chromium.Focus()
		}
	case wmCopyData:
		receivePaths((*copyData)(unsafe.Pointer(lp)))
		return 1
	case wmSettingChange:
		applyWindowTheme() // могли сменить тему Windows
	case wmGetMinMaxInfo:
		// MINMAXINFO.ptMinTrackSize лежит по смещению 24
		mm := (*[10]int32)(unsafe.Pointer(lp))
		mm[6] = int32(dpiScale(760))
		mm[7] = int32(dpiScale(600))
		return 0
	case wmClose:
		running := false
		if srv != nil {
			srv.mu.Lock()
			running = srv.running
			srv.mu.Unlock()
			if running {
				r, _, _ := pMessageBoxW.Call(hwnd,
					uintptr(unsafe.Pointer(u16(tr("ui.closeAsk")))),
					uintptr(unsafe.Pointer(u16(tr("app.name")))), mbYesNo|mbIconQuestion)
				if r != idYes {
					return 0
				}
			}
		}
		if !webReady.Load() {
			closeWindow()
			return 0
		}
		// Про несохранённое спрашивает страница. Не ответила (не загрузилась, зависла) — закрываем сами.
		closeAcked.Store(false)
		chromium.Eval(fmt.Sprintf("window.__konvClose && window.__konvClose(%t)", running))
		go func() {
			time.Sleep(4 * time.Second) // занятая страница отвечает не сразу, а без вопроса пропадёт работа
			if !closeAcked.Load() {
				runOnUI(closeWindow)
			}
		}()
		return 0
	case wmDestroy:
		pPostQuitMessage.Call(0)
		return 0
	}
	r, _, _ := pDefWindowProcW.Call(hwnd, msg, wp, lp)
	return r
}

// ---------- второй запуск: файлы и подъём окна в уже открытой программе ----------

// copyData — структура COPYDATASTRUCT; в Data лежит JSON со списком путей
type copyData struct {
	Kind uintptr
	Size uint32
	Data *byte
}

// activateRunning передаёт пути уже открытой программе и поднимает её окно.
// false: окна нет, или это старая версия, которая таких сообщений не понимает.
func activateRunning(paths []string) bool {
	h, _, _ := pFindWindowW.Call(uintptr(unsafe.Pointer(u16(windowClass))), 0)
	if h == 0 {
		return false
	}
	if paths == nil {
		paths = []string{}
	}
	b, err := json.Marshal(paths)
	if err != nil {
		return false
	}
	cd := copyData{Size: uint32(len(b)), Data: &b[0]}
	var res uintptr
	r, _, _ := pSendMessageTimeoutW.Call(h, wmCopyData, 0, uintptr(unsafe.Pointer(&cd)), smtoAbortIfHung, 5000, uintptr(unsafe.Pointer(&res)))
	if r == 0 || res == 0 {
		return false
	}
	if iconic, _, _ := pIsIconic.Call(h); iconic != 0 {
		pShowWindow.Call(h, swRestore)
	}
	pSetForegroundWindow.Call(h) // поднять может только тот, кого запустил пользователь, то есть этот процесс
	return true
}

// receivePaths: сообщение второго запуска в оконном потоке. Данные живут только до выхода из обработчика.
func receivePaths(cd *copyData) {
	var paths []string
	if cd.Size > 0 && cd.Data != nil {
		json.Unmarshal(unsafe.Slice(cd.Data, cd.Size), &paths)
	}
	if srv != nil {
		go srv.addIncoming(paths)
		if browserMode.Load() { // окна нет, программа живёт во вкладке браузера
			openBrowser(srv.url())
		}
	}
}

func createMainWindow() {
	hInstance, _, _ = pGetModuleHandleW.Call(0)
	cursor, _, _ := pLoadCursorW.Call(0, 32512) // IDC_ARROW
	cx, _, _ := pGetSystemMetrics.Call(smCxIcon)
	cy, _, _ := pGetSystemMetrics.Call(smCyIcon)
	sx, _, _ := pGetSystemMetrics.Call(smCxSmIcon)
	sy, _, _ := pGetSystemMetrics.Call(smCySmIcon)
	icon, _, _ := pLoadImageW.Call(hInstance, uintptr(unsafe.Pointer(u16("APP"))), imageIcon, cx, cy, 0)
	iconSm, _, _ := pLoadImageW.Call(hInstance, uintptr(unsafe.Pointer(u16("APP"))), imageIcon, sx, sy, 0)

	className := u16(windowClass)
	wc := wndClassEx{
		WndProc:    windows.NewCallback(wndProc),
		Instance:   hInstance,
		Icon:       icon,
		Cursor:     cursor,
		Background: themeBrush(windowIsLight()), // фон страницы, чтобы не мигало белым
		ClassName:  className,
		IconSm:     iconSm,
	}
	wc.Size = uint32(unsafe.Sizeof(wc))
	pRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))

	sw, _, _ := pGetSystemMetrics.Call(smCxScreen)
	sh, _, _ := pGetSystemMetrics.Call(smCyScreen)
	w, h := dpiScale(1180), dpiScale(920)
	if w > int(sw)*94/100 {
		w = int(sw) * 94 / 100
	}
	if h > int(sh)*90/100 {
		h = int(sh) * 90 / 100
	}
	x, y := (int(sw)-w)/2, (int(sh)-h)/2

	mainHwnd, _, _ = pCreateWindowExW.Call(0,
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(u16(tr("app.name")))),
		wsOverlappedWindow, uintptr(x), uintptr(y), uintptr(w), uintptr(h), 0, 0, hInstance, 0)

	applyWindowTheme()
}

// ---------- размер и положение окна между запусками, см. winplace.go ----------

// winRect — RECT, windowPlacement — WINDOWPLACEMENT
type winRect struct{ Left, Top, Right, Bottom int32 }

type windowPlacement struct {
	Length, Flags, ShowCmd uint32
	MinX, MinY, MaxX, MaxY int32
	Normal                 winRect
}

// saveWindowPlace запоминает окно. Свёрнутое запоминается таким, каким откроется из панели задач.
func saveWindowPlace() {
	if mainHwnd == 0 || browserMode.Load() {
		return // в браузере окно скрыто, его размер ничего не значит
	}
	wp := windowPlacement{Length: uint32(unsafe.Sizeof(windowPlacement{}))}
	if r, _, _ := pGetWindowPlacement.Call(mainHwnd, uintptr(unsafe.Pointer(&wp))); r == 0 {
		return
	}
	saveWinPlace(winPlace{
		X: wp.Normal.Left, Y: wp.Normal.Top,
		W: wp.Normal.Right - wp.Normal.Left, H: wp.Normal.Bottom - wp.Normal.Top,
		Max: wp.ShowCmd == swShowMaximized || (wp.ShowCmd == swShowMinimized && wp.Flags&wpfRestoreMax != 0),
	})
}

// showMainWindow показывает окно там, где его закрыли. Монитора с этим местом больше нет — там, где создано.
func showMainWindow() {
	p, ok := loadWinPlace()
	if ok {
		r := winRect{p.X, p.Y, p.X + p.W, p.Y + p.H}
		const monitorDefaultToNull = 0
		mon, _, _ := pMonitorFromRect.Call(uintptr(unsafe.Pointer(&r)), monitorDefaultToNull)
		var mi struct {
			Size          uint32
			Monitor, Work winRect
			Flags         uint32
		}
		mi.Size = uint32(unsafe.Sizeof(mi))
		if got, _, _ := pGetMonitorInfoW.Call(mon, uintptr(unsafe.Pointer(&mi))); mon != 0 && got != 0 {
			p = p.fit(mi.Monitor.Left, mi.Monitor.Top, mi.Monitor.Right, mi.Monitor.Bottom, int32(dpiScale(760)), int32(dpiScale(600)))
			wp := windowPlacement{
				Length: uint32(unsafe.Sizeof(windowPlacement{})), ShowCmd: swShowNormal,
				MinX: -1, MinY: -1, MaxX: -1, MaxY: -1,
				Normal: winRect{p.X, p.Y, p.X + p.W, p.Y + p.H},
			}
			if p.Max {
				wp.ShowCmd = swShowMaximized
			}
			if r, _, _ := pSetWindowPlacement.Call(mainHwnd, uintptr(unsafe.Pointer(&wp))); r != 0 {
				return
			}
		}
	}
	pShowWindow.Call(mainHwnd, swShow)
}

// systemIsLight: светлая ли тема приложений в Windows. Страница узнаёт то же самое через prefers-color-scheme.
func systemIsLight() bool {
	k, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`, registry.QUERY_VALUE)
	if err != nil {
		return true // значения нет только там, где тёмной темы нет вообще
	}
	defer k.Close()
	v, _, err := k.GetIntegerValue("AppsUseLightTheme")
	return err != nil || v != 0
}

func windowIsLight() bool {
	srv.mu.Lock()
	t := normTheme(srv.settings.Theme)
	srv.mu.Unlock()
	return t == themeLight || (t == themeSystem && systemIsLight())
}

func themeBrush(light bool) uintptr {
	i, c := 0, themeBg(light)
	if light {
		i = 1
	}
	if themeBrushes[i] == 0 {
		themeBrushes[i], _, _ = pCreateSolidBrush.Call(uintptr(c[0]) | uintptr(c[1])<<8 | uintptr(c[2])<<16)
	}
	return themeBrushes[i]
}

// applyWindowTheme красит заголовок и фон окна под текущую тему. Только в оконном потоке.
func applyWindowTheme() {
	if mainHwnd == 0 {
		return
	}
	light := windowIsLight()
	if windowThemed && light == windowLight {
		return
	}
	windowThemed, windowLight = true, light

	// заголовок окна (Windows 10 20H1+ / 11; 19 — номер атрибута на более старых сборках)
	if pDwmSetWindowAttribute.Find() == nil {
		dark := int32(1)
		if light {
			dark = 0
		}
		if r, _, _ := pDwmSetWindowAttribute.Call(mainHwnd, 20, uintptr(unsafe.Pointer(&dark)), 4); r != 0 {
			pDwmSetWindowAttribute.Call(mainHwnd, 19, uintptr(unsafe.Pointer(&dark)), 4)
		}
		pSetWindowPos.Call(mainHwnd, 0, 0, 0, 0, 0, swpNoSize|swpNoMove|swpNoZOrder|swpNoActivate|swpFrameChanged)
	}
	pSetClassLongPtrW.Call(mainHwnd, gclpHbrBackground, themeBrush(light))
	if webReady.Load() {
		c := themeBg(light)
		chromium.SetBackgroundColour(c[0], c[1], c[2], 255)
	}
}

// windowThemeChanged вызывается из обработчика API: окно живёт в другом потоке
func windowThemeChanged() {
	if mainHwnd != 0 {
		runOnUI(applyWindowTheme)
	}
}

// windowLangChanged: заголовок окна на новом языке (вызывается из обработчика API)
func windowLangChanged() {
	if mainHwnd != 0 {
		runOnUI(func() { pSetWindowTextW.Call(mainHwnd, uintptr(unsafe.Pointer(u16(tr("app.name"))))) })
	}
}

func messageLoop() {
	var m winMsg
	for {
		r, _, _ := pGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if int32(r) <= 0 {
			return
		}
		pTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		pDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
	}
}

// fallbackToBrowser: WebView2 не завёлся — работаем во вкладке браузера
func fallbackToBrowser() {
	if browserMode.Swap(true) {
		return
	}
	pShowWindow.Call(mainHwnd, swHide)
	openBrowser(srv.url())
	go srv.idleExit()
}

func runUI(s *Server) {
	srv = s
	pCoInitializeEx.Call(0, 2) // COINIT_APARTMENTTHREADED
	createMainWindow()

	if v, err := webviewloader.GetAvailableCoreWebView2BrowserVersionString(""); err != nil || v == "" {
		fallbackToBrowser()
		messageLoop()
		return
	}

	showMainWindow()
	pUpdateWindow.Call(mainHwnd)

	chromium = edge.NewChromium()
	chromium.DataPath = filepath.Join(dataDir(), "webview")
	chromium.SetErrorCallback(func(err error) {
		if err == nil || webReady.Load() {
			return // мелкие ошибки после запуска не критичны
		}
		m := err.Error()
		if strings.Contains(m, "environment") || strings.Contains(m, "controller") || strings.Contains(m, "Webview2Loader") {
			// окно не создать: уходим в браузер и крутим сообщения здесь,
			// чтобы не вернуться в библиотеку с пустым контроллером
			fallbackToBrowser()
			messageLoop()
			s.stopAll()
			windows.Exit(0)
		}
	})
	chromium.MessageCallback = func(string, *edge.ICoreWebView2, *edge.ICoreWebView2WebMessageReceivedEventArgs) {}
	chromium.MessageWithAdditionalObjectsCallback = onWebMessage
	chromium.SetPermission(edge.CoreWebView2PermissionKindClipboardRead, edge.CoreWebView2PermissionStateAllow) // «Вставить» в своём меню, без окна с вопросом
	// цвет WebView2 до первой отрисовки: задаётся только так, настройки ниже применятся уже после Embed
	bg := themeBg(windowLight)
	os.Setenv("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", fmt.Sprintf("FF%02X%02X%02X", bg[0], bg[1], bg[2]))
	chromium.Embed(mainHwnd)

	webReady.Store(true)
	chromium.Resize()
	if st, err := chromium.GetSettings(); err == nil {
		st.PutAreDevToolsEnabled(false)
		st.PutIsStatusBarEnabled(false)
		st.PutAreDefaultScriptDialogsEnabled(true)
		st.PutAreDefaultContextMenusEnabled(false) // меню браузера не нужно: своё в web/js/ctxmenu.js
	}
	chromium.SetBackgroundColour(bg[0], bg[1], bg[2], 255)
	chromium.Navigate(s.url())
	chromium.Focus()

	messageLoop()
	s.stopAll()
	markStopped()
	windows.Exit(0)
}

// ---------- перетаскивание: настоящие пути файлов ----------

var iidCoreWebView2File = windows.GUID{Data1: 0xf2c19559, Data2: 0x6bc1, Data3: 0x4583, Data4: [8]byte{0xa7, 0x57, 0x90, 0x02, 0x1b, 0xe9, 0xaf, 0xec}}

// comCall вызывает метод COM-объекта по номеру в таблице
func comCall(obj unsafe.Pointer, idx int, args ...uintptr) uintptr {
	vtbl := *(*uintptr)(obj)
	fn := *(*uintptr)(unsafe.Pointer(vtbl + uintptr(idx)*unsafe.Sizeof(uintptr(0))))
	r, _, _ := syscall.SyscallN(fn, append([]uintptr{uintptr(obj)}, args...)...)
	return r
}

func comRelease(obj unsafe.Pointer) {
	if obj != nil {
		comCall(obj, 2)
	}
}

func webFilePath(obj unsafe.Pointer) string {
	var f unsafe.Pointer
	if comCall(obj, 0, uintptr(unsafe.Pointer(&iidCoreWebView2File)), uintptr(unsafe.Pointer(&f))) == 0 && f != nil {
		defer comRelease(f)
		p, err := (*edge.ICoreWebView2File)(f).GetPath()
		if err == nil {
			return p
		}
		return ""
	}
	p, err := (*edge.ICoreWebView2File)(obj).GetPath()
	if err != nil {
		return ""
	}
	return p
}

func onWebMessage(message string, _ *edge.ICoreWebView2, args *edge.ICoreWebView2WebMessageReceivedEventArgs) {
	if message != "konv:drop" {
		return
	}
	objs, err := args.GetAdditionalObjects()
	if err != nil || objs == nil {
		return
	}
	defer objs.Release()
	n, _ := objs.GetCount()
	var paths []string
	for i := uint32(0); i < n; i++ {
		v, err := objs.GetValueAtIndex(i)
		if err != nil || v == nil {
			continue
		}
		obj := unsafe.Pointer(v)
		if p := webFilePath(obj); p != "" {
			paths = append(paths, p)
		}
		comRelease(obj)
	}
	go func() { // папки обходим в фоне, чтобы окно не подвисало
		list := expandPaths(paths)
		if list == nil {
			list = []FileInfo{}
		}
		b, _ := json.Marshal(list)
		raw, _ := json.Marshal(paths) // как бросили, с папками: «PDF» разворачивает их сам (pdf-list)
		js := "window.__konvDrop && window.__konvDrop(" + string(b) + "," + string(raw) + ")"
		runOnUI(func() { chromium.Eval(js) })
	}()
}

// ---------- системные диалоги выбора (IFileOpenDialog) ----------

var (
	clsidFileOpenDialog = windows.GUID{Data1: 0xDC1C5A9C, Data2: 0xE88A, Data3: 0x4DDE, Data4: [8]byte{0xA5, 0xA1, 0x60, 0xF8, 0x2A, 0x20, 0xAE, 0xF7}}
	iidFileOpenDialog   = windows.GUID{Data1: 0xd57c7288, Data2: 0xd4ad, Data3: 0x4768, Data4: [8]byte{0xbe, 0x02, 0x9d, 0x96, 0x95, 0x32, 0xd9, 0x60}}
	clsidFileSaveDialog = windows.GUID{Data1: 0xC0B4E2F3, Data2: 0xBA21, Data3: 0x4773, Data4: [8]byte{0x8D, 0xBA, 0x33, 0x5E, 0xC9, 0x46, 0xEB, 0x8B}}
	iidFileSaveDialog   = windows.GUID{Data1: 0x84BCCD23, Data2: 0x5FDE, Data3: 0x4CDB, Data4: [8]byte{0xAE, 0xA4, 0xAF, 0x64, 0xB8, 0x3D, 0x78, 0xAB}}
)

const (
	fosOverwritePrompt  = 0x2
	fosPickFolders      = 0x20
	fosForceFileSystem  = 0x40
	fosAllowMultiselect = 0x200
	fosPathMustExist    = 0x800
	fosFileMustExist    = 0x1000
	sigdnFileSysPath    = 0x80058000
	hrCancelled         = 0x800704C7
)

type filterSpec struct{ name, spec *uint16 }

func shellItemPath(item unsafe.Pointer) string {
	var p *uint16
	if comCall(item, 5, sigdnFileSysPath, uintptr(unsafe.Pointer(&p))) != 0 || p == nil {
		return ""
	}
	s := windows.UTF16PtrToString(p)
	pCoTaskMemFree.Call(uintptr(unsafe.Pointer(p)))
	return s
}

func showDialog(owner uintptr, folders, multi bool, title, typeName, typePattern string) ([]string, error) {
	var dlg unsafe.Pointer
	hr, _, _ := pCoCreateInstance.Call(uintptr(unsafe.Pointer(&clsidFileOpenDialog)), 0, 1,
		uintptr(unsafe.Pointer(&iidFileOpenDialog)), uintptr(unsafe.Pointer(&dlg)))
	if hr != 0 || dlg == nil {
		return nil, syscall.Errno(hr)
	}
	defer comRelease(dlg)

	var opts uint32
	comCall(dlg, 10, uintptr(unsafe.Pointer(&opts))) // GetOptions
	opts |= fosForceFileSystem | fosPathMustExist
	if folders {
		opts |= fosPickFolders
	} else {
		opts |= fosFileMustExist
	}
	if multi {
		opts |= fosAllowMultiselect
	}
	comCall(dlg, 9, uintptr(opts))                        // SetOptions
	comCall(dlg, 17, uintptr(unsafe.Pointer(u16(title)))) // SetTitle

	if !folders {
		specs := []filterSpec{
			{u16(typeName), u16(typePattern)},
			{u16(tr("dlg.allFiles")), u16("*.*")},
		}
		comCall(dlg, 4, uintptr(len(specs)), uintptr(unsafe.Pointer(&specs[0]))) // SetFileTypes
		runtime.KeepAlive(specs)
	}

	hr = comCall(dlg, 3, owner) // Show
	if uint32(hr) == hrCancelled {
		return nil, nil
	}
	if hr != 0 {
		return nil, syscall.Errno(hr)
	}

	var out []string
	if multi {
		var arr unsafe.Pointer
		if comCall(dlg, 27, uintptr(unsafe.Pointer(&arr))) != 0 || arr == nil { // GetResults
			return nil, nil
		}
		defer comRelease(arr)
		var n uint32
		comCall(arr, 7, uintptr(unsafe.Pointer(&n))) // GetCount
		for i := uint32(0); i < n; i++ {
			var item unsafe.Pointer
			if comCall(arr, 8, uintptr(i), uintptr(unsafe.Pointer(&item))) == 0 && item != nil { // GetItemAt
				if p := shellItemPath(item); p != "" {
					out = append(out, p)
				}
				comRelease(item)
			}
		}
	} else {
		var item unsafe.Pointer
		if comCall(dlg, 20, uintptr(unsafe.Pointer(&item))) == 0 && item != nil { // GetResult
			if p := shellItemPath(item); p != "" {
				out = append(out, p)
			}
			comRelease(item)
		}
	}
	return out, nil
}

// dialogOnUI показывает диалог в оконном потоке; в режиме браузера — поверх всех окон
func dialogOnUI(folders, multi bool, title, typeName, typePattern string) ([]string, error) {
	return ownerDialog(func(owner uintptr) ([]string, error) {
		return showDialog(owner, folders, multi, title, typeName, typePattern)
	})
}

func ownerDialog(show func(owner uintptr) ([]string, error)) ([]string, error) {
	type res struct {
		p []string
		e error
	}
	ch := make(chan res, 1)
	runOnUI(func() {
		owner := mainHwnd
		var tmp uintptr
		if browserMode.Load() {
			// временное невидимое окно поверх всех, иначе диалог откроется за браузером
			tmp, _, _ = pCreateWindowExW.Call(wsExToolWindow|wsExTopmost,
				uintptr(unsafe.Pointer(u16("STATIC"))), 0, wsPopup, 0, 0, 0, 0, 0, 0, hInstance, 0)
			pShowWindow.Call(tmp, swShow)
			fg, _, _ := pGetForegroundWindow.Call()
			fgThread, _, _ := pGetWindowThreadProcessId.Call(fg, 0)
			me, _, _ := pGetCurrentThreadId.Call()
			pAttachThreadInput.Call(fgThread, me, 1)
			pSetForegroundWindow.Call(tmp)
			pAttachThreadInput.Call(fgThread, me, 0)
			owner = tmp
		}
		p, e := show(owner)
		if tmp != 0 {
			pDestroyWindow.Call(tmp)
		}
		ch <- res{p, e}
	})
	r := <-ch
	return r.p, r.e
}

func pickFiles() ([]string, error) {
	return dialogOnUI(false, true, tr("dlg.pickFiles"), tr("dlg.mediaFiles"), mediaFilter())
}

func pickPDFs() ([]string, error) {
	return dialogOnUI(false, true, tr("dlg.pickPDF"), tr("dlg.pdfFiles"), "*.pdf;*.jpg;*.jpeg;*.png;*.webp")
}

func pickFolder() (string, error) {
	p, err := dialogOnUI(true, false, tr("dlg.pickFolder"), "", "")
	if err != nil || len(p) == 0 {
		return "", err
	}
	return p[0], nil
}

// pickSound: свой звук для конца пачки; только форматы, которые умеет играть окно программы
func pickSound() (string, error) {
	p, err := dialogOnUI(false, false, tr("dlg.pickSound"), tr("dlg.audioFiles"), "*.mp3;*.wav;*.flac;*.m4a;*.aac;*.ogg;*.opus")
	if err != nil || len(p) == 0 {
		return "", err
	}
	return p[0], nil
}

func pickSubs() (string, error) {
	p, err := dialogOnUI(false, false, tr("dlg.pickSubs"), tr("dlg.subsFiles"), "*.srt")
	if err != nil || len(p) == 0 {
		return "", err
	}
	return p[0], nil
}

func pickSubsSave() (string, error) {
	p, err := ownerDialog(func(owner uintptr) ([]string, error) {
		return showSaveDialog(owner, tr("dlg.saveSubs"), tr("dlg.subsFiles"), "*.srt", "srt")
	})
	if err != nil || len(p) == 0 {
		return "", err
	}
	return p[0], nil
}

func pickProjectOpen() (string, error) {
	p, err := dialogOnUI(false, false, tr("dlg.openProject"), tr("dlg.projectFiles"), "*"+projectExt+";*"+projectOldExt)
	if err != nil || len(p) == 0 {
		return "", err
	}
	return p[0], nil
}

func pickProjectSave() (string, error) {
	p, err := ownerDialog(func(owner uintptr) ([]string, error) {
		return showSaveDialog(owner, tr("dlg.saveProject"), tr("dlg.projectFiles"), "*"+projectExt, strings.TrimPrefix(projectExt, "."))
	})
	if err != nil || len(p) == 0 {
		return "", err
	}
	return p[0], nil
}

// pickZipSave: куда сохранить ZIP с фавиконами
func pickZipSave() (string, error) {
	p, err := ownerDialog(func(owner uintptr) ([]string, error) {
		return showSaveDialog(owner, tr("dlg.saveFavicons"), tr("dlg.zipFiles"), "*.zip", "zip", "favicons.zip")
	})
	if err != nil || len(p) == 0 {
		return "", err
	}
	return p[0], nil
}

// pickColorSave: куда сохранить файл с вкладки «Цвет»; ext — png, svg или ase, name — имя, которое диалог предложит
func pickColorSave(ext, name string) (string, error) {
	typeName := tr("dlg.pngFiles")
	switch ext {
	case "svg":
		typeName = tr("dlg.svgFiles")
	case "ase":
		typeName = tr("dlg.aseFiles")
	}
	p, err := ownerDialog(func(owner uintptr) ([]string, error) {
		return showSaveDialog(owner, tr("dlg.saveColor"), typeName, "*."+ext, ext, name)
	})
	if err != nil || len(p) == 0 {
		return "", err
	}
	return p[0], nil
}

// showSaveDialog: те же номера методов IFileDialog, что у showDialog. Спросить про замену файла просит сам диалог.
// name — имя файла, которое диалог предложит сразу (необязательно).
func showSaveDialog(owner uintptr, title, typeName, typePattern, ext string, name ...string) ([]string, error) {
	var dlg unsafe.Pointer
	hr, _, _ := pCoCreateInstance.Call(uintptr(unsafe.Pointer(&clsidFileSaveDialog)), 0, 1,
		uintptr(unsafe.Pointer(&iidFileSaveDialog)), uintptr(unsafe.Pointer(&dlg)))
	if hr != 0 || dlg == nil {
		return nil, syscall.Errno(hr)
	}
	defer comRelease(dlg)

	var opts uint32
	comCall(dlg, 10, uintptr(unsafe.Pointer(&opts))) // GetOptions
	comCall(dlg, 9, uintptr(opts|fosForceFileSystem|fosPathMustExist|fosOverwritePrompt))
	comCall(dlg, 17, uintptr(unsafe.Pointer(u16(title)))) // SetTitle
	specs := []filterSpec{{u16(typeName), u16(typePattern)}}
	comCall(dlg, 4, uintptr(len(specs)), uintptr(unsafe.Pointer(&specs[0]))) // SetFileTypes
	runtime.KeepAlive(specs)
	comCall(dlg, 22, uintptr(unsafe.Pointer(u16(ext)))) // SetDefaultExtension
	if len(name) > 0 && name[0] != "" {
		comCall(dlg, 15, uintptr(unsafe.Pointer(u16(name[0])))) // SetFileName
	}

	hr = comCall(dlg, 3, owner) // Show
	if uint32(hr) == hrCancelled {
		return nil, nil
	}
	if hr != 0 {
		return nil, syscall.Errno(hr)
	}
	var item unsafe.Pointer
	if comCall(dlg, 20, uintptr(unsafe.Pointer(&item))) != 0 || item == nil { // GetResult
		return nil, nil
	}
	defer comRelease(item)
	if p := shellItemPath(item); p != "" {
		return []string{p}, nil
	}
	return nil, nil
}
