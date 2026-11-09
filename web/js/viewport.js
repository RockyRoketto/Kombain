// ---------- вьюпорт монтажа: все слои и весь звук одновременно, рамка выбранного слоя, просмотр файла из окна файлов ----------
// Время идёт по часам: курсор не ждёт видео. Отставший слой подгоняется скоростью, сильно отставший перематывается.
// Каждый клип играет в своём <video> из общего набора mv.pool, следующий клип готовится заранее, поэтому стык без паузы.
const MV_LIVE = 6;      // столько видеослоёв играет сразу, остальные показывают стоп-кадр
const MV_POOL = 14;     // столько <video> держим загруженными
const MV_AHEAD = 2;     // за сколько секунд готовить следующий клип
const MV_PROBES = 4;    // столько файлов проверяем одновременно
const mtV = $('mtVideo'), mtPic = $('mtImg'), mvCv = $('mvCanvas'), mvFrame = $('mvFrame'), mvStage = $('mtStage');
const mv = {
  playing: false, loop: false, holding: false, holdTo: 0, last: 0, raf: 0, shownAt: 0, sig: '',
  pool: [],          // {el, key, clip, ready, stop, lag, t0}
  pics: new Map(),   // id клипа → <img>: фото или кадр-заместитель
  state: new Map(),  // файл или кусок реверса → {ok, proxy, pct, fail}
  probes: new Map(), // что проверяем сейчас
  live: [],          // {c, e}: играющие сейчас
  file: null, fileStop: null, fileReady: false, pic: '',
  tr: new Map(),     // переходы: id клипа → края (mvTrMap в mvtrans.js)
  trBg: new Map(),   // плашки цвета переходов fadeblack и fadewhite
};
const mvVol = {volume: .8, muted: false};   // общий ползунок: стоит на выходе шины, поэтому индикатор его не видит
bindVolume(mvVol, $('mtMute'), $('mtVol'));
keepSeeking(mtV);
trackFrame(mtV);
// картинка из связанной пары молчит: её звук играет свой клип на звуковой дорожке
const mvMuted = c => !!(c && c.part === 'v');
// доля плавности клипа в момент x: 0 совсем нет, 1 полностью. Как в движке (tlFades): край с переходом плавность заменяет он
function mvFadeAt(c, x) {
  const len = tkLen(c), d = x - c.at, t = mv.tr.get(c.id), a = t && t.i ? 0 : Math.min(c.fadeIn || 0, len), b = t && t.o ? 0 : Math.min(c.fadeOut || 0, len);
  let k = 1;
  if (a > 0) k *= Math.min(Math.max(d / a, 0), 1);
  if (b > 0) k *= Math.min(Math.max((len - d) / b, 0), 1);
  return k;
}
// Весь звук просмотра: <video> → усилитель клипа → шина → общий ползунок → колонки. С шины снимает уровень индикатор.
// Браузер запускает контекст только после действия пользователя, поэтому resume зовём при каждом запуске просмотра.
function mvAudio() {
  if (!mv.audio) {
    const a = mv.audio = new AudioContext({latencyHint: 'playback'});   // запас в буфере: без него звук трещит, когда страница занята кадрами
    mv.bus = a.createGain();
    mv.bus.channelCount = 2;                // моно попадает в оба канала, 5.1 сводится в стерео
    mv.bus.channelCountMode = 'explicit';
    mv.bus.channelInterpretation = 'speakers';
    mv.out = a.createGain();
    mv.out.gain.value = mvVol.muted ? 0 : mvVol.volume;
    mv.bus.connect(mv.out);
    mv.out.connect(a.destination);
    a.createMediaElementSource(mtV).connect(mv.bus);
    vuAttach(a, mv.bus, () => mv.playing || (!!mv.file && !mtV.paused));
  }
  if (mv.audio.state === 'suspended') mv.audio.resume();
}
function mvGain(e) {
  if (!e.gain) {
    mvAudio();
    e.gain = mv.audio.createGain();
    mv.audio.createMediaElementSource(e.el).connect(e.gain);
    e.gain.connect(mv.bus);
  }
  return e.gain;
}
function mvLevel(e, c) {
  const g = mvGain(e).gain, v = c ? (c.vol === undefined ? 1 : c.vol) * mvFadeAt(c, tkAt) * mvTrGain(c, tkAt) : 1;
  if (v === e.vol) return;
  e.vol = v;
  g.setTargetAtTime(v, mv.audio.currentTime, .012);   // ступеньки громкости от кадра к кадру слышны как треск
}
function mvVolume() { if (mv.out) mv.out.gain.value = mvVol.muted ? 0 : mvVol.volume; }
// плавность и громкость идут за курсором времени в каждом кадре просмотра
function mvLook() {
  const keyed = new Set(), op = c => (c.op ?? 1) * mvFadeAt(c, tkAt) * mvTrOpacity(c, tkAt);   // c.op с ключами ставит поза (kfPose)
  mvTrFrame();
  for (const {c, e} of mv.live) { e.el.style.opacity = op(c); mvLevel(e, c); chromaShow(e.el, c, keyed); }
  for (const [id, el] of mv.pics) { const c = tkById(id); if (c) { el.style.opacity = op(c); if (!el.classList.contains('hide')) chromaShow(el, c, keyed); } }
  chromaSweep(keyed);
  mvSubsDraw();
}
// Субтитры поверх всех слоёв, те же размеры, что в subsASS (subtitles.go). В ASS размер шрифта — это высота строки, в CSS — кегль:
// их отношение своё у каждого шрифта. Без файла в проекте или без реплики в этот момент ничего не видно.
const mvSubLines = new Map();
var mvSubsSel = false;   // выбраны ли субтитры во вьюпорте: тогда видны рамка и ручки
function mvSubLine(font) {
  if (!mvSubLines.has(font)) {
    const g = document.createElement('canvas').getContext('2d');
    g.font = `100px "${font}"`;
    const m = g.measureText('Ag');
    mvSubLines.set(font, (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent) / 100 || 1.15);
  }
  return mvSubLines.get(font);
}
function mvSubsDraw() {
  const el = $('mvSubs'), s = tkSubs;
  mtCueNow();
  const text = s && !s.off ? mtCueList().filter(c => tkAt >= c.a && tkAt < c.b).map(c => s.join ? c.t.replace(/\s*\n\s*/g, ' ') : c.t).join('\n').trim() : '';
  el.classList.toggle('hide', !text);
  if (!text) return;
  // обёртка держит текст по центру рамки, а сам span остаётся строчным: подложка рисуется на каждую строку
  let span = el.querySelector('span');
  if (!span) { const box = document.createElement('div'); box.className = 'mv-subs-t'; span = document.createElement('span'); box.append(span); el.prepend(box); }
  if (span.textContent !== text) span.textContent = text;
  if (tkSel.size) mvSubsSel = false;
  el.classList.toggle('sel', mvSubsSel && !mv.playing);
  const size = s.size * mvCv.clientHeight, w = s.w || .9, x = s.x || .5, pad = size * .12;
  el.dataset.pos = s.y > 0 ? 'free' : s.pos;
  Object.assign(el.style, {left: (x - w / 2) * 100 + '%', width: w * 100 + '%', bottom: s.y > 0 ? (1 - s.y) * 100 + '%' : '', height: s.y > 0 && s.h > 0 ? s.h * 100 + '%' : '',
    fontFamily: `"${s.font}"`, fontSize: size / mvSubLine(s.font) + 'px', lineHeight: size + 'px', color: s.color || '#fff'});
  const a = s.backA > 0 ? s.backA : .6, hex = s.back || '#000000';
  Object.assign(span.style, s.back
    ? {webkitTextStroke: '', backgroundColor: `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`, padding: `${pad}px`}
    : {webkitTextStroke: `${pad}px #000`, backgroundColor: '', padding: ''});
}
// Субтитры и их ручки под мышью. Смотрим по точке, а не по e.target: рамка выбранного слоя лежит выше холста и забирает нажатие.
function mvSubsAt(e) {
  return document.elementsFromPoint(e.clientX, e.clientY).find(n => n.matches('#mvSubs span, #mvSubs i, #mvSubs.sel')) || null;
}
// Мышью во вьюпорте: текст и пустое место выбранной рамки двигают её, ручки меняют только рамку, противоположный край стоит на месте.
// Шрифт меняет только поле «Размер». Рамка получает свою высоту, когда тянут верх или низ.
function mvSubsPress(e, h) {
  const s = tkSubs, el = $('mvSubs'), side = h.dataset.sc || '';
  if (mv.playing) mvPause();
  if (tkSel.size) { tkSel.clear(); tkSelChanged(); }
  mvSubsSel = true;
  mvSubsDraw();
  const before = tkState(), cv = mvCv.getBoundingClientRect(), r = el.getBoundingClientRect();
  const w0 = s.w || .9, x0 = s.x || .5, low = s.h || s.size, cx = e.clientX, cy = e.clientY;
  const L = (r.left - cv.left) / cv.width, R = (r.right - cv.left) / cv.width, T = (r.top - cv.top) / cv.height, B = (r.bottom - cv.top) / cv.height;
  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
  const onX = v => { const s = mvSnap([v], cv.width, 'x'); mvGuides(s.at, -1); return v + s.d; }, onY = v => { const s = mvSnap([v], cv.height, 'y'); mvGuides(-1, s.at); return v + s.d; };
  let moved = false;
  tkDrag(e, ev => {
    moved = true;
    if (side) {
      const dx = (ev.clientX - cx) / cv.width, dy = (ev.clientY - cy) / cv.height, patch = {};
      if (/[we]/.test(side)) {
        const a = side.includes('w') ? clamp(onX(L + dx), 0, R - .1) : L, b = side.includes('e') ? clamp(onX(R + dx), L + .1, 1) : R;
        patch.w = mtRnd(b - a, 3); patch.x = +((a + b) / 2).toFixed(4);
      }
      if (/[ns]/.test(side)) {
        const a = side.includes('n') ? clamp(onY(T + dy), 0, B - .02) : T, b = side.includes('s') ? clamp(onY(B + dy), T + .02, 1) : B;
        patch.h = +(b - a).toFixed(4); patch.y = +b.toFixed(4);
      }
      mtSubsLive(patch);
    } else {
      // прилипают края и середина контейнера: к краям и середине кадра и к направляющим
      const tall = B - T, rawX = x0 + (ev.clientX - cx) / cv.width, rawY = B + (ev.clientY - cy) / cv.height;
      const sx = mvSnap([rawX - w0 / 2, rawX, rawX + w0 / 2], cv.width, 'x'), sy = mvSnap([rawY - tall, rawY - tall / 2, rawY], cv.height, 'y');
      mvGuides(sx.at, sy.at);
      tkSubs.x = +clamp(rawX + sx.d, w0 / 2, 1 - w0 / 2).toFixed(4);
      tkSubs.y = +clamp(rawY + sy.d, low, 1).toFixed(4);
      mvSubsDraw();
    }
  }, () => { mvGuides(-1, -1); if (moved) tkCommit(before); });
}
$('mvSubs').addEventListener('click', e => e.stopPropagation());
// Сетка и телевизионные зоны поверх кадра: только для просмотра, в результат не идут
function mvGuidesSet(id, btn, key, on) {
  $(id).classList.toggle('hide', !on);
  $(btn).classList.toggle('on', on);
  storeSet(key, on ? '1' : '');
}
[['mvGrid', 'mvGridBtn', 'konv9000.mvGrid']].forEach(([id, btn, key]) => {
  mvGuidesSet(id, btn, key, !!storeGet(key));
  $(btn).onclick = () => { mvGuidesSet(id, btn, key, $(id).classList.contains('hide')); $(btn).blur(); };
});
// Безопасные зоны площадок: поля в процентах кадра 9:16 (значения для рекламы, у обычных роликов интерфейс похож, но точных цифр площадки не дают).
// meta: Meta Ads Guide, https://www.facebook.com/business/ads-guide/update/video/instagram-reels (там же указаны 14, 35, 6).
// shorts: измерено по оверлею Google 1080×1920 (288, 672, 48, 192 px), https://services.google.com/fh/files/misc/youtubesafezoneoverlay_vertical_final.png
// tiktok: измерено по Feed.png из «In-Feed-Standard Version LTR.zip», https://ads.tiktok.com/help/article/tiktok-auction-in-feed-ads
//   кадр 720×1280: поля 160, 440, 80, 80; справа внизу под кнопки вырез 120×280 px (cut: его доля от ширины и высоты зоны).
const MV_ZONES = {
  meta: {t: 14, b: 35, l: 6, r: 6, src: 'Meta Ads Guide'},
  shorts: {t: 288 / 19.2, b: 672 / 19.2, l: 48 / 10.8, r: 192 / 10.8, src: 'Google Ads Help'},
  tiktok: {t: 160 / 12.8, b: 440 / 12.8, l: 80 / 7.2, r: 80 / 7.2, cut: [120 / 5.6, 280 / 6.8], src: 'TikTok Ads Manager'},
};
let mvSafeNow = '';
const mvSafeKey = v => 'mv.safe.' + v;
function mvSafeSet(v) {
  const z = MV_ZONES[v], el = $('mvSafeZone');
  mvSafeNow = v;
  $('mvSafe').classList.toggle('hide', !v);
  $('mvSafe').classList.toggle('zone', !!z);
  $('mvSafeBtn').classList.toggle('on', !!v);
  if (z) {
    el.style.inset = `${z.t}% ${z.r}% ${z.b}% ${z.l}%`;
    $('mvSafeName').dataset.i18n = mvSafeKey(v);
    $('mvSafeName').textContent = t(mvSafeKey(v));
    $('mvSafeCut').classList.toggle('hide', !z.cut);
    if (z.cut) { $('mvSafeCut').style.width = z.cut[0] + '%'; $('mvSafeCut').style.height = z.cut[1] + '%'; }
  }
  storeSet('konv9000.mvSafe', v);
}
{
  const saved = storeGet('konv9000.mvSafe');   // '1' писали прежние версии: телезоны
  mvSafeSet(saved === '1' ? 'tv' : saved === 'tv' || MV_ZONES[saved] ? saved : '');
}
$('mvSafeBtn').onclick = () => {
  const r = $('mvSafeBtn').getBoundingClientRect();
  const item = (v, label, title) => ({label, title, key: mvSafeNow === v ? '✓' : '', run: () => mvSafeSet(v)});
  ctxOpen(r.left, r.bottom + 4, [
    item('', t('mv.safe.off')),
    '-',
    item('tv', t('mv.safe.tv')),
    ...Object.keys(MV_ZONES).map(v => item(v, t(mvSafeKey(v)), t('mv.safe.src', {src: MV_ZONES[v].src}))),
  ]);
  $('mvSafeBtn').blur();
};
$('mtVol').addEventListener('input', mvVolume);
$('mtMute').addEventListener('click', mvVolume);
function mvNote(text) {
  $('mtNote').textContent = text || '';
  $('mtNote').classList.toggle('hide', !text);
}
function mvPicture(url, fallback) {
  mtPic.classList.toggle('hide', !url);
  if (url === mv.pic) return;
  mv.pic = url;
  if (!url) { mtPic.removeAttribute('src'); return; }
  mtPic.onerror = () => { if (fallback) { mv.pic = fallback; mtPic.src = fallback; fallback = null; } };
  mtPic.src = url;
}
// место в файле для момента x на дорожке
const mvSrc = (c, x) => { const s = (x - c.at) * c.speed; return c.reverse ? c.from + c.len - s : c.from + s; };
// место в <video>: кусок реверса уже идёт задом наперёд и начинается с нуля
const mvTime = (c, x) => c.reverse ? (x - c.at) * c.speed : mvSrc(c, x);
const mvUnder = (c, x) => x >= c.at - 1e-4 && x < tkEnd(c) - 1e-4;
const mvRev = c => c.reverse ? {from: +c.from.toFixed(3), len: +c.len.toFixed(3)} : null;
const mvKey = c => {
  if (c.reverse) return `${mtKey(c.path)}|${c.from.toFixed(3)}|${c.len.toFixed(3)}`;
  const low = mvLowOf(c);
  return low ? mvLowId(c.path, low) : mtKey(c.path);
};

