// ---------- «PDF» во вкладке «Утилиты» ----------
// Файлы, действие, пароль, куда сохранять. Работу делает pdf.go (pdfcpu) и pdf_images.go («Картинки → PDF»),
// прогон идёт через общий опрос, как у «Баннеров».
let pdfFiles = [];        // {name, dir, path, size, img, info}; info — ответ /api/pdf-info (страницы, нужен ли пароль, ошибка)
const pdfRes = {};        // путь -> состояние с сервера (последний прогон PDF)
const pdfSet = {mode: 'same', dir: '', op: 'resave', img: {page: 'a4', orient: 'auto', margin: 5, quality: 'high', separate: false}};   // сохраняется в localStorage
let pdfLast = '';
try {
  const saved = JSON.parse(localStorage.getItem('konv9000.pdf') || '{}');
  Object.assign(pdfSet.img, saved.img || {}); delete saved.img;
  Object.assign(pdfSet, saved);
} catch (e) {}
if (pdfSet.mode !== 'folder') pdfSet.mode = 'same';
if (pdfSet.op !== 'img2pdf') pdfSet.op = 'resave';
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
    else if (!imgs && pdfSet.op === 'img2pdf' && !pdfFor('img2pdf').length) { pdfSet.op = 'resave'; pdfSave(); }
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
  const labels = {pending:t('status.pending'), running:'<span class="spin"></span>', ok:t('status.ok'), error:t('status.error'), canceled:t('status.canceled')};
  const op = pdfSet.op, im = pdfSet.img, imgOp = op === 'img2pdf';
  document.querySelectorAll('#pdfOp .chip').forEach(b => b.classList.toggle('on', b.dataset.op === op));
  $('pdfOpSum').textContent = t(imgOp ? 'pdf.opImg' : 'pdf.opResave');
  $('pdfOpNote').textContent = t(imgOp ? 'pdf.opImgSub' : 'pdf.opResaveSub');
  // раздел другого действия прячется; если он был открыт — открыть раздел этого
  const [show, hide] = imgOp ? ['pdfImgCard', 'pdfPassCard'] : ['pdfPassCard', 'pdfImgCard'];
  if ($(hide).classList.contains('open')) { pdfAccOpen(hide, false); pdfAccOpen(show, true); }
  $(show).classList.remove('hide'); $(hide).classList.add('hide');
  pdfChips('pdfImgPage', im.page); pdfChips('pdfImgOrient', im.orient); pdfChips('pdfImgMargin', im.margin); pdfChips('pdfImgQuality', im.quality);
  $('pdfImgOrientRow').classList.toggle('hide', im.page === 'fit');
  $('pdfImgQNote').textContent = t({orig: 'pdf.qNote_orig', mid: 'pdf.qNote_mid', low: 'pdf.qNote_low'}[im.quality] || 'pdf.qNote_high');
  $('pdfImgSep').checked = !!im.separate;
  // сводки в заголовках разделов: подписи выбранных чипов
  const chip = id => document.querySelector(`#${id} .chip.on`)?.textContent || '';
  $('pdfImgSum').textContent = [chip('pdfImgPage'), im.page === 'fit' ? '' : chip('pdfImgOrient'), chip('pdfImgMargin'), chip('pdfImgQuality'),
    im.separate ? t('pdf.sepShort') : ''].filter(Boolean).join(' · ');
  $('pdfPassSum').textContent = t($('pdfPass').value ? 'pdf.passSet' : 'pdf.passNone');
  document.querySelectorAll('#pdfOutMode .segb').forEach(b => b.classList.toggle('on', b.dataset.m === pdfSet.mode));
  $('pdfFolderRow').classList.toggle('hide', pdfSet.mode !== 'folder');
  if ($('pdfOutDir').value !== pdfSet.dir && document.activeElement !== $('pdfOutDir')) $('pdfOutDir').value = pdfSet.dir;
  const outName = base(pdfSet.dir.replace(/[\\/]+$/, '')) || pdfSet.dir;
  $('pdfOutSum').textContent = pdfSet.mode === 'same' ? t('out.same') : pdfSet.dir ? t('out.sumFolder', {name: outName}) : t('out.noFolder');
  $('pdfOutSum').title = pdfSet.mode === 'folder' ? pdfSet.dir : '';
  const drag = imgOp && !snap.running;
  $('pdfSortName').classList.toggle('hide', !drag || pdfFor('img2pdf').length < 2);
  let page = 0;
  const list = pdfFiles.map(it => {
    const s = pdfRes[it.path], inf = it.info || {}, off = imgOp !== it.img;
    let cls = '', status = '', sub = esc(it.dir) + ' · ' + fmtSize(it.size);
    if (inf.pages) sub += ' · ' + t('pdf.pages', {n: inf.pages});
    if (inf.needPass) sub = `<span class="tag big">${t('pdf.tagPass')}</span>` + sub;
    else if (inf.encrypted) sub += `<span class="tag">${t('pdf.tagLocked')}</span>`;
    if (inf.error) sub = `<span class="tag big">${t('pdf.tagBroken')}</span>` + esc(inf.error);
    if (off) { cls = 'off'; sub = `<span class="tag">${t(it.img ? 'pdf.offImg' : 'pdf.offPdf')}</span>` + sub; }
    else if (imgOp && !im.separate) sub = `<span class="tag">${t('pdf.pageN', {n: ++page})}</span>` + sub;
    if (s) {
      cls = s.status; status = labels[s.status] || '';
      if (s.status === 'error') sub = esc(s.hint || s.msg);
      else if (s.msg) sub = esc(s.msg);
    }
    const badge = it.img
      ? `<div class="badge th"><img src="${thumbUrl(it.path, 0, 120)}" alt="" draggable="false" loading="lazy" onerror="this.remove()"><span class="ex">${esc(ext(it.name))}</span></div>`
      : '<div class="badge">pdf</div>';
    return `<div class="f sel ${cls}" title="${esc(it.path)}" data-pp="${esc(it.path)}"${drag && !off ? ' data-mv' : ''}>${badge}` +
      `<div class="meta"><div class="n">${esc(it.name)}</div><div class="sub">${sub}</div></div>` +
      `<div class="pill">${status}</div>` + (snap.running ? '' : `<button class="x" data-px="${esc(it.path)}" title="${t('list.remove')}">✕</button>`) + '</div>';
  }).join('');
  if (list === pdfLast) return;   // опрос не сбрасывает наведение и выделение
  pdfLast = list;
  $('pdfList').innerHTML = list;
  $('pdfEmpty').classList.toggle('hide', pdfFiles.length > 0);
  $('pdfList').classList.toggle('hide', !pdfFiles.length);
  const np = pdfFor('resave').length, ni = pdfFor('img2pdf').length;
  $('pdfCnt').textContent = [np ? np + ' PDF' : '', ni ? t('pdf.imgCount', {n: ni}) : ''].filter(Boolean).join(' · ');
}

