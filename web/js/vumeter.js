// ---------- индикатор громкости монтажа: левый и правый канал всего микса до общего ползунка ----------
// Звук в него подаёт вьюпорт (mvAudio). Рисует только пока идёт просмотр и пока столбики не опустились.
const VU_MIN = -60, VU_FALL = 26, VU_PEAK_FALL = 18;    // дБ и дБ в секунду
const VU_HOLD = 1000;                                   // сколько мс держится метка пика
const VU_HOT = -1;                                      // выше этого уровня столбик краснеет: обычный громкий ролик стоит у −3…−1
const VU_OVER = .5;                                     // красная метка: сжатый звук после декодирования и сам чуть выходит за 0 дБ
const VU_TICKS = [0, -6, -12, -24, -48];
const VU_BAR = 9, VU_GAP = 2, VU_TOP = 6, VU_BOTTOM = 14;   // размеры в пикселях CSS; ширина как у .vu-clip i
const vuCv = $('tkVuCv'), vuClipBtn = $('tkVuClip');
const vu = {an: null, buf: null, busy: () => false, raf: 0, last: 0, ch: [0, 1].map(() => ({lvl: VU_MIN, peak: VU_MIN, held: 0}))};

function vuAttach(ctx, bus, busy) {
  const split = ctx.createChannelSplitter(2);
  bus.connect(split);
  vu.an = [0, 1].map(i => {
    const a = ctx.createAnalyser();
    a.fftSize = 2048;   // около 43 мс: куски идут внахлёст, поэтому короткий пик не теряется между кадрами
    split.connect(a, i);
    return a;
  });
  vu.buf = new Float32Array(2048);
  vu.busy = busy;
}
function vuDb(i) {
  vu.an[i].getFloatTimeDomainData(vu.buf);
  let m = 0;
  for (const x of vu.buf) { const a = Math.abs(x); if (a > m) m = a; }
  return m > 0 ? 20 * Math.log10(m) : -Infinity;
}
function vuClip(i, on) { vuClipBtn.children[i].classList.toggle('on', on); }
function vuStep(now) {
  const dt = Math.min((now - vu.last) / 1000, .25), busy = vu.busy();
  vu.last = now;
  let alive = busy;
  vu.ch.forEach((c, i) => {
    const db = busy && vu.an ? vuDb(i) : -Infinity;
    if (db >= VU_OVER) vuClip(i, true);
    c.lvl = Math.max(db, c.lvl - VU_FALL * dt, VU_MIN);
    if (db >= c.peak) { c.peak = db; c.held = now; }
    else if (now - c.held > VU_HOLD) c.peak = Math.max(c.peak - VU_PEAK_FALL * dt, VU_MIN);
    if (c.lvl > VU_MIN || c.peak > VU_MIN) alive = true;
  });
  vuDraw();
  vu.raf = alive ? requestAnimationFrame(vuStep) : 0;
}
function vuKick() {
  if (vu.raf) return;
  vu.last = performance.now();
  vu.raf = requestAnimationFrame(vuStep);
}
function vuDraw() {
  const w = vuCv.clientWidth, h = vuCv.clientHeight, dpr = devicePixelRatio || 1;
  if (!w || !h) return;
  const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
  if (vuCv.width !== pw || vuCv.height !== ph) { vuCv.width = pw; vuCv.height = ph; }
  const g = vuCv.getContext('2d'), css = getComputedStyle(vuCv);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const span = h - VU_TOP - VU_BOTTOM;
  const y = db => VU_TOP + span * Math.min(Math.max(db, VU_MIN), 0) / VU_MIN;
  const hot = y(VU_HOT);
  g.font = '9px ' + css.fontFamily;
  g.textBaseline = 'middle';
  g.textAlign = 'right';
  g.fillStyle = css.color;
  const x0 = w - VU_BAR * 2 - VU_GAP;
  VU_TICKS.forEach(db => g.fillText(String(Math.abs(db)), x0 - 4, y(db)));
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  vu.ch.forEach((c, i) => {
    const x = x0 + i * (VU_BAR + VU_GAP), top = y(c.lvl);
    g.fillStyle = css.color;
    g.fillText('LR'[i], x + VU_BAR / 2, h - 2);
    g.fillStyle = css.getPropertyValue('--track');
    g.fillRect(x, VU_TOP, VU_BAR, span);
    if (c.lvl > VU_MIN) {
      g.fillStyle = css.getPropertyValue('--acc');
      g.fillRect(x, Math.max(top, hot), VU_BAR, VU_TOP + span - Math.max(top, hot));
      if (top < hot) { g.fillStyle = css.getPropertyValue('--err'); g.fillRect(x, top, VU_BAR, hot - top); }
    }
    if (c.peak > VU_MIN) {
      g.fillStyle = css.getPropertyValue(c.peak > VU_HOT ? '--err' : '--acc-hi');
      g.fillRect(x, y(c.peak) - 1, VU_BAR, 2);
    }
  });
}
vuClipBtn.onclick = () => { vuClip(0, false); vuClip(1, false); };
new ResizeObserver(vuDraw).observe(vuCv);
