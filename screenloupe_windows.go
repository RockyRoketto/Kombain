//go:build windows

package main

import (
	"fmt"
	"math"
	"unsafe"
)

// Лупа пипетки: сама заменяет курсор. Снимок экрана делается один раз до показа окон,
// лупа рисуется из него в собственном буфере и выставляется целиком (UpdateLayeredWindow), поэтому без мерцания
// и без попадания самой лупы в снимок. Мышь окно лупы пропускает сквозь себя.
var (
	lpCreateDC  = gdi32.NewProc("CreateCompatibleDC")
	lpSelect    = gdi32.NewProc("SelectObject")
	lpDelete    = gdi32.NewProc("DeleteObject")
	lpDeleteDC  = gdi32.NewProc("DeleteDC")
	lpBitBlt    = gdi32.NewProc("BitBlt")
	lpDIB       = gdi32.NewProc("CreateDIBSection")
	lpFlush     = gdi32.NewProc("GdiFlush")
	lpBkMode    = gdi32.NewProc("SetBkMode")
	lpTextColor = gdi32.NewProc("SetTextColor")
	lpTextOut   = gdi32.NewProc("TextOutW")
	lpFont      = gdi32.NewProc("CreateFontW")
	lpUpdateLW  = user32.NewProc("UpdateLayeredWindow")
	lpCursor    = user32.NewProc("CreateCursor")
)

const (
	loupeCells = 11
	loupeCell  = 13
	loupeD     = loupeCells * loupeCell // диаметр круга
	loupeLabW  = 108
	loupeLabH  = 26
	loupeH     = loupeD + 8 + loupeLabH
)

type bmpInfoHeader struct {
	Size                   uint32
	Width, Height          int32
	Planes, BitCount       uint16
	Compression, SizeImage uint32
	XPPM, YPPM             int32
	ClrUsed, ClrImportant  uint32
}

type loupe struct {
	win        uintptr
	dc, bmp    uintptr
	bits       []uint32 // loupeD × loupeH, 0xAARRGGBB с предумноженной прозрачностью
	snap       []uint32
	vx, vy     int32
	vw, vh     int32
	font       uintptr
	snapDC     uintptr
	snapBmp    uintptr
	snapOldBmp uintptr
	oldBmp     uintptr
}

func newDIB(dc uintptr, w, h int32) (bmp uintptr, bits []uint32) {
	hdr := bmpInfoHeader{Size: 40, Width: w, Height: -h, Planes: 1, BitCount: 32}
	var p unsafe.Pointer
	bmp, _, _ = lpDIB.Call(dc, uintptr(unsafe.Pointer(&hdr)), 0, uintptr(unsafe.Pointer(&p)), 0, 0)
	if bmp == 0 || p == nil {
		return 0, nil
	}
	return bmp, unsafe.Slice((*uint32)(p), int(w)*int(h))
}

// newLoupe снимает экран (vx, vy, vw, vh — виртуальный экран) и готовит буферы; nil — не вышло
func newLoupe(vx, vy, vw, vh int32) *loupe {
	scr, _, _ := spGetDC.Call(0)
	defer spReleaseDC.Call(0, scr)
	l := &loupe{vx: vx, vy: vy, vw: vw, vh: vh}
	l.snapDC, _, _ = lpCreateDC.Call(scr)
	l.snapBmp, l.snap = newDIB(scr, vw, vh)
	if l.snap == nil {
		return nil
	}
	l.snapOldBmp, _, _ = lpSelect.Call(l.snapDC, l.snapBmp)
	lpBitBlt.Call(l.snapDC, 0, 0, uintptr(vw), uintptr(vh), scr, uintptr(vx), uintptr(vy), 0x00CC0020)
	lpFlush.Call()
	l.dc, _, _ = lpCreateDC.Call(scr)
	l.bmp, l.bits = newDIB(scr, loupeD, loupeH)
	if l.bits == nil {
		return nil
	}
	l.oldBmp, _, _ = lpSelect.Call(l.dc, l.bmp)
	l.font, _, _ = lpFont.Call(^uintptr(14), 0, 0, 0, 600, 0, 0, 0, 1, 0, 0, 5, 0, uintptr(unsafe.Pointer(u16("Segoe UI")))) // высота -15
	return l
}

// show создаёт окно лупы (в потоке окон)
func (l *loupe) show() bool {
	l.win, _, _ = pCreateWindowExW.Call(wsExToolWindow|wsExTopmost|spExNoActive|spExLayered|0x20, // WS_EX_TRANSPARENT
		uintptr(unsafe.Pointer(u16("STATIC"))), 0, wsPopup, 0, 0, loupeD, loupeH, 0, 0, hInstance, 0)
	if l.win == 0 {
		return false
	}
	pShowWindow.Call(l.win, 4)
	return true
}

// close освобождает всё; окно — в потоке окон
func (l *loupe) close() {
	if l.win != 0 {
		pDestroyWindow.Call(l.win)
	}
	if l.dc != 0 {
		lpSelect.Call(l.dc, l.oldBmp)
		lpDeleteDC.Call(l.dc)
		lpDelete.Call(l.bmp)
	}
	if l.snapDC != 0 {
		lpSelect.Call(l.snapDC, l.snapOldBmp)
		lpDeleteDC.Call(l.snapDC)
		lpDelete.Call(l.snapBmp)
	}
	if l.font != 0 {
		lpDelete.Call(l.font)
	}
}

