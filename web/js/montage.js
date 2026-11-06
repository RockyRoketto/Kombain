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
  it.audio = !!mi.acodec;
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
  tkDo(() => { mtFiles = []; tkTracks = tkFresh(); tkAt = 0; tkPath = ''; tkIn = tkOut = null; tkMarkers = []; tkCanvas = null; tkSubs = null; });
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
  $('dock').classList.toggle('hide', (tab === 'mont' || tab === 'play') && !snap.running);
}
function mtTabChanged() {
  if (tab !== 'mont') { mvPause(); mvUnload(); return; }
  plHold();
  mtSplitLoad(); mtVSplitLoad();
  tkRender();
  mvShow();
  mtCopies();
}

// ---------- разделитель между верхом и дорожками: высота дорожек тянется мышью и запоминается ----------
const MT_SPLIT_KEY = 'konv9000.mtSplit';
function mtSplitSet(h) {
  const view = $('montView').clientHeight;
  // сверху остаётся место на вьюпорт с кнопками, снизу на панель и шкалу с одной дорожкой
  const max = Math.max(view - 240, 170), v = Math.min(Math.max(h, 170), max);
  $('tkBox').style.maxHeight = 'none';
  $('tkBox').style.height = v + 'px';
  mvSizeCanvas();
  return v;
}
$('mtSplit').addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  e.preventDefault();
  const bar = $('mtSplit'), y0 = e.clientY, h0 = $('tkBox').offsetHeight;
  let cur = h0;
  bar.setPointerCapture(e.pointerId);
  bar.classList.add('on');
  const move = ev => { cur = mtSplitSet(h0 - (ev.clientY - y0)); };
  const up = () => {
    bar.removeEventListener('pointermove', move);
    bar.removeEventListener('pointerup', up);
    bar.removeEventListener('pointercancel', up);
    bar.classList.remove('on');
    storeSet(MT_SPLIT_KEY, cur);
  };
  bar.addEventListener('pointermove', move);
  bar.addEventListener('pointerup', up);
  bar.addEventListener('pointercancel', up);
});
function mtSplitLoad() { const h = +storeGet(MT_SPLIT_KEY); if (h > 0) mtSplitSet(h); }
window.addEventListener('resize', () => { if (tab === 'mont') { mtSplitLoad(); mtVSplitLoad(); } });
// Ширина панели эффектов: тянется за полосу между ней и вьюпортом, двойной щелчок возвращает как было
const MT_VSPLIT_KEY = 'konv9000.mtPanelW';
function mtVSplitPlace() {
  const p = $('mtPanel'), bar = $('mtVSplit');
  Object.assign(bar.style, {left: p.offsetLeft - 7 + 'px', top: p.offsetTop + 'px', height: p.offsetHeight + 'px'});
}
function mtVSplitSet(w) {
  const view = $('montView').clientWidth, left = $('mtStage').closest('.mt-view').offsetLeft;
  const v = Math.round(Math.min(Math.max(w, 220), Math.max(view - left - 320, 220)));
  $('montView').style.setProperty('--mt-right', v + 'px');
  mvSizeCanvas();
  return v;
}
function mtVSplitLoad() { const w = +storeGet(MT_VSPLIT_KEY); if (w > 0) mtVSplitSet(w); }
new ResizeObserver(mtVSplitPlace).observe($('mtPanel'));
$('mtVSplit').addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  e.preventDefault();
  const bar = $('mtVSplit'), x0 = e.clientX, w0 = $('mtPanel').offsetWidth;
  let cur = w0;
  bar.setPointerCapture(e.pointerId);
  bar.classList.add('on');
  const move = ev => { cur = mtVSplitSet(w0 - (ev.clientX - x0)); mtVSplitPlace(); };
  const up = () => {
    bar.removeEventListener('pointermove', move);
    bar.removeEventListener('pointerup', up);
    bar.removeEventListener('pointercancel', up);
    bar.classList.remove('on');
    storeSet(MT_VSPLIT_KEY, cur);
  };
  bar.addEventListener('pointermove', move);
  bar.addEventListener('pointerup', up);
  bar.addEventListener('pointercancel', up);
});
$('mtVSplit').addEventListener('dblclick', () => {
  $('montView').style.removeProperty('--mt-right');
  storeSet(MT_VSPLIT_KEY, '');
  mvSizeCanvas();
  mtVSplitPlace();
});

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
      follow = kinFollow(ghost, {still: true});
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
      tkDo(() => { tkSel = new Set(tkIds(tkPlace(it, tr, at))); });
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
  tkDo(() => { tkSel = new Set(tkIds(tkAppend(it))); });
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

