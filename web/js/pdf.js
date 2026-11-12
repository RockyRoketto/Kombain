// ---------- «PDF» во вкладке «Утилиты» ----------
// Файлы, действие, пароль, куда сохранять. Работу делает pdf.go (pdfcpu) и pdf_images.go («Картинки → PDF»),
// прогон идёт через общий опрос, как у «Баннеров».
let pdfFiles = [];        // {name, dir, path, size, img, info}; info — ответ /api/pdf-info (страницы, нужен ли пароль, ошибка)
const pdfRes = {};        // путь -> состояние с сервера (последний прогон PDF)
const pdfSet = {mode: 'same', dir: '', op: 'compress', ras: {fmt: 'png', dpi: 150, q: 92, pages: 'all', range: '', transparent: false}, fix: {version: '', strip: false}, img: {page: 'a4', orient: 'auto', margin: 5, quality: 'high', separate: false, pageW: 210, pageH: 297},
  comp: {preset: 'medium', quality: 70, dpi: 150, color: '', strip: true, target: 10}, pg: {mode: 'one', every: 2, ranges: ''}};   // сохраняется в localStorage
let pdfLast = '';
try {
  const saved = JSON.parse(localStorage.getItem('konv9000.pdf') || '{}');
  Object.assign(pdfSet.img, saved.img || {}); delete saved.img;
  Object.assign(pdfSet.comp, saved.comp || {}); delete saved.comp;
  Object.assign(pdfSet.ras, saved.ras || {}); delete saved.ras;
  Object.assign(pdfSet.fix, saved.fix || {}); delete saved.fix;
  Object.assign(pdfSet.pg, saved.pg || {}); delete saved.pg;
  Object.assign(pdfSet, saved);
} catch (e) {}
if (pdfSet.mode !== 'folder') pdfSet.mode = 'same';
if (!['img2pdf', 'resave', 'compress', 'raster', 'pages'].includes(pdfSet.op)) pdfSet.op = 'compress';
function pdfSave() { try { localStorage.setItem('konv9000.pdf', JSON.stringify(pdfSet)); } catch (e) {} }

const PDF_IMG = /\.(jpe?g|png|webp)$/i;
// файлы, с которыми работает выбранное действие
const pdfFor = op => pdfFiles.filter(f => op === 'img2pdf' ? f.img : !f.img);

function pdfAdd(list) {
  const have = new Set(pdfFiles.map(f => f.path.toLowerCase()));
  let added = 0, imgs = 0;
  // новые — по имени, как в Проводнике: «фото 2» раньше «фото 10»
  const coll = new Intl.Collator(undefined, {numeric: true, sensitivity: 'base'});
  for (const f of [...(list || [])].sort((a, b) => coll.compare(a.path, b.path))) {
    const img = PDF_IMG.test(f.path);
    if ((!img && !/\.pdf$/i.test(f.path)) || have.has(f.path.toLowerCase())) continue;
    pdfFiles.push({name: base(f.path), dir: dirOf(f.path), path: f.path, size: f.size, img, info: img ? {} : null});
    have.add(f.path.toLowerCase());
    added++;
    if (img) imgs++;
  }
  if (list && list.length && !added && !pdfFiles.length) say('warn', t('drop.notSuitableTitle'), t('pdf.noneFound'));
  // добавили только картинки и их нечем пересобрать — сразу «Картинки → PDF», и наоборот
  if (added && !snap.running) {
    if (imgs === added && pdfSet.op !== 'img2pdf' && !pdfFor('resave').length) { pdfSet.op = 'img2pdf'; pdfSave(); }
    else if (!imgs && pdfSet.op === 'img2pdf' && !pdfFor('img2pdf').length) { pdfSet.op = 'compress'; pdfSave(); }
  }
  pdfRender();
  pdfCheck();
}
// перетащенные пути (папки разворачивает pdf.go)
async function pdfAddPaths(paths) {
  if (snap.running || !paths || !paths.length) return;
  const r = await api('pdf-list', {paths});
  if (!(r.files || []).length) { say('warn', t('drop.notSuitableTitle'), t('pdf.noneFound')); return; }
  pdfAdd(r.files);
}
// прочитать страницы и пароль; all — заново у закрытых (пароль поменялся)
let pdfChecking = false;
async function pdfCheck(all) {
  if (all) pdfFiles.forEach(f => { if (f.info && f.info.needPass) f.info = null; });
  if (pdfChecking) return;
  pdfChecking = true;
  try {
    for (let it; (it = pdfFiles.find(f => !f.info));) {
      it.info = {wait: true};
      const r = await api('pdf-info', {path: it.path, password: $('pdfPass').value});
      if (pdfFiles.includes(it) && it.info.wait) it.info = r;
      pdfRender();
    }
  } finally { pdfChecking = false; }
}

