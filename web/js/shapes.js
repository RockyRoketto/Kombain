// ---------- фигуры: прямоугольник, эллипс, линия, стрелка, перо ----------
// Как «Текст»: настройки в поле клипа shape, страница рисует PNG, для движка это слой-картинка, поэтому просмотр и результат совпадают.
// Рамка слоя — границы фигуры. Рамку тянут — картинка рисуется заново, толщина линии и скругление не растягиваются.
// Толщина sw и скругление r в долях высоты холста. У прямоугольника и эллипса обводка внутри рамки.
// Путь (k: 'path'): точки pts — [x, y, ix, iy, ox, oy], точка и её ручки входа и выхода, в долях внутренней области рамки
// (рамка без запаса mtShapePad на толщину и наконечники). У угловой точки ручки стоят на ней самой.
// Поле shape не меняется на месте: копии клипа делят один объект.
const MT_SHAPE_K = 2, MT_SHAPE_PX = 8192;   // запас резкости и предел стороны картинки
const MT_ARROW_L = 4.5, MT_ARROW_W = 2.4;   // длина и полуширина наконечника в толщинах линии
const MT_SHAPE_KINDS = ['rect', 'ell', 'line', 'arrow'];   // что ставит инструмент U; линия и стрелка — путь из двух точек

// запас вокруг пути в долях высоты холста: половина толщины, у стрелки полуширина наконечника
const mtShapePad = x => x.k !== 'path' ? 0 : x.sw * (x.a0 || x.a1 ? MT_ARROW_W : .5) + .001;
const mtShapeOpen = x => x.k === 'path' && !x.closed;

// Кривая отрезка i → i+1 точками ломаной (в тех же координатах, что и точки)
function mtShapeFlat(pts, closed, n = 32) {
  const out = [], cnt = closed ? pts.length : pts.length - 1;
  if (pts.length) out.push([pts[0][0], pts[0][1]]);
  for (let i = 0; i < cnt; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const straight = a[4] === a[0] && a[5] === a[1] && b[2] === b[0] && b[3] === b[1];
    const steps = straight ? 1 : n;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps, u = 1 - t, A = u * u * u, B = 3 * u * u * t, C = 3 * u * t * t, D = t * t * t;
      out.push([A * a[0] + B * a[4] + C * b[2] + D * b[0], A * a[1] + B * a[5] + C * b[3] + D * b[1]]);
    }
  }
  return out;
}
// Ломаная до длины len от начала (или от конца, если len < 0 считать с конца): прорисовка и место под наконечник
function mtPolyLen(poly) { let s = 0; for (let i = 1; i < poly.length; i++) s += Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]); return s; }
function mtPolyCut(poly, from, to) {
  const out = [];
  let s = 0;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1], b = poly[i], d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const at = v => { const t = d ? (v - s) / d : 0; return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; };
    if (s + d >= from && s <= to) {
      if (!out.length) out.push(s >= from ? a : at(from));
      out.push(s + d <= to ? b : at(to));
    }
    s += d;
  }
  return out;
}
// точка на расстоянии back от конца ломаной, для направления наконечника
function mtPolyBack(poly, back) {
  const L = mtPolyLen(poly), cut = mtPolyCut(poly, Math.max(L - back, 0), L);
  return cut[0] || poly[0];
}

// Точки пути в пикселях холста (внутри картинки размера bw×bh)
function mtShapePx(x, bw, bh, H) {
  const pad = mtShapePad(x) * H, iw = Math.max(bw - pad * 2, 0), ih = Math.max(bh - pad * 2, 0);
  return x.pts.map(p => [pad + p[0] * iw, pad + p[1] * ih, pad + p[2] * iw, pad + p[3] * ih, pad + p[4] * iw, pad + p[5] * ih]);
}
function mtShapePath(g, pts, closed) {
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  const cnt = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < cnt; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; g.bezierCurveTo(a[4], a[5], b[2], b[3], b[0], b[1]); }
  if (closed) g.closePath();
}
// наконечник: остриё в tip, основание в сторону from
function mtArrowHead(g, tip, from, sw) {
  const dx = tip[0] - from[0], dy = tip[1] - from[1], d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d, L = sw * MT_ARROW_L, w = sw * MT_ARROW_W;
  g.beginPath();
  g.moveTo(tip[0], tip[1]);
  g.lineTo(tip[0] - ux * L - uy * w, tip[1] - uy * L + ux * w);
  g.lineTo(tip[0] - ux * L * .78, tip[1] - uy * L * .78);
  g.lineTo(tip[0] - ux * L + uy * w, tip[1] - uy * L - ux * w);
  g.closePath();
  g.fill();
}
// Картинка фигуры. bw, bh — рамка в пикселях холста, H — высота холста. part — доля прорисовки обводки (1 — вся).
function mtShapeDraw(x, bw, bh, H, part = 1, kMax = MT_SHAPE_K) {
  const cv = document.createElement('canvas'), k = Math.min(kMax, MT_SHAPE_PX / Math.max(bw, bh, 1));
  cv.width = Math.max(Math.round(bw * k), 2);
  cv.height = Math.max(Math.round(bh * k), 2);
  let g = cv.getContext('2d');
  g.scale(cv.width / bw, cv.height / bh);
  const sw = x.sw * H, stroke = sw > 0, dash = x.dash ? [sw * 2, sw * 2.5] : [];
  g.lineJoin = 'round';
  g.fillStyle = cpStyle(g, x.fill, bw, bh);   // градиент в долях рамки (colorpick.js)
  g.strokeStyle = cpStyle(g, x.stroke, bw, bh);
  g.lineWidth = sw;
  if (x.k === 'rect' || x.k === 'ell') {
    const i = stroke ? sw / 2 : 0, w = Math.max(bw - i * 2, 0), h = Math.max(bh - i * 2, 0);
    g.beginPath();
    if (x.k === 'rect') g.roundRect(i, i, w, h, Math.min(x.r * H, w / 2, h / 2));
    else g.ellipse(bw / 2, bh / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    if (x.fillOn) g.fill();
    if (stroke && part > 0) {
      g.setLineDash(x.dash ? [sw * 3, sw * 2] : []);
      if (part < 1) {   // прорисовка: обводка по ломаной до нужной длины
        const poly = mtShapeRim(x, i, w, h, H);
        mtStrokePoly(g, mtPolyCut(poly, 0, mtPolyLen(poly) * part), false);
      } else g.stroke();
    }
    return cv;
  }
  const pts = mtShapePx(x, bw, bh, H);
  if (x.fillOn && pts.length > 2) { mtShapePath(g, pts, true); g.fill(); }
  if (!stroke || part <= 0) return cv;
  // полупрозрачная обводка или градиент: линия и наконечники рисуются сплошной маской на отдельном слое (иначе их стык темнее),
  // потом маска закрашивается цветом или градиентом
  const main = g, layer = cpSee(x.stroke) || cpGrad(x.stroke) ? document.createElement('canvas') : null;
  if (layer) {
    layer.width = cv.width; layer.height = cv.height;
    g = layer.getContext('2d');
    g.scale(cv.width / bw, cv.height / bh);
    g.lineJoin = 'round'; g.lineWidth = sw; g.strokeStyle = '#000';
  }
  g.lineCap = 'round';
  g.setLineDash(dash);
  const poly = mtShapeFlat(pts, x.closed), L = mtPolyLen(poly), end = L * part, cut = sw * MT_ARROW_L * .7;
  const a0 = x.a0 && !x.closed, a1 = x.a1 && !x.closed;
  // линия заходит под наконечник, но не до острия
  const from = a0 ? Math.min(cut, end) : 0, to = a1 ? Math.max(end - cut, from) : end;
  if (to > from) mtStrokePoly(g, mtPolyCut(poly, from, to), x.closed && part >= 1);
  g.setLineDash([]);
  g.fillStyle = layer ? '#000' : x.stroke;
  const drawn = part >= 1 ? poly : mtPolyCut(poly, 0, end);
  if (a1 && drawn.length > 1) mtArrowHead(g, drawn[drawn.length - 1], mtPolyBack(drawn, sw * MT_ARROW_L), sw);
  if (a0 && drawn.length > 1 && end > 0) mtArrowHead(g, drawn[0], mtPolyCut(drawn, 0, sw * MT_ARROW_L).pop(), sw);
  if (layer) {
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = cpStyle(g, x.stroke, bw, bh);
    g.fillRect(0, 0, bw, bh);
    main.setTransform(1, 0, 0, 1, 0, 0);
    main.drawImage(layer, 0, 0);
  }
  return cv;
}
function mtStrokePoly(g, poly, closed) {
  if (poly.length < 2) return;
  g.beginPath();
  g.moveTo(poly[0][0], poly[0][1]);
  for (const p of poly.slice(1)) g.lineTo(p[0], p[1]);
  if (closed) g.closePath();
  g.stroke();
}
// контур прямоугольника или эллипса ломаной, от верхней середины по часовой стрелке
function mtShapeRim(x, i, w, h, H) {
  const out = [];
  if (x.k === 'ell') {
    for (let s = 0; s <= 128; s++) { const a = -Math.PI / 2 + s / 128 * Math.PI * 2; out.push([i + w / 2 + Math.cos(a) * w / 2, i + h / 2 + Math.sin(a) * h / 2]); }
    return out;
  }
  const r = Math.min(x.r * H, w / 2, h / 2), L = i, T = i, R = i + w, B = i + h;
  const arc = (cx, cy, a0) => { for (let s = 0; s <= 16; s++) { const a = a0 + s / 16 * Math.PI / 2; out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); } };
  out.push([L + w / 2, T]);
  arc(R - r, T + r, -Math.PI / 2);
  arc(R - r, B - r, 0);
  arc(L + r, B - r, Math.PI / 2);
  arc(L + r, T + r, Math.PI);
  out.push([L + w / 2, T]);
  return out;
}