// ---------- панель эффектов ----------
// Разделы свёрнуты, пока их не откроют; что открыто, запоминается. Новому разделу хватит data-sec в разметке.
(() => {
  const key = 'konv9000.mtSecs';
  let open = {};
  try { open = JSON.parse(localStorage.getItem(key)) || {}; } catch (err) {}
  $('mtPanel').querySelectorAll('details[data-sec]').forEach(d => {
    d.open = !!open[d.dataset.sec];
    d.addEventListener('toggle', () => {
      open[d.dataset.sec] = d.open;
      try { localStorage.setItem(key, JSON.stringify(open)); } catch (err) {}
    });
  });
})();
// Значение в заголовке свёрнутого раздела: пусто, пока в разделе всё как было
const mtSum = (id, text) => { $(id).textContent = text; };
const mtFadeSum = (a, b) => [a ? '↗' + a : '', b ? '↘' + b : ''].filter(Boolean).join(' ');
let mtTrimIt = null;   // что открыто в окне обрезки
// Вкладки панели: Видео, Аудио, Клип. Выбор запоминается; если у клипа такой части нет, видна первая из тех, что есть.
// Точка на вкладке: внутри что-то изменено.
let mtTab = 'v';
try { mtTab = localStorage.getItem('konv9000.mtTab') || 'v'; } catch (err) {}
function mtTabs() {
  const has = {v: mtFrameClips().length > 0, a: mtSoundClips().length > 0, c: true};
  const show = has[mtTab] ? mtTab : has.v ? 'v' : has.a ? 'a' : 'c';
  $('mtPanel').querySelectorAll('.mt-pane').forEach(p => {
    const id = p.dataset.tab, b = $('mtTabs').querySelector(`[data-tab="${id}"]`);
    p.classList.toggle('hide', id !== show);
    b.classList.toggle('on', id === show);
    b.disabled = !has[id];
    b.classList.toggle('mark', has[id] && [...p.querySelectorAll('summary em')].some(e => e.textContent && !e.closest('#mtCatFrame.hide')));
  });
}
$('mtTabs').addEventListener('click', e => {
  const b = e.target.closest('.mt-tab');
  if (!b || b.disabled) return;
  mtTab = b.dataset.tab;
  try { localStorage.setItem('konv9000.mtTab', mtTab); } catch (err) {}
  mtTabs();
});
function mtPanel() {
  mtSubsFill();
  const list = tkSelected(), one = tkOne();
  $('mtNoClip').classList.toggle('hide', list.length > 0);
  $('mtClipBox').classList.toggle('hide', !list.length);
  if (!list.length) return;
  const clips = list.filter(c => !tkPhoto(c));
  $('mtClipName').textContent = one ? tkClipName(one) : t('mt.clipsN', {clips: tn(list.length, 'n.clips')});
  $('mtClipName').title = one && !one.text ? one.path : '';
  const same = clips.length && clips.every(c => c.speed === clips[0].speed);
  $('mtSpeed').value = same ? String(clips[0].speed) : '';
  $('mtSpeed').disabled = $('mtReverse').disabled = !clips.length;
  $('mtReverse').checked = clips.length > 0 && clips.every(c => c.reverse);
  mtSum('mtSumTime', [same && clips[0].speed !== 1 ? clips[0].speed + '×' : '', clips.length && $('mtReverse').checked ? '↺' : ''].filter(Boolean).join(' '));
  $('mtTrim').classList.toggle('hide', !one || !clips.length);
  mtFramePanel();
  mtSoundPanel();
  $('mtClipInfo').innerHTML = one
    ? [[t('mt.clipAt'), fmtTc(one.at)], [t('mt.clipLen'), fmtTc(tkLen(one))], ...(tkPhoto(one) ? [] : [[t('mt.clipFrom'), `${fmtTc(one.from)} – ${fmtTc(one.from + one.len)}`]])]
        .map(([k, x]) => `<div>${esc(k)}<b>${esc(x)}</b></div>`).join('')
    : '';
}
// ---------- разделы видео и звука ----------
const mtFrameClips = () => tkSelected().filter(c => tkTrackOf(c).kind === 'v');
const mtSoundClips = () => tkSelected().filter(c => tkTrackOf(c).kind === 'a' || (!c.part && !!(mtFile(c.path) || {}).audio));
const mtFrameOne = () => { const c = tkOne(); return c && tkTrackOf(c).kind === 'v' ? c : null; };
// общее значение поля для нескольких клипов; разные значения: поле пустое
const mtSame = (list, get) => { const v = get(list[0]); return list.every(c => get(c) === v) ? v : ''; };
const mtRnd = (v, n) => +v.toFixed(n);
const mtPut = (c, key, v, none) => { if (v === none) delete c[key]; else c[key] = v; };
const MT_COLOR = [['mtColBri', 'cBri'], ['mtColCon', 'cCon'], ['mtColMid', 'cMid'], ['mtColSat', 'cSat'], ['mtColTemp', 'cTemp'], ['mtColTint', 'cTint']];
function mtFramePanel() { mtTextFill(); mtFrameFill(); mtTabs(); }
function mtSoundPanel() { mtSoundFill(); mtTabs(); }
function mtFrameFill() {
  const clips = mtFrameClips(), one = mtFrameOne();
  $('mtCatFrame').classList.toggle('hide', !one);
  if (!clips.length) return;
  const keyOn = clips.every(c => c.key);
  $('mtKeyOn').checked = keyOn;
  $('mtKeyBody').classList.toggle('hide', !keyOn);
  $('mtKeyPick').classList.toggle('hide', !one);
  $('mtKeyPick').classList.toggle('on', chromaPicking());
  if (keyOn) {
    $('mtKeyColor').value = clips[0].key;
    mtVal('mtKeySim', mtSame(clips, c => mtRnd((c.keySim || 0) * 100, 0)));
    mtVal('mtKeyBlend', mtSame(clips, c => mtRnd((c.keyBlend || 0) * 100, 0)));
    mtVal('mtKeySpill', mtSame(clips, c => mtRnd((c.keySpill || 0) * 100, 0)));
  }
  mtSum('mtSumKey', clips.some(c => c.key) ? '●' : '');
  MT_COLOR.forEach(([id, key]) => mtVal(id, mtSame(clips, c => mtRnd((c[key] || 0) * 100, 0))));
  mtSum('mtSumColor', clips.some(chromaGraded) ? '●' : '');
  const fadeIn = mtSame(clips, c => c.fadeIn || 0), fadeOut = mtSame(clips, c => c.fadeOut || 0);
  mtVal('mtFadeIn', fadeIn);
  mtVal('mtFadeOut', fadeOut);
  mtFadeMax(clips, 'mtFadeIn', 'mtFadeOut');
  mtSum('mtSumFade', mtFadeSum(fadeIn, fadeOut));
  if (!one) return;
  const b = mvBox(one), f = mvFitBox(one), d = mvCanvasDims(), o = mvCropOf(one);
  const x = Math.round((b.x + b.w / 2 - .5) * d.w), y = Math.round((b.y + b.h / 2 - .5) * d.h), scale = mtRnd(b.w / f.w * 100, 1), rot = one.rot || 0;
  const crop = [o.l, o.r, o.t, o.b].map(v => mtRnd(v * 100, 1));
  mtBounds('mtPosX', -d.w, d.w);
  mtBounds('mtPosY', -d.h, d.h);
  mtVal('mtPosX', x);
  mtVal('mtPosY', y);
  mtVal('mtScale', scale);
  mtVal('mtRot', rot);
  mtVal('mtCropL', crop[0]);
  mtVal('mtCropR', crop[1]);
  mtVal('mtCropT', crop[2]);
  mtVal('mtCropB', crop[3]);
  mtSum('mtSumMotion', x || y || scale !== 100 || rot ? `${scale}% · ${rot}°` : '');
  mtSum('mtSumCrop', crop.some(Boolean) ? '●' : '');
  $('mtCropMouse').classList.toggle('on', mv.crop === one.id);
}
function mtSoundFill() {
  const clips = mtSoundClips();
  if (!clips.length) return;
  const v = mtSame(clips, c => c.vol === undefined ? 1 : c.vol), fadeIn = mtSame(clips, c => c.fadeIn || 0), fadeOut = mtSame(clips, c => c.fadeOut || 0);
  mtVal('mtVolume', v === '' ? '' : Math.round(v * 100));
  mtVal('mtAFadeIn', fadeIn);
  mtVal('mtAFadeOut', fadeOut);
  mtFadeMax(clips, 'mtAFadeIn', 'mtAFadeOut');
  mtSum('mtSumSound', v !== '' && v !== 1 ? Math.round(v * 100) + '%' : '');
  mtSum('mtSumAFade', mtFadeSum(fadeIn, fadeOut));
}
// число и ползунок одного ряда; разные значения у нескольких клипов: поле пустое, ползунок в начале
function mtVal(id, v) { $(id).value = v; $(id + 'R').value = v === '' ? +$(id + 'R').min || 0 : v; }
function mtBounds(id, a, b) { $(id).min = $(id + 'R').min = a; $(id).max = $(id + 'R').max = b; }
function mtFadeMax(clips, ...ids) { const m = mtRnd(Math.max(...clips.map(tkLen)), 2); ids.forEach(id => { $(id).max = $(id + 'R').max = m; }); }
const mtLive = () => { mvShow(); mtFramePanel(); mtSoundPanel(); };
// Ряд панели: ползунок и число двигают одно значение, Alt с мышью влево-вправо тоже (k: сколько единиц на пиксель).
// set меняет клипы без отмены; всё движение отменяется одним шагом.
const mtRows = new Map();
function mtRow(id, k, set) {
  const num = $(id), rng = $(id + 'R');
  let before = null;
  mtRows.set(id, {k, set});
  num.addEventListener('change', () => { if (num.value !== '' && Number.isFinite(+num.value)) tkDo(() => set(+num.value)); else mtPanel(); });
  num.addEventListener('keydown', e => { if (e.key === 'Enter') num.blur(); });
  rng.addEventListener('input', () => {
    if (before === null) before = tkState();
    set(+rng.value);
    mtLive();
  });
  rng.addEventListener('change', () => {
    rng.blur();
    if (before !== null) tkCommit(before);
    before = null;
  });
}
$('mtPanel').addEventListener('pointermove', e => $('mtPanel').classList.toggle('alt', e.altKey));
$('mtPanel').addEventListener('mousedown', e => { if (e.altKey && e.target.closest('.mt-row[data-n]')) e.preventDefault(); }, true);
$('mtPanel').addEventListener('pointerdown', e => {
  const row = e.altKey && e.button === 0 && e.target.closest('.mt-row[data-n]');
  const num = row && row.querySelector('input[type=number]'), r = num && mtRows.get(num.id);
  if (!r) return;
  e.preventDefault();
  e.stopPropagation();
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  const panel = $('mtPanel'), state = tkState(), x0 = e.clientX, v0 = +num.value || 0, lo = num.min === '' ? -Infinity : +num.min, hi = num.max === '' ? Infinity : +num.max;
  const move = ev => {
    if (ev.pointerId !== e.pointerId) return;
    r.set(Math.min(Math.max(mtRnd(v0 + (ev.clientX - x0) * r.k, 2), lo), hi));
    mtLive();
  };
  const up = ev => {
    if (ev.pointerId !== e.pointerId) return;
    panel.removeEventListener('pointermove', move);
    panel.removeEventListener('pointerup', up);
    panel.removeEventListener('pointercancel', up);
    tkCommit(state);
  };
  panel.setPointerCapture(e.pointerId);
  panel.addEventListener('pointermove', move);
  panel.addEventListener('pointerup', up);
  panel.addEventListener('pointercancel', up);
}, true);
const mtBoxRow = (id, k, fn) => mtRow(id, k, v => { const c = mtFrameOne(); if (c) fn(c, v, mvBox(c)); });
mtBoxRow('mtPosX', 2, (c, v, b) => mvSetBox(c, v / mvCanvasDims().w + .5 - b.w / 2, b.y, b.w, b.h));
mtBoxRow('mtPosY', 2, (c, v, b) => mvSetBox(c, b.x, v / mvCanvasDims().h + .5 - b.h / 2, b.w, b.h));
mtBoxRow('mtScale', .5, (c, v, b) => {
  const w = mvFitBox(c).w * Math.max(v, 1) / 100, h = b.h * w / b.w;
  mvSetBox(c, b.x + b.w / 2 - w / 2, b.y + b.h / 2 - h / 2, w, h);
});
mtBoxRow('mtRot', .5, (c, v) => mtPut(c, 'rot', mvRotNorm(v), 0));
const mtCropRow = (id, key, other) => mtBoxRow(id, .25, (c, v) => mtPut(c, key, mtRnd(Math.min(Math.max(v / 100, 0), MV_MAX_CROP - (c[other] || 0)), 4), 0));
mtCropRow('mtCropL', 'cl', 'cr');
mtCropRow('mtCropR', 'cr', 'cl');
mtCropRow('mtCropT', 'ct', 'cb');
mtCropRow('mtCropB', 'cb', 'ct');
const mtTurn = d => { const c = mtFrameOne(); if (c) tkDo(() => mtPut(c, 'rot', mvRotNorm((c.rot || 0) + d), 0)); };
$('mtTurnL').onclick = () => mtTurn(-90);
$('mtTurnR').onclick = () => mtTurn(90);
$('mtCropMouse').onclick = () => {
  const c = mtFrameOne();
  mv.crop = c && mv.crop !== c.id ? c.id : 0;
  mtFramePanel();
  mvFrameDraw();
};
$('mtFrameReset').onclick = () => {
  const c = mtFrameOne();
  if (c) tkDo(() => ['x', 'y', 'w', 'h', 'rot', 'cl', 'ct', 'cr', 'cb'].forEach(key => delete c[key]));
};
const mtFadeRow = (id, key, list) => mtRow(id, .02, v => list().forEach(c => mtPut(c, key, mtRnd(Math.min(Math.max(v, 0), tkLen(c)), 2), 0)));
mtFadeRow('mtFadeIn', 'fadeIn', mtFrameClips);
mtFadeRow('mtFadeOut', 'fadeOut', mtFrameClips);
mtFadeRow('mtAFadeIn', 'fadeIn', mtSoundClips);
mtFadeRow('mtAFadeOut', 'fadeOut', mtSoundClips);
// удаление фона: значения в панели в процентах, в клипе доли
const mtKeyRow = (id, key, lo) => mtRow(id, .5, v => mtFrameClips().forEach(c => { if (c.key) mtPut(c, key, mtRnd(Math.min(Math.max(v, lo), 100) / 100, 3), 0); }));
mtKeyRow('mtKeySim', 'keySim', 1);
mtKeyRow('mtKeyBlend', 'keyBlend', 0);
mtKeyRow('mtKeySpill', 'keySpill', 0);
$('mtKeyOn').addEventListener('change', e => {
  const on = e.target.checked;
  tkDo(() => mtFrameClips().forEach(c => {
    if (on) { if (!c.key) Object.assign(c, {key: '#00b140', keySim: .25, keyBlend: .08, keySpill: .5}); }
    else { delete c.key; delete c.keySim; delete c.keyBlend; delete c.keySpill; }
  }));
});
$('mtKeyColor').addEventListener('change', e => { const v = e.target.value; tkDo(() => mtFrameClips().forEach(c => { if (c.key) c.key = v; })); });
$('mtKeyPick').addEventListener('click', () => { chromaPickToggle(); mtFramePanel(); });
// цветокоррекция: в панели от -100 до 100, в клипе доли
MT_COLOR.forEach(([id, key]) => mtRow(id, .5, v => mtFrameClips().forEach(c => mtPut(c, key, mtRnd(Math.min(Math.max(v, -100), 100) / 100, 3), 0))));
$('mtColorReset').onclick = () => tkDo(() => mtFrameClips().forEach(c => MT_COLOR.forEach(x => delete c[x[1]])));
mtRow('mtVolume', .5,v => mtSoundClips().forEach(c => mtPut(c, 'vol', mtRnd(Math.min(Math.max(v, 0), 200) / 100, 3), 1)));

