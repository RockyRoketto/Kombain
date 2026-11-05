//go:build !windows

package main

func availableRAM() uint64 { return 0 }