// Путь по точкам в пикселях холста: рамка слоя по границам кривой с запасом, точки в доли внутренней области
function mtShapeFit(c, x, abs) {
  const d = mvCanvasDims(), pad = mtShapePad(x) * d.h, flat = mtShapeFlat(abs, x.closed, 64);
  const xs = flat.map(p => p[0]), ys = flat.map(p => p[1]);
  const x0 = Math.min(...xs), y0 = Math.min(...ys), sx = Math.max(Math.max(...xs) - x0, 1e-3), sy = Math.max(Math.max(...ys) - y0, 1e-3);
  const u = v => mtRnd((v - x0) / sx, 6), w = v => mtRnd((v - y0) / sy, 6);
  c.shape = {...x, pts: abs.map(p => [u(p[0]), w(p[1]), u(p[2]), w(p[3]), u(p[4]), w(p[5])])};
  Object.assign(c, {x: (x0 - pad) / d.w, y: (y0 - pad) / d.h, w: (sx + pad * 2) / d.w, h: (sy + pad * 2) / d.h});
}
// обратно: точки пути в пикселях холста по текущей рамке
function mtShapeAbs(c) {
  const d = mvCanvasDims(), b = mvBox(c);
  return mtShapePx(c.shape, b.w * d.w, b.h * d.h, d.h).map(p => p.map((v, i) => v + (i % 2 ? b.y * d.h : b.x * d.w)));
}

// Прямоугольник и эллипс точками пути (пиксели холста, без поворота), по середине обводки, как их рисует mtShapeDraw:
// эллипс — 4 гладкие точки с ручками 0,5523 радиуса, прямоугольник — 4 угла, со скруглением по 2 точки на угол.
// Начало сверху, по часовой стрелке, как у прорисовки (mtShapeRim).
const MT_ARC_K = .5523;
function mtShapeRimPts(c) {
  const d = mvCanvasDims(), b = mvBox(c), x = c.shape, H = d.h, i = x.sw > 0 ? x.sw * H / 2 : 0;
  const w = Math.max(b.w * d.w - i * 2, 0), h = Math.max(b.h * d.h - i * 2, 0), L = b.x * d.w + i, T = b.y * d.h + i, R = L + w, B = T + h;
  if (x.k === 'ell') {
    const cx = L + w / 2, cy = T + h / 2, kx = w / 2 * MT_ARC_K, ky = h / 2 * MT_ARC_K;
    return [[cx, T, cx - kx, T, cx + kx, T], [R, cy, R, cy - ky, R, cy + ky], [cx, B, cx + kx, B, cx - kx, B], [L, cy, L, cy + ky, L, cy - ky]];
  }
  const r = Math.min((x.r || 0) * H, w / 2, h / 2), k = r * MT_ARC_K, P = (u, v) => [u, v, u, v, u, v];
  if (!(r > 0)) return [P(L, T), P(R, T), P(R, B), P(L, B)];
  const pts = [
    [L + r, T, L + r - k, T, L + r, T], [R - r, T, R - r, T, R - r + k, T],
    [R, T + r, R, T + r - k, R, T + r], [R, B - r, R, B - r, R, B - r + k],
    [R - r, B, R - r + k, B, R - r, B], [L + r, B, L + r, B, L + r - k, B],
    [L, B - r, L, B - r + k, L, B - r], [L, T + r, L, T + r, L, T + r - k]];
  // скругление во всю сторону: две точки совпали — одна гладкая
  const same = (p, q) => Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) < 1e-6, out = [];
  for (const p of pts) { const q = out[out.length - 1]; if (q && same(q, p)) q.splice(4, 2, p[4], p[5]); else out.push(p); }
  if (out.length > 2 && same(out[0], out[out.length - 1])) out[0].splice(2, 2, ...out.pop().slice(2, 4));
  return out;
}
// фигура как путь: прямоугольник и эллипс становятся замкнутым путём при первой правке точек (точки даёт mtShapeWorld)
const mtShapePathOf = x => x.k === 'path' ? x : {...x, k: 'path', closed: true, a0: false, a1: false};