// pixel: цвет в снимке в точке экрана
func (l *loupe) pixel(x, y int32) uint32 {
	x, y = x-l.vx, y-l.vy
	if x < 0 || y < 0 || x >= l.vw || y >= l.vh {
		return 0
	}
	return l.snap[int(y)*int(l.vw)+int(x)] & 0xFFFFFF
}

func (l *loupe) hex(x, y int32) string {
	c := l.pixel(x, y)
	return fmt.Sprintf("#%02x%02x%02x", byte(c>>16), byte(c>>8), byte(c))
}

func mixPx(c uint32, a float64) uint32 { // предумножить цвет на прозрачность
	r, g, b := float64(c>>16&255)*a, float64(c>>8&255)*a, float64(c&255)*a
	return uint32(a*255)<<24 | uint32(r)<<16 | uint32(g)<<8 | uint32(b)
}

// draw рисует лупу с центром в курсоре (x, y) и выставляет окно
func (l *loupe) draw(x, y int32) {
	const R = float64(loupeD) / 2
	half := int32(loupeCells / 2)
	for i := range l.bits {
		l.bits[i] = 0
	}
	for py := 0; py < loupeD; py++ {
		for px := 0; px < loupeD; px++ {
			d := math.Hypot(float64(px)+.5-R, float64(py)+.5-R)
			a := math.Min(math.Max(R-d+.5, 0), 1)
			if a == 0 {
				continue
			}
			var c uint32
			if d > R-3 { // кольцо
				c = 0xe9b872
			} else {
				cx, cy := int32(px/loupeCell), int32(py/loupeCell)
				c = l.pixel(x+cx-half, y+cy-half)
				lx, ly := px%loupeCell, py%loupeCell
				if cx == half && cy == half {
					if lx == 0 || ly == 0 || lx == loupeCell-1 || ly == loupeCell-1 {
						c = 0x000000
					} else if lx == 1 || ly == 1 || lx == loupeCell-2 || ly == loupeCell-2 {
						c = 0xffffff
					}
				} else if lx == 0 || ly == 0 {
					c = (c >> 1) & 0x7f7f7f // тонкая сетка между пикселями
				}
			}
			l.bits[py*loupeD+px] = mixPx(c, a)
		}
	}
	// подпись: плашка с образцом цвета и HEX
	x0, y0 := (loupeD-loupeLabW)/2, loupeD+8
	cur := l.pixel(x, y)
	inLab := func(px, py int) bool {
		dx, dy := math.Max(math.Max(float64(x0+10-px), float64(px-(x0+loupeLabW-11))), 0), math.Max(math.Max(float64(y0+10-py), float64(py-(y0+loupeLabH-11))), 0)
		return px >= x0 && px < x0+loupeLabW && py >= y0 && py < y0+loupeLabH && math.Hypot(dx, dy) <= 10
	}
	for py := y0; py < y0+loupeLabH; py++ {
		for px := x0; px < x0+loupeLabW; px++ {
			if inLab(px, py) {
				c := uint32(0x181614)
				if px >= x0+8 && px < x0+22 && py >= y0+6 && py < y0+loupeLabH-6 {
					c = cur
					if px == x0+8 || px == x0+21 || py == y0+6 || py == y0+loupeLabH-7 {
						c = 0xffffff
					}
				}
				l.bits[py*loupeD+px] = 0xFF000000 | c
			}
		}
	}
	lpBkMode.Call(l.dc, 1)
	lpTextColor.Call(l.dc, 0xd6e6f0) // COLORREF BGR: светлый текст
	of, _, _ := lpSelect.Call(l.dc, l.font)
	lpTextOut.Call(l.dc, uintptr(x0+28), uintptr(y0+3), uintptr(unsafe.Pointer(u16(l.hex(x, y)))), 7)
	lpSelect.Call(l.dc, of)
	lpFlush.Call()
	for py := y0; py < y0+loupeLabH; py++ { // GDI оставляет прозрачность в буквах нулевой
		for px := x0; px < x0+loupeLabW; px++ {
			if inLab(px, py) {
				l.bits[py*loupeD+px] |= 0xFF000000
			}
		}
	}

	pos := [2]int32{x - loupeD/2, y - loupeD/2}
	size := [2]int32{loupeD, loupeH}
	src := [2]int32{}
	blend := [4]byte{0, 0, 255, 1} // AC_SRC_OVER, без общей прозрачности, AC_SRC_ALPHA
	lpUpdateLW.Call(l.win, 0, uintptr(unsafe.Pointer(&pos)), uintptr(unsafe.Pointer(&size)), l.dc,
		uintptr(unsafe.Pointer(&src)), 0, uintptr(unsafe.Pointer(&blend)), 2) // ULW_ALPHA
}

// blankCursor: невидимый курсор, чтобы вместо него была видна лупа
func blankCursor() uintptr {
	and := make([]byte, 128)
	for i := range and {
		and[i] = 0xFF
	}
	xor := make([]byte, 128)
	c, _, _ := lpCursor.Call(hInstance, 0, 0, 32, 32, uintptr(unsafe.Pointer(&and[0])), uintptr(unsafe.Pointer(&xor[0])))
	return c
}
