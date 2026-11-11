'use strict';
// «Цвет», инструмент «Меш-градиент»: сетка точек с цветами (cl.mesh, проверка meshValid и состав в color.js).
// Поверхность гладкая: и положение, и цвет между точками идут кривой Катмулла — Рома по строкам, потом по столбцам,
// поэтому тяга точки плавно изгибает соседние переходы, а не ломает их по линиям сетки.
// Цвета смешиваются в OKLab (ровно на глаз) или в RGB. Рисует свой растеризатор: каждая клетка сетки делится на мелкие
// треугольники, внутри них цвет линейный. Так просмотр и PNG получаются одной и той же функцией (meshRaster).

let meshSel = -1;          // выбранная точка (номер в cl.mesh.pts); -1 — средняя
let meshLines = true;      // показывать линии сетки поверх просмотра (не сохраняется)

// ---------- поверхность ----------
// кривая Катмулла — Рома между p1 и p2; за краем сетки соседа нет — продолжаем прямой (2·p1 − p2)
function meshCr(v, n, i, t) {
  const p1 = v[i], p2 = v[i + 1], p0 = i > 0 ? v[i - 1] : 2 * p1 - p2, p3 = i + 2 < n ? v[i + 2] : 2 * p2 - p1;
  return .5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (3 * p1 - p0 - 3 * p2 + p3) * t * t * t);
}
// каналы точек: x, y (доли кадра) и цвет (OKLab или RGB 0–255), каждый массивом по строкам
function meshChan(m) {
  const ch = [[], [], [], [], []];
  for (const p of m.pts) {
    const c = cpParse(p.c), o = m.mix === 'rgb' ? {L: c.r, a: c.g, b: c.b} : clLab(c);
    ch[0].push(p.x); ch[1].push(p.y); ch[2].push(o.L); ch[3].push(o.a); ch[4].push(o.b);
  }
  return ch;
}
// место s на отрезках 0..n−1: номер отрезка и доля внутри
const meshSeg = (s, n) => { const i = Math.min(Math.floor(s), n - 2); return [i, s - i]; };
// цвет каналов (L, a, b) в {r, g, b} 0–255 без обрезки
const meshRgb = (m, L, a, b) => m.mix === 'rgb' ? {r: L, g: a, b} : clLabRgb({L, a, b});
// одна точка поверхности по месту в сетке (u — 0..cols−1, v — 0..rows−1): {x, y, c: {r, g, b}}
function meshAt(m, u, v, ch = meshChan(m)) {
  const [i, tu] = meshSeg(u, m.cols), [j, tv] = meshSeg(v, m.rows), out = [];
  for (const arr of ch) {
    const col = [];
    for (let r = 0; r < m.rows; r++) col.push(meshCr(arr.slice(r * m.cols, (r + 1) * m.cols), m.cols, i, tu));
    out.push(meshCr(col, m.rows, j, tv));
  }
  return {x: out[0], y: out[1], c: meshRgb(m, out[2], out[3], out[4])};
}
// частая сетка вершин: каждая клетка делится на S × S. Возвращает размеры и массивы x, y (доли кадра), r, g, b (0–255)
function meshBuild(m, S) {
  const NX = (m.cols - 1) * S + 1, NY = (m.rows - 1) * S + 1;
  // строки точек каждого канала отдельными массивами
  const rows = meshChan(m).map(arr => Array.from({length: m.rows}, (_, r) => arr.slice(r * m.cols, (r + 1) * m.cols)));
  // сначала вдоль строк: для каждой строки точек и каждого шага по горизонтали
  const tmp = rows.map(() => new Float64Array(m.rows * NX));
  for (let a = 0; a < NX; a++) {
    const [i, t] = meshSeg(a / S, m.cols);
    for (let c = 0; c < 5; c++) for (let r = 0; r < m.rows; r++) tmp[c][r * NX + a] = meshCr(rows[c][r], m.cols, i, t);
  }
  const N = NX * NY, X = new Float32Array(N), Y = new Float32Array(N), R = new Float32Array(N), G = new Float32Array(N), B = new Float32Array(N);
  const col = new Float64Array(m.rows), val = [0, 0, 0, 0, 0];
  for (let a = 0; a < NX; a++) {
    for (let b = 0; b < NY; b++) {
      const [j, t] = meshSeg(b / S, m.rows);
      for (let c = 0; c < 5; c++) {
        for (let r = 0; r < m.rows; r++) col[r] = tmp[c][r * NX + a];
        val[c] = meshCr(col, m.rows, j, t);
      }
      const k = b * NX + a, o = meshRgb(m, val[2], val[3], val[4]);
      X[k] = val[0]; Y[k] = val[1];
      R[k] = Math.min(Math.max(o.r, 0), 255); G[k] = Math.min(Math.max(o.g, 0), 255); B[k] = Math.min(Math.max(o.b, 0), 255);
    }
  }
  return {S, NX, NY, X, Y, R, G, B};
}
// сколько делить клетку: треугольник примерно в 8 пикселей картинки, но в разумных пределах
const meshSteps = (m, W, H) => Math.min(Math.max(Math.ceil(Math.max(W / (m.cols - 1), H / (m.rows - 1)) / 8), 4), 128);
// картинка W × H в RGBA. dither — шум на полшага яркости против ступенек в 8 битах (как у PNG градиента).
// Пиксель, куда не попал ни один треугольник (сетку перекрутили), остаётся прозрачным.
function meshRaster(m, W, H, dither, mb = meshBuild(m, meshSteps(m, W, H))) {
  const d = new Uint8ClampedArray(W * H * 4), {NX, NY, X, Y, R, G, B} = mb, E = 1e-6;
  const tri = (i0, i1, i2) => {
    const ax = X[i0] * W, ay = Y[i0] * H, bx = X[i1] * W, by = Y[i1] * H, cx = X[i2] * W, cy = Y[i2] * H;
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-9) return;
    const inv = 1 / area;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let py = y0; py <= y1; py++) {
      const yc = py + .5;
      for (let px = x0; px <= x1; px++) {
        const xc = px + .5;
        const w0 = ((bx - xc) * (cy - yc) - (by - yc) * (cx - xc)) * inv;
        if (w0 < -E) continue;
        const w1 = ((cx - xc) * (ay - yc) - (cy - yc) * (ax - xc)) * inv;
        if (w1 < -E) continue;
        const w2 = 1 - w0 - w1;
        if (w2 < -E) continue;
        const n = dither ? Math.random() - .5 : 0, o = (py * W + px) * 4;
        d[o] = w0 * R[i0] + w1 * R[i1] + w2 * R[i2] + n;
        d[o + 1] = w0 * G[i0] + w1 * G[i1] + w2 * G[i2] + n;
        d[o + 2] = w0 * B[i0] + w1 * B[i1] + w2 * B[i2] + n;
        d[o + 3] = 255;
      }
    }
  };
  for (let b = 0; b < NY - 1; b++) {
    for (let a = 0; a < NX - 1; a++) {
      const q = b * NX + a;
      tri(q, q + 1, q + NX + 1);
      tri(q, q + NX + 1, q + NX);
    }
  }
  return d;
}
// маленькая картинка для «Моих цветов», с запоминанием
const meshThumbs = new Map();
function meshThumb(m) {
  const key = JSON.stringify(m);
  let url = meshThumbs.get(key);
  if (url) return url;
  const W = 64, H = 40, c = document.createElement('canvas');
  c.width = W; c.height = H;
  c.getContext('2d').putImageData(new ImageData(meshRaster(m, W, H, false), W, H), 0, 0);
  url = c.toDataURL('image/png');
  if (meshThumbs.size > 80) meshThumbs.clear();
  meshThumbs.set(key, url);
  return url;
}

