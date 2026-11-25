// «Доработать вырезку» (раньше «Поправить вырезку»): ручная доработка картинки, устроенная как в Фотошопе: слева инструменты
// (V, M, W, P, E, Y, H, Z), над картинкой параметры инструмента, справа выделение, край и оригинал. Входы: «Утилиты» → «Убрать фон»
// (кнопка «Доработать» у готового файла и в карточке «Редактор вырезки» — файл из списка, с фоном или без), галерея генератора.
// Картинка = цвет × маска. Цвет (ce.col): пиксели вырезки, а там, где нейросеть стёрла всё, — пиксели оригинала.
// Маска (ce.mk): белое с прозрачностью; ластик стирает её (destination-out), «Вернуть» докрашивает (source-over).
// Без оригинала цвет — сама вырезка с её прозрачностью, маска — белая целиком: «Вернуть» возвращает только то, что было.
// Мазки хранятся списком, отмена перерисовывает маску с начала (как в geninpaint.js).
// Край (сжать/расширить, растушёвка, кайма) считается по пикселям после мазка и при движении ползунков: ceFx.
// Обычная картинка без прозрачности (ce.plain): цвет — она сама, маска белая; фон стирается инструментами, альфа появляется сама.
// Прямоугольник, перо (контур Безье, точки как у пера Монтажа в shapes.js) и волшебная палочка дают выделение (муравьи);
// стирает его Delete, возвращает кнопка «Вернуть». Выделение и стирание лежат в общем списке мазков сжатыми по строкам (RLE),
// поэтому отмена у всех общая и повтор не зависит от порядка.
// Сервер: cutedit.go (cut-src ищет оригинал, cut-save кладёт PNG отдельным файлом).
const CE_ZMAX = 32;
const ce = {
  on: false, busy: false,
  path: '', src: '', srcBad: false, done: null,
  w: 0, h: 0,
  col: null,        // холст цвета (w×h)
  colData: null,    // его пиксели: RGB без потерь на прозрачном и потолок прозрачности
  mk: null,         // холст маски
  mk0: null,        // маска до правок
  cv: null,         // показ: цвет × маска (или ce.fx)
  fx: null,         // показ с обработанным краем; null — край не трогали или идёт мазок
  strokes: [],      // {erase, r, soft, pts: [[x, y], …]}, {reset: true}, {sel: RLE, erase}
                    // или {selset: RLE | null, ox, oy} — выделение (маску не меняет, но отменяется вместе со всем)
  redo: [],
  cur: null,
  tool: 'erase',    // move | rect | wand | pen | erase | restore | hand | zoom (порядок и клавиши как в Фотошопе)
  pen: null,        // контур пера: {pts: [[x, y, ix, iy, ox, oy], …], closed, hover, close}
  wandAll: false,   // палочка по всей картинке, а не связной областью
  selA: null,       // выделение 0…255 на точку (Uint8Array w×h) без сдвига; null — нет
  selR: null,       // его RLE из истории (по ссылке видно, что массив тот же)
  selX: 0, selY: 0, // сдвиг выделения инструментом «Переместить»
  ants: null,       // контур муравьёв (Path2D в точках картинки, без сдвига)
  selMode: {rect: 'new', pen: 'new', wand: 'new'},   // new | add | sub | inter
  rc: null,         // рамка инструмента «Прямоугольное выделение» при протяжке: {a: [x, y], b, mode}
  plain: false,     // открыта обычная картинка без прозрачности: «Вернуть» берёт из неё самой
  mods: {shift: false, alt: false}, mx: 0, my: 0,
  drag: null,       // тяга точки или ручки контура: {move(e), end(ok)}
  z: 1, px: 0, py: 0,
  pan: null, space: false,
  bg: 'chk',
};

function ceImg(url) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
}
const ceCanvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

// ceOpen: o = {path — что правим (PNG с прозрачностью), src — оригинал (не задан — спросить сервер), done(путь) — после сохранения}
async function ceOpen(o) {
  if (ce.on) return;
  Object.assign(ce, {on: true, busy: true, path: o.path, done: o.done || null, strokes: [], redo: [], cur: null, fx: null, pan: null, pen: null, drag: null,
    selA: null, selR: null, selX: 0, selY: 0, ants: null, rc: null});
  cePenDraw();
  $('ceName').textContent = base(o.path);
  $('ceName').title = o.path;
  for (const id of ['ceFeather', 'ceShift', 'ceFringe']) $(id).value = 0;
  ceVals();
  $('ceLoad').classList.remove('hide');
  $('ce').classList.remove('hide');
  ceState();
  try {
    const im = await ceImg(mediaUrl(o.path) + '&_=' + Date.now());
    if (!ce.on) return;
    ce.w = im.naturalWidth; ce.h = im.naturalHeight;
    ce.cut = ceCanvas(ce.w, ce.h);
    ce.cut.getContext('2d').drawImage(im, 0, 0);
    // без единой прозрачной точки — обычная картинка: оригинал не нужен, «Вернуть» берёт из неё самой
    const A = ce.cut.getContext('2d').getImageData(0, 0, ce.w, ce.h).data;
    let solid = true;
    for (let i = 3; i < A.length && solid; i += 4) solid = A[i] === 255;
    ce.plain = solid;
    let src = o.src;
    if (solid) src = '';
    else if (src === undefined) { const r = await api('cut-src', {path: o.path}); src = r.src || ''; }
    await ceSetSrc(src);
    if (!ce.on) return;
    const cv = $('ceCv'); cv.width = ce.w; cv.height = ce.h; ce.cv = cv;
    ceFit();
    ceRender();
  } catch (e) {
    ceClose(true);
    toast({type: 'warn', title: t('ce.loadFail'), text: esc(o.path), ttl: 6000});
    return;
  } finally {
    ce.busy = false;
    $('ceLoad').classList.add('hide');
    ceState();
  }
}

// ceSetSrc: оригинал для кисти «Вернуть»; другой формы не годится (растянется криво)
async function ceSetSrc(src) {
  let orig = null;
  ce.srcBad = false;
  if (src) {
    try {
      orig = await ceImg(mediaUrl(src));
      if (Math.abs(orig.naturalWidth / orig.naturalHeight - ce.w / ce.h) > 0.01) { orig = null; ce.srcBad = true; }
    } catch (e) { orig = null; }
  }
  ce.src = orig ? src : '';
  const w = ce.w, h = ce.h, n = w * h;
  const cut = ce.cut.getContext('2d').getImageData(0, 0, w, h).data;
  const col = new ImageData(w, h), d = col.data;
  if (orig) {
    const oc = ceCanvas(w, h), og = oc.getContext('2d');
    og.drawImage(orig, 0, 0, w, h);
    const od = og.getImageData(0, 0, w, h).data;
    for (let i = 0; i < n * 4; i += 4) {
      const s = cut[i + 3] > 0 ? cut : od;
      d[i] = s[i]; d[i + 1] = s[i + 1]; d[i + 2] = s[i + 2]; d[i + 3] = 255;
    }
  } else d.set(cut);
  ce.colData = d;
  ce.col = ceCanvas(w, h);
  ce.col.getContext('2d').putImageData(col, 0, 0);
  // маска: с оригиналом — прозрачность вырезки, без него — белая целиком (потолок — прозрачность цвета)
  ce.mk0 = ceCanvas(w, h);
  const mg = ce.mk0.getContext('2d');
  if (orig) {
    const m = new ImageData(w, h), md = m.data;
    for (let i = 0; i < n * 4; i += 4) { md[i] = md[i + 1] = md[i + 2] = 255; md[i + 3] = cut[i + 3]; }
    mg.putImageData(m, 0, 0);
  } else { mg.fillStyle = '#fff'; mg.fillRect(0, 0, w, h); }
  ce.mk = ceCanvas(w, h);
  ceReplay();
  ceSrcNote();
}

function ceSrcNote() {
  $('ceSrc').textContent = ce.src ? base(ce.src) : t(ce.plain ? 'ce.srcSelf' : ce.srcBad ? 'ce.srcBad' : 'ce.srcNone');
  $('ceSrc').title = ce.src || '';
  $('ceSrc').classList.toggle('warn', !ce.src && !ce.plain);
  $('ceSrcS').classList.toggle('hide', ce.plain && !ce.src);
}

function ceDirty() {
  return ce.strokes.some(s => !('selset' in s)) || (ce.pen && ce.pen.pts.length > 1) || +$('ceFeather').value || +$('ceShift').value || +$('ceFringe').value;
}

async function ceClose(force) {
  if (!ce.on) return;
  if (!force && ceDirty() && !await askYes(t('ce.dropAsk'), t('ce.drop'))) return;
  Object.assign(ce, {on: false, cut: null, col: null, colData: null, mk: null, mk0: null, fx: null, strokes: [], redo: [], cur: null, done: null,
    pen: null, drag: null, tmp: null, tmpD: null, selA: null, selR: null, ants: null, mv: null, rc: null});
  ceAntsTick(); ceAntsDraw();
  cePenDraw();
  $('ce').classList.add('hide');
  $('ceCur').classList.add('hide');
  const cv = $('ceCv'); cv.width = cv.height = 1;
}

