package main

// Инструмент «PDF» во вкладке «Утилиты»: общие функции и пакетный прогон.
// Операции делает pdfcpu (чистый Go, Apache 2.0), ffmpeg для PDF не нужен.
// Страница: web/js/pdf.js, разметка #pdfView в web/index.html.

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
)

func init() {
	// иначе pdfcpu при первом вызове пишет config.yml и шрифты в папку настроек пользователя
	model.ConfigPath = "disable"
}

// errPDFPassword: файл закрыт паролем, а пароль не подошёл или не задан
var errPDFPassword = errors.New("pdf password")

// PDFInfo: что показать в списке файлов
type PDFInfo struct {
	Pages     int    `json:"pages"`
	Version   string `json:"version"`
	Encrypted bool   `json:"encrypted"`
	NeedPass  bool   `json:"needPass"` // без (верного) пароля не открыть
	Error     string `json:"error,omitempty"`
}

// PDFReq: запрос /api/pdf-run
type PDFReq struct {
	Files    []string    `json:"files"`
	Op       string      `json:"op"`       // "resave" — пересобрать без потерь, "img2pdf" — картинки в PDF (pdf_images.go), "compress" — сжать (pdf_compress.go)
	Img      ImgPDFOpts  `json:"img"`      // настройки для "img2pdf"
	Comp     PDFCompress `json:"comp"`     // настройки для "compress"
	Password string      `json:"password"` // для закрытых файлов, один на всю пачку
	SameDir  bool        `json:"sameDir"`  // «Рядом с оригиналом»
	OutDir   string      `json:"outDir"`   // своя папка, если не SameDir
}

func pdfConf(pw string) *model.Configuration {
	conf := model.NewDefaultConfiguration()
	conf.UserPW, conf.OwnerPW = pw, pw
	conf.ValidationMode = model.ValidationRelaxed
	return conf
}

func isPDFPassErr(err error) bool {
	return err != nil && (errors.Is(err, pdfcpu.ErrWrongPassword) || strings.Contains(strings.ToLower(err.Error()), "password"))
}

// pdfOpen: прочитать и проверить PDF; pw — пароль, если файл закрыт
func pdfOpen(c context.Context, path, pw string) (*model.Context, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	ctx, err := api.ReadAndValidate(c, f, pdfConf(pw))
	if isPDFPassErr(err) {
		return nil, errPDFPassword
	}
	if err != nil {
		return nil, err
	}
	return ctx, nil
}

// pdfInfo: страницы, версия, нужен ли пароль. Ошибку чтения кладёт в Error, чтобы список показал её у файла
func pdfInfo(c context.Context, path, pw string) PDFInfo {
	ctx, err := pdfOpen(c, path, pw)
	switch {
	case errors.Is(err, errPDFPassword):
		return PDFInfo{Encrypted: true, NeedPass: true}
	case err != nil:
		return PDFInfo{Error: pdfErrText(err)}
	}
	return PDFInfo{Pages: ctx.PageCount, Version: ctx.XRefTable.Version().String(), Encrypted: ctx.Encrypt != nil}
}

// pdfErrText: понятный текст ошибки
func pdfErrText(err error) string {
	switch {
	case errors.Is(err, errPDFPassword):
		return tr("pdf.needPass")
	case errors.Is(err, os.ErrNotExist):
		return tr("pdf.noFile")
	}
	return tr("pdf.broken") // подробности в логе
}

// pdfOutPath: куда записать результат. Рядом с оригиналом или в свою папку; оригинал и чужие файлы не трогает,
// при совпадении имени добавляет « (1)», « (2)»…
func pdfOutPath(src string, req PDFReq, used map[string]bool) string {
	return outPathNamed(src, fileStem(src), ".pdf", StartReq{SameDir: req.SameDir, OutDir: req.OutDir, Copy: true}, used)
}

// pdfList: PDF и картинки для «Картинки → PDF» из выбранных путей, папки — вместе с подпапками
func pdfList(paths []string) []FileInfo {
	var found []string
	seen := map[string]bool{}
	add := func(p string) {
		if k := strings.ToLower(p); !seen[k] && (strings.EqualFold(filepath.Ext(p), ".pdf") || isImgForPDF(p)) {
			seen[k] = true
			found = append(found, p)
		}
	}
	for _, p := range paths {
		st, err := os.Stat(p)
		if err != nil {
			continue
		}
		if !st.IsDir() {
			add(p)
			continue
		}
		filepath.WalkDir(p, func(q string, d os.DirEntry, err error) error {
			if err == nil && !d.IsDir() {
				add(q)
			}
			return nil
		})
	}
	return infos(found)
}

