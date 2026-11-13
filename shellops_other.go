//go:build !windows

package main

import "os"

// moveToTrash: вне Windows корзины нет, удаляем сразу (программа собирается для Windows, это для тестов)
func moveToTrash(paths []string) error {
	for _, p := range paths {
		if err := os.Remove(p); err != nil {
			return err
		}
	}
	return nil
}

func revealFile(path string) {}

func copyImage(pngData []byte, dib []byte) error { return errT("dlg.onlyWindows") }
