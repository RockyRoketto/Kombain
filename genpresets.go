package main

// Стили-пресеты и размеры генератора картинок. Пресет — шаблон промта и негатив: пользователь видит только название
// (gn.pre.<id> и подсказку gn.preHint.<id> в web/i18n.json), а модель получает описание стиля.
// Позже (сессии 6+) пресет сможет назвать свою модель и LoRA из каталога.

import (
	"math"
	"regexp"
	"strconv"
	"strings"
)

type GenPreset struct {
	ID       string `json:"id"`
	Template string `json:"-"` // {p} — запрос пользователя
	Negative string `json:"-"`
	// Format: что нужно этому виду картинки, строкой «Format:» для помощника (llmEnhance). Без неё помощник пишет
	// обычную сцену. Стиль он не называет: стиль добавляет Template.
	Format string `json:"-"`
	// Framed: кадр задаёт сам стиль (один предмет на фоне, вид сверху), подсказка разнообразия меняет только свет
	Framed bool `json:"-"`
	// Object: картинка — один предмет или персонаж, фон и свет задаёт стиль. Помощник пишет по своим указаниям
	// llmSystemObject (только сам предмет), без подсказки разнообразия и строки «Format:».
	Object bool `json:"-"`
}

// genNegBase: что не нужно никогда. Текст на картинках автору не нужен (решение 2026-11-12), поэтому он тоже здесь.
const genNegBase = "text, watermark, signature, logo, lowres, blurry, jpeg artifacts, deformed, disfigured, bad anatomy, extra fingers, fused fingers, missing fingers, malformed hands, mutated hands, extra limbs, extra arms, poorly drawn face, cropped, out of frame"