// ---- вид: масштаб и сдвиг ----
function ceApplyView() {
  Object.assign($('ceBox').style, {width: ce.w * ce.z + 'px', height: ce.h * ce.z + 'px', transform: `translate(${ce.px}px, ${ce.py}px)`});
  $('ceCv').classList.toggle('px', ce.z >= 2);
  $('ceZoomV').textContent = Math.round(ce.z * 100) + '%';
  cePenDraw();
  ceAntsDraw();
}
function ceFitZ() {
  const st = $('ceStage');
  return Math.max(0.01, Math.min(1, (st.clientWidth - 24) / ce.w, (st.clientHeight - 24) / ce.h) || 1);
}
// вписанная картинка остаётся вписанной при смене размера окна, пока её не двигали и не увеличивали
function ceFit() {
  if (!ce.w) return;
  const st = $('ceStage');
  ce.auto = true;
  ce.z = ceFitZ();
  ce.px = (st.clientWidth - ce.w * ce.z) / 2;
  ce.py = (st.clientHeight - ce.h * ce.z) / 2;
  ceApplyView();
}
function ceZoomAt(z, cx, cy) {
  z = Math.min(CE_ZMAX, Math.max(Math.min(ceFitZ(), 1) / 4, z));
  ce.auto = false;
  ce.px = cx - (cx - ce.px) * z / ce.z;
  ce.py = cy - (cy - ce.py) * z / ce.z;
  ce.z = z;
  ceApplyView();
}

// ---- кисть ----
// отпечаток кисти: белый круг радиуса r, мягкость soft (0…1) — доля радиуса, на которой край сходит на нет
function ceStampOf(s) {
  if (s.stamp) return s.stamp;
  const r = s.r, d = Math.ceil(r * 2) + 2, c = ceCanvas(d, d), g = c.getContext('2d'), m = d / 2;
  if (s.soft <= 0) { g.fillStyle = '#fff'; g.beginPath(); g.arc(m, m, r, 0, Math.PI * 2); g.fill(); }
  else {
    const gr = g.createRadialGradient(m, m, 0, m, m, r);
    gr.addColorStop(0, '#fff');
    gr.addColorStop(Math.max(0, 1 - s.soft), '#fff');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, d, d);
  }
  return (s.stamp = c);
}
// мазок от a до b: отпечатки через шаг, остаток шага переходит в следующий отрезок
function ceSeg(g, s, a, b) {
  const st = ceStampOf(s), step = Math.max(1, s.r * (s.soft > 0 ? 0.2 : 0.3)), m = st.width / 2;
  g.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over';
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
  if (!len) { if (s.rest === undefined) { g.drawImage(st, a[0] - m, a[1] - m); s.rest = 0; } return; }
  let at = s.rest === undefined ? 0 : step - s.rest;
  for (; at <= len; at += step) g.drawImage(st, a[0] + dx * at / len - m, a[1] + dy * at / len - m);
  s.rest = len - (at - step);
}
function ceReplay() {
  const g = ce.mk.getContext('2d');
  g.globalCompositeOperation = 'copy';
  g.drawImage(ce.mk0, 0, 0);
  for (const s of ce.strokes) {
    if (s.reset) { g.globalCompositeOperation = 'copy'; g.drawImage(ce.mk0, 0, 0); continue; }
    if (s.sel) { ceSelPaint(g, s); continue; }
    if ('selset' in s) continue;
    delete s.rest;
    s.pts.forEach((p, i) => ceSeg(g, s, s.pts[Math.max(0, i - 1)], p));
  }
  g.globalCompositeOperation = 'source-over';
}

// показ: цвет × маска, а с обработанным краем — готовые пиксели ce.fx
function ceRender() {
  if (!ce.cv) return;
  const g = ce.cv.getContext('2d');
  g.globalCompositeOperation = 'copy';
  if (ce.fx && !ce.cur) { g.drawImage(ce.fx, 0, 0); g.globalCompositeOperation = 'source-over'; return; }
  g.drawImage(ce.col, 0, 0);
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(ce.mk, 0, 0);
  g.globalCompositeOperation = 'source-over';
}

function ceVals() {
  $('ceSizeV').textContent = $('ceSize').value + ' px';
  $('ceSoftV').textContent = $('ceSoft').value + '%';
  $('ceFeatherV').textContent = $('ceFeather').value + ' px';
  const sh = +$('ceShift').value;
  $('ceShiftV').textContent = (sh > 0 ? '+' : '') + sh + ' px';
  $('ceFringeV').textContent = $('ceFringe').value + '%';
  $('ceTolV').textContent = $('ceTol').value + '%';
  $('ceSmoothV').textContent = $('ceSmooth').value + ' px';
}

// ключи текстов инструмента: ce.n.* — имя, ce.o.* — строка параметров, ce.h.* — короткая подсказка за «?» справа
const ceTK = (g, tool) => `ce.${g}.${tool}`;
function ceState() {
  const live = ce.on && !ce.busy;
  $('ceUndo').disabled = !live || !ce.strokes.length;
  $('ceRedo').disabled = !live || !ce.redo.length;
  $('ceReset').disabled = !live || !ce.strokes.length || !!ce.strokes[ce.strokes.length - 1].reset;
  $('ceSave').disabled = !live;
  $('ceSrcPick').disabled = !live;
  const tool = ce.tool;
  document.querySelectorAll('#ceMode button').forEach(b => { const on = b.dataset.v === tool; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
  document.querySelectorAll('#ceBgs [data-bg]').forEach(b => b.classList.toggle('on', b.dataset.bg === ce.bg));
  document.querySelectorAll('#ce .ce-opt').forEach(el => el.classList.toggle('hide', !el.dataset.for.split(' ').includes(tool)));
  // строка параметров: имя инструмента, режим выделения четырьмя кнопками, короткая подсказка; справа — подробная
  $('ceTName').textContent = t(ceTK('n', tool));
  $('ceOHint').textContent = t(ceTK('o', tool));
  $('ceHintCap').textContent = t(ceTK('n', tool));
  $('ceHint').textContent = t(ceTK('h', tool));
  document.querySelectorAll('#ceModes [data-m]').forEach(b => { const on = b.dataset.m === ce.selMode[tool]; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
  $('ceNear').checked = !ce.wandAll;
  $('cePenApply').disabled = !live || !ce.pen || ce.pen.pts.length < 2;
  $('cePenDrop').disabled = !live || !ce.pen || !ce.pen.pts.length;
  const st = $('ceStage');
  st.dataset.bg = ce.bg;
  // выделение: действия доступны, когда оно есть
  const has = live && !!ce.selA;
  for (const id of ['ceSelDel', 'ceSelFill', 'ceSelNone']) $(id).disabled = !has;
  $('ceSelInv').disabled = !live;
  ceCurSet();
}

function ceTool(v) { if (ce.rc) return; ce.tool = v; ceState(); cePenDraw(); }
function ceSize(k) { const r = $('ceSize'); r.value = Math.round(Math.min(+r.max, Math.max(+r.min, +r.value * k + (k > 1 ? 1 : -1)))); ceVals(); }

function ceUndo() {
  if (ce.drag || ce.cur || ce.mv) return;
  // сначала отменяются точки нового контура; возвращённый отменой контур уходит целиком, и отмена идёт дальше
  if (ce.tool === 'pen' && ce.pen && ce.pen.pts.length && !ce.pen.back) { cePenBack(); return; }
  if (ce.pen && ce.pen.back) { ce.pen = null; cePenDraw(); }
  if (!ce.strokes.length) { ceState(); return; }
  const s = ce.strokes.pop(), pts = s.penPts || s.pen;
  ceHist(ce.redo, s);
  // шаг пера — контур возвращается на место, его можно поправить и применить снова
  if (pts && !ce.pen) { ce.pen = {pts: pts.map(p => p.slice()), closed: true, hover: null, close: false, back: true}; ce.tool = 'pen'; ceState(); cePenDraw(); }
}
function ceRedo() {
  if (!ce.redo.length || ce.cur || ce.mv) return;
  const s = ce.redo.pop();
  if ((s.penPts || s.pen) && ce.pen) { ce.pen = null; cePenDraw(); }
  ceHist(ce.strokes, s);
}
// шаг отмены или повтора: выделение маску не трогает, его хватает пересобрать
function ceHist(to, s) {
  to.push(s);
  if ('selset' in s) ceSelSync();
  else { ceReplay(); ceFxSoon(0); }
  ceState();
}
function ceReset() { if (!ce.cur && ce.strokes.length && !ce.strokes[ce.strokes.length - 1].reset) { ce.strokes.push({reset: true}); ce.redo = []; ceReplay(); ceFxSoon(0); ceState(); } }

// ---- край: сжать/расширить, растушёвка, кайма ----
const ceEdgeOn = () => +$('ceFeather').value || +$('ceShift').value || +$('ceFringe').value;

// ceMinMax: сжать (min) или расширить (max) прозрачность на r точек, квадратом через два прохода
function ceMinMax(A, w, h, r, grow) {
  const T = new Uint8ClampedArray(A.length), pick = grow ? Math.max : Math.min;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      let v = A[o + x];
      for (let k = 1; k <= r; k++) {
        if (x - k >= 0) v = pick(v, A[o + x - k]);
        if (x + k < w) v = pick(v, A[o + x + k]);
      }
      T[o + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = T[y * w + x];
      for (let k = 1; k <= r; k++) {
        if (y - k >= 0) v = pick(v, T[(y - k) * w + x]);
        if (y + k < h) v = pick(v, T[(y + k) * w + x]);
      }
      A[y * w + x] = v;
    }
  }
}

// ceBlur: размытие прозрачности квадратом радиуса r, по строкам и по столбцам (бегущая сумма)
function ceBlur(A, w, h, r) {
  const T = new Float32Array(A.length), n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let s = 0;
    for (let k = -r; k <= r; k++) s += A[o + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      T[o + x] = s / n;
      s += A[o + Math.min(w - 1, x + r + 1)] - A[o + Math.max(0, x - r)];
    }
  }
  // по столбцам — суммами всех столбцов сразу, строка за строкой: так память читается подряд (на 4000 px в разы быстрее)
  const S = new Float64Array(w);
  for (let k = -r; k <= r; k++) { const o = Math.min(h - 1, Math.max(0, k)) * w; for (let x = 0; x < w; x++) S[x] += T[o + x]; }
  for (let y = 0; y < h; y++) {
    const o = y * w, add = Math.min(h - 1, y + r + 1) * w, sub = Math.max(0, y - r) * w;
    for (let x = 0; x < w; x++) { A[o + x] = S[x] / n; S[x] += T[add + x] - T[sub + x]; }
  }
}

// ceInner: цвет ближайшего плотного пикселя для полупрозрачного края (до R точек вглубь прозрачного).
// Возвращает массив RGB, где у пикселей края — усреднённый цвет соседей изнутри; has — есть ли он.
function ceInner(A, C, w, h, R) {
  const n = w * h, has = new Uint8Array(n), rgb = new Float32Array(n * 3);
  let edge = [];
  for (let i = 0; i < n; i++) {
    if (A[i] >= 240) { has[i] = 1; rgb[i * 3] = C[i * 4]; rgb[i * 3 + 1] = C[i * 4 + 1]; rgb[i * 3 + 2] = C[i * 4 + 2]; }
    else if (A[i] > 0) edge.push(i);
  }
  for (let pass = 0; pass < R && edge.length; pass++) {
    const got = [], left = [];
    for (const i of edge) {
      const x = i % w, y = (i - x) / w;
      let r = 0, g = 0, b = 0, k = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if ((dx || dy) && xx >= 0 && yy >= 0 && xx < w && yy < h) {
          const j = yy * w + xx;
          if (has[j]) { r += rgb[j * 3]; g += rgb[j * 3 + 1]; b += rgb[j * 3 + 2]; k++; }
        }
      }
      if (k) got.push(i, r / k, g / k, b / k); else left.push(i);
    }
    for (let q = 0; q < got.length; q += 4) { const i = got[q]; has[i] = 1; rgb[i * 3] = got[q + 1]; rgb[i * 3 + 1] = got[q + 2]; rgb[i * 3 + 2] = got[q + 3]; }
    edge = left;
  }
  return {has, rgb};
}

// ceProcess: готовые пиксели (ImageData) — цвет, маска и край
function ceProcess() {
  const w = ce.w, h = ce.h, n = w * h, C = ce.colData;
  const M = ce.mk.getContext('2d').getImageData(0, 0, w, h).data;
  const A = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i++) A[i] = M[i * 4 + 3] * C[i * 4 + 3] / 255;
  const A0 = A.slice();
  const sh = +$('ceShift').value, fe = +$('ceFeather').value, fr = +$('ceFringe').value / 100;
  if (sh) ceMinMax(A, w, h, Math.abs(sh), sh > 0);
  if (fe) { const F = Float32Array.from(A), r = Math.max(1, Math.round(fe / 2)); ceBlur(F, w, h, r); ceBlur(F, w, h, r); for (let i = 0; i < n; i++) A[i] = F[i]; }
  const out = new ImageData(w, h), d = out.data;
  for (let i = 0; i < n; i++) { d[i * 4] = C[i * 4]; d[i * 4 + 1] = C[i * 4 + 1]; d[i * 4 + 2] = C[i * 4 + 2]; d[i * 4 + 3] = A[i]; }
  // кайма и выросший край: цвет берём изнутри предмета (у выросшего своего цвета нет — там был фон)
  const grown = sh > 0 || fe > 0;
  if (fr > 0 || grown) {
    const {has, rgb} = ceInner(A, d, w, h, Math.max(4, Math.abs(sh) + fe + 2));
    for (let i = 0; i < n; i++) {
      if (!A[i] || A[i] >= 240 || !has[i]) continue;
      let k = fr * Math.min(1, 2 * (1 - A[i] / 255));
      if (!A0[i]) k = 1;
      if (!k) continue;
      for (let c = 0; c < 3; c++) d[i * 4 + c] += (rgb[i * 3 + c] - d[i * 4 + c]) * k;
    }
  }
  return out;
}

