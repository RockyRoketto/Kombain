//go:build windows

package main

import "testing"

func TestPdhPick(t *testing.T) {
	eng := map[string]float64{
		"pid_1_luid_0x0_0xA_phys_0_eng_0_engtype_3D":      40,
		"pid_2_luid_0x0_0xA_phys_0_eng_1_engtype_Compute": 50,
		"pid_2_luid_0x0_0xA_phys_0_eng_2_engtype_Copy":    90,
		"pid_1_luid_0x0_0xB_phys_0_eng_0_engtype_3D":      70,
	}
	mem := map[string]float64{"luid_0x0_0xA_phys_0": 6 << 30, "luid_0x0_0xB_phys_0": 1 << 29}
	g, ok := pdhPick(eng, mem, "RTX", 16384)
	if !ok || g.Util != 90 || g.Used != 6144 || g.Total != 16384 || g.Temp != -1 || g.Name != "RTX" {
		t.Fatalf("%+v", g)
	}
	if _, ok := pdhPick(eng, nil, "", 0); ok {
		t.Fatal("no memory counters → no gpu")
	}
}

// Живой замер: на любой Windows процессор и память должны прочитаться
func TestHWSysLive(t *testing.T) {
	h := newHWSys()
	defer h.close()
	_, used, total := h.cpuRAM()
	if total <= 0 || used <= 0 || used > total {
		t.Fatalf("ram %v / %v", used, total)
	}
	g, ok := h.gpu()
	t.Logf("pdh gpu %+v %v; registry vram %v MB", g, ok, hwVRAMTotal())
}
