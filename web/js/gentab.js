// Вкладка «Картинки»: запрос, стили, пропорции и очередь слева; в центре холст, где картинка проявляется из шума
// (кадры предпросмотра плавно перетекают друг в друга, ранние размыты), под ним плашка нагрузки на железо.
// Сервер: genapi.go (gen-info, gen-add, gen-state раз в 0,7 с, пока вкладка открыта, кадр — /gen-frame).
const GN_KEY = 'kb.gen';
// запасные образцы стилей (градиенты), если картинки-примера нет
const GN_GRAD = {
  none: 'linear-gradient(135deg,#4a4a55,#1d1d22)',
  photo: 'linear-gradient(160deg,#9fb4c7 0%,#d9b27c 55%,#4b5a3c 100%)',
  cinema: 'linear-gradient(135deg,#0f2a3a 0%,#c86b3c 65%,#1a1210 100%)',
  illus: 'linear-gradient(135deg,#ff8a65,#ba68c8 55%,#4fc3f7)',
  icon3d: 'radial-gradient(circle at 35% 30%,#bfe3ff,#5c6bc0 55%,#2a2350)',
  flat: 'linear-gradient(135deg,#ffd166 0 33%,#06d6a0 33% 66%,#118ab2 66%)',
  anime: 'linear-gradient(135deg,#ff9ac1,#8ec5ff 60%,#fff1a8)',
  water: 'radial-gradient(circle at 30% 40%,#a8d8ea,#f6c6ea 55%,#fdf6e3)',
  product: 'linear-gradient(160deg,#f2f2f4,#b9bcc4 70%,#8a8d96)',
  retro: 'linear-gradient(135deg,#c9a66b,#8c5a3c 60%,#3b2a22)',
  oil: 'linear-gradient(135deg,#b5651d,#e0b15a 50%,#3f5a6b)',
  sketch: 'linear-gradient(135deg,#e8e6df,#9a9a96 70%,#4a4a48)',
  comic: 'linear-gradient(135deg,#ffd23f,#ee4266 55%,#3bceac)',
  fantasy: 'linear-gradient(160deg,#2b1b4a,#7a4fb5 55%,#f0b27a)',
  lowpoly: 'linear-gradient(135deg,#7fd1ae,#4d9de0 55%,#e15554)',
  pixel: 'linear-gradient(135deg,#5b6ee1,#37946e 55%,#fbf236)',
  neon: 'linear-gradient(135deg,#120a2a,#ff2bd6 55%,#00e5ff)',
  minimal: 'linear-gradient(135deg,#f1ede4,#d8cfc0 60%,#b7a58a)',
};
// стили с картинкой-примером web/styles/<id>.jpg (её отдаёт /styles/ из genapi.go); без файла плитка показывает градиент
const GN_IMG = new Set(['anime', 'cinema', 'comic', 'fantasy', 'flat', 'icon3d', 'illus', 'lowpoly', 'minimal', 'neon', 'none', 'oil', 'photo', 'pixel', 'product', 'retro', 'sketch', 'water']);
// группы в окне «Ещё стили…»
const GN_GROUPS = {
  photo: ['photo', 'cinema', 'product', 'retro'],
  art: ['illus', 'anime', 'water', 'oil', 'sketch', 'comic', 'fantasy'],
  gfx: ['icon3d', 'flat', 'lowpoly', 'pixel', 'neon', 'minimal'],
};
const GN_VIS = 5;                                    // сколько стилей видно плитками, шестая плитка — «Ещё стили…»
const GN_VIS_DEF = ['photo', 'cinema', 'illus', 'icon3d', 'anime'];

const gn = {
  info: null,         // ответ gen-info
  tasks: [],          // очередь с сервера
  view: 0,            // id задачи на холсте
  timer: 0,
  speed: {},          // 'id:картинка' → {t0, s0}: от чего считать секунды на шаг
  hist: {gpu: [], vram: [], cpu: [], ram: []},
  hw: null, model: '', gpu: '',
  gridKey: '',
  set: {prompt: '', preset: 'photo', ratio: '1:1', count: 1, model: '', steps: '', cfg: '', seed: '', neg: '', build: true, hwMin: false,
    own: false,         // «Писать промт самому»: помощник не зовётся, модель получает запрос как есть
    fold: {},           // разделы панели: id → true, если свёрнут (у «Дополнительно» и «Журнала» наоборот: true — развёрнут)
    // vis — стили на плитках, pins — закреплённые, use — когда стиль выбирали в последний раз
    vis: GN_VIS_DEF.slice(), pins: [], use: {}},
  writing: false,     // помощник пишет промт: «Создать» ждёт
};

