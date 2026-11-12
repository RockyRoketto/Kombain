// ---------- pdf.js в «PDF»: миниатюры, просмотр и «В картинки» ----------
// pdf.js (web/pdfjs, Apache 2.0) грузится только когда понадобился: отдаёт его pdf_raster.go.
// Страницы рисуются здесь на canvas, файлы пишет сервер (pdf-ras-begin → pdf-page-save → pdf-ras-end).
let pdfjsReady = null;
function pdfjsLoad() {
  if (!pdfjsReady) pdfjsReady = new Promise((ok, bad) => {
    const s = document.createElement('script');
    s.src = '/pdfjs/pdf.min.js';
    s.onload = () => {
      if (!window.pdfjsLib) { pdfjsReady = null; bad(new Error(t('pdf.rasNoLib'))); return; }
      pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.js';
      ok(pdfjsLib);
    };
    s.onerror = () => { pdfjsReady = null; s.remove(); bad(new Error(t('pdf.rasNoLib'))); };
    document.head.appendChild(s);
  });
  return pdfjsReady;
}
const pdfFileUrl = p => `/pdf?t=${TOKEN}&p=${encodeURIComponent(p)}`;
async function pdfDoc(path, password) {
  const lib = await pdfjsLoad();
  return lib.getDocument({url: pdfFileUrl(path), password: password || undefined, isEvalSupported: false}).promise;
}
// понятный текст ошибки pdf.js
function pdfJsErr(e) {
  const n = e && e.name;
  if (n === 'PasswordException') return t('pdf.jsPass');
  if (n === 'InvalidPDFException' || n === 'MissingPDFException' || n === 'UnexpectedResponseException') return t('pdf.jsBroken');
  return (e && e.message) || String(e);
}

// нарисовать страницу n с масштабом scale (1 = 72 dpi). Холст не больше, чем вытянет окно: 16 тыс. точек по стороне, 120 Мпикс всего
const PDF_MAX_SIDE = 16000, PDF_MAX_AREA = 120e6;
async function pdfDrawPage(doc, n, scale, transparent) {
  const page = await doc.getPage(n);
  try {
    let vp = page.getViewport({scale});
    const k = Math.min(1, PDF_MAX_SIDE / vp.width, PDF_MAX_SIDE / vp.height, Math.sqrt(PDF_MAX_AREA / (vp.width * vp.height)));
    if (k < 1) vp = page.getViewport({scale: scale * k});
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.floor(vp.width));
    cv.height = Math.max(1, Math.floor(vp.height));
    // intent print: рисует без привязки к кадрам экрана, поэтому не встаёт в свёрнутом окне; страница как при печати (с полями форм)
    await page.render({canvasContext: cv.getContext('2d', {alpha: !!transparent}), viewport: vp, intent: 'print', background: transparent ? 'rgba(0,0,0,0)' : '#fff'}).promise;
    return cv;
  } finally { page.cleanup(); }
}

// ---------- миниатюры первой страницы в списке ----------
const pdfThumbs = {};   // путь -> dataURL, 'wait' или 'fail'
let pdfThumbBusy = false;
// значок PDF в строке списка: миниатюра, если уже есть, иначе просто «pdf»; оба открывают просмотр
function pdfBadge(it) {
  const th = pdfThumbs[it.path], inf = it.info || {};
  const can = inf.pages && !inf.needPass && !inf.error;
  if (can && th && th !== 'wait' && th !== 'fail')
    return `<div class="badge th pdfth" data-pview="${esc(it.path)}" title="${t('pdf.view')}"><img src="${th}" alt="" draggable="false"><span class="ex">pdf</span></div>`;
  return `<div class="badge${can ? ' pdfv' : ''}" ${can ? `data-pview="${esc(it.path)}" title="${t('pdf.view')}"` : `data-popen="${esc(it.path)}" title="${t('pdf.openDefault')}"`}>pdf</div>`;
}
// дорисовать недостающие миниатюры по одной; во время прогона не мешаем
async function pdfThumbWatch() {
  if (pdfThumbBusy || snap.running || tab !== 'pdf') return;
  pdfThumbBusy = true;
  try {
    for (;;) {
      const it = pdfFiles.find(f => !f.img && f.info && f.info.pages && !f.info.needPass && !f.info.error && !pdfThumbs[f.path]);
      if (!it || snap.running || tab !== 'pdf') return;
      pdfThumbs[it.path] = 'wait';
      let doc = null;
      try {
        doc = await pdfDoc(it.path, $('pdfPass').value);
        const page = await doc.getPage(1), vp = page.getViewport({scale: 1});
        page.cleanup();
        const cv = await pdfDrawPage(doc, 1, 128 / vp.width, false);   // 128 точек шириной: чётко и на экране с масштабом
        pdfThumbs[it.path] = cv.toDataURL('image/jpeg', 0.82);
        cv.width = cv.height = 0;
      } catch (e) { pdfThumbs[it.path] = 'fail'; }
      finally { if (doc) doc.destroy(); }
      pdfLast = ''; pdfRender();
    }
  } finally { pdfThumbBusy = false; }
}

