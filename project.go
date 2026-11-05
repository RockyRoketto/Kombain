package main

// Файл проекта монтажа: JSON, который собирает страница. Внутри пути к исходникам, сами видео в него не входят.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

const (
	projectExt     = ".k9000"
	projectMaxSize = 64 << 20
)

// writeProject пишет через временный файл: сбой на середине не должен испортить уже сохранённый проект
func writeProject(path string, data []byte) (string, error) {
	if !json.Valid(data) {
		return "", errT("mont.badProject", filepath.Base(path))
	}
	if !strings.EqualFold(filepath.Ext(path), projectExt) {
		path += projectExt
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "konvertor-project-*.tmp")
	if err != nil {
		return "", err
	}
	_, err = tmp.Write(data)
	if e := tmp.Close(); err == nil {
		err = e
	}
	if err == nil {
		err = os.Rename(tmp.Name(), path)
	}
	if err != nil {
		os.Remove(tmp.Name())
		return "", err
	}
	return path, nil
}

func readProject(path string) ([]byte, error) {
	if !strings.EqualFold(filepath.Ext(path), projectExt) {
		return nil, errT("mont.badProject", filepath.Base(path))
	}
	st, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if st.Size() > projectMaxSize {
		return nil, errT("mont.badProject", filepath.Base(path))
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if !json.Valid(data) {
		return nil, errT("mont.badProject", filepath.Base(path))
	}
	return data, nil
}