// ---------- логотип: картинка на новой верхней дорожке, на весь монтаж, в правом верхнем углу ----------
const MT_LOGO_W = .15, MT_LOGO_GAP = .03;
$('mtLogo').onclick = () => dialog(async () => {
  const r = await api('pick-files');
  if (r.error) { alert(r.error); return; }
  if (!r.files || !r.files.length) return;
  const f = r.files.find(x => IMAGES.test(base(x.path)));
  if (!f) { say('warn', t('mt.logoTitle'), t('mt.logoNotPic')); return; }
  mtAdd([f]);
  const it = mtFile(f.path);
  await it.reading;
  if (it.bad || !(it.w > 0)) { say('warn', t('mt.noDurTitle'), t('mt.noDur')); return; }
  const v = tkTracks.filter(x => x.kind === 'v'), top = v[v.length - 1], total = tkTotal(), d = mvCanvasDims();
  tkDo(() => {
    let row = top;
    if (top.clips.length) { row = {kind: 'v', thin: false, clips: []}; tkTracks.splice(v.length, 0, row); }
    const c = tkNewClip(it, 0);
    if (total > 0) c.len = total;
    const h = MT_LOGO_W * d.w / d.h * it.h / it.w;
    Object.assign(c, {x: 1 - MT_LOGO_W - MT_LOGO_GAP, y: MT_LOGO_GAP * d.w / d.h, w: MT_LOGO_W, h});
    row.clips.push(c);
    tkSel = new Set([c.id]);
  });
});

