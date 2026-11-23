package main

import (
	"strings"
	"unicode"
)

// flagColors: цвета и устройство флагов стран по основе слова (русское название). Маленькая модель-помощник путает цвета
// и рисунок флагов («мяч в цветах Испании» превращался в случайные цвета, у флага путались полосы), поэтому подставляем сами:
// строка «Colors:» всегда, строка «Flag:» только если в запросе есть слово про флаг. Основа ищется с начала слова с
// окончанием не длиннее 6 букв (испанский, испании), чтобы «Даниил» не стал Данией.
var flagColors = []struct {
	stems  []string
	name   string
	cols   string
	layout string
}{
	{[]string{"испани", "испанск"}, "Spain", "red and yellow", "three horizontal stripes: red, a wide yellow one, red, with a small coat of arms on the yellow stripe near the left"},
	{[]string{"франци", "француз", "французск"}, "France", "blue, white and red", "three equal vertical stripes: blue, white, red"},
	{[]string{"итали", "итальянск"}, "Italy", "green, white and red", "three equal vertical stripes: green, white, red"},
	{[]string{"германи", "немец", "немецк", "германск"}, "Germany", "black, red and yellow", "three equal horizontal stripes: black, red, yellow"},
	{[]string{"англи", "английск", "британи", "британск"}, "England", "white and red", "a white flag with a big red cross"},
	{[]string{"португал"}, "Portugal", "red and green", "a vertical green stripe on the left and a larger red field on the right, with a small yellow coat of arms on the border"},
	{[]string{"бразили"}, "Brazil", "green, yellow and blue", "a green flag with a big yellow diamond and a blue circle inside it"},
	{[]string{"аргентин"}, "Argentina", "light blue and white", "three horizontal stripes: light blue, white, light blue, with a small yellow sun in the middle"},
	{[]string{"сша", "америк"}, "USA", "red, white and blue", "thirteen horizontal red and white stripes and a blue rectangle with white stars in the top left corner"},
	{[]string{"росси"}, "Russia", "white, blue and red", "three equal horizontal stripes: white, blue, red"},
	{[]string{"украин"}, "Ukraine", "blue and yellow", "two horizontal halves: blue on top, yellow below"},
	{[]string{"нидерланд", "голланд"}, "Netherlands", "orange", "three equal horizontal stripes: red, white, blue (the team color is orange)"},
	{[]string{"бельги", "бельгийск"}, "Belgium", "black, yellow and red", "three equal vertical stripes: black, yellow, red"},
	{[]string{"хорвати", "хорватск"}, "Croatia", "red and white checkered, with blue", "three horizontal stripes: red, white, blue, with a red and white checkered coat of arms in the middle"},
	{[]string{"польш", "польск"}, "Poland", "white and red", "two horizontal halves: white on top, red below"},
	{[]string{"турци", "турецк"}, "Turkey", "red and white", "a red flag with a white crescent and a white star"},
	{[]string{"швейцари"}, "Switzerland", "red and white", "a square red flag with a white cross"},
	{[]string{"швеци"}, "Sweden", "blue and yellow", "a blue flag with a yellow Nordic cross"},
	{[]string{"норвеги"}, "Norway", "red, white and blue", "a red flag with a white-edged blue Nordic cross"},
	{[]string{"финлянди"}, "Finland", "white and blue", "a white flag with a blue Nordic cross"},
	{[]string{"чехи"}, "Czechia", "white, red and blue", "two horizontal halves: white on top, red below, and a blue triangle on the left"},
	{[]string{"австри"}, "Austria", "red and white", "three equal horizontal stripes: red, white, red"},
	{[]string{"греци"}, "Greece", "blue and white", "nine horizontal blue and white stripes and a blue square with a white cross in the top left corner"},
	{[]string{"серби"}, "Serbia", "red, blue and white", "three horizontal stripes: red, blue, white, with a coat of arms on the left"},
	{[]string{"шотланди"}, "Scotland", "blue and white", "a blue flag with a white diagonal cross"},
	{[]string{"уэльс"}, "Wales", "red, white and green", "two horizontal halves, white on top and green below, with a red dragon in the middle"},
	{[]string{"ирланди"}, "Ireland", "green, white and orange", "three equal vertical stripes: green, white, orange"},
	{[]string{"япони"}, "Japan", "white and red", "a white flag with a red circle in the middle"},
	{[]string{"китай", "китае"}, "China", "red and yellow", "a red flag with one big yellow star and four small yellow stars in the top left corner"},
	{[]string{"корея", "кореи", "корею", "корейск"}, "South Korea", "white, red and blue", "a white flag with a red and blue circle in the middle and black bars in the corners"},
	{[]string{"мексик"}, "Mexico", "green, white and red", "three equal vertical stripes: green, white, red, with an eagle emblem in the middle"},
	{[]string{"канад"}, "Canada", "red and white", "red, white, red vertical stripes with a red maple leaf on the white one"},
	{[]string{"австрали"}, "Australia", "dark blue, red and white", "a dark blue flag with a small Union Jack in the top left corner and white stars"},
	{[]string{"колумби"}, "Colombia", "yellow, blue and red", "three horizontal stripes: a wide yellow one, blue, red"},
	{[]string{"уругва"}, "Uruguay", "white and light blue", "nine horizontal white and blue stripes and a white square with a sun in the top left corner"},
	{[]string{"марокко", "марокк"}, "Morocco", "red and green", "a red flag with a green five-pointed star in the middle"},
	{[]string{"египет", "египт"}, "Egypt", "red, white and black", "three horizontal stripes: red, white, black, with a golden eagle in the middle"},
	{[]string{"нигери"}, "Nigeria", "green and white", "three vertical stripes: green, white, green"},
	{[]string{"сенегал"}, "Senegal", "green, yellow and red", "three vertical stripes: green, yellow, red, with a green star on the yellow one"},
	{[]string{"гана", "ганы", "ганой", "гане"}, "Ghana", "red, yellow and green", "three horizontal stripes: red, yellow, green, with a black star in the middle"},
	{[]string{"казахстан"}, "Kazakhstan", "sky blue and yellow", "a sky blue flag with a golden sun and an eagle in the middle and a golden pattern on the left"},
	{[]string{"беларус", "белорус"}, "Belarus", "red and green", "red on top and green below, with a white and red ornament on the left"},
	{[]string{"грузи"}, "Georgia", "white and red", "a white flag with a big red cross and four small red crosses"},
	{[]string{"армени"}, "Armenia", "red, blue and orange", "three equal horizontal stripes: red, blue, orange"},
	{[]string{"азербайджан"}, "Azerbaijan", "blue, red and green", "three horizontal stripes: blue, red, green, with a white crescent and a star"},
	{[]string{"узбекистан"}, "Uzbekistan", "blue, white and green", "blue, white and green horizontal stripes with thin red lines, a white crescent and stars in the top left"},
	{[]string{"индия", "индии", "индию", "индийск"}, "India", "orange, white and green", "three horizontal stripes: saffron, white, green, with a blue wheel in the middle"},
}

