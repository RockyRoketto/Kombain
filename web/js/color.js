// ---------- вкладка «Цвет» ----------
// Слева инструменты, в середине рабочее поле, справа «Мои цвета» (сохранённое и недавние).
// Здесь Градиент и Пипетка; Палитра, Оттенки и Из фото — в colorset.js.
// Градиент: от 2 до CL_MAX точек, вид линейный, круговой или конический, смешивание в OKLCH или RGB.
// OKLCH-смешивание браузер и редакторы понимают не везде, поэтому в PNG, SVG и CSS оно уходит частыми точками,
// посчитанными здесь (clDense): так файл выглядит одинаково в любой программе.
// Состояние в localStorage: k9000.color (инструмент, градиент, размер), k9000.colorLib (Мои цвета).
// Недавние цвета общие с окном выбора цвета (CP_RECENT_KEY в colorpick.js).

const CL_KEY = 'k9000.color', CL_LIB_KEY = 'k9000.colorLib', CL_MAX = 8, CL_LIB_N = 60;
const CL_KINDS = ['lin', 'rad', 'conic'];
// инструменты; pal, shade и photo живут в colorset.js
const CL_TOOLS = ['grad', 'pal', 'photo', 'pick', 'shade', 'ctr', 'mix'];
let clId = 0;
const clStop = (at, c, lock) => ({id: ++clId, at, c, lock: !!lock});
const clDefault = () => ({tool: 'grad', size: '1920x1080', w: 1920, h: 1080, pick: '#e9b872', ctr: {fg: '#9a9a9a', bg: '#ffffff'}, mix: {a: '#ff7a59', b: '#5b8cff', k: 50, n: 7, mode: 'oklch'},
  g: {k: 'lin', ang: 135, cx: .5, cy: .5, mix: 'oklch', stops: [clStop(0, '#ff7a59'), clStop(.5, '#e9b872'), clStop(1, '#5b8cff')]}});
// «Смешать» (colormix.js): проверка сохранённого состояния, число шагов 3–15, доля 0–100
function mixOk(o) {
  const n = o && Number.isInteger(o.n) && o.n >= 3 && o.n <= 15 ? o.n : 7;
  const k = o && Number.isFinite(o.k) ? Math.min(Math.max(Math.round(o.k), 0), 100) : 50;
  return {a: cpValid(o && o.a, '#ff7a59'), b: cpValid(o && o.b, '#5b8cff'), k, n, mode: o && o.mode === 'rgb' ? 'rgb' : 'oklch'};
}
let cl = clDefault();
let clSel = null;   // выбранная точка (объект из cl.g.stops)

// ---------- цвет: sRGB ↔ OKLab ↔ OKLCH ----------
const clLin = c => (c /= 255) <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
const clGam = c => 255 * (c <= .0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - .055);
function clLab({r, g, b}) {
  r = clLin(r); g = clLin(g); b = clLin(b);
  const l = Math.cbrt(.4122214708 * r + .5363325363 * g + .0514459929 * b);
  const m = Math.cbrt(.2119034982 * r + .6806995451 * g + .1073969566 * b);
  const s = Math.cbrt(.0883024619 * r + .2817188376 * g + .6299787005 * b);
  return {L: .2104542553 * l + .7936177850 * m - .0040720468 * s,
    a: 1.9779984951 * l - 2.4285922050 * m + .4505937099 * s,
    b: .0259040371 * l + .7827717662 * m - .8086757660 * s};
}
// без обрезки: значения за пределами 0..255 значат «вне sRGB»
function clLabRgb({L, a, b}) {
  const l = (L + .3963377774 * a + .2158037573 * b) ** 3;
  const m = (L - .1055613458 * a - .0638541728 * b) ** 3;
  const s = (L - .0894841775 * a - 1.2914855480 * b) ** 3;
  return {r: clGam(4.0767416621 * l - 3.3077115913 * m + .2309699292 * s),
    g: clGam(-1.2684380046 * l + 2.6097574011 * m - .3413193965 * s),
    b: clGam(-.0041960863 * l - .7034186147 * m + 1.7076147010 * s)};
}
function clLch(c) { const o = clLab(c); return {L: o.L, C: Math.hypot(o.a, o.b), H: (Math.atan2(o.b, o.a) * 180 / Math.PI + 360) % 360}; }
const clLchLab = ({L, C, H}) => ({L, a: C * Math.cos(H * Math.PI / 180), b: C * Math.sin(H * Math.PI / 180)});
const clIn = c => [c.r, c.g, c.b].every(x => Number.isFinite(x) && x > -.5 && x < 255.5);
// OKLCH в sRGB; если цвет не помещается, насыщенность уменьшается, пока не поместится (оттенок и яркость те же)
function clFit(lch) {
  let c = clLabRgb(clLchLab(lch));
  if (clIn(c)) return c;
  let lo = 0, hi = lch.C;
  for (let i = 0; i < 18; i++) { const mid = (lo + hi) / 2; if (clIn(clLabRgb(clLchLab({...lch, C: mid})))) lo = mid; else hi = mid; }
  return clLabRgb(clLchLab({...lch, C: lo}));
}

// смесь двух цветов {r,g,b,a} в доле k
function clMix(A, B, k, mix) {
  const a = A.a + (B.a - A.a) * k;
  if (mix !== 'oklch') return {r: A.r + (B.r - A.r) * k, g: A.g + (B.g - A.g) * k, b: A.b + (B.b - A.b) * k, a};
  const p = clLch(A), q = clLch(B);
  if (p.C < .02) p.H = q.H;   // у серого оттенка нет: берём оттенок соседа, иначе по дороге вылезет чужой цвет
  if (q.C < .02) q.H = p.H;
  const dh = ((q.H - p.H + 540) % 360) - 180;   // короткой дорогой по кругу, как в CSS
  const c = clLabRgb(clLchLab({L: p.L + (q.L - p.L) * k, C: p.C + (q.C - p.C) * k, H: p.H + dh * k}));
  return {r: c.r, g: c.g, b: c.b, a};
}
const clSorted = g => g.stops.slice().sort((a, b) => a.at - b.at);
// цвет градиента в месте at
function clAt(g, at, list = clSorted(g)) {
  const r = list.findIndex(s => s.at >= at);
  if (r <= 0) return cpParse(list[r < 0 ? list.length - 1 : 0].c);
  const A = list[r - 1], B = list[r], k = B.at > A.at ? (at - A.at) / (B.at - A.at) : 0;
  return clMix(cpParse(A.c), cpParse(B.c), k, g.mix);
}
// точки для рисования: в RGB как есть, в OKLCH ещё по 8 промежуточных на каждый отрезок
function clDense(g) {
  const list = clSorted(g);
  if (g.mix !== 'oklch') return list.map(s => ({at: s.at, c: cpParse(s.c)}));
  const out = [];
  list.forEach((s, i) => {
    out.push({at: s.at, c: cpParse(s.c)});
    const n = list[i + 1];
    if (n && n.at > s.at) for (let j = 1; j < 8; j++) { const at = s.at + (n.at - s.at) * j / 8; out.push({at, c: clAt(g, at, list)}); }
  });
  return out;
}
const clB = x => Math.round(Math.min(Math.max(x, 0), 255));
const clRgba = c => c.a < 1 ? `rgba(${clB(c.r)},${clB(c.g)},${clB(c.b)},${+c.a.toFixed(3)})` : cpHex(c, false);