// Картинка на диске. Ключи масштаба меняют рамку на ходу, картинка рисуется под самый крупный ключ: растягивается она равномерно.
async function mtShapeMake(x, c) {
  const d = mvCanvasDims(), b = mvBox(c), keys = c.kf && Array.isArray(c.kf.w) ? c.kf.w.map(k => k.v).filter(v => v > 0) : [];
  const g = keys.length ? Math.max(1, Math.max(...keys) / b.w) : 1, cv = mtShapeDraw(x, b.w * d.w * g, b.h * d.h * g, d.h * g);
  const r = await api('text-png', {data: cv.toDataURL('image/png').split(',')[1]});
  if (r.error) { say('err', t('mt.secShape'), r.error); return null; }
  if (!mtFile(r.path)) mtKnown.set(mtKey(r.path), {name: base(r.path), dir: dirOf(r.path), path: r.path, size: 0, w: cv.width, h: cv.height, kind: 'p', bad: false, audio: false, reading: Promise.resolve()});
  return r;
}
// Прорисовка обводки: кадр на каждый кадр монтажа от начала клипа, последний — фигура целиком. Кадры в размер холста
// (запас резкости тут не нужен), те же картинки показывает просмотр. stale() — фигуру уже поменяли, кадры не нужны.
const MT_SEQ_MAX = 600;   // как shapeSeqMax в shapes.go
const mtShapeSeqs = new WeakMap();   // объект shape → {fps, urls}: копии клипа делят его
async function mtShapeSeqMake(x, c, stale) {
  const d = mvCanvasDims(), b = mvBox(c), fps = tkFps(), n = Math.min(Math.ceil(x.on.d * fps) + 1, MT_SEQ_MAX), urls = [];
  for (let i = 0; i < n; i++) {
    if (i % 8 === 0) { await new Promise(r => setTimeout(r)); if (stale()) return null; }   // окно не замирает на длинной прорисовке
    const part = i === n - 1 ? 1 : kfEase(x.on.e, Math.min(i / fps / x.on.d, 1));
    urls.push(mtShapeDraw(x, b.w * d.w, b.h * d.h, d.h, part, 1).toDataURL('image/png'));
  }
  const r = await api('shape-seq', {fps, frames: urls.map(u => u.split(',')[1])});
  if (r.error) { say('err', t('mt.secShape'), r.error); return null; }
  return {path: r.path, n, fps, urls};
}
const mtShapeTurn = new Map();
async function mtShapeRedraw(c) {
  const turn = (mtShapeTurn.get(c.id) || 0) + 1, x = c.shape;
  mtShapeTurn.set(c.id, turn);
  const stale = () => { const now = tkById(c.id); return !now || now.shape !== x || mtShapeTurn.get(c.id) !== turn; };
  const made = await mtShapeMake(x, c);
  const seq = made && x.on && x.sw > 0 && !stale() ? await mtShapeSeqMake(x, c, stale) : null;
  if (!made || stale()) return;   // новая рамка всегда приходит с новым объектом shape
  const now = tkById(c.id);
  if (seq) mtShapeSeqs.set(x, seq);
  const same = now.path === made.path && (seq ? now.seq === seq.path : !now.seq);
  if (same && !made.fresh) return;
  if (now.path === made.path) {   // файл убрала чистка кэша и он появился снова
    const pic = mv.pics.get(now.id), el = tkEls.get(now.id);
    if (pic) delete pic.dataset.url;
    if (el) delete el.dataset.sig;
  }
  now.path = made.path;
  if (seq) Object.assign(now, {seq: seq.path, seqN: seq.n, seqFps: seq.fps});
  else { delete now.seq; delete now.seqN; delete now.seqFps; }
  tkChanged();
}
// кадр прорисовки для просмотра в момент at; нет прорисовки или она кончилась — null, тогда фигура целиком
function mtShapeFrameUrl(c, at) {
  const s = c.shape && c.seq && mtShapeSeqs.get(c.shape);
  if (!s) return null;
  const i = Math.max(Math.floor((at - c.at) * s.fps + 1e-6), 0);
  return i < s.urls.length ? s.urls[i] : null;
}
// при воспроизведении: viewport.js (mvTick) меняет кадр прорисовки у видимых фигур
function mtShapeTick(at) {
  for (const [id, el] of mv.pics) {
    const c = tkById(id);
    if (c && c.seq && mvShown(c, at)) mvPicSrc(el, mtShapeFrameUrl(c, at) || mediaUrl(c.path));
  }
}
function mtShapeRefresh() { tkClips().filter(c => c.shape).forEach(mtShapeRedraw); }
// Рамку тянут: новая картинка не чаще, чем раз в 100 мс, последняя обязательно
let mtShapeBoxTimer = 0, mtShapeBoxId = 0;
function mtShapeBoxMove(c) {
  c.shape = {...c.shape};
  mtShapeBoxId = c.id;
  if (mtShapeBoxTimer) return;
  mtShapeBoxTimer = setTimeout(() => { mtShapeBoxTimer = 0; const now = tkById(mtShapeBoxId); if (now && now.shape) mtShapeRedraw(now); }, 100);
}
function mtShapePatch(patch) {
  const c = tkOne();
  if (!c || !c.shape) return;
  const x = {...c.shape, ...patch};
  if (x.k === 'path' && ('sw' in patch || 'a0' in patch || 'a1' in patch)) mtShapeFitWorld(c, x, mtShapeWorld(c));   // запас под толщину другой, точки на месте
  else c.shape = x;
  mtShapeRedraw(c);
}
const mtShapeDo = patch => tkDo(() => mtShapePatch(patch));

// ---------- панель ----------
function mtShapeFill() {
  const c = tkOne(), x = c && c.shape;
  $('mtShapeBox').classList.toggle('hide', !x);
  if (!x) return;
  $('mtShapeName').textContent = tkClipName(c);
  $('mtShapeFillOn').checked = x.fillOn;
  $('mtShapeFill').value = x.fill;
  $('mtShapeFill').disabled = !x.fillOn;
  mtVal('mtShapeSw', mtRnd(x.sw * 100, 2));
  $('mtShapeStroke').value = x.stroke;
  $('mtShapeDash').checked = x.dash;
  $('mtShapeRRow').classList.toggle('hide', x.k !== 'rect');
  mtVal('mtShapeR', mtRnd(x.r * 100, 1));
  $('mtShapeEndsRow').classList.toggle('hide', !mtShapeOpen(x));
  $('mtShapeEnds').value = (x.a0 ? 1 : 0) + (x.a1 ? 2 : 0);
  $('mtShapeClosedRow').classList.toggle('hide', x.k !== 'path' || x.pts.length < 3);
  $('mtShapeClosed').checked = x.closed;
  $('mtShapeOnOn').checked = !!x.on;
  $('mtShapeOnBox').classList.toggle('hide', !x.on);
  if (x.on) { mtVal('mtShapeOnD', mtRnd(x.on.d, 2)); $('mtShapeOnE').value = x.on.e; }
  $('mtShapeOnHint').classList.toggle('hide', !x.on || x.sw > 0);   // прорисовка рисует обводку
}
// Прорисовка: при включении 1 с с плавным началом и концом, длина не больше, чем помещается кадров (MT_SEQ_MAX)
const mtShapeOnMax = () => mtRnd((MT_SEQ_MAX - 1) / tkFps(), 1);
$('mtShapeOnOn').addEventListener('change', () => {
  const c = tkOne(), on = $('mtShapeOnOn').checked;
  if (!c || !c.shape) return;
  tkDo(() => {
    const x = {...c.shape};
    if (on) x.on = {d: Math.min(1, mtShapeOnMax()), e: 'inout'}; else delete x.on;
    if (on && !(x.sw > 0)) x.sw = .006;   // без обводки рисовать нечего
    c.shape = x;
    mtShapeRedraw(c);
  });
});
$('mtShapeOnE').addEventListener('change', () => { $('mtShapeOnE').blur(); const c = tkOne(); if (c && c.shape && c.shape.on) mtShapeDo({on: {...c.shape.on, e: $('mtShapeOnE').value}}); });
mtRow('mtShapeOnD', .05, v => { const c = tkOne(); if (c && c.shape && c.shape.on) mtShapePatch({on: {...c.shape.on, d: mtRnd(Math.min(Math.max(v, .1), mtShapeOnMax()), 2)}}); });
$('mtShapeFillOn').addEventListener('change', () => mtShapeDo({fillOn: $('mtShapeFillOn').checked}));
mtColor('mtShapeFill', v => mtShapePatch({fill: v}), true, true);
mtColor('mtShapeStroke', v => mtShapePatch({stroke: v}), true, true);
$('mtShapeDash').addEventListener('change', () => mtShapeDo({dash: $('mtShapeDash').checked}));
$('mtShapeEnds').addEventListener('change', () => { $('mtShapeEnds').blur(); const v = +$('mtShapeEnds').value; mtShapeDo({a0: !!(v & 1), a1: !!(v & 2)}); });
mtRow('mtShapeSw', .05, v => mtShapePatch({sw: mtRnd(Math.min(Math.max(v, 0), 10) / 100, 5)}));
mtRow('mtShapeR', .1, v => mtShapePatch({r: mtRnd(Math.min(Math.max(v, 0), 50) / 100, 4)}));

