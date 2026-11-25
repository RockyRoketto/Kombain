// «Поправить вырезку»: ручная доработка картинки после «Убрать фон». Одно окно на два входа:
// «Утилиты» → «Убрать фон» (кнопка у готового файла, «Поправить PNG…») и окно просмотра галереи генератора.
// Картинка = цвет × маска. Цвет (ce.col): пиксели вырезки, а там, где нейросеть стёрла всё, — пиксели оригинала.
// Маска (ce.mk): белое с прозрачностью; ластик стирает её (destination-out), «Вернуть» докрашивает (source-over).
// Без оригинала цвет — сама вырезка с её прозрачностью, маска — белая целиком: «Вернуть» возвращает только то, что было.
// Мазки хранятся списком, отмена перерисовывает маску с начала (как в geninpaint.js).
// Край (сжать/расширить, растушёвка, кайма) считается по пикселям после мазка и при движении ползунков: ceFx.
// Перо (контур Безье, точки как у пера Монтажа в shapes.js) и волшебная палочка тоже ложатся в маску и в список мазков,
// поэтому отмена у всех общая. Палочка хранит выделение сжатым по строкам (RLE), а не параметры: повтор не зависит от порядка.
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
  strokes: [],      // {erase, r, soft, pts: [[x, y], …]}, {reset: true}, {pen: точки, op, soft} или {sel: RLE, erase}
  redo: [],
  cur: null,
  tool: 'erase',    // erase | restore | pen | wand | hand
  pen: null,        // контур пера: {pts: [[x, y, ix, iy, ox, oy], …], closed, hover, close}
  penOp: 'keep',    // keep — оставить внутри, cut — стереть внутри, add — вернуть внутри
  wandAll: false,   // палочка по всей картинке, а не связной областью
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
  Object.assign(ce, {on: true, busy: true, path: o.path, done: o.done || null, strokes: [], redo: [], cur: null, fx: null, pan: null, pen: null, drag: null});
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
    let src = o.src;
    if (src === undefined) { const r = await api('cut-src', {path: o.path}); src = r.src || ''; }
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
  $('ceSrc').textContent = ce.src ? base(ce.src) : t(ce.srcBad ? 'ce.srcBad' : 'ce.srcNone');
  $('ceSrc').title = ce.src || '';
  $('ceSrc').classList.toggle('warn', !ce.src);
}

function ceDirty() {
  return ce.strokes.length > 0 || (ce.pen && ce.pen.pts.length > 1) || +$('ceFeather').value || +$('ceShift').value || +$('ceFringe').value;
}

