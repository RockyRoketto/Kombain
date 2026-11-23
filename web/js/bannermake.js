// ---------- «Сборка баннеров» в «Утилитах»: одна картинка на все шаблоны (bannermake.go) ----------
// Результат: <общая папка>\<месяц>\<день>\<матч>\png|jpeg|webp. Месяц и день двумя цифрами.
let bmSlots = [];          // [{name, w, h, x, y, s}] из /api/bmk-list: шаблон и квадрат под картинку
let bmImg = null;          // {name, blob: PNG уже без прозрачных полей, url: ссылка на blob для плиток, w, h}
let bmBusy = false;
let bmAbort = null;        // «Стоп»: обрыв запроса текущего баннера
const bmSt = {};           // имя баннера -> {st: run | ok | error, msg}
let bmChk = {};            // ответ /api/bmk-check
const BM_KEY = 'k9000.bmk';

// как bmkFit в Go: картинка вписана в квадрат слота по центру, потом правка adj {k, dx, dy}; в процентах от шаблона
function bmFit(sl, aw, ah, adj = BM_ID) {
  let w = sl.s, h = sl.s;
  if (aw >= ah) h = ah * sl.s / aw; else w = aw * sl.s / ah;
  w = Math.max(1, Math.round(w * adj.k)); h = Math.max(1, Math.round(h * adj.k));
  const x = Math.round(sl.x + sl.s / 2 + adj.dx * sl.s - w / 2), y = Math.round(sl.y + sl.s / 2 + adj.dy * sl.s - h / 2);
  return {l: x / sl.w * 100, t: y / sl.h * 100, w: w / sl.w * 100, h: h / sl.h * 100};
}
const bmPad = n => String(n).padStart(2, '0');

