//go:build !windows

package main

import (
	"fmt"
	"os"
	"time"
)

// Установка есть только в Windows. FFB_FAKE_INSTALL=1 — для проверки окна установки на Linux.

func installInfo() InstallInfo {
	if os.Getenv("FFB_FAKE_INSTALL") != "" {
		return InstallInfo{Supported: true, Dir: "/fake/Programs/Konvertor", Offer: "install"}
	}
	return InstallInfo{}
}

func doInstall(desktop bool) error {
	if os.Getenv("FFB_FAKE_INSTALL") != "" {
		time.Sleep(700 * time.Millisecond)
		return nil
	}
	return errT("inst.onlyWindows")
}

func runUninstall() { fmt.Println(tr("inst.uninstallOnlyOS")) }

// обновление самой программы — тоже только в Windows
func canSelfUpdate() bool { return false }
func replaceSelf(string) error {
	return errT("upd.onlyWindows")
}
func restartSelf(*Server)                      {}
func afterUpdate(inst InstallInfo) InstallInfo { return inst }
