// ---------- линейки и направляющие вьюпорта ----------
// Только для работы: лежат в проекте (tkGuides, доли кадра), в результат не идут.
const MV_RULER = 18, MV_RULERS_KEY = 'konv9000.mvRulers';
let mvRulersOn = !!storeGet(MV_RULERS_KEY);
const mvRulersSeen = () => mvRulersOn && !mv.file;
// к чему магнитятся слои: направляющие работают, пока видны
const mvGuidePts = axis => mvRulersSeen() ? tkGuides[axis] : [];

function mvRulerPaint(cv, axis) {
  const horiz = axis === 'x', len = horiz ? mvStage.clientWidth : mvStage.clientHeight, dpr = devicePixelRatio || 1;
  const from = horiz ? mvCv.offsetLeft : mvCv.offsetTop, frame = horiz ? mvCv.offsetWidth : mvCv.offsetHeight;
  const d = mvCanvasDims(), px = frame / (horiz ? d.w : d.h);
  cv.width = (horiz ? len : MV_RULER) * dpr;
  cv.height = (horiz ? MV_RULER : len) * dpr;
  if (!(px > 0)) return;
  const g = cv.getContext('2d'), css = getComputedStyle(cv), rect = (a, b) => horiz ? g.fillRect(a, 0, b, MV_RULER) : g.fillRect(0, a, MV_RULER, b);
  g.scale(dpr, dpr);
  g.fillStyle = css.getPropertyValue('--s1');
  rect(0, len);
  g.fillStyle = css.getPropertyValue('--s3');   // светлее там, где кадр
  rect(from, frame);
  // крупный шаг 1, 2 или 5 с нулями, подписи не ближе 60 точек
  let step = 1;
  for (let k = 1; step * px < 60; k *= 10) step = [1, 2, 5, 10].map(m => m * k).find(s => s * px >= 60) || k * 10;
  const minor = step / 5;
  g.fillStyle = css.getPropertyValue('--dim');
  g.font = '9px sans-serif';
  g.textBaseline = 'top';
  for (let i = Math.ceil(-from / px / minor), end = Math.floor((len - from) / px / minor); i <= end; i++) {
    const at = Math.round(from + i * minor * px), big = i % 5 === 0, size = big ? MV_RULER : 4;
    if (horiz) g.fillRect(at, MV_RULER - size, 1, size); else g.fillRect(MV_RULER - size, at, size, 1);
    if (!big) continue;
    const label = String(Math.round(i * minor));
    if (horiz) { g.fillText(label, at + 3, 2); continue; }
    g.save();
    g.translate(2, at - 3);
    g.rotate(-Math.PI / 2);
    g.fillText(label, 0, 0);
    g.restore();
  }
}
function mvGuidesPaint() {
  const box = $('mvGuideLines'), W = mvCv.offsetWidth, H = mvCv.offsetHeight, tip = esc(t('mv.guideTip'));
  const line = axis => tkGuides[axis].map((v, i) => {
    const at = axis === 'x' ? mvCv.offsetLeft + v * W : mvCv.offsetTop + v * H;
    return `<i class="mv-gl g${axis}" data-a="${axis}" data-i="${i}" title="${tip}" style="${axis === 'x' ? 'left' : 'top'}:${at}px"></i>`;
  }).join('');
  box.innerHTML = line('x') + line('y');
}
function mvRulersDraw() {
  const on = mvRulersSeen();
  ['mvRulerX', 'mvRulerY', 'mvRulerCorner', 'mvGuideLines'].forEach(id => $(id).classList.toggle('hide', !on));
  $('mvRulersBtn').classList.toggle('on', mvRulersOn);
  if (!on) return;
  mvRulerPaint($('mvRulerX'), 'x');
  mvRulerPaint($('mvRulerY'), 'y');
  mvGuidesPaint();
}
// Направляющая идёт за мышью. Над линейкой или за вьюпортом её нет: так новая ещё не появилась, а старая при отпускании удаляется.
function mvGuideDrag(e, axis, i) {
  const before = tkState(), rest = tkGuides[axis].filter((v, j) => j !== i);
  let moved = false;
  tkDrag(e, ev => {
    moved = true;
    const b = mvCv.getBoundingClientRect(), st = mvStage.getBoundingClientRect();
    const off = ev.clientX < st.left + MV_RULER || ev.clientY < st.top + MV_RULER || ev.clientX > st.right || ev.clientY > st.bottom;
    const a = axis === 'x' ? (ev.clientX - b.left) / b.width : (ev.clientY - b.top) / b.height;
    const v = a + mvSnap([a], axis === 'x' ? b.width : b.height).d;
    tkGuides[axis] = off ? rest : [...rest, +v.toFixed(5)];
    mvGuidesPaint();
  }, () => { if (moved) tkCommit(before); });
}
[['mvRulerX', 'y'], ['mvRulerY', 'x']].forEach(([id, axis]) => {
  $(id).addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.stopPropagation();
    mvGuideDrag(e, axis, -1);
  });
});
$('mvRulerCorner').addEventListener('pointerdown', e => e.stopPropagation());
$('mvRulerCorner').onclick = () => {
  if (tkGuides.x.length || tkGuides.y.length) tkDo(() => { tkGuides = {x: [], y: []}; });
  $('mvRulerCorner').blur();
};
$('mvRulersBtn').onclick = () => {
  mvRulersOn = !mvRulersOn;
  storeSet(MV_RULERS_KEY, mvRulersOn ? '1' : '');
  mvStageFit();
  $('mvRulersBtn').blur();
};
