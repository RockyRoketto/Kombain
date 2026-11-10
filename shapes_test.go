package main

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/png"
	"math"
	"os"
	"strconv"
	"strings"
	"testing"
)

// grayPNG: картинка одного серого цвета, в base64, как её присылает страница
func grayPNG(t *testing.T, v uint8) string {
	t.Helper()
	img := image.NewGray(image.Rect(0, 0, 320, 240))
	for i := range img.Pix {
		img.Pix[i] = v
	}
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(b.Bytes())
}

// Прорисовка: кадры идут по одному на 1/fps от начала клипа, последний держится до конца; метка начала вывода сдвигает начало;
// нет кадров в кэше — фигура целиком (Path)
func TestShapeSeqRender(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
	m := newMontFixture(t)
	black := m.color("black.mp4", "black", 320, 240, 30, 2, 0)
	var frames []string
	for i := 0; i < 10; i++ {
		frames = append(frames, grayPNG(t, uint8(i*25)))
	}
	seq, _, err := saveShapeSeq(frames, 30)
	if err != nil {
		t.Fatal(err)
	}
	full, _, err := saveTextPNG(grayPNG(t, 255))
	if err != nil {
		t.Fatal(err)
	}
	near := func(name string, got, want float64) {
		t.Helper()
		if math.Abs(got-want) > 6 {
			t.Errorf("%s: яркость %.0f, должно быть %.0f", name, got, want)
		}
	}
	shape := Clip{Path: full, At: 0.5, Len: 1.5, Seq: seq, SeqN: 10, SeqFps: 30}
	out := m.render(tracks([]Clip{{Path: black}}, []Clip{shape}), "mp4")
	for n := 14; n < 30; n++ { // клип с кадра 15
		want := float64(min(n-15, 9) * 25)
		if n < 15 {
			want = 0
		}
		near("кадр "+strconv.Itoa(n), m.midGray(out, n), want)
	}
	p := tracks([]Clip{{Path: black}}, []Clip{shape})
	p.In = 0.6 // три кадра прорисовки уже прошли
	out = m.render(p, "mp4")
	for n := 0; n < 9; n++ {
		near("с метки начала, кадр "+strconv.Itoa(n), m.midGray(out, n), float64(min(n+3, 9)*25))
	}
	// снимок кадра монтажа идёт тем же tlInput: в середине прорисовки — её кадр, а не фигура целиком
	for _, at := range []float64{0.6, 0.7} {
		shot, err := saveMontFrame(m.ffm, tracks([]Clip{{Path: black}}, []Clip{shape}), at)
		if err != nil {
			t.Fatal("снимок: ", err)
		}
		near("снимок на "+secs(at), m.midGray(shot, 0), float64(int(at*30+1e-6)-15)*25)
	}
	// прорисовка целиком до метки начала: фигура целиком
	p.In = 1
	out = m.render(p, "mp4")
	near("после прорисовки", m.midGray(out, 0), 255)

	// чистка кэша убрала кадр: без прорисовки, фигура целиком
	os.Remove(strings.Replace(seq, "%04d", "0004", 1))
	if shapeSeqOK(seq, 10) {
		t.Error("кадра нет, а последовательность цела")
	}
	out = m.render(tracks([]Clip{{Path: black}}, []Clip{shape}), "mp4")
	near("без кадров", m.midGray(out, 16), 255)
}

func TestShapeSeqInput(t *testing.T) {
	if got := shapeSeqInput(`C:\a%b\seq-1-%04d.png`); got != `C:\a%%b\seq-1-%04d.png` {
		t.Errorf("got %s", got)
	}
}