// ---------- форматы ----------
const clUp = h => h.toUpperCase();
function clHsl({r, g, b}) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return {h: h * 60, s: d ? d / (1 - Math.abs(2 * l - 1)) : 0, l};
}
// CMYK простой формулой, без профиля печати: для типографии цвета надо сверять в редакторе
function clCmyk({r, g, b}) {
  const k = 1 - Math.max(r, g, b) / 255;
  const f = x => k >= 1 ? 0 : (1 - x / 255 - k) / (1 - k);
  return [f(r), f(g), f(b), k].map(x => Math.round(x * 100));
}
function clFormats(hex) {
  const c = cpParse(hex), h = clHsl(c), o = clLch(c), [C, M, Y, K] = clCmyk(c);
  return [['HEX', clUp(cpHex(c, false))],
    ['RGB', `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`],
    ['HSL', `hsl(${Math.round(h.h)}, ${Math.round(h.s * 100)}%, ${Math.round(h.l * 100)}%)`],
    ['OKLCH', `oklch(${+(o.L * 100).toFixed(1)}% ${+o.C.toFixed(3)} ${o.C < .002 ? 0 : +o.H.toFixed(1)})`],
    ['CMYK', `cmyk(${C}%, ${M}%, ${Y}%, ${K}%)`]];
}

// ---------- геометрия: как в CSS, чтобы PNG, SVG и CSS совпадали ----------
// линейный: угол по-CSS (0 — вверх, 90 — вправо), длина линии такая, что углы рамки получают крайние цвета
function clGeo(g, w, h) {
  if (g.k === 'lin') {
    const A = g.ang * Math.PI / 180, dx = Math.sin(A), dy = -Math.cos(A), L = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
    return {x0: w / 2 - dx * L, y0: h / 2 - dy * L, x1: w / 2 + dx * L, y1: h / 2 + dy * L};
  }
  const cx = g.cx * w, cy = g.cy * h;
  return {cx, cy, r: Math.max(Math.hypot(cx, cy), Math.hypot(w - cx, cy), Math.hypot(cx, h - cy), Math.hypot(w - cx, h - cy)) || 1};
}
// ---------- стили: шум, растр, полосы, ступени, пиксели ----------
// Стиль лежит в самом градиенте (g.fx), поэтому уходит с ним в «Мои цвета», в отмену и переживает «Случайно».
// Размеры стиля в пикселях выгрузки; просмотр уменьшен в той же доле (sc), и картинка в нём та же, что в PNG.
// Числовой параметр: [меньше, больше, по умолчанию]; строка — цвет по умолчанию.
const CL_FX = {
  none: {},
  noise: {a: [1, 100, 30], s: [1, 12, 1]},
  dots: {s: [4, 160, 18], ang: [0, 90, 45], k: [30, 150, 100], bg: '#ffffff'},
  lines: {s: [4, 160, 14], ang: [0, 180, 45], k: [30, 150, 100], bg: '#ffffff'},
  steps: {n: [2, 24, 6]},
  pixel: {s: [2, 240, 32]},
};
const CL_FX_SHAPES = 60000;   // больше кружков или квадратов SVG не пишем: файл станет неподъёмным для редакторов
const clFxDef = t => { const o = {t}; for (const [k, v] of Object.entries(CL_FX[t])) o[k] = Array.isArray(v) ? v[2] : v; return o; };
function clFxValid(f) {
  const t = f && Object.hasOwn(CL_FX, f.t) ? f.t : 'none', o = {t};
  for (const [k, v] of Object.entries(CL_FX[t])) {
    o[k] = !Array.isArray(v) ? cpValid(f[k], v, true)
      : Number.isFinite(f[k]) ? Math.min(Math.max(Math.round(f[k]), v[0]), v[1]) : v[2];
  }
  return o;
}
const clFxT = g => g.fx ? g.fx.t : 'none';
// ступени: n полос ровного цвета, крайние — ровно цвета концов
function clStepStops(g, n) {
  const list = clSorted(g), out = [];
  for (let i = 0; i < n; i++) { const c = clAt(g, i / (n - 1), list); out.push({at: i / n, c}, {at: (i + 1) / n, c}); }
  return out;
}
// точки для рисования с учётом стиля: ступени — жёсткими парами, иначе как обычно
const clOutStops = g => clFxT(g) === 'steps' ? clStepStops(g, g.fx.n) : clDense(g);
// место на градиенте (0..1) для точки холста — то же, что считает canvas
function clPlace(g, o) {
  if (g.k === 'lin') { const dx = o.x1 - o.x0, dy = o.y1 - o.y0, L2 = dx * dx + dy * dy || 1; return (x, y) => ((x - o.x0) * dx + (y - o.y0) * dy) / L2; }
  if (g.k === 'rad') return (x, y) => Math.hypot(x - o.cx, y - o.cy) / o.r;
  const a0 = (g.ang - 90) * Math.PI / 180, T = Math.PI * 2;
  return (x, y) => (((Math.atan2(y - o.cy, x - o.cx) - a0) % T + T) % T) / T;
}
// таблица цветов градиента: цвет и закраска клетки (0..1) в каждой из n долей.
// Закраска от темноты цвета, но в пределах самого градиента: самое светлое место — тонко, самое тёмное — густо.
// По абсолютной темноте у обычных градиентов средней яркости точки и линии выходили еле заметными.
const CL_LUT_N = 1024;
function clLut(g) {
  const list = clSorted(g), c = new Array(CL_LUT_N), dk = new Float32Array(CL_LUT_N);
  for (let i = 0; i < CL_LUT_N; i++) { const x = clAt(g, i / (CL_LUT_N - 1), list); c[i] = x; dk[i] = 1 - clLab(x).L; }
  let lo = Infinity, hi = -Infinity;
  for (const v of dk) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const k = (g.fx && g.fx.k || 100) / 100;
  for (let i = 0; i < CL_LUT_N; i++) dk[i] = (.12 + .78 * (hi - lo > .04 ? (dk[i] - lo) / (hi - lo) : .5)) * k;
  return {c, dk, at: v => Math.round(Math.min(Math.max(v, 0), 1) * (CL_LUT_N - 1))};
}
// кружки растра: сетка с центром в середине картинки, повёрнутая на угол; площадь кружка растёт с темнотой цвета
function clDotList(g, w, h, sc) {
  const f = g.fx, s = f.s * sc, A = f.ang * Math.PI / 180, ca = Math.cos(A), sa = Math.sin(A);
  const P = clPlace(g, clGeo(g, w, h)), L = clLut(g), n = Math.ceil(Math.hypot(w, h) / 2 / s) + 1, out = [];
  for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
    const x = w / 2 + (i * ca - j * sa) * s, y = h / 2 + (i * sa + j * ca) * s;
    if (x < -s || y < -s || x > w + s || y > h + s) continue;
    const k = L.at(P(Math.min(Math.max(x, 0), w), Math.min(Math.max(y, 0), h))), r = s * Math.sqrt(L.dk[k] / Math.PI);
    if (r * 2 >= .1 * sc) out.push([x, y, r, L.c[k]]);
  }
  return out;
}
// квадраты пикселей: сетка от левого верхнего угла, цвет — в середине клетки; края округлены, чтобы не было щелей
function clPixList(g, w, h, sc) {
  const s = g.fx.s * sc, P = clPlace(g, clGeo(g, w, h)), L = clLut(g), out = [];
  for (let j = 0; j * s < h; j++) for (let i = 0; i * s < w; i++) {
    const x0 = Math.round(i * s), y0 = Math.round(j * s), x1 = Math.min(Math.round((i + 1) * s), w), y1 = Math.min(Math.round((j + 1) * s), h);
    out.push([x0, y0, x1, y1, L.c[L.at(P((x0 + x1) / 2, (y0 + y1) / 2))]]);
  }
  return out;
}
const clCount = (g, w, h) => Math.ceil(w / g.fx.s) * Math.ceil(h / g.fx.s) * (clFxT(g) === 'dots' ? 1.6 : 1);
// шум: у каждой клетки зерна своё смещение яркости, одинаковое при каждой перерисовке (иначе просмотр мерцал бы при тяге)
const clHash = (x, y) => { let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) | 0; h = Math.imul(h ^ h >>> 13, 1274126177); return ((h ^ h >>> 16) >>> 0) / 4294967296; };
function clNoise(ctx, w, h, sc, f) {
  const im = ctx.getImageData(0, 0, w, h), d = im.data, cell = f.s * sc;
  // в уменьшенном просмотре несколько зёрен сливаются в одну точку экрана и шум честно слабеет; ослабляем мягче, чтобы зерно было видно
  const A = f.a * 1.6 * Math.sqrt(Math.min(cell, 1));
  for (let y = 0, i = 0; y < h; y++) {
    const cy = Math.floor(y / cell);
    for (let x = 0; x < w; x++, i += 4) { const n = (clHash(Math.floor(x / cell), cy) - .5) * A; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  }
  ctx.putImageData(im, 0, 0);
}
// полосы: толщина линии растёт с темнотой цвета, края сглажены на пиксель
function clLines(ctx, g, w, h, sc) {
  const f = g.fx, s = f.s * sc, A = f.ang * Math.PI / 180, nx = -Math.sin(A), ny = Math.cos(A);
  const P = clPlace(g, clGeo(g, w, h)), L = clLut(g), im = ctx.createImageData(w, h), d = im.data;
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i += 4) {
    const v = ((x + .5 - w / 2) * nx + (y + .5 - h / 2) * ny) / s, dist = Math.abs(v - Math.floor(v) - .5) * s;
    const k = L.at(P(x + .5, y + .5)), half = s * Math.min(L.dk[k], 1) / 2, cov = Math.min(Math.max(half - dist + .5, 0), 1);
    if (!cov) continue;
    const c = L.c[k];
    d[i] = c.r; d[i + 1] = c.g; d[i + 2] = c.b; d[i + 3] = 255 * c.a * cov;
  }
  const t = document.createElement('canvas');
  t.width = w; t.height = h;
  t.getContext('2d').putImageData(im, 0, 0);
  ctx.drawImage(t, 0, 0);
}
function clPaint(ctx, g, w, h, sc = 1) {
  const t = clFxT(g);
  ctx.clearRect(0, 0, w, h);
  if (t === 'dots' || t === 'lines') { ctx.fillStyle = g.fx.bg; ctx.fillRect(0, 0, w, h); }
  if (t === 'dots') {
    for (const [x, y, r, c] of clDotList(g, w, h, sc)) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = clRgba(c); ctx.fill(); }
    return;
  }
  if (t === 'lines') { clLines(ctx, g, w, h, sc); return; }
  if (t === 'pixel') { for (const [x0, y0, x1, y1, c] of clPixList(g, w, h, sc)) { ctx.fillStyle = clRgba(c); ctx.fillRect(x0, y0, x1 - x0, y1 - y0); } return; }
  const o = clGeo(g, w, h);
  const q = g.k === 'lin' ? ctx.createLinearGradient(o.x0, o.y0, o.x1, o.y1)
    : g.k === 'rad' ? ctx.createRadialGradient(o.cx, o.cy, 0, o.cx, o.cy, o.r)
    : ctx.createConicGradient((g.ang - 90) * Math.PI / 180, o.cx, o.cy);
  for (const s of clOutStops(g)) q.addColorStop(Math.min(Math.max(s.at, 0), 1), clRgba(s.c));
  ctx.fillStyle = q;
  ctx.fillRect(0, 0, w, h);
  if (t === 'noise') clNoise(ctx, w, h, sc, g.fx);
}
const clPct = n => +(n * 100).toFixed(2) + '%';
function clCssOf(g, dense) {
  const list = dense ? clOutStops(g).map(s => `${clRgba(s.c)} ${clPct(s.at)}`) : clSorted(g).map(s => `${s.c} ${clPct(s.at)}`);
  const sp = dense ? '' : ' in oklch';
  const at = `at ${clPct(g.cx)} ${clPct(g.cy)}`;
  return g.k === 'lin' ? `linear-gradient(${g.ang}deg${sp}, ${list.join(', ')})`
    : g.k === 'rad' ? `radial-gradient(circle farthest-corner ${at}${sp}, ${list.join(', ')})`
    : `conic-gradient(from ${g.ang}deg ${at}${sp}, ${list.join(', ')})`;
}
// CSS для копирования: строка, которую понимают все браузеры, и для OKLCH ещё короткая запись поверх неё
function clCssCode(g) {
  const lines = [`background: ${clCssOf(g, true)};`];
  if (g.mix === 'oklch' && clFxT(g) === 'none') lines.push(`background: ${clCssOf(g, false)};`);
  return lines.join('\n');
}
// почему SVG или CSS не выйдет (ключ текста) или '' — выйдет
function clNoOut(g, ext, w, h) {
  const t = clFxT(g);
  if (ext === 'css') return t === 'none' || t === 'steps' ? '' : 'cl.cssFx';
  if (t === 'noise' || t === 'lines') return 'cl.svgFx';
  if (t === 'dots' || t === 'pixel') return clCount(g, w, h) > CL_FX_SHAPES ? 'cl.svgMany' : '';
  return g.k === 'conic' ? 'cl.svgConic' : '';
}
const clSvgFill = c => `fill="${cpHex({...c, a: 1}, false)}"${c.a < 1 ? ` fill-opacity="${+c.a.toFixed(3)}"` : ''}`;
// SVG: линейный и круговой градиенты настоящие, точки с прозрачностью — через stop-opacity (8-значный HEX понимают не все).
// Растр и пиксели — настоящими кружками и квадратами (так их можно править в редакторе), им и конический не помеха.
function clSvg(g, w, h) {
  const o = clGeo(g, w, h), n = x => +x.toFixed(2), t = clFxT(g);
  const head = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`;
  if (t === 'dots') {
    const bg = cpParse(g.fx.bg), back = bg.a > 0 ? `<rect width="${w}" height="${h}" ${clSvgFill(bg)}/>` : '';
    return head + back + clDotList(g, w, h, 1).map(([x, y, r, c]) => `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" ${clSvgFill(c)}/>`).join('') + '</svg>';
  }
  if (t === 'pixel') return head + clPixList(g, w, h, 1).map(([x0, y0, x1, y1, c]) => `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" ${clSvgFill(c)}/>`).join('') + '</svg>';
  const stops = clOutStops(g).map(s => `<stop offset="${+s.at.toFixed(4)}" stop-color="${cpHex({...s.c, a: 1}, false)}"${s.c.a < 1 ? ` stop-opacity="${+s.c.a.toFixed(3)}"` : ''}/>`).join('');
  const def = g.k === 'lin'
    ? `<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="${n(o.x0)}" y1="${n(o.y0)}" x2="${n(o.x1)}" y2="${n(o.y1)}">${stops}</linearGradient>`
    : `<radialGradient id="g" gradientUnits="userSpaceOnUse" cx="${n(o.cx)}" cy="${n(o.cy)}" r="${n(o.r)}">${stops}</radialGradient>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs>${def}</defs><rect width="${w}" height="${h}" fill="url(#g)"/></svg>`;
}