let ceFxTimer = 0;
function ceFxSoon(ms) {
  clearTimeout(ceFxTimer);
  if (!ceEdgeOn()) { ce.fx = null; ceRender(); return; }
  ceFxTimer = setTimeout(() => {
    if (!ce.on || ce.cur || !ce.mk) return;
    const c = ce.fx || ceCanvas(ce.w, ce.h);
    c.getContext('2d').putImageData(ceProcess(), 0, 0);
    ce.fx = c;
    ceRender();
  }, ms);
}

// ---- перо: контур Безье ----
// Точки [x, y, ix, iy, ox, oy] в точках картинки, как у пера Монтажа (shapes.js): точка, ручка входа, ручка выхода.
// Контур можно ставить и за краем картинки, чтобы захватить край целиком.
const CE_NEAR = 8;   // радиус захвата точки и ручки в точках экрана
function cePath(pts) {
  const P = new Path2D();
  P.moveTo(pts[0][0], pts[0][1]);
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; P.bezierCurveTo(a[4], a[5], b[2], b[3], b[0], b[1]); }
  P.closePath();
  return P;
}
// «Создать выделение» (кнопка, Enter или Ctrl+Enter, как в Фотошопе): контур становится выделением с муравьями.
// Режим — Shift/Alt при нажатии, иначе выбранный в строке параметров. Стереть выделенное — Delete, отдельным шагом.
// Контур помнится в шаге истории: Ctrl+Z возвращает его на место, чтобы поправить точки.
function cePenApply(e) {
  const pen = ce.pen;
  if (!ce.on || ce.busy || ce.drag || !pen || pen.pts.length < 2) return;
  const pts = pen.pts.map(p => p.slice()), soft = +$('ceSmooth').value;
  ce.pen = null;
  cePenDraw();
  const mode = ceModeOf(e && e.shiftKey, e && e.altKey, 'pen');
  ceSelCommit(ceSelMix(cePenSel(pts, soft), mode), {penPts: pts});
}
function cePenDrop() { ce.pen = null; cePenDraw(); ceState(); }
// шаг назад в контуре: замкнутый размыкается, у открытого уходит последняя точка
function cePenBack() {
  const pen = ce.pen; if (!pen) return;
  if (pen.closed) pen.closed = false; else pen.pts.pop();
  if (!pen.pts.length) ce.pen = null;
  cePenDraw(); ceState();
}
const ceSmooth = p => p[2] !== p[0] || p[3] !== p[1] || p[4] !== p[0] || p[5] !== p[1];
// что под мышью: {i, h} — точка i (h 0) или её ручка (h 2 — вход, 4 — выход); ручки только у плавных точек
function cePenHit(p) {
  const pen = ce.pen; if (!pen) return null;
  const R = CE_NEAR / ce.z;
  let best = null, bd = R;
  pen.pts.forEach((q, i) => {
    for (const h of ceSmooth(q) ? [0, 2, 4] : [0]) {
      const d = Math.hypot(q[h] - p[0], q[h + 1] - p[1]);
      if (d < bd || (d === bd && !h)) { bd = d; best = {i, h}; }
    }
  });
  return best;
}
const cePenCanClose = p => !!ce.pen && !ce.pen.closed && ce.pen.pts.length >= 2 && Math.hypot(ce.pen.pts[0][0] - p[0], ce.pen.pts[0][1] - p[1]) * ce.z <= CE_NEAR;
// тяга ручек новой точки: выход — куда тянут, вход — зеркально
function cePenPull(e, pt, done) {
  const p = [pt[0], pt[1]], x0 = e.clientX, y0 = e.clientY;
  ce.drag = {
    move(ev) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < KIN.drag) return;
      const q = cePt(ev);
      pt[4] = q[0]; pt[5] = q[1]; pt[2] = 2 * p[0] - q[0]; pt[3] = 2 * p[1] - q[1];
      cePenDraw();
    },
    end: ok => done(ok),
  };
}
// тяга точки (h 0) или ручки; у плавной точки вторая ручка поворачивается следом, brk (Alt) ломает её
function cePenMove(e, i, h, brk) {
  const pts = ce.pen.pts, start = pts.map(p => p.slice()), sp = start[i], p0 = cePt(e), x0 = e.clientX, y0 = e.clientY;
  const turn = Math.abs(Math.atan2(sp[3] - sp[1], sp[2] - sp[0]) - Math.atan2(sp[5] - sp[1], sp[4] - sp[0]));
  const smooth = h && !brk && Math.abs(turn - Math.PI) < .05;
  let on = false;
  ce.drag = {
    move(ev) {
      if (!on && Math.hypot(ev.clientX - x0, ev.clientY - y0) < KIN.drag) return;
      on = true;
      const q = cePt(ev), dx = q[0] - p0[0], dy = q[1] - p0[1], p = sp.slice();
      if (!h) for (let j = 0; j < 6; j += 2) { p[j] += dx; p[j + 1] += dy; }
      else {
        p[h] += dx; p[h + 1] += dy;
        if (smooth) {
          const o = h === 2 ? 4 : 2, len = Math.hypot(sp[o] - p[0], sp[o + 1] - p[1]), a = Math.atan2(p[h + 1] - p[1], p[h] - p[0]);
          p[o] = p[0] - Math.cos(a) * len; p[o + 1] = p[1] - Math.sin(a) * len;
        }
      }
      pts[i] = p;
      cePenDraw();
    },
    end() {
      // Alt+щелчок без тяги по точке замкнутого контура — убрать её
      if (!on && !h && brk && ce.pen.closed && pts.length > 3) { pts.splice(i, 1); cePenDraw(); ceState(); }
    },
  };
}
function cePenDown(e) {
  const p = cePt(e);
  if (!ce.pen) ce.pen = {pts: [], closed: false, hover: null, close: false};
  const pen = ce.pen, hit = cePenHit(p);
  if (hit && (pen.closed || e.altKey) && !(cePenCanClose(p) && !e.altKey)) { cePenMove(e, hit.i, hit.h, e.altKey); return; }
  if (pen.closed) return;   // мимо точек замкнутого контура — ничего: Enter применяет, Esc убирает
  if (cePenCanClose(p)) {   // первая точка: щелчок замыкает углом, тяга тянет её ручки
    const f = pen.pts[0], keep = f.slice();
    pen.close = true;
    cePenPull(e, f, ok => {
      pen.close = false;
      if (ok) pen.closed = true; else f.splice(0, 6, ...keep);
      ce.penCur = '';
      cePenDraw(); ceState();
    });
    cePenDraw();
    return;
  }
  const last = pen.pts[pen.pts.length - 1];
  if (last && Math.hypot(last[0] - p[0], last[1] - p[1]) * ce.z < 3) return;   // второй щелчок двойного — не новая точка
  const pt = [p[0], p[1], p[0], p[1], p[0], p[1]];
  pen.pts.push(pt);
  pen.hover = null;
  cePenPull(e, pt, () => {});
  cePenDraw(); ceState();
}
// двойной щелчок по точке замкнутого контура: угол ↔ плавная (ручки вдоль соседей, по трети расстояния до них)
function cePenToggle(e) {
  const pen = ce.pen;
  if (ce.tool !== 'pen' || !pen || !pen.closed) return;
  const hit = cePenHit(cePt(e));
  if (!hit || hit.h) return;
  const pts = pen.pts, n = pts.length, i = hit.i, p = pts[i];
  if (ceSmooth(p)) p.splice(2, 4, p[0], p[1], p[0], p[1]);
  else {
    const prev = pts[(i - 1 + n) % n], next = pts[(i + 1) % n];
    const dx = next[0] - prev[0], dy = next[1] - prev[1], len = Math.hypot(dx, dy) || 1;
    const li = Math.hypot(p[0] - prev[0], p[1] - prev[1]) / 3, lo = Math.hypot(next[0] - p[0], next[1] - p[1]) / 3;
    p.splice(2, 4, p[0] - dx / len * li, p[1] - dy / len * li, p[0] + dx / len * lo, p[1] + dy / len * lo);
  }
  cePenDraw();
}
// контур поверх картинки в точках экрана; у замкнутого подкрашено то, что изменится
function cePenDraw() {
  const sv = $('cePen'), pen = ce.pen;
  if (ce.on && ce.rc) {   // рамка прямоугольного выделения при протяжке
    const [x0, y0, x1, y1] = ceRectBox(ce.rc.a, ce.rc.b), X = x => +(ce.px + x * ce.z).toFixed(1), Y = y => +(ce.py + y * ce.z).toFixed(1);
    sv.innerHTML = mvDual('path', `d="M${X(x0)} ${Y(y0)}H${X(x1)}V${Y(y1)}H${X(x0)}Z"`);
    return;
  }
  if (!ce.on || ce.tool !== 'pen' || !pen || !pen.pts.length) { if (sv.innerHTML) sv.innerHTML = ''; return; }
  const pts = pen.pts, f = v => +v.toFixed(1), X = x => f(ce.px + x * ce.z), Y = y => f(ce.py + y * ce.z);
  const seg = (a, b) => `C${X(a[4])} ${Y(a[5])} ${X(b[2])} ${Y(b[3])} ${X(b[0])} ${Y(b[1])}`;
  let d = `M${X(pts[0][0])} ${Y(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) d += seg(pts[i], pts[i + 1]);
  let out = '';
  if (pen.closed) {
    d += seg(pts[pts.length - 1], pts[0]) + 'Z';
    out += `<path class="ce-pen-fill" d="${d}"/>`;
  } else if (pen.close) d += seg(pts[pts.length - 1], pts[0]);
  else if (pen.hover) { const h = pen.hover; d += seg(pts[pts.length - 1], [h[0], h[1], h[0], h[1]]); }
  out += mvDual('path', `d="${d}"`);
  pts.forEach(p => {
    if (!ceSmooth(p)) return;
    for (const h of [2, 4]) {
      const xy = `x1="${X(p[0])}" y1="${Y(p[1])}" x2="${X(p[h])}" y2="${Y(p[h + 1])}"`;
      out += `<line class="mv-draw-armu" ${xy}/><line class="mv-draw-arm" ${xy}/><circle class="mv-pt h" cx="${X(p[h])}" cy="${Y(p[h + 1])}" r="3.5"/>`;
    }
  });
  pts.forEach((p, i) => {
    const x = X(p[0]), y = Y(p[1]), first = i === 0 && !pen.closed ? ' first' : '';
    out += `<rect class="mv-pt-under" x="${x - 5.5}" y="${y - 5.5}" width="11" height="11"/><rect class="mv-pt${first}" x="${x - 4}" y="${y - 4}" width="8" height="8"/>`;
  });
  sv.innerHTML = out;
}

// ---- волшебная палочка ----
// Цвета сравниваются в OKLab: близость там ближе к тому, как видит глаз. Таблица на 64 уровня по каждому каналу
// (262 144 цвета, считается один раз), шаг 4 из 255 глазу не виден.
let ceLab = null;
function ceLabT() {
  if (ceLab) return ceLab;
  const lin = new Float32Array(64);
  for (let k = 0; k < 64; k++) { const v = Math.min(255, k * 4 + 2) / 255; lin[k] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
  const T = new Float32Array(64 * 64 * 64 * 3);
  let o = 0;
  for (let r = 0; r < 64; r++) for (let g = 0; g < 64; g++) for (let b = 0; b < 64; b++) {
    const R = lin[r], G = lin[g], B = lin[b];
    const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
    const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
    const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
    T[o++] = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
    T[o++] = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
    T[o++] = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  }
  return (ceLab = T);
}
// ceWandSel: выделение (0…255 на точку) от точки (x, y) по цвету C (RGBA). vis(i) — можно ли брать точку.
// tol — допуск в единицах OKLab; за допуском полоса band, где выделение сходит на нет (мягкий край без размытия).
// all — по всей картинке, иначе связная область (4 соседа) построчной заливкой: в стек идут только начала отрезков.
function ceWandSel(C, w, h, x, y, tol, all, vis, trans) {
  const n = w * h, lab = ceLabT(), i0 = y * w + x;
  const sel = new Uint8Array(n), seedVis = vis(i0);
  if (!seedVis && !trans) return sel;
  const k0 = ((C[i0 * 4] >> 2) << 12 | (C[i0 * 4 + 1] >> 2) << 6 | C[i0 * 4 + 2] >> 2) * 3;
  const L0 = lab[k0], A0 = lab[k0 + 1], B0 = lab[k0 + 2], band = Math.max(0.012, tol * 0.5), T2 = (tol + band) * (tol + band), tt = tol * tol;
  const val = seedVis ? i => {
    if (!vis(i)) return 0;
    const k = ((C[i * 4] >> 2) << 12 | (C[i * 4 + 1] >> 2) << 6 | C[i * 4 + 2] >> 2) * 3;
    const dl = lab[k] - L0, da = lab[k + 1] - A0, db = lab[k + 2] - B0, d2 = dl * dl + da * da + db * db;
    if (d2 <= tt) return 255;
    if (d2 >= T2) return 0;
    return 255 * (1 - (Math.sqrt(d2) - tol) / band) | 0;
  } : i => vis(i) ? 0 : 255;   // щелчок по прозрачному (trans) — выделить прозрачное
  if (all) { for (let i = 0; i < n; i++) sel[i] = val(i); return sel; }
  const st = new Uint8Array(n);   // 1 — точку уже смотрели
  const stack = [i0];
  const edge = (j, v) => { st[j] = 1; if (v > sel[j]) sel[j] = v; };
  while (stack.length) {
    const i = stack.pop();
    if (st[i]) continue;
    const row = i - i % w;
    let l = i, r = i;
    while (l > row && !st[l - 1]) { const v = val(l - 1); if (v === 255) l--; else { edge(l - 1, v); break; } }
    while (r < row + w - 1 && !st[r + 1]) { const v = val(r + 1); if (v === 255) r++; else { edge(r + 1, v); break; } }
    for (let j = l; j <= r; j++) { st[j] = 1; sel[j] = 255; }
    for (const nr of [row - w, row + w]) {
      if (nr < 0 || nr >= n) continue;
      let open = false;
      for (let j = l - row + nr, e = r - row + nr; j <= e; j++) {
        if (st[j]) { open = false; continue; }
        const v = val(j);
        if (v === 255) { if (!open) { stack.push(j); open = true; } }
        else { edge(j, v); open = false; }
      }
    }
  }
  return sel;
}
// выделение сжато отрезками [значение, длина, …]: у палочки это обычно крупные однородные куски
function ceRle(a) {
  const out = [];
  let v = a[0], k = 0;
  for (let i = 0; i < a.length; i++) { if (a[i] === v) k++; else { out.push(v, k); v = a[i]; k = 1; } }
  out.push(v, k);
  return Uint32Array.from(out);
}
// выделение в маску: белое с прозрачностью выделения, стирает (destination-out) или возвращает (source-over)
function ceSelPaint(g, s) {
  const w = ce.w, h = ce.h;
  if (!ce.tmp || ce.tmp.width !== w || ce.tmp.height !== h) {
    ce.tmp = ceCanvas(w, h);
    ce.tmpD = new ImageData(w, h);
    new Uint32Array(ce.tmpD.data.buffer).fill(0x00ffffff);
  }
  const d = ce.tmpD.data, R = s.sel;
  let i = 3;
  for (let q = 0; q < R.length; q += 2) { const v = R[q]; for (const e = i + R[q + 1] * 4; i < e; i += 4) d[i] = v; }
  ce.tmp.getContext('2d').putImageData(ce.tmpD, 0, 0);
  g.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over';
  g.drawImage(ce.tmp, 0, 0);
  g.globalCompositeOperation = 'source-over';
}
// щелчок палочкой: похожее среди видимого (по прозрачному — прозрачное) становится выделением, сложить по режиму
function ceWandPick(p, mode) {
  const x = Math.floor(p[0]), y = Math.floor(p[1]), w = ce.w, h = ce.h;
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const C = ce.colData, M = ce.mk.getContext('2d').getImageData(0, 0, w, h).data;
  const sel = ceWandSel(C, w, h, x, y, +$('ceTol').value / 100 * 0.4, ce.wandAll, i => M[i * 4 + 3] * C[i * 4 + 3] > 255 * 4, true);
  const empty = !ceSoften(sel);
  if (empty && (mode === 'add' || mode === 'sub')) return;
  ceSelCommit(ceSelMix(sel, mode));
}
// мягкий край «Мягкий край» (ceSmooth) по выделению; false — выделение пустое
function ceSoften(sel) {
  const w = ce.w, h = ce.h;
  // рамка выделения: мягкий край размывается только в ней с запасом
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let yy = 0; yy < h; yy++) {
    const o = yy * w;
    for (let xx = 0; xx < w; xx++) if (sel[o + xx]) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (yy < y0) y0 = yy; y1 = yy; }
  }
  if (x1 < 0) return false;
  const soft = +$('ceSmooth').value;
  if (soft) {
    const r = Math.max(1, Math.round(soft / 2)), m = 2 * r + 1;
    x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(w - 1, x1 + m); y1 = Math.min(h - 1, y1 + m);
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1, F = new Float32Array(cw * ch);
    for (let yy = 0; yy < ch; yy++) for (let xx = 0, o = (yy + y0) * w + x0; xx < cw; xx++) F[yy * cw + xx] = sel[o + xx];
    ceBlur(F, cw, ch, r); ceBlur(F, cw, ch, r);
    for (let yy = 0; yy < ch; yy++) for (let xx = 0, o = (yy + y0) * w + x0; xx < cw; xx++) sel[o + xx] = F[yy * cw + xx] + 0.5;
  }
  return true;
}

// ---- выделение, как в Фотошопе ----
// Массив 0…255 на точку (ce.selA) и сдвиг (ce.selX/Y): «Переместить» двигает только контур, пиксели не трогает,
// а уехавшее за край и вернувшееся не обрезается. Каждая смена — запись {selset: RLE, ox, oy} в общем списке мазков,
// поэтому Ctrl+Z отменяет и её. Перо и палочка дают новое выделение, режим (new/add/sub/inter) складывает его со старым.
// По краю бегут «муравьи»: контур по порогу 50 % собран в Path2D один раз, анимация — только смещение штриха.
function ceUnRle(R, n) {
  const a = new Uint8Array(n);
  for (let q = 0, i = 0; q < R.length; q += 2) { const e = i + R[q + 1]; if (R[q]) a.fill(R[q], i, e); i = e; }
  return a;
}
// выделение там, где оно сейчас лежит на картинке (со сдвигом)
function ceSelNow() {
  const a = ce.selA, dx = ce.selX, dy = ce.selY;
  if (!a || (!dx && !dy)) return a;
  const w = ce.w, h = ce.h, out = new Uint8Array(w * h), x0 = Math.max(0, dx), x1 = Math.min(w, w + dx);
  if (x1 > x0) for (let y = Math.max(0, dy), ye = Math.min(h, h + dy); y < ye; y++) {
    const o = (y - dy) * w - dx;
    out.set(a.subarray(o + x0, o + x1), y * w + x0);
  }
  return out;
}
// новое выделение n со старым: new — заменить, add — сложить, sub — вычесть, inter — оставить общее
function ceSelMix(n, mode) {
  const b = mode === 'new' ? null : ceSelNow();
  if (!b) return mode === 'new' || mode === 'add' ? n : null;
  for (let i = 0; i < n.length; i++) {
    const v = n[i], u = b[i];
    n[i] = mode === 'add' ? (u > v ? u : v) : mode === 'sub' ? u * (255 - v) / 255 + 0.5 : (u < v ? u : v);
  }
  return n;
}
// записать выделение в историю (a — без сдвига; пустое = снять). extra — что ещё помнит шаг (контур пера)
function ceSelCommit(a, extra) {
  if (a && !a.some(v => v)) a = null;
  if (!a && !ce.selA && !extra) return;
  const R = a ? ceRle(a) : null;
  ce.strokes.push(Object.assign({selset: R, ox: 0, oy: 0}, extra));
  ce.redo = [];
  Object.assign(ce, {selA: a, selR: R, selX: 0, selY: 0});
  ceAntsBuild(); ceState();
}
// сдвиг контура; стрелки подряд (nudge) сливаются в один шаг отмены
function ceSelShift(ox, oy, nudge) {
  if (!ce.selA || (ox === ce.selX && oy === ce.selY)) return;
  const last = ce.strokes[ce.strokes.length - 1], now = Date.now();
  if (nudge && last && last.selset === ce.selR && last.nudge && now - last.nudge < 1000) Object.assign(last, {ox, oy, nudge: now});
  else { ce.strokes.push({selset: ce.selR, ox, oy, nudge: nudge ? now : 0}); ce.redo = []; }
  ce.selX = ox; ce.selY = oy;
  ceAntsDraw(); ceState();
}
// выделение по истории: последняя запись {selset}
function ceSelSync() {
  let s = null;
  for (let i = ce.strokes.length - 1; i >= 0 && !s; i--) if ('selset' in ce.strokes[i]) s = ce.strokes[i];
  const R = s ? s.selset : null;
  ce.selX = s ? s.ox : 0; ce.selY = s ? s.oy : 0;
  if (R !== ce.selR) { ce.selR = R; ce.selA = R ? ceUnRle(R, ce.w * ce.h) : null; ceAntsBuild(); } else ceAntsDraw();
}
function ceSelInvert() {
  if (!ce.on || ce.busy || !ce.w) return;
  const b = ceSelNow(), a = new Uint8Array(ce.w * ce.h);
  if (b) for (let i = 0; i < a.length; i++) a[i] = 255 - b[i]; else a.fill(255);
  ceSelCommit(a);
}
function ceSelAll() { if (ce.on && !ce.busy && ce.w) ceSelCommit(new Uint8Array(ce.w * ce.h).fill(255)); }
function ceSelNone() { if (ce.on && !ce.busy) ceSelCommit(null); }
// стереть (Delete) или вернуть выделенное: ложится мазком {sel, erase}, как у палочки; мягкость — уже в выделении
function ceSelApply(erase) {
  const a = ceSelNow();
  if (!a || !ce.on || ce.busy) return;
  const s = {sel: ceRle(a), erase};
  ce.strokes.push(s);
  ce.redo = [];
  ceSelPaint(ce.mk.getContext('2d'), s);
  ceRender(); ceFxSoon(0); ceState();
}
// контур пера в выделение: заливка с размытием на «Мягкий край»
function cePenSel(pts, soft) {
  const w = ce.w, h = ce.h, g = ceCanvas(w, h).getContext('2d');
  g.filter = soft ? `blur(${soft / 2}px)` : 'none';
  g.fillStyle = '#fff';
  g.fill(cePath(pts));
  const d = g.getImageData(0, 0, w, h).data, a = new Uint8Array(w * h);
  for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
  return a;
}
// режим по клавишам (Shift — добавить, Alt — вычесть, оба — пересечь), без них — выбранный у инструмента
function ceModeOf(shift, alt, tool) {
  return shift && alt ? 'inter' : shift ? 'add' : alt ? 'sub' : ce.selMode[tool || ce.tool] || 'new';
}
// ---- курсоры, как в Фотошопе ----
// Курсор = значок инструмента (белый с тёмной обводкой), горячая точка на его кончике. Режим выделения — маленький знак
// справа снизу от значка (+ добавить, − вычесть, × пересечь) по зажатым Shift/Alt или выбранному режиму.
const CE_SELTOOLS = ['rect', 'wand', 'pen'];   // инструменты выделения: у каждого свой режим в строке параметров
const CE_SIGN = {add: 'M22.5 26h7M26 22.5v7', sub: 'M22.5 26h7', inter: 'M23.3 23.3l5.4 5.4M28.7 23.3l-5.4 5.4'};
const CE_CUR_PATHS = {
  wand: {p: 'M10 10l10.5 10.5M16.5 3v3M15 4.5h3M4.5 15v3M3 16.5h3', star: 'M7 2.6l1.3 3.1 3.1 1.3-3.1 1.3L7 11.4 5.7 8.3 2.6 7l3.1-1.3z', hx: 7, hy: 7},
  pen: {p: 'M3 3l4.6 13.4 5.4 1.8 5.2-5.2-1.8-5.4zM3 3l6.3 6.3M13 18.2l2.6 2.6 5.2-5.2-2.6-2.6', c: [10.6, 10.6, 1.7], hx: 3, hy: 3},
  rect: {p: 'M16 6v7M16 19v7M6 16h7M19 16h7', hx: 16, hy: 16},
  move: {p: 'M12 2v20M2 12h20M9 5l3-3 3 3M9 19l3 3 3-3M5 9l-3 3 3 3M19 9l3 3-3 3', hx: 12, hy: 12},
  zoom: {p: 'M15.2 15.2l6.3 6.3', c: [10, 10, 6.8], hx: 10, hy: 10},
};
const ceCurCache = {};
function ceCurOf(kind, extra, sign) {
  const key = kind + extra + sign;
  if (ceCurCache[key]) return ceCurCache[key];
  const k = CE_CUR_PATHS[kind];
  let p = k.p;
  if (k.c) p += `M${k.c[0] - k.c[2]} ${k.c[1]}a${k.c[2]} ${k.c[2]} 0 1 0 ${2 * k.c[2]} 0a${k.c[2]} ${k.c[2]} 0 1 0 ${-2 * k.c[2]} 0`;
  if (kind === 'zoom') p += extra === 'out' ? 'M7 10h6' : 'M7 10h6M10 7v6';
  if (sign) p += CE_SIGN[sign];
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32" fill="none" stroke-linecap="round" stroke-linejoin="round">` +
    `<path stroke="#000" stroke-width="3.6" d="${p}"/><path stroke="#fff" stroke-width="1.6" d="${p}"/>`;
  if (k.star) s += `<path fill="#e9b872" stroke="#000" stroke-width="1.1" d="${k.star}"/>`;
  if (extra === 'close') s += `<circle cx="23" cy="7" r="2.6" stroke="#000" stroke-width="3.4"/><circle cx="23" cy="7" r="2.6" stroke="#e9b872" stroke-width="1.6"/>`;
  s += '</svg>';
  return (ceCurCache[key] = `url("data:image/svg+xml,${encodeURIComponent(s)}") ${k.hx} ${k.hy}, crosshair`);
}
// курсор над картинкой по инструменту и клавишам; кисти рисуют свой кружок (ceCursor), системный курсор у них спрятан
function ceCurSet() {
  const st = $('ceStage'), tool = ce.tool;
  let c = 'default';
  if (ce.pan) c = 'grabbing';
  else if (tool === 'hand' || ce.space) c = 'grab';
  else if (tool === 'erase' || tool === 'restore') c = 'none';
  else if (tool === 'move') c = ceCurOf('move', '', '');
  else if (tool === 'zoom') c = ceCurOf('zoom', ce.mods.alt ? 'out' : 'in', '');
  else if (tool === 'pen') { const pc = ce.pen ? ce.penCur : ''; c = pc === 'pt' ? 'move' : ceCurOf('pen', pc === 'close' ? 'close' : '', ''); }
  else if (tool === 'wand' || tool === 'rect') {
    const m = ce.rc ? ce.rc.mode : ceModeOf(ce.mods.shift, ce.mods.alt);
    c = ceCurOf(tool, '', m === 'new' ? '' : m);
  }
  if (ce.curNow !== c) { ce.curNow = c; st.style.cursor = c; }
}

