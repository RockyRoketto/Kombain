// ---------- «Страницы» в «PDF»: склейка, разрезание, порядок ----------
// Сетка миниатюр на pdf.js (pdfraster.js). Модель одна на всё действие: pdfPg.items — страницы будущего PDF по порядку
// (из каких файлов, какая страница, на сколько повёрнута). Пока правок нет, это все страницы всех файлов списка подряд,
// и порядок файлов задаёт сам список. Правка в сетке (поворот, удаление, дубль, порядок) делает порядок «ручным».
// Готовый план уходит на сервер (pdf_pages.go): склейка и разрезание считаются здесь, сервер только собирает.
// Файлы модели берутся из pdfFiles (pdf.js), а он грузится позже, поэтому наверху нет обращений к нему.
const pdfPg = {items: [], sel: new Set(), undo: [], dirty: false, sig: '', known: new Set(), id: 1, last: -1};
const PG_COLORS = ['#e9b872', '#7fb4e8', '#8fd19e', '#e88f8f', '#c39be8', '#e8d27f', '#7fd8d0', '#e89fc8'];
const PG_BOX = {w: 130, h: 170};                 // место под миниатюру в CSS-пикселях
const pgThumbs = {};                             // "путь#стр" -> {u: dataURL, w, h} | 'fail'
const pgDocs = {};                               // путь -> обещание документа pdf.js (пока окно открыто)
const pgOpen = () => !$('pdfPg').classList.contains('hide');

// файлы, которые можно собирать: прочитаны, не закрыты, не битые
const pdfPgFiles = () => pdfFiles.filter(f => !f.img && f.info && f.info.pages && !f.info.needPass && !f.info.error);
// файлы действия, которые собрать нельзя (ещё читаются, закрыты, битые)
const pdfPgBad = () => pdfFiles.filter(f => !f.img && !(f.info && f.info.pages && !f.info.needPass && !f.info.error));
const pgStem = p => base(p).replace(/\.[^.]+$/, '');

// сверить модель со списком файлов. Без правок — собрать заново (порядок файлов мог поменяться),
// с правками — только убрать страницы ушедших файлов и добавить страницы новых
function pdfPgSync() {
  const fl = pdfPgFiles();
  const sig = fl.map(f => f.path + ':' + f.info.pages).join('|');
  if (sig === pdfPg.sig) return;
  pdfPg.sig = sig;
  const alive = new Set(fl.map(f => f.path));
  if (!pdfPg.dirty) {
    pdfPg.items = []; pdfPg.known = new Set(); pdfPg.sel.clear(); pdfPg.undo = []; pdfPg.last = -1;
  } else {
    pdfPg.items = pdfPg.items.filter(i => alive.has(i.path));
    for (const k of [...pdfPg.known]) if (!alive.has(k)) pdfPg.known.delete(k);
    const ids = new Set(pdfPg.items.map(i => i.id));
    for (const id of [...pdfPg.sel]) if (!ids.has(id)) pdfPg.sel.delete(id);
  }
  for (const f of fl) {
    if (pdfPg.known.has(f.path)) continue;
    pdfPg.known.add(f.path);
    for (let n = 1; n <= f.info.pages; n++) pdfPg.items.push({id: pdfPg.id++, path: f.path, n, rot: 0});
  }
  for (const k of Object.keys(pgThumbs)) if (!alive.has(k.slice(0, k.lastIndexOf('#')))) delete pgThumbs[k];
  if (pgOpen()) pgRender();
}

