//go:build windows

package main

import (
	"testing"

	"golang.org/x/sys/windows/registry"
)

// Проверка идёт в своём разделе реестра: настоящая привязка файлов на компьютере не трогается
func TestProjectType(t *testing.T) {
	const root = `Software\Konvertor9000Test`
	defer registry.DeleteKey(registry.CURRENT_USER, root)
	defer deleteProjectType(root)
	exe := `C:\Программы\Konvertor.exe`
	if err := writeProjectType(root, exe); err != nil {
		t.Fatal(err)
	}
	read := func(path string) string {
		t.Helper()
		k, err := registry.OpenKey(registry.CURRENT_USER, root+`\`+path, registry.QUERY_VALUE)
		if err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		defer k.Close()
		v, _, err := k.GetStringValue("")
		if err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		return v
	}
	if got := read(projectExt); got != projectProgID {
		t.Errorf("расширение ведёт на %q", got)
	}
	if got, want := read(projectProgID+`\DefaultIcon`), `"`+exe+`",0`; got != want {
		t.Errorf("иконка %q, ждали %q", got, want)
	}
	if got, want := read(projectProgID+`\shell\open\command`), `"`+exe+`" "%1"`; got != want {
		t.Errorf("команда %q, ждали %q", got, want)
	}
	deleteProjectType(root)
	if k, err := registry.OpenKey(registry.CURRENT_USER, root+`\`+projectProgID, registry.QUERY_VALUE); err == nil {
		k.Close()
		t.Error("тип файла остался после удаления")
	}
}
