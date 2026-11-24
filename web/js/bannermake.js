// ---------- «Сборка баннеров» в «Утилитах»: одна картинка на все шаблоны (bannermake.go) ----------
// Результат: <общая папка>\<месяц>\<день>\<матч>\png|jpeg|webp. Месяц и день двумя цифрами.
let bmSlots = [];          // [{name, w, h, x, y, zw, zh}] из /api/bmk-list: шаблон и сейв-зона под картинку
let bmImg = null;          // {name, blob: PNG уже без прозрачных полей, url: ссылка на blob для плиток, w, h}
let bmBusy = false;
let bmAbort = null;        // «Стоп»: обрыв запроса текущего баннера
const bmSt = {};           // имя баннера -> {st: run | ok | error, msg}
let bmChk = {};            // ответ /api/bmk-check
const BM_KEY = 'k9000.bmk';

// середина сейв-зоны в пикселях шаблона; сдвиг dx и dy считается в долях ширины и высоты зоны
const bmZx = sl => sl.x + sl.zw / 2, bmZy = sl => sl.y + sl.zh / 2;
// картинка aw×ah вписана в сейв-зону слота по центру, потом правка adj {k, dx, dy}; в пикселях шаблона
function bmFitPx(sl, aw, ah, adj = BM_ID) {
  const z = Math.min(sl.zw / aw, sl.zh / ah);
  const w = Math.max(1, Math.round(aw * z * adj.k)), h = Math.max(1, Math.round(ah * z * adj.k));
  return {x: Math.round(bmZx(sl) + adj.dx * sl.zw - w / 2), y: Math.round(bmZy(sl) + adj.dy * sl.zh - h / 2), w, h};
}
// то же в процентах от шаблона
function bmFit(sl, aw, ah, adj = BM_ID) {
  const r = bmFitPx(sl, aw, ah, adj);
  return {l: r.x / sl.w * 100, t: r.y / sl.h * 100, w: r.w / sl.w * 100, h: r.h / sl.h * 100};
}
const bmPad = n => String(n).padStart(2, '0');

