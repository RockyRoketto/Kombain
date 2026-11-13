//go:build windows

package main

import (
	"os/exec"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Движки ИИ держат гигабайты видеопамяти. Если Kombain упадёт или его снимут в диспетчере задач, они не должны остаться
// висеть: процесс кладётся в объект задания, который Windows закрывает вместе с нами и убивает всё, что в нём.
var (
	killJobOnce sync.Once
	killJob     windows.Handle
)

func killJobHandle() windows.Handle {
	killJobOnce.Do(func() {
		h, err := windows.CreateJobObject(nil, nil)
		if err != nil {
			return
		}
		var info windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
		info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
		if _, err := windows.SetInformationJobObject(h, windows.JobObjectExtendedLimitInformation,
			uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
			windows.CloseHandle(h)
			return
		}
		killJob = h
	})
	return killJob
}

// dieWithUs: процесс уже запущен; при неудаче он просто живёт как обычно
func dieWithUs(c *exec.Cmd) {
	job := killJobHandle()
	if job == 0 || c.Process == nil {
		return
	}
	p, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(c.Process.Pid))
	if err != nil {
		return
	}
	windows.AssignProcessToJobObject(job, p)
	windows.CloseHandle(p)
}
