// ---------- вкладка «Цвет»: Палитра, Оттенки, Из фото ----------
// Здесь наборы цветов без положения, в отличие от градиента (color.js). Выгрузка общая, внизу поля:
// CSS и JSON в буфер, ASE (собирает Go, aseBytes в color.go), SVG и PNG (полоса квадратов с подписями).
// Палитра: цвета по правилу круга оттенков в OKLCH, замки и «Случайно» как у градиента.
// Оттенки: ступени 50–950 от одного цвета; основа встаёт на ближайшую по яркости ступень без изменений.
// Из фото: k-средних в OKLab по уменьшенной картинке, метки на фото можно тянуть. Картинка не запоминается.
// Состояние в localStorage: k9000.colorSet.

const CS_KEY = 'k9000.colorSet', CS_MIN = 2, CS_MAX = 8, CS_TOOLS = ['pal', 'shade', 'photo'];
// правила палитры: сдвиги оттенка от основы в градусах; «Авто» берёт любое из остальных
const CS_RULES = {auto: null, analog: [0, 28, -28, 56, -56], mono: [0], compl: [0, 180], split: [0, 150, 210], triad: [0, 120, 240], tetrad: [0, 90, 180, 270]};
const CS_STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
const CS_L = [.971, .934, .884, .809, .706, .63, .562, .497, .434, .388, .27];   // яркость ступеней в OKLCH, близко к шкале Tailwind
const CS_C = [.12, .25, .45, .7, .9, 1, 1, .92, .8, .68, .5];                     // доля насыщенности: к светлому и тёмному краю меньше
let csId = 0;
const csCol = (c, lock) => ({id: ++csId, c, lock: !!lock});
const csDefault = () => ({pal: {rule: 'auto', colors: ['#1f2a44', '#3d5a80', '#e9b872', '#f2d7a6', '#ee6c4d'].map(c => csCol(c))},
  shade: {base: '#e9b872', name: 'primary'}, photo: {n: 5}});
let cs = csDefault();
let csSel = null;   // колонка палитры, куда ляжет цвет из «Моих цветов»

// имя для CSS-переменных: латиница, цифры и дефис
const csName = v => typeof v === 'string' ? v.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) : '';
const csPalOf = list => Array.isArray(list) ? list.map(c => cpValid(c, '')).filter(Boolean).slice(0, CS_MAX) : [];
// состояние из сохранённого (или из снимка отмены); негодное заменяется значениями по умолчанию
function csFrom(o) {
  const d = csDefault(), p = o.pal || {}, sh = o.shade || {};
  const cols = Array.isArray(p.colors) ? p.colors.filter(x => x && cpValid(x.c, '')).slice(0, CS_MAX).map(x => csCol(cpValid(x.c, ''), x.lock)) : [];
  return {pal: {rule: Object.hasOwn(CS_RULES, p.rule) ? p.rule : 'auto', colors: cols.length >= CS_MIN ? cols : d.pal.colors},
    shade: {base: cpValid(sh.base, d.shade.base), name: csName(sh.name) || d.shade.name},
    photo: {n: o.photo && Number.isInteger(o.photo.n) && o.photo.n >= 3 && o.photo.n <= CS_MAX ? o.photo.n : 5}};
}
function csLoad() {
  try { const o = JSON.parse(storeGet(CS_KEY) || 'null'); if (o) cs = csFrom(o); } catch (e) {}
}
const csPlainState = () => ({pal: {rule: cs.pal.rule, colors: cs.pal.colors.map(x => ({c: x.c, lock: x.lock || undefined}))}, shade: cs.shade, photo: cs.photo});
const csSave = () => { storeSet(CS_KEY, JSON.stringify(csPlainState())); clMark(); };
// цвет светлый — подписи на нём тёмные
const csLight = hex => clLab(cpParse(hex)).L > .66;