// ---------- качество просмотра: на результат не влияет. Пока уменьшенная копия считается, играет то, что играло ----------
const MV_QUAL_KEY = 'konv9000.mvQual', MV_LOW_MIN = 1280;   // файл меньше этого декодируется легко, копия не окупится
let mvQual = [2, 4].includes(+storeGet(MV_QUAL_KEY)) ? +storeGet(MV_QUAL_KEY) : 1;
const mvLow = {ready: new Set(), bad: new Set(), busy: new Map()};
const mvLowId = (path, q) => `${mtKey(path)}|q${q}`;
function mvLowWanted(c) {
  const it = mtFile(c.path);
  return mvQual > 1 && !c.reverse && !tkPhoto(c) && !!it && it.kind !== 'a' && !it.bad && Math.max(it.w || 0, it.h || 0) > MV_LOW_MIN;
}
const mvLowOf = c => mvLowWanted(c) && mvLow.ready.has(mvLowId(c.path, mvQual)) ? mvQual : 0;
async function mvLowPoll(id, j) {
  const r = await api('proxy', {path: j.path, scale: j.q});
  if (mvLow.busy.get(id) !== j) return;
  if (r.ready || r.error) {
    mvLow.busy.delete(id);
    if (r.error) mvLow.bad.add(id);   // остаётся оригинал
    else {
      mvLow.ready.add(id);
      mv.state.set(id, {ok: true, proxy: true, pct: 0, fail: ''});
      mtCopies();
      mvShow();
    }
  } else {
    j.pct = r.pct || 0;
    j.timer = setTimeout(() => mvLowPoll(id, j), 500);
  }
  mvQualBtn();
}
function mvLowPrep() {
  for (const [id, j] of mvLow.busy) {
    if (j.q === mvQual) continue;
    clearTimeout(j.timer);
    mvLow.busy.delete(id);
    api('proxy-stop', {path: j.path, scale: j.q});
  }
  for (const c of tkClips()) {
    if (!mvLowWanted(c)) continue;
    const id = mvLowId(c.path, mvQual);
    if (mvLow.ready.has(id) || mvLow.bad.has(id) || mvLow.busy.has(id)) continue;
    const j = {path: c.path, q: mvQual, pct: 0, timer: 0};
    mvLow.busy.set(id, j);
    mvLowPoll(id, j);
  }
  mvQualBtn();
}
// Копии стёрты: всё считается заново
function mvLowReset() {
  for (const j of mvLow.busy.values()) clearTimeout(j.timer);
  mvLow.busy.clear(); mvLow.ready.clear(); mvLow.bad.clear();
}
function mvQualBtn() {
  const b = $('mvQualBtn'), jobs = [...mvLow.busy.values()];
  if (mvQual === 1) { b.dataset.i18n = 'mv.qual.full'; b.textContent = t('mv.qual.full'); }
  else {
    delete b.dataset.i18n;
    b.textContent = `1/${mvQual}` + (jobs.length ? ` ${Math.round(jobs.reduce((a, j) => a + j.pct, 0) / jobs.length)}%` : '');
  }
  b.classList.toggle('on', mvQual > 1);
}
function mvQualSet(q) {
  if (q === mvQual) return;
  mvQual = q;
  storeSet(MV_QUAL_KEY, q > 1 ? String(q) : '');
  mvLowPrep();
  mvShow();
  mvLook();
}
mvQualBtn();
$('mvQualBtn').onclick = () => {
  const r = $('mvQualBtn').getBoundingClientRect();
  const item = (q, label, title) => ({label, title, key: mvQual === q ? '✓' : '', run: () => mvQualSet(q)});
  ctxOpen(r.left, r.bottom + 4, [
    item(1, t('mv.qual.full'), t('mv.qual.fullHint')),
    item(2, '1/2', t('mv.qual.lowHint', {n: 2})),
    item(4, '1/4', t('mv.qual.lowHint', {n: 4})),
  ]);
  $('mvQualBtn').blur();
};
const mvFps = c => { const it = mtFile(c.path); return it && it.fps > 0 ? it.fps : 30; };

