package main

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"image"
	"image/png"
	"path/filepath"
	"testing"
)

func testPNG(t *testing.T, n int) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := png.Encode(&b, image.NewNRGBA(image.Rect(0, 0, n, n))); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func TestBuildICO(t *testing.T) {
	pngs := [][]byte{testPNG(t, 16), testPNG(t, 32), testPNG(t, 256)}
	ico, err := buildICO(pngs)
	if err != nil {
		t.Fatal(err)
	}
	if got := binary.LittleEndian.Uint16(ico[4:]); got != 3 {
		t.Fatalf("картинок %d, нужно 3", got)
	}
	off := 6 + 16*3
	for i, p := range pngs {
		e := ico[6+16*i:]
		want := [3]int{16, 32, 0}[i] // 256 пишется как 0
		if int(e[0]) != want || int(e[1]) != want {
			t.Errorf("картинка %d: размер %d×%d, нужно %d", i, e[0], e[1], want)
		}
		size, at := int(binary.LittleEndian.Uint32(e[8:])), int(binary.LittleEndian.Uint32(e[12:]))
		if size != len(p) || at != off || !bytes.Equal(ico[at:at+size], p) {
			t.Errorf("картинка %d лежит не там: размер %d смещение %d", i, size, at)
		}
		off += len(p)
	}
	if _, err := buildICO([][]byte{[]byte("не png")}); err == nil {
		t.Error("не PNG должен давать ошибку")
	}
	if _, err := buildICO([][]byte{testPNG(t, 300)}); err == nil {
		t.Error("больше 256 точек должен давать ошибку")
	}
}

func TestWriteFavZip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "f.zip")
	files := []favFile{{"favicon-96x96.png", testPNG(t, 96)}, {"site.webmanifest", []byte("{}")}}
	if err := writeFavZip(path, files, [][]byte{testPNG(t, 16), testPNG(t, 32)}); err != nil {
		t.Fatal(err)
	}
	zr, err := zip.OpenReader(path)
	if err != nil {
		t.Fatal(err)
	}
	defer zr.Close()
	var names []string
	for _, f := range zr.File {
		names = append(names, f.Name)
	}
	if len(names) != 3 || names[2] != "favicon.ico" {
		t.Errorf("в архиве %v", names)
	}
	for _, bad := range []string{"../x.png", "a/b.png", "", ".hidden"} {
		if err := writeFavZip(path, []favFile{{bad, []byte{1}}}, nil); err == nil {
			t.Errorf("имя %q должно давать ошибку", bad)
		}
	}
	if err := writeFavZip(path, []favFile{{"a.png", nil}, {"a.png", nil}}, nil); err == nil {
		t.Error("повтор имени должен давать ошибку")
	}
}
