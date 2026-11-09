// ---------- вид вьюпорта: сдвиг и масштаб, как в After Effects ----------
// Только для работы: в проект и в результат не идёт. 100 % — точка кадра на точку экрана.
// z: 0 — по размеру окна; x, y — сдвиг середины кадра от середины окна, в точках страницы.
const mvView = {z: 0, x: 0, y: 0};
const MV_ZOOM_MIN = .05, MV_ZOOM_MAX = 16, MV_VIEW_KEEP = 40;   // столько точек кадра всегда остаётся в окне
let mvHand = null, mvPanning = false;   // mvHand: зажат пробел, {moved}

const mvDpr = () => devicePixelRatio || 1;
// масштаб в точках страницы на точку кадра; fit — при вписывании в окно
const mvViewScale = fit => mvView.z ? mvView.z / mvDpr() : fit;
// сколько сейчас на самом деле, в долях от 100 %
function mvZoomNow() { const d = mvCanvasDims(); return d.w ? mvCv.offsetWidth / d.w * mvDpr() : 1; }
const mvViewFree = () => !!(mvView.z || mvView.x || mvView.y);
// сдвиг не уводит кадр из окна целиком
function mvViewClamp(W, H, w, h) {
  const lx = Math.max((W + w) / 2 - MV_VIEW_KEEP, 0), ly = Math.max((H + h) / 2 - MV_VIEW_KEEP, 0);
  mvView.x = Math.min(Math.max(mvView.x, -lx), lx);
  mvView.y = Math.min(Math.max(mvView.y, -ly), ly);
}

function mvZoomBtn() {
  const b = $('mvZoomBtn');
  b.textContent = Math.round(mvZoomNow() * 100) + '%';
  b.classList.toggle('on', mvViewFree());
}
// масштаб z (1 = 100 %) с точкой (cx, cy) на месте; без точки — середина окна
function mvZoomTo(z, cx, cy) {
  const d = mvCanvasDims(), st = mvStage.getBoundingClientRect(), r = mvCv.getBoundingClientRect();
  const pad = mvRulersSeen() ? MV_RULER : 0, mx = st.left + pad + (mvStage.clientWidth - pad) / 2, my = st.top + pad + (mvStage.clientHeight - pad) / 2;
  if (cx === undefined) { cx = mx; cy = my; }
  z = Math.min(Math.max(z, MV_ZOOM_MIN), MV_ZOOM_MAX);
  const u = r.width ? (cx - r.left) / r.width : .5, v = r.height ? (cy - r.top) / r.height : .5;
  const s = z / mvDpr(), w = d.w * s, h = d.h * s;
  Object.assign(mvView, {z, x: cx - u * w + w / 2 - mx, y: cy - v * h + h / 2 - my});
  mvStageFit();
}
function mvViewFit() {
  Object.assign(mvView, {z: 0, x: 0, y: 0});
  mvStageFit();
}