// ---------- просмотр PDF ----------
// В «Сжать» тот же просмотр сравнивает страницу до и после (pdf_compare.go пережимает одну страницу):
// «После» лежит поверх «До», шторка (--cut) открывает его справа. Лупа показывает место под курсором крупно,
// с обеих сторон шторки. Полоса под страницей — все страницы, страницы с картинками отмечены
const pdfPv = {doc: null, path: '', n: 1, gen: 0, it: null, marks: null, cmp: false, lens: false, cut: 0.5, z: 3, zMax: 4,
  scale: 1, docB: null, res: null, hiA: null, hiB: null, hiKey: '', lp: null};
const pdfPvCanCmp = it => pdfSet.op === 'compress' && !!(it && it.info && it.info.pages && !it.info.needPass && !it.info.error);
async function pdfView(it, cmp) {
  pdfPvClose();
  const g = ++pdfPv.gen;
  Object.assign(pdfPv, {path: it.path, it, n: 1, marks: null, cmp: !!cmp && pdfPvCanCmp(it), res: null});
  $('pdfPvName').textContent = it.name;
  $('pdfPvNum').textContent = '';
  const cv = $('pdfPvCv'); cv.width = cv.height = 0;
  $('pdfPvNote').classList.add('hide');
  $('pdfPvCmp').classList.toggle('hide', !pdfPvCanCmp(it));
  pdfPvMode();
  $('pdfPv').classList.remove('hide');
  $('pdfPvClose').focus();
  const pw = $('pdfPass').value;
  const marks = api('pdf-page-marks', {path: it.path, password: pw}).then(r => {
    if (g !== pdfPv.gen) return;
    pdfPv.marks = r.error || r.needPass ? null : {img: new Set(r.img || []), any: new Set(r.any || [])};
    pdfPvBar();
  });
  try {
    const doc = await pdfDoc(it.path, pw);
    if (g !== pdfPv.gen) { doc.destroy(); return; }
    pdfPv.doc = doc;
    // открыли сравнение — сразу к первой странице с картинками: на остальных сжатию нечего менять
    if (pdfPv.cmp) {
      await marks;
      if (g !== pdfPv.gen) return;
      const first = pdfPv.marks && Math.min(...pdfPv.marks.img);
      if (first && isFinite(first)) pdfPv.n = first;
    }
    pdfPvShow();
  } catch (e) {
    if (g !== pdfPv.gen) return;
    $('pdfPvNote').textContent = pdfJsErr(e);
    $('pdfPvNote').classList.remove('hide');
  }
}
let pdfPvTask = null;
async function pdfPvShow() {
  const doc = pdfPv.doc; if (!doc) return;
  const g = pdfPv.gen, n = pdfPv.n = Math.max(1, Math.min(doc.numPages, pdfPv.n));
  $('pdfPvNum').textContent = t('pdf.pvPage', {n, m: doc.numPages});
  $('pdfPvPrev').disabled = n <= 1; $('pdfPvNext').disabled = n >= doc.numPages;
  pdfPvBar();
  if (pdfPv.cmp && (!pdfPv.res || pdfPv.res.page !== n)) pdfPvDropB();   // прежняя страница «После» уже не про эту
  try {
    const page = await doc.getPage(n);
    if (g !== pdfPv.gen || n !== pdfPv.n) { page.cleanup(); return; }
    const st = $('pdfPvStage'), base = page.getViewport({scale: 1});
    const fit = Math.max(0.1, Math.min((st.clientWidth - 24) / base.width, (st.clientHeight - 24) / base.height) || 1);   // окно ещё не разложено — хоть что-то
    const dpr = window.devicePixelRatio || 1, vp = page.getViewport({scale: fit * dpr});
    if (pdfPvTask) { pdfPvTask.cancel(); pdfPvTask = null; }
    const cv = document.createElement('canvas');
    cv.width = Math.floor(vp.width); cv.height = Math.floor(vp.height);
    const task = pdfPvTask = page.render({canvasContext: cv.getContext('2d', {alpha: false}), viewport: vp, intent: 'print'});
    await task.promise;
    if (pdfPvTask === task) pdfPvTask = null;
    page.cleanup();
    if (g !== pdfPv.gen || n !== pdfPv.n) return;
    // готовый кадр подменяет прежний сразу, без мигания пустым холстом
    pdfPv.scale = fit * dpr;
    const css = [Math.floor(vp.width / dpr) + 'px', Math.floor(vp.height / dpr) + 'px'];
    pdfPvPut($('pdfPvCv'), cv, css);
    if (!$('pdfPvB').classList.contains('hide')) { $('pdfPvB').style.width = css[0]; $('pdfPvB').style.height = css[1]; }
    pdfPvHi();
    if (pdfPv.cmp) pdfPvCmpLoad(g, n);
  } catch (e) {
    if (e && e.name === 'RenderingCancelledException') return;
    $('pdfPvNote').textContent = pdfJsErr(e);
    $('pdfPvNote').classList.remove('hide');
  }
}
// перенести готовый холст cv в видимый out с размером css
function pdfPvPut(out, cv, css) {
  out.width = cv.width; out.height = cv.height;
  out.style.width = css[0]; out.style.height = css[1];
  out.getContext('2d').drawImage(cv, 0, 0);
  cv.width = cv.height = 0;
}

