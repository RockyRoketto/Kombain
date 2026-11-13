package main

// Плашка нагрузки на железо во вкладке генератора. Опрос раз в секунду идёт, только пока страница о нём спрашивает
// (hwMon.Get), и сам останавливается через hwIdle без вопросов: на других вкладках nvidia-smi не висит.
// Видеокарта NVIDIA — из nvidia-smi (один долгоживущий процесс, есть температура и ватты); любая другая и запасной путь —
// счётчики Windows PDH (загрузка и занятая память, без температуры). Процессор и память — системные вызовы.
// Платформенная часть: hwmon_windows.go (на других системах только nvidia-smi).

import (
	"bufio"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// HWSample: последний замер. -1 — узнать не вышло. Память в МБ.
type HWSample struct {
	GPU       string  `json:"gpu,omitempty"`
	GPUUtil   float64 `json:"gpuUtil"`
	VRAMUsed  float64 `json:"vramUsed"`
	VRAMTotal float64 `json:"vramTotal"`
	Temp      float64 `json:"temp"`
	Power     float64 `json:"power"`
	CPU       float64 `json:"cpu"`
	RAMUsed   float64 `json:"ramUsed"`
	RAMTotal  float64 `json:"ramTotal"`
	Src       string  `json:"src"` // smi, pdh или пусто
}

func unknownSample() HWSample {
	return HWSample{GPUUtil: -1, VRAMUsed: -1, VRAMTotal: -1, Temp: -1, Power: -1, CPU: -1, RAMUsed: -1, RAMTotal: -1}
}

// hwSys: то, что зависит от системы
type hwSys interface {
	cpuRAM() (cpu, used, total float64)
	gpu() (s smiGPU, ok bool) // PDH: только загрузка и память
	close()
}

var hwIdle = 15 * time.Second

type hwMon struct {
	mu      sync.Mutex
	last    HWSample
	asked   time.Time
	running bool
}

var hwMonitor = &hwMon{last: unknownSample()}

// Get: последний замер; заодно будит опрос
func (m *hwMon) Get() HWSample {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.asked = time.Now()
	if !m.running {
		m.running = true
		go m.loop()
	}
	return m.last
}

func (m *hwMon) loop() {
	sys := newHWSys()
	defer sys.close()
	smi := startSMI()
	defer smi.stop()
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		s := unknownSample()
		s.CPU, s.RAMUsed, s.RAMTotal = sys.cpuRAM()
		if g, ok := smi.get(); ok {
			s.GPU, s.GPUUtil, s.VRAMUsed, s.VRAMTotal, s.Temp, s.Power, s.Src = g.Name, g.Util, g.Used, g.Total, g.Temp, g.Power, "smi"
		} else if g, ok := sys.gpu(); ok {
			s.GPU, s.GPUUtil, s.VRAMUsed, s.VRAMTotal, s.Src = g.Name, g.Util, g.Used, g.Total, "pdh"
		}
		m.mu.Lock()
		m.last = s
		quiet := time.Since(m.asked) > hwIdle
		if quiet {
			m.running = false
			m.last = unknownSample()
		}
		m.mu.Unlock()
		if quiet {
			return
		}
		<-tick.C
	}
}

// ---- nvidia-smi ----

type smiGPU struct {
	Index                          int
	Name                           string
	Util, Used, Total, Temp, Power float64
	at                             time.Time
}

// parseSMI: строка «index, name, util, mem.used, mem.total, temp, power» (csv,noheader,nounits). [N/A] → -1.
func parseSMI(line string) (smiGPU, bool) {
	f := strings.Split(line, ",")
	if len(f) < 7 {
		return smiGPU{}, false
	}
	for i := range f {
		f[i] = strings.TrimSpace(f[i])
	}
	idx, err := strconv.Atoi(f[0])
	if err != nil {
		return smiGPU{}, false
	}
	num := func(s string) float64 {
		v, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return -1
		}
		return v
	}
	g := smiGPU{Index: idx, Name: f[1], Util: num(f[2]), Used: num(f[3]), Total: num(f[4]), Temp: num(f[5]), Power: num(f[6])}
	if g.Total <= 0 {
		return smiGPU{}, false
	}
	return g, true
}

type smiProc struct {
	cmd  *exec.Cmd
	mu   sync.Mutex
	gpus map[int]smiGPU
}

func startSMI() *smiProc {
	p := &smiProc{gpus: map[int]smiGPU{}}
	exe := findSMI()
	if exe == "" {
		return p
	}
	cmd := exec.Command(exe, "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
		"--format=csv,noheader,nounits", "-lms", "1000")
	out, err := cmd.StdoutPipe()
	if err != nil {
		return p
	}
	hide(cmd)
	if cmd.Start() != nil {
		return p
	}
	dieWithUs(cmd)
	p.cmd = cmd
	go func() {
		sc := bufio.NewScanner(out)
		for sc.Scan() {
			if g, ok := parseSMI(sc.Text()); ok {
				g.at = time.Now()
				p.mu.Lock()
				p.gpus[g.Index] = g
				p.mu.Unlock()
			}
		}
		cmd.Wait()
	}()
	return p
}

// get: видеокарта, на которой рисуем, — та, где больше памяти (встроенная рядом с дискретной не нужна). Старше 3 с — не считается.
func (p *smiProc) get() (smiGPU, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	var best smiGPU
	ok := false
	for _, g := range p.gpus {
		if time.Since(g.at) > 3*time.Second {
			continue
		}
		if !ok || g.Total > best.Total || g.Total == best.Total && g.Index < best.Index {
			best, ok = g, true
		}
	}
	return best, ok
}

func (p *smiProc) stop() {
	if p.cmd != nil && p.cmd.Process != nil {
		p.cmd.Process.Kill()
	}
}