// genPresets: порядок здесь не важен, группы и порядок в окне «Ещё стили…» задаёт GN_GROUPS в gentab.js.
// Новый стиль: запись здесь, gn.pre.<id> и gn.preHint.<id> на обоих языках в web/i18n.json, группа и градиент в gentab.js.
var genPresets = []GenPreset{
	{ID: "none", Template: "{p}"},

	// ---- фото и кино ----
	{ID: "photo",
		Template: "{p}, professional photograph, natural light, sharp focus, high detail, 35mm lens",
		Negative: "illustration, painting, drawing, cartoon, 3d render, cgi"},
	{ID: "portrait",
		Template: "portrait photograph of {p}, 85mm lens, soft studio lighting, shallow depth of field, natural skin texture, sharp eyes",
		Negative: "illustration, painting, cartoon, 3d render, distorted face, cross-eyed",
		Format:   "a portrait: the person (or creature) from the chest up, facing the viewer, simple softly blurred background. Keep the action of the request if it involves the face or hands."},
	{ID: "cinema",
		Template: "cinematic film still of {p}, dramatic lighting, shallow depth of field, film grain, color graded, anamorphic",
		Negative: "cartoon, illustration, flat lighting"},
	{ID: "product",
		Template: "commercial product photo of {p}, studio softbox lighting, clean seamless background, sharp focus, high detail, advertising shot",
		Negative: "illustration, painting, cartoon, cluttered background, people",
		Format:   "the item alone on a clean seamless studio backdrop or a simple surface, no environment, no people.",
		Framed:   true},
	{ID: "food",
		Template: "appetizing food photography of {p}, soft natural window light, shallow depth of field, fresh, high detail, styled table",
		Negative: "illustration, cartoon, 3d render, unappetizing, messy",
		Format:   "food close-up: the dish on a plate or board on a table, a few fitting props at most, simple background."},
	{ID: "macro",
		Template: "macro photograph of {p}, extreme close-up, fine texture detail, shallow depth of field, soft bokeh background",
		Negative: "illustration, cartoon, wide shot, 3d render",
		Format:   "an extreme close-up of the subject or its most interesting part, the background only a soft blur.",
		Framed:   true},
	{ID: "aerial",
		Template: "aerial drone photograph of {p}, top-down view from high above, crisp detail, natural colors",
		Negative: "illustration, cartoon, ground level view, 3d render",
		Format:   "seen straight from high above, like a drone photo: describe the layout, shapes and colors as they look from the sky.",
		Framed:   true},
	{ID: "bw",
		Template: "black and white photograph of {p}, monochrome, rich contrast, fine grain, timeless documentary look",
		Negative: "color, colorful, illustration, cartoon, 3d render"},
	{ID: "retro",
		Template: "vintage analog photo of {p}, 35mm film, faded warm colors, light leaks, soft grain, 1970s look",
		Negative: "digital, sharp, hdr, modern, illustration"},

	// ---- рисунок и живопись ----
	{ID: "illus",
		Template: "digital illustration of {p}, clean shapes, rich colors, detailed, professional artwork",
		Negative: "photo, photorealistic"},
	{ID: "cartoon",
		Template: "2d cartoon illustration of {p}, bold clean outlines, bright flat colors, expressive friendly shapes, animated series style",
		Negative: "photo, photorealistic, 3d render, gritty, realistic",
		Format:   "a clear, readable scene with few elements and a simple background."},
	{ID: "storybook",
		Template: "children's storybook illustration of {p}, soft gouache textures, warm gentle colors, whimsical, cozy",
		Negative: "photo, photorealistic, 3d render, dark, scary"},
	{ID: "anime",
		Template: "anime artwork of {p}, cel shading, vibrant colors, key visual, detailed background",
		Negative: "photo, photorealistic, 3d render"},
	{ID: "water",
		Template: "watercolor painting of {p}, soft washes, visible paper texture, delicate brush strokes",
		Negative: "photo, 3d render, harsh lines"},
	{ID: "oil",
		Template: "oil painting of {p}, thick impasto brush strokes, rich textured canvas, classical painting, warm palette",
		Negative: "photo, photorealistic, 3d render, flat colors"},
	{ID: "impress",
		Template: "impressionist painting of {p}, loose visible brush strokes, vibrant dappled light, soft edges",
		Negative: "photo, photorealistic, 3d render, sharp lines"},
	{ID: "sketch",
		Template: "pencil sketch of {p}, graphite hatching, hand drawn, monochrome, sketchbook paper",
		Negative: "color, photo, photorealistic, 3d render"},
	{ID: "ink",
		Template: "ink drawing of {p}, black ink on white paper, expressive brush and pen lines, cross-hatching, high contrast",
		Negative: "color, photo, photorealistic, 3d render, gradient"},
	{ID: "comic",
		Template: "comic book illustration of {p}, bold ink outlines, halftone shading, dynamic composition, vivid flat colors",
		Negative: "photo, photorealistic, watercolor, blurry"},
	{ID: "popart",
		Template: "pop art of {p}, bold flat colors, thick black outlines, halftone dots, high contrast, 1960s print style",
		Negative: "photo, photorealistic, 3d render, muted colors"},
	{ID: "fantasy",
		Template: "epic fantasy concept art of {p}, painterly, dramatic atmospheric light, intricate detail, magical mood",
		Negative: "photo, flat, minimal, modern"},

	// ---- 3D и игры ----
	{ID: "icon3d",
		Template: "3d icon of {p}, isometric, soft clay render, smooth glossy plastic, soft studio lighting, simple solid background, centered, single object",
		Negative: "photo, photograph, photorealistic, realistic, depth of field, bokeh, busy background, multiple objects",
		Object:   true, Framed: true},
	{ID: "render3d",
		Template: "3d animated movie still of {p}, stylized characters, soft global illumination, subsurface scattering, vibrant colors, high quality cgi",
		Negative: "photo, photorealistic, 2d, flat, sketch"},
	{ID: "clay",
		Template: "claymation of {p}, handmade plasticine models, visible fingerprints and clay texture, stop motion look, soft lighting",
		Negative: "photo, photorealistic, 2d, flat illustration, glossy plastic"},
	{ID: "lowpoly",
		Template: "low poly 3d render of {p}, faceted geometric surfaces, soft pastel gradients, clean studio background",
		Negative: "photo, photorealistic, smooth, detailed texture"},
	{ID: "isometric",
		Template: "isometric 3d diorama of {p}, cute miniature scene on a small square base, soft lighting, clean pastel background",
		Negative: "photo, photorealistic, perspective distortion, cluttered",
		Format:   "a small compact scene on a square base, like a miniature model, plain background around it.",
		Framed:   true},
	{ID: "pixel",
		Template: "pixel art of {p}, 16-bit retro game sprite style, crisp pixels, limited palette",
		Negative: "photo, photorealistic, smooth, blurry, anti-aliased, 3d render"},

	// ---- дизайн и графика ----
	{ID: "sticker",
		Template: "die-cut sticker of {p}, thick white border, bold outlines, vibrant colors, cute, plain white background",
		Negative: "photo, photorealistic, busy background, multiple stickers, cropped",
		Object:   true, Framed: true},
	{ID: "flaticon",
		Template: "flat icon of {p}, simple geometric shapes, few solid colors, centered, plain background, vector, ui icon",
		Negative: "photo, photorealistic, 3d, gradient noise, detailed texture, busy background",
		Object:   true, Framed: true},
	{ID: "sportbanner",
		Template: "banner illustration of {p}, clean composition with a clear empty space in the middle, soft lighting, plain solid dark color background, vibrant limited palette",
		Negative: "photo, busy background, cluttered, people, text, geometric shapes, patterns, abstract shapes in the background",
		Format:   "only the objects the request names, one of each unless the request gives a number, on a plain solid color background with nothing behind them.",
		Framed:   true},
	{ID: "flat",
		Template: "flat vector illustration of {p}, minimal, geometric shapes, limited color palette, clean background",
		Negative: "photo, photorealistic, gradient noise, 3d",
		Format:   "a simple clear composition with few elements and an uncluttered background."},
	{ID: "lineart",
		Template: "clean line art of {p}, black outlines on white, no shading, coloring book page, even line weight",
		Negative: "color, shading, gradient, photo, photorealistic, 3d render, gray fill",
		Format:   "clear shapes with distinct outlines, simple background with few elements."},
	{ID: "papercut",
		Template: "layered paper cut art of {p}, cut paper craft, soft shadows between layers, depth, handmade",
		Negative: "photo, photorealistic, 3d render, flat, glossy"},
	{ID: "poster",
		Template: "vintage travel poster illustration of {p}, bold simplified shapes, limited flat colors, screen print texture, graphic design",
		Negative: "photo, photorealistic, 3d render, cluttered"},
	{ID: "minimal",
		Template: "minimalist art of {p}, lots of negative space, simple shapes, muted calm colors, clean composition",
		Negative: "busy, cluttered, detailed, photo, realistic",
		Format:   "very few elements and lots of empty space around the subject, plain background."},
	{ID: "neon",
		Template: "neon cyberpunk scene of {p}, glowing neon lights, rainy night, magenta and cyan, high contrast, futuristic",
		Negative: "daylight, pastel, flat, minimal"},
	{ID: "synthwave",
		Template: "synthwave retrowave art of {p}, 1980s retro futurism, glowing grid, purple and pink sunset gradient, chrome, neon glow",
		Negative: "photo, daylight, muted colors, realistic"},
	{ID: "blueprint",
		Template: "technical blueprint drawing of {p}, white precise lines on deep blue paper, engineering schematic, orthographic views",
		Negative: "photo, photorealistic, color, 3d render, shading",
		Format:   "the subject shown as a technical drawing, plain background, no environment.",
		Framed:   true},
}

