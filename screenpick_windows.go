//go:build windows

package main

import (
	"errors"
	"time"
	"unsafe"
)

// Пипетка с экрана. Системный EyeDropper в окне WebView2 не отвечает, поэтому цвет берём сами:
// снимок экрана, поверх всех экранов почти прозрачное окно (оно ловит щелчок, чтобы он не попал в чужую программу)
// и лупа вместо курсора (screenloupe_windows.go). Щелчок — цвет под курсором, Esc — отмена.
var (
	spGetCursorPos     = user32.NewProc("GetCursorPos")
	spGetAsyncKeyState = user32.NewProc("GetAsyncKeyState")
	spSetLayered       = user32.NewProc("SetLayeredWindowAttributes")
	spGetDC            = user32.NewProc("GetDC")
	spReleaseDC        = user32.NewProc("ReleaseDC")
)

const (
	spExLayered  = 0x00080000
	spExNoActive = 0x08000000
	spGclHCursor = ^uintptr(11) // GCLP_HCURSOR = -12
)

func spDown(vk uintptr) bool {
	r, _, _ := spGetAsyncKeyState.Call(vk)
	return r&0x8000 != 0
}

// pickScreenColor ждёт щелчок и возвращает цвет «#rrggbb»; пустая строка — отменили (Esc или время вышло)
func pickScreenColor() (string, error) {
	x, _, _ := pGetSystemMetrics.Call(76)
	y, _, _ := pGetSystemMetrics.Call(77)
	w, _, _ := pGetSystemMetrics.Call(78)
	h, _, _ := pGetSystemMetrics.Call(79)
	lp := newLoupe(int32(x), int32(y), int32(w), int32(h)) // снимок до того, как на экране появятся наши окна
	if lp == nil {
		return "", errors.New("capture")
	}
	var win, oldCur uintptr
	ok := make(chan bool, 1)
	runOnUI(func() {
		// окно класса диалога: в отличие от STATIC, ловит мышь, а не пропускает её сквозь себя
		win, _, _ = pCreateWindowExW.Call(wsExTopmost|wsExToolWindow|spExLayered|spExNoActive,
			uintptr(unsafe.Pointer(u16("#32770"))), 0, wsPopup, x, y, w, h, 0, 0, hInstance, 0)
		if win == 0 {
			ok <- false
			return
		}
		spSetLayered.Call(win, 0, 1, 2) // LWA_ALPHA, почти прозрачное
		oldCur, _, _ = pSetClassLongPtrW.Call(win, spGclHCursor, blankCursor())
		pSetWindowPos.Call(win, ^uintptr(0), x, y, w, h, swpNoActivate) // HWND_TOPMOST
		pShowWindow.Call(win, 4)                                        // SW_SHOWNOACTIVATE
		ok <- lp.show()
	})
	var pt struct{ X, Y int32 }
	for i := 0; i < 200 && spDown(0x01); i++ { // щелчок, запустивший пипетку, ещё может быть зажат
		time.Sleep(10 * time.Millisecond)
	}
	picked := false
	if <-ok {
		for end := time.Now().Add(60 * time.Second); time.Now().Before(end); time.Sleep(6 * time.Millisecond) {
			spGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))
			lp.draw(pt.X, pt.Y)
			if spDown(0x1B) { // Esc
				break
			}
			if spDown(0x01) { // левая кнопка
				picked = true
				for spDown(0x01) {
					time.Sleep(10 * time.Millisecond)
				}
				break
			}
		}
	}
	color := ""
	if picked {
		color = lp.hex(pt.X, pt.Y)
	}
	done := make(chan struct{})
	runOnUI(func() {
		if win != 0 {
			pSetClassLongPtrW.Call(win, spGclHCursor, oldCur)
			pDestroyWindow.Call(win)
		}
		lp.close()
		close(done)
	})
	<-done
	if win == 0 {
		return "", errors.New("overlay")
	}
	return color, nil
}