// ---------- палитра ----------
function csRandom() {
  const cols = cs.pal.colors, locked = cols.filter(x => x.lock), free = cols.filter(x => !x.lock);
  const names = Object.keys(CS_RULES).filter(k => k !== 'auto');
  const rule = cs.pal.rule === 'auto' ? names[Math.floor(Math.random() * names.length)] : cs.pal.rule;
  const sch = CS_RULES[rule], mono = rule === 'mono';
  const base = locked.length ? clLch(cpParse(locked[0].c)).H : Math.random() * 360;
  // яркости вразброс от тёмной до светлой, чтобы в палитре был и фон, и текст; у одного тона — по порядку
  const n = free.length, Ls = free.map((_, i) => .28 + .66 * (n > 1 ? i / (n - 1) : .5));
  if (!mono) for (let i = Ls.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [Ls[i], Ls[j]] = [Ls[j], Ls[i]]; }
  free.forEach((x, i) => {
    const H = (base + sch[(i + (locked.length ? 1 : 0)) % sch.length] + (Math.random() - .5) * (mono ? 6 : 14) + 360) % 360;
    let L = Ls[i] + (Math.random() - .5) * .05;
    if (H > 60 && H < 130 && L > .5) L = Math.max(L, .8);   // тёмный жёлтый и салатовый выходят болотными
    const C = mono ? .03 + Math.random() * .1 : L < .4 ? .05 + Math.random() * .08 : .09 + Math.random() * .1;
    x.c = cpHex(clFit({L, C, H}), false);
  });
  csRender(); csSave();
}
const csColsEl = $('csCols');
let csColsSig = '';
function csColsDraw() {
  const cols = cs.pal.colors, sig = cols.map(x => x.id).join(',');
  const find = id => cs.pal.colors.find(x => x.id === id);
  if (sig !== csColsSig) {
    if (cp && csColsEl.contains(cp.el)) cpClose(true);
    csColsSig = sig;
    csColsEl.innerHTML = cols.map(x => `<div class="cs-col" data-id="${x.id}">
      <button type="button" class="cp-sw cs-sw" aria-label="${esc(t('cl.color'))}"></button>
      <div class="cs-ctl"><input type="text" class="cs-hex" spellcheck="false" maxlength="7" aria-label="HEX">
      <span class="cs-btns"><button type="button" class="cl-mini cs-lk"></button>
      <button type="button" class="cl-mini cs-cp" title="${esc(t('cl.copy'))}" aria-label="${esc(t('cl.copy'))}">${CL_ICO.copy}</button>
      <button type="button" class="cl-mini cs-x" title="${esc(t('cl.del'))}" aria-label="${esc(t('cl.del'))}">${CL_ICO.del}</button></span></div></div>`).join('');
    csColsEl.querySelectorAll('.cs-col').forEach(el => {
      const id = +el.dataset.id;
      let was;
      cpField(el.querySelector('.cs-sw'), {
        live: v => { const x = find(id); if (x) { if (was === undefined) was = x.c; x.c = v; csSel = x; csRender(); } },
        done: ok => { const x = find(id); if (x && !ok && was !== undefined) x.c = was; was = undefined; csRender(); csSave(); }});
    });
  }
  for (const x of cols) {
    const el = csColsEl.querySelector(`.cs-col[data-id="${x.id}"]`);
    if (!el) continue;
    el.classList.toggle('lt', csLight(x.c));
    el.classList.toggle('on', x === csSel);
    const sw = el.querySelector('.cs-sw');
    if (sw.value !== x.c && !(cp && cp.el === sw)) sw.value = x.c;
    const hx = el.querySelector('.cs-hex');
    if (document.activeElement !== hx) hx.value = clUp(x.c).slice(1);
    const lk = el.querySelector('.cs-lk');
    lk.innerHTML = x.lock ? CL_ICO.lock : CL_ICO.open;
    lk.classList.toggle('on', x.lock);
    lk.title = t(x.lock ? 'cl.unlock' : 'cl.lock');
    lk.setAttribute('aria-label', lk.title);
    el.querySelector('.cs-x').classList.toggle('hide', cols.length <= CS_MIN);
  }
}
csColsEl.addEventListener('click', e => {
  const el = e.target.closest('.cs-col'), x = el && cs.pal.colors.find(c => c.id === +el.dataset.id);
  if (!x) return;
  csSel = x;
  if (e.target.closest('.cs-lk')) { x.lock = !x.lock; csRender(); csSave(); }
  else if (e.target.closest('.cs-cp')) { clCopy(clUp(x.c)); clRecentAdd(x.c); clLibDraw(); }
  else if (e.target.closest('.cs-x')) { if (cs.pal.colors.length > CS_MIN) { cs.pal.colors = cs.pal.colors.filter(c => c !== x); csRender(); csSave(); } }
  else csRender();
});
csColsEl.addEventListener('change', e => {
  if (!e.target.matches('.cs-hex')) return;
  const x = cs.pal.colors.find(c => c.id === +e.target.closest('.cs-col').dataset.id), c = cpParse('#' + e.target.value.replace(/^#/, ''));
  if (x && c) { x.c = cpHex(c, false); csSave(); }
  csRender();
});
csColsEl.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('.cs-hex')) e.target.blur(); });
$('csRule').addEventListener('change', () => { cs.pal.rule = $('csRule').value; csRandom(); });
$('csRand').onclick = csRandom;
$('csAdd').onclick = () => {
  const cols = cs.pal.colors;
  if (cols.length >= CS_MAX) { toast({type: 'warn', title: t('cs.max', {n: CS_MAX}), ttl: 3000}); return; }
  const o = clLch(cpParse((csSel || cols[cols.length - 1]).c));
  const x = csCol(cpHex(clFit({L: o.L > .6 ? o.L - .25 : o.L + .25, C: Math.max(o.C, .08), H: (o.H + 30) % 360}), false));
  cols.splice(cols.indexOf(csSel) + 1 || cols.length, 0, x);
  csSel = x;
  csRender(); csSave();
};
// палитра в градиент: цвета через равные промежутки
function csToGrad(list) {
  list = list.slice(0, CL_MAX);
  if (list.length < 2) return;
  cl.g.stops = list.map((c, i) => clStop(i / (list.length - 1), c));
  clSel = cl.g.stops[0];
  cl.tool = 'grad';
  clRender(); clSave();
}
// палитра из «Моих цветов» или из фото
function csPalLoad(list) {
  list = csPalOf(list);
  if (list.length < CS_MIN) return;
  cs.pal.colors = list.map(c => csCol(c));
  csSel = cs.pal.colors[0];
  cl.tool = 'pal';
  clRender(); clSave(); csSave();
}

