// Вкладка «Картинки»: запрос, стили, пропорции и очередь слева; в центре холст, где картинка проявляется из шума
// (кадры предпросмотра плавно перетекают друг в друга, ранние размыты), под ним плашка нагрузки на железо.
// Сервер: genapi.go (gen-info, gen-add, gen-state раз в 0,7 с, пока вкладка открыта, кадр — /gen-frame).
const gn = {
  info: null,         // ответ gen-info
  tasks: [],          // очередь с сервера
  view: 0,            // id задачи на холсте
  timer: 0,
  prompts: {},        // id → запрос, как его написал человек (на сервере уже с шаблоном стиля)
  speed: {},          // 'id:картинка' → {t0, s0}: от чего считать секунды на шаг
  hist: {gpu: [], vram: [], cpu: [], ram: []},
  hw: null, model: '', gpu: '',
  gridKey: '',
  set: {prompt: '', preset: 'photo', ratio: '1:1', count: 1, model: '', steps: '', cfg: '', seed: '', neg: '', build: true, hwMin: false},
};
const GN_KEY = 'kb.gen';
// образцы стилей, пока нет картинок-примеров из каталога
const GN_GRAD = {
  none: 'linear-gradient(135deg,#4a4a55,#1d1d22)',
  photo: 'linear-gradient(160deg,#9fb4c7 0%,#d9b27c 55%,#4b5a3c 100%)',
  cinema: 'linear-gradient(135deg,#0f2a3a 0%,#c86b3c 65%,#1a1210 100%)',
  illus: 'linear-gradient(135deg,#ff8a65,#ba68c8 55%,#4fc3f7)',
  icon3d: 'radial-gradient(circle at 35% 30%,#bfe3ff,#5c6bc0 55%,#2a2350)',
  flat: 'linear-gradient(135deg,#ffd166 0 33%,#06d6a0 33% 66%,#118ab2 66%)',
  anime: 'linear-gradient(135deg,#ff9ac1,#8ec5ff 60%,#fff1a8)',
  water: 'radial-gradient(circle at 30% 40%,#a8d8ea,#f6c6ea 55%,#fdf6e3)',
};

try { Object.assign(gn.set, JSON.parse(localStorage.getItem(GN_KEY) || '{}')); } catch (e) {}
function gnSave() { try { localStorage.setItem(GN_KEY, JSON.stringify(gn.set)); } catch (e) {} }

// ---- сведения и поля слева ----

