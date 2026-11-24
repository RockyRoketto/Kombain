package main

// Стиль «Спорт 3D»: наборы предметов по видам спорта. Задача — чтобы «футбольная композиция» без списка предметов
// каждый раз выходила разной (другие предметы, другая расстановка, другой акцентный цвет), а не одной и той же,
// и чтобы маленький помощник не выдумывал случайное. sportHint даёт помощнику строки «Group:», «Props:», «Arrangement:»,
// «Accent:» (llmEnhance, только для стиля sport3d; правила про них в llmSystemObject).

import (
	"math/rand"
	"regexp"
	"strconv"
	"strings"
)

type sportKit struct {
	keys  []string // начала русских и английских слов запроса (в нижнем регистре)
	items []string // items[0] — главный предмет вида спорта, остальные — что можно положить рядом
}

// порядок важен: «настольный теннис» раньше «тенниса», «американский футбол» раньше «футбола»
var sportKits = []sportKit{
	{[]string{"настольн", "пинг-понг", "пингпонг", "table"}, []string{
		"a small white table tennis ball", "a table tennis paddle with red rubber", "a second paddle with dark teal rubber", "a golden trophy", "a stopwatch"}},
	{[]string{"регби", "rugby", "американск"}, []string{
		"an oval rugby ball with white stitches", "a dark teal rugby helmet", "a lime green mouthguard case", "a golden trophy", "a whistle"}},
	{[]string{"футбол", "soccer", "football", "бутс", "вратар"}, []string{
		"a classic soccer ball with white and dark teal panels",
		"a lime green football boot with white studs",
		"a dark teal goalkeeper glove with a lime green cuff",
		"a golden trophy cup",
		"a dark teal and lime green whistle",
		"a white stopwatch with lime green marks",
		"a pair of white shin guards",
		"a small lime green corner flag",
		"a yellow referee card"}},
	{[]string{"баскет", "basket"}, []string{
		"an orange basketball with black lines",
		"a white basketball sneaker with a lime green sole",
		"a basketball hoop with a white net",
		"a small golden trophy",
		"a white sweatband with a dark teal stripe",
		"a dark teal whistle",
		"a white stopwatch with lime green marks"}},
	{[]string{"теннис", "tennis", "ракетк"}, []string{
		"a bright yellow-green tennis ball",
		"a tennis racket with a lime green frame",
		"a second tennis ball",
		"a golden trophy",
		"a white sweatband with a dark teal stripe",
		"a white tennis sneaker with a lime green sole",
		"a dark teal water bottle"}},
	{[]string{"волейбол", "volley"}, []string{
		"a white volleyball with lime green and dark teal panels",
		"a white sneaker with a lime green sole",
		"a pair of dark teal knee pads",
		"a golden trophy",
		"a whistle",
		"a white stopwatch with lime green marks"}},
	{[]string{"хокке", "шайб", "hockey", "клюшк"}, []string{
		"a black rubber hockey puck",
		"a dark teal hockey stick with a lime green tape blade",
		"a white ice skate with a lime green blade holder",
		"a dark teal goalie mask",
		"a lime green hockey glove",
		"a golden trophy"}},
	{[]string{"бокс", "box", "mma", "единоборств"}, []string{
		"a pair of glossy red boxing gloves",
		"a golden championship belt",
		"a dark teal boxing helmet",
		"a white stopwatch with lime green marks",
		"a small brass bell",
		"a lime green hand wrap roll"}},
	{[]string{"плаван", "бассейн", "swim"}, []string{
		"a pair of dark teal swimming goggles with lime green straps",
		"a lime green swim cap",
		"a white stopwatch with lime green marks",
		"a golden medal on a ribbon",
		"a dark teal water bottle",
		"a lime green pool float"}},
	{[]string{"велосипед", "велоспорт", "вело", "bike", "bicycle", "cycling"}, []string{
		"a sleek road bicycle with a dark teal frame and lime green rims",
		"a lime green cycling helmet",
		"a dark teal cycling shoe with a lime green sole",
		"a water bottle",
		"a golden trophy",
		"a white stopwatch with lime green marks"}},
	{[]string{"бег", "марафон", "running", "лёгк", "легк"}, []string{
		"a lime green running sneaker with a white sole",
		"a white stopwatch with lime green marks",
		"a golden medal on a ribbon",
		"a dark teal water bottle",
		"a lime green finish ribbon",
		"a dark teal sweatband"}},
	{[]string{"бильярд", "billiard", "снукер"}, []string{
		"a triangle rack of glossy billiard balls",
		"a wooden billiard cue",
		"a black eight ball",
		"a lime green chalk cube",
		"a golden trophy"}},
	{[]string{"гольф", "golf"}, []string{
		"a white golf ball on a tee",
		"a golf club with a dark teal shaft",
		"a small lime green golf flag",
		"a white golf glove",
		"a golden trophy"}},
	{[]string{"бейсбол", "baseball"}, []string{
		"a white baseball with red stitches",
		"a wooden baseball bat",
		"a brown baseball glove",
		"a dark teal baseball cap",
		"a golden trophy"}},
}