// ---------- сравнение до/после ----------
// страница «После» с сервера: PDF в одну страницу, целиком в память (сервер держит только последнюю)
async function pdfPvCmpLoad(g, n) {
  const info = $('pdfPvInfo');
  const stale = () => g !== pdfPv.gen || n !== pdfPv.n || !pdfPv.cmp;
  try {
    if (!pdfPv.docB || !pdfPv.res || pdfPv.res.page !== n) {
      pdfPvDropB();
      info.textContent = t('pdf.cmpWait');
      const e = pdfEst[pdfEstKey(pdfPv.path)] || {};   // «До размера»: ступень уже подобрал прогноз
      const r = await api('pdf-compare', {path: pdfPv.path, password: $('pdfPass').value, comp: pdfSet.comp, page: n, q: e.quality || 0, dpi: e.dpi || 0});
      if (stale() || r.error === 'canceled') return;
      if (r.error || r.needPass || !r.id) { info.textContent = r.needPass ? t('pdf.jsPass') : r.error || t('net.err'); return; }
      const buf = await (await fetch(`/pdf?t=${TOKEN}&c=${encodeURIComponent(r.id)}`)).arrayBuffer();
      if (stale()) return;
      const doc = await (await pdfjsLoad()).getDocument({data: new Uint8Array(buf), isEvalSupported: false}).promise;
      if (stale()) { doc.destroy(); return; }
      if (pdfPv.docB) pdfPv.docB.destroy();
      pdfPv.docB = doc; pdfPv.res = r;
    }
    info.textContent = pdfPvInfoText(pdfPv.res);
    const cv = await pdfDrawPage(pdfPv.docB, 1, pdfPv.scale, false);
    if (stale()) { cv.width = cv.height = 0; return; }
    const a = $('pdfPvCv');
    pdfPvPut($('pdfPvB'), cv, [a.style.width, a.style.height]);
    pdfPvMode();
    pdfPvHi();
  } catch (e) {
    if (!stale()) info.textContent = pdfJsErr(e);
  }
}
function pdfPvInfoText(r) {
  if (!r.images) return t('pdf.cmpNoImg');
  if (!r.recoded) return t('pdf.cmpSame', {n: r.images});
  let s = t('pdf.cmpInfo', {n: r.recoded, m: r.images, a: fmtSize(r.before), b: fmtSize(r.after)}) + pdfPct(r.before, r.after);
  if (pdfSet.comp.preset === 'target' && r.quality) s += ` · JPEG ${r.quality}, ${r.dpi} dpi`;
  const e = pdfEst[pdfEstKey(pdfPv.path)];
  if (e && e.kept) s += ' · ' + t('pdf.cmpKept');
  return s;
}
// убрать страницу «После»
function pdfPvDropB() {
  if (pdfPv.docB) { pdfPv.docB.destroy(); pdfPv.docB = null; }
  pdfPv.res = null;
  const b = $('pdfPvB'); b.width = b.height = 0;
  if (pdfPv.hiB) { pdfPv.hiB.width = pdfPv.hiB.height = 0; pdfPv.hiB = null; pdfPv.hiKey = ''; }
  pdfPvMode();
}
// видимость шторки, подписей и кнопок по состоянию
function pdfPvMode() {
  const ready = pdfPv.cmp && !!pdfPv.docB;
  $('pdfPvStage').classList.toggle('cmp', pdfPv.cmp);
  $('pdfPvStage').classList.toggle('lens', pdfPv.lens);
  for (const el of [$('pdfPvB'), $('pdfPvCut'), ...document.querySelectorAll('#pdfPvBox .pdf-lbl')]) el.classList.toggle('hide', !ready);
  $('pdfPvInfo').classList.toggle('hide', !pdfPv.cmp);
  $('pdfPvCmp').classList.toggle('on', pdfPv.cmp);
  $('pdfPvLensB').classList.toggle('on', pdfPv.lens);
  $('pdfPvBox').style.setProperty('--cut', pdfPv.cut * 100 + '%');
  pdfPvLensDraw();
}
$('pdfPvCmp').onclick = () => {
  pdfPv.cmp = !pdfPv.cmp && pdfPvCanCmp(pdfPv.it);
  if (!pdfPv.cmp) { pdfPvDropB(); api('pdf-compare', {drop: true}); }
  pdfPvMode();
  if (pdfPv.cmp && pdfPv.doc) pdfPvCmpLoad(pdfPv.gen, pdfPv.n);
};

