package main

// «Оформление и защита» в инструменте «PDF» (op "decor"): водяной знак, нумерация страниц, поля (обрезка),
// метаданные, пароль (поставить или снять). Всё за один проход по файлу: правки идут в одном контексте pdfcpu,
// пароль ставится отдельным шагом по готовому файлу. Страница: web/js/pdf.js (pdfSet.dec).

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/font"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/types"
)

// PDFDecor: настройки op "decor". Каждый блок включается своим On
type PDFDecor struct {
	WM struct {
		On      bool   `json:"on"`
		Kind    string `json:"kind"`    // "text" или "image"
		Text    string `json:"text"`    // для text
		Image   string `json:"image"`   // путь к картинке для image
		Size    int    `json:"size"`    // кегль текста, pt (по умолчанию 64)
		Scale   int    `json:"scale"`   // картинка: ширина в % от ширины страницы (по умолчанию 40)
		Opacity int    `json:"opacity"` // 5…100, % (по умолчанию 30)
		Rotate  int    `json:"rotate"`  // градусы против часовой стрелки: 0, 45, 90, -45
		Pos     string `json:"pos"`     // c, tl, tc, tr, bl, bc, br
		Color   string `json:"color"`   // #rrggbb (текст)
		OnTop   bool   `json:"onTop"`   // поверх содержимого (иначе под ним)
	} `json:"wm"`
	Num struct {
		On        bool   `json:"on"`
		Format    string `json:"format"` // шаблон: %p — номер, %P — всего страниц
		Pos       string `json:"pos"`    // bl, bc, br, tl, tc, tr
		Size      int    `json:"size"`   // кегль, pt (по умолчанию 11)
		SkipFirst bool   `json:"skipFirst"`
	} `json:"num"`
	Crop struct {
		On                       bool    `json:"on"`
		Top, Right, Bottom, Left float64 // мм
	} `json:"crop"`
	Meta struct {
		On       bool   `json:"on"`
		Title    string `json:"title"`
		Author   string `json:"author"`
		Subject  string `json:"subject"`
		Keywords string `json:"keywords"`
		Clean    bool   `json:"clean"` // сначала убрать все метаданные
	} `json:"meta"`
	Pass struct {
		Mode string `json:"mode"` // "" — как есть, "set" — поставить, "remove" — снять
		New  string `json:"new"`  // новый пароль для "set"
	} `json:"pass"`
}

// any: есть ли что делать
func (d PDFDecor) any() bool {
	return d.WM.On || d.Num.On || d.Crop.On || d.Meta.On || d.Meta.Clean || d.Pass.Mode == "set" || d.Pass.Mode == "remove"
}

var (
	decorFontOnce sync.Once
	decorFontName string
	decorFontErr  error
)

// pdfDecorFont: шрифт с кириллицей для текста водяного знака и номеров. pdfcpu сам берёт только свои установленные
// шрифты, поэтому ставим Arial (или Segoe UI, Tahoma) из системы в свою временную папку, один раз за запуск
func pdfDecorFont(c context.Context) (string, error) {
	decorFontOnce.Do(func() {
		dir := filepath.Join(os.TempDir(), "kombain-pdffonts")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			decorFontErr = err
			return
		}
		font.UserFontDir = dir
		win := os.Getenv("WINDIR")
		if win == "" {
			win = `C:\Windows`
		}
		for _, f := range []string{"arial.ttf", "segoeui.ttf", "tahoma.ttf", "calibri.ttf"} {
			rep, err := font.InstallTrueTypeFont(dir, filepath.Join(win, "Fonts", f))
			if err != nil || len(rep.Fonts) == 0 {
				continue
			}
			if err := font.ReloadUserFonts(c); err != nil {
				decorFontErr = err
				return
			}
			decorFontName = rep.Fonts[0].PostScriptName
			return
		}
		decorFontErr = errors.New("no cyrillic font")
	})
	return decorFontName, decorFontErr
}

// pdfWMDesc: описание водяного знака для pdfcpu
func pdfWMDesc(parts ...string) string { return strings.Join(parts, ", ") }

func decorColor(s string) string {
	s = strings.TrimSpace(s)
	if len(s) == 7 && s[0] == '#' {
		return s
	}
	return "#808080"
}

func decorClamp(v, lo, hi, def int) int {
	if v == 0 {
		return def
	}
	return min(max(v, lo), hi)
}