try { Object.assign(gn.set, JSON.parse(localStorage.getItem(GN_KEY) || '{}')); } catch (e) {}
for (const k of ['exp', 'expFor', 'enhAl']) delete gn.set[k];   // остатки «Улучшить» (до 6.2)
function gnSave() { try { localStorage.setItem(GN_KEY, JSON.stringify(gn.set)); } catch (e) {} }

// ---- сведения и поля слева ----

async function gnInfo() {
  const r = await api('gen-info');
  if (r.error) return;
  gn.info = r;
  if (!r.presets.includes(gn.set.preset)) gn.set.preset = r.presets[0];
  if (!r.ratios.includes(gn.set.ratio)) gn.set.ratio = r.ratios[0];
  if (!r.models.some(m => m.id === gn.set.model)) gn.set.model = r.models.length ? r.models[0].id : '';
  gnStyleRender();
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
  gmSync(r);
}

function gnFields() {
  $('gnPrompt').value = gn.set.prompt;
  $('gnNeg').value = gn.set.neg;
  $('gnSteps').value = gn.set.steps;
  $('gnCfg').value = gn.set.cfg;
  $('gnSeed').value = gn.set.seed;
  $('gnShowBuild').checked = gn.set.build;
  $('gnOwn').checked = gn.set.own;
  $('gnUsed').open = !!gn.set.usedOpen;
  gnSecSums();
  document.querySelectorAll('#gnCount button').forEach(b => b.classList.toggle('on', +b.dataset.v === gn.set.count));
  $('gnHw').classList.toggle('min', !!gn.set.hwMin);
  $('gnHwToggle').setAttribute('aria-expanded', String(!gn.set.hwMin));
  gnTips();
}

function gnModel() { return (gn.info?.models || []).find(m => m.id === gn.set.model); }

// ---- разделы панели: сворачиваются по одному, состояние запоминается ----

const GN_OPEN_DEF = {more: false, log: false};   // остальные по умолчанию развёрнуты
function gnSecInit() {
  const f = gn.set.fold || (gn.set.fold = {});
  document.querySelectorAll('#gnSide details.gn-sec').forEach(d => {
    const k = d.dataset.sec;
    d.open = k in f ? !!f[k] : (GN_OPEN_DEF[k] ?? true);
  });
}
document.querySelectorAll('#gnSide details.gn-sec').forEach(d => {
  d.addEventListener('toggle', () => { (gn.set.fold || (gn.set.fold = {}))[d.dataset.sec] = d.open; gnSave(); });
  // кнопки и «?» в заголовке не должны сворачивать раздел
  d.firstElementChild.addEventListener('click', e => { if (e.target.closest('button')) e.preventDefault(); });
});

// gnSecSums: что выбрано, видно в свёрнутом заголовке
function gnSecSums() {
  const m = gnModel();
  $('gnSv_style').textContent = gn.set.preset === 'none' ? t('gn.pre.none') : gnPreName(gn.set.preset);
  $('gnSv_fmt').textContent = [gn.set.ratio, m ? m.name : '', gn.set.count > 1 ? '× ' + gn.set.count : ''].filter(Boolean).join(' · ');
}

// ---- ширина левой панели: полоса между панелью и холстом, как в монтаже; двойной щелчок возвращает как было ----

const GN_W_KEY = 'konv9000.gnLeftW';
function gnVSplitPlace() {
  const s = $('gnSide'), c = document.querySelector('.gn-center'), b = $('gnVSplit');
  if (!s.offsetWidth) return;
  const gap = c.offsetLeft - (s.offsetLeft + s.offsetWidth);
  Object.assign(b.style, {left: Math.round(s.offsetLeft + s.offsetWidth + gap / 2 - 5) + 'px', top: s.offsetTop + 'px', height: s.offsetHeight + 'px'});
}
function gnVSplitSet(w) {
  const view = $('genView').clientWidth;
  const v = Math.round(Math.min(Math.max(w, 280), Math.max(view - 420, 280)));
  $('genView').style.setProperty('--gn-left', v + 'px');
  return v;
}
function gnVSplitLoad() { const w = +storeGet(GN_W_KEY); if (w > 0) gnVSplitSet(w); gnVSplitPlace(); }
new ResizeObserver(() => { gnVSplitPlace(); gnLayout(); }).observe($('gnSide'));
window.addEventListener('resize', () => { if (tab === 'gen') gnVSplitLoad(); });
$('gnVSplit').addEventListener('dblclick', () => { $('genView').style.removeProperty('--gn-left'); storeSet(GN_W_KEY, ''); gnVSplitPlace(); });
$('gnVSplit').addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  e.preventDefault();
  const bar = $('gnVSplit'), x0 = e.clientX, w0 = $('gnSide').offsetWidth;
  let cur = w0;
  bar.setPointerCapture(e.pointerId);
  bar.classList.add('on');
  const move = ev => { cur = gnVSplitSet(w0 + (ev.clientX - x0)); gnVSplitPlace(); };
  const up = () => {
    bar.removeEventListener('pointermove', move);
    bar.removeEventListener('pointerup', up);
    bar.removeEventListener('pointercancel', up);
    bar.classList.remove('on');
    storeSet(GN_W_KEY, cur);
  };
  bar.addEventListener('pointermove', move);
  bar.addEventListener('pointerup', up);
  bar.addEventListener('pointercancel', up);
});

