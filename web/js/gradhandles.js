// ---------- ручки градиента во вьюпорте ----------
// Пока открыто окно цвета (colorpick.js) с градиентом у поля выбранного слоя (заливка и обводка фигуры, цвет и обводка текста),
// поверх кадра видны точки градиента: у линейного начало и конец, у кругового середина и край круга. Тянешь — градиент
// меняется на ходу (cpGradP), картинка слоя рисуется заново не чаще раза в 100 мс. Точки хранятся в долях рамки слоя без поворота,
// здесь считаются в пикселях холста «как видно» (с поворотом слоя, как точки пути в shapes.js), на экран — с масштабом вида.
// Окно цвета на тягу не закрывается (.cp-keep); всё до «ОК» — один шаг отмены, «Отмена» и Esc возвращают и точки.
const mvGrad = $('mvGrad');
let mtGradHot = -1;   // какую ручку тянут
function mtGradClip() {
  const e = cpGradEdit(), c = e && e.opt.layer && e.opt.layer();
  return c && c === mvFrameClip() && mv.crop !== c.id ? {c, v: e.v} : null;
}
// доли рамки слоя → пиксели холста с поворотом, и обратно
function mtGradAxis(c) {
  const d = mvCanvasDims(), b = mvBox(c);
  return {d, b, a: (c.rot || 0) * Math.PI / 180, cx: (b.x + b.w / 2) * d.w, cy: (b.y + b.h / 2) * d.h};
}
function mtGradPx(c, u, v) { const {d, b, a, cx, cy} = mtGradAxis(c); return mtRotP((b.x + u * b.w) * d.w, (b.y + v * b.h) * d.h, a, cx, cy); }
function mtGradUv(c, p) {
  const {d, b, a, cx, cy} = mtGradAxis(c), [x, y] = mtRotP(p[0], p[1], -a, cx, cy);
  return [(x / d.w - b.x) / b.w, (y / d.h - b.y) / b.h];
}
// Пока ручки на кадре, «Градиент» — выбранный инструмент в панели вместо «Выбор»
var mtGradOn = false;
function mtGradTool(on) {
  if (on === mtGradOn) return;
  mtGradOn = on;
  $('mtGradTool').classList.toggle('hide', !on);
  $('mtGradTool').classList.toggle('on', on);
  mvStage.classList.toggle('mv-grading', on);
  tkBar();
}
function mtGradDraw() {
  const g = mtGradClip();
  mtGradTool(!!g);
  if (!g) { if (mvGrad.innerHTML) mvGrad.innerHTML = ''; return; }
  Object.assign(mvGrad.style, {left: mvCv.offsetLeft + 'px', top: mvCv.offsetTop + 'px', width: mvCv.offsetWidth + 'px', height: mvCv.offsetHeight + 'px'});
  mvGrad.setAttribute('viewBox', `0 0 ${mvCv.offsetWidth} ${mvCv.offsetHeight}`);
  const {c, v} = g, k = mvScreenK(), f = n => +(n * k).toFixed(1), A = mtGradPx(c, v.p[0], v.p[1]), B = mtGradPx(c, v.p[2], v.p[3]);
  const xy = `x1="${f(A[0])}" y1="${f(A[1])}" x2="${f(B[0])}" y2="${f(B[1])}"`, solid = s => cpHex({...cpParse(s.c), a: 1});
  let out = `<line class="mv-gl-under" ${xy}/><line class="mv-gl" ${xy}/>`;
  if (v.g === 'rad') out = `<circle class="mv-gr" cx="${f(A[0])}" cy="${f(A[1])}" r="${f(Math.hypot(B[0] - A[0], B[1] - A[1]))}"/>` + out;
  // зона захвата больше значка (mvHits в shapes.js), значок подсвечивается при наведении
  out += mvHits([[A, v.stops[0]], [B, v.stops[v.stops.length - 1]]].map(([p, s], i) => ({x: f(p[0]), y: f(p[1]), cls: 'mv-gh cp-keep', data: `data-h="${i}"`,
    tip: t(v.g === 'rad' ? (i ? 'cp.gh.edge' : 'cp.gh.mid') : i ? 'cp.gh.end' : 'cp.gh.start'),
    see: `<circle class="mv-gh see${mtGradHot === i ? ' on' : ''}" cx="${f(p[0])}" cy="${f(p[1])}" r="6" fill="${solid(s)}"/>`})), 12);
  mvGrad.innerHTML = out;
}
// Тяга ручки: раньше обработчиков вьюпорта, чтобы нажатие не выбирало и не двигало слой.
// Середина кругового едет вместе с краем. Shift у линейного — угол кратен 45° (как видно на экране).
addEventListener('pointerdown', e => {
  const el = e.button === 0 && e.target.closest && e.target.closest('.mv-gh'), g = el && mtGradClip();
  if (!g) return;
  e.preventDefault();
  e.stopPropagation();
  const h = +el.dataset.h, {c} = g, p0 = g.v.p.slice(), m0 = mvPx(e), A0 = mtGradPx(c, p0[0], p0[1]), B0 = mtGradPx(c, p0[2], p0[3]);
  mtGradHot = h;
  const r4 = n => Math.round(n * 1e4) / 1e4;
  const move = ev => {
    if (ev.pointerId !== e.pointerId) return;
    ev.preventDefault();
    const m = mvPx(ev), dx = m[0] - m0[0], dy = m[1] - m0[1], gv = cpGradEdit();
    if (!gv || !tkById(c.id)) return;
    let A = A0, B = B0;
    if (h === 0) { A = [A0[0] + dx, A0[1] + dy]; if (gv.v.g === 'rad') B = [B0[0] + dx, B0[1] + dy]; }
    else B = [B0[0] + dx, B0[1] + dy];
    if (ev.shiftKey && gv.v.g === 'lin') {   // угол от неподвижного конца
      const [o, q] = h ? [A, B] : [B, A], ang = Math.round(Math.atan2(q[1] - o[1], q[0] - o[0]) / (Math.PI / 4)) * Math.PI / 4, len = Math.hypot(q[0] - o[0], q[1] - o[1]);
      const s = [o[0] + Math.cos(ang) * len, o[1] + Math.sin(ang) * len];
      if (h) B = s; else A = s;
    }
    cpGradP([...mtGradUv(c, A), ...mtGradUv(c, B)].map(r4));
  };
  const up = ev => {
    if (ev.pointerId !== e.pointerId) return;
    removeEventListener('pointermove', move, true);
    removeEventListener('pointerup', up, true);
    removeEventListener('pointercancel', up, true);
    mtGradHot = -1;
    mtGradDraw();
  };
  addEventListener('pointermove', move, true);
  addEventListener('pointerup', up, true);
  addEventListener('pointercancel', up, true);
  mtGradDraw();
}, true);
cpHook = mtGradDraw;
var mtGradReady = true;   // viewport.js зовёт mtGradDraw из mvFrameDraw: до этой строки — undefined