func decorPos(p, def string) string {
	switch p {
	case "c", "tl", "tc", "tr", "bl", "bc", "br":
		return p
	}
	return def
}

// pdfAllPages: все страницы или все, кроме первой
func pdfAllPages(n int, skipFirst bool) types.IntSet {
	set := types.IntSet{}
	for p := 1; p <= n; p++ {
		if p == 1 && skipFirst {
			continue
		}
		set[p] = true
	}
	return set
}

// pdfDecorApply: правки в открытом контексте (без записи и пароля).
// only > 0 — только эта страница (предпросмотр «после»): номер и «из N» остаются как во всём файле
func pdfDecorApply(c context.Context, ctx *model.Context, d PDFDecor, conf *model.Configuration, only int) error {
	pagesOf := func(skipFirst bool) types.IntSet {
		if only > 0 {
			if skipFirst && only == 1 {
				return types.IntSet{}
			}
			return types.IntSet{only: true}
		}
		return pdfAllPages(ctx.PageCount, skipFirst)
	}
	if d.Meta.Clean {
		pdfStrip(c, ctx)
	}
	if d.Meta.On {
		props := map[string]string{}
		for k, v := range map[string]string{"Title": d.Meta.Title, "Author": d.Meta.Author, "Subject": d.Meta.Subject, "Keywords": d.Meta.Keywords} {
			if strings.TrimSpace(v) != "" {
				props[k] = strings.TrimSpace(v)
			}
		}
		if len(props) > 0 {
			if err := pdfcpu.PropertiesAdd(c, ctx, props); err != nil {
				return err
			}
		}
	}
	if d.Crop.On {
		box, err := model.ParseBox(fmt.Sprintf("%g %g %g %g abs", d.Crop.Top, d.Crop.Right, d.Crop.Bottom, d.Crop.Left), types.MILLIMETRES)
		if err != nil {
			return err
		}
		if err := ctx.Crop(c, pagesOf(false), box); err != nil {
			return err
		}
	}
	if d.WM.On {
		var wm *model.Watermark
		var err error
		pos := decorPos(d.WM.Pos, "c")
		common := []string{
			fmt.Sprintf("op:%.2f", float64(decorClamp(d.WM.Opacity, 5, 100, 30))/100),
			fmt.Sprintf("rot:%d", d.WM.Rotate%360),
			"pos:" + pos,
			"mo:0",
		}
		if d.WM.Kind == "image" {
			if d.WM.Image == "" {
				return errors.New("watermark image")
			}
			parts := append([]string{fmt.Sprintf("scale:%.2f rel", float64(decorClamp(d.WM.Scale, 5, 100, 40))/100)}, common...)
			wm, err = pdfcpu.ParseImageWatermarkDetails(c, d.WM.Image, pdfWMDesc(parts...), d.WM.OnTop, types.POINTS, nil)
		} else {
			if strings.TrimSpace(d.WM.Text) == "" {
				return errors.New("watermark text")
			}
			fn, ferr := pdfDecorFont(c)
			if ferr != nil {
				return ferr
			}
			parts := append([]string{"font:" + fn, fmt.Sprintf("points:%d", decorClamp(d.WM.Size, 8, 400, 64)), "scale:1 abs", "fillc:" + decorColor(d.WM.Color)}, common...)
			wm, err = pdfcpu.ParseTextWatermarkDetails(c, d.WM.Text, pdfWMDesc(parts...), d.WM.OnTop, types.POINTS, nil)
		}
		if err != nil {
			return err
		}
		if err := decorStamp(c, ctx, pagesOf(false), wm); err != nil {
			return err
		}
	}
	if d.Num.On {
		fn, err := pdfDecorFont(c)
		if err != nil {
			return err
		}
		f := d.Num.Format
		if !strings.Contains(f, "%p") {
			f = "%p"
		}
		pos := decorPos(d.Num.Pos, "bc")
		desc := pdfWMDesc("font:"+fn, fmt.Sprintf("points:%d", decorClamp(d.Num.Size, 6, 72, 11)), "scale:1 abs", "fillc:#333333", "pos:"+pos, "off:"+offForPos(pos), "rot:0", "op:1", "mo:0")
		wm, err := pdfcpu.ParseTextWatermarkDetails(c, f, desc, true, types.POINTS, nil)
		if err != nil {
			return err
		}
		if set := pagesOf(d.Num.SkipFirst); len(set) > 0 {
			if err := decorStamp(c, ctx, set, wm); err != nil {
				return err
			}
		}
	}
	return nil
}