// ---------- показать слой: вид, где видны и кадр, и слой ----------
function mvShowLayer(c) {
  c = c || mvFrameClip() || tkOne();
  if (!c || tkTrackOf(c).kind !== 'v') return;
  if (!mvUnder(c, tkAt)) { mvPause(); tkSeek(c.at); }   // слой виден только в своё время
  // края слоя с поворотом, в долях кадра
  const d = mvCanvasDims(), b = mvBox(c), a = (c.rot || 0) * Math.PI / 180, pw = b.w * d.w, ph = b.h * d.h;
  const ex = (Math.abs(pw * Math.cos(a)) + Math.abs(ph * Math.sin(a))) / 2 / d.w, ey = (Math.abs(pw * Math.sin(a)) + Math.abs(ph * Math.cos(a))) / 2 / d.h;
  const mx = b.x + b.w / 2, my = b.y + b.h / 2;
  const x0 = Math.min(0, mx - ex), x1 = Math.max(1, mx + ex), y0 = Math.min(0, my - ey), y1 = Math.max(1, my + ey);
  if (x0 >= 0 && y0 >= 0 && x1 <= 1 && y1 <= 1) { mvViewFit(); return; }   // слой в кадре: хватит вида по окну
  const pad = mvRulersSeen() ? MV_RULER : 0, W = mvStage.clientWidth - pad, H = mvStage.clientHeight - pad;
  const s = Math.min(W / ((x1 - x0) * d.w), H / ((y1 - y0) * d.h)) * .9;
  Object.assign(mvView, {z: s * mvDpr(), x: (.5 - (x0 + x1) / 2) * d.w * s, y: (.5 - (y0 + y1) / 2) * d.h * s});
  mvStageFit();
}
// Стрелка у края вьюпорта, когда выбранный слой целиком вне вида: показывает, куда он ушёл, щелчок показывает его. Зовётся из mvFrameDraw
function mvOffDraw(c) {
  const el = $('mvOffArrow');
  if (!c) { el.classList.add('hide'); return; }
  const st = mvStage.getBoundingClientRect(), f = mvFrame.getBoundingClientRect(), m = 4;
  const seen = f.right > st.left + m && f.left < st.right - m && f.bottom > st.top + m && f.top < st.bottom - m;
  el.classList.toggle('hide', seen);
  if (seen) return;
  const dx = (f.left + f.right) / 2 - (st.left + st.width / 2), dy = (f.top + f.bottom) / 2 - (st.top + st.height / 2);
  const k = Math.min((st.width / 2 - 22) / Math.max(Math.abs(dx), 1e-6), (st.height / 2 - 22) / Math.max(Math.abs(dy), 1e-6));
  Object.assign(el.style, {left: st.width / 2 + dx * k + 'px', top: st.height / 2 + dy * k + 'px'});
  el.style.setProperty('--a', Math.atan2(dy, dx) + 'rad');
}
$('mvOffArrow').addEventListener('pointerdown', e => e.stopPropagation());   // иначе вьюпорт снимет выбор слоя
$('mvOffArrow').onclick = () => { mvShowLayer(); $('mvOffArrow').blur(); };

// ---------- рука: зажатый пробел или колёсико ----------
function mvHandDown() {
  if (mvHand) return;
  mvHand = {moved: false};
  mvStage.classList.add('hand');
}
function mvHandUp(play) {
  const h = mvHand;
  mvHand = null;
  mvStage.classList.remove('hand');
  if (h && !h.moved && play) mvToggle();   // нажал и отпустил, ничего не тянул: старт и стоп, как раньше
}
document.addEventListener('keyup', e => { if (e.code === 'Space' && mvHand) { e.preventDefault(); mvHandUp(true); } });
window.addEventListener('blur', () => mvHandUp(false));
// перехват раньше слоёв, рамки и направляющих: с рукой нажатие только двигает вид
mvStage.addEventListener('pointerdown', e => {
  if (mv.file || !(mvHand && e.button === 0 || e.button === 1)) return;
  e.stopImmediatePropagation();
  if (mvHand) mvHand.moved = true;
  const x0 = e.clientX, y0 = e.clientY, vx = mvView.x, vy = mvView.y;
  let frame = 0, last = null;
  mvPanning = true;
  mvStage.classList.add('panning');
  tkDrag(e, ev => {
    last = ev;
    if (frame) return;
    frame = requestAnimationFrame(() => {   // не чаще кадра экрана: пересчёт трогает линейки и все слои
      frame = 0;
      mvView.x = vx + last.clientX - x0;
      mvView.y = vy + last.clientY - y0;
      mvStageFit();
    });
  }, () => {
    mvPanning = false;
    mvStage.classList.remove('panning');
  });
}, true);
// Ctrl + колёсико и щипок на тачпаде: масштаб у курсора. Без Ctrl колёсико как было
mvStage.addEventListener('wheel', e => {
  if (!(e.ctrlKey || e.metaKey) || mv.file) return;
  e.preventDefault();   // иначе WebView2 увеличит всю страницу
  mvZoomTo(mvZoomNow() * 2 ** (-e.deltaY / 300), e.clientX, e.clientY);
}, {passive: false});

$('mvZoomBtn').onclick = () => {
  const r = $('mvZoomBtn').getBoundingClientRect(), free = mvViewFree();
  const item = (z, label) => ({label, key: (z ? mvView.z === z : !free) ? '✓' : '', run: () => z ? mvZoomTo(z) : mvViewFit()});
  ctxOpen(r.left, r.bottom + 4, [item(0, t('mv.zoomFit')), ...[.25, .5, 1, 2, 4].map(z => item(z, z * 100 + '%'))]);
  $('mvZoomBtn').blur();
};
$('mvZoomBtn').ondblclick = () => { ctxClose(); mvViewFit(); };
