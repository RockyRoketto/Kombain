// ---------- переходы на краю клипа в просмотре монтажа ----------
// Правила те же, что в tlTransitions (transitions.go), вид повторяет фильтр xfade на CSS: прозрачность, clip-path, transform, маска.
// У стыка оба клипа видны сразу: левый (A) дольше своего конца, правый (B) раньше своего начала, кадры файла за краями
// (mvTime продолжается за край, где файла нет, стоит первый или последний кадр). A лежит над B, плашка чёрного или белого над обоими.
// Прогресс P как у xfade: 1 в начале перехода, 0 в конце.

// Переходы всех дорожек: id клипа → {i, o}, край {k: вид, h, cut}. У стыка h — половина перехода (столько за краем и столько до него),
// у свободного края весь переход внутри клипа
function mvTrMap() {
  const out = new Map(), ok = t => t && TK_TRANS.includes(t.k) && t.d > 0, dur = t => Math.min(t.d, TK_TRANS_MAX);
  for (const tr of tkTracks) {
    if (tr.off) continue;
    const list = [...tr.clips].sort((a, b) => a.at - b.at), e = list.map(() => ({i: null, o: null}));
    // вплотную: картинка с картинкой одного режима наложения, звук со звуком (tlMeet)
    const meet = (a, b) => Math.abs(tkEnd(a) - b.at) < 1e-3 && (tr.kind === 'a' || (a.blend || '') === (b.blend || ''));
    list.forEach((c, n) => {
      const prev = n > 0 && meet(list[n - 1], c), next = n + 1 < list.length && meet(c, list[n + 1]);
      if (ok(c.trIn)) e[n].i = prev ? {k: c.trIn.k, h: dur(c.trIn) / 2, cut: true} : {k: c.trIn.k, h: dur(c.trIn), cut: false};
      if (ok(c.trOut) && !next) e[n].o = {k: c.trOut.k, h: dur(c.trOut), cut: false};
      if (n > 0 && e[n].i && e[n].i.cut) e[n - 1].o = {...e[n].i};
    });
    // переходы клипа не заходят друг на друга, у стыка половина одна на двоих
    list.forEach((c, n) => {
      const {i, o} = e[n], a = i ? i.h : 0, b = o ? o.h : 0, len = tkLen(c);
      if (a + b > len) { if (i) i.h = a * len / (a + b); if (o) o.h = b * len / (a + b); }
    });
    for (let n = 1; n < list.length; n++) if (e[n].i && e[n].i.cut) e[n].i.h = e[n - 1].o.h = Math.min(e[n].i.h, e[n - 1].o.h);
    list.forEach((c, n) => {
      const {i, o} = e[n], half = .5 / tkFps();
      const x = {i: i && i.h >= half ? i : null, o: o && o.h >= half ? o : null};
      if (x.i || x.o) out.set(c.id, x);
    });
  }
  return out;
}
// где клип виден вместе с кусками за краями
function mvSpan(c) {
  const t = mv.tr.get(c.id);
  return [c.at - (t && t.i && t.i.cut ? t.i.h : 0), tkEnd(c) + (t && t.o && t.o.cut ? t.o.h : 0)];
}
const mvShown = (c, x) => { const [a, b] = mvSpan(c); return x >= a - 1e-4 && x < b - 1e-4; };
// переход клипа в момент x: вид, прогресс P, роль a (уходит) или b (приходит), стык или свободный край
function mvTrAt(c, x) {
  const t = mv.tr.get(c.id);
  if (!t) return null;
  const end = tkEnd(c);
  let edge = null, a = 0, role = '';
  if (t.i) {
    const s = c.at - (t.i.cut ? t.i.h : 0);
    if (x >= s - 1e-4 && x < c.at + t.i.h) { edge = t.i; a = s; role = 'b'; }
  }
  if (!edge && t.o) {
    const s = end - t.o.h;
    if (x >= s - 1e-4 && x < end + (t.o.cut ? t.o.h : 0)) { edge = t.o; a = s; role = 'a'; }
  }
  if (!edge) return null;
  const d = edge.cut ? 2 * edge.h : edge.h;
  return {k: edge.k, P: Math.min(Math.max(1 - (x - a) / d, 0), 1), role, cut: edge.cut};
}
const mvSmooth = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };
const MV_FAR_RECT = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
// Вид слоя в переходе. Формулы из vf_xfade.c. A (уходящий) сверху со своей долей, B у стыка под ним целиком;
// у свободного края второй стороны нет (пустота), и клип показывает свою долю сам.
// op — прозрачность, poly — видимая часть в долях кадра, dx/dy — сдвиг, zoom — увеличение от середины кадра,
// circle(r) — доля клипа на расстоянии r от середины (в полудиагоналях кадра), bg — плашка цвета над парой
function mvTrLook(st) {
  const {k, P, role, cut} = st, me = role === 'a', own = me || !cut;
  const L = {op: 1, poly: null, dx: 0, dy: 0, zoom: 1, circle: null, bg: null};
  if (k === 'fade') {
    if (own) L.op = me ? P : 1 - P;
  } else if (k === 'fadeblack' || k === 'fadewhite') {
    // A уходит в цвет, из цвета приходит B. Цвет у xfade непрозрачный и на верхней дорожке, поэтому плашка на весь кадр
    const wA = P * mvSmooth(.8, 1, P), wB = (1 - P) * (1 - mvSmooth(.2, 1, P)), wBg = Math.max(1 - wA - wB, 0), rest = 1 - wBg;
    if (own) L.op = rest > 1e-6 ? (me ? wA : wB) / rest : 0;
    L.bg = {color: k === 'fadeblack' ? '#000' : '#fff', a: wBg};
  } else if (k.startsWith('wipe')) {
    // A остаётся в своей части кадра, B в остальной. За краем кадра слой виден как обычно
    const lo = -9, hi = 10, part = {wipeleft: ['x', lo, P], wiperight: ['x', 1 - P, hi], wipeup: ['y', lo, P], wipedown: ['y', 1 - P, hi]}[k];
    const [ax, a0, a1] = part, [b0, b1] = me ? [a0, a1] : a0 === lo ? [a1, hi] : [lo, a0];
    L.poly = ax === 'x' ? MV_FAR_RECT(b0, lo, b1, hi) : MV_FAR_RECT(lo, b0, hi, b1);
  } else if (k.startsWith('slide')) {
    // A уезжает, B въезжает следом; что ушло за кадр, срезано, как в движке
    const v = me ? -(1 - P) : P;
    [L.dx, L.dy] = {slideleft: [v, 0], slideright: [-v, 0], slideup: [0, v], slidedown: [0, -v]}[k];
    L.poly = MV_FAR_RECT(0, 0, 1, 1);
  } else if (k === 'circleopen' || k === 'circleclose') {
    // у xfade край круга мягкий: доля A = smoothstep(r + p)
    const open = k === 'circleopen', p = open ? (P - .5) * 3 : (.5 - P) * 3;
    if (own) L.circle = r => { const s = mvSmooth(0, 1, r + p), a = open ? s : 1 - s; return me ? a : 1 - a; };
  } else if (k === 'zoomin') {
    // первая половина: A растёт от середины кадра, вторая: растворяется в B
    const wA = mvSmooth(0, .5, P);
    if (me) { L.zoom = 1 / Math.max(mvSmooth(.5, 1, P), 1e-6); L.poly = MV_FAR_RECT(0, 0, 1, 1); L.op = wA; }
    else if (own) L.op = 1 - wA;
  }
  return L;
}
// Многоугольник subj, срезанный выпуклым clip (Сазерленд — Ходжмен)
function mvClipPoly(subj, clip) {
  const area = clip.reduce((s, p, i) => { const q = clip[(i + 1) % clip.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0), sg = Math.sign(area) || 1;
  let out = subj;
  clip.forEach((a, i) => {
    const b = clip[(i + 1) % clip.length], side = p => sg * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]));
    const inp = out;
    out = [];
    inp.forEach((p, j) => {
      const q = inp[(j + 1) % inp.length], sp = side(p), sq = side(q);
      if (sp >= 0) out.push(p);
      if ((sp >= 0) !== (sq >= 0)) { const t = sp / (sp - sq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
    });
  });
  return out;
}
// Переход поверх того, что поставил mvPlace. box — рамка элемента в долях холста, [fx, fy] — середина поворота в долях элемента,
// crop — кадрирование через clip-path (или null). Сдвиг и увеличение идут в координатах кадра, поэтому стоят перед поворотом.
function mvTrPlace(el, c, box, [fx, fy], crop) {
  const st = mvTrAt(c, tkAt), L = st && mvTrLook(st);
  if (el.dataset.z) el.style.zIndex = (+el.dataset.z + 1) * 4 + (st && st.role === 'a' ? 2 : 1);   // A над B той же дорожки
  if (el.style.maskImage) el.style.maskImage = el.style.webkitMaskImage = '';
  if (!L || (!L.poly && !L.circle && !L.dx && !L.dy && L.zoom === 1)) return;
  const CW = mvCv.clientWidth, CH = mvCv.clientHeight, W = box.w * CW, H = box.h * CH;
  if (!(W > 0 && H > 0)) return;
  const ox = W * fx, oy = H * fy, Ox = box.x * CW + ox, Oy = box.y * CH + oy, cx = CW / 2, cy = CH / 2, d = mvCanvasDims();
  // xfade в конце увеличения берёт один пиксель: правее и ниже середины (ceil). Больше одного пикселя кадра на весь кадр не нужно
  const s = Math.min(L.zoom, d.w), zx = s !== 1 ? (Math.ceil((d.w - 1) / 2) + .5) / d.w * CW : cx, zy = s !== 1 ? (Math.ceil((d.h - 1) / 2) + .5) / d.h * CH : cy;
  const Dx = L.dx * CW, Dy = L.dy * CH, a = (c.rot || 0) * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
  if (s !== 1 || Dx || Dy) el.style.transform = `translate(${(s - 1) * (Ox - zx) + Dx}px,${(s - 1) * (Oy - zy) + Dy}px) scale(${s})` + (c.rot ? ` rotate(${c.rot}deg)` : '');
  // точка кадра в точках холста → место на элементе в долях
  const local = (X, Y) => {
    const qx = zx + (X - Dx - zx) / s - Ox, qy = zy + (Y - Dy - zy) / s - Oy;
    return [(ox + qx * cos + qy * sin) / W, (oy - qx * sin + qy * cos) / H];
  };
  if (L.poly) {
    let p = L.poly.map(([X, Y]) => local(X * CW, Y * CH));
    if (crop) p = mvClipPoly(p, MV_FAR_RECT(crop.l, crop.t, 1 - crop.r, 1 - crop.b));
    el.style.clipPath = p.length > 2 ? `polygon(${p.map(([x, y]) => `${(x * 100).toFixed(3)}% ${(y * 100).toFixed(3)}%`).join(',')})` : 'polygon(0 0,0 0,0 0)';
  }
  if (L.circle) {
    const [u, v] = local(cx, cy), Z = Math.hypot(cx, cy) / s, N = 30, stops = [];
    for (let j = 0; j <= N; j++) { const r = j / N * 2.5; stops.push(`rgba(0,0,0,${L.circle(r).toFixed(3)}) ${(r * Z).toFixed(1)}px`); }
    el.style.maskImage = el.style.webkitMaskImage = `radial-gradient(circle at ${(u * W).toFixed(1)}px ${(v * H).toFixed(1)}px,${stops.join(',')})`;
  }
}
// доля прозрачности слоя от перехода
function mvTrOpacity(c, x) { const st = mvTrAt(c, x); return st ? mvTrLook(st).op : 1; }
// Звук на краю с переходом: afade с кривой qsin (tlTransFades), у стыка сумма мощности двух клипов постоянна
function mvTrGain(c, x) { const st = mvTrAt(c, x); return st ? Math.sin(Math.PI / 2 * (st.role === 'a' ? st.P : 1 - st.P)) : 1; }
// Каждый кадр: слои в переходе на место, плашки цвета над парой
function mvTrFrame() {
  const used = new Set();
  tkTracks.forEach((tr, z) => {
    if (tr.kind !== 'v' || tr.off) return;
    for (const c of tr.clips) {
      if (!mv.tr.has(c.id)) continue;
      const e = mv.pool.find(p => p.clip === c.id), pic = mv.pics.get(c.id);
      if (e && !e.el.classList.contains('hide')) mvPlace(e.el, c);
      if (pic) mvPlace(pic, c);
      const st = mvShown(c, tkAt) && mvTrAt(c, tkAt), bg = st && (st.role === 'b' || !st.cut) && mvTrLook(st).bg;
      if (!bg) continue;
      const key = c.id + st.role;
      let div = mv.trBg.get(key);
      if (!div) {
        div = document.createElement('div');
        div.className = 'mv-layer';
        Object.assign(div.style, {left: 0, top: 0, width: '100%', height: '100%'});
        mvCv.appendChild(div);
        mv.trBg.set(key, div);
      }
      Object.assign(div.style, {zIndex: (z + 1) * 4 + 3, background: bg.color, opacity: bg.a, mixBlendMode: c.blend || ''});
      used.add(key);
    }
  });
  for (const [key, div] of mv.trBg) if (!used.has(key)) { div.remove(); mv.trBg.delete(key); }
}
