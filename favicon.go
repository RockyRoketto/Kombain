package main

// Генератор фавиконов (вкладка «Утилиты»). Картинки нужных размеров рисует страница (web/js/favicon.js):
// так SVG на входе работает без лишних библиотек. Здесь только сборка favicon.ico и ZIP.

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"path/filepath"
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

// favBundle: проверенный список файлов; к ним добавляется favicon.ico, если есть ico (PNG разных размеров)
func favBundle(files []favFile, ico [][]byte) ([]favFile, error) {
	if len(files) == 0 && len(ico) == 0 {
		return nil, errT("err.favEmpty")
	}
	seen := map[string]bool{}
	out := make([]favFile, 0, len(files)+1)
	for _, f := range files {
		if !favNameRe.MatchString(f.Name) || seen[f.Name] {
			return nil, errors.New("bad file name: " + f.Name)
		}
		seen[f.Name] = true
		out = append(out, f)
	}
	if len(ico) > 0 {
		b, err := buildICO(ico)
		if err != nil {
			return nil, err
		}
		out = append(out, favFile{Name: "favicon.ico", Data: b})
	}
	return out, nil
}

// favFreePath: путь, которого ещё нет: «имя», «имя (2)», «имя (3)»… ext — расширение с точкой или пусто
func favFreePath(dir, base, ext string) string {
	p := filepath.Join(dir, base+ext)
	for i := 2; i < 1000; i++ {
		if _, err := os.Stat(p); err != nil {
			break
		}
		p = filepath.Join(dir, fmt.Sprintf("%s (%d)%s", base, i, ext))
	}
	return p
}

// writeFavFolder: файлы прямо в папку dir (создаётся); свободное имя папки подбирает favFreePath
func writeFavFolder(dir string, files []favFile, ico [][]byte) error {
	list, err := favBundle(files, ico)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	for _, f := range list {
		if err := os.WriteFile(filepath.Join(dir, f.Name), f.Data, 0o644); err != nil {
			return err
		}
	}
	return nil
}

// writeFavZip: архив с файлами; ico — PNG для favicon.ico (пусто — без него).
// Пишет во временный файл рядом и подменяет: наполовину записанного архива не будет.
func writeFavZip(path string, files []favFile, ico [][]byte) error {
	list, err := favBundle(files, ico)
	if err != nil {
		return err
	}
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	now := time.Now()
	for _, f := range list {
		w, err := zw.CreateHeader(&zip.FileHeader{Name: f.Name, Method: zip.Deflate, Modified: now})
		if err != nil {
			return err
		}
		if _, err := w.Write(f.Data); err != nil {
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
