// Галерея вкладки «Картинки»: лента последних под холстом, сетка с поиском и избранным вместо холста,
// окно просмотра с быстрыми действиями. Картинка, брошенная на вкладку, возвращает свои настройки в поля.
// Сервер: gengallery.go (gen-gallery, gen-fav, gen-delete, gen-reveal, gen-restore, gen-export, миниатюры /gen-thumb).
const gg = {
  strip: [],          // последние картинки для ленты
  seen: -1,           // сколько готовых картинок было в очереди: стало больше — лента перечитывается
  all: 0,             // всего картинок в галерее
  fresh: new Set(),   // пути, которые только что появились в ленте (анимация)
  open: false,        // сетка вместо холста
  q: '', fav: false, model: '',
  page: null,         // ответ gen-gallery для сетки
  items: [],          // что показано в сетке
  seq: 0,             // последний запрос сетки (ответы на старые отбрасываются)
  lb: null,           // окно просмотра: {list, i}
  pick: false,        // сетка открыта, чтобы выбрать референс: щелчок по картинке кладёт её в референсы
  sel: null,          // мультивыбор в сетке: Set путей, null — выключен
};
const GG_STRIP = 30, GG_PAGE = 120;

const ggThumb = it => `/gen-thumb?t=${TOKEN}&p=${encodeURIComponent(it.path)}&m=${it.mod}`;
const ggPrompt = it => (it.meta.request && it.meta.request.prompt) || it.meta.params.prompt;
const ggModelName = id => ((gn.info && gn.info.models) || []).find(m => m.id === id)?.name || id;
const ggErr = r => { if (r && r.error) { say('warn', t('warn.title'), r.error); return true; } return false; };

// ---- лента ----

async function ggStripLoad() {
  const r = await api('gen-gallery', {limit: GG_STRIP});
  if (r.error) return;
  const old = new Set(gg.strip.map(x => x.path));
  if (gg.strip.length) r.items.forEach(x => { if (!old.has(x.path)) gg.fresh.add(x.path); });
  gg.strip = r.items;
  gg.all = r.all;
  ggStripRender();
}

function ggStripRender() {
  const all = gg.all;
  const el = $('gnStrip');
  el.classList.toggle('hide', !gg.strip.length);
  el.innerHTML = gg.strip.map((x, i) =>
    `<button type="button" class="gn-th${gg.fresh.has(x.path) ? ' fresh' : ''}" data-i="${i}" title="${esc(ggPrompt(x))}"><img src="${ggThumb(x)}" alt="" loading="lazy">${x.meta.fav ? '<span class="st">★</span>' : ''}</button>`).join('') +
    (all > 0 ? `<button type="button" class="gn-th-all" id="gnStripAll">${esc(t('gg.allN', {n: all}))}</button>` : '');
  gg.fresh.clear();
}

// колесо мыши крутит ленту вбок
$('gnStrip').addEventListener('wheel', e => {
  const el = e.currentTarget;
  if (el.scrollWidth <= el.clientWidth) return;
  const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
  if (!d) return;
  e.preventDefault();
  el.scrollLeft += d;
}, {passive: false});
$('gnStrip').addEventListener('click', e => {
  if (e.target.closest('#gnStripAll')) { ggOpen(true); return; }
  const b = e.target.closest('.gn-th'); if (b) ggLb(gg.strip, +b.dataset.i);
});

// из опроса очереди: появилась новая готовая картинка — перечитать ленту
function ggOnPoll() {
  const n = gn.tasks.reduce((s, x) => s + x.images.length, 0);
  if (n !== gg.seen) { gg.seen = n; ggStripLoad(); }
}

// ---- сетка ----

function ggOpen(on) {
  gg.open = on;
  if (!on) gg.pick = false;   // выбор референса (genrefs.js) заканчивается вместе с сеткой
  if (!on) gg.sel = null;     // мультивыбор тоже
  document.querySelector('.gn-center').classList.toggle('gal', on);
  $('gnGal').classList.toggle('hide', !on);
  if (on) { ggLoad(true); $('gnGalQ').focus(); } else ggStripLoad();
}

async function ggLoad(reset) {
  const seq = ++gg.seq, offset = reset ? 0 : gg.items.length;
  const r = await api('gen-gallery', {q: gg.q, fav: gg.fav, model: gg.model, offset, limit: GG_PAGE});
  if (r.error || seq !== gg.seq) return;
  gg.page = r;
  gg.items = reset ? r.items : gg.items.concat(r.items);
  ggRender(reset);
}