// ---------- оттенки 50–950 ----------
function csShades(base) {
  const b = cpParse(base), o = clLch(b), T = CS_L, last = T.length - 1;
  let i0 = 0;
  T.forEach((L, i) => { if (Math.abs(L - o.L) < Math.abs(T[i0] - o.L)) i0 = i; });
  return T.map((_, i) => {
    if (i === i0) return cpHex(b, false);
    // ступени по обе стороны от основы сжимаются или растягиваются, крайние остаются на месте
    const end = i < i0 ? 0 : last, k = (T[i] - T[end]) / (T[i0] - T[end]), L = T[end] + (o.L - T[end]) * k;
    // тёмный жёлтый выходит болотным: у жёлтых к тёмному краю оттенок уходит к оранжевому (до 40° на всю разницу яркости)
    const yel = Math.max(0, 1 - Math.abs(o.H - 90) / 30), H = o.H - yel * Math.max(o.L - L, 0) * 40 / .7;
    return cpHex(clFit({L, C: Math.min(o.C * CS_C[i] / CS_C[i0], .32), H}), false);
  });
}
function csShadeDraw() {
  const sh = cs.shade, list = csShades(sh.base), sw = $('csBaseSw');
  if (sw.value !== sh.base && !(cp && cp.el === sw)) sw.value = sh.base;
  if (document.activeElement !== $('csBaseHex')) $('csBaseHex').value = clUp(sh.base);
  if (document.activeElement !== $('csName')) $('csName').value = sh.name;
  $('csSteps').innerHTML = list.map((c, i) => `<button type="button" class="cs-step${csLight(c) ? ' lt' : ''}${c === sh.base ? ' base' : ''}" data-c="${c}" style="background:${c}" title="${esc(t('cl.copy'))} ${clUp(c)}"><b>${CS_STEPS[i]}</b><span>${clUp(c)}</span></button>`).join('');
}
cpField($('csBaseSw'), {live: v => { cs.shade.base = v; csRender(); }, done: () => { csSave(); clLibDraw(); }});
$('csBaseHex').addEventListener('change', () => { const c = cpParse($('csBaseHex').value); if (c) { cs.shade.base = cpHex(c, false); csSave(); } csRender(); });
$('csName').addEventListener('change', () => { cs.shade.name = csName($('csName').value) || 'color'; csSave(); csRender(); });
for (const id of ['csBaseHex', 'csName']) $(id).addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
$('csSteps').addEventListener('click', e => { const b = e.target.closest('[data-c]'); if (b) { clCopy(clUp(b.dataset.c)); clRecentAdd(b.dataset.c); clLibDraw(); } });