function pdfAccOpen(id, on) {
  $(id).classList.toggle('open', on);
  $(id).querySelector('.acc-h').setAttribute('aria-expanded', String(on));
}
function pdfChips(id, v) { document.querySelectorAll(`#${id} .chip`).forEach(b => b.classList.toggle('on', b.dataset.v === String(v))); }

function pdfRender() {
  const labels = {pending:t('status.pending'), running:'<span class="spin"></span>', ok:t('status.ok'), error:t('status.error'), kept:t('status.kept'), canceled:t('status.canceled')};
  const op = pdfSet.op, im = pdfSet.img, imgOp = op === 'img2pdf', cp = pdfSet.comp;
  document.querySelectorAll('#pdfOp .chip').forEach(b => b.classList.toggle('on', b.dataset.op === op));
  const opKey = {img2pdf: 'pdf.opImg', resave: 'pdf.opResave', compress: 'pdf.opComp', raster: 'pdf.opRas', pages: 'pdf.opPg'}[op];
  $('pdfOpSum').textContent = t(opKey);
  $('pdfOpNote').textContent = t(opKey + 'Sub');
  // разделы других действий прячутся; если открытый спрятался — открыть первый раздел этого
  const show = {img2pdf: ['pdfImgCard'], resave: ['pdfFixCard', 'pdfPassCard'], compress: ['pdfCompCard', 'pdfPassCard'], raster: ['pdfRasCard', 'pdfPassCard'], pages: ['pdfPgCard', 'pdfPassCard']}[op];
  for (const id of ['pdfImgCard', 'pdfCompCard', 'pdfRasCard', 'pdfPgCard', 'pdfFixCard', 'pdfPassCard']) {
    if (show.includes(id)) continue;
    if ($(id).classList.contains('open')) { pdfAccOpen(id, false); pdfAccOpen(show[0], true); }
    $(id).classList.add('hide');
  }
  show.forEach(id => $(id).classList.remove('hide'));
  // в картинки и пересборка
  const rs = pdfSet.ras, fx = pdfSet.fix;
  pdfChips('pdfRasFmt', rs.fmt); pdfChips('pdfRasDpi', rs.dpi); pdfChips('pdfRasQ', rs.q); pdfChips('pdfRasPages', rs.pages);
  $('pdfRasQRow').classList.toggle('hide', rs.fmt === 'png');
  $('pdfRasTranspRow').classList.toggle('hide', rs.fmt === 'jpg');
  $('pdfRasTransp').checked = !!rs.transparent;
  $('pdfRasRangeRow').classList.toggle('hide', rs.pages !== 'range');
  if (document.activeElement !== $('pdfRasRange')) $('pdfRasRange').value = rs.range;
  $('pdfRasRange').classList.toggle('bad', rs.pages === 'range' && !!rs.range.trim() && !pdfRangeOk(rs.range));
  pdfChips('pdfFixVer', fx.version);
  $('pdfFixStrip').checked = !!fx.strip;
  // сжатие
  pdfChips('pdfCompPreset', cp.preset); pdfChips('pdfCompDpi', cp.dpi); pdfChips('pdfCompColor', cp.color);
  const custom = cp.preset === 'custom';
  $('pdfCompCustom').classList.toggle('hide', !custom);
  $('pdfCompTarget').classList.toggle('hide', cp.preset !== 'target');
  pdfChips('pdfCompTgt', cp.target);
  if (document.activeElement !== $('pdfCompTgtV')) $('pdfCompTgtV').value = cp.target;
  $('pdfCompNote').textContent = t({strong: 'pdf.cNote_strong', light: 'pdf.cNote_light', custom: 'pdf.cNote_custom', target: 'pdf.cNote_target'}[cp.preset] || 'pdf.cNote_medium');
  if (document.activeElement !== $('pdfCompQ')) $('pdfCompQ').value = cp.quality;
  $('pdfCompQV').textContent = cp.quality;
  $('pdfCompStrip').checked = !!cp.strip;
  pdfChips('pdfImgPage', im.page); pdfChips('pdfImgOrient', im.orient); pdfChips('pdfImgMargin', im.margin); pdfChips('pdfImgQuality', im.quality);
  $('pdfImgOrientRow').classList.toggle('hide', im.page === 'fit');
  $('pdfImgSize').classList.toggle('hide', im.page !== 'custom');
  for (const [id, k] of [['pdfImgW', 'pageW'], ['pdfImgH', 'pageH']]) if (document.activeElement !== $(id)) $(id).value = im[k];
  $('pdfImgQNote').textContent = t({orig: 'pdf.qNote_orig', mid: 'pdf.qNote_mid', low: 'pdf.qNote_low'}[im.quality] || 'pdf.qNote_high');
  $('pdfImgSep').checked = !!im.separate;
  // сводки в заголовках разделов: подписи выбранных чипов
  const chip = id => document.querySelector(`#${id} .chip.on`)?.textContent || '';
  $('pdfImgSum').textContent = [im.page === 'custom' ? `${im.pageW}×${im.pageH} ${t('pdf.mm')}` : chip('pdfImgPage'),im.page === 'fit' ? '' : chip('pdfImgOrient'), chip('pdfImgMargin'), chip('pdfImgQuality'),
    im.separate ? t('pdf.sepShort') : ''].filter(Boolean).join(' · ');
  $('pdfCompSum').textContent = [custom ? `JPEG ${cp.quality} · ${cp.dpi ? cp.dpi + ' dpi' : chip('pdfCompDpi')}` : cp.preset === 'target' ? t('pdf.tgtSum', {n: pdfNum(cp.target)}) : chip('pdfCompPreset'),
    cp.color ? chip('pdfCompColor') : ''].filter(Boolean).join(' · ');
  $('pdfRasSum').textContent = [chip('pdfRasFmt'), rs.dpi + ' dpi', rs.pages === 'range' && rs.range.trim() ? rs.range.trim() : chip('pdfRasPages')].join(' · ');
  $('pdfFixSum').textContent = chip('pdfFixVer');
  $('pdfPassSum').textContent = t($('pdfPass').value ? 'pdf.passSet' : 'pdf.passNone');
  document.querySelectorAll('#pdfOutMode .segb').forEach(b => b.classList.toggle('on', b.dataset.m === pdfSet.mode));
  $('pdfFolderRow').classList.toggle('hide', pdfSet.mode !== 'folder');
  if ($('pdfOutDir').value !== pdfSet.dir && document.activeElement !== $('pdfOutDir')) $('pdfOutDir').value = pdfSet.dir;
  const outName = base(pdfSet.dir.replace(/[\\/]+$/, '')) || pdfSet.dir;
  $('pdfOutSum').textContent = pdfSet.mode === 'same' ? t('out.same') : pdfSet.dir ? t('out.sumFolder', {name: outName}) : t('out.noFolder');
  $('pdfOutSum').title = pdfSet.mode === 'folder' ? pdfSet.dir : '';
  pdfPgSync();
  pdfPgPanel();
  // Ð¿Ð¾ÑÑÐ´Ð¾Ðº ÑÐ°Ð¹Ð»Ð¾Ð² Ð·Ð°Ð´Ð°ÑÑ ÑÐ¿Ð¸ÑÐ¾Ðº, Ð¿Ð¾ÐºÐ° ÑÑÑÐ°Ð½Ð¸ÑÑ Ð² ÑÐµÑÐºÐµ Ð½Ðµ Ð¿ÑÐ°Ð²Ð¸Ð»Ð¸ Ð²ÑÑÑÐ½ÑÑ (Ð¿Ð¾ÑÐ¾Ð¼ Ð¿Ð¾ÑÑÐ´Ð¾Ðº Ð¶Ð¸Ð²ÑÑ Ð² ÑÐµÑÐºÐµ)
  const drag = (imgOp || (op === 'pages' && !pdfPg.dirty)) && !snap.running;
  $('pdfSortName').classList.toggle('hide', !drag || pdfFor('img2pdf').length < 2);
  let page = 0;
  const list = pdfFiles.map(it => {
    const s = pdfResOf(it.path), inf = it.info || {}, off = imgOp !== it.img;
    let cls = '', status = '', sub = esc(it.dir) + ' · ' + fmtSize(it.size);
    if (inf.pages) sub += ' · ' + t('pdf.pages', {n: inf.pages});
    if (inf.needPass) sub = `<span class="tag big">${t('pdf.tagPass')}</span>` + sub;
    else if (inf.encrypted) sub += `<span class="tag">${t('pdf.tagLocked')}</span>`;
    if (inf.error) sub = `<span class="tag big">${t('pdf.tagBroken')}</span>` + esc(inf.error);
    if (off) { cls = 'off'; sub = `<span class="tag">${t(it.img ? 'pdf.offImg' : 'pdf.offPdf')}</span>` + sub; }
    else if (imgOp && !im.separate) sub = `<span class="tag">${t('pdf.pageN', {n: ++page})}</span>` + sub;
    else if (op === 'compress' && !s) sub = pdfEstTag(it) + (pdfPvCanCmp(it) ? `<button class="tag" data-pcmp="${esc(it.path)}" title="${esc(t('pdf.cmpTip'))}">${t('pdf.cmp')}</button>` : '') + sub;
    if (s) {
      cls = s.status; status = labels[s.status] || '';
      if (s.status === 'error') sub = esc(s.hint || s.msg);
      else if (s.msg) sub = esc(s.msg);
      else if (s.status === 'running' && s.pct) sub = Math.round(s.pct) + '%';
    }
    const badge = it.img
      ? `<div class="badge th" data-pprev="${esc(it.path)}" title="${t('list.preview')}"><img src="${thumbUrl(it.path, 0, 120)}" alt="" draggable="false" loading="lazy" onerror="this.remove()"><span class="ex">${esc(ext(it.name))}</span></div>`
      : pdfBadge(it);
    return `<div class="f sel ${cls}" title="${esc(it.path)}" data-pp="${esc(it.path)}">${badge}` +
      `<div class="meta"><div class="n">${esc(it.name)}</div><div class="sub">${sub}</div></div>` +
      `<div class="pill">${status}</div>` + (snap.running ? '' : `<button class="x" data-px="${esc(it.path)}" title="${t('list.remove')}">✕</button>`) + '</div>';
  }).join('');
  pdfEstWatch();
  pdfThumbWatch();
  $('pdfList').classList.toggle('kin-list', drag && pdfFiles.length > 1);
  if (list === pdfLast || pdfSort.busy()) return;   // опрос не сбрасывает наведение и выделение, перетаскиваемую строку не трогаем
  pdfLast = list;
  $('pdfList').innerHTML = list;
  $('pdfEmpty').classList.toggle('hide', pdfFiles.length > 0);
  $('pdfList').classList.toggle('hide', !pdfFiles.length);
  const np = pdfFor('resave').length, ni = pdfFor('img2pdf').length;
  $('pdfCnt').textContent = [np ? np + ' PDF' : '', ni ? t('pdf.imgCount', {n: ni}) : ''].filter(Boolean).join(' · ');
}

