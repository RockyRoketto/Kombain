package main

// Генератор фавиконов (вкладка «Утилиты»). Картинки нужных размеров рисует страница (web/js/favicon.js):
// так SVG на входе работает без лишних библиотек. Здесь только сборка favicon.ico и ZIP.

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"errors"
	"os"
	"regexp"
	"time"
)

type favFile struct {
	Name string `json:"name"`
	Data []byte `json:"data"` // в JSON это base64
}

// имя внутри архива: без папок и странных знаков
var favNameRe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$`)

// pngSize: ширина и высота из заголовка PNG
func pngSize(b []byte) (int, int, error) {
	if len(b) < 24 || !bytes.Equal(b[:8], []byte("\x89PNG\r\n\x1a\n")) || string(b[12:16]) != "IHDR" {
		return 0, 0, errors.New("not a PNG")
	}
	return int(binary.BigEndian.Uint32(b[16:20])), int(binary.BigEndian.Uint32(b[20:24])), nil
}

// buildICO: favicon.ico из готовых PNG (так ICO умеют все браузеры и Windows начиная с Vista)
func buildICO(pngs [][]byte) ([]byte, error) {
	if len(pngs) == 0 || len(pngs) > 16 {
		return nil, errors.New("bad ICO image count")
	}
	var buf bytes.Buffer
	binary.Write(&buf, binary.LittleEndian, [3]uint16{0, 1, uint16(len(pngs))})
	off := 6 + 16*len(pngs)
	for _, p := range pngs {
		w, h, err := pngSize(p)
		if err != nil {
			return nil, err
		}
		if w < 1 || h < 1 || w > 256 || h > 256 {
			return nil, errors.New("ICO image must be 1..256 px")
		}
		buf.WriteByte(byte(w % 256)) // 256 пишется как 0
		buf.WriteByte(byte(h % 256))
		buf.Write([]byte{0, 0})                                 // палитры нет, резерв
		binary.Write(&buf, binary.LittleEndian, uint16(1))      // плоскости
		binary.Write(&buf, binary.LittleEndian, uint16(32))     // бит на точку
		binary.Write(&buf, binary.LittleEndian, uint32(len(p))) // размер
		binary.Write(&buf, binary.LittleEndian, uint32(off))    // где лежит
		off += len(p)
	}
	for _, p := range pngs {
		buf.Write(p)
	}
	return buf.Bytes(), nil
}

// writeFavZip: архив с файлами; ico — PNG для favicon.ico (пусто — без него).
// Пишет во временный файл рядом и подменяет: наполовину записанного архива не будет.
func writeFavZip(path string, files []favFile, ico [][]byte) error {
	if len(files) == 0 && len(ico) == 0 {
		return errT("err.favEmpty")
	}
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	now := time.Now()
	add := func(name string, data []byte) error {
		w, err := zw.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Deflate, Modified: now})
		if err != nil {
			return err
		}
		_, err = w.Write(data)
		return err
	}
	seen := map[string]bool{}
	for _, f := range files {
		if !favNameRe.MatchString(f.Name) || seen[f.Name] {
			return errors.New("bad file name: " + f.Name)
		}
		seen[f.Name] = true
		if err := add(f.Name, f.Data); err != nil {
			return err
		}
	}
	if len(ico) > 0 {
		b, err := buildICO(ico)
		if err != nil {
			return err
		}
		if err := add("favicon.ico", b); err != nil {
			return err
		}
	}
	if err := zw.Close(); err != nil {
		return err
	}
	tmp := path + ".part"
	if err := os.WriteFile(tmp, buf.Bytes(), 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}