// ---------- холст: тот же размер, что выберет движок (tlCanvas) ----------
function mvCanvasDims() {
  if (tkCanvas) return tkCanvas;
  for (const photos of [false, true]) {
    for (const tr of tkTracks) {
      if (tr.kind !== 'v' || tr.off) continue;
      let best = null;
      for (const c of tr.clips) {
        const it = mtFile(c.path);
        if (it && it.w > 0 && tkPhoto(c) === photos && (!best || c.at < best.at)) best = c;
      }
      if (best) { const it = mtFile(best.path); return {w: it.w, h: it.h}; }
    }
  }
  return {w: 1920, h: 1080};
}
function mvSizeCanvas() {
  const pad = mvRulersSeen() ? MV_RULER : 0;   // линейки сверху и слева не закрывают кадр
  const d = mvCanvasDims(), W = mvStage.clientWidth - pad, H = mvStage.clientHeight - pad;
  const s = mvViewScale(Math.min(W / d.w, H / d.h) || 0), w = Math.round(d.w * s), h = Math.round(d.h * s);   // сдвиг и масштаб вида: viewzoom.js
  mvViewClamp(W, H, w, h);
  Object.assign(mvCv.style, {width: w + 'px', height: h + 'px', left: pad + Math.round((W - w) / 2 + mvView.x) + 'px', top: pad + Math.round((H - h) / 2 + mvView.y) + 'px'});
  mvCanvasBtn();
  mvZoomBtn();
  mvRulersDraw();
}
function mvStageFit() { mvSizeCanvas(); mvFrameDraw(); mvSubsDraw(); tkClips().filter(c => c.blur || c.shA).forEach(mvPlaceClip); mvLook(); }   // размытие и тень в точках экрана
new ResizeObserver(() => { if (tab === 'mont') mvStageFit(); }).observe(mvStage);
// Рамка слоя в долях холста. Без своей рамки слой вписан по центру, как делает движок.
function mvBox(c) { return c.w > 0 ? {x: c.x || 0, y: c.y || 0, w: c.w, h: c.h} : mvFitBox(c); }
// слой, вписанный в кадр по центру (tlFitBox)
function mvFitBox(c) {
  const d = mvCanvasDims(), it = mtFile(c.path) || {};
  if (!(it.w > 0)) return {x: 0, y: 0, w: 1, h: 1};
  const s = Math.min(d.w / it.w, d.h / it.h), w = it.w * s / d.w, h = it.h * s / d.h;
  return {x: (1 - w) / 2, y: (1 - h) / 2, w, h};
}
const mvCropOf = c => ({l: c.cl || 0, t: c.ct || 0, r: c.cr || 0, b: c.cb || 0});
// Порядок как в движке (tlBoxChain): кадрирование срезает края на месте, поворот идёт вокруг середины рамки
function mvPlace(el, c) {
  const b = mvBox(c), o = mvCropOf(c), fx = mvFx(c), cut = o.l || o.t || o.r || o.b, inner = fx && cut;
  // filter у браузера идёт раньше clip-path: тень и край размытия обрезались бы. Поэтому с эффектами срезается само содержимое, как в tlBoxChain
  const w = 1 - o.l - o.r, h = 1 - o.t - o.b, box = inner ? {x: b.x + o.l * b.w, y: b.y + o.t * b.h, w: b.w * w, h: b.h * h} : b;
  Object.assign(el.style, {left: box.x * 100 + '%', top: box.y * 100 + '%', width: box.w * 100 + '%', height: box.h * 100 + '%', objectFit: c.w > 0 || inner ? 'fill' : 'contain',
    clipPath: cut && !inner ? `inset(${o.t * 100}% ${o.r * 100}% ${o.b * 100}% ${o.l * 100}%)` : '',
    objectViewBox: inner ? `inset(${o.t * 100}% ${o.r * 100}% ${o.b * 100}% ${o.l * 100}%)` : '',
    transformOrigin: inner ? `${(.5 - o.l) / w * 100}% ${(.5 - o.t) / h * 100}%` : '',   // поворот вокруг середины всей рамки
    transform: c.rot ? `rotate(${c.rot}deg)` : '', filter: fx, mixBlendMode: c.blend || ''});   // режимы и формулы как у ffmpeg: tlBlends в timeline.go
  mvTrPlace(el, c, box, inner ? [(.5 - o.l) / w, (.5 - o.t) / h] : [.5, .5], cut && !inner ? o : null);   // переход на краю (mvtrans.js)
}
// Размытие и тень, порядок и размеры как в tlFxChain (timeline.go). Сдвиг тени считается на экране, а filter стоит до поворота, поэтому сдвиг поворачивается обратно
function mvFx(c) {
  const px = mvCv.clientHeight, out = [];
  if (c.blur) out.push(`blur(${c.blur * px}px)`);
  if (c.shA) {
    const a = (c.rot || 0) * Math.PI / 180, x = c.shX || 0, y = c.shY || 0, [r, g, b] = chromaRGB(c.shC || '#000000').map(v => Math.round(v * 255));
    out.push(`drop-shadow(${(x * Math.cos(a) + y * Math.sin(a)) * px}px ${(y * Math.cos(a) - x * Math.sin(a)) * px}px ${(c.shB || 0) * px}px rgba(${r},${g},${b},${c.shA}))`);
  }
  return out.join(' ');
}
// Новый размер холста: рамки не растягиваются, а уменьшаются или растут вместе с кадром
function mvSetCanvas(next) {
  const a = mvCanvasDims();
  tkDo(() => {
    tkCanvas = next;
    const b = mvCanvasDims(), f = Math.min(b.w / a.w, b.h / a.h);
    for (const c of tkClips()) {
      if (!(c.w > 0)) continue;
      const cx = (c.x || 0) + c.w / 2, cy = (c.y || 0) + c.h / 2, w = c.w * a.w * f / b.w, h = c.h * a.h * f / b.h;
      if (kfOn(c, 'w')) kfSet(c, 'w', c.kf.w.map(k => ({...k, v: +(k.v * a.w * f / b.w).toFixed(6)})));   // ключи ширины вместе с рамкой
      mvSetBox(c, cx - w / 2, cy - h / 2, w, h);
    }
  });
}