// ---------- из фото ----------
let csPhSeq = 0;   // номер картинки: по нему снимок отмены видит, что фото сменили
let csPh = null;   // {id, cv — картинка для показа и пипетки (до 1600 по стороне), px — OKLab уменьшенной, pw, ph, pts: [{u, v, c}]}
async function csPhTake(file) {
  if (!file || !/^image\//.test(file.type)) { say('warn', t('cs.phBad'), t('cs.phType')); return; }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = url; });   // decode() в фоновом окне может не завершиться
    const iw = img.naturalWidth || 800, ih = img.naturalHeight || 800, k = Math.min(1, 1600 / Math.max(iw, ih));
    const cv = document.createElement('canvas');
    cv.width = Math.max(Math.round(iw * k), 1); cv.height = Math.max(Math.round(ih * k), 1);
    cv.getContext('2d', {willReadFrequently: true}).drawImage(img, 0, 0, cv.width, cv.height);
    // для подбора хватает картинки до 160 точек по стороне
    const s = Math.min(1, 160 / Math.max(cv.width, cv.height)), sm = document.createElement('canvas');
    sm.width = Math.max(Math.round(cv.width * s), 1); sm.height = Math.max(Math.round(cv.height * s), 1);
    const sx = sm.getContext('2d');
    sx.drawImage(cv, 0, 0, sm.width, sm.height);
    const d = sx.getImageData(0, 0, sm.width, sm.height).data, px = [], at = [];
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) continue;   // прозрачное не считаем
      const o = clLab({r: d[i], g: d[i + 1], b: d[i + 2]});
      px.push(o.L, o.a, o.b); at.push(i / 4);
    }
    if (!at.length) { say('warn', t('cs.phBad'), t('cs.phEmpty')); return; }
    csPh = {id: ++csPhSeq, cv, px: Float32Array.from(px), at, pw: sm.width, ph: sm.height, pts: []};
    cl.tool = 'photo';
    csPhPick();
    clRender(); clSave();
  } catch (e) { say('warn', t('cs.phBad'), t('cs.phType')); }
  finally { URL.revokeObjectURL(url); }
}
// k-средних в OKLab (pos — номер точки картинки шириной pw для каждого цвета); начальные центры — k-means++ с постоянным зерном, чтобы одна картинка давала одну палитру
function csKmeans(px, k, pos, pw) {
  const n = px.length / 3, d2 = (i, c) => (px[i * 3] - c[0]) ** 2 + (px[i * 3 + 1] - c[1]) ** 2 + (px[i * 3 + 2] - c[2]) ** 2;
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const C = [[px[0], px[1], px[2]]], best = new Float32Array(n).fill(Infinity);
  while (C.length < Math.min(k, n)) {
    let sum = 0;
    for (let i = 0; i < n; i++) { best[i] = Math.min(best[i], d2(i, C[C.length - 1])); sum += best[i]; }
    if (!(sum > 0)) break;   // точек одного цвета меньше, чем просят
    let r = rnd() * sum, i = 0;
    while (i < n - 1 && (r -= best[i]) > 0) i++;
    C.push([px[i * 3], px[i * 3 + 1], px[i * 3 + 2]]);
  }
  const own = new Int32Array(n);
  for (let it = 0; it < 16; it++) {
    const acc = C.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) {
      let bj = 0, bd = Infinity;
      for (let j = 0; j < C.length; j++) { const v = d2(i, C[j]); if (v < bd) { bd = v; bj = j; } }
      own[i] = bj;
      const a = acc[bj]; a[0] += px[i * 3]; a[1] += px[i * 3 + 1]; a[2] += px[i * 3 + 2]; a[3]++;
    }
    acc.forEach((a, j) => { if (a[3]) C[j] = [a[0] / a[3], a[1] / a[3], a[2] / a[3]]; });
  }
  // для метки на фото — настоящая точка картинки близкого цвета; из таких берётся ближняя к их середине,
  // иначе метка встаёт на край пятна и под ней смесь с соседним цветом
  return C.map((c, j) => {
    let bd = Infinity, cnt = 0;
    for (let i = 0; i < n; i++) if (own[i] === j) { cnt++; bd = Math.min(bd, d2(i, c)); }
    const tol = Math.max(bd * 2, bd + .0004), near = [];
    for (let i = 0; i < n; i++) if (own[i] === j && d2(i, c) <= tol) near.push(i);
    const xy = i => [pos[i] % pw, Math.floor(pos[i] / pw)];
    let mx = 0, my = 0;
    for (const i of near) { const [x, y] = xy(i); mx += x; my += y; }
    mx /= near.length || 1; my /= near.length || 1;
    let bi = near[0] || 0, bs = Infinity;
    for (const i of near) { const [x, y] = xy(i), s = (x - mx) ** 2 + (y - my) ** 2; if (s < bs) { bs = s; bi = i; } }
    return {i: bi, cnt};
  }).filter(x => x.cnt).sort((a, b) => b.cnt - a.cnt);
}
// Из k пятен по площади заметный, но небольшой цвет (жёлтая плашка на 9% кадра) проигрывает оттенкам большого фона.
// Поэтому пятен берём больше и выбираем жадно: первое самое большое, дальше то, у кого больше
// «расстояние до уже взятых × √доля площади». Совсем мелкие пятна (меньше 1%) идут только на добор.
function csPhChoose(px, k, list) {
  const total = list.reduce((s, x) => s + x.cnt, 0) || 1;
  const col = x => [px[x.i * 3], px[x.i * 3 + 1], px[x.i * 3 + 2]];
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const big = list.filter(x => x.cnt / total >= .01), out = [];
  while (out.length < k && big.length) {
    let bj = 0, bs = -1;
    big.forEach((x, j) => {
      const d = out.length ? Math.min(...out.map(o => dist(col(o), col(x)))) : 1;
      const s = d * Math.sqrt(x.cnt / total);
      if (s > bs) { bs = s; bj = j; }
    });
    out.push(big.splice(bj, 1)[0]);
  }
  for (const x of list) if (out.length < k && !out.includes(x)) out.push(x);
  return out.sort((a, b) => b.cnt - a.cnt);
}
function csPhPick() {
  const p = csPh, k = cs.photo.n;
  p.pts = csPhChoose(p.px, k, csKmeans(p.px, Math.min(k * 2 + 2, 18), p.at, p.pw)).map(x => {
    const at = p.at[x.i], u = (at % p.pw + .5) / p.pw, v = (Math.floor(at / p.pw) + .5) / p.ph;
    return {u, v, c: csPhAt(u, v)};
  });
}
// цвет под меткой: среднее квадрата 5×5 на картинке для показа
function csPhAt(u, v) {
  const cv = csPh.cv, x = Math.min(Math.max(Math.round(u * cv.width) - 2, 0), cv.width - 5), y = Math.min(Math.max(Math.round(v * cv.height) - 2, 0), cv.height - 5);
  const d = cv.getContext('2d', {willReadFrequently: true}).getImageData(Math.max(x, 0), Math.max(y, 0), Math.min(5, cv.width), Math.min(5, cv.height)).data;
  let r = 0, g = 0, b = 0, w = 0;
  for (let i = 0; i < d.length; i += 4) { const a = d[i + 3] / 255; r += d[i] * a; g += d[i + 1] * a; b += d[i + 2] * a; w += a; }
  return w ? cpHex({r: r / w, g: g / w, b: b / w}, false) : '#000000';
}
const csPhCv = $('csPhCv');
function csPhDraw() {
  const has = !!csPh;
  $('csPh').classList.toggle('hide', !has);
  $('csPhNone').classList.toggle('hide', has);
  $('csPhClear').disabled = !has;
  $('csPhPick').classList.toggle('hide', !has);   // без фото кнопка уже есть посередине поля
  $('csPhHint').classList.toggle('hide', !has);
  if (document.activeElement !== $('csPhN')) $('csPhN').value = cs.photo.n;
  if (!has) { $('csStrip').innerHTML = ''; return; }
  const box = $('csPhView'), W = csPh.cv.width, H = csPh.cv.height;
  const k = Math.min((box.clientWidth - 24) / W, (box.clientHeight - 24) / H);
  if (k > 0) {
    const cw = Math.max(Math.round(W * k), 1), ch = Math.max(Math.round(H * k), 1), dpr = devicePixelRatio || 1;
    $('csPh').style.width = cw + 'px'; $('csPh').style.height = ch + 'px';
    const pw = Math.round(cw * dpr), ph = Math.round(ch * dpr);
    if (csPhCv.width !== pw || csPhCv.height !== ph || csPhCv.from !== csPh.cv) {
      csPhCv.width = pw; csPhCv.height = ph; csPhCv.from = csPh.cv;
      const x = csPhCv.getContext('2d');
      x.imageSmoothingQuality = 'high';
      x.drawImage(csPh.cv, 0, 0, pw, ph);
    }
  }
  const wrap = $('csPh'), have = [...wrap.querySelectorAll('.cs-mk')];
  csPh.pts.forEach((p, i) => {
    let m = have[i];
    if (!m) { m = document.createElement('i'); m.className = 'cs-mk'; wrap.append(m); }
    m.dataset.i = i;
    m.style.left = clPct(p.u); m.style.top = clPct(p.v);
    m.style.setProperty('--c', p.c);
  });
  have.slice(csPh.pts.length).forEach(m => m.remove());
  $('csStrip').innerHTML = csPh.pts.map(p => `<button type="button" class="cs-step${csLight(p.c) ? ' lt' : ''}" data-c="${p.c}" style="background:${p.c}" title="${esc(t('cl.copy'))} ${clUp(p.c)}"><span>${clUp(p.c)}</span></button>`).join('');
}
// метку тянут по фото: цвет берётся из-под неё
let csMkDrag = null;
$('csPh').addEventListener('pointerdown', e => {
  const m = e.target.closest('.cs-mk');
  if (!m || e.button !== 0) return;
  csMkDrag = {i: +m.dataset.i, id: e.pointerId};
  m.setPointerCapture(e.pointerId);
  m.classList.add('on');
});
$('csPh').addEventListener('pointermove', e => {
  const d = csMkDrag;
  if (!d || d.id !== e.pointerId || !csPh) return;
  const r = $('csPh').getBoundingClientRect(), p = csPh.pts[d.i];
  p.u = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1);
  p.v = Math.min(Math.max((e.clientY - r.top) / r.height, 0), 1);
  p.c = csPhAt(p.u, p.v);
  csPhDraw();
});
const csMkEnd = e => { if (csMkDrag && csMkDrag.id === e.pointerId) { $('csPh').querySelectorAll('.cs-mk.on').forEach(m => m.classList.remove('on')); csMkDrag = null; clMark(); } };
$('csPh').addEventListener('pointerup', csMkEnd);
$('csPh').addEventListener('pointercancel', csMkEnd);
$('csStrip').addEventListener('click', e => { const b = e.target.closest('[data-c]'); if (b) { clCopy(clUp(b.dataset.c)); clRecentAdd(b.dataset.c); clLibDraw(); } });
$('csPhN').addEventListener('change', () => { cs.photo.n = +$('csPhN').value; if (csPh) csPhPick(); csSave(); csRender(); });
// «Очистить»: убрать фото, чтобы положить другое (Ctrl+Z вернёт)
$('csPhClear').onclick = () => { csPh = null; clRender(); clMark(); };
const csPhOpen = () => dialog(async () => {
  const r = await api('pick-files');
  if (r.error) { say('warn', t('warn.title'), r.error); return; }
  const p = r.files && r.files[0] && r.files[0].path;
  if (!p) return;
  const x = await api('fav-read', {path: p});
  if (x.error) { say('warn', t('cs.phBad'), x.error); return; }
  const bin = atob(x.data), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const ext = x.name.split('.').pop().toLowerCase();
  const type = ext === 'svg' ? 'image/svg+xml' : ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  await csPhTake(new File([u8], x.name, {type}));
});
$('csPhPick').onclick = csPhOpen;
$('csPhPick2').onclick = csPhOpen;
// перетаскивание на вкладку «Цвет» (зовёт drop.js): пока файл над окном, открыто «Из фото» и его поле подсвечено;
// унесли файл обратно — возвращается прежний инструмент, бросили — картинка в «Из фото»
let csDragWas = null;
function csDragIn() {
  if (csDragWas === null) csDragWas = cl.tool;
  if (cl.tool !== 'photo') { cl.tool = 'photo'; clRender(); }
  $('csPhView').classList.add('over');
}
function csDragOut(dropped) {
  $('csPhView').classList.remove('over');
  if (!dropped && csDragWas && cl.tool !== csDragWas) { cl.tool = csDragWas; clRender(); }
  csDragWas = null;
}
function csDrop(e) { csDragOut(true); const f = [...(e.dataTransfer.files || [])][0]; if (f) csPhTake(f); }
new ResizeObserver(() => { if (tab === 'color' && cl.tool === 'photo') csPhDraw(); }).observe($('csPhView'));