$('pdfList').addEventListener('click', e => {
  const x = e.target.closest('[data-px]');
  if (x && !snap.running) { pdfFiles = pdfFiles.filter(f => f.path !== x.dataset.px); delete pdfRes[x.dataset.px]; pdfRender(); }
});

// порядок картинок перетаскиванием строк (только для «Картинки → PDF»). На указателе, не HTML5:
// перетаскивание браузера в окне отключено (drop.js), а файлы извне ловит само окно
let pdfDrag = null;   // {path, y, on, row}
$('pdfList').addEventListener('pointerdown', e => {
  const row = e.target.closest('[data-pp][data-mv]');
  if (!row || e.button !== 0 || e.target.closest('.x')) return;
  pdfDrag = {path: row.dataset.pp, y: e.clientY, on: false, row};
  try { $('pdfList').setPointerCapture(e.pointerId); } catch (err) {}
});
function pdfDropMark() { document.querySelectorAll('#pdfList .drop-before, #pdfList .drop-after').forEach(r => r.classList.remove('drop-before', 'drop-after')); }
$('pdfList').addEventListener('pointermove', e => {
  if (!pdfDrag) return;
  if (!pdfDrag.on) {
    if (Math.abs(e.clientY - pdfDrag.y) < 5) return;
    pdfDrag.on = true;
    pdfDrag.row.classList.add('dragging');
  }
  pdfDropMark();
  const row = document.elementFromPoint(e.clientX, e.clientY)?.closest('#pdfList [data-mv]');
  pdfDrag.to = null;
  if (row && row.dataset.pp !== pdfDrag.path) {
    const r = row.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
    row.classList.add(after ? 'drop-after' : 'drop-before');
    pdfDrag.to = {path: row.dataset.pp, after};
  }
  // у краёв списка — прокрутка
  const lr = $('pdfList').getBoundingClientRect();
  if (e.clientY < lr.top + 30) $('pdfList').scrollTop -= 12;
  else if (e.clientY > lr.bottom - 30) $('pdfList').scrollTop += 12;
});
function pdfDragEnd(apply) {
  const d = pdfDrag;
  pdfDrag = null;
  if (!d || !d.on) return;
  pdfDropMark();
  if (apply && d.to) {
    const it = pdfFiles.find(f => f.path === d.path);
    pdfFiles = pdfFiles.filter(f => f !== it);
    const at = pdfFiles.findIndex(f => f.path === d.to.path);
    pdfFiles.splice(at + (d.to.after ? 1 : 0), 0, it);
  }
  pdfLast = '';
  pdfRender();
}
$('pdfList').addEventListener('pointerup', () => pdfDragEnd(true));
$('pdfList').addEventListener('pointercancel', () => pdfDragEnd(false));
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
  pdfSet.op = b.dataset.op; pdfSave(); pdfRender();
});
for (const [id, key] of [['pdfImgPage', 'page'], ['pdfImgOrient', 'orient'], ['pdfImgMargin', 'margin'], ['pdfImgQuality', 'quality']]) {
  $(id).addEventListener('click', e => {
    const b = e.target.closest('.chip'); if (!b) return;
    pdfSet.img[key] = key === 'margin' ? +b.dataset.v : b.dataset.v; pdfSave(); pdfRender();
  });
}
$('pdfImgSep').addEventListener('change', () => { pdfSet.img.separate = $('pdfImgSep').checked; pdfSave(); pdfRender(); });
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
$('pdfPass').addEventListener('input', () => { pdfRender(); clearTimeout(pdfPassTimer); pdfPassTimer = setTimeout(() => pdfCheck(true), 400); });

