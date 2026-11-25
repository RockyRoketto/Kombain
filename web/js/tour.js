// ---------- обучающие туры по вкладкам ----------
// Шаг тура: id — уникален и не меняется (текст поправили — тот же id; шаг надо показать заново — новый id,
// например 'mt.anim.2'; функцию убрали — шаг удалить). sel — селектор или список селекторов: рамка обводит все.
// kind: 'base' — входит в обычный тур вкладки, 'new' — новинка (у новой установки считается просмотренной).
// must — шаг не пропускается кнопкой «Пропустить» и показывается, даже когда автопоказ замолчал.
// Тексты: tour.<id>.h и tour.<id>.d в i18n.json. Нет элемента на экране — шаг тихо пропускается.
// Учёт по шагам (tours.go): шаг просмотрен, когда до него дошли; брошенный тур потом продолжится с непросмотренного.
const TOURS = {
  conv: [   // общий тур первого запуска: шапка, файлы, куда сохранить, «Конвертировать»
    {id: 'hi.tabs', sel: '#tabs', kind: 'base'},
    {id: 'hi.drop', sel: '#drop', kind: 'base'},
    {id: 'hi.from', sel: '#drop', kind: 'new'},
    {id: 'hi.any', sel: '#accFmt', kind: 'base'},
    {id: 'hi.out', sel: '#accOut .acc-h', kind: 'base'},
    {id: 'hi.start', sel: '#start', kind: 'base'},
  ],
  mont: [
    {id: 'mt.anim', sel: '#mtTabs [data-tab="anim"]', kind: 'new'},
    {id: 'mt.files', sel: '#mtDrop', kind: 'base'},
    {id: 'mt.tracks', sel: '#tkScroll', kind: 'base'},
    {id: 'mt.tools', sel: ['#tkToolV', '#tkToolC'], kind: 'base'},
    {id: 'mt.add', sel: ['#mtLogo', '#mtText', '#mtShape', '#mtShapeMore', '#mtPen', '#mtPenMore'], kind: 'base'},
    {id: 'mt.stage', sel: '#mtStage', kind: 'base'},
    {id: 'mt.canvas', sel: '#mvCanvasBtn', kind: 'base'},
    {id: 'mt.panel', sel: '#mtTabs', kind: 'base'},
    {id: 'mt.keys', sel: '#tkKeysBtn', kind: 'base'},
    {id: 'mt.project', sel: ['#mtOpenProject', '#mtSaveProject'], kind: 'base'},
    {id: 'mt.send', sel: '#mtSend', kind: 'base'},
  ],
  play: [   // без файла видны только первые два шага, остальные покажутся, когда файл откроют
    {id: 'pl.drop', sel: '#plDrop', kind: 'base'},
    {id: 'pl.queue', sel: '.pl-side', kind: 'base'},
    {id: 'pl.ctl', sel: '#plCtl', kind: 'base'},
    {id: 'pl.send', sel: ['#plToConv', '#plToMont', '#plTrim'], kind: 'base'},
  ],
  color: [
    {id: 'cl.tools', sel: '#clTools', kind: 'base'},
    {id: 'cl.bar', sel: '#clBar', kind: 'base'},
    {id: 'cl.out', sel: '#clGrad .cl-out', kind: 'base'},
    {id: 'cl.lib', sel: '#clLib', kind: 'base'},
    {id: 'cl.from', sel: '#clTools [data-tool="photo"]', kind: 'new'},
  ],
  gen: [   // без скачанной модели вместо холста экран установки: шаги холста и ленты покажутся позже
    {id: 'gn.prompt', sel: '#gnPrompt', kind: 'base'},
    {id: 'gn.style', sel: '#gnPresets', kind: 'base'},
    {id: 'gn.model', sel: ['#gnModel', '#gnModelsBtn'], kind: 'base'},
    {id: 'gn.go', sel: '#gnGo', kind: 'base'},
    {id: 'gn.stage', sel: '#gnStage', kind: 'base'},
    {id: 'gn.strip', sel: ['#gnStrip', '#gnGalBtn'], kind: 'base'},
  ],
  ggal: [   // галерея генератора (карточка #gnGal вместо холста): автопоказ при её открытии (ggOpen)
    {id: 'ga.find', sel: ['#gnGalQ', '#gnGalF', '#gnGalModel'], kind: 'base'},
    {id: 'ga.sel', sel: '#gnGalSel', kind: 'base'},
    {id: 'ga.open', sel: '#gnGalGrid', kind: 'base'},
  ],
  gview: [   // окно просмотра картинки (модальное #gnLb): автопоказ при открытии (ggLb), закрывается вместе с окном
    {id: 'gv.bg', sel: ['#gnLbBg', '#gnLbFix'], kind: 'base'},
    {id: 'gv.up', sel: '#gnLbUpBox', kind: 'base'},
    {id: 'gv.inp', sel: '#gnLbInp', kind: 'base'},
    {id: 'gv.out', sel: '#gnLbOut', kind: 'base'},
    {id: 'gv.save', sel: '#gnLbSave', kind: 'base'},
    {id: 'gv.send', sel: '#gnLbSend', kind: 'base'},
  ],
  util: [   // общий для всех инструментов «Утилит»: рамка на видимом элементе выбранного инструмента
    {id: 'ut.tools', sel: '#utTools', kind: 'base'},
    {id: 'ut.drop', sel: ['#fvDrop', '#bDrop', '#bmDrop', '#bgDrop', '#upDrop', '#imDrop', '#pdfDrop'], kind: 'base'},
    {id: 'ut.start', sel: ['#fvSave', '#bStart', '#bmStart', '#bgStart', '#upStart', '#imStart', '#pdfStart'], kind: 'base'},
    {id: 'ut.cmp', sel: ['#bgList .cmpb:not(.ce-go)', '#upList .cmpb'], kind: 'base'},
    {id: 'ut.fix', sel: '#bgEdit', kind: 'base'},
  ],
  // туры инструментов «Утилит» (UT_TOUR): идут сразу после непросмотренного общего тура util, одной лентой
  fav: [
    {id: 'fv.slots', sel: ['#fvSlotLight', '#fvSlotDark'], kind: 'base'},
    {id: 'fv.mocks', sel: '#fvMocks', kind: 'base'},
    {id: 'fv.set', sel: '.fv-set', kind: 'base'},
    {id: 'fv.out', sel: ['#fvWhere', '#fvKind'], kind: 'base'},
  ],
  banner: [
    {id: 'bn.need', sel: '#bNeed', kind: 'base'},
    {id: 'bn.dirs', sel: ['.sw:has(#bAutoDirs)', '#bManualDirs'], kind: 'base'},
    {id: 'bn.from', sel: '#bDrop', kind: 'base'},
  ],
  bmake: [
    {id: 'bm.grid', sel: '#bmGrid', kind: 'base'},
    {id: 'bm.pos', sel: '#bmPosCard', kind: 'base'},
    {id: 'bm.path', sel: '.bm-grp[data-g="where"]', kind: 'base'},
    {id: 'bm.from', sel: '#bmDrop', kind: 'base'},
  ],
  bgcut: [
    {id: 'bg.how', sel: '#bgView .col > .card:first-child', kind: 'base'},
    {id: 'bg.out', sel: '#bgOutMode', kind: 'base'},
  ],
  upscale: [
    {id: 'up.factor', sel: '#upFactor', kind: 'base'},
    {id: 'up.kind', sel: '#upKind', kind: 'base'},
    {id: 'up.out', sel: '#upOutMode', kind: 'base'},
  ],
  imgops: [
    {id: 'im.size', sel: '#imResize', kind: 'base'},
    {id: 'im.fmt', sel: ['#imFormat', '#imQRow'], kind: 'base'},
    {id: 'im.wm', sel: ['#imWmPick', '#imWmSet'], kind: 'base'},
    {id: 'im.out', sel: '#imOutMode', kind: 'base'},
  ],
  pdf: [
    {id: 'pdf.op', sel: '#pdfOp', kind: 'base'},
    {id: 'pdf.par', sel: ['#pdfImgCard', '#pdfCompCard', '#pdfRasCard', '#pdfPgCard', '#pdfFixCard', '#pdfDecCard'], kind: 'base'},
    {id: 'pdf.pv', sel: '#pdfPv', kind: 'base'},
    {id: 'pdf.out', sel: '#pdfAccOut', kind: 'base'},
  ],
};
// инструмент «Утилит» (значение `tab`) → его тур; у фавиконов `tab` = 'util', а тур 'util' — общий
const UT_TOUR = {util: 'fav', banner: 'banner', bmake: 'bmake', pdf: 'pdf', bgcut: 'bgcut', upscale: 'upscale', imgops: 'imgops'};
const UT_TOOLS = Object.keys(UT_TOUR);
// вкладка шапки: у «Утилит» `tab` — выбранный инструмент
const tourTab = () => UT_TOOLS.includes(tab) ? 'util' : tab;
// какие туры к месту сейчас (по порядку): окно просмотра картинки, галерея, общий тур «Утилит» + тур инструмента, вкладка
function tourCtx() {
  if (!$('gnLb').classList.contains('hide')) return ['gview'];
  if (tab === 'gen' && gg.open) return ['ggal'];
  return UT_TOOLS.includes(tab) ? ['util', UT_TOUR[tab]] : [tab];
}
// где тур открывается из настроек: вкладка (`tab`) и, для галереи и просмотра, что открыть
const TOUR_TAB = {fav: 'util', ggal: 'gen', gview: 'gen'};
const TOUR_AUTO_DELAY = 1500, TOUR_WIN_DELAY = 1200, TOUR_MAX_DECLINES = 3;
const tourS = {
  st: {seen: [], declined: {}},   // с сервера: seen, declined, off, fresh
  loaded: null,
  open: false, steps: [], i: 0, keys: [], tool: '', manual: false, els: [],
  timer: 0, quiet: new Set(),      // закрытый тур не возвращается, пока не уйдёшь из его места (вкладки, инструмента, окна)
  down: false, dragAt: 0, back: null, dom: null,
};