// ---------- проверка файлов: что окно играет само, а для чего нужна копия. Идёт заранее, чтобы копия была готова к своему месту ----------
function mvPrep() {
  mvLowPrep();
  const want = new Map();
  for (const tr of tkTracks) for (const c of tr.clips) {
    const it = mtFile(c.path);
    if (!tkPhoto(c) && it && it.kind && !it.bad) want.set(mvKey(c), c);
  }
  for (const [key, stop] of mv.probes) if (!want.has(key)) { stop(); mv.probes.delete(key); mv.state.delete(key); }
  for (const [key, c] of want) {
    if (mv.probes.size >= MV_PROBES) break;
    if (mv.state.has(key) && (mv.state.get(key).ok || mv.state.get(key).fail)) continue;
    if (mv.probes.has(key)) continue;
    const st = {ok: false, proxy: false, pct: 0, fail: ''}, el = document.createElement('video');
    mv.state.set(key, st);
    el.preload = 'metadata'; el.muted = true;
    const done = () => { const stop = mv.probes.get(key); mv.probes.delete(key); if (stop) stop(); mvShow(); };
    const low = mvLowOf(c);
    mv.probes.set(key, attachMedia(el, c.path, mtFile(c.path).kind !== 'a', {
      rev: mvRev(c), proxy: !!low, scale: low,
      ready(proxy) { st.ok = true; st.proxy = !!proxy; done(); mtCopies(); },
      wait(pct) { st.proxy = true; st.pct = pct; mvNotes(); },
      fail(text) { st.fail = text || t('pv.cantPlay'); done(); },
    }));
  }
}
function mvUsable(c) { const st = mv.state.get(mvKey(c)); return !!(st && st.ok); }

// ---------- набор <video> ----------
function mvNewEntry() {
  const el = document.createElement('video');
  el.className = 'mv-layer mv-off';
  el.preload = 'auto'; el.playsInline = true;
  keepSeeking(el);
  const e = {el, key: '', clip: null, ready: false, stop: null, lag: .08, t0: 0, used: 0};
  mvGain(e);   // сразу на шину: иначе первый миг звук шёл бы мимо ползунка и индикатора
  el.addEventListener('seeked', () => { if (e.t0) { e.lag = Math.min(Math.max((performance.now() - e.t0) / 1000, .02), .6); e.t0 = 0; } });
  mvCv.appendChild(el);
  mv.pool.push(e);
  return e;
}
function mvDetach(e) {
  if (e.stop) e.stop();
  e.stop = null; e.key = ''; e.ready = false;
}
function mvRelease(e) {
  e.clip = null;
  e.el.pause();
  e.el.classList.add('mv-off');
}
function mvBind(c) {
  const key = mvKey(c), free = mv.pool.filter(e => e.clip === null);
  let e = free.find(x => x.key === key);
  if (!e) {
    if (mv.pool.length < MV_POOL) e = mvNewEntry();
    else e = free.sort((a, b) => a.used - b.used)[0];
    if (!e) return null;
    mvDetach(e);
    const st = mv.state.get(key), me = e, it = mtFile(c.path);
    e.key = key;
    e.stop = attachMedia(e.el, c.path, !it || it.kind !== 'a', {
      proxy: st.proxy, rev: mvRev(c), scale: mvLowOf(c),
      ready() { if (me.key === key) { me.ready = true; mvShow(); } },
      wait() {},
      fail() {},
    });
  }
  e.clip = c.id;
  e.used = performance.now();
  return e;
}