function gnGoState() {
  const ok = !!gnModel() && gn.info?.engine && gn.set.prompt.trim() !== '' && !gn.writing;
  $('gnGo').disabled = !ok;
  $('gnGo').classList.toggle('busy', gn.writing);
  $('gnGo').firstElementChild.textContent = t(gn.writing ? 'gn.writing' : 'gn.go');
  const why = !gn.info ? '' : !gn.info.engine ? t('gn.noEngine') : !gnModel() ? t('gn.noModel') : '';
  $('gnEmptyS').textContent = why || t('gn.emptyS');
}

// подсказка под полем: слишком общий запрос
// слова без смысла для картинки: русские из словаря берутся всегда, на любом языке интерфейса
const GN_FILLER = new Set((I18N.ru['gn.filler'] + ' ' + I18N.en['gn.filler']).split(' '));
const GN_RU = String.fromCharCode(0x430) + '-' + String.fromCharCode(0x44f) + String.fromCharCode(0x451);   // кириллица без букв в коде (TestNoStrayRussian)
const GN_SPLIT = new RegExp('[^a-z0-9' + GN_RU + '-]+');
function gnVague(s) {
  const w = s.toLowerCase().split(GN_SPLIT).filter(Boolean);
  return w.length > 0 && w.filter(x => !GN_FILLER.has(x)).length < 2;
}
function gnTips() {
  const p = gn.set.prompt;
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
$('gnModel').addEventListener('change', () => { gn.set.model = $('gnModel').value; gnSave(); gnGoState(); gnSecSums(); });
$('gnTips').addEventListener('click', e => {
  const b = e.target.closest('.chip'); if (!b) return;
  const p = gn.set.prompt.trimEnd();
  gn.set.prompt = p ? (/[,.;]$/.test(p) ? p + ' ' : p + ', ') + b.textContent : b.textContent;
  $('gnPrompt').value = gn.set.prompt; gnSave(); gnTips(); gnGoState(); $('gnPrompt').focus();
});
// ---- стили: плитки, закрепление и окно «Ещё стили…» ----

const gnPreName = p => I18N[lang]['gn.pre.' + p] || p;
const gnPreTile = (p, pin) => {
  const g = GN_IMG.has(p) ? `url(styles/${p}.jpg) center/cover` : (GN_GRAD[p] || GN_GRAD.none);
  const pinned = gn.set.pins.includes(p);
  return `<button type="button" class="gn-pre${p === gn.set.preset ? ' on' : ''}" data-v="${esc(p)}" title="${esc(I18N[lang]['gn.preHint.' + p] || '')}" style="--g:${g}"><b>${esc(gnPreName(p))}</b>` +
    (pin ? `<span class="gn-pin${pinned ? ' on' : ''}" role="button" title="${esc(t(pinned ? 'gn.unpin' : 'gn.pin'))}">${pinned ? '★' : '☆'}</span>` : '') + `</button>`;
};

// gnStyleVis: чинит список плиток (вдруг стиль убрали из программы или список испортился)
function gnStyleVis() {
  const all = (gn.info?.presets || []).filter(p => p !== 'none');
  const s = gn.set;
  s.pins = (s.pins || []).filter(p => all.includes(p)).slice(0, GN_VIS - 1);
  const vis = [];
  for (const p of [...(s.vis || []), ...GN_VIS_DEF, ...all]) if (all.includes(p) && !vis.includes(p) && vis.length < GN_VIS) vis.push(p);
  for (const p of s.pins) if (!vis.includes(p)) vis[vis.findIndex(x => !s.pins.includes(x))] = p;
  if (s.preset !== 'none' && all.includes(s.preset) && !vis.includes(s.preset)) gnStyleShow(s.preset, vis);
  s.vis = vis;
}

// gnStyleShow: ставит стиль на плитку вместо того, которым дольше всего не пользовались (закреплённые и выбранный не трогаем)
function gnStyleShow(id, vis = gn.set.vis) {
  if (vis.includes(id)) return;
  const s = gn.set;
  let at = -1, best = Infinity;
  vis.forEach((p, i) => {
    if (s.pins.includes(p) || p === s.preset) return;
    const u = s.use[p] || 0;
    if (u < best) { best = u; at = i; }
  });
  if (at < 0) at = vis.length - 1;
  vis[at] = id;
}

function gnStylePick(id) {
  gn.set.preset = id;
  if (id !== 'none') { gn.set.use[id] = Date.now(); gnStyleShow(id); }
  gnSave(); gnStyleRender();
}

function gnStyleRender() {
  if (!gn.info) return;
  gnStyleVis();
  $('gnPresets').innerHTML = gn.set.vis.map(p => gnPreTile(p, true)).join('') +
    `<button type="button" class="gn-pre gn-more-t" id="gnStylesBtn"><b>${esc(t('gn.moreStyles'))}</b></button>`;
  $('gnNoStyle').classList.toggle('on', gn.set.preset === 'none');
  gnSecSums();
}

function gnStylesOpen() {
  $('gnStylesQ').value = '';
  gnStylesList();
  $('gnStyles').classList.remove('hide');
  $('gnStylesQ').focus();
}
const gnStylesClose = () => $('gnStyles').classList.add('hide');

function gnStylesList() {
  const q = $('gnStylesQ').value.trim().toLowerCase();
  const hit = p => !q || (gnPreName(p) + ' ' + (I18N[lang]['gn.preHint.' + p] || '')).toLowerCase().includes(q);
  const known = new Set(Object.values(GN_GROUPS).flat());
  const grpNames = {photo: t('gn.grp.photo'), art: t('gn.grp.art'), gfx: t('gn.grp.gfx')};
  const groups = Object.entries(GN_GROUPS).map(([g, ids]) => [grpNames[g] || g, ids]);
  const rest = (gn.info?.presets || []).filter(p => p !== 'none' && !known.has(p));
  if (rest.length) groups.push(['', rest]);
  const html = groups.map(([name, ids]) => {
    const list = ids.filter(p => (gn.info?.presets || []).includes(p) && hit(p));
    return list.length ? `<h4>${esc(name)}</h4><div class="gn-st-grid">${list.map(p => gnPreTile(p, false)).join('')}</div>` : '';
  }).join('');
  $('gnStylesBody').innerHTML = html || `<div class="gn-tip">${esc(t('gn.moreNone'))}</div>`;
}

$('gnPresets').addEventListener('click', e => {
  if (e.target.closest('#gnStylesBtn')) { gnStylesOpen(); return; }
  const b = e.target.closest('.gn-pre'); if (!b) return;
  const id = b.dataset.v;
  if (e.target.closest('.gn-pin')) {            // звёздочка: закрепить или открепить, выбор не меняется
    const pins = gn.set.pins, i = pins.indexOf(id);
    if (i >= 0) pins.splice(i, 1); else if (pins.length < GN_VIS - 1) pins.push(id);
    gnSave(); gnStyleRender(); return;
  }
  gnStylePick(id);
});
$('gnNoStyle').addEventListener('click', () => gnStylePick(gn.set.preset === 'none' ? (gn.set.vis[0] || 'photo') : 'none'));
$('gnStylesBody').addEventListener('click', e => {
  const b = e.target.closest('.gn-pre'); if (!b) return;
  gnStylePick(b.dataset.v); gnStylesClose();
});
$('gnStylesQ').addEventListener('input', gnStylesList);
$('gnStylesX').addEventListener('click', gnStylesClose);
$('gnStyles').addEventListener('click', e => { if (e.target === $('gnStyles')) gnStylesClose(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('gnStyles').classList.contains('hide')) { e.stopPropagation(); gnStylesClose(); } });
$('gnRatio').addEventListener('click', e => {
  const b = e.target.closest('.gn-ratio'); if (!b) return;
  gn.set.ratio = b.dataset.v; gnSave(); gnSecSums();
  document.querySelectorAll('#gnRatio .gn-ratio').forEach(x => x.classList.toggle('on', x === b));
});
$('gnCount').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  gn.set.count = +b.dataset.v; gnSave(); gnFields();
});
for (const id of ['gnPrompt', 'gnNeg'])
  $(id).addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); gnGo(); } });
