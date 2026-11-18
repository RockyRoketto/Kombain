// Новогоднее оформление шапки: сугробы с ёлочками, снег и огоньки вокруг рамки названия.
// Включается само с 1 декабря по 14 января; в эти же даты в настройках («Оформление») появляется тумблер, чтобы его выключить.
// Вне сезона тумблера нет, оформления тоже. Рисунок случайный на каждый запуск. Всё лежит в двух слоях:
// фон под содержимым шапки и огоньки поверх рамки названия.
const NY_KEY = 'konv9000.newyear';   // off — выключено; пусто — включено (в сезон)
let nyOff = false;
try { nyOff = localStorage.getItem(NY_KEY) === 'off'; } catch (e) {}

// 'force' в том же ключе включает сезон в любую дату (для проверки)
function nySeason(d = new Date()) {
  try { if (localStorage.getItem(NY_KEY) === 'force') return true; } catch (e) {}
  const m = d.getMonth(), day = d.getDate();
  return m === 11 || (m === 0 && day <= 14);
}
function nyActive() { return nySeason() && !nyOff; }

const NY_NS = 'http://www.w3.org/2000/svg';
const nyR = (a, b) => a + Math.random() * (b - a);
function nyE(p, tag, a) { const e = document.createElementNS(NY_NS, tag); for (const k in a) e.setAttribute(k, a[k]); p.appendChild(e); return e; }

const nyBack = document.createElement('div');
nyBack.className = 'ny'; nyBack.setAttribute('aria-hidden', 'true');
const nyBackSvg = document.createElementNS(NY_NS, 'svg');
nyBack.appendChild(nyBackSvg);
document.querySelector('.hero').prepend(nyBack);
const nyBulbs = document.createElementNS(NY_NS, 'svg');
nyBulbs.setAttribute('class', 'ny-bulbs'); nyBulbs.setAttribute('aria-hidden', 'true');
document.querySelector('.hero-title').appendChild(nyBulbs);

const NY_COLS = ['#e9b872', '#e06a5a', '#6fcf97', '#6aa9e9'];
const NY_FIRS = ['#1f4a3a', '#2d6a4f', '#25594a'];

function nyFir(g, x, h, color, lift) {
  const y = nyH - 2 - lift, w = h * 0.5, f = nyE(g, 'g', {});
  nyE(f, 'rect', {x: x - 1.2, y: y - 2, width: 2.4, height: 4, fill: '#4a3a2a'});
  for (let k = 0; k < 3; k++) {
    const by = y - 2 - k * h * 0.27, ty = by - h * 0.48, hw = w * (1 - k * 0.25);
    nyE(f, 'path', {d: `M${x} ${ty} L${x + hw} ${by} L${x - hw} ${by}Z`, fill: color});
  }
  nyE(f, 'path', {d: `M${x} ${y - 2 - 2 * h * 0.27 - h * 0.48} l${w * 0.2} ${h * 0.2} h${-w * 0.4}Z`, class: 'ny-cap'});
}
function nyDrift(g, x, w, h, tone) {
  nyE(g, 'path', {d: `M${x} ${nyH} C${x + w * .2} ${nyH - h * 1.35} ${x + w * .8} ${nyH - h * 1.35} ${x + w} ${nyH}Z`, class: tone ? 'ny-d1' : 'ny-d2'});
}