// ---- прямоугольное выделение (M) ----
// рамка от a до b в точках картинки, обрезанная краем картинки
function ceRectBox(a, b) {
  const cl = (v, m) => Math.max(0, Math.min(m, Math.round(v)));
  return [cl(Math.min(a[0], b[0]), ce.w), cl(Math.min(a[1], b[1]), ce.h), cl(Math.max(a[0], b[0]), ce.w), cl(Math.max(a[1], b[1]), ce.h)];
}
// конец протяжки: рамка — в выделение по режиму; щелчок без протяжки в режиме «Новое» снимает выделение, как в Фотошопе
function ceRectEnd(ok) {
  const rc = ce.rc; ce.rc = null;
  cePenDraw();
  if (!ok || !rc) { ceCurSet(); return; }
  const [x0, y0, x1, y1] = ceRectBox(rc.a, rc.b);
  const tiny = Math.abs(rc.b[0] - rc.a[0]) * ce.z < 3 && Math.abs(rc.b[1] - rc.a[1]) * ce.z < 3;
  if (tiny || x1 <= x0 || y1 <= y0) { if (rc.mode === 'new') ceSelNone(); ceCurSet(); return; }
  const a = new Uint8Array(ce.w * ce.h);
  for (let y = y0; y < y1; y++) a.fill(255, y * ce.w + x0, y * ce.w + x1);
  ceSoften(a);
  ceSelCommit(ceSelMix(a, rc.mode));
  ceCurSet();
}