// ---------- субтитры из файла: они на весь монтаж, поэтому раздел виден и без выбранного клипа ----------
var mtSubsWait = '', mtSubsErr = '';   // var: mtPanel может позвать раньше, чем дойдёт до этой строки
// проект старой сборки хранит только путь: реплики прочитать из файла, дальше они живут в проекте
async function mtSubsLoad(path) {
  mtSubsWait = path;
  mtSubsErr = '';
  const r = await api('subs-read', {path});
  if (!tkSubs || tkSubs.path !== path || tkSubs.cues) return;
  if (r.error) mtSubsErr = r.error; else tkSubs.cues = r.cues || [];
  mtSubsFill();
  tkRender();
  mvSubsDraw();
}
function mtSubsFill() {
  const s = tkSubs;
  $('mtSubsBody').classList.toggle('hide', !s);
  $('mtSubsOff').classList.toggle('hide', !s);
  mtSum('mtSumSubs', s ? t(s.mode === 'track' ? 'mt.subsTrack' : 'mt.subsBurn') : '');
  $('mtSubsName').textContent = s ? base(s.path) : '';
  $('mtSubsName').title = s ? s.path : '';
  mtCuesFill();
  if (!s) { mtSubsWait = mtSubsErr = ''; $('mtSubsErr').classList.add('hide'); return; }
  if (!s.cues && s.path !== mtSubsWait) mtSubsLoad(s.path);
  $('mtSubsErr').textContent = mtSubsErr;
  $('mtSubsErr').classList.toggle('hide', !mtSubsErr);
  $('mtSubsMode').value = s.mode;
  mtFontPut($('mtSubsFont'), s.font);
  $('mtSubsPos').value = s.pos;
  mtVal('mtSubsSize', mtRnd(s.size * 100, 1));
  $('mtSubsColor').value = s.color || '#ffffff';
  $('mtSubsBackOn').checked = !!s.back;
  $('mtSubsBackBody').classList.toggle('hide', !s.back);
  $('mtSubsBack').value = s.back || '#000000';
  mtVal('mtSubsBackA', Math.round((s.backA > 0 ? s.backA : .6) * 100));
  mtVal('mtSubsW', Math.round((s.w || .9) * 100));
  $('mtSubsLook').classList.toggle('hide', s.mode === 'track');
  $('mtSubsNote').classList.toggle('hide', s.mode !== 'track');
}
$('mtSubsPick').onclick = () => dialog(async () => {
  const r = await api('subs-pick');
  if (r.error) { say('err', t('mt.secSubs'), r.error); return; }
  if (!r.path) return;
  const c = await api('subs-read', {path: r.path});
  if (c.error) { say('warn', t('mt.secSubs'), c.error); return; }
  tkDo(() => { tkSubs = {mode: 'burn', font: 'Arial', size: .05, pos: 'bottom', ...(tkSubs || {}), path: r.path, cues: c.cues || []}; mtCueSel = null; });
});
$('mtSubsOff').onclick = () => tkDo(() => { tkSubs = null; });
// Автосубтитры: выбор модели и языка запоминается, сама работа идёт в программе (whisper.go), страница только следит за ходом
const mtAutoSizes = {tiny: 77691713, base: 147951465, small: 487601967};
['mtAutoModel', 'mtAutoLang'].forEach(id => {
  const v = storeGet('konv9000.' + id);
  if (v && [...$(id).options].some(o => o.value === v)) $(id).value = v;
  $(id).addEventListener('change', () => { storeSet('konv9000.' + id, $(id).value); $(id).blur(); });
});
function mtAutoShow(job) {
  $('mtAutoGo').classList.toggle('hide', job.active);
  $('mtAutoRun').classList.toggle('hide', !job.active);
  if (job.active) {
    const pct = Math.round(job.pct || 0), stage = job.stage || 'audio';
    $('mtAutoText').textContent = t({tool: 'mt.auto.getTool', model: 'mt.auto.getModel', audio: 'mt.auto.audio', speech: 'mt.auto.speech'}[stage]) + (stage === 'audio' ? '' : ` ${pct}%`);
    $('mtAutoBar').style.width = (stage === 'audio' ? 0 : pct) + '%';
  }
}
async function mtAutoWatch() {
  const job = await api('whisper-state');
  mtAutoShow(job);
  if (job.active) { setTimeout(mtAutoWatch, 400); return; }
  if (job.err) { say('err', t('mt.auto.title'), job.err); return; }
  if (!job.path) return;   // отменили
  const c = await api('subs-read', {path: job.path});
  if (c.error) { say('warn', t('mt.auto.title'), c.error); return; }
  tkDo(() => { tkSubs = {mode: 'burn', font: 'Arial', size: .05, pos: 'bottom', ...(tkSubs || {}), path: job.path, cues: c.cues || []}; mtCueSel = null; });
  document.querySelector('details[data-sec=subs]').open = true;
  toast({id: 'auto', type: 'ok', title: t('mt.auto.done'), text: esc(base(job.path)), ttl: 6000});
}
$('mtAutoGo').onclick = () => dialog(async () => {
  if (!tkLive().length) { say('warn', t('start.emptyTitle'), t('mt.empty')); return; }
  mvPause();
  const model = $('mtAutoModel').value, info = await api('whisper-info');
  const need = (info.tool ? 0 : info.toolSize) + (info.models && info.models[model] ? 0 : mtAutoSizes[model]);
  if (need > 0 && !confirm(t('mt.auto.ask', {size: fmtSize(need)}))) return;
  const r = await api('whisper-start', {project: mtProject().project, model, lang: $('mtAutoLang').value});
  if (r.error) { say('err', t('mt.auto.title'), r.error); return; }
  mtAutoWatch();
});
$('mtAutoStop').onclick = () => api('whisper-cancel');
[['mtSubsMode', 'mode'], ['mtSubsFont', 'font'], ['mtSubsPos', 'pos']].forEach(([id, key]) => $(id).addEventListener('change', () => {
  const v = $(id).value;
  $(id).blur();
  // выбор положения из списка снимает то, что перетащили мышью
  if (tkSubs) tkDo(() => { tkSubs = {...tkSubs, [key]: v}; if (key === 'pos') { delete tkSubs.x; delete tkSubs.y; } });
}));
$('mtSubsColor').addEventListener('change', () => { if (tkSubs) tkDo(() => { tkSubs = {...tkSubs, color: $('mtSubsColor').value}; }); });
$('mtSubsBack').addEventListener('change', () => { if (tkSubs) tkDo(() => { tkSubs = {...tkSubs, back: $('mtSubsBack').value}; }); });
$('mtSubsBackOn').addEventListener('change', () => {
  $('mtSubsBackOn').blur();
  if (tkSubs) tkDo(() => { tkSubs = {...tkSubs}; if ($('mtSubsBackOn').checked) tkSubs.back = $('mtSubsBack').value; else delete tkSubs.back; });
});
const mtSubsLive = patch => { if (tkSubs) { tkSubs = {...tkSubs, ...patch}; mtSubsFill(); mvSubsDraw(); } };
mtRow('mtSubsBackA', .5, v => mtSubsLive({backA: mtRnd(Math.min(Math.max(v, 5), 100) / 100, 2)}));
mtRow('mtSubsW', .25, v => { const w = mtRnd(Math.min(Math.max(v, 10), 100) / 100, 3), x = tkSubs ? tkSubs.x || .5 : .5; mtSubsLive({w, ...(tkSubs && tkSubs.x ? {x: Math.min(Math.max(x, w / 2), 1 - w / 2)} : {})}); });
mtRow('mtSubsSize', .05, v => { if (tkSubs) { tkSubs = {...tkSubs, size: mtRnd(Math.min(Math.max(v, 1), 20) / 100, 4)}; mtSubsFill(); mvSubsDraw(); } });