// ---------- прогноз размера после «Сжать» ----------
// Оценку делает pdf_compress.go пробным сжатием без записи (/api/pdf-estimate), по одному файлу.
// Кэш по файлу и настройкам: вернулся к прежнему пресету — ответ сразу
const pdfEst = {};          // ключ (pdfEstKey) -> ответ сервера или {wait: true}
let pdfEstGen = 0, pdfEstTimer = 0, pdfEstBusy = 0, pdfEstSet = '';
const pdfNum = v => lang === 'ru' ? String(v).replace('.', ',') : String(v);
// настройки, от которых зависит размер
function pdfEstOpts() {
  const c = pdfSet.comp;
  const p = c.preset === 'custom' ? [c.preset, c.quality, c.dpi] : c.preset === 'target' ? [c.preset, +c.target] : [c.preset];
  return JSON.stringify([p, c.color, !!c.strip, $('pdfPass').value]);
}
const pdfEstKey = path => path + '\n' + pdfEstOpts();
// файлы, которые можно оценить: прочитаны, не закрыты, не битые
const pdfEstFiles = () => pdfSet.op === 'compress' ? pdfFor('compress').filter(f => f.info && f.info.pages && !f.info.needPass && !f.info.error) : [];
// с какими настройками был последний «Сжать»: настройки сменили — его результаты уже не про них, вместо них прогноз
let pdfRunOpts = '';
const pdfResOf = path => pdfSet.op === 'compress' && !snap.running && pdfRunOpts !== pdfEstOpts() ? null : pdfRes[path];
const pdfPct = (a, b) => b < a ? ` (−${Math.round((a - b) * 100 / a)}%)` : '';