func genPreset(id string) GenPreset {
	for _, p := range genPresets {
		if p.ID == id {
			return p
		}
	}
	return genPresets[0]
}

// apply: промт и негатив для модели. Свой негатив пользователя дописывается к негативу стиля.
func (p GenPreset) apply(prompt, negative string) (string, string) {
	prompt = strings.TrimSpace(prompt)
	full := strings.ReplaceAll(p.Template, "{p}", prompt)
	neg := []string{}
	for _, s := range []string{strings.TrimSpace(negative), p.Negative, genNegBase} {
		if s != "" {
			neg = append(neg, s)
		}
	}
	return full, strings.Join(neg, ", ")
}

// genRatios: пропорции в интерфейсе. Порядок — порядок кнопок.
var genRatios = []string{"1:1", "16:9", "9:16", "4:5", "3:2", "2:3"}

// genSize: размер под пропорцию с той же площадью, что родное разрешение модели (так модель рисует лучше всего),
// стороны кратны 64.
func genSize(nw, nh int, ratio string) (int, int) {
	if nw <= 0 || nh <= 0 {
		nw, nh = 1024, 1024
	}
	a, b := 1.0, 1.0
	if x, y, ok := strings.Cut(ratio, ":"); ok {
		if fa, e1 := strconv.ParseFloat(x, 64); e1 == nil && fa > 0 {
			if fb, e2 := strconv.ParseFloat(y, 64); e2 == nil && fb > 0 {
				a, b = fa, fb
			}
		}
	}
	area := float64(nw * nh)
	w := math.Sqrt(area * a / b)
	h := w * b / a
	r64 := func(v float64) int { return max(64, int(math.Round(v/64))*64) }
	return r64(w), r64(h)
}