// строка в панели: сколько получится и что программа сделает сама
function mtInfo() {
  const parts = [], total = tkLive().length, [a, b] = mtRange();
  if (total > 0) parts.push(t('mt.total', {dur: fmtTc(Math.max(b - a, 0))}));
  const marks = tkIn !== null || tkOut !== null;
  $('mtRange').classList.toggle('hide', !marks);
  if (marks) $('mtRangeText').textContent = t('mt.range', {a: fmtTc(a), b: fmtTc(b), dur: fmtTc(Math.max(b - a, 0))});
  const seen = tkTracks.filter(x => x.kind === 'v' && !x.off).flatMap(x => x.clips).map(c => mtFile(c.path)).filter(it => it && it.w);
  if (!tkCanvas && seen.some(it => it.w !== seen[0].w || it.h !== seen[0].h)) parts.push(t('mt.sizes', {size: `${seen[0].w}×${seen[0].h}`}));
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
  const n = mtRepeat() - 1, fresh = new Map();
  // у каждого повтора связанной пары своя связь
  const linkOf = (c, i) => { const k = `${c.link}|${i}`; if (!fresh.has(k)) fresh.set(k, tkNext++); return fresh.get(k); };
  tkDo(() => tkSelected().forEach(c => {
    const tr = tkTrackOf(c);
    tr.clips.sort((a, b) => a.at - b.at);
    let at = tr.clips.indexOf(c);
    for (let i = 1; i <= n; i++) tr.clips.splice(++at, 0, Object.assign({}, c, {id: tkNext++, at: c.at + i * tkLen(c)}, c.link ? {link: linkOf(c, i)} : {}));
    tkCascade(tr);
  }));
};
$('mtTrim').onclick = () => {
  const c = tkOne();
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
    const da = a - c.from, db = b - (c.from + c.len);   // связанный клип обрезается на те же сдвиги
    if (Math.abs(da) > 1e-3 || Math.abs(db) > 1e-3) tkDo(() => tkGroup(c).forEach(m => {
      m.from = Math.max(m.from + da, 0);
      m.len = Math.min(Math.max(m.len - da + db, m.speed / tkFps()), m.src - m.from);
      tkPush(tkTrackOf(m));
    }));
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
  mtTextRefresh();
  tkFit();
}
function mtProjectIncoming(path) { setTab('mont'); mtProjectOpen(path); }
$('mtOpenProject').onclick = () => dialog(() => mtProjectOpen());
$('mtSaveProject').onclick = () => dialog(() => mtProjectSave(false));

