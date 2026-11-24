package main

// Стиль «Спорт 3D»: наборы предметов по видам спорта. Задача — чтобы «футбольная композиция» без списка предметов
// каждый раз выходила разной (другие предметы, другая расстановка, другой акцентный цвет), а не одной и той же,
// и чтобы маленький помощник не выдумывал случайное. sportHint даёт помощнику строки «Group:», «Props:», «Arrangement:»,
// «Colors:» (llmEnhance, только для стиля sport3d; правила про них в llmSystemObject).

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

// порядок важен: «настольный теннис» раньше «тенниса», «американский футбол» раньше «футбола».
// Цвета предметов естественные и разные; общей цветовой темы нет. «Футбол» всегда soccer (не американский)
var sportKits = []sportKit{
	{[]string{"настольн", "пинг-понг", "пингпонг", "table"}, []string{
		"a small white table tennis ball", "a table tennis paddle with red rubber", "a second paddle with blue rubber", "a golden trophy", "a stopwatch"}},
	{[]string{"регби", "rugby", "американск"}, []string{
		"an oval rugby ball with white stitches", "a blue rugby helmet", "a white mouthguard case", "a golden trophy", "a silver whistle"}},
	{[]string{"футбол", "soccer", "football", "бутс", "вратар"}, []string{
		"a classic black and white soccer ball",
		"a blue and red soccer cleat with studs",
		"a green goalkeeper glove",
		"a golden trophy cup",
		"a silver referee whistle",
		"a white stopwatch",
		"a pair of white shin guards",
		"a small red corner flag",
		"a yellow referee card"}},
	{[]string{"баскет", "basket"}, []string{
		"an orange basketball with black lines",
		"a white and red basketball sneaker",
		"a basketball hoop with a white net",
		"a small golden trophy",
		"a white sweatband with a blue stripe",
		"a silver whistle",
		"a white stopwatch"}},
	{[]string{"теннис", "tennis", "ракетк"}, []string{
		"a bright yellow-green tennis ball",
		"a tennis racket with a red frame",
		"a second tennis ball",
		"a golden trophy",
		"a white sweatband with a blue stripe",
		"a white tennis sneaker",
		"a blue water bottle"}},
	{[]string{"волейбол", "volley"}, []string{
		"a white and blue volleyball",
		"a white sneaker with a red sole",
		"a pair of black knee pads",
		"a golden trophy",
		"a silver whistle",
		"a white stopwatch"}},
	{[]string{"хокке", "шайб", "hockey", "клюшк"}, []string{
		"a black rubber hockey puck",
		"a red hockey stick with a black tape blade",
		"a white ice skate with a silver blade",
		"a white goalie mask",
		"a blue hockey glove",
		"a golden trophy"}},
	{[]string{"бокс", "box", "mma", "единоборств"}, []string{
		"a pair of glossy red boxing gloves",
		"a golden championship belt",
		"a blue boxing helmet",
		"a white stopwatch",
		"a small brass bell",
		"a white hand wrap roll"}},
	{[]string{"плаван", "бассейн", "swim"}, []string{
		"a pair of blue swimming goggles",
		"a yellow swim cap",
		"a white stopwatch",
		"a golden medal on a ribbon",
		"a blue water bottle",
		"a red and white pool float"}},
	{[]string{"велосипед", "велоспорт", "вело", "bike", "bicycle", "cycling"}, []string{
		"a sleek road bicycle with a red frame and black tyres",
		"a white cycling helmet",
		"a blue cycling shoe",
		"a water bottle",
		"a golden trophy",
		"a white stopwatch"}},
	{[]string{"бег", "марафон", "running", "лёгк", "легк"}, []string{
		"an orange running sneaker with a white sole",
		"a white stopwatch",
		"a golden medal on a ribbon",
		"a blue water bottle",
		"a red finish ribbon",
		"a white sweatband"}},
	{[]string{"бильярд", "billiard", "снукер"}, []string{
		"an empty flat equilateral triangle billiard rack frame lying flat",
		"a wooden billiard cue",
		"a plain black billiard ball",
		"a blue chalk cube",
		"a golden trophy"}},
	{[]string{"гольф", "golf"}, []string{
		"a white golf ball on a tee",
		"a golf club with a silver shaft",
		"a small red golf flag",
		"a white golf glove",
		"a golden trophy"}},
	{[]string{"бейсбол", "baseball"}, []string{
		"a white baseball with red stitches",
		"a wooden baseball bat",
		"a brown baseball glove",
		"a blue baseball cap",
		"a golden trophy"}},
}

// запасной набор: вид спорта в запросе не назван (или не знаем), но стиль спортивный
var sportGeneric = sportKit{items: []string{
	"a golden trophy cup", "a silver whistle", "a white stopwatch",
	"a golden medal on a ribbon", "a red sports sneaker", "a blue water bottle"}}

