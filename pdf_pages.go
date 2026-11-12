package main

// «Страницы» в инструменте «PDF»: склейка, разрезание, порядок, повороты, удаление, дубли.
// Сетку страниц рисует окно (web/js/pdfpages.js, pdf.js) и присылает готовый план: список файлов-результатов,
// у каждого свой список страниц (откуда, какая, на сколько повернуть). Сервер собирает их pdfcpu в памяти:
// страницы одного источника подряд вынимаются пачкой (порядок и повторы сохраняются), поворот добавляется к собственному,
// пачки склеиваются.

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/types"
)

// PDFPageRef: одна страница результата
type PDFPageRef struct {
	Src string `json:"src"` // файл-источник (из Files запроса)
	N   int    `json:"n"`   // номер страницы в нём, с 1
	Rot int    `json:"rot"` // на сколько довернуть по часовой: 0, 90, 180, 270
}

// PDFPagesDoc: один файл-результат
type PDFPagesDoc struct {
	Name  string       `json:"name"` // имя без расширения; пусто — по первому источнику
	Pages []PDFPageRef `json:"pages"`
}

// PDFPagesOpts: план для "pages"; пустой — все страницы всех файлов в одном PDF по порядку
type PDFPagesOpts struct {
	Docs []PDFPagesDoc `json:"docs"`
}

var errPagesBad = errors.New("pdf pages: bad plan")

// pdfPagesPlan: проверенный план. Файлы вне запроса и странные повороты — ошибка запроса, а не файла
func pdfPagesPlan(o PDFPagesOpts, files []string) ([]PDFPagesDoc, error) {
	if len(o.Docs) == 0 {
		return nil, errPagesBad
	}
	known := map[string]string{}
	for _, f := range files {
		known[strings.ToLower(f)] = f
	}
	out := make([]PDFPagesDoc, 0, len(o.Docs))
	for _, d := range o.Docs {
		if len(d.Pages) == 0 {
			continue
		}
		nd := PDFPagesDoc{Name: strings.TrimSpace(d.Name)}
		for _, p := range d.Pages {
			src, ok := known[strings.ToLower(p.Src)]
			rot := ((p.Rot % 360) + 360) % 360
			if !ok || p.N < 1 || rot%90 != 0 {
				return nil, errPagesBad
			}
			nd.Pages = append(nd.Pages, PDFPageRef{Src: src, N: p.N, Rot: rot})
		}
		out = append(out, nd)
	}
	return out, nil
}

// pdfBuildPages: собрать страницы refs в один PDF dst (через .part). Закрытые файлы дают закрытый результат тем же паролем
func pdfBuildPages(c context.Context, refs []PDFPageRef, dst, pw string, progress func(float64)) error {
	if len(refs) == 0 {
		return errPagesBad
	}
	// после последней пачки источник из памяти уходит: склейка сотен файлов не держит их все сразу
	last := map[string]int{}
	for i, r := range refs {
		last[r.Src] = i
	}
	cache := map[string]*model.Context{}
	locked := false
	open := func(p string) (*model.Context, error) {
		if ctx := cache[p]; ctx != nil {
			return ctx, nil
		}
		ctx, _, err := pdfOpenRepair(c, p, pw)
		if err != nil {
			return nil, err
		}
		ctx.Configuration.CreateBookmarks = false // закладки пачек всё равно не переносятся
		if err := api.OptimizeContext(c, ctx); err != nil {
			return nil, err
		}
		if ctx.Encrypt != nil {
			locked = true
		}
		cache[p] = ctx
		return ctx, nil
	}

	// каждая пачка пишется в память отдельным PDF, потом их склеивает api.MergeRaw (склейка контекстов «вживую»
	// в pdfcpu требует сведений о чтении, которых у вынутых страниц нет)
	var parts [][]byte
	for i := 0; i < len(refs); {
		if err := c.Err(); err != nil {
			return err
		}
		j := i
		seen := map[int]bool{} // повтор страницы в одной пачке pdfcpu схлопывает в одну: повтор начинает новую пачку
		for j < len(refs) && refs[j].Src == refs[i].Src && !seen[refs[j].N] {
			seen[refs[j].N] = true
			j++
		}
		run := refs[i:j]
		src := run[0].Src
		ctx, err := open(src)
		if err != nil {
			return err
		}
		nrs := make([]int, len(run))
		for k, r := range run {
			if r.N > ctx.PageCount {
				return fmt.Errorf("%s: page %d of %d", filepath.Base(src), r.N, ctx.PageCount)
			}
			nrs[k] = r.N
		}
		part, err := pdfcpu.ExtractPages(c, ctx, nrs, false)
		if err != nil {
			return err
		}
		part.PageCount = len(run) // ExtractPages его не заполняет, а поворот ищет страницы по нему
		rots := map[int]types.IntSet{}
		for k, r := range run {
			if r.Rot != 0 {
				if rots[r.Rot] == nil {
					rots[r.Rot] = types.IntSet{}
				}
				rots[r.Rot][k+1] = true
			}
		}
		for rot, set := range rots {
			if err := pdfcpu.RotatePages(c, part, set, rot); err != nil {
				return err
			}
		}
		part.EnsureVersionForWriting()
		var buf bytes.Buffer
		if err := api.WriteContext(c, part, &buf); err != nil {
			return err
		}
		parts = append(parts, buf.Bytes())
		if last[src] < j {
			delete(cache, src)
		}
		if progress != nil {
			progress(float64(j) / float64(len(refs)) * 0.8)
		}
		i = j
	}
	cache = nil

	tmp := dst + ".part"
	defer os.Remove(tmp)
	plain := tmp
	if locked && pw != "" {
		plain = dst + ".plain"
		defer os.Remove(plain)
	}
	f, err := os.Create(plain)
	if err != nil {
		return err
	}
	conf := pdfConf("")
	conf.CreateBookmarks = false
	rs := make([]io.ReadSeeker, len(parts))
	for i, p := range parts {
		rs[i] = bytes.NewReader(p)
	}
	err = api.MergeRaw(c, rs, f, false, conf)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	if plain != tmp {
		if err := api.EncryptFile(c, plain, tmp, model.NewAESConfiguration(pw, pw, 256)); err != nil {
			return err
		}
	}
	if err := c.Err(); err != nil {
		return err
	}
	return os.Rename(tmp, dst)
}