function pdfEstTag(it) {
  const e = pdfEst[pdfEstKey(it.path)];
  if (!e || e.error || e.needPass) return '';
  if (e.wait) return `<span class="tag est-wait">${t('pdf.estWait')}</span>`;
  const tip = ` title="${esc(t('pdf.estTip'))}"`;
  if (e.already) return `<span class="tag"${tip}>${t('pdf.estAlready', {n: pdfNum(pdfSet.comp.target)})}</span>`;
  if (e.kept) return `<span class="tag est-no"${tip}>${t('pdf.estKept')}</span>`;
  const txt = `${e.exact ? '→' : '≈'} ${fmtSize(e.size)}${pdfPct(e.src, e.size)}`;
  if (pdfSet.comp.preset === 'target' && !e.fit) return `<span class="tag big"${tip}>${txt} · ${t('pdf.estMiss', {n: pdfNum(pdfSet.comp.target)})}</span>`;
  return `<span class="tag"${tip}>${txt}</span>`;
}

// итог по пачке для нижней панели: «Сейчас 180 МБ → будет ≈ 42 МБ (−77%)»; '' — показывать обычную подсказку
function pdfEstTotal() {
  const fl = pdfEstFiles();
  if (!fl.length || fl.some(f => pdfResOf(f.path))) return '';
  let src = 0, dst = 0, wait = 0, approx = false;
  for (const f of fl) {
    const e = pdfEst[pdfEstKey(f.path)];
    if (!e || e.wait || e.error || e.needPass) { wait++; continue; }
    src += e.src; dst += e.kept ? e.src : e.size;
    approx = approx || !e.exact;
  }
  if (wait === fl.length) return t('pdf.estTotalWait', {n: 1, m: fl.length});
  let s = t('pdf.estTotal', {a: fmtSize(src), b: (approx || wait ? '≈ ' : '') + fmtSize(dst) + pdfPct(src, dst)});
  if (wait) s += ' · ' + t('pdf.estTotalWait', {n: fl.length - wait + 1, m: fl.length});
  return s;
}

