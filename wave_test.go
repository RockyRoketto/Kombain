package main

import (
	"bytes"
	"testing"
	"testing/iotest"
)

func TestWavePeaks(t *testing.T) {
	if got := wavePeaks(nil); got != nil {
		t.Errorf("пустой звук: %v", got)
	}
	// 200 отсчётов: тишина, отрицательный пик на всю шкалу, половина шкалы; при 80 отсчётах на значение выходит 3 значения
	pcm := make([]byte, 400)
	put := func(i int, v int16) { pcm[2*i], pcm[2*i+1] = byte(uint16(v)), byte(uint16(v)>>8) }
	put(100, -32768)
	put(170, 16384)
	got := wavePeaks(pcm)
	if len(got) != 3 || got[0] != 0 || got[1] != 255 || got[2] != 127 {
		t.Errorf("пики: %v", got)
	}
	// звук приходит из ffmpeg кусками, отсчёт может разрезаться между чтениями
	if byOne := wavePeaksFrom(iotest.OneByteReader(bytes.NewReader(pcm))); !bytes.Equal(byOne, got) {
		t.Errorf("по байту: %v, целиком: %v", byOne, got)
	}
}
