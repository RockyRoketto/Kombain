// Окно выбора цвета для всей программы вместо <input type="color">.
// В разметке поле — <button type="button" class="cp-sw" id=…>, у него те же value и disabled, что у input color.
// Модуль поля подключает его cpField(el, {alpha, grad, layer, live, done}): live(v) — показать цвет сразу (без шага отмены),
// done(ok) — окно закрыто: ok — применить одним шагом, иначе вернуть как было. Без live поле шлёт change после «ОК».
// Щелчок мимо окна — как «ОК»: что видно, то и остаётся (как в Figma). Отмена — кнопка, Esc или «было» в образце.
// Значение: строка '#rrggbb' или '#rrggbbaa' (альфа только у полей с alpha и только если она меньше 100 %).
// У полей с grad (их рисует сама страница: фигуры, текст) значение может быть градиентом:
// {g: 'lin'|'rad', stops: [{at: 0..1, c: '#rrggbb[aa]'}], p: [x0, y0, x1, y1]} — точки в долях рамки слоя:
// у линейного начало и конец, у кругового середина и точка на краю круга. layer() — слой, у которого во вьюпорте видны ручки
// градиента (gradhandles.js); точки там тянут через cpGradP. Пока окно открыто, правки градиента — один шаг отмены на «ОК».

const CP_RECENT_KEY = 'k9000.cpRecent', CP_RECENT_N = 14, CP_STOPS_MAX = 16;
const cpGrad = v => !!v && typeof v === 'object';
function cpParse(v) {
  const m = typeof v === 'string' && /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(v.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.replace(/./g, '$&$&');
  const n = i => parseInt(h.slice(i, i + 2), 16);
  return {r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1};
}
const cpX2 = n => Math.round(Math.min(Math.max(n, 0), 255)).toString(16).padStart(2, '0');
const cpHex = (c, alpha = true) => '#' + cpX2(c.r) + cpX2(c.g) + cpX2(c.b) + (alpha && c.a < 1 ? cpX2(c.a * 255) : '');
// цвет из файла проекта: '#rrggbb', с alpha ещё '#rrggbbaa'; иначе d
const cpValid = (v, d, alpha) => typeof v === 'string' && (alpha ? /^#[0-9a-f]{6}([0-9a-f]{2})?$/i : /^#[0-9a-f]{6}$/i).test(v) ? v.toLowerCase() : d;
// градиент по умолчанию: линейный слева направо, круговой из середины до края рамки
const cpGradP0 = g => g === 'rad' ? [.5, .5, 1, .5] : [0, .5, 1, .5];
// цвет или градиент из файла проекта (поля с grad); негодное — d
function cpValidG(v, d) {
  if (!cpGrad(v)) return cpValid(v, d, true);
  if (v.g !== 'lin' && v.g !== 'rad' || !Array.isArray(v.stops)) return d;
  const stops = v.stops.filter(s => s && Number.isFinite(s.at) && cpValid(s.c, '', true)).slice(0, CP_STOPS_MAX)
    .map(s => ({at: Math.min(Math.max(s.at, 0), 1), c: cpValid(s.c, '', true)})).sort((a, b) => a.at - b.at);
  const p = Array.isArray(v.p) && v.p.length === 4 && v.p.every(Number.isFinite) ? v.p.map(n => Math.min(Math.max(n, -10), 10)) : cpGradP0(v.g);
  return stops.length >= 2 ? {g: v.g, stops, p} : d;
}
const cpSame = (a, b) => a === b || (cpGrad(a) && cpGrad(b) && JSON.stringify(a) === JSON.stringify(b));
// угол линейного градиента в градусах, 0 — слева направо, по часовой стрелке (в долях рамки)
const cpGradAng = v => Math.round(Math.atan2(v.p[3] - v.p[1], v.p[2] - v.p[0]) * 180 / Math.PI);
// образец для CSS: цвет как есть, градиент — CSS-градиентом
function cpCss(v) {
  if (!cpGrad(v)) return v;
  const list = v.stops.map(s => `${s.c} ${+(s.at * 100).toFixed(2)}%`).join(',');
  return v.g === 'rad' ? `radial-gradient(circle,${list})` : `linear-gradient(${cpGradAng(v) + 90}deg,${list})`;
}
// для canvas: цвет как есть, градиент — CanvasGradient в рамке w×h (координаты холста g)
function cpStyle(g, v, w, h) {
  if (!cpGrad(v)) return v;
  const [x0, y0, x1, y1] = v.p.map((n, i) => n * (i % 2 ? h : w)), far = Math.hypot(x1 - x0, y1 - y0) < 1e-3;
  const q = v.g === 'rad' ? g.createRadialGradient(x0, y0, 0, x0, y0, Math.max(Math.hypot(x1 - x0, y1 - y0), 1e-3))
    : g.createLinearGradient(x0, y0, far ? x0 + 1e-3 : x1, y1);   // нулевая длина у canvas не рисует ничего
  for (const s of v.stops) q.addColorStop(Math.min(Math.max(s.at, 0), 1), s.c);
  return q;
}
// есть ли прозрачность: у цвета или у какой-нибудь точки градиента
const cpSee = v => cpGrad(v) ? v.stops.some(s => (cpParse(s.c) || {a: 1}).a < 1) : (cpParse(v) || {a: 1}).a < 1;
// цвет градиента в месте at (между соседними точками)
function cpGradAt(stops, at) {
  const r = stops.findIndex(s => s.at >= at);
  if (r <= 0) return cpParse(stops[r < 0 ? stops.length - 1 : 0].c);
  const A = stops[r - 1], B = stops[r], k = B.at > A.at ? (at - A.at) / (B.at - A.at) : 0, a = cpParse(A.c), b = cpParse(B.c);
  return {r: a.r + (b.r - a.r) * k, g: a.g + (b.g - a.g) * k, b: a.b + (b.b - a.b) * k, a: a.a + (b.a - a.a) * k};
}
function cpHsv({r, g, b}) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), d = mx - Math.min(r, g, b);
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return {h: h * 60, s: mx ? d / mx : 0, v: mx};
}
function cpRgb(h, s, v) {
  const f = k => { const x = (k + h / 60) % 6; return (v - v * s * Math.max(Math.min(x, 4 - x, 1), 0)) * 255; };
  return {r: f(5), g: f(3), b: f(1)};
}