async function ceClose(force) {
  if (!ce.on) return;
  if (!force && ceDirty() && !await askYes(t('ce.dropAsk'), t('ce.drop'))) return;
  Object.assign(ce, {on: false, cut: null, col: null, colData: null, mk: null, mk0: null, fx: null, strokes: [], redo: [], cur: null, done: null,
    pen: null, drag: null, tmp: null, tmpD: null});
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
    if (s.pen) { cePenPaint(g, s); continue; }
    if (s.sel) { ceSelPaint(g, s); continue; }
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

function ceState() {
  const live = ce.on && !ce.busy;
  $('ceUndo').disabled = !live || !ce.strokes.length;
  $('ceRedo').disabled = !live || !ce.redo.length;
  $('ceReset').disabled = !live || !ce.strokes.length || !!ce.strokes[ce.strokes.length - 1].reset;
  $('ceSave').disabled = !live;
  $('ceSrcPick').disabled = !live;
  document.querySelectorAll('#ceMode button').forEach(b => b.classList.toggle('on', b.dataset.v === ce.tool));
  document.querySelectorAll('#ceBgs [data-bg]').forEach(b => b.classList.toggle('on', b.dataset.bg === ce.bg));
  document.querySelectorAll('#ce .ce-opt').forEach(el => el.classList.toggle('hide', !el.dataset.for.split(' ').includes(ce.tool)));
  document.querySelectorAll('#cePenOp button').forEach(b => b.classList.toggle('on', b.dataset.v === ce.penOp));
  document.querySelectorAll('#ceWandArea button').forEach(b => b.classList.toggle('on', (b.dataset.v === 'all') === ce.wandAll));
  $('cePenApply').disabled = !live || !ce.pen || ce.pen.pts.length < 2;
  $('cePenDrop').disabled = !live || !ce.pen || !ce.pen.pts.length;
  const st = $('ceStage'), hand = ce.tool === 'hand' || ce.space || !!ce.pan;
  st.dataset.bg = ce.bg;
  st.classList.toggle('hand', hand);
  st.classList.toggle('panning', !!ce.pan);
  st.classList.toggle('pen', !hand && ce.tool === 'pen');
  st.classList.toggle('wand', !hand && ce.tool === 'wand');
}

function ceTool(v) { ce.tool = v; ceState(); cePenDraw(); }
function ceSize(k) { const r = $('ceSize'); r.value = Math.round(Math.min(+r.max, Math.max(+r.min, +r.value * k + (k > 1 ? 1 : -1)))); ceVals(); }

function ceUndo() {
  if (ce.drag || ce.cur) return;
  if (ce.tool === 'pen' && ce.pen && ce.pen.pts.length) { cePenBack(); return; }   // сначала отменяются точки контура
  if (ce.strokes.length) { ce.redo.push(ce.strokes.pop()); ceReplay(); ceFxSoon(0); ceState(); } }
function ceRedo() { if (ce.redo.length && !ce.cur) { ce.strokes.push(ce.redo.pop()); ceReplay(); ceFxSoon(0); ceState(); } }
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
// контур в маску: op cut — стереть внутри, add — вернуть внутри, keep — стереть снаружи. Мягкий край — размытием заливки,
// у keep заливается всё вокруг контура с запасом за краем картинки, чтобы размытие не задело её край.
function cePenPaint(g, s) {
  const P = cePath(s.pen);
  g.save();
  g.filter = s.soft ? `blur(${s.soft / 2}px)` : 'none';
  g.fillStyle = '#fff';
  if (s.op === 'keep') {
    const m = Math.max(ce.w, ce.h) + s.soft * 4, big = new Path2D();
    big.rect(-m, -m, ce.w + 2 * m, ce.h + 2 * m);
    big.addPath(P);
    g.globalCompositeOperation = 'destination-out';
    g.fill(big, 'evenodd');
  } else {
    g.globalCompositeOperation = s.op === 'add' ? 'source-over' : 'destination-out';
    g.fill(P);
  }
  g.restore();
}
function cePenApply() {
  const pen = ce.pen;
  if (!ce.on || ce.busy || ce.drag || !pen || pen.pts.length < 2) return;
  const s = {pen: pen.pts.map(p => p.slice()), op: ce.penOp, soft: +$('ceSmooth').value};
  ce.pen = null;
  ce.strokes.push(s);
  ce.redo = [];
  cePenPaint(ce.mk.getContext('2d'), s);
  cePenDraw(); ceRender(); ceFxSoon(0); ceState();
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
      $('ceStage').classList.remove('pen-close');
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
  if (!ce.on || ce.tool !== 'pen' || !pen || !pen.pts.length) { if (sv.innerHTML) sv.innerHTML = ''; return; }
  const pts = pen.pts, f = v => +v.toFixed(1), X = x => f(ce.px + x * ce.z), Y = y => f(ce.py + y * ce.z);
  const seg = (a, b) => `C${X(a[4])} ${Y(a[5])} ${X(b[2])} ${Y(b[3])} ${X(b[0])} ${Y(b[1])}`;
  let d = `M${X(pts[0][0])} ${Y(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) d += seg(pts[i], pts[i + 1]);
  let out = '';
  if (pen.closed) {
    d += seg(pts[pts.length - 1], pts[0]) + 'Z';
    const st = $('ceStage'), W = st.clientWidth, H = st.clientHeight;
    const fill = ce.penOp === 'keep' ? `M-9 -9H${W + 9}V${H + 9}H-9Z${d}` : d;
    out += `<path class="ce-pen-fill" fill-rule="evenodd" d="${fill}"/>`;
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
function ceWandSel(C, w, h, x, y, tol, all, vis) {
  const n = w * h, lab = ceLabT(), i0 = y * w + x;
  const sel = new Uint8Array(n);
  if (!vis(i0)) return sel;
  const k0 = ((C[i0 * 4] >> 2) << 12 | (C[i0 * 4 + 1] >> 2) << 6 | C[i0 * 4 + 2] >> 2) * 3;
  const L0 = lab[k0], A0 = lab[k0 + 1], B0 = lab[k0 + 2], band = Math.max(0.012, tol * 0.5), T2 = (tol + band) * (tol + band), tt = tol * tol;
  const val = i => {
    if (!vis(i)) return 0;
    const k = ((C[i * 4] >> 2) << 12 | (C[i * 4 + 1] >> 2) << 6 | C[i * 4 + 2] >> 2) * 3;
    const dl = lab[k] - L0, da = lab[k + 1] - A0, db = lab[k + 2] - B0, d2 = dl * dl + da * da + db * db;
    if (d2 <= tt) return 255;
    if (d2 >= T2) return 0;
    return 255 * (1 - (Math.sqrt(d2) - tol) / band) | 0;
  };
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
// щелчок палочкой: стереть видимое похожего цвета или (restore) вернуть похожее из цвета, в том числе уже стёртое
function ceWand(p, erase) {
  const x = Math.floor(p[0]), y = Math.floor(p[1]), w = ce.w, h = ce.h;
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const C = ce.colData, tol = +$('ceTol').value / 100 * 0.4;
  let vis = i => C[i * 4 + 3] > 0;
  if (erase) {   // стирается только то, что сейчас видно: уже прозрачное — граница, через него заливка не течёт
    const M = ce.mk.getContext('2d').getImageData(0, 0, w, h).data;
    vis = i => M[i * 4 + 3] * C[i * 4 + 3] > 255 * 4;
  }
  const sel = ceWandSel(C, w, h, x, y, tol, ce.wandAll, vis);
  // рамка выделения: пусто — ничего не делать; мягкий край размывается только в ней с запасом
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let yy = 0; yy < h; yy++) {
    const o = yy * w;
    for (let xx = 0; xx < w; xx++) if (sel[o + xx]) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (yy < y0) y0 = yy; y1 = yy; }
  }
  if (x1 < 0) return;
  const soft = +$('ceSmooth').value;
  if (soft) {
    const r = Math.max(1, Math.round(soft / 2)), m = 2 * r + 1;
    x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(w - 1, x1 + m); y1 = Math.min(h - 1, y1 + m);
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1, F = new Float32Array(cw * ch);
    for (let yy = 0; yy < ch; yy++) for (let xx = 0, o = (yy + y0) * w + x0; xx < cw; xx++) F[yy * cw + xx] = sel[o + xx];
    ceBlur(F, cw, ch, r); ceBlur(F, cw, ch, r);
    for (let yy = 0; yy < ch; yy++) for (let xx = 0, o = (yy + y0) * w + x0; xx < cw; xx++) sel[o + xx] = F[yy * cw + xx] + 0.5;
  }
  const s = {sel: ceRle(sel), erase};
  ce.strokes.push(s);
  ce.redo = [];
  ceSelPaint(ce.mk.getContext('2d'), s);
  ceRender(); ceFxSoon(0); ceState();
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
    if (ce.tool === 'wand') { ceWand(cePt(e), e.button === 0); return; }
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
    if (ce.pan) { ce.px = e.clientX - ce.pan.x; ce.py = e.clientY - ce.pan.y; ce.auto = false; ceApplyView(); return; }
    ceCursor(e);
    if (ce.drag) { ce.drag.move(e); return; }
    if (ce.tool === 'pen' && ce.pen && !e.buttons) {   // кусок контура за мышью, у первой точки — колечко замыкания
      const p = cePt(e), pen = ce.pen;
      pen.close = cePenCanClose(p);
      pen.hover = pen.closed ? null : p;
      st.classList.toggle('pen-close', pen.close);
      st.classList.toggle('pen-pt', !pen.close && (pen.closed || e.altKey) && !!cePenHit(p));
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
    if (ce.drag) { const d = ce.drag; ce.drag = null; d.end(e.type !== 'pointercancel'); cePenDraw(); ceState(); }
    if (ce.cur) { ce.cur = null; ceState(); ceRender(); ceFxSoon(0); }
  };
  st.addEventListener('pointerup', end);
  st.addEventListener('pointercancel', end);
  st.addEventListener('pointerleave', () => {
    $('ceCur').classList.add('hide');
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
$('ceMode').addEventListener('click', e => { const b = e.target.closest('button[data-v]'); if (b) ceTool(b.dataset.v); });
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
$('cePenOp').addEventListener('click', e => {
  const b = e.target.closest('button[data-v]'); if (!b) return;
  ce.penOp = b.dataset.v; ceState(); cePenDraw();
  try { localStorage.setItem('k9000.cePenOp', ce.penOp); } catch (er) {}
});
$('ceWandArea').addEventListener('click', e => {
  const b = e.target.closest('button[data-v]'); if (!b) return;
  ce.wandAll = b.dataset.v === 'all'; ceState();
  try { localStorage.setItem('k9000.ceWandAll', ce.wandAll ? '1' : ''); } catch (er) {}
});
try {
  for (const id of ['ceTol', 'ceSmooth']) { const v = localStorage.getItem('k9000.' + id); if (v !== null) $(id).value = v; }
  const op = localStorage.getItem('k9000.cePenOp');
  if (['keep', 'cut', 'add'].includes(op)) ce.penOp = op;
  ce.wandAll = localStorage.getItem('k9000.ceWandAll') === '1';
} catch (er) {}
$('cePenApply').addEventListener('click', cePenApply);
$('cePenDrop').addEventListener('click', cePenDrop);
for (const id of ['ceFeather', 'ceShift', 'ceFringe']) $(id).addEventListener('input', () => { ceVals(); ceFxSoon(90); });
$('ceUndo').addEventListener('click', ceUndo);
$('ceRedo').addEventListener('click', ceRedo);
$('ceReset').addEventListener('click', ceReset);
$('ceFit').addEventListener('click', ceFit);
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

// клавиши окна: на window, раньше всех остальных, чтобы E, B, пробел и Ctrl+Z не доставались окнам и вкладкам под ним.
// Пока открыт вопрос (askBox), клавиши его.
window.addEventListener('keydown', e => {
  if (!ce.on || askDone) return;
  const typing = e.target.closest && e.target.closest('input[type=text], textarea, select');
  const c = e.code, mod = e.ctrlKey || e.metaKey;
  const penLive = ce.tool === 'pen' && ce.pen && ce.pen.pts.length;
  if (e.key === 'Escape') { if (!ce.drag) penLive ? cePenDrop() : ceClose(false); }
  else if (typing) { e.stopPropagation(); return; }
  else if (penLive && (c === 'Enter' || c === 'NumpadEnter')) cePenApply();
  else if (penLive && !ce.pen.closed && (c === 'Backspace' || c === 'Delete') && !ce.drag) cePenBack();
  else if (c === 'Enter' || c === 'NumpadEnter') return;   // Enter на кнопке нажимает её
  else if (c.startsWith('Arrow')) { e.stopPropagation(); return; }   // ползунок двигается, окно просмотра под нами — нет
  else if (mod && c === 'KeyZ') e.shiftKey ? ceRedo() : ceUndo();
  else if (mod && c === 'KeyY') ceRedo();
  else if (mod && c === 'KeyS') ceSave();
  else if (mod && (c === 'Digit0' || c === 'Numpad0')) ceFit();
  else if (mod || e.altKey) return;
  else if (c === 'Space') { if (!ce.space) { ce.space = true; ceState(); $('ceCur').classList.add('hide'); } }
  else if (c === 'KeyE') ceTool('erase');
  else if (c === 'KeyB') ceTool('restore');
  else if (c === 'KeyH') ceTool('hand');
  else if (c === 'KeyP') ceTool('pen');
  else if (c === 'KeyW') ceTool('wand');
  else if (c === 'BracketLeft') ceSize(1 / 1.15);
  else if (c === 'BracketRight') ceSize(1.15);
  else if (c === 'Digit0') ceFit();
  else if (c === 'Digit1') { const st = $('ceStage'); ceZoomAt(1, st.clientWidth / 2, st.clientHeight / 2); }
  else if (['Delete', 'KeyF'].includes(c)) {}
  else return;
  e.preventDefault(); e.stopPropagation();
}, true);
window.addEventListener('keyup', e => {
  if (ce.on && e.code === 'Space') { ce.space = false; ceState(); e.preventDefault(); e.stopPropagation(); }
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
// «Утилиты» → «Убрать фон»: любая PNG с диска
$('bgFixPick').addEventListener('click', () => dialog(async () => {
  const r = await api('pick-files'); if (r.error) { alert(r.error); return; }
  const f = (r.files || []).find(f => /\.(png|webp)$/i.test(f.path));
  if (f) ceOpen({path: f.path});
  else if ((r.files || []).length) say('warn', t('drop.notSuitableTitle'), t('ce.onlyPng'));
}));
