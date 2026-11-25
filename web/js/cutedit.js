// «Поправить вырезку»: ручная доработка картинки после «Убрать фон». Одно окно на два входа:
// «Утилиты» → «Убрать фон» (кнопка у готового файла, «Поправить PNG…») и окно просмотра галереи генератора.
// Картинка = цвет × маска. Цвет (ce.col): пиксели вырезки, а там, где нейросеть стёрла всё, — пиксели оригинала.
// Маска (ce.mk): белое с прозрачностью; ластик стирает её (destination-out), «Вернуть» докрашивает (source-over).
// Без оригинала цвет — сама вырезка с её прозрачностью, маска — белая целиком: «Вернуть» возвращает только то, что было.
// Мазки хранятся списком, отмена перерисовывает маску с начала (как в geninpaint.js).
// Край (сжать/расширить, растушёвка, кайма) считается по пикселям после мазка и при движении ползунков: ceFx.
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
  strokes: [],      // {erase, r, soft, pts: [[x, y], …]} или {reset: true}
  redo: [],
  cur: null,
  tool: 'erase',    // erase | restore | hand
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
  Object.assign(ce, {on: true, busy: true, path: o.path, done: o.done || null, strokes: [], redo: [], cur: null, fx: null, pan: null});
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
  return ce.strokes.length > 0 || +$('ceFeather').value || +$('ceShift').value || +$('ceFringe').value;
}

async function ceClose(force) {
  if (!ce.on) return;
  if (!force && ceDirty() && !await askYes(t('ce.dropAsk'), t('ce.drop'))) return;
  Object.assign(ce, {on: false, cut: null, col: null, colData: null, mk: null, mk0: null, fx: null, strokes: [], redo: [], cur: null, done: null});
  $('ce').classList.add('hide');
  $('ceCur').classList.add('hide');
  const cv = $('ceCv'); cv.width = cv.height = 1;
}

// ---- вид: масштаб и сдвиг ----
function ceApplyView() {
  Object.assign($('ceBox').style, {width: ce.w * ce.z + 'px', height: ce.h * ce.z + 'px', transform: `translate(${ce.px}px, ${ce.py}px)`});
  $('ceCv').classList.toggle('px', ce.z >= 2);
  $('ceZoomV').textContent = Math.round(ce.z * 100) + '%';
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
  $('ceStage').dataset.bg = ce.bg;
  $('ceStage').classList.toggle('hand', ce.tool === 'hand' || ce.space || !!ce.pan);
  $('ceStage').classList.toggle('panning', !!ce.pan);
}

function ceTool(v) { ce.tool = v; ceState(); }
function ceSize(k) { const r = $('ceSize'); r.value = Math.round(Math.min(+r.max, Math.max(+r.min, +r.value * k + (k > 1 ? 1 : -1)))); ceVals(); }

function ceUndo() { if (ce.strokes.length && !ce.cur) { ce.redo.push(ce.strokes.pop()); ceReplay(); ceFxSoon(0); ceState(); } }
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
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let k = -r; k <= r; k++) s += T[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      A[y * w + x] = s / n;
      s += T[Math.min(h - 1, y + r + 1) * w + x] - T[Math.max(0, y - r) * w + x];
    }
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

// ---- мышь ----
function cePt(e) {
  const r = ce.cv.getBoundingClientRect();
  return [(e.clientX - r.left) * ce.w / r.width, (e.clientY - r.top) * ce.h / r.height];
}
function ceCursor(e) {
  const c = $('ceCur'), s = $('ceStage').getBoundingClientRect();
  if (!ce.cv || ce.tool === 'hand' || ce.space || ce.pan) { c.classList.add('hide'); return; }
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
    if (!ce.cur) return;
    const p = cePt(e), pts = ce.cur.pts;
    ceSeg(ce.mk.getContext('2d'), ce.cur, pts[pts.length - 1], p);
    pts.push(p);
    ceRender();
  });
  const end = () => {
    if (ce.pan) { ce.pan = null; ceState(); }
    if (ce.cur) { ce.cur = null; ceState(); ceRender(); ceFxSoon(0); }
  };
  st.addEventListener('pointerup', end);
  st.addEventListener('pointercancel', end);
  st.addEventListener('pointerleave', () => $('ceCur').classList.add('hide'));
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
for (const id of ['ceSize', 'ceSoft']) $(id).addEventListener('input', ceVals);
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
  if (e.key === 'Escape') ceClose(false);
  else if (typing) { e.stopPropagation(); return; }
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