tourS.loaded = api('tours').then(r => {
  if (r && r.tours) tourS.st = r.tours;
  if (tourS.st.fresh) {   // новая установка: новинки для неё не новинки
    tourMark(Object.values(TOURS).flat().filter(s => s.kind === 'new').map(s => s.id), true);
  }
});

const tourSeen = id => (tourS.st.seen || []).includes(id);
function tourMark(ids, freshDone) {
  ids = ids.filter(id => !tourSeen(id));
  tourS.st.seen = (tourS.st.seen || []).concat(ids);
  if (freshDone) tourS.st.fresh = false;
  if (ids.length || freshDone) api('tours', {seen: ids, freshDone: !!freshDone});
  if (ids.length) nbSoon();   // просмотренный шаг или совет гасит свой бейдж или «!»
}

function tourVisible(el) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
}
const tourTargets = step => [].concat(step.sel).flatMap(s => [...document.querySelectorAll(s)]).filter(tourVisible);

function tourBuild() {
  if (tourS.dom) return tourS.dom;
  const d = document.createElement('div');
  d.className = 'tour hide'; d.id = 'tour';
  d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true'); d.setAttribute('aria-labelledby', 'tourH');
  d.innerHTML = '<div class="tour-block"></div><div class="tour-hole"></div>' +
    '<div class="tour-pop"><i class="tour-arr"></i><button class="tour-x" type="button">' +
    '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>' +
    '<div class="tour-body"><span class="tour-new"></span><h3 id="tourH"></h3><p class="tour-d"></p></div>' +
    '<div class="tour-foot"><span class="tour-dots" aria-hidden="true"></span><span class="tour-count"></span>' +
    '<button class="tour-skip" type="button"></button><button class="btn sm tour-back" type="button"></button>' +
    '<button class="btn primary sm tour-next" type="button"></button></div></div>';
  document.body.appendChild(d);
  const q = s => d.querySelector(s);
  tourS.dom = {root: d, hole: q('.tour-hole'), pop: q('.tour-pop'), arr: q('.tour-arr'), x: q('.tour-x'), isNew: q('.tour-new'),
    h: q('#tourH'), p: q('.tour-d'), dots: q('.tour-dots'), count: q('.tour-count'), skip: q('.tour-skip'), back: q('.tour-back'), next: q('.tour-next')};
  tourS.dom.next.onclick = tourNext;
  tourS.dom.back.onclick = () => tourGo(tourS.i - 1, -1);
  tourS.dom.skip.onclick = tourSkip;
  tourS.dom.x.onclick = () => tourEnd('close');
  return tourS.dom;
}