// ---------- картинка ----------
// прозрачные поля срезаем сразу: в шаблоне квадрат занимает сама картинка, а не её пустые края
async function bmTake(file) {
  if (!file) return;
  if (!/^image\/(png|jpeg|webp|gif|bmp)$/.test(file.type) && !/\.(png|jpe?g|webp)$/i.test(file.name || '')) {
    say('warn', t('drop.notSuitableTitle'), t('bm.badType')); return;
  }
  try {
    const url = URL.createObjectURL(file);
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    URL.revokeObjectURL(url);
    const W = img.naturalWidth, H = img.naturalHeight;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d', {willReadFrequently: true}); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, W, H).data;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (d[(y * W + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < 0) { x0 = 0; y0 = 0; x1 = W - 1; y1 = H - 1; }   // совсем прозрачная: как есть
    const o = document.createElement('canvas'); o.width = x1 - x0 + 1; o.height = y1 - y0 + 1;
    o.getContext('2d').drawImage(c, x0, y0, o.width, o.height, 0, 0, o.width, o.height);
    const blob = await new Promise(res => o.toBlob(res, 'image/png'));
    if (!blob) throw new Error('png');
    bmDropImg();
    bmImg = {name: file.name || 'image.png', blob, url: URL.createObjectURL(blob), w: o.width, h: o.height, trimmed: o.width !== W || o.height !== H};
    Object.keys(bmSt).forEach(k => delete bmSt[k]);
    bmResetAdj();
    bmRender();
  } catch (e) { toast({type: 'warn', title: t('drop.notSuitableTitle'), text: t('bm.badFile', {name: esc(file.name || '')}), ttl: 7000}); }
}
// перетаскивание (вызывает drop.js): нужен сам файл в окне, путь на диске не нужен
function bmDrop(e) {
  const f = [...(e.dataTransfer.files || [])][0];
  if (f && !bmBusy) bmTake(f);
}
$('bmPick').onclick = () => dialog(async () => {
  if (bmBusy) return;
  const r = await api('pick-files');
  if (r.error) { say('warn', t('warn.title'), r.error); return; }
  const p = r.files && r.files[0] && r.files[0].path;
  if (!p) return;
  const x = await api('fav-read', {path: p});   // тот же читатель, что у «Фавиконов»
  if (x.error) { say('warn', t('drop.notSuitableTitle'), x.error); return; }
  const bin = atob(x.data), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const ext = x.name.split('.').pop().toLowerCase();
  await bmTake(new File([u8], x.name, {type: ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'}));
});
const bmDropImg = () => { if (bmImg) URL.revokeObjectURL(bmImg.url); bmImg = null; };
$('bmClear').onclick = () => { if (!bmBusy) { bmDropImg(); bmResetAdj(); Object.keys(bmSt).forEach(k => delete bmSt[k]); bmRender(); } };
// Ctrl+V: картинка из буфера; в поле ввода с текстом в буфере — обычная вставка
document.addEventListener('paste', e => {
  if (tab !== 'bmake' || bmBusy || document.querySelector('.modal:not(.hide)')) return;
  const cd = e.clipboardData; if (!cd) return;
  const f = [...cd.files].find(f => /^image\//.test(f.type));
  if (!f) return;
  if (e.target.closest && e.target.closest('input, textarea') && cd.getData('text/plain')) return;
  e.preventDefault();
  bmTake(f);
});

// ---------- куда ----------
function bmFillDate() {
  const now = new Date(), ms = $('bmMonth'), fmt = new Intl.DateTimeFormat(lang === 'ru' ? 'ru' : 'en', {month: 'long'});
  ms.innerHTML = Array.from({length: 12}, (_, i) => {
    const n = fmt.format(new Date(2024, i, 1));
    return `<option value="${i + 1}">${bmPad(i + 1)} · ${esc(n[0].toUpperCase() + n.slice(1))}</option>`;
  }).join('');
  ms.value = now.getMonth() + 1;
  bmFillDays(now.getDate());
}
function bmFillDays(keep) {
  const m = +$('bmMonth').value, n = m === 2 ? 29 : [4, 6, 9, 11].includes(m) ? 30 : 31;
  const cur = Math.min(keep || +$('bmDay').value || 1, n);
  $('bmDay').innerHTML = Array.from({length: n}, (_, i) => `<option value="${i + 1}">${bmPad(i + 1)}</option>`).join('');
  $('bmDay').value = cur;
}
const bmReq = () => ({root: $('bmRoot').value.trim(), month: +$('bmMonth').value, day: +$('bmDay').value, match: $('bmMatch').value});
let bmChkT = 0, bmChkN = 0;
function bmCheckSoon() { clearTimeout(bmChkT); bmChkT = setTimeout(bmCheck, 250); }
async function bmCheck() {
  const n = ++bmChkN, r = await api('bmk-check', bmReq());
  if (n !== bmChkN) return;   // пока ждали, поле уже поменяли
  bmChk = r || {};
  bmRenderPath();
}
// путь и что из папок уже есть
function bmRenderPath() {
  const q = bmReq(), c = bmChk, mm = bmPad(q.month), dd = bmPad(q.day);
  const st = ok => `<i class="${ok ? 'have' : 'new'}">${t(ok ? 'bm.have' : 'bm.new')}</i>`;
  let h = '';
  if (!q.root) h = t('bm.noRoot');
  else if (!c.rootOk) h = `<span class="warn">${t('bm.rootMissing')}</span>`;
  else {
    h = `<div class="bm-tree">` +
      `<div>${esc(q.root)}</div>` +
      `<div class="l1">${mm} ${st(c.monthOk)}</div>` +
      `<div class="l2">${dd} ${st(c.dayOk)}</div>` +
      (c.matchName ? `<div class="l3">${esc(c.matchName)} ${c.matchOk ? `<i class="warn">${t('bm.replace')}</i>` : st(false)}</div>` +
        `<div class="l4">png · jpeg · webp</div>` : `<div class="l3 dim">${t('bm.noMatch')}</div>`) + '</div>';
    if (c.others && c.others.length) h += `<div class="bm-others">${t('bm.others', {n: c.others.length})} ${c.others.map(esc).join(', ')}</div>`;
  }
  if ($('bmPath').innerHTML !== h) $('bmPath').innerHTML = h;
}
try {
  const o = JSON.parse(localStorage.getItem(BM_KEY) || 'null');
  if (o && typeof o.root === 'string') $('bmRoot').value = o.root;
} catch (e) {}
const bmSave = () => { try { localStorage.setItem(BM_KEY, JSON.stringify({root: $('bmRoot').value.trim()})); } catch (e) {} };
$('bmRoot').addEventListener('input', () => { bmSave(); bmCheckSoon(); });
$('bmMatch').addEventListener('input', bmCheckSoon);
$('bmMatch').addEventListener('keydown', e => { if (e.key === 'Enter') bmRun(); });
$('bmMonth').addEventListener('change', () => { bmFillDays(); bmCheck(); });
$('bmDay').addEventListener('change', bmCheck);
$('bmPickRoot').onclick = () => dialog(async () => {
  const r = await api('pick-folder', {purpose: 'out'});
  if (r.error) alert(r.error);
  if (r.path) { $('bmRoot').value = r.path; bmSave(); bmCheck(); }
});


// ---------- редактор: размер и сдвиг ----------
// Общая правка bmAll действует на все баннеры, своя bmOne[имя] — поверх неё (размер множится, сдвиг складывается).
// Сдвиг в долях стороны квадрата: на всех баннерах он выглядит одинаково.
const BM_ID = {k: 1, dx: 0, dy: 0};
let bmAll = {...BM_ID};
let bmOne = {};
let bmSel = '';            // выбранный баннер: правка только его; '' — правка всех
const bmIsId = a => !a || (Math.abs(a.k - 1) < 1e-3 && Math.abs(a.dx) < 1e-3 && Math.abs(a.dy) < 1e-3);
function bmAdj(name) {
  const o = bmOne[name] || BM_ID;
  return {k: bmAll.k * o.k, dx: bmAll.dx + o.dx, dy: bmAll.dy + o.dy};
}
const bmCur = () => bmSel ? (bmOne[bmSel] = bmOne[bmSel] || {...BM_ID}) : bmAll;
function bmSet(ch) {
  const a = bmCur();
  if ('k' in ch) a.k = Math.min(Math.max(ch.k, 0.2), 3);
  if ('dx' in ch) a.dx = Math.min(Math.max(ch.dx, -2), 2);
  if ('dy' in ch) a.dy = Math.min(Math.max(ch.dy, -2), 2);
  bmPlace(); bmEditSync();
}
function bmResetAdj() {
  for (const k in bmOne) delete bmOne[k];
  bmAll = {...BM_ID}; bmSel = '';
}
// панель «Положение»: на что действует правка и её значения
function bmEditSync() {
  const a = bmCur(), on = !!bmImg && !bmBusy;
  document.querySelectorAll('#bmTarget .segb').forEach(b => b.classList.toggle('on', (b.dataset.m === 'one') === !!bmSel));
  $('bmSelName').textContent = bmSel || t('bm.tOne');
  $('bmK').value = Math.round(a.k * 100);
  $('bmKv').textContent = Math.round(a.k * 100) + '%';
  $('bmK').disabled = $('bmCenter').disabled = $('bmReset').disabled = !on;
  document.querySelectorAll('#bmTarget .segb').forEach(b => { b.disabled = !on; });
  document.querySelectorAll('#bmGrid .bm-t').forEach(f => {
    f.classList.toggle('sel', f.dataset.n === bmSel);
    f.classList.toggle('own', !bmIsId(bmOne[f.dataset.n]));
  });
}
// положение картинки на плитках без перерисовки списка (её дёргает каждое движение мыши)
function bmPlace() {
  if (!bmImg) return;
  document.querySelectorAll('#bmGrid .bm-t').forEach(f => {
    const sl = bmSlots.find(s => s.name === f.dataset.n), art = f.querySelector('.art');
    if (!sl || !art) return;
    const p = bmFit(sl, bmImg.w, bmImg.h, bmAdj(sl.name));
    art.style.cssText = `left:${p.l}%;top:${p.t}%;width:${p.w}%;height:${p.h}%`;
  });
}
$('bmK').addEventListener('input', () => bmSet({k: +$('bmK').value / 100}));
$('bmCenter').onclick = () => bmSet({dx: 0, dy: 0});
$('bmReset').onclick = () => { if (bmSel) delete bmOne[bmSel]; else bmAll = {...BM_ID}; bmPlace(); bmEditSync(); };
$('bmTarget').addEventListener('click', e => {
  const b = e.target.closest('.segb'); if (!b || b.disabled) return;
  if (b.dataset.m === 'all') bmSel = '';
  else if (!bmSel) { say('info', t('bm.edit'), t('bm.pickOne')); return; }
  bmEditSync();
});
// мышью по плитке: тянуть — сдвиг, щелчок — выбрать этот баннер (правка только его)
let bmDrag = null;
$('bmGrid').addEventListener('pointerdown', e => {
  const box = e.target.closest('.bm-img'), f = box && box.closest('.bm-t');
  if (!f || bmBusy || e.button !== 0) return;
  e.preventDefault();
  const sl = bmSlots.find(s => s.name === f.dataset.n);
  if (bmSel && bmSel !== sl.name) { bmSel = sl.name; bmEditSync(); }   // выбран другой: теперь правим этот
  const a = bmCur();
  bmDrag = {x: e.clientX, y: e.clientY, dx: a.dx, dy: a.dy, side: sl.s / sl.w * box.clientWidth, name: sl.name, moved: false};
  box.setPointerCapture(e.pointerId);
});
$('bmGrid').addEventListener('pointermove', e => {
  if (!bmDrag) return;
  const mx = e.clientX - bmDrag.x, my = e.clientY - bmDrag.y;
  if (!bmDrag.moved && Math.hypot(mx, my) < 3) return;
  bmDrag.moved = true;
  bmSet({dx: bmDrag.dx + mx / bmDrag.side, dy: bmDrag.dy + my / bmDrag.side});
});
const bmDragEnd = () => {
  if (!bmDrag) return;
  if (!bmDrag.moved) { bmSel = bmSel === bmDrag.name ? '' : bmDrag.name; bmEditSync(); }   // щелчок по выбранному снимает выбор
  bmDrag = null;
};
$('bmGrid').addEventListener('pointerup', bmDragEnd);
$('bmGrid').addEventListener('pointercancel', bmDragEnd);
// стрелки двигают (с Shift крупнее), + и − меняют размер, Esc снимает выбор
document.addEventListener('keydown', e => {
  if (tab !== 'bmake' || !bmImg || bmBusy || e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable]') || document.querySelector('.modal:not(.hide)')) return;
  const st = e.shiftKey ? 0.05 : 0.01, a = bmCur();
  const m = {ArrowLeft: {dx: a.dx - st}, ArrowRight: {dx: a.dx + st}, ArrowUp: {dy: a.dy - st}, ArrowDown: {dy: a.dy + st},
    '+': {k: a.k * 1.02}, '=': {k: a.k * 1.02}, '-': {k: a.k / 1.02}}[e.key];
  if (m) { e.preventDefault(); bmSet(m); }
  else if (e.key === 'Escape' && bmSel) { bmSel = ''; bmEditSync(); }
});
// ---------- вид ----------
function bmRender() {
  const has = !!bmImg;
  $('bmEmpty').classList.toggle('hide', has);
  $('bmGrid').classList.toggle('hide', !has);
  $('bmCnt').textContent = has ? `${bmImg.name} · ${bmImg.w}×${bmImg.h}` + (bmImg.trimmed ? ' · ' + t('bm.trimmed') : '') : '';
  $('bmPick').disabled = $('bmClear').disabled = $('bmRoot').disabled = $('bmPickRoot').disabled = $('bmMonth').disabled = $('bmDay').disabled = $('bmMatch').disabled = bmBusy;
  if (has) {
    const html = bmSlots.map(sl => {
      const s = bmSt[sl.name] || {};
      const pill = s.st === 'run' ? '<span class="spin"></span>' : s.st === 'ok' ? '✓' : s.st === 'error' ? '!' : '';
      // ширина по высоте ряда, но не шире поля; подпись под баннером, не меньше 130 px. Положение картинки ставит bmPlace
      return `<figure class="bm-t ${s.st || ''}" data-n="${esc(sl.name)}" style="width:max(130px, min(100%, calc(var(--bm-h) * ${(sl.w / sl.h).toFixed(4)})))" title="${esc(s.msg || sl.name)}">` +
        `<div class="bm-img" style="aspect-ratio:${sl.w}/${sl.h};max-width:calc(var(--bm-h) * ${(sl.w / sl.h).toFixed(4)})">` +
        `<img class="bg" src="/bannerbg/${sl.name}.png" alt="" draggable="false">` +
        `<img class="art" src="${bmImg.url}" alt="" draggable="false"></div>` +
        `<figcaption><b>${esc(sl.name)}</b>${sl.site ? '' : `<span class="tag" title="${t('bm.pngOnlyHint')}">${t('bm.pngOnly')}</span>`}<em>${t('bm.own')}</em><i>${pill}</i></figcaption>` +
        `${s.msg ? `<span class="bm-msg">${esc(s.msg)}</span>` : ''}</figure>`;
    }).join('');
    if ($('bmGrid').dataset.k !== html) { $('bmGrid').innerHTML = html; $('bmGrid').dataset.k = html; }
    bmPlace();
  }
  bmEditSync();
  updateButtons();
}

// ---------- сборка ----------
async function bmRun() {
  if (bmBusy || snap.running) return;
  if (!bmImg) { say('warn', t('start.emptyTitle'), t('bm.needImg')); return; }
  const q = bmReq();
  if (!q.root) { say('warn', t('start.whereTitle'), t('bm.noRoot')); return; }
  if (!q.match.trim()) { say('warn', t('start.whereTitle'), t('bm.noMatch')); $('bmMatch').focus(); return; }
  bmBusy = true; bmAbort = new AbortController();
  Object.keys(bmSt).forEach(k => delete bmSt[k]);
  bmRender();
  const b64 = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = () => res(''); fr.readAsDataURL(bmImg.blob); });
  const b = await api('bmk-begin', Object.assign({image: b64}, q));
  if (b.error) { bmBusy = false; bmAbort = null; bmRender(); say('warn', t('bm.failTitle'), esc(b.error)); return; }
  let done = 0, fail = 0, stopped = false;
  for (const sl of bmSlots) {
    bmSt[sl.name] = {st: 'run'}; bmRender();
    const r = await api('bmk-one', {id: b.id, name: sl.name, adj: bmAdj(sl.name)}, bmAbort.signal);
    if (r.aborted) { delete bmSt[sl.name]; stopped = true; break; }
    if (r.error) { bmSt[sl.name] = {st: 'error', msg: r.error}; fail++; }
    else {
      const big = (r.jpgBig ? ' · ' + t('bm.jpgBig') : '') + (r.webpBig ? ' · ' + t('bm.webpBig') : '');
      bmSt[sl.name] = {st: 'ok', msg: `PNG ${fmtSize(r.png)}` + (r.jpg ? ` · JPG ${fmtSize(r.jpg)} · WebP ${fmtSize(r.webp)}` : '') + big};
      done++;
    }
    bmRender();
  }
  bmBusy = false; bmAbort = null; bmRender(); bmCheck();
  const open = async () => { const r = await api('open-dir', {path: b.dir}); if (r.error) say('warn', t('folder.title'), r.error); };
  const first = bmSlots.map(s => bmSt[s.name]).find(s => s && s.st === 'error');
  toast({id: 'done', type: fail ? 'err' : stopped ? 'warn' : 'ok',
    title: stopped ? t('done.stopped') : t('bm.doneTitle', {n: done}),
    text: esc(b.dir) + (first ? '<br>' + esc(first.msg) : ''),
    actions: done ? [{t: t('btn.openFolder'), primary: true, keep: true, fn: open}] : [],
    ttl: fail ? 0 : 15000});
}
$('bmStart').onclick = bmRun;
$('bmStop').onclick = () => { if (bmAbort) bmAbort.abort(); };

// при первом показе вкладки: шаблоны и дата
let bmReady = false;
async function bmShow() {
  if (bmReady) return;
  bmReady = true;
  bmFillDate();
  const r = await api('bmk-list');
  bmSlots = r.slots || [];
  bmRender();
  bmCheck();
}
