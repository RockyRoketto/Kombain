package main

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/color"
	"image/png"
	"testing"
)

// revealPNG: белая картинка с прозрачным фоном; видна левая часть шириной cols точек из 320 (как буквы, которые уже появились)
func revealPNG(t *testing.T, cols int) string {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, 320, 240))
	for y := 0; y < 240; y++ {
		for x := 0; x < cols; x++ {
			img.SetNRGBA(x, y, color.NRGBA{255, 255, 255, 255})
		}
	}
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(b.Bytes())
}

// Появление текста идёт тем же путём, что прорисовка фигуры: кадры страницы (прозрачные, часть текста видна) ложатся на чёрный
// кадр по одному на 1/fps, последний держится до конца клипа. Левая часть видна с начала, правая только к концу появления.
// Те же кадры при ключах непрозрачности (плавное «проявление» поверх появления) идут вместе
func TestTextRevealRender(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
	m := newMontFixture(t)
	black := m.color("black.mp4", "black", 320, 240, 30, 2, 0)
	var frames []string
	for i := 0; i < 6; i++ {
		frames = append(frames, revealPNG(t, 53*(i+1))) // 318 из 320: Go пишет полностью непрозрачный PNG без альфа-канала, у настоящих кадров страницы он есть всегда
	}
	seq, _, err := saveShapeSeq(frames, 30)
	if err != nil {
		t.Fatal(err)
	}
	full, _, err := saveTextPNG(revealPNG(t, 318))
	if err != nil {
		t.Fatal(err)
	}
	text := Clip{Path: full, At: 0, Len: 1.5, Seq: seq, SeqN: 6, SeqFps: 30}
	out := m.render(tracks([]Clip{{Path: black}}, []Clip{text}), "mp4")
	// кадр n виден до столбца 53*(n+1); дальше чёрный фон
	for n := 0; n < 5; n++ {
		row := m.rowAt(out, n)
		edge := 53 * (n + 1)
		if row[edge-10] < 240 {
			t.Errorf("кадр %d: слева от границы %d должно быть светло, а там %d", n, edge, row[edge-10])
		}
		if row[min(edge+10, 319)] > 15 {
			t.Errorf("кадр %d: справа от границы %d должно быть темно, а там %d", n, edge, row[min(edge+10, 319)])
		}
	}
	for _, n := range []int{5, 10, 40} { // текст целиком и держится до конца клипа
		row := m.rowAt(out, n)
		if row[10] < 240 || row[160] < 240 || row[310] < 240 {
			t.Errorf("кадр %d: текст должен быть виден целиком, а там %d %d %d", n, row[10], row[160], row[310])
		}
	}
	if row := m.rowAt(out, 50); row[160] > 15 { // клип кончился на 1,5 с
		t.Errorf("после клипа должен быть фон, а там %d", row[160])
	}

	// с ключами непрозрачности: те же кадры, но слой проявляется целиком
	keyed := text
	keyed.Keys = &Keys{O: []Key{{S: 0, V: 0}, {S: 1, V: 1}}}
	out = m.render(tracks([]Clip{{Path: black}}, []Clip{keyed}), "mp4")
	if a, b := m.rowAt(out, 0)[10], m.rowAt(out, 15)[10]; a > 15 || b < 100 || b > 160 {
		t.Errorf("с ключами: в начале %d (ждали ~0), на полпути %d (ждали ~128)", a, b)
	}
	if row := m.rowAt(out, 3); row[300] > 15 {
		t.Errorf("с ключами: правая часть до конца появления должна быть темной, а там %d", row[300])
	}
}