// ---------- инструмент: кнопка со списком видов, U; тяга в кадре задаёт рамку или концы линии ----------
let mtShapeOn = false, mtShapeKind = 'rect';
try { if (MT_SHAPE_KINDS.includes(localStorage.getItem('kb.shapeKind'))) mtShapeKind = localStorage.getItem('kb.shapeKind'); } catch (e) {}
const MT_SHAPE_ICONS = {
  rect: '<rect x="4" y="6" width="16" height="12" rx="2"/>',
  ell: '<ellipse cx="12" cy="12" rx="8.5" ry="6.5"/>',
  line: '<path d="M5 19L19 5"/>',
  arrow: '<path d="M5 19L19 5M11 5h8v8"/>',
};
function mtShapeBtn() {
  $('mtShapeIcon').innerHTML = MT_SHAPE_ICONS[mtShapeKind];
  $('mtShape').classList.toggle('on', mtShapeOn);
  document.querySelectorAll('#mtShapeMenu [data-shape]').forEach(b => {
    b.classList.toggle('on', b.dataset.shape === mtShapeKind);
    const s = b.querySelector('svg');
    if (s && !s.innerHTML) s.innerHTML = MT_SHAPE_ICONS[b.dataset.shape];   // в меню значки, подписи в title
  });
}
function mtShapeTool(on) {
  if (on === mtShapeOn) return;
  mtShapeOn = on;
  mtShapeLine = mtShapeGhost = null;
  if (on) { mtTextTool(false); mtPenTool(false); mtPtsTool(false); mvFileOff(); if (chromaPicking()) { chromaPickToggle(); mtFramePanel(); } }
  mvStage.classList.toggle('mv-shaping', on);
  mtShapeBtn();
  mtSegSync();
  mtPtsDraw();   // при фигуре точки выбранного пути не нужны
}
const mtShapeMenuShow = on => $('mtShapeMenu').classList.toggle('hide', !on);
$('mtShape').onclick = () => mtShapeTool(!mtShapeOn);
$('mtShapeMore').onclick = e => {
  e.stopPropagation();
  const m = $('mtShapeMenu'), open = m.classList.contains('hide');
  mtShapeMenuShow(open);
  if (!open) return;
  const r = $('mtShapeMore').getBoundingClientRect();   // над кнопкой, у края окна не вылезает
  Object.assign(m.style, {left: Math.max(Math.min(r.left, innerWidth - m.offsetWidth - 8), 8) + 'px', top: Math.max(r.top - m.offsetHeight - 4, 8) + 'px'});
};
document.addEventListener('pointerdown', e => { if (!e.target.closest('#mtShapeMenu,#mtShapeMore')) mtShapeMenuShow(false); });
$('mtShapeMenu').addEventListener('click', e => {
  const b = e.target.closest('[data-shape]');
  if (!b) return;
  mtShapeKind = b.dataset.shape;
  try { localStorage.setItem('kb.shapeKind', mtShapeKind); } catch (e) {}
  mtShapeMenuShow(false);
  mtShapeOn = false;
  mtShapeTool(true);
});

// Слой поверх кадра для того, что ещё рисуется: рамка будущей фигуры, точки и ручки пера
const mvDraw = $('mvDraw');
function mvDrawPlace() {
  Object.assign(mvDraw.style, {left: mvCv.offsetLeft + 'px', top: mvCv.offsetTop + 'px', width: mvCv.offsetWidth + 'px', height: mvCv.offsetHeight + 'px'});
  mvDraw.setAttribute('viewBox', `0 0 ${mvCv.offsetWidth} ${mvCv.offsetHeight}`);
}
// мышь в долях кадра, без ограничения краями
function mvAt(e) { const r = mvCv.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; }
// Shift: квадрат и круг, у линии угол кратен 45°
function mtShapeEnds(kind, a, b, shift, W, H) {
  let [x1, y1] = b;
  if (shift) {
    const dx = (x1 - a[0]) * W, dy = (y1 - a[1]) * H;
    if (kind === 'line' || kind === 'arrow') {
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4, len = Math.hypot(dx, dy);
      x1 = a[0] + Math.cos(ang) * len / W; y1 = a[1] + Math.sin(ang) * len / H;
    } else {
      const s = Math.max(Math.abs(dx), Math.abs(dy));
      x1 = a[0] + Math.sign(dx || 1) * s / W; y1 = a[1] + Math.sign(dy || 1) * s / H;
    }
  }
  return [x1, y1];
}
// Будущая фигура поверх кадра: {kind, a, b}, концы в долях кадра. Линия контрастная, видна и на фигуре того же цвета.
let mtShapeGhost = null;
// Линия или стрелка двумя щелчками: {kind, a, m} — начало стоит, конец идёт за мышью (m — где мышь), второй щелчок ставит конец
let mtShapeLine = null;
// Невидимые круги захвата вокруг значков {x, y, cls, data, see, under?, tip?}: радиус до R точек экрана, но не больше половины
// расстояния до соседнего значка, чтобы зоны не перекрывались (не меньше 3: точки ближе 6 px и так сливаются). Круг стоит перед значком: при наведении значок подсвечивается.
function mvHits(list, R = 10) {
  return list.map(a => {
    let r = R;
    for (const b of list) if (b !== a) r = Math.min(r, Math.hypot(a.x - b.x, a.y - b.y) / 2);
    return (a.under || '') + `<circle class="${a.cls} mv-hit" ${a.data} cx="${a.x}" cy="${a.y}" r="${Math.max(r, 3).toFixed(1)}">${a.tip ? `<title>${a.tip}</title>` : ''}</circle>` + a.see;
  }).join('');
}
const mvDual = (tag, attrs) =>`<${tag} class="mv-draw-under" ${attrs}/><${tag} class="mv-draw-line" ${attrs}/>`;
function mtShapeGhostDraw() {
  const g = mtShapeGhost;
  if (!g) { if (mvDraw.innerHTML) mvDraw.innerHTML = ''; return; }
  mvDrawPlace();
  const W = mvCv.offsetWidth, H = mvCv.offsetHeight, {kind, a, b} = g, f = v => +v.toFixed(1);
  if (kind === 'line' || kind === 'arrow') { mvDraw.innerHTML = mvDual('line', `x1="${f(a[0] * W)}" y1="${f(a[1] * H)}" x2="${f(b[0] * W)}" y2="${f(b[1] * H)}"`); return; }
  const x = Math.min(a[0], b[0]) * W, y = Math.min(a[1], b[1]) * H, w = Math.abs(b[0] - a[0]) * W, h = Math.abs(b[1] - a[1]) * H;
  mvDraw.innerHTML = kind === 'ell' ? mvDual('ellipse', `cx="${f(x + w / 2)}" cy="${f(y + h / 2)}" rx="${f(w / 2)}" ry="${f(h / 2)}"`) : mvDual('rect', `x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}"`);
}
// конец линии, которую ставят двумя щелчками, по мыши m (в долях кадра)
function mtShapeLineAt(m, shift) {
  const L = mtShapeLine;
  L.m = m;
  mtShapeGhost = {kind: L.kind, a: L.a, b: mtShapeEnds(L.kind, L.a, m, shift, mvCv.offsetWidth, mvCv.offsetHeight)};
  mtShapeGhostDraw();
}
mvStage.addEventListener('pointermove', e => { if (mtShapeLine && !e.buttons) mtShapeLineAt(mvAt(e), e.shiftKey); });
['keydown', 'keyup'].forEach(ty => document.addEventListener(ty, e => { if (mtShapeLine && e.key === 'Shift') mtShapeLineAt(mtShapeLine.m, e.shiftKey); }));
$('mtStage').addEventListener('pointerdown', e => {
  if (!mtShapeOn || e.button !== 0 || mvHand) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const W = mvCv.offsetWidth, H = mvCv.offsetHeight;
  if (mtShapeLine) {   // второй щелчок: конец линии. Щелчок на месте начала — линия обычной длины
    const {kind, a} = mtShapeLine, b = mtShapeEnds(kind, a, mvAt(e), e.shiftKey, W, H), tiny = Math.hypot((b[0] - a[0]) * W, (b[1] - a[1]) * H) < KIN.drag;
    mtShapeTool(false);
    mtShapeAdd(kind, a, tiny ? null : b);
    return;
  }
  const kind = mtShapeKind, a = mvAt(e), line = kind === 'line' || kind === 'arrow';
  let moved = false;
  const move = ev => {
    if (ev.pointerId !== e.pointerId) return;
    if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < KIN.drag) return;
    moved = true;
    mtShapeGhost = {kind, a, b: mtShapeEnds(kind, a, mvAt(ev), ev.shiftKey, W, H)};
    mtShapeGhostDraw();
  };
  const end = ev => {
    if (ev.pointerId !== e.pointerId) return;
    mvStage.removeEventListener('pointermove', move);
    mvStage.removeEventListener('pointerup', end);
    mvStage.removeEventListener('pointercancel', end);
    const b = moved && mtShapeGhost ? mtShapeGhost.b : null;
    mtShapeGhost = null;
    mtShapeGhostDraw();
    if (ev.type === 'pointercancel') return;
    if (line && !b) { mtShapeLine = {kind, a, m: a}; mtShapeLineAt(mvAt(ev), ev.shiftKey); return; }   // щелчок: ждём конец
    mtShapeTool(false);
    mtShapeAdd(kind, a, b);
  };
  mvStage.setPointerCapture(e.pointerId);
  mvStage.addEventListener('pointermove', move);
  mvStage.addEventListener('pointerup', end);
  mvStage.addEventListener('pointercancel', end);
}, true);

