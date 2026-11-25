// ---------- обучающие туры по вкладкам ----------
// Шаг тура: id — уникален и не меняется (текст поправили — тот же id; шаг надо показать заново — новый id,
// например 'mt.anim.2'; функцию убрали — шаг удалить). sel — селектор или список селекторов: рамка обводит все.
// kind: 'base' — входит в обычный тур вкладки, 'new' — новинка (у новой установки считается просмотренной).
// must — шаг не пропускается кнопкой «Пропустить» и показывается, даже когда автопоказ замолчал.
// Тексты: tour.<id>.h и tour.<id>.d в i18n.json. Нет элемента на экране — шаг тихо пропускается.
// Учёт по шагам (tours.go): шаг просмотрен, когда до него дошли; брошенный тур потом продолжится с непросмотренного.
const TOURS = {
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
};
const TOUR_AUTO_DELAY = 1500, TOUR_MAX_DECLINES = 3;
const tourS = {
  st: {seen: [], declined: {}},   // с сервера: seen, declined, off, fresh
  loaded: null,
  open: false, steps: [], i: 0, tab: '', manual: false, els: [],
  timer: 0, quietTab: '',          // закрытый тур не возвращается, пока не уйдёшь с вкладки и не вернёшься
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

// mode: 'all' — весь тур (из настроек), 'unseen' — непросмотренные шаги, 'must' — только обязательные из них
function tourStart(tabId, mode = 'all') {
  if (tourS.open) tourEnd('away');
  const steps = (TOURS[tabId] || []).filter(s => mode === 'all' || (!tourSeen(s.id) && (mode !== 'must' || s.must)))
    .filter(s => tourTargets(s).length);
  if (!steps.length) return false;
  const D = tourBuild();
  Object.assign(tourS, {steps, tab: tabId, manual: mode === 'all', i: -1, open: true, back: document.activeElement});
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
  const hero = document.querySelector('.hero'), inHero = hero && els.every(e => hero.contains(e));
  const minTop = (hero && !inHero ? hero.getBoundingClientRect().bottom : 0) + 8;
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
  if (how === 'close' && !tourS.manual && (TOURS[tourS.tab] || []).some(s => !tourSeen(s.id))) {
    const dc = tourS.st.declined || (tourS.st.declined = {});
    dc[tourS.tab] = (dc[tourS.tab] || 0) + 1;
    api('tours', {decline: tourS.tab});
  }
  if (how !== 'away') tourS.quietTab = tourS.tab;
  const b = tourS.back;
  if (b && b.isConnected && b.focus) b.focus({preventScroll: true});
}

// занят ли человек: идёт конвертация, открыто окно или меню, тянет мышью или файл, печатает
function tourBusy() {
  if (document.hidden || snap.running || tourS.down || Date.now() - tourS.dragAt < 1500) return true;
  if (document.querySelector('.modal:not(.hide), #setPanel:not(.hide), .ctx:not(.hide)')) return true;
  const a = document.activeElement;
  return !!(a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== 'range' && a.type !== 'checkbox'));
}

async function tourAuto() {
  await tourS.loaded;
  if (tourS.open || !TOURS[tab] || tourS.quietTab === tab) return;
  const left = TOURS[tab].filter(s => !tourSeen(s.id));
  if (!left.length) return;
  const quiet = tourS.st.off || ((tourS.st.declined || {})[tab] || 0) >= TOUR_MAX_DECLINES;
  if (quiet && !left.some(s => s.must)) return;
  if (tourBusy()) { tourS.timer = setTimeout(tourAuto, 2000); return; }
  tourStart(tab, quiet ? 'must' : 'unseen');
}

// вызывается из setTab: тур только на своей вкладке и через полторы секунды после захода
function tourTabChanged() {
  clearTimeout(tourS.timer);
  if (tourS.open && tourS.tab !== tab) tourEnd('away');
  if (tourS.quietTab !== tab) tourS.quietTab = '';
  if (TOURS[tab]) tourS.timer = setTimeout(tourAuto, TOUR_AUTO_DELAY);
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
