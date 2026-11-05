// ---------- вкладка «Монтаж»: окно файлов, вьюпорт, панель клипа, отправка в конвертер. Сами дорожки: tracks.js ----------
let mtFiles = [];             // окно файлов: {name, dir, path, size, dur, w, h, fps, kind, bad}; kind: 'v' видео, 'p' фото, 'a' звук
const mtKnown = new Map();    // уже прочитанные файлы: отмена возвращает файл без нового чтения
let mtLast = '';

const mtFits = name => MEDIA.test(name);
const mtKey = p => p.toLowerCase();
const mtFile = p => mtKnown.get(mtKey(p));
function mtItem(path, size) {
  const key = mtKey(path);
  let it = mtKnown.get(key);
  if (!it) {
    it = {name: base(path), dir: dirOf(path), path, size: size || 0};
    mtKnown.set(key, it);
    it.reading = mtRead(it);
  }
  return it;
}
async function mtRead(it) {
  const mi = await api('info', {path: it.path});
  it.dur = mi.dur; it.w = mi.rotated ? mi.h : mi.w; it.h = mi.rotated ? mi.w : mi.h; it.fps = mi.fps;
  it.size = it.size || mi.size || 0;
  it.kind = IMAGES.test(it.name) ? 'p' : mi.vcodec && !mi.cover ? 'v' : mi.acodec ? 'a' : '';
  it.bad = !!mi.error || !it.kind || (it.kind !== 'p' && !(it.dur > 0));
  tkRender(); mtRender(); mtPanel(); mvShow();
}
function mtSetFiles(list) {
  const seen = new Set();
  mtFiles = [];
  for (const f of list) {
    const key = mtKey(f.path);
    if (seen.has(key)) continue;
    seen.add(key);
    mtFiles.push(mtItem(f.path, f.size));
  }
}
// Файлы снаружи падают в окно файлов, на дорожки их переносят мышью. Что уже есть в окне, второй раз не встаёт.
function mtAdd(list) {
  const bad = [], fresh = [];
  for (const f of list || []) {
    const name = base(f.path);
    if (!mtFits(name)) bad.push(name);
    else if (!mtFiles.some(x => mtKey(x.path) === mtKey(f.path))) fresh.push(f);
  }
  if (bad.length) say('warn', t('mt.notMedia'), bad.join(', '));
  if (fresh.length) tkDo(() => { fresh.forEach(f => mtFiles.push(mtItem(f.path, f.size))); });
}
// файл из плеера: встаёт в окно файлов и в конец дорожки
async function mtShow(f) {
  mtAdd([f]);
  const it = mtFile(f.path);
  if (!it) return;
  await it.reading;
  if (it.bad) { say('warn', t('mt.noDurTitle'), t('mt.noDur')); return; }
  if (!tkClips().some(c => mtKey(c.path) === mtKey(f.path))) tkDo(() => { tkAppend(it); });
}
function mtRemove(it) {
  if (mv.file === it) mvFileOff();
  tkDo(() => {
    mtFiles = mtFiles.filter(x => x !== it);
    tkTracks.forEach(tr => { tr.clips = tr.clips.filter(c => mtKey(c.path) !== mtKey(it.path)); });
  });
}
function mtClear() {
  mvFileOff();
  tkDo(() => { mtFiles = []; tkTracks = tkFresh(); tkAt = 0; tkPath = ''; tkIn = tkOut = null; });
}
function mtRender() {
  $('mtEmpty').classList.toggle('hide', mtFiles.length > 0);
  $('mtList').classList.toggle('hide', !mtFiles.length);
  $('mtAllIn').classList.toggle('hide', !mtFiles.length);
  $('mtCnt').textContent = mtFiles.length ? tn(mtFiles.length, 'n.pcs') : '';
  const html = mtFiles.map((it, i) => {
    const used = tkClips().some(c => mtKey(c.path) === mtKey(it.path));
    return `<div class="f sel mt-file${used ? ' used' : ''}${it.bad ? ' error' : ''}${mv.file === it ? ' cur' : ''}" data-i="${i}" title="${esc(it.path)}">` +
      `<div class="badge th"><img src="${thumbUrl(it.path, .1, 160)}" alt="" draggable="false" loading="lazy" onerror="this.remove()"><span class="ex">${esc(ext(it.name))}</span></div>` +
      `<div class="meta"><div class="n">${esc(it.name)}</div><div class="sub">${it.bad ? esc(t('mt.badFile')) : (it.dur > 0 && it.kind !== 'p' ? fmtDur(it.dur) + ' · ' : '') + fmtSize(it.size)}</div></div>` +
      `<button class="x" data-a="rm" title="${t('list.remove')}" aria-label="${t('list.remove')}">✕</button></div>`;
  }).join('');
  if (html !== mtLast) { $('mtList').innerHTML = html; mtLast = html; }
  mtInfo();
}
function mtButtons() {
  $('mtSend').disabled = $('start').disabled;
  $('dock').classList.toggle('hide', tab === 'mont' && !snap.running);
}
function mtTabChanged() {
  if (tab !== 'mont') { mvPause(); mvUnload(); return; }
  plHold();
  tkRender();
  mvShow();
  mtCopies();
}

