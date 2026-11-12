// ---------- «PDF» во вкладке «Утилиты» ----------
// Файлы, действие, пароль, куда сохранять. Работу делает pdf.go (pdfcpu) и pdf_images.go («Картинки → PDF»),
// прогон идёт через общий опрос, как у «Баннеров».
let pdfFiles = [];        // {name, dir, path, size, img, info}; info — ответ /api/pdf-info (страницы, нужен ли пароль, ошибка)
const pdfRes = {};        // путь -> состояние с сервера (последний прогон PDF)
const pdfSet = {mode: 'same', dir: '', op: 'compress', ras: {fmt: 'png', dpi: 150, q: 92, pages: 'all', range: '', transparent: false}, fix: {version: '', strip: false}, img: {page: 'a4', orient: 'auto', margin: 5, quality: 'high', separate: false, pageW: 210, pageH: 297},
  comp: {preset: 'medium', quality: 70, dpi: 150, color: '', strip: true, target: 10}, pg: {mode: 'one', every: 2, ranges: ''},
  dec: {wm: {on: false, kind: 'text', text: '', image: '', size: 64, scale: 40, opacity: 30, rotate: 45, pos: 'c', color: '#808080', onTop: true}, num: {on: false, fmt: 'nt', pos: 'bc', size: 11, skipFirst: false},
    crop: {on: false, top: 0, right: 0, bottom: 0, left: 0}, meta: {on: false, title: '', author: '', subject: '', keywords: '', clean: false}, pw: {mode: ''}}};   // сохраняется в localStorage
let pdfLast = '';
try {
  const saved = JSON.parse(localStorage.getItem('konv9000.pdf') || '{}');
  Object.assign(pdfSet.img, saved.img || {}); delete saved.img;
  Object.assign(pdfSet.comp, saved.comp || {}); delete saved.comp;
  Object.assign(pdfSet.ras, saved.ras || {}); delete saved.ras;
  Object.assign(pdfSet.fix, saved.fix || {}); delete saved.fix;
  Object.assign(pdfSet.pg, saved.pg || {}); delete saved.pg;
  for (const k of ['wm', 'num', 'crop', 'meta', 'pw']) Object.assign(pdfSet.dec[k], (saved.dec || {})[k] || {});
  delete saved.dec;
  Object.assign(pdfSet, saved);
} catch (e) {}
if (pdfSet.mode !== 'folder') pdfSet.mode = 'same';
if (!['img2pdf', 'resave', 'compress', 'raster', 'pages', 'decor'].includes(pdfSet.op)) pdfSet.op = 'compress';
function pdfSave() { try { localStorage.setItem('konv9000.pdf', JSON.stringify(pdfSet)); } catch (e) {} }

const PDF_IMG = /\.(jpe?g|png|webp)$/i;
// файлы, с которыми работает действие: картинки — только «Картинки → PDF»; нечитаемый PDF — только «Починить»
const pdfFor = op => pdfFiles.filter(f => op === 'img2pdf' ? f.img : !f.img && (op === 'resave' || !(f.info && f.info.error)));
const PDF_OPS = ['compress', 'raster', 'pages', 'decor', 'resave', 'img2pdf'];
const PDF_OPKEY = {img2pdf: 'pdf.opImg', resave: 'pdf.opResave', compress: 'pdf.opComp', raster: 'pdf.opRas', pages: 'pdf.opPg', decor: 'pdf.opDec'};
// раздел «Параметры» каждого действия
const PDF_CARD = {img2pdf: 'pdfImgCard', resave: 'pdfFixCard', compress: 'pdfCompCard', raster: 'pdfRasCard', pages: 'pdfPgCard', decor: 'pdfDecCard'};

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
// открыть только этот раздел правой колонки (как щелчок по заголовку)
function pdfAccOnly(id) {
  document.querySelectorAll('.pdf-col > .acc').forEach(s => pdfAccOpen(s.id, s.id === id));
}
// выбранную строку списка — в видимую часть
function pdfScrollSel() {
  requestAnimationFrame(() => { const r = document.querySelector('#pdfList .f.cur'); if (r) r.scrollIntoView({block: 'nearest'}); });
}
function pdfChips(id, v) { document.querySelectorAll(`#${id} .chip`).forEach(b => b.classList.toggle('on', b.dataset.v === String(v))); }

