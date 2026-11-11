//go:build !windows

package main

import (
	"fmt"
	"os"
)

func pickFiles() ([]string, error) {
	return nil, errT("dlg.onlyWindows")
}

func pickPDFs() ([]string, error) {
	return nil, errT("dlg.onlyWindows")
}

func pickFolder() (string, error) {
	return "", errT("dlg.onlyWindows")
}

func pickSound() (string, error) {
	return "", errT("dlg.onlyWindows")
}

func windowThemeChanged() {} // своего окна здесь нет, страницу в браузере красит CSS
func windowLangChanged()  {}

func activateRunning([]string) bool { return false } // своего окна здесь нет
func closeAck()                     {}
func closeFromPage()                {}

func runUI(s *Server) {
	if os.Getenv("FFB_NO_BROWSER") == "" {
		openBrowser(s.url())
	} else {
		fmt.Println(s.url() + " token=" + s.token)
	}
	s.idleExit()
}

func pickSubs() (string, error) {
	return "", errT("dlg.onlyWindows")
}

func pickSubsSave() (string, error) {
	return "", errT("dlg.onlyWindows")
}

func pickProjectOpen() (string, error) {
	return "", errT("dlg.onlyWindows")
}

func pickProjectSave() (string, error) {
	return "", errT("dlg.onlyWindows")
}

func pickZipSave() (string, error) {
	return "", errT("dlg.onlyWindows")
}

func pickColorSave(ext, name string) (string, error) {
	return "", errT("dlg.onlyWindows")
}

func pickScreenColor() (string, error) {
	return "", errT("dlg.onlyWindows")
}