// ---------- состояние ----------
function clValidG(g) {
  if (!g || !Array.isArray(g.stops)) return null;
  const stops = g.stops.filter(s => s && Number.isFinite(s.at) && cpValid(s.c, '', true)).slice(0, CL_MAX)
    .map(s => clStop(Math.min(Math.max(s.at, 0), 1), cpValid(s.c, '', true), s.lock));
  if (stops.length < 2) return null;
  const num = (v, d, lo, hi) => Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : d;
  const fx = g.fx ? clFxValid(g.fx) : null;
  return {k: CL_KINDS.includes(g.k) ? g.k : 'lin', ang: num(g.ang, 90, -360, 360), cx: num(g.cx, .5, 0, 1), cy: num(g.cy, .5, 0, 1),
    mix: g.mix === 'rgb' ? 'rgb' : 'oklch', stops, fx: fx && fx.t !== 'none' ? fx : undefined};
}
function clLoad() {
  try {
    const o = JSON.parse(storeGet(CL_KEY) || 'null');
    if (!o) return;
    const d = clDefault();
    cl = {tool: CL_TOOLS.includes(o.tool) ? o.tool : d.tool,
      size: typeof o.size === 'string' && (o.size === 'own' || /^\d+x\d+$/.test(o.size)) ? o.size : d.size,
      w: Number.isInteger(o.w) ? Math.min(Math.max(o.w, 16), 8192) : d.w, h: Number.isInteger(o.h) ? Math.min(Math.max(o.h, 16), 8192) : d.h,
      pick: cpValid(o.pick, d.pick), ctr: {fg: cpValid(o.ctr && o.ctr.fg, d.ctr.fg), bg: cpValid(o.ctr && o.ctr.bg, d.ctr.bg)}, mix: mixOk(o.mix), g: clValidG(o.g) || d.g};
  } catch (e) {}
}
const clPlain = g => ({k: g.k, ang: g.ang, cx: g.cx, cy: g.cy, mix: g.mix, stops: clSorted(g).map(s => ({at: +s.at.toFixed(4), c: s.c, lock: s.lock || undefined})),
  fx: clFxT(g) !== 'none' ? {...g.fx} : undefined});