function ggRender(reset) {
  const r = gg.page, grid = $('gnGalGrid');
  const f = $('gnGalF').querySelectorAll('button');
  f[0].classList.toggle('on', !gg.fav); f[1].classList.toggle('on', gg.fav);
  f[0].querySelector('i').textContent = r.all || '';
  f[1].querySelector('i').textContent = r.favs || '';
  const sel = $('gnGalModel');
  sel.classList.toggle('hide', r.models.length < 2);
  const opts = `<option value="">${esc(t('gg.anyModel'))}</option>` + r.models.map(m => `<option value="${esc(m.id)}">${esc(ggModelName(m.id))} (${m.n})</option>`).join('');
  if (sel.dataset.html !== opts) { sel.innerHTML = opts; sel.dataset.html = opts; }
  sel.value = gg.model;
  $('gnGalN').textContent = (gg.q || gg.fav || gg.model) ? t('gg.found', {n: r.total}) : '';
  const tiles = gg.items.map((x, i) =>
    `<button type="button" class="gn-gt${gg.sel && gg.sel.has(x.path) ? " on" : ""}" data-i="${i}"><img src="${ggThumb(x)}" alt="" loading="lazy">${gg.sel ? "<span class=\"ck\">✓</span>" : ""}${x.meta.fav ? '<span class="st">★</span>' : ''}<span class="p">${esc(ggPrompt(x))}</span></button>`).join('');
  const more = gg.items.length < r.total ? `<button type="button" class="btn sm gn-gal-more" id="gnGalMore">${esc(t('gg.showMore', {n: Math.min(GG_PAGE, r.total - gg.items.length)}))}</button>` : '';
  grid.innerHTML = tiles + more;
  ggSelUI();
  if (reset) grid.scrollTop = 0;
  const empty = !gg.items.length;
  $('gnGalEmpty').classList.toggle('hide', !empty);
  grid.classList.toggle('hide', empty);
  if (empty) {
    $('gnGalEmptyT').textContent = t(r.all ? 'gg.noneT' : 'gg.emptyT');
    $('gnGalEmptyS').textContent = t(r.all ? (gg.fav && !gg.q ? 'gg.noFavS' : 'gg.noneS') : 'gg.emptyS');
  }
}

$('gnGalBtn').addEventListener('click', () => ggOpen(true));
$('gnGalBack').addEventListener('click', () => ggOpen(false));
let ggQTimer = 0;
$('gnGalQ').addEventListener('input', () => { clearTimeout(ggQTimer); ggQTimer = setTimeout(() => { gg.q = $('gnGalQ').value.trim(); ggLoad(true); }, 200); });
$('gnGalQ').addEventListener('keydown', e => { if (e.key === 'Escape' && $('gnGalQ').value) { e.stopPropagation(); $('gnGalQ').value = ''; gg.q = ''; ggLoad(true); } });
$('gnGalF').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; gg.fav = b.dataset.v === 'fav'; ggLoad(true); });
$('gnGalModel').addEventListener('change', () => { gg.model = $('gnGalModel').value; ggLoad(true); });
$('gnGalGrid').addEventListener('click', e => {
  if (e.target.closest('#gnGalMore')) { ggLoad(false); return; }
  const b = e.target.closest('.gn-gt'); if (!b) return;
  if (gg.pick) { const p = gg.items[+b.dataset.i].path; ggOpen(false); gnRefFromGallery(p); return; }
  if (!gg.sel && (e.ctrlKey || e.metaKey)) gg.sel = new Set();   // Ctrl+щелчок включает выбор
  if (gg.sel) { ggSelToggle(gg.items[+b.dataset.i].path, b); return; }
  ggLb(gg.items, +b.dataset.i);
});

// ---- мультивыбор: отметить несколько картинок и сразу в избранное или в корзину ----