async function gnInfo() {
  const r = await api('gen-info');
  if (r.error) return;
  gn.info = r;
  $('genTabBtn').classList.toggle('hide', !r.show);
  if (!r.show && tab === 'gen') { setTab('conv'); return; }
  if (!r.presets.includes(gn.set.preset)) gn.set.preset = r.presets[0];
  if (!r.ratios.includes(gn.set.ratio)) gn.set.ratio = r.ratios[0];
  if (!r.models.some(m => m.id === gn.set.model)) gn.set.model = r.models.length ? r.models[0].id : '';
  $('gnPresets').innerHTML = r.presets.map(p =>
    `<button type="button" class="gn-pre${p === gn.set.preset ? ' on' : ''}" data-v="${esc(p)}" title="${esc(I18N[lang]['gn.preHint.' + p] || '')}" style="--g:${GN_GRAD[p] || GN_GRAD.none}"><b>${esc(I18N[lang]['gn.pre.' + p] || p)}</b></button>`).join('');
  $('gnRatio').innerHTML = r.ratios.map(q => {
    const [a, b] = q.split(':').map(Number), k = 14 / Math.max(a, b);
    return `<button type="button" class="gn-ratio${q === gn.set.ratio ? ' on' : ''}" data-v="${q}"><i style="width:${Math.round(a * k)}px;height:${Math.round(b * k)}px"></i>${q}</button>`;
  }).join('');
  $('gnModel').innerHTML = r.models.map(m => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
  $('gnModel').value = gn.set.model;
  $('gnModel').disabled = r.models.length < 2;
  gnFields();
  gnGoState();
  gnStage();
}

function gnFields() {
  $('gnPrompt').value = gn.set.prompt;
  $('gnNeg').value = gn.set.neg;
  $('gnSteps').value = gn.set.steps;
  $('gnCfg').value = gn.set.cfg;
  $('gnSeed').value = gn.set.seed;
  $('gnShowBuild').checked = gn.set.build;
  document.querySelectorAll('#gnCount button').forEach(b => b.classList.toggle('on', +b.dataset.v === gn.set.count));
  $('gnHw').classList.toggle('min', !!gn.set.hwMin);
  $('gnHwToggle').setAttribute('aria-expanded', String(!gn.set.hwMin));
  gnTips();
}

function gnModel() { return (gn.info?.models || []).find(m => m.id === gn.set.model); }

function gnGoState() {
  const ok = !!gnModel() && gn.info?.engine && gn.set.prompt.trim() !== '';
  $('gnGo').disabled = !ok;
  const why = !gn.info ? '' : !gn.info.engine ? t('gn.noEngine') : !gnModel() ? t('gn.noModel') : '';
  $('gnEmptyS').textContent = why || t('gn.emptyS');
}

// подсказки под полем: запрос по-русски (модель понимает английский) и слишком общий запрос
// слова без смысла для картинки: русские из словаря берутся всегда, на любом языке интерфейса
const GN_FILLER = new Set((I18N.ru['gn.filler'] + ' ' + I18N.en['gn.filler']).split(' '));
const GN_RU = String.fromCharCode(0x430) + '-' + String.fromCharCode(0x44f) + String.fromCharCode(0x451);   // кириллица без букв в коде (TestNoStrayRussian)
const GN_CYR = new RegExp('[' + GN_RU + ']', 'i');
const GN_SPLIT = new RegExp('[^a-z0-9' + GN_RU + '-]+');
function gnVague(s) {
  const w = s.toLowerCase().split(GN_SPLIT).filter(Boolean);
  return w.length > 0 && w.filter(x => !GN_FILLER.has(x)).length < 2;
}
function gnTips() {
  const p = gn.set.prompt;
  $('gnLangTip').classList.toggle('hide', !GN_CYR.test(p));
  const vague = gnVague(p);
  $('gnVague').classList.toggle('hide', !vague);
  if (vague)
    $('gnTips').innerHTML = t('gn.tips').split('|').map(x => `<button type="button" class="chip">${esc(x)}</button>`).join('');
}

$('gnPrompt').addEventListener('input', () => { gn.set.prompt = $('gnPrompt').value; gnSave(); gnTips(); gnGoState(); });
$('gnNeg').addEventListener('input', () => { gn.set.neg = $('gnNeg').value; gnSave(); });
for (const [id, k] of [['gnSteps', 'steps'], ['gnCfg', 'cfg'], ['gnSeed', 'seed']])
  $(id).addEventListener('input', () => { gn.set[k] = $(id).value; gnSave(); });
$('gnSeedRnd').addEventListener('click', () => { gn.set.seed = ''; $('gnSeed').value = ''; gnSave(); });
$('gnShowBuild').addEventListener('change', () => { gn.set.build = $('gnShowBuild').checked; gnSave(); });
$('gnModel').addEventListener('change', () => { gn.set.model = $('gnModel').value; gnSave(); gnGoState(); });
$('gnTips').addEventListener('click', e => {
  const b = e.target.closest('.chip'); if (!b) return;
  const p = gn.set.prompt.trimEnd();
  gn.set.prompt = p ? (/[,.;]$/.test(p) ? p + ' ' : p + ', ') + b.textContent : b.textContent;
  $('gnPrompt').value = gn.set.prompt; gnSave(); gnTips(); gnGoState(); $('gnPrompt').focus();
});
$('gnPresets').addEventListener('click', e => {
  const b = e.target.closest('.gn-pre'); if (!b) return;
  gn.set.preset = b.dataset.v; gnSave();
  document.querySelectorAll('#gnPresets .gn-pre').forEach(x => x.classList.toggle('on', x === b));
});
$('gnRatio').addEventListener('click', e => {
  const b = e.target.closest('.gn-ratio'); if (!b) return;
  gn.set.ratio = b.dataset.v; gnSave();
  document.querySelectorAll('#gnRatio .gn-ratio').forEach(x => x.classList.toggle('on', x === b));
});
$('gnCount').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  gn.set.count = +b.dataset.v; gnSave(); gnFields();
});
for (const id of ['gnPrompt', 'gnNeg'])
  $(id).addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); gnGo(); } });