// поле-образец
function cpField(el, opt = {}) {
  const first = !el.cpOpt;
  el.cpOpt = opt;
  el.classList.toggle('alpha', !!opt.alpha);
  if (!first) { el.value = el.value; return el; }
  el.append(document.createElement('i'));
  let val = '#000000';
  Object.defineProperty(el, 'value', {
    get: () => val,
    set: v => {
      const o = el.cpOpt;
      if (cpGrad(v) && !o.grad) v = v.stops[0].c;   // градиент там, где его не умеют: первый цвет
      val = cpGrad(v) ? v : cpHex(cpParse(v) || {r: 0, g: 0, b: 0, a: 1}, !!o.alpha);
      el.firstChild.style.background = cpCss(val);
    },
  });
  el.value = val;
  el.addEventListener('click', () => cpOpen(el));
  return el;
}

// ---------- окно ----------
let cp = null;   // открытое окно: {el, opt, was, h, s, v, a, timer, gv — градиент в правке или null, st — выбранная точка}
let cpHook = null;   // зовётся при каждой правке и закрытии: ручки градиента во вьюпорте (gradhandles.js)
const cpBox = document.createElement('div');
cpBox.className = 'cp hide';
cpBox.innerHTML = `<div class="cp-kinds hide"><button type="button" data-k=""></button><button type="button" data-k="lin"></button><button type="button" data-k="rad"></button></div>
<div class="cp-gr hide"><div class="cp-gbar"><b></b></div>
<div class="cp-grow"><label class="cp-gang"><svg viewBox="0 0 16 16" width="13" height="13"><path d="M2 13.5h12M2 13.5L11 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M7 13.5a5 5 0 0 0-1.4-3.5" fill="none" stroke="currentColor" stroke-width="1.2"/></svg><input class="cp-ang" type="number" min="-360" max="360" step="1">°</label>
<span class="cp-gsp"></span><button type="button" class="btn sm cp-gflip"><svg viewBox="0 0 16 16" width="14" height="14"><path d="M2 5h11M10 2l3 3-3 3M14 11H3M6 8l-3 3 3 3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button><button type="button" class="btn sm cp-gdel"><svg viewBox="0 0 16 16" width="14" height="14"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg></button></div></div>
<div class="cp-sv"><i></i></div>
<div class="cp-bar cp-hue"><i></i></div>
<div class="cp-bar cp-al"><b></b><i></i></div>
<div class="cp-row"><span class="cp-cmp"><button type="button" class="cp-was"></button><span class="cp-now"></span></span>
<input type="text" class="cp-hex" spellcheck="false" maxlength="9"><label class="cp-ap"><input class="cp-a" type="number" min="0" max="100" step="1">%</label>
<button type="button" class="btn sm cp-eye"><svg viewBox="0 0 16 16" width="14" height="14"><path d="M10.6 1.9a1.9 1.9 0 0 1 2.7 0l.8.8a1.9 1.9 0 0 1 0 2.7l-1.5 1.5.6.6-1.1 1.1-.6-.6-5.2 5.2H3.5L2 14.7l-.7-.7 1.5-1.5v-2.8L8 4.5l-.6-.6 1.1-1.1.6.6zM3.8 10.3v1.9h1.9l5-5-1.9-1.9z" fill="currentColor"/></svg></button></div>
<div class="cp-recent"></div>
<div class="cp-foot"><button type="button" class="btn sm cp-no"></button><button type="button" class="btn sm primary cp-ok"></button></div>`;
document.body.append(cpBox);
const cpQ = s => cpBox.querySelector(s);
function cpTexts() {
  cpQ('.cp-no').textContent = t('cp.cancel');
  cpQ('.cp-ok').textContent = t('cp.ok');
  cpQ('.cp-eye').title = t('cp.eye');
  cpQ('.cp-eye').setAttribute('aria-label', t('cp.eye'));
  cpQ('.cp-was').title = t('cp.was');
  cpQ('.cp-hex').setAttribute('aria-label', 'HEX');
  cpQ('.cp-a').setAttribute('aria-label', t('cp.alpha'));
  cpQ('.cp-al').title = t('cp.alpha');
  const kinds = {'': 'cp.kind.solid', lin: 'cp.kind.lin', rad: 'cp.kind.rad'};
  cpBox.querySelectorAll('.cp-kinds [data-k]').forEach(b => { b.textContent = t(kinds[b.dataset.k]); });
  cpQ('.cp-gbar').title = t('cp.gbar');
  cpQ('.cp-gang').title = t('cp.gang');
  cpQ('.cp-ang').setAttribute('aria-label', t('cp.gang'));
  for (const [s, k] of [['.cp-gflip', 'cp.gflip'], ['.cp-gdel', 'cp.gdel']]) { cpQ(s).title = t(k); cpQ(s).setAttribute('aria-label', t(k)); }
}
const cpA = () => !!(cp.opt.alpha || cp.gv);   // прозрачность можно: у поля с alpha и у любой точки градиента
const cpNow = () => ({...cpRgb(cp.h, cp.s, cp.v), a: cpA() ? cp.a : 1});
const cpRecent = () => { try { return (JSON.parse(storeGet(CP_RECENT_KEY)) || []).filter(v => cpParse(v)); } catch (e) { return []; } };
const cpClone = v => cpGrad(v) ? {...v, stops: v.stops.map(s => ({...s})), p: v.p.slice()} : v;
// цвет в квадрат, оттенок и альфу; у серого и чёрного оттенок не теряется
function cpLoadColor(c) {
  const hsv = cpHsv(c);
  if (hsv.s > 0 && hsv.v > 0) cp.h = hsv.h;
  if (hsv.v > 0) cp.s = hsv.s;
  cp.v = hsv.v;
  if (cpA() && 'a' in c) cp.a = c.a;
}
// значение целиком: цвет или градиент (выбрана первая точка)
function cpLoad(v) {
  cp.gv = cpGrad(v) ? cpClone(v) : null;
  cp.st = cp.gv ? cp.gv.stops[0] : null;
  const c = cp.gv ? cpParse(cp.st.c) : cpParse(v) || {r: 0, g: 0, b: 0, a: 1};
  cp.a = c.a;
  cpLoadColor(c);
}