// ---------- кадр на экране ----------
// id клипов, которые должны играть в момент x, снизу вверх
function mvActiveSig(x) {
  let s = '';
  for (const c of tkLive()) if (mvShown(c, x)) s += c.id + ',';
  return s;
}
function mvPicFor(c, z) {
  let el = mv.pics.get(c.id);
  if (!el) {
    el = document.createElement('img');
    el.className = 'mv-layer';
    el.alt = '';
    el.draggable = false;
    mvCv.appendChild(el);
    mv.pics.set(c.id, el);
  }
  el.dataset.z = z;   // слой дорожки z, место ставит mvPlace
  mvPlace(el, c);
  return el;
}
function mvPicSrc(el, url, fallback) {
  if (el.dataset.url === url) return;
  el.dataset.url = url;
  el.onerror = fallback ? () => { el.onerror = null; el.src = fallback; } : null;
  el.src = url;
}
function mvNotes() {
  if (mv.file) return;
  const all = tkClips();
  if (!all.length) { mvNote(t('mt.viewEmpty')); return; }
  const keys = new Set(all.filter(c => !tkPhoto(c)).map(mvKey));
  const list = [...keys].map(k => mv.state.get(k)).filter(Boolean);
  const fail = list.find(st => st.fail), wait = list.filter(st => !st.ok && !st.fail && st.proxy);
  if (fail) mvNote(fail.fail);
  else if (wait.length) mvNote(t('mt.preparing', {pct: Math.round(wait.reduce((a, st) => a + st.pct, 0) / wait.length)}));
  else if (mv.extra) mvNote(t('mt.tooLayers', {n: MV_LIVE}));
  else mvNote('');
}
function mvShow() {
  if (tab !== 'mont' || trs.it) return;
  if (mv.file) return;
  const all = tkClips(), now = performance.now(), x = tkAt;
  kfPoseAll(x);   // слои с ключами в позу этого момента (keyframes.js)
  mvStage.classList.toggle('canplay', all.length > 0);
  $('mtCtl').classList.toggle('off', !all.length);
  $('mtShot').disabled = !all.length;
  mvCv.classList.remove('hide');
  mvSizeCanvas();
  mvPrep();
  mv.tr = mvTrMap();
  // кто звучит и виден сейчас и кто скоро начнётся. У стыка с переходом клип виден и за своим краем (mvSpan)
  const active = [], soon = [];
  let vids = 0;
  mv.extra = false;
  tkTracks.forEach((tr, z) => tr.off || tr.clips.forEach(c => {
    const start = mvSpan(c)[0];
    if (mvShown(c, x)) {
      let frozen = false;
      if (tr.kind === 'v' && !tkPhoto(c) && ++vids > MV_LIVE) { frozen = true; mv.extra = true; }
      active.push({c, z, tr, frozen});
    } else if (mv.playing && start > x && start - x < MV_AHEAD) soon.push({c, z, tr});
  }));
  mv.shownAt = now;
  mv.sig = mvActiveSig(x);
  const wanted = new Set();
  for (const a of active) if (!tkPhoto(a.c) && !a.frozen && mvUsable(a.c)) wanted.add(a.c.id);
  for (const a of soon) if (!tkPhoto(a.c) && mvUsable(a.c)) wanted.add(a.c.id);
  for (const e of mv.pool) {
    if (e.clip === null) continue;
    const c = tkById(e.clip);
    if (!wanted.has(e.clip) || !c || mvKey(c) !== e.key) mvRelease(e);
  }
  mv.live = [];
  const keepPics = new Set();
  let picture = false;
  for (const a of active) {
    const {c, z, tr, frozen} = a, visual = tr.kind === 'v';
    let e = null;
    if (wanted.has(c.id)) e = mv.pool.find(p => p.clip === c.id) || mvBind(c);
    const on = !!(e && e.ready);
    if (e) {
      e.el.muted = mvMuted(c);
      e.el.classList.toggle('hide', !visual);
      e.el.classList.toggle('mv-off', !on);
      if (visual) { e.el.dataset.z = z; mvPlace(e.el, c); }
      if (on) mv.live.push({c, e});
    }
    if (!visual) continue;
    picture = true;
    if (on) continue;
    // фото, стоп-кадр лишнего слоя или кадр-заместитель, пока файл не готов
    const el = mvPicFor(c, z);
    el.classList.remove('hide');
    keepPics.add(c.id);
    if (tkPhoto(c)) mvPicSrc(el, mediaUrl(c.path), thumbUrl(c.path, 0, 1280));
    else if (!mv.playing || !el.dataset.url) mvPicSrc(el, thumbUrl(c.path, c.src ? Math.min(Math.max(mvSrc(c, x) / c.src, 0), 1).toFixed(3) : 0, 1280));
  }
  for (const a of soon) {
    const {c, z, tr} = a;
    if (tkPhoto(c)) {   // фото заранее, чтобы на стыке не мигало
      const el = mvPicFor(c, z);
      el.classList.add('hide');
      mvPicSrc(el, mediaUrl(c.path), thumbUrl(c.path, 0, 1280));
      keepPics.add(c.id);
    } else if (wanted.has(c.id)) {
      const e = mv.pool.find(p => p.clip === c.id) || mvBind(c);
      if (e) {
        e.el.classList.add('mv-off');
        e.el.classList.toggle('hide', tr.kind !== 'v');
        if (tr.kind === 'v') { e.el.dataset.z = z; mvPlace(e.el, c); }
        const t0 = Math.max(mvTime(c, mvSpan(c)[0]), 0);
        if (e.ready) {
          if (!e.el.paused) e.el.pause();
          if (Math.abs(e.el.currentTime - t0) > .02) videoSeek(e.el, t0);
        }
      }
    }
  }
  for (const [id, el] of mv.pics) if (!keepPics.has(id)) { el.remove(); mv.pics.delete(id); }
  // только звук: обложка или волна, как раньше. Звук от видеофайла картинку не показывает: её на этом месте нет и в результате
  const sound = !picture && active[0] && !active[0].c.part ? active[0] : null;
  mvPicture(sound ? thumbUrl(sound.c.path, 0, 1280) : '');
  for (const {c, e} of mv.live) mvSync(e, c, now);
  mvLook();
  mvNotes();
  mvFrameDraw();
}
// Один слой держится на курсоре времени
function mvSync(e, c, now) {
  const el = e.el, want = mvTime(c, tkAt), dur = el.duration || Infinity;
  if (!mv.playing || mv.holding) {
    if (!el.paused) el.pause();
    if (el.playbackRate !== c.speed) el.defaultPlaybackRate = el.playbackRate = c.speed;
    if (Math.abs(el.currentTime - Math.max(want, 0)) > .5 / mvFps(c)) videoSeek(el, Math.min(Math.max(want, 0), dur));
    return;
  }
  if (want >= dur - .02) {   // картинка в файле кончилась раньше клипа: держится последний кадр, как в результате
    if (!el.paused) el.pause();
    return;
  }
  if (want < 0) {   // стык с переходом раньше начала файла: держится первый кадр, как стоп-кадр в результате
    if (!el.paused) el.pause();
    if (el.currentTime > .5 / mvFps(c) && !el.seeking) videoSeek(el, 0);
    return;
  }
  if (el.seeking) return;
  const d = el.currentTime - want;
  let rate = c.speed;
  if (e !== mv.master) {   // ведущий звук не трогаем: на него равняются часы (mvFollow)
    if (Math.abs(d) > .25) {
      if (now - e.t0 > 400 || !e.t0) {
        e.t0 = now;
        videoSeek(el, Math.min(want + e.lag * c.speed, dur));   // с запасом на время самой перемотки
      }
    } else if (Math.abs(d) > (el.muted ? .03 : .06)) rate = c.speed * (1 - Math.max(Math.min(d, .05), -.05));
  }
  // Подгонка без сохранения высоты: растягивание времени с сохранением высоты слышно как плавающие помехи.
  // При своей скорости клипа высота сохраняется, как в результате.
  const keepPitch = c.speed !== 1;
  if (el.preservesPitch !== keepPitch) el.preservesPitch = keepPitch;
  if (Math.abs(el.playbackRate - rate) > .001) el.playbackRate = rate;
  if (el.paused) el.play().catch(() => {});
}
// Часы просмотра идут за звуком, а не звук за часами: перемотки и смены скорости на слух заметны, а сдвиг линии кадра на сотые нет
function mvFollow() {
  mv.master = null;
  for (const {c, e} of mv.live) {
    const el = e.el;
    if (el.muted || el.paused || el.seeking || el.readyState < 3) continue;
    const d = (el.currentTime - mvTime(c, tkAt)) / c.speed;
    if (Math.abs(d) >= .5) continue;   // только что подключился: пусть сначала встанет на место
    mv.master = e;
    tkAt = Math.max(tkAt + (Math.abs(d) > .1 ? d : d * .1), 0);
    return;
  }
}
function mvUnload() {
  mvFileOff(true);
  mv.pool.forEach(e => { mvDetach(e); e.el.remove(); });
  mv.pool = []; mv.live = [];
  for (const stop of mv.probes.values()) stop();
  for (const key of mv.probes.keys()) mv.state.delete(key);
  mv.probes.clear();
  for (const el of mv.pics.values()) el.remove();
  mv.pics.clear();
  for (const div of mv.trBg.values()) div.remove();
  mv.trBg.clear();
  mvPicture('');
  mvNote('');
  mvFrame.classList.add('hide');
  mvStage.classList.remove('framed');
}
const mvRangeStart = () => tkIn !== null ? tkIn : 0;
const mvRangeEnd = () => tkOut !== null ? Math.min(tkOut, tkTotal()) : tkTotal();
function mvTick(now) {
  if (!mv.playing) return;
  mv.raf = requestAnimationFrame(mvTick);
  if (mv.holding) {   // начало: все слои встали на место, стартуем вместе
    const ready = mv.pool.every(e => {
      const c = e.clip !== null && tkById(e.clip);
      return !c || !mvShown(c, tkAt) || (e.ready && !e.el.seeking && e.el.readyState >= 2);
    });
    if (!ready && now < mv.holdTo) return;
    mv.holding = false;
    mv.last = now;
    mvShow();
    return;
  }
  tkAt += Math.min(Math.max((now - mv.last) / 1000, 0), .25);
  mv.last = now;
  mvFollow();
  const end = mv.loop ? mvRangeEnd() : tkTotal();
  if (tkAt >= end) {
    if (mv.loop) { tkAt = mvRangeStart(); mvShow(); }
    else { tkAt = end; mvPause(); return; }
  } else if (now - mv.shownAt > 250 || mvActiveSig(tkAt) !== mv.sig) mvShow();
  else for (const {c, e} of mv.live) mvSync(e, c, now);
  for (const tr of tkTracks) if (tr.kind === 'v' && !tr.off) for (const c of tr.clips) if (c.kf && mvShown(c, tkAt)) { kfPose(c, tkAt); mvPlaceClip(c); }   // ключи на каждом кадре
  mvLook();
  tkDrawHead(true);
}
function mvPlay() {
  mvAudio();
  if (mv.file) { if (mv.fileReady) mtV.play().catch(() => {}); return; }
  if (!tkClips().length || mv.playing) return;
  if (tkAt >= tkTotal() - 1e-3) tkAt = mv.loop ? mvRangeStart() : 0;
  mv.playing = true;
  vuKick();
  mv.holding = true;
  mv.holdTo = performance.now() + 1500;
  $('mtPlay').classList.add('playing');
  mvStage.classList.add('playing');
  mvShow();
  mv.raf = requestAnimationFrame(mvTick);
}
function mvPause() {
  if (mv.file) { mtV.pause(); return; }
  if (!mv.playing) return;
  mv.playing = false;
  mv.holding = false;
  mv.master = null;
  cancelAnimationFrame(mv.raf);
  $('mtPlay').classList.remove('playing');
  mvStage.classList.remove('playing');
  mv.pool.forEach(e => e.el.pause());
  tkAt = tkRound(tkAt);
  tkDrawHead();
  mvShow();
}
const mvToggle = () => {
  if (mv.file) { if (mtV.paused) mvPlay(); else mtV.pause(); return; }
  if (mv.playing) mvPause(); else mvPlay();
};
function mvStep(d) {
  if (mv.file) { mtV.pause(); videoSeek(mtV, Math.max(mtV.currentTime + d, 0)); return; }
  mvPause();
  tkSeek(tkAt + d);
}
// щелчок запускает просмотр только у файла из окна файлов; в монтаже он выбирает слой (см. рамку ниже)
mvStage.addEventListener('click', e => { if (mv.file && !e.target.closest('#mvTag')) mvToggle(); });
$('mtPlay').onclick = mvToggle;
$('mtStart').onclick = () => { if (mv.file) { mtV.pause(); videoSeek(mtV, 0); return; } mvPause(); tkSeek(0); };
$('mtEnd').onclick = () => { if (mv.file) { mtV.pause(); videoSeek(mtV, mtV.duration || 0); return; } mvPause(); tkSeek(tkTotal()); };
$('mtPrev').onclick = () => mvStep(-1 / (mv.file ? mv.file.fps || 30 : tkFps()));
$('mtNext').onclick = () => mvStep(1 / (mv.file ? mv.file.fps || 30 : tkFps()));
$('mtLoop').onclick = () => { mv.loop = !mv.loop; mtV.loop = mv.loop; $('mtLoop').classList.toggle('on', mv.loop); };
$('mtShot').onclick = async () => {
  if (mv.file) { if (mv.fileReady) saveShot($('mtShot'), mtV, mv.file.path); return; }
  const btn = $('mtShot');
  btn.disabled = true;
  const r = await api('snapshot-montage', {project: mtProject().project, at: Math.min(tkAt, Math.max(tkTotal() - 1 / tkFps(), 0))});
  btn.disabled = false;
  shotDone(r);
};