// расстановка как на образце: предметы разного размера стоят рядом на одном уровне, главный крупнее;
// могут красиво заходить друг за друга, но не парят стопкой и не лежат внутри друг друга
var sportArrangements = []string{
	"one large main item in front, the others smaller and slightly behind it, all at the same height",
	"the main item large on the left, the others placed beside it at different sizes, slightly overlapping in front of each other",
	"the main item in the center, the others on both sides of it a little further back",
	"the items placed side by side in a relaxed row, the main one the biggest, the neighbours slightly overlapping",
	"the main item in front, the others behind it in a staggered row, each one clearly visible, exactly one of each",
	"a close group where the items lean lightly on each other, like a still life",
}

var sportSingles = []string{
	"seen from a dynamic three-quarter angle",
	"flying fast on a diagonal, with glossy bright speed streaks behind it",
	"wrapped in a glossy bright flame trail",
	"slightly tilted, with a few small glossy bright sparks around it",
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
// «Arrangement:» — расстановка, «Colors:» — у каждого предмета свой естественный цвет.
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
	baseLine := "\nBase: " + sportBases[pick(len(sportBases))] +
		"\nBiggest: " + sportBiggest[pick(len(sportBiggest))]
	if reSportOne.MatchString(request) {
		return "Group: ONE object only, no other objects.\nArrangement: " + sportSingles[pick(len(sportSingles))] +
			".\nColors: " + sportColors + baseLine
	}
	// предметы перечислены сами («велосипед, шлем и линии»): ничего не добавлять и не терять, только расстановка и цвет.
	// Набор нужен лишь когда названа сама тема («футбольная композиция») или перечень неполный («мяч, бутсы и ещё что-то»)
	if reSportList.MatchString(request) && !reSportMore.MatchString(request) {
		return "Group: exactly the objects the request names, no more and no fewer; do not swap any of them for another item.\nArrangement: " +
			sportArrangements[pick(len(sportArrangements))] + ".\nColors: " + sportColors + baseLine
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
		".\nColors: " + sportColors + baseLine
}

// цвета: у каждого предмета свой естественный, общей цветовой темы нет
const sportColors = "each object has its own different natural vivid color, no shared color theme, no color on all objects; tyres, rubber and tools stay black or grey, balls keep their real look; one of each named object."

// подставка: чаще всего её нет, иногда тонкий тёмный постамент
var sportBases = []string{
	"no platform and no ground: the objects are placed close together on a plain pure white background, no floor, no ground",
	"no platform and no ground: the objects are placed close together on a plain pure white background, no floor, no ground",
	"no platform and no ground: the objects are placed close together on a plain pure white background, no floor, no ground",
	"no platform and no ground: the objects are placed close together on a plain pure white background, no floor, no ground",
	"no platform and no ground: the objects are placed close together on a plain pure white background, no floor, no ground",
}

// чтобы один и тот же запрос каждый раз давал новую картинку: случайные ракурс, цветовая гамма и кто в группе главный
var sportAngles = []string{
	"camera angle: straight front view, symmetrical",
	"camera angle: three-quarter view from the left, 30 degrees from above",
	"camera angle: three-quarter view from the right, 30 degrees from above",
	"camera angle: extreme low angle, camera at floor level looking up at the objects, heroic perspective",
	"camera angle: pure side profile view",
	"camera angle: high angle looking down at the group from above",
	"camera angle: dynamic dutch tilt, the group leaning towards the camera, wide lens close-up",
}

var sportBiggest = []string{
	"the first named object is the biggest",
	"the second named object is the biggest",
	"the third named object is the biggest",
	"the last named object is the biggest",
}

var (
	reSoccerOnly   = regexp.MustCompile(`(?i)регби|rugby|американск|american`)
	reFootballBoot = regexp.MustCompile(`(?i)\bfootball (boots?|shoes?|cleats?)\b`)
	reAmFootball   = regexp.MustCompile(`(?i)\b(american )?football\b`)
)

// sportFixSoccer: картинка-модель рисует слово «football» американским мячом; в футбольном запросе пишем soccer
func sportFixSoccer(request, p string) string {
	if reSoccerOnly.MatchString(request) {
		return p
	}
	p = reFootballBoot.ReplaceAllString(p, "soccer $1")
	return reAmFootball.ReplaceAllString(p, "soccer ball")
}

// sportAngle: ракурс дописывается к готовому промту кодом: помощник его в описании не передавал, и картинки выходили в одном ракурсе
func sportAngle() string {
	return sportAngles[rand.Intn(len(sportAngles))]
}
