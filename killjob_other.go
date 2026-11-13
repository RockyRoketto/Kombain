//go:build !windows

package main

import "os/exec"

func dieWithUs(c *exec.Cmd) {}