function cpOpen(el) {
  if (el.disabled) return;
  if (cp) { const same = cp.el === el; cpClose(true); if (same) return; }
  cp = {el, opt: el.cpOpt || {}, was: el.value, h: 0, s: 0, v: 0, a: 1, timer: 0, gv: null, st: null};
  cpLoad(el.value);
  cpTexts();
  cpQ('.cp-kinds').classList.toggle('hide', !cp.opt.grad);
  cpQ('.cp-eye').classList.toggle('hide', !window.EyeDropper);
  cpQ('.cp-was').style.background = cpCss(cp.was);
  cpFillRecent();
  el.classList.add('on');
  cpBox.classList.remove('hide');
  cpPaint();
  cpPlace();
  cpQ('.cp-ok').focus({preventScroll: true});
  if (cpHook) cpHook();
}
// у поля: снизу, если не помещается — сверху; по краям окна не вылезает
function cpPlace() {
  const r = cp.el.getBoundingClientRect(), w = cpBox.offsetWidth, h = cpBox.offsetHeight, m = 8;
  const x = Math.min(Math.max(r.right - w, m), innerWidth - w - m);
  const y = r.bottom + 6 + h <= innerHeight - m ? r.bottom + 6 : Math.max(r.top - 6 - h, m);
  cpBox.style.left = x + 'px';
  cpBox.style.top = y + 'px';
}
function cpPaint(keepHex) {
  const c = cpNow(), pure = cpRgb(cp.h, 1, 1), hex = cpHex(c, cpA()), solid = cpHex({...c, a: 1}), gv = cp.gv;
  const grew = cpBox.classList.contains('grad') !== !!gv;
  cpBox.classList.toggle('alpha', cpA());
  cpBox.classList.toggle('grad', !!gv);
  cpBox.querySelectorAll('.cp-kinds [data-k]').forEach(b => b.classList.toggle('on', b.dataset.k === (gv ? gv.g : '')));
  cpQ('.cp-gr').classList.toggle('hide', !gv);
  if (gv) {
    if (cp.st) cp.st.c = hex;
    const bar = cpQ('.cp-gbar');
    bar.querySelector('b').style.background = cpCss({...gv, g: 'lin', p: [0, 0, 1, 0]});
    [...bar.querySelectorAll('i')].forEach(i => i.remove());
    const bw = bar.offsetWidth || 200;
    gv.stops.forEach((s, n) => {
      const i = document.createElement('i'), near = Math.min(...gv.stops.filter(o => o !== s).map(o => Math.abs(o.at - s.at) * bw));
      i.style.setProperty('--hp', Math.min(Math.max((near - 14) / 2, 0), 5) + 'px');   // зона захвата шире значка, но не на соседа
      i.dataset.n = n;
      i.className = s === cp.st ? 'on' : '';
      i.style.left = s.at * 100 + '%';
      i.append(document.createElement('u'));
      i.firstChild.style.background = s.c;
      bar.append(i);
    });
    cpQ('.cp-gang').classList.toggle('hide', gv.g !== 'lin');
    if (gv.g === 'lin' && document.activeElement !== cpQ('.cp-ang')) cpQ('.cp-ang').value = cpGradAng(gv);
    cpQ('.cp-gdel').disabled = gv.stops.length <= 2;
  }
  cpQ('.cp-sv').style.background = `linear-gradient(to top,#000,transparent),linear-gradient(to right,#fff,${cpHex({...pure, a: 1})})`;
  cpQ('.cp-sv i').style.cssText = `left:${cp.s * 100}%;top:${(1 - cp.v) * 100}%;background:${solid}`;
  cpQ('.cp-hue i').style.left = cp.h / 360 * 100 + '%';
  cpQ('.cp-al b').style.background = `linear-gradient(to right,${solid}00,${solid})`;
  cpQ('.cp-al i').style.left = cp.a * 100 + '%';
  cpQ('.cp-now').style.background = gv ? cpCss(gv) : hex;
  if (!keepHex) cpQ('.cp-hex').value = hex.slice(1).toUpperCase();
  if (document.activeElement !== cpQ('.cp-a')) cpQ('.cp-a').value = Math.round(cp.a * 100);
  if (grew && !cpBox.classList.contains('hide')) cpPlace();   // окно стало выше или ниже
}
// новое значение: образец сразу, просмотр в монтаже не чаще 15 раз в секунду (ручки градиента — 10 раз, как рамка фигуры)
function cpSet(keepHex, slow) {
  cpPaint(keepHex);
  const v = cp.gv ? cpClone(cp.gv) : cpHex(cpNow(), !!cp.opt.alpha);
  if (cpSame(v, cp.el.value)) return;
  cp.el.value = v;
  if (cp.opt.live && !cp.timer) cp.timer = setTimeout(() => { if (cp) { cp.timer = 0; cp.opt.live(cp.el.value); } }, slow ? 100 : 66);
  if (cpHook) cpHook();
}
function cpPut(c, keepHex) {
  cpLoadColor(c);
  cpSet(keepHex);
}
function cpClose(ok) {
  if (!cp) return;
  const x = cp;
  if (ok && document.activeElement === cpQ('.cp-hex')) { const c = cpHexIn(cpQ('.cp-hex').value); if (c) cpPut(c); }
  cp = null;
  clearTimeout(x.timer);
  cpBox.classList.add('hide');
  x.el.classList.remove('on');
  const changed = !cpSame(x.el.value, x.was);
  if (ok && changed) {
    if (!cpGrad(x.el.value)) storeSet(CP_RECENT_KEY, JSON.stringify([x.el.value, ...cpRecent().filter(v => v !== x.el.value)].slice(0, CP_RECENT_N)));
    if (x.opt.live) x.opt.live(x.el.value);   // последний цвет мог ещё ждать в таймере
  }
  if (!ok) x.el.value = x.was;
  if (x.opt.done) x.opt.done(ok);
  else if (ok && changed) x.el.dispatchEvent(new Event('change', {bubbles: true}));
  if (document.activeElement === document.body || cpBox.contains(document.activeElement)) x.el.focus({preventScroll: true});
  if (cpHook) cpHook();
}
function cpFillRecent() {
  const box = cpQ('.cp-recent'), list = cpRecent().filter(v => cp.opt.alpha || cp.opt.grad || !(cpParse(v).a < 1));
  box.textContent = '';
  box.classList.toggle('hide', !list.length);
  for (const v of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = v.slice(1).toUpperCase();
    b.dataset.v = v;
    b.append(document.createElement('i'));
    b.firstChild.style.background = v;
    box.append(b);
  }
}