// Новый слой-фигура с текущего места на верхней дорожке, если там занято — на новой. b нет — щелчок: фигура обычного размера серединой в a.
const MT_SHAPE_NEW = {fill: '#e9b872', fillOn: true, stroke: '#ffffff', sw: 0, r: 0, pts: null, closed: false, a0: false, a1: false, dash: false};
function mtShapeAdd(kind, a, b) {
  const d = mvCanvasDims(), H = d.h, W = d.w, line = kind === 'line' || kind === 'arrow';
  if (!b) {   // щелчок: квадрат в четверть высоты или линия в треть ширины
    const s = .25 * H;
    b = line ? [a[0] + s * .7 / W, a[1] - s * .7 / H] : [a[0] + s / 2 / W, a[1] + s / 2 / H];
    if (!line) a = [a[0] - s / 2 / W, a[1] - s / 2 / H];
  }
  const c = {id: 0, path: '', at: tkAt, from: 0, len: TK_PHOTO, speed: 1, reverse: false, src: 0};
  if (line) {
    const x = {...MT_SHAPE_NEW, k: 'path', fillOn: false, sw: .006, a1: kind === 'arrow'};
    const p = (u, v) => [u * W, v * H, u * W, v * H, u * W, v * H];
    mtShapeFit(c, x, [p(...a), p(...b)]);
  } else {
    const x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1]);
    c.shape = {...MT_SHAPE_NEW, k: kind};
    Object.assign(c, {x: x0, y: y0, w: Math.max(Math.abs(b[0] - a[0]), MV_MIN_BOX), h: Math.max(Math.abs(b[1] - a[1]), MV_MIN_BOX)});
  }
  mtShapePut(c);
}
// Слой готов, нужна только картинка: кладём на дорожку одним шагом отмены
const mtShapePut = c => dialog(async () => {
  const made = await mtShapeMake(c.shape, c);
  if (!made) return;
  const v = tkTracks.filter(tr => tr.kind === 'v'), top = v[v.length - 1];
  const busy = top.off || top.clips.some(q => q.at < c.at + TK_PHOTO && tkEnd(q) > c.at), alone = !tkCanvas && !tkClips().some(q => !q.text && !q.shape), dims = mvCanvasDims();
  tkDo(() => {
    if (alone) tkCanvas = {w: dims.w, h: dims.h};   // иначе холст взял бы размер самой фигуры
    let row = top;
    if (busy) { row = {kind: 'v', thin: false, clips: []}; tkTracks.splice(v.length, 0, row); }
    Object.assign(c, {id: tkNext++, path: made.path});
    row.clips.push(c);
    tkSel = new Set([c.id]);
  });
  mtTab = 'frame';
  mtTabs();
  document.querySelector('details[data-sec=shape]').open = true;
});

// ---------- перо: щелчок — угловая точка, тяга — гладкая с ручками, щелчок по первой замыкает ----------
// Точки пера и правка точек считаются в пикселях холста «как видно», с поворотом слоя. Слой хранит их без поворота.
const mtRotP = (x, y, a, cx, cy) => { const s = Math.sin(a), k = Math.cos(a), dx = x - cx, dy = y - cy; return [cx + dx * k - dy * s, cy + dx * s + dy * k]; };
const mtRot6 = (p, a, cx, cy) => [...mtRotP(p[0], p[1], a, cx, cy), ...mtRotP(p[2], p[3], a, cx, cy), ...mtRotP(p[4], p[5], a, cx, cy)];
function mtShapeWorld(c) {
  const abs = c.shape.k === 'path' ? mtShapeAbs(c) : mtShapeRimPts(c), a = (c.rot || 0) * Math.PI / 180;
  if (!a) return abs;
  const d = mvCanvasDims(), b = mvBox(c), cx = (b.x + b.w / 2) * d.w, cy = (b.y + b.h / 2) * d.h;
  return abs.map(p => mtRot6(p, a, cx, cy));
}
// Обратно с поворотом: середина новой рамки такая, чтобы повёрнутый слой показал точки ровно там, где они видны
function mtShapeFitWorld(c, x, world) {
  const a = (c.rot || 0) * Math.PI / 180;
  if (!a) { mtShapeFit(c, x, world); return; }
  mtShapeFit(c, x, world.map(p => mtRot6(p, -a, 0, 0)));
  const d = mvCanvasDims(), qx = (c.x + c.w / 2) * d.w, qy = (c.y + c.h / 2) * d.h, [cx, cy] = mtRotP(qx, qy, a, 0, 0);
  c.x += (cx - qx) / d.w;
  c.y += (cy - qy) / d.h;
}

