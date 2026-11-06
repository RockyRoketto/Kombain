package main

// Список шрифтов Windows для инструмента «Текст» и субтитров.

import (
	"slices"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

type logFontW struct {
	Height, Width, Escapement, Orientation, Weight                                     int32
	Italic, Underline, StrikeOut, CharSet, OutPrecision, ClipPrecision, Quality, Pitch byte
	FaceName                                                                           [32]uint16
}

// Один раз за запуск: число обратных вызовов в Go ограничено, а шрифты пока программа открыта почти не меняются
var systemFonts = sync.OnceValue(func() []string {
	seen := map[string]bool{}
	cb := windows.NewCallback(func(lf *logFontW, _, _, _ uintptr) uintptr {
		// имя с @ — тот же шрифт для вертикального письма
		if name := windows.UTF16ToString(lf.FaceName[:]); name != "" && name[0] != '@' {
			seen[name] = true
		}
		return 1
	})
	dc, _, _ := windows.NewLazySystemDLL("user32.dll").NewProc("GetDC").Call(0)
	if dc != 0 {
		defer windows.NewLazySystemDLL("user32.dll").NewProc("ReleaseDC").Call(0, dc)
		lf := logFontW{CharSet: 1} // DEFAULT_CHARSET: все шрифты
		windows.NewLazySystemDLL("gdi32.dll").NewProc("EnumFontFamiliesExW").Call(dc, uintptr(unsafe.Pointer(&lf)), cb, 0, 0)
	}
	names := make([]string, 0, len(seen))
	for name := range seen {
		names = append(names, name)
	}
	slices.Sort(names)
	return names
})