// ---------- правая панель ----------
function pdfPgPanel() {
  const pg = pdfSet.pg, n = pdfPg.items.length, nf = pdfPgFiles().length;
  pdfChips('pdfPgMode', pg.mode);
  $('pdfPgChunkRow').classList.toggle('hide', pg.mode !== 'chunk');
  $('pdfPgRangesRow').classList.toggle('hide', pg.mode !== 'ranges');
  if (document.activeElement !== $('pdfPgN')) $('pdfPgN').value = pg.every;
  if (document.activeElement !== $('pdfPgRanges')) $('pdfPgRanges').value = pg.ranges;
  $('pdfPgRanges').classList.toggle('bad', pg.mode === 'ranges' && !!pg.ranges.trim() && !pdfPgParse(pg.ranges, 1e6));
  $('pdfPgModeNote').textContent = t({one: 'pdf.pgNote_one', each: 'pdf.pgNote_each', chunk: 'pdf.pgNote_chunk', ranges: 'pdf.pgNote_ranges'}[pg.mode]);
  $('pdfPgState').textContent = !nf ? t('pdf.pgNoFiles')
    : t(pdfPg.dirty ? 'pdf.pgStateEdited' : 'pdf.pgStateAuto', {n, f: nf});
  const chip = document.querySelector('#pdfPgMode .chip.on')?.textContent || '';
  $('pdfPgSum').textContent = [chip, pg.mode === 'chunk' ? t('pdf.pgEverySum', {n: pg.every}) : pg.mode === 'ranges' && pg.ranges.trim() ? pg.ranges.trim() : '',
    n ? t('pdf.pgPagesSum', {n}) : ''].filter(Boolean).join(' · ');
}
$('pdfPgMode').addEventListener('click', e => {
  const b = e.target.closest('.chip'); if (!b) return;
  pdfSet.pg.mode = b.dataset.v; pdfSave(); pdfRender();
  if (b.dataset.v === 'ranges') $('pdfPgRanges').focus();
  else if (b.dataset.v === 'chunk') $('pdfPgN').focus();
});
$('pdfPgN').addEventListener('input', () => {
  const v = parseInt($('pdfPgN').value, 10);
  if (v >= 1 && v <= 10000) { pdfSet.pg.every = v; pdfSave(); pdfRender(); }
});
$('pdfPgN').addEventListener('blur', () => { $('pdfPgN').value = pdfSet.pg.every; });
$('pdfPgRanges').addEventListener('input', () => { pdfSet.pg.ranges = $('pdfPgRanges').value; pdfSave(); pdfRender(); });
$('pdfPgOpen').onclick = () => pdfPgShow();

// «1-3, 5-7, 9-» → группы позиций [[1,2,3],[5,6,7],[9..total]]; null — не разобрать. Группа вне 1…total пропускается
function pdfPgParse(s, total) {
  const out = [];
  const parts = String(s || '').split(/[,;]+/).map(x => x.trim()).filter(Boolean);
  if (!parts.length) return null;
  for (const p of parts) {
    const m = /^(\d*)\s*[-–—]\s*(\d*)$/.exec(p) || /^(\d+)()$/.exec(p);
    if (!m || (m[1] === '' && m[2] === '')) return null;
    const single = !/[-–—]/.test(p);
    let a = m[1] === '' ? 1 : +m[1], b = single ? a : m[2] === '' ? total : +m[2];
    if (!a || (!single && m[2] !== '' && !b)) return null;
    if (a > b) [a, b] = [b, a];
    const g = [];
    for (let i = Math.max(1, a); i <= Math.min(total, b); i++) g.push(i);
    if (g.length) out.push(g);
  }
  return out;
}

// ---------- план для сервера ----------
// {docs: [{name, pages: [{src, n, rot}]}]} или {error}. Склейка — один файл; остальное режет текущий порядок страниц
function pdfPgPlan() {
  const it = pdfPg.items, pg = pdfSet.pg;
  if (!it.length) return {error: t('pdf.pgEmpty')};
  const ref = i => ({src: i.path, n: i.n, rot: i.rot});
  const width = String(it.length).length, pad = v => String(v).padStart(width, '0');
  const name = (a, b) => {   // a, b — позиции с 1, включительно
    const s = pgStem(it[a - 1].path);
    return a === b ? t('pdf.pgPartOne', {name: s, a: pad(a)}) : t('pdf.pgPartMany', {name: s, a: pad(a), b: pad(b)});
  };
  const doc = (a, b) => ({name: name(a, b), pages: it.slice(a - 1, b).map(ref)});
  if (pg.mode === 'each') return {docs: it.map((_, i) => doc(i + 1, i + 1))};
  if (pg.mode === 'chunk') {
    const k = Math.max(1, +pg.every || 1), docs = [];
    for (let a = 1; a <= it.length; a += k) docs.push(doc(a, Math.min(it.length, a + k - 1)));
    return {docs};
  }
  if (pg.mode === 'ranges') {
    const groups = pdfPgParse(pg.ranges, it.length);
    if (!groups) return {error: t('pdf.pgRangesBad')};
    if (!groups.length) return {error: t('pdf.pgRangesNone', {n: it.length})};
    // номера — места в сетке, а не страницы исходных файлов
    return {docs: groups.map(g => ({name: name(g[0], g[g.length - 1]), pages: g.map(p => ref(it[p - 1]))}))};
  }
  const one = new Set(it.map(i => i.path)).size === 1;
  return {docs: [{name: one ? pgStem(it[0].path) : t('pdf.pgMerged'), pages: it.map(ref)}]};
}