const clSave = () => { storeSet(CL_KEY, JSON.stringify({...cl, g: clPlain(cl.g)})); clMark(); };   // clMark — шаг отмены (colorset.js)
// размер выгрузки
function clWH() {
  if (cl.size === 'own') return [cl.w, cl.h];
  const [w, h] = cl.size.split('x').map(Number);
  return [w, h];
}

// ---------- просмотр ----------
const clCv = $('clCanvas'), clCx = clCv.getContext('2d');
function clDraw() {
  const box = $('clView'), [W, H] = clWH();
  const k = Math.min((box.clientWidth - 2) / W, (box.clientHeight - 2) / H);
  if (!(k > 0)) return;
  const cw = Math.max(Math.round(W * k), 1), ch = Math.max(Math.round(H * k), 1), dpr = devicePixelRatio || 1;
  clCv.style.width = cw + 'px'; clCv.style.height = ch + 'px';
  const pw = Math.round(cw * dpr), ph = Math.round(ch * dpr);
  if (clCv.width !== pw || clCv.height !== ph) { clCv.width = pw; clCv.height = ph; }
  clPaint(clCx, cl.g, pw, ph, pw / W);
  // точки цвета лежат прямо на картинке: у линейного на линии градиента, у кругового на луче из середины в дальний угол,
  // у конического на кольце вокруг середины. Их можно брать и двигать, как на полосе.
  const g = cl.g, x = clCx, R = 6 * dpr, mk = clMarkers(pw, ph);
  const cx = (g.k === 'lin' ? .5 : g.cx) * pw, cy = (g.k === 'lin' ? .5 : g.cy) * ph;
  x.save();
  x.lineWidth = 2 * dpr;
  x.shadowColor = 'rgba(0,0,0,.45)'; x.shadowBlur = 4 * dpr;
  x.strokeStyle = '#fff';
  if (g.k === 'conic') {
    const A = g.ang * Math.PI / 180, len = Math.min(pw, ph) * .22;
    x.beginPath(); x.arc(cx, cy, R * .6, 0, Math.PI * 2); x.stroke();
    x.beginPath(); x.arc(cx, cy, mk.ring, 0, Math.PI * 2); x.globalAlpha = .55; x.stroke(); x.globalAlpha = 1;   // кольцо, по которому ходят точки
    const ex = cx + Math.sin(A) * len, ey = cy - Math.cos(A) * len;
    x.beginPath(); x.moveTo(cx + Math.sin(A) * R, cy - Math.cos(A) * R); x.lineTo(ex, ey); x.stroke();
    x.beginPath(); x.arc(ex, ey, R * .8, 0, Math.PI * 2); x.fillStyle = 'rgba(255,255,255,.9)'; x.fill(); x.stroke();   // за этот кружок крутят
  } else {
    x.beginPath();
    x.moveTo(mk.x0, mk.y0); x.lineTo(mk.x0 + mk.dx, mk.y0 + mk.dy);
    x.globalAlpha = .6; x.stroke(); x.globalAlpha = 1;
  }
  const order = [...mk.pts].sort((a, b) => (a.s === clSel) - (b.s === clSel));   // выбранная сверху
  for (const m of order) {
    const on = m.s === clSel;
    x.beginPath(); x.arc(m.x, m.y, R * (on ? 1.5 : 1.25), 0, Math.PI * 2);
    x.fillStyle = clRgba(m.s.c); x.fill();
    x.strokeStyle = on ? '#e9b872' : '#fff'; x.lineWidth = (on ? 3 : 2) * dpr; x.stroke();
  }
  x.restore();
  $('clSizeTag').textContent = `${W} × ${H}`;
}
// положение точек в пикселях холста pw × ph. Линейный и круговой: точка at = (x0, y0) + (dx, dy) · at; конический: кольцо радиуса ring
function clMarkers(pw, ph) {
  const g = cl.g, o = clGeo(g, pw, ph), r = {pts: []};
  if (g.k === 'lin') Object.assign(r, {x0: o.x0, y0: o.y0, dx: o.x1 - o.x0, dy: o.y1 - o.y0});
  else if (g.k === 'rad') {   // луч в дальний угол: там как раз at = 1
    const fx = o.cx < pw / 2 ? pw : 0, fy = o.cy < ph / 2 ? ph : 0;
    Object.assign(r, {x0: o.cx, y0: o.cy, dx: fx - o.cx, dy: fy - o.cy});
  } else r.ring = Math.min(pw, ph) * .33;
  for (const s of g.stops) {
    const at = Math.min(Math.max(s.at, 0), 1);
    if (g.k === 'conic') {
      const A = (g.ang + at * 360) * Math.PI / 180;
      r.pts.push({s, x: g.cx * pw + Math.sin(A) * r.ring, y: g.cy * ph - Math.cos(A) * r.ring});
    } else r.pts.push({s, x: r.x0 + r.dx * at, y: r.y0 + r.dy * at});
  }
  return r;
}
// тяга по полю: точка цвета — двигается по линии, лучу или кольцу; иначе линейный — направление (угол), круговой — середина,
// конический — середина, а за белый кружок на стрелке — поворот; Shift — шаг 15°
let clDrag = null;
clCv.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  clDrag = {id: e.pointerId, turn: false, stop: null, moved: false, x0: e.clientX, y0: e.clientY};
  const g = cl.g, r = clCv.getBoundingClientRect(), k = clCv.width / r.width;
  const px = (e.clientX - r.left) * k, py = (e.clientY - r.top) * k, reach = 14 * (devicePixelRatio || 1);
  let best = reach;
  for (const m of clMarkers(clCv.width, clCv.height).pts) {   // ближайшая точка в пределах кружка; при равенстве выбранная
    const d = Math.hypot(px - m.x, py - m.y) - (m.s === clSel ? 1 : 0);
    if (d <= best) { best = d; clDrag.stop = m.s; }
  }
  if (clDrag.stop) { clSel = clDrag.stop; clRender(); }
  else if (g.k === 'conic') {   // попали в кружок на конце стрелки — крутим, иначе двигаем середину
    const len = Math.min(r.width, r.height) * .22, A = g.ang * Math.PI / 180;
    const hx = r.left + g.cx * r.width + Math.sin(A) * len, hy = r.top + g.cy * r.height - Math.cos(A) * len;
    clDrag.turn = Math.hypot(e.clientX - hx, e.clientY - hy) <= 16;
  }
  clCv.setPointerCapture(e.pointerId);
  if (!clDrag.stop) clAim(e);
});
clCv.addEventListener('pointermove', e => { if (clDrag && clDrag.id === e.pointerId) clAim(e); });
function clDragEnd(e) {
  const d = clDrag;
  if (!d) return;
  clDrag = null;
  clSave();
  // щелчок по точке без тяги — окно цвета, как на полосе
  if (d.stop && !d.moved && e && e.type === 'pointerup') clChipOpen(d.stop.id);
}
clCv.addEventListener('pointerup', clDragEnd);
clCv.addEventListener('pointercancel', clDragEnd);
function clAim(e) {
  const r = clCv.getBoundingClientRect(), u = (e.clientX - r.left) / r.width, v = (e.clientY - r.top) / r.height, g = cl.g;
  const snap = a => ((e.shiftKey ? Math.round(a / 15) * 15 : Math.round(a)) + 360) % 360;
  const d = clDrag;
  if (d && d.stop) {
    if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 3) return;
    d.moved = true;
    const k = clCv.width / r.width, px = (e.clientX - r.left) * k, py = (e.clientY - r.top) * k;
    let at;
    if (g.k === 'conic') {
      const a = Math.atan2(px - g.cx * clCv.width, -(py - g.cy * clCv.height)) * 180 / Math.PI;
      at = (((a - g.ang) % 360) + 360) % 360 / 360;
      if (d.stop.at >= .999 && at < .05) at = 1;   // у конца кольца точка остаётся на конце, а не перескакивает в начало
      else if (d.stop.at <= .001 && at > .95) at = 0;
    } else {
      const m = clMarkers(clCv.width, clCv.height);
      at = ((px - m.x0) * m.dx + (py - m.y0) * m.dy) / (m.dx * m.dx + m.dy * m.dy);
    }
    d.stop.at = Math.min(Math.max(at, 0), 1);
  } else if (g.k === 'lin') {
    const [W, H] = clWH();
    g.ang = snap(Math.atan2((u - .5) * W, -(v - .5) * H) * 180 / Math.PI);
  } else if (g.k === 'conic' && d && d.turn) {
    g.ang = snap(Math.atan2(e.clientX - r.left - g.cx * r.width, -(e.clientY - r.top - g.cy * r.height)) * 180 / Math.PI);
  } else { g.cx = Math.min(Math.max(u, 0), 1); g.cy = Math.min(Math.max(v, 0), 1); }
  clRender();
}

