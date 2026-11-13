package main

// Действия Windows для галереи картинок: удалить в корзину (SHFileOperation с FOF_ALLOWUNDO, чтобы удалённое
// можно было вернуть), показать файл выделенным в его папке, положить картинку в буфер обмена.

import (
	"errors"
	"os/exec"
	"runtime"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

var procSHFileOperation = windows.NewLazySystemDLL("shell32.dll").NewProc("SHFileOperationW")

// shFileOpStruct — SHFILEOPSTRUCTW (в 64-битной сборке выравнивание обычное)
type shFileOpStruct struct {
	hwnd     uintptr
	wFunc    uint32
	pFrom    *uint16
	pTo      *uint16
	flags    uint16
	aborted  int32
	mappings uintptr
	title    *uint16
}

func moveToTrash(paths []string) error {
	if len(paths) == 0 {
		return nil
	}
	var from []uint16 // пути через ноль, в конце два нуля
	for _, p := range paths {
		from = append(from, utf16.Encode([]rune(p))...)
		from = append(from, 0)
	}
	from = append(from, 0)
	const foDelete, flags = 3, 0x0040 | 0x0010 | 0x0004 | 0x0400 // ALLOWUNDO, NOCONFIRMATION, SILENT, NOERRORUI
	op := shFileOpStruct{wFunc: foDelete, pFrom: &from[0], flags: flags}
	r, _, _ := procSHFileOperation.Call(uintptr(unsafe.Pointer(&op)))
	if r != 0 {
		return errors.New(tr("err.trash"))
	}
	if op.aborted != 0 {
		return errors.New(tr("err.trash"))
	}
	return nil
}

// revealFile открывает папку в Проводнике с выделенным файлом. Кавычки ставим сами: Проводник не понимает
// стандартное экранирование Go, если весь аргумент /select,… взят в кавычки.
func revealFile(path string) {
	cmd := exec.Command("explorer")
	cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: `explorer /select,"` + path + `"`}
	cmd.Start()
}

var (
	procOpenClipboard    = windows.NewLazySystemDLL("user32.dll").NewProc("OpenClipboard")
	procCloseClipboard   = windows.NewLazySystemDLL("user32.dll").NewProc("CloseClipboard")
	procEmptyClipboard   = windows.NewLazySystemDLL("user32.dll").NewProc("EmptyClipboard")
	procSetClipboardData = windows.NewLazySystemDLL("user32.dll").NewProc("SetClipboardData")
	procRegisterClipFmt  = windows.NewLazySystemDLL("user32.dll").NewProc("RegisterClipboardFormatW")
	procGlobalAlloc      = windows.NewLazySystemDLL("kernel32.dll").NewProc("GlobalAlloc")
	procGlobalLock       = windows.NewLazySystemDLL("kernel32.dll").NewProc("GlobalLock")
	procGlobalUnlock     = windows.NewLazySystemDLL("kernel32.dll").NewProc("GlobalUnlock")
	procGlobalFree       = windows.NewLazySystemDLL("kernel32.dll").NewProc("GlobalFree")
)

// clipPut: кусок памяти для буфера обмена; после удачного SetClipboardData он принадлежит системе
func clipPut(format uintptr, data []byte) bool {
	h, _, _ := procGlobalAlloc.Call(0x0002, uintptr(len(data))) // GMEM_MOVEABLE
	if h == 0 {
		return false
	}
	p, _, _ := procGlobalLock.Call(h)
	if p == 0 {
		procGlobalFree.Call(h)
		return false
	}
	copy(unsafe.Slice((*byte)(unsafe.Pointer(p)), len(data)), data)
	procGlobalUnlock.Call(h)
	if r, _, _ := procSetClipboardData.Call(format, h); r == 0 {
		procGlobalFree.Call(h)
		return false
	}
	return true
}

// copyImage кладёт картинку в буфер обмена двумя видами: "PNG" (с прозрачностью, его берут браузеры, Figma,
// Photoshop) и CF_DIB (его понимают все, вплоть до Paint и мессенджеров)
func copyImage(pngData []byte, dib []byte) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	var ok uintptr
	for i := 0; i < 10; i++ { // буфер может держать другая программа
		if ok, _, _ = procOpenClipboard.Call(0); ok != 0 {
			break
		}
		time.Sleep(30 * time.Millisecond)
	}
	if ok == 0 {
		return errors.New(tr("err.clipboard"))
	}
	defer procCloseClipboard.Call()
	procEmptyClipboard.Call()
	name, _ := windows.UTF16PtrFromString("PNG")
	fmtPNG, _, _ := procRegisterClipFmt.Call(uintptr(unsafe.Pointer(name)))
	a := fmtPNG != 0 && clipPut(fmtPNG, pngData)
	b := clipPut(8, dib) // CF_DIB
	if !a && !b {
		return errors.New(tr("err.clipboard"))
	}
	return nil
}