$('gnGo').addEventListener('click', () => gnGo());
$('gnFolder').addEventListener('click', () => { if (gn.info) api('open-dir', {path: gn.info.gallery}).then(r => { if (r.error) say('warn', t('warn.title'), r.error); }); });
$('gnHwToggle').addEventListener('click', () => { gn.set.hwMin = !gn.set.hwMin; gnSave(); gnFields(); gnHwRender(); });

// ---- промт: при каждом «Создать» его пишет помощник (английский, подробный, без стиля: стиль добавляется при рисовании).
// Что получилось, видно под картинкой (gnUsedRender). Галочка «Писать промт самому» отдаёт модели запрос как есть.

$('gnOwn').addEventListener('change', () => { gn.set.own = $('gnOwn').checked; gnSave(); });

// gnWrite: промты от помощника, по одному на картинку (каждый со своим ракурсом и светом, поэтому повторное
// «Создать» и картинки одной пачки выходят разными); null — не вышло (всплывашка уже показана)
async function gnWrite(prompt, count) {
  gn.writing = true; gnGoState();
  const r = await api('gen-enhance', {prompt, preset: gn.set.preset, count});
  gn.writing = false; gnGoState();
  if (!r.error) return r.prompts?.length ? r.prompts : [r.prompt];
  // помощник упал: рисовать можно и по запросу как есть
  gnErrToast('llm', r.error, [{t: t('gn.err.asIs'), primary: true, fn: () => gnGo(null, true)}]);
  return null;
}