// ---------- перенос файла на дорожку ----------
function mtDragFile(e, it) {
  const x0 = e.clientX, y0 = e.clientY;
  let ghost = null, follow = null, row = -1, at = 0;
  const drop = $('tkDrop');
  const len = () => it.kind === 'p' ? TK_PHOTO : it.dur;
  const lanes = () => $('tkLanes').querySelectorAll('.tk-lane');
  const place = ev => {
    const r = tkRowAt(ev.clientY), tr = tkShown()[r], box = $('tkScroll').getBoundingClientRect();
    const inside = r >= 0 && ev.clientX >= box.left && ev.clientX <= box.right && tkFitsTrack(it, tr);
    row = inside ? r : -1;
    drop.classList.toggle('hide', !inside);
    if (!inside) { $('tkSnapLine').classList.add('hide'); return; }
    at = tkTimeAt(ev);
    at = Math.max(at + tkSnapBy([at, at + len()], tkSnapPts(new Set())), 0);
    lanes()[r].appendChild(drop);
    drop.style.left = at * tkPps + 'px';
    drop.style.width = len() * tkPps + 'px';
  };
  const move = ev => {
    if (ev.pointerId !== e.pointerId) return;
    if (!ghost) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < KIN.drag) return;
      if (it.bad || !it.kind) { end(); say('warn', t('mt.noDurTitle'), t('mt.noDur')); return; }
      ghost = document.createElement('div');
      ghost.className = 'tk-ghost';
      ghost.textContent = it.name;
      ghost.style.left = x0 + 'px';
      ghost.style.top = y0 + 'px';
      document.body.appendChild(ghost);
      follow = kinFollow(ghost, {side: 0});
    }
    follow.aim(ev.clientX - x0, ev.clientY - y0);
    place(ev);
  };
  const end = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
  };
  const up = ev => {
    if (ev.pointerId !== e.pointerId) return;
    end();
    if (!ghost) return;
    drop.classList.add('hide');
    $('tkSnapLine').classList.add('hide');
    if (ev.type === 'pointerup' && row >= 0) {
      const tr = tkShown()[row];
      follow.stop();
      ghost.remove();
      tkDo(() => { const c = tkPlace(it, tr, at); tkSel = new Set([c.id]); });
    } else follow.land(0, 0, () => ghost.remove());
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}
$('mtList').addEventListener('pointerdown', e => {
  const row = e.target.closest('.f');
  if (e.button !== 0 || !row || e.target.closest('button')) return;
  const it = mtFiles[+row.dataset.i];
  if (it) { e.preventDefault(); mtDragFile(e, it); }
});
$('mtList').addEventListener('click', e => {
  const row = e.target.closest('.f');
  const it = row && mtFiles[+row.dataset.i];
  if (!it) return;
  if (e.target.closest('[data-a="rm"]')) mtRemove(it);
  else mvFileShow(it);   // щелчок показывает файл во вьюпорте, щелчок по дорожкам возвращает монтаж
});
$('mtList').addEventListener('dblclick', e => {
  const row = e.target.closest('.f');
  const it = row && mtFiles[+row.dataset.i];
  if (!it || e.target.closest('button')) return;
  if (it.bad || !it.kind) { say('warn', t('mt.noDurTitle'), t('mt.noDur')); return; }
  mvFileOff();
  tkDo(() => { const c = tkAppend(it); tkSel = new Set([c.id]); });
});
// старая склейка: все файлы по порядку, встык
$('mtAllIn').onclick = () => {
  const list = mtFiles.filter(it => it.kind && !it.bad);
  if (list.length) tkDo(() => list.forEach(tkAppend));
  tkFit();
};
$('mtAddFiles').onclick = () => dialog(async () => { const r = await api('pick-files'); if (r.error) alert(r.error); mtAdd(r.files); });
$('mtAddFolder').onclick = () => dialog(async () => { const r = await api('pick-folder', {purpose:'add'}); if (r.error) alert(r.error); mtAdd(r.files); });
$('mtClear').onclick = mtClear;

