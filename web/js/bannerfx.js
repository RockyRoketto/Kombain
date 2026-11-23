// ---------- «Сборка баннеров»: фоновый элемент, тень, свечение и готовые баннеры на холсте (bannermake.js) ----------
// Элемент — PNG из web/bannershapes, один на все баннеры: лежит под картинкой, вписан в сейв-зону как она,
// дальше свой размер ek и сдвиг ex, ey (в долях зоны). Двигается и растёт вместе с картинкой, за зону выходить может.
// Эффекты считаются один раз на объект в «спрайт»: объект с полями под тень и свечение. На всех баннерах спрайт
// просто масштабируется: пиксели эффектов заданы как на самом большом баннере и растут вместе с объектом.
// Превью берёт спрайт под размер на экране (ступенями 256, 512, 1024…), сборка — спрайт полного размера (кэш по настройкам).
// Готовый баннер целиком собирается здесь же на холсте, Go только сохраняет PNG, JPEG и WebP: файл ровно как превью.
const BM_FX_KEY = 'k9000.bmfx';
const BM_SH0 = {on: false, c: '#000000', a: 55, d: 10, ang: 90, b: 18};
const BM_GL0 = {on: false, c: '#ffe2a8', r: 24, s: 60};
const bmFxDef = () => ({el: '', ek: 1.5, ex: 0, ey: 0, art: {sh: {...BM_SH0}, gl: {...BM_GL0}}, elf: {sh: {...BM_SH0}, gl: {...BM_GL0}, bl: 0}});
let bmFx = bmFxDef();
let bmFxObj = 'art';        // чьи эффекты в панели: art — картинка, elf — элемент
let bmShapes = [];          // имена элементов из /api/bmk-list
const bmEls = {};           // имя -> {cv, w, h, url}: элемент без прозрачных полей
const bmSpr = {art: null, el: null};   // спрайты превью: {key, url, px, py}; px, py — поля в долях ширины и высоты объекта
const bmSprFull = {art: null, el: null};   // спрайты полного размера для сборки: {key, cv, px, py}

// ---------- настройки: проверка, сохранение ----------
const bmNum = (v, a, b, d) => Number.isFinite(+v) && v !== null && v !== '' ? Math.min(Math.max(+v, a), b) : d;
function bmFxValid(o) {
  const d = bmFxDef();
  if (!o || typeof o !== 'object') return d;
  const sh = (s = {}) => ({on: !!s.on, c: cpValid(s.c, BM_SH0.c), a: bmNum(s.a, 0, 100, BM_SH0.a), d: bmNum(s.d, 0, 80, BM_SH0.d), ang: bmNum(s.ang, 0, 360, BM_SH0.ang), b: bmNum(s.b, 0, 80, BM_SH0.b)});
  const gl = (s = {}) => ({on: !!s.on, c: cpValid(s.c, BM_GL0.c), r: bmNum(s.r, 1, 120, BM_GL0.r), s: bmNum(s.s, 0, 100, BM_GL0.s)});
  const art = o.art || {}, elf = o.elf || {};
  return {el: typeof o.el === 'string' ? o.el : '', ek: bmNum(o.ek, 0.2, 3, 1.5), ex: bmNum(o.ex, -1, 1, 0), ey: bmNum(o.ey, -1, 1, 0),
    art: {sh: sh(art.sh), gl: gl(art.gl)}, elf: {sh: sh(elf.sh), gl: gl(elf.gl), bl: bmNum(elf.bl, 0, 60, 0)}};
}
try { bmFx = bmFxValid(JSON.parse(localStorage.getItem(BM_FX_KEY) || 'null')); } catch (e) {}
let bmFxSaveT = 0;
const bmFxSave = () => { clearTimeout(bmFxSaveT); bmFxSaveT = setTimeout(() => { try { localStorage.setItem(BM_FX_KEY, JSON.stringify(bmFx)); } catch (e) {} }, 300); };
// есть ли у объекта эффекты, которые надо считать
const bmFxOn = f => !!f && ((f.sh.on && f.sh.a > 0) || (f.gl.on && f.gl.s > 0) || f.bl > 0);
const bmRgba = (hex, a) => { const c = cpParse(hex) || {r: 0, g: 0, b: 0, a: 1}; return `rgba(${c.r},${c.g},${c.b},${+(c.a * a).toFixed(3)})`; };