// после каждой отрисовки. Сменились настройки — через паузу оценить заново (прежнюю оценку на сервере
// отменит новый запрос). Добавились файлы — идущий цикл возьмёт их сам, иначе запустить
function pdfEstWatch() {
  if (snap.running || tab !== 'pdf') return;
  const set = pdfEstOpts(), changed = set !== pdfEstSet;
  pdfEstSet = set;
  if (changed) renderSummary(snap);
  if (!changed && (pdfEstBusy || !pdfEstFiles().some(f => !pdfEst[pdfEstKey(f.path)]))) return;
  const g = pdfEstBusy = ++pdfEstGen;
  for (const k in pdfEst) if (pdfEst[k].wait) delete pdfEst[k];
  clearTimeout(pdfEstTimer);
  pdfEstTimer = setTimeout(() => pdfEstLoop(g), 350);
}
async function pdfEstLoop(g) {
  try {
    for (;;) {
      if (g !== pdfEstGen || snap.running || tab !== 'pdf') return;
      const it = pdfEstFiles().find(f => !pdfEst[pdfEstKey(f.path)]);
      if (!it) return;
      const key = pdfEstKey(it.path);
      pdfEst[key] = {wait: true};
      pdfLast = ''; pdfRender(); renderSummary(snap);
      const r = await api('pdf-estimate', {path: it.path, password: $('pdfPass').value, comp: pdfSet.comp});
      // отменил более новый запрос — забыть, оценим заново; иначе запомнить даже ошибку, чтобы не крутиться на ней
      if (r.error === 'canceled' && g !== pdfEstGen) delete pdfEst[key];
      else pdfEst[key] = r.error && !r.src ? {error: r.error} : r;
      pdfLast = ''; pdfRender(); renderSummary(snap);
    }
  } finally { if (pdfEstBusy === g) pdfEstBusy = 0; }
}