// ---------- полоса с точками ----------
const clBar = $('clBar');
function clBarDraw() {
  clBar.querySelector('b').style.background = clCssOf({...cl.g, k: 'lin', ang: 90, fx: undefined}, true);   // на полосе точки, без стиля
  const have = new Map([...clBar.querySelectorAll('.cl-st')].map(el => [+el.dataset.id, el]));
  for (const s of cl.g.stops) {
    let el = have.get(s.id);
    if (!el) { el = document.createElement('i'); el.className = 'cl-st'; el.dataset.id = s.id; clBar.append(el); }
    have.delete(s.id);
    el.style.left = clPct(s.at);
    el.style.setProperty('--c', s.c);
    el.classList.toggle('on', s === clSel);
    el.classList.toggle('lock', s.lock);
  }
  for (const el of have.values()) el.remove();
}
let clBarDrag = null;   // {s, id, out — утащили вниз, отпустить = удалить}
clBar.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  const r = clBar.getBoundingClientRect(), at = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1);
  const hit = e.target.closest('.cl-st');
  let s = hit ? cl.g.stops.find(x => x.id === +hit.dataset.id) : null;
  if (!s) {   // щелчок по пустому месту — новая точка цвета, который там уже есть
    if (cl.g.stops.length >= CL_MAX) { toast({type: 'warn', title: t('cl.maxStops', {n: CL_MAX}), ttl: 3000}); return; }
    s = clStop(at, cpHex(clAt(cl.g, at), true));
    cl.g.stops.push(s);
  }
  clSel = s;
  clBarDrag = {s, id: e.pointerId, out: false, x0: e.clientX, moved: false};
  clBar.setPointerCapture(e.pointerId);
  clRender();
});
clBar.addEventListener('pointermove', e => {
  const d = clBarDrag;
  if (!d || d.id !== e.pointerId) return;
  const r = clBar.getBoundingClientRect();
  if (!d.moved && Math.abs(e.clientX - d.x0) < 3) return;
  d.moved = true;
  d.s.at = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1);
  d.out = cl.g.stops.length > 2 && e.clientY > r.bottom + 36;
  const el = clBar.querySelector(`.cl-st[data-id="${d.s.id}"]`);
  if (el) el.classList.toggle('out', d.out);
  clRender();
});
function clBarUp(e) {
  const d = clBarDrag;
  if (!d || d.id !== e.pointerId) return;
  clBarDrag = null;
  if (d.out) clDel(d.s); else clRender();
  clSave();
  // щелчок без тяги (по точке или по пустому месту, где точка только что появилась) — сразу окно цвета, как в Figma
  if (!d.out && !d.moved && e.type === 'pointerup') clChipOpen(d.s.id);
}
clBar.addEventListener('pointerup', clBarUp);
clBar.addEventListener('pointercancel', clBarUp);
function clDel(s) {
  if (cl.g.stops.length <= 2 || !s) return;
  cl.g.stops = cl.g.stops.filter(x => x !== s);
  clSel = clSorted(cl.g)[0];
  clRender(); clSave();
}

// ---------- точки списком: цвет, HEX, замок, копировать, удалить ----------
const clStopsEl = $('clStops');
let clChipsSig = '';
const CL_ICO = {
  lock: '<svg viewBox="0 0 16 16"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>',
  open: '<svg viewBox="0 0 16 16"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 4.8-1"/></svg>',
  copy: '<svg viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5v-.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.5"/></svg>',
  del: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
};
function clChips() {
  const list = clSorted(cl.g), sig = list.map(s => s.id).join(',');
  if (sig !== clChipsSig) {
    if (cp && clStopsEl.contains(cp.el)) cpClose(true);
    clChipsSig = sig;
    clStopsEl.innerHTML = list.map(s => `<div class="cl-chip" data-id="${s.id}">
      <button type="button" class="cp-sw" aria-label="${esc(t('cl.color'))}"></button>
      <input type="text" class="cl-hex" spellcheck="false" maxlength="9" aria-label="HEX">
      <button type="button" class="cl-mini cl-lk"></button>
      <button type="button" class="cl-mini cl-cp" title="${esc(t('cl.copy'))}" aria-label="${esc(t('cl.copy'))}">${CL_ICO.copy}</button>
      <button type="button" class="cl-mini cl-x" title="${esc(t('cl.del'))}" aria-label="${esc(t('cl.del'))}">${CL_ICO.del}</button></div>`).join('');
    clStopsEl.querySelectorAll('.cl-chip').forEach(ch => {
      const s = () => cl.g.stops.find(x => x.id === +ch.dataset.id);
      let was;
      cpField(ch.querySelector('.cp-sw'), {alpha: true,
        live: v => { const x = s(); if (x) { if (was === undefined) was = x.c; x.c = v; clRender(); } },
        done: ok => { const x = s(); if (x && !ok && was !== undefined) x.c = was; was = undefined; clRender(); clSave(); }});
    });
  }
  const many = list.length > 2;
  for (const s of list) {
    const ch = clStopsEl.querySelector(`.cl-chip[data-id="${s.id}"]`);
    if (!ch) continue;
    ch.classList.toggle('on', s === clSel);
    const sw = ch.querySelector('.cp-sw');
    if (sw.value !== s.c && !(cp && cp.el === sw)) sw.value = s.c;
    const hx = ch.querySelector('.cl-hex');
    if (document.activeElement !== hx) hx.value = clUp(s.c);
    const lk = ch.querySelector('.cl-lk');
    lk.innerHTML = s.lock ? CL_ICO.lock : CL_ICO.open;
    lk.classList.toggle('on', s.lock);
    lk.title = t(s.lock ? 'cl.unlock' : 'cl.lock');
    lk.setAttribute('aria-label', lk.title);
    ch.querySelector('.cl-x').classList.toggle('hide', !many);
  }
}
// окно цвета у точки (оно уже открыто у неё — не закрывать: cpOpen по тому же полю закрыл бы его)
function clChipOpen(id) { const sw = clStopsEl.querySelector(`.cl-chip[data-id="${id}"] .cp-sw`); if (sw && !(cp && cp.el === sw)) cpOpen(sw); }
clStopsEl.addEventListener('click', e => {
  const ch = e.target.closest('.cl-chip');
  if (!ch) return;
  const s = cl.g.stops.find(x => x.id === +ch.dataset.id);
  if (!s) return;
  if (clSel !== s) { clSel = s; clRender(); }
  if (e.target.closest('.cl-lk')) { s.lock = !s.lock; clRender(); clSave(); }
  else if (e.target.closest('.cl-cp')) clCopy(clUp(s.c));
  else if (e.target.closest('.cl-x')) clDel(s);
  else if (!e.target.closest('.cp-sw,input')) clChipOpen(s.id);   // щелчок по карточке мимо кнопок — тоже окно цвета
});
// «+ Цвет»: новая точка в самом широком промежутке, цвет — сосед по кругу оттенков, и сразу окно цвета
$('clAdd').onclick = () => {
  const g = cl.g, list = clSorted(g);
  if (g.stops.length >= CL_MAX) { toast({type: 'warn', title: t('cl.maxStops', {n: CL_MAX}), ttl: 3000}); return; }
  let at = 1, gap = -1;
  list.forEach((s, i) => { const n = list[i + 1]; if (n && n.at - s.at > gap) { gap = n.at - s.at; at = (s.at + n.at) / 2; } });
  const o = clLch(clAt(g, at, list));
  const s = clStop(at, cpHex(clFit({L: Math.min(Math.max(o.L, .55), .85), C: Math.max(o.C, .12), H: (o.H + 40 + Math.random() * 80) % 360}), false));
  g.stops.push(s);
  clSel = s;
  clRender(); clSave();
  clChipOpen(s.id);
};
clStopsEl.addEventListener('change', e => {
  if (!e.target.matches('.cl-hex')) return;
  const s = cl.g.stops.find(x => x.id === +e.target.closest('.cl-chip').dataset.id), c = cpParse(e.target.value);
  if (s && c) { s.c = cpHex(c, true); clSave(); }
  clRender();
});
clStopsEl.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('.cl-hex')) e.target.blur(); });