// mode: 'all' — весь тур (из настроек), 'unseen' — непросмотренные шаги, 'must' — только обязательные из них,
// 'new' — непросмотренные новинки (кнопка «Показать новое»)
const tourPick = (key, mode) => (TOURS[key] || []).filter(s => mode === 'all' ||
  (!tourSeen(s.id) && (mode !== 'must' || s.must) && (mode !== 'new' || s.kind === 'new')));
function tourStart(key, mode = 'all') { return tourRun([[key, mode]], mode === 'all'); }
// несколько туров одной лентой: parts = [[ключ тура, режим], …] (общий тур «Утилит» и тур инструмента)
function tourRun(parts, manual) {
  if (tourS.open) tourEnd('away');
  const steps = parts.flatMap(([k, m]) => tourPick(k, m)).filter(s => tourTargets(s).length);
  if (!steps.length) return false;
  const D = tourBuild();
  Object.assign(tourS, {steps, keys: parts.map(p => p[0]), tool: tab, manual, i: -1, open: true, back: document.activeElement});
  D.root.classList.remove('hide');
  D.root.classList.add('tour-first');   // первый показ: рамка не едет из угла
  document.body.classList.add('tour-on');
  if (!tourGo(0, 1)) { tourEnd('away'); return false; }
  requestAnimationFrame(() => D.root.classList.remove('tour-first'));
  return true;
}

// перейти к шагу i, а если его элемента уже нет — к ближайшему в сторону dir
function tourGo(i, dir) {
  for (; i >= 0 && i < tourS.steps.length; i += dir) {
    const els = tourTargets(tourS.steps[i]);
    if (els.length) { tourS.i = i; tourShow(els); return true; }
  }
  return false;
}
function tourNext() {
  if (tourS.i >= tourS.steps.length - 1 || !tourGo(tourS.i + 1, 1)) tourEnd('done');
}
// «Пропустить»: обязательные шаги всё равно показываем, остальное — отказ
function tourSkip() {
  const k = tourS.steps.findIndex((s, j) => j > tourS.i && s.must && !tourSeen(s.id));
  if (k < 0 || !tourGo(k, 1)) tourEnd('close');
}

