// ---------- правка субтитров: дорожка S на таймлайне и список реплик в панели ----------
// Реплики лежат в проекте (tkSubs.cues, поля a, b, t), всегда по порядку и без наложений. Каждое действие отменяется.
let mtCueSel = null;             // номер выбранной реплики
const mtCueMany = new Set();     // все выбранные, когда их несколько (рамка, Ctrl и Shift с мышью, Ctrl+A); mtCueSel среди них
const mtCuePicked = i => i === mtCueSel || mtCueMany.has(i);
function mtCueNone() { mtCueSel = null; mtCueMany.clear(); }
let mtCueBefore = null;          // состояние до начала ввода: весь ввод отменяется одним шагом
let mtCaret = null;              // где стоял курсор в тексте: {i, pos}
const MT_CUE_MIN = .1;
const mtCueList = () => (tkSubs && tkSubs.cues) || [];
const mtCueSec = v => Math.round(v * 1000) / 1000;
function mtCueTime(v) {
  const s = Math.floor(v);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')},${Math.floor((v - s) * 10 + 1e-6)}`;
}
// выбранная реплика, а если её нет, та, что под линией кадра
function mtCueCur() {
  const list = mtCueList();
  if (mtCueSel !== null && list[mtCueSel]) return mtCueSel;
  const i = list.findIndex(c => tkAt >= c.a && tkAt < c.b);
  return i < 0 ? null : i;
}