// ---------- картинка ----------
// прозрачные поля срезаем сразу: в сейв-зону вписывается сама картинка, а не её пустые края
async function bmTake(file) {
  if (!file) return;
  if (!/^image\/(png|jpeg|webp|gif|bmp)$/.test(file.type) && !/\.(png|jpe?g|webp)$/i.test(file.name || '')) {
    say('warn', t('drop.notSuitableTitle'), t('bm.badType')); return;
  }
  try {
    const url = URL.createObjectURL(file);
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    URL.revokeObjectURL(url);
    const o = bmTrimCanvas(img);   // bannerfx.js
    const blob = await new Promise(res => o.cv.toBlob(res, 'image/png'));
    if (!blob) throw new Error('png');
    bmDropImg();
    bmImg = {name: file.name || 'image.png', url: URL.createObjectURL(blob), cv: o.cv, w: o.w, h: o.h, trimmed: o.trimmed};
    Object.keys(bmSt).forEach(k => delete bmSt[k]);
    bmResetAdj();
    bmFxNewArt();   // до отрисовки: старый спрайт эффектов от прошлой картинки
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
$('bmClear').onclick = () => { if (!bmBusy) { bmDropImg(); bmResetAdj(); Object.keys(bmSt).forEach(k => delete bmSt[k]); bmFxNewArt(); bmRender(); } };
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
  bmDateText();
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
// путь и что из папок уже есть: древо со значками папок и плашками «есть / создам / заменятся» — в подсказке «?»
// у «Куда сохранить»; в самой панели только то, что требует действия: нет папки, папки не существует, файлы заменятся
const BM_DIR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.3l2 2.2h8.7A1.5 1.5 0 0 1 21 9.7v8.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/></svg>';
function bmRenderPath() {
  const q = bmReq(), c = bmChk, mm = bmPad(q.month), dd = bmPad(q.day);
  const pill = ok => `<em class="bm-pl ${ok ? 'have' : 'new'}">${t(ok ? 'bm.have' : 'bm.new')}</em>`;
  const row = (d, cls, name, tail) => `<div class="bm-tn d${d} ${cls}"><span class="bm-ti">${BM_DIR}</span><span class="bm-tx">${name}${tail || ''}</span></div>`;
  let h = '', msg = '', warn = false;
  if (!q.root) { msg = t('bm.noRoot'); h = `<div class="bm-pmsg">${msg}</div>`; }
  else if (!c.rootOk) { msg = t('bm.rootMissing'); warn = true; h = `<div class="bm-pmsg warn">${msg}</div>`; }
  else {
    if (c.matchName && c.matchOk) { msg = `${esc(c.matchName)}: ${t('bm.replace')}`; warn = true; }
    const site = bmSlots.filter(s => s.site).length;
    h = `<div class="bm-tree">` +
      row(0, '', esc(q.root)) +
      row(1, c.monthOk ? '' : 'new', mm, pill(c.monthOk)) +
      row(2, c.dayOk ? '' : 'new', dd, pill(c.dayOk)) +
      (c.matchName
        ? row(3, 'match', `<b>${esc(c.matchName)}</b>`, c.matchOk ? `<em class="bm-pl warn">${t('bm.replace')}</em>` : pill(false)) +
          `<div class="bm-tn d4 files">${[['png', bmSlots.length], ['jpeg', site], ['webp', site]].map(([f, n]) => `<span class="bm-fc"><b>${f}</b>${n}</span>`).join('')}</div>`
        : row(3, 'dim', t('bm.noMatch'))) +
      '</div>';
    if (c.others && c.others.length) h += `<div class="bm-others"><span>${t('bm.others', {n: c.others.length})}</span>${c.others.map(o => `<i>${esc(o)}</i>`).join('')}</div>`;
  }
  if ($('bmPath').innerHTML !== h) $('bmPath').innerHTML = h;
  const m = $('bmPathMsg');
  m.classList.toggle('hide', !msg);
  m.classList.toggle('warn', warn);
  if (m.innerHTML !== msg) m.innerHTML = msg;
}
try {
  const o = JSON.parse(localStorage.getItem(BM_KEY) || 'null');
  if (o && typeof o.root === 'string') $('bmRoot').value = o.root;
} catch (e) {}
const bmSave = () => { try { localStorage.setItem(BM_KEY, JSON.stringify({root: $('bmRoot').value.trim()})); } catch (e) {} };
$('bmRoot').addEventListener('input', () => { bmSave(); bmCheckSoon(); });
$('bmMatch').addEventListener('input', bmCheckSoon);
$('bmMatch').addEventListener('keydown', e => { if (e.key === 'Enter') bmRun(); });
// календарь вместо списков: месяц и день лежат в скрытых bmMonth/bmDay (из них собирается путь), сегодняшняя дата — из часов Windows
const bmCal = {el: null, m: 1};
function bmDateText() {
  const m = +$('bmMonth').value, d = +$('bmDay').value;
  $('bmDateTx').textContent = new Intl.DateTimeFormat(lang === 'ru' ? 'ru' : 'en', {day: 'numeric', month: 'long'}).format(new Date(2024, m - 1, d));
}
function bmCalDraw() {
  const el = bmCal.el, now = new Date(), y = now.getFullYear(), m = bmCal.m;
  const loc = lang === 'ru' ? 'ru' : 'en', mn = new Intl.DateTimeFormat(loc, {month: 'long'}).format(new Date(y, m - 1, 1));
  const first = (new Date(y, m - 1, 1).getDay() + 6) % 7, days = new Date(y, m, 0).getDate();
  const wd = Array.from({length: 7}, (_, i) => new Intl.DateTimeFormat(loc, {weekday: 'short'}).format(new Date(2024, 0, 1 + i)));
  const selM = +$('bmMonth').value, selD = +$('bmDay').value, tM = now.getMonth() + 1, tD = now.getDate();
  let cells = '<i></i>'.repeat(first);
  for (let d = 1; d <= days; d++) cells += `<button type="button" data-d="${d}" class="${m === selM && d === selD ? 'on' : ''} ${m === tM && d === tD ? 'today' : ''}">${d}</button>`;
  el.innerHTML = `<div class="bm-cal-h"><button type="button" class="bm-cal-n" data-s="-1" aria-label="‹"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg></button>` +
    `<b>${esc(mn[0].toUpperCase() + mn.slice(1))}</b><button type="button" class="bm-cal-n" data-s="1" aria-label="›"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></button></div>` +
    `<div class="bm-cal-w">${wd.map(w => `<span>${esc(w)}</span>`).join('')}</div><div class="bm-cal-g">${cells}</div>` +
    `<button type="button" class="bm-cal-t" data-t="1">${t('bm.today')}</button>`;
}
function bmCalPlace() {
  const el = bmCal.el, b = $('bmDateBtn').getBoundingClientRect();
  const hero = document.querySelector('.hero'), minTop = (hero ? hero.getBoundingClientRect().bottom : 0) + 8;
  el.style.maxHeight = '';
  const w = el.offsetWidth, h = el.offsetHeight;
  const below = window.innerHeight - b.bottom - 6 - 8, above = b.top - 6 - minTop;
  let top;
  if (h <= below) top = b.bottom + 6;
  else if (h <= above) top = b.top - h - 6;
  else { const room = Math.max(above, below, 120); el.style.maxHeight = room + 'px'; top = below >= above ? b.bottom + 6 : minTop; }
  el.style.left = Math.max(8, Math.min(b.left, window.innerWidth - w - 8)) + 'px';
  el.style.top = top + 'px';
}
function bmCalClose() { if (bmCal.el) bmCal.el.classList.add('hide'); $('bmDateBtn').classList.remove('open'); }
function bmSetDate(m, d) {
  $('bmMonth').value = m; bmFillDays(d); bmDateText(); bmCheck();
}
$('bmDateBtn').onclick = e => {
  e.stopPropagation();
  if (!bmCal.el) { bmCal.el = document.createElement('div'); bmCal.el.className = 'bm-cal hide'; document.body.appendChild(bmCal.el); }
  if (!bmCal.el.classList.contains('hide')) { bmCalClose(); return; }
  bmCal.m = +$('bmMonth').value || 1;
  bmCalDraw();
  bmCal.el.classList.remove('hide'); $('bmDateBtn').classList.add('open');
  bmCalPlace();
};
document.addEventListener('click', e => {
  if (!bmCal.el) return;
  const el = bmCal.el;
  if (el.classList.contains('hide')) return;
  const n = e.target.closest('.bm-cal-n'), d = e.target.closest('.bm-cal-g button'), tb = e.target.closest('.bm-cal-t');
  if (n && el.contains(n)) { bmCal.m = (bmCal.m - 1 + +n.dataset.s + 12) % 12 + 1; bmCalDraw(); bmCalPlace(); }
  else if (d && el.contains(d)) { bmSetDate(bmCal.m, +d.dataset.d); bmCalClose(); }
  else if (tb && el.contains(tb)) { const now = new Date(); bmSetDate(now.getMonth() + 1, now.getDate()); bmCalClose(); }
  else if (!el.contains(e.target)) bmCalClose();
});
// Esc при открытом календаре закрывает только его (не снимает выбор баннера и не закрывает «Крупно»)
window.addEventListener('keydown', e => { if (e.key === 'Escape' && bmCal.el && !bmCal.el.classList.contains('hide')) { e.stopPropagation(); e.preventDefault(); bmCalClose(); } }, true);
window.addEventListener('resize', bmCalClose);
$('bmPickRoot').onclick = () => dialog(async () => {
  const r = await api('pick-folder', {purpose: 'out'});
  if (r.error) alert(r.error);
  if (r.path) { $('bmRoot').value = r.path; bmSave(); bmCheck(); }
});


// ---------- редактор: размер и сдвиг ----------
// Общая правка bmAll действует на все баннеры, своя bmOne[имя] — поверх неё (размер множится, сдвиг складывается).
// Сдвиг в долях ширины и высоты сейв-зоны: на всех баннерах он выглядит одинаково относительно зоны.
const BM_ID = {k: 1, dx: 0, dy: 0};
let bmAll = {...BM_ID};
let bmOne = {};
// Сначала выбирают, что править (bmMode): 'all' — все баннеры, рамки у всех; 'one' — один, щелчком по нему (bmSel), рамка у него.
// Пока ничего не выбрано, картинки не двигаются.
let bmMode = '';
let bmSel = '';
const bmIsId = a => !a || (Math.abs(a.k - 1) < 1e-3 && Math.abs(a.dx) < 1e-3 && Math.abs(a.dy) < 1e-3);
function bmAdj(name) {
  const o = bmOne[name] || BM_ID;
  return {k: bmAll.k * o.k, dx: bmAll.dx + o.dx, dy: bmAll.dy + o.dy};
}
// что сейчас правится; null — режим не выбран или в «Один баннер» ещё не щёлкнули по баннеру
const bmCur = () => bmMode === 'all' ? bmAll : bmMode === 'one' && bmSel ? (bmOne[bmSel] = bmOne[bmSel] || {...BM_ID}) : null;
// подсветить выбор режима, если пытаются править без него
function bmNeedMode() {
  const s = $('bmTarget');
  s.classList.remove('need'); void s.offsetWidth; s.classList.add('need');
}
function bmSet(ch) {
  const a = bmCur();
  if (!a) return;
  if ('k' in ch) a.k = Math.min(Math.max(ch.k, 0.2), 3);
  if ('dx' in ch) a.dx = Math.min(Math.max(ch.dx, -8), 8);
  if ('dy' in ch) a.dy = Math.min(Math.max(ch.dy, -8), 8);
  bmPlace(); bmEditSync();
  if ('k' in ch) bmSprSoon();   // крупнее — спрайту эффектов может не хватить чёткости
}
function bmResetAdj() {
  for (const k in bmOne) delete bmOne[k];
  bmAll = {...BM_ID}; bmSel = '';
  bmHist.u = []; bmHist.r = [];
}
// без округления, в пикселях шаблона: размер картинки при k = 1 и её середина при правке a
function bmGeo(sl, a) {
  const z = Math.min(sl.zw / bmImg.w, sl.zh / bmImg.h);
  return {bw: bmImg.w * z, bh: bmImg.h * z, cx: bmZx(sl) + a.dx * sl.zw, cy: bmZy(sl) + a.dy * sl.zh};
}

// ---------- отмена: Ctrl+Z, Ctrl+Shift+Z и Ctrl+Y ----------
// Снимок — вся правка (общая и своя у каждого баннера) и «Оформление» (bmFx); выбор баннера в снимок не входит.
// Шаг ставится перед началом движения: тяга мышью, ползунок, число, серия стрелок — по одному шагу.
const bmHist = {u: [], r: [], key: '', at: 0};
function bmSnap() {
  const one = {};
  for (const n in bmOne) if (!bmIsId(bmOne[n])) one[n] = bmOne[n];
  return JSON.stringify({all: bmAll, one, fx: bmFx});
}
function bmMark(key) {
  const now = Date.now();
  if (key && key === bmHist.key && now - bmHist.at < 900) { bmHist.at = now; return; }   // серия клавиш одним шагом
  bmHist.key = key || ''; bmHist.at = now;
  const s = bmSnap();
  if (bmHist.u[bmHist.u.length - 1] !== s) bmHist.u.push(s);
  if (bmHist.u.length > 200) bmHist.u.shift();
  bmHist.r = [];
  bmEditSync();
}
function bmLoad(s) {
  const o = JSON.parse(s);
  bmAll = o.all;
  for (const n in bmOne) delete bmOne[n];
  Object.assign(bmOne, o.one);
  bmHist.key = '';
  bmPlace(); bmEditSync();
  if (JSON.stringify(o.fx) !== JSON.stringify(bmFx)) bmFxSetAll(o.fx);
  else bmSprSoon();
}
function bmUndo(redo) {
  const from = redo ? bmHist.r : bmHist.u, to = redo ? bmHist.u : bmHist.r, cur = bmSnap();
  while (from.length && from[from.length - 1] === cur) from.pop();   // шаг без изменений не считаем
  if (!from.length) return;
  to.push(cur);
  bmLoad(from.pop());
}
$('bmUndo').onclick = () => bmUndo(false);
$('bmRedo').onclick = () => bmUndo(true);
document.addEventListener('keydown', e => {
  if (tab !== 'bmake' || !bmImg || bmBusy || !(e.ctrlKey || e.metaKey) || e.altKey) return;
  if (e.target.closest && e.target.closest('input:not([type=range]), textarea, select, [contenteditable]') || document.querySelector('.modal:not(.hide)')) return;
  const z = e.code === 'KeyZ', y = e.code === 'KeyY';   // по коду клавиши: в русской раскладке тоже
  if (!z && !y) return;
  e.preventDefault();
  bmUndo(y || e.shiftKey);
});

// панель «Положение»: что правим и значения правки
function bmEditSync() {
  const a = bmCur(), on = !!bmImg && !bmBusy, kv = Math.round((a || BM_ID).k * 100);
  document.querySelectorAll('#bmTarget .segb').forEach(b => { b.classList.toggle('on', b.dataset.m === bmMode); b.disabled = !on; });
  $('bmSelName').textContent = bmMode === 'one' && bmSel ? bmSel : t('bm.tOne');
  $('bmSelSub').textContent = t(bmMode === 'one' && bmSel ? 'bm.oneSel' : 'bm.tOneSub');
  $('bmModeHint').classList.toggle('hide', !on || !!a);
  $('bmModeHint').textContent = t(bmMode === 'one' ? 'bm.pickOne' : 'bm.pickMode');
  $('bmK').value = kv; slFill($('bmK'));
  if (document.activeElement !== $('bmKn')) $('bmKn').value = kv;
  $('bmToAll').classList.toggle('hide', !(on && bmMode === 'one' && bmSel && !bmIsId(bmOne[bmSel])));
  $('bmK').disabled = $('bmKn').disabled = $('bmCenter').disabled = $('bmReset').disabled = !on || !a;
  const cur = bmSnap();
  $('bmUndo').disabled = !on || !bmHist.u.some(s => s !== cur);
  $('bmRedo').disabled = !on || !bmHist.r.some(s => s !== cur);
  $('bmGrid').classList.toggle('m-all', bmMode === 'all');
  $('bmGrid').classList.toggle('m-one', bmMode === 'one');
  document.querySelectorAll('#bmGrid .bm-t').forEach(f => {
    f.classList.toggle('sel', bmMode === 'one' && f.dataset.n === bmSel);
    f.classList.toggle('own', !bmIsId(bmOne[f.dataset.n]));
  });
  bmObjSync();   // «Сбросить всё» и переключатель «что правишь» (bannerfx.js)
}
// положение картинки и рамки на плитках без перерисовки списка (её дёргает каждое движение мыши)
function bmPlace() {
  if (!bmImg) return;
  document.querySelectorAll('#bmGrid .bm-t').forEach(f => {
    const sl = bmSlots.find(s => s.name === f.dataset.n), box = f.querySelector('.bm-img');
    if (!sl || !box) return;
    const p = bmFit(sl, bmImg.w, bmImg.h, bmAdj(sl.name));
    const ad = bmAdj(sl.name), hx = bmZx(sl) / sl.w * 100, hy = bmZy(sl) / sl.h * 100;
    box.style.cssText = `aspect-ratio:${sl.w}/${sl.h};--l:${p.l};--t:${p.t};--w:${p.w};--h:${p.h};--hx:${hx};--hy:${hy}` + bmFxVars(f, sl, ad, p);
    // метка «здесь картинка стоит по умолчанию» появляется, когда её сдвинули; вторая метка — центр самого баннера, если он не совпадает
    f.classList.toggle('off', Math.abs(ad.dx) > 0.004 || Math.abs(ad.dy) > 0.004);
    f.classList.toggle('offm', Math.abs(hx - 50) * sl.w / 100 > 1 || Math.abs(hy - 50) * sl.h / 100 > 1);
  });
  bmLpDraw();   // «Крупно» (bannerfx.js)
}
$('bmTarget').addEventListener('click', e => {
  const b = e.target.closest('.segb'); if (!b || b.disabled) return;
  bmMode = b.dataset.m;
  if (bmMode === 'all') bmSel = '';
  bmEditSync();
});
let bmKMark = false;   // ползунок и число: один шаг отмены на всё движение
$('bmK').addEventListener('input', () => {
  if (!bmKMark) { bmMark(); bmKMark = true; }
  bmSet({k: +$('bmK').value / 100});
});
$('bmK').addEventListener('change', () => { bmKMark = false; });
$('bmKn').addEventListener('input', () => {
  const v = +$('bmKn').value;
  if (!(v >= 20 && v <= 300) || !bmCur()) return;
  if (!bmKMark) { bmMark(); bmKMark = true; }
  bmSet({k: v / 100});
});
$('bmKn').addEventListener('change', () => { bmKMark = false; $('bmKn').value = Math.round((bmCur() || BM_ID).k * 100); });
$('bmKn').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
// двойной щелчок по ползунку — снова 100%
$('bmK').addEventListener('dblclick', () => { if (bmCur()) { bmMark(); bmSet({k: 1}); } });
$('bmCenter').onclick = () => { bmMark(); bmSet({dx: 0, dy: 0}); };
$('bmReset').onclick = () => {
  if (!bmCur()) return;
  bmMark();
  if (bmMode === 'one') delete bmOne[bmSel]; else bmAll = {...BM_ID};
  bmPlace(); bmEditSync();
};

// «Применить ко всем»: итог выбранного баннера становится общей правкой, свои правки у всех сбрасываются
$('bmToAll').onclick = () => {
  if (bmMode !== 'one' || !bmSel) return;
  bmMark();
  bmAll = bmAdj(bmSel);
  for (const n in bmOne) delete bmOne[n];
  bmPlace(); bmEditSync();
};

// ---------- мышью по плитке ----------
// Правишь один объект — картинку или фон (bmFxObj, меняет только bmObjSet). Тянешь его, нажав внутри его рамки.
// «Все баннеры»: тянешь картинку любого — едут все, уголки рамки любой — размер у всех.
// «Один баннер»: нажатие выбирает баннер, тянуть и растягивать можно только его (нажал на другой — теперь правишь его).
// Размер уголком — от противоположного угла. Середина картинки прилипает к середине баннера и к середине места
// под картинку, размер — к 100%. Alt — без магнитов.
// Фон (bmFxObj = 'elf') тянется так же, его середина прилипает к тем же точкам; картинку он не трогает и сам от неё не зависит.
const BM_SNAP = 7;   // ширина магнита в пикселях экрана
let bmDrag = null;
function bmGuides(f, gx, gy) {
  f.classList.toggle('snx', gx != null); f.classList.toggle('sny', gy != null);
  const b = f.querySelector('.bm-img') || f;   // в «Крупно» f — сам баннер #bmLpI
  if (gx != null) b.style.setProperty('--gx', gx);
  if (gy != null) b.style.setProperty('--gy', gy);
}
// перемещение холста: пробел + мышь или средняя кнопка (колёсико)
// Пробел в «Сборке баннеров» только включает перемещение: кнопку под фокусом не нажимает, галочку не ставит
// (фокус после щелчка мышью остаётся на кнопке, и пробел на ней = щелчок: так открывалось «Крупно»).
// Пробелом остаётся только в полях для текста и в списках. Ловим в фазе захвата, раньше кнопки.
let bmSpace = false;
const bmPanOn = v => {
  if (bmSpace === v) return;
  bmSpace = v; $('bmGrid').classList.toggle('panr', v); $('bmLpV').classList.toggle('panr', v);
  requestAnimationFrame(bmTileHover);   // курсор над плиткой: при пробеле только «двигать вид»
  if (bmLp.on && typeof bmLpHover === 'function') requestAnimationFrame(bmLpHover);   // в «Крупно» убрать или вернуть подсветку под мышью
};
const BM_TXT = 'textarea, select, [contenteditable], input:not([type=button]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=submit]):not([type=reset])';
const bmSpaceKey = e => e.code === 'Space' && tab === 'bmake' && !document.querySelector('.modal:not(.hide)') && !(e.target.closest && e.target.closest(BM_TXT));
document.addEventListener('keydown', e => {
  if (!bmSpaceKey(e)) return;
  e.preventDefault();
  if (bmImg && !e.ctrlKey && !e.altKey && !e.metaKey) bmPanOn(true);
}, true);
document.addEventListener('keyup', e => {
  if (e.code !== 'Space') return;
  if (bmSpaceKey(e)) e.preventDefault();
  bmPanOn(false);
}, true);
window.addEventListener('blur', () => bmPanOn(false));
// после перемещения холста щелчок не считается: не снимает и не меняет выбор
let bmPanClick = false;
document.addEventListener('click', e => { if (bmPanClick) { bmPanClick = false; e.stopPropagation(); e.preventDefault(); } }, true);
$('bmGrid').addEventListener('pointerdown', e => {
  if (!(e.button === 1 || (e.button === 0 && bmSpace))) return;
  e.preventDefault(); e.stopImmediatePropagation();
  const g = $('bmGrid'), x0 = e.clientX, y0 = e.clientY, sl = g.scrollLeft, st = g.scrollTop;
  g.classList.add('panning');
  if (e.button === 0) bmPanClick = true;
  const mv = ev => { g.scrollLeft = sl - (ev.clientX - x0); g.scrollTop = st - (ev.clientY - y0); };
  const up = () => {
    g.classList.remove('panning'); window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
    setTimeout(() => { bmPanClick = false; });   // click приходит сразу после pointerup; если не пришёл — флаг не должен съесть следующий
  };
  window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
}, true);
$('bmGrid').addEventListener('auxclick', e => { if (e.button === 1) e.preventDefault(); });
$('bmGrid').addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });   // средняя кнопка — без автопрокрутки
// Модель та же, что в «Крупно» (bmPickAt, bmGrab в bannerfx.js): правишь один объект (bmFxObj), тянешь его, только если
// нажал внутри его рамки (или за уголок); второй объект не двигается никогда. Щелчок без движения по видимой части
// другого объекта выбирает его через bmObjSet, само нажатие выбор объекта не меняет. Баннер (bmSel в режиме «Один»)
// выбирается любым нажатием на него, пока правишь картинку.
let bmTileClick = null;   // {id, x, y, kind}: нажали на другой объект; отпустили без движения — выбрать его
$('bmGrid').addEventListener('pointerdown', e => {
  const box = e.target.closest('.bm-img'), f = box && box.closest('.bm-t');
  bmTileClick = null;
  if (!f || bmBusy || e.button !== 0) return;
  e.preventDefault();
  const sl = bmSlots.find(s => s.name === f.dataset.n);
  if (!sl) return;
  if (bmLp.name !== sl.name) { bmLp.name = sl.name; bmLpDraw(); if (bmLp.on) bmSprSoon(); }   // «Крупно» смотрит этот баннер
  if (bmFxObj === 'art' && bmMode === 'one' && bmSel !== sl.name) { bmSel = sl.name; bmEditSync(); }
  const hd = e.target.closest('.bm-box i'), pk = hd ? {grab: bmFxObj, click: ''} : bmTilePick(f, e.clientX, e.clientY);
  if (pk.click) bmTileClick = {id: e.pointerId, x: e.clientX, y: e.clientY, kind: pk.click};
  if (pk.grab && bmGrab(e, pk.grab, hd, sl, f, box)) {
    f.classList.remove('ov', 'pk');
    box.setPointerCapture(e.pointerId);
    return;
  }
  if (bmTileClick) box.setPointerCapture(e.pointerId);
  else if (bmFxObj === 'art' && !bmMode && !pk.grab) bmNeedMode();   // нажал мимо картинки без режима — подсказать режим
});
// наведение на плитку: внутри рамки выбранного — курсор «тянуть», над другим объектом — рука (щелчок выберет его)
let bmTileHov = null, bmTileHovRaf = 0;
function bmTileHover() {
  bmTileHovRaf = 0;
  const p = bmTileHov, f = p && p.f;
  document.querySelectorAll('#bmGrid .bm-t.ov, #bmGrid .bm-t.pk').forEach(o => { if (o !== f) o.classList.remove('ov', 'pk'); });
  if (!f) return;
  const pk = !bmDrag && !bmSpace && !bmBusy ? (p.h ? {grab: bmFxObj, click: ''} : bmTilePick(f, p.x, p.y)) : {grab: '', click: ''};
  f.classList.toggle('ov', !!pk.grab);
  f.classList.toggle('pk', !pk.grab && !!pk.click);
}
$('bmGrid').addEventListener('pointermove', e => {
  if (bmTileClick && bmTileClick.id === e.pointerId && Math.hypot(e.clientX - bmTileClick.x, e.clientY - bmTileClick.y) >= 3) bmTileClick = null;   // повёл — не щелчок
  if (bmDrag) return;
  const box = e.target.closest('.bm-img');
  bmTileHov = box ? {f: box.closest('.bm-t'), x: e.clientX, y: e.clientY, h: !!e.target.closest('.bm-box i')} : null;
  if (!bmTileHovRaf) bmTileHovRaf = requestAnimationFrame(bmTileHover);
});
$('bmGrid').addEventListener('pointerleave', () => { bmTileHov = null; if (!bmTileHovRaf) bmTileHovRaf = requestAnimationFrame(bmTileHover); });
// движение мышью: общее для плиток и «Крупно» (там d.f — баннер #bmLpI, d.r — его место на экране, d.sc — масштаб лупы).
// d.el — тянем фоновый элемент, d.ek — его размер от центра, d.er — поворот вокруг центра (cx, cy в пикселях экрана)
function bmDragMove(e) {
  const d = bmDrag;
  if (!d) return;
  const mx = e.clientX - d.x, my = e.clientY - d.y, sl = d.sl, free = e.altKey;
  if (!d.moved) {
    if (Math.hypot(mx, my) < 3) return;
    d.moved = true;
    bmMark();
  }
  if (d.ek) {   // размер элемента за уголок, как у картинки: противоположный угол стоит на месте; прилипает к 100%, Alt — без магнита
    const a = -bmFx.er * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
    const dx = e.clientX - d.cx, dy = e.clientY - d.cy;
    const px = dx * ca - dy * sa, py = dx * sa + dy * ca;   // мышь в осях элемента, от его середины
    const ax = -d.sx * d.gw / 2, ay = -d.sy * d.gh / 2;     // стоящий угол
    let kt = Math.max((px - ax) * d.sx / d.gw, (py - ay) * d.sy / d.gh);
    let nk = Math.min(Math.max(d.ek * kt, 0.2), 3);
    const one = !free && Math.abs(nk - 1) * d.gw / d.ek < BM_SNAP;
    if (one) nk = 1;
    kt = nk / d.ek;
    const lx = ax + d.sx * d.gw * kt / 2, ly = ay + d.sy * d.gh * kt / 2, b = -a, cb = Math.cos(b), sb = Math.sin(b);
    const cx = d.cx + lx * cb - ly * sb, cy = d.cy + lx * sb + ly * cb;   // новая середина на экране
    bmFx.ek = nk;
    bmFx.ex = Math.min(Math.max(d.ex0 + (cx - d.cx) / d.sc / sl.zw, -BM_EL_D), BM_EL_D);
    bmFx.ey = Math.min(Math.max(d.ey0 + (cy - d.cy) / d.sc / sl.zh, -BM_EL_D), BM_EL_D);
    d.f.classList.toggle('k100', one);
    bmFxChanged(true);
    return;
  }
  if (d.er != null) {   // поворот: прилипает к 0°, 90°, 180°, 270° (Alt — без магнита)
    const a = Math.atan2(e.clientY - d.cy, e.clientX - d.cx) - Math.atan2(d.y - d.cy, d.x - d.cx);
    let v = ((d.er + a * 180 / Math.PI) % 360 + 360) % 360;
    const q = Math.round(v / 90) * 90;
    if (!free && Math.abs(v - q) < 4) v = q % 360;
    bmFx.er = Math.round(v * 10) / 10;
    bmFxChanged(true);
    return;
  }
  const tol = free ? 0 : BM_SNAP / d.sc;   // магнит в пикселях шаблона
  if (d.el) {   // сдвиг элемента: его середина прилипает к середине баннера и сейв-зоны, как у картинки
    const gx = bmZx(sl) + d.ex * sl.zw + mx / d.sc, gy = bmZy(sl) + d.ey * sl.zh + my / d.sc;
    const sx = bmSnapTo(gx, bmSnapX(sl), tol), sy = bmSnapTo(gy, bmSnapY(sl), tol);
    bmFx.ex = Math.min(Math.max(((sx ?? gx) - bmZx(sl)) / sl.zw, -BM_EL_D), BM_EL_D);
    bmFx.ey = Math.min(Math.max(((sy ?? gy) - bmZy(sl)) / sl.zh, -BM_EL_D), BM_EL_D);
    bmFxChanged(true);
    bmGuides(d.f, sx == null ? null : sx / sl.w * 100, sy == null ? null : sy / sl.h * 100);
    return;
  }
  if (d.h) {   // растягиваем за уголок: противоположный угол стоит на месте
    const px = (e.clientX - d.r.left) / d.sc, py = (e.clientY - d.r.top) / d.sc, bk = d.t0.k / d.a0.k;
    let kt = Math.max((px - d.ax) * d.sx / d.g.bw, (py - d.ay) * d.sy / d.g.bh);
    if (!free && Math.abs(kt - 1) * d.g.bw * d.sc < BM_SNAP) kt = 1;
    const k = Math.min(Math.max(kt / bk, 0.2), 3);
    kt = k * bk;
    const cx = d.ax + d.sx * d.g.bw * kt / 2, cy = d.ay + d.sy * d.g.bh * kt / 2;
    bmSet({k, dx: d.a0.dx + (cx - bmZx(sl)) / sl.zw - d.t0.dx, dy: d.a0.dy + (cy - bmZy(sl)) / sl.zh - d.t0.dy});
    d.f.classList.toggle('k100', kt === 1);
    return;
  }
  // сдвиг: середина картинки в пикселях шаблона, магнит к середине баннера и места
  const g = bmGeo(sl, {dx: d.t0.dx + mx / d.sc / sl.zw, dy: d.t0.dy + my / d.sc / sl.zh});
  const sx = bmSnapTo(g.cx, bmSnapX(sl), tol), sy = bmSnapTo(g.cy, bmSnapY(sl), tol);
  const cx = sx ?? g.cx, cy = sy ?? g.cy;
  bmSet({dx: d.a0.dx + (cx - bmZx(sl)) / sl.zw - d.t0.dx, dy: d.a0.dy + (cy - bmZy(sl)) / sl.zh - d.t0.dy});
  bmGuides(d.f, sx == null ? null : sx / sl.w * 100, sy == null ? null : sy / sl.h * 100);
}
$('bmGrid').addEventListener('pointermove', bmDragMove);
const bmDragEnd = () => {
  const d = bmDrag;
  if (!d) return;
  bmDrag = null;
  d.f.classList.remove('drag', 'k100');
  bmGuides(d.f, null, null);
};
const bmTileUp = e => {
  const c = bmTileClick && bmTileClick.id === e.pointerId && e.type === 'pointerup' ? bmTileClick.kind : '';
  bmTileClick = null;
  if (bmDrag && !bmDrag.lp) bmDragEnd();
  if (c) bmObjSet(c);   // щелчок без движения по другому объекту — теперь правишь его
  if (!bmTileHovRaf) bmTileHovRaf = requestAnimationFrame(bmTileHover);
};
$('bmGrid').addEventListener('pointerup', bmTileUp);
$('bmGrid').addEventListener('pointercancel', bmTileUp);
// щелчок по пустому месту поля снимает выбор баннера; по подписи или краю плитки — выбирает его, как щелчок по самому баннеру
// (картинку при этом не трогает). «Крупно» не открывает, только показывает этот баннер, если уже открыто
$('bmGrid').addEventListener('click', e => {
  const f = e.target.closest('.bm-t');
  if (!f) { if (bmSel) { bmSel = ''; bmEditSync(); } return; }
  if (e.target.closest('.bm-img') || bmBusy) return;   // по самому баннеру выбирает pointerdown
  if (bmLp.name !== f.dataset.n) { bmLp.name = f.dataset.n; bmLpDraw(); if (bmLp.on) bmSprSoon(); }
  if (bmFxObj === 'elf') return;   // фон общий для всех баннеров, выбирать нечего
  if (!bmMode) { bmNeedMode(); return; }
  if (bmMode === 'one' && bmSel !== f.dataset.n) { bmSel = f.dataset.n; bmEditSync(); }
});
// стрелки двигают (с Shift крупнее), + и − меняют размер, Esc снимает выбор баннера
document.addEventListener('keydown', e => {
  if (tab !== 'bmake' || !bmImg || bmBusy || e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable]') || document.querySelector('.modal:not(.hide)')) return;
  if (e.key === 'Escape') { if (bmSel) { bmSel = ''; bmEditSync(); } return; }
  const st = e.shiftKey ? 0.05 : 0.01;
  if (bmFxObj === 'elf') {   // правим фон: стрелки двигают элемент, + и − меняют его размер
    if (!bmElCur()) return;
    const c = (v, a, b) => Math.min(Math.max(v, a), b);
    const m = {ArrowLeft: {ex: c(bmFx.ex - st, -BM_EL_D, BM_EL_D)}, ArrowRight: {ex: c(bmFx.ex + st, -BM_EL_D, BM_EL_D)}, ArrowUp: {ey: c(bmFx.ey - st, -BM_EL_D, BM_EL_D)}, ArrowDown: {ey: c(bmFx.ey + st, -BM_EL_D, BM_EL_D)},
      '+': {ek: c(bmFx.ek * 1.02, 0.2, 3)}, '=': {ek: c(bmFx.ek * 1.02, 0.2, 3)}, '-': {ek: c(bmFx.ek / 1.02, 0.2, 3)}}[e.key];
    if (m) { e.preventDefault(); bmMark('key'); Object.assign(bmFx, m); bmFxChanged(true); }
    return;
  }
  const a = bmCur();
  const m = a && {ArrowLeft: {dx: a.dx - st}, ArrowRight: {dx: a.dx + st}, ArrowUp: {dy: a.dy - st}, ArrowDown: {dy: a.dy + st},
    '+': {k: a.k * 1.02}, '=': {k: a.k * 1.02}, '-': {k: a.k / 1.02}}[e.key];
  if (m) { e.preventDefault(); bmMark('key'); bmSet(m); }
  else if (!a && /^Arrow|^[+=-]$/.test(e.key)) bmNeedMode();
});

