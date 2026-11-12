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
	Files    []string      `json:"files"`
	Op       string        `json:"op"`       // "resave" — пересобрать без потерь, "img2pdf" — картинки в PDF (pdf_images.go), "compress" — сжать (pdf_compress.go), "raster" — PDF в картинки (pdf_raster.go)
	Img      ImgPDFOpts    `json:"img"`      // настройки для "img2pdf"
	Comp     PDFCompress   `json:"comp"`     // настройки для "compress"
	Fix      PDFResaveOpts `json:"fix"`      // настройки для "resave"
	Password string        `json:"password"` // для закрытых файлов, один на всю пачку
	SameDir  bool          `json:"sameDir"`  // «Рядом с оригиналом»
	OutDir   string        `json:"outDir"`   // своя папка, если не SameDir
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

// PDFResaveOpts: настройки «Пересобрать»
type PDFResaveOpts struct {
	Version string `json:"version"` // "" — обычный (pdfcpu пишет 1.7), "1.4" — для старых программ (без сжатых таблиц)
	Strip   bool   `json:"strip"`   // убрать метаданные, миниатюры и служебные данные редакторов
}

// pdfPatchHeader: заменить версию в заголовке «%PDF-1.x» на v той же длины
func pdfPatchHeader(path, v string) error {
	f, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	head := make([]byte, 8)
	if _, err := f.ReadAt(head, 0); err != nil {
		return err
	}
	if !strings.HasPrefix(string(head), "%PDF-") || len(v) != 3 {
		return errors.New("pdf header")
	}
	_, err = f.WriteAt([]byte(v), 5)
	return err
}

// pdfOpenRepair: как pdfOpen, а если файл не проходит проверку (оборван, битая таблица ссылок),
// читает его без строгой проверки: pdfcpu сам восстанавливает таблицу, перебрав объекты. repaired — так и вышло
func pdfOpenRepair(c context.Context, path, pw string) (ctx *model.Context, repaired bool, err error) {
	ctx, err = pdfOpen(c, path, pw)
	if err == nil || errors.Is(err, errPDFPassword) || errors.Is(err, os.ErrNotExist) || c.Err() != nil {
		return ctx, false, err
	}
	f, ferr := os.Open(path)
	if ferr != nil {
		return nil, false, ferr
	}
	defer f.Close()
	conf := pdfConf(pw)
	if ctx, rerr := api.ReadContext(c, f, conf); rerr == nil && ctx.PageCount > 0 {
		return ctx, true, nil
	}
	return nil, false, err
}

// pdfResave: прочитать и записать заново без потерь (лишние и повторяющиеся объекты убираются, мелкие поломки чинятся).
// repaired — файл пришлось чинить
func pdfResave(c context.Context, src, dst, pw string, opt PDFResaveOpts) (repaired bool, err error) {
	ctx, repaired, err := pdfOpenRepair(c, src, pw)
	if err != nil {
		return false, err
	}
	if opt.Strip {
		pdfStrip(c, ctx)
	}
	if err := api.OptimizeContext(c, ctx); err != nil {
		return false, err
	}
	old := opt.Version == "1.4"
	if old {
		// без сжатых таблиц и потоков объектов: их не знают программы до PDF 1.5
		ctx.WriteObjectStream, ctx.WriteXRefStream = false, false
		if root, err := ctx.XRefTable.Catalog(); err == nil && root != nil {
			root.Delete("Version")
		}
	}
	tmp := dst + ".part"
	if err := api.WriteContextFile(c, ctx, tmp); err != nil {
		os.Remove(tmp)
		return false, err
	}
	if old {
		// pdfcpu всегда пишет заголовок %PDF-1.7; та же длина, поэтому меняем на месте, смещения не съезжают
		if err := pdfPatchHeader(tmp, "1.4"); err != nil {
			os.Remove(tmp)
			return false, err
		}
	}
	if err := os.Rename(tmp, dst); err != nil {
		os.Remove(tmp)
		return false, err
	}
	return repaired, nil
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

// pdfBatch: пачка, подготовленная pdfPrep
type pdfBatch struct {
	c      context.Context
	cancel context.CancelFunc
	states []*FileState
	req    PDFReq
	job    *rasterJob // для "raster"
}

// pdfPrep: список файлов и отмена; у "raster" сразу и прогон, чтобы окно могло слать страницы, как только получит ответ
func (s *Server) pdfPrep(req PDFReq) *pdfBatch {
	c, cancel := context.WithCancel(context.Background())
	b := &pdfBatch{c: c, cancel: cancel, req: req}
	for _, p := range req.Files {
		b.states = append(b.states, &FileState{Path: p, Name: filepath.Base(p), Status: "pending", SrcSize: fileSize(p)})
	}
	s.mu.Lock()
	s.files = b.states
	s.batch = "pdf"
	s.cancel = cancel
	s.mu.Unlock()
	if req.Op == "raster" {
		b.job = newRasterJob(c, req, len(b.states))
	}
	return b
}

// startPDF: подготовить и запустить в фоне (ручка /api/pdf-run)
func (s *Server) startPDF(req PDFReq) { go s.pdfWork(s.pdfPrep(req)) }

// runPDF: то же, но дождаться конца (тесты)
func (s *Server) runPDF(req PDFReq) { s.pdfWork(s.pdfPrep(req)) }

func (s *Server) pdfWork(b *pdfBatch) {
	c, cancel, states, req := b.c, b.cancel, b.states, b.req
	var ok, bad int
	var before, after int64
	switch req.Op {
	case "img2pdf":
		ok, bad = s.runImg2PDF(c, states, req)
	case "compress":
		ok, bad, before, after = s.runCompress(c, states, req)
	case "raster":
		ok, bad = s.runRaster(b.job)
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
	switch req.Op {
	case "img2pdf":
		key = "pdf.imgSummary"
	case "raster":
		key = "pdf.rasSummary"
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
		repaired, err := pdfResave(c, st.Path, dst, req.Password, req.Fix)
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
		if repaired {
			msg += " · " + tr("pdf.repaired")
		}
		s.set(i, func(fs *FileState) { fs.Status = "ok"; fs.Pct = 100; fs.Dst = dst; fs.DstSize = size; fs.Msg = msg })
		s.addLog("[pdf] %s → %s", st.Name, dst)
	}
	return
}
