package main

import (
	"os"
	"testing"
)

func TestWinPlaceFit(t *testing.T) {
	const minW, minH = 760, 600
	mon := [4]int32{0, 0, 1920, 1080}
	cases := []struct {
		name     string
		in, want winPlace
	}{
		{"помещается", winPlace{100, 50, 1200, 900, false}, winPlace{100, 50, 1200, 900, false}},
		{"развёрнутость сохраняется", winPlace{100, 50, 1200, 900, true}, winPlace{100, 50, 1200, 900, true}},
		{"меньше минимума", winPlace{100, 50, 300, 200, false}, winPlace{100, 50, minW, minH, false}},
		{"больше монитора", winPlace{0, 0, 3840, 2160, false}, winPlace{0, 0, 1920, 1080, false}},
		{"уехало вправо и вниз", winPlace{1800, 1000, 1000, 800, false}, winPlace{920, 280, 1000, 800, false}},
		{"уехало влево и вверх", winPlace{-500, -300, 1000, 800, false}, winPlace{0, 0, 1000, 800, false}},
	}
	for _, c := range cases {
		if got := c.in.fit(mon[0], mon[1], mon[2], mon[3], minW, minH); got != c.want {
			t.Errorf("%s: %+v, нужно %+v", c.name, got, c.want)
		}
	}
	// второй монитор левее основного: координаты отрицательные и остаются такими
	got := winPlace{-1500, 100, 1000, 800, false}.fit(-1920, 0, 0, 1080, minW, minH)
	if want := (winPlace{-1500, 100, 1000, 800, false}); got != want {
		t.Errorf("второй монитор: %+v", got)
	}
}

func TestWinPlaceFile(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("LOCALAPPDATA", dir)
	t.Setenv("XDG_CACHE_HOME", dir)
	if _, ok := loadWinPlace(); ok {
		t.Error("файла нет, а положение нашлось")
	}
	want := winPlace{-10, 20, 1500, 900, true}
	if err := saveWinPlace(want); err != nil {
		t.Fatal(err)
	}
	if got, ok := loadWinPlace(); !ok || got != want {
		t.Errorf("прочитано %+v, %v", got, ok)
	}
	for _, bad := range []string{"не json", `{"x":1}`, `{"w":-5,"h":100}`} {
		os.WriteFile(winPlacePath(), []byte(bad), 0o644)
		if _, ok := loadWinPlace(); ok {
			t.Errorf("испорченный файл принят: %s", bad)
		}
	}
}