// ---------- геометрия ----------
// баннер, по которому меряются пиксели эффектов: самый большой
const bmRef = () => bmSlots.reduce((m, s) => !m || s.w * s.h > m.w * m.h ? s : m, null);
const bmZs = (sl, w, h) => Math.min(sl.zw / w, sl.zh / h);
// элемент в баннере sl при правке картинки ad: в пикселях шаблона, без округления
function bmElRect(sl, ad, e) {
  const z = bmZs(sl, e.w, e.h) * ad.k * bmFx.ek, g = bmGeo(sl, ad);
  const w = e.w * z, h = e.h * z;
  return {x: g.cx + bmFx.ex * sl.zw * ad.k - w / 2, y: g.cy + bmFx.ey * sl.zh * ad.k - h / 2, w, h};
}
const bmElCur = () => bmFx.el && bmEls[bmFx.el] && bmEls[bmFx.el].cv ? bmEls[bmFx.el] : null;
// самый крупный объект по всем баннерам: длинная сторона в пикселях шаблона и в пикселях экрана (высота ряда превью z)
function bmNeed(kind) {
  const src = kind === 'art' ? bmImg : bmElCur();
  if (!src) return null;
  const z = +$('bmZoom').value * (devicePixelRatio || 1);
  let full = 0, scr = 0;
  for (const sl of bmSlots) {
    const ad = bmAdj(sl.name);
    const L = kind === 'art' ? Math.max(src.w, src.h) * bmZs(sl, src.w, src.h) * ad.k : (r => Math.max(r.w, r.h))(bmElRect(sl, ad, src));
    full = Math.max(full, L); scr = Math.max(scr, L * z / sl.h);
  }
  return {src, full, scr};
}
// u: пикселей спрайта в одном «пикселе большого баннера» при масштабе f (пикселей спрайта на пиксель источника).
// Мера — объект на большом баннере при размере 100%: дальше эффекты растут вместе с объектом, как слой со стилем в редакторе.
function bmUnit(src, f) {
  const ref = bmRef();
  return ref ? f / bmZs(ref, src.w, src.h) : f;
}

// ---------- спрайт: объект со своими эффектами ----------
// src — холст источника w×h, масштаб f, u — см. bmUnit. Тень и свечение — тенью холста без самого объекта
// (объект рисуется за краем, тень сдвигается обратно), сверху сам объект; блюр элемента — на всё вместе.
function bmSprite(src, fx, f, u) {
  const W = Math.max(1, Math.round(src.w * f)), H = Math.max(1, Math.round(src.h * f));
  const sh = fx.sh.on && fx.sh.a > 0 ? fx.sh : null, gl = fx.gl.on && fx.gl.s > 0 ? fx.gl : null, bl = (fx.bl || 0) * u;
  let pad = 0;
  if (sh) pad = Math.max(pad, sh.d * u + sh.b * u * 1.6);
  if (gl) pad = Math.max(pad, gl.r * u * 1.6);
  pad = Math.ceil(pad + bl * 3 + 2);
  const c = document.createElement('canvas');
  c.width = W + 2 * pad; c.height = H + 2 * pad;
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  const far = c.width + c.height + 64;
  const only = (col, blur, dx, dy) => {
    g.save(); g.shadowColor = col; g.shadowBlur = blur; g.shadowOffsetX = dx + far; g.shadowOffsetY = dy;
    g.drawImage(src.cv, pad - far, pad, W, H); g.restore();
  };
  if (sh) { const r = sh.ang * Math.PI / 180; only(bmRgba(sh.c, sh.a / 100), sh.b * u, Math.cos(r) * sh.d * u, Math.sin(r) * sh.d * u); }
  if (gl) { const col = bmRgba(gl.c, gl.s / 100); only(col, gl.r * u, 0, 0); only(col, gl.r * u / 3, 0, 0); }
  g.drawImage(src.cv, pad, pad, W, H);
  let out = c;
  if (bl > 0.05) {
    out = document.createElement('canvas'); out.width = c.width; out.height = c.height;
    const o = out.getContext('2d'); o.filter = `blur(${bl.toFixed(2)}px)`; o.drawImage(c, 0, 0);
  }
  return {cv: out, px: pad / W, py: pad / H};
}
const bmFxOf = kind => kind === 'art' ? bmFx.art : bmFx.elf;
// что меняет вид спрайта, кроме масштаба: источник и эффекты
const bmSprBase = (kind, src) => JSON.stringify([kind, src.url, bmFxOf(kind)]);
const BM_SPR_MAX = 4096;   // длинная сторона спрайта: больше холст не нужен и тяжёл