// муравьи: границы между точками внутри и снаружи (порог 128), соседние отрезки склеены в длинные линии
function ceAntsBuild() {
  const a = ce.selA, w = ce.w, h = ce.h;
  ce.ants = null; ce.antsN = 0;
  if (a) {
    const P = new Path2D();
    let k = 0;
    for (let y = 0; y <= h; y++) {
      const o = y * w, u = o - w;
      let run = -1;
      for (let x = 0; x <= w; x++) {
        const e = x < w && ((y < h && a[o + x] >= 128) !== (y > 0 && a[u + x] >= 128));
        if (e) { if (run < 0) run = x; } else if (run >= 0) { P.moveTo(run, y); P.lineTo(x, y); run = -1; k++; }
      }
    }
    for (let x = 0; x <= w; x++) {
      let run = -1;
      for (let y = 0; y <= h; y++) {
        const o = y * w;
        const e = y < h && ((x < w && a[o + x] >= 128) !== (x > 0 && a[o + x - 1] >= 128));
        if (e) { if (run < 0) run = y; } else if (run >= 0) { P.moveTo(x, run); P.lineTo(x, y); run = -1; k++; }
      }
    }
    if (k) { ce.ants = P; ce.antsN = k; }
  }
  ceAntsDraw(); ceAntsTick();
}
let ceAntsPh = 0, ceAntsT = 0, ceAntsSkip = 0;
function ceAntsDraw() {
  const c = $('ceAnts'), st = $('ceStage'), dpr = window.devicePixelRatio || 1;
  const W = Math.round(st.clientWidth * dpr), H = Math.round(st.clientHeight * dpr);
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  const g = c.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, W, H);
  if (!ce.on || !ce.ants) return;
  const z = ce.z * dpr, k = dpr / z;   // k — одна точка экрана в точках картинки
  g.setTransform(z, 0, 0, z, (ce.px + ce.selX * ce.z) * dpr, (ce.py + ce.selY * ce.z) * dpr);
  g.lineWidth = k;
  g.setLineDash([]);
  g.strokeStyle = '#000';
  g.stroke(ce.ants);
  g.setLineDash([4 * k, 4 * k]);
  g.lineDashOffset = -ceAntsPh * k;
  g.strokeStyle = '#fff';
  g.stroke(ce.ants);
}
// бегут ~8 раз в секунду, только пока выделение есть и окно видно; очень длинный контур — реже; без анимации по желанию системы
function ceAntsTick() {
  const want = ce.on && !!ce.ants && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (want && !ceAntsT) ceAntsT = setInterval(() => {
    if (document.hidden || (ce.antsN > 40000 && ceAntsSkip++ % 3)) return;
    ceAntsPh = (ceAntsPh + 1) % 8;
    ceAntsDraw();
  }, 120);
  else if (!want && ceAntsT) { clearInterval(ceAntsT); ceAntsT = 0; }
}