function tourShow(els) {
  const D = tourS.dom, s = tourS.steps[tourS.i], n = tourS.steps.length, last = tourS.i === n - 1;
  tourMark([s.id]);
  tourS.els = els;
  els[0].scrollIntoView({block: 'nearest', inline: 'nearest'});
  D.isNew.textContent = t('tour.new');
  D.isNew.classList.toggle('hide', s.kind !== 'new');
  const key = 'tour.' + s.id;   // ключи tour.<id>.h и .d проверяет TestPageKeysExist не здесь, а по TOURS
  D.h.textContent = t(key + '.h');
  D.p.innerHTML = t(key + '.d');
  D.dots.innerHTML = n > 1 ? tourS.steps.map((_, k) => `<i${k === tourS.i ? ' class="on"' : ''}></i>`).join('') : '';
  D.count.textContent = t('tour.count', {n: tourS.i + 1, m: n});
  D.skip.textContent = t('tour.skip');
  D.skip.classList.toggle('hide', last);
  D.back.textContent = t('tour.back');
  D.back.classList.toggle('hide', tourS.i === 0);
  D.next.textContent = t(last ? 'tour.done' : 'tour.next');
  D.x.title = t('tour.close'); D.x.setAttribute('aria-label', t('tour.close'));
  D.pop.classList.remove('tour-in'); void D.pop.offsetWidth; D.pop.classList.add('tour-in');
  tourPlace();
  setTimeout(tourPlace, 450);   // прокрутка и раскладка могли сдвинуть элемент
  D.next.focus({preventScroll: true});
}

// Плашка по правилам из CLAUDE.md (образец clQPlace): position:fixed, сверху граница — низ шапки .hero
// (если сам элемент не в шапке), не влезает ни снизу, ни сверху — сбоку, иначе внутри большого элемента с ужатой высотой.
function tourPlace() {
  if (!tourS.open) return;
  const D = tourS.dom, els = tourS.els.filter(e => e.isConnected && tourVisible(e));
  if (!els.length) { tourNext(); return; }
  const W = window.innerWidth, H = window.innerHeight, pad = 6, gap = 14;
  const rs = els.map(e => e.getBoundingClientRect());
  const r = {left: Math.min(...rs.map(x => x.left)), top: Math.min(...rs.map(x => x.top)),
    right: Math.max(...rs.map(x => x.right)), bottom: Math.max(...rs.map(x => x.bottom))};
  // в модальном окне (просмотр картинки) шапка закрыта самим окном: граница — край окна программы
  const hero = document.querySelector('.hero'), inHero = hero && els.every(e => hero.contains(e));
  const inModal = els.every(e => e.closest('.modal'));
  const minTop = (hero && !inHero && !inModal ? hero.getBoundingClientRect().bottom : 0) + 8;
  // рамка: в пределах окна, ниже шапки
  const hl = Math.max(2, r.left - pad), ht = Math.max(inHero ? 2 : minTop - 6, r.top - pad);
  const hr = Math.min(W - 2, r.right + pad), hb = Math.min(H - 2, r.bottom + pad);
  Object.assign(D.hole.style, {left: hl + 'px', top: ht + 'px', width: Math.max(0, hr - hl) + 'px', height: Math.max(0, hb - ht) + 'px'});

  D.pop.style.maxHeight = '';
  const w = D.pop.offsetWidth, h = D.pop.offsetHeight;
  const cx = (hl + hr) / 2, cy = (ht + hb) / 2, fitV = H - 8 - minTop;
  const room = {b: H - 8 - (hb + gap), t: ht - gap - minTop, r: W - 8 - (hr + gap), l: hl - gap - 8};
  const clamp = (v, a, b) => Math.max(a, Math.min(v, b));
  let side, x, y;
  if (h <= room.b) side = 'b';
  else if (h <= room.t) side = 't';
  else if (w <= room.r && h <= fitV) side = 'r';
  else if (w <= room.l && h <= fitV) side = 'l';
  else side = 'in';
  if (side === 'b' || side === 't') {
    x = clamp(cx - w / 2, 8, W - 8 - w);
    y = side === 'b' ? hb + gap : ht - gap - h;
  } else if (side === 'r' || side === 'l') {
    x = side === 'r' ? hr + gap : hl - gap - w;
    y = clamp(cy - h / 2, minTop, H - 8 - h);
  } else {   // элемент на весь экран: плашка внутри него снизу, высота по месту
    const maxH = Math.max(80, Math.min(fitV, hb - 16 - Math.max(minTop, ht + 16)));
    if (h > maxH) D.pop.style.maxHeight = maxH + 'px';
    x = clamp(cx - w / 2, 8, W - 8 - w);
    y = clamp(hb - 16 - Math.min(h, maxH), minTop, H - 8 - Math.min(h, maxH));
  }
  D.pop.style.left = x + 'px'; D.pop.style.top = y + 'px';
  D.pop.dataset.side = side;
  if (side === 'b' || side === 't') { D.arr.style.left = clamp(cx - x, 18, w - 18) + 'px'; D.arr.style.top = ''; }
  else if (side === 'r' || side === 'l') { D.arr.style.top = clamp(cy - y, 18, h - 18) + 'px'; D.arr.style.left = ''; }
}

// how: 'done' — дошли до конца, 'close' — крестик, Esc или «Пропустить», 'away' — ушли с вкладки
function tourEnd(how) {
  if (!tourS.open) return;
  tourS.open = false;
  tourS.dom.root.classList.add('hide');
  document.body.classList.remove('tour-on');
  // отказ считается каждому туру ленты, в котором ещё есть непросмотренное: у каждого свои 3 возврата
  if (how === 'close' && !tourS.manual) {
    const dc = tourS.st.declined || (tourS.st.declined = {});
    for (const k of tourS.keys) {
      if (!(TOURS[k] || []).some(s => !tourSeen(s.id))) continue;
      dc[k] = (dc[k] || 0) + 1;
      api('tours', {decline: k});
    }
  }
  if (how !== 'away') tourS.keys.forEach(k => tourS.quiet.add(k));
  const b = tourS.back;
  if (b && b.isConnected && b.focus) b.focus({preventScroll: true});
}

