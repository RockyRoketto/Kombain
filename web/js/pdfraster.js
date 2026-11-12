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
const pdfPv = {doc: null, path: '', n: 1, gen: 0};
async function pdfView(it) {
  pdfPvClose();
  const g = ++pdfPv.gen;
  pdfPv.path = it.path; pdfPv.n = 1;
  $('pdfPvName').textContent = it.name;
  $('pdfPvNum').textContent = '';
  const cv = $('pdfPvCv'); cv.width = cv.height = 0;
  $('pdfPvNote').classList.add('hide');
  $('pdfPv').classList.remove('hide');
  $('pdfPvClose').focus();
  try {
    const doc = await pdfDoc(it.path, $('pdfPass').value);
    if (g !== pdfPv.gen) { doc.destroy(); return; }
    pdfPv.doc = doc;
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
    const out = $('pdfPvCv');
    out.width = cv.width; out.height = cv.height;
    out.style.width = Math.floor(vp.width / dpr) + 'px'; out.style.height = Math.floor(vp.height / dpr) + 'px';
    out.getContext('2d').drawImage(cv, 0, 0);
    cv.width = cv.height = 0;
  } catch (e) {
    if (e && e.name === 'RenderingCancelledException') return;
    $('pdfPvNote').textContent = pdfJsErr(e);
    $('pdfPvNote').classList.remove('hide');
  }
}
function pdfPvGo(d) { if (pdfPv.doc) { pdfPv.n += d; pdfPvShow(); } }
function pdfPvClose() {
  pdfPv.gen++;
  if (pdfPvTask) { pdfPvTask.cancel(); pdfPvTask = null; }
  if (pdfPv.doc) { pdfPv.doc.destroy(); pdfPv.doc = null; }
  $('pdfPv').classList.add('hide');
}
$('pdfPvClose').onclick = pdfPvClose;
$('pdfPv').addEventListener('click', e => { if (e.target === $('pdfPv')) pdfPvClose(); });
$('pdfPvPrev').onclick = () => pdfPvGo(-1);
$('pdfPvNext').onclick = () => pdfPvGo(1);
$('pdfPvOpen').onclick = async () => { const r = await api('open-file', {path: pdfPv.path}); if (r.error) say('warn', t('pdf.openDefault'), r.error); };
$('pdfPvStage').addEventListener('wheel', e => { if (!e.ctrlKey && Math.abs(e.deltaY) > 4) { e.preventDefault(); pdfPvGo(e.deltaY > 0 ? 1 : -1); } }, {passive: false});
document.addEventListener('keydown', e => {
  if ($('pdfPv').classList.contains('hide')) return;
  const k = e.key;
  if (k === 'Escape') pdfPvClose();
  else if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp') pdfPvGo(-1);
  else if (k === 'ArrowRight' || k === 'ArrowDown' || k === 'PageDown' || k === ' ') pdfPvGo(1);
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