// ---------- точки ----------
function meshNode() {
  const m = cl.mesh;
  if (!(meshSel >= 0 && meshSel < m.pts.length)) meshSel = Math.floor(m.rows / 2) * m.cols + Math.floor(m.cols / 2);
  return m.pts[meshSel];
}
// цвет выбранной точки (из «Моих цветов», недавних, «Отправить в»); рисует и сохраняет тот, кто позвал
function meshSetSel(hex) { const c = cpParse(hex); if (c) meshNode().c = cpHex(c, false); }
// набор цветов по сетке косыми полосами: соседние точки получают разные цвета
function meshFill(list) {
  const m = cl.mesh;
  m.pts.forEach((p, k) => { p.c = cpHex(cpParse(list[(k % m.cols + Math.floor(k / m.cols)) % list.length]), false); });
}
// новая сетка cols × rows из прежней поверхности: изгибы и цвета остаются на своих местах
function meshResize(cols, rows) {
  const m = cl.mesh, ch = meshChan(m), pts = [];
  if (cols === m.cols && rows === m.rows) return;
  meshNode();   // выбранная точка есть всегда
  const su =meshSel % m.cols / (m.cols - 1), sv = Math.floor(meshSel / m.cols) / (m.rows - 1);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const p = meshAt(m, i / (cols - 1) * (m.cols - 1), j / (rows - 1) * (m.rows - 1), ch);
      pts.push({x: p.x, y: p.y, c: cpHex({...p.c, a: 1}, false)});
    }
  }
  // точки, которые совпали с прежними по месту в сетке, берут прежний цвет как есть (без потерь на пересчёте)
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const u = i / (cols - 1) * (m.cols - 1), v = j / (rows - 1) * (m.rows - 1);
    if (Number.isInteger(u) && Number.isInteger(v)) { const o = m.pts[v * m.cols + u]; Object.assign(pts[j * cols + i], {x: o.x, y: o.y, c: o.c}); }
  }
  cl.mesh = meshValid({cols, rows, mix: m.mix, pts});
  meshSel = Math.round(sv * (rows - 1)) * cols + Math.round(su * (cols - 1));   // выбранной остаётся точка в том же месте сетки
}
// «Случайно» (и пробел): цвета по сочетаниям круга оттенков, как у градиента (CL_SCHEMES в color.js); соседние точки
// берут разные цвета схемы (косыми полосами). Точки внутри и на краях чуть сдвигаются от ровной сетки — так живее.
function meshRandom() {
  const m = cl.mesh, base = Math.random() * 360, sch = CL_SCHEMES[Math.floor(Math.random() * CL_SCHEMES.length)];
  const mono = sch.every(x => !x), L0 = .5 + Math.random() * .12, L1 = .78 + Math.random() * .15;
  const shake = (k, n) => Math.min(Math.max(k / (n - 1) + (Math.random() - .5) * .55 / (n - 1), .04), .96);
  m.pts.forEach((p, k) => {
    const i = k % m.cols, j = Math.floor(k / m.cols), d = (i + j) % sch.length;
    const H = (base + sch[d] + (Math.random() - .5) * 20 + 360) % 360;
    let L = mono ? L0 + (L1 - L0) * (i + j) / (m.cols + m.rows - 2) : L0 + (L1 - L0) * Math.random();
    if (H > 60 && H < 130) L = Math.max(L, .8);   // тёмный жёлтый и салатовый выходят болотными
    p.c = cpHex({...clFit({L, C: mono ? .06 + Math.random() * .1 : .1 + Math.random() * .12, H}), a: 1}, false);
    if (i > 0 && i < m.cols - 1) p.x = +shake(i, m.cols).toFixed(4);
    if (j > 0 && j < m.rows - 1) p.y = +shake(j, m.rows).toFixed(4);
  });
  clRender(); clSave();
}
// точки обратно на ровную сетку, цвета те же
function meshEven() {
  const m = cl.mesh;
  m.pts.forEach((p, k) => { p.x = k % m.cols / (m.cols - 1); p.y = Math.floor(k / m.cols) / (m.rows - 1); });
}