// ---------- в конвертер ----------
const mtClipOut = (c, at) => ({path: c.path, at, from: c.from, len: c.len, speed: c.speed, reverse: c.reverse, ...(c.part ? {part: c.part} : {}), ...(c.w > 0 ? {x: c.x || 0, y: c.y || 0, w: c.w, h: c.h} : {}),
  ...Object.fromEntries(['rot', 'cl', 'ct', 'cr', 'cb', 'vol', 'fadeIn', 'fadeOut', 'key', 'keySim', 'keyBlend', 'keySpill', ...MT_COLOR.map(x => x[1])].filter(key => c[key] !== undefined).map(key => [key, c[key]]))});
// область вывода: от метки до метки, без меток весь монтаж
const mtRange = () => { const end = tkLive().reduce((a, c) => Math.max(a, tkEnd(c)), 0), a = tkIn !== null ? Math.min(tkIn, end) : 0; return [a, tkOut !== null ? Math.min(tkOut, end) : end]; };
const mtInRange = c => { const [a, b] = mtRange(); return c.at < b - 1e-4 && tkEnd(c) > a + 1e-4; };
function mtProject() {
  const tracks = tkTracks.filter(x => x.clips.length && !x.off).map(x => ({clips: x.clips.map(c => mtClipOut(c, c.at))}));
  const [a, b] = mtRange();
  const project = {...(tkCanvas || {}), tracks, in: tkIn || 0, out: tkOut || 0, ...(tkSubs ? {subs: tkSubs} : {})};
  return {project, dur: Math.max(b - a, 0), paths: tkLive().filter(mtInRange).sort((x, y) => x.at - y.at).map(c => c.path)};
}
const mtListOf = paths => [...new Map(paths.map(p => [mtKey(p), mtFile(p) || {path: p}])).values()];
$('mtSend').onclick = () => {
  const all = tkLive();
  if (!all.length) { say('warn', t('start.emptyTitle'), t('mt.empty')); return; }
  const bad = all.map(c => mtFile(c.path)).filter(it => it && it.bad);
  if (bad.length) { say('warn', t('mt.badTitle'), [...new Set(bad.map(it => it.name))].join(', ')); return; }
  const inside = all.filter(mtInRange);
  if (!inside.length) { say('warn', t('start.emptyTitle'), t('mt.rangeEmpty')); return; }
  mvPause();
  if ($('mtEach').checked) {
    const [a, b] = mtRange(), seen = new Set();
    [...inside].sort((x, y) => x.at - y.at).forEach(c => {
      if (c.link && seen.has(c.link)) return;
      seen.add(c.link);
      // клип отдельным файлом, связанная пара одним файлом; остаётся только то, что попало между метками
      const group = c.link ? inside.filter(o => o.link === c.link) : [c];
      const lo = Math.max(a, Math.min(...group.map(o => o.at))), hi = Math.min(b, Math.max(...group.map(tkEnd)));
      addMontage({...(tkCanvas || {}), tracks: group.map(o => ({clips: [mtClipOut(o, o.at)]})), in: lo, out: hi, ...(tkSubs ? {subs: tkSubs} : {})}, mtListOf(group.map(o => o.path)), hi - lo);
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
setTimeout(mtTextRefresh);   // когда все скрипты уже загружены