$('pdfList').addEventListener('click', e => {
  const x = e.target.closest('[data-px]');
  if (x && !snap.running) { pdfFiles = pdfFiles.filter(f => f.path !== x.dataset.px); delete pdfRes[x.dataset.px]; pdfRender(); }
});

// порядок картинок: строка идёт за курсором, остальные расступаются, как в очереди плеера (kinSort из kinetic.js).
// На указателе, не HTML5: перетаскивание браузера в окне отключено (drop.js), а файлы извне ловит само окно
function pdfMove(from, to) {
  pdfFiles.splice(to, 0, pdfFiles.splice(from, 1)[0]);
  pdfLast = '';
  pdfRender();
}
const pdfSort = kinSort($('pdfList'), {item: '.f', key: r => r.dataset.pp, done: pdfMove});

// миниатюра картинки открывает быстрый просмотр, значок PDF — просмотр страниц (pdfraster.js), а битый или закрытый — файл в программе по умолчанию
$('pdfList').addEventListener('click', async e => {
  const pv = e.target.closest('[data-pprev]');
  if (pv) { const it = pdfFiles.find(f => f.path === pv.dataset.pprev); if (it) openPreview(it); return; }
  const vw = e.target.closest('[data-pview]');
  if (vw) { const it = pdfFiles.find(f => f.path === vw.dataset.pview); if (it) pdfView(it); return; }
  const cm = e.target.closest('[data-pcmp]');
  if (cm) { const it = pdfFiles.find(f => f.path === cm.dataset.pcmp); if (it) pdfView(it, true); return; }
  const op = e.target.closest('[data-popen]');
  if (op) { const r = await api('open-file', {path: op.dataset.popen}); if (r.error) say('warn', t('pdf.openDefault'), r.error); }
});
$('pdfSortName').onclick = () => {
  if (snap.running) return;
  const coll = new Intl.Collator(undefined, {numeric: true, sensitivity: 'base'});
  pdfFiles = pdfFiles.slice().sort((a, b) => coll.compare(a.dir, b.dir) || coll.compare(a.name, b.name));
  pdfRender();
};