$('pdfStart').onclick = async () => {
  if (startSent || snap.running) return;
  const op = pdfSet.op, files = pdfFor(op);
  if (!files.length) { say('warn', t('start.emptyTitle'), t(op === 'img2pdf' ? 'pdf.emptyAddImg' : 'pdf.emptyAdd')); return; }
  if (pdfSet.mode === 'folder' && !pdfSet.dir) { say('warn', t('start.whereTitle'), t('start.where')); return; }
  pdfFiles.forEach(f => delete pdfRes[f.path]);
  snap.files = []; newBatch(); pdfLast = '';
  startSent = true;
  const r = await api('pdf-run', {files: files.map(f => f.path), op, img: pdfSet.img, password: $('pdfPass').value,
    sameDir: pdfSet.mode === 'same', outDir: pdfSet.mode === 'folder' ? pdfSet.dir : ''});
  startSent = false;
  if (r.error) say('err', t('start.failed'), r.error);
  else { snap.running = true; pollSoon(); }
};

function pdfDone(s) {
  pdfLast = '';
  pdfRender();
  const fl = s.files || [], er = fl.filter(f => f.status === 'error'), ok = fl.filter(f => f.status === 'ok' && f.dst);
  const stopped = fl.some(f => f.status === 'canceled');
  const dirs = [...new Set(ok.map(f => dirOf(f.dst)))];
  const made = new Set(ok.map(f => f.dst.toLowerCase())).size;
  toast({id: 'done', type: er.length ? 'err' : stopped ? 'warn' : 'ok',
    title: stopped ? t('done.stopped') : t('pdf.doneTitle', {n: made}),
    text: esc(s.summary || ''),
    list: er.map(f => `<b style="display:inline;font-size:12.5px;color:var(--tx-em)">${esc(f.name)}</b> — ${esc(f.hint || f.msg)}`),
    actions: dirs.length === 1 ? [{t: t('btn.openFolder'), primary: true, keep: true, fn: async () => {
      const r = await api('open-dir', {path: dirs[0]}); if (r.error) say('warn', t('folder.title'), r.error);
    }}] : [],
    ttl: er.length ? 0 : 15000});
}
pdfRender();
