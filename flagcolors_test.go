package main

import (
	"strings"
	"testing"
)

func TestCountryColorsHint(t *testing.T) {
	cases := map[string]string{
		"мяч в цветах Испании":              "Colors: Spain = red and yellow",
		"испанский футболист":               "Colors: Spain = red and yellow",
		"Даниил пьёт чай":                   "",
		"корень дерева":                     "",
		"красный мяч и свисток":             "",
		"баскетбольное кольцо с флагом США": "Colors: USA = red, white and blue\nFlag: USA flag = thirteen horizontal red and white stripes and a blue rectangle with white stars in the top left corner",
	}
	for in, want := range cases {
		if got := countryColorsHint(in); got != want {
			t.Errorf("%q: %q, ждали %q", in, got, want)
		}
	}
}

// порядок стран в подсказке — как в запросе, и описание флага есть только когда просят флаг
func TestCountryColorsHintOrder(t *testing.T) {
	got := countryColorsHint("флаги Англии и Испании")
	if !strings.HasPrefix(got, "Colors: England = white and red; Spain = ") || !strings.Contains(got, "\nFlag: England flag = a white flag with a big red cross; Spain flag = ") {
		t.Errorf("порядок или описание флагов: %q", got)
	}
	if got := countryColorsHint("Испания и Англия"); strings.Contains(got, "Flag:") {
		t.Errorf("без слова «флаг» описания флагов быть не должно: %q", got)
	}
}