// ---------- вид ----------
// размер превью: высота ряда плиток, помнится
const BM_ZOOM = 'k9000.bmz';
const BM_Z0 = 118, BM_ZMIN = 70, BM_ZMAX = 900;
try { const z = +localStorage.getItem(BM_ZOOM); if (z >= BM_ZMIN && z <= BM_ZMAX) $('bmZoom').value = z; } catch (e) {}
// масштаб — только вид (высота ряда); правку, отмену и сборку не трогает. Выше 260 плитки могут быть шире поля: сетка прокручивается
const bmZoomSet = () => {
  const z = +$('bmZoom').value, g = $('bmGrid');
  g.style.setProperty('--bm-h', z + 'px');
  g.style.setProperty('--bm-cap', z > 260 ? '100000px' : '100%');
  $('bmZp').textContent = Math.round(z / BM_Z0 * 100) + '%';
};
// ставит масштаб z. Точка под мышью (cx, cy в координатах сетки) остаётся на месте; если выбран баннер — масштаб идёт по нему (его центр не двигается)
function bmZoomTo(z, cx, cy) {
  z = Math.max(BM_ZMIN, Math.min(BM_ZMAX, Math.round(z)));
  const g = $('bmGrid');
  if (z === +$('bmZoom').value) return;
  const gb = g.getBoundingClientRect();
  const sel = bmSel && [...g.querySelectorAll('.bm-t')].find(f => f.dataset.n === bmSel);
  let tile = sel, fx = .5, fy = .5;
  if (sel) { const r = sel.getBoundingClientRect(); cx = r.left + r.width / 2 - gb.left; cy = r.top + r.height / 2 - gb.top; }
  else {
    const el = document.elementFromPoint(gb.left + cx, gb.top + cy);
    tile = el && el.closest('#bmGrid .bm-t');
    if (tile) { const r = tile.getBoundingClientRect(); fx = (gb.left + cx - r.left) / (r.width || 1); fy = (gb.top + cy - r.top) / (r.height || 1); }
  }
  const ax = (g.scrollLeft + cx) / (g.scrollWidth || 1), ay = (g.scrollTop + cy) / (g.scrollHeight || 1);
  $('bmZoom').value = z; bmZoomSet();
  if (tile) {
    const r = tile.getBoundingClientRect();
    g.scrollLeft += r.left + fx * r.width - (gb.left + cx);
    g.scrollTop += r.top + fy * r.height - (gb.top + cy);
  } else { g.scrollLeft = ax * g.scrollWidth - cx; g.scrollTop = ay * g.scrollHeight - cy; }
  try { localStorage.setItem(BM_ZOOM, z); } catch (e) {}
  bmPlace(); bmSprSoon();
}
const bmZoomMid = k => { const g = $('bmGrid'); bmZoomTo(+$('bmZoom').value * k, g.clientWidth / 2, g.clientHeight / 2); };
$('bmZoom').addEventListener('input', () => { bmZoomSet(); try { localStorage.setItem(BM_ZOOM, $('bmZoom').value); } catch (e) {} bmPlace(); bmSprSoon(); });
$('bmZm').addEventListener('click', () => bmZoomMid(1 / 1.2));
$('bmZi').addEventListener('click', () => bmZoomMid(1.2));
$('bmZp').addEventListener('click', () => { const g = $('bmGrid'); bmZoomTo(BM_Z0, g.clientWidth / 2, g.clientHeight / 2); });
$('bmGrid').addEventListener('wheel', e => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  const g = $('bmGrid'), b = g.getBoundingClientRect();
  bmZoomTo(+$('bmZoom').value * Math.exp(-Math.max(-120, Math.min(120, e.deltaY)) * 0.0025), e.clientX - b.left, e.clientY - b.top);
}, {passive: false});
bmZoomSet();
function bmTile(sl) {
  const s = bmSt[sl.name] || {}, r = (sl.w / sl.h).toFixed(4);
  const pill = s.st === 'ok' ? '✓' : s.st === 'error' ? '!' : '';
  const ov = s.st === 'run' ? '<div class="bm-ov"><span class="bm-dots"><i></i><i></i><i></i></span></div>'
    : s.st === 'ok' ? '<div class="bm-ov"><svg class="bm-chk" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11"/><path d="M7 12.5l3.3 3.3L17 9"/></svg></div>'
    : s.st === 'error' ? '<div class="bm-ov"><b class="bm-bad">!</b></div>' : '';
  // ширина по высоте ряда, но не шире поля; подпись под баннером, не меньше 130 px. Положение картинки и элемента ставит bmPlace.
  // Пунктир bm-zf — сейв-зона, только в превью
  const zf = `left:${sl.x / sl.w * 100}%;top:${sl.y / sl.h * 100}%;width:${sl.zw / sl.w * 100}%;height:${sl.zh / sl.h * 100}%`;
  return `<figure class="bm-t ${s.st || ''}" data-n="${esc(sl.name)}" style="width:max(130px, min(var(--bm-cap), calc(var(--bm-h) * ${r})))" title="${esc(s.msg || '')}">` +
    `<div class="bm-img" style="aspect-ratio:${sl.w}/${sl.h}">` +
    `<div class="bm-clip"><img class="bg" src="/bannerbg/${sl.name}.png" alt="" draggable="false">` +
    `<img class="el" alt="" draggable="false"><img class="art" alt="" draggable="false"><b class="bm-eb"></b><b class="bm-zf" style="${zf}"></b><b class="bm-g v"></b><b class="bm-g h"></b><b class="bm-hm"></b><b class="bm-hm mid"></b>${ov}</div>` +
    `<div class="bm-bx"><div class="bm-box"><i data-h="nw"></i><i data-h="ne"></i><i data-h="sw"></i><i data-h="se"></i></div></div></div>` +
    `<figcaption><b>${esc(sl.name)}</b><em>${t('bm.own')}</em><i>${pill}</i></figcaption>` +
    `${s.msg ? `<span class="bm-msg">${esc(s.msg)}</span>` : ''}</figure>`;
}
function bmRender() {
  const has = !!bmImg;
  $('bmEmpty').classList.toggle('hide', has);
  $('bmGrid').classList.toggle('hide', !has);
  $('bmSrc').classList.toggle('hide', !has);
  $('bmZoomL').classList.toggle('hide', !has);
  $('bmLpBtn').classList.toggle('hide', !has);
  $('bmDrop').classList.toggle('has', has);
  if (has) {
    if ($('bmThumb').getAttribute('src') !== bmImg.url) $('bmThumb').src = bmImg.url;
    $('bmName').textContent = bmImg.name;
    $('bmCnt').textContent = `${bmImg.w}×${bmImg.h}` + (bmImg.trimmed ? ' · ' + t('bm.trimmed') : '');
  }
  $('bmPick').disabled = $('bmClear').disabled = $('bmRoot').disabled = $('bmPickRoot').disabled = $('bmMonth').disabled = $('bmDay').disabled = $('bmMatch').disabled = bmBusy;
  if (has) {
    const html = bmSlots.map(bmTile).join('');
    if ($('bmGrid').bmHtml !== html) { $('bmGrid').innerHTML = html; $('bmGrid').bmHtml = html; }   // не dataset.k: data-k прячет applyKind (settings.js)
    bmPlace();
  }
  bmEditSync();
  bmFxSync();
  bmLpDraw();
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
  const b = await api('bmk-begin', q);
  if (b.error) { bmBusy = false; bmAbort = null; bmRender(); say('warn', t('bm.failTitle'), esc(b.error)); return; }
  if (bmFx.el) await bmElLoad(bmFx.el);   // элемент выбран, но ещё не загружен
  let done = 0, fail = 0, stopped = false;
  for (const sl of bmSlots) {
    bmSt[sl.name] = {st: 'run'}; bmRender();
    // баннер целиком собирает страница (bannerfx.js): шаблон, элемент, картинка, эффекты; сервер сохраняет форматы
    let pix = null;
    try { pix = await bmFxBanner(sl); } catch (e) {}
    if (bmAbort.signal.aborted) { delete bmSt[sl.name]; stopped = true; break; }
    const r = pix ? await bmFxPut(b.id, sl.name, pix, bmAbort.signal) : {error: t('bm.badFile', {name: sl.name})};
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
  bmShapesFill(r.shapes);
  bmRender();
  bmCheck();
}

// ---------- памятка «Сейв-зоны»: каждый шаблон с рамкой зоны, её размер и отступы до краёв ----------
// Шаблон без картинки в web/bannerbg рисуется схемой: серый прямоугольник того же вида.
function bmZonesOpen() {
  $('bmZwGrid').innerHTML = bmSlots.map(sl => {
    const r = sl.x + sl.zw, b = sl.y + sl.zh;
    const box = `left:${sl.x / sl.w * 100}%;top:${sl.y / sl.h * 100}%;width:${sl.zw / sl.w * 100}%;height:${sl.zh / sl.h * 100}%`;
    // у всех плиток одна высота окошка (110 px), шаблон вписан в него: подписи стоят ровно
    return `<figure class="bm-zw-t"><div class="bm-zw-st"><div class="bm-zw-img" style="aspect-ratio:${sl.w}/${sl.h};width:min(100%, ${Math.round(110 * sl.w / sl.h)}px)">` +
      `<img src="/bannerbg/${esc(sl.name)}.png" alt="" draggable="false" onerror="this.remove()"><b style="${box}"></b></div></div>` +
      `<figcaption><b>${esc(sl.name)}</b><span>${t('bm.zoneSize', {w: sl.zw, h: sl.zh})}</span>` +
      `<span>${t('bm.zonePad', {l: sl.x, t: sl.y, r: sl.w - r, b: sl.h - b})}</span></figcaption></figure>`;
  }).join('');
  $('bmZw').classList.remove('hide');
  $('bmZwX').focus();
}
const bmZonesClose = () => $('bmZw').classList.add('hide');
$('bmZones').addEventListener('click', async () => {
  if (!bmSlots.length) bmSlots = (await api('bmk-list')).slots || [];
  bmZonesOpen();
});
$('bmZwX').addEventListener('click', bmZonesClose);
$('bmZw').addEventListener('click', e => { if (e.target === $('bmZw')) bmZonesClose(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('bmZw').classList.contains('hide')) { e.stopPropagation(); bmZonesClose(); } });

// ---------- разделы правой колонки: заголовок .bm-gh сворачивает раздел, состояние помнится ----------
const BM_GRP_KEY = 'k9000.bmgrp';
function bmGrpInit() {
  let shut = [];
  try { shut = JSON.parse(localStorage.getItem(BM_GRP_KEY) || '[]') || []; } catch (e) {}
  const set = (g, off) => {
    g.classList.toggle('shut', off);
    g.querySelector('.bm-gh').setAttribute('aria-expanded', String(!off));
  };
  document.querySelectorAll('#bmView .bm-grp').forEach(g => {
    set(g, shut.includes(g.dataset.g));
    g.querySelector('.bm-gh').addEventListener('click', () => {
      set(g, !g.classList.contains('shut'));
      const now = [...document.querySelectorAll('#bmView .bm-grp.shut')].map(x => x.dataset.g);
      try { localStorage.setItem(BM_GRP_KEY, JSON.stringify(now)); } catch (e) {}
    });
  });
}
bmGrpInit();