// ---------- градиент ----------
// вид: '' — цвет, 'lin', 'rad'. Из цвета — этот цвет, уходящий в прозрачность; между видами точки цветов остаются.
function cpKind(k) {
  if (!cp || !cp.opt.grad || k === (cp.gv ? cp.gv.g : '')) return;
  if (!k) { cp.gv = cp.st = null; cpSet(); return; }
  if (cp.gv) cp.gv = {...cp.gv, g: k, p: cpGradP0(k)};
  else {
    const c = cpHex(cpNow(), true), solid = cpHex({...cpNow(), a: 1});
    cp.gv = {g: k, stops: [{at: 0, c}, {at: 1, c: solid + '00'}], p: cpGradP0(k)};
  }
  cp.st = cp.gv.stops[0];
  cp.a = (cpParse(cp.st.c) || {a: 1}).a;
  cpSet();
}
cpQ('.cp-kinds').addEventListener('click', e => { const b = e.target.closest('[data-k]'); if (b) cpKind(b.dataset.k); });
function cpPick(s) {
  cp.st = s;
  const c = cpParse(s.c);
  cp.a = c.a;
  cpLoadColor(c);
}
function cpDelStop() {
  const gv = cp && cp.gv;
  if (!gv || gv.stops.length <= 2 || !cp.st) return;
  const n = gv.stops.indexOf(cp.st);
  gv.stops.splice(n, 1);
  cpPick(gv.stops[Math.min(n, gv.stops.length - 1)]);
  cpSet();
}
// полоса: щелчок мимо точек — новая точка цвета этого места, точку тянут вбок, вниз с полосы — убрать
cpQ('.cp-gbar').addEventListener('pointerdown', e => {
  if (e.button !== 0 || !cp || !cp.gv) return;
  e.preventDefault();
  const bar = cpQ('.cp-gbar'), gv = cp.gv, r = bar.getBoundingClientRect(), at = ev => Math.round(Math.min(Math.max((ev.clientX - r.left) / r.width, 0), 1) * 1000) / 1000;
  const hit = e.target.closest('.cp-gbar i');
  let s = hit && gv.stops[+hit.dataset.n];
  if (!s) {
    if (gv.stops.length >= CP_STOPS_MAX) return;
    s = {at: at(e), c: cpHex(cpGradAt(gv.stops, at(e)), true)};
    gv.stops.push(s);
    gv.stops.sort((a, b) => a.at - b.at);
  }
  cpPick(s);
  cpSet();
  bar.setPointerCapture(e.pointerId);
  let off = false;
  const x0 = e.clientX;
  const move = ev => {
    if (ev.pointerId !== e.pointerId) return;
    const out = ev.clientY - r.bottom > 24 && gv.stops.length > 2;
    if (Math.abs(ev.clientX - x0) > 2 || out !== off) {
      off = out;
      s.at = at(ev);
      gv.stops.sort((a, b) => a.at - b.at);
      cpSet();
      const i = bar.querySelector('i.on');
      if (i) i.classList.toggle('off', off);
    }
  };
  const up = ev => {
    if (ev.pointerId !== e.pointerId) return;
    bar.removeEventListener('pointermove', move);
    bar.removeEventListener('pointerup', up);
    bar.removeEventListener('pointercancel', up);
    if (off && cp && cp.gv === gv) cpDelStop();
  };
  bar.addEventListener('pointermove', move);
  bar.addEventListener('pointerup', up);
  bar.addEventListener('pointercancel', up);
});
// угол линейного: середина и длина остаются
cpQ('.cp-ang').addEventListener('input', e => {
  const gv = cp && cp.gv, n = +e.target.value;
  if (!gv || gv.g !== 'lin' || e.target.value === '' || !Number.isFinite(n)) return;
  const [x0, y0, x1, y1] = gv.p, mx = (x0 + x1) / 2, my = (y0 + y1) / 2, L = Math.hypot(x1 - x0, y1 - y0) / 2 || .5, a = n * Math.PI / 180;
  const k = v => Math.round(v * 1e4) / 1e4;
  gv.p = [k(mx - Math.cos(a) * L), k(my - Math.sin(a) * L), k(mx + Math.cos(a) * L), k(my + Math.sin(a) * L)];
  cpSet();
});
cpQ('.cp-ang').addEventListener('change', () => cp && cpPaint());
cpQ('.cp-gflip').addEventListener('click', () => {
  const gv = cp && cp.gv;
  if (!gv) return;
  const n = gv.stops.indexOf(cp.st);
  gv.stops = gv.stops.map(s => ({...s, at: Math.round((1 - s.at) * 1000) / 1000})).reverse();
  cpPick(gv.stops[Math.max(gv.stops.length - 1 - n, 0)]);
  cpSet();
});
cpQ('.cp-gdel').addEventListener('click', cpDelStop);
// точки градиента из вьюпорта (gradhandles.js): что сейчас в правке и новое место
const cpGradEdit = () => cp && cp.gv ? {opt: cp.opt, v: cp.gv} : null;
function cpGradP(p) { if (cp && cp.gv) { cp.gv.p = p; cpSet(false, true); } }

