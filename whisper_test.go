package main

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
)

// Настоящий whisper-cli в тестах не запускается: качать программу на каждую проверку незачем.

func TestWhisperPct(t *testing.T) {
	for line, want := range map[string]float64{
		"whisper_print_progress_callback: progress =  25%": 25,
		"progress = 100%": 100,
		"[00:00:01.000 --> 00:00:02.000] progress is good": -1,
	} {
		if got := whisperPct(line); got != want {
			t.Errorf("%q: %v", line, got)
		}
	}
}

// Сумма не сошлась: файла на месте нет. Сошлась: файл есть, недокачанного рядом нет.
func TestWhisperFetch(t *testing.T) {
	body := []byte("модель")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write(body) }))
	defer srv.Close()
	dst := filepath.Join(t.TempDir(), "sub", "m.bin")
	sum := sha256.Sum256(body)
	noop := func(float64) {}

	if err := whisperFetch(context.Background(), whisperFile{srv.URL, int64(len(body)), strings.Repeat("0", 64)}, dst, noop); err == nil {
		t.Error("чужая сумма прошла")
	}
	if fileExists(dst) || fileExists(dst+".part") {
		t.Error("после плохой суммы остался файл")
	}
	if err := whisperFetch(context.Background(), whisperFile{srv.URL, int64(len(body)) + 1, hex.EncodeToString(sum[:])}, dst, noop); err == nil {
		t.Error("чужой размер прошёл")
	}
	if err := whisperFetch(context.Background(), whisperFile{srv.URL, int64(len(body)), hex.EncodeToString(sum[:])}, dst, noop); err != nil {
		t.Fatal(err)
	}
	if !fileExists(dst) || fileExists(dst+".part") {
		t.Error("файл не на месте")
	}
}

// Из архива берутся только программа и библиотеки, и только в свою папку
func TestWhisperUnpack(t *testing.T) {
	dir := t.TempDir()
	archive := filepath.Join(dir, "p.zip")
	f, _ := os.Create(archive)
	zw := zip.NewWriter(f)
	for _, name := range []string{"Release/whisper-cli.exe", "Release/ggml.dll", "Release/stream.exe", "../../evil.dll", "readme.txt"} {
		w, _ := zw.Create(name)
		w.Write([]byte(name))
	}
	zw.Close()
	f.Close()
	out := filepath.Join(dir, "out")
	os.Mkdir(out, 0o755)
	if err := whisperUnpack(archive, out); err != nil {
		t.Fatal(err)
	}
	var got []string
	entries, _ := os.ReadDir(out)
	for _, e := range entries {
		got = append(got, e.Name())
	}
	if !slices.Equal(got, []string{"evil.dll", "ggml.dll", "whisper-cli.exe"}) {
		t.Errorf("%v", got)
	}
	if fileExists(filepath.Join(dir, "..", "evil.dll")) {
		t.Error("файл вышел из папки")
	}
}

func TestWhisperPlace(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", os.Getenv("LOCALAPPDATA"))
	dir := t.TempDir()
	lead := filepath.Join(dir, "ролик.mp4")
	cues := []SubCue{{0, 1, "Привет"}}
	first, err := whisperPlace(cues, lead)
	if err != nil || filepath.Base(first) != "ролик.srt" {
		t.Fatalf("%s %v", first, err)
	}
	second, err := whisperPlace(cues, lead)
	if err != nil || filepath.Base(second) != "ролик_2.srt" {
		t.Fatalf("старый файл не должен затираться: %s %v", second, err)
	}
	if _, err := whisperPlace(nil, lead); err == nil {
		t.Error("пустой результат принят")
	}
}

// Звук для распознавания: весь монтаж, 16 кГц, моно; метки вывода и субтитры не мешают
func TestWhisperAudio(t *testing.T) {
	m := newMontFixture(t)
	t.Setenv("LOCALAPPDATA", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", os.Getenv("LOCALAPPDATA"))
	src := m.color("src.mp4", "black", 160, 120, 30, 2, 440)
	p := tracks([]Clip{{Path: src}})
	p.In, p.Out = 1, 1.5
	p.Subs = &Subs{Path: filepath.Join(m.dir, "нет.srt"), Mode: subsModeBurn}
	wav := filepath.Join(m.dir, "a.wav")
	if err := whisperAudio(context.Background(), m.ffm, p, wav); err != nil {
		t.Fatal(err)
	}
	if n := fileSize(wav); n < 60000 || n > 66000 { // 2 секунды по 32000 байт
		t.Errorf("размер %d", n)
	}
}

func TestSaveTextPNG(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", os.Getenv("LOCALAPPDATA"))
	png := base64.StdEncoding.EncodeToString([]byte("\x89PNG\r\n\x1a\nданные"))
	a, _, err := saveTextPNG(png)
	if err != nil || !fileExists(a) {
		t.Fatal(a, err)
	}
	if b, _, _ := saveTextPNG(png); b != a {
		t.Errorf("один текст, два файла: %s %s", a, b)
	}
	if _, _, err := saveTextPNG(base64.StdEncoding.EncodeToString([]byte("not png"))); err == nil {
		t.Error("принят не PNG")
	}
}

func TestSystemFonts(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip()
	}
	fonts := systemFonts()
	if !slices.Contains(fonts, "Arial") || slices.ContainsFunc(fonts, func(f string) bool { return strings.HasPrefix(f, "@") }) {
		t.Errorf("%d шрифтов: %v", len(fonts), fonts[:min(len(fonts), 5)])
	}
}