// шторка: тянуть в любом месте страницы
let pdfPvDrag = false;
function pdfPvCutAt(e) {
  const r = $('pdfPvCv').getBoundingClientRect();
  if (!r.width) return;
  pdfPv.cut = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  pdfPvMode();
}
const pdfPvSt = $('pdfPvStage');
pdfPvSt.addEventListener('pointerdown', e => {
  if (!pdfPv.cmp || e.button !== 0) return;
  pdfPvSt.setPointerCapture(e.pointerId);
  pdfPvDrag = true;
  pdfPvCutAt(e);
  e.preventDefault();
});
pdfPvSt.addEventListener('pointermove', e => {
  pdfPv.lp = {x: e.clientX, y: e.clientY};
  if (pdfPvDrag) pdfPvCutAt(e); else if (pdfPv.lens) pdfPvLensDraw();
});
for (const ev of ['pointerup', 'pointercancel']) pdfPvSt.addEventListener(ev, () => { pdfPvDrag = false; });
pdfPvSt.addEventListener('pointerleave', () => { if (!pdfPvDrag) { pdfPv.lp = null; pdfPvLensDraw(); } });

// ---------- лупа ----------
// Страницы для лупы рисуются крупнее экрана (до 4 раз, не больше 48 Мпикс), пока рисуются — лупа берёт экранные
$('pdfPvLensB').onclick = () => { pdfPv.lens = !pdfPv.lens; pdfPvMode(); pdfPvHi(); };
async function pdfPvHi() {
  if (!pdfPv.lens || !pdfPv.doc) return;
  const a = $('pdfPvCv');
  if (!a.width) return;
  const f = Math.max(1, Math.min(4, Math.sqrt(48e6 / (a.width * a.height))));
  pdfPv.zMax = Math.max(2, Math.min(6, f * (window.devicePixelRatio || 1)));
  pdfPv.z = Math.min(pdfPv.z, pdfPv.zMax);
  const key = [pdfPv.gen, pdfPv.n, pdfPv.scale, pdfPv.res ? pdfPv.res.id : ''].join('|');
  if (key === pdfPv.hiKey) return;
  pdfPv.hiKey = key;
  for (const k of ['hiA', 'hiB']) if (pdfPv[k]) { pdfPv[k].width = pdfPv[k].height = 0; pdfPv[k] = null; }
  const g = pdfPv.gen, n = pdfPv.n, docB = pdfPv.docB;
  try {
    const hiA = await pdfDrawPage(pdfPv.doc, n, pdfPv.scale * f, false);
    if (key !== pdfPv.hiKey) { hiA.width = hiA.height = 0; return; }
    pdfPv.hiA = hiA;
    pdfPvLensDraw();
    if (docB && pdfPv.cmp) {
      const hiB = await pdfDrawPage(docB, 1, pdfPv.scale * f, false);
      if (key !== pdfPv.hiKey || g !== pdfPv.gen) { hiB.width = hiB.height = 0; return; }
      pdfPv.hiB = hiB;
      pdfPvLensDraw();
    }
  // не вышло — лупа останется с экранными страницами
  } catch (e) {}
}
function pdfPvLensDraw() {
  const L = $('pdfPvLens'), a = $('pdfPvCv');
  const ra = a.getBoundingClientRect(), lp = pdfPv.lp;
  const u = lp && (lp.x - ra.left) / ra.width, v = lp && (lp.y - ra.top) / ra.height;
  if (!pdfPv.lens || !lp || !a.width || !(u >= 0 && u <= 1 && v >= 0 && v <= 1)) { L.classList.add('hide'); return; }
  const rs = pdfPvSt.getBoundingClientRect(), S = 240, dpr = window.devicePixelRatio || 1, D = Math.round(S * dpr);
  if (L.width !== D) L.width = L.height = D;
  L.style.left = (lp.x - rs.left - S / 2) + 'px';
  L.style.top = (lp.y - rs.top - S / 2) + 'px';
  L.classList.remove('hide');
  const c = L.getContext('2d');
  c.fillStyle = getComputedStyle(pdfPvSt).backgroundColor;
  c.fillRect(0, 0, D, D);
  // кусок исходника вокруг точки (u, v): S / z экранных точек, в точках самого исходника
  const part = (src, x0, x1) => {
    const sw = S / pdfPv.z * src.width / ra.width, sh = sw * (src.height / src.width) / (ra.height / ra.width);
    const sx = u * src.width - sw / 2, sy = v * src.height - sh / 2;
    c.save();
    c.beginPath(); c.rect(x0, 0, x1 - x0, D); c.clip();
    // за краем страницы исходник обрезаем сами: drawImage с выходом за край рисует не везде одинаково
    const cx = Math.max(0, sx), cy = Math.max(0, sy), cw = Math.min(src.width, sx + sw) - cx, ch = Math.min(src.height, sy + sh) - cy;
    if (cw > 0 && ch > 0) c.drawImage(src, cx, cy, cw, ch, (cx - sx) / sw * D, (cy - sy) / sh * D, cw / sw * D, ch / sh * D);
    c.restore();
  };
  const A = pdfPv.hiA || a, B = pdfPv.cmp && pdfPv.docB ? pdfPv.hiB || $('pdfPvB') : null;
  if (!B) { part(A, 0, D); return; }
  const cutX = Math.min(D, Math.max(0, D / 2 + (pdfPv.cut - u) * ra.width * pdfPv.z * dpr));
  part(A, 0, cutX);
  part(B, cutX, D);
  c.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--acc').trim() || '#e9b872';
  c.fillRect(cutX - dpr, 0, 2 * dpr, D);
}