// ---------- окно сетки ----------
function pgColor(path) {
  const k = pdfPgFiles().findIndex(f => f.path === path);
  return PG_COLORS[(k < 0 ? 0 : k) % PG_COLORS.length];
}
async function pdfPgShow() {
  if (!pdfPgFiles().length) { say('warn', t('pdf.pgTitle'), t('pdf.pgNoFiles')); return; }
  try { await pdfjsLoad(); } catch (e) { say('err', t('start.failed'), e.message); return; }
  pdfPgSync();
  $('pdfPg').classList.remove('hide');
  pgRender();
  $('pdfPgGrid').focus();
}
function pgClose() {
  $('pdfPg').classList.add('hide');
  pgQueue.length = 0;
  for (const k in pgDocs) { pgDocs[k].then(d => d.destroy()).catch(() => {}); delete pgDocs[k]; }
  pgEnd();
  pdfRender();
}
$('pdfPgClose').onclick = pgClose;
$('pdfPg').addEventListener('click', e => { if (e.target === $('pdfPg')) pgClose(); });

// миниатюра внутри рамки: повёрнутая страница вписывается заново, поэтому размер считается здесь, а не CSS
function pgThumbHtml(k, rot) {
  const th = pgThumbs[k];
  if (!th) return '<span class="spin"></span>';
  if (th === 'fail') return '<span class="pg-fail">!</span>';
  const swap = rot % 180 !== 0, vw = swap ? th.h : th.w, vh = swap ? th.w : th.h;
  const s = Math.min(PG_BOX.w / vw, PG_BOX.h / vh);
  return `<img src="${th.u}" alt="" draggable="false" style="width:${Math.round(th.w * s)}px;height:${Math.round(th.h * s)}px;transform:translate(-50%,-50%) rotate(${rot}deg)">`;
}
function pgCard(i, idx) {
  const k = i.path + '#' + i.n;
  return `<div class="pg-c${pdfPg.sel.has(i.id) ? ' sel' : ''}" data-id="${i.id}" data-k="${esc(k)}" style="--fc:${pgColor(i.path)}" title="${esc(base(i.path))} · ${t('pdf.pageN', {n: i.n})}">` +
    `<div class="pg-th" data-rot="${i.rot}">${pgThumbHtml(k, i.rot)}</div>` +
    `<div class="pg-l"><b>${idx + 1}</b><span>${esc(base(i.path))} · ${i.n}</span></div></div>`;
}
function pgRender() {
  if (!pgOpen()) return;
  const g = $('pdfPgGrid'), top = g.scrollTop;
  g.innerHTML = pdfPg.items.length ? pdfPg.items.map(pgCard).join('') : `<div class="pg-none">${t('pdf.pgEmpty')}</div>`;
  g.scrollTop = top;
  pgWatch();
  pgCounts();
}
function pgCounts() {
  const n = pdfPg.items.length, s = pdfPg.sel.size;
  $('pdfPgCnt').textContent = t('pdf.pgCnt', {n, s});
  for (const id of ['pdfPgRotL', 'pdfPgRotR', 'pdfPgDup', 'pdfPgDel', 'pdfPgBack', 'pdfPgFwd']) $(id).disabled = !s;
  $('pdfPgKeep').disabled = !s || s === n;
  $('pdfPgAll').disabled = !n || s === n;
  $('pdfPgNone').disabled = !s;
  $('pdfPgUndo').disabled = !pdfPg.undo.length;
  $('pdfPgReset').disabled = !pdfPg.dirty;
}