// ---------- дорожка ----------
let mtCueSig = '';
function mtCueLane() {
  const list = mtCueList(), on = !!tkSubs;
  const off = on && !!tkSubs.off, eye = $('tkSubEye'), tip = t(off ? 'tk.show' : 'tk.hide');
  $('tkSubRow').classList.toggle('hide', !on);
  $('tkSubRow').classList.toggle('off', off);
  eye.classList.toggle('on', off);
  if (eye.title !== tip) { eye.title = tip; eye.setAttribute('aria-label', tip); }
  if (eye.dataset.off !== String(off) || !eye.firstChild) { eye.dataset.off = off; eye.innerHTML = TK_ICON[off ? 'vOff' : 'vOn']; }
  const sig = on ? JSON.stringify([tkPps, mtCueSel, [...mtCueMany], list]) : '';
  if (sig === mtCueSig) return;
  mtCueSig = sig;
  $('tkSubLane').innerHTML = list.map((c, i) => `<div class="tk-cue${mtCuePicked(i) ? ' sel' : ''}" data-i="${i}" style="left:${c.a * tkPps}px;width:${Math.max((c.b - c.a) * tkPps, 2)}px" title="${esc(c.t)}"><b class="l"></b>${esc(c.t.replace(/\s+/g, ' '))}<b class="r"></b></div>`).join('');
}
// Скрытые субтитры остаются в проекте и правятся, но их нет ни во вьюпорте, ни в результате
$('tkSubEye').onclick = () => { if (tkSubs) tkDo(() => { tkSubs = {...tkSubs, off: !tkSubs.off}; }); };
function mtCueSelect(i, seek) {
  mtCueNone();
  mtCueSel = i;
  if (tkSel.size) { tkSel = new Set(); tkSelChanged(); }
  mtCueLane();
  mtCuesFill();
  const row = $('mtCueList').children[i];
  if (row) mtCueReveal(row);
  if (seek) { if (mv.playing) mvPause(); tkSeek(mtCueList()[i].a + 1e-3); }
}
// прокрутить только сам список, панель остаётся на месте
function mtCueReveal(row) {
  const box = $('mtCueList'), top = row.offsetTop - box.offsetTop;
  if (top < box.scrollTop || top + row.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = top - box.clientHeight / 3;
}
// Ctrl или Shift с мышью добавляет реплику к выбранным или убирает её
function mtCueToggle(i) {
  if (mtCueSel !== null) mtCueMany.add(mtCueSel);
  if (mtCueMany.has(i)) mtCueMany.delete(i); else mtCueMany.add(i);
  mtCueSel = mtCueMany.has(mtCueSel) ? mtCueSel : mtCueMany.size ? Math.min(...mtCueMany) : null;
  mtCueLane();
  mtCuesFill();
}
function mtCueAll() {
  const n = mtCueList().length;
  mtCueNone();
  if (!n) { mtCueLane(); mtCuesFill(); return; }
  for (let i = 0; i < n; i++) mtCueMany.add(i);
  mtCueSel = 0;
  if (tkSel.size) { tkSel = new Set(); tkSelChanged(); }
  mtCueLane();
  mtCuesFill();
}
function mtCueDown(e, el) {
  const list = mtCueList(), i = +el.dataset.i, c = list[i];
  if (!c) return;
  if (e.ctrlKey || e.metaKey || e.shiftKey) { mtCueToggle(i); e.preventDefault(); return; }
  const inGroup = mtCueMany.size > 1 && mtCueMany.has(i);
  if (!inGroup) mtCueSelect(i, false);
  const lo = i > 0 ? list[i - 1].b : 0, hi = i + 1 < list.length ? list[i + 1].a : Infinity;
  const side = e.target.classList.contains('l') ? 'l' : e.target.classList.contains('r') ? 'r' : '';
  const before = tkState(), x0 = e.clientX, a0 = c.a, b0 = c.b;
  // вся группа едет вместе и упирается в ближайшую невыбранную реплику
  const group = [...(inGroup ? mtCueMany : [i])].map(n => ({c: list[n], a: list[n].a, b: list[n].b}));
  let min = -Infinity, max = Infinity;
  list.forEach((q, n) => {
    if (!mtCuePicked(n)) return;
    if (n + 1 < list.length && !mtCuePicked(n + 1)) max = Math.min(max, list[n + 1].a - q.b);
    if (n === 0) min = Math.max(min, -q.a);
    else if (!mtCuePicked(n - 1)) min = Math.max(min, list[n - 1].b - q.a);
  });
  let moved = false;
  tkDrag(e, ev => {
    const dx = (ev.clientX - x0) / tkPps;
    if (!moved && Math.abs(ev.clientX - x0) < 3) return;
    moved = true;
    if (side === 'l') c.a = mtCueSec(Math.min(Math.max(a0 + dx, lo), b0 - MT_CUE_MIN));
    else if (side === 'r') c.b = mtCueSec(Math.max(Math.min(b0 + dx, hi), a0 + MT_CUE_MIN));
    else {
      const d = Math.min(Math.max(dx, min), max);
      for (const g of group) { g.c.a = mtCueSec(g.a + d); g.c.b = mtCueSec(g.b + d); }
    }
    mtCueLane();
    mvSubsDraw();
  }, () => {
    if (moved) tkCommit(before);
    else {
      if (inGroup) mtCueSelect(i, false);   // курсор не двигаем, как и при выборе видеокуска
    }
    mtCuesFill();
  });
}
$('tkSubLane').addEventListener('dblclick', e => {
  const el = e.target.closest('.tk-cue');
  if (el) mtCueFocus(+el.dataset.i);
});
function mtCueFocus(i) {
  document.querySelector('details[data-sec=subs]').open = true;
  const row = $('mtCueList').children[i];
  if (row) { mtCueReveal(row); row.querySelector('textarea').focus(); }
}

// ---------- список ----------
function mtCuesFill() {
  const list = mtCueList(), box = $('mtCueList');
  $('mtCueWrap').classList.toggle('hide', !tkSubs || !tkSubs.cues);
  if (mtCueSel !== null && !list[mtCueSel]) mtCueSel = null;
  for (const i of mtCueMany) if (!list[i]) mtCueMany.delete(i);
  // строка с курсором сначала отпускает его: иначе потеря фокуса посреди удаления запустит этот же код ещё раз
  if (box.contains(document.activeElement) && mtCueRowOf(document.activeElement) >= list.length) document.activeElement.blur();
  while (box.children.length > list.length) box.lastChild.remove();
  while (box.children.length < list.length) {
    const row = document.createElement('div');
    row.className = 'mt-cue';
    row.innerHTML = '<button class="mt-cue-t" tabindex="-1"></button><textarea rows="1" spellcheck="false"></textarea>';
    box.appendChild(row);
  }
  list.forEach((c, i) => {
    const row = box.children[i], ta = row.children[1], time = mtCueTime(c.a);
    row.dataset.i = i;
    row.classList.toggle('sel', mtCuePicked(i));
    if (row.children[0].textContent !== time) row.children[0].textContent = time;
    if (document.activeElement !== ta && ta.value !== c.t) ta.value = c.t;
  });
  $('mtCueCount').textContent = tn(list.length, 'n.cues');
  const cur = mtCueCur();
  $('mtCueSplit').disabled = $('mtCueDel').disabled = cur === null;
  $('mtCueMerge').disabled = cur === null || cur + 1 >= list.length;
  $('mtCueSave').disabled = !list.length;
}
const mtCueRowOf = el => { const row = el.closest('.mt-cue'); return row ? +row.dataset.i : null; };
$('mtCueList').addEventListener('click', e => {
  const i = mtCueRowOf(e.target);
  if (i !== null && e.target.closest('.mt-cue-t')) mtCueSelect(i, true);
});
$('mtCueList').addEventListener('focusin', e => {
  const i = mtCueRowOf(e.target);
  if (i === null) return;
  mtCueBefore = tkState();
  if (mtCueSel !== i) mtCueSelect(i, true);
});
$('mtCueList').addEventListener('input', e => {
  const c = mtCueList()[mtCueRowOf(e.target)];
  if (!c) return;
  if (mtCueBefore === null) mtCueBefore = tkState();
  c.t = e.target.value;
  mtCueLane();
  mvSubsDraw();
});
$('mtCueList').addEventListener('focusout', e => {
  const i = mtCueRowOf(e.target);
  if (i === null) return;
  mtCaret = {i, pos: e.target.selectionStart};
  if (mtCueBefore !== null) tkCommit(mtCueBefore);
  mtCueBefore = null;
});
function mtCueAdd() {
  const list = mtCueList();
  let a = tkAt;
  const inside = list.find(c => a >= c.a && a < c.b);
  if (inside) a = inside.b;
  const next = list.find(c => c.a >= a), b = next ? Math.min(a + 2, next.a) : a + 2;
  if (b - a < MT_CUE_MIN) { say('warn', t('mt.secSubs'), t('mt.cue.noRoom')); return; }
  const fresh = {a: mtCueSec(a), b: mtCueSec(b), t: ''};
  tkDo(() => {
    list.push(fresh);
    list.sort((x, y) => x.a - y.a);
    mtCueSel = list.indexOf(fresh);
  });
  mtCueFocus(mtCueSel);
}
// Разрезать там, где стоял курсор в тексте; время: по линии кадра, если она внутри реплики, иначе в той же доле, что и текст
function mtCueSplit() {
  const list = mtCueList(), i = mtCueCur();
  if (i === null) return;
  const c = list[i];
  let pos = mtCaret && mtCaret.i === i ? mtCaret.pos : 0;
  if (pos <= 0 || pos >= c.t.length) {
    const mid = c.t.length / 2, gaps = [...c.t.matchAll(/\s+/g)].map(m => m.index);
    pos = gaps.length ? gaps.reduce((best, g) => Math.abs(g - mid) < Math.abs(best - mid) ? g : best) : Math.floor(mid);
  }
  const share = c.t.length ? pos / c.t.length : .5;
  let at = tkAt > c.a + MT_CUE_MIN && tkAt < c.b - MT_CUE_MIN ? tkAt : c.a + (c.b - c.a) * share;
  at = mtCueSec(Math.min(Math.max(at, c.a + MT_CUE_MIN), c.b - MT_CUE_MIN));
  if (at <= c.a || at >= c.b) return;
  tkDo(() => {
    list.splice(i + 1, 0, {a: at, b: c.b, t: c.t.slice(pos).trim()});
    c.b = at;
    c.t = c.t.slice(0, pos).trim();
    mtCueSel = i + 1;
  });
  mtCaret = null;
}
function mtCueMerge() {
  const list = mtCueList(), i = mtCueCur();
  if (i === null || i + 1 >= list.length) return;
  tkDo(() => {
    list[i].t = `${list[i].t} ${list[i + 1].t}`.trim();
    list[i].b = list[i + 1].b;
    list.splice(i + 1, 1);
    mtCueSel = i;
  });
}
// убрать выбранные реплики без шага отмены: его делает вызывающий
function mtCueDrop() {
  const list = mtCueList(), one = mtCueCur(), gone = mtCueMany.size ? [...mtCueMany] : one === null ? [] : [one];
  if (!gone.length) return;
  gone.sort((a, b) => b - a).forEach(i => list.splice(i, 1));
  const first = gone[gone.length - 1];
  mtCueNone();
  mtCueSel = list[first] ? first : list.length ? list.length - 1 : null;
}
function mtCueDelete() {
  if (mtCueCur() !== null || mtCueMany.size) tkDo(mtCueDrop);
}
$('mtCueAdd').onclick = mtCueAdd;
$('mtCueSplit').onclick = mtCueSplit;
$('mtCueMerge').onclick = mtCueMerge;
$('mtCueDel').onclick = mtCueDelete;
$('mtCueSave').onclick = () => dialog(async () => {
  const r = await api('subs-save', {cues: mtCueList().map(c => ({a: c.a, b: c.b, t: c.t}))});
  if (r.error) { say('err', t('mt.secSubs'), r.error); return; }
  if (r.path) toast({id: 'snap', type: 'ok', title: t('mt.saved'), text: esc(base(r.path)), ttl: 5000});
});
// реплика под линией кадра подсвечена в списке, при просмотре список идёт за ней
let mtCueLit = -1;
function mtCueNow() {
  const list = mtCueList(), i = list.findIndex(c => tkAt >= c.a && tkAt < c.b);
  if (i === mtCueLit) return;
  const box = $('mtCueList'), old = box.children[mtCueLit], row = box.children[i];
  if (old) old.classList.remove('now');
  if (row) {
    row.classList.add('now');
    if (mv.playing && !box.contains(document.activeElement)) mtCueReveal(row);
  }
  mtCueLit = i;
}