// ---------- полоса страниц ----------
function pdfPvBar() {
  const w = $('pdfPvBarW'), cv = $('pdfPvBar'), N = pdfPv.doc ? pdfPv.doc.numPages : 0, mk = pdfPv.marks;
  $('pdfPvImgNext').classList.toggle('hide', !mk || N < 2);
  $('pdfPvImgNext').disabled = !mk || !mk.img.size;
  w.classList.toggle('hide', N < 2);
  if (N < 2) return;
  const cmpOp = pdfSet.op === 'compress';
  $('pdfPvBarK').innerHTML = !mk ? '' : cmpOp && mk.any.size > mk.img.size
    ? `<i></i>${t('pdf.barImg')}<i class="any"></i>${t('pdf.barAny')}` : mk.any.size ? `<i></i>${t('pdf.barPics')}` : t('pdf.barNone');
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = 14;
  if (!W) return;
  cv.width = Math.round(W * dpr); cv.height = H * dpr;
  const c = cv.getContext('2d'), cs = getComputedStyle(document.documentElement), col = k => cs.getPropertyValue(k).trim();
  c.scale(dpr, dpr);
  const acc = col('--acc-rgb'), step = W / N, gap = step > 5 ? 1 : 0;
  for (let p = 1; p <= N; p++) {
    const img = mk && (cmpOp ? mk.img.has(p) : mk.any.has(p)), any = mk && mk.any.has(p);
    c.fillStyle = img ? `rgb(${acc})` : any ? `rgba(${acc},.35)` : col('--s4');
    c.fillRect((p - 1) * step, 3, Math.max(1, step - gap), H - 6);
  }
  const x = (pdfPv.n - 1) * step, cw = Math.max(3, step - gap);
  c.fillStyle = col('--tx');
  c.fillRect(x + (step - gap - cw) / 2, 0, cw, H);
}
const pdfPvBarPage = e => {
  const r = $('pdfPvBar').getBoundingClientRect(), N = pdfPv.doc ? pdfPv.doc.numPages : 0;
  return N ? Math.min(N, Math.max(1, Math.floor((e.clientX - r.left) / r.width * N) + 1)) : 0;
};
$('pdfPvBar').addEventListener('click', e => { const p = pdfPvBarPage(e); if (p) { pdfPv.n = p; pdfPvShow(); } });
$('pdfPvBar').addEventListener('mousemove', e => {
  const p = pdfPvBarPage(e), mk = pdfPv.marks;
  e.target.title = !p ? '' : t('pdf.pvPage', {n: p, m: pdfPv.doc.numPages}) + (mk && mk.any.has(p) ? ' · ' + t(pdfSet.op === 'compress' && !mk.img.has(p) ? 'pdf.barAny' : 'pdf.barPics') : '');
});
// к следующей (d = -1 — к предыдущей) странице с картинками, по кругу
function pdfPvGoImg(d) {
  const mk = pdfPv.marks; if (!mk || !pdfPv.doc) return;
  const list = [...(pdfSet.op === 'compress' ? mk.img : mk.any)].sort((a, b) => a - b);
  if (!list.length) return;
  const n = pdfPv.n;
  pdfPv.n = d > 0 ? list.find(p => p > n) ?? list[0] : list.findLast(p => p < n) ?? list[list.length - 1];
  pdfPvShow();
}
$('pdfPvImgNext').onclick = () => pdfPvGoImg(1);

