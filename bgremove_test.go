package main

import (
	"bytes"
	"image"
	"image/color"
	"math"
	"os"
	"testing"
)

func TestF16RoundTrip(t *testing.T) {
	for _, v := range []float32{0, 1, -1, 0.5, 65504, -2.5, 1e-5, 0.1} {
		got := f16to32(f32to16(v))
		if math.Abs(float64(got-v)) > math.Abs(float64(v))*1e-3+1e-7 {
			t.Errorf("%v → %v", v, got)
		}
	}
	if f32to16(float32(math.Inf(1))) != 0x7c00 || f32to16(1e6) != 0x7c00 {
		t.Error("inf")
	}
}

// модель из одного узла Add(вход, вес): после перевода вход и выход float32, Cast на входе и выходе, вес в fp16
func TestOnnxToFP16Tiny(t *testing.T) {
	w := []pbField{pbInt(1, 1), pbInt(2, onnxFloat), pbStr(8, "w"), pbBytes(9, []byte{0, 0, 128, 63})} // [1] 1.0
	vi := func(name string) []byte { return pbEnc([]pbField{pbStr(1, name)}) }
	node := []pbField{pbStr(1, "x"), pbStr(1, "w"), pbStr(2, "y"), pbStr(3, "add"), pbStr(4, "Add")}
	g := []pbField{pbBytes(1, pbEnc(node)), pbStr(2, "g"), pbBytes(5, pbEnc(w)), pbBytes(11, vi("x")), pbBytes(12, vi("y"))}
	model := pbEnc([]pbField{pbInt(1, 8), pbBytes(7, pbEnc(g))})
	out, err := onnxToFP16(model)
	if err != nil {
		t.Fatal(err)
	}
	m, err := pbParse(out)
	if err != nil {
		t.Fatal(err)
	}
	gg, _ := pbParse(pbGet(m, 7).data)
	var ops []string
	weights := map[string]int{}
	for _, f := range gg {
		switch f.num {
		case 1:
			n, _ := pbParse(f.data)
			ops = append(ops, pbGetStr(n, 4)+":"+pbStrs(n, 1)[0])
		case 5:
			tt, _ := pbParse(f.data)
			weights[pbGetStr(tt, 8)] = pbGetInt(tt, 2)
		}
	}
	want := []string{"Cast:x", "Add:x_fp16", "Cast:y_fp16out"}
	if len(ops) != len(want) {
		t.Fatalf("ops %v", ops)
	}
	for i := range want {
		if ops[i] != want[i] {
			t.Fatalf("ops %v", ops)
		}
	}
	if weights["w_t10"] != onnxF16 {
		t.Errorf("weights %v", weights)
	}
	if _, ok := weights["w"]; ok {
		t.Errorf("unused float32 weight left: %v", weights)
	}
}

func TestBgBoxBlur(t *testing.T) {
	w, h := 7, 5
	src := make([]float64, w*h*4)
	for i := range src {
		src[i] = float64(i%13) * 0.5
	}
	got := bgBoxBlur4(src, w, h, 2)
	// прямой подсчёт с повтором крайних
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			for c := 0; c < 4; c++ {
				s := 0.0
				for dy := -2; dy <= 2; dy++ {
					for dx := -2; dx <= 2; dx++ {
						xx, yy := min(max(x+dx, 0), w-1), min(max(y+dy, 0), h-1)
						s += src[(yy*w+xx)*4+c]
					}
				}
				if math.Abs(s-got[(y*w+x)*4+c]) > 1e-9 {
					t.Fatalf("(%d,%d,%d): %v != %v", x, y, c, got[(y*w+x)*4+c], s)
				}
			}
		}
	}
}

// подставная модель: левая половина — объект (логит +10), правая — фон (−10)
func TestBgRun(t *testing.T) {
	img := image.NewNRGBA(image.Rect(0, 0, 300, 200))
	for y := 0; y < 200; y++ {
		for x := 0; x < 300; x++ {
			img.SetNRGBA(x, y, color.NRGBA{200, 50, 50, 255})
		}
	}
	infer := func(x []float32, shape []int64) ([]float32, []int64, error) {
		if len(x) != 3*bgSide*bgSide || shape[2] != bgSide {
			t.Fatalf("input %d %v", len(x), shape)
		}
		const s = 64
		out := make([]float32, s*s)
		for i := range out {
			if i%s < s/2 {
				out[i] = 10
			} else {
				out[i] = -10
			}
		}
		return out, []int64{1, 1, s, s}, nil
	}
	res, err := bgRun(img, infer)
	if err != nil {
		t.Fatal(err)
	}
	if res.Bounds().Dx() != 300 || res.Bounds().Dy() != 200 {
		t.Fatal(res.Bounds())
	}
	if a := res.NRGBAAt(10, 100).A; a < 250 {
		t.Errorf("left alpha %d", a)
	}
	if a := res.NRGBAAt(290, 100).A; a > 5 {
		t.Errorf("right alpha %d", a)
	}
	if c := res.NRGBAAt(10, 100); c.R != 200 || c.G != 50 {
		t.Errorf("color %v", c)
	}
}

func TestBgMaskProbabilities(t *testing.T) {
	m, s, err := bgMask([]float32{0, 0.5, 1, 0.25}, []int64{1, 1, 2, 2})
	if err != nil || s != 2 || m[1] != 0.5 || m[2] != 1 {
		t.Fatal(m, s, err)
	}
	if _, _, err := bgMask([]float32{1, 2}, []int64{1, 2}); err == nil {
		t.Error("bad shape accepted")
	}
}

// Настоящая модель (только по просьбе): KB_ONNX_IN=fp32.onnx KB_ONNX_OUT=fp16.onnx go test -run TestOnnxRealConvert
func TestOnnxRealConvert(t *testing.T) {
	in, out := os.Getenv("KB_ONNX_IN"), os.Getenv("KB_ONNX_OUT")
	if in == "" || out == "" {
		t.Skip("KB_ONNX_IN/KB_ONNX_OUT")
	}
	if err := aiConvert(in, out, "fp16"); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(out)
	if !bytes.Contains(b, []byte("Cast")) {
		t.Error("no Cast")
	}
	t.Logf("%d MB", len(b)>>20)
}