// запасной набор: вид спорта в запросе не назван (или не знаем), но стиль спортивный
var sportGeneric = sportKit{items: []string{
	"a golden trophy cup", "a dark teal and lime green whistle", "a white stopwatch with lime green marks",
	"a golden medal on a ribbon", "a lime green sports sneaker", "a dark teal water bottle"}}

var sportArrangements = []string{
	"one large main item in front, the others smaller behind it",
	"the items overlap in a diagonal line from lower left to upper right",
	"the main item in the center and the others tilted around it",
	"the items form a tight vertical cluster with the main item on top",
	"the main item on the left and the others cascading to the right at different heights",
	"the items form a triangle, each one tilted at a different dynamic angle",
}

var sportSingles = []string{
	"seen from a dynamic three-quarter angle",
	"flying fast on a diagonal, with glossy lime green speed streaks behind it",
	"wrapped in a glossy lime green flame trail",
	"slightly tilted, with a few small glossy lime green sparks around it",
}

var sportAccents = []string{
	"lime green", "dark teal", "white", "lime green and dark teal", "white with small lime green details",
}

// «один», «крупно», «только»: нужен один предмет, а не группа
var reSportOne = regexp.MustCompile(`(?i)(?:^|[^\p{L}])(один|одна|одно|одного|одну|крупно|крупный|крупная|крупное|single)(?:$|[^\p{L}])`)

// перечень предметов в запросе: запятая, «и», «с», «+»; и слова «ещё что-то», «и другое»: перечень неполный
var reSportList = regexp.MustCompile(`(?i)[,;+]|(?:^|[^\p{L}])(и|с|со)(?:$|[^\p{L}])`)
var reSportMore = regexp.MustCompile(`(?i)(?:^|[^\p{L}])(ещё|еще|что-то|чето|что-нибудь|что-нибуть|другое|другие|прочее|etc|something)(?:$|[^\p{L}])`)

// sportOf: набор вида спорта, названного в запросе (первый подошедший по порядку sportKits)
func sportOf(request string) sportKit {
	low := strings.ToLower(request)
	var words []string
	for _, w := range regexp.MustCompile(`[^\p{L}\d-]+`).Split(low, -1) {
		if w != "" {
			words = append(words, w)
		}
	}
	for _, k := range sportKits {
		for _, key := range k.keys {
			for _, w := range words {
				if strings.HasPrefix(w, key) {
					return k
				}
			}
		}
	}
	return sportGeneric
}

// sportHint: строки для помощника, у каждой картинки пачки своя (rnd == nil — общий генератор).
// «Group:» — сколько предметов в группе (или один крупный), «Props:» — из чего дополнить группу,
// «Arrangement:» — расстановка, «Accent:» — цвет предметов без своего цвета (мяч остаётся настоящим).
func sportHint(request string, rnd *rand.Rand) string {
	pick := func(n int) int {
		if rnd != nil {
			return rnd.Intn(n)
		}
		return rand.Intn(n)
	}
	perm := func(n int) []int {
		if rnd != nil {
			return rnd.Perm(n)
		}
		return rand.Perm(n)
	}
	kit := sportOf(request)
	accent := sportAccents[pick(len(sportAccents))]
	if reSportOne.MatchString(request) {
		return "Group: ONE object only, no other objects.\nArrangement: " + sportSingles[pick(len(sportSingles))] +
			".\nAccent: " + accent + " for the details that have no natural color."
	}
	// предметы перечислены сами («велосипед, шлем и линии»): ничего не добавлять и не терять, только расстановка и цвет.
	// Набор нужен лишь когда названа сама тема («футбольная композиция») или перечень неполный («мяч, бутсы и ещё что-то»)
	if reSportList.MatchString(request) && !reSportMore.MatchString(request) {
		return "Group: exactly the objects the request names, no more and no fewer; do not swap any of them for another item.\nArrangement: " +
			sportArrangements[pick(len(sportArrangements))] + ".\nAccent: " + accent + " for the items that have no natural color."
	}
	n := 2 + pick(3) // 2, 3 или 4 предмета в группе
	n = min(n, len(kit.items))
	// главный предмет вида спорта всегда в группе, остальные — случайные
	items := []string{}
	if kit.keys != nil {
		items = append(items, kit.items[0])
	}
	rest := kit.items
	if kit.keys != nil {
		rest = kit.items[1:]
	}
	for _, i := range perm(len(rest)) {
		if len(items) >= n {
			break
		}
		items = append(items, rest[i])
	}
	return "Group: " + strconv.Itoa(n) + " objects.\nProps: " + strings.Join(items, "; ") +
		".\nArrangement: " + sportArrangements[pick(len(sportArrangements))] +
		".\nAccent: " + accent + " for the items that have no natural color."
}
