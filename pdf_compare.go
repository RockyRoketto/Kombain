package main

// Сравнение до и после «Сжать»: одна выбранная страница пережимается с текущими настройками,
// страница программы рисует её рядом с оригиналом (шторка и лупа в web/js/pdfraster.js).
// Отметки страниц с картинками — чтобы сразу найти, на что смотреть.

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strconv"
	"sync"
	"time"

	"github.com/pdfcpu/pdfcpu/pkg/api"
)

// PDFPageMarks: ответ /api/pdf-page-marks
type PDFPageMarks struct {
	Pages    int    `json:"pages"`
	Img      []int  `json:"img"` // страницы с картинками, которые «Сжать» пережмёт
	Any      []int  `json:"any"` // страницы с любыми картинками (и теми, что сжатие не трогает)
	NeedPass bool   `json:"needPass"`
	Error    string `json:"error,omitempty"`
}

// pdfPageMarks: какие страницы с картинками. Без OptimizeContext: номера объектов те же, что при чтении
func pdfPageMarks(c context.Context, path, pw string) (r PDFPageMarks) {
	ctx, err := pdfOpen(c, path, pw)
	if err != nil {
		if errors.Is(err, errPDFPassword) {
			r.NeedPass = true
		} else {
			r.Error = pdfErrText(err)
		}
		return
	}
	sizes, pages := pdfImageScan(c, ctx)
	jobs, _ := pdfImageJobs(ctx, sizes)
	can := map[int]bool{}
	for _, j := range jobs {
		can[j.nr] = true
	}
	r.Pages, r.Img, r.Any = ctx.PageCount, []int{}, []int{}
	for p := 1; p <= ctx.PageCount; p++ {
		if len(pages[p]) == 0 {
			continue
		}
		r.Any = append(r.Any, p)
		for nr := range pages[p] {
			if can[nr] {
				r.Img = append(r.Img, p)
				break
			}
		}
	}
	return
}

// PDFCompare: ответ /api/pdf-compare
type PDFCompare struct {
	ID       string `json:"id"`      // готовая страница: /pdf?c=ID
	Page     int    `json:"page"`    //
	Images   int    `json:"images"`  // картинок на странице
	Recoded  int    `json:"recoded"` // из них пережато
	Before   int64  `json:"before"`  // вес картинок страницы до
	After    int64  `json:"after"`   // и после
	Quality  int    `json:"quality"` //
	DPI      int    `json:"dpi"`     //
	NeedPass bool   `json:"needPass"`
	Error    string `json:"error,omitempty"`
}

// pdfComparePage: страница page файла path после «Сжать» с настройками o, отдельным PDF в одну страницу.
// q и dpi для «До размера» страница берёт из своего прогноза (q > 0); нет — подбираем здесь же
func pdfComparePage(c context.Context, path, pw string, o PDFCompress, page, q, dpi int) (r PDFCompare, out []byte) {
	r.Page = page
	fail := func(err error) (PDFCompare, []byte) {
		if errors.Is(err, errPDFPassword) {
			return PDFCompare{Page: page, NeedPass: true}, nil
		}
		return PDFCompare{Page: page, Error: pdfErrText(err)}, nil
	}
	switch {
	case o.targetBytes() == 0:
		q, dpi = o.params()
	case q < 10 || q > 95:
		est := pdfEstimate(c, path, pw, o)
		if est.Error != "" || est.NeedPass {
			return PDFCompare{Page: page, Error: est.Error, NeedPass: est.NeedPass}, nil
		}
		q, dpi = est.Quality, est.DPI
		if est.Already { // файл и так меньше цели: «Сжать» его не тронет
			q = 0
		}
	}
	r.Quality, r.DPI = q, dpi
	p, err := pdfPrepare(c, path, pw, false)
	if err != nil {
		return fail(err)
	}
	if page < 1 || page > p.ctx.PageCount {
		return PDFCompare{Page: page, Error: "page"}, nil
	}
	r.Images = len(p.pages[page])
	var sel []*pdfImgJob
	for _, j := range p.jobs {
		if p.pages[page][j.nr] {
			sel = append(sel, j)
		}
	}
	if q > 0 {
		if err := pdfRecodeAll(c, sel, q, dpi, pdfColor(o.Color), nil); err != nil {
			return fail(err)
		}
	}
	for _, j := range sel {
		r.Before += int64(len(j.sd.Raw))
		if j.replaced {
			r.After += int64(len(j.data))
			pdfApplyJob(p.ctx, j)
			r.Recoded++
		} else {
			r.After += int64(len(j.sd.Raw))
		}
		j.data = nil
	}
	rd, err := api.ExtractPage(c, p.ctx, page)
	if err != nil {
		return fail(err)
	}
	if out, err = io.ReadAll(rd); err != nil {
		return fail(err)
	}
	return
}

// pdfCmp: последняя готовая страница сравнения (одна: окно показывает одну) и отмена прежнего запроса
var pdfCmp struct {
	sync.Mutex
	cancel context.CancelFunc
	n      int
	id     string
	data   []byte
}

// pdfCompareOne: для /api/pdf-compare. Новый запрос отменяет прежний, тот отвечает Error "canceled"
func pdfCompareOne(parent context.Context, path, pw string, o PDFCompress, page, q, dpi int) PDFCompare {
	c, cancel := context.WithTimeout(parent, 3*time.Minute)
	pdfCmp.Lock()
	if pdfCmp.cancel != nil {
		pdfCmp.cancel()
	}
	pdfCmp.cancel = cancel
	pdfCmp.Unlock()
	defer cancel()
	r, out := pdfComparePage(c, path, pw, o, page, q, dpi)
	if c.Err() != nil {
		return PDFCompare{Page: page, Error: "canceled"}
	}
	if out != nil {
		pdfCmp.Lock()
		pdfCmp.n++
		pdfCmp.id, pdfCmp.data = strconv.Itoa(pdfCmp.n), out
		r.ID = pdfCmp.id
		pdfCmp.Unlock()
	}
	return r
}

// pdfCmpGet: страница сравнения по ID для /pdf?c=ID; nil — уже заменена новой
func pdfCmpGet(id string) *bytes.Reader {
	pdfCmp.Lock()
	defer pdfCmp.Unlock()
	if id == "" || id != pdfCmp.id {
		return nil
	}
	return bytes.NewReader(pdfCmp.data)
}

// pdfCmpDrop: окно сравнения закрыли — страница больше не нужна
func pdfCmpDrop() {
	pdfCmp.Lock()
	if pdfCmp.cancel != nil {
		pdfCmp.cancel()
	}
	pdfCmp.id, pdfCmp.data = "", nil
	pdfCmp.Unlock()
}