// ---------- просмотр ----------
const meshCv = $('meshCanvas'), meshCx = meshCv.getContext('2d');
let meshRaf = 0;
const meshDrawSoon = () => { if (!meshRaf) meshRaf = requestAnimationFrame(() => { meshRaf = 0; meshDraw(); }); };
function meshDraw() {
  const box = $('meshView'), [W, H] = clWH(), m = cl.mesh;
  const k = Math.min((box.clientWidth - 2) / W, (box.clientHeight - 2) / H);
  if (!(k > 0)) return;
  const cw = Math.max(Math.round(W * k), 1), ch = Math.max(Math.round(H * k), 1), dpr = devicePixelRatio || 1;
  meshCv.style.width = cw + 'px'; meshCv.style.height = ch + 'px';
  const pw = Math.round(cw * dpr), ph = Math.round(ch * dpr);
  if (meshCv.width !== pw || meshCv.height !== ph) { meshCv.width = pw; meshCv.height = ph; }
  const mb = meshBuild(m, meshSteps(m, pw, ph));
  meshCx.putImageData(new ImageData(meshRaster(m, pw, ph, true, mb), pw, ph), 0, 0);
  const x = meshCx, R = 6 * dpr, {S, NX, NY, X, Y} = mb;
  x.save();
  x.shadowColor = 'rgba(0,0,0,.45)'; x.shadowBlur = 4 * dpr;
  if (meshLines) {   // линии сетки идут по той же поверхности, что и цвет: видно, как точка изгибает переходы
    x.strokeStyle = 'rgba(255,255,255,.6)'; x.lineWidth = 1.25 * dpr;
    x.beginPath();
    for (let j = 0; j < m.rows; j++) { const b = j * S; for (let a = 0; a < NX; a++) { const q = b * NX + a; a ? x.lineTo(X[q] * pw, Y[q] * ph) : x.moveTo(X[q] * pw, Y[q] * ph); } }
    for (let i = 0; i < m.cols; i++) { const a = i * S; for (let b = 0; b < NY; b++) { const q = b * NX + a; b ? x.lineTo(X[q] * pw, Y[q] * ph) : x.moveTo(X[q] * pw, Y[q] * ph); } }
    x.stroke();
  }
  meshNode();
  const order = m.pts.map((p, i) => i).sort((a, b) => (a === meshSel) - (b === meshSel));   // выбранная сверху
  for (const i of order) {
    const p = m.pts[i], on = i === meshSel;
    // точки на краю рисуются чуть внутрь, иначе от кружка видна только половина
    const px = Math.min(Math.max(p.x * pw, R * 1.6), pw - R * 1.6), py = Math.min(Math.max(p.y * ph, R * 1.6), ph - R * 1.6);
    x.beginPath(); x.arc(px, py, R * (on ? 1.5 : 1.25), 0, Math.PI * 2);
    x.fillStyle = p.c; x.fill();
    x.strokeStyle = on ? '#e9b872' : '#fff'; x.lineWidth = (on ? 3 : 2) * dpr; x.stroke();
  }
  x.restore();
  $('meshSizeTag').textContent = `${W} × ${H}`;
}
// ближайшая точка под мышью в пределах кружка: номер или −1
function meshHit(e) {
  const r = meshCv.getBoundingClientRect(), m = cl.mesh, reach = 14, pad = 6 * 1.6;
  let best = reach, hit = -1;
  m.pts.forEach((p, i) => {
    const px = Math.min(Math.max(p.x * r.width, pad), r.width - pad), py = Math.min(Math.max(p.y * r.height, pad), r.height - pad);
    const d = Math.hypot(e.clientX - r.left - px, e.clientY - r.top - py) - (i === meshSel ? 1 : 0);
    if (d <= best) { best = d; hit = i; }
  });
  return hit;
}
// тяга точки: углы стоят, точки края ходят вдоль края, внутренние — по всему кадру. Щелчок без тяги — окно цвета
let meshDrag = null;
meshCv.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  const k = meshHit(e);
  if (k < 0) return;
  if (cp && cp.el === $('meshSw') && k !== meshSel) cpClose(true);   // окно цвета было у другой точки
  meshSel = k;
  meshDrag = {id: e.pointerId, k, moved: false, x0: e.clientX, y0: e.clientY};
  meshCv.setPointerCapture(e.pointerId);
  meshCv.style.cursor = 'grabbing';
  meshRender();
});
meshCv.addEventListener('pointermove', e => {
  const d = meshDrag;
  if (!d || d.id !== e.pointerId) { meshCv.style.cursor = meshHit(e) >= 0 ? 'grab' : ''; return; }
  if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 3) return;
  d.moved = true;
  const m = cl.mesh, r = meshCv.getBoundingClientRect(), i = d.k % m.cols, j = Math.floor(d.k / m.cols), p = m.pts[d.k];
  const u = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1), v = Math.min(Math.max((e.clientY - r.top) / r.height, 0), 1);
  if (i > 0 && i < m.cols - 1) p.x = +u.toFixed(4);
  if (j > 0 && j < m.rows - 1) p.y = +v.toFixed(4);
  meshDrawSoon();
});
function meshDragEnd(e) {
  const d = meshDrag;
  if (!d || d.id !== e.pointerId) return;
  meshDrag = null;
  meshCv.style.cursor = 'grab';
  if (d.moved) { meshDraw(); clSave(); clLibDraw(); }
  else if (e.type === 'pointerup' && !(cp && cp.el === $('meshSw'))) cpOpen($('meshSw'));
}
meshCv.addEventListener('pointerup', meshDragEnd);
meshCv.addEventListener('pointercancel', meshDragEnd);