// ---------- миниатюры: рисуются по мере появления в окне ----------
const pgQueue = [];
let pgBusy = 0, pgObs = null;
function pgWatch() {
  if (pgObs) pgObs.disconnect();
  pgObs = new IntersectionObserver(es => {
    for (const e of es) {
      if (!e.isIntersecting) continue;
      pgObs.unobserve(e.target);
      const k = e.target.dataset.k;
      if (!pgThumbs[k] && !pgQueue.includes(k)) pgQueue.push(k);
    }
    pgPump();
  }, {root: $('pdfPgGrid'), rootMargin: '300px 0px'});
  $('pdfPgGrid').querySelectorAll('.pg-c').forEach(c => { if (!pgThumbs[c.dataset.k]) pgObs.observe(c); });
}
function pgDoc(path) {
  if (!pgDocs[path]) pgDocs[path] = pdfDoc(path, $('pdfPass').value);
  return pgDocs[path];
}
async function pgPump() {
  while (pgBusy < 2 && pgQueue.length && pgOpen()) {
    const k = pgQueue.shift();
    if (pgThumbs[k]) continue;
    pgBusy++;
    pgMake(k).finally(() => { pgBusy--; pgPump(); });
  }
}
async function pgMake(k) {
  const cut = k.lastIndexOf('#'), path = k.slice(0, cut), n = +k.slice(cut + 1);
  try {
    const doc = await pgDoc(path);
    if (!pgOpen()) return;
    const page = await doc.getPage(n), vp = page.getViewport({scale: 1});
    page.cleanup();
    // в 1,6 раза чётче рамки: на экране с масштабом остаётся резко
    const cv = await pdfDrawPage(doc, n, Math.min(PG_BOX.w / vp.width, PG_BOX.h / vp.height) * 1.6, false);
    pgThumbs[k] = {u: cv.toDataURL('image/jpeg', 0.8), w: cv.width, h: cv.height};
    cv.width = cv.height = 0;
  } catch (e) { pgThumbs[k] = 'fail'; }
  if (!pgOpen()) return;
  $('pdfPgGrid').querySelectorAll('.pg-c').forEach(c => {
    if (c.dataset.k === k) c.querySelector('.pg-th').innerHTML = pgThumbHtml(k, +c.querySelector('.pg-th').dataset.rot);
  });
}

// ---------- правки ----------
function pgSnap() {
  pdfPg.undo.push({items: pdfPg.items.map(i => ({...i})), sel: [...pdfPg.sel], dirty: pdfPg.dirty});
  if (pdfPg.undo.length > 60) pdfPg.undo.shift();
}
function pgEdit(fn) {
  if (!pdfPg.sel.size && fn.needSel) return;
  pgSnap();
  fn();
  pdfPg.dirty = true;
  pgRender();
  pdfPgPanel();
}
const selIdx = () => pdfPg.items.map((i, k) => pdfPg.sel.has(i.id) ? k : -1).filter(k => k >= 0);
function pgRotate(d) {
  const f = () => {
    for (const i of pdfPg.items) if (pdfPg.sel.has(i.id)) i.rot = (i.rot + d + 360) % 360;
  };
  f.needSel = true;
  pgEdit(f);
}
function pgDelete() {
  const f = () => { pdfPg.items = pdfPg.items.filter(i => !pdfPg.sel.has(i.id)); pdfPg.sel.clear(); pdfPg.last = -1; };
  f.needSel = true;
  pgEdit(f);
}
function pgKeep() {
  if (!pdfPg.sel.size || pdfPg.sel.size === pdfPg.items.length) return;
  pgEdit(() => { pdfPg.items = pdfPg.items.filter(i => pdfPg.sel.has(i.id)); pdfPg.last = -1; });
}
function pgDup() {
  const f = () => {
    const out = [], copies = new Set();
    for (const i of pdfPg.items) {
      out.push(i);
      if (pdfPg.sel.has(i.id)) { const c = {...i, id: pdfPg.id++}; out.push(c); copies.add(c.id); }
    }
    pdfPg.items = out;
    pdfPg.sel = copies;   // дальше удобнее работать с копиями: повернуть, унести
  };
  f.needSel = true;
  pgEdit(f);
}
// на шаг влево или вправо; выбранные идут вместе, упираясь в край
function pgShift(d) {
  const f = () => {
    const a = pdfPg.items, sel = i => pdfPg.sel.has(a[i].id);
    if (d < 0) { for (let i = 1; i < a.length; i++) if (sel(i) && !sel(i - 1)) [a[i - 1], a[i]] = [a[i], a[i - 1]]; }
    else { for (let i = a.length - 2; i >= 0; i--) if (sel(i) && !sel(i + 1)) [a[i + 1], a[i]] = [a[i], a[i + 1]]; }
  };
  f.needSel = true;
  pgEdit(f);
}
function pgUndo() {
  const s = pdfPg.undo.pop(); if (!s) return;
  pdfPg.items = s.items; pdfPg.sel = new Set(s.sel); pdfPg.dirty = s.dirty;
  pgRender();
  pdfPgPanel();
}
function pgReset() {
  pdfPg.dirty = false; pdfPg.sig = ''; pdfPg.undo = [];
  pdfPgSync();
  pgRender();
  pdfPgPanel();
}
$('pdfPgAll').onclick = () => { pdfPg.sel = new Set(pdfPg.items.map(i => i.id)); pgMark(); };
$('pdfPgNone').onclick = () => { pdfPg.sel.clear(); pgMark(); };
$('pdfPgRotL').onclick = () => pgRotate(-90);
$('pdfPgRotR').onclick = () => pgRotate(90);
$('pdfPgDup').onclick = pgDup;
$('pdfPgDel').onclick = pgDelete;
$('pdfPgKeep').onclick = pgKeep;
$('pdfPgBack').onclick = () => pgShift(-1);
$('pdfPgFwd').onclick = () => pgShift(1);
$('pdfPgUndo').onclick = pgUndo;
$('pdfPgReset').onclick = pgReset;