function pdfRender() {
  const labels = {pending:t('status.pending'), running:'<span class="spin"></span>', ok:t('status.ok'), error:t('status.error'), kept:t('status.kept'), canceled:t('status.canceled')};
  const op = pdfSet.op, im = pdfSet.img, imgOp = op === 'img2pdf', cp = pdfSet.comp;
  // действия: у каждого — сколько файлов из списка ему подходит; не подходит ни один — чип приглушён
  document.querySelectorAll('#pdfOp .chip').forEach(b => {
    const n = pdfFiles.length ? pdfFor(b.dataset.op).length : 0;
    b.classList.toggle('on', b.dataset.op === op);
    b.classList.toggle('none', !!pdfFiles.length && !n);
    b.querySelector('.cn').textContent = n || '';
  });
  const opKey = PDF_OPKEY[op];
  $('pdfOpSum').textContent = t(opKey);
  $('pdfOpNote').textContent = t(opKey + 'Sub');
  // «Параметры» только выбранного действия; «Пароль» — только если в списке есть закрытые PDF (или пароль уже вписан)
  const pass = !imgOp && (!!$('pdfPass').value || pdfFiles.some(f => f.info && (f.info.needPass || f.info.encrypted)));
  const show = [PDF_CARD[op], ...(pass ? ['pdfPassCard'] : [])];
  for (const id of [...Object.values(PDF_CARD), 'pdfPassCard']) {
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
  pdfDecRender();
  pdfPgSync();
  pdfPgPanel();
  // порядок файлов задаёт список, пока страницы в сетке не правили вручную (потом порядок живёт в сетке)
  const drag = (imgOp || (op === 'pages' && !pdfPg.dirty)) && !snap.running;
  $('pdfSortName').classList.toggle('hide', !drag || pdfFor('img2pdf').length < 2);
  pdfCanRender();
  pdfPvSync();   // выбранный файл и просмотр; до строк: выбор мог смениться
  let page = 0;
  const fits = new Set(pdfFor(op));
  const list = pdfFiles.map(it => {
    const s = pdfResOf(it.path), inf = it.info || {}, off = !fits.has(it);
    let cls = it.path === pdfSel ? 'cur' : '', status = '', sub = esc(it.dir) + ' · ' + fmtSize(it.size);
    if (inf.pages) sub += ' · ' + t('pdf.pages', {n: inf.pages});
    // закрытый: метка ведёт к полю пароля; нечитаемый: к «Починить»
    if (inf.needPass) sub = `<button class="tag big" data-ppass="1" title="${esc(t('pdf.tagPassTip'))}">${t('pdf.tagPass')}</button>` + sub;
    else if (inf.encrypted) sub += `<span class="tag">${t('pdf.tagLocked')}</span>`;
    if (inf.error) sub = `<span class="tag big">${t('pdf.tagBroken')}</span>` + (op !== 'resave' ? `<button class="tag" data-pfix="1" title="${esc(t('pdf.tagFixTip'))}">${t('pdf.tagFix')}</button>` : '') + esc(inf.error);
    if (off) { cls += ' off'; if (!inf.error) sub = `<span class="tag">${t(it.img ? 'pdf.offImg' : 'pdf.offPdf')}</span>` + sub; }
    else if (imgOp && !im.separate) sub = `<span class="tag">${t('pdf.pageN', {n: ++page})}</span>` + sub;
    else if (op === 'compress' && !s) sub = pdfEstTag(it) + sub;
    if (s) {
      cls = s.status; status = labels[s.status] || '';
      if (s.status === 'error') sub = esc(s.hint || s.msg);
      else if (s.msg) sub = esc(s.msg);
      else if (s.status === 'running' && s.pct) sub = Math.round(s.pct) + '%';
    }
    const badge = it.img
      ? `<div class="badge th"><img src="${thumbUrl(it.path, 0, 120)}" alt="" draggable="false" loading="lazy" onerror="this.remove()"><span class="ex">${esc(ext(it.name))}</span></div>`
      : pdfBadge(it);
    return `<div class="f sel ${cls}" title="${esc(it.path)}" data-pp="${esc(it.path)}">${badge}` +
      `<div class="meta"><div class="n">${esc(it.name)}</div><div class="sub">${sub}</div></div>` +
      `<div class="pill">${status}</div>` + (snap.running ? '' : `<button class="x" data-px="${esc(it.path)}" title="${t('list.remove')}">✕</button>`) + '</div>';
  }).join('');
  pdfEstWatch();
  pdfThumbWatch();
  $('pdfList').classList.toggle('kin-list', drag && pdfFiles.length > 1);
  renderSummary(snap);
  if (list === pdfLast || pdfSort.busy()) return;   // опрос не сбрасывает наведение и выделение, перетаскиваемую строку не трогаем
  pdfLast = list;
  $('pdfList').innerHTML = list;
  $('pdfEmpty').classList.toggle('hide', pdfFiles.length > 0);
  $('pdfList').classList.toggle('hide', !pdfFiles.length);
  const np = pdfFor('resave').length, ni = pdfFor('img2pdf').length;
  $('pdfCnt').textContent = [np ? np + ' PDF' : '', ni ? t('pdf.imgCount', {n: ni}) : ''].filter(Boolean).join(' · ');
}

// пустой список: что здесь можно сделать. Щелчок выбирает действие заранее
function pdfCanRender() {
  const html = PDF_OPS.map(op => `<button class="pdf-can-i${op === pdfSet.op ? ' on' : ''}" data-op="${op}"><b>${t(PDF_OPKEY[op])}</b><span>${t(PDF_OPKEY[op] + 'Can')}</span></button>`).join('');
  if ($('pdfCan').innerHTML !== html) $('pdfCan').innerHTML = html;
}
$('pdfCan').addEventListener('click', e => { const b = e.target.closest('[data-op]'); if (b) pdfSetOp(b.dataset.op); });

// что получится — для нижней панели до запуска. '' — обычная подсказка
function pdfPlanText() {
  if (!pdfFiles.length || pdfFiles.some(f => pdfResOf(f.path))) return '';   // после прогона — его итог
  const op = pdfSet.op, fl = pdfFor(op), skip = pdfFiles.length - fl.length;
  if (!fl.length) return t(op === 'img2pdf' ? 'pdf.planNoImg' : 'pdf.planNoPdf', {op: t(PDF_OPKEY[op])});
  const pages = fl.reduce((a, f) => a + ((f.info && f.info.pages) || 0), 0);
  let s = '';
  if (op === 'compress') s = pdfEstTotal() || t('pdf.planComp', {n: fl.length});
  else if (op === 'img2pdf') s = t(pdfSet.img.separate ? 'pdf.planImgSep' : 'pdf.planImg', {n: fl.length});
  else if (op === 'raster') s = t(pdfSet.ras.pages === 'range' ? 'pdf.planRasRange' : 'pdf.planRas', {n: fl.length, p: pages, f: pdfSet.ras.fmt.toUpperCase(), d: pdfSet.ras.dpi});
  else if (op === 'pages') { const pl = pdfPgPlan(); s = pl.error ? pl.error : t('pdf.planPg', {p: pl.docs.reduce((a, d) => a + d.pages.length, 0), n: pl.docs.length}); }
  else if (op === 'decor') s = pdfDecSumText() === t('pdf.decNone') ? t('pdf.planDecNone') : t('pdf.planDec', {n: fl.length, what: pdfDecSumText()});
  else if (op === 'resave') { const bad = fl.filter(f => f.info && f.info.error).length; s = t('pdf.planFix', {n: fl.length}) + (bad ? ' · ' + t('pdf.planFixBad', {n: bad}) : ''); }
  if (skip) s += ' · ' + t('pdf.planSkip', {n: skip});
  return s;
}

// выбрать действие: его «Параметры» сразу открываются, а выбранный в списке файл, если не подходит, меняется на подходящий
function pdfSetOp(op) {
  if (snap.running || !PDF_OPKEY[op]) return;
  const was = pdfSet.op;
  pdfSet.op = op; pdfSave();
  const fl = pdfFor(op), cur = pdfFiles.find(f => f.path === pdfSel);
  if (fl.length && !fl.includes(cur)) pdfSel = fl[0].path;
  if (was !== op || !$(PDF_CARD[op]).classList.contains('open')) pdfAccOnly(PDF_CARD[op]);
  pdfLast = '';
  pdfRender(); renderSummary(snap);
  pdfScrollSel();
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
// результаты прогона видны, пока действие то же (у «Сжать» — и настройки те же); выбрал другое — вместо них его прогноз
const pdfResOf = path => !snap.running && (pdfSet.op !== pdfRunOp || (pdfSet.op === 'compress' && pdfRunOpts !== pdfEstOpts())) ? null : pdfRes[path];
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

// строка списка: щелчок выбирает файл для просмотра, двойной — просмотр на всё окно.
// Метки в строке: «нужен пароль» ведёт к полю пароля, «Починить» — к этому действию
$('pdfList').addEventListener('click', e => {
  const row = e.target.closest('.f[data-pp]');
  if (!row || e.target.closest('[data-px]')) return;
  if (e.target.closest('[data-ppass]')) { pdfAccOnly('pdfPassCard'); $('pdfPass').focus(); }
  if (e.target.closest('[data-pfix]')) { pdfSel = row.dataset.pp; pdfSetOp('resave'); return; }
  if (pdfSel !== row.dataset.pp) { pdfSel = row.dataset.pp; pdfLast = ''; pdfRender(); }
});
$('pdfList').addEventListener('dblclick', e => {
  const row = e.target.closest('.f[data-pp]');
  if (row && !e.target.closest('button')) { pdfSel = row.dataset.pp; pdfLast = ''; pdfRender(); pdfPvBigSet(true); }
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
  const b = e.target.closest('.chip'); if (b) pdfSetOp(b.dataset.op);
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
  let plan = null, decor = {};
  if (op === 'decor') {
    const dd = pdfDecOpts();
    if (dd.err) { say('warn', t('pdf.decBadTitle'), t(dd.err)); if (dd.focus) { pdfAccOnly('pdfDecCard'); $(dd.focus).focus(); } return; }
    decor = dd.opts;
  }
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
  const r = await api('pdf-run', {files: (op === 'pages' ? pdfPgFiles() : files).map(f => f.path), op, img: pdfSet.img, comp: pdfSet.comp, fix: pdfSet.fix, pages: plan || {}, decor, password: pw,
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

// ---------- «Оформление»: водяной знак, номера, поля, метаданные, пароль на файл ----------
function pdfDecRender() {
  const d = pdfSet.dec, wm = d.wm, nm = d.num, cr = d.crop, mt = d.meta;
  const on = (id, v) => { if ($(id).checked !== !!v) $(id).checked = !!v; };
  const val = (id, v) => { if (document.activeElement !== $(id) && $(id).value !== String(v)) $(id).value = v; };
  on('pdfWmOn', wm.on); on('pdfNumOn', nm.on); on('pdfCropOn', cr.on); on('pdfMetaOn', mt.on);
  on('pdfWmTop', wm.onTop); on('pdfNumSkip', nm.skipFirst); on('pdfMetaClean', mt.clean);
  $('pdfWmBox').classList.toggle('hide', !wm.on); $('pdfNumBox').classList.toggle('hide', !nm.on);
  $('pdfCropBox').classList.toggle('hide', !cr.on); $('pdfMetaBox').classList.toggle('hide', !mt.on);
  const txt = wm.kind !== 'image';
  $('pdfWmTextRow').classList.toggle('hide', !txt); $('pdfWmSizeRow').classList.toggle('hide', !txt);
  $('pdfWmImgRow').classList.toggle('hide', txt); $('pdfWmScaleRow').classList.toggle('hide', txt);
  pdfChips('pdfWmKind', wm.kind); pdfChips('pdfWmSize', wm.size); pdfChips('pdfWmScale', wm.scale); pdfChips('pdfWmPos', wm.pos); pdfChips('pdfWmRot', wm.rotate);
  pdfChips('pdfNumFmt', nm.fmt); pdfChips('pdfNumPos', nm.pos); pdfChips('pdfNumSize', nm.size);
  val('pdfWmText', wm.text); val('pdfWmImg', wm.image); val('pdfWmColor', wm.color);
  val('pdfWmOp', wm.opacity); $('pdfWmOpV').textContent = wm.opacity + '%';
  for (const [id, k] of [['pdfCropTop', 'top'], ['pdfCropRight', 'right'], ['pdfCropBottom', 'bottom'], ['pdfCropLeft', 'left']]) val(id, cr[k]);
  val('pdfMetaTitle', mt.title); val('pdfMetaAuthor', mt.author); val('pdfMetaSubject', mt.subject); val('pdfMetaKeys', mt.keywords);
  pdfChips('pdfPwMode', d.pw.mode);
  $('pdfPwNewRow').classList.toggle('hide', d.pw.mode !== 'set');
  $('pdfPwNote').textContent = t({set: 'pdf.pwNote_set', remove: 'pdf.pwNote_remove'}[d.pw.mode] || 'pdf.pwNote_keep');
  $('pdfDecSum').textContent = pdfDecSumText();
}
function pdfDecBind() {
  const d = pdfSet.dec, upd = () => { pdfSave(); pdfRender(); };
  for (const [id, obj, key] of [['pdfWmOn', d.wm, 'on'], ['pdfNumOn', d.num, 'on'], ['pdfCropOn', d.crop, 'on'], ['pdfMetaOn', d.meta, 'on'],
      ['pdfWmTop', d.wm, 'onTop'], ['pdfNumSkip', d.num, 'skipFirst'], ['pdfMetaClean', d.meta, 'clean']])
    $(id).addEventListener('change', () => { obj[key] = $(id).checked; upd(); });
  for (const [id, obj, key, num] of [['pdfWmKind', d.wm, 'kind'], ['pdfWmSize', d.wm, 'size', 1], ['pdfWmScale', d.wm, 'scale', 1], ['pdfWmPos', d.wm, 'pos'], ['pdfWmRot', d.wm, 'rotate', 1],
      ['pdfNumFmt', d.num, 'fmt'], ['pdfNumPos', d.num, 'pos'], ['pdfNumSize', d.num, 'size', 1], ['pdfPwMode', d.pw, 'mode']])
    $(id).addEventListener('click', e => { const b = e.target.closest('.chip'); if (!b) return; obj[key] = num ? +b.dataset.v : b.dataset.v; upd(); if (id === 'pdfPwMode' && b.dataset.v === 'set') $('pdfPwNew').focus(); });
  for (const [id, obj, key] of [['pdfWmText', d.wm, 'text'], ['pdfWmColor', d.wm, 'color'], ['pdfMetaTitle', d.meta, 'title'], ['pdfMetaAuthor', d.meta, 'author'],
      ['pdfMetaSubject', d.meta, 'subject'], ['pdfMetaKeys', d.meta, 'keywords'], ['pdfWmImg', d.wm, 'image']])
    $(id).addEventListener('input', () => { obj[key] = $(id).value; upd(); });
  $('pdfWmOp').addEventListener('input', () => { d.wm.opacity = +$('pdfWmOp').value; upd(); });
  for (const [id, k] of [['pdfCropTop', 'top'], ['pdfCropRight', 'right'], ['pdfCropBottom', 'bottom'], ['pdfCropLeft', 'left']])
    $(id).addEventListener('input', () => { const v = parseFloat($(id).value); d.crop[k] = v >= 0 && v <= 200 ? v : 0; upd(); });
  $('pdfWmPick').onclick = () => dialog(async () => {
    const r = await api('pick-files'); if (r.error) { alert(r.error); return; }
    const f = (r.files || []).find(x => PDF_IMG.test(x.path)); if (f) { d.wm.image = f.path; upd(); }
  });
}
// настройки «Оформления» для сервера или текст, чего не хватает (пароль на чтение — в разделе «Пароль»)
function pdfDecOpts() {
  const d = pdfSet.dec, wm = d.wm, nm = d.num, cr = d.crop, mt = d.meta;
  if (wm.on && wm.kind === 'image' && !wm.image.trim()) return {err: 'pdf.decNeedImg', focus: 'pdfWmImg'};
  if (wm.on && wm.kind !== 'image' && !wm.text.trim()) return {err: 'pdf.decNeedText', focus: 'pdfWmText'};
  if (d.pw.mode === 'set' && !$('pdfPwNew').value.trim()) return {err: 'pdf.decNeedPw', focus: 'pdfPwNew'};
  if (!wm.on && !nm.on && !cr.on && !mt.on && !mt.clean && !d.pw.mode) return {err: 'pdf.decNothing'};
  return {opts: pdfDecBuild()};
}
// те же настройки без проверок; водяной знак без текста или картинки выключен (так их берёт и просмотр «после»)
function pdfDecBuild() {
  const d = pdfSet.dec, wm = d.wm, nm = d.num, cr = d.crop, mt = d.meta;
  const word = t('pdf.numTpl'), wmOk = wm.on && !!(wm.kind === 'image' ? wm.image.trim() : wm.text.trim());
  return {
    wm: {on: wmOk, kind: wm.kind, text: wm.text.trim(), image: wm.image.trim(), size: wm.size, scale: wm.scale, opacity: wm.opacity, rotate: wm.rotate, pos: wm.pos, color: wm.color, onTop: wm.onTop},
    num: {on: nm.on, format: {n: '%p', nt: '%p / %P', word}[nm.fmt] || '%p', pos: nm.pos, size: nm.size, skipFirst: nm.skipFirst},
    crop: {on: cr.on, top: cr.top, right: cr.right, bottom: cr.bottom, left: cr.left},
    meta: {on: mt.on, title: mt.title, author: mt.author, subject: mt.subject, keywords: mt.keywords, clean: mt.clean},
    pass: {mode: d.pw.mode, new: $('pdfPwNew').value}};
}
// что включено в «Оформлении», через точку
function pdfDecSumText() {
  const d = pdfSet.dec;
  return [d.wm.on && t('pdf.wm'), d.num.on && t('pdf.num'), d.crop.on && t('pdf.crop'), (d.meta.on || d.meta.clean) && t('pdf.meta'),
    d.pw.mode === 'set' && t('pdf.pwSetSum'), d.pw.mode === 'remove' && t('pdf.pwRemoveSum')].filter(Boolean).join(' · ') || t('pdf.decNone');
}
pdfDecBind();