let mtPenOn = false, mtPen = null;   // mtPen: {pts, hover} — путь, который сейчас рисуют
// Кнопка «Перо» — выбор из двух инструментов: перо и правка вектора; показывает последний выбранный
let mtPenMode = 'pen';
try { if (localStorage.getItem('kb.penMode') === 'edit') mtPenMode = 'edit'; } catch (e) {}
const MT_PEN_ICONS = {
  pen: '<path d="M12 3l6 8-6 10-6-10zM12 3v8"/><circle cx="12" cy="13" r="1.6"/>',
  edit: '<path d="M6 3v13.5l3.6-3.4 2.5 5.6 2.4-1.1-2.5-5.4H17.5z"/><rect x="16.5" y="16.5" width="4" height="4" rx=".6"/>',
};
function mtPenTool(on) {
  if (on === mtPenOn) return;
  mtPenOn = on;
  if (on) { mtPenMode = 'pen'; mtTextTool(false); mtShapeTool(false); mtPtsTool(false); mvFileOff(); if (chromaPicking()) { chromaPickToggle(); mtFramePanel(); } }
  else mtPenEnd(false);
  mvStage.classList.toggle('mv-pen', on);
  mtSegSync();
  mtPtsCls();
  mtPtsDraw();
}
// Подсветка кнопок рисования и «Выбор» в панели: включён ровно один инструмент
function mtSegSync(init) {
  const edit = mtPenMode === 'edit';
  $('mtPenIcon').innerHTML = MT_PEN_ICONS[mtPenMode];
  $('mtPen').classList.toggle('on', edit ? mtPtsOn : mtPenOn);
  document.querySelectorAll('#mtPenMenu [data-pen]').forEach(b => {
    b.classList.toggle('on', b.dataset.pen === mtPenMode);
    const s = b.querySelector('svg');
    if (s && !s.innerHTML) s.innerHTML = MT_PEN_ICONS[b.dataset.pen];
  });
  if (!init) tkBar();
}
// «Выбор» подсвечен, только когда не включён никакой другой инструмент (рисование, текст, правка точек, градиент)
const mtToolBusy = () => mtShapeOn || mtPenOn || mtPtsOn || (typeof mtTextOn !== 'undefined' && mtTextOn) || mtGradOn;
const mtPenGo = on => mtPenMode === 'edit' ? mtPtsTool(on) : mtPenTool(on);
$('mtPen').onclick = () => mtPenGo(mtPenMode === 'edit' ? !mtPtsOn : !mtPenOn);
const mtPenMenuShow = on => $('mtPenMenu').classList.toggle('hide', !on);
$('mtPenMore').onclick = e => {
  e.stopPropagation();
  const m = $('mtPenMenu'), open = m.classList.contains('hide');
  mtPenMenuShow(open);
  if (!open) return;
  const r = $('mtPenMore').getBoundingClientRect();
  Object.assign(m.style, {left: Math.max(Math.min(r.left, innerWidth - m.offsetWidth - 8), 8) + 'px', top: Math.max(r.top - m.offsetHeight - 4, 8) + 'px'});
};
document.addEventListener('pointerdown', e => { if (!e.target.closest('#mtPenMenu,#mtPenMore')) mtPenMenuShow(false); });
$('mtPenMenu').addEventListener('click', e => {
  const b = e.target.closest('[data-pen]');
  if (!b) return;
  mtPenMenuShow(false);
  const mode = b.dataset.pen;
  mtPenOn && mtPenTool(false); mtPtsOn && mtPtsTool(false);   // старый инструмент выключен, новый включается
  mtPenMode = mode;
  try { localStorage.setItem('kb.penMode', mode); } catch (e) {}
  mtPenGo(true);
});
const mvPx = e => { const d = mvCanvasDims(), [u, v] = mvAt(e); return [u * d.w, v * d.h]; };
const mvScreenK = () => mvCv.offsetWidth / mvCanvasDims().w;   // пикселей экрана на пиксель холста
// Путь готов: замкнутый с заливкой, открытый — линия. Меньше двух точек — ничего.
function mtPenEnd(closed) {
  const pen = mtPen;
  mtPen = null;
  mvStage.classList.remove('pen-close');
  mtPtsDraw();
  if (!pen || pen.pts.length < 2) return;
  const c = {id: 0, path: '', at: tkAt, from: 0, len: TK_PHOTO, speed: 1, reverse: false, src: 0};
  mtShapeFit(c, {...MT_SHAPE_NEW, k: 'path', closed, fillOn: closed, sw: closed ? 0 : .006}, pen.pts);
  if (mtPenOn) { mtPenOn = false; mvStage.classList.remove('mv-pen'); $('mtPen').classList.remove('on'); mtSegSync(); mtPtsCls(); }
  mtShapePut(c);
}
$('mtStage').addEventListener('pointerdown', e => {
  if (!mtPenOn || e.button !== 0 || mvHand) return;
  if (e.altKey) {   // Alt: правка точек, точку тянет обработчик mvDraw, мимо точек — ничего
    if (!e.target.closest('.mv-pt')) { e.preventDefault(); e.stopImmediatePropagation(); }
    return;
  }
  e.preventDefault();
  e.stopImmediatePropagation();
  const p = mvPx(e), near = (q, r) => Math.hypot(q[0] - p[0], q[1] - p[1]) * mvScreenK() <= r;
  if (!mtPen) mtPen = {pts: [], hover: null, close: false};
  const pts = mtPen.pts;
  if (mtPenCanClose(p)) {   // первая точка: щелчок замыкает углом, тяга тянет её ручки, отпускание замыкает
    const f = pts[0], keep = f.slice();
    mtPen.close = true;
    mtPenDrag(e, f, ok => { if (ok) mtPenEnd(true); else { f.splice(0, 6, ...keep); mtPtsDraw(); } });
    return;
  }
  if (pts.length && near(pts[pts.length - 1], 3)) { mtPenEnd(false); return; }   // второй щелчок на месте последней точки — конец
  const pt = [p[0], p[1], p[0], p[1], p[0], p[1]];
  pts.push(pt);
  mtPen.hover = null;
  mtPtsDraw();
  mtPenDrag(e, pt, () => {});
}, true);
// над первой точкой, и точек уже две: путь можно замкнуть
const mtPenCanClose = p => !!mtPen && mtPen.pts.length >= 2 && Math.hypot(mtPen.pts[0][0] - p[0], mtPen.pts[0][1] - p[1]) * mvScreenK() <= 8;
// Тяга от точки pt: ручки по мыши, выход — куда тянут, вход — зеркально. done(true) — отпустили, done(false) — отмена
function mtPenDrag(e, pt, done) {
  const p = [pt[0], pt[1]];
  const move = ev => {
    if (ev.pointerId !== e.pointerId) return;
    const q = mvPx(ev);
    if (Math.hypot(q[0] - p[0], q[1] - p[1]) * mvScreenK() < KIN.drag) return;
    pt[4] = q[0]; pt[5] = q[1]; pt[2] = 2 * p[0] - q[0]; pt[3] = 2 * p[1] - q[1];
    mtPtsDraw();
  };
  const end = ev => {
    if (ev.pointerId !== e.pointerId) return;
    mvStage.removeEventListener('pointermove', move);
    mvStage.removeEventListener('pointerup', end);
    mvStage.removeEventListener('pointercancel', end);
    done(ev.type !== 'pointercancel');
  };
  mvStage.setPointerCapture(e.pointerId);
  mvStage.addEventListener('pointermove', move);
  mvStage.addEventListener('pointerup', end);
  mvStage.addEventListener('pointercancel', end);
}
// Мышь без нажатия: кусок пути за мышью; над первой точкой у курсора колечко и кусок показывает, как путь замкнётся
mvStage.addEventListener('pointermove', e => {
  if (!mtPen || e.buttons) return;
  const p = mvPx(e);
  mtPen.close = mtPenCanClose(p);
  mtPen.hover = p;
  mvStage.classList.toggle('pen-close', mtPen.close);
  mtPtsDraw();
});
// Enter — конец открытого пути, Esc — конец или отмена, Backspace — убрать последнюю точку. Раньше хоткеев дорожек.
document.addEventListener('keydown', e => {
  if (!mtPenOn || tkTyping(e.target)) return;
  if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Escape') { mtPenEnd(false); mtPenTool(false); }
  else if ((e.code === 'Backspace' || e.code === 'Delete') && mtPen && mtPen.pts.length) { mtPen.pts.pop(); mtPtsDraw(); }
  else return;
  e.preventDefault();
  e.stopImmediatePropagation();
}, true);