let nyH = 56, nyWas = '';
function nyBuild() {
  const hero = document.querySelector('.hero'), on = nyActive();
  nyWas = on + ':' + nySeason() + ':' + new Date().getDate();
  $('nyBox').classList.toggle('hide', !nySeason());
  $('nyOn').checked = !nyOff;
  nyBackSvg.replaceChildren(); nyBulbs.replaceChildren();
  nyBack.hidden = !on; nyBulbs.style.display = on ? '' : 'none';
  hero.classList.toggle('ny-on', on);
  if (!on) return;
  const hr = hero.getBoundingClientRect(), W = hr.width;
  nyH = hr.height;
  nyBackSvg.setAttribute('viewBox', `0 0 ${W} ${nyH}`);
  nyBackSvg.style.setProperty('--ny-h', (nyH + 8) + 'px');

  // под текстом и вкладками ничего не должно лежать: высота украшений там ограничена
  // название занимает колонку сетки целиком, поэтому его ширину берём по самому тексту (рамка и подпись)
  const nameR = document.querySelector('.hero-title h1').getBoundingClientRect(), byRange = document.createRange();
  byRange.selectNodeContents(document.querySelector('.hero-title .by'));
  const byR = byRange.getBoundingClientRect();
  const zones = [{l: Math.min(nameR.left, byR.left) - hr.left, r: Math.max(nameR.right, byR.right) - hr.left, free: nyH - (byR.bottom - hr.top) - 2}];
  ['#tabs', '.hero-right'].forEach(s => {
    const e = document.querySelector(s);
    if (!e) return;
    const r = e.getBoundingClientRect();
    zones.push({l: r.left - hr.left, r: r.right - hr.left, free: nyH - (r.bottom - hr.top) - 2});
  });
  const cap = (a, b) => zones.reduce((m, z) => (z.r > a - 6 && z.l < b + 6) ? Math.min(m, z.free) : m, 20);

  const back = [], front = [], firs = [], mounds = [];
  for (let x = -40; x < W; x += nyR(.35, .7) * 150) {
    const w = nyR(70, 200), h = Math.min(nyR(6, 14), cap(x + w * .2, x + w * .8));
    if (h < 2) continue;
    (Math.random() < .55 ? back : front).push([x, w, h, Math.random() < .5]);
  }
  const nf = Math.max(2, Math.round(W / 110));
  // ёлочки только в промежутках между названием, вкладками и шестерёнкой: под ними самими они прячутся за плашкой
  const free = x => zones.every(z => x < z.l - 10 || x > z.r + 10);
  for (let i = 0, tries = 0; i < nf && tries < nf * 8; tries++) {
    const x = nyR(10, W - 10);
    if (!free(x) || firs.some(f => Math.abs(f[0] - x) < 14)) continue;
    // у каждой ёлочки своя высота и свой уровень земли: часть стоит на собственном бугорке сугроба, он спереди закрывает ствол
    const fh = nyR(9, 19), mw = nyR(34, 60), mh = Math.min(nyR(3, 11), cap(x - mw / 2, x + mw / 2));
    firs.push([x, fh, NY_FIRS[Math.floor(Math.random() * 3)], Math.max(0, mh - 2)]);
    mounds.push([x - mw / 2, mw, mh, Math.random() < .5]); i++;
  }
  back.forEach(d => nyDrift(nyBackSvg, ...d));
  firs.forEach(f => nyFir(nyBackSvg, ...f));
  mounds.forEach(d => nyDrift(nyBackSvg, ...d));
  front.forEach(d => nyDrift(nyBackSvg, ...d));

  const n = Math.max(30, Math.min(110, Math.round(W / 16)));
  for (let i = 0; i < n; i++) {
    const g = nyE(nyBackSvg, 'g', {class: 'ny-fl'});
    g.style.animation = `ny-sway ${nyR(2.5, 5)}s ${-nyR(0, 4)}s ease-in-out infinite alternate`;
    const c = nyE(g, 'circle', {cx: nyR(0, W), cy: 0, r: nyR(.8, 1.9), 'fill-opacity': nyR(.4, .75)});
    c.style.animation = `ny-fall ${nyR(6, 13)}s ${-nyR(0, 13)}s linear infinite`;
  }

  // огоньки вдоль рамки: шаг считается по всей длине рамки, высота над ней случайная
  const h1 = document.querySelector('.hero-title h1'), w = h1.offsetWidth, h = h1.offsetHeight, P = 10;
  Object.assign(nyBulbs.style, {left: -P + 'px', top: -P + 'px'});
  nyBulbs.setAttribute('width', w + 2 * P); nyBulbs.setAttribute('height', h + 2 * P);
  const x0 = P + .5, y0 = P + .5, bw = w - 1, bh = h - 1, L = 2 * (bw + bh), cnt = Math.round(L / 11), st = L / cnt;
  const at = s => {
    s = ((s % L) + L) % L;
    if (s < bw) return [x0 + s, y0, 0, -1];
    s -= bw; if (s < bh) return [x0 + bw, y0 + s, 1, 0];
    s -= bh; if (s < bw) return [x0 + bw - s, y0 + bh, 0, 1];
    s -= bw; return [x0, y0 + bh - s, -1, 0];
  };
  for (let i = 0; i < cnt; i++) {
    const p = at(i * st + nyR(-3, 3)), o = nyR(-1.5, 4.5), col = NY_COLS[i % 4], x = p[0] + p[2] * o, y = p[1] + p[3] * o, d = (i % 4 * .5) + 's';
    nyE(nyBulbs, 'circle', {cx: x, cy: y, r: 3.5, fill: col, 'fill-opacity': .16}).style.animation = `ny-tw 2s ${d} infinite`;
    nyE(nyBulbs, 'circle', {cx: x, cy: y, r: 1.6, fill: col}).style.animation = `ny-tw 2s ${d} infinite`;
  }
}

let nyTimer = 0;
function nyLater() { cancelAnimationFrame(nyTimer); nyTimer = requestAnimationFrame(nyBuild); }
if (window.ResizeObserver) {
  const ro = new ResizeObserver(nyLater);
  ro.observe(document.querySelector('.hero')); ro.observe(document.querySelector('.hero-title h1'));
} else addEventListener('resize', nyLater);
// программа может работать неделями: на границе дат оформление включается и гаснет без перезапуска
addEventListener('focus', () => { if (nyWas !== nyActive() + ':' + nySeason() + ':' + new Date().getDate()) nyBuild(); });
nyBuild();

$('nyOn').addEventListener('change', () => {
  nyOff = !$('nyOn').checked;
  try { nyOff ? localStorage.setItem(NY_KEY, 'off') : localStorage.removeItem(NY_KEY); } catch (e) {}
  nyBuild();
});