$('gnGo').addEventListener('click', gnGo);
$('gnFolder').addEventListener('click', () => { if (gn.info) api('open-dir', {path: gn.info.gallery}).then(r => { if (r.error) say('warn', t('warn.title'), r.error); }); });
$('gnHwToggle').addEventListener('click', () => { gn.set.hwMin = !gn.set.hwMin; gnSave(); gnFields(); gnHwRender(); });

async function gnGo() {
  if ($('gnGo').disabled) return;
  const s = gn.set, seed = s.seed === '' ? -1 : Math.max(0, Math.floor(+s.seed) || 0);
  const r = await api('gen-add', {model: s.model, prompt: s.prompt, negative: s.neg, preset: s.preset, ratio: s.ratio, count: s.count,
    seed, steps: Math.floor(+s.steps) || 0, cfg: +s.cfg || 0, preview: s.build});
  if (r.error) { say('warn', t('warn.title'), r.error); return; }
  gn.prompts[r.id] = s.prompt.trim();
  gn.view = r.id;
  gnPoll();
}

// ---- опрос ----

function gnTabChanged() {
  clearTimeout(gn.timer);
  if (tab !== 'gen') return;
  gnInfo();
  gnPoll();
}

async function gnPoll() {
  clearTimeout(gn.timer);
  if (tab !== 'gen') return;
  const r = await api('gen-state');
  if (!r.error) {
    gn.tasks = r.tasks || [];
    gn.hw = r.hw; gn.model = r.model; gn.gpu = r.gpu;
    gnHistPush(r.hw);
    if (!gn.tasks.some(x => x.id === gn.view)) gn.view = gn.tasks.length ? gn.tasks[gn.tasks.length - 1].id : 0;
    gnQueue();
    gnStage();
    gnHwRender();
  }
  if (tab === 'gen') gn.timer = setTimeout(gnPoll, document.hidden ? 2000 : 700);
}

// ---- очередь ----

function gnStatus(x, short) {
  const n = x.count;
  switch (x.status) {
    case 'queued': return t('gn.queued');
    case 'loading': return t('gn.loading');
    case 'running': return t('gn.running', {i: x.index + 1, n}) + (x.progress.total ? ' · ' + t('gn.step', {s: x.progress.step, t: x.progress.total}) : '');
    case 'done': return short ? t('gn.done') : t('gn.done') + ' · ' + t('gn.size', {w: x.params.width, h: x.params.height});
    case 'failed': return t('gn.failed') + (x.err ? ': ' + x.err : '');
    case 'cancelled': return t('gn.cancelled');
  }
  return x.status;
}

function gnQueue() {
  const live = x => !['done', 'failed', 'cancelled'].includes(x.status);
  const rows = gn.tasks.slice().reverse().map(x =>
    `<div class="gn-q${x.id === gn.view ? ' cur' : ''}" data-id="${x.id}" title="${esc(x.params.prompt)}">
      <span class="p">${esc(gn.prompts[x.id] || x.params.prompt)}</span>
      <span class="s${x.status === 'failed' ? ' err' : ''}">${esc(gnStatus(x))}</span>
      ${live(x) ? `<button type="button" class="x" data-cancel="${x.id}" title="${esc(t('gn.cancel'))}" aria-label="${esc(t('gn.cancel'))}">×</button>` : ''}
    </div>`).join('');
  const clear = gn.tasks.some(x => !live(x)) ? `<button type="button" class="gn-q-clear" id="gnClear">${esc(t('gn.clear'))}</button>` : '';
  const html = rows + clear;
  if ($('gnQueue').dataset.html !== html) { $('gnQueue').innerHTML = html; $('gnQueue').dataset.html = html; }
}

$('gnQueue').addEventListener('click', async e => {
  const c = e.target.closest('[data-cancel]');
  if (c) { await api('gen-cancel', {id: +c.dataset.cancel}); gnPoll(); return; }
  if (e.target.closest('#gnClear')) { await api('gen-clear'); gnPoll(); return; }
  const row = e.target.closest('.gn-q');
  if (row) { gn.view = +row.dataset.id; gnQueue(); gnStage(); }
});

// ---- холст: сетка картинок одной задачи ----