// gnGo: «Создать». extra.expanded (даже пустой) — промт уже есть («Ещё такие же», «Нарисовать с этим промтом»), помощник не нужен.
// asIs: помощник упал, рисуем по запросу как есть.
async function gnGo(extra, asIs) {
  const s = gn.set, prompt = (extra?.prompt ?? s.prompt).trim();
  if (gn.writing || !prompt || !gnModel() || !gn.info?.engine) return;
  let expanded = extra?.expanded, variants;
  if (expanded === undefined) {
    expanded = '';
    if (!asIs && !s.own) {
      if (gn.info.llm) {
        variants = await gnWrite(prompt, s.count);
        if (variants === null) return;
        expanded = variants[0];
        if (variants.length < 2) variants = undefined;
      } else if (!gn.llmTold) {
        // помощника нет: рисуем по запросу, один раз за сеанс говорим, что с ним выйдет лучше
        gn.llmTold = true;
        toast({type: 'info', title: t('gn.llmNone'), text: esc(t('gn.enhNeed')), ttl: 8000, actions: [{t: t('gn.err.models'), fn: () => gmOpen(true)}]});
      }
    }
  }
  const seed = s.seed === '' ? -1 : Math.max(0, Math.floor(+s.seed) || 0);
  const r = await api('gen-add', {model: s.model, negative: s.neg, preset: s.preset, ratio: s.ratio, count: s.count,
    seed, steps: Math.floor(+s.steps) || 0, cfg: +s.cfg || 0, preview: s.build, ...(extra || {}), prompt, expanded, variants});
  if (r.error) { say('warn', t('warn.title'), r.error); return; }
  gn.view = r.id;
  gnPoll();
}

// gnUsedRender: под картинкой свёрнутая строка «Какой промт получился» (смотреть, править, копировать, нарисовать заново).
// Текст меняется только при смене задачи, чтобы опрос не стирал правку.
// У пачки с разными промтами — переключатель номера картинки (gnUsedN).
function gnUsedRender(x, i) {
  const box = $('gnUsed'), n = $('gnUsedN');
  box.classList.toggle('hide', !x);
  if (!x) { box.dataset.id = ''; return; }
  const vs = x.req.variants || [];
  if (i === undefined) {
    if (box.dataset.id === String(x.id)) return;
    i = 0;
  }
  box.dataset.id = x.id;
  n.classList.toggle('hide', vs.length < 2);
  n.innerHTML = vs.length < 2 ? '' : vs.map((_, k) => `<button type="button" data-i="${k}"${k === i ? ' class="on"' : ''}>${k + 1}</button>`).join('');
  const p = (vs[i] || x.req.expanded || x.req.prompt || '').trim();
  $('gnUsedT').value = p;
  $('gnUsedV').textContent = p;
}
$('gnUsedN').addEventListener('click', e => {
  const b = e.target.closest('button[data-i]'); if (!b) return;
  gnUsedRender(gn.tasks.find(q => q.id === +$('gnUsed').dataset.id), +b.dataset.i);
});
$('gnUsed').addEventListener('toggle', () => { gn.set.usedOpen = $('gnUsed').open; gnSave(); });
$('gnUsedT').addEventListener('input', () => { $('gnUsedV').textContent = $('gnUsedT').value; });
$('gnUsedCopy').addEventListener('click', () => { const v = $('gnUsedT').value.trim(); if (v) ggCopyText(v); });
$('gnUsedGo').addEventListener('click', () => {
  const x = gn.tasks.find(q => q.id === +$('gnUsed').dataset.id), v = $('gnUsedT').value.trim();
  if (!v) return;
  // запрос остаётся прежним (для журнала и галереи), стиль и остальное берутся из полей слева
  gnGo({prompt: x?.req.prompt || gn.set.prompt || v, expanded: v});
});