// runPages: прогон «Страницы». Состояния — исходные файлы; результатов может быть больше или меньше
func (s *Server) runPages(c context.Context, states []*FileState, req PDFReq) (ok, bad int) {
	paths := make([]string, len(states))
	idx := map[string]int{}
	for i, st := range states {
		paths[i] = st.Path
		idx[strings.ToLower(st.Path)] = i
	}
	docs, err := pdfPagesPlan(req.Pages, paths)
	if err != nil {
		// план не разобрать или он пуст: честно сказать у каждого файла
		for i := range states {
			bad++
			msg := tr("pdf.pgNoPlan")
			s.set(i, func(fs *FileState) { fs.Status = "error"; fs.Msg = msg; fs.Hint = msg })
		}
		s.addLog("[pdf] pages: %v", err)
		return
	}
	used := map[string]bool{}
	used2 := make([]bool, len(states)) // файл вошёл хотя бы в один результат
	for n, d := range docs {
		if c.Err() != nil {
			break
		}
		var mine []int // номера состояний, из которых собран этот результат
		seen := map[int]bool{}
		for _, p := range d.Pages {
			if i := idx[strings.ToLower(p.Src)]; !seen[i] {
				seen[i] = true
				mine = append(mine, i)
			}
		}
		for _, i := range mine {
			used2[i] = true
			s.set(i, func(fs *FileState) {
				if fs.Status != "error" {
					fs.Status = "running"
				}
			})
		}
		first := d.Pages[0].Src
		stem := fileStem(first)
		if d.Name != "" {
			stem = safeName(d.Name)
		}
		dst := outPathNamed(first, stem, ".pdf", StartReq{SameDir: req.SameDir, OutDir: req.OutDir, Copy: true}, used)
		base := float64(n) / float64(len(docs)) * 100
		err := pdfBuildPages(c, d.Pages, dst, req.Password, func(f float64) {
			for _, i := range mine {
				s.set(i, func(fs *FileState) {
					if fs.Status == "running" {
						fs.Pct = base + f*100/float64(len(docs))
					}
				})
			}
		})
		if c.Err() != nil {
			os.Remove(dst)
			break
		}
		if err != nil {
			bad++
			msg := pdfErrText(err)
			s.addLog("[pdf] pages %s: %v", filepath.Base(dst), err)
			for _, i := range mine {
				s.set(i, func(fs *FileState) { fs.Status = "error"; fs.Msg = msg; fs.Hint = msg })
			}
			continue
		}
		ok++
		size := fileSize(dst)
		msg := fmt.Sprintf("→ %s (%s)", filepath.Base(dst), tr("pdf.pgCount", len(d.Pages)))
		for _, i := range mine {
			s.set(i, func(fs *FileState) {
				if fs.Status == "error" {
					return
				}
				fs.Status = "running"
				fs.Pct = float64(n+1) / float64(len(docs)) * 100
				if fs.Dst == "" {
					fs.Dst, fs.DstSize, fs.Msg = dst, size, msg
				} else {
					fs.Msg = tr("pdf.pgMany")
				}
			})
		}
		s.addLog("[pdf] %d → %s", len(d.Pages), dst)
	}
	for i := range states {
		i := i
		s.set(i, func(fs *FileState) {
			switch {
			case fs.Status == "running":
				fs.Status, fs.Pct = "ok", 100
			case fs.Status == "pending" && !used2[i] && c.Err() == nil:
				fs.Status, fs.Pct, fs.Msg = "ok", 100, tr("pdf.pgUnused")
			}
		})
	}
	return
}