// pdfResave: прочитать и записать заново без потерь (лишние и повторяющиеся объекты убираются)
func pdfResave(c context.Context, src, dst, pw string) error {
	ctx, err := pdfOpen(c, src, pw)
	if err != nil {
		return err
	}
	if err := api.OptimizeContext(c, ctx); err != nil {
		return err
	}
	tmp := dst + ".part"
	if err := api.WriteContextFile(c, ctx, tmp); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, dst); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// beginPDF: как begin, только ffmpeg не нужен
func (s *Server) beginPDF() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case s.appUpd.Active || s.appUpd.Restart:
		return errT("err.updating")
	case s.running:
		return errT("err.busyBanner")
	}
	s.running = true
	s.batchSeq++
	s.files = nil
	s.summary = ""
	return nil
}

func (s *Server) runPDF(req PDFReq) {
	c, cancel := context.WithCancel(context.Background())
	var states []*FileState
	for _, p := range req.Files {
		states = append(states, &FileState{Path: p, Name: filepath.Base(p), Status: "pending", SrcSize: fileSize(p)})
	}
	s.mu.Lock()
	s.files = states
	s.batch = "pdf"
	s.cancel = cancel
	s.mu.Unlock()

	var ok, bad int
	var before, after int64
	switch req.Op {
	case "img2pdf":
		ok, bad = s.runImg2PDF(c, states, req)
	case "compress":
		ok, bad, before, after = s.runCompress(c, states, req)
	default:
		ok, bad = s.runResave(c, states, req)
	}

	s.mu.Lock()
	canc := false
	for _, fs := range s.files {
		if fs.Status == "pending" || fs.Status == "running" {
			fs.Status = "canceled"
			canc = true
		}
	}
	title := tr("batch.done")
	if canc {
		title = tr("batch.stopped")
	}
	key := "pdf.summary"
	if req.Op == "img2pdf" {
		key = "pdf.imgSummary"
	}
	s.summary = tr(key, title, ok, len(states), bad)
	if req.Op == "compress" {
		// итог по пачке: «было 180 МБ → стало 42 МБ», не сжатые считаются как были
		kept := 0
		for _, fs := range s.files {
			if fs.Status == "kept" {
				kept++
			}
		}
		s.summary = tr("pdf.compSummary", title, ok, len(states), kept, bad)
		if before > 0 {
			s.summary += "; " + tr("pdf.compTotal", pdfSaved(before, after))
		}
	}
	s.running = false
	s.cancel = nil
	s.mu.Unlock()
	cancel()
	s.addLog("%s", s.summary)
}

// runResave: «Пересобрать» каждый PDF
func (s *Server) runResave(c context.Context, states []*FileState, req PDFReq) (ok, bad int) {
	used := map[string]bool{}
	for i, st := range states {
		if c.Err() != nil {
			break
		}
		s.set(i, func(fs *FileState) { fs.Status = "running" })
		dst := pdfOutPath(st.Path, req, used) // копия из браузера уходит в папку по умолчанию (outPathNamed)
		err := pdfResave(c, st.Path, dst, req.Password)
		if c.Err() != nil {
			os.Remove(dst)
			break
		}
		if err != nil {
			bad++
			msg := pdfErrText(err)
			s.set(i, func(fs *FileState) { fs.Status = "error"; fs.Msg = msg; fs.Hint = msg })
			s.addLog("[pdf] %s: %v", st.Name, err)
			continue
		}
		ok++
		size := fileSize(dst)
		msg := fmt.Sprintf("%s → %s", fmtKB(st.SrcSize), fmtKB(size))
		s.set(i, func(fs *FileState) { fs.Status = "ok"; fs.Pct = 100; fs.Dst = dst; fs.DstSize = size; fs.Msg = msg })
		s.addLog("[pdf] %s → %s", st.Name, dst)
	}
	return
}