// Формат полного JSON whisper.cpp. Многобайтовая буква разрезана между частями слова, поэтому файл читается как сырые байты.
func TestWhisperWords(t *testing.T) {
	j := []byte("{\"transcription\":[" +
		"{\"offsets\":{\"from\":0,\"to\":23000},\"tokens\":[" +
		"{\"text\":\"[_BEG_]\",\"offsets\":{\"from\":0,\"to\":0},\"t_dtw\":-1}," +
		"{\"text\":\" Есть\",\"offsets\":{\"from\":0,\"to\":500},\"t_dtw\":2000}," +
		"{\"text\":\" ид\",\"offsets\":{\"from\":500,\"to\":900},\"t_dtw\":2040}," +
		"{\"text\":\"\xD0\",\"offsets\":{\"from\":900,\"to\":950},\"t_dtw\":2060}," +
		"{\"text\":\"\xB5я!\",\"offsets\":{\"from\":950,\"to\":1000},\"t_dtw\":2070}," +
		"{\"text\":\"[_TT_1150]\",\"offsets\":{\"from\":23000,\"to\":23000},\"t_dtw\":-1}]}," +
		"{\"offsets\":{\"from\":23000,\"to\":25000},\"tokens\":[{\"text\":\" (upbeat\",\"offsets\":{\"from\":23000,\"to\":24000}},{\"text\":\" music)\",\"offsets\":{\"from\":24000,\"to\":25000}}]}," +
		"{\"offsets\":{\"from\":25000,\"to\":26000},\"tokens\":[{\"text\":\" Нет\",\"offsets\":{\"from\":25000,\"to\":25500},\"t_dtw\":-1}]}" +
		"]}")
	words, err := whisperWords(j)
	if err != nil {
		t.Fatal(err)
	}
	if len(words) != 3 || words[0].Text != "Есть" || words[1].Text != "идея!" || words[2].Text != "Нет" {
		t.Fatalf("%+v", words)
	}
	if words[0].Start != 20 || words[1].Start != 20.4 {
		t.Errorf("времена слов: %+v", words)
	}
	if words[2].Start != 25 { // t_dtw не посчитан: обычное время
		t.Errorf("запасное время: %+v", words[2])
	}
	if end := words[1].End; end > 21.5 {
		t.Errorf("последнее слово тянется в паузу до конца куска: %v", end)
	}
	if _, err := whisperWords([]byte("{битый")); err == nil {
		t.Error("битый файл принят")
	}
}

func TestWhisperGroup(t *testing.T) {
	w := func(a float64, s string) whisperWord { return whisperWord{a, a + 0.3, s} }
	got := whisperGroup([]whisperWord{w(20, "Есть"), w(20.4, "идея?"), w(21, "Мы"), w(21.4, "запускаем"), w(25, "конкурс")})
	want := []SubCue{{20, 20.7, "Есть идея?"}, {21, 21.7, "Мы запускаем"}, {25, 25.7, "конкурс"}}
	if !slices.Equal(got, want) {
		t.Fatalf("%+v", got)
	}
	var long []whisperWord
	for i := 0; i < 40; i++ {
		long = append(long, w(float64(i)*0.3, "слово"))
	}
	for _, c := range whisperGroup(long) {
		if len([]rune(c.Text)) > cueMaxChars || c.End-c.Start > cueMaxDur+0.5 {
			t.Errorf("длинная реплика: %+v", c)
		}
	}
}

func TestWhisperNoise(t *testing.T) {
	for s, want := range map[string]bool{"(upbeat music)": true, "[МУЗЫКА]": true, "♪": true, "♪ la la ♪": true, "Есть идея (конкурс)": false, "Привет": false} {
		if whisperNoise.MatchString(s) != want {
			t.Errorf("%q", s)
		}
	}
}
