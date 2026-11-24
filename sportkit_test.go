package main

import (
	"math/rand"
	"strings"
	"testing"
)

func TestSportOf(t *testing.T) {
	for req, want := range map[string]string{
		"футбольная композиция":          "soccer ball",
		"мяч для баскетбола и кроссовки": "basketball",
		"настольный теннис":              "table tennis",
		"теннис, ракетка":                "tennis ball",
		"бокс":                           "boxing gloves",
		"велосипед":                      "bicycle",
		"хоккейная шайба":                "hockey puck",
		"что-то про спорт":               "",
		"football match banner":          "soccer ball",
	} {
		k := sportOf(req)
		if want == "" {
			if k.keys != nil {
				t.Errorf("%q: ждали запасной набор", req)
			}
			continue
		}
		if k.keys == nil || !strings.Contains(k.items[0], want) {
			t.Errorf("%q: набор %v, ждали %q", req, k.items[0], want)
		}
	}
}

// пять футбольных запросов подряд не должны давать одно и то же
func TestSportHintVaries(t *testing.T) {
	rnd := rand.New(rand.NewSource(1))
	seen := map[string]bool{}
	for i := 0; i < 5; i++ {
		h := sportHint("футбольная композиция", rnd)
		if !strings.Contains(h, "Group:") || !strings.Contains(h, "soccer ball") {
			t.Fatalf("плохая подсказка: %q", h)
		}
		seen[h] = true
	}
	if len(seen) < 4 {
		t.Errorf("слишком похожие подсказки: %d разных из 5", len(seen))
	}
}

func TestSportHintOne(t *testing.T) {
	h := sportHint("один велосипед крупно", rand.New(rand.NewSource(2)))
	if !strings.Contains(h, "ONE object") || strings.Contains(h, "Props:") {
		t.Errorf("один предмет: %q", h)
	}
	if h := sportHint("мяч и бутсы", rand.New(rand.NewSource(3))); strings.Contains(h, "ONE object") {
		t.Errorf("группа принята за один предмет: %q", h)
	}
}

// названные предметы не заменяются набором (жалоба автора: «велосипед, шлем и линии» дали велосипед и бутсу)
func TestSportHintExplicit(t *testing.T) {
	for i := int64(0); i < 5; i++ {
		h := sportHint("композиция из велосипеда, шлема и линий", rand.New(rand.NewSource(i)))
		if !strings.Contains(h, "exactly the objects the request names") || strings.Contains(h, "Props:") {
			t.Fatalf("перечень предметов: %q", h)
		}
	}
	// неполный перечень и просто тема дополняются набором
	for _, req := range []string{"футбольная композиция", "мяч, бутсы и ещё что-то", "мяч, бутсы и еще чето", "бокс"} {
		if h := sportHint(req, rand.New(rand.NewSource(7))); !strings.Contains(h, "Props:") {
			t.Errorf("%q: нет набора: %q", req, h)
		}
	}
}

func TestSportFixSoccer(t *testing.T) {
	if got := sportFixSoccer("футбольный мяч, кубок", "A large orange football and a football boot"); got != "A large orange soccer ball and a soccer boot" {
		t.Fatal(got)
	}
	if got := sportFixSoccer("регби: мяч", "a rugby football"); got != "a rugby football" {
		t.Fatal(got)
	}
}

func TestSportHintManyVariants(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 400; i++ {
		seen[sportHint("велосипед, шлем, бутылка", nil)] = true
	}
	if len(seen) < 20 {
		t.Fatal("мало вариаций:", len(seen))
	}
}