// ---------- рамка выбранного слоя ----------
// какой слой можно тянуть прямо сейчас: один выбранный, видимый, на паузе
function mvFrameClip() {
  if (mv.file || mv.playing || trs.it) return null;
  const c = tkOne();
  return c && mvUnder(c, tkAt) && tkTrackOf(c).kind === 'v' && !tkTrackOf(c).off ? c : null;
}
function mvFrameDraw() {
  const c = mvFrameClip();
  mvFrame.classList.toggle('hide', !c);
  mvStage.classList.toggle('framed', !!c);
  if (!c) { mvOffDraw(null); return; }
  // рамка обводит то, что осталось после кадрирования, и поворачивается вокруг середины всего слоя
  const b = mvBox(c), o = mvCropOf(c), W = mvCv.offsetWidth, H = mvCv.offsetHeight, bw = b.w * W, bh = b.h * H;
  const top = mvCv.offsetTop + b.y * H + o.t * bh;
  mvFrame.classList.toggle('crop', mv.crop === c.id);
  mvFrame.classList.toggle('text', !!c.text && mv.crop !== c.id);   // у надписи ручки и на сторонах, как у субтитров
  mvFrame.classList.toggle('rotin', top < 26);   // ручке поворота нет места над кадром
  Object.assign(mvFrame.style, {left: mvCv.offsetLeft + b.x * W + o.l * bw + 'px', top: top + 'px', width: (1 - o.l - o.r) * bw + 'px', height: (1 - o.t - o.b) * bh + 'px',
    transformOrigin: `${(.5 - o.l) * bw}px ${(.5 - o.t) * bh}px`, transform: c.rot ? `rotate(${c.rot}deg)` : ''});
  mvOffDraw(c);   // слой целиком вне вида: стрелка у края (viewzoom.js)
}
// на сколько сдвинуть, чтобы одно из значений list встало на край или середину кадра, а с axis ещё и на направляющую
function mvSnap(list, px, axis) {
  let best = 0, at = -1, lim = 12 / px;
  if (tkSnapOn) for (const a of list) for (const p of [0, .5, 1, ...(axis ? mvGuidePts(axis) : [])]) {
    const d = Math.abs(p - a);
    if (d <= lim) { lim = d; best = p - a; at = p; }
  }
  return {d: best, at};
}
function mvGuides(ax, ay) {
  const W = mvCv.offsetWidth, H = mvCv.offsetHeight, gx = $('mvGuideX'), gy = $('mvGuideY');
  gx.classList.toggle('hide', ax < 0);
  gy.classList.toggle('hide', ay < 0);
  if (ax >= 0) Object.assign(gx.style, {left: mvCv.offsetLeft + ax * W + 'px', top: mvCv.offsetTop + 'px', height: H + 'px'});
  if (ay >= 0) Object.assign(gy.style, {top: mvCv.offsetTop + ay * H + 'px', left: mvCv.offsetLeft + 'px', width: W + 'px'});
}
function mvPlaceClip(c) {
  const e = mv.pool.find(p => p.clip === c.id), pic = mv.pics.get(c.id);
  if (e) mvPlace(e.el, c);
  if (pic) mvPlace(pic, c);
}
// MV_FAR: слой можно увести за кадр целиком, но не дальше размера кадра от края (как tlFarOut в timeline.go)
const MV_MIN_BOX = .02, MV_MAX_BOX = 4, MV_FAR = 1, MV_MAX_CROP = .98;
function mvSetBox(c, x, y, w, h) {
  w = Math.min(Math.max(w, MV_MIN_BOX), MV_MAX_BOX); h = Math.min(Math.max(h, MV_MIN_BOX), MV_MAX_BOX);
  const resized = c.w !== w || c.h !== h;
  c.w = w; c.h = h;
  if (resized && c.text && c.text.box) mtTextBoxMove(c);
  c.x = Math.min(Math.max(x, -MV_FAR - w), 1 + MV_FAR);
  c.y = Math.min(Math.max(y, -MV_FAR - h), 1 + MV_FAR);
}
// попала ли мышь в то, что видно от клипа
function mvInside(c, ev) {
  const r = mvCv.getBoundingClientRect(), b = mvBox(c), o = mvCropOf(c), a = -(c.rot || 0) * Math.PI / 180;
  const dx = ev.clientX - r.left - (b.x + b.w / 2) * r.width, dy = ev.clientY - r.top - (b.y + b.h / 2) * r.height;
  const u = (dx * Math.cos(a) - dy * Math.sin(a)) / (b.w * r.width) + .5, v = (dx * Math.sin(a) + dy * Math.cos(a)) / (b.h * r.height) + .5;
  return u >= o.l && u <= 1 - o.r && v >= o.t && v <= 1 - o.b;
}
// верхний слой под мышью в текущий момент
function mvHit(ev) {
  for (const tr of tkShown()) {
    if (tr.kind !== 'v' || tr.off) continue;
    const c = tr.clips.find(q => mvUnder(q, tkAt));
    if (c && mvInside(c, ev)) return c;
  }
  return null;
}
// pick: кого выбрать, если мышь так и не сдвинулась (щелчок по выбранному слою, над которым лежит другой)
function mvFrameDrag(e, c, corner, pick) {
  const before = tkState(), W = mvCv.offsetWidth, H = mvCv.offsetHeight, o = mvBox(c), x0 = e.clientX, y0 = e.clientY;
  const left = corner && corner.includes('w'), up = corner && corner.includes('n'), cut = mvCropOf(c);
  const rad = (c.rot || 0) * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  const ow = o.w * W, oh = o.h * H, ocx = (o.x + o.w / 2) * W, ocy = (o.y + o.h / 2) * H;
  // доли слоя: угол, который стоит на месте, и угол под мышью
  const fu = left ? 1 - cut.r : cut.l, fv = up ? 1 - cut.b : cut.t, mu = left ? cut.l : 1 - cut.r, mw = up ? cut.t : 1 - cut.b;
  const world = (u, v, w, h) => [(u - .5) * w * cos - (v - .5) * h * sin, (u - .5) * w * sin + (v - .5) * h * cos];
  const [fdx, fdy] = world(fu, fv, ow, oh), [mdx, mdy] = world(mu, mw, ow, oh);
  const fixX = ocx + fdx, fixY = ocy + fdy, startX = ocx + mdx, startY = ocy + mdy;
  const seenW = (1 - cut.l - cut.r) * ow, seenH = (1 - cut.t - cut.b) * oh;
  let on = false;
  const set = (x, y, w, h) => mvSetBox(c, x, y, w, h);
  const move = ev => {
    if (ev.pointerId !== e.pointerId) return;
    const dx = (ev.clientX - x0) / W, dy = (ev.clientY - y0) / H;
    if (!on && Math.hypot(ev.clientX - x0, ev.clientY - y0) < KIN.drag) return;
    if (!on && corner && c.text && !c.text.box) mtTextBoxed(c);
    on = true;
    if (!corner) {
      // повёрнутый слой прилипает серединой, остальной по тому, что видно
      const seen = (a, s, l, r) => c.rot ? [a + s / 2] : [a + s * l, a + s * (l + 1 - r) / 2, a + s * (1 - r)];
      const sx = mvSnap(seen(o.x + dx, o.w, cut.l, cut.r), W, 'x'), sy = mvSnap(seen(o.y + dy, o.h, cut.t, cut.b), H, 'y');
      set(o.x + dx + sx.d, o.y + dy + sy.d, o.w, o.h);
      mvGuides(sx.at, sy.at);
    } else {
      // угол под мышью; в повёрнутом слое размеры считаются вдоль его сторон, прилипания нет
      const mx = startX + ev.clientX - x0, my = startY + ev.clientY - y0, none = {d: 0, at: -1};
      const sx = c.rot ? none : mvSnap([mx / W], W, 'x'), sy = c.rot ? none : mvSnap([my / H], H, 'y');
      const local = (ax, ay) => [(ax - fixX) * cos + (ay - fixY) * sin, -(ax - fixX) * sin + (ay - fixY) * cos];
      const [lx, ly] = local(mx, my), [lxs, lys] = local(mx + sx.d * W, my + sy.d * H);
      const kx = v => (left ? -v : v) / seenW, ky = v => (up ? -v : v) / seenH;
      let sw, sh, gx = -1, gy = -1;
      if (ev.shiftKey || c.text) {   // свободно: каждая сторона сама по себе; у текста рамка всегда свободна
        // ручка на стороне (есть только у текста) меняет один размер, другой остаётся
        const horz = corner.length > 1 || /[we]/.test(corner), vert = corner.length > 1 || /[ns]/.test(corner);
        sw = horz ? kx(lxs) : 1; sh = vert ? ky(lys) : 1;
        gx = horz ? sx.at : -1; gy = vert ? sy.at : -1;
      } else {   // пропорции те же, ведёт та сторона, что изменилась сильнее
        let s = Math.max(kx(lx), ky(ly));
        if (sx.at >= 0) { s = kx(lxs); gx = sx.at; }
        else if (sy.at >= 0) { s = ky(lys); gy = sy.at; }
        sw = sh = Math.min(Math.max(s, Math.max(MV_MIN_BOX / o.w, MV_MIN_BOX / o.h)), Math.min(MV_MAX_BOX / o.w, MV_MAX_BOX / o.h));
      }
      const nw = Math.min(Math.max(o.w * sw, MV_MIN_BOX), MV_MAX_BOX), nh = Math.min(Math.max(o.h * sh, MV_MIN_BOX), MV_MAX_BOX);
      const [ndx, ndy] = world(fu, fv, nw * W, nh * H), cx = (fixX - ndx) / W, cy = (fixY - ndy) / H;
      set(cx - nw / 2, cy - nh / 2, nw, nh);
      mvGuides(gx, gy);
    }
    mvPlaceClip(c);
    mvFrameDraw();
    mtFramePanel();
  };
  const end = ev => {
    if (ev.pointerId !== e.pointerId) return;
    mvStage.removeEventListener('pointermove', move);
    mvStage.removeEventListener('pointerup', end);
    mvStage.removeEventListener('pointercancel', end);
    mvGuides(-1, -1);
    if (on) tkCommit(before);
    else if (pick && pick !== c) { tkSel = new Set(tkIds(pick)); tkSelChanged(); }
  };
  mvStage.setPointerCapture(e.pointerId);
  mvStage.addEventListener('pointermove', move);
  mvStage.addEventListener('pointerup', end);
  mvStage.addEventListener('pointercancel', end);
}
// Общая часть ручек поворота и кадрирования: отмена одним шагом и своя реакция на движение
function mvHandleDrag(e, c, step) {
  const before = tkState();
  let on = false;
  const move = ev => {
    if (ev.pointerId !== e.pointerId) return;
    on = true;
    step(ev);
    mvPlaceClip(c);
    mvFrameDraw();
    mtFramePanel();
  };
  const end = ev => {
    if (ev.pointerId !== e.pointerId) return;
    mvStage.removeEventListener('pointermove', move);
    mvStage.removeEventListener('pointerup', end);
    mvStage.removeEventListener('pointercancel', end);
    if (on) tkCommit(before);
  };
  mvStage.setPointerCapture(e.pointerId);
  mvStage.addEventListener('pointermove', move);
  mvStage.addEventListener('pointerup', end);
  mvStage.addEventListener('pointercancel', end);
}
const mvRotNorm = a => { a = ((a % 360) + 360) % 360; return +(a > 180 ? a - 360 : a).toFixed(1); };
// Поворот мышью: Shift даёт шаги по 15°, с прилипанием прямые углы ловятся сами
function mvRotDrag(e, c) {
  const r = mvCv.getBoundingClientRect(), b = mvBox(c), cx = r.left + (b.x + b.w / 2) * r.width, cy = r.top + (b.y + b.h / 2) * r.height;
  const at = ev => Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180 / Math.PI;
  const a0 = at(e), r0 = c.rot || 0;
  mvHandleDrag(e, c, ev => {
    let a = r0 + at(ev) - a0;
    if (ev.shiftKey) a = Math.round(a / 15) * 15;
    else if (tkSnapOn && Math.abs(a - Math.round(a / 90) * 90) < 3) a = Math.round(a / 90) * 90;
    a = mvRotNorm(a);
    if (a) c.rot = a; else delete c.rot;
  });
}
// Кадрирование мышью: края уходят внутрь слоя, сам слой стоит на месте
function mvCropDrag(e, c, side) {
  const r = mvCv.getBoundingClientRect(), b = mvBox(c), o = mvCropOf(c), a = (c.rot || 0) * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
  const w = b.w * r.width, h = b.h * r.height, x0 = e.clientX, y0 = e.clientY;
  const put = (key, v) => { if (v > 1e-4) c[key] = v; else delete c[key]; };
  mvHandleDrag(e, c, ev => {
    const dx = ev.clientX - x0, dy = ev.clientY - y0, du = (dx * cos + dy * sin) / w, dv = (-dx * sin + dy * cos) / h;
    if (side.includes('w')) put('cl', Math.min(Math.max(o.l + du, 0), MV_MAX_CROP - o.r));
    if (side.includes('e')) put('cr', Math.min(Math.max(o.r - du, 0), MV_MAX_CROP - o.l));
    if (side.includes('n')) put('ct', Math.min(Math.max(o.t + dv, 0), MV_MAX_CROP - o.b));
    if (side.includes('s')) put('cb', Math.min(Math.max(o.b - dv, 0), MV_MAX_CROP - o.t));
  });
}
// Нажатие сразу выбирает слой под мышью, и его можно тянуть, не отпуская кнопку. Мимо слоёв — выбор снимается.
mvStage.addEventListener('pointerdown', e => {
  if (e.button !== 0 || mv.file || chromaPick) return;
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  // слой, прилипший к направляющей, лежит ручками прямо на ней: ручка важнее
  const gl = e.target.closest('.mv-gl');
  const h = gl ? document.elementsFromPoint(e.clientX, e.clientY).find(el => el.dataset.c) : e.target.closest('[data-c]');
  if (gl && !h) { mvGuideDrag(e, gl.dataset.a, +gl.dataset.i); return; }
  const sub = !h && mvSubsAt(e);
  if (sub) { mvSubsPress(e, sub); return; }
  if (mvSubsSel) { mvSubsSel = false; mvSubsDraw(); }
  if (!tkClips().length) return;
  if (mv.playing) mvPause();
  const cur = mvFrameClip(), top = mvHit(e);
  if (cur && h) {
    e.preventDefault();
    if (h.dataset.c === 'rot') mvRotDrag(e, cur);
    else if (mv.crop === cur.id) mvCropDrag(e, cur, h.dataset.c);
    else mvFrameDrag(e, cur, h.dataset.c);
    return;
  }
  if (cur && mvInside(cur, e)) { e.preventDefault(); mvFrameDrag(e, cur, '', top); return; }
  if (!top) { if (tkSel.size) { tkSel.clear(); tkSelChanged(); } return; }
  e.preventDefault();
  tkSel = new Set(tkIds(top));
  tkSelChanged();
  mvFrameDrag(e, top, '');
});
// двойной щелчок: как было, вписан в кадр по центру
mvStage.addEventListener('dblclick', e => {
  const c = mvFrameClip();
  if (!c || !(c.w > 0) || !mvInside(c, e)) return;
  tkDo(() => { delete c.x; delete c.y; delete c.w; delete c.h; });
});