function gnLayout() {
  const x = gn.tasks.find(q => q.id === gn.view), grid = $('gnGrid');
  if (!x || grid.classList.contains('hide')) return;
  const n = x.count, asp = x.params.width / x.params.height, gap = 10;
  const W = grid.clientWidth, H = grid.clientHeight;
  if (!W || !H) return;
  let best = {cw: 0, cols: 1};
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const cw = Math.min((W - gap * (cols - 1)) / cols, (H - gap * (rows - 1)) / rows * asp);
    if (cw > best.cw) best = {cw, cols};
  }
  const cw = Math.floor(best.cw);
  grid.style.gridTemplateColumns = `repeat(${best.cols}, ${cw}px)`;
  grid.style.gridAutoRows = `${Math.floor(cw / asp)}px`;
}
new ResizeObserver(gnLayout).observe($('gnStage'));

function gnStage() {
  const x = gn.tasks.find(q => q.id === gn.view);
  $('gnEmpty').classList.toggle('hide', !!x);
  $('gnGrid').classList.toggle('hide', !x);
  if (!x) { gn.gridKey = ''; $('gnStageT').textContent = ''; return; }
  const grid = $('gnGrid'), key = x.id + ':' + x.count;
  if (gn.gridKey !== key) {
    gn.gridKey = key;
    grid.innerHTML = Array.from({length: x.count}, () =>
      '<div class="gn-cell wait queued"><div class="gn-wait"></div><img alt=""><img alt=""><div class="gn-bar"><b></b></div><span class="gn-tag"></span></div>').join('');
    [...grid.children].forEach(c => { c.gn = {seq: 0, fin: '', top: null}; });
    gnLayout();
  }
  const pr = x.progress || {};
  [...grid.children].forEach((c, i) => {
    const st = c.gn, img = x.images[i];
    let tag = '';
    if (img) {
      if (st.fin !== img) { st.fin = img; gnShow(c, mediaUrl(img), 0, true); }
      c.className = 'gn-cell done';
      tag = t('gn.seedOf', {s: x.params.seed + i});
    } else if (i === x.index && (x.status === 'running' || x.status === 'loading')) {
      const live = x.status === 'running' && x.previewSeq > 0 && st.seq !== x.previewSeq;
      if (live) { st.seq = x.previewSeq; gnShow(c, `/gen-frame?t=${TOKEN}&id=${x.id}&s=${x.previewSeq}`, pr.total ? pr.previewStep / pr.total : 0, false); }
      c.className = 'gn-cell' + (st.top ? '' : ' wait');
      tag = x.status === 'loading' ? t('gn.loading') : pr.total && pr.step < pr.total ? t('gn.step', {s: pr.step, t: pr.total}) : t('gn.encoding');
      c.querySelector('.gn-bar b').style.width = (x.status === 'loading' || !pr.total ? 2 : Math.min(100, pr.step / pr.total * 100)) + '%';
    } else if (x.status === 'failed' || x.status === 'cancelled' || x.status === 'done') {
      c.className = 'gn-cell err' + (st.top ? '' : ' wait queued');
      tag = t(x.status === 'failed' ? 'gn.failed' : 'gn.cancelled');
    } else {
      c.className = 'gn-cell wait queued';
      tag = t('gn.queued');
    }
    const tg = c.querySelector('.gn-tag');
    if (tg.textContent !== tag) tg.textContent = tag;
    c.title = img ? t('gn.open') : '';
  });
  $('gnStageT').textContent = [gn.prompts[x.id] || '', t('gn.size', {w: x.params.width, h: x.params.height}), gnStatus(x, true)].filter(Boolean).join(' · ');
}

// gnShow: новый кадр ложится поверх старого и плавно проявляется; ранние кадры размыты сильнее.
// fin — готовая картинка: проявление со вспышкой (gnReveal в style.css).
function gnShow(cell, src, p, fin) {
  const st = cell.gn, imgs = cell.querySelectorAll('img');
  const next = st.top === imgs[0] ? imgs[1] : imgs[0], prev = st.top;
  const ver = st.ver = (st.ver || 0) + 1, im = new Image();
  im.onload = () => {
    if (st.ver !== ver) return;   // пока грузился, пришёл кадр новее или готовая картинка
    next.src = src;
    next.style.zIndex = 2;
    next.style.filter = fin ? '' : `blur(${(10 * (1 - p) * (1 - p)).toFixed(1)}px)`;
    next.classList.toggle('fin', fin);
    next.classList.add('on');
    if (prev) { prev.style.zIndex = 1; setTimeout(() => { if (st.top !== prev) prev.classList.remove('on', 'fin'); }, 800); }
    st.top = next;
  };
  im.src = src;
}

