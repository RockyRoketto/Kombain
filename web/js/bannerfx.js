// ---------- «Сборка баннеров»: фоновый элемент, тень, свечение и готовые баннеры на холсте (bannermake.js) ----------
// Элемент — PNG из web/bannershapes, один на все баннеры: лежит под картинкой, вписан в сейв-зону как она,
// дальше свой размер ek, сдвиг ex, ey (в долях зоны) и поворот er (градусы, вокруг центра фигуры). Двигается и растёт вместе с картинкой, за зону выходить может.
// Эффекты считаются один раз на объект в «спрайт»: объект с полями под тень и свечение. На всех баннерах спрайт
// просто масштабируется: пиксели эффектов заданы как на самом большом баннере и растут вместе с объектом.
// Превью берёт спрайт под размер на экране (ступенями 256, 512, 1024…), сборка — спрайт полного размера (кэш по настройкам).
// Готовый баннер целиком собирается здесь же на холсте, Go только сохраняет PNG, JPEG и WebP: файл ровно как превью.
const BM_FX_KEY = 'k9000.bmfx';
const BM_SH0 = {on: false, c: '#000000', a: 55, d: 10, ang: 90, b: 18};
const BM_GL0 = {on: false, c: '#ffe2a8', r: 24, s: 60};
const BM_EL_D = 8;   // предел сдвига элемента в долях сейв-зоны (как у картинки): на широком баннере дотянуть до его середины
const bmFxDef = () => ({el: '', ek: 1.5, ex: 0, ey: 0, er: 0, art: {sh: {...BM_SH0}, gl: {...BM_GL0}}, elf: {sh: {...BM_SH0}, gl: {...BM_GL0}, bl: 0}});
let bmFx = bmFxDef();
let bmFxObj = 'art';        // чьи эффекты в панели: art — картинка, elf — элемент
let bmLpReady = false;     // «Крупно» уже настроено (bmObjSync зовётся и раньше)
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
  return {el: typeof o.el === 'string' ? o.el : '', ek: bmNum(o.ek, 0.2, 3, 1.5), ex: bmNum(o.ex, -BM_EL_D, BM_EL_D, 0), ey: bmNum(o.ey, -BM_EL_D, BM_EL_D, 0), er: bmNum(o.er, 0, 360, 0),
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
// Повёрнутая фигура описана рамкой по её краям (bmRotBox): центр рамки — центр фигуры, поворот идёт вокруг него.
function bmRotBox(w, h, deg) {
  const a = (deg || 0) * Math.PI / 180, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
  return {w: w * c + h * s, h: w * s + h * c};
}
const bmRotOf = kind => kind === 'el' ? bmFx.er : 0;
// Фоновый элемент не зависит от правки картинки: двигаешь картинку — фон стоит. Середина — середина сейв-зоны
// плюс сдвиг ex, ey (в долях её ширины и высоты), размер — вписан в сейв-зону и умножен на ek.
// элемент в баннере sl без поворота: середина и размер в пикселях шаблона
function bmElGeo(sl, e) {
  const z = bmZs(sl, e.w, e.h) * bmFx.ek;
  return {cx: bmZx(sl) + bmFx.ex * sl.zw, cy: bmZy(sl) + bmFx.ey * sl.zh, w: e.w * z, h: e.h * z};
}
// рамка элемента по краям с учётом поворота, в пикселях шаблона, без округления
function bmElRect(sl, e) {
  const g = bmElGeo(sl, e), b = bmRotBox(g.w, g.h, bmFx.er);
  return {x: g.cx - b.w / 2, y: g.cy - b.h / 2, w: b.w, h: b.h};
}
// магнит: ближайшая к v точка из list, если до неё меньше tol; иначе null
function bmSnapTo(v, list, tol) {
  let best = null;
  for (const c of list) if (Math.abs(v - c) < tol && (best == null || Math.abs(v - c) < Math.abs(v - best))) best = c;
  return best;
}
// куда прилипает середина объекта в баннере sl: середина баннера и середина сейв-зоны, по каждой оси
const bmSnapX = sl => [sl.w / 2, bmZx(sl)], bmSnapY = sl => [sl.h / 2, bmZy(sl)];
const bmElCur = () => bmFx.el && bmEls[bmFx.el] && bmEls[bmFx.el].cv ? bmEls[bmFx.el] : null;
// самый крупный объект по всем баннерам: длинная сторона в пикселях шаблона и в пикселях экрана (высота ряда превью z)
function bmNeed(kind) {
  const src = kind === 'art' ? bmImg : bmElCur();
  if (!src) return null;
  const z = +$('bmZoom').value * (devicePixelRatio || 1);
  let full = 0, scr = 0;
  for (const sl of bmSlots) {
    const ad = bmAdj(sl.name);
    const L = kind === 'art' ? Math.max(src.w, src.h) * bmZs(sl, src.w, src.h) * ad.k : (r => Math.max(r.w, r.h))(bmElRect(sl, src));
    full = Math.max(full, L); scr = Math.max(scr, L * z / sl.h);
  }
  scr = Math.max(scr, bmLpNeed(kind));   // в «Крупно» объект больше, чем на плитке
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
// rot — поворот объекта в градусах: тень и свечение считаются уже у повёрнутого (направление тени от поворота не зависит)
function bmSprite(src, fx, f, u, rot = 0) {
  const W = Math.max(1, Math.round(src.w * f)), H = Math.max(1, Math.round(src.h * f));
  const bb = bmRotBox(W, H, rot), BW = Math.max(1, Math.round(bb.w)), BH = Math.max(1, Math.round(bb.h));
  const sh = fx.sh.on && fx.sh.a > 0 ? fx.sh : null, gl = fx.gl.on && fx.gl.s > 0 ? fx.gl : null, bl = (fx.bl || 0) * u;
  let pad = 0;
  if (sh) pad = Math.max(pad, sh.d * u + sh.b * u * 1.6);
  if (gl) pad = Math.max(pad, gl.r * u * 1.6);
  pad = Math.ceil(pad + bl * 3 + 2);
  const c = document.createElement('canvas');
  c.width = BW + 2 * pad; c.height = BH + 2 * pad;
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  const far = c.width + c.height + 64, cx = pad + BW / 2, cy = pad + BH / 2, ang = rot * Math.PI / 180;
  const put = ox => { g.save(); g.translate(cx + ox, cy); g.rotate(ang); g.drawImage(src.cv, -W / 2, -H / 2, W, H); g.restore(); };
  // сдвиг и размытие тени заданы в пикселях холста и поворотом не меняются
  const only = (col, blur, dx, dy) => {
    g.save(); g.shadowColor = col; g.shadowBlur = blur; g.shadowOffsetX = dx + far; g.shadowOffsetY = dy;
    put(-far); g.restore();
  };
  if (sh) { const r = sh.ang * Math.PI / 180; only(bmRgba(sh.c, sh.a / 100), sh.b * u, Math.cos(r) * sh.d * u, Math.sin(r) * sh.d * u); }
  if (gl) { const col = bmRgba(gl.c, gl.s / 100); only(col, gl.r * u, 0, 0); only(col, gl.r * u / 3, 0, 0); }
  put(0);
  let out = c;
  if (bl > 0.05) {
    out = document.createElement('canvas'); out.width = c.width; out.height = c.height;
    const o = out.getContext('2d'); o.filter = `blur(${bl.toFixed(2)}px)`; o.drawImage(c, 0, 0);
  }
  return {cv: out, px: pad / BW, py: pad / BH};
}
const bmFxOf = kind => kind === 'art' ? bmFx.art : bmFx.elf;
// что меняет вид спрайта, кроме масштаба: источник и эффекты
const bmSprBase = (kind, src) => JSON.stringify([kind, src.url, bmFxOf(kind), bmRotOf(kind)]);
// спрайт нужен, если есть эффекты или фигура повёрнута
const bmSprNeeded = kind => bmFxOn(bmFxOf(kind)) || bmRotOf(kind) % 360 !== 0;
// длинная сторона источника после поворота: от неё считается масштаб спрайта
const bmSrcMax = (kind, src) => { const b = bmRotBox(src.w, src.h, bmRotOf(kind)); return Math.max(b.w, b.h); };
const BM_SPR_MAX = 4096;   // длинная сторона спрайта: больше холст не нужен и тяжёл

// спрайт превью: под размер на экране ступенями, не больше полного; без эффектов — сам источник. true — сменился
async function bmSprPrev(kind) {
  const n = bmNeed(kind), old = bmSpr[kind];
  const drop = () => { if (old && !old.src) URL.revokeObjectURL(old.url); };
  if (!n) { bmSpr[kind] = null; drop(); return !!old; }
  const fx = bmFxOf(kind);
  if (!bmSprNeeded(kind)) {
    if (old && old.src && old.url === n.src.url) return false;
    bmSpr[kind] = {url: n.src.url, px: 0, py: 0, src: true};
    drop();
    return true;
  }
  let T = 256;
  while (T < n.scr && T < BM_SPR_MAX) T *= 2;
  if (bmLp.hold) T = Math.min(T, 1024);   // пока двигаешь ползунок в «Крупно», спрайт грубее и быстрее; точный — после отпускания
  T = Math.min(T, Math.max(64, Math.ceil(n.full)), BM_SPR_MAX);
  const f = T / bmSrcMax(kind, n.src), base = bmSprBase(kind, n.src);
  // те же настройки и масштаб тот же или крупнее (но не больше чем вчетверо) — пересчитывать незачем
  if (old && !old.src && old.base === base && old.f >= f * 0.999 && old.f <= f * 4) return false;
  const s = bmSprite(n.src, fx, f, bmUnit(n.src, f), bmRotOf(kind));
  // WebP, а не PNG: спрайт 1024 px PNG кодируется около секунды, WebP — в разы быстрее, и ползунок отзывается вживую.
  // Это только превью: сборка берёт спрайт полного размера прямо с холста (bmSprBig), без кодирования
  const blob = await new Promise(res => s.cv.toBlob(res, 'image/webp', 0.95));
  if (!blob) return false;
  const url = URL.createObjectURL(blob), im = new Image();
  im.src = url;
  // показываем уже разобранную картинку: без мигания. В свёрнутом окне decode может не прийти — ждём недолго
  try { await Promise.race([im.decode(), new Promise(r => setTimeout(r, 500))]); } catch (e) {}
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
  if (!bmSprNeeded(kind)) return {cv: n.src.cv, px: 0, py: 0};
  const f = Math.min(n.full, BM_SPR_MAX) / bmSrcMax(kind, n.src), key = bmSprBase(kind, n.src) + f.toFixed(6);
  if (bmSprFull[kind] && bmSprFull[kind].key === key) return bmSprFull[kind];
  const s = bmSprite(n.src, fx, f, bmUnit(n.src, f), bmRotOf(kind));
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
    const r = bmElRect(sl, e);
    // --r*: сам элемент без полей эффектов — пунктир «правишь фон»
    s += `;--rl:${r.x / sl.w * 100};--rt:${r.y / sl.h * 100};--rw:${r.w / sl.w * 100};--rh:${r.h / sl.h * 100}`;
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
  if (e) put(bmSprBig('el'), bmElRect(sl, e));
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
// холст непрозрачной части картинки (альфа больше нуля); совсем прозрачная — целиком.
// Порог именно ноль: у свечений и дыма хвост с альфой в единицы, срез по нему виден ровным прямоугольником
function bmTrimCanvas(img) {
  const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d', {willReadFrequently: true}); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, W, H).data;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (d[(y * W + x) * 4 + 3] > 0) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
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
// строки ползунков: [контейнер, путь, текст, min, max, шаг, риска, единица, множитель, ноль в центре, предел числа]; путь без точки — у элемента,
// с точкой — у эффектов выбранного объекта (картинка или элемент)
const BM_ROWS = [
  ['bmElPos', 'ek', 'bm.fxSize', 20, 300, 1, 150, '%', 100],
  ['bmElPos', 'ex', 'bm.fxX', -100, 100, 1, 0, '%', 100, false, BM_EL_D * 100],   // число шире ползунка: мышью фон уезжает дальше
  ['bmElPos', 'ey', 'bm.fxY', -100, 100, 1, 0, '%', 100, false, BM_EL_D * 100],
  ['bmElPos', 'er', 'bm.fxRot', -180, 180, 1, 0, '°', 1, true],   // ноль в центре; хранится 0…360, как раньше
  ['bmShC', 'sh.c', 'bm.fxColor'],   // цвет — в строке переключателя
  ['bmShBox', 'sh.a', 'bm.fxOp', 0, 100, 1, BM_SH0.a, '%', 1],
  ['bmShBox', 'sh.d', 'bm.fxDist', 0, 80, 1, BM_SH0.d, 'px', 1],
  ['bmShBox', 'sh.ang', 'bm.fxAng', 0, 360, 1, BM_SH0.ang, '°', 1],
  ['bmShBox', 'sh.b', 'bm.fxBlur', 0, 80, 1, BM_SH0.b, 'px', 1],
  ['bmGlC', 'gl.c', 'bm.fxColor'],
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
// панель — два раздела: «Фоновый элемент» и «Тень и свечение»
const BM_FX_CARDS = ['bmLook', 'bmFxCard'];
const bmFxAll = sel => document.querySelectorAll(BM_FX_CARDS.map(id => `#${id} ${sel}`).join(', '));
const bmFxOnCards = (ev, fn) => BM_FX_CARDS.forEach(id => $(id).addEventListener(ev, fn));
function bmFxPanel() {
  const ids = [...new Set(BM_ROWS.map(r => r[0]))];
  for (const id of ids) $(id).innerHTML = '';
  for (const [box, p, key, min, max, step, origin, unit, , , nl] of BM_ROWS) {
    const el = $(box);
    if (min === undefined) {
      el.insertAdjacentHTML('beforeend', `<button type="button" class="cp-sw bm-cs" data-p="${p}" data-i18n-title="${key}" title="${esc(t(key))}" data-i18n-aria="${key}" aria-label="${esc(t(key))}"></button>`);
      const sw = el.querySelector(`.cp-sw[data-p="${p}"]`);
      const put = v => { const [o, k] = bmFxRef(p); if (o[k] !== v) { o[k] = v; bmFxChanged(); } };
      cpField(sw, {live: put, done: () => put(sw.value)});
      sw.addEventListener('click', () => bmMark());
      continue;
    }
    const tip = unit === 'px' ? ` title="${esc(t('bm.fxPx'))}" data-i18n-title="bm.fxPx"` : '';
    // одна строка: подпись, ползунок, число с единицей
    el.insertAdjacentHTML('beforeend', `<div class="bm-sl"${tip}><span data-i18n="${key}">${t(key)}</span>` +
      `<input type="range" class="vol" data-p="${p}" min="${min}" max="${max}" step="${step}" data-origin="${origin}" data-fill="${min < 0 ? 'mid' : 'left'}" data-snap="6" data-i18n-aria="${key}" aria-label="${esc(t(key))}">` +
      `<label class="bm-kn"><input type="number" class="bm-num" data-p="${p}" min="${nl ? -nl : min}" max="${nl || max}" step="${step}" data-i18n-aria="${key}" aria-label="${esc(t(key))}"><i>${unit}</i></label></div>`);
  }
  if (!$('bmElRs')) $('bmElPos').insertAdjacentHTML('beforeend', `<button class="btn sm bm-elrs" id="bmElRs"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg><span data-i18n="bm.reset">${t('bm.reset')}</span></button>`);
  bmFxAll('input[type=range][data-origin]').forEach(r => { slPlace(r); slFill(r); });
}
const bmRow = p => BM_ROWS.find(r => r[1] === p);
// значения в поля панели
function bmFxSync() {
  const busy = bmBusy, e = !!bmFx.el, elf = bmFxObj === 'elf';
  BM_FX_CARDS.forEach(id => $(id).classList.toggle('off', busy));
  $('bmShapes').querySelectorAll('button').forEach(b => { const on = (b.dataset.n || '') === bmFx.el; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
  bmPkSync();
  $('bmElPos').classList.toggle('hide', !e);
  bmObjSync();
  $('bmFxHint').classList.toggle('hide', !(elf && !e));
  $('bmFxBody').classList.toggle('dis', elf && !e);
  const fx = bmFxOf(bmFxObj);
  $('bmShOn').checked = fx.sh.on; $('bmGlOn').checked = fx.gl.on;
  $('bmShBox').classList.toggle('hide', !fx.sh.on);
  $('bmGlBox').classList.toggle('hide', !fx.gl.on);
  $('bmBlBox').classList.toggle('hide', !elf);
  // сброс тени и свечения — только когда есть что сбрасывать
  $('bmShRs').disabled = bmSame(fx.sh, {...BM_SH0, on: fx.sh.on});
  $('bmGlRs').disabled = bmSame(fx.gl, {...BM_GL0, on: fx.gl.on});
  bmFxAll('[data-p]').forEach(el => {
    const p = el.dataset.p, v = bmFxGet(p);
    if (el.matches('.cp-sw')) { if (!(cp && cp.el === el) && el.value !== v) el.value = v; return; }
    const row = bmRow(p), m = row[8];
    let n = Math.round(v * m * 100) / 100;
    if (row[9] && n > 180) n -= 360;   // поворот: 270° показываем как −90°
    if (el.type === 'range') { el.value = n; slFill(el); }
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
  const lo = el.type === 'number' && r[10] ? -r[10] : r[3], hi = el.type === 'number' && r[10] ? r[10] : r[4];
  let n = Math.min(Math.max(v, lo), hi);
  if (r[9] && n < 0) n += 360;
  o[k] = n / r[8];
  bmFxChanged(!p.includes('.') && p !== 'bl');
}
bmFxOnCards('input', e => { if (e.target.matches('input[data-p]')) bmFxInput(e.target); });
bmFxOnCards('change', e => { if (e.target.matches('input[data-p]')) { bmFxMarkOn = false; bmFxSync(); } });
bmFxOnCards('keydown', e => { if (e.key === 'Enter' && e.target.matches('.bm-num')) e.target.blur(); });
bmFxOnCards('dblclick', e => {   // двойной щелчок по ползунку — снова к риске
  const r = e.target.closest('input[type=range][data-p]');
  if (!r) return;
  bmMark(); r.value = r.dataset.origin; bmFxInput(r); bmFxMarkOn = false;
});
bmFxOnCards('click', e => {
  if (e.target.closest('#bmElRs')) { bmMark(); Object.assign(bmFx, {ek: 1.5, ex: 0, ey: 0, er: 0}); bmFxChanged(true); return; }
});
['Sh', 'Gl'].forEach(w => $(`bm${w}On`).addEventListener('change', e => {
  bmMark();
  bmFxOf(bmFxObj)[w.toLowerCase()].on = e.target.checked;
  bmFxChanged();
}));
// сброс тени или свечения выбранного объекта: значения как в начале, включённость та же
$('bmShRs').onclick = () => { const f = bmFxOf(bmFxObj); bmMark(); f.sh = {...BM_SH0, on: f.sh.on}; bmFxChanged(); };
$('bmGlRs').onclick = () => { const f = bmFxOf(bmFxObj); bmMark(); f.gl = {...BM_GL0, on: f.gl.on}; bmFxChanged(); };

// ---------- что правим: картинку или фоновый элемент ----------
// Выбор сверху панели решает, какие разделы видны («Положение картинки» или «Фоновый элемент»), чьи тень и свечение
// в разделе эффектов, кого тянет мышь и стрелки в превью, и что подсвечено на плитках (у фона — пунктир, картинка бледнее).
const bmSame = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const BM_NONE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="8"/><path d="M6.5 17.5l11-11"/></svg>';
// есть ли что сбрасывать у объекта kind
function bmObjDirty(kind) {
  if (kind === 'art') {
    if (!bmIsId(bmAll) || Object.values(bmOne).some(a => !bmIsId(a))) return true;
    return !bmSame(bmFx.art, {sh: BM_SH0, gl: BM_GL0});
  }
  const d = bmFxDef();
  return bmFx.ek !== d.ek || bmFx.ex !== d.ex || bmFx.ey !== d.ey || bmFx.er !== d.er || !bmSame(bmFx.elf, d.elf);
}
function bmObjSync() {
  const elf = bmFxObj === 'elf', e = bmElCur();
  document.querySelectorAll('#bmObj button, #bmLpK button').forEach(b => { b.classList.toggle('on', b.dataset.o === bmFxObj); b.disabled = bmBusy; });
  const at = $('bmObjArt'), et = $('bmObjEl');
  const ah = bmImg ? `<img src="${bmImg.url}" alt="">` : BM_NONE_ICON, eh = bmFx.el ? `<img src="/bannershapes/${encodeURIComponent(bmFx.el)}.png" alt="">` : BM_NONE_ICON;
  if (at.bmHtml !== ah) { at.innerHTML = ah; at.bmHtml = ah; }
  if (et.bmHtml !== eh) { et.innerHTML = eh; et.bmHtml = eh; }
  $('bmPosCard').classList.toggle('hide', elf);
  $('bmLook').classList.toggle('hide', !elf);
  // ключ в data-i18n: при смене языка текст переведёт applyLang
  const lbl = (id, key) => { const el = $(id); if (el.dataset.i18n !== key) { el.dataset.i18n = key; el.textContent = t(key); } };
  lbl('bmFxTitle', elf ? 'bm.fxsEl' : 'bm.fxsArt');
  lbl('bmShTx', elf ? 'bm.shEl' : 'bm.shArt');
  lbl('bmGlTx', elf ? 'bm.glEl' : 'bm.glArt');
  lbl('bmRsAllTx', elf ? 'bm.rsAllEl' : 'bm.rsAllArt');
  $('bmRsAll').disabled = bmBusy || !bmObjDirty(bmFxObj);
  $('bmGrid').classList.toggle('o-elf', elf && !!e);
  $('bmLp').classList.toggle('o-elf', elf && !!e);
  if (bmLpReady) bmLpDraw();   // подпись режима и рамка выбранного в «Крупно»
}
// выбрать объект: единственное место, где меняется bmFxObj (панель, переключатель и щелчок в «Крупно»).
// Пока тянешь мышью, выбор не меняется: тянется тот, кого взяли
function bmObjSet(kind) {
  if (kind === bmFxObj || bmDrag || (kind !== 'art' && kind !== 'elf')) return;
  bmFxObj = kind;
  bmFxSync(); bmEditSync(); bmPlace();
}
$('bmObj').addEventListener('click', e => {
  const b = e.target.closest('button[data-o]');
  if (b && !b.disabled) bmObjSet(b.dataset.o);
});
// «Сбросить всё» у выбранного объекта: у картинки — общая и свои правки, тень, свечение; у фона — размер, сдвиг, эффекты.
// Сам выбранный элемент остаётся
$('bmRsAll').onclick = () => {
  if (!bmObjDirty(bmFxObj)) return;
  bmMark();
  if (bmFxObj === 'art') {
    bmAll = {...BM_ID};
    for (const n in bmOne) delete bmOne[n];
    bmFx.art = {sh: {...BM_SH0}, gl: {...BM_GL0}};
  } else {
    const d = bmFxDef();
    Object.assign(bmFx, {ek: d.ek, ex: d.ex, ey: d.ey, er: d.er, elf: d.elf});
  }
  bmEditSync();
  bmFxChanged(true);
};

// ---------- пока двигают ползунок: в превью только результат, без рамок, пунктира и меток ----------
$('bmView').querySelector('.col.one').addEventListener('pointerdown', e => {
  if (e.button === 0 && e.target.matches('input[type=range]')) $('bmGrid').classList.add('clean');
});
const bmCleanOff = () => $('bmGrid').classList.remove('clean');
addEventListener('pointerup', bmCleanOff);
addEventListener('pointercancel', bmCleanOff);
addEventListener('blur', bmCleanOff);

// ---------- «Крупно»: баннер целиком по центру, колесо и кнопки приближают, мышь двигает ----------
// Те же спрайты превью, что у плиток (bmNeed учитывает масштаб лупы), поэтому и на шаблоне 4056×496 это не сборка
// целого баннера, а одна плитка побольше: обновляется вместе с плитками в bmPlace.
// Кадр (масштаб и сдвиг) зависит только от баннера и размера окна, а не от спрайта эффектов: ползунки его не двигают.
const BM_LP_KEY = 'k9000.bmlp';
const BM_LP_MAX = 8;    // предел приближения: 800% (экранных пикселей на пиксель шаблона)
const BM_LP_PAD = 24;   // отступ целого баннера от краёв окна
const bmLp = {on: false, name: ''};   // name — баннер, который смотрим (щелчок по плитке); пусто — самый большой
try { bmLp.on = localStorage.getItem(BM_LP_KEY) === '1'; } catch (e) {}
const bmLpSlot = () => bmSlots.find(s => s.name === (bmSel || bmLp.name)) || bmRef();
// hold — пока двигаешь ползунок: спрайт грубее и быстрее, пунктир и подписи скрыты; отпустил — точный спрайт.
// z — приближение к целому баннеру (1 — весь), ox/oy — сдвиг центра баннера от центра окна в пикселях экрана
bmLp.hold = false; bmLp.down = false; bmLp.timer = 0; bmLp.z = 1; bmLp.ox = 0; bmLp.oy = 0; bmLp.cur = '';
function bmLpHold() {
  if (!bmLp.on) return;
  bmLp.hold = true;
  $('bmLp').classList.add('clean');
  clearTimeout(bmLp.timer);
  if (!bmLp.down) bmLp.timer = setTimeout(bmLpRelease, 450);
}
function bmLpRelease() {
  clearTimeout(bmLp.timer);
  if (bmLp.down) return;
  if (bmSprBusy) { bmLp.timer = setTimeout(bmLpRelease, 120); return; }   // ждём последний спрайт
  bmLp.hold = false;
  $('bmLp').classList.remove('clean');
  bmLpDraw();
  bmSprSoon();   // спрайт в полном качестве (во время движения он грубее)
}
// движение в панели и на плитках: поле ввода, ползунок, перетаскивание картинки
document.addEventListener('input', e => { if (bmLp.on && e.target.closest && e.target.closest('#bmView')) bmLpHold(); }, true);
document.addEventListener('pointerdown', e => {
  if (bmLp.on && e.target.closest && e.target.closest('#bmView') && !e.target.closest('#bmLp')) { bmLp.down = true; bmLpHold(); }
}, true);
const bmLpUp = () => { if (bmLp.down) { bmLp.down = false; if (bmLp.hold) { clearTimeout(bmLp.timer); bmLp.timer = setTimeout(bmLpRelease, 120); } } };
addEventListener('pointerup', bmLpUp);
addEventListener('pointercancel', bmLpUp);
addEventListener('blur', bmLpUp);
// рамка объекта kind в баннере sl, в пикселях шаблона: {x, y, w, h} без полей эффектов
function bmLpObj(sl, kind) {
  const e = bmElCur();
  if (kind === 'elf' && e) return bmElRect(sl, e);
  return bmFitPx(sl, bmImg.w, bmImg.h, bmAdj(sl.name));
}
const bmLpSize = () => { const v = $('bmLpV'); return {W: v.clientWidth || 400, H: v.clientHeight || 240}; };
// масштаб «весь баннер»: влезает в окно с отступом, но не крупнее предела
function bmLpFit(sl) {
  const {W, H} = bmLpSize();
  return Math.max(0.01, Math.min(Math.max(W - 2 * BM_LP_PAD, 40) / sl.w, Math.max(H - 2 * BM_LP_PAD, 40) / sl.h, BM_LP_MAX));
}
const bmLpZMax = f => Math.max(1, BM_LP_MAX / f);
// текущий масштаб: пикселей экрана на пиксель шаблона
function bmLpScale(sl) {
  const f = bmLpFit(sl);
  return f * Math.min(Math.max(bmLp.z, 1), bmLpZMax(f));
}
// баннер не уходит из окна: крупный можно двигать, пока его край не дойдёт до отступа; целый стоит по центру
function bmLpClamp(sl, s) {
  const {W, H} = bmLpSize();
  const lx = Math.max(0, sl.w * s / 2 - (W / 2 - BM_LP_PAD)), ly = Math.max(0, sl.h * s / 2 - (H / 2 - BM_LP_PAD));
  bmLp.ox = Math.max(-lx, Math.min(lx, bmLp.ox)); bmLp.oy = Math.max(-ly, Math.min(ly, bmLp.oy));
}
// сколько пикселей экрана займёт объект kind в лупе (для чёткости спрайта); 0 — лупа закрыта
function bmLpNeed(kind) {
  if (!bmLp.on || !bmImg) return 0;
  const sl = bmLpSlot();
  if (!sl) return 0;
  const o = bmLpObj(sl, kind === 'el' ? 'elf' : 'art');
  return Math.max(o.w, o.h) * bmLpScale(sl) * (devicePixelRatio || 1);
}
// приблизить в k раз к точке (mx, my) окна, считая от его центра
function bmLpZoom(k, mx, my, ease) {
  const sl = bmLpSlot();
  if (!sl) return;
  const z = Math.min(bmLpZMax(bmLpFit(sl)), Math.max(1, bmLp.z * k)), kk = z / bmLp.z;
  if (kk === 1) return;
  bmLp.ox = mx - (mx - bmLp.ox) * kk; bmLp.oy = my - (my - bmLp.oy) * kk; bmLp.z = z;
  bmLpMoved(ease);
}
function bmLpWhole() { bmLp.z = 1; bmLp.ox = 0; bmLp.oy = 0; bmLpMoved(true); }
function bmLpMoved(ease) {
  const i = $('bmLpI');
  i.classList.toggle('ease', !!ease);
  if (ease) { clearTimeout(bmLp.easeT); bmLp.easeT = setTimeout(() => i.classList.remove('ease'), 260); }
  bmLpDraw();
  bmSprSoon();   // чёткость спрайта под новый масштаб
}
// Подложка окна «Крупно»: position:fixed от низа шапки .hero до низа окна, слева до панели настроек (она остаётся
// доступной: ползунки двигаешь, а результат виден крупно). Если панель под превью (узкое окно) — подложка на верхнюю часть окна.
function bmLpPlace() {
  const lp = $('bmLp'), top = Math.round(document.querySelector('.hero').getBoundingClientRect().bottom);
  const col = document.querySelector('#bmView .col.one'), cr = col ? col.getBoundingClientRect() : null;
  const side = cr && cr.width > 0 && cr.left > innerWidth * 0.4 && cr.top < innerHeight - 60;
  lp.style.top = top + 'px'; lp.style.left = '0';
  lp.style.right = side ? Math.max(0, innerWidth - cr.left + 6) + 'px' : '0';
  lp.style.bottom = side ? '0' : Math.round((innerHeight - top) * 0.42) + 'px';
}
function bmLpDraw() {
  const lp = $('bmLp'), show = bmLp.on && !!bmImg;
  lp.classList.toggle('hide', !show);
  $('bmLpBtn').classList.toggle('on', show);
  if (!show) return;
  bmLpPlace();
  const sl = bmLpSlot();
  if (!sl) return;
  if (bmLp.cur !== sl.name) { bmLp.cur = sl.name; bmLp.z = 1; bmLp.ox = 0; bmLp.oy = 0; }   // другой баннер — снова целиком
  $('bmLpName').textContent = sl.name;
  const {W, H} = bmLpSize(), f = bmLpFit(sl), s = bmLpScale(sl);
  bmLpClamp(sl, s);
  const ad = bmAdj(sl.name), p = bmFit(sl, bmImg.w, bmImg.h, ad);
  const bg = lp.querySelector('img.bg'), src = `/bannerbg/${sl.name}.png`;
  if (bg.getAttribute('src') !== src) bg.src = src;
  $('bmLpI').style.cssText = `width:${sl.w * s}px;height:${sl.h * s}px;left:${W / 2 + bmLp.ox - sl.w * s / 2}px;top:${H / 2 + bmLp.oy - sl.h * s / 2}px` + bmFxVars(lp, sl, ad, p);
  // сейв-зона пунктиром, как на плитках
  lp.querySelector('.bm-zf').style.cssText = `left:${sl.x / sl.w * 100}%;top:${sl.y / sl.h * 100}%;width:${sl.zw / sl.w * 100}%;height:${sl.zh / sl.h * 100}%`;
  // подпись: размер, масштаб и что правит мышь (режим «Все / Один баннер» у картинки, фон всегда общий)
  const elf = bmFxObj === 'elf';
  const mode = elf ? t('bm.lpElAll') : bmMode === 'all' ? t('bm.tAll') : bmMode === 'one' ? t('bm.tOne') : t('bm.lpNoMode');
  $('bmLpL').textContent = `${sl.w}×${sl.h}, ${Math.round(s * 100)}% · ${mode}`;
  $('bmLpL').classList.toggle('warn', !elf && !bmMode);
  // рамка выбранного объекта с ручками (у фона ещё кружок поворота)
  const sel = $('bmLpSel'), css = bmLpObjCss(sl, bmFxObj);
  sel.classList.toggle('hide', !css);
  sel.classList.toggle('el', elf);
  if (css) sel.style.cssText = css;
  if (bmLpHovPt && !bmDrag) { if (!bmLpHovRaf) bmLpHovRaf = requestAnimationFrame(bmLpHover); }
  else if (bmDrag) $('bmLpHov').classList.add('hide');
  const z = Math.min(Math.max(bmLp.z, 1), bmLpZMax(f));
  $('bmLpO').disabled = $('bmLpW').disabled = z <= 1.0001;
  $('bmLpIn').disabled = z >= bmLpZMax(f) - 0.0001;
  $('bmLpV').classList.toggle('zoomed', z > 1.0001);
}
function bmLpSet(on) {
  bmLp.on = on; bmLp.hold = false; bmLp.down = false; clearTimeout(bmLp.timer);
  bmLp.z = 1; bmLp.ox = 0; bmLp.oy = 0;   // открываем всегда на целом баннере
  $('bmLp').classList.remove('clean');
  try { localStorage.setItem(BM_LP_KEY, on ? '1' : '0'); } catch (e) {}
  bmLpDraw();
  if (on) bmSprSoon();   // лупе может понадобиться спрайт почётче
}
$('bmLpBtn').onclick = () => bmLpSet(!bmLp.on);
$('bmLpX').onclick = () => bmLpSet(false);
$('bmLp').addEventListener('mousedown', e => { if (e.target === $('bmLp')) bmLpSet(false); });
$('bmLpIn').onclick = () => bmLpZoom(1.5, 0, 0, true);
$('bmLpO').onclick = () => bmLpZoom(1 / 1.5, 0, 0, true);
$('bmLpW').onclick = bmLpWhole;
// колесо приближает к курсору, перетаскивание двигает приблизившуюся картинку
$('bmLpV').addEventListener('wheel', e => {
  e.preventDefault();
  if ((bmDrag && bmDrag.lp) || bmLpPan) return;   // пока тянешь, вид не меняется
  const r = $('bmLpV').getBoundingClientRect();
  bmLpZoom(Math.exp(-Math.max(-120, Math.min(120, e.deltaY)) * 0.0022), e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2, false);
}, {passive: false});
// ---------- правка в «Крупно»: тянешь выбранный объект, щелчок по другому выбирает его ----------
// Выбран всегда один объект (bmFxObj — общий для «Крупно», плиток и панели), второй мышь не трогает никогда.
// Нажал внутри рамки выбранного (даже там, где его закрывает другой) и повёл — тянешь его. Щелчок без движения
// по видимой части другого объекта (сверху картинка, под ней фон) выбирает тот; само нажатие выбор не меняет,
// поэтому выбор не перескакивает посреди перетаскивания. Вид двигают пробел + мышь, средняя кнопка или пустое место.
// Тянут той же bmDragMove, что и плитки: магниты, Alt, отмена.
let bmLpPan = null;   // сдвиг вида
let bmLpClick = null;   // {id, x, y, kind}: нажали на другой объект; отпустили без движения — выбрать его
// что делает нажатие (чистая логика): sel — выбранный объект, inSel — точка внутри его рамки, top — верхний видимый
// объект в точке ('' — пусто). grab — кого тянуть, click — кого выбрать щелчком без движения
function bmLpRule(sel, inSel, top) {
  return {grab: inSel ? sel : '', click: top && top !== sel ? top : ''};
}
// непрозрачна ли точка холста (fx, fy — доли ширины и высоты)
function bmLpAlpha(cv, fx, fy) {
  if (!(fx >= 0 && fx < 1 && fy >= 0 && fy < 1)) return false;
  try { return cv.getContext('2d').getImageData(Math.floor(fx * cv.width), Math.floor(fy * cv.height), 1, 1).data[3] > 16; } catch (e) { return true; }
}
// точка экрана в баннере лупы: {sl, x, y} в пикселях шаблона
function bmLpAt(cx, cy) {
  const sl = bmLpSlot();
  if (!sl) return null;
  const r = $('bmLpI').getBoundingClientRect(), s = r.width / sl.w;
  return {sl, x: (cx - r.left) / s, y: (cy - r.top) / s};
}
// объект kind в точке (x, y) баннера sl: {box — внутри рамки, px — на непрозрачном пикселе}. Вне баннера объектов не видно
function bmLpHitObj(sl, kind, x, y) {
  const no = {box: false, px: false};
  if (!bmImg || !(x >= 0 && y >= 0 && x <= sl.w && y <= sl.h)) return no;
  if (kind === 'art') {
    const a = bmFitPx(sl, bmImg.w, bmImg.h, bmAdj(sl.name)), fx = (x - a.x) / a.w, fy = (y - a.y) / a.h;
    const box = fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1;
    return {box, px: box && bmLpAlpha(bmImg.cv, fx, fy)};
  }
  const e = bmElCur();
  if (!e) return no;
  const g = bmElGeo(sl, e), ang = -bmFx.er * Math.PI / 180, dx = x - g.cx, dy = y - g.cy;
  const fx = (dx * Math.cos(ang) - dy * Math.sin(ang)) / g.w + 0.5, fy = (dx * Math.sin(ang) + dy * Math.cos(ang)) / g.h + 0.5;
  const box = fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1;
  return {box, px: box && bmLpAlpha(e.cv, fx, fy)};
}
// что делает нажатие в точке экрана: {grab, click} по bmLpRule
function bmLpPick(cx, cy) {
  const p = bmLpAt(cx, cy);
  if (!p || !bmImg) return {grab: '', click: ''};
  const art = bmLpHitObj(p.sl, 'art', p.x, p.y), elf = bmLpHitObj(p.sl, 'elf', p.x, p.y);
  const top = art.px ? 'art' : elf.px ? 'elf' : '';
  return bmLpRule(bmFxObj, (bmFxObj === 'art' ? art : elf).box, top);
}
// рамка объекта kind на баннере лупы: стиль для position:absolute внутри #bmLpI
function bmLpObjCss(sl, kind) {
  const ad = bmAdj(sl.name);
  let cx, cy, w, h, rot = 0;
  if (kind === 'elf') {
    const e = bmElCur();
    if (!e) return '';
    const g = bmElGeo(sl, e);
    cx = g.cx; cy = g.cy; w = g.w; h = g.h; rot = bmFx.er;
  } else {
    if (!bmImg) return '';
    const a = bmFitPx(sl, bmImg.w, bmImg.h, ad);
    cx = a.x + a.w / 2; cy = a.y + a.h / 2; w = a.w; h = a.h;
  }
  // в процентах баннера: при плавном приближении рамка едет вместе с ним
  return `left:${(cx - w / 2) / sl.w * 100}%;top:${(cy - h / 2) / sl.h * 100}%;width:${w / sl.w * 100}%;height:${h / sl.h * 100}%;transform:rotate(${rot}deg)`;
}
$('bmLpK').addEventListener('click', e => { const b = e.target.closest('button[data-o]'); if (b && !b.disabled) bmObjSet(b.dataset.o); });
// взять выбранный объект kind: тянуть, а за ручку hd — размер или поворот
function bmLpGrab(e, kind, hd) {
  const sl = bmLpSlot(), I = $('bmLpI'), r = I.getBoundingClientRect(), sc = r.width / sl.w;
  if (kind !== bmFxObj) return false;
  if (kind === 'elf') {
    const el = bmElCur();
    if (!el) return false;
    const g = bmElGeo(sl, el), cx = r.left + g.cx * sc, cy = r.top + g.cy * sc;
    bmDrag = {el: true, x: e.clientX, y: e.clientY, ex: bmFx.ex, ey: bmFx.ey, sl, f: I, sc, moved: false};
    if (hd && hd.tagName === 'U') Object.assign(bmDrag, {er: bmFx.er, cx, cy});
    else if (hd) Object.assign(bmDrag, {ek: bmFx.ek, cx, cy});
  } else {
    if (!bmMode) { bmNeedMode(); bmLpNeedMode(); return false; }
    if (bmMode === 'one' && bmSel !== sl.name) { bmSel = sl.name; bmEditSync(); }
    const a = bmCur(), t0 = bmAdj(sl.name);
    bmDrag = {x: e.clientX, y: e.clientY, a0: {...a}, t0, sl, f: I, r, sc, moved: false};
    if (hd && hd.dataset.h) {
      const g = bmGeo(sl, t0), h = hd.dataset.h, sx = h.includes('e') ? 1 : -1, sy = h.includes('s') ? 1 : -1;
      Object.assign(bmDrag, {h, sx, sy, g, ax: g.cx - sx * g.bw * t0.k / 2, ay: g.cy - sy * g.bh * t0.k / 2, moved: true});
      bmMark();
    }
  }
  bmDrag.lp = true;
  I.classList.add('drag');
  // пока тянешь: спрайт эффектов грубее и быстрее, после отпускания точный (bmLpUp → bmLpRelease)
  bmLp.hold = true; bmLp.down = true;
  return true;
}
// подсветить подпись режима в окне, если режим «Все / Один баннер» не выбран
function bmLpNeedMode() {
  const l = $('bmLpL');
  l.classList.remove('need'); void l.offsetWidth; l.classList.add('need');
}
$('bmLpV').addEventListener('pointerdown', e => {
  if (e.target.closest('.bm-lpt, .bm-lpk')) return;
  const pan = e.button === 1 || (e.button === 0 && bmSpace);
  if (!pan && e.button !== 0) return;
  e.preventDefault();
  const v = $('bmLpV');
  bmLpClick = null;
  if (!pan && !bmBusy) {
    const hd = e.target.closest('#bmLpSel i, #bmLpSel u'), pk = hd ? {grab: bmFxObj, click: ''} : bmLpPick(e.clientX, e.clientY);
    if (pk.click) bmLpClick = {id: e.pointerId, x: e.clientX, y: e.clientY, kind: pk.click};
    if (pk.grab && bmLpGrab(e, pk.grab, hd)) {
      v.setPointerCapture(e.pointerId); v.classList.remove('ov', 'pk'); $('bmLpHov').classList.add('hide');
      return;
    }
    if (bmLpClick) v.setPointerCapture(e.pointerId);
  }
  if (bmLp.z <= 1.0001) return;   // целый баннер двигать некуда
  bmLpPan = {id: e.pointerId, x: e.clientX, y: e.clientY};
  v.setPointerCapture(e.pointerId);
  v.classList.remove('ov', 'pk');
  v.classList.add('drag');
  $('bmLpI').classList.remove('ease');
});
$('bmLpV').addEventListener('auxclick', e => { if (e.button === 1) e.preventDefault(); });
// наведение: внутри рамки выбранного — курсор «двигать»; над другим объектом — его рамка и курсор-рука (щелчок выберет его)
let bmLpHovRaf = 0, bmLpHovPt = null;
function bmLpHover() {
  bmLpHovRaf = 0;
  const v = $('bmLpV'), hv = $('bmLpHov'), sl = bmLpSlot(), pt = bmLpHovPt;
  const pk = pt && !bmDrag && !bmLpPan && !bmSpace && !bmBusy && sl ? (pt.h ? {grab: bmFxObj, click: ''} : bmLpPick(pt.x, pt.y)) : {grab: '', click: ''};
  v.classList.toggle('ov', !!pk.grab);
  v.classList.toggle('pk', !pk.grab && !!pk.click);
  hv.classList.toggle('hide', !pk.click);
  if (pk.click) hv.style.cssText = bmLpObjCss(sl, pk.click);
}
$('bmLpV').addEventListener('pointermove', e => {
  if (bmLpClick && bmLpClick.id === e.pointerId && Math.hypot(e.clientX - bmLpClick.x, e.clientY - bmLpClick.y) >= 3) bmLpClick = null;   // повёл — это не щелчок
  if (bmDrag && bmDrag.lp) { bmDragMove(e); return; }
  if (bmLpPan && bmLpPan.id === e.pointerId) {
    bmLp.ox += e.clientX - bmLpPan.x; bmLp.oy += e.clientY - bmLpPan.y;
    bmLpPan.x = e.clientX; bmLpPan.y = e.clientY;
    bmLpDraw();
    return;
  }
  bmLpHovPt = {x: e.clientX, y: e.clientY, h: !!e.target.closest('#bmLpSel i, #bmLpSel u')};
  if (!bmLpHovRaf) bmLpHovRaf = requestAnimationFrame(bmLpHover);
});
$('bmLpV').addEventListener('pointerleave', () => { bmLpHovPt = null; if (!bmLpHovRaf) bmLpHovRaf = requestAnimationFrame(bmLpHover); });
const bmLpDragEnd = e => {
  const c = bmLpClick && bmLpClick.id === e.pointerId && e.type === 'pointerup' ? bmLpClick.kind : '';
  bmLpClick = null;
  if (bmDrag && bmDrag.lp) { bmDragEnd(); $('bmLpI').classList.remove('drag'); }
  if (bmLpPan && bmLpPan.id === e.pointerId) { bmLpPan = null; $('bmLpV').classList.remove('drag'); }
  if (c) bmObjSet(c);   // щелчок без движения по другому объекту — теперь правишь его
  if (!bmLpHovRaf) bmLpHovRaf = requestAnimationFrame(bmLpHover);
};
$('bmLpV').addEventListener('pointerup', bmLpDragEnd);
$('bmLpV').addEventListener('pointercancel', bmLpDragEnd);
bmLpReady = true;
document.addEventListener('keydown', e => { if (e.key === 'Escape' && bmLp.on && bmImg) { e.stopPropagation(); e.preventDefault(); bmLpSet(false); } }, true);
addEventListener('resize', () => { if (bmLp.on) { bmLpDraw(); bmSprSoon(); } });
// список элементов: кнопка с текущим и выпадающая плашка с плитками («без элемента» первым).
// Плашка и увеличенная плитка — position:fixed (как clQPlace в color.js), чтобы рамка карточки их не обрезала;
// живут в body. Верхняя граница — низ шапки .hero, она лежит поверх.
const BM_CHEV = '<svg class="bm-pkc" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
const bmShapeName = n => { const k = 'bm.shape.' + n, v = t(k); return v === k ? n : v; };
const bmPkTop = () => { const h = document.querySelector('.hero'); return (h ? h.getBoundingClientRect().bottom : 0) + 8; };
const bmPkOpen = () => !$('bmShapes').classList.contains('hide');
// кнопка: миниатюра и название текущего элемента
function bmPkSync() {
  const b = $('bmPk'), n = bmFx.el;
  if (b.bmKey !== n) {
    b.bmKey = n;
    const th = n ? `<img src="/bannershapes/${encodeURIComponent(n)}.png" alt="" draggable="false">` : BM_NONE_ICON, key = n ? 'bm.shape.' + n : 'bm.elNone';
    b.innerHTML = `<i class="bm-pkt">${th}</i><span data-i18n="${key}">${esc(n ? bmShapeName(n) : t('bm.elNone'))}</span>${BM_CHEV}`;
  }
  b.disabled = bmBusy;
  if (bmBusy && bmPkOpen()) bmPkShow(false);
}
function bmPkPlace() {
  const p = $('bmShapes'), b = $('bmPk');
  if (!bmPkOpen()) return;
  const r = b.getBoundingClientRect(), minTop = bmPkTop();
  if (!r.width || r.bottom < minTop - 4 || r.top > innerHeight) { bmPkShow(false); return; }   // кнопку унесло за край или скрыли
  const w = Math.min(Math.max(r.width, 340), innerWidth - 16);
  p.style.width = w + 'px'; p.style.maxHeight = '';
  const h = Math.min(p.scrollHeight + 2, 460), above = r.top - 6 - minTop, below = innerHeight - r.bottom - 6 - 8;
  let top, mh = h;
  if (h <= below) top = r.bottom + 6;
  else if (h <= above) top = r.top - 6 - h;
  else {   // не влезает ни снизу, ни сверху: берём где больше места и ужимаем высоту
    mh = Math.max(Math.max(above, below), 80);
    top = below >= above ? r.bottom + 6 : r.top - 6 - mh;
  }
  p.style.maxHeight = mh + 'px';
  p.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
  p.style.top = Math.max(minTop, top) + 'px';
}
function bmPkShow(on) {
  const p = $('bmShapes');
  p.classList.toggle('hide', !on);
  $('bmPk').setAttribute('aria-expanded', on ? 'true' : 'false');
  bmPzHide();
  if (!on) return;
  bmPkPlace();
  const cur = p.querySelector('button.on');
  if (cur) cur.scrollIntoView({block: 'nearest'});
}
// увеличенная плитка: квадрат вокруг плитки под курсором, внутри окна и ниже шапки; мышь не ловит
function bmPzShow(btn) {
  const z = $('bmPz'), n = btn && btn.dataset.n;
  if (!n) { bmPzHide(); return; }
  const minTop = bmPkTop(), S = Math.max(90, Math.min(230, innerWidth - 16, innerHeight - minTop - 8)), r = btn.getBoundingClientRect();
  z.querySelector('img').src = `/bannershapes/${encodeURIComponent(n)}.png`;
  z.querySelector('b').textContent = bmShapeName(n);
  z.style.width = z.style.height = S + 'px';
  z.style.left = Math.max(8, Math.min(r.left + r.width / 2 - S / 2, innerWidth - S - 8)) + 'px';
  z.style.top = Math.max(minTop, Math.min(r.top + r.height / 2 - S / 2, innerHeight - S - 8)) + 'px';
  z.classList.remove('hide');
}
const bmPzHide = () => $('bmPz').classList.add('hide');
async function bmElPick(name) {
  if (name === bmFx.el) return;
  bmMark();
  bmFx.el = name;
  bmFxChanged(true);
  if (name && !bmEls[name]) { await bmElLoad(name); bmFxChanged(true); }
}
function bmShapesFill(list) {
  bmShapes = list || [];
  if (bmFx.el && !bmShapes.includes(bmFx.el)) bmFx.el = '';
  const none = `<button type="button" class="none" data-n="" role="option"><span class="bm-pt">${BM_NONE_ICON}</span><span class="bm-pn" data-i18n="bm.elNone">${esc(t('bm.elNone'))}</span></button>`;
  $('bmShapes').firstElementChild.innerHTML = none + bmShapes.map(n => `<button type="button" data-n="${esc(n)}" role="option"><span class="bm-pt"><img src="/bannershapes/${encodeURIComponent(n)}.png" alt="" draggable="false" loading="lazy"></span><span class="bm-pn" data-i18n="bm.shape.${esc(n)}">${esc(bmShapeName(n))}</span></button>`).join('');
  bmFxSync();
  if (bmFx.el) bmElLoad(bmFx.el).then(() => bmFxChanged(true));
}
document.body.append($('bmShapes'), $('bmPz'));
$('bmPk').addEventListener('click', () => { if (!bmBusy) bmPkShow(!bmPkOpen()); });
$('bmShapes').addEventListener('click', e => {
  const s = e.target.closest('button[data-n]');
  if (!s) return;
  bmPkShow(false);
  bmElPick(s.dataset.n || '');
  $('bmPk').focus({preventScroll: true});
});
['mouseover', 'focusin'].forEach(ev => $('bmShapes').addEventListener(ev, e => { const s = e.target.closest('button[data-n]'); if (s) bmPzShow(s); }));
$('bmShapes').addEventListener('mouseleave', bmPzHide);
$('bmShapes').addEventListener('focusout', bmPzHide);
$('bmShapes').addEventListener('scroll', bmPzHide);
// закрытие: щелчок мимо, Esc (раньше «Крупно»), смена размера окна; прокрутка страницы двигает кнопку — плашка за ней
document.addEventListener('pointerdown', e => { if (bmPkOpen() && !e.target.closest('#bmShapes, #bmPk')) bmPkShow(false); }, true);
window.addEventListener('keydown', e => { if (e.key === 'Escape' && bmPkOpen()) { e.stopPropagation(); e.preventDefault(); bmPkShow(false); $('bmPk').focus({preventScroll: true}); } }, true);
addEventListener('resize', bmPkPlace);
document.addEventListener('scroll', e => { if (bmPkOpen() && !e.target.closest?.('#bmShapes')) bmPkPlace(); }, true);
bmFxPanel();
bmFxSync();
