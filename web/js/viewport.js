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
};
bindVolume(mtV, $('mtMute'), $('mtVol'));   // громкость общая: mtV здесь хранит значение для всех слоёв
keepSeeking(mtV);
trackFrame(mtV);
// картинка из связанной пары молчит: её звук играет свой клип на звуковой дорожке
const mvMuted = c => mtV.muted || !!(c && c.part === 'v');
function mvVolume() { mv.pool.forEach(e => { e.el.volume = mtV.volume; e.el.muted = mvMuted(e.clip !== null && tkById(e.clip)); }); }
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
const mvKey = c => c.reverse ? `${mtKey(c.path)}|${c.from.toFixed(3)}|${c.len.toFixed(3)}` : mtKey(c.path);
const mvFps = c => { const it = mtFile(c.path); return it && it.fps > 0 ? it.fps : 30; };

// ---------- холст: тот же размер, что выберет движок (tlCanvas) ----------
function mvCanvasDims() {
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
  const d = mvCanvasDims(), W = mvStage.clientWidth, H = mvStage.clientHeight;
  const s = Math.min(W / d.w, H / d.h) || 0, w = Math.round(d.w * s), h = Math.round(d.h * s);
  Object.assign(mvCv.style, {width: w + 'px', height: h + 'px', left: Math.floor((W - w) / 2) + 'px', top: Math.floor((H - h) / 2) + 'px'});
}
new ResizeObserver(() => { if (tab === 'mont') { mvSizeCanvas(); mvFrameDraw(); } }).observe(mvStage);
// Рамка слоя в долях холста. Без своей рамки слой вписан по центру, как делает движок.
function mvBox(c) {
  if (c.w > 0) return {x: c.x || 0, y: c.y || 0, w: c.w, h: c.h};
  const d = mvCanvasDims(), it = mtFile(c.path) || {};
  if (!(it.w > 0)) return {x: 0, y: 0, w: 1, h: 1};
  const s = Math.min(d.w / it.w, d.h / it.h), w = it.w * s / d.w, h = it.h * s / d.h;
  return {x: (1 - w) / 2, y: (1 - h) / 2, w, h};
}
function mvPlace(el, c) {
  const b = mvBox(c);
  Object.assign(el.style, {left: b.x * 100 + '%', top: b.y * 100 + '%', width: b.w * 100 + '%', height: b.h * 100 + '%', objectFit: c.w > 0 ? 'fill' : 'contain'});
}

