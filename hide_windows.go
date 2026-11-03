//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

// hide не даёт всплывать чёрным консольным окнам у дочерних процессов.
func hide(c *exec.Cmd) {
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}