// тяга по квадрату и полосам
function cpDrag(sel, fn) {
  const area = cpQ(sel);
  area.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    area.setPointerCapture(e.pointerId);
    const move = ev => { const r = area.getBoundingClientRect(); fn(Math.min(Math.max((ev.clientX - r.left) / r.width, 0), 1), Math.min(Math.max((ev.clientY - r.top) / r.height, 0), 1)); cpSet(); };
    const up = () => { area.removeEventListener('pointermove', move); area.removeEventListener('pointerup', up); area.removeEventListener('pointercancel', up); };
    area.addEventListener('pointermove', move);
    area.addEventListener('pointerup', up);
    area.addEventListener('pointercancel', up);
    move(e);
  });
}
cpDrag('.cp-sv', (x, y) => { cp.s = x; cp.v = 1 - y; });
cpDrag('.cp-hue', x => { cp.h = Math.min(x * 360, 359.9); });
cpDrag('.cp-al', x => { cp.a = Math.round(x * 100) / 100; });
// HEX из поля: без двух последних цифр прозрачность остаётся прежней
function cpHexIn(v) { const c = cpParse(v); if (c && v.trim().replace(/^#/, '').length <= 6) delete c.a; return c; }
cpQ('.cp-hex').addEventListener('input', e => { const c = cpHexIn(e.target.value); if (c && /^#?([0-9a-f]{6}|[0-9a-f]{8})$/i.test(e.target.value.trim())) cpPut(c, true); });
cpQ('.cp-hex').addEventListener('change', e => { const c = cpHexIn(e.target.value); if (c) cpPut(c); else cpPaint(); });
cpQ('.cp-a').addEventListener('input', e => { const n = +e.target.value; if (e.target.value !== '' && Number.isFinite(n)) { cp.a = Math.min(Math.max(n, 0), 100) / 100; cpSet(); } });
cpQ('.cp-a').addEventListener('change', () => cpPaint());
cpQ('.cp-was').addEventListener('click', () => { cpLoad(cp.was); cpSet(); });
cpQ('.cp-recent').addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (b) cpPut(cpParse(b.dataset.v)); });
cpQ('.cp-recent').addEventListener('dblclick', e => { if (e.target.closest('[data-v]')) cpClose(true); });
cpQ('.cp-ok').addEventListener('click', () => cpClose(true));
cpQ('.cp-no').addEventListener('click', () => cpClose(false));
// пипетка берёт цвет с экрана; окно на это время не закрывается
cpQ('.cp-eye').addEventListener('click', async () => {
  const at = cp && cp.el;
  try {
    const r = await new EyeDropper().open();
    const c = cpParse(r.sRGBHex);
    if (cp && cp.el === at && c) cpPut({r: c.r, g: c.g, b: c.b});
  } catch (e) {}
});
// щелчок мимо окна и поля — «ОК»; сам щелчок проходит дальше (выбор клипа и т. п.). Ручки градиента во вьюпорте (.cp-keep) окно не закрывают.
addEventListener('pointerdown', e => { if (cp && !cpBox.contains(e.target) && !cp.el.contains(e.target) && !(e.target.closest && e.target.closest('.cp-keep'))) cpClose(true); }, true);
// пока окно открыто, клавиши программы не работают: Ctrl+Z посреди просмотра сломал бы отмену
addEventListener('keydown', e => {
  if (!cp) return;
  const typing = cpBox.contains(e.target) && e.target.matches('input');
  if (e.key === 'Escape') cpClose(false);
  else if (e.key === 'Enter' && !(e.target.closest && e.target.closest('.cp-foot, .cp-recent, .cp-was, .cp-eye, .cp-kinds, .cp-grow'))) cpClose(true);
  else if (cp.gv && !typing && (e.key === 'Delete' || e.key === 'Backspace')) cpDelStop();   // убрать выбранную точку градиента
  else if (cpBox.contains(e.target) && (typing || e.key === 'Tab' || e.key === ' ' || e.key === 'Enter')) { e.stopPropagation(); return; }
  else if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); cpQ('.cp-hex').focus(); return; }
  else { e.preventDefault(); e.stopPropagation(); return; }
  e.preventDefault();
  e.stopPropagation();
}, true);
addEventListener('resize', () => { if (cp) cpPlace(); });
addEventListener('scroll', () => { if (cp) cpPlace(); }, true);
document.querySelectorAll('.cp-sw').forEach(el => cpField(el, {}));