// режим выделения инструмента: четыре кнопки в строке параметров (как в Фотошопе), помнится между запусками
function ceSelModeSet(tool, m) {
  ce.selMode[tool] = m;
  try { localStorage.setItem('k9000.ceSelMode', JSON.stringify(ce.selMode)); } catch (er) {}
  ceState();
}

// ---- мышь ----
function cePt(e) {
  const r = ce.cv.getBoundingClientRect();
  return [(e.clientX - r.left) * ce.w / r.width, (e.clientY - r.top) * ce.h / r.height];
}
function ceCursor(e) {
  const c = $('ceCur'), s = $('ceStage').getBoundingClientRect();
  if (!ce.cv || !['erase', 'restore'].includes(ce.tool) || ce.space || ce.pan) { c.classList.add('hide'); return; }
  const d = Math.max(4, 2 * +$('ceSize').value * ce.z);
  Object.assign(c.style, {width: d + 'px', height: d + 'px', transform: `translate(${e.clientX - s.left - d / 2}px, ${e.clientY - s.top - d / 2}px)`});
  c.classList.toggle('erase', ce.tool === 'erase');
  c.classList.remove('hide');
}

{
  const st = $('ceStage');
  st.addEventListener('pointerdown', e => {
    if (!ce.on || ce.busy || !ce.cv) return;
    e.preventDefault();
    st.setPointerCapture(e.pointerId);
    if (e.button === 1 || ce.tool === 'hand' || ce.space) { ce.pan = {x: e.clientX - ce.px, y: e.clientY - ce.py}; ceState(); ceCursor(e); return; }
    if (e.button !== 0 && e.button !== 2) return;
    if (ce.tool === 'pen') { if (e.button === 0) cePenDown(e); return; }
    // палочка и рамка: Shift — добавить, Alt — вычесть, оба — пересечь, правая кнопка — вычесть
    const mode = e.button === 2 ? 'sub' : ceModeOf(e.shiftKey, e.altKey);
    if (ce.tool === 'wand') { ceWandPick(cePt(e), mode); return; }
    if (ce.tool === 'rect') { const p = cePt(e); ce.rc = {a: p, b: p, mode}; ceCurSet(); return; }
    if (ce.tool === 'zoom') {   // щелчок — крупнее вдвое, Alt+щелчок или правая кнопка — мельче
      const r = st.getBoundingClientRect();
      ceZoomAt(ce.z * (e.altKey || e.button === 2 ? 0.5 : 2), e.clientX - r.left, e.clientY - r.top);
      return;
    }
    if (ce.tool === 'move') {   // тянуть контур выделения; пиксели не двигаются
      if (e.button === 0 && ce.selA) ce.mv = {p: cePt(e), ox: ce.selX, oy: ce.selY};
      return;
    }
    const p = cePt(e);
    // правая кнопка — другая кисть: у ластика «Вернуть», у «Вернуть» ластик
    const erase = (ce.tool === 'erase') !== (e.button === 2);
    ce.cur = {erase, r: Math.max(0.5, +$('ceSize').value), soft: +$('ceSoft').value / 100, pts: [p]};
    ce.strokes.push(ce.cur);
    ce.redo = [];
    ceSeg(ce.mk.getContext('2d'), ce.cur, p, p);
    ceRender();
  });
  st.addEventListener('pointermove', e => {
    if (!ce.on) return;
    const sr = st.getBoundingClientRect();
    Object.assign(ce, {mx: e.clientX - sr.left, my: e.clientY - sr.top, over: true, mods: {shift: e.shiftKey, alt: e.altKey}});
    ceCurSet();
    if (ce.rc) { ce.rc.b = cePt(e); cePenDraw(); return; }
    if (ce.mv) {
      const q = cePt(e);
      ce.selX = ce.mv.ox + Math.round(q[0] - ce.mv.p[0]); ce.selY = ce.mv.oy + Math.round(q[1] - ce.mv.p[1]);
      ceAntsDraw();
      return;
    }
    if (ce.pan) { ce.px = e.clientX - ce.pan.x; ce.py = e.clientY - ce.pan.y; ce.auto = false; ceApplyView(); return; }
    ceCursor(e);
    if (ce.drag) { ce.drag.move(e); return; }
    if (ce.tool === 'pen' && ce.pen && !e.buttons) {   // кусок контура за мышью, у первой точки — колечко замыкания
      const p = cePt(e), pen = ce.pen;
      pen.close = cePenCanClose(p);
      pen.hover = pen.closed ? null : p;
      ce.penCur = pen.close ? 'close' : (pen.closed || e.altKey) && cePenHit(p) ? 'pt' : '';
      ceCurSet();
      cePenDraw();
      return;
    }
    if (!ce.cur) return;
    const p = cePt(e), pts = ce.cur.pts;
    ceSeg(ce.mk.getContext('2d'), ce.cur, pts[pts.length - 1], p);
    pts.push(p);
    ceRender();
  });
  const end = e => {
    if (ce.pan) { ce.pan = null; ceState(); }
    if (ce.rc) ceRectEnd(e.type !== 'pointercancel');
    if (ce.drag) { const d = ce.drag; ce.drag = null; d.end(e.type !== 'pointercancel'); cePenDraw(); ceState(); }
    if (ce.cur) { ce.cur = null; ceState(); ceRender(); ceFxSoon(0); }
    if (ce.mv) {
      const m = ce.mv, x = ce.selX, y = ce.selY;
      ce.mv = null; ce.selX = m.ox; ce.selY = m.oy;
      if (e.type === 'pointercancel') ceAntsDraw(); else ceSelShift(x, y);
    }
  };
  st.addEventListener('pointerup', end);
  st.addEventListener('pointercancel', end);
  st.addEventListener('pointerleave', () => {
    $('ceCur').classList.add('hide');
    ce.over = false;
    if (ce.pen && ce.pen.hover && !ce.drag) { ce.pen.hover = null; cePenDraw(); }
  });
  st.addEventListener('dblclick', cePenToggle);
  st.addEventListener('contextmenu', e => e.preventDefault());
  st.addEventListener('auxclick', e => e.preventDefault());
  st.addEventListener('wheel', e => {
    if (!ce.on || !ce.cv) return;
    e.preventDefault();
    const r = st.getBoundingClientRect();
    ceZoomAt(ce.z * Math.pow(1.0015, -e.deltaY), e.clientX - r.left, e.clientY - r.top);
    ceCursor(e);
  }, {passive: false});
  new ResizeObserver(() => { if (ce.on && ce.w) ce.auto ? ceFit() : ceApplyView(); }).observe(st);
}