// спрайт превью: под размер на экране ступенями, не больше полного; без эффектов — сам источник. true — сменился
async function bmSprPrev(kind) {
  const n = bmNeed(kind), old = bmSpr[kind];
  const drop = () => { if (old && !old.src) URL.revokeObjectURL(old.url); };
  if (!n) { bmSpr[kind] = null; drop(); return !!old; }
  const fx = bmFxOf(kind);
  if (!bmFxOn(fx)) {
    if (old && old.src && old.url === n.src.url) return false;
    bmSpr[kind] = {url: n.src.url, px: 0, py: 0, src: true};
    drop();
    return true;
  }
  let T = 256;
  while (T < n.scr && T < BM_SPR_MAX) T *= 2;
  T = Math.min(T, Math.max(64, Math.ceil(n.full)), BM_SPR_MAX);
  const f = T / Math.max(n.src.w, n.src.h), base = bmSprBase(kind, n.src);
  // те же настройки и масштаб тот же или крупнее (но не больше чем вчетверо) — пересчитывать незачем
  if (old && !old.src && old.base === base && old.f >= f * 0.999 && old.f <= f * 4) return false;
  const s = bmSprite(n.src, fx, f, bmUnit(n.src, f));
  const blob = await new Promise(res => s.cv.toBlob(res, 'image/png'));
  if (!blob) return false;
  const url = URL.createObjectURL(blob), im = new Image();
  im.src = url;
  try { await im.decode(); } catch (e) {}   // показываем уже разобранную картинку: без мигания
  bmSpr[kind] = {base, f, url, px: s.px, py: s.py};
  drop();
  return true;
}
// пересчёт спрайтов превью: один за раз, последняя правка не теряется
let bmSprBusy = false, bmSprAgain = false;
async function bmSprSoon() {
  if (bmSprBusy) { bmSprAgain = true; return; }
  bmSprBusy = true;
  try {
    do {
      bmSprAgain = false;
      const a = await bmSprPrev('art'), e = await bmSprPrev('el');
      if (a || e) bmPlace();
    } while (bmSprAgain);
  } finally { bmSprBusy = false; }
}
// новая картинка или её нет: старый спрайт больше не годится
function bmFxNewArt() {
  if (bmSpr.art && !bmSpr.art.src) URL.revokeObjectURL(bmSpr.art.url);
  bmSpr.art = null; bmSprFull.art = null;
  bmSprSoon();
}
// спрайт полного размера для сборки, в кэше по настройкам
function bmSprBig(kind) {
  const n = bmNeed(kind);
  if (!n) return null;
  const fx = bmFxOf(kind);
  if (!bmFxOn(fx)) return {cv: n.src.cv, px: 0, py: 0};
  const f = Math.min(n.full, BM_SPR_MAX) / Math.max(n.src.w, n.src.h), key = bmSprBase(kind, n.src) + f.toFixed(6);
  if (bmSprFull[kind] && bmSprFull[kind].key === key) return bmSprFull[kind];
  const s = bmSprite(n.src, fx, f, bmUnit(n.src, f));
  return (bmSprFull[kind] = {key, cv: s.cv, px: s.px, py: s.py});
}

