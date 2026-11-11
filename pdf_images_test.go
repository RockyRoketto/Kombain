package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"testing"
)

// testJPEG: JPEG w×h, при orient > 1 с EXIF-тегом поворота
func testJPEG(t *testing.T, path string, w, h, orient int) {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for i := range img.Pix {
		img.Pix[i] = byte(i * 7)
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 80}); err != nil {
		t.Fatal(err)
	}
	d := buf.Bytes()
	if orient > 1 {
		// APP1 Exif: TIFF II, одна запись IFD0 — Orientation (0x0112, SHORT)
		tiff := []byte{'I', 'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, byte(orient), 0, 0, 0, 0, 0, 0, 0}
		seg := append([]byte("Exif\x00\x00"), tiff...)
		app := []byte{0xFF, 0xE1, 0, 0}
		binary.BigEndian.PutUint16(app[2:], uint16(len(seg)+2))
		d = append(append(append([]byte{0xFF, 0xD8}, app...), seg...), d[2:]...)
	}
	if err := os.WriteFile(path, d, 0o644); err != nil {
		t.Fatal(err)
	}
}

func testAlphaPNG(t *testing.T, path string, w, h int) {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.NRGBA{200, 30, 30, uint8(x * 255 / w)}) // полупрозрачный
		}
	}
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	png.Encode(f, img)
}

func TestJPEGOrientation(t *testing.T) {
	dir := t.TempDir()
	for o := 1; o <= 8; o++ {
		p := filepath.Join(dir, "o.jpg")
		testJPEG(t, p, 40, 20, o)
		im, err := prepImage(p, "orig")
		if err != nil {
			t.Fatal(err)
		}
		if im.orient != o || im.filter != "DCTDecode" {
			t.Fatalf("orient %d: got %d %s", o, im.orient, im.filter)
		}
		w, h := im.shown()
		if (o >= 5) != (w == 20 && h == 40) {
			t.Fatalf("orient %d: shown %v×%v", o, w, h)
		}
		// матрица переводит единичный квадрат картинки ровно в единичный квадрат
		u0, us, ut, v0, vs, vt := orientMatrix(o)
		for _, c := range [][2]float64{{0, 0}, {1, 0}, {0, 1}, {1, 1}} {
			u, v := u0+us*c[0]+ut*c[1], v0+vs*c[0]+vt*c[1]
			if (u != 0 && u != 1) || (v != 0 && v != 1) {
				t.Fatalf("orient %d: corner %v → %v,%v", o, c, u, v)
			}
		}
	}
}

func TestPageLayout(t *testing.T) {
	// альбомная картинка на A4 «авто» — страница альбомная, картинка вписана с полями 10 мм
	pw, ph, x, y, w, h := pageLayout(ImgPDFOpts{Page: "a4", Orient: "auto", Margin: 10}, 4000, 3000)
	if pw < ph {
		t.Fatalf("A4 auto for landscape image: %v×%v", pw, ph)
	}
	m := 10 * 72 / 25.4
	if x < m-0.01 || y < m-0.01 || math.Abs(w/h-4.0/3) > 1e-6 || x+w > pw-m+0.01 || y+h > ph-m+0.01 {
		t.Fatalf("layout %v %v %v %v", x, y, w, h)
	}
	if pw, ph, _, _, _, _ := pageLayout(ImgPDFOpts{Page: "a4", Orient: "portrait"}, 4000, 3000); pw > ph {
		t.Fatal("portrait forced")
	}
	pw, ph, x, _, w, _ = pageLayout(ImgPDFOpts{Page: "fit"}, 800, 600)
	if pw != 600 || ph != 450 || x != 0 || w != 600 {
		t.Fatalf("fit: %v×%v", pw, ph)
	}
}

// 20 картинок разных видов в один PDF: порядок, страницы, кириллица, битая картинка пропускается
func TestImg2PDF(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "Отпуск 2026")
	os.MkdirAll(dir, 0o755)
	var files []string
	for i := 0; i < 20; i++ {
		p := filepath.Join(dir, "фото "+string(rune('a'+i))+".jpg")
		switch {
		case i%5 == 4:
			p = filepath.Join(dir, "картинка "+string(rune('a'+i))+".png")
			testAlphaPNG(t, p, 64, 48)
		default:
			testJPEG(t, p, 60+i, 40, 1+i%8)
		}
		files = append(files, p)
	}
	broken := filepath.Join(dir, "битая.jpg")
	os.WriteFile(broken, []byte("не картинка"), 0o644)
	files = append(files[:3], append([]string{broken}, files[3:]...)...)

	got := pdfList([]string{dir})
	if len(got) != 21 {
		t.Fatalf("pdfList: %d", len(got))
	}

	for _, q := range []string{"orig", "mid"} {
		s := &Server{}
		s.running = true
		s.runPDF(PDFReq{Files: files, Op: "img2pdf", SameDir: true, Img: ImgPDFOpts{Page: "a4", Orient: "auto", Margin: 10, Quality: q}})
		var dst string
		bad := 0
		for _, fs := range s.files {
			switch fs.Status {
			case "ok":
				if dst != "" && fs.Dst != dst {
					t.Fatalf("%s: different results %s %s", q, dst, fs.Dst)
				}
				dst = fs.Dst
			case "error":
				bad++
			default:
				t.Fatalf("%s: %s %s", q, fs.Name, fs.Status)
			}
		}
		if bad != 1 || s.files[3].Status != "error" {
			t.Fatalf("%s: broken image not reported", q)
		}
		want := filepath.Join(dir, "Отпуск 2026.pdf")
		if q == "mid" {
			want = filepath.Join(dir, "Отпуск 2026 (1).pdf")
		}
		if dst != want {
			t.Fatalf("%s: dst %s", q, dst)
		}
		if inf := pdfInfo(context.Background(), dst, ""); inf.Error != "" || inf.Pages != 20 {
			t.Fatalf("%s: result %+v", q, inf)
		}
		if _, err := os.Stat(dst + ".part"); err == nil {
			t.Fatal(".part left behind")
		}
	}

	// каждая картинка отдельным PDF, страница по размеру картинки
	s := &Server{}
	s.runPDF(PDFReq{Files: files[:3], Op: "img2pdf", SameDir: true, Img: ImgPDFOpts{Page: "fit", Quality: "high", Separate: true}})
	for _, fs := range s.files {
		if fs.Status != "ok" || filepath.Ext(fs.Dst) != ".pdf" || fileStem(fs.Dst) != fileStem(fs.Path) {
			t.Fatalf("separate: %+v", fs)
		}
		if inf := pdfInfo(context.Background(), fs.Dst, ""); inf.Pages != 1 {
			t.Fatalf("separate result %+v", inf)
		}
	}
}