// ---------- панель ----------
function meshRender() {
  const m = cl.mesh, p = meshNode();
  clSegSync('meshCols', String(m.cols));
  clSegSync('meshRows', String(m.rows));
  clSegSync('meshMix', m.mix);
  const sw = $('meshSw');
  if (sw.value !== p.c && !(cp && cp.el === sw)) sw.value = p.c;
  if (document.activeElement !== $('meshHex')) $('meshHex').value = clUp(p.c);
  $('meshLines').classList.toggle('on', meshLines);
  $('meshLines').setAttribute('aria-pressed', meshLines);
  $('meshSize').value = cl.size;
  $('meshOwn').classList.toggle('hide', cl.size !== 'own');
  if (document.activeElement !== $('meshW')) $('meshW').value = cl.w;
  if (document.activeElement !== $('meshH')) $('meshH').value = cl.h;
  meshDraw();
}
let meshWas;
cpField($('meshSw'), {
  live: v => { const p = meshNode(); if (meshWas === undefined) meshWas = p.c; p.c = cpHex(cpParse(v), false); $('meshHex').value = clUp(p.c); meshDrawSoon(); },
  done: ok => { const p = meshNode(); if (!ok && meshWas !== undefined) p.c = meshWas; meshWas = undefined; clRender(); clSave(); }});
