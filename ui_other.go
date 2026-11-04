//go:build !windows

package main

import (
	"fmt"
	"os"
)

func pickFiles() ([]string, error) {
	return nil, errT("dlg.onlyWindows")
}

func pickFolder() (string, error) {
	return "", errT("dlg.onlyWindows")
}

func windowThemeChanged() {} // своего окна здесь нет, страницу в браузере красит CSS
func windowLangChanged()  {}

func runUI(s *Server) {
	if os.Getenv("FFB_NO_BROWSER") == "" {
		openBrowser(s.url())
	} else {
		fmt.Println(s.url() + " token=" + s.token)
	}
	s.idleExit()
}
