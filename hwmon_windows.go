//go:build windows

package main

// Опрос железа в Windows: процессор (GetSystemTimes), память (GlobalMemoryStatusEx), видеокарта по счётчикам PDH
// (\GPU Engine(*)\Utilization Percentage, \GPU Adapter Memory(*)\Dedicated Usage) без cgo. Сколько видеопамяти всего,
// PDH не говорит: берём из реестра драйвера (HardwareInformation.qwMemorySize). Проверено прототипом в сессии 2.

import (
	"encoding/binary"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows/registry"
)

var (
	pdhDLL         = syscall.NewLazyDLL("pdh.dll")
	pdhOpenQuery   = pdhDLL.NewProc("PdhOpenQueryW")
	pdhAddCounter  = pdhDLL.NewProc("PdhAddEnglishCounterW")
	pdhCollect     = pdhDLL.NewProc("PdhCollectQueryData")
	pdhGetArray    = pdhDLL.NewProc("PdhGetFormattedCounterArrayW")
	pdhCloseQuery  = pdhDLL.NewProc("PdhCloseQuery")
	k32GetSysTimes = syscall.NewLazyDLL("kernel32.dll").NewProc("GetSystemTimes")
	k32MemStatusEx = syscall.NewLazyDLL("kernel32.dll").NewProc("GlobalMemoryStatusEx")
)

const (
	pdhFmtDouble = 0x200
	pdhMoreData  = 0x800007D2
)

// pdhItem: PDH_FMT_COUNTERVALUE_ITEM_W — указатель имени, статус, double (24 байта)
type pdhItem struct {
	Name  *uint16
	Stat  uint32
	Value float64
}

type winHW struct {
	q, cEng, cMem    uintptr
	idle, kern, user uint64
	gpuName          string
	vramTotal        float64
}

func newHWSys() hwSys {
	h := &winHW{}
	if pdhDLL.Load() == nil {
		if r, _, _ := pdhOpenQuery.Call(0, 0, uintptr(unsafe.Pointer(&h.q))); r == 0 {
			e, _ := syscall.UTF16PtrFromString(`\GPU Engine(*)\Utilization Percentage`)
			m, _ := syscall.UTF16PtrFromString(`\GPU Adapter Memory(*)\Dedicated Usage`)
			pdhAddCounter.Call(h.q, uintptr(unsafe.Pointer(e)), 0, uintptr(unsafe.Pointer(&h.cEng)))
			pdhAddCounter.Call(h.q, uintptr(unsafe.Pointer(m)), 0, uintptr(unsafe.Pointer(&h.cMem)))
			pdhCollect.Call(h.q) // загрузка считается по разнице двух сборов
		} else {
			h.q = 0
		}
	}
	h.idle, h.kern, h.user = sysTimes()
	h.gpuName, h.vramTotal = regGPU()
	return h
}

func (h *winHW) close() {
	if h.q != 0 {
		pdhCloseQuery.Call(h.q)
	}
}

func sysTimes() (idle, kern, user uint64) {
	var i, k, u [2]uint32
	k32GetSysTimes.Call(uintptr(unsafe.Pointer(&i)), uintptr(unsafe.Pointer(&k)), uintptr(unsafe.Pointer(&u)))
	v := func(f [2]uint32) uint64 { return uint64(f[1])<<32 | uint64(f[0]) }
	return v(i), v(k), v(u)
}

func (h *winHW) cpuRAM() (cpu, used, total float64) {
	cpu, used, total = -1, -1, -1
	idle, kern, user := sysTimes()
	dI, dK, dU := idle-h.idle, kern-h.kern, user-h.user
	h.idle, h.kern, h.user = idle, kern, user
	if dK+dU > 0 {
		cpu = 100 * float64(dK+dU-dI) / float64(dK+dU) // время ядра включает простой
	}
	var m struct {
		length, load                                                  uint32
		total, avail, totalPage, availPage, virt, availVirt, availExt uint64
	}
	m.length = uint32(unsafe.Sizeof(m))
	if r, _, _ := k32MemStatusEx.Call(uintptr(unsafe.Pointer(&m))); r != 0 {
		total, used = float64(m.total)/(1<<20), float64(m.total-m.avail)/(1<<20)
	}
	return
}

