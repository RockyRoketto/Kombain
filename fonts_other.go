//go:build !windows

package main

func systemFonts() []string { return nil }

func textWidth(_ string, px float64, s string) float64 { return textWidthGuess(px, s) }