// ---------- общий набор и выгрузка ----------
// цвета инструмента: {hex, name} — имя для CSS, JSON и ASE
function csList() {
  if (cl.tool === 'shade') return csShades(cs.shade.base).map((hex, i) => ({hex, name: `${cs.shade.name}-${CS_STEPS[i]}`}));
  const list = cl.tool === 'photo' ? (csPh ? csPh.pts.map(p => p.c) : []) : cs.pal.colors.map(x => x.c);
  return list.map((hex, i) => ({hex, name: `color-${i + 1}`}));
}
const csBase = () => cl.tool === 'shade' ? cs.shade.name : cl.tool === 'photo' ? 'photo-palette' : 'palette';
function csCss(list) { return `:root {\n${list.map(x => `  --${x.name}: ${x.hex};`).join('\n')}\n}`; }
function csJson(list) {
  if (cl.tool === 'shade') return JSON.stringify({[cs.shade.name]: Object.fromEntries(list.map((x, i) => [CS_STEPS[i], x.hex]))}, null, 2);
  return JSON.stringify(list.map(x => x.hex), null, 2);
}
// SVG и PNG: квадраты в ряд, под каждым имя ступени (у оттенков) и HEX
const CS_SQ = 240;
function csSvg(list) {
  const W = CS_SQ * list.length, H = CS_SQ, shade = cl.tool === 'shade';
  const body = list.map((x, i) => {
    const X = i * CS_SQ, ink = csLight(x.hex) ? '#1a1a1a' : '#ffffff';
    return `<rect x="${X}" width="${CS_SQ}" height="${H}" fill="${x.hex}"/>` +
      (shade ? `<text x="${X + 20}" y="${H - 52}" fill="${ink}" font-size="22" font-weight="700">${CS_STEPS[i]}</text>` : '') +
      `<text x="${X + 20}" y="${H - 22}" fill="${ink}" font-size="20">${clUp(x.hex)}</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, Arial, sans-serif">${body}</svg>`;
}
function csPng(list) {
  const c = document.createElement('canvas'), shade = cl.tool === 'shade';
  c.width = CS_SQ * list.length; c.height = CS_SQ;
  const x = c.getContext('2d');
  list.forEach((s, i) => {
    const X = i * CS_SQ;
    x.fillStyle = s.hex; x.fillRect(X, 0, CS_SQ, CS_SQ);
    x.fillStyle = csLight(s.hex) ? '#1a1a1a' : '#ffffff';
    if (shade) { x.font = '700 22px "Segoe UI", Arial, sans-serif'; x.fillText(String(CS_STEPS[i]), X + 20, CS_SQ - 52); }
    x.font = '20px "Segoe UI", Arial, sans-serif';
    x.fillText(clUp(s.hex), X + 20, CS_SQ - 22);
  });
  return c.toDataURL('image/png').split(',')[1];
}
const csNeed = () => { const l = csList(); if (!l.length) toast({type: 'warn', title: t('cs.none'), ttl: 2500}); return l.length ? l : null; };
$('csCss').onclick = () => { const l = csNeed(); if (l) clCopy(csCss(l), t('cl.cssCopied')); };
$('csJson').onclick = () => { const l = csNeed(); if (l) clCopy(csJson(l), t('cs.jsonCopied')); };
$('csAse').onclick = () => dialog(async () => {
  const l = csNeed();
  if (l) clSaved(await api('color-save', {ext: 'ase', name: csBase(), data: JSON.stringify({name: csBase(), colors: cl.tool === 'shade' ? l : l.map(x => ({hex: x.hex}))})}));
});
$('csSvg').onclick = () => dialog(async () => { const l = csNeed(); if (l) clSaved(await api('color-save', {ext: 'svg', name: csBase(), data: csSvg(l)})); });
$('csPng').onclick = () => dialog(async () => { const l = csNeed(); if (l) clSaved(await api('color-save', {ext: 'png', name: csBase(), data: csPng(l)})); });

// цвет из «Моих цветов» или недавних (зовёт clUse): в палитре — в выбранную колонку, в оттенках — основой
function csUse(hex) {
  hex = cpHex(cpParse(hex), false);
  if (cl.tool === 'shade') cs.shade.base = hex;
  else if (cl.tool === 'pal') { const x = csSel || cs.pal.colors[0]; x.c = hex; csSel = x; }
  else return;
  csRender(); csSave();
}

function csRender() {
  const tool = cl.tool;
  $('csPal').classList.toggle('hide', tool !== 'pal');
  $('csShade').classList.toggle('hide', tool !== 'shade');
  $('csPhoto').classList.toggle('hide', tool !== 'photo');
  if (!cs.pal.colors.includes(csSel)) csSel = null;
  if (tool === 'pal') { $('csRule').value = cs.pal.rule; csColsDraw(); }
  else if (tool === 'shade') csShadeDraw();
  else if (tool === 'photo') csPhDraw();
  const none = !csList().length;   // пустое «Из фото»: выгрузка тусклая, по нажатию скажет, что цветов нет
  for (const id of ['csCss', 'csJson', 'csAse', 'csSvg', 'csPng']) $(id).classList.toggle('cl-no', none);
}
function csRelang() { csColsSig = ''; clSendSig = ''; }

// ---------- отправить в другой инструмент ----------
// Наборы (градиент, палитра, фото, оттенки) идут набором, в оттенки — один цвет:
// выбранная точка градиента, выбранная колонка палитры, основа оттенков, первый цвет фото.
const CL_SEND = {grad: ['pal', 'shade', 'ctr'], pal: ['grad', 'shade', 'ctr'], photo: ['pal', 'grad', 'shade', 'ctr'],
  shade: ['pal', 'grad', 'ctr'], pick: ['grad', 'pal', 'shade', 'ctr'], ctr: ['grad', 'pal', 'shade']};
const CL_TOOL_NAME = {grad: 'cl.tGrad', pal: 'cs.tPal', shade: 'cs.tShade', pick: 'cl.tPick', ctr: 'cl.tCtr'};
const clOpaque = c => cpHex(cpParse(c), false);
function clSetOf(tool) {
  if (tool === 'grad') return clSorted(cl.g).map(s => clOpaque(s.c));
  if (tool === 'pal') return cs.pal.colors.map(x => x.c);
  if (tool === 'photo') return csPh ? csPh.pts.map(p => p.c) : [];
  if (tool === 'shade') {   // из 11 ступеней пять через одну, основа среди них обязательно
    const l = csShades(cs.shade.base), i0 = l.indexOf(cs.shade.base), idx = [1, 3, 5, 7, 9];
    let j = 0;
    idx.forEach((v, k) => { if (Math.abs(v - i0) < Math.abs(idx[j] - i0)) j = k; });
    idx[j] = i0;
    return [...new Set(idx)].sort((a, b) => a - b).map(i => l[i]);
  }
  if (tool === 'ctr') return [cl.ctr.fg, cl.ctr.bg];
  return [cl.pick];
}
function clOneOf(tool) {
  if (tool === 'grad') return clOpaque((clSel || clSorted(cl.g)[0]).c);
  if (tool === 'pal') return (csSel || cs.pal.colors[0]).c;
  if (tool === 'shade') return cs.shade.base;
  if (tool === 'photo') return csPh && csPh.pts[0] ? csPh.pts[0].c : null;
  if (tool === 'ctr') return cl.ctr.fg;
  return cl.pick;
}
function clSendTo(to) {
  const from = cl.tool, one = clOneOf(from), list = clSetOf(from);
  if (!one) { toast({type: 'warn', title: t('cs.none'), ttl: 2500}); return; }
  if (to === 'shade') cs.shade.base = one;
  else if (to === 'pick') cl.pick = one;
  else if (to === 'ctr') { cl.ctr.fg = list.length > 1 ? list[0] : one; if (list.length > 1) cl.ctr.bg = list[list.length - 1]; }   // набор: первый цвет — текст, последний — фон
  else if (from === 'pick' && to === 'grad') { if (!clAddStop(one)) return; }
  else if (from === 'pick' && to === 'pal') {
    const cols = cs.pal.colors;
    if (cols.length >= CS_MAX) { toast({type: 'warn', title: t('cs.max', {n: CS_MAX}), ttl: 3000}); return; }
    csSel = csCol(one);
    cols.push(csSel);
  } else if (list.length < 2) { toast({type: 'warn', title: t('cs.few'), ttl: 3000}); return; }
  else if (to === 'grad') csToGrad(list);
  else csPalLoad(list);
  cl.tool = to;
  clRender(); clSave(); csSave();
}
let clSendSig = '';
// одна кнопка «Отправить в ▾»: по нажатию выпадает список инструментов; в пипетку слать нечего (она берёт цвет с экрана), поэтому её в списке нет
function clSendDraw() {
  const sig = cl.tool + (cl.tool === 'photo' ? !!csPh : '');
  if (sig === clSendSig) return;
  clSendSig = sig;
  const to = CL_SEND[cl.tool] || [], off = cl.tool === 'photo' && !csPh;
  document.querySelectorAll('.cl-send').forEach(el => {
    el.innerHTML = `<button type="button" class="btn sm cl-sendb" aria-haspopup="true" aria-expanded="false"${off ? ' disabled' : ''}>${esc(t('cs.send'))} <i class="cl-car"></i></button>`
      + `<div class="cl-sendm hide" role="menu">` + to.map(k => `<button type="button" role="menuitem" data-to="${k}">${esc(t(CL_TOOL_NAME[k]))}</button>`).join('') + `</div>`;
  });
}
function clSendClose() {
  document.querySelectorAll('.cl-sendm').forEach(m => m.classList.add('hide'));
  document.querySelectorAll('.cl-sendb').forEach(b => b.setAttribute('aria-expanded', 'false'));
}
document.addEventListener('click', e => {
  const b = e.target.closest('.cl-send [data-to]');
  const open = e.target.closest('.cl-sendb');
  if (b) { clSendClose(); clSendTo(b.dataset.to); return; }
  const wasHidden = open && open.parentNode.querySelector('.cl-sendm').classList.contains('hide');
  clSendClose();
  if (open && wasHidden) { open.parentNode.querySelector('.cl-sendm').classList.remove('hide'); open.setAttribute('aria-expanded', 'true'); }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && document.querySelector('.cl-sendm:not(.hide)')) { clSendClose(); e.stopPropagation(); } }, true);

// ---------- отмена: Ctrl+Z, вернуть: Ctrl+Shift+Z или Ctrl+Y ----------
// Снимок берётся после каждого сохранения (clSave, csSave, clLibSet и конец тяги метки зовут clMark), если что-то изменилось.
// Выбранный инструмент в снимок не входит: отмена возвращает цвета, а не переключение. Фото — ссылкой, метки — копией.
// «Мои цвета» входят: случайно убранный цвет тоже возвращается.
const CL_UNDO_N = 100;
let clHist = null;
function clSnap() {
  const {tool, ...rest} = cl;
  const pts = csPh ? csPh.pts.map(p => ({...p})) : null;
  return {key: JSON.stringify({c: {...rest, g: clPlain(cl.g)}, s: csPlainState(), l: storeGet(CL_LIB_KEY) || '[]', p: csPh ? csPh.id : 0, pts}), ph: csPh, pts};
}
function clMark() {
  if (!clHist) return;
  const s = clSnap();
  if (s.key === clHist.cur.key) return;
  clHist.undo.push(clHist.cur);
  if (clHist.undo.length > CL_UNDO_N) clHist.undo.shift();
  clHist.redo = [];
  clHist.cur = s;
}
function clBack(from, to) {
  if (!from.length) return;
  to.push(clHist.cur);
  const s = clHist.cur = from.pop(), o = JSON.parse(s.key);
  cl = {...o.c, tool: cl.tool, g: clValidG(o.c.g) || cl.g};
  cs = csFrom(o.s);
  storeSet(CL_LIB_KEY, o.l);
  csPh = s.ph;
  if (csPh) csPh.pts = s.pts.map(p => ({...p}));
  clSel = null; csSel = null; clChipsSig = ''; csColsSig = ''; clSendSig = '';
  clRender(); clSave(); csSave();   // снимок тот же — новый шаг не появится
}
document.addEventListener('keydown', e => {
  if (tab !== 'color' || !(e.ctrlKey || e.metaKey) || e.altKey || cp || tkTyping(e.target) || document.querySelector('.modal:not(.hide)')) return;
  if (e.code !== 'KeyZ' && e.code !== 'KeyY') return;
  e.preventDefault();
  if (e.code === 'KeyY' || e.shiftKey) clBack(clHist.redo, clHist.undo); else clBack(clHist.undo, clHist.redo);
});

csLoad();
clHist = {undo: [], redo: [], cur: clSnap()};