// ---------- случайный градиент: красивые сочетания по кругу оттенков в OKLCH, закреплённые точки не трогаются ----------
const CL_SCHEMES = [[0, 30, 60, 90], [0, 180, 20, 200], [0, 120, 240], [0, 150, 210], [0, 0, 0, 0], [0, -40, 40, 80]];
function clRandom() {
  const g = cl.g, locked = g.stops.filter(s => s.lock);
  const base = locked.length ? clLch(cpParse(locked[0].c)).H : Math.random() * 360;
  const sch = CL_SCHEMES[Math.floor(Math.random() * CL_SCHEMES.length)], mono = sch.every(x => !x);
  const L0 = .45 + Math.random() * .15, L1 = .75 + Math.random() * .17, up = Math.random() < .5;
  const free = clSorted(g).filter(s => !s.lock);
  free.forEach((s, i) => {
    const k = free.length > 1 ? i / (free.length - 1) : .5, kk = up ? k : 1 - k;
    const H = (base + sch[(i + (locked.length ? 1 : 0)) % sch.length] + (Math.random() - .5) * 16 + 360) % 360;
    let L = mono ? L0 + (L1 - L0) * kk : L0 + (L1 - L0) * (.3 + .7 * Math.random());
    if (H > 60 && H < 130) L = Math.max(L, .8);   // тёмный жёлтый и салатовый выходят болотными
    const C = mono ? .06 + Math.random() * .1 : .1 + Math.random() * .12;
    s.c = cpHex({...clFit({L, C, H}), a: (cpParse(s.c) || {a: 1}).a}, true);
  });
  clRender(); clSave();
}

// ---------- копирование ----------
async function clCopy(text, title) {
  try { await navigator.clipboard.writeText(text); toast({type: 'ok', title: title || t('cl.copied', {v: esc(text)}), ttl: 2200}); }
  catch (e) { say('warn', t('warn.title'), t('cl.copyFail')); }
}
const clRecentAdd = hex => storeSet(CP_RECENT_KEY, JSON.stringify([hex, ...cpRecent().filter(v => v !== hex)].slice(0, CP_RECENT_N)));

// ---------- выгрузка ----------
const clName = ext => `gradient-${clWH().join('x')}.${ext}`;
const clNoOutText = (ext, W, H) => { const k = clNoOut(cl.g, ext, W, H); return k && t(k, {s: clFxName(clFxT(cl.g)), n: CL_FX_SHAPES}); };
$('clCss').onclick = () => {
  const no = clNoOutText('css');
  if (no) say('warn', t('warn.title'), no); else clCopy(clCssCode(cl.g), t('cl.cssCopied'));
};
$('clSvg').onclick = () => dialog(async () => {
  const [W, H] = clWH(), no = clNoOutText('svg', W, H);
  if (no) { say('warn', t('warn.title'), no); return; }
  clSaved(await api('color-save', {ext: 'svg', name: clName('svg'), data: clSvg(cl.g, W, H)}));
});
$('clPng').onclick = () => dialog(async () => {
  const [W, H] = clWH(), c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  clPaint(x, cl.g, W, H);
  // лёгкий шум на полшага яркости: на плавных переходах в 8 битах иначе видны ступеньки. Ровным заливкам стилей он не нужен
  if (clFxT(cl.g) === 'none') {
    const im = x.getImageData(0, 0, W, H), d = im.data;
    for (let i = 0; i < d.length; i += 4) { const n = Math.random() - .5; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
    x.putImageData(im, 0, 0);
  }
  clSaved(await api('color-save', {ext: 'png', name: clName('png'), data: c.toDataURL('image/png').split(',')[1]}));
});
function clSaved(r) {
  if (r.error) { say('err', t('cl.saveFail'), r.error); return; }
  if (r.path) toast({type: 'ok', title: t('cl.saved'), text: esc(r.path), ttl: 5000});
}

// ---------- пипетка и форматы ----------
function clPickDraw() {
  const hex = cl.pick;
  $('clBig').style.background = hex;
  const sw = $('clPickSw');
  if (sw.value !== hex && !(cp && cp.el === sw)) sw.value = hex;
  $('clCtr').innerHTML = [['#ffffff', 'cl.ctrW'], ['#000000', 'cl.ctrB']].map(([fg, k]) => {
    const r = clContrast(hex, fg), mark = r >= 7 ? 'AAA' : r >= 4.5 ? 'AA' : r >= 3 ? t('cl.ctrBig') : t('cl.ctrNo');
    return `<div class="cl-ctrs" style="color:${fg}"><b>Aa</b><span>${esc(t(k))}</span><em>${r.toFixed(1).replace(/\.0$/, '')}:1 · ${esc(mark)}</em></div>`;
  }).join('');
  $('clFmts').innerHTML = clFormats(hex).map(([k, v]) => `<div class="cl-fmt"><span>${k}</span><code>${esc(v)}</code>
    <button type="button" class="cl-mini" data-v="${esc(v)}" title="${esc(t('cl.copy'))}" aria-label="${esc(t('cl.copy'))} ${k}">${CL_ICO.copy}</button></div>`).join('');
}
$('clFmts').addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (b) { clCopy(b.dataset.v); clRecentAdd(cl.pick); clLibDraw(); } });
cpField($('clPickSw'), {live: v => { cl.pick = v; clPickDraw(); }, done: () => { clSave(); clLibDraw(); }});
// контраст двух цветов по WCAG 2: (L1 + 0.05) / (L2 + 0.05), L — относительная яркость sRGB
function clContrast(a, b) {
  const lum = hex => { const c = cpParse(hex), f = v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }; return .2126 * f(c.r) + .7152 * f(c.g) + .0722 * f(c.b); };
  const x = lum(a), y = lum(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
// большая плашка: щелчок открывает выбор цвета, как образец рядом с кнопкой
$('clBig').addEventListener('click', () => $('clPickSw').click());
$('clBig').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('clPickSw').click(); } });
$('clEye').onclick = async () => {
  toast({type: 'ok', title: t('cl.eyeGo'), ttl: 2500});
  const hex = await screenColor();   // null — Esc, передумали
  const c = hex && cpParse(hex);
  if (!c) return;
  cl.pick = cpHex(c, false);
  clRecentAdd(cl.pick); clSave(); clRender();
};
// цвет новой точкой градиента в самый широкий промежуток (из пипетки, «Отправить в» в colorset.js); false — точек уже предел
function clAddStop(hex) {
  const g = cl.g;
  if (g.stops.length >= CL_MAX) { toast({type: 'warn', title: t('cl.maxStops', {n: CL_MAX}), ttl: 3000}); return false; }
  const list = clSorted(g);
  let at = 1, gap = -1;
  list.forEach((s, i) => { const n = list[i + 1]; if (n && n.at - s.at > gap) { gap = n.at - s.at; at = (s.at + n.at) / 2; } });
  clSel = clStop(at, hex);
  g.stops.push(clSel);
  return true;
}