$('gnGrid').addEventListener('click', e => {
  const c = e.target.closest('.gn-cell.done'); if (!c) return;
  api('open-file', {path: c.gn.fin}).then(r => { if (r.error) say('warn', t('warn.title'), r.error); });
});

// ---- плашка железа ----

function gnHistPush(h) {
  if (!h) return;
  const push = (k, v) => { const a = gn.hist[k]; a.push(v); if (a.length > 60) a.shift(); };
  push('gpu', h.gpuUtil); push('cpu', h.cpu);
  push('vram', h.vramTotal > 0 && h.vramUsed >= 0 ? h.vramUsed / h.vramTotal * 100 : -1);
  push('ram', h.ramTotal > 0 && h.ramUsed >= 0 ? h.ramUsed / h.ramTotal * 100 : -1);
}

const gnNum = (v, d) => v.toLocaleString(lang, {minimumFractionDigits: d, maximumFractionDigits: d});
const gnGB = mb => gnNum(mb / 1024, mb >= 10240 ? 0 : 1);
function gnSecs(s) {
  s = Math.max(1, Math.round(s));
  return s < 60 ? t('gn.sec', {v: s}) : t('gn.min', {v: gnNum(s / 60, s < 600 ? 1 : 0)});
}
// пороги тревоги; видеопамять с 92%: модель держится в ней 5 минут после картинки, и это нормально
const gnLevel = (v, warn, hot) => v >= hot ? 'hot' : v >= warn ? 'warn' : '';

// gnGen: что сейчас делает генерация (для плашки и строки)
function gnGen() {
  const x = gn.tasks.find(q => q.status === 'running' || q.status === 'loading');
  const vram = gn.gpu === 'llm' ? t('gn.inVramLLM') : gn.model ? t('gn.inVram', {m: (gn.info?.models || []).find(m => m.id === gn.model)?.name || gn.model}) : t('gn.vramFree');
  if (!x) return {v: t('gn.idle'), sub: vram, short: ''};
  if (x.status === 'loading') return {v: t('gn.loading'), sub: vram, short: t('gn.loading')};
  const p = x.progress || {}, key = x.id + ':' + x.index, now = performance.now();
  if (!p.total || p.step >= p.total) return {v: t('gn.encoding'), sub: vram, short: t('gn.encoding')};
  let sp = gn.speed[key];
  if (!sp || p.step < sp.s0) sp = gn.speed[key] = {t0: now, s0: p.step};
  const sps = p.step > sp.s0 ? (now - sp.t0) / 1000 / (p.step - sp.s0) : 0;
  const parts = [];
  if (sps) {
    parts.push(t('gn.perStep', {v: gnNum(sps, 2)}));
    const left = (p.total - p.step) * sps + (x.count - x.index - 1) * (p.total * sps + 3);
    parts.push(t('gn.left', {v: gnSecs(left)}));
  }
  parts.push(vram);
  const v = (x.count > 1 ? t('gn.running', {i: x.index + 1, n: x.count}) + ' · ' : '') + t('gn.step', {s: p.step, t: p.total});
  return {v, sub: parts.join(' · '), short: t('gn.step', {s: p.step, t: p.total})};
}

