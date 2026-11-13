//go:build !windows

package main

import "os/exec"

// На других системах только nvidia-smi: Kombain собирается под Windows, остальное нужно для проверок.
type otherHW struct{}

func newHWSys() hwSys                              { return otherHW{} }
func (otherHW) cpuRAM() (cpu, used, total float64) { return -1, -1, -1 }
func (otherHW) gpu() (smiGPU, bool)                { return smiGPU{}, false }
func (otherHW) close()                             {}

func hwVRAMTotal() float64 { return -1 }

func findSMI() string {
	p, _ := exec.LookPath("nvidia-smi")
	return p
}
