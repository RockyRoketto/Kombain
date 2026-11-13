package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeEngine рисует «картинку» из зерна; block держит генерацию, пока его не закроют
type fakeEngine struct {
	mu     sync.Mutex
	loaded ModelSet
	ok     bool
	loads  int
	stops  int
	seeds  []int64
	block  chan struct{}
	fail   error
	failN  int // первые failN кадров падают (повтор после нехватки памяти)
}

func (e *fakeEngine) Load(ctx context.Context, m ModelSet) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.ok && e.loaded == m {
		return nil
	}
	e.loaded, e.ok = m, true
	e.loads++
	return nil
}

func (e *fakeEngine) Generate(ctx context.Context, p GenParams, progress func(GenProgress)) ([]byte, error) {
	progress(GenProgress{Stage: "sampling", Step: 1, Total: 2, Preview: []byte("frame")})
	e.mu.Lock()
	block, fail := e.block, e.fail
	if e.failN > 0 {
		e.failN--
		fail = errors.New("no results")
	}
	e.mu.Unlock()
	if block != nil {
		select {
		case <-block:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if fail != nil {
		return nil, fail
	}
	e.mu.Lock()
	e.seeds = append(e.seeds, p.Seed)
	e.mu.Unlock()
	return []byte("png:" + p.Prompt), nil
}

func (e *fakeEngine) Upscale(context.Context, []byte, string, int) ([]byte, error) { return nil, nil }

func (e *fakeEngine) Loaded() (ModelSet, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.loaded, e.ok
}

func (e *fakeEngine) Stop() {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.ok = false
	e.stops++
}

func testQueue(t *testing.T, e *fakeEngine) (*genQueue, string) {
	dir := t.TempDir()
	resolve := func(id string) (ModelSet, error) {
		if id == "missing" {
			return ModelSet{}, errors.New("no such model")
		}
		return ModelSet{Checkpoint: id + ".safetensors"}, nil
	}
	q := newGenQueue(e, resolve, genSave(func(time.Time) string { return dir }), &gpuGate{})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { q.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
	return q, dir
}

// waitTask ждёт, пока задача закончится
func waitTask(t *testing.T, q *genQueue, id int) GenTask {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		for _, x := range q.State() {
			if x.ID == id && x.finished() {
				return x
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("task %d did not finish: %+v", id, q.State())
	return GenTask{}
}

func waitStatus(t *testing.T, q *genQueue, id int, status string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		for _, x := range q.State() {
			if x.ID == id && x.Status == status {
				return
			}
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("task %d never became %s", id, status)
}

func TestQueueRuns(t *testing.T) {
	e := &fakeEngine{}
	q, dir := testQueue(t, e)
	id := q.Add("sdxl", GenParams{Prompt: "fox", Seed: 100}, 3, genAddReq{})
	task := waitTask(t, q, id)
	if task.Status != "done" || len(task.Images) != 3 {
		t.Fatalf("%+v", task)
	}
	if !slices.Equal(e.seeds, []int64{100, 101, 102}) {
		t.Errorf("seeds %v", e.seeds)
	}
	for i, img := range task.Images {
		if filepath.Dir(img) != dir {
			t.Errorf("image outside gallery: %s", img)
		}
		b, _ := os.ReadFile(img)
		if string(b) != "png:fox" {
			t.Errorf("image %d: %q", i, b)
		}
		var meta GenMeta
		mb, _ := os.ReadFile(strings.TrimSuffix(img, ".png") + ".json")
		if json.Unmarshal(mb, &meta) != nil || meta.Model != "sdxl" || meta.Params.Seed != int64(100+i) || meta.Params.Prompt != "fox" {
			t.Errorf("meta %d: %s", i, mb)
		}
	}
	if task.PreviewSeq == 0 {
		t.Error("preview frames not counted")
	}

	// тот же набор моделей не грузится заново, другой — грузится
	waitTask(t, q, q.Add("sdxl", GenParams{Prompt: "cat"}, 1, genAddReq{}))
	waitTask(t, q, q.Add("flux", GenParams{Prompt: "dog"}, 1, genAddReq{}))
	if e.loads != 2 {
		t.Errorf("%d loads, want 2", e.loads)
	}
	q.Clear()
	if len(q.State()) != 0 {
		t.Error("finished tasks not cleared")
	}
}

func TestQueueRandomSeed(t *testing.T) {
	q, _ := testQueue(t, &fakeEngine{})
	task := waitTask(t, q, q.Add("sdxl", GenParams{Seed: -1}, 1, genAddReq{}))
	if task.Params.Seed < 0 {
		t.Errorf("seed %d", task.Params.Seed)
	}
}

func TestQueueCancel(t *testing.T) {
	e := &fakeEngine{block: make(chan struct{})}
	q, _ := testQueue(t, e)
	a := q.Add("sdxl", GenParams{Prompt: "a"}, 2, genAddReq{})
	b := q.Add("sdxl", GenParams{Prompt: "b"}, 1, genAddReq{})
	waitStatus(t, q, a, "running")
	if img, seq := q.Preview(a); string(img) != "frame" || seq == 0 {
		t.Errorf("preview %q %d", img, seq)
	}
	q.Cancel(b) // ждущая — сразу
	q.Cancel(a) // работающая — через движок
	if ta := waitTask(t, q, a); ta.Status != "cancelled" {
		t.Errorf("a: %s", ta.Status)
	}
	if tb := waitTask(t, q, b); tb.Status != "cancelled" {
		t.Errorf("b: %s", tb.Status)
	}
	if img, _ := q.Preview(a); img != nil {
		t.Error("preview kept after the task ended")
	}

	// очередь живёт дальше
	close(e.block)
	if tc := waitTask(t, q, q.Add("sdxl", GenParams{Prompt: "c"}, 1, genAddReq{})); tc.Status != "done" {
		t.Errorf("c: %+v", tc)
	}
}

func TestQueueRetry(t *testing.T) {
	genRetryPause = 0
	// один сбой: второй заход на той же загрузке
	e := &fakeEngine{failN: 1}
	q, _ := testQueue(t, e)
	if task := waitTask(t, q, q.Add("sdxl", GenParams{Prompt: "r"}, 1, genAddReq{})); task.Status != "done" || e.loads != 1 {
		t.Errorf("1 сбой: %+v, загрузок %d", task, e.loads)
	}
	// два сбоя: третий заход после перезагрузки в экономном режиме
	e = &fakeEngine{failN: 2}
	q, _ = testQueue(t, e)
	if task := waitTask(t, q, q.Add("sdxl", GenParams{Prompt: "r"}, 1, genAddReq{})); task.Status != "done" || e.loads != 2 || !e.loaded.LowVRAM {
		t.Errorf("2 сбоя: %+v, загрузок %d, %+v", task, e.loads, e.loaded)
	}
}

func TestQueueFail(t *testing.T) {
	genRetryPause = 0
	e := &fakeEngine{}
	q, _ := testQueue(t, e)
	if task := waitTask(t, q, q.Add("missing", GenParams{}, 1, genAddReq{})); task.Status != "failed" || task.Err == "" {
		t.Errorf("%+v", task)
	}
	e.mu.Lock()
	e.fail = errors.New("boom")
	e.mu.Unlock()
	if task := waitTask(t, q, q.Add("sdxl", GenParams{}, 1, genAddReq{})); task.Status != "failed" || task.Err != "boom" {
		t.Errorf("%+v", task)
	}
}

func TestQueueIdleUnload(t *testing.T) {
	e := &fakeEngine{}
	dir := t.TempDir()
	gpu := &gpuGate{}
	q := newGenQueue(e, func(id string) (ModelSet, error) { return ModelSet{Checkpoint: id}, nil },
		genSave(func(time.Time) string { return dir }), gpu)
	q.idle = 30 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { q.Run(ctx); close(done) }()
	defer func() { cancel(); <-done }()
	waitTask(t, q, q.Add("sdxl", GenParams{}, 1, genAddReq{}))
	if gpu.holder() != "sd" {
		t.Errorf("gpu holder %q", gpu.holder())
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, ok := e.Loaded(); !ok {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if _, ok := e.Loaded(); ok || gpu.holder() != "" {
		t.Error("engine not unloaded after idle")
	}
}

func TestGPUGate(t *testing.T) {
	g := &gpuGate{}
	var released []string
	g.take("llm", func() { released = append(released, "llm") })
	g.take("llm", func() { released = append(released, "llm2") }) // тот же хозяин себя не выгоняет, только обновляет функцию
	g.take("sd", func() { released = append(released, "sd") })
	if !slices.Equal(released, []string{"llm2"}) || g.holder() != "sd" { // выгоняется последней переданной функцией
		t.Errorf("%v %s", released, g.holder())
	}
	g.drop("llm") // чужое не отпускает
	if g.holder() != "sd" {
		t.Error("dropped by a stranger")
	}
	g.drop("sd")
	if g.holder() != "" {
		t.Error("not dropped")
	}
}