$('pdfAddFiles').onclick = () => dialog(async () => { const r = await api('pdf-pick'); if (r.error) alert(r.error); pdfAdd(r.files); });
$('pdfAddFolder').onclick = () => dialog(async () => { const r = await api('pick-folder', {purpose:'pdf'}); if (r.error) alert(r.error); pdfAdd(r.files); });
$('pdfClear').onclick = () => { if (!snap.running) { pdfFiles = []; Object.keys(pdfRes).forEach(k => delete pdfRes[k]); pdfRender(); } };
$('pdfOp').addEventListener('click', e => {
  const b = e.target.closest('.chip'); if (!b || snap.running) return;
  pdfSet.op = b.dataset.op; pdfSave(); pdfRender(); renderSummary(snap);   // прогноз «Сжать» в панели — только у него
});
for (const [id, key] of [['pdfImgPage', 'page'], ['pdfImgOrient', 'orient'], ['pdfImgMargin', 'margin'], ['pdfImgQuality', 'quality']]) {
  $(id).addEventListener('click', e => {
    const b = e.target.closest('.chip'); if (!b) return;
    pdfSet.img[key] = key === 'margin' ? +b.dataset.v : b.dataset.v; pdfSave(); pdfRender();
  });
}
// свой размер страницы, мм: вне 20…5000 не принимаем (пустое поле — как у A4, смотрит pageLayout)
for (const [id, k] of [['pdfImgW', 'pageW'], ['pdfImgH', 'pageH']]) {
  $(id).addEventListener('input', () => {
    const v = parseFloat($(id).value.replace(',', '.'));
    if (v >= 20 && v <= 5000) { pdfSet.img[k] = Math.round(v * 10) / 10; pdfSave(); pdfRender(); }
  });
  $(id).addEventListener('blur', () => { $(id).value = pdfSet.img[k]; });
}
// сжатие: пресет, качество и DPI для «Своего», цвет, чистка
for (const [id, key] of [['pdfCompPreset', 'preset'], ['pdfCompDpi', 'dpi'], ['pdfCompColor', 'color']]) {
  $(id).addEventListener('click', e => {
    const b = e.target.closest('.chip'); if (!b) return;
    pdfSet.comp[key] = key === 'dpi' ? +b.dataset.v : b.dataset.v; pdfSave(); pdfRender();
  });
}
// «До размера»: МБ на файл, чипами или своим числом (0,1…10000)
$('pdfCompTgt').addEventListener('click', e => {
  const b = e.target.closest('.chip'); if (!b) return;
  pdfSet.comp.target = +b.dataset.v; pdfSave(); pdfRender();
});
$('pdfCompTgtV').addEventListener('input', () => {
  const v = parseFloat($('pdfCompTgtV').value.replace(',', '.'));
  if (v >= 0.1 && v <= 10000) { pdfSet.comp.target = Math.round(v * 10) / 10; pdfSave(); pdfRender(); }
});
$('pdfCompTgtV').addEventListener('blur', () => { $('pdfCompTgtV').value = pdfSet.comp.target; });
$('pdfCompQ').addEventListener('input', () => { pdfSet.comp.quality = +$('pdfCompQ').value; pdfSave(); pdfRender(); });
$('pdfCompStrip').addEventListener('change', () => { pdfSet.comp.strip = $('pdfCompStrip').checked; pdfSave(); pdfRender(); });
$('pdfImgSep').addEventListener('change', () => { pdfSet.img.separate = $('pdfImgSep').checked; pdfSave(); pdfRender(); });
// в картинки: формат, dpi, качество, страницы, прозрачность; пересборка: совместимость, чистка
for (const [id, key] of [['pdfRasFmt', 'fmt'], ['pdfRasDpi', 'dpi'], ['pdfRasQ', 'q'], ['pdfRasPages', 'pages']]) {
  $(id).addEventListener('click', e => {
    const b = e.target.closest('.chip'); if (!b) return;
    pdfSet.ras[key] = key === 'dpi' || key === 'q' ? +b.dataset.v : b.dataset.v; pdfSave(); pdfRender();
    if (key === 'pages' && b.dataset.v === 'range') $('pdfRasRange').focus();
  });
}
$('pdfRasRange').addEventListener('input', () => { pdfSet.ras.range = $('pdfRasRange').value; pdfSave(); pdfRender(); });
$('pdfRasTransp').addEventListener('change', () => { pdfSet.ras.transparent = $('pdfRasTransp').checked; pdfSave(); pdfRender(); });
$('pdfFixVer').addEventListener('click', e => {
  const b = e.target.closest('.chip'); if (!b) return;
  pdfSet.fix.version = b.dataset.v; pdfSave(); pdfRender();
});
$('pdfFixStrip').addEventListener('change', () => { pdfSet.fix.strip = $('pdfFixStrip').checked; pdfSave(); pdfRender(); });
$('pdfOutMode').addEventListener('click', e => {
  const b = e.target.closest('.segb'); if (!b) return;
  pdfSet.mode = b.dataset.m; pdfSave(); pdfRender();
  if (pdfSet.mode === 'folder' && !pdfSet.dir) $('pdfPickOut').click();
});
$('pdfOutDir').addEventListener('input', () => { pdfSet.dir = $('pdfOutDir').value.trim(); pdfSave(); pdfRender(); });
$('pdfPickOut').onclick = () => dialog(async () => {
  const r = await api('pick-folder', {purpose:'out'});
  if (r.error) alert(r.error);
  if (r.path) { pdfSet.dir = r.path; pdfSet.mode = 'folder'; $('pdfOutDir').value = r.path; pdfSave(); pdfRender(); }
});
let pdfPassTimer = 0;
$('pdfPass').addEventListener('input', () => { pdfRender(); clearTimeout(pdfPassTimer); pdfPassTimer = setTimeout(() => { for (const k in pdfThumbs) if (pdfThumbs[k] === 'fail') delete pdfThumbs[k]; pdfCheck(true); }, 400); });

