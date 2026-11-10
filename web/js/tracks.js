// ---------- дорожки монтажа: клипы, инструменты, масштаб, прилипание, отмена, хоткеи. Рендер: timeline.go ----------
// Клип: {id, path, at, from, len, speed, reverse, src, x, y, w, h, part, link, marks}. at — секунда на дорожке, from и len — кусок файла, src — длина файла (у фото 0),
// x, y, w, h — рамка слоя в долях кадра, без w слой вписан в кадр по центру. rot — поворот, градусы. op — непрозрачность 0…1, без значения 1. cl, ct, cr, cb — кадрирование, доли слоя.
// vol — громкость, 1 как в файле; fadeIn, fadeOut — плавность, секунды на дорожке. Без значения: как в файле и без плавности.
// part: что клип берёт из файла, 'v' картинку, 'a' звук, без него всё сразу (фото, файлы без звука, старые проекты).
// link: общий номер у связанных клипов, они двигаются и режутся вместе. marks: метки на клипе, секунды файла, поэтому держатся за кадр.
// tkTracks идёт снизу вверх, как ждёт движок: сначала видео, потом звук. На экране видео показано верхней дорожкой вверх.
const TK_HEAD = 124, TK_PHOTO = 5, TK_UNDO = 100, TK_EPS = 1e-3, TK_MIN_PPS = 1, TK_MAX_PPS = 512, TK_GRAB = 10, TK_ROW_MIN = 20, TK_ROW_MAX = 160;
const TK_SAVE_KEY = 'konv9000.mtProject';
// Переходы на краю клипа: trIn — из соседа слева вплотную (стык) или из пустоты, trOut — в пустоту; {k: вид, d: секунды}.
// Виды как tlTransKinds в transitions.go: только те, что просмотр повторяет на CSS (mvtrans.js)
const TK_TRANS = ['fade', 'fadeblack', 'fadewhite', 'wipeleft', 'wiperight', 'wipeup', 'wipedown', 'slideleft', 'slideright', 'slideup', 'slidedown', 'circleopen', 'circleclose', 'zoomin'];
const TK_TRANS_MAX = 10;   // секунд, как tlMaxTrans
const tkFresh = () => ['v', 'v', 'a', 'a'].map(kind => ({kind, thin: false, clips: []}));
let tkTracks = tkFresh(), tkSel = new Set(), tkAt = 0, tkPps = 40, tkTool = 'select', tkSnapOn = true, tkNext = 1;
let tkUndoList = [], tkRedoList = [], tkBoard = [], tkPath = '', tkSaveTimer = 0;
let tkIn = null, tkOut = null;   // метки начала и конца вывода, секунды; null — метки нет
let tkMarkers = [];              // метки на таймлайне, секунды, по возрастанию
let tkCanvas = null;             // размер холста {w, h}; null — как у первого видео
let tkGuides = {x: [], y: []};    // направляющие вьюпорта, доли кадра: x — вертикальные линии, y — горизонтальные
let tkSubs = null;               // субтитры {path, mode, font, size, pos}; null — нет
const tkEls = new Map();   // id клипа → его элемент: при перерисовке картинки в клипах не мигают