// занят ли человек: идёт конвертация, открыто окно или меню, тянет мышью или файл, печатает.
// Окно просмотра картинки не мешает своему туру, если в нём не идёт обработка, перерисовка или сравнение.
function tourBusy(ctx) {
  if (document.hidden || snap.running || tourS.down || Date.now() - tourS.dragAt < 1500) return true;
  const own = ctx[0] === 'gview' ? $('gnLb') : null;
  if ([...document.querySelectorAll('.modal:not(.hide), #setPanel:not(.hide), .ctx:not(.hide)')].some(m => m !== own)) return true;
  if (own && ['gnLbBusy', 'gnInp', 'gnOut', 'gnCmp'].some(id => !$(id).classList.contains('hide'))) return true;
  const a = document.activeElement;
  if (a && a.id === 'gnGalQ' && !a.value) return false;   // галерея сама ставит курсор в пустой поиск
  return !!(a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== 'range' && a.type !== 'checkbox'));
}

// что показать сейчас: по каждому туру места его непросмотренные шаги; замолчавший тур (автопоказ выключен
// или 3 отказа) — только обязательные. Общий тур «Утилит» и тур инструмента идут одной лентой.
function tourParts(ctx) {
  const parts = [];
  for (const k of ctx) {
    if (!TOURS[k] || tourS.quiet.has(k)) continue;
    const left = TOURS[k].filter(s => !tourSeen(s.id));
    if (!left.length) continue;
    const quiet = tourS.st.off || ((tourS.st.declined || {})[k] || 0) >= TOUR_MAX_DECLINES;
    if (quiet && !left.some(s => s.must)) continue;
    parts.push([k, quiet ? 'must' : 'unseen']);
  }
  return parts;
}

async function tourAuto() {
  await tourS.loaded;
  if (tourS.open) return;
  const ctx = tourCtx(), parts = tourParts(ctx);
  if (!parts.length) return;
  if (tourBusy(ctx)) { tourS.timer = setTimeout(tourAuto, 2000); return; }
  tourRun(parts, false);
}

// Место сменилось: вкладка (setTab), инструмент «Утилит», открыли или закрыли галерею или окно просмотра.
// Тур чужого места закрывается, «тишина» снимается с туров, из чьих мест ушли, а через паузу — автопоказ.
function tourCtxChanged() {
  clearTimeout(tourS.timer);
  const ctx = tourCtx();
  if (tourS.open && (tourS.keys.some(k => !ctx.includes(k)) || tourS.tool !== tab)) tourEnd('away');
  for (const k of [...tourS.quiet]) if (!ctx.includes(k)) tourS.quiet.delete(k);
  if (ctx.some(k => TOURS[k])) tourS.timer = setTimeout(tourAuto, ctx[0] === 'gview' || ctx[0] === 'ggal' ? TOUR_WIN_DELAY : TOUR_AUTO_DELAY);
}

window.addEventListener('pointerdown', () => { tourS.down = true; }, true);
['pointerup', 'pointercancel'].forEach(ev => window.addEventListener(ev, () => { tourS.down = false; }, true));
window.addEventListener('dragover', () => { tourS.dragAt = Date.now(); }, true);
window.addEventListener('resize', tourPlace);
document.addEventListener('scroll', () => { if (tourS.open) tourPlace(); }, true);
// пока тур открыт, клавиши его: горячие клавиши вкладки не срабатывают
window.addEventListener('keydown', e => {
  if (!tourS.open) return;
  const onBtn = e.target && e.target.closest && e.target.closest('.tour-pop button');
  if (e.key === 'Tab') {   // фокус не уходит из плашки
    const bs = [...tourS.dom.pop.querySelectorAll('button')].filter(b => !b.classList.contains('hide'));
    const k = bs.indexOf(document.activeElement);
    bs[(k + (e.shiftKey ? -1 : 1) + bs.length) % bs.length].focus();
  } else if (e.key === 'Escape') tourEnd('close');
  else if (e.key === 'ArrowRight' || (e.key === 'Enter' && !onBtn)) tourNext();
  else if (e.key === 'ArrowLeft' && tourS.i > 0) tourGo(tourS.i - 1, -1);
  else if ((e.key === 'Enter' || e.key === ' ') && onBtn) return;   // кнопка нажмётся сама
  e.preventDefault(); e.stopImmediatePropagation();
}, true);

// ---------- настройки → «Обучение» и кнопка «Показать новое» в окне «Что нового» ----------
// список туров: вкладки, под ними (sub) галерея и просмотр генератора и инструменты «Утилит»
const LEARN_TABS = [['conv'], ['play'], ['mont'], ['color'], ['gen'], ['ggal', 1], ['gview', 1], ['util'],
  ['fav', 1], ['banner', 1], ['bmake', 1], ['bgcut', 1], ['upscale', 1], ['imgops', 1], ['pdf', 1]];