// flagWord: в запросе просят именно флаг (флаг, флаги, флажок, вымпел, знамя)
func flagWord(words []string) bool {
	for _, w := range words {
		if strings.HasPrefix(w, "флаг") || strings.HasPrefix(w, "флаж") || strings.HasPrefix(w, "вымпел") || strings.HasPrefix(w, "знам") {
			return true
		}
	}
	return false
}

// countryColorsHint: строки «Colors:» (и «Flag:», если просят флаг) для помощника, если в запросе названа страна.
// Порядок стран в строках — как в запросе, чтобы «Англия и Испания» шло слева направо. Пусто, если стран нет.
func countryColorsHint(request string) string {
	words := strings.FieldsFunc(strings.ToLower(request), func(r rune) bool { return !unicode.IsLetter(r) })
	type hit struct{ pos, idx int }
	var hits []hit
	for i, c := range flagColors {
		pos := -1
		for wi, w := range words {
			rw := len([]rune(w))
			for _, s := range c.stems {
				if strings.HasPrefix(w, s) && rw-len([]rune(s)) <= 6 {
					pos = wi
				}
			}
			if pos >= 0 {
				break
			}
		}
		if pos >= 0 {
			hits = append(hits, hit{pos, i})
		}
	}
	if len(hits) == 0 {
		return ""
	}
	for i := 1; i < len(hits); i++ { // сортировка вставками по позиции в запросе
		for j := i; j > 0 && hits[j].pos < hits[j-1].pos; j-- {
			hits[j], hits[j-1] = hits[j-1], hits[j]
		}
	}
	var cols, flags []string
	for _, h := range hits {
		c := flagColors[h.idx]
		cols = append(cols, c.name+" = "+c.cols)
		flags = append(flags, c.name+" flag = "+c.layout)
	}
	out := "Colors: " + strings.Join(cols, "; ")
	if flagWord(words) {
		out += "\nFlag: " + strings.Join(flags, "; ")
	}
	return out
}