// выбор без перерисовки: меняются только рамки
function pgMark() {
  $('pdfPgGrid').querySelectorAll('.pg-c').forEach(c => c.classList.toggle('sel', pdfPg.sel.has(+c.dataset.id)));
  pgCounts();
}
// щелчок выбирает или снимает, Shift тянет выбор от прошлой страницы
function pgPick(card, shift) {
  const idx = pdfPg.items.findIndex(i => i.id === +card.dataset.id);
  if (idx < 0) return;
  if (shift && pdfPg.last >= 0) {
    const [a, b] = [Math.min(pdfPg.last, idx), Math.max(pdfPg.last, idx)];
    for (let k = a; k <= b; k++) pdfPg.sel.add(pdfPg.items[k].id);
  } else {
    const id = pdfPg.items[idx].id;
    if (pdfPg.sel.has(id)) pdfPg.sel.delete(id); else pdfPg.sel.add(id);
    pdfPg.last = idx;
  }
  pgMark();
}

// ---------- перетаскивание страниц ----------
// Карточка идёт за курсором, между страницами светится полоска-место. Берёшь выбранную — несёшь все выбранные.
// Окно не принимает HTML5-перетаскивание (drop.js), поэтому на событиях указателя, как очередь в плеере.
let pgDrag = null;
function pgEnd() {
  if (pgDrag) { pgDrag.ghost?.remove(); pgDrag.mark?.remove(); cancelAnimationFrame(pgDrag.raf); pgDrag = null; }
  $('pdfPgGrid').classList.remove('pg-moving');
  $('pdfPgGrid').querySelectorAll('.pg-lift').forEach(c => c.classList.remove('pg-lift'));
}
// место вставки: индекс «перед какой карточкой» (в списке без переносимых) по положению указателя
function pgSlot(x, y) {
  const cards = [...$('pdfPgGrid').querySelectorAll('.pg-c')].filter(c => !c.classList.contains('pg-lift'));
  let best = null, bd = 1e9;
  for (const [k, c] of cards.entries()) {
    const r = c.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const d = Math.hypot(x - cx, (y - cy) * 1.6);
    if (d < bd) { bd = d; best = {k, c, after: x > cx, r}; }
  }
  if (!best) return {k: 0, x: 0, y: 0, h: 0};
  const idx = best.after ? best.k + 1 : best.k;
  return {k: idx, x: best.after ? best.r.right : best.r.left, y: best.r.top, h: best.r.height};
}
function pgGhostMove() {
  const d = pgDrag, g = $('pdfPgGrid').getBoundingClientRect();
  d.ghost.style.transform = `translate(${d.x - d.dx}px,${d.y - d.dy}px) rotate(2deg)`;
  // у верхнего и нижнего края окно прокручивается
  const edge = 46;
  if (d.y < g.top + edge) $('pdfPgGrid').scrollTop -= Math.min(18, (g.top + edge - d.y) / 2);
  else if (d.y > g.bottom - edge) $('pdfPgGrid').scrollTop += Math.min(18, (d.y - g.bottom + edge) / 2);
  d.slot = pgSlot(d.x, d.y);
  const m = d.mark, s = d.slot;
  m.style.left = (s.x - g.left + $('pdfPgGrid').scrollLeft - 2) + 'px';
  m.style.top = (s.y - g.top + $('pdfPgGrid').scrollTop) + 'px';
  m.style.height = s.h + 'px';
  d.raf = requestAnimationFrame(pgGhostMove);
}
$('pdfPgGrid').addEventListener('pointerdown', e => {
  const card = e.target.closest('.pg-c');
  if (!card || e.button !== 0 || pgDrag) return;
  pgDrag = {card, id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, on: false};
});
window.addEventListener('pointermove', e => {
  const d = pgDrag; if (!d || e.pointerId !== d.id) return;
  d.x = e.clientX; d.y = e.clientY;
  if (d.on || Math.hypot(d.x - d.x0, d.y - d.y0) < 6) return;
  // начали тащить: невыбранную карточку берём одну, выбранную — всех выбранных
  const id = +d.card.dataset.id, grid = $('pdfPgGrid');
  d.ids = pdfPg.sel.has(id) ? new Set(pdfPg.sel) : new Set([id]);
  d.on = true;
  const r = d.card.getBoundingClientRect();
  d.dx = d.x0 - r.left; d.dy = d.y0 - r.top;
  d.ghost = d.card.cloneNode(true);
  d.ghost.classList.add('pg-ghost');
  d.ghost.style.cssText = `width:${r.width}px;left:0;top:0;`;
  if (d.ids.size > 1) d.ghost.insertAdjacentHTML('beforeend', `<span class="pg-badge">${d.ids.size}</span>`);
  document.body.appendChild(d.ghost);
  d.mark = document.createElement('i');
  d.mark.className = 'pg-ins';
  grid.appendChild(d.mark);
  grid.classList.add('pg-moving');
  grid.querySelectorAll('.pg-c').forEach(c => { if (d.ids.has(+c.dataset.id)) c.classList.add('pg-lift'); });
  d.raf = requestAnimationFrame(pgGhostMove);
});
const pgDrop = cancel => {
  const d = pgDrag; if (!d) return;
  if (!d.on) { pgDrag = null; return; }
  const ids = d.ids, k = d.slot ? d.slot.k : -1;
  pgEnd();
  // клик после перетаскивания не должен ничего выбирать
  const swallow = ev => { ev.stopPropagation(); ev.preventDefault(); };
  window.addEventListener('click', swallow, {capture: true, once: true});
  setTimeout(() => window.removeEventListener('click', swallow, true), 100);
  if (cancel || k < 0) return;
  const rest = pdfPg.items.filter(i => !ids.has(i.id)), moved = pdfPg.items.filter(i => ids.has(i.id));
  const next = [...rest.slice(0, k), ...moved, ...rest.slice(k)];
  if (next.every((i, n) => i === pdfPg.items[n])) return;
  pgSnap();
  pdfPg.items = next;
  pdfPg.sel = new Set(ids);
  pdfPg.dirty = true;
  pgRender();
  pdfPgPanel();
};
window.addEventListener('pointerup', e => { if (pgDrag && e.pointerId === pgDrag.id) pgDrop(false); });
window.addEventListener('pointercancel', e => { if (pgDrag && e.pointerId === pgDrag.id) pgDrop(true); });
window.addEventListener('blur', () => pgDrop(true));

$('pdfPgGrid').addEventListener('click', e => {
  const card = e.target.closest('.pg-c');
  if (card) pgPick(card, e.shiftKey);
  else if (e.target === $('pdfPgGrid')) { pdfPg.sel.clear(); pgMark(); }
});
document.addEventListener('keydown', e => {
  if (!pgOpen()) return;
  const k = e.key, ctrl = e.ctrlKey || e.metaKey;
  if (k === 'Escape') { if (pgDrag && pgDrag.on) pgDrop(true); else pgClose(); }
  else if (ctrl && k.toLowerCase() === 'a') { $('pdfPgAll').click(); }
  else if (ctrl && k.toLowerCase() === 'z') { pgUndo(); }
  else if (ctrl && k.toLowerCase() === 'd') { pgDup(); }
  else if (k === 'Delete' || k === 'Backspace') { pgDelete(); }
  else if (!ctrl && e.code === 'KeyR') { pgRotate(e.shiftKey ? -90 : 90); }
  else if (e.altKey && k === 'ArrowLeft') { pgShift(-1); }
  else if (e.altKey && k === 'ArrowRight') { pgShift(1); }
  else return;
  e.preventDefault();
  e.stopPropagation();
}, true);