// ---------- проверка файлов: что окно играет само, а для чего нужна копия. Идёт заранее, чтобы копия была готова к своему месту ----------
function mvPrep() {
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
    mv.probes.set(key, attachMedia(el, c.path, mtFile(c.path).kind !== 'a', {
      rev: mvRev(c),
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
  el.volume = mtV.volume; el.muted = mtV.muted;
  keepSeeking(el);
  const e = {el, key: '', clip: null, ready: false, stop: null, lag: .08, t0: 0, used: 0};
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
      proxy: st.proxy, rev: mvRev(c),
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
  for (const c of tkLive()) if (mvUnder(c, x)) s += c.id + ',';
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
  el.style.zIndex = z + 1;
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
  mvStage.classList.toggle('canplay', all.length > 0);
  $('mtCtl').classList.toggle('off', !all.length);
  $('mtShot').disabled = !all.length;
  mvCv.classList.remove('hide');
  mvSizeCanvas();
  mvPrep();
  // кто звучит и виден сейчас и кто скоро начнётся
  const active = [], soon = [];
  let vids = 0;
  mv.extra = false;
  tkTracks.forEach((tr, z) => tr.off || tr.clips.forEach(c => {
    if (mvUnder(c, x)) {
      let frozen = false;
      if (tr.kind === 'v' && !tkPhoto(c) && ++vids > MV_LIVE) { frozen = true; mv.extra = true; }
      active.push({c, z, tr, frozen});
    } else if (mv.playing && c.at > x && c.at - x < MV_AHEAD) soon.push({c, z, tr});
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
      if (visual) { e.el.style.zIndex = z + 1; mvPlace(e.el, c); }
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
    else if (!mv.playing || !el.dataset.url) mvPicSrc(el, thumbUrl(c.path, c.src ? (mvSrc(c, x) / c.src).toFixed(3) : 0, 1280));
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
        if (tr.kind === 'v') { e.el.style.zIndex = z + 1; mvPlace(e.el, c); }
        if (e.ready) {
          if (!e.el.paused) e.el.pause();
          if (Math.abs(e.el.currentTime - mvTime(c, c.at)) > .02) videoSeek(e.el, mvTime(c, c.at));
        }
      }
    }
  }
  for (const [id, el] of mv.pics) if (!keepPics.has(id)) { el.remove(); mv.pics.delete(id); }
  // только звук: обложка или волна, как раньше. Звук от видеофайла картинку не показывает: её на этом месте нет и в результате
  const sound = !picture && active[0] && !active[0].c.part ? active[0] : null;
  mvPicture(sound ? thumbUrl(sound.c.path, 0, 1280) : '');
  for (const {c, e} of mv.live) mvSync(e, c, now);
  mvNotes();
  mvFrameDraw();
}
// Один слой держится на курсоре времени
function mvSync(e, c, now) {
  const el = e.el, want = mvTime(c, tkAt), dur = el.duration || Infinity;
  if (!mv.playing || mv.holding) {
    if (!el.paused) el.pause();
    if (el.playbackRate !== c.speed) el.defaultPlaybackRate = el.playbackRate = c.speed;
    if (Math.abs(el.currentTime - want) > .5 / mvFps(c)) videoSeek(el, Math.min(want, dur));
    return;
  }
  if (want >= dur - .02) {   // картинка в файле кончилась раньше клипа: держится последний кадр, как в результате
    if (!el.paused) el.pause();
    return;
  }
  if (el.seeking) return;
  const d = el.currentTime - want;
  let rate = c.speed;
  if (Math.abs(d) > .25) {
    if (now - e.t0 > 400 || !e.t0) {
      e.t0 = now;
      videoSeek(el, Math.min(want + e.lag * c.speed, dur));   // с запасом на время самой перемотки
    }
  } else if (Math.abs(d) > .03) rate = c.speed * (1 - Math.max(Math.min(d, .05), -.05));
  if (Math.abs(el.playbackRate - rate) > .001) el.playbackRate = rate;
  if (el.paused) el.play().catch(() => {});
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
      return !c || !mvUnder(c, tkAt) || (e.ready && !e.el.seeking && e.el.readyState >= 2);
    });
    if (!ready && now < mv.holdTo) return;
    mv.holding = false;
    mv.last = now;
    mvShow();
    return;
  }
  tkAt += Math.min(Math.max((now - mv.last) / 1000, 0), .25);
  mv.last = now;
  const end = mv.loop ? mvRangeEnd() : tkTotal();
  if (tkAt >= end) {
    if (mv.loop) { tkAt = mvRangeStart(); mvShow(); }
    else { tkAt = end; mvPause(); return; }
  } else if (now - mv.shownAt > 250 || mvActiveSig(tkAt) !== mv.sig) mvShow();
  else for (const {c, e} of mv.live) mvSync(e, c, now);
  tkDrawHead(true);
}
function mvPlay() {
  if (mv.file) { if (mv.fileReady) mtV.play().catch(() => {}); return; }
  if (!tkClips().length || mv.playing) return;
  if (tkAt >= tkTotal() - 1e-3) tkAt = mv.loop ? mvRangeStart() : 0;
  mv.playing = true;
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
  if (!c) return;
  const b = mvBox(c), W = mvCv.offsetWidth, H = mvCv.offsetHeight;
  Object.assign(mvFrame.style, {left: mvCv.offsetLeft + b.x * W + 'px', top: mvCv.offsetTop + b.y * H + 'px', width: b.w * W + 'px', height: b.h * H + 'px'});
}
// на сколько сдвинуть, чтобы одно из значений list встало на край или середину кадра
function mvSnap(list, px) {
  let best = 0, at = -1, lim = 8 / px;
  if (tkSnapOn) for (const a of list) for (const p of [0, .5, 1]) {
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
const MV_MIN_BOX = .02, MV_MAX_BOX = 4, MV_SEEN = .01;
// попала ли мышь в рамку клипа
function mvInside(c, ev) {
  const r = mvCv.getBoundingClientRect(), b = mvBox(c), x = (ev.clientX - r.left) / r.width, y = (ev.clientY - r.top) / r.height;
  return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
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
  const left = corner && corner.includes('w'), up = corner && corner.includes('n');
  const ax = left ? o.x + o.w : o.x, ay = up ? o.y + o.h : o.y;   // угол, который стоит на месте
  let on = false;
  const set = (x, y, w, h) => {
    w = Math.min(Math.max(w, MV_MIN_BOX), MV_MAX_BOX); h = Math.min(Math.max(h, MV_MIN_BOX), MV_MAX_BOX);
    c.w = w; c.h = h;
    c.x = Math.min(Math.max(x, MV_SEEN - w), 1 - MV_SEEN);
    c.y = Math.min(Math.max(y, MV_SEEN - h), 1 - MV_SEEN);
  };
  const move = ev => {
    if (ev.pointerId !== e.pointerId) return;
    const dx = (ev.clientX - x0) / W, dy = (ev.clientY - y0) / H;
    if (!on && Math.hypot(ev.clientX - x0, ev.clientY - y0) < KIN.drag) return;
    on = true;
    if (!corner) {
      const sx = mvSnap([o.x + dx, o.x + dx + o.w / 2, o.x + dx + o.w], W), sy = mvSnap([o.y + dy, o.y + dy + o.h / 2, o.y + dy + o.h], H);
      set(o.x + dx + sx.d, o.y + dy + sy.d, o.w, o.h);
      mvGuides(sx.at, sy.at);
    } else {
      let mx = (left ? o.x : o.x + o.w) + dx, my = (up ? o.y : o.y + o.h) + dy;
      const sx = mvSnap([mx], W), sy = mvSnap([my], H);
      let nw = left ? ax - mx : mx - ax, nh = up ? ay - my : my - ay, gx = -1, gy = -1;
      if (ev.shiftKey) {   // свободно: каждая сторона сама по себе
        nw = left ? ax - mx - sx.d : mx + sx.d - ax;
        nh = up ? ay - my - sy.d : my + sy.d - ay;
        gx = sx.at; gy = sy.at;
      } else {   // пропорции те же, ведёт та сторона, что изменилась сильнее
        let s = Math.max(nw / o.w, nh / o.h);
        if (sx.at >= 0) { s = (left ? ax - mx - sx.d : mx + sx.d - ax) / o.w; gx = sx.at; }
        else if (sy.at >= 0) { s = (up ? ay - my - sy.d : my + sy.d - ay) / o.h; gy = sy.at; }
        s = Math.min(Math.max(s, Math.max(MV_MIN_BOX / o.w, MV_MIN_BOX / o.h)), Math.min(MV_MAX_BOX / o.w, MV_MAX_BOX / o.h));
        nw = o.w * s; nh = o.h * s;
      }
      nw = Math.max(nw, MV_MIN_BOX); nh = Math.max(nh, MV_MIN_BOX);
      set(left ? ax - nw : ax, up ? ay - nh : ay, nw, nh);
      mvGuides(gx, gy);
    }
    mvPlaceClip(c);
    mvFrameDraw();
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
// Нажатие сразу выбирает слой под мышью, и его можно тянуть, не отпуская кнопку. Мимо слоёв — выбор снимается.
mvStage.addEventListener('pointerdown', e => {
  if (e.button !== 0 || mv.file || !tkClips().length) return;
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  if (mv.playing) mvPause();
  const cur = mvFrameClip(), h = e.target.closest('[data-c]'), top = mvHit(e);
  if (cur && h) { e.preventDefault(); mvFrameDrag(e, cur, h.dataset.c); return; }
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
function mvFileShow(it) {
  if (it.bad || !it.kind) { say('warn', t('mt.noDurTitle'), t('mt.noDur')); return; }
  if (mv.file === it) return;
  if (mv.playing) mvPause();
  mvFileOff(true);
  mv.pool.forEach(e => { if (e.clip !== null) mvRelease(e); });
  mv.file = it;
  mv.fileReady = false;
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
$('mvSeek').addEventListener('input', () => { if (mtV.duration) videoSeek(mtV, $('mvSeek').value / 1000 * mtV.duration); });
$('mvSeek').addEventListener('change', () => $('mvSeek').blur());
$('mvTagOff').onclick = () => mvFileOff();
