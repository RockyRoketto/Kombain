//go:build !windows

package main

import (
	"fmt"
	"os"
)

func pickFiles() ([]string, error) {
	return nil, fmt.Errorf("диалоги выбора доступны только в Windows")
}

func pickFolder() (string, error) {
	return "", fmt.Errorf("диалоги выбора доступны только в Windows")
}

func windowThemeChanged() {} // своего окна здесь нет, страницу в браузере красит CSS

func runUI(s *Server) {
	if os.Getenv("FFB_NO_BROWSER") == "" {
		openBrowser(s.url())
	} else {
		fmt.Println(s.url() + " token=" + s.token)
	}
	s.idleExit()
}
