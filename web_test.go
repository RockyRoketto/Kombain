package main

import (
	"io/fs"
	"strings"
	"testing"
)

func TestTabsOrder(t *testing.T) {
	page, at := pages[langRU], 0
	for _, want := range []string{`data-t="conv"`, `data-t="play"`, `data-t="mont"`, `data-t="banner"`} {
		i := strings.Index(page, want)
		if i < at {
			t.Fatalf("вкладка %s не на своём месте", want)
		}
		at = i
	}
}

func TestPageAssembled(t *testing.T) {
	for _, p := range []string{"__CSS__", "__JS__"} {
		if strings.Contains(pages[langRU], p) {
			t.Errorf("в странице осталось %s", p)
		}
	}
	for _, want := range []string{"const TOKEN = '__TOKEN__'", "--acc:#e9b872", `id="convView"`, "setTab(tab); poll();"} {
		if !strings.Contains(pages[langRU], want) {
			t.Errorf("в странице нет %q", want)
		}
	}
	// новый файл в web/js легко забыть добавить в webJS
	listed := map[string]bool{}
	for _, f := range webJS {
		listed[f] = true
	}
	entries, err := fs.ReadDir(webFS, "web/js")
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if !listed[e.Name()] {
			t.Errorf("web/js/%s нет в webJS", e.Name())
		}
	}
}