// ---------- просмотр файла из окна файлов, до постановки на дорожку ----------
function mvFileDraw() {
  if (!mv.file) return;
  const d = mtV.duration || 0, at = mtV.currentTime || 0;
  $('mtNow').textContent = fmtTc(at);
  $('mtDur').textContent = fmtTc(d);
  const bar = $('mvSeek');
  if (document.activeElement !== bar) bar.value = d ? at / d * 1000 : 0;
  $('mtPlay').classList.toggle('playing', !mtV.paused);
  mvStage.classList.toggle('playing', !mtV.paused);
}
['timeupdate', 'seeked', 'play', 'pause', 'durationchange'].forEach(n => mtV.addEventListener(n, mvFileDraw));
mtV.addEventListener('play', vuKick);
function mvFileShow(it) {
  if (it.bad || !it.kind) { say('warn', t('mt.noDurTitle'), t('mt.noDur')); return; }
  if (mv.file === it) return;
  if (mv.playing) mvPause();
  mvFileOff(true);
  mv.pool.forEach(e => { if (e.clip !== null) mvRelease(e); });
  mv.file = it;
  mv.fileReady = false;
  mvRulersDraw();
  mvFrame.classList.add('hide');
  mvStage.classList.remove('framed');
  mvStage.classList.add('canplay', 'filemode');
  $('mtCtl').classList.remove('off');
  mvCv.classList.add('hide');
  $('mvTagName').textContent = it.name;
  $('mvTag').classList.remove('hide');
  $('mtShot').disabled = true;
  const me = it;
  if (it.kind === 'p') {
    mvStage.classList.remove('canplay');
    mvPicture(mediaUrl(it.path), thumbUrl(it.path, 0, 1280));
    $('mtNow').textContent = $('mtDur').textContent = fmtTc(0);
    mvNote('');
  } else {
    $('mvSeek').classList.remove('hide');
    mvPicture(it.kind === 'a' ? thumbUrl(it.path, 0, 1280) : '');
    mv.fileStop = attachMedia(mtV, it.path, it.kind !== 'a', {
      ready() { if (mv.file !== me) return; mv.fileReady = true; mvNote(''); mtV.classList.toggle('hide', it.kind === 'a'); $('mtShot').disabled = it.kind === 'a'; mvFileDraw(); },
      wait(pct) { if (mv.file === me) mvNote(t('pv.preparing', {pct: Math.round(pct)})); },
      fail(text) { if (mv.file === me) mvNote(text); },
    });
  }
  mtRender();
}
function mvFileOff(quiet) {
  if (!mv.file) return;
  if (mv.fileStop) mv.fileStop();
  mv.fileStop = null;
  mv.file = null;
  mvSizeCanvas();
  mv.fileReady = false;
  mtV.classList.add('hide');
  $('mvSeek').classList.add('hide');
  $('mvTag').classList.add('hide');
  mvStage.classList.remove('filemode', 'playing');
  $('mtPlay').classList.remove('playing');
  mvPicture('');
  if (quiet === true) return;
  mtRender();
  tkDrawHead();
  mvShow();
}
// ---------- размер холста: кнопка под вьюпортом ----------
const MV_SIZES = () => [[1920, 1080, t('mv.canvasHd')], [3840, 2160, t('mv.canvas4k')], [1080, 1920, t('mv.canvasV')], [1080, 1080, t('mv.canvasSq')], [1080, 1350, t('mv.canvasPost')]];
const mvSideFit = v => Math.min(Math.max(Math.round((+v || 0) / 2) * 2, 16), 7680);
function mvRatio(d) {
  const r = [[16, 9], [9, 16], [1, 1], [4, 5], [4, 3], [3, 4], [21, 9]].find(([a, b]) => Math.abs(d.w / d.h - a / b) < .01);
  return r ? r[0] + ':' + r[1] : '';
}
function mvCanvasBtn() {
  const d = mvCanvasDims(), ratio = mvRatio(d);
  $('mvCanvasRatio').textContent = ratio;
  $('mvCanvasRatio').classList.toggle('hide', !ratio);
  $('mvCanvasSize').textContent = d.w + '×' + d.h;
  $('mvCanvasBtn').classList.toggle('on', !!tkCanvas);
}
function mvCanvasMenu() {
  const cur = tkCanvas;
  const row = (w, h, name, on) => `<button class="mv-cm-row${on ? ' on' : ''}" data-w="${w}" data-h="${h}"><span>${esc(name)}</span><em>${w ? w + '×' + h : ''}</em></button>`;
  $('mvCanvasList').innerHTML = row(0, 0, t('mv.canvasAuto'), !cur) +
    MV_SIZES().map(([w, h, name]) => row(w, h, name, cur && cur.w === w && cur.h === h)).join('');
  const d = mvCanvasDims();
  $('mvCanvasW').value = d.w;
  $('mvCanvasH').value = d.h;
}
function mvCanvasClose() { $('mvCanvasPop').classList.add('hide'); }
$('mvCanvasBtn').onclick = e => {
  e.stopPropagation();
  const open = $('mvCanvasPop').classList.contains('hide');
  if (open) mvCanvasMenu();
  $('mvCanvasPop').classList.toggle('hide', !open);
};
$('mvCanvasList').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  mvSetCanvas(+b.dataset.w ? {w: +b.dataset.w, h: +b.dataset.h} : null);
  mvCanvasClose();
});
const mvCanvasOwn = () => { mvSetCanvas({w: mvSideFit($('mvCanvasW').value), h: mvSideFit($('mvCanvasH').value)}); mvCanvasClose(); };
$('mvCanvasOk').onclick = mvCanvasOwn;
['mvCanvasW', 'mvCanvasH'].forEach(id => $(id).addEventListener('keydown', e => { if (e.key === 'Enter') mvCanvasOwn(); }));
document.addEventListener('pointerdown', e => { if (!e.target.closest('#mvCanvasPop,#mvCanvasBtn')) mvCanvasClose(); });

$('mvSeek').addEventListener('input', () => { if (mtV.duration) videoSeek(mtV, $('mvSeek').value / 1000 * mtV.duration); });
$('mvSeek').addEventListener('change', () => $('mvSeek').blur());
$('mvTagOff').onclick = () => mvFileOff();
