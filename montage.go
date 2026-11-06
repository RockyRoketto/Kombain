package main

// Общее для монтажа: какие форматы годятся, кусок файла, память для реверса, цепочка скорости звука, аргументы графа.
// Сам монтаж собирает timeline.go.

import (
	"slices"
	"strconv"
)

const (
	montMinSpeed = 0.25
	montMaxSpeed = 8
)

func (f Format) forMontage() bool {
	return f.moving() || f.Kind == "gif" || f.Kind == "anim" || f.audioOnly()
}

func (f Format) audioOnly() bool {
	return (f.Kind == "audio" || f.Kind == "fixed") && slices.Contains(f.Args, "-vn")
}

// montClip: один кусок будущего результата
type montClip struct {
	path string
	si   srcInfo
	from float64 // обрезка: откуда
	cut  float64 // и сколько секунд; 0 — файл целиком
}

func (c montClip) dur() float64 {
	if c.cut > 0 {
		if c.si.dur > 0 {
			return min(c.cut, max(c.si.dur-c.from, 0))
		}
		return c.cut
	}
	return c.si.dur
}

// size: размер кадра, каким его увидят фильтры: ffmpeg сам поворачивает кадр по метке из файла
func (c montClip) size() (int, int) {
	if c.si.rotated {
		return c.si.h, c.si.w
	}
	return c.si.w, c.si.h
}

// reverseRAM: примерно сколько байт памяти съест реверс. Фильтр reverse держит все кадры в памяти, причём замер на ProRes
// показал, что складываются все куски склейки: 2 куска по 0,92 ГБ заняли 2 ГБ.
func reverseRAM(clips []montClip, repeat int) float64 {
	need := 0.0
	for _, c := range clips {
		if !c.si.video {
			continue
		}
		perPixel := 1.5
		if c.si.deep {
			perPixel = 4
		}
		need += c.dur() * c.si.fps * float64(c.si.w) * float64(c.si.h) * perPixel
	}
	return need * float64(repeat)
}

// checkReverseRAM: ошибка, если реверсу не хватит свободной памяти
func checkReverseRAM(clips []montClip, repeat int) error {
	need, have := reverseRAM(clips, repeat), availableRAM()
	if have > 0 && need > float64(have)*0.8 {
		const gb = 1 << 30
		return errT("mont.reverseRAM", mbStr(float64(int(need/gb*10))/10), mbStr(float64(int(float64(have)/gb*10))/10))
	}
	return nil
}

// atempoChain: один фильтр atempo надёжно работает в пределах от 0,5 до 2, дальше их ставят цепочкой
func atempoChain(s float64) []string {
	var out []string
	for s > 2 {
		out = append(out, "atempo=2")
		s /= 2
	}
	for s < 0.5 {
		out = append(out, "atempo=0.5")
		s *= 2
	}
	if s != 1 {
		out = append(out, "atempo="+strconv.FormatFloat(s, 'f', -1, 64))
	}
	return out
}

// montGraphArgs: готовый граф плюс фильтры формата vf на выходе картинки (они у buildArgs те же, что для обычной конвертации)
func montGraphArgs(si srcInfo, tail string) []string {
	g, vOut := si.graph, "[v]"
	if tail != "" && si.video {
		g += ";[v]" + tail + "[vo]"
		vOut = "[vo]"
	}
	args := []string{"-filter_complex", g}
	if si.video {
		args = append(args, "-map", vOut)
	}
	if si.audio {
		args = append(args, "-map", "[a]")
	}
	return append(args, si.subsMap...)
}