// genArchDefaults: если у модели нет своих настроек (своя модель без каталога), берём обычные для её архитектуры
func genArchDefaults(arch string) GenDefaults {
	switch arch {
	case "sd15":
		return GenDefaults{Steps: 25, CFG: 7, Width: 512, Height: 512}
	case "flux":
		return GenDefaults{Steps: 4, CFG: 1, Width: 1024, Height: 1024}
	case "zimage":
		return GenDefaults{Steps: 8, CFG: 1, Width: 1024, Height: 1024}
	case "flux2":
		return GenDefaults{Steps: 4, CFG: 1, Width: 1024, Height: 1024}
	case "chroma":
		return GenDefaults{Steps: 26, CFG: 4, Width: 1024, Height: 1024}
	}
	return GenDefaults{Steps: 20, CFG: 7, Width: 1024, Height: 1024}
}

// genPreviewEvery: кадр предпросмотра примерно 4–5 раз за картинку. Чаще — дороже (tae ~0,25 с на кадр), а кадры всё равно
// плавно перетекают друг в друга.
func genPreviewEvery(steps int) int {
	return max(1, int(math.Round(float64(steps)/5)))
}

// genAnatomyTail: что дописать к промту, когда на картинке люди и руки. У моделей с CFG 1 (klein, Z-Image Turbo, FLUX)
// негативный промт не работает совсем, и «не рисуй клешни» им сказать нечем; остаётся сказать, что рисовать
// (жалоба автора 2026-11-20: руки у klein выходят клешнями). Список слов короткий: лишний хвост без людей только мешает.
const genAnatomyTail = "natural anatomy, well-formed hands with five fingers each"

var genPeopleRe = regexp.MustCompile(`(?i)\b(man|men|woman|women|person|people|boy|girl|child|kid|portrait|hand|hands|finger|fingers|face|he|she|his|her)\b|муж|женщ|человек|люд|рук|палец|пальц|парен|девуш|дев[оч]|мальч|ребён|портрет|лиц`)

func genWithAnatomy(prompt string) string {
	if !genPeopleRe.MatchString(prompt) {
		return prompt
	}
	return strings.TrimRight(prompt, ". ") + ". " + genAnatomyTail
}