// ---- сохранить ----
async function ceSave() {
  if (!ce.on || ce.busy) return;
  ce.busy = true; ceState();
  const b = $('ceSave'); b.classList.add('busy');
  try {
    const c = ceCanvas(ce.w, ce.h);
    c.getContext('2d').putImageData(ceProcess(), 0, 0);
    const data = c.toDataURL('image/png');
    const r = await api('cut-save', {path: ce.path, data});
    if (r.error) { toast({type: 'warn', title: t('ce.saveFail'), text: esc(r.error), ttl: 8000}); return; }
    const done = ce.done;
    ce.busy = false;
    await ceClose(true);
    toast({type: 'ok', title: t(r.gallery ? 'ce.savedGal' : 'ce.saved'), text: esc(base(r.path)), ttl: 4000,
      actions: [{t: t('bgc.show'), fn: () => api('gen-reveal', {path: r.path})}]});
    if (done) done(r.path);
  } finally {
    ce.busy = false; b.classList.remove('busy'); if (ce.on) ceState();
  }
}

// ---- кнопки ----
$('ceMode').addEventListener('click', e => {
  const b = e.target.closest('button[data-v]'); if (b) ceTool(b.dataset.v);
});
$('ceModes').addEventListener('click', e => {
  const b = e.target.closest('[data-m]'); if (b && CE_SELTOOLS.includes(ce.tool)) ceSelModeSet(ce.tool, b.dataset.m);
});
$('ceBgs').addEventListener('click', e => {
  const b = e.target.closest('[data-bg]'); if (!b) return;
  ce.bg = b.dataset.bg; ceState();
  try { localStorage.setItem('k9000.ceBg', ce.bg); } catch (er) {}
});
$('ceColor').addEventListener('input', () => {
  $('ceStage').style.setProperty('--ce-col', $('ceColor').value);
  $('ceSwColor').style.background = $('ceColor').value;
  ce.bg = 'color'; ceState();
  try { localStorage.setItem('k9000.ceBg', 'color'); localStorage.setItem('k9000.ceCol', $('ceColor').value); } catch (er) {}
});
try {
  const col = localStorage.getItem('k9000.ceCol'), bg = localStorage.getItem('k9000.ceBg');
  if (col) $('ceColor').value = col;
  if (['chk', 'white', 'dark', 'color'].includes(bg)) ce.bg = bg;
} catch (er) {}
$('ceStage').style.setProperty('--ce-col', $('ceColor').value);
$('ceSwColor').style.background = $('ceColor').value;
for (const id of ['ceSize', 'ceSoft', 'ceTol', 'ceSmooth']) $(id).addEventListener('input', ceVals);
for (const id of ['ceTol', 'ceSmooth']) $(id).addEventListener('change', () => { try { localStorage.setItem('k9000.' + id, $(id).value); } catch (er) {} });
$('ceNear').addEventListener('change', () => {
  ce.wandAll = !$('ceNear').checked;
  try { localStorage.setItem('k9000.ceWandAll', ce.wandAll ? '1' : ''); } catch (er) {}
});
try {
  for (const id of ['ceTol', 'ceSmooth']) { const v = localStorage.getItem('k9000.' + id); if (v !== null) $(id).value = v; }
  const sm = JSON.parse(localStorage.getItem('k9000.ceSelMode') || '{}');
  for (const k of CE_SELTOOLS) if (['new', 'add', 'sub', 'inter'].includes(sm[k])) ce.selMode[k] = sm[k];
  ce.wandAll = localStorage.getItem('k9000.ceWandAll') === '1';
} catch (er) {}
$('cePenApply').addEventListener('click', cePenApply);
$('ceSelInv').addEventListener('click', ceSelInvert);
$('ceSelDel').addEventListener('click', () => ceSelApply(true));
$('ceSelFill').addEventListener('click', () => ceSelApply(false));
$('ceSelNone').addEventListener('click', ceSelNone);
window.addEventListener('blur', () => { ce.mods = {shift: false, alt: false}; if (ce.on) ceCurSet(); });
$('cePenDrop').addEventListener('click', cePenDrop);
for (const id of ['ceFeather', 'ceShift', 'ceFringe']) $(id).addEventListener('input', () => { ceVals(); ceFxSoon(90); });
$('ceUndo').addEventListener('click', ceUndo);
$('ceRedo').addEventListener('click', ceRedo);
$('ceReset').addEventListener('click', ceReset);
$('ceFit').addEventListener('click', ceFit);
$('ceZFit').addEventListener('click', ceFit);
$('ceZ100').addEventListener('click', () => ceZoomBy(0));
$('ceSave').addEventListener('click', ceSave);
$('ceCancel').addEventListener('click', () => ceClose(false));
$('ceClose').addEventListener('click', () => ceClose(false));
$('ceSrcPick').addEventListener('click', () => dialog(async () => {
  const r = await api('pick-files'); if (r.error) { alert(r.error); return; }
  const f = (r.files || []).find(f => BG_EXT.test(f.path));
  if (!f || !ce.on) return;
  ce.busy = true; ceState();
  try { await ceSetSrc(f.path); ceRender(); ceFxSoon(0); } finally { ce.busy = false; ceState(); }
  if (!ce.src) toast({type: 'warn', title: t('ce.srcBad'), ttl: 5000});
}));
// масштаб от середины: k — во сколько раз, 0 — 100 %
function ceZoomBy(k) { const st = $('ceStage'); ceZoomAt(k ? ce.z * k : 1, st.clientWidth / 2, st.clientHeight / 2); }

