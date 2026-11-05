//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

// availableRAM: сколько байт памяти свободно; 0 — узнать не вышло
func availableRAM() uint64 {
	var m struct {
		length, load                                                  uint32
		total, avail, totalPage, availPage, virt, availVirt, availExt uint64
	}
	m.length = uint32(unsafe.Sizeof(m))
	r, _, _ := syscall.NewLazyDLL("kernel32.dll").NewProc("GlobalMemoryStatusEx").Call(uintptr(unsafe.Pointer(&m)))
	if r == 0 {
		return 0
	}
	return m.avail
}