function ggSelToggle(path, tile) {
  if (gg.sel.has(path)) gg.sel.delete(path); else gg.sel.add(path);
  if (tile) tile.classList.toggle('on', gg.sel.has(path));
  ggSelUI();
}
function ggSelUI() {
  const on = !!gg.sel, n = on ? gg.sel.size : 0;
  $('gnGal').classList.toggle('selecting', on);
  const b = $('gnGalSel');
  b.classList.toggle('hide', gg.pick);
  b.textContent = t(on ? 'gg.selDone' : 'gg.select');
  b.classList.toggle('primary', on);
  $('gnGalSelBar').classList.toggle('hide', !on);
  if (!on) { $('gnGalGrid').querySelectorAll('.ck').forEach(c => c.remove()); return; }
  $('gnGalSelN').textContent = t('gg.selN', {n});
  $('gnGalSelFav').disabled = $('gnGalSelDel').disabled = !n;
  const picked = gg.items.filter(x => gg.sel.has(x.path));
  $('gnGalSelFav').textContent = t(picked.length && picked.every(x => x.meta.fav) ? 'gg.selUnfav' : 'gg.selFav');
  // галочки есть у всех плиток (после включения выбора плитки перерисовываются)
  if (gg.page && gg.items.length && !$('gnGalGrid').querySelector('.ck')) ggRender(false);
}
$('gnGalSel').addEventListener('click', () => { gg.sel = gg.sel ? null : new Set(); ggSelUI(); if (gg.page && !gg.sel) ggRender(false); });
$('gnGalSelAll').addEventListener('click', () => { if (!gg.sel) return; gg.items.forEach(x => gg.sel.add(x.path)); ggRender(false); });
$('gnGalSelFav').addEventListener('click', async () => {
  if (!gg.sel || !gg.sel.size) return;
  const picked = gg.items.filter(x => gg.sel.has(x.path));
  const fav = !picked.every(x => x.meta.fav);
  for (const x of picked) {
    if (x.meta.fav === fav) continue;
    if (ggErr(await api('gen-fav', {path: x.path, fav}))) break;
    x.meta.fav = fav;
    ggEach(x.path, y => { y.meta.fav = fav; });
    gg.page.favs += fav ? 1 : -1;
  }
  ggStripRender(); ggRender(false);
});
$('gnGalSelDel').addEventListener('click', async () => {
  if (!gg.sel || !gg.sel.size) return;
  const paths = [...gg.sel], gone = new Set(paths);
  if (ggErr(await api('gen-delete', {paths}))) return;
  const favs = gg.items.filter(x => gone.has(x.path) && x.meta.fav).length;
  gg.strip = gg.strip.filter(x => !gone.has(x.path));
  gg.items = gg.items.filter(x => !gone.has(x.path));
  gg.all -= paths.length;
  gg.page.all -= paths.length; gg.page.total -= paths.length; gg.page.favs -= favs;
  gg.sel = new Set();
  toast({type: 'info', title: t('gg.deletedN', {n: paths.length}), ttl: 4000});
  ggStripRender(); ggRender(false);
});

// ---- окно просмотра ----

function ggLb(list, i) {
  if (!list[i]) return;
  gg.lb = {list, i};
  $('gnLb').classList.remove('hide');
  ggLbRender();
}

// ggLbPath: открыть картинку с холста (её может ещё не быть в ленте)
async function ggLbPath(path) {
  let i = gg.strip.findIndex(x => x.path === path);
  if (i < 0) { await ggStripLoad(); i = gg.strip.findIndex(x => x.path === path); }
  if (i >= 0) ggLb(gg.strip, i);
}

function ggLbClose() { giClose(); gopClose(); $('gnLb').classList.add('hide'); gg.lb = null; }

