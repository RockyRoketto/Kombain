//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

var (
	k32DiskFree = syscall.NewLazyDLL("kernel32.dll").NewProc("GetDiskFreeSpaceExW")
	k32Drives   = syscall.NewLazyDLL("kernel32.dll").NewProc("GetLogicalDrives")
	k32DrvType  = syscall.NewLazyDLL("kernel32.dll").NewProc("GetDriveTypeW")
)

// hwRAMTotal: вся обычная память, МБ; -1 — неизвестно
func hwRAMTotal() float64 {
	var m struct {
		length, load                                                  uint32
		total, avail, totalPage, availPage, virt, availVirt, availExt uint64
	}
	m.length = uint32(unsafe.Sizeof(m))
	if r, _, _ := k32MemStatusEx.Call(uintptr(unsafe.Pointer(&m))); r == 0 {
		return -1
	}
	return float64(m.total) / (1 << 20)
}

// diskFree: свободные байты на диске папки dir (с учётом квот пользователя); -1 — неизвестно
func diskFree(dir string) int64 {
	p, err := syscall.UTF16PtrFromString(dir)
	if err != nil {
		return -1
	}
	var avail, total, free uint64
	if r, _, _ := k32DiskFree.Call(uintptr(unsafe.Pointer(p)), uintptr(unsafe.Pointer(&avail)), uintptr(unsafe.Pointer(&total)), uintptr(unsafe.Pointer(&free))); r == 0 {
		return -1
	}
	return int64(avail)
}

// drivesFree: локальные диски (без флешек, сетевых и CD) со свободным местом
func drivesFree() []HWDrive {
	const driveFixed = 3
	mask, _, _ := k32Drives.Call()
	out := []HWDrive{}
	for i := 0; i < 26; i++ {
		if mask&(1<<i) == 0 {
			continue
		}
		root := string(rune('A'+i)) + `:\`
		p, _ := syscall.UTF16PtrFromString(root)
		if t, _, _ := k32DrvType.Call(uintptr(unsafe.Pointer(p))); t != driveFixed {
			continue
		}
		if f := diskFree(root); f >= 0 {
			out = append(out, HWDrive{Root: root, Free: f})
		}
	}
	return out
}