// ---------- Мои цвета и недавние ----------
// в библиотеке три вида: цвет '#rrggbb', градиент {k, stops…}, палитра {p: ['#rrggbb', …]}
const clLibOk = x => typeof x === 'string' ? cpParse(x) : x && x.p ? csPalOf(x.p).length >= CS_MIN : clValidG(x);
const clLib = () => { try { return (JSON.parse(storeGet(CL_LIB_KEY)) || []).filter(clLibOk); } catch (e) { return []; } };
const clLibSet = list => { storeSet(CL_LIB_KEY, JSON.stringify(list.slice(0, CL_LIB_N))); clMark(); };
// палитра полосками одинаковой ширины
const clPalCss = p => `linear-gradient(90deg, ${p.map((c, i) => `${c} ${clPct(i / p.length)} ${clPct((i + 1) / p.length)}`).join(', ')})`;
function clLibDraw() {
  const lib = clLib();
  $('clSaved').innerHTML = lib.map((x, i) => {
    const p = x.p ? csPalOf(x.p) : null, g = typeof x === 'string' || p ? null : clValidG(x);
    const bg = p ? clPalCss(p) : g ? clCssOf(g, true) : x;
    return `<div class="cl-item${g || p ? ' grad' : ''}" data-i="${i}" role="button" tabindex="0" style="background:${esc(bg)}" title="${esc(p ? t('cs.libLoad') : g ? t('cl.libLoad') : clUp(x))}"><button type="button" class="cl-mini cl-x" title="${esc(t('cl.del'))}" aria-label="${esc(t('cl.del'))}">${CL_ICO.del}</button></div>`;
  }).join('');
  $('clSavedNone').classList.toggle('hide', lib.length > 0);
  $('clKeep').textContent = t(cl.tool === 'pick' || cl.tool === 'shade' || cl.tool === 'ctr' ? 'cl.keepColor' : cl.tool === 'grad' ? 'cl.keep' : 'cs.keep');
  $('clKeep').classList.toggle('cl-no', CS_TOOLS.includes(cl.tool) && cl.tool !== 'shade' && csList().length < CS_MIN);
  $('clRecent').innerHTML = cpRecent().map(v => `<button type="button" class="cl-rc" data-c="${esc(v)}" style="background:${esc(v)}" title="${esc(clUp(v))}" aria-label="${esc(clUp(v))}"></button>`).join('');
}
// цвет из библиотеки или недавних: в пипетке — текущий цвет, в градиенте — выбранная точка
function clUse(hex) {
  if (CS_TOOLS.includes(cl.tool)) { csUse(hex); clLibDraw(); return; }
  if (cl.tool === 'pick') cl.pick = cpHex(cpParse(hex), false);
  else if (cl.tool === 'ctr') cl.ctr.fg = cpHex(cpParse(hex), false);   // цвет из библиотеки — в текст
  else if (cl.tool === 'mix') cl.mix.a = cpHex(cpParse(hex), false);   // и в «Смешать» — цвет A
  else if (clSel) clSel.c = cpHex(cpParse(hex), true);
  clRender(); clSave();
}
$('clSaved').addEventListener('click', e => {
  const it = e.target.closest('.cl-item');
  if (!it) return;
  const lib = clLib(), x = lib[+it.dataset.i];
  if (e.target.closest('.cl-x')) { lib.splice(+it.dataset.i, 1); clLibSet(lib); clLibDraw(); return; }
  if (typeof x === 'string') { clUse(x); return; }
  // градиент или палитра заменяют текущую работу и могут сменить инструмент: говорим, где открылось и как вернуть
  const said = to => toast({type: 'ok', title: t('cl.libOpened', {s: t(CL_TOOL_NAME[to])}), ttl: 3500});
  if (x.p) { csPalLoad(x.p); said('pal'); return; }
  const g = clValidG(x);
  if (!g) return;
  cl.g = g; cl.tool = 'grad'; clSel = clSorted(g)[0];
  clRender(); clSave();
  said('grad');
});
$('clSaved').addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.cl-item')) { e.preventDefault(); e.target.click(); } });
$('clRecent').addEventListener('click', e => { const b = e.target.closest('[data-c]'); if (b) clUse(b.dataset.c); });
$('clKeep').onclick = () => {
  const lib = clLib();
  const one = cl.tool === 'pick' ? cl.pick : cl.tool === 'shade' ? cs.shade.base : null;
  if (cl.tool === 'ctr') lib.unshift({p: [cl.ctr.fg, cl.ctr.bg]});   // пара текст + фон идёт палитрой из двух цветов
  else if (cl.tool === 'mix') lib.unshift({p: mixRow()});   // ряд шагов — палитрой
  else if (one) { if (!lib.includes(one)) lib.unshift(one); }
  else if (cl.tool === 'grad') lib.unshift(clPlain(cl.g));
  else { const p = csList().map(x => x.hex); if (p.length < CS_MIN) { toast({type: 'warn', title: t('cs.none'), ttl: 2500}); return; } lib.unshift({p}); }
  clLibSet(lib); clLibDraw();
  toast({type: 'ok', title: t('cl.kept'), ttl: 2000});
};

// ---------- управление ----------
const clSegSync = (id, v) => $(id).querySelectorAll('[data-v]').forEach(b => b.classList.toggle('on', b.dataset.v === v));
$('clKind').addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (b) { cl.g.k = b.dataset.v; clRender(); clSave(); } });
$('clMix').addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (b) { cl.g.mix = b.dataset.v; clRender(); clSave(); } });
$('clAng').addEventListener('input', () => { const v = +$('clAng').value; if (Number.isFinite(v)) { cl.g.ang = ((Math.round(v) % 360) + 360) % 360; clRender(); } });
$('clAng').addEventListener('change', () => { clRender(); clSave(); });
$('clRot').onclick = () => { cl.g.ang = (cl.g.ang + 90) % 360; clRender(); clSave(); };
$('clFlip').onclick = () => { for (const s of cl.g.stops) s.at = 1 - s.at; clRender(); clSave(); };
$('clRand').onclick = clRandom;
$('clSize').addEventListener('change', () => { cl.size = $('clSize').value; clRender(); clSave(); });
for (const [id, k] of [['clW', 'w'], ['clH', 'h']]) {
  $(id).addEventListener('change', () => {
    const v = Math.round(+$(id).value);
    if (Number.isFinite(v) && v > 0) cl[k] = Math.min(Math.max(v, 16), 8192);
    clRender(); clSave();
  });
}
$('clTools').addEventListener('click', e => { const b = e.target.closest('.cl-tool'); if (b) { cl.tool = b.dataset.tool; clRender(); clSave(); } });