const LEARN_NAME = {conv: 'tab.conv', play: 'tab.play', mont: 'tab.mont', color: 'tab.color', gen: 'tab.gen', util: 'tab.util',
  ggal: 'gg.open', gview: 'learn.gview', fav: 'ut.tFav', banner: 'ut.tBanner', bmake: 'ut.tBm', bgcut: 'ut.tBg',
  upscale: 'ut.tUp', imgops: 'ut.tImg', pdf: 'ut.tPdf'};
const tourDone = id => (TOURS[id] || []).every(s => tourSeen(s.id));
// туры с непросмотренными новинками; тур текущего места первым
function tourNewTabs() {
  const ids = Object.keys(TOURS).filter(id => TOURS[id].some(s => s.kind === 'new' && !tourSeen(s.id)));
  const cur = tourCtx().filter(id => ids.includes(id));
  return [...cur, ...ids.filter(id => !cur.includes(id))];
}
// кнопка в «Что нового» нужна, только пока есть что показать
function newsShowRender() { tourS.loaded.then(() => $('newsShow').classList.toggle('hide', !tourNewTabs().length)); }
// открыть место тура (вкладку, инструмент, галерею или первую картинку ленты) и через паузу запустить тур
async function tourOpen(id, mode) {
  const want = TOUR_TAB[id] || id;
  if (id === 'util' ? tourTab() !== 'util' : tab !== want) setTab(want);
  if (id === 'ggal') { if (gg.lb) ggLbClose(); if (!gg.open) ggOpen(true); }
  if (id === 'gview' && !gg.lb) {
    if (!gg.strip.length) await ggStripLoad();
    if (gg.strip.length) ggLb(gg.strip, 0);
  }
  clearTimeout(tourS.timer);
  setTimeout(() => {
    clearTimeout(tourS.timer);
    if (!tourStart(id, mode)) say('warn', t(LEARN_NAME[id]), t(id === 'gview' ? 'learn.noImg' : 'learn.none'));
  }, 450);
}
function learnRender() {
  $('learnList').innerHTML = LEARN_TABS.map(([id, sub]) => {
    const done = tourDone(id);
    return `<div class="st-row${sub ? ' st-sub' : ''}"><div><span class="lb">${esc(t(LEARN_NAME[id]))}</span><span class="hint${done ? '' : ' upd'}">${esc(t(done ? 'learn.done' : 'learn.todo'))}</span></div><button class="btn sm" data-tour="${id}">${esc(t('learn.show'))}</button></div>`;
  }).join('');
  tourS.loaded.then(() => { $('learnAuto').checked = !tourS.st.off; });
  learnTipsRender();
}
$('learnList').addEventListener('click', e => {
  const b = e.target.closest('[data-tour]');
  if (!b) return;
  setPanel(false);
  tourOpen(b.dataset.tour, 'all');
});
$('learnAuto').onchange = e => {
  tourS.st.off = !e.target.checked;
  api('tours', {auto: e.target.checked});
};
$('learnReset').onclick = async () => {
  if (!await askYes(t('learn.resetAsk'), t('ask.reset'))) return;
  const r = await api('tours', {reset: true});
  if (!r || r.error) { say('err', t('learn.reset'), (r && r.error) || ''); return; }
  tourS.st = r.tours || {seen: [], declined: {}};
  tourS.quiet.clear();
  nbInit();   // бейджи «Новое» снова живы и считают запуски заново
  learnRender();
  newsShowRender();
  say('ok', t('setp.learn'), t('learn.resetDone'));
};
$('newsShow').onclick = () => {
  const ids = tourNewTabs();
  if (!ids.length) return;
  newsClose();
  tourOpen(ids[0], 'new');
};

// ---------- бейдж «Новое» на новинках и советы «!» ----------
// Бейдж «Новое» — по шагам kind 'new' из TOURS (один источник): на самом элементе и, пока на вкладку
// не заходили, на вкладке в шапке. Гаснет, когда навёл (полсекунды) или нажал (id шага в toursSeen), или через
// NEW_LAUNCHES запусков программы (счётчик на id в tours.go). Советы «!» — редкие функции (TIPS): на вкладке
// горит один, навёл — плашка по правилам clQPlace, увёл — совет просмотрен ('tip.<id>' в toursSeen),
// через 0,5 с загорается следующий. Значки лежат в своём слое position:fixed поверх страницы,
// поэтому их не срезает overflow узких панелей; слой ниже окон (.modal) и тура.
const NEW_LAUNCHES = 3;
// советы: текст tip.<id>; tab — вкладка шапки (tourTab), sel — элемент, в углу которого стоит «!»
const TIPS = [
  {id: 'mt.ctx', tab: 'mont', sel: '#tkScroll'},
  {id: 'mt.zoom', tab: 'mont', sel: '#mvZoomBtn'},
  {id: 'mt.split', tab: 'mont', sel: '#mtVSplit'},
  {id: 'cl.mesh', tab: 'color', sel: '#meshMap'},
  {id: 'cl.undo', tab: 'color', sel: '#clLib'},
  {id: 'gn.paste', tab: 'gen', sel: '#gnRefsSec'},
  {id: 'gn.split', tab: 'gen', sel: '#gnVSplit'},
  {id: 'bm.zoom', tab: 'util', sel: '#bmZoomL'},
  {id: 'pdf.lens', tab: 'util', sel: '#pdfPvLensB'},
];
const TIP_TABS = ['mont', 'color', 'gen', 'util'];
const tipKey = id => 'tip.' + id;   // тексты tip.<id> проверяет TestTourTips
const nb = {show: new Set(), layer: null, badges: new Map(), tip: null, tipId: '', tipTab: null, tipWait: 0, hover: null, hoverT: 0, raf: 0};
// вкладка шапки, на которой живёт тур
const tourHeadTab = k => k === 'util' || Object.values(UT_TOUR).includes(k) ? 'util' : TOUR_TAB[k] || k;
const nbSteps = () => Object.entries(TOURS).flatMap(([k, ss]) => ss.filter(s => s.kind === 'new').map(s => ({...s, head: tourHeadTab(k)})));