// ---------- панель клипа: до панели эффектов здесь скорость, реверс, повтор и точная обрезка ----------
let mtTrimIt = null;   // что открыто в окне обрезки
function mtPanel() {
  const list = tkSelected(), one = list[0];
  $('mtNoClip').classList.toggle('hide', list.length > 0);
  $('mtClipBox').classList.toggle('hide', !list.length);
  if (!list.length) return;
  const clips = list.filter(c => !tkPhoto(c));
  $('mtClipName').textContent = list.length === 1 ? base(one.path) : t('mt.clipsN', {clips: tn(list.length, 'n.clips')});
  $('mtClipName').title = list.length === 1 ? one.path : '';
  const same = clips.length && clips.every(c => c.speed === clips[0].speed);
  $('mtSpeed').value = same ? String(clips[0].speed) : '';
  $('mtSpeed').disabled = $('mtReverse').disabled = !clips.length;
  $('mtReverse').checked = clips.length > 0 && clips.every(c => c.reverse);
  $('mtTrim').classList.toggle('hide', list.length !== 1 || !clips.length);
  $('mtClipInfo').innerHTML = list.length === 1
    ? [[t('mt.clipAt'), fmtTc(one.at)], [t('mt.clipLen'), fmtTc(tkLen(one))], ...(tkPhoto(one) ? [] : [[t('mt.clipFrom'), `${fmtTc(one.from)} – ${fmtTc(one.from + one.len)}`]])]
        .map(([k, x]) => `<div>${esc(k)}<b>${esc(x)}</b></div>`).join('')
    : '';
}
// строка в панели: сколько получится и что программа сделает сама
function mtInfo() {
  const parts = [], total = tkTotal(), [a, b] = mtRange();
  if (total > 0) parts.push(t('mt.total', {dur: fmtTc(Math.max(b - a, 0))}));
  const marks = tkIn !== null || tkOut !== null;
  $('mtRange').classList.toggle('hide', !marks);
  if (marks) $('mtRangeText').textContent = t('mt.range', {a: fmtTc(a), b: fmtTc(b), dur: fmtTc(Math.max(b - a, 0))});
  const seen = tkTracks.filter(x => x.kind === 'v').flatMap(x => x.clips).map(c => mtFile(c.path)).filter(it => it && it.w);
  if (seen.some(it => it.w !== seen[0].w || it.h !== seen[0].h)) parts.push(t('mt.sizes', {size: `${seen[0].w}×${seen[0].h}`}));
  if (tkClips().some(c => c.reverse)) parts.push(t('mt.revNote'));
  const html = parts.map(esc).join('<br>');
  if ($('mtInfo').innerHTML !== html) $('mtInfo').innerHTML = html;
}
$('mtMarksOff').onclick = tkMarksOff;
// сколько места занимают копии для просмотра; строка видна, только если они есть
async function mtCopies() {
  const r = await api('proxy-usage');
  $('mtCopies').classList.toggle('hide', !(r.bytes > 0));
  if (r.bytes > 0) $('mtCopiesText').textContent = t('mt.copies', {size: fmtSize(r.bytes)});
}
$('mtCopiesClear').onclick = async () => {
  mvPause(); mvUnload();
  mv.state.clear();
  await api('proxy-clear');
  await mtCopies();
  mvShow();
};
$('mtSpeed').addEventListener('change', () => {
  const v = +$('mtSpeed').value;
  $('mtSpeed').blur();
  if (v) tkDo(() => tkTracks.forEach(tr => { tr.clips.forEach(c => { if (tkSel.has(c.id) && !tkPhoto(c)) c.speed = v; }); tkPush(tr); }));
});
$('mtReverse').addEventListener('change', () => {
  const on = $('mtReverse').checked;
  $('mtReverse').blur();
  tkDo(() => tkSelected().forEach(c => { if (!tkPhoto(c)) c.reverse = on; }));
});
const mtRepeat = () => Math.min(Math.max(Math.round(+$('mtRepeat').value) || 2, 2), 20);
$('mtRepeat').addEventListener('change', () => { $('mtRepeat').value = mtRepeat(); });
// повтор: копии клипа встают сразу за ним, следующие клипы отъезжают
$('mtRepeatGo').onclick = () => {
  const n = mtRepeat() - 1;
  tkDo(() => tkSelected().forEach(c => {
    const tr = tkTrackOf(c);
    tr.clips.sort((a, b) => a.at - b.at);
    let at = tr.clips.indexOf(c);
    for (let i = 1; i <= n; i++) tr.clips.splice(++at, 0, Object.assign({}, c, {id: tkNext++, at: c.at + i * tkLen(c)}));
    tkCascade(tr);
  }));
};
$('mtTrim').onclick = () => {
  const c = tkSelected()[0];
  if (!c) return;
  mvPause(); mvUnload();
  const it = mtFile(c.path) || {};
  mtTrimIt = {name: base(c.path), path: c.path, dir: dirOf(c.path), size: it.size, id: c.id, trim: {start: c.from, end: c.from + c.len}};
  openTrim(mtTrimIt);
};
// окно обрезки закрылось: что выбрано, то и станет куском файла
function mtTrimClosed() {
  const it = mtTrimIt;
  mtTrimIt = null;
  const c = it && tkById(it.id);
  if (c) {
    const a = it.trim ? it.trim.start : 0, b = it.trim ? it.trim.end : c.src;
    if (Math.abs(a - c.from) > 1e-3 || Math.abs(b - (c.from + c.len)) > 1e-3) tkDo(() => { c.from = a; c.len = b - a; tkPush(tkTrackOf(c)); });
  }
  mvShow();
}