const tkClips = () => tkTracks.flatMap(x => x.clips);
const tkLen = c => c.len / c.speed;
const tkEnd = c => c.at + tkLen(c);
const tkTotal = () => tkClips().reduce((a, c) => Math.max(a, tkEnd(c)), 0);
// что идёт в результат: выключенная дорожка не видна и не звучит ни во вьюпорте, ни в готовом файле
const tkLive = () => tkTracks.filter(x => !x.off).flatMap(x => x.clips);
const tkById = id => tkClips().find(c => c.id === id);
const tkTrackOf = c => tkTracks.find(x => x.clips.includes(c));
const MT_TEXT_DEF = {s: '', font: 'Arial', size: .08, color: '#ffffff', bold: false, italic: false, align: 'center', stroke: 0, strokeColor: '#000000'};   // клип «Текст», textclip.js; нужно уже при загрузке проекта
const tkPhoto = c => !c.src;
// у клипов «Текст» и «Фигура» в пути только служебное имя
const tkClipName = c => c.text ? c.text.s.replace(/\s+/g, ' ') : c.shape ? tkShapeName(c.shape) : base(c.path);
const tkShapeName = x => t(x.k === 'rect' ? 'mt.shape.rect' : x.k === 'ell' ? 'mt.shape.ell' : x.pts.length > 2 || x.closed ? 'mt.shape.path' : x.a0 || x.a1 ? 'mt.shape.arrow' : 'mt.shape.line');
// Фигура из файла: клип «Фигура», shapes.js. Нужно уже при загрузке проекта.
function tkShapeLoad(x) {
  if (!x || !['rect', 'ell', 'path'].includes(x.k)) return null;
  const col = cpValidG, n = (v, hi) => Number.isFinite(v) ? Math.min(Math.max(v, 0), hi) : 0;
  const pts = x.k === 'path' && Array.isArray(x.pts) ? x.pts.filter(p => Array.isArray(p) && p.length === 6 && p.every(Number.isFinite)).map(p => p.map(v => Math.min(Math.max(v, -1e3), 1e3))) : null;
  if (x.k === 'path' && !(pts && pts.length >= 2)) return null;
  const on = x.on && x.on.d > 0 && Number.isFinite(x.on.d) ? {on: {d: Math.min(x.on.d, 60), e: ['', 'in', 'out', 'inout'].includes(x.on.e) ? x.on.e : 'inout'}} : {};
  return {k: x.k, fill: col(x.fill, '#ffffff'), fillOn: !!x.fillOn, stroke: col(x.stroke, '#ffffff'), sw: n(x.sw, .2), r: n(x.r, 1), pts, closed: x.k === 'path' && !!x.closed, a0: !!x.a0, a1: !!x.a1, dash: !!x.dash, ...on};
}
const tkShown = () => [...tkTracks.filter(x => x.kind === 'v').reverse(), ...tkTracks.filter(x => x.kind === 'a')];
const tkRowH = tr => tr.thin ? TK_ROW_MIN : tr.h || 58;
const tkSmall = tr => tkRowH(tr) < 32;   // в низкой дорожке кадров и волны не разобрать
const tkFirstOf = kind => tkTracks.find(x => x.kind === kind);
const tkSelected = () => tkClips().filter(c => tkSel.has(c.id));
const tkGroup = c => c.link ? tkClips().filter(o => o.link === c.link) : [c];
const tkIds = c => tkGroup(c).map(o => o.id);
// Выбран один клип или одна связанная пара: вернёт клип, у пары картинку. Иначе null.
function tkOne() {
  const list = tkSelected();
  return list.length && (list.length === 1 || list.every(c => c.link && c.link === list[0].link)) ? list[0] : null;
}
// частота как у движка: самый ранний видеоклип самой нижней дорожки, где такой есть (tlCanvas)
function tkFps() {
  for (const tr of tkTracks) {
    if (tr.kind !== 'v' || tr.off) continue;
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
const tkState = () => JSON.stringify({tracks: kfTracks(), in: tkIn, out: tkOut, markers: tkMarkers, canvas: tkCanvas, subs: tkSubs, guides: tkGuides, files: mtFiles.map(f => ({path: f.path, size: f.size}))});
// связь из одного клипа ничего не значит: второй удалён или разрезан отдельно
function tkTidyLinks() {
  const n = new Map();
  for (const c of tkClips()) if (c.link) n.set(c.link, (n.get(c.link) || 0) + 1);
  for (const c of tkClips()) if (c.link && n.get(c.link) < 2) delete c.link;
}
function tkCommit(before) {
  tkTidyLinks();
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
  mtTextRefresh();
}
// вернуть состояние без шага отмены (окно цвета, «Отмена»)
function tkRestore(s) {
  if (s === tkState()) return;
  tkApply(JSON.parse(s));
  tkChanged();
  mtTextRefresh();
}
function tkApply(o) {
  tkTracks = o.tracks;
  tkIn = o.in; tkOut = o.out; tkMarkers = o.markers || []; tkCanvas = o.canvas || null; tkSubs = o.subs || null; tkGuides = o.guides || {x: [], y: []};
  tkNext = tkClips().reduce((a, c) => Math.max(a, c.id + 1, (c.link || 0) + 1), tkNext);
  mtSetFiles(o.files || []);
}
const tkFile = () => ({app: 'konvertor9000', v: 1, tracks: kfTracks(), in: tkIn, out: tkOut, markers: tkMarkers, canvas: tkCanvas, subs: tkSubs, guides: tkGuides, files: mtFiles.map(f => ({path: f.path, size: f.size})), at: tkAt, pps: tkPps, snap: tkSnapOn});
function tkAutosave() { storeSet(TK_SAVE_KEY, JSON.stringify(Object.assign(tkFile(), {path: tkPath, dirty: tkDirty()}))); }
// Есть ли несохранённые изменения. Размер файла не считается: он приходит позже, когда файл прочитан.
const tkWork = () => JSON.stringify({tracks: kfTracks(), in: tkIn, out: tkOut, markers: tkMarkers, canvas: tkCanvas, subs: tkSubs, guides: tkGuides, files: mtFiles.map(f => f.path)});
let tkSavedWork = '';
function tkMarkSaved() { tkSavedWork = tkWork(); }
const tkDirty = () => !!(tkClips().length || mtFiles.length || tkSubs) && tkWork() !== tkSavedWork;
// Проект из файла или автосохранения. Файл могли править руками, поэтому каждое значение проверяется.
function tkLoad(o, path) {
  if (!o || !Array.isArray(o.tracks)) return false;
  const num = (x, d) => Number.isFinite(x) && x >= 0 ? x : d;
  tkNext = 1;
  // номера связей из файла заменяются своими: они не должны совпасть с теми, что позже выдаст tkNext
  const links = new Map(), linkOf = x => { if (!links.has(x)) links.set(x, tkNext++); return links.get(x); };
  const times = list => (Array.isArray(list) ? list : []).filter(x => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  const share = (c, key) => c[key] > 0 && c[key] <= .98 ? {[key]: c[key]} : {};
  const more = (c, key) => c[key] > 0 && Number.isFinite(c[key]) ? {[key]: c[key]} : {};
  const grade = (c, key) => c[key] && Number.isFinite(c[key]) ? {[key]: Math.min(Math.max(c[key], -1), 1)} : {};
  const trans = (c, key) => { const t = c[key]; return t && TK_TRANS.includes(t.k) && t.d > 0 && Number.isFinite(t.d) ? {[key]: {k: t.k, d: Math.min(t.d, TK_TRANS_MAX)}} : {}; };
  const tracks = o.tracks.filter(x => x && (x.kind === 'v' || x.kind === 'a')).map(x => ({kind: x.kind, thin: !!x.thin,
    ...(x.h >= TK_ROW_MIN && x.h <= TK_ROW_MAX ? {h: x.h} : {}),
    ...(x.off ? {off: true} : {}),
    clips: (Array.isArray(x.clips) ? x.clips : []).filter(c => c && typeof c.path === 'string' && c.len > 0).map(c => ({
      id: tkNext++, path: c.path, at: num(c.at, 0), from: num(c.from, 0), len: c.len, speed: c.speed > 0 ? Math.min(Math.max(c.speed, .25), 8) : 1,
      reverse: !!c.reverse, src: num(c.src, 0),
      ...(c.w > 0 && c.h > 0 && Number.isFinite(c.x) && Number.isFinite(c.y) ? {x: c.x, y: c.y, w: Math.min(c.w, 4), h: Math.min(c.h, 4)} : {}),
      ...(Number.isFinite(c.rot) && c.rot ? {rot: c.rot % 360} : {}),
      ...(c.op >= 0 && c.op < 1 ? {op: c.op} : {}),
      ...share(c, 'cl'), ...share(c, 'ct'), ...share(c, 'cr'), ...share(c, 'cb'),
      ...(c.vol >= 0 && c.vol <= 2 && c.vol !== 1 ? {vol: c.vol} : {}),
      ...more(c, 'fadeIn'), ...more(c, 'fadeOut'), ...trans(c, 'trIn'), ...trans(c, 'trOut'),
      ...(/^#[0-9a-f]{6}$/i.test(c.key) ? {key: c.key, ...more(c, 'keySim'), ...more(c, 'keyBlend'), ...more(c, 'keySpill')} : {}),
      ...(['screen', 'plus-lighter', 'lighten', 'multiply', 'darken', 'overlay', 'hard-light', 'difference'].includes(c.blend) ? {blend: c.blend} : {}),
      ...more(c, 'blur'),
      ...(c.shA > 0 && c.shA <= 1 ? {shA: c.shA, ...more(c, 'shB'), shC: /^#[0-9a-f]{6}$/i.test(c.shC) ? c.shC : '#000000', ...(Number.isFinite(c.shX) && c.shX ? {shX: c.shX} : {}), ...(Number.isFinite(c.shY) && c.shY ? {shY: c.shY} : {})} : {}),
      ...grade(c, 'cBri'), ...grade(c, 'cCon'), ...grade(c, 'cMid'), ...grade(c, 'cSat'), ...grade(c, 'cTemp'), ...grade(c, 'cTint'),
      ...(c.part === 'v' || c.part === 'a' ? {part: c.part} : {}),
      ...(c.link ? {link: linkOf(c.link)} : {}),
      ...(times(c.marks).length ? {marks: times(c.marks)} : {}),
      ...kfLoad(c.kf), ...kfAnimLoad(c.anim),
      ...(c.text && typeof c.text.s === 'string' ? {text: {...MT_TEXT_DEF, ...c.text, color: cpValidG(c.text.color, MT_TEXT_DEF.color), strokeColor: cpValidG(c.text.strokeColor, MT_TEXT_DEF.strokeColor)}, ...more(c, 'nw')} : {}),
      ...(tkShapeLoad(c.shape) ? {shape: tkShapeLoad(c.shape), ...(typeof c.seq === 'string' && c.seqN > 0 && c.seqFps > 0 ? {seq: c.seq, seqN: c.seqN, seqFps: c.seqFps} : {})} : {}),
    }))}));
  if (!tracks.some(x => x.kind === 'v')) tracks.unshift({kind: 'v', thin: false, clips: []});
  if (!tracks.some(x => x.kind === 'a')) tracks.push({kind: 'a', thin: false, clips: []});
  tracks.sort((a, b) => (a.kind === 'v' ? 0 : 1) - (b.kind === 'v' ? 0 : 1));
  const paths = tracks.flatMap(x => x.clips).filter(c => !c.text && !c.shape).map(c => ({path: c.path}));   // картинка текста и фигуры в окно файлов не встаёт
  const files = (Array.isArray(o.files) ? o.files : []).filter(f => f && typeof f.path === 'string').concat(paths);
  tkTracks = tracks;
  mtSetFiles(files);
  tkAt = num(o.at, 0);
  tkIn = num(o.in, null);
  tkOut = num(o.out, null);
  if (tkOut !== null && tkOut <= (tkIn || 0)) tkOut = null;
  tkMarkers = times(o.markers);
  const guides = l => (Array.isArray(l) ? l : []).filter(v => Number.isFinite(v) && v > -2 && v < 3).slice(0, 200);
  tkGuides = {x: guides(o.guides && o.guides.x), y: guides(o.guides && o.guides.y)};
  tkCanvas = o.canvas && o.canvas.w >= 16 && o.canvas.h >= 16 && o.canvas.w <= 7680 && o.canvas.h <= 7680 ? {w: o.canvas.w & ~1, h: o.canvas.h & ~1} : null;
  const sub = o.subs;
  tkSubs = sub && typeof sub.path === 'string' && sub.path ? {path: sub.path,
    ...(Array.isArray(sub.cues) ? {cues: sub.cues.filter(c => c && Number.isFinite(c.a) && Number.isFinite(c.b) && c.b > c.a && c.a >= 0 && typeof c.t === 'string').sort((x, y) => x.a - y.a)} : {}),
    mode: ['track', 'both'].includes(sub.mode) ? sub.mode : 'burn',
    font: typeof sub.font === 'string' && sub.font ? sub.font : 'Arial', size: sub.size >= .01 && sub.size <= .2 ? sub.size : .05,
    pos: ['top', 'center'].includes(sub.pos) ? sub.pos : 'bottom',
    ...(/^#[0-9a-f]{6}$/i.test(sub.color) ? {color: sub.color} : {}),
    ...(/^#[0-9a-f]{6}$/i.test(sub.back) ? {back: sub.back} : {}),
    ...(sub.backA > 0 && sub.backA <= 1 ? {backA: sub.backA} : {}),
    ...(sub.w >= .1 && sub.w <= 1 ? {w: sub.w} : {}),
    ...(sub.x > 0 && sub.x < 1 ? {x: sub.x} : {}),
    ...(sub.y > 0 && sub.y <= 1 ? {y: sub.y} : {}),
    ...(sub.h > 0 && sub.h <= 1 ? {h: sub.h} : {}),
    ...(sub.join === true ? {join: true} : {}),
    ...([-1, 1, 2, 3].includes(sub.chunk) ? {chunk: sub.chunk} : {}),
    ...(sub.fx && typeof sub.fx === 'object' ? {fx: subFxLoad(sub.fx)} : {}),
    ...(sub.off === true ? {off: true} : {})} : null;
  tkTidyLinks();
  if (o.pps > 0) tkPps = Math.min(Math.max(o.pps, TK_MIN_PPS), TK_MAX_PPS);
  if (typeof o.snap === 'boolean') tkSnapOn = o.snap;
  tkPath = path || '';
  tkSel.clear(); tkUndoList = []; tkRedoList = [];
  tkMarkSaved();
  return true;
}

// ---------- отрисовка ----------
function tkThumb(c, sec) { return thumbUrl(c.path, tkPhoto(c) ? 0 : (sec / c.src).toFixed(4), 160); }
function tkPaint(el, c, tr) {
  const w = Math.max(tkLen(c) * tkPps, 2), it = mtFile(c.path);
  el.style.left = c.at * tkPps + 'px';
  el.style.width = w + 'px';
  el.className = `tk-clip ${tr.kind}${tkSel.has(c.id) ? ' sel' : ''}${c.link ? ' linked' : ''}${it && it.bad ? ' miss' : ''}`;
  el.title = c.path;
  const pics = !tkSmall(tr) && tr.kind === 'v', first = pics && w >= 44, last = pics && !tkPhoto(c) && w >= 120, wave = !tkSmall(tr) && tr.kind === 'a';
  const sig = [c.path, c.from, c.len, c.speed, c.reverse, first, last, wave, wave ? tkPps + '/' + tkRowH(tr) : 0].join('|');
  if (el.dataset.sig !== sig) tkPaintBody(el, c, sig, first, last, wave);
  tkPaintMarks(el, c);
  if (c.kf || el.querySelector('.tk-kfs')) kfPaintClip(el, c);
  tkTrPaint(el, c);   // плашки переходов (trpanel.js)
}
function tkPaintBody(el, c, sig, first, last, wave) {
  el.dataset.sig = sig;
  const a = c.reverse ? c.from + c.len : c.from, b = c.reverse ? c.from : c.from + Math.max(c.len - .05, 0);
  const tag = (c.speed !== 1 ? `${String(c.speed).replace('.', lang === 'ru' ? ',' : '.')}× ` : '') + (c.reverse ? '⇄ ' : '');
  el.innerHTML = (wave && c.src ? `<canvas class="tk-wave${c.reverse ? ' flip' : ''}"></canvas>` : '') +
    (first ? `<img class="tk-pic" src="${tkThumb(c, a)}" alt="" draggable="false" onerror="this.remove()">` : '') +
    `<span class="tk-name">${esc(tag)}${esc(tkClipName(c))}</span>` +
    (last ? `<img class="tk-pic end" src="${tkThumb(c, b)}" alt="" draggable="false" onerror="this.remove()">` : '') +
    '<i class="tk-edge l"></i><i class="tk-edge r"></i><div class="tk-mks"></div>';
  tkWaveDraw(el, c);
}
// Волна: настоящие пики звука (100 значений на секунду, makeWave в media.go), столбик на каждую точку экрана, поэтому чёткая на любом масштабе
const TK_WAVE_RATE = 100, TK_WAVE_MAX = 4096;
const tkWaves = new Map();   // путь файла → пики; null, пока они не готовы или звука нет
function tkWavePeaks(path) {
  if (tkWaves.has(path)) return tkWaves.get(path);
  tkWaves.set(path, null);
  fetch(`/wave?t=${TOKEN}&p=${encodeURIComponent(path)}`).then(r => r.ok ? r.arrayBuffer() : null).then(buf => {
    if (!buf) return;
    tkWaves.set(path, new Uint8Array(buf));
    for (const [id, el] of tkEls) { const c = tkById(id); if (c && c.path === path) tkWaveDraw(el, c); }
  }).catch(() => {});
  return null;
}
function tkWaveDraw(el, c) {
  const cv = el.querySelector('canvas.tk-wave'), peaks = cv && tkWavePeaks(c.path);
  if (!peaks) return;
  const dpr = devicePixelRatio || 1, W = Math.min(Math.ceil(Math.max(tkLen(c) * tkPps, 2) * dpr), TK_WAVE_MAX), H = Math.max(Math.round((tkRowH(tkTrackOf(c)) - 4) * dpr), 1);
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d'), a = c.from * TK_WAVE_RATE, step = c.len * TK_WAVE_RATE / W;
  g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--acc');
  for (let x = 0; x < W; x++) {
    const i0 = Math.floor(a + x * step), i1 = Math.max(i0 + 1, Math.floor(a + (x + 1) * step));
    let p = 0;
    for (let i = i0; i < i1 && i < peaks.length; i++) if (peaks[i] > p) p = peaks[i];
    const h = Math.max(p / 255 * H, 1);
    g.fillRect(x, (H - h) / 2, 1, h);
  }
}
// Какие метки клипа видны и где: кадр из обрезанного куска скрыт, но метка помнится и вернётся вместе с ним.
function tkClipMarks(c) {
  return (c.marks || []).filter(s => s >= c.from - TK_EPS && s <= c.from + c.len + TK_EPS)
    .map(s => ({s, x: (c.reverse ? c.from + c.len - s : s - c.from) / c.speed}));
}
function tkPaintMarks(el, c) {
  const box = el.querySelector('.tk-mks'), tip = t('tk.marker');
  const html = tkClipMarks(c).map(m => `<em class="tk-mk" data-s="${m.s}" title="${esc(tip)}" style="left:${m.x * tkPps}px"></em>`).join('');
  if (box && box.dataset.h !== html) { box.dataset.h = html; box.innerHTML = html; }
}
const tkSvg = d => `<svg viewBox="0 0 24 24">${d}</svg>`;
const TK_EYE = '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>', TK_SPK = '<path d="M3 9.5v5h4l5 4v-13l-5 4z"/>';
const TK_ICON = {
  vOn: tkSvg(TK_EYE), vOff: tkSvg(TK_EYE + '<path d="M4 4l16 16"/>'),
  aOn: tkSvg(TK_SPK + '<path d="M16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12"/>'), aOff: tkSvg(TK_SPK + '<path d="M16 9.5l5 5M21 9.5l-5 5"/>'),
  up: tkSvg('<path d="m6 15 6-6 6 6"/>'), down: tkSvg('<path d="m6 9 6 6 6-6"/>'), close: tkSvg('<path d="M6 6l12 12M18 6 6 18"/>'),
};
function tkRender() {
  tkTrPrep();   // переходы для плашек (trpanel.js)
  const box = $('tkLanes'), shown = tkShown(), one = {v: tkTracks.filter(x => x.kind === 'v').length, a: tkTracks.filter(x => x.kind === 'a').length};
  const sig = shown.map(x => x.kind + (x.thin ? 't' : '') + (x.off ? 'o' : '') + (x.clips.length ? 'u' : '')).join() + lang;
  if (box.dataset.sig !== sig) {
    box.dataset.sig = sig;
    $('tkInner').appendChild($('tkDrop'));   // метка места могла остаться в строке, которая сейчас пересоберётся
    let nv = one.v, na = 0;
    box.innerHTML = shown.map(x => {
      const label = x.kind === 'v' ? 'V' + nv-- : 'A' + ++na;
      const offTip = t(x.kind === 'v' ? (x.off ? 'tk.show' : 'tk.hide') : (x.off ? 'tk.unmute' : 'tk.mute'));
      return `<div class="tk-row ${x.kind}"><div class="tk-th"><i class="tk-rowh" title="${esc(t('tk.rowH'))}"></i><b>${label}</b><span class="tk-thline"></span>` +
        `<button class="tk-mini${x.off ? ' on' : ''}" data-a="off" title="${offTip}" aria-label="${offTip}">${TK_ICON[x.kind + (x.off ? 'Off' : 'On')]}</button>` +
        `<button class="tk-mini" data-a="thin" title="${t(x.thin ? 'tk.wide' : 'tk.thin')}" aria-label="${t(x.thin ? 'tk.wide' : 'tk.thin')}">${x.thin ? TK_ICON.down : TK_ICON.up}</button>` +
        (!x.clips.length && one[x.kind] > 1 ? `<button class="tk-mini" data-a="del" title="${t('tk.delTrack')}" aria-label="${t('tk.delTrack')}">${TK_ICON.close}</button>` : '<span class="tk-gap"></span>') +
        '</div><div class="tk-lane"></div></div>';
    }).join('');
  }
  [...box.children].forEach((row, i) => tkRowPaint(row, shown[i]));
  const lanes = box.querySelectorAll('.tk-lane'), seen = new Set();
  shown.forEach((tr, i) => tr.clips.forEach(c => {
    let el = tkEls.get(c.id);
    if (!el) { el = document.createElement('div'); el.dataset.id = c.id; tkEls.set(c.id, el); }
    tkPaint(el, c, tr);
    if (el.parentNode !== lanes[i]) lanes[i].appendChild(el);
    seen.add(c.id);
  }));
  for (const [id, el] of tkEls) if (!seen.has(id)) { el.remove(); tkEls.delete(id); }
  mtCueLane();
  tkSize(); tkDrawHead(); tkRuler(); tkBar();
}
function tkRowPaint(row, tr) {
  row.style.height = tkRowH(tr) + 'px';
  row.classList.toggle('thin', tkSmall(tr));
  row.classList.toggle('off', !!tr.off);
}
// Высота дорожки: тянется за нижний край её заголовка
function tkRowDrag(e, tr) {
  const row = e.target.closest('.tk-row'), y0 = e.clientY, h0 = tkRowH(tr);
  tkDrag(e, ev => {
    tr.thin = false;
    tr.h = Math.min(Math.max(Math.round(h0 + ev.clientY - y0), TK_ROW_MIN), TK_ROW_MAX);
    tkRowPaint(row, tr);
  }, () => tkChanged());
}
// Правый край таймлайна: за монтажом, линией кадра и метками ещё 10 секунд. Иначе то, что дальше, растягивает прокрутку за концом линейки.
const tkRightEnd = () => TK_HEAD + (Math.max(tkTotal(), tkAt, tkIn || 0, tkOut || 0, ...tkMarkers) + 10) * tkPps;
function tkSize() {
  // До края окна дотягивает min-width в стилях: ширина не зависит от полос прокрутки и не качает их
  $('tkInner').style.width = tkRightEnd() + 'px';
  const band = $('tkRange'), on = tkIn !== null || tkOut !== null;
  band.classList.toggle('hide', !on);
  if (on) {
    const a = tkIn !== null ? tkIn : 0, b = tkOut !== null ? tkOut : Math.max(tkTotal(), a);
    band.style.left = TK_HEAD + a * tkPps + 'px';
    band.style.width = (b - a) * tkPps + 'px';
    band.classList.toggle('l', tkIn !== null);
    band.classList.toggle('r', tkOut !== null);
  }
}
// Метки вывода: I ставит начало, O конец. Метка не даёт области вывернуться: начало за концом снимает конец, и наоборот.
function tkMark(side) {
  const x = tkRound(tkAt);
  tkDo(() => {
    if (side === 'in') {
      tkIn = x;
      if (tkOut !== null && tkOut <= x) tkOut = null;
    } else if (x > 0) {
      tkOut = x;
      if (tkIn !== null && tkIn >= x) tkIn = null;
    }
  });
}
function tkMarksOff() { if (tkIn !== null || tkOut !== null) tkDo(() => { tkIn = tkOut = null; }); }
// Метка (M): на выделенный клип, если линия кадра на нём, иначе на таймлайн. У связанной пары метка одна, на первом клипе.
function tkPutMarker() {
  const seen = new Set(), add = (list, x) => list.some(m => Math.abs(m - x) < TK_EPS) ? list : [...list, x].sort((a, b) => a - b);
  const list = tkSelected().filter(c => mvUnder(c, tkAt) && (!c.link || !seen.has(c.link) && seen.add(c.link)));
  tkDo(() => {
    if (list.length) list.forEach(c => { c.marks = add(c.marks || [], +mvSrc(c, tkAt).toFixed(3)); });
    else tkMarkers = add(tkMarkers, tkRound(tkAt));
  });
}
// Метка клипа мышью: только в пределах видимого куска
function tkClipMarkDrag(e, c, s0) {
  const before = tkState(), el = tkEls.get(c.id), rest = (c.marks || []).filter(m => m !== s0), pts = tkSnapPts(new Set([c.id]));
  tkDrag(e, ev => {
    let x = tkTimeAt(ev);
    x += tkSnapBy([x], pts);
    x = Math.min(Math.max(x, c.at), tkEnd(c));
    c.marks = [...rest, +mvSrc(c, x).toFixed(3)].sort((a, b) => a - b);
    tkPaintMarks(el, c);
  }, () => {
    $('tkSnapLine').classList.add('hide');
    tkCommit(before);
  });
}
// Какая метка под мышью на шкале. Решает расстояние, а не элемент: метка часто стоит ровно под линией кадра
// (I, O и M ставят её туда), и ручка линии её бы закрывала. При равенстве берётся метка, линию можно переставить нажатием рядом.
function tkMarkAt(e) {
  if (!e.target.closest('#tkRuler, #tkGrip')) return '';
  const x = tkTimeAt(e), all = [['in', tkIn], ['out', tkOut], ...tkMarkers.map((at, i) => ['k' + i, at])];
  let best = '', lim = TK_GRAB;
  for (const [m, at] of all) {
    if (at === null) continue;
    const d = Math.abs(at - x) * tkPps;
    if (d < lim || (d === lim && !best)) { lim = d; best = m; }
  }
  if (e.target.closest('#tkGrip') && Math.abs(tkAt - x) * tkPps < lim) return '';
  if (best) return best;
  const mid = e.target.closest('[data-m]');
  return mid ? mid.dataset.m : '';
}
// Метка на таймлайне мышью
function tkMarkerDrag(e, i) {
  const before = tkState(), x0 = tkMarkers[i], rest = tkMarkers.filter((m, j) => j !== i);
  const pts = tkSnapPts(new Set()).filter(p => p !== x0);
  tkDrag(e, ev => {
    const x = tkTimeAt(ev);
    tkMarkers = [...rest, tkRound(Math.max(x + tkSnapBy([x], pts), 0))].sort((a, b) => a - b);
    tkRuler();
  }, () => {
    $('tkSnapLine').classList.add('hide');
    tkMarkers = [...new Set(tkMarkers)];
    tkCommit(before);
  });
}
// Метки мышью на шкале: 'in' и 'out' двигают свою метку, 'mid' всю область, размер при этом не меняется.
function tkMarkDrag(e, which) {
  const before = tkState(), f = 1 / tkFps(), t0 = tkTimeAt(e);
  const a0 = tkIn !== null ? tkIn : 0, b0 = tkOut !== null ? tkOut : Math.max(tkTotal(), a0);
  // точка, на которой метка уже стоит, не прилипает: иначе первые пиксели мышь едет, а метка стоит на месте
  const pts = tkSnapPts(new Set()).filter(p => Math.abs(p - a0) > TK_EPS && Math.abs(p - b0) > TK_EPS);
  tkDrag(e, ev => {
    tkEdgeScroll(ev.clientX, .05);
    let x = tkTimeAt(ev);
    if (which === 'in') {
      x += tkSnapBy([x], pts);
      tkIn = tkRound(Math.max(tkOut !== null ? Math.min(x, tkOut - f) : x, 0));
    } else if (which === 'out') {
      x += tkSnapBy([x], pts);
      tkOut = tkRound(Math.max(x, (tkIn || 0) + f));
    } else {
      let d = x - t0;
      d += tkSnapBy([a0 + d, b0 + d], pts);
      d = Math.max(d, -a0);   // вправо не ограничено: за концом монтажа вывод всё равно обрежется (mtRange)
      tkIn = tkRound(a0 + d);
      tkOut = tkRound(b0 + d);
    }
    tkSize(); tkRuler(); mtInfo();
  }, () => {
    $('tkSnapLine').classList.add('hide');
    tkCommit(before);
  });
}
function tkBar() {
  $('tkToolV').classList.toggle('on', tkTool === 'select');
  $('tkToolC').classList.toggle('on', tkTool === 'razor');
  $('tkSnapBtn').classList.toggle('on', tkSnapOn);
  const sel = tkSelected(), linked = sel.some(c => c.link), tip = t(linked || !tkCanLink(sel) ? 'tk.unlink' : 'tk.link');
  $('tkLink').classList.toggle('on', linked);
  $('tkLink').disabled = !linked && !tkCanLink(sel) && !sel.some(tkCanSplitOff);
  $('tkLink').title = tip;
  $('tkLink').setAttribute('aria-label', tip);
  $('tkUndo').disabled = !tkUndoList.length;
  $('tkRedo').disabled = !tkRedoList.length;
  $('tkZoom').value = Math.log2(tkPps);
  $('tkScroll').classList.toggle('razor', tkTool === 'razor');
}
function tkDrawHead(follow) {
  const sc = $('tkScroll'), x = tkAt * tkPps;
  if (parseFloat($('tkInner').style.width) < tkRightEnd()) tkSize();
  $('tkHead').style.transform = `translateX(${TK_HEAD + x}px)`;
  $('tkGrip').style.transform = `translateX(${TK_HEAD + x}px)`;
  if (follow && (x < sc.scrollLeft || x > sc.scrollLeft + sc.clientWidth - TK_HEAD - 20)) sc.scrollLeft = Math.max(x - 40, 0);
  if (mv.file) return;   // сейчас показан файл, а не монтаж: время у него своё
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
  if (tkIn !== null || tkOut !== null) {
    const a = tkIn !== null ? tkIn : 0, b = tkOut !== null ? tkOut : Math.max(tkTotal(), a), w = (b - a) * tkPps;
    html += `<b class="${tkIn !== null ? 'l ' : ''}${tkOut !== null ? 'r' : ''}" style="left:${a * tkPps}px;width:${w}px">` +
      `<s class="mid" data-m="mid" title="${t('tk.markMove')}"><span></span></s>` +
      (tkIn !== null ? `<s class="in" data-m="in" title="${t('tk.markIn')}"></s>` : '') +
      (tkOut !== null ? `<s class="out" data-m="out" title="${t('tk.markOut')}"></s>` : '') + '</b>';
  }
  for (const m of tkMarkers) html += `<em style="left:${m * tkPps}px" title="${esc(t('tk.marker'))}"></em>`;
  if (tkRulerHtml !== html) { tkRulerHtml = html; $('tkRuler').innerHTML = html; }
  tkBars();
}
let tkRulerHtml = '';
// Три полоски посередине области. Считаются в пикселях экрана от целого пикселя: при масштабе Windows 125% и 150% и дробном положении области
// CSS округляет каждую полоску по-своему, и они выходят разной толщины.
function tkBars() {
  const mid = $('tkRuler').querySelector('s.mid');
  if (!mid) return;
  const bars = mid.firstElementChild, d = devicePixelRatio || 1, w = Math.max(Math.round(2 * d), 1), all = w * 7;
  const r = mid.getBoundingClientRect(), x0 = Math.round((r.left + r.width / 2) * d - all / 2) / d;
  bars.style.left = x0 - r.left + 'px';
  bars.style.width = all / d + 'px';
  bars.style.background = `repeating-linear-gradient(90deg,var(--acc) 0 ${w / d}px,transparent ${w / d}px ${3 * w / d}px)`;
}

// ---------- время и прилипание ----------
const tkTimeAt = e => Math.max((e.clientX - $('tkRuler').getBoundingClientRect().left) / tkPps, 0);
function tkRowAt(y) {
  const rows = $('tkLanes').querySelectorAll('.tk-lane');
  for (let i = 0; i < rows.length; i++) { const r = rows[i].getBoundingClientRect(); if (y >= r.top && y < r.bottom) return i; }
  return -1;
}
function tkSnapPts(skip) {
  const pts = [0, tkAt, ...tkMarkers];
  if (tkIn !== null) pts.push(tkIn);
  if (tkOut !== null) pts.push(tkOut);
  for (const c of tkClips()) if (!skip.has(c.id)) {
    pts.push(c.at, tkEnd(c), ...tkClipMarks(c).map(m => c.at + m.x));
    if (c.kf) for (const p of KF_PROPS) for (const k of kfList(c, p)) pts.push(c.at + k.t);   // ключи
    for (const side of ['i', 'o']) {   // края переходов других клипов
      const tr = c[tkTrKey(side)];
      if (tr) pts.push(...tkTrSpan(c, side, tr.d));
    }
  }
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
function tkSelChanged() { tkRender(); mtPanel(); mvFrameDraw(); mvSubsDraw(); }
function tkNewClip(it, at) {
  const photo = it.kind === 'p';
  return {id: tkNext++, path: it.path, at, from: 0, len: photo ? TK_PHOTO : it.dur, speed: 1, reverse: false, src: photo ? 0 : it.dur};
}
const tkFitsTrack = (it, tr) => (it.kind === 'a') === (tr.kind === 'a');
// Видео со звуком встаёт парой: картинка на tr, звук на первую звуковую дорожку, где это место свободно. Занято везде: новая дорожка, чтобы не разъехаться.
function tkPlace(it, tr, at) {
  const c = tkNewClip(it, 0);
  c.at = tkRound(tkSpot([{c, tr}], at));
  tr.clips.push(c);
  if (it.kind === 'v' && it.audio) tkAddSound(c, tkNext++);
  return c;
}
// Отделить звук клипа в свой клип на звуковой дорожке. link: номер связи, 0 — без связи.
function tkAddSound(c, link) {
  const a = Object.assign({}, c, {id: tkNext++, part: 'a'});
  ['marks', 'x', 'y', 'w', 'h', 'rot', 'op', 'cl', 'ct', 'cr', 'cb', 'kf', 'anim'].forEach(key => delete a[key]);
  c.part = 'v';
  if (link) c.link = a.link = link;
  let row = tkTracks.find(x => x.kind === 'a' && tkSpot([{c: a, tr: x}], 0) === 0);
  if (!row) { row = {kind: 'a', thin: false, clips: []}; tkTracks.push(row); }
  row.clips.push(a);
}
// Склеить можно картинку и звук; расклеить — любую пару. Клип целиком (из старого проекта) при расклейке получает отдельный звук.
const tkCanLink = list => list.some(c => tkTrackOf(c).kind === 'v') && list.some(c => tkTrackOf(c).kind === 'a');
const tkCanSplitOff = c => { const it = mtFile(c.path); return !c.part && !tkPhoto(c) && tkTrackOf(c).kind === 'v' && !!it && it.kind === 'v' && !!it.audio; };
function tkLinkToggle() {
  const list = tkSelected();
  if (!list.length) return;
  if (list.some(c => c.link)) tkDo(() => list.forEach(c => { delete c.link; }));
  else if (tkCanLink(list)) tkDo(() => { const id = tkNext++; list.forEach(c => { c.link = id; }); });
  else if (list.some(tkCanSplitOff)) tkDo(() => list.filter(tkCanSplitOff).forEach(c => tkAddSound(c, 0)));
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
  // метка остаётся у той части, где её кадр. У фото время считается от начала клипа
  const cut = mvSrc(c, x), marks = c.marks || [], early = marks.filter(m => m < cut), late = marks.filter(m => m >= cut);
  if (tkPhoto(c)) c.len = s;
  else if (c.reverse) { c.from = c.from + c.len - s; c.len = s; }
  else { right.from = c.from + s; c.len = s; }
  const setMarks = (o, list) => { if (list.length) o.marks = list; else delete o.marks; };
  setMarks(c, c.reverse ? late : early);
  setMarks(right, tkPhoto(c) ? late.map(m => +(m - cut).toFixed(3)) : c.reverse ? early : late);
  kfSplit(right, cut);
  if (c.anim) { const {i, o} = c.anim; if (i) c.anim = {i}; else delete c.anim; if (o) right.anim = {o}; else delete right.anim; }   // появление у левой части, исчезание у правой
  delete c.fadeOut; delete right.fadeIn;   // на месте разреза плавности нет: появление остаётся у начала, исчезание у конца
  delete c.trOut; delete right.trIn;       // и перехода нет: из соседа слева он остаётся у левой части, в пустоту у правой
  tr.clips.splice(tr.clips.indexOf(c) + 1, 0, right);
  return right;
}
// Разрезать несколько клипов в момент x. Правые части связанной пары получают свою общую связь.
function tkSplitAll(list, x) {
  const fresh = new Map();
  for (const c of list) {
    const right = tkSplit(c, x, tkTrackOf(c));
    if (!right || !c.link) continue;
    if (!fresh.has(c.link)) fresh.set(c.link, tkNext++);
    right.link = fresh.get(c.link);
  }
}
function tkCutHere() {
  const hit = c => tkAt > c.at && tkAt < tkEnd(c);
  const list = (tkSel.size ? tkSelected() : tkClips()).filter(hit);
  if (list.length) tkDo(() => tkSplitAll(list, tkAt));
}
function tkDrop(ripple) {
  for (const tr of tkTracks) {
    const gone = tr.clips.filter(c => tkSel.has(c.id)).sort((a, b) => b.at - a.at);
    tr.clips = tr.clips.filter(c => !tkSel.has(c.id));
    if (ripple) for (const g of gone) for (const c of tr.clips) if (c.at >= tkEnd(g) - TK_EPS) c.at -= tkLen(g);
  }
  tkSel.clear();
}
function tkRemove(ripple) {
  if (tkSel.size) tkDo(() => tkDrop(ripple));
}
// Delete: всё, что выбрано, и клипы, и реплики, одним шагом отмены
function tkDeleteSel() {
  if (kfPickDrop()) return;   // выбран ромбик ключа: удаляются ключи в этом месте, а не клип
  if (tkTrSel && tkTrRemove()) return;   // выбран переход: удаляется он (trpanel.js)
  if (!tkSel.size && mtCueSel === null && !mtCueMany.size) return;
  const cues = mtCueSel !== null || mtCueMany.size;   // без выбранной реплики нельзя: mtCueDrop взял бы ту, что под линией кадра
  tkDo(() => { tkDrop(false); if (cues) mtCueDrop(); });
}
function tkCopy() {
  tkBoard = tkSelected().map(c => Object.assign({}, c, {track: tkTracks.indexOf(tkTrackOf(c))}));
}
// вставить копии так, чтобы самая ранняя начиналась в at; занято — ближайшее свободное место правее
function tkInsert(list, at) {
  if (!list.length) return;
  tkDo(() => {
    const first = Math.min(...list.map(c => c.at)), fresh = new Map();
    const items = list.map(s => {
      const c = Object.assign({}, s, {id: tkNext++, at: s.at - first + at});
      delete c.track;
      if (c.link) {
        if (!fresh.has(c.link)) fresh.set(c.link, tkNext++);
        c.link = fresh.get(c.link);
      }
      const own = tkTracks[s.track];
      return {c, tr: own && own.kind === tkBoardKind(s) ? own : tkFirstOf(tkBoardKind(s))};
    });
    const d = tkSpot(items, 0, true);
    items.forEach(x => { x.c.at = tkRound(x.c.at + d); x.tr.clips.push(x.c); });
    tkSel = new Set(items.map(x => x.c.id));
  });
}
const tkBoardKind = s => { if (s.part) return s.part; const it = mtFile(s.path); return it && it.kind ? (it.kind === 'a' ? 'a' : 'v') : (tkTracks[s.track] || {}).kind || 'v'; };
function tkDuplicate() {
  tkCopy();
  if (tkBoard.length) tkInsert(tkBoard, Math.max(...tkSelected().map(tkEnd)));
}
function tkSetTool(x) { tkTool = x; if (x !== 'razor') $('tkCutLine').classList.add('hide'); tkBar(); }
function tkEdge(dir) {
  // ключевые кадры выделенных клипов тоже точки остановки (keyframes.js)
  const keys = c => KF_PROPS.flatMap(p => kfList(c, p).map(k => k.t)).filter(x => x >= -1e-6 && x <= tkLen(c) + 1e-6).map(x => c.at + x);
  const pts = [0, ...tkMarkers, ...tkClips().flatMap(c => [c.at, tkEnd(c), ...tkClipMarks(c).map(m => c.at + m.x)]), ...tkSelected().flatMap(keys)].map(x => +x.toFixed(4));
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
  e.preventDefault();
  try { $('tkScroll').setPointerCapture(e.pointerId); } catch (err) {}
  // Слушает окно, а не дорожки: удержание не теряется, даже если захват мыши сорвётся или она уйдёт с дорожек
  const onMove = ev => {
    if (ev.pointerId !== e.pointerId) return;
    if (!ev.buttons) { onUp(ev); return; }   // кнопку отпустили там, откуда событие не дошло
    move(ev);
  };
  const onUp = ev => {
    if (ev.pointerId !== e.pointerId) return;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    up(ev);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}
function tkEdgeScroll(x, dt) {
  const sc = $('tkScroll'), r = sc.getBoundingClientRect(), zone = 40;
  const v = x < r.left + TK_HEAD + zone ? x - (r.left + TK_HEAD + zone) : x > r.right - zone ? x - (r.right - zone) : 0;
  if (!v) return false;
  sc.scrollLeft += v * 14 * dt;
  return true;
}
// Перенос клипов: выделенные идут точно за мышью, раскладку трогает только итог.
function tkMoveDrag(e, grab, wasSel) {
  const moving = tkSelected(), ids = new Set(moving.map(c => c.id)), shown = tkShown();
  const rowOf = c => shown.indexOf(tkTrackOf(c));
  const fromRow = new Map(moving.map(c => [c, rowOf(c)]));
  const row0 = fromRow.get(grab), t0 = tkTimeAt(e), x0 = e.clientX, y0 = e.clientY, minAt = Math.min(...moving.map(c => c.at));
  const pts = tkSnapPts(ids), lanes = $('tkLanes').querySelectorAll('.tk-lane');
  // между дорожками идут только клипы того же вида, что и взятый: звук пары остаётся на своей, когда картинку уносят выше
  const kind0 = shown[row0].kind, rowTo = (c, d) => shown[fromRow.get(c)].kind === kind0 ? fromRow.get(c) + d : fromRow.get(c);
  const fits = d => moving.every(c => { const to = shown[rowTo(c, d)]; return to && to.kind === shown[fromRow.get(c)].kind; });
  const dyOf = (c, d) => lanes[rowTo(c, d)].getBoundingClientRect().top - lanes[fromRow.get(c)].getBoundingClientRect().top;
  let on = false, grips = [], dt = 0, dr = 0, px = x0, py = y0;
  const aim = () => {
    let d = Math.max(tkTimeAt({clientX: px}) - t0, -minAt);
    d += tkSnapBy(moving.flatMap(c => [c.at + d, tkEnd(c) + d]), pts);
    dt = Math.max(d, -minAt);
    const r = tkRowAt(py);
    if (r >= 0 && fits(r - row0)) dr = r - row0;
    // линейка растёт вместе с клипом, который уносят за её конец
    $('tkInner').style.width = Math.max(tkRightEnd(), TK_HEAD + (Math.max(...moving.map(tkEnd)) + dt + 10) * tkPps) + 'px';
    grips.forEach(g => g.k.aim(dt * tkPps, dyOf(g.c, dr)));
  };
  const lift = () => {
    on = true;
    grips = moving.map((c, i) => {
      const el = tkEls.get(c.id);
      el.classList.add('tk-lift');
      return {c, el, k: kinFollow(el, {still: true, onFrame: i ? undefined : dt_ => { if (tkEdgeScroll(px, dt_)) aim(); }})};
    });
  };
  tkDrag(e, ev => {
    px = ev.clientX; py = ev.clientY;
    if (!on && Math.hypot(px - x0, py - y0) >= KIN.drag) lift();
    if (on) aim();
  }, () => {
    $('tkSnapLine').classList.add('hide');
    if (!on) {
      if (wasSel && tkSel.size > tkIds(grab).length) { tkSel = new Set(tkIds(grab)); tkSelChanged(); }
      return;
    }
    const d = tkSpot(moving.map(c => ({c, tr: shown[rowTo(c, dr)]})), dt);
    let left = grips.length;
    const finish = () => {
      if (--left) return;
      grips.forEach(g => { g.el.classList.remove('tk-lift'); g.el.style.transform = ''; });
      tkDo(() => moving.forEach(c => {
        const from = shown[fromRow.get(c)], to = shown[rowTo(c, dr)];
        c.at = tkRound(c.at + d);
        if (to !== from) { from.clips = from.clips.filter(x => x !== c); to.clips.push(c); }
      }));
    };
    grips.forEach(g => g.k.land(d * tkPps, dyOf(g.c, dr), finish));
  });
}
// Край клипа: левый двигает начало на дорожке и в файле, правый только конец. За длину файла и в соседа не уйти.
// Связанные клипы обрезаются на один и тот же сдвиг, с Alt только взятый. Сдвиг ограничен самым тесным из них.
function tkTrimDrag(e, grab, side, alone) {
  const before = tkState(), min = 1 / tkFps(), list = alone ? [grab] : tkGroup(grab);
  const items = list.map(c => {
    const o = Object.assign({}, c), oEnd = tkEnd(c), near = tkTrackOf(c).clips.filter(x => x !== c);
    const prev = near.filter(x => tkEnd(x) <= c.at + TK_EPS).reduce((a, x) => Math.max(a, tkEnd(x)), 0);
    const next = near.filter(x => x.at >= oEnd - TK_EPS).reduce((a, x) => Math.min(a, x.at), Infinity);
    // сколько файла можно открыть за этим краем, в секундах дорожки
    const roomL = tkPhoto(c) ? Infinity : (c.reverse ? c.src - c.from - c.len : c.from) / c.speed;
    const roomR = tkPhoto(c) ? Infinity : (c.reverse ? c.from : c.src - c.from - c.len) / c.speed;
    return {c, o, oEnd, el: tkEls.get(c.id), low: side === 'l' ? Math.max(prev - o.at, -roomL) : o.at + min - oEnd, high: side === 'l' ? oEnd - min - o.at : Math.min(next - oEnd, roomR)};
  });
  const edge0 = side === 'l' ? grab.at : tkEnd(grab), pts = tkSnapPts(new Set(list.map(c => c.id)));
  const low = Math.max(...items.map(x => x.low)), high = Math.min(...items.map(x => x.high));
  tkDrag(e, ev => {
    let x = tkTimeAt(ev);
    x = x + tkSnapBy([x], pts);
    const move = Math.min(Math.max(x - edge0, low), high);
    for (const {c, o, el} of items) {
      const d = move * o.speed;
      if (side === 'l') {
        c.at = o.at + move; c.len = o.len - d;
        if (!tkPhoto(c) && !o.reverse) c.from = o.from + d;
      } else {
        c.len = o.len + d;
        if (!tkPhoto(c) && o.reverse) c.from = o.from - d;
      }
      el.style.left = c.at * tkPps + 'px';
      el.style.width = tkLen(c) * tkPps + 'px';
      tkPaintMarks(el, c);
      tkWaveDraw(el, c);
    }
    tkSize();
  }, () => {
    $('tkSnapLine').classList.add('hide');
    const f = tkFps();
    for (const {c} of items) {
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
    }
    tkCommit(before);
  });
}
function tkBandDrag(e) {
  const band = $('tkBand'), inner = $('tkInner').getBoundingClientRect();
  const x0 = e.clientX - inner.left, y0 = e.clientY - inner.top;
  const keep = e.ctrlKey || e.shiftKey ? new Set(tkSel) : new Set();
  const keepCues = e.ctrlKey || e.shiftKey ? new Set([...mtCueMany, ...(mtCueSel === null ? [] : [mtCueSel])]) : new Set();
  let on = false;
  tkDrag(e, ev => {
    const r = $('tkInner').getBoundingClientRect();
    // Рамка не выходит за дорожки: иначе она раздувает прокручиваемую область, и полосы прокрутки моргают
    const x1 = Math.min(Math.max(ev.clientX - r.left, TK_HEAD), r.width), y1 = Math.min(Math.max(ev.clientY - r.top, 30), r.height);
    if (!on && Math.hypot(x1 - x0, y1 - y0) < KIN.drag) return;
    on = true;
    band.classList.remove('hide');
    const L = Math.min(x0, x1), T = Math.min(y0, y1), W = Math.abs(x1 - x0), H = Math.abs(y1 - y0);
    Object.assign(band.style, {left: L + 'px', top: T + 'px', width: W + 'px', height: H + 'px'});
    const next = new Set(keep);
    for (const [id, el] of tkEls) {
      const q = el.getBoundingClientRect();
      if (q.left - r.left < L + W && q.right - r.left > L && q.top - r.top < T + H && q.bottom - r.top > T) tkIds(tkById(id)).forEach(x => next.add(x));
    }
    // реплики на дорожке S выделяются той же рамкой
    const cues = new Set(keepCues);
    for (const el of $('tkSubLane').children) {
      const q = el.getBoundingClientRect();
      if (q.left - r.left < L + W && q.right - r.left > L && q.top - r.top < T + H && q.bottom - r.top > T) cues.add(+el.dataset.i);
    }
    mtCueMany.clear();
    cues.forEach(i => mtCueMany.add(i));
    mtCueSel = cues.size ? Math.min(...cues) : null;
    mtCueLane();
    // перерисовка только при смене выделения
    if (next.size === tkSel.size && [...next].every(x => tkSel.has(x))) return;
    tkSel = next;
    tkRender();
  }, ev => {
    band.classList.add('hide');
    if (on) { mtCuesFill(); tkSelChanged(); return; }
    tkSel.clear();
    tkSelChanged();
    tkSeek(tkTimeAt(ev));
  });
  $('tkScroll').focus({preventScroll: true});
}
$('tkScroll').addEventListener('pointerdown', e => {
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  mvFileOff();
  if (e.button === 0 && e.target.closest('.tk-rowh')) {
    tkRowDrag(e, tkShown()[[...$('tkLanes').children].indexOf(e.target.closest('.tk-row'))]);
    return;
  }
  if (e.button !== 0 || e.target.closest('.tk-th')) return;
  const cueEl = e.target.closest('.tk-cue');
  if (cueEl) { mtCueDown(e, cueEl); return; }
  const mark = tkMarkAt(e);
  if (mark[0] === 'k') { tkMarkerDrag(e, +mark.slice(1)); return; }
  if (mark) { tkMarkDrag(e, mark); return; }
  if (e.target.closest('#tkRuler, #tkGrip')) {
    if (mv.playing) mvPause();
    // ползунок магнитится к краям клипов, переходам, ключам и меткам; S включает и выключает
    const pts = tkSnapPts(new Set()).filter(p => Math.abs(p - tkAt) > TK_EPS);
    const seek = ev => { const x = tkTimeAt(ev); tkSeek(x + tkSnapBy([x], pts)); };
    seek(e);
    tkDrag(e, seek, () => $('tkSnapLine').classList.add('hide'));
    return;
  }
  const trEl = e.target.closest('.tk-tr');
  if (tkTrSel && !trEl) { tkTrSel = null; tkRender(); mtTabs(); }   // выбранный переход снимается щелчком мимо
  if (trEl && tkTool !== 'razor') { if (kfPick) kfPickSet(null); tkTrDown(e, trEl); return; }
  if (kfPick && !e.target.closest('.tk-kf')) kfPickSet(null);   // выбранный ромбик снимается щелчком мимо
  if (!e.ctrlKey && !e.metaKey && !e.shiftKey && (mtCueSel !== null || mtCueMany.size)) { mtCueNone(); mtCueLane(); mtCuesFill(); }
  const el = e.target.closest('.tk-clip');
  if (tkTool === 'razor') {
    const c = el && tkById(+el.dataset.id);
    if (c) {
      let x = tkTimeAt(e);
      x += tkSnapBy([x], tkSnapPts(new Set([c.id])));
      $('tkSnapLine').classList.add('hide');
      tkDo(() => tkSplitAll(e.altKey ? [c] : tkGroup(c), x));
    }
    e.preventDefault();
    return;
  }
  if (!el) { tkBandDrag(e); return; }
  const c = tkById(+el.dataset.id);
  if (!c) return;
  const mk = e.target.closest('.tk-mk');
  if (mk) { tkClipMarkDrag(e, c, +mk.dataset.s); return; }
  const kd = e.target.closest('.tk-kf');
  if (kd) {
    if (!tkSel.has(c.id)) { tkSel = new Set(tkIds(c)); tkSelChanged(); }
    kfClipDrag(e, c, +kd.dataset.t);
    return;
  }
  const ids = e.altKey ? [c.id] : tkIds(c);   // Alt берёт один клип из связанной пары
  if (e.ctrlKey || e.metaKey || e.shiftKey) {
    const off = tkSel.has(c.id);
    ids.forEach(id => { if (off) tkSel.delete(id); else tkSel.add(id); });
    tkSelChanged();
    e.preventDefault();
    return;
  }
  const wasSel = !e.altKey && ids.every(id => tkSel.has(id));
  if (!wasSel) { tkSel = new Set(ids); tkSelChanged(); }
  const edge = e.target.closest('.tk-edge');
  if (edge) tkTrimDrag(e, c, edge.classList.contains('l') ? 'l' : 'r', e.altKey);
  else tkMoveDrag(e, c, wasSel);
});
// правый клик по метке удаляет её
$('tkScroll').addEventListener('contextmenu', e => {
  const mk = e.target.closest('.tk-mk'), c = mk && tkById(+mk.closest('.tk-clip').dataset.id), mark = tkMarkAt(e);
  if (c) { e.preventDefault(); tkDo(() => { c.marks = c.marks.filter(m => m !== +mk.dataset.s); if (!c.marks.length) delete c.marks; }); }
  else if (mark[0] === 'k') { e.preventDefault(); tkDo(() => { tkMarkers = tkMarkers.filter((m, i) => i !== +mark.slice(1)); }); }
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
  if (b.dataset.a === 'off') { tkDo(() => { tr.off = !tr.off; }); return; }
  if (b.dataset.a === 'thin') { tr.thin = !tkSmall(tr); if (!tr.thin && tkSmall(tr)) delete tr.h; tkChanged(); }
  else if (b.dataset.a === 'del' && !tr.clips.length) tkDo(() => { tkTracks = tkTracks.filter(x => x !== tr); });
});

// ---------- кнопки ----------
$('tkToolV').onclick = () => tkSetTool('select');
$('tkToolC').onclick = () => tkSetTool('razor');
$('tkUndo').onclick = () => tkBack(tkUndoList, tkRedoList);
$('tkRedo').onclick = () => tkBack(tkRedoList, tkUndoList);
$('tkSnapBtn').onclick = () => { tkSnapOn = !tkSnapOn; tkBar(); tkAutosave(); };
$('tkMarkIn').onclick = () => tkMark('in');
$('tkMarkOut').onclick = () => tkMark('out');
$('tkMarker').onclick = tkPutMarker;
$('tkLink').onclick = tkLinkToggle;
$('tkAddV').onclick = () => tkAddTrack('v');
$('tkAddA').onclick = () => tkAddTrack('a');
$('tkFitBtn').onclick = tkFit;
$('tkZoom').addEventListener('input', () => tkZoomTo(2 ** +$('tkZoom').value));

// ---------- окно горячих клавиш. Клавиша с приставкой kh. переводится, остальные написаны как на клавиатуре ----------
const TK_HELP = [
  ['kh.g.view', [[['kh.space'], 'kh.play'], [['kh.spaceDrag', 'kh.wheelDrag'], 'kh.pan'], [['F'], 'kh.showLayer'], [['←', '→'], 'kh.frame'], [['Shift+←', 'Shift+→'], 'kh.second'], [['↑', '↓'], 'kh.edge'], [['Home', 'End'], 'kh.ends']]],
  ['kh.g.tools', [[['V'], 'kh.select'], [['C'], 'kh.razor'], [['T'], 'kh.text'], [['U'], 'kh.shape'], [['P'], 'kh.pen'], [['A'], 'kh.pts'], [['S'], 'kh.snap'], [['Esc'], 'kh.esc']]],
  ['kh.g.edit', [[['Ctrl+Z'], 'kh.undo'], [['Ctrl+Shift+Z', 'Ctrl+Y'], 'kh.redo'], [['Ctrl+K'], 'kh.cut'], [['Delete'], 'kh.del'], [['Shift+Delete'], 'kh.ripple'], [['Ctrl+C', 'Ctrl+X', 'Ctrl+V'], 'kh.clip'], [['Ctrl+D'], 'kh.dup'], [['D'], 'kh.trans'], [['Ctrl+A'], 'kh.all'], [['Ctrl+A'], 'kh.cueAll']]],
  ['kh.g.link', [[['Ctrl+L'], 'kh.unlink'], [['kh.altMouse'], 'kh.alt']]],
  ['kh.g.marks', [[['I', 'O'], 'kh.io'], [['Ctrl+Shift+X'], 'kh.ioOff'], [['M'], 'kh.marker'], [['kh.rightClick'], 'kh.markerOff']]],
  ['kh.g.zoom', [[['+', '−'], 'kh.zoom'], [['kh.ctrlWheel'], 'kh.wheel'], [['\\'], 'kh.fit'], [['kh.ctrlWheel'], 'kh.viewZoom'], [['Shift+\\'], 'kh.viewFit']]],
  ['kh.g.mouse', [[['kh.m.shiftCorner'], 'kh.m.free'], [['kh.m.shiftRot'], 'kh.m.rot15'], [['kh.m.dblLayer'], 'kh.m.refit'],
    [['kh.m.ctrlClick', 'kh.m.shiftClick'], 'kh.m.addSel'], [['kh.m.band'], 'kh.m.bandSel'], [['kh.m.dblFile'], 'kh.m.append'], [['kh.m.dblCue'], 'kh.m.cueEdit'],
    [['kh.m.altRow'], 'kh.m.scrub'], [['kh.m.altSlider'], 'kh.m.noMagnet'], [['kh.m.rightClip'], 'kh.m.menu']]],
  ['kh.g.project', [[['Ctrl+S'], 'kh.save'], [['Ctrl+Shift+S'], 'kh.saveAs']]],
];
function tkHelpOpen() {
  const key = k => `<kbd>${esc(k.startsWith('kh.') ? t(k) : k)}</kbd>`;
  $('khBody').innerHTML = TK_HELP.map(([group, rows]) => `<section><h4>${esc(t(group))}</h4>` +
    rows.map(([keys, text]) => `<div class="kh-row"><span class="kh-keys">${keys.map(key).join('')}</span><span>${esc(t(text))}</span></div>`).join('') +
    '</section>').join('');
  $('keysHelp').classList.remove('hide');
}
const tkHelpClose = () => $('keysHelp').classList.add('hide');
$('tkKeysBtn').onclick = tkHelpOpen;
$('khClose').onclick = tkHelpClose;
$('keysHelp').addEventListener('click', e => { if (e.target === $('keysHelp')) tkHelpClose(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('keysHelp').classList.contains('hide')) { e.stopPropagation(); tkHelpClose(); } });

// ---------- хоткеи: по коду клавиши, поэтому работают и в русской раскладке ----------
const tkTyping = el => el.matches && el.matches('input:not([type=range]):not([type=checkbox]),select,textarea');
const TK_KEYS = {
  Space: () => mvHandDown(),   // старт и стоп при отпускании, если вид не двигали (viewzoom.js)
  KeyV: () => tkSetTool('select'),
  KeyC: () => tkSetTool('razor'),
  KeyT: () => mtTextTool(!mtTextOn),
  KeyU: () => mtShapeTool(!mtShapeOn),   // фигура и перо: shapes.js
  KeyP: () => mtPenTool(!mtPenOn),
  KeyA: () => mtPtsTool(!mtPtsOn),   // правка точек фигуры
  KeyF: () => mvShowLayer(),
  KeyS: () => $('tkSnapBtn').click(),
  KeyI: () => tkMark('in'),
  KeyO: () => tkMark('out'),
  KeyM: tkPutMarker,
  KeyD: tkTrDefault,   // переход по умолчанию на ближайший стык (trpanel.js)
  Delete: tkDeleteSel,
  Backspace: tkDeleteSel,
  Equal: () => tkZoomTo(tkPps * 1.5),
  NumpadAdd: () => tkZoomTo(tkPps * 1.5),
  Minus: () => tkZoomTo(tkPps / 1.5),
  NumpadSubtract: () => tkZoomTo(tkPps / 1.5),
  Backslash: () => tkFit(),
  ArrowLeft: () => mvStep(-1 / tkFps()),
  ArrowRight: () => mvStep(1 / tkFps()),
  ArrowUp: () => { mvPause(); tkEdge(-1); },
  ArrowDown: () => { mvPause(); tkEdge(1); },
  Home: () => $('mtStart').click(),
  End: () => $('mtEnd').click(),
  Escape: () => { mvFileOff(); tkSel.clear(); tkTrSel = null; mtCueNone(); mtCueLane(); mtCuesFill(); tkSetTool('select'); mtTextTool(false); mtShapeTool(false); tkSelChanged(); },
};
const TK_CTRL_KEYS = {
  KeyK: tkCutHere,
  KeyL: tkLinkToggle,
  KeyZ: () => tkBack(tkUndoList, tkRedoList),
  KeyY: () => tkBack(tkRedoList, tkUndoList),
  KeyC: tkCopy,
  KeyX: () => { tkCopy(); tkRemove(false); },
  KeyV: () => tkInsert(tkBoard, tkAt),
  KeyD: tkDuplicate,
  KeyA: () => {
    if (mtCueSel !== null || mtCueMany.size) { mtCueAll(); return; }   // выбрана реплика: всё значит все реплики
    tkSel = new Set(tkClips().map(c => c.id)); tkSelChanged();
  },
  KeyS: () => mtProjectSave(false),
  KeyF: () => { $('mtFind').focus(); $('mtFind').select(); },   // поиск по настройкам инспектора
};
document.addEventListener('keydown', e => {
  if (tab !== 'mont' || document.querySelector('.modal:not(.hide)') || tkTyping(e.target) || e.altKey) return;
  const ctrl = e.ctrlKey || e.metaKey;
  let fn;
  if (ctrl && e.shiftKey && e.code === 'KeyZ') fn = () => tkBack(tkRedoList, tkUndoList);
  else if (ctrl && e.shiftKey && e.code === 'KeyS') fn = () => mtProjectSave(true);
  else if (ctrl && e.shiftKey && e.code === 'KeyX') fn = tkMarksOff;
  else if (!ctrl && e.shiftKey && e.code === 'Delete') fn = () => tkRemove(true);
  else if (!ctrl && e.shiftKey && e.code === 'Backslash') fn = mvViewFit;   // вид по размеру окна (viewzoom.js)
  else if (!ctrl && e.shiftKey && e.code === 'ArrowLeft') fn = () => mvStep(-1);
  else if (!ctrl && e.shiftKey && e.code === 'ArrowRight') fn = () => mvStep(1);
  else if (ctrl && !e.shiftKey) fn = TK_CTRL_KEYS[e.code];
  else if (!ctrl && !e.shiftKey) fn = TK_KEYS[e.code];
  if (!fn) return;
  e.preventDefault();
  if (e.target.blur && e.target !== document.body) e.target.blur();   // иначе пробел нажмёт кнопку, на которой фокус
  if (e.repeat && e.code === 'Space') return;   // зажатый пробел — это рука, а не череда нажатий
  fn();
});
