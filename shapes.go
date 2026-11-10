package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Прорисовка фигуры: кадры рисует страница, здесь они ложатся в кэш картинок «Текста» под общим именем с номером
// (seq-<сумма>-0000.png …), движок читает их как последовательность с точной частотой (image2), последний кадр держит
// до конца клипа tpad в tlClipChain. Имя по содержимому: та же прорисовка — те же файлы.
const shapeSeqMax = 600 // кадров: 10 с при 60 к/с

func saveShapeSeq(frames []string, fps float64) (pattern string, fresh bool, err error) {
	if len(frames) == 0 || len(frames) > shapeSeqMax || !(fps > 0 && fps <= 240) {
		return "", false, errors.New("bad sequence")
	}
	data := make([][]byte, len(frames))
	h := sha256.New()
	fmt.Fprintf(h, "%g\n", fps)
	for i, f := range frames {
		b, err := base64.StdEncoding.DecodeString(f)
		if err != nil {
			return "", false, err
		}
		if !bytes.HasPrefix(b, []byte("\x89PNG\r\n\x1a\n")) {
			return "", false, errors.New("not a PNG")
		}
		data[i] = b
		h.Write(b)
	}
	dir := textDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", false, err
	}
	name := "seq-" + hex.EncodeToString(h.Sum(nil)[:12]) + "-"
	now := time.Now()
	for i, b := range data {
		p := filepath.Join(dir, fmt.Sprintf("%s%04d.png", name, i))
		if fileExists(p) {
			os.Chtimes(p, now, now)
			continue
		}
		if err := os.WriteFile(p+".part", b, 0o644); err != nil {
			return "", false, err
		}
		if err := os.Rename(p+".part", p); err != nil {
			os.Remove(p + ".part")
			return "", false, err
		}
		fresh = true
	}
	return filepath.Join(dir, name+"%04d.png"), fresh, nil
}

// shapeSeqOK: все n кадров на месте. Чистка кэша могла убрать часть, тогда фигура идёт без прорисовки.
func shapeSeqOK(pattern string, n int) bool {
	if n <= 0 || n > shapeSeqMax || !strings.HasSuffix(pattern, "%04d.png") {
		return false
	}
	head := strings.TrimSuffix(pattern, "%04d.png")
	for i := 0; i < n; i++ {
		if !fileExists(head + fmt.Sprintf("%04d", i) + ".png") {
			return false
		}
	}
	return true
}

// shapeSeqInput: вход ffmpeg для последовательности. % в остальном пути удваивается, иначе image2 примет его за номер.
func shapeSeqInput(pattern string) string {
	head := strings.TrimSuffix(pattern, "%04d.png")
	return strings.ReplaceAll(head, "%", "%%") + "%04d.png"
}