// pdhRead: значения счётчика по экземплярам
func pdhRead(c uintptr) map[string]float64 {
	if c == 0 {
		return nil
	}
	var size, cnt uint32
	r, _, _ := pdhGetArray.Call(c, pdhFmtDouble, uintptr(unsafe.Pointer(&size)), uintptr(unsafe.Pointer(&cnt)), 0)
	if uint32(r) != pdhMoreData || size == 0 {
		return nil
	}
	buf := make([]byte, size)
	if r, _, _ = pdhGetArray.Call(c, pdhFmtDouble, uintptr(unsafe.Pointer(&size)), uintptr(unsafe.Pointer(&cnt)), uintptr(unsafe.Pointer(&buf[0]))); r != 0 {
		return nil
	}
	out := map[string]float64{}
	sz := unsafe.Sizeof(pdhItem{})
	for i := uintptr(0); i < uintptr(cnt); i++ {
		it := (*pdhItem)(unsafe.Add(unsafe.Pointer(&buf[0]), i*sz))
		if it.Stat != 0 && it.Stat != 1 { // PDH_CSTATUS_VALID_DATA, PDH_CSTATUS_NEW_DATA
			continue
		}
		out[windows16(it.Name)] += it.Value
	}
	return out
}

func windows16(p *uint16) string {
	if p == nil {
		return ""
	}
	n := 0
	for *(*uint16)(unsafe.Add(unsafe.Pointer(p), n*2)) != 0 {
		n++
	}
	return syscall.UTF16ToString(unsafe.Slice(p, n))
}

func (h *winHW) gpu() (smiGPU, bool) {
	if h.q == 0 {
		return smiGPU{}, false
	}
	if r, _, _ := pdhCollect.Call(h.q); r != 0 {
		return smiGPU{}, false
	}
	return pdhPick(pdhRead(h.cEng), pdhRead(h.cMem), h.gpuName, h.vramTotal)
}

// pdhLUID: «pid_1_luid_0x00000000_0x0000D1E2_phys_0_eng_0_engtype_3D» → «luid_0x00000000_0x0000D1E2»
func pdhLUID(name string) string {
	i := strings.Index(name, "luid_")
	if i < 0 {
		return name
	}
	j := strings.Index(name[i:], "_phys")
	if j < 0 {
		return name[i:]
	}
	return name[i : i+j]
}

// pdhPick: видеокарта с наибольшей занятой памятью (дискретная, а не встроенная). Загрузка — сумма движков 3D и Compute.
func pdhPick(eng, mem map[string]float64, name string, total float64) (smiGPU, bool) {
	used := map[string]float64{}
	for k, v := range mem {
		used[pdhLUID(k)] += v
	}
	best, bestUsed := "", -1.0
	for k, v := range used {
		if v > bestUsed || v == bestUsed && k < best {
			best, bestUsed = k, v
		}
	}
	if best == "" {
		return smiGPU{}, false
	}
	util := 0.0
	for k, v := range eng {
		if pdhLUID(k) == best && (strings.Contains(k, "engtype_3D") || strings.Contains(k, "engtype_Compute")) {
			util += v
		}
	}
	if total <= 0 {
		total = -1
	}
	return smiGPU{Name: name, Util: min(util, 100), Used: bestUsed / (1 << 20), Total: total, Temp: -1, Power: -1}, true
}

// regGPU: имя и объём памяти видеокарты с наибольшей памятью из реестра драйверов дисплея
func regGPU() (string, float64) {
	const class = `SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}`
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, class, registry.ENUMERATE_SUB_KEYS)
	if err != nil {
		return "", -1
	}
	defer k.Close()
	subs, _ := k.ReadSubKeyNames(-1)
	name, best := "", 0.0
	for _, s := range subs {
		sk, err := registry.OpenKey(k, s, registry.QUERY_VALUE)
		if err != nil {
			continue
		}
		var size uint64
		if v, _, err := sk.GetIntegerValue("HardwareInformation.qwMemorySize"); err == nil {
			size = v
		} else if b, _, err := sk.GetBinaryValue("HardwareInformation.MemorySize"); err == nil && len(b) >= 4 {
			size = uint64(binary.LittleEndian.Uint32(b))
		} else if v, _, err := sk.GetIntegerValue("HardwareInformation.MemorySize"); err == nil {
			size = v
		}
		desc, _, _ := sk.GetStringValue("DriverDesc")
		sk.Close()
		if mb := float64(size) / (1 << 20); mb > best {
			name, best = desc, mb
		}
	}
	if best == 0 {
		return name, -1
	}
	return name, best
}

func findSMI() string {
	if p, err := exec.LookPath("nvidia-smi"); err == nil {
		return p
	}
	for _, p := range []string{
		filepath.Join(os.Getenv("SystemRoot"), "System32", "nvidia-smi.exe"),
		filepath.Join(os.Getenv("ProgramFiles"), "NVIDIA Corporation", "NVSMI", "nvidia-smi.exe"),
	} {
		if fileExists(p) {
			return p
		}
	}
	return ""
}

// hwVRAMTotal: сколько видеопамяти у карты, МБ; -1 — неизвестно. Нужен до первой картинки, чтобы включить режим слабой карты.
func hwVRAMTotal() float64 {
	_, total := regGPU()
	return total
}
