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

// textWidth: ширина строки шрифтом font высотой строки px (как Fontsize в ASS: высота ячейки, ascent + descent).
// GDI без кернинга, libass с ним: расхождение в пиксель-другой. Эффект «по слову» умножает его на малую долю, глазу не видно.
// Не вышло — грубая оценка textWidthGuess.
var gdi = windows.NewLazySystemDLL("gdi32.dll")

func textWidth(font string, px float64, s string) float64 {
	const big = 1000 // мерить крупно: у мелкого шрифта GDI округляет ширины букв до пикселя
	name, err := windows.UTF16PtrFromString(font)
	text := windows.StringToUTF16(s)
	if err != nil || len(text) < 2 {
		return textWidthGuess(px, s)
	}
	dc, _, _ := gdi.NewProc("CreateCompatibleDC").Call(0)
	if dc == 0 {
		return textWidthGuess(px, s)
	}
	defer gdi.NewProc("DeleteDC").Call(dc)
	// высота > 0 — высота ячейки; 1 — DEFAULT_CHARSET, 4 — OUT_TT_PRECIS
	f, _, _ := gdi.NewProc("CreateFontW").Call(big, 0, 0, 0, 400, 0, 0, 0, 1, 4, 0, 0, 0, uintptr(unsafe.Pointer(name)))
	if f == 0 {
		return textWidthGuess(px, s)
	}
	defer gdi.NewProc("DeleteObject").Call(f)
	gdi.NewProc("SelectObject").Call(dc, f)
	var size struct{ CX, CY int32 }
	if ok, _, _ := gdi.NewProc("GetTextExtentPoint32W").Call(dc, uintptr(unsafe.Pointer(&text[0])), uintptr(len(text)-1), uintptr(unsafe.Pointer(&size))); ok == 0 {
		return textWidthGuess(px, s)
	}
	return float64(size.CX) * px / big
}