// offForPos: отступ номера от края страницы (pt): вдоль края 28, от края 20
func offForPos(pos string) string {
	x, y := 0, 20
	switch {
	case strings.HasSuffix(pos, "l"):
		x = 28
	case strings.HasSuffix(pos, "r"):
		x = -28
	}
	if strings.HasPrefix(pos, "t") {
		y = -20
	}
	return fmt.Sprintf("%d %d", x, y)
}

// pdfDecor: прочитать src, применить правки и записать dst. Пароль на чтение — pw
func pdfDecor(c context.Context, src, dst, pw string, d PDFDecor) (repaired bool, err error) {
	ctx, repaired, err := pdfOpenRepair(c, src, pw)
	if err != nil {
		return false, err
	}
	conf := pdfConf(pw)
	if err := pdfDecorApply(c, ctx, d, conf, 0); err != nil {
		return false, err
	}
	if err := api.OptimizeContext(c, ctx); err != nil {
		return false, err
	}
	tmp := dst + ".part"
	tmp2 := dst + ".part2"
	defer os.Remove(tmp2)
	if err := api.WriteContextFile(c, ctx, tmp); err != nil {
		os.Remove(tmp)
		return false, err
	}
	cur := tmp
	step := func(f func(in, out string) error) error {
		next := tmp2
		if cur == tmp2 {
			next = tmp
		}
		if err := f(cur, next); err != nil {
			return err
		}
		cur = next
		return nil
	}
	fail := func(err error) (bool, error) {
		os.Remove(tmp)
		os.Remove(tmp2)
		return false, err
	}
	closed := ctx.Encrypt != nil
	if closed && (d.Pass.Mode == "remove" || d.Pass.Mode == "set") {
		// снять старый пароль (для "set" — чтобы поставить новый)
		if err := step(func(in, out string) error { return api.DecryptFile(c, in, out, pdfConf(pw)) }); err != nil {
			return fail(err)
		}
		closed = false
	}
	if d.Pass.Mode == "set" {
		npw := strings.TrimSpace(d.Pass.New)
		if npw == "" {
			return fail(errors.New("new password is empty"))
		}
		owner := make([]byte, 12)
		rand.Read(owner)
		ec := model.NewAESConfiguration(npw, npw+hex.EncodeToString(owner), 256)
		ec.ValidationMode = model.ValidationRelaxed
		if err := step(func(in, out string) error { return api.EncryptFile(c, in, out, ec) }); err != nil {
			return fail(err)
		}
	}
	if err := os.Rename(cur, dst); err != nil {
		return fail(err)
	}
	if cur == tmp {
		os.Remove(tmp2)
	} else {
		os.Remove(tmp)
	}
	return repaired, nil
}

// runDecor: «Оформление и защита» для каждого файла
func (s *Server) runDecor(c context.Context, states []*FileState, req PDFReq) (ok, bad int) {
	if !req.Decor.any() {
		for i := range states {
			bad++
			msg := tr("pdf.decNothing")
			s.set(i, func(fs *FileState) { fs.Status = "error"; fs.Msg = msg; fs.Hint = msg })
		}
		return
	}
	used := map[string]bool{}
	for i, st := range states {
		if c.Err() != nil {
			break
		}
		s.set(i, func(fs *FileState) { fs.Status = "running" })
		dst := pdfOutPath(st.Path, req, used)
		repaired, err := pdfDecor(c, st.Path, dst, req.Password, req.Decor)
		if c.Err() != nil {
			os.Remove(dst)
			break
		}
		if err != nil {
			bad++
			msg := pdfErrText(err)
			if strings.Contains(err.Error(), "font") {
				msg = tr("pdf.decNoFont")
			}
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

// decorStamp: поставить штамп. Без конфигурационной папки pdfcpu ищет шрифты только в своей папке настроек;
// пустая Conf отправляет его в font.UserFontDir, куда мы поставили шрифт
func decorStamp(c context.Context, ctx *model.Context, pages types.IntSet, wm *model.Watermark) error {
	conf := ctx.XRefTable.Conf
	ctx.XRefTable.Conf = nil
	defer func() { ctx.XRefTable.Conf = conf }()
	return api.WatermarkContext(c, ctx, pages, wm)
}