$('meshHex').addEventListener('change', () => {
  const c = cpParse($('meshHex').value);
  if (c) { meshNode().c = cpHex(c, false); clSave(); }
  clRender();
});
$('meshHex').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
$('meshEye').onclick = async () => {
  toast({type: 'ok', title: t('cl.eyeGo'), ttl: 2500});
  const hex = await screenColor();   // null — Esc, передумали
  const c = hex && cpParse(hex);
  if (!c) return;
  meshNode().c = cpHex(c, false);
  clRecentAdd(meshNode().c); clRender(); clSave();
};
$('meshCols').addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (b) { meshResize(+b.dataset.v, cl.mesh.rows); clRender(); clSave(); } });
$('meshRows').addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (b) { meshResize(cl.mesh.cols, +b.dataset.v); clRender(); clSave(); } });
$('meshMix').addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (b) { cl.mesh.mix = b.dataset.v; clRender(); clSave(); } });
$('meshLines').onclick = () => { meshLines = !meshLines; meshRender(); };
$('meshRand').onclick = meshRandom;
$('meshEvenB').onclick =() => { meshEven(); clRender(); clSave(); };
$('meshSize').addEventListener('change', () => { cl.size = $('meshSize').value; clRender(); clSave(); });
for (const [id, k] of [['meshW', 'w'], ['meshH', 'h']]) {
  $(id).addEventListener('change', () => {
    const v = Math.round(+$(id).value);
    if (Number.isFinite(v) && v > 0) cl[k] = Math.min(Math.max(v, 16), 8192);
    clRender(); clSave();
  });
}
$('meshPng').onclick = () => dialog(async () => {
  const [W, H] = clWH(), c = document.createElement('canvas');
  c.width = W; c.height = H;
  c.getContext('2d').putImageData(new ImageData(meshRaster(cl.mesh, W, H, true), W, H), 0, 0);
  clSaved(await api('color-save', {ext: 'png', name: `mesh-${W}x${H}.png`, data: c.toDataURL('image/png').split(',')[1]}));
});
new ResizeObserver(() => { if (tab === 'color' && cl.tool === 'mesh') meshDraw(); }).observe($('meshView'));