function pdfPvGo(d) { if (pdfPv.doc) { pdfPv.n += d; pdfPvShow(); } }
function pdfPvClose() {
  pdfPv.gen++;
  if (pdfPvTask) { pdfPvTask.cancel(); pdfPvTask = null; }
  if (pdfPv.doc) { pdfPv.doc.destroy(); pdfPv.doc = null; }
  if (pdfPv.docB || pdfPv.cmp) api('pdf-compare', {drop: true});
  pdfPvDropB();
  for (const k of ['hiA', 'hiB']) if (pdfPv[k]) { pdfPv[k].width = pdfPv[k].height = 0; pdfPv[k] = null; }
  pdfPv.hiKey = ''; pdfPv.lp = null; pdfPv.marks = null;
  $('pdfPvLens').classList.add('hide');
  $('pdfPv').classList.add('hide');
}
$('pdfPvClose').onclick = pdfPvClose;
$('pdfPv').addEventListener('click', e => { if (e.target === $('pdfPv')) pdfPvClose(); });
$('pdfPvPrev').onclick = () => pdfPvGo(-1);
$('pdfPvNext').onclick = () => pdfPvGo(1);
$('pdfPvOpen').onclick = async () => { const r = await api('open-file', {path: pdfPv.path}); if (r.error) say('warn', t('pdf.openDefault'), r.error); };
// колесо листает страницы; с лупой над страницей — меняет её увеличение
pdfPvSt.addEventListener('wheel', e => {
  if (e.ctrlKey || Math.abs(e.deltaY) <= 4) return;
  e.preventDefault();
  if (pdfPv.lens && !$('pdfPvLens').classList.contains('hide')) {
    pdfPv.z = Math.min(pdfPv.zMax, Math.max(1.5, pdfPv.z * (e.deltaY < 0 ? 1.25 : 0.8)));
    pdfPvLensDraw();
  } else pdfPvGo(e.deltaY > 0 ? 1 : -1);
}, {passive: false});
document.addEventListener('keydown', e => {
  if ($('pdfPv').classList.contains('hide')) return;
  const k = e.key;
  if (k === 'Escape') pdfPvClose();
  else if (e.shiftKey && (k === 'ArrowLeft' || k === 'ArrowRight')) pdfPvGoImg(k === 'ArrowRight' ? 1 : -1);
  else if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp') pdfPvGo(-1);
  else if (k === 'ArrowRight' || k === 'ArrowDown' || k === 'PageDown' || (k === ' ' && !e.target.closest('button'))) pdfPvGo(1);
  else if (k === 'Home' && pdfPv.doc) { pdfPv.n = 1; pdfPvShow(); }
  else if (k === 'End' && pdfPv.doc) { pdfPv.n = pdfPv.doc.numPages; pdfPvShow(); }
  else return;
  e.preventDefault();
});
let pdfPvResize = 0;
window.addEventListener('resize', () => { clearTimeout(pdfPvResize); if (pdfPv.doc) pdfPvResize = setTimeout(pdfPvShow, 150); });

