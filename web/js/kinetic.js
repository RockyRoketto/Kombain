// ---------- кинетика: перетаскивание с инерцией и наклоном. Модуль не знает ни про монтаж, ни про плеер ----------
const KIN = {
  stiff: 600, damp: 38,    // пружина: чем больше stiff, тем меньше отставание; при таком damp посадка почти без колебаний
  tilt: .004, tiltMax: 4,  // наклон в градусах на пиксель в секунду и его предел
  lift: .02,               // на сколько элемент увеличен, пока его держат
  edge: 44, scroll: 900,   // у края списка: ширина зоны прокрутки и скорость в пикселях в секунду
  land: 320, drag: 5,      // предел посадки в мс и сдвиг мыши, с которого нажатие считается перетаскиванием
};
const kinCalm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// Элемент идёт за целью на пружине и наклоняется от скорости. Двигает только transform, раскладку не трогает.
// side: где схвачен элемент, от -1 (левый край) до 1 (правый). onFrame(dt) зовётся на каждом кадре.
function kinFollow(el, {side = 1, onFrame} = {}) {
  const calm = kinCalm();
  let x = 0, y = 0, vx = 0, vy = 0, tx = 0, ty = 0, rot = 0, lift = 0;
  let held = true, landed = null, landBy = 0, raf = 0, last = performance.now();
  const paint = () => { el.style.transform = `translate(${x}px,${y}px) rotate(${rot}deg) scale(${1 + KIN.lift * lift})`; };
  const finish = () => { cancelAnimationFrame(raf); raf = 0; const cb = landed; landed = null; if (cb) cb(); };
  const tick = now => {
    const dt = Math.min((now - last) / 1000, 1 / 30); last = now;
    if (calm) { x = tx; y = ty; }
    else {
      vx += (KIN.stiff * (tx - x) - KIN.damp * vx) * dt; x += vx * dt;
      vy += (KIN.stiff * (ty - y) - KIN.damp * vy) * dt; y += vy * dt;
      const want = Math.max(-KIN.tiltMax, Math.min(KIN.tiltMax, (vx + vy * side) * KIN.tilt));
      rot += (want - rot) * (1 - Math.exp(-dt * 16));
      lift += ((held ? 1 : 0) - lift) * (1 - Math.exp(-dt * 18));
    }
    paint();
    if (onFrame && held) onFrame(dt);
    if (landed && (calm || now > landBy || (Math.hypot(tx - x, ty - y) < .4 && Math.hypot(vx, vy) < 12))) { finish(); return; }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return {
    aim(nx, ny) { tx = nx; ty = ny; },
    land(nx, ny, cb) {
      tx = nx; ty = ny; held = false; landed = cb; landBy = performance.now() + KIN.land;
      setTimeout(() => { if (landed) finish(); }, KIN.land + 100);   // в скрытом окне кадров нет, а посадка должна закончиться
    },
    stop() { landed = null; finish(); },
  };
}

// Порядок в вертикальном списке: строка идёт за мышью, соседи расступаются, а в конце зовётся done(откуда, куда).
// Список, у которого снят класс kin-list, не перетаскивается. Пока busy(), список нельзя перерисовывать.
function kinSort(list, {item, key, done, skip = 'button,a,input,select,textarea'}) {
  let grip = null;
  const down = e => {
    if (grip || e.button !== 0 || !list.classList.contains('kin-list') || e.target.closest(skip)) return;
    const row = e.target.closest(item);
    if (row && row.parentNode === list) grip = {row, id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, on: false, land: false};
  };
  const lift = () => {
    if (!grip.row.isConnected) { grip = null; return; }   // список успели перерисовать между нажатием и сдвигом
    const rows = [...list.children].filter(el => el.matches(item));
    const rects = rows.map(r => r.getBoundingClientRect());
    const from = rows.indexOf(grip.row), r = rects[from];
    const near = rects[from + 1] ? rects[from + 1].top - r.bottom : rects[from - 1] ? r.top - rects[from - 1].bottom : 0;
    const s = (grip.x0 - r.left) / (r.width / 2) - 1;
    Object.assign(grip, {
      on: true, rows, rects, from, to: from, step: r.height + near, scroll0: list.scrollTop, title: grip.row.title,
      gap: grip.row.cloneNode(true),
      fol: kinFollow(grip.row, {side: (s < 0 ? -1 : 1) * Math.max(Math.abs(s), .5), onFrame: frame}),
    });
    grip.gap.classList.add('kin-gap');
    list.insertBefore(grip.gap, grip.row);   // держит место, пока сама строка вынута из потока
    grip.row.removeAttribute('title');        // подсказка с путём не должна всплывать во время перетаскивания
    Object.assign(grip.row.style, {left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px'});
    grip.row.classList.add('kin-held');
    list.classList.add('kin-sorting');
    try { grip.row.setPointerCapture(grip.id); } catch (err) {}
  };
  const frame = dt => {
    const box = list.getBoundingClientRect();
    if (grip.y < box.top + KIN.edge) list.scrollTop -= KIN.scroll * dt * Math.min(1, (box.top + KIN.edge - grip.y) / KIN.edge);
    else if (grip.y > box.bottom - KIN.edge) list.scrollTop += KIN.scroll * dt * Math.min(1, (grip.y - box.bottom + KIN.edge) / KIN.edge);
    const r = grip.rects[grip.from];
    const mid = r.top + r.height / 2 + (grip.y - grip.y0) + list.scrollTop - grip.scroll0;
    // сосед уступает, когда край строки дошёл до его середины, то есть на половине пути
    let to = 0;
    grip.rects.forEach((o, i) => { if (i !== grip.from && o.top + o.height / 2 < mid + (i > grip.from ? r.height : -r.height) / 2) to++; });
    if (to !== grip.to) part(to);
  };
  // соседи между старым и новым местом сдвигаются на одну строку
  const part = to => {
    grip.to = to;
    grip.rows.forEach((row, i) => {
      if (i === grip.from) return;
      const d = i > grip.from && i <= to ? -grip.step : i < grip.from && i >= to ? grip.step : 0;
      row.style.transform = d ? `translateY(${d}px)` : '';
    });
  };
  const drop = cancel => {
    if (!grip) return;
    const g = grip;
    if (!g.on) { grip = null; return; }
    if (g.land) return;
    g.land = true;
    if (cancel) part(g.from);
    else window.addEventListener('click', swallow, {capture: true, once: true});   // отпускание не должно открыть строку
    setTimeout(() => window.removeEventListener('click', swallow, true), 100);
    const r = g.rects, slot = g.to > g.from ? r[g.to].bottom - r[g.from].height : r[g.to].top;
    g.fol.land(0, slot - r[g.from].top - (list.scrollTop - g.scroll0), () => {
      list.classList.remove('kin-sorting');
      g.gap.remove();
      g.row.classList.remove('kin-held');
      g.row.removeAttribute('style');
      g.rows.forEach(row => { row.style.transform = ''; });
      g.row.title = g.title;
      grip = null;
      done(g.from, g.to);
    });
  };
  const swallow = e => { e.stopPropagation(); e.preventDefault(); };
  list.classList.add('kin-list');
  list.addEventListener('pointerdown', down);
  window.addEventListener('pointermove', e => {
    if (!grip || e.pointerId !== grip.id || grip.land) return;
    grip.x = e.clientX; grip.y = e.clientY;
    if (!grip.on && Math.hypot(grip.x - grip.x0, grip.y - grip.y0) >= KIN.drag) lift();
    if (grip && grip.on) grip.fol.aim((grip.x - grip.x0) * .12, grip.y - grip.y0);
  });
  window.addEventListener('pointerup', e => { if (grip && e.pointerId === grip.id) drop(false); });
  window.addEventListener('pointercancel', e => { if (grip && e.pointerId === grip.id) drop(true); });
  window.addEventListener('blur', () => drop(true));
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && grip && grip.on) { e.stopPropagation(); e.preventDefault(); drop(true); }
  }, true);
  return {
    busy: () => !!(grip && grip.on),
    // Перестановка без мыши (кнопки): строки плавно переезжают со старых мест на новые. Строки узнаются по key.
    flip(change) {
      const rowsOf = () => [...list.children].filter(el => el.matches(item));
      const was = new Map(rowsOf().map(r => [key(r), r.getBoundingClientRect().top]));
      change();
      if (kinCalm()) return;
      for (const r of rowsOf()) {
        const d = was.has(key(r)) ? was.get(key(r)) - r.getBoundingClientRect().top : 0;
        if (d) r.animate([{transform: `translateY(${d}px)`}, {transform: 'none'}], {duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)'});
      }
    },
  };
}
