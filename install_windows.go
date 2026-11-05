//go:build windows

package main

// Установка «для текущего пользователя», без прав администратора:
//   exe → %LOCALAPPDATA%\Programs\Konvertor\Konvertor.exe
//   ярлыки → меню «Пуск» (и по желанию рабочий стол)
//   запись в «Установленных приложениях» (HKCU\...\Uninstall\Konvertor9000)
// Удаление: Konvertor.exe --uninstall (его и вызывает Windows из «Приложений»).

import (
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const uninstallKey = `Software\Microsoft\Windows\CurrentVersion\Uninstall\Konvertor9000`

// так назывались ярлыки до переименования в «Конвертер 9000»
const oldShortcutName = "Конвертор 9000.lnk"

// shortcutFile: ярлык называется на языке, выбранном при установке
func shortcutFile() string { return tr("app.name") + ".lnk" }

// shortcutNames: все названия, которые ярлык мог получить раньше
func shortcutNames() []string {
	return []string{oldShortcutName, goDict[langRU]["app.name"] + ".lnk", goDict[langEN]["app.name"] + ".lnk"}
}

var (
	pCoUninitialize = ole32.NewProc("CoUninitialize")

	clsidShellLink = windows.GUID{Data1: 0x00021401, Data4: [8]byte{0xC0, 0, 0, 0, 0, 0, 0, 0x46}}
	iidShellLinkW  = windows.GUID{Data1: 0x000214F9, Data4: [8]byte{0xC0, 0, 0, 0, 0, 0, 0, 0x46}}
	iidPersistFile = windows.GUID{Data1: 0x0000010B, Data4: [8]byte{0xC0, 0, 0, 0, 0, 0, 0, 0x46}}
	mbOK           = uintptr(0x00)
	mbIconInfo     = uintptr(0x40)
	mbIconWarn     = uintptr(0x30)
	mbDefButton2   = uintptr(0x100)
	createNoWindow = uint32(0x08000000)
)

func installDir() string {
	d := os.Getenv("LOCALAPPDATA")
	if d == "" {
		d, _ = os.UserCacheDir()
	}
	return filepath.Join(d, "Programs", "Konvertor")
}

func installExe() string { return filepath.Join(installDir(), "Konvertor.exe") }

func selfExe() string {
	p, err := os.Executable()
	if err != nil {
		return ""
	}
	if r, err := filepath.EvalSymlinks(p); err == nil {
		p = r
	}
	return filepath.Clean(p)
}

func installedVersion() string {
	k, err := registry.OpenKey(registry.CURRENT_USER, uninstallKey, registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer k.Close()
	v, _, _ := k.GetStringValue("DisplayVersion")
	return v
}

func installInfo() InstallInfo {
	ii := InstallInfo{Supported: true, Dir: installDir(), Version: installedVersion()}
	ii.Installed = strings.EqualFold(selfExe(), filepath.Clean(installExe()))
	switch {
	case ii.Installed:
	case !fileExists(installExe()) || ii.Version == "":
		ii.Offer = "install"
	case cmpVer(appVersion, ii.Version) > 0:
		ii.Offer = "upgrade"
	}
	return ii
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dst + ".new"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, dst); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

func doInstall(desktop bool) error {
	src, dst := selfExe(), installExe()
	if src == "" {
		return errT("inst.noSelf")
	}
	if err := os.MkdirAll(installDir(), 0o755); err != nil {
		return err
	}
	renameOldShortcuts()
	if !strings.EqualFold(src, filepath.Clean(dst)) {
		if err := copyFile(src, dst); err != nil {
			if fileExists(dst) {
				return errT("inst.replaceBusy", dst)
			}
			return errT("inst.copyFailed", err)
		}
	}

	if dir, err := windows.KnownFolderPath(windows.FOLDERID_Programs, 0); err == nil {
		if err := createShortcut(filepath.Join(dir, shortcutFile()), dst); err != nil {
			return errT("inst.startShortcut", err)
		}
	}
	addSendTo(dst)
	addProjectType(dst)
	desk := ""
	if dir, err := windows.KnownFolderPath(windows.FOLDERID_Desktop, 0); err == nil {
		desk = filepath.Join(dir, shortcutFile())
	}
	if desk != "" {
		if desktop {
			if err := createShortcut(desk, dst); err != nil {
				return errT("inst.deskShortcut", err)
			}
		} else {
			os.Remove(desk)
		}
	}
	return writeUninstallEntry(dst)
}

// Файл проекта монтажа: у него иконка программы, двойной щелчок открывает его в программе. Только для текущего пользователя.
const (
	classesKey    = `Software\Classes`
	projectProgID = "Konvertor9000.Project"
)

func writeProjectType(root, exe string) error {
	set := func(path, val string) error {
		k, _, err := registry.CreateKey(registry.CURRENT_USER, root+`\`+path, registry.SET_VALUE)
		if err != nil {
			return err
		}
		defer k.Close()
		return k.SetStringValue("", val)
	}
	for _, v := range [][2]string{
		{projectExt, projectProgID},
		{projectProgID, tr("dlg.projectFile")},
		{projectProgID + `\DefaultIcon`, `"` + exe + `",0`},
		{projectProgID + `\shell\open\command`, `"` + exe + `" "%1"`},
	} {
		if err := set(v[0], v[1]); err != nil {
			return err
		}
	}
	return nil
}

func deleteProjectType(root string) {
	for _, path := range []string{projectProgID + `\shell\open\command`, projectProgID + `\shell\open`, projectProgID + `\shell`, projectProgID + `\DefaultIcon`, projectProgID, projectExt} {
		registry.DeleteKey(registry.CURRENT_USER, root+`\`+path)
	}
}

// addProjectType: без него программа всё равно работает, поэтому ошибка не мешает установке. Проводнику надо сказать, что иконки поменялись.
func addProjectType(exe string) {
	if writeProjectType(classesKey, exe) == nil {
		const shcneAssocChanged = 0x08000000
		windows.NewLazySystemDLL("shell32.dll").NewProc("SHChangeNotify").Call(shcneAssocChanged, 0, 0, 0)
	}
}

// shortcutFolders: где лежат ярлыки программы
var shortcutFolders = []*windows.KNOWNFOLDERID{windows.FOLDERID_Programs, windows.FOLDERID_Desktop, windows.FOLDERID_SendTo}

// addSendTo: пункт в меню Windows «Отправить». Без него программа всё равно работает, поэтому ошибка не мешает установке.
func addSendTo(exe string) {
	if dir, err := windows.KnownFolderPath(windows.FOLDERID_SendTo, 0); err == nil {
		createShortcut(filepath.Join(dir, shortcutFile()), exe)
	}
}

// renameOldShortcuts: ярлыки со старым названием или на другом языке переименовать в новое
func renameOldShortcuts() {
	cur := shortcutFile()
	for _, id := range shortcutFolders {
		if dir, err := windows.KnownFolderPath(id, 0); err == nil {
			for _, name := range shortcutNames() {
				if old := filepath.Join(dir, name); name != cur && fileExists(old) {
					os.Rename(old, filepath.Join(dir, cur))
				}
			}
		}
	}
}

func writeUninstallEntry(exe string) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, uninstallKey, registry.SET_VALUE)
	if err != nil {
		return errT("inst.uninstallEntry", err)
	}
	defer k.Close()
	k.SetStringValue("DisplayName", tr("app.name"))
	k.SetStringValue("DisplayVersion", appVersion)
	k.SetStringValue("Publisher", appAuthor)
	k.SetStringValue("DisplayIcon", exe+",0")
	k.SetStringValue("InstallLocation", installDir())
	k.SetStringValue("UninstallString", `"`+exe+`" --uninstall`)
	k.SetStringValue("InstallDate", time.Now().Format("20060102"))
	k.SetDWordValue("NoModify", 1)
	k.SetDWordValue("NoRepair", 1)
	size := fileSize(exe) + fileSize(filepath.Join(dataDir(), ffName()))
	k.SetDWordValue("EstimatedSize", uint32(size/1024))
	return nil
}

// createShortcut делает .lnk через IShellLinkW + IPersistFile
func createShortcut(lnk, target string) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	hr, _, _ := pCoInitializeEx.Call(0, 2) // COINIT_APARTMENTTHREADED
	if hr == 0 || hr == 1 {                // S_OK / S_FALSE
		defer pCoUninitialize.Call()
	}

	var sl unsafe.Pointer
	r, _, _ := pCoCreateInstance.Call(uintptr(unsafe.Pointer(&clsidShellLink)), 0, 1, // CLSCTX_INPROC_SERVER
		uintptr(unsafe.Pointer(&iidShellLinkW)), uintptr(unsafe.Pointer(&sl)))
	if int32(r) < 0 || sl == nil {
		return fmt.Errorf("ShellLink 0x%08X", uint32(r))
	}
	defer comRelease(sl)

	comCall(sl, 20, uintptr(unsafe.Pointer(u16(target))))                // SetPath
	comCall(sl, 9, uintptr(unsafe.Pointer(u16(filepath.Dir(target)))))   // SetWorkingDirectory
	comCall(sl, 7, uintptr(unsafe.Pointer(u16(tr("app.shortcutDesc"))))) // SetDescription
	comCall(sl, 17, uintptr(unsafe.Pointer(u16(target))), 0)             // SetIconLocation

	var pf unsafe.Pointer
	if r := comCall(sl, 0, uintptr(unsafe.Pointer(&iidPersistFile)), uintptr(unsafe.Pointer(&pf))); int32(r) < 0 || pf == nil {
		return fmt.Errorf("IPersistFile 0x%08X", uint32(r))
	}
	defer comRelease(pf)
	os.MkdirAll(filepath.Dir(lnk), 0o755)
	if r := comCall(pf, 6, uintptr(unsafe.Pointer(u16(lnk))), 1); int32(r) < 0 { // Save
		return errT("inst.saveShortcut", uint32(r))
	}
	return nil
}

// ---------- обновление самой программы (см. selfupdate.go) ----------

func canSelfUpdate() bool { return selfExe() != "" }

// replaceSelf: запущенный exe Windows удалить не даёт, но переименовать — даёт.
// Свой exe → Konvertor.exe.old, новый → на его место. .old удалит следующий запуск.
func replaceSelf(newExe string) error {
	self := selfExe()
	if self == "" {
		return errT("inst.noSelf")
	}
	old := self + ".old"
	os.Remove(old)
	if err := os.Rename(self, old); err != nil {
		return errT("inst.notWritable", self)
	}
	if err := copyFile(newExe, self); err != nil {
		os.Rename(old, self)
		return errT("inst.writeFailed", err)
	}
	os.Remove(newExe)
	return nil
}

// restartSelf запускает новый exe и закрывает этот (новый подождёт, пока освободится порт)
func restartSelf(s *Server) {
	time.Sleep(1500 * time.Millisecond) // интерфейс успевает показать «перезапускаю»
	self := selfExe()
	cmd := exec.Command(self, "--updated")
	cmd.Dir = filepath.Dir(self)
	if err := cmd.Start(); err != nil {
		msgBox(tr("inst.restartFailed"), mbOK|mbIconInfo)
	}
	saveWindowPlace()
	s.stopAll()
	os.Exit(0)
}

// afterUpdate: убрать .old от прошлой версии и поправить версию в «Установленных приложениях»
func afterUpdate(inst InstallInfo) InstallInfo {
	go func() {
		old := selfExe() + ".old"
		for i := 0; i < 20; i++ { // прошлый процесс может ещё закрываться
			if err := os.Remove(old); err == nil || os.IsNotExist(err) {
				return
			}
			time.Sleep(500 * time.Millisecond)
		}
	}()
	if inst.Installed {
		renameOldShortcuts()
	}
	if inst.Installed && inst.Version != appVersion {
		addSendTo(selfExe()) // установка старой версии такого пункта не делала
		addProjectType(selfExe())
		if writeUninstallEntry(selfExe()) == nil {
			return installInfo()
		}
	}
	return inst
}

func msgBox(text string, flags uintptr) uintptr {
	r, _, _ := pMessageBoxW.Call(0, uintptr(unsafe.Pointer(u16(text))), uintptr(unsafe.Pointer(u16(tr("app.name")))), flags)
	return r
}

// runUninstall: Konvertor.exe --uninstall
func runUninstall() {
	// программа открыта (держит свой порт) — сначала пусть закроют
	if ln, err := net.Listen("tcp", "127.0.0.1:47831"); err != nil {
		msgBox(tr("inst.uninstallOpen"), mbOK|mbIconWarn)
		return
	} else {
		ln.Close()
	}
	if msgBox(tr("inst.uninstallAsk", tr("app.name")),
		mbYesNo|mbIconQuestion|mbDefButton2) != idYes {
		return
	}

	for _, id := range shortcutFolders {
		if dir, err := windows.KnownFolderPath(id, 0); err == nil {
			for _, name := range shortcutNames() {
				os.Remove(filepath.Join(dir, name))
			}
		}
	}
	registry.DeleteKey(registry.CURRENT_USER, uninstallKey)
	deleteProjectType(classesKey)
	os.RemoveAll(dataDir()) // ffmpeg, настройки, данные окна

	dir := installDir()
	inside := strings.HasPrefix(strings.ToLower(selfExe()), strings.ToLower(dir+string(os.PathSeparator)))
	if !inside {
		os.RemoveAll(dir)
	}
	msgBox(tr("inst.uninstallDone"), mbOK|mbIconInfo)
	if !inside {
		return
	}
	// сам себя exe удалить не может: просим cmd подождать пару секунд и стереть папку
	cmd := exec.Command("cmd.exe")
	cmd.Dir = os.TempDir()
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: createNoWindow,
		CmdLine:       `cmd.exe /d /c ping 127.0.0.1 -n 3 >nul & rmdir /s /q "` + dir + `"`,
	}
	cmd.Start()
}