// Клавиши как в Фотошопе: V, M, W, P, E, Y (и B), H, Z — инструменты; пробел — рука; Enter или Ctrl+Enter — контур в выделение;
// Ctrl+D, Ctrl+Shift+I, Ctrl+A, Delete; Ctrl+Z, Ctrl+Shift+Z/Ctrl+Y; Ctrl+= / Ctrl+− / Ctrl+0 / Ctrl+1 — масштаб.
// Слушаем на window раньше всех, чтобы клавиши не доставались окнам и вкладкам под редактором. Пока открыт вопрос (askBox), клавиши его.
// окно «Клавиши»: все сочетания по темам, сам список показывает общее окно хоткеев (khShow в tracks.js)
const CE_HELP = [
  ['ce.kg.tools', [[['V'], 'ce.k.move'], [['M'], 'ce.k.rect'], [['W'], 'ce.k.wand'], [['P'], 'ce.k.pen'], [['E'], 'ce.k.erase'], [['Y', 'B'], 'ce.k.restore'], [['H'], 'ce.k.hand'], [['Z'], 'ce.k.zoom'], [['[', ']'], 'ce.k.brush']]],
  ['ce.kg.sel', [[['Shift'], 'ce.k.add'], [['Alt', 'ce.k.rclick'], 'ce.k.sub'], [['Shift+Alt'], 'ce.k.inter'], [['Ctrl+Shift+I'], 'ce.k.inv'], [['Delete'], 'ce.k.del'], [['Ctrl+D'], 'ce.k.none'], [['Ctrl+A'], 'ce.k.all'], [['←', '↑', '→', '↓'], 'ce.k.arrows'], [['Shift+←', 'Shift+↑', 'Shift+→', 'Shift+↓'], 'ce.k.arrows10']]],
  ['ce.kg.pen', [[['ce.k.click'], 'ce.k.pPoint'], [['ce.k.drag'], 'ce.k.pCurve'], [['ce.k.first'], 'ce.k.pClose'], [['ce.k.dragPt'], 'ce.k.pEdit'], [['ce.k.altHandle'], 'ce.k.pBreak'], [['ce.k.dbl'], 'ce.k.pCorner'], [['ce.k.altClick'], 'ce.k.pRemove'], [['Backspace'], 'ce.k.pBack'], [['Enter', 'Ctrl+Enter'], 'ce.k.pMake'], [['Shift+Enter'], 'ce.k.pAdd'], [['Alt+Enter'], 'ce.k.pSub'], [['Esc'], 'ce.k.pDrop']]],
  ['ce.kg.view', [[['kh.space'], 'ce.k.vHand'], [['ce.k.wheel'], 'ce.k.vWheel'], [['Ctrl+0'], 'ce.k.vFit'], [['Ctrl+1'], 'ce.k.v100'], [['Ctrl+=', 'Ctrl+−'], 'ce.k.vZoom'], [['ce.k.click', 'Alt'], 'ce.k.vZoomTool']]],
  ['ce.kg.file', [[['Ctrl+Z'], 'ce.k.undo'], [['Ctrl+Shift+Z', 'Ctrl+Y'], 'ce.k.redo'], [['Ctrl+S'], 'ce.k.save'], [['Esc'], 'ce.k.close']]],
];
$('ceKeys').addEventListener('click', () => khShow('ce.keysT', CE_HELP, true));
const CE_KEYS = {KeyV: 'move', KeyM: 'rect', KeyW: 'wand', KeyP: 'pen', KeyE: 'erase', KeyY: 'restore', KeyB: 'restore', KeyH: 'hand', KeyZ: 'zoom'};
window.addEventListener('keydown', e => {
  if (!ce.on || askDone) return;
  if (e.key === 'Escape' && !$('keysHelp').classList.contains('hide')) return;   // Esc закрывает окно клавиш (tracks.js), а не редактор
  const typing = e.target.closest && e.target.closest('input[type=text], textarea, select');
  const c = e.code, mod = e.ctrlKey || e.metaKey;
  const penLive = ce.tool === 'pen' && ce.pen && ce.pen.pts.length;
  if (e.key === 'Shift' || e.key === 'Alt') {   // знак режима у курсора; Alt не отдаём меню окна
    ce.mods[e.key === 'Shift' ? 'shift' : 'alt'] = true;
    ceCurSet();
    if (e.key === 'Alt') e.preventDefault();
    return;
  }
  if (e.key === 'Escape') { if (ce.rc) ceRectEnd(false); else if (!ce.drag) penLive ? cePenDrop() : ceClose(false); }
  else if (typing) { e.stopPropagation(); return; }
  else if (penLive && (c === 'Enter' || c === 'NumpadEnter')) cePenApply(e);
  else if (penLive && !ce.pen.closed && (c === 'Backspace' || c === 'Delete') && !ce.drag) cePenBack();
  else if (c === 'Enter' || c === 'NumpadEnter') return;   // Enter на кнопке нажимает её
  // стрелки двигают контур выделения (Shift — на 10), а на ползунке — ползунок; окну просмотра под нами — ничего
  else if (c.startsWith('Arrow') && ce.selA && !mod && !(e.target.closest && e.target.closest('input'))) {
    if (!ce.mv) {
      const k = e.shiftKey ? 10 : 1, dx = c === 'ArrowLeft' ? -k : c === 'ArrowRight' ? k : 0, dy = c === 'ArrowUp' ? -k : c === 'ArrowDown' ? k : 0;
      ceSelShift(ce.selX + dx, ce.selY + dy, true);
    }
  }
  else if (c.startsWith('Arrow')) { e.stopPropagation(); return; }
  else if (mod && e.shiftKey && c === 'KeyI') ceSelInvert();
  else if (mod && c === 'KeyD') ceSelNone();
  else if (mod && c === 'KeyA') ceSelAll();
  else if ((c === 'Delete' || c === 'Backspace') && !mod && ce.selA) { if (!ce.cur && !ce.mv && !ce.rc) ceSelApply(true); }
  else if (mod && c === 'KeyZ') e.shiftKey ? ceRedo() : ceUndo();
  else if (mod && c === 'KeyY') ceRedo();
  else if (mod && c === 'KeyS') ceSave();
  else if (mod && (c === 'Digit0' || c === 'Numpad0')) ceFit();
  else if (mod && (c === 'Digit1' || c === 'Numpad1')) ceZoomBy(0);
  else if (mod && (c === 'Equal' || c === 'NumpadAdd')) ceZoomBy(2);
  else if (mod && (c === 'Minus' || c === 'NumpadSubtract')) ceZoomBy(0.5);
  else if (mod || e.altKey) return;
  else if (c === 'Space') { if (!ce.space) { ce.space = true; ceState(); $('ceCur').classList.add('hide'); } }
  else if (CE_KEYS[c]) ceTool(CE_KEYS[c]);
  else if (c === 'BracketLeft') ceSize(1 / 1.15);
  else if (c === 'BracketRight') ceSize(1.15);
  else if (c === 'Digit0') ceFit();
  else if (c === 'Digit1') ceZoomBy(0);
  else if (['Delete', 'KeyF'].includes(c)) {}
  else return;
  e.preventDefault(); e.stopPropagation();
}, true);
window.addEventListener('keyup', e => {
  if (!ce.on) return;
  if (e.code === 'Space') { ce.space = false; ceState(); e.preventDefault(); e.stopPropagation(); }
  if (e.key === 'Shift' || e.key === 'Alt') { ce.mods[e.key === 'Shift' ? 'shift' : 'alt'] = false; ceCurSet(); e.preventDefault(); }
}, true);

// ---- входы ----
// галерея генератора: правленая ложится новой записью и открывается в окне просмотра, сравнение с прежней
function ggFix() {
  const x = ggCur(); if (!x || !x.meta.cutout) return;
  ceOpen({path: x.path, done: async p => {
    await ggStripLoad();
    if (gg.open) await ggLoad(true);
    if (gg.lb) { await ggLbPath(p); if (ggCur()?.path === p) gcmpOpen(x.path); }
  }});
}
$('gnLbFix').addEventListener('click', ggFix);
// картинка для редактора: PNG, JPG или WebP — с прозрачностью (вырезка) или обычная (фон сотрётся инструментами)
const CE_EXT = /\.(png|jpe?g|webp)$/i;
// брошенная в открытый редактор картинка (drop.js): открыть вместо текущей (несохранённое — с вопросом, как при закрытии)
async function ceDropPaths(list) {
  const f = (list || []).find(f => CE_EXT.test(f.path));
  if (!f) { say('warn', t('drop.notSuitableTitle'), t('ce.onlyPng')); return; }
  if (ce.on) {
    if (ce.busy || f.path === ce.path) return;
    await ceClose();
    if (ce.on) return;
  }
  ceOpen({path: f.path});
}