$('pdfStart').onclick = async () => {
  if (startSent || snap.running) return;
  const op = pdfSet.op, files = pdfFor(op);
  if (!files.length) { say('warn', t('start.emptyTitle'), t(op === 'img2pdf' ? 'pdf.emptyAddImg' : 'pdf.emptyAdd')); return; }
  if (pdfSet.mode === 'folder' && !pdfSet.dir) { say('warn', t('start.whereTitle'), t('start.where')); return; }
  const ras = {...pdfSet.ras};
  if (op === 'raster' && ras.pages === 'range' && !pdfRangeOk(ras.range)) { say('warn', t('pdf.rasRangeTitle'), t('pdf.rasRangeBad')); $('pdfRasRange').focus(); return; }
  let plan = null;
  if (op === 'pages') {
    const bad = pdfPgBad()[0];
    if (bad) { say('warn', t('pdf.pgBadTitle'), t('pdf.pgBadFile', {name: bad.name})); return; }
    plan = pdfPgPlan();
    if (plan.error) { say('warn', t('pdf.pgTitle'), plan.error); if (pdfSet.pg.mode === 'ranges') $('pdfPgRanges').focus(); return; }
    pdfRunDocs = plan.docs.length;
  }
  if (op === 'raster') try { await pdfjsLoad(); } catch (e) { say('err', t('start.failed'), e.message); return; }
  pdfFiles.forEach(f => delete pdfRes[f.path]);
  pdfRunOpts = op === 'compress' ? pdfEstOpts() : '';
  pdfRunOp = op;
  snap.files = []; newBatch(); pdfLast = '';
  startSent = true;
  const pw = $('pdfPass').value;
  const r = await api('pdf-run', {files: (op === 'pages' ? pdfPgFiles() : files).map(f => f.path), op, img: pdfSet.img, comp: pdfSet.comp, fix: pdfSet.fix, pages: plan || {}, password: pw,
    sameDir: pdfSet.mode === 'same', outDir: pdfSet.mode === 'folder' ? pdfSet.dir : ''});
  startSent = false;
  if (r.error) { say('err', t('start.failed'), r.error); return; }
  snap.running = true; pollSoon();
  if (op === 'raster') pdfRasRun(files, ras, pw);   // страницы рисует окно, сервер ведёт прогон
};
let pdfRunOp = '', pdfRunDocs = 0;

function pdfDone(s) {
  pdfLast = '';
  pdfRender();
  const fl = s.files || [], er = fl.filter(f => f.status === 'error'), ok = fl.filter(f => f.status === 'ok' && f.dst);
  const stopped = fl.some(f => f.status === 'canceled');
  let dirs = [...new Set(ok.map(f => dirOf(f.dst)))];
  // «В картинки»: у каждого PDF своя папка страниц; если их несколько, но лежат рядом — открыть общую
  if (pdfRunOp === 'raster' && dirs.length > 1) { const up = [...new Set(dirs.map(d => dirOf(d.replace(/[\\/]+$/, ''))))]; if (up.length === 1) dirs = up; }
  const made = pdfRunOp === 'pages' ? pdfRunDocs - er.length : new Set(ok.map(f => f.dst.toLowerCase())).size;
  const kept = fl.filter(f => f.status === 'kept');   // «Сжать»: не стало меньше, оригинал как есть
  toast({id: 'done', type: er.length ? 'err' : stopped ? 'warn' : !made && kept.length ? 'info' : 'ok',
    title: stopped ? t('done.stopped') : !made && kept.length ? t('pdf.compNothing') : t(pdfRunOp === 'raster' ? 'pdf.rasDoneTitle' : 'pdf.doneTitle', {n: made}),
    text: esc(s.summary || ''),
    list: [...er, ...kept, ...fl.filter(f => f.status === 'ok' && f.hint)].map(f => `<b style="display:inline;font-size:12.5px;color:var(--tx-em)">${esc(f.name)}</b> — ${esc(f.hint || f.msg)}`),
    actions: dirs.length === 1 ? [{t: t('btn.openFolder'), primary: true, keep: true, fn: async () => {
      const r = await api('open-dir', {path: dirs[0]}); if (r.error) say('warn', t('folder.title'), r.error);
    }}] : [],
    ttl: er.length ? 0 : 15000});
}
pdfRender();
