package main

import (
	"encoding/base64"
	"encoding/binary"
	"math"
	"testing"
	"unicode/utf16"
)

func TestColorFileBytes(t *testing.T) {
	png := append(append([]byte{}, pngMagic...), 1, 2, 3)
	if b, err := colorFileBytes("png", base64.StdEncoding.EncodeToString(png)); err != nil || len(b) != len(png) {
		t.Fatalf("PNG не принят: %v", err)
	}
	for _, bad := range []string{"", "!!!", base64.StdEncoding.EncodeToString([]byte("GIF89a"))} {
		if _, err := colorFileBytes("png", bad); err == nil {
			t.Errorf("негодный PNG %q принят", bad)
		}
	}
	svg := `<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"></svg>`
	if b, err := colorFileBytes("svg", "  "+svg+"\n"); err != nil || string(b) != svg+"\n" {
		t.Fatalf("SVG не принят: %v %q", err, b)
	}
	for _, bad := range []string{"", "<html></html>", "<svg>"} {
		if _, err := colorFileBytes("svg", bad); err == nil {
			t.Errorf("негодный SVG %q принят", bad)
		}
	}
	if _, err := colorFileBytes("exe", "x"); err == nil {
		t.Error("неизвестный вид файла принят")
	}
}

func TestColorFileName(t *testing.T) {
	for _, c := range [][3]string{
		{"gradient-1920x1080", "png", "gradient-1920x1080.png"},
		{"g.svg", "svg", "g.svg"},
		{"", "png", "gradient.png"},
		{"  ", "svg", "gradient.svg"},
		{`a:b/c`, "png", "c.png"},
	} {
		if got := colorFileName(c[0], c[1]); got != c[2] {
			t.Errorf("colorFileName(%q, %q) = %q, ждали %q", c[0], c[1], got, c[2])
		}
	}
}

func TestColorASE(t *testing.T) {
	b, err := colorFileBytes("ase", `{"name":"Моя","colors":[{"name":"","hex":"#ff8000"},{"name":"Фон","hex":"#000000"}]}`)
	if err != nil {
		t.Fatal(err)
	}
	if string(b[:4]) != "ASEF" || binary.BigEndian.Uint16(b[4:]) != 1 || binary.BigEndian.Uint32(b[8:]) != 4 {
		t.Fatalf("шапка не та: % x", b[:12])
	}
	// разбор как у Adobe: блоки подряд, у цвета имя, модель, три числа, вид
	p, kinds, names := 12, []uint16{}, []string{}
	var first [3]float32
	for p < len(b) {
		kind, n := binary.BigEndian.Uint16(b[p:]), int(binary.BigEndian.Uint32(b[p+2:]))
		body := b[p+6 : p+6+n]
		kinds = append(kinds, kind)
		if kind != 0xC002 {
			ln := int(binary.BigEndian.Uint16(body))
			u := make([]uint16, ln-1)
			for i := range u {
				u[i] = binary.BigEndian.Uint16(body[2+i*2:])
			}
			names = append(names, string(utf16.Decode(u)))
			if kind == 1 {
				m := body[2+ln*2:]
				if string(m[:4]) != "RGB " || binary.BigEndian.Uint16(m[16:]) != 2 {
					t.Fatalf("цвет устроен не так: % x", m)
				}
				if len(names) == 2 {
					for i := range first {
						first[i] = math.Float32frombits(binary.BigEndian.Uint32(m[4+i*4:]))
					}
				}
			}
		}
		p += 6 + n
	}
	if p != len(b) || len(kinds) != 4 || kinds[0] != 0xC001 || kinds[3] != 0xC002 {
		t.Fatalf("блоки не те: %x, конец %d из %d", kinds, p, len(b))
	}
	if names[0] != "Моя" || names[1] != "#FF8000" || names[2] != "Фон" {
		t.Errorf("имена %q", names)
	}
	if first != [3]float32{1, 128.0 / 255, 0} {
		t.Errorf("цвет %v", first)
	}
	for _, bad := range []string{"", "[]", `{"colors":[]}`, `{"colors":[{"hex":"#fff"}]}`, `{"colors":[{"hex":"#zzzzzz"}]}`} {
		if _, err := colorFileBytes("ase", bad); err == nil {
			t.Errorf("негодная палитра %q принята", bad)
		}
	}
}