// ---------- превью: где на плитке спрайты ----------
// css-переменные спрайтов картинки и элемента для плитки баннера sl; p — место самой картинки из bmFit (в процентах)
function bmFxVars(f, sl, ad, p) {
  const a = bmSpr.art || {px: 0, py: 0, url: bmImg.url};
  let s = `;--al:${p.l - p.w * a.px};--at:${p.t - p.h * a.py};--aw:${p.w * (1 + 2 * a.px)};--ah:${p.h * (1 + 2 * a.py)}`;
  const ai = f.querySelector('img.art');
  if (ai && ai.getAttribute('src') !== a.url) ai.src = a.url;
  const e = bmElCur(), q = e && bmSpr.el;
  f.classList.toggle('hasel', !!q);
  if (q) {
    const r = bmElRect(sl, ad, e);
    s += `;--el:${(r.x - r.w * q.px) / sl.w * 100};--et:${(r.y - r.h * q.py) / sl.h * 100};--ew:${r.w * (1 + 2 * q.px) / sl.w * 100};--eh:${r.h * (1 + 2 * q.py) / sl.h * 100}`;
    const ei = f.querySelector('img.el');
    if (ei && ei.getAttribute('src') !== q.url) ei.src = q.url;
  }
  return s;
}

// ---------- сборка: баннер целиком на холсте ----------
const bmTpls = {};
function bmTpl(name) {
  return bmTpls[name] || (bmTpls[name] = new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = `/bannerbg/${name}.png`; }));
}
// пиксели баннера sl (RGBA, как getImageData): шаблон, элемент, картинка — со спрайтами полного размера.
// PNG из них делает Go: кодировать здесь — секунда на большой баннер
async function bmFxBanner(sl) {
  const tpl = await bmTpl(sl.name);
  const c = document.createElement('canvas'); c.width = sl.w; c.height = sl.h;
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(tpl, 0, 0, sl.w, sl.h);
  const ad = bmAdj(sl.name), e = bmElCur();
  const put = (s, r) => g.drawImage(s.cv, r.x - r.w * s.px, r.y - r.h * s.py, r.w * (1 + 2 * s.px), r.h * (1 + 2 * s.py));
  if (e) put(bmSprBig('el'), bmElRect(sl, ad, e));
  put(bmSprBig('art'), bmFitPx(sl, bmImg.w, bmImg.h, ad));
  return g.getImageData(0, 0, sl.w, sl.h).data;
}
// отдать пиксели серверу (/api/bmk-one): тело — сами байты, не JSON
async function bmFxPut(id, name, pix, signal) {
  try {
    const r = await fetch(`/api/bmk-one?id=${encodeURIComponent(id)}&name=${encodeURIComponent(name)}`,
      {method: 'POST', headers: {'X-Token': TOKEN, 'Content-Type': 'application/octet-stream'}, body: pix, signal});
    return await r.json();
  } catch (e) { return e && e.name === 'AbortError' ? {aborted: true, error: ''} : {error: t('net.err')}; }
}

// ---------- источники: элемент без прозрачных полей ----------
// холст непрозрачной части картинки (альфа больше 8 из 255); совсем прозрачная — целиком
function bmTrimCanvas(img) {
  const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d', {willReadFrequently: true}); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, W, H).data;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (d[(y * W + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) { x0 = 0; y0 = 0; x1 = W - 1; y1 = H - 1; }
  const o = document.createElement('canvas'); o.width = x1 - x0 + 1; o.height = y1 - y0 + 1;
  o.getContext('2d').drawImage(c, x0, y0, o.width, o.height, 0, 0, o.width, o.height);
  return {cv: o, w: o.width, h: o.height, trimmed: o.width !== W || o.height !== H};
}
async function bmElLoad(name) {
  if (!name || bmEls[name]) return;
  bmEls[name] = {};
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = `/bannershapes/${encodeURIComponent(name)}.png`; });
    const t = bmTrimCanvas(img);
    const blob = await new Promise(res => t.cv.toBlob(res, 'image/png'));
    bmEls[name] = {...t, url: URL.createObjectURL(blob)};
  } catch (e) { delete bmEls[name]; }
}

