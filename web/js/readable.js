// ---------- читаемость текста на фоне: общий расчёт для Монтажа (mtread.js), Баннеров и Фавиконов ----------
// Контраст по WCAG 2: (L1 + 0.05) / (L2 + 0.05). Текст в кадре всегда крупный, поэтому порог 3:1, а подсказки подтягивают до 4.5:1.
const RD_MIN = 3, RD_GOOD = 4.5;
const RD_EDGE = .04;   // обводка тоньше этой доли кегля буквы не отделяет
const RD_LOW = .1;     // по какой доле самых плохих точек фона судить: светлое пятно на десятой части рамки уже съедает буквы

const rdLin = v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; };
const rdLum = (r, g, b) => .2126 * rdLin(r) + .7152 * rdLin(g) + .0722 * rdLin(b);
const rdRatio = (x, y) => (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
// контраст двух цветов #rrggbb
const rdContrast = (a, b) => { const x = cpParse(a), y = cpParse(b); return rdRatio(rdLum(x.r, x.g, x.b), rdLum(y.r, y.g, y.b)); };
// цвета, из которых состоит заливка: сам цвет или точки градиента ({r, g, b, a})
function rdInks(v) {
  if (cpGrad(v)) return v.stops.map(s => cpParse(s.c)).filter(Boolean);
  const c = cpParse(v);
  return c ? [c] : [];
}
const rdOver = (a, k, b) => a * k + b * (1 - k);
// худший контраст набора красок с цветом (r, g, b) под ними; полупрозрачная краска смешивается с этим цветом
function rdWorst(inks, r, g, b) {
  const under = rdLum(r, g, b);
  let worst = Infinity;
  for (const c of inks) worst = Math.min(worst, rdRatio(rdLum(rdOver(c.r, c.a, r), rdOver(c.g, c.a, g), rdOver(c.b, c.a, b)), under));
  return worst;
}
// Проверка текста на фоне. px — RGBA пикселей фона под текстом (ImageData.data), ink — цвет или градиент текста.
// opt.back {c, a} — подложка под текстом (a — непрозрачность), opt.edge {c, w} — обводка, w в долях кегля.
// Ответ: ratio — контраст, by — что его даёт ('bg' фон, 'back' подложка, 'edge' обводка), ok — хватает ли; null — мерить нечего.
function rdCheck(px, ink, opt = {}) {
  const inks = rdInks(ink);
  if (!inks.length || !px || px.length < 4) return null;
  // обводка заметного цвета и толщины держит буквы на любом фоне
  const edges = opt.edge && opt.edge.w >= RD_EDGE ? rdInks(opt.edge.c).filter(e => e.a > .5).map(e => rdWorst(inks, e.r, e.g, e.b)) : [];
  const edge = edges.length ? Math.min(...edges) : 0;
  const back = opt.back && cpParse(opt.back.c), ba = back ? Math.min(Math.max(opt.back.a, 0), 1) : 0;
  const n = px.length / 4, step = Math.max(1, Math.floor(n / 4096)), list = [];
  for (let i = 0; i < n; i += step) {
    let r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
    if (back) { r = rdOver(back.r, ba, r); g = rdOver(back.g, ba, g); b = rdOver(back.b, ba, b); }
    list.push(rdWorst(inks, r, g, b));
  }
  list.sort((a, b) => a - b);
  const ratio = list[Math.floor((list.length - 1) * RD_LOW)];
  if (edge >= RD_GOOD && edge > ratio) return {ratio: edge, by: 'edge', ok: true};
  return {ratio, by: back ? 'back' : 'bg', ok: ratio >= RD_MIN};
}
// цвет обводки или подложки, на котором текст виден лучше: чёрный или белый
function rdGuard(ink) {
  const inks = rdInks(ink);
  const on = c => Math.min(...inks.map(i => rdRatio(rdLum(i.r, i.g, i.b), rdLum(c, c, c))));
  return on(0) >= on(255) ? '#000000' : '#ffffff';
}
// наименьшая непрозрачность подложки цвета back, с которой текст читается хорошо (до RD_GOOD); не хватает и сплошной — 1
function rdBackAlpha(px, ink, back) {
  for (const a of [.5, .6, .7, .8, .9]) { const r = rdCheck(px, ink, {back: {c: back, a}}); if (r && r.ratio >= RD_GOOD) return a; }
  return 1;
}
// контраст для показа: 1 знак после запятой, без «.0»
const rdShow = r => (Math.floor(r * 10) / 10).toFixed(1).replace(/\.0$/, '');