// ---------- «В картинки» ----------
// «1-3, 5, 8-» → номера страниц по порядку без повторов; null — не разобрать. total — сколько страниц в файле
function pdfRange(s, total) {
  const out = new Set();
  const parts = String(s || '').split(/[,;\s]+/).filter(Boolean);
  if (!parts.length) return null;
  for (const p of parts) {
    const m = /^(\d*)\s*[-–—]\s*(\d*)$/.exec(p) || /^(\d+)()$/.exec(p);
    if (!m || (m[1] === '' && m[2] === '')) return null;
    const single = !/[-–—]/.test(p);
    let a = m[1] === '' ? 1 : +m[1], b = single ? a : m[2] === '' ? total : +m[2];
    if (!a || (!single && m[2] !== '' && !b)) return null;
    if (a > b) [a, b] = [b, a];
    for (let i = Math.max(1, a); i <= Math.min(total, b); i++) out.add(i);
  }
  return [...out].sort((x, y) => x - y);
}
const pdfRangeOk = s => pdfRange(s, 1e6) !== null;

// пройти файлы прогона: окно рисует, сервер пишет. Прогон уже начат (pdf-run с op "raster")
async function pdfRasRun(files, o, pw) {
  const mime = {jpg: 'image/jpeg', webp: 'image/webp'}[o.fmt] || 'image/png';
  const transp = o.fmt !== 'jpg' && !!o.transparent;
  for (let i = 0; i < files.length; i++) {
    const b = await api('pdf-ras-begin', {i});
    if (b.canceled) return;
    let err = b.error || '', count = 0, doc = null;
    if (!err) try {
      doc = await pdfDoc(files[i].path, pw);
      const pages = o.pages === 'range' ? pdfRange(o.range, doc.numPages) || [] : [...Array(doc.numPages)].map((_, k) => k + 1);
      if (!pages.length) throw new Error(t('pdf.rasNone'));
      const digits = Math.max(2, String(doc.numPages).length), stem = files[i].name.replace(/\.[^.]+$/, '');
      for (const n of pages) {
        const cv = await pdfDrawPage(doc, n, (o.dpi || 150) / 72, transp);
        const blob = await new Promise(ok => cv.toBlob(ok, mime, (o.q || 92) / 100));
        cv.width = cv.height = 0;
        if (!blob) throw new Error(t('pdf.rasTooBig'));
        const name = `${stem}-${String(n).padStart(digits, '0')}.${o.fmt === 'jpg' ? 'jpg' : o.fmt === 'webp' ? 'webp' : 'png'}`;
        let r;
        try {
          r = await (await fetch(`/api/pdf-page-save?i=${i}&n=${count + 1}&of=${pages.length}&name=${encodeURIComponent(name)}`,
            {method: 'POST', headers: {'X-Token': TOKEN}, body: blob})).json();
        } catch (e) { r = {error: t('net.err')}; }
        if (r.canceled) return;
        if (r.error) throw new Error(r.error);
        count++;
        if (count === 1 || count % 4 === 0) pollSoon();
      }
    } catch (e) { err = pdfJsErr(e); }
    finally { if (doc) doc.destroy(); }
    const r = await api('pdf-ras-end', {i, error: err, pages: count});
    if (r.canceled) return;
    pollSoon();
  }
}