// ---------- панель «Оформление» ----------
// строки ползунков: [контейнер, путь, текст, min, max, шаг, риска, единица, множитель]; путь без точки — у элемента,
// с точкой — у эффектов выбранного объекта (картинка или элемент)
const BM_ROWS = [
  ['bmElPos', 'ek', 'bm.fxSize', 20, 300, 1, 150, '%', 100],
  ['bmElPos', 'ex', 'bm.fxX', -100, 100, 1, 0, '%', 100],
  ['bmElPos', 'ey', 'bm.fxY', -100, 100, 1, 0, '%', 100],
  ['bmShBox', 'sh.c', 'bm.fxColor'],
  ['bmShBox', 'sh.a', 'bm.fxOp', 0, 100, 1, BM_SH0.a, '%', 1],
  ['bmShBox', 'sh.d', 'bm.fxDist', 0, 80, 1, BM_SH0.d, 'px', 1],
  ['bmShBox', 'sh.ang', 'bm.fxAng', 0, 360, 1, BM_SH0.ang, '°', 1],
  ['bmShBox', 'sh.b', 'bm.fxBlur', 0, 80, 1, BM_SH0.b, 'px', 1],
  ['bmGlBox', 'gl.c', 'bm.fxColor'],
  ['bmGlBox', 'gl.r', 'bm.fxRad', 1, 120, 1, BM_GL0.r, 'px', 1],
  ['bmGlBox', 'gl.s', 'bm.fxStr', 0, 100, 1, BM_GL0.s, '%', 1],
  ['bmBlBox', 'bl', 'bm.fxBl', 0, 60, 0.5, 0, 'px', 1],
];
// где лежит значение пути: элемент (ek, ex, ey) — в самом bmFx, остальное — у выбранного объекта
function bmFxRef(path) {
  if (!path.includes('.')) {
    if (path === 'bl') return [bmFx.elf, 'bl'];
    return [bmFx, path];
  }
  const [a, b] = path.split('.');
  return [bmFxOf(bmFxObj)[a], b];
}
const bmFxGet = p => { const [o, k] = bmFxRef(p); return o[k]; };
function bmFxPanel() {
  const ids = [...new Set(BM_ROWS.map(r => r[0]))];
  for (const id of ids) $(id).innerHTML = '';
  for (const [box, p, key, min, max, step, origin, unit] of BM_ROWS) {
    const el = $(box);
    if (min === undefined) {
      el.insertAdjacentHTML('beforeend', `<div class="bm-fr"><span data-i18n="${key}">${t(key)}</span><button type="button" class="cp-sw" data-p="${p}" data-i18n-aria="${key}" aria-label="${esc(t(key))}"></button></div>`);
      const sw = el.querySelector(`.cp-sw[data-p="${p}"]`);
      const put = v => { const [o, k] = bmFxRef(p); if (o[k] !== v) { o[k] = v; bmFxChanged(); } };
      cpField(sw, {live: put, done: () => put(sw.value)});
      sw.addEventListener('click', () => bmMark());
      continue;
    }
    const tip = unit === 'px' ? ` title="${esc(t('bm.fxPx'))}" data-i18n-title="bm.fxPx"` : '';
    el.insertAdjacentHTML('beforeend', `<div class="bm-fr"${tip}><span data-i18n="${key}">${t(key)}</span><label class="bm-kn"><input type="number" class="bm-num" data-p="${p}" min="${min}" max="${max}" step="${step}" data-i18n-aria="${key}" aria-label="${esc(t(key))}"><i>${unit}</i></label></div>` +
      `<input type="range" class="vol" data-p="${p}" min="${min}" max="${max}" step="${step}" data-origin="${origin}" data-snap="6" data-i18n-aria="${key}" aria-label="${esc(t(key))}">`);
  }
  if (!$('bmElRs')) $('bmElPos').insertAdjacentHTML('beforeend', `<button class="btn sm bm-elrs" id="bmElRs"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg><span data-i18n="bm.reset">${t('bm.reset')}</span></button>`);
  document.querySelectorAll('#bmLook input[type=range][data-origin]').forEach(slPlace);
}
const bmRow = p => BM_ROWS.find(r => r[1] === p);
// значения в поля панели
function bmFxSync() {
  const busy = bmBusy, e = !!bmFx.el, elf = bmFxObj === 'elf';
  $('bmLook').classList.toggle('off', busy);
  $('bmShapes').querySelectorAll('button').forEach(b => b.classList.toggle('on', (b.dataset.n || '') === bmFx.el));
  $('bmElPos').classList.toggle('hide', !e);
  document.querySelectorAll('#bmFxObj .segb').forEach(b => b.classList.toggle('on', b.dataset.o === bmFxObj));
  $('bmFxHint').classList.toggle('hide', !(elf && !e));
  $('bmFxBody').classList.toggle('dis', elf && !e);
  const fx = bmFxOf(bmFxObj);
  $('bmShOn').checked = fx.sh.on; $('bmGlOn').checked = fx.gl.on;
  $('bmShBox').classList.toggle('hide', !fx.sh.on);
  $('bmGlBox').classList.toggle('hide', !fx.gl.on);
  $('bmBlBox').classList.toggle('hide', !elf);
  document.querySelectorAll('#bmLook [data-p]').forEach(el => {
    const p = el.dataset.p, v = bmFxGet(p);
    if (el.matches('.cp-sw')) { if (!(cp && cp.el === el) && el.value !== v) el.value = v; return; }
    const m = bmRow(p)[8], n = Math.round(v * m * 100) / 100;
    if (el.type === 'range') el.value = n;
    else if (document.activeElement !== el) el.value = n;
  });
}
// после любой правки: превью, сохранение, панель
function bmFxChanged(place) {
  bmFxSave();
  bmFxSync();
  if (place) bmPlace();
  bmSprSoon();
}
// набор настроек целиком (отмена, загрузка): элемент мог смениться
async function bmFxSetAll(o) {
  bmFx = bmFxValid(o);
  bmFxChanged(true);
  if (bmFx.el && !bmEls[bmFx.el]) { await bmElLoad(bmFx.el); bmFxChanged(true); }
}
let bmFxMarkOn = false;   // ползунок и число: один шаг отмены на всё движение
function bmFxInput(el) {
  const p = el.dataset.p, r = bmRow(p), v = +el.value;
  if (el.value === '' || !Number.isFinite(v)) return;
  if (!bmFxMarkOn) { bmMark(); bmFxMarkOn = true; }
  const [o, k] = bmFxRef(p);
  o[k] = Math.min(Math.max(v, r[3]), r[4]) / r[8];
  bmFxChanged(!p.includes('.') && p !== 'bl');
}
$('bmLook').addEventListener('input', e => { if (e.target.matches('input[data-p]')) bmFxInput(e.target); });
$('bmLook').addEventListener('change', e => { if (e.target.matches('input[data-p]')) { bmFxMarkOn = false; bmFxSync(); } });
$('bmLook').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('.bm-num')) e.target.blur(); });
$('bmLook').addEventListener('dblclick', e => {   // двойной щелчок по ползунку — снова к риске
  const r = e.target.closest('input[type=range][data-p]');
  if (!r) return;
  bmMark(); r.value = r.dataset.origin; bmFxInput(r); bmFxMarkOn = false;
});
$('bmLook').addEventListener('click', e => {
  if (e.target.closest('#bmElRs')) { bmMark(); Object.assign(bmFx, {ek: 1.5, ex: 0, ey: 0}); bmFxChanged(true); return; }
  const s = e.target.closest('#bmShapes button');
  if (s) { bmElPick(s.dataset.n || ''); return; }
  const o = e.target.closest('#bmFxObj .segb');
  if (o) { bmFxObj = o.dataset.o; bmFxSync(); }
});
['Sh', 'Gl'].forEach(w => $(`bm${w}On`).addEventListener('change', e => {
  bmMark();
  bmFxOf(bmFxObj)[w.toLowerCase()].on = e.target.checked;
  bmFxChanged();
}));
async function bmElPick(name) {
  if (name === bmFx.el) return;
  bmMark();
  bmFx.el = name;
  bmFxChanged(true);
  if (name && !bmEls[name]) { await bmElLoad(name); bmFxChanged(true); }
}
// список элементов: «без элемента» и плитки с картинками
function bmShapesFill(list) {
  bmShapes = list || [];
  if (bmFx.el && !bmShapes.includes(bmFx.el)) bmFx.el = '';
  const none = `<button type="button" class="none" data-n="" title="${esc(t('bm.elNone'))}" data-i18n-title="bm.elNone"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="8"/><path d="M6.5 17.5l11-11"/></svg></button>`;
  $('bmShapes').innerHTML = none + bmShapes.map(n => `<button type="button" data-n="${esc(n)}" title="${esc(n)}"><img src="/bannershapes/${encodeURIComponent(n)}.png" alt="" draggable="false" loading="lazy"></button>`).join('');
  bmFxSync();
  if (bmFx.el) bmElLoad(bmFx.el).then(() => bmFxChanged(true));
}
bmFxPanel();
bmFxSync();