// при загрузке: какие бейджи живы (не просмотрены, не старше NEW_LAUNCHES запусков); этот запуск им засчитывается
async function nbInit() {
  await tourS.loaded;
  const live = () => nbSteps().filter(s => !tourSeen(s.id) && ((tourS.st.beacons || {})[s.id] || 0) <= NEW_LAUNCHES).map(s => s.id);
  const ids = live();
  if (ids.length) {
    const r = await api('tours', {beacon: ids});
    if (r && r.tours) tourS.st.beacons = r.tours.beacons || {};
  }
  nb.show = new Set(live().filter(id => ids.includes(id)));
  nbSoon();
}

function nbLayer() {
  if (!nb.layer) {
    nb.layer = document.createElement('div');
    nb.layer.className = 'nb-layer';
    document.body.appendChild(nb.layer);
  }
  return nb.layer;
}
function nbSoon() { if (!nb.raf) nb.raf = requestAnimationFrame(() => { nb.raf = 0; nbRender(); }); }
// окно, настройки или тур закрывают страницу: значки прячутся
const nbCovered = () => tourS.open || !!document.querySelector('.modal:not(.hide), #setPanel:not(.hide)');
// элемент виден: сверху граница — низ шапки (если элемент не в ней), снизу и по бокам — окно
function nbBox(el) {
  if (!el || !el.isConnected || !tourVisible(el)) return null;
  const r = el.getBoundingClientRect(), hero = document.querySelector('.hero');
  const top = hero && !hero.contains(el) ? hero.getBoundingClientRect().bottom : 0;
  if (r.bottom < top + 8 || r.top > innerHeight - 8 || r.right < 8 || r.left > innerWidth - 8) return null;
  return r;
}

function nbRender() {
  const cur = tourTab(), covered = nbCovered(), want = new Map();   // элемент → бейдж
  const live = nbSteps().filter(s => nb.show.has(s.id) && !tourSeen(s.id));
  // на вкладку зашли — бейдж на ней в шапке больше не нужен (id 'nt.<шаг>' в toursSeen)
  const entered = live.filter(s => s.head === cur && !tourSeen('nt.' + s.id)).map(s => 'nt.' + s.id);
  if (entered.length && !document.hidden) tourMark(entered);
  // порядок «тур → новинки → советы»: пока здесь ждёт непросмотренный автотур, бейджи этой вкладки молчат
  // (шаги тура сами отметятся просмотренными); после тура или отказа (тишина) — бейджи; «!» — когда нет ни того, ни другого
  const pending = !covered && tourParts(tourCtx()).length > 0;
  let hereNew = false;
  for (const s of live) {
    if (s.head !== cur) {
      const b = !tourSeen('nt.' + s.id) && document.querySelector(`#tabs .tab[data-t="${s.head}"]`);
      if (b) want.set(b, {id: '', tab: true});
      continue;
    }
    if (pending) continue;
    for (const el of [].concat(s.sel).flatMap(q => [...document.querySelectorAll(q)])) {
      if (!want.has(el)) want.set(el, {id: s.id});
      if (!hereNew && nbBox(el)) hereNew = true;
    }
  }
  for (const [el, b] of nb.badges) {
    if (want.has(el) && !covered) continue;
    b.remove(); el.classList.remove('is-new', 'is-new-tab'); delete el.dataset.nb; nb.badges.delete(el);
  }
  if (!covered) for (const [el, w] of want) {
    let b = nb.badges.get(el);
    el.classList.add(w.tab ? 'is-new-tab' : 'is-new');
    el.dataset.nb = w.id;
    if (!b) {
      b = document.createElement('span');
      b.className = 'nb-b';
      nbLayer().appendChild(b);
      nb.badges.set(el, b);
    }
    const r = nbBox(el);
    if (!r) { b.style.visibility = 'hidden'; continue; }
    b.textContent = t('tour.new');
    // правый верхний угол, чуть заходит на кнопку; у края окна — внутрь
    const bw = b.offsetWidth;
    b.style.left = Math.max(4, Math.min(r.right + 7 - bw, innerWidth - 4 - bw)) + 'px';
    b.style.top = Math.max(2, r.top - 9) + 'px';
    b.style.visibility = '';
  }
  tipRender(covered || pending || hereNew || tourBusy(tourCtx()));
}