// gnApply: настройки картинки из галереи или брошенного PNG — в поля. fresh: зерно случайное («ещё такие же», «вариации»).
function gnApply(r, fresh) {
  const s = gn.set, inf = gn.info || {presets: [], ratios: [], models: []};
  s.prompt = r.prompt || '';
  s.neg = r.negative || '';
  s.preset = inf.presets.includes(r.preset) ? r.preset : inf.presets.includes('none') ? 'none' : s.preset;
  if (inf.ratios.includes(r.ratio)) s.ratio = r.ratio;
  if (inf.models.some(m => m.id === r.model)) s.model = r.model;
  s.steps = r.steps > 0 ? String(r.steps) : '';
  s.cfg = r.cfg > 0 ? String(r.cfg) : '';
  s.seed = fresh ? '' : String(r.seed);
  gnSave();
  if (!fresh) $('gnMore').open = true;   // зерно и шаги видны, иначе не понять, что вернулось
  document.querySelectorAll('#gnPresets .gn-pre').forEach(x => x.classList.toggle('on', x.dataset.v === s.preset));
  document.querySelectorAll('#gnRatio .gn-ratio').forEach(x => x.classList.toggle('on', x.dataset.v === s.ratio));
  $('gnModel').value = s.model;
  gnFields();
  gnGoState();
}

// ---- понятные ошибки ----

// gnErrToast: всплывашка вместо английского текста движка. Технический текст прячется под «Подробности».
function gnErrText(kind) {
  return {
    vram: {t: t('gn.err.vram.t'), x: t('gn.err.vram.x')},
    disk: {t: t('gn.err.disk.t'), x: t('gn.err.disk.x')},
    model: {t: t('gn.err.model.t'), x: t('gn.err.model.x')},
    engine: {t: t('gn.err.engine.t'), x: t('gn.err.engine.x')},
    llm: {t: t('gn.err.llm.t'), x: t('gn.err.llm.x')},
    other: {t: t('gn.err.other.t'), x: t('gn.err.other.x')},
  }[kind] || {t: t('gn.err.other.t'), x: t('gn.err.other.x')};
}
function gnErrToast(kind, raw, actions) {
  const m = gnErrText(kind);
  toast({id: 'gnerr', type: 'err', title: m.t,
    text: esc(m.x) +(raw ? `<details><summary>${esc(t('gn.err.details'))}</summary><pre>${esc(raw)}</pre></details>` : ''),
    actions});
}

// gnFailWatch: про каждую упавшую задачу говорим один раз. Те, что упали до открытия вкладки, молчат.
function gnFailWatch() {
  const failed = gn.tasks.filter(x => x.status === 'failed');
  if (!gn.seenFail) { gn.seenFail = new Set(failed.map(x => x.id)); return; }
  const fresh = failed.filter(x => !gn.seenFail.has(x.id));
  fresh.forEach(x => gn.seenFail.add(x.id));
  const x = fresh[fresh.length - 1];
  if (!x) return;
  const acts = [{t: t('btn.retry'), primary: true, fn: async () => {
    const r = await api('gen-add', x.req);
    if (r.error) { say('warn', t('warn.title'), r.error); return; }
    gn.view = r.id; gnPoll();
  }}];
  if (['model', 'engine', 'disk'].includes(x.errKind)) acts.push({t: t('gn.err.models'), fn: () => gmOpen(true)});
  gnErrToast(x.errKind, x.err, acts);
}

// ---- опрос ----

function gnTabChanged() {
  clearTimeout(gn.timer);
  clearTimeout(gm.timer);
  if (tab !== 'gen') return;
  gnSecInit();
  gnVSplitLoad();
  gnInfo();
  gnPoll();
  ggStripLoad();
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
    ggOnPoll();
    gnFailWatch();
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
    case 'failed': return t('gn.failed') + (x.err ? ': ' + gnErrText(x.errKind).t : '');
    case 'cancelled': return t('gn.cancelled');
  }
  return x.status;
}