// пробел — случайный градиент или палитра, Delete — убрать выбранную точку (не во время ввода и не поверх окон)
document.addEventListener('keydown', e => {
  if (tab !== 'color' || cl.tool !== 'grad' && cl.tool !== 'pal' || cp || tkTyping(e.target) || document.querySelector('.modal:not(.hide)') || e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.code === 'Space' && !e.target.closest('button,select,[role=button]')) { e.preventDefault(); if (cl.tool === 'pal') csRandom(); else clRandom(); }
  else if (cl.tool === 'grad' && (e.code === 'Delete' || e.code === 'Backspace') && clSel) { e.preventDefault(); clDel(clSel); }
});

// ---------- стиль: переключатель и его настройки ----------
// Настройки каждого стиля помнятся до закрытия программы: вернулся к растру — шаг и угол прежние.
const clFxMem = {};
let clFxSig = '';
const clFxUnit = {s: 'px', ang: '°', k: '%'};
// ключи текстов целиком, чтобы тест текстов (i18n_test.go) видел каждый
const clFxName = ft => ({noise: () => t('cl.fx_noise'), dots: () => t('cl.fx_dots'), lines: () => t('cl.fx_lines'), steps: () => t('cl.fx_steps'), pixel: () => t('cl.fx_pixel')}[ft] || (() => t('cl.fx_none')))();
const clFxLabel = (ft, k) => ({a: () => t('cl.fxP_a'), s: () => ft === 'noise' ? t('cl.fxP_grain') : ft === 'pixel' ? t('cl.fxP_cell') : t('cl.fxP_s'),
  ang: () => t('cl.fxP_ang'), k: () => t('cl.fxP_k'), n: () => t('cl.fxP_n'), bg: () => t('cl.fxP_bg')}[k])();
const clFxTip = k => ({a: () => t('cl.fxTip_a'), s: () => t('cl.fxTip_s'), ang: () => t('cl.fxTip_ang'), k: () => t('cl.fxTip_k'), n: () => t('cl.fxTip_n'), bg: () => t('cl.fxTip_bg')}[k])();
function clFxDraw() {
  const g = cl.g, ft = clFxT(g), box = $('clFxOpt');
  clSegSync('clFx', ft);
  if (clFxSig !== ft) {
    clFxSig = ft;
    box.innerHTML = Object.entries(CL_FX[ft]).map(([k, v]) => {
      const name = esc(clFxLabel(ft, k)), tip = esc(clFxTip(k));
      if (!Array.isArray(v)) return `<span class="cl-fxp" title="${tip}"><span>${name}</span><button type="button" class="cp-sw" data-k="${k}" aria-label="${name}"></button></span>`;
      return `<label class="cl-fxp" title="${tip}"><span>${name}</span><input type="range" class="vol" data-k="${k}" data-origin="${v[2]}" min="${v[0]}" max="${v[1]}" step="1" aria-label="${name}">`
        + `<input type="number" data-k="${k}" min="${v[0]}" max="${v[1]}" step="1" aria-label="${name}">${clFxUnit[k] ? `<i>${clFxUnit[k]}</i>` : ''}</label>`;
    }).join('');
    box.querySelectorAll('input[type=range]').forEach(slPlace);
    box.querySelectorAll('.cp-sw').forEach(sw => {
      let was;
      cpField(sw, {alpha: true,
        live: v => { if (!cl.g.fx) return; if (was === undefined) was = cl.g.fx[sw.dataset.k]; cl.g.fx[sw.dataset.k] = v; clDraw(); },
        done: ok => { if (cl.g.fx && !ok && was !== undefined) cl.g.fx[sw.dataset.k] = was; was = undefined; clRender(); clSave(); }});
    });
  }
  box.classList.toggle('hide', ft === 'none');
  if (ft === 'none') return;
  box.querySelectorAll('[data-k]').forEach(el => {
    const v = g.fx[el.dataset.k];
    if (el.matches('.cp-sw')) { if (el.value !== v && !(cp && cp.el === el)) el.value = v; }
    else if (document.activeElement !== el || el.type === 'range') el.value = v;
  });
}
$('clFx').addEventListener('click', e => {
  const b = e.target.closest('[data-v]'), g = cl.g;
  if (!b || b.dataset.v === clFxT(g)) return;
  if (g.fx) clFxMem[g.fx.t] = {...g.fx};
  const ft = b.dataset.v;
  g.fx = ft === 'none' ? undefined : {...(clFxMem[ft] || clFxDef(ft))};
  clRender(); clSave();
});
// ползунок и число рядом: оба правят одно значение; тяга рисует сразу, шаг отмены — по отпусканию
function clFxIn(e, commit) {
  const el = e.target.closest('input[data-k]'), f = cl.g.fx;
  if (!el || !f) return;
  const v = CL_FX[f.t][el.dataset.k], n = Math.round(+el.value);
  if (el.value === '' || !Number.isFinite(n)) { if (commit) clRender(); return; }
  f[el.dataset.k] = Math.min(Math.max(n, v[0]), v[1]);
  $('clFxOpt').querySelectorAll(`input[data-k="${el.dataset.k}"]`).forEach(x => { if (x !== el) x.value = f[el.dataset.k]; });
  clDraw();
  if (commit) { clRender(); clSave(); }
}
$('clFxOpt').addEventListener('input', e => clFxIn(e, false));
$('clFxOpt').addEventListener('change', e => clFxIn(e, true));

function clRender() {
  if (!cl.g.stops.includes(clSel)) clSel = clSorted(cl.g)[0];
  const g = cl.g, grad = cl.tool === 'grad';
  document.querySelectorAll('#clTools .cl-tool').forEach(b => b.classList.toggle('on', b.dataset.tool === cl.tool));
  $('clGrad').classList.toggle('hide', !grad);
  $('clPick').classList.toggle('hide', cl.tool !== 'pick');
  $('ctrWork').classList.toggle('hide', cl.tool !== 'ctr');
  $('mixWork').classList.toggle('hide', cl.tool !== 'mix');
  $('csWork').classList.toggle('hide', !CS_TOOLS.includes(cl.tool));
  if (grad) {
    clSegSync('clKind', g.k);
    clSegSync('clMix', g.mix);
    $('clAngWrap').classList.toggle('hide', g.k === 'rad');
    $('clRot').classList.toggle('hide', g.k === 'rad');
    if (document.activeElement !== $('clAng')) $('clAng').value = Math.round(g.ang);
    $('clSize').value = cl.size;
    $('clOwn').classList.toggle('hide', cl.size !== 'own');
    if (document.activeElement !== $('clW')) $('clW').value = cl.w;
    if (document.activeElement !== $('clH')) $('clH').value = cl.h;
    const [W, H] = clWH();
    for (const [id, no] of [['clSvg', clNoOutText('svg', W, H)], ['clCss', clNoOutText('css')]]) { $(id).title = no || ''; $(id).classList.toggle('cl-no', !!no); }
    clFxDraw(); clBarDraw(); clChips(); clDraw();
  } else if (cl.tool === 'pick') clPickDraw();
  else if (cl.tool === 'ctr') ctrDraw();
  else if (cl.tool === 'mix') mixDraw();
  else csRender();
  clLibDraw();
  clSendDraw();
}
// вкладку показали: размеры поля стали известны
function clShow() { clRender(); }
new ResizeObserver(() => { if (tab === 'color' && cl.tool === 'grad') clDraw(); }).observe($('clView'));
// язык сменили (settings.js): подписи в точках и кнопках собираются заново
function clRelang() { clChipsSig = ''; clFxSig = ''; csRelang(); if (tab === 'color') clRender(); }

clLoad();
$('clEyeNo').classList.add('hide');   // своя пипетка есть всегда, запасной не нужен
