package main

// Проверка железа перед установкой генератора картинок (окно первого запуска во вкладке «Генератор»):
// видеокарта, обычная память и место на диске. Каждая строка получает оценку «хватает / на пределе / не хватает»
// и короткое объяснение. Если хоть что-то «не хватает», страница не даёт скачивать и показывает почему.
// Ещё здесь выбор сборки движка под видеокарту (CUDA для NVIDIA, Vulkan для остальных).

import (
	"path/filepath"
	"strings"
)

// HWVerdict: ok — хватает, edge — на пределе (работать будет, но медленно или впритык), no — не хватает
type HWVerdict struct {
	Level string  `json:"level"` // ok, edge, no
	Value float64 `json:"value"` // МБ (видеопамять, память) или байты (место)
	Need  float64 `json:"need"`  // сколько нужно, в тех же единицах
	Note  string  `json:"note"`  // объяснение на языке интерфейса
}

type HWDrive struct {
	Root string `json:"root"` // C:\
	Free int64  `json:"free"`
}

type HWCheck struct {
	GPU    string    `json:"gpu"`
	Vendor string    `json:"vendor"` // nvidia, amd, intel, ""
	Flavor string    `json:"flavor"` // сборка движка: cuda, vulkan; пусто — подходящей нет
	VRAM   HWVerdict `json:"vram"`
	RAM    HWVerdict `json:"ram"`
	Disk   HWVerdict `json:"disk"`
	Root   string    `json:"root"`   // папка ИИ, для которой считалось место
	Drives []HWDrive `json:"drives"` // диски с местом: подсказка, куда положить
	Best   string    `json:"best"`   // диск, где больше всего места
	OK     bool      `json:"ok"`     // можно качать
}

// hwVendor: производитель по названию видеокарты из драйвера
func hwVendor(name string) string {
	n := strings.ToLower(name)
	switch {
	case strings.Contains(n, "nvidia") || strings.Contains(n, "geforce") || strings.Contains(n, "quadro") || strings.Contains(n, "rtx"):
		return "nvidia"
	case strings.Contains(n, "amd") || strings.Contains(n, "radeon"):
		return "amd"
	case strings.Contains(n, "intel") || strings.Contains(n, "arc"):
		return "intel"
	}
	return ""
}

// hwFlavor: CUDA у NVIDIA вдвое быстрее Vulkan (замеры сессии 1). У остальных только Vulkan.
func hwFlavor(vendor string) string {
	switch vendor {
	case "nvidia":
		return "cuda"
	case "amd", "intel":
		return "vulkan"
	}
	return ""
}

// пороги. Видеопамять: SDXL на 8 ГБ идёт в режиме слабой карты (часть модели в обычной памяти), на 6 ГБ медленно,
// меньше 4 ГБ не стоит и пробовать. Память: с выгрузкой в обычную память SDXL нужно 16 ГБ, на 8 ГБ впритык.
const (
	hwVRAMOk    = 8 * 1024
	hwVRAMMin   = 4 * 1024
	hwRAMOk     = 16 * 1024
	hwRAMMin    = 8 * 1024
	hwDiskSpare = 5 << 30 // запас на картинки и временные файлы
)

// hwJudge: оценки по цифрам. vramMB или ramMB < 0 — неизвестно (тогда «на пределе», а не «не хватает»: не пугаем зря).
// need — сколько байт придётся скачать.
func hwJudge(gpu string, vramMB, ramMB float64, free, need int64) HWCheck {
	c := HWCheck{GPU: gpu, Vendor: hwVendor(gpu)}
	c.Flavor = hwFlavor(c.Vendor)
	c.VRAM = HWVerdict{Value: vramMB, Need: hwVRAMOk}
	switch {
	case c.Flavor == "":
		c.VRAM.Level, c.VRAM.Note = "no", tr("hw.noGPU")
	case vramMB < 0:
		c.VRAM.Level, c.VRAM.Note = "edge", tr("hw.vramUnknown")
	case vramMB < hwVRAMMin:
		c.VRAM.Level, c.VRAM.Note = "no", tr("hw.vramNo")
	case vramMB < hwVRAMOk-512: // карта «8 ГБ» отдаёт чуть меньше
		c.VRAM.Level, c.VRAM.Note = "edge", tr("hw.vramEdge")
	default:
		c.VRAM.Level, c.VRAM.Note = "ok", tr("hw.vramOk")
	}
	if c.VRAM.Level == "ok" && c.Flavor == "vulkan" {
		c.VRAM.Level, c.VRAM.Note = "edge", tr("hw.vulkan")
	}
	c.RAM = HWVerdict{Value: ramMB, Need: hwRAMOk}
	switch {
	case ramMB < 0:
		c.RAM.Level, c.RAM.Note = "edge", tr("hw.ramUnknown")
	case ramMB < hwRAMMin-512:
		c.RAM.Level, c.RAM.Note = "no", tr("hw.ramNo")
	case ramMB < hwRAMOk-1024:
		c.RAM.Level, c.RAM.Note = "edge", tr("hw.ramEdge")
	default:
		c.RAM.Level, c.RAM.Note = "ok", tr("hw.ramOk")
	}
	c.Disk = HWVerdict{Value: float64(free), Need: float64(need)}
	switch {
	case free < 0:
		c.Disk.Level, c.Disk.Note = "edge", tr("hw.diskUnknown")
	case free < need:
		c.Disk.Level, c.Disk.Note = "no", tr("hw.diskNo")
	case free < need+hwDiskSpare:
		c.Disk.Level, c.Disk.Note = "edge", tr("hw.diskEdge")
	default:
		c.Disk.Level, c.Disk.Note = "ok", tr("hw.diskOk")
	}
	c.OK = c.VRAM.Level != "no" && c.RAM.Level != "no" && c.Disk.Level != "no"
	return c
}

// hwCheckNow: проверка для папки root и объёма скачивания need
func hwCheckNow(root string, need int64) HWCheck {
	gpu, vram := regGPU()
	c := hwJudge(gpu, vram, hwRAMTotal(), diskFreeAt(root), need)
	c.Root = root
	c.Drives = drivesFree()
	var best int64 = -1
	for _, d := range c.Drives {
		if d.Free > best {
			best, c.Best = d.Free, d.Root
		}
	}
	return c
}

// diskFreeAt: место на диске папки; папки может ещё не быть, тогда смотрим ближайшую существующую выше
func diskFreeAt(dir string) int64 {
	for d := filepath.Clean(dir); ; d = filepath.Dir(d) {
		if dirExists(d) {
			return diskFree(d)
		}
		if filepath.Dir(d) == d {
			return -1
		}
	}
}