function gnQueue() {
  const live = x => !['done', 'failed', 'cancelled'].includes(x.status);
  // готовые уходят сами (картинки в ленте), остаются идущие, ошибки и открытая сейчас
  const shown = gn.tasks.slice().reverse().filter(x => x.status !== 'done' || x.id === gn.view);
  // одинаковые запросы с одной ошибкой или отменой схлопываются в «×N»
  const groups = [];
  for (const x of shown) {
    const key = live(x) || x.status === 'done' ? '' : (x.req.prompt || x.params.prompt) + '|' + x.status + '|' + (x.errKind || '');
    const g = key && groups.find(y => y.key === key);
    if (g) g.items.push(x); else groups.push({key, items: [x]});
  }
  const LIM = 3;
  const vis = gn.qAll ? groups : groups.slice(0, LIM);
  const rows = vis.map(g => {
    const x = g.items[0], n = g.items.length;
    const cur = g.items.some(y => y.id === gn.view);
    return `<div class="gn-q${cur ? ' cur' : ''}" data-id="${x.id}" title="${esc(x.params.prompt)}">
      <span class="p">${esc(x.req.prompt || x.params.prompt)}${n > 1 ? ` <b class="n">×${n}</b>` : ''}</span>
      <span class="s${x.status === 'failed' ? ' err' : ''}">${esc(gnStatus(x))}</span>
      ${live(x) ? `<button type="button" class="x" data-cancel="${x.id}" title="${esc(t('gn.cancel'))}" aria-label="${esc(t('gn.cancel'))}">×</button>` : ''}
    </div>`;
  }).join('');
  const more = groups.length > LIM ? `<button type="button" class="gn-q-clear" id="gnQMore">${esc(gn.qAll ? t('gn.qLess') : t('gn.qMore', {n: groups.length - LIM}))}</button>` : '';
  const clear = gn.tasks.some(x => !live(x) && x.status !== 'done') ? `<button type="button" class="gn-q-clear" id="gnClear">${esc(t('gn.clear'))}</button>` : '';
  const html = rows + more + clear;
  if ($('gnQueue').dataset.html !== html) { $('gnQueue').innerHTML = html; $('gnQueue').dataset.html = html; }
  // в свёрнутом заголовке «Журнала»: как закончилась последняя задача, без длинного текста ошибки
  const last = gn.tasks[gn.tasks.length - 1];
  const lv = $('gnLogV');
  lv.textContent = last ? gnStatus(last, true).split(':')[0] : '';
  lv.style.color = last?.status === 'failed' ? 'var(--err)' : '';
}