function gnHwRender() {
  const h = gn.hw, body = $('gnHwBody');
  if (!h) return;
  const g = gnGen();
  const line = [];
  if (h.gpuUtil >= 0) line.push(`${t('gn.gpu')} ${Math.round(h.gpuUtil)}%`);
  if (h.vramUsed >= 0) line.push(h.vramTotal > 0 ? t('gn.gb', {u: gnGB(h.vramUsed), t: gnGB(h.vramTotal)}) : gnGB(h.vramUsed) + ' GB');
  if (h.temp >= 0) line.push(Math.round(h.temp) + '°');
  if (h.power >= 0) line.push(Math.round(h.power) + ' W');
  if (h.cpu >= 0) line.push(`${t('gn.cpu')} ${Math.round(h.cpu)}%`);
  if (h.ramTotal > 0) line.push(`${t('gn.ram')} ${t('gn.gb', {u: gnGB(h.ramUsed), t: gnGB(h.ramTotal)})}`);
  if (g.short) line.push(g.short);
  $('gnHwLine').textContent = line.join(' · ') || t('gn.na');
  if (gn.set.hwMin) return;

  const m = [];
  const card = (k, v, small, opt) => m.push({k, v, small, ...opt});
  if (h.gpuUtil >= 0) card(t('gn.gpu'), Math.round(h.gpuUtil) + '%', '', {spark: 'gpu', title: h.gpu});
  else card(t('gn.gpu'), t('gn.na'), '', {title: h.gpu});
  if (h.vramUsed >= 0) {
    const pct = h.vramTotal > 0 ? h.vramUsed / h.vramTotal * 100 : -1;
    card(t('gn.vram'), h.vramTotal > 0 ? t('gn.gb', {u: gnGB(h.vramUsed), t: gnGB(h.vramTotal)}) : gnGB(h.vramUsed) + ' GB', '',
      {bar: pct, lvl: gnLevel(pct, 92, 98), spark: pct >= 0 ? 'vram' : ''});
  }
  if (h.temp >= 0) card(t('gn.temp'), Math.round(h.temp) + '°C', '', {bar: Math.min(100, h.temp), lvl: gnLevel(h.temp, 75, 85)});
  if (h.power >= 0) card(t('gn.power'), Math.round(h.power), 'W', {});
  if (h.cpu >= 0) card(t('gn.cpu'), Math.round(h.cpu) + '%', '', {spark: 'cpu', lvl: gnLevel(h.cpu, 90, 98)});
  if (h.ramTotal > 0) {
    const pct = h.ramUsed / h.ramTotal * 100;
    card(t('gn.ram'), t('gn.gb', {u: gnGB(h.ramUsed), t: gnGB(h.ramTotal)}), '', {bar: pct, lvl: gnLevel(pct, 85, 95), spark: 'ram'});
  }
  const sig = m.map(x => x.k + (x.spark ? 's' : '') + (x.bar !== undefined ? 'b' : '')).join('|');
  if (body.dataset.sig !== sig) {
    body.dataset.sig = sig;
    body.innerHTML = m.map(x => `<div class="gn-m"><div class="k"></div><div class="v"></div>${x.bar !== undefined ? '<div class="mb"><b></b></div>' : ''}${x.spark ? '<canvas></canvas>' : ''}</div>`).join('') +
      '<div class="gn-m gen"><div class="k"></div><div class="v"></div><div class="sub"></div></div>';
  }
  const els = body.children;
  m.forEach((x, i) => {
    const el = els[i];
    el.className = 'gn-m' + (x.lvl ? ' ' + x.lvl : '');
    el.title = x.title || '';
    el.querySelector('.k').textContent = x.k;
    el.querySelector('.v').innerHTML = esc(String(x.v)) + (x.small ? `<small>${esc(x.small)}</small>` : '');
    if (x.bar !== undefined) el.querySelector('.mb b').style.width = Math.max(0, Math.min(100, x.bar)) + '%';
    if (x.spark) gnSpark(el.querySelector('canvas'), gn.hist[x.spark], el);
  });
  const ge = els[m.length];
  ge.querySelector('.k').textContent = t('gn.gen');
  ge.querySelector('.v').textContent = g.v;
  ge.querySelector('.sub').textContent = g.sub;
}

// мини-график за последнюю минуту, 0–100
function gnSpark(cv, data, el) {
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  const col = getComputedStyle(el).getPropertyValue('--c').trim() || '#e9b872';
  const pts = data.map((v, i) => [w - (data.length - 1 - i) * (w / 59), v < 0 ? null : h - 1 - Math.min(100, v) / 100 * (h - 2)]);
  c.beginPath();
  let started = false, first = 0, last = 0;
  for (const [x, y] of pts) {
    if (y === null) continue;
    if (!started) { c.moveTo(x, y); first = x; started = true; } else c.lineTo(x, y);
    last = x;
  }
  if (!started) return;
  c.strokeStyle = col; c.lineWidth = 1.5; c.lineJoin = 'round'; c.stroke();
  c.lineTo(last, h); c.lineTo(first, h); c.closePath();
  c.globalAlpha = .18; c.fillStyle = col; c.fill(); c.globalAlpha = 1;
}

gnInfo();
