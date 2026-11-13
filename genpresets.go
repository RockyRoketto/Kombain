package main

// Стили-пресеты и размеры генератора картинок. Пресет — шаблон промта и негатив: пользователь видит только название
// (gn.pre.<id> и подсказку gn.preHint.<id> в web/i18n.json), а модель получает описание стиля.
// Позже (сессии 6+) пресет сможет назвать свою модель и LoRA из каталога.

import (
	"math"
	"strconv"
	"strings"
)

type GenPreset struct {
	ID       string `json:"id"`
	Template string `json:"-"` // {p} — запрос пользователя
	Negative string `json:"-"`
}

// genNegBase: что не нужно никогда. Текст на картинках автору не нужен (решение 2026-11-12), поэтому он тоже здесь.
const genNegBase = "text, watermark, signature, logo, lowres, blurry, jpeg artifacts, deformed, extra fingers, bad anatomy"

var genPresets = []GenPreset{
	{ID: "none", Template: "{p}"},
	{ID: "photo",
		Template: "{p}, professional photograph, natural light, sharp focus, high detail, 35mm lens",
		Negative: "illustration, painting, drawing, cartoon, 3d render, cgi"},
	{ID: "cinema",
		Template: "cinematic film still of {p}, dramatic lighting, shallow depth of field, film grain, color graded, anamorphic",
		Negative: "cartoon, illustration, flat lighting"},
	{ID: "illus",
		Template: "digital illustration of {p}, clean shapes, rich colors, detailed, professional artwork",
		Negative: "photo, photorealistic"},
	{ID: "icon3d",
		Template: "3d icon of {p}, isometric, soft clay render, smooth glossy plastic, soft studio lighting, simple solid background, centered, single object",
		Negative: "photo, busy background, multiple objects"},
	{ID: "flat",
		Template: "flat vector illustration of {p}, minimal, geometric shapes, limited color palette, clean background",
		Negative: "photo, photorealistic, gradient noise, 3d"},
	{ID: "anime",
		Template: "anime artwork of {p}, cel shading, vibrant colors, key visual, detailed background",
		Negative: "photo, photorealistic, 3d render"},
	{ID: "water",
		Template: "watercolor painting of {p}, soft washes, visible paper texture, delicate brush strokes",
		Negative: "photo, 3d render, harsh lines"},
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
	}
	return GenDefaults{Steps: 20, CFG: 7, Width: 1024, Height: 1024}
}

// genPreviewEvery: кадр предпросмотра примерно 4–5 раз за картинку. Чаще — дороже (tae ~0,25 с на кадр), а кадры всё равно
// плавно перетекают друг в друга.
func genPreviewEvery(steps int) int {
	return max(1, int(math.Round(float64(steps)/5)))
}