// ---------- правка точек: стрелка A, как «Direct Selection» в Illustrator; в пере то же, пока зажат Alt ----------
// Точки и ручки выбранной фигуры видны и тянутся только здесь. Рамки слоя нет, щелчок мимо точек не выбирает другие слои
// (щелчок по другой фигуре выбирает её). Прямоугольник и эллипс показывают точки пути и становятся путём при первой правке.
let mtPtsOn = false, mtAlt = false;
const mtPtsMode = () => mtPtsOn || (mtPenOn && mtAlt);
function mtPtsCls() { mvStage.classList.toggle('mv-ptsel', mtPtsMode()); }
function mtPtsTool(on) {
  if (on === mtPtsOn) return;
  mtPtsOn = on;
  if (on) { mtPenMode = 'edit'; mtTextTool(false); mtShapeTool(false); mtPenTool(false); mvFileOff(); if (chromaPicking()) { chromaPickToggle(); mtFramePanel(); } }
  $('mtShapeEdit').classList.toggle('on', on);
  mtSegSync();
  mtPtsCls();
  mvFrameDraw();   // рамка прячется или возвращается, точки рисует mtPtsDraw
}
$('mtShapeEdit').onclick = () => mtPtsTool(!mtPtsOn);
mtSegSync(true);   // значок и подсветка кнопки пера при загрузке (mtPtsOn уже объявлен)
// Alt в пере: пока зажат, точки тянутся, а не ставятся
function mtAltSet(on) {
  if (mtAlt === on) return;
  mtAlt = on;
  if (mtPenOn) { mtPtsCls(); mtPtsDraw(); }
}
document.addEventListener('keydown', e => { if (e.key === 'Alt') { mtAltSet(true); if (mtPenOn) e.preventDefault(); } }, true);
document.addEventListener('keyup', e => { if (e.key === 'Alt') mtAltSet(false); }, true);
addEventListener('blur', () => mtAltSet(false));
mvStage.addEventListener('pointermove', e => { if (mtPenOn) mtAltSet(e.altKey); }, true);   // Alt отпустили вне окна
// Esc выходит из правки точек, выбор слоя остаётся. Раньше хоткеев дорожек.
document.addEventListener('keydown', e => {
  if (!mtPtsOn || e.code !== 'Escape' || tab !== 'mont' || tkTyping(e.target) || document.querySelector('.modal:not(.hide)')) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  mtPtsTool(false);
}, true);