function ggLbRender() {
  const {list, i} = gg.lb, x = list[i], m = x.meta, p = m.params, rq = m.request || {};
  $('gnLbImg').src = mediaUrl(x.path);
  $('gnLbImg').classList.toggle('cut', !!m.cutout);
  $('gnLbBg').classList.toggle('hide', !!m.cutout);
  $('gnLbInp').classList.toggle('hide', !!m.cutout);   // прозрачную перерисовывать не умеем: движок рисует без прозрачности
  $('gnLbOut').classList.toggle('hide', !!m.cutout);
  const [w, h] = ggSize(m);
  for (const f of [2, 4]) {   // больше GG_UP_MAX по стороне сервер не увеличивает: такую кнопку прячем
    const b = $('gnLbUp' + f);
    b.classList.toggle('hide', w * f > GG_UP_MAX || h * f > GG_UP_MAX);
    if (!b.classList.contains('busy')) b.querySelector('small').textContent = `${w * f}×${h * f}`;
    b.title = t(f === 2 ? 'gg.up2' : 'gg.up4') + ': ' + t('gg.upS', {w: w * f, h: h * f});
  }
  $('gnLbPrev').disabled = i <= 0;
  $('gnLbNext').disabled = i >= list.length - 1;
  const d = new Date(m.created);
  $('gnLbT').textContent = isNaN(d) ? '' : d.toLocaleString(lang, {day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit'});
  $('gnLbFav').setAttribute('aria-pressed', String(!!m.fav));
  $('gnLbPrompt').textContent = ggPrompt(x);
  $('gnLbCp').querySelector('[data-cp=req]').classList.toggle('hide', !rq.prompt || rq.prompt === p.prompt);
  const full = p.prompt !== ggPrompt(x);
  $('gnLbFullD').classList.toggle('hide', !full && !p.negative);
  $('gnLbFull').textContent = p.prompt + (p.negative ? '\n\n' + t('gn.negative') + ': ' + p.negative : '');
  const rows = [
    [t('gn.style'), rq.preset ? (I18N[lang]['gn.pre.' + rq.preset] || rq.preset) : ''],
    [t('gn.model'), ggModelName(m.model)],
    [t('gg.size'), `${w}×${h}`],
    [t('gn.seed'), String(p.seed)],
    [t('gn.steps'), String(p.steps)],
    [t('gn.cfg'), String(p.cfg)],
    [t(rq.inpaint ? 'gg.inpOf' : rq.outpaint ? 'gg.outOf' : 'gg.varOf'), rq.init ? base(rq.init) : ''],
  ].filter(r => r[1]);
  $('gnLbMeta').innerHTML = rows.map(r => `<div><dt>${esc(r[0])}</dt><dd title="${esc(r[1])}">${esc(r[1])}</dd></div>`).join('');
  $('gnLbN').textContent = list.length > 1 ? `${i + 1} / ${list.length}` : '';
}

function ggLbStep(d) {
  if (!gg.lb) return;
  const n = gg.lb.i + d;
  if (n < 0 || n >= gg.lb.list.length) return;
  gg.lb.i = n; ggLbRender();
}

const ggCur = () => gg.lb && gg.lb.list[gg.lb.i];

// все списки держат свои копии; отметку избранного и удаление надо разнести по всем
function ggEach(path, fn) { for (const l of [gg.strip, gg.items]) l.forEach((x, i) => { if (x.path === path) fn(x, i, l); }); }

async function ggFav() {
  const x = ggCur(); if (!x) return;
  const fav = !x.meta.fav;
  if (ggErr(await api('gen-fav', {path: x.path, fav}))) return;
  x.meta.fav = fav;
  ggEach(x.path, y => { y.meta.fav = fav; });
  $('gnLbFav').setAttribute('aria-pressed', String(fav));
  ggStripRender();
  if (gg.open) { gg.page.favs += fav ? 1 : -1; ggRender(false); }
}

async function ggDel() {
  const x = ggCur(); if (!x) return;
  if (ggErr(await api('gen-delete', {paths: [x.path]}))) return;
  const lb = gg.lb;
  for (const l of [gg.strip, gg.items]) { const k = l.findIndex(y => y.path === x.path); if (k >= 0) l.splice(k, 1); }
  toast({type: 'info', title: t('gg.deleted'), text: esc(base(x.path)), ttl: 4000});
  if (!lb.list.length) ggLbClose(); else { lb.i = Math.min(lb.i, lb.list.length - 1); ggLbRender(); }
  gg.all--;
  if (gg.page) { gg.page.all--; gg.page.total--; if (x.meta.fav) gg.page.favs--; }
  ggStripRender();
  if (gg.open) ggRender(false);
}

// настройки картинки — в поля слева; gnApply в gentab.js
async function ggRestore(path) {
  const r = await api('gen-restore', {path});
  if (ggErr(r)) return null;
  return r.restore;
}

async function ggUse(mode) {
  const x = ggCur(); if (!x) return;
  const r = await ggRestore(x.path); if (!r) return;
  ggLbClose();
  if (gg.open) ggOpen(false);
  gnApply(r, mode !== 'use');
  if (mode === 'use') { toast({type: 'ok', title: t('gg.restored'), text: esc(t('gg.restoredS')), ttl: 4000}); $('gnPrompt').focus(); return; }
  // «Ещё такие же» и «Вариации» рисуют с прежним промтом, помощник не зовётся
  // референсы из блока слева сюда не идут: картинка повторяется такой, какой была
  gnGo({...(mode === 'var' ? {init: x.path} : {}), expanded: r.expanded || '', refs: []});
}

async function ggExport(fmt) {
  const x = ggCur(); if (!x) return;
  const r = await api('gen-export', {path: x.path, format: fmt});
  if (ggErr(r) || r.cancel) return;
  toast({type: 'ok', title: t('gg.saved'), text: esc(r.path), ttl: 5000, actions: [{t: t('gg.reveal'), fn: () => api('gen-reveal', {path: r.path})}]});
}

// «Убрать фон»: нейросеть (bgremove.go) кладёт рядом новую картинку с прозрачностью, она открывается здесь же.
// Если генератор рисует, сервер ждёт конца задачи: вместе на видеокарте они не помещаются.
const ggAbort = {};   // идущие «Убрать фон» (bg) и «Увеличить» (up2, up4): AbortController на «Стоп»
async function ggBg() {
  const x = ggCur(), b = $('gnLbBg'); if (!x) return;
  if (b.classList.contains('busy')) { ggAbort.bg?.abort(); return; }   // пока идёт, кнопка — «Стоп»
  b.classList.add('busy');
  const lbl = b.querySelector('span'); lbl.textContent = t('gg.stop'); b.title = t('gg.bgBusy');
  const ac = ggAbort.bg = new AbortController();
  let r;
  try { r = await api('gen-bg', {path: x.path}, ac.signal); } finally { b.classList.remove('busy'); lbl.textContent = t('gg.bg'); b.title = t('gg.bgS'); ggAbort.bg = null; }
  if (r.aborted) { toast({type: 'warn', title: t('upc.stopped'), ttl: 2500}); return; }
  if (r.error) {
    toast({type: 'warn', title: t('gg.bgFail'), text: esc(r.error), ttl: 8000, actions: [{t: t('gn.err.models'), fn: () => { ggLbClose(); gmOpen(true); }}]});
    return;
  }
  await ggStripLoad();
  if (gg.open) await ggLoad(true);
  if (gg.lb) await ggLbPath(r.path);
  toast({type: 'ok', title: t('gg.bgDone'), ttl: 3000});
}

// ggSize: настоящий размер картинки; у увеличенной params остаются исходными (по ним «Ещё такие же»), множитель в upscale
const GG_UP_MAX = 8192;   // как upMaxSide в upscale.go
function ggSize(m) { const u = m.upscale || 1; return [m.params.width * u, m.params.height * u]; }

// «Увеличить ×2 / ×4»: Real-ESRGAN (upscale.go) кладёт рядом новую картинку, она открывается здесь же.
// Модель для фото или для рисунков сервер выбирает по стилю. Пока генератор рисует, сервер ждёт конца задачи.
async function ggUp(f) {
  const x = ggCur(), b = $('gnLbUp' + f); if (!x) return;
  if (b.classList.contains('busy')) { ggAbort['up' + f]?.abort(); return; }   // пока идёт, кнопка — «Стоп»
  b.classList.add('busy');
  const sm = b.querySelector('small'), was = sm.textContent; sm.textContent = t('gg.stop'); b.title = t('gg.upBusy');
  const ac = ggAbort['up' + f] = new AbortController();
  let r;
  try { r = await api('gen-up', {path: x.path, factor: f}, ac.signal); } finally { b.classList.remove('busy'); sm.textContent = was; b.title = t(f === 2 ? 'gg.up2' : 'gg.up4'); ggAbort['up' + f] = null; }
  if (r.aborted) { toast({type: 'warn', title: t('upc.stopped'), ttl: 2500}); return; }
  if (r.error) {
    toast({type: 'warn', title: t('gg.upFail'), text: esc(r.error), ttl: 8000, actions: r.needModel ? [{t: t('gn.err.models'), fn: () => { ggLbClose(); gmOpen(true); }}] : []});
    return;
  }
  await ggStripLoad();
  if (gg.open) await ggLoad(true);
  if (gg.lb) await ggLbPath(r.path);
  toast({type: 'ok', title: t('gg.upDone'), ttl: 3000});
}

async function ggCopy() {
  const x = ggCur(); if (!x) return;
  // через Go (gen-copy): navigator.clipboard в окне программы требует фокуса и не всегда пускает картинки
  if (ggErr(await api('gen-copy', {path: x.path}))) return;
  toast({type: 'ok', title: t('gg.copied'), ttl: 2500});
}

// ggCpText: текст промта и настроек картинки x; kind: exp (развёрнутый), req (что вписал сам), all (всё)
function ggCpText(x, kind) {
  const m = x.meta, p = m.params, rq = m.request || {};
  if (kind === 'exp') return p.prompt;
  if (kind === 'req') return rq.prompt || p.prompt;
  const lines = [p.prompt];
  if (p.negative) lines.push('', t('gn.negative') + ': ' + p.negative);
  lines.push('');
  if (rq.preset) lines.push(t('gn.style') + ': ' + (I18N[lang]['gn.pre.' + rq.preset] || rq.preset));
  lines.push(t('gn.model') + ': ' + ggModelName(m.model), t('gg.size') + ': ' + ggSize(m).join('×'),
    t('gn.steps') + ': ' + p.steps, t('gn.cfg') + ': ' + p.cfg, t('gn.seed') + ': ' + p.seed);
  return lines.join('\n');
}

// копирование через Go: navigator.clipboard в окне программы не всегда пускает
async function ggCopyText(text) {
  if (ggErr(await api('gen-copy-text', {text}))) return;
  toast({type: 'ok', title: t('gg.cpDone'), text: esc(t('gg.cpDoneS')), ttl: 2000});
}

// «Отправить в…»: вкладка получает файл так же, как если бы его туда бросили
async function ggSend(to) {
  const x = ggCur(); if (!x) return;
  const f = {path: x.path, size: x.size || 0};
  ggLbClose();
  if (to === 'color') {
    try {
      const b = await (await fetch(mediaUrl(x.path))).blob();
      setTab('color');
      csPhTake(new File([b], base(x.path), {type: 'image/png'}));
    } catch (e) { say('warn', t('warn.title'), String(e)); }
    return;
  }
  setTab(to);
  if (to === 'conv') { addInfos([f]); updateButtons(); }
  else if (to === 'mont') mtAdd([f]);
  else if (to === 'banner') bAdd([f]);
}

$('gnLbClose').addEventListener('click', ggLbClose);
$('gnLb').addEventListener('click', e => { if (e.target === $('gnLb')) ggLbClose(); });
$('gnLbPrev').addEventListener('click', () => ggLbStep(-1));
$('gnLbNext').addEventListener('click', () => ggLbStep(1));
$('gnLbFav').addEventListener('click', ggFav);
$('gnLbDel').addEventListener('click', ggDel);
$('gnLbUse').addEventListener('click', () => ggUse('use'));
$('gnLbMore').addEventListener('click', () => ggUse('more'));
$('gnLbVar').addEventListener('click', () => ggUse('var'));
$('gnLbCopy').addEventListener('click', ggCopy);
$('gnLbBg').addEventListener('click', ggBg);
$('gnLbUp2').addEventListener('click', () => ggUp(2));
$('gnLbUp4').addEventListener('click', () => ggUp(4));
$('gnLbCp').addEventListener('click', e => { const b = e.target.closest('[data-cp]'), x = ggCur(); if (b && x) ggCopyText(ggCpText(x, b.dataset.cp)); });
$('gnLbReveal').addEventListener('click', () => { const x = ggCur(); if (x) api('gen-reveal', {path: x.path}).then(ggErr); });
$('gnLbSave').addEventListener('click', e => { const b = e.target.closest('[data-fmt]'); if (b) ggExport(b.dataset.fmt); });
$('gnLbSend').addEventListener('click', e => { const b = e.target.closest('[data-to]'); if (b) ggSend(b.dataset.to); });
$('gnLbImg').addEventListener('dblclick', () => { const x = ggCur(); if (x) api('gen-reveal', {path: x.path}).then(ggErr); });
document.addEventListener('keydown', e => {
  if (!gg.lb || $('gnLb').classList.contains('hide') || gi.on || gop.on) return;   // в режиме кисти и рамки клавиши у geninpaint.js и genoutpaint.js
  if (e.target.closest && e.target.closest('input, textarea, select')) return;
  const k = e.key;
  if (k === 'Escape') ggLbClose();
  else if (k === 'ArrowLeft') ggLbStep(-1);
  else if (k === 'ArrowRight') ggLbStep(1);
  else if (k === 'Delete') ggDel();
  else if (k === 'f' || k === 'F' || e.code === 'KeyF') ggFav();
  else return;
  e.preventDefault(); e.stopPropagation();
}, true);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && gg.open && tab === 'gen' && $('gnLb').classList.contains('hide') && document.activeElement !== $('gnGalQ')) ggOpen(false);
});

// ---- картинку бросили на вкладку: вернуть её настройки ----

async function gnDropPaths(list) {
  const f = (list || []).find(x => /\.png$/i.test(x.path));
  if (!f) { say('warn', t('drop.notSuitableTitle'), t('gg.dropPng')); return; }
  const r = await ggRestore(f.path); if (!r) return;
  if (gg.open) ggOpen(false);
  gnApply(r, false);
  toast({type: 'ok', title: t('gg.restored'), text: esc(r.exact ? t('gg.restoredS') : t('gg.restoredA1111')), ttl: 5000});
}
