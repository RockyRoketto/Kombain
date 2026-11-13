//go:build !windows

package main

func hwRAMTotal() float64       { return -1 }
func diskFree(dir string) int64 { return -1 }
func drivesFree() []HWDrive     { return []HWDrive{} }
func regGPU() (string, float64) { return "", -1 }