// ---------- точки и ручки: рисуются поверх кадра, тянутся в режиме правки точек ----------
const mtPtsClip = () => { if (!mtPtsMode() || mtPen || mtShapeOn) return null; const c = mvFrameClip(); return c && c.shape && mv.crop !== c.id ? c : null; };
const mtSmooth = p => p[2] !== p[0] || p[3] !== p[1] || p[4] !== p[0] || p[5] !== p[1];
// Всё в точках экрана поверх кадра, у линий тёмная подложка: видно и на фигуре того же цвета, что и линии
function mtPtsDraw() {
  if (mtShapeOn) { mtShapeGhostDraw(); return; }
  const c = mtPtsClip(), pts = mtPen ? mtPen.pts : c ? mtShapeWorld(c) : null;
  if (!pts || !pts.length) { if (mvDraw.innerHTML) mvDraw.innerHTML = ''; return; }
  mvDrawPlace();
  const k = mvScreenK(), f = v => +(v * k).toFixed(1), seg = (a, b) => `C${f(a[4])} ${f(a[5])} ${f(b[2])} ${f(b[3])} ${f(b[0])} ${f(b[1])}`, arms = [], dots = [];
  const closed = mtPen ? false : mtShapePathOf(c.shape).closed, cnt = closed ? pts.length : pts.length - 1;
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 0; i < cnt; i++) d += seg(pts[i], pts[(i + 1) % pts.length]);
  if (mtPen && mtPen.close) d += seg(pts[pts.length - 1], pts[0]);   // так путь замкнётся
  else if (mtPen && mtPen.hover && !mtAlt) { const h = mtPen.hover; d += seg(pts[pts.length - 1], [h[0], h[1], h[0], h[1]]); }
  // Каждой точке и ручке — невидимый круг захвата (mvHits): нажимает и подсвечивает он, значок остаётся маленьким
  const hits = [];
  pts.forEach((p, i) => {
    if (mtSmooth(p)) for (const h of [2, 4]) {
      const xy = `x1="${f(p[0])}" y1="${f(p[1])}" x2="${f(p[h])}" y2="${f(p[h + 1])}"`;
      arms.push(`<line class="mv-draw-armu" ${xy}/><line class="mv-draw-arm" ${xy}/>`);
      hits.push({x: f(p[h]), y: f(p[h + 1]), cls: 'mv-pt h', data: `data-i="${i}" data-h="${h}"`, see: `<circle class="mv-pt h see" cx="${f(p[h])}" cy="${f(p[h + 1])}" r="3.5"/>`});
    }
  });
  pts.forEach((p, i) => {
    const x = f(p[0]), y = f(p[1]), first = i === 0 && mtPen ? ' first' : '';
    hits.push({x, y, cls: 'mv-pt' + first, data: `data-i="${i}"`, under: `<rect class="mv-pt-under" x="${x - 5.5}" y="${y - 5.5}" width="11" height="11"/>`, see: `<rect class="mv-pt${first} see" x="${x - 4}" y="${y - 4}" width="8" height="8"/>`});
  });
  mvDraw.innerHTML = mvDual('path', `d="${d}${closed ? 'Z' : ''}"`) + arms.join('') + mvHits(hits);
}
// Тяга точки i (h — ручка 2 или 4, 0 — сама точка) от точек start: точка едет с ручками, ручка гладкой точки
// поворачивает и вторую по той же прямой, brk — ломает. put(pts) — показать новые точки, done(moved) — отпустили.
function mtPtsDrag(e, i, h, start, brk, put, done) {
  const sp = start[i], p0 = mvPx(e), turn = Math.abs(Math.atan2(sp[3] - sp[1], sp[2] - sp[0]) - Math.atan2(sp[5] - sp[1], sp[4] - sp[0]));
  const smooth = h && !brk && Math.abs(turn - Math.PI) < .05;   // ручки на одной прямой — гладкая точка
  let on = false;
  const move = ev => {
    if (ev.pointerId !== e.pointerId) return;
    const q = mvPx(ev), dx = q[0] - p0[0], dy = q[1] - p0[1];
    if (!on && Math.hypot(dx, dy) * mvScreenK() < KIN.drag) return;
    on = true;
    const pts = start.map(p => p.slice()), p = pts[i];
    if (!h) for (let j = 0; j < 6; j += 2) { p[j] += dx; p[j + 1] += dy; }
    else {
      p[h] += dx; p[h + 1] += dy;
      if (smooth) {
        const o = h === 2 ? 4 : 2, len = Math.hypot(sp[o] - p[0], sp[o + 1] - p[1]), a = Math.atan2(p[h + 1] - p[1], p[h] - p[0]);
        p[o] = p[0] - Math.cos(a) * len; p[o + 1] = p[1] - Math.sin(a) * len;
      }
    }
    put(pts);
  };
  const end = ev => {
    if (ev.pointerId !== e.pointerId) return;
    mvDraw.removeEventListener('pointermove', move);
    mvDraw.removeEventListener('pointerup', end);
    mvDraw.removeEventListener('pointercancel', end);
    done(on);
  };
  mvDraw.setPointerCapture(e.pointerId);
  mvDraw.addEventListener('pointermove', move);
  mvDraw.addEventListener('pointerup', end);
  mvDraw.addEventListener('pointercancel', end);
}
// Двойной щелчок по точке: угол ↔ гладкая. Alt+щелчок — убрать точку. Ctrl+щелчок по линии пути — новая точка.
// В пере с Alt тянутся и точки пути, который ещё рисуют; ручка там ломается (Alt и так зажат).
mvDraw.addEventListener('pointerdown', e => {
  const el = e.target.closest('.mv-pt');
  if (!el || e.button !== 0 || !mtPtsMode()) return;
  const i = +el.dataset.i, h = el.dataset.h ? +el.dataset.h : 0;
  if (mtPen) {
    e.preventDefault();
    e.stopPropagation();
    const pts = mtPen.pts;
    mtPtsDrag(e, i, h, pts.map(p => p.slice()), true, next => { pts.splice(0, pts.length, ...next); mtPtsDraw(); }, () => {});
    return;
  }
  const c = mtPtsClip();
  if (!c) return;
  e.preventDefault();
  e.stopPropagation();
  const before = tkState(), start = mtShapeWorld(c);
  if (!h && e.altKey && mtPtsOn) {
    if (start.length > 2) tkDo(() => { mtShapeFitWorld(c, mtShapePathOf(c.shape), start.filter((_, j) => j !== i)); mtShapeRedraw(c); });
    return;
  }
  mtPtsDrag(e, i, h, start, e.altKey, pts => { mtShapeFitWorld(c, mtShapePathOf(c.shape), pts); mtShapeBoxMove(c); mvPlaceClip(c); mvFrameDraw(); },
    moved => { if (moved) { tkCommit(before); mtFramePanel(); } });
});
mvDraw.addEventListener('dblclick', e => {
  const el = e.target.closest('.mv-pt:not(.h)'), c = mtPtsOn && mtPtsClip();
  if (!el || !c) return;
  e.stopPropagation();
  const x = mtShapePathOf(c.shape), i = +el.dataset.i, pts = mtShapeWorld(c), p = pts[i];
  if (mtSmooth(p)) p.splice(2, 4, p[0], p[1], p[0], p[1]);
  else {   // ручки вдоль соседей, по трети расстояния до них
    const n = pts.length, prev = pts[x.closed ? (i - 1 + n) % n : Math.max(i - 1, 0)], next = pts[x.closed ? (i + 1) % n : Math.min(i + 1, n - 1)];
    const dx = next[0] - prev[0], dy = next[1] - prev[1], len = Math.hypot(dx, dy) || 1;
    const li = Math.hypot(p[0] - prev[0], p[1] - prev[1]) / 3, lo = Math.hypot(next[0] - p[0], next[1] - p[1]) / 3;
    p.splice(2, 4, p[0] - dx / len * li, p[1] - dy / len * li, p[0] + dx / len * lo, p[1] + dy / len * lo);
  }
  tkDo(() => { mtShapeFitWorld(c, x, pts); mtShapeRedraw(c); });
});
// Ctrl+щелчок по пути выбранного слоя: точка в ближайшем месте кривой, форма не меняется (деление де Кастельжо)
$('mtStage').addEventListener('pointerdown', e => {
  const c = mtPtsOn && mtPtsClip();
  if (!c || !(e.ctrlKey || e.metaKey) || e.button !== 0) return;
  const xs = mtShapePathOf(c.shape), pts = mtShapeWorld(c), q = mvPx(e), k = mvScreenK(), cnt = xs.closed ? pts.length : pts.length - 1;
  let best = null;
  for (let i = 0; i < cnt; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    for (let s = 1; s < 64; s++) {
      const t = s / 64, u = 1 - t, x = u * u * u * a[0] + 3 * u * u * t * a[4] + 3 * u * t * t * b[2] + t * t * t * b[0], y = u * u * u * a[1] + 3 * u * u * t * a[5] + 3 * u * t * t * b[3] + t * t * t * b[1];
      const d = Math.hypot(x - q[0], y - q[1]) * k;
      if (!best || d < best.d) best = {d, i, t};
    }
  }
  if (!best || best.d > 8) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const {i, t} = best, a = pts[i], b = pts[(i + 1) % pts.length], L = (p, r) => [p[0] + (r[0] - p[0]) * t, p[1] + (r[1] - p[1]) * t];
  const p1 = L([a[0], a[1]], [a[4], a[5]]), p2 = L([a[4], a[5]], [b[2], b[3]]), p3 = L([b[2], b[3]], [b[0], b[1]]), m1 = L(p1, p2), m2 = L(p2, p3), m = L(m1, m2);
  a[4] = p1[0]; a[5] = p1[1]; b[2] = p3[0]; b[3] = p3[1];
  pts.splice(i + 1, 0, [m[0], m[1], m1[0], m1[1], m2[0], m2[1]]);
  tkDo(() => { mtShapeFitWorld(c, xs, pts); mtShapeRedraw(c); });
}, true);
// Остальные щелчки в правке точек: по другой фигуре — выбрать её, мимо — ничего (слой под мышью не выбирается и не едет)
$('mtStage').addEventListener('pointerdown', e => {
  if (!mtPtsOn || e.button !== 0 || mvHand || e.target.closest('.mv-pt')) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  if (mv.playing) mvPause();
  const top = mvHit(e);
  if (top && top.shape && !tkSel.has(top.id)) { tkSel = new Set(tkIds(top)); tkSelChanged(); }
}, true);
// двойной щелчок по фигуре — правка её точек
$('mtStage').addEventListener('dblclick', e => {
  const c = mvFrameClip();
  if (mtPtsOn || mtPenOn || mtShapeOn || mtTextOn || !c || !c.shape || !mvInside(c, e)) return;
  e.stopImmediatePropagation();
  mtPtsTool(true);
}, true);

// замкнуть или разомкнуть путь
$('mtShapeClosed').addEventListener('change', () => {
  const c = tkOne();
  if (!c || !c.shape || c.shape.k !== 'path') return;
  tkDo(() => { const pts = mtShapeWorld(c); mtShapeFitWorld(c, {...c.shape, closed: $('mtShapeClosed').checked}, pts); mtShapeRedraw(c); });
});

// весь код выше уже выполнен: другие файлы могут звать функции фигур (var, чтобы до этой строки было просто undefined)
mtShapeBtn();
var mtShapesReady = true;