// ---------- проект файлом ----------
async function mtProjectSave(ask) {
  const r = await api('project-save', {path: ask ? '' : tkPath, data: tkFile()});
  if (r.error) { say('err', t('mt.saveFailed'), r.error); return; }
  if (!r.path) return;
  tkPath = r.path;
  tkAutosave();
  toast({id: 'snap', type: 'ok', title: t('mt.saved'), text: esc(base(r.path)), ttl: 5000});
}
// path: файл открыли снаружи, двойным щелчком; без него программа спросит сама
async function mtProjectOpen(path) {
  const r = await api('project-open', {path: path || ''});
  if (r.error) { say('err', t('mt.openFailed'), r.error); return; }
  if (!r.path) return;
  if (!tkLoad(r.data, r.path)) { say('err', t('mt.openFailed'), base(r.path)); return; }
  mvPause(); mvUnload();
  tkChanged();
  tkFit();
}
function mtProjectIncoming(path) { setTab('mont'); mtProjectOpen(path); }
$('mtOpenProject').onclick = () => dialog(() => mtProjectOpen());
$('mtSaveProject').onclick = () => dialog(() => mtProjectSave(false));

// ---------- в конвертер ----------
const mtClipOut = (c, at) => ({path: c.path, at, from: c.from, len: c.len, speed: c.speed, reverse: c.reverse, ...(c.w > 0 ? {x: c.x || 0, y: c.y || 0, w: c.w, h: c.h} : {})});
// область вывода: от метки до метки, без меток весь монтаж
const mtRange = () => { const end = tkTotal(), a = tkIn !== null ? Math.min(tkIn, end) : 0; return [a, tkOut !== null ? Math.min(tkOut, end) : end]; };
const mtInRange = c => { const [a, b] = mtRange(); return c.at < b - 1e-4 && tkEnd(c) > a + 1e-4; };
function mtProject() {
  const tracks = tkTracks.filter(x => x.clips.length).map(x => ({clips: x.clips.map(c => mtClipOut(c, c.at))}));
  const [a, b] = mtRange();
  const project = {tracks, in: tkIn || 0, out: tkOut || 0};
  return {project, dur: Math.max(b - a, 0), paths: tkClips().filter(mtInRange).sort((x, y) => x.at - y.at).map(c => c.path)};
}
const mtListOf = paths => [...new Map(paths.map(p => [mtKey(p), mtFile(p) || {path: p}])).values()];
$('mtSend').onclick = () => {
  const all = tkClips();
  if (!all.length) { say('warn', t('start.emptyTitle'), t('mt.empty')); return; }
  const bad = all.map(c => mtFile(c.path)).filter(it => it && it.bad);
  if (bad.length) { say('warn', t('mt.badTitle'), [...new Set(bad.map(it => it.name))].join(', ')); return; }
  const inside = all.filter(mtInRange);
  if (!inside.length) { say('warn', t('start.emptyTitle'), t('mt.rangeEmpty')); return; }
  mvPause();
  if ($('mtEach').checked) {
    const [a, b] = mtRange();
    [...inside].sort((x, y) => x.at - y.at).forEach(c => {
      // клип отдельным файлом, от него остаётся только то, что попало между метками
      const lo = Math.max(c.at, a), hi = Math.min(tkEnd(c), b);
      addMontage({tracks: [{clips: [mtClipOut(c, c.at)]}], in: lo, out: hi}, mtListOf([c.path]), hi - lo);
    });
  } else {
    const p = mtProject();
    addMontage(p.project, mtListOf(p.paths), p.dur);
  }
  setTab('conv');
};

try {
  const saved = JSON.parse(storeGet(TK_SAVE_KEY) || 'null');
  if (saved) tkLoad(saved, saved.path);
} catch (e) {}
