package main

// Вкладка «Цвет». Градиент и палитры рисует страница (web/js/color.js), здесь проверка готового файла,
// сборка палитры ASE и запись туда, куда укажет диалог «Сохранить».

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"math"
	"os"
	"strconv"
	"strings"
	"unicode/utf16"
)

var pngMagic = []byte("\x89PNG\r\n\x1a\n")

// colorFileBytes: содержимое файла от страницы. PNG приходит в base64, SVG — текстом.
// Негодное (не та подпись, пусто, неизвестный вид) — ошибка.
func colorFileBytes(ext, data string) ([]byte, error) {
	switch ext {
	case "png":
		b, err := base64.StdEncoding.DecodeString(data)
		if err != nil || !bytes.HasPrefix(b, pngMagic) {
			return nil, errT("err.colorFile")
		}
		return b, nil
	case "svg":
		s := strings.TrimSpace(data)
		if !strings.HasPrefix(s, "<svg") || !strings.HasSuffix(s, "</svg>") {
			return nil, errT("err.colorFile")
		}
		return []byte(s + "\n"), nil
	case "ase":
		return aseBytes(data)
	}
	return nil, errT("err.badRequest")
}

// colorFileName: имя, которое диалог предложит сразу: основа без запрещённых знаков и нужное расширение
func colorFileName(name, ext string) string {
	name = strings.TrimSuffix(strings.TrimSpace(name), "."+ext)
	if name == "" {
		name = "gradient"
	}
	return safeName(name) + "." + ext
}

// saveColorFile: спросить, куда сохранить, и записать. Пустой путь — передумали.
func saveColorFile(ext, name, data string) (string, error) {
	b, err := colorFileBytes(ext, data)
	if err != nil {
		return "", err
	}
	path, err := pickColorSave(ext, colorFileName(name, ext))
	if err != nil || path == "" {
		return "", err
	}
	return path, os.WriteFile(path, b, 0o644)
}

// aseColor: цвет палитры от страницы. Hex — #rrggbb.
type aseColor struct {
	Name string `json:"name"`
	Hex  string `json:"hex"`
}

// aseBytes: палитра в формате Adobe Swatch Exchange (Photoshop, Illustrator, InDesign).
// Страница шлёт JSON {name, colors: [{name, hex}]}; цвета кладутся группой с именем палитры, в RGB.
// Устройство файла: «ASEF», версия 1.0, число блоков, дальше блоки «тип, длина, данные», числа big-endian,
// имена в UTF-16 с нулём на конце.
func aseBytes(data string) ([]byte, error) {
	var p struct {
		Name   string     `json:"name"`
		Colors []aseColor `json:"colors"`
	}
	if err := json.Unmarshal([]byte(data), &p); err != nil || len(p.Colors) == 0 || len(p.Colors) > 256 {
		return nil, errT("err.colorFile")
	}
	type rgb struct {
		name    string
		r, g, b float32
	}
	list := make([]rgb, 0, len(p.Colors))
	for _, c := range p.Colors {
		h := strings.TrimPrefix(strings.TrimSpace(c.Hex), "#")
		v, err := strconv.ParseUint(h, 16, 32)
		if len(h) != 6 || err != nil {
			return nil, errT("err.colorFile")
		}
		name := strings.TrimSpace(c.Name)
		if name == "" {
			name = "#" + strings.ToUpper(h)
		}
		list = append(list, rgb{name, float32(v>>16) / 255, float32(v>>8&255) / 255, float32(v&255) / 255})
	}
	group := strings.TrimSpace(p.Name)
	if group == "" {
		group = "Kombain"
	}
	name := func(s string) []byte {
		u := utf16.Encode([]rune(s))
		b := make([]byte, 2, 2+len(u)*2+2)
		binary.BigEndian.PutUint16(b, uint16(len(u)+1))
		for _, x := range u {
			b = binary.BigEndian.AppendUint16(b, x)
		}
		return append(b, 0, 0)
	}
	var out bytes.Buffer
	block := func(kind uint16, body []byte) {
		binary.Write(&out, binary.BigEndian, kind)
		binary.Write(&out, binary.BigEndian, uint32(len(body)))
		out.Write(body)
	}
	out.WriteString("ASEF")
	binary.Write(&out, binary.BigEndian, [2]uint16{1, 0})
	binary.Write(&out, binary.BigEndian, uint32(len(list)+2))
	block(0xC001, name(group)) // начало группы
	for _, c := range list {
		b := append(name(c.name), "RGB "...)
		for _, f := range []float32{c.r, c.g, c.b} {
			b = binary.BigEndian.AppendUint32(b, math.Float32bits(f))
		}
		block(0x0001, binary.BigEndian.AppendUint16(b, 2)) // 2 — обычный цвет (не плашечный)
	}
	block(0xC002, nil) // конец группы
	return out.Bytes(), nil
}