$('gnQueue').addEventListener('click', async e => {
  const c = e.target.closest('[data-cancel]');
  if (c) { await api('gen-cancel', {id: +c.dataset.cancel}); gnPoll(); return; }
  if (e.target.closest('#gnQMore')) { gn.qAll = !gn.qAll; gnQueue(); return; }
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
// сетка тоже: её высота меняется, когда под картинкой появляется или раскрывается «Какой промт получился»
{ const ro = new ResizeObserver(gnLayout); ro.observe($('gnStage')); ro.observe($('gnGrid')); }

function gnStage() {
  const x = gn.tasks.find(q => q.id === gn.view);
  $('gnEmpty').classList.toggle('hide', !!x);
  $('gnGrid').classList.toggle('hide', !x);
  gnUsedRender(x);
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
    if (img && st.finOk === img) {
      // «готово» только когда готовая картинка реально отрисована в плитке
      c.className = 'gn-cell done';
      tag = performance.now() < (st.okUntil || 0) ? t('gn.done') : t('gn.seedOf', {s: x.params.seed + i});
    } else if (img) {
      if (st.fin !== img) { st.fin = img; gnShow(c, mediaUrl(img), 0, true); }
      c.className = 'gn-cell';
      tag = t('gn.saving');
      c.querySelector('.gn-bar b').style.width = '98%';
    } else if (i === x.index && (x.status === 'running' || x.status === 'loading')) {
      const live = x.status === 'running' && x.previewSeq > 0 && st.seq !== x.previewSeq;
      if (live) { st.seq = x.previewSeq; gnShow(c, `/gen-frame?t=${TOKEN}&id=${x.id}&s=${x.previewSeq}`, pr.total ? pr.previewStep / pr.total : 0, false); }
      c.className = 'gn-cell' + (st.top ? '' : ' wait');
      // шаги занимают полосу до 85%, дальше этапы: сборка картинки 92%, сохранение 98%
      const sampling = pr.total && pr.step < pr.total && (!pr.stage || pr.stage === 'sampling');
      let w = 2;
      if (x.status === 'loading') tag = t('gn.loading');
      else if (sampling) { tag = t('gn.step', {s: pr.step, t: pr.total}); w = Math.max(2, pr.step / pr.total * 85); }
      else if (pr.stage === 'saving') { tag = t('gn.saving'); w = 98; }
      else if (pr.total) { tag = t('gn.encoding'); w = 92; }
      else tag = t('gn.encoding');
      c.querySelector('.gn-bar b').style.width = w + '%';
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
  $('gnStageT').textContent = [x.req.prompt || '', t('gn.size', {w: x.params.width, h: x.params.height}), gnStatus(x, true)].filter(Boolean).join(' · ');
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
    if (fin) { cell.gn.finOk = cell.gn.fin; cell.gn.okUntil = performance.now() + 2500; setTimeout(gnStage, 2600); gnStage(); }
    if (prev) { prev.style.zIndex = 1; setTimeout(() => { if (st.top !== prev) prev.classList.remove('on', 'fin'); }, 800); }
    st.top = next;
  };
  im.src = src;
}

$('gnGrid').addEventListener('click', e => {
  const c = e.target.closest('.gn-cell.done'); if (c) ggLbPath(c.gn.fin);
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
  if (p.stage === 'saving') return {v: t('gn.saving'), sub: vram, short: t('gn.saving')};
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
  // строка всегда на виду: показатели через вертикальные линии, у каждого свой цвет; тревога перекрашивает в жёлтый/красный
  const seg = [];
  const add = (label, val, col, lvl) => seg.push(`<span class="hs${lvl ? ' ' + lvl : ''}" style="--hc:${col}">${label ? `<i>${esc(label)}</i>` : ''}<b>${esc(val)}</b></span>`);
  const vramPct = h.vramTotal > 0 && h.vramUsed >= 0 ? h.vramUsed / h.vramTotal * 100 : -1;
  const ramPct = h.ramTotal > 0 ? h.ramUsed / h.ramTotal * 100 : -1;
  if (h.gpuUtil >= 0) add(t('gn.gpu'), Math.round(h.gpuUtil) + '%', '#e9b872');
  if (h.vramUsed >= 0) add(t('gn.vram'), h.vramTotal > 0 ? t('gn.gb', {u: gnGB(h.vramUsed), t: gnGB(h.vramTotal)}) : gnGB(h.vramUsed) + ' GB', '#7fb4e8', gnLevel(vramPct, 92, 98));
  if (h.temp >= 0) add(t('gn.temp'), Math.round(h.temp) + '°C', '#e8946f', gnLevel(h.temp, 75, 85));
  if (h.power >= 0) add(t('gn.power'), Math.round(h.power) + ' W', '#c79be8');
  if (h.cpu >= 0) add(t('gn.cpu'), Math.round(h.cpu) + '%', '#6fcfc0', gnLevel(h.cpu, 90, 98));
  if (h.ramTotal > 0) add(t('gn.ram'), t('gn.gb', {u: gnGB(h.ramUsed), t: gnGB(h.ramTotal)}), '#b5d36f', gnLevel(ramPct, 85, 95));
  add('', g.short || g.v, 'var(--tx)', 'gen');
  $('gnHwLine').innerHTML = seg.join('');
  if (gn.set.hwMin) return;

  // в развёрнутом виде под строкой только графики за последнюю минуту
  const m = [];
  if (h.gpuUtil >= 0) m.push({k: t('gn.gpu'), spark: 'gpu', col: '#e9b872', title: h.gpu});
  if (vramPct >= 0) m.push({k: t('gn.vram'), spark: 'vram', col: '#7fb4e8'});
  if (h.cpu >= 0) m.push({k: t('gn.cpu'), spark: 'cpu', col: '#6fcfc0'});
  if (ramPct >= 0) m.push({k: t('gn.ram'), spark: 'ram', col: '#b5d36f'});
  const sig = m.map(x => x.spark).join('|');
  if (body.dataset.sig !== sig) {
    body.dataset.sig = sig;
    body.innerHTML = m.map(() => '<div class="gn-m"><div class="k"></div><canvas></canvas></div>').join('');
  }
  m.forEach((x, i) => {
    const el = body.children[i];
    el.style.setProperty('--c', x.col);
    el.title = x.title || '';
    el.querySelector('.k').textContent = x.k;
    gnSpark(el.querySelector('canvas'), gn.hist[x.spark], el);
  });
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

// gnRelang: после смены языка заново собрать то, что вкладка рисует кодом (названия стилей, галерея, окно просмотра)
function gnRelang() {
  gnStyleRender();
  if (!$('gnStyles').classList.contains('hide')) gnStylesList();
  if (typeof ggStripRender === 'function') {
    ggStripRender();
    if (gg.open && gg.page) ggRender(false);
    if (gg.lb) ggLbRender();
  }
}