// ---------- советы «!» ----------
function tipEl() {
  if (nb.tip) return nb.tip;
  const m = nb.tip = document.createElement('button');
  m.type = 'button';
  m.className = 'tip-mark hide';
  m.innerHTML = '!<span class="cl-qt" role="tooltip"></span>';
  m.addEventListener('mouseenter', () => tipOpen(true));
  m.addEventListener('focus', () => tipOpen(true));
  m.addEventListener('mouseleave', () => tipOpen(false));
  m.addEventListener('blur', () => tipOpen(false));
  // клик только открывает: после наведения плашка уже открыта, и переключатель закрывал её сразу
  m.addEventListener('click', e => { e.stopPropagation(); tipOpen(true); });
  nbLayer().appendChild(m);
  return m;
}
function tipOpen(on) {
  const m = tipEl();
  if (!nb.tipId) return;
  if (on) {
    if (m.classList.contains('open')) return;
    m.querySelector('.cl-qt').textContent = t(tipKey(nb.tipId));
    m.classList.add('open');
    clQPlace(m);
    return;
  }
  if (!m.classList.contains('open')) return;
  // прочитан: прячем, следующий загорится через полсекунды
  m.classList.remove('open');
  const id = nb.tipId;
  nb.tipId = ''; m.classList.add('hide');
  nb.tipWait = Date.now() + 500;
  setTimeout(nbSoon, 520);
  tourMark(['tip.' + id]);
}
function tipRender(covered) {
  const m = tipEl();
  const cur0 = tourTab();
  if (nb.tipTab !== cur0) {   // сменили вкладку: «!» старой вкладки гаснет сразу, новый — после того как раскладка встанет
    nb.tipTab = cur0;
    nb.tipId = ''; m.classList.remove('open'); m.classList.add('hide');
    nb.tipWait = Date.now() + 250;
    setTimeout(nbSoon, 280);
    return;
  }
  if (m.classList.contains('open')) {   // открытый совет не переносим на другой элемент
    const tip = TIPS.find(x => x.id === nb.tipId), r = tip && nbBox(document.querySelector(tip.sel));
    if (r && !covered) { tipAt(m, r); return; }
    m.classList.remove('open');
  }
  let pick = null, r = null;
  if (!covered && Date.now() >= nb.tipWait && !document.hidden) {
    const cur = tourTab();
    for (const x of TIPS) {
      if (x.tab !== cur || tourSeen('tip.' + x.id)) continue;
      const el = document.querySelector(x.sel);
      if (!el || el.closest('.is-new')) continue;   // «Новое» и «!» на одном элементе не стоят
      if ((r = nbBox(el))) { pick = x; break; }
    }
  }
  if (!pick) { nb.tipId = ''; m.classList.add('hide'); return; }
  nb.tipId = pick.id;
  m.setAttribute('aria-label', t('tip.mark'));
  m.classList.remove('hide');
  tipAt(m, r);
}
// в правом верхнем углу элемента, в пределах окна и ниже шапки
function tipAt(m, r) {
  const hero = document.querySelector('.hero'), minTop = hero ? hero.getBoundingClientRect().bottom + 2 : 2;
  m.style.left = Math.max(4, Math.min(r.right - 12, innerWidth - 16)) + 'px';
  m.style.top = Math.max(minTop, r.top - 8) + 'px';
}

// наведение на новинку (полсекунды) или нажатие — бейдж просмотрен
document.addEventListener('pointerover', e => {
  const el = (e.target.closest && e.target.closest('.is-new')) || null;
  if (el === nb.hover) return;
  clearTimeout(nb.hoverT);
  nb.hover = el;
  if (el) nb.hoverT = setTimeout(() => { if (nb.hover === el && el.dataset.nb) tourMark([el.dataset.nb]); }, 500);
});
document.addEventListener('click', e => {
  const el = e.target.closest && e.target.closest('.is-new');
  if (el && el.dataset.nb) tourMark([el.dataset.nb]);
  if (nb.tip && nb.tip.classList.contains('open') && !nb.tip.contains(e.target)) tipOpen(false);
}, true);
// смена вкладки или инструмента: сразу перерисовать, не ждать тика
document.addEventListener('click', e => { if (e.target.closest && e.target.closest('#tabs .tab, #utTools .cl-tool')) setTimeout(nbSoon, 0); });
window.addEventListener('resize', nbSoon);
document.addEventListener('scroll', nbSoon, true);
setInterval(() => { if (!document.hidden) nbRender(); }, 400);   // панели раскрываются и едут без событий
nbInit();

// страница «Обучение»: все советы, чтобы перечитать
function learnTipsRender() {
  $('learnTips').innerHTML = TIP_TABS.map(tb => {
    const list = TIPS.filter(x => x.tab === tb);
    return list.length ? `<div class="learn-tg">${esc(t(LEARN_NAME[tb]))}</div>` +
      list.map(x => `<p class="learn-tip">${esc(t(tipKey(x.id)))}</p>`).join('') : '';
  }).join('');
}
