// ---------- дорожки монтажа: клипы, инструменты, масштаб, прилипание, отмена, хоткеи. Рендер: timeline.go ----------
// Клип: {id, path, at, from, len, speed, reverse, src}. at — секунда на дорожке, from и len — кусок файла, src — длина файла (у фото 0).
// tkTracks идёт снизу вверх, как ждёт движок: сначала видео, потом звук. На экране видео показано верхней дорожкой вверх.
const TK_HEAD = 76, TK_PHOTO = 5, TK_UNDO = 100, TK_EPS = 1e-3, TK_MIN_PPS = 1, TK_MAX_PPS = 512;
const TK_SAVE_KEY = 'konv9000.mtProject';
const tkFresh = () => ['v', 'v', 'a', 'a'].map(kind => ({kind, thin: false, clips: []}));
let tkTracks = tkFresh(), tkSel = new Set(), tkAt = 0, tkPps = 40, tkTool = 'select', tkSnapOn = true, tkNext = 1;
let tkUndoList = [], tkRedoList = [], tkBoard = [], tkPath = '', tkSaveTimer = 0;
const tkEls = new Map();   // id клипа → его элемент: при перерисовке картинки в клипах не мигают

const tkClips = () => tkTracks.flatMap(x => x.clips);
const tkLen = c => c.len / c.speed;
const tkEnd = c => c.at + tkLen(c);
const tkTotal = () => tkClips().reduce((a, c) => Math.max(a, tkEnd(c)), 0);
const tkById = id => tkClips().find(c => c.id === id);
const tkTrackOf = c => tkTracks.find(x => x.clips.includes(c));
const tkPhoto = c => !c.src;
const tkShown = () => [...tkTracks.filter(x => x.kind === 'v').reverse(), ...tkTracks.filter(x => x.kind === 'a')];
const tkFirstOf = kind => tkTracks.find(x => x.kind === kind);
const tkSelected = () => tkClips().filter(c => tkSel.has(c.id));
// частота как у движка: самый ранний видеоклип самой нижней дорожки, где такой есть (tlCanvas)
function tkFps() {
  for (const tr of tkTracks) {
    if (tr.kind !== 'v') continue;
    let best = null;
    for (const c of tr.clips) if (!tkPhoto(c) && (!best || c.at < best.at)) best = c;
    const it = best && mtFile(best.path);
    if (it && it.fps > 0) return Math.min(it.fps, 240);
  }
  return 30;
}
const tkRound = x => { const f = tkFps(); return Math.round(x * f) / f; };
function fmtTc(x) {
  const f = tkFps(), s = Math.floor(x + 1e-6), ff = Math.floor((x - s) * f + 1e-6);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}:${String(ff).padStart(2, '0')}`;
}

// ---------- отмена и сохранение ----------
const tkState = () => JSON.stringify({tracks: tkTracks, files: mtFiles.map(f => ({path: f.path, size: f.size}))});
function tkCommit(before) {
  if (before !== tkState()) {
    tkUndoList.push(before);
    if (tkUndoList.length > TK_UNDO) tkUndoList.shift();
    tkRedoList = [];
  }
  tkChanged();
}
function tkDo(fn) { const before = tkState(); fn(); tkCommit(before); }
function tkChanged() {
  const ids = new Set(tkClips().map(c => c.id));
  tkSel = new Set([...tkSel].filter(id => ids.has(id)));
  tkRender(); mtRender(); mtPanel(); mvShow();
  clearTimeout(tkSaveTimer);
  tkSaveTimer = setTimeout(tkAutosave, 400);
}
function tkBack(from, to) {
  const s = from.pop();
  if (!s) return;
  to.push(tkState());
  tkApply(JSON.parse(s));
  tkChanged();
}
function tkApply(o) {
  tkTracks = o.tracks;
  tkNext = tkClips().reduce((a, c) => Math.max(a, c.id + 1), tkNext);
  mtSetFiles(o.files || []);
}
const tkFile = () => ({app: 'konvertor9000', v: 1, tracks: tkTracks, files: mtFiles.map(f => ({path: f.path, size: f.size})), at: tkAt, pps: tkPps, snap: tkSnapOn});
function tkAutosave() { storeSet(TK_SAVE_KEY, JSON.stringify(Object.assign(tkFile(), {path: tkPath}))); }
// Проект из файла или автосохранения. Файл могли править руками, поэтому каждое значение проверяется.
function tkLoad(o, path) {
  if (!o || !Array.isArray(o.tracks)) return false;
  const num = (x, d) => Number.isFinite(x) && x >= 0 ? x : d;
  tkNext = 1;
  const tracks = o.tracks.filter(x => x && (x.kind === 'v' || x.kind === 'a')).map(x => ({kind: x.kind, thin: !!x.thin,
    clips: (Array.isArray(x.clips) ? x.clips : []).filter(c => c && typeof c.path === 'string' && c.len > 0).map(c => ({
      id: tkNext++, path: c.path, at: num(c.at, 0), from: num(c.from, 0), len: c.len, speed: c.speed > 0 ? Math.min(Math.max(c.speed, .25), 8) : 1,
      reverse: !!c.reverse, src: num(c.src, 0),
    }))}));
  if (!tracks.some(x => x.kind === 'v')) tracks.unshift({kind: 'v', thin: false, clips: []});
  if (!tracks.some(x => x.kind === 'a')) tracks.push({kind: 'a', thin: false, clips: []});
  tracks.sort((a, b) => (a.kind === 'v' ? 0 : 1) - (b.kind === 'v' ? 0 : 1));
  const paths = tracks.flatMap(x => x.clips).map(c => ({path: c.path}));
  const files = (Array.isArray(o.files) ? o.files : []).filter(f => f && typeof f.path === 'string').concat(paths);
  tkTracks = tracks;
  mtSetFiles(files);
  tkAt = num(o.at, 0);
  if (o.pps > 0) tkPps = Math.min(Math.max(o.pps, TK_MIN_PPS), TK_MAX_PPS);
  if (typeof o.snap === 'boolean') tkSnapOn = o.snap;
  tkPath = path || '';
  tkSel.clear(); tkUndoList = []; tkRedoList = [];
  return true;
}

// ---------- отрисовка ----------
function tkThumb(c, sec) { return thumbUrl(c.path, tkPhoto(c) ? 0 : (sec / c.src).toFixed(4), 160); }
function tkPaint(el, c, tr) {
  const w = Math.max(tkLen(c) * tkPps, 2), it = mtFile(c.path);
  el.style.left = c.at * tkPps + 'px';
  el.style.width = w + 'px';
  el.className = `tk-clip ${tr.kind}${tkSel.has(c.id) ? ' sel' : ''}${it && it.bad ? ' miss' : ''}`;
  el.title = c.path;
  const pics = !tr.thin && tr.kind === 'v', first = pics && w >= 44, last = pics && !tkPhoto(c) && w >= 120, wave = !tr.thin && tr.kind === 'a';
  const sig = [c.path, c.from, c.len, c.speed, c.reverse, first, last, wave, wave ? tkPps : 0].join('|');
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  const a = c.reverse ? c.from + c.len : c.from, b = c.reverse ? c.from : c.from + Math.max(c.len - .05, 0);
  const tag = (c.speed !== 1 ? `${String(c.speed).replace('.', lang === 'ru' ? ',' : '.')}× ` : '') + (c.reverse ? '⇄ ' : '');
  let waveImg = '';
  if (wave && c.src) {
    const scale = tkPps / c.speed, off = c.reverse ? c.src - c.from - c.len : c.from;
    waveImg = `<img class="tk-wave${c.reverse ? ' flip' : ''}" src="${thumbUrl(c.path, 0, 1280)}" alt="" draggable="false" style="left:${-off * scale}px;width:${c.src * scale}px" onerror="this.remove()">`;
  }
  el.innerHTML = waveImg +
    (first ? `<img class="tk-pic" src="${tkThumb(c, a)}" alt="" draggable="false" onerror="this.remove()">` : '') +
    `<span class="tk-name">${esc(tag)}${esc(base(c.path))}</span>` +
    (last ? `<img class="tk-pic end" src="${tkThumb(c, b)}" alt="" draggable="false" onerror="this.remove()">` : '') +
    '<i class="tk-edge l"></i><i class="tk-edge r"></i>';
}
function tkRender() {
  const box = $('tkLanes'), shown = tkShown(), one = {v: tkTracks.filter(x => x.kind === 'v').length, a: tkTracks.filter(x => x.kind === 'a').length};
  const sig = shown.map(x => x.kind + (x.thin ? 't' : '') + (x.clips.length ? 'u' : '')).join() + lang;
  if (box.dataset.sig !== sig) {
    box.dataset.sig = sig;
    $('tkInner').appendChild($('tkDrop'));   // метка места могла остаться в строке, которая сейчас пересоберётся
    let nv = one.v, na = 0;
    box.innerHTML = shown.map(x => {
      const label = x.kind === 'v' ? 'V' + nv-- : 'A' + ++na;
      return `<div class="tk-row ${x.kind}${x.thin ? ' thin' : ''}"><div class="tk-th"><b>${label}</b>` +
        `<button class="tk-mini" data-a="thin" title="${t(x.thin ? 'tk.wide' : 'tk.thin')}" aria-label="${t(x.thin ? 'tk.wide' : 'tk.thin')}">${x.thin ? '▾' : '▴'}</button>` +
        (!x.clips.length && one[x.kind] > 1 ? `<button class="tk-mini" data-a="del" title="${t('tk.delTrack')}" aria-label="${t('tk.delTrack')}">✕</button>` : '') +
        '</div><div class="tk-lane"></div></div>';
    }).join('');
  }
  const lanes = box.querySelectorAll('.tk-lane'), seen = new Set();
  shown.forEach((tr, i) => tr.clips.forEach(c => {
    let el = tkEls.get(c.id);
    if (!el) { el = document.createElement('div'); el.dataset.id = c.id; tkEls.set(c.id, el); }
    tkPaint(el, c, tr);
    if (el.parentNode !== lanes[i]) lanes[i].appendChild(el);
    seen.add(c.id);
  }));
  for (const [id, el] of tkEls) if (!seen.has(id)) { el.remove(); tkEls.delete(id); }
  tkSize(); tkDrawHead(); tkRuler(); tkBar();
}
function tkSize() {
  const sc = $('tkScroll');
  $('tkInner').style.width = Math.max(sc.clientWidth, TK_HEAD + (tkTotal() + 10) * tkPps) + 'px';
}
function tkBar() {
  $('tkToolV').classList.toggle('on', tkTool === 'select');
  $('tkToolC').classList.toggle('on', tkTool === 'razor');
  $('tkSnapBtn').classList.toggle('on', tkSnapOn);
  $('tkUndo').disabled = !tkUndoList.length;
  $('tkRedo').disabled = !tkRedoList.length;
  $('tkZoom').value = Math.log2(tkPps);
  $('tkScroll').classList.toggle('razor', tkTool === 'razor');
}
function tkDrawHead(follow) {
  const sc = $('tkScroll'), x = tkAt * tkPps;
  $('tkHead').style.transform = `translateX(${TK_HEAD + x}px)`;
  if (follow && (x < sc.scrollLeft || x > sc.scrollLeft + sc.clientWidth - TK_HEAD - 20)) sc.scrollLeft = Math.max(x - 40, 0);
  $('mtNow').textContent = fmtTc(tkAt);
  $('mtDur').textContent = fmtTc(tkTotal());
}
const TK_STEPS = [.1, .2, .5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
function tkRuler() {
  const sc = $('tkScroll'), left = sc.scrollLeft, right = left + sc.clientWidth;
  const step = TK_STEPS.find(s => s * tkPps >= 76) || 7200, tick = step / 5;
  let html = '';
  for (let i = Math.floor(left / tkPps / tick); i * tick * tkPps < right; i++) {
    const x = i * tick * tkPps;
    if (i % 5) html += `<u style="left:${x}px"></u>`;
    else html += `<i style="left:${x}px">${step < 1 ? fmtTc(i * tick) : fmtDur(i * tick)}</i>`;
  }
  if ($('tkRuler').innerHTML !== html) $('tkRuler').innerHTML = html;
}

// ---------- время и прилипание ----------
const tkTimeAt = e => Math.max((e.clientX - $('tkRuler').getBoundingClientRect().left) / tkPps, 0);
function tkRowAt(y) {
  const rows = $('tkLanes').querySelectorAll('.tk-lane');
  for (let i = 0; i < rows.length; i++) { const r = rows[i].getBoundingClientRect(); if (y >= r.top && y < r.bottom) return i; }
  return -1;
}
function tkSnapPts(skip) {
  const pts = [0, tkAt];
  for (const c of tkClips()) if (!skip.has(c.id)) pts.push(c.at, tkEnd(c));
  return pts;
}
// на сколько сдвинуть, чтобы одно из времён list встало на точку из pts; заодно показывает линию
function tkSnapBy(list, pts) {
  const line = $('tkSnapLine');
  let best = 0, bestAt = -1, lim = 8 / tkPps;
  if (tkSnapOn) for (const a of list) for (const p of pts) {
    const d = Math.abs(p - a);
    if (d <= lim) { lim = d; best = p - a; bestAt = p; }
  }
  line.classList.toggle('hide', bestAt < 0);
  if (bestAt >= 0) line.style.transform = `translateX(${TK_HEAD + bestAt * tkPps}px)`;
  return best;
}
// Ближайшее свободное место для группы. list: [{c, tr}], c.at — откуда считается сдвиг, want — желаемый сдвиг.
function tkSpot(list, want, onlyLater) {
  const skip = new Set(list.map(x => x.c));
  const others = x => x.tr.clips.filter(o => !skip.has(o));
  const free = d => list.every(x => {
    const a = x.c.at + d, b = a + tkLen(x.c);
    return others(x).every(o => b <= o.at + TK_EPS || a >= tkEnd(o) - TK_EPS);
  });
  const low = -Math.min(...list.map(x => x.c.at));
  if (want >= low && free(want)) return want;
  const cand = [];
  for (const x of list) for (const o of others(x)) cand.push(tkEnd(o) - x.c.at, o.at - tkLen(x.c) - x.c.at);
  cand.sort((a, b) => Math.abs(a - want) - Math.abs(b - want));
  for (const d of cand) if (d >= low && (!onlyLater || d >= want) && free(d)) return d;
  return Math.max(want, low);
}
// клипы дорожки не должны заезжать друг на друга: следующий сдвигается вправо
function tkPush(tr) {
  tr.clips.sort((a, b) => a.at - b.at);
  tkCascade(tr);
}
function tkCascade(tr) {
  for (let i = 1; i < tr.clips.length; i++) {
    const end = tkEnd(tr.clips[i - 1]);
    if (tr.clips[i].at < end - TK_EPS) tr.clips[i].at = end;
  }
}

// ---------- действия ----------
function tkSeek(x) { tkAt = tkRound(Math.max(x, 0)); tkDrawHead(true); mvShow(); }
function tkSelChanged() { tkRender(); mtPanel(); }
function tkNewClip(it, at) {
  const photo = it.kind === 'p';
  return {id: tkNext++, path: it.path, at, from: 0, len: photo ? TK_PHOTO : it.dur, speed: 1, reverse: false, src: photo ? 0 : it.dur};
}
const tkFitsTrack = (it, tr) => (it.kind === 'a') === (tr.kind === 'a');
function tkPlace(it, tr, at) {
  const c = tkNewClip(it, 0);
  c.at = tkRound(tkSpot([{c, tr}], at));
  tr.clips.push(c);
  return c;
}
function tkAppend(it) {
  const tr = tkFirstOf(it.kind === 'a' ? 'a' : 'v');
  return tkPlace(it, tr, tr.clips.reduce((a, c) => Math.max(a, tkEnd(c)), 0));
}
// Разрезать клип в момент x. Левая часть остаётся в c, правая возвращается. У реверса левая часть берёт конец куска файла.
function tkSplit(c, x, tr) {
  x = tkRound(x);
  const half = .5 / tkFps();
  if (x <= c.at + half || x >= tkEnd(c) - half) return null;
  const s = (x - c.at) * c.speed, right = Object.assign({}, c, {id: tkNext++, at: x, len: c.len - s});
  if (tkPhoto(c)) c.len = s;
  else if (c.reverse) { c.from = c.from + c.len - s; c.len = s; }
  else { right.from = c.from + s; c.len = s; }
  tr.clips.splice(tr.clips.indexOf(c) + 1, 0, right);
  return right;
}
function tkCutHere() {
  const hit = c => tkAt > c.at && tkAt < tkEnd(c);
  const list = (tkSel.size ? tkSelected() : tkClips()).filter(hit);
  if (list.length) tkDo(() => list.forEach(c => tkSplit(c, tkAt, tkTrackOf(c))));
}
function tkRemove(ripple) {
  if (!tkSel.size) return;
  tkDo(() => {
    for (const tr of tkTracks) {
      const gone = tr.clips.filter(c => tkSel.has(c.id)).sort((a, b) => b.at - a.at);
      tr.clips = tr.clips.filter(c => !tkSel.has(c.id));
      if (ripple) for (const g of gone) for (const c of tr.clips) if (c.at >= tkEnd(g) - TK_EPS) c.at -= tkLen(g);
    }
    tkSel.clear();
  });
}
function tkCopy() {
  tkBoard = tkSelected().map(c => Object.assign({}, c, {track: tkTracks.indexOf(tkTrackOf(c))}));
}
// вставить копии так, чтобы самая ранняя начиналась в at; занято — ближайшее свободное место правее
function tkInsert(list, at) {
  if (!list.length) return;
  tkDo(() => {
    const first = Math.min(...list.map(c => c.at));
    const items = list.map(s => {
      const c = Object.assign({}, s, {id: tkNext++, at: s.at - first + at});
      delete c.track;
      const own = tkTracks[s.track];
      return {c, tr: own && own.kind === tkBoardKind(s) ? own : tkFirstOf(tkBoardKind(s))};
    });
    const d = tkSpot(items, 0, true);
    items.forEach(x => { x.c.at = tkRound(x.c.at + d); x.tr.clips.push(x.c); });
    tkSel = new Set(items.map(x => x.c.id));
  });
}
const tkBoardKind = s => { const it = mtFile(s.path); return it && it.kind ? (it.kind === 'a' ? 'a' : 'v') : (tkTracks[s.track] || {}).kind || 'v'; };
function tkDuplicate() {
  tkCopy();
  if (tkBoard.length) tkInsert(tkBoard, Math.max(...tkSelected().map(tkEnd)));
}
function tkSetTool(x) { tkTool = x; if (x !== 'razor') $('tkCutLine').classList.add('hide'); tkBar(); }
function tkEdge(dir) {
  const pts = [0, ...tkClips().flatMap(c => [c.at, tkEnd(c)])].map(x => +x.toFixed(4));
  const list = [...new Set(pts)].sort((a, b) => a - b);
  const to = dir < 0 ? list.filter(x => x < tkAt - TK_EPS).pop() : list.find(x => x > tkAt + TK_EPS);
  if (to !== undefined) tkSeek(to);
}
function tkAddTrack(kind) {
  tkDo(() => {
    const row = {kind, thin: false, clips: []};
    if (kind === 'a') tkTracks.push(row);
    else tkTracks.splice(tkTracks.filter(x => x.kind === 'v').length, 0, row);
  });
}

// ---------- масштаб ----------
function tkZoomTo(pps, anchor) {
  const sc = $('tkScroll');
  pps = Math.min(Math.max(pps, TK_MIN_PPS), TK_MAX_PPS);
  const box = sc.getBoundingClientRect();
  const headX = $('tkRuler').getBoundingClientRect().left + tkAt * tkPps;
  const ax = anchor !== undefined ? anchor : headX >= box.left + TK_HEAD && headX <= box.right ? headX : box.left + (box.width + TK_HEAD) / 2;
  const at = (ax - $('tkRuler').getBoundingClientRect().left) / tkPps;
  tkPps = pps;
  tkRender();
  sc.scrollLeft += at * tkPps - (ax - $('tkRuler').getBoundingClientRect().left);
  tkRuler();
  clearTimeout(tkSaveTimer);
  tkSaveTimer = setTimeout(tkAutosave, 400);
}
function tkFit() {
  const sc = $('tkScroll'), room = sc.clientWidth - TK_HEAD - 24;
  if (room <= 0) return;
  tkPps = Math.min(Math.max(room / Math.max(tkTotal(), 1), TK_MIN_PPS), TK_MAX_PPS);
  tkRender();
  sc.scrollLeft = 0;
  tkRuler();
}

// ---------- мышь ----------
function tkDrag(e, move, up) {
  const sc = $('tkScroll');
  e.preventDefault();
  sc.setPointerCapture(e.pointerId);
  const onMove = ev => { if (ev.pointerId === e.pointerId) move(ev); };
  const onUp = ev => {
    if (ev.pointerId !== e.pointerId) return;
    sc.removeEventListener('pointermove', onMove);
    sc.removeEventListener('pointerup', onUp);
    sc.removeEventListener('pointercancel', onUp);
    up(ev);
  };
  sc.addEventListener('pointermove', onMove);
  sc.addEventListener('pointerup', onUp);
  sc.addEventListener('pointercancel', onUp);
}
function tkEdgeScroll(x, dt) {
  const sc = $('tkScroll'), r = sc.getBoundingClientRect(), zone = 40;
  const v = x < r.left + TK_HEAD + zone ? x - (r.left + TK_HEAD + zone) : x > r.right - zone ? x - (r.right - zone) : 0;
  if (!v) return false;
  sc.scrollLeft += v * 14 * dt;
  return true;
}
// Перенос клипов: выделенные идут за мышью на пружине, раскладку трогает только итог.
function tkMoveDrag(e, grab, wasSel) {
  const moving = tkSelected(), ids = new Set(moving.map(c => c.id)), shown = tkShown();
  const rowOf = c => shown.indexOf(tkTrackOf(c));
  const fromRow = new Map(moving.map(c => [c, rowOf(c)]));
  const row0 = fromRow.get(grab), t0 = tkTimeAt(e), x0 = e.clientX, y0 = e.clientY, minAt = Math.min(...moving.map(c => c.at));
  const pts = tkSnapPts(ids), lanes = $('tkLanes').querySelectorAll('.tk-lane');
  const fits = d => moving.every(c => { const to = shown[fromRow.get(c) + d]; return to && to.kind === shown[fromRow.get(c)].kind; });
  const dyOf = (c, d) => lanes[fromRow.get(c) + d].getBoundingClientRect().top - lanes[fromRow.get(c)].getBoundingClientRect().top;
  let on = false, grips = [], dt = 0, dr = 0, px = x0, py = y0;
  const aim = () => {
    let d = Math.max(tkTimeAt({clientX: px}) - t0, -minAt);
    d += tkSnapBy(moving.flatMap(c => [c.at + d, tkEnd(c) + d]), pts);
    dt = Math.max(d, -minAt);
    const r = tkRowAt(py);
    if (r >= 0 && fits(r - row0)) dr = r - row0;
    grips.forEach(g => g.k.aim(dt * tkPps, dyOf(g.c, dr)));
  };
  const lift = () => {
    on = true;
    const r = tkEls.get(grab.id).getBoundingClientRect(), side = Math.max(-1, Math.min(1, (x0 - r.left) / (r.width / 2) - 1));
    grips = moving.map((c, i) => {
      const el = tkEls.get(c.id);
      el.classList.add('tk-lift');
      return {c, el, k: kinFollow(el, {side, onFrame: i ? undefined : dt_ => { if (tkEdgeScroll(px, dt_)) aim(); }})};
    });
  };
  tkDrag(e, ev => {
    px = ev.clientX; py = ev.clientY;
    if (!on && Math.hypot(px - x0, py - y0) >= KIN.drag) lift();
    if (on) aim();
  }, () => {
    $('tkSnapLine').classList.add('hide');
    if (!on) {
      if (wasSel && tkSel.size > 1) { tkSel = new Set([grab.id]); tkSelChanged(); }
      return;
    }
    const d = tkSpot(moving.map(c => ({c, tr: shown[fromRow.get(c) + dr]})), dt);
    let left = grips.length;
    const finish = () => {
      if (--left) return;
      grips.forEach(g => { g.el.classList.remove('tk-lift'); g.el.style.transform = ''; });
      tkDo(() => moving.forEach(c => {
        const from = shown[fromRow.get(c)], to = shown[fromRow.get(c) + dr];
        c.at = tkRound(c.at + d);
        if (to !== from) { from.clips = from.clips.filter(x => x !== c); to.clips.push(c); }
      }));
    };
    grips.forEach(g => g.k.land(d * tkPps, dyOf(g.c, dr), finish));
  });
}
// Край клипа: левый двигает начало на дорожке и в файле, правый только конец. За длину файла и в соседа не уйти.
function tkTrimDrag(e, c, side) {
  const before = tkState(), tr = tkTrackOf(c), o = Object.assign({}, c), oEnd = tkEnd(c), min = 1 / tkFps();
  const near = tr.clips.filter(x => x !== c);
  const prev = near.filter(x => tkEnd(x) <= c.at + TK_EPS).reduce((a, x) => Math.max(a, tkEnd(x)), 0);
  const next = near.filter(x => x.at >= oEnd - TK_EPS).reduce((a, x) => Math.min(a, x.at), Infinity);
  const pts = tkSnapPts(new Set([c.id])), el = tkEls.get(c.id);
  // сколько файла можно открыть за этим краем, в секундах дорожки
  const roomL = tkPhoto(c) ? Infinity : (c.reverse ? c.src - c.from - c.len : c.from) / c.speed;
  const roomR = tkPhoto(c) ? Infinity : (c.reverse ? c.from : c.src - c.from - c.len) / c.speed;
  tkDrag(e, ev => {
    let x = tkTimeAt(ev);
    x = x + tkSnapBy([x], pts);
    if (side === 'l') {
      x = Math.min(Math.max(x, prev, o.at - roomL), oEnd - min);
      const d = (x - o.at) * o.speed;
      c.at = x; c.len = o.len - d;
      if (!tkPhoto(c) && !o.reverse) c.from = o.from + d;
    } else {
      x = Math.max(Math.min(x, next, oEnd + roomR), o.at + min);
      const d = (x - oEnd) * o.speed;
      c.len = o.len + d;
      if (!tkPhoto(c) && o.reverse) c.from = o.from - d;
    }
    el.style.left = c.at * tkPps + 'px';
    el.style.width = tkLen(c) * tkPps + 'px';
  }, () => {
    $('tkSnapLine').classList.add('hide');
    const f = tkFps();
    if (side === 'l') {   // начало встаёт на сетку кадров, файл сдвигается вместе с ним
      const x = tkRound(c.at), d = (x - c.at) * c.speed;
      if (c.len - d >= min) {
        c.at = x; c.len -= d;
        if (!tkPhoto(c) && !c.reverse) c.from += d;
      }
      c.from = Math.max(c.from, 0);
    }
    if (c.src) c.len = Math.min(c.len, c.src - c.from);
    c.len = Math.max(c.len, c.speed / f);
    tkCommit(before);
  });
}
function tkBandDrag(e) {
  const sc = $('tkScroll'), band = $('tkBand'), inner = $('tkInner').getBoundingClientRect();
  const x0 = e.clientX - inner.left, y0 = e.clientY - inner.top;
  const keep = e.ctrlKey || e.shiftKey ? new Set(tkSel) : new Set();
  let on = false;
  tkDrag(e, ev => {
    const r = $('tkInner').getBoundingClientRect(), x1 = ev.clientX - r.left, y1 = ev.clientY - r.top;
    if (!on && Math.hypot(x1 - x0, y1 - y0) < KIN.drag) return;
    on = true;
    band.classList.remove('hide');
    const L = Math.min(x0, x1), T = Math.min(y0, y1), W = Math.abs(x1 - x0), H = Math.abs(y1 - y0);
    Object.assign(band.style, {left: L + 'px', top: T + 'px', width: W + 'px', height: H + 'px'});
    const next = new Set(keep);
    for (const [id, el] of tkEls) {
      const q = el.getBoundingClientRect();
      if (q.left - r.left < L + W && q.right - r.left > L && q.top - r.top < T + H && q.bottom - r.top > T) next.add(id);
    }
    tkSel = next;
    tkRender();
  }, ev => {
    band.classList.add('hide');
    if (on) { mtPanel(); return; }
    tkSel.clear();
    tkSelChanged();
    tkSeek(tkTimeAt(ev));
  });
  sc.focus({preventScroll: true});
}
$('tkScroll').addEventListener('pointerdown', e => {
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  if (e.button !== 0 || e.target.closest('.tk-th')) return;
  if (e.target.closest('#tkRuler')) {
    tkSeek(tkTimeAt(e));
    tkDrag(e, ev => tkSeek(tkTimeAt(ev)), () => {});
    return;
  }
  const el = e.target.closest('.tk-clip');
  if (tkTool === 'razor') {
    const c = el && tkById(+el.dataset.id);
    if (c) {
      let x = tkTimeAt(e);
      x += tkSnapBy([x], tkSnapPts(new Set([c.id])));
      $('tkSnapLine').classList.add('hide');
      tkDo(() => tkSplit(c, x, tkTrackOf(c)));
    }
    e.preventDefault();
    return;
  }
  if (!el) { tkBandDrag(e); return; }
  const c = tkById(+el.dataset.id);
  if (!c) return;
  if (e.ctrlKey || e.metaKey || e.shiftKey) {
    if (tkSel.has(c.id)) tkSel.delete(c.id); else tkSel.add(c.id);
    tkSelChanged();
    e.preventDefault();
    return;
  }
  const wasSel = tkSel.has(c.id);
  if (!wasSel) { tkSel = new Set([c.id]); tkSelChanged(); }
  const edge = e.target.closest('.tk-edge');
  if (edge) tkTrimDrag(e, c, edge.classList.contains('l') ? 'l' : 'r');
  else tkMoveDrag(e, c, wasSel);
});
$('tkScroll').addEventListener('pointermove', e => {
  const line = $('tkCutLine');
  if (tkTool !== 'razor' || e.buttons) return;
  const el = e.target.closest('.tk-clip');
  line.classList.toggle('hide', !el);
  if (!el) return;
  let x = tkTimeAt(e);
  x += tkSnapBy([x], tkSnapPts(new Set([+el.dataset.id])));
  line.style.transform = `translateX(${TK_HEAD + x * tkPps}px)`;
});
$('tkScroll').addEventListener('pointerleave', () => { $('tkCutLine').classList.add('hide'); $('tkSnapLine').classList.add('hide'); });
$('tkScroll').addEventListener('wheel', e => {
  const sc = $('tkScroll');
  if (e.ctrlKey) { e.preventDefault(); tkZoomTo(tkPps * (e.deltaY < 0 ? 1.25 : .8), e.clientX); return; }
  if (!e.shiftKey && sc.scrollHeight <= sc.clientHeight) { e.preventDefault(); sc.scrollLeft += e.deltaY; }
}, {passive: false});
let tkRulerQueued = false;
$('tkScroll').addEventListener('scroll', () => {
  if (tkRulerQueued) return;
  tkRulerQueued = true;
  requestAnimationFrame(() => { tkRulerQueued = false; tkRuler(); });
});
new ResizeObserver(() => { if (tab === 'mont') { tkSize(); tkRuler(); } }).observe($('tkScroll'));
$('tkLanes').addEventListener('click', e => {
  const b = e.target.closest('[data-a]');
  if (!b) return;
  const rows = [...$('tkLanes').children], tr = tkShown()[rows.indexOf(b.closest('.tk-row'))];
  if (!tr) return;
  if (b.dataset.a === 'thin') { tr.thin = !tr.thin; tkChanged(); }
  else if (b.dataset.a === 'del' && !tr.clips.length) tkDo(() => { tkTracks = tkTracks.filter(x => x !== tr); });
});

// ---------- кнопки ----------
$('tkToolV').onclick = () => tkSetTool('select');
$('tkToolC').onclick = () => tkSetTool('razor');
$('tkUndo').onclick = () => tkBack(tkUndoList, tkRedoList);
$('tkRedo').onclick = () => tkBack(tkRedoList, tkUndoList);
$('tkSnapBtn').onclick = () => { tkSnapOn = !tkSnapOn; tkBar(); tkAutosave(); };
$('tkAddV').onclick = () => tkAddTrack('v');
$('tkAddA').onclick = () => tkAddTrack('a');
$('tkFitBtn').onclick = tkFit;
$('tkZoom').addEventListener('input', () => tkZoomTo(2 ** +$('tkZoom').value));
$('tkKeysBtn').onclick = () => $('tkKeys').classList.toggle('hide');
$('tkKeys').onclick = () => $('tkKeys').classList.add('hide');

// ---------- хоткеи: по коду клавиши, поэтому работают и в русской раскладке ----------
const tkTyping = el => el.matches && el.matches('input:not([type=range]):not([type=checkbox]),select,textarea');
const TK_KEYS = {
  Space: () => mvToggle(),
  KeyV: () => tkSetTool('select'),
  KeyC: () => tkSetTool('razor'),
  KeyS: () => $('tkSnapBtn').click(),
  Delete: () => tkRemove(false),
  Backspace: () => tkRemove(false),
  Equal: () => tkZoomTo(tkPps * 1.5),
  NumpadAdd: () => tkZoomTo(tkPps * 1.5),
  Minus: () => tkZoomTo(tkPps / 1.5),
  NumpadSubtract: () => tkZoomTo(tkPps / 1.5),
  Backslash: () => tkFit(),
  ArrowLeft: () => mvStep(-1 / tkFps()),
  ArrowRight: () => mvStep(1 / tkFps()),
  ArrowUp: () => { mvPause(); tkEdge(-1); },
  ArrowDown: () => { mvPause(); tkEdge(1); },
  Home: () => { mvPause(); tkSeek(0); },
  End: () => { mvPause(); tkSeek(tkTotal()); },
  Escape: () => { tkSel.clear(); tkSetTool('select'); tkSelChanged(); $('tkKeys').classList.add('hide'); },
};
const TK_CTRL_KEYS = {
  KeyK: tkCutHere,
  KeyZ: () => tkBack(tkUndoList, tkRedoList),
  KeyY: () => tkBack(tkRedoList, tkUndoList),
  KeyC: tkCopy,
  KeyX: () => { tkCopy(); tkRemove(false); },
  KeyV: () => tkInsert(tkBoard, tkAt),
  KeyD: tkDuplicate,
  KeyA: () => { tkSel = new Set(tkClips().map(c => c.id)); tkSelChanged(); },
  KeyS: () => mtProjectSave(false),
};
document.addEventListener('keydown', e => {
  if (tab !== 'mont' || document.querySelector('.modal:not(.hide)') || tkTyping(e.target) || e.altKey) return;
  const ctrl = e.ctrlKey || e.metaKey;
  let fn;
  if (ctrl && e.shiftKey && e.code === 'KeyZ') fn = () => tkBack(tkRedoList, tkUndoList);
  else if (ctrl && e.shiftKey && e.code === 'KeyS') fn = () => mtProjectSave(true);
  else if (!ctrl && e.shiftKey && e.code === 'Delete') fn = () => tkRemove(true);
  else if (!ctrl && e.shiftKey && e.code === 'ArrowLeft') fn = () => mvStep(-1);
  else if (!ctrl && e.shiftKey && e.code === 'ArrowRight') fn = () => mvStep(1);
  else if (ctrl && !e.shiftKey) fn = TK_CTRL_KEYS[e.code];
  else if (!ctrl && !e.shiftKey) fn = TK_KEYS[e.code];
  if (!fn) return;
  e.preventDefault();
  if (e.target.blur && e.target !== document.body) e.target.blur();   // иначе пробел нажмёт кнопку, на которой фокус
  fn();
});
