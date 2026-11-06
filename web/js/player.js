// ---------- общее для окна просмотра и окна обрезки ----------
const mediaUrl = (p, proxy, rev, scale) => `/media?t=${TOKEN}&p=${encodeURIComponent(p)}${proxy ? '&proxy=1' : ''}${rev ? `&rev=1&from=${rev.from}&len=${rev.len}` : ''}${scale ? `&scale=${scale}` : ''}`;

// Показать файл в <video>: сначала как есть, а если проигрыватель не умеет, то копию от ffmpeg (proxy.go).
// cb.ready(копия ли) — можно играть, cb.wait(процент) — копия готовится, cb.fail(текст) — не вышло.
// cb.proxy — уже известно, что нужна копия; cb.rev {from, len} — нужен кусок задом наперёд; cb.scale — копия в 2 или 4 раза меньше.
// Возвращает функцию, которая всё останавливает.
function attachMedia(v, path, needPicture, cb) {
  let usingProxy = false, alive = true, timer = 0;
  const piece = cb.rev ? {rev: true, from: cb.rev.from, len: cb.rev.len} : cb.scale ? {scale: cb.scale} : {};
  const poll = async () => {
    const r = await api('proxy', {path, ...piece});
    if (!alive) return;
    if (r.ready) { v.src = mediaUrl(path, true, cb.rev, cb.scale); return; }
    if (r.error) { cb.fail(r.error); return; }
    cb.wait(r.pct || 0);
    timer = setTimeout(poll, 500);
  };
  const toProxy = () => {
    usingProxy = true;
    v.removeAttribute('src'); v.load();
    cb.wait(0);
    poll();
  };
  const onError = () => {
    if (!v.getAttribute('src')) return;
    if (usingProxy) cb.fail(t('pv.cantPlay')); else toProxy();
  };
  const onMeta = () => {
    if (needPicture && !v.videoWidth && !usingProxy) toProxy();   // звук играет, а картинку не показать
    else cb.ready(usingProxy);
  };
  v.addEventListener('error', onError);
  v.addEventListener('loadedmetadata', onMeta);
  if (cb.proxy || cb.rev) { usingProxy = true; poll(); }
  else v.src = mediaUrl(path);
  return () => {
    alive = false;
    clearTimeout(timer);
    v.removeEventListener('error', onError);
    v.removeEventListener('loadedmetadata', onMeta);
    v.pause(); v.removeAttribute('src'); v.load();
    if (usingProxy) api('proxy-stop', {path, ...piece});
  };
}

// Перемотка мышью присылает места быстрее, чем видео успевает: пока ищем, помним только последнее.
const seekNext = new WeakMap();
function videoSeek(v, at) {
  if (v.seeking) { seekNext.set(v, at); return; }
  try { v.currentTime = at; } catch (e) {}
}
function keepSeeking(v) {
  v.addEventListener('seeked', () => {
    if (!seekNext.has(v)) return;
    const at = seekNext.get(v);
    seekNext.delete(v);
    videoSeek(v, at);
  });
}

// Кадр на экране. При воспроизведении currentTime убегает вперёд, точное время показанного кадра даёт только это событие.
const shownFrame = new WeakMap();
function trackFrame(v) {
  const on = (_, m) => { shownFrame.set(v, m.mediaTime); v.requestVideoFrameCallback(on); };
  v.requestVideoFrameCallback(on);
}
const frameTime = v => !v.paused && !v.seeking && shownFrame.has(v) ? shownFrame.get(v) : v.currentTime;
// Сохранить кадр из исходного файла рядом с ним (snapshot.go)
async function saveShot(btn, v, path) {
  btn.disabled = true;
  const r = await api('snapshot', {path, at: frameTime(v), proxy: v.src.includes('proxy=1')});
  btn.disabled = false;
  shotDone(r);
}
function shotDone(r) {
  if (r.error) { say('err', t('snap.failed'), r.error); return; }
  toast({id: 'snap', type: 'ok', title: t('snap.saved'), text: esc(r.name), ttl: 12000,
    actions: [{t: t('btn.openFolder'), primary: true, fn: async () => { const o = await api('open-dir', {path: r.dir}); if (o.error) say('warn', t('folder.title'), o.error); }}]});
}

// Громкость общая для обоих окон и запоминается между запусками.
const VOL_KEY = 'konv9000.volume', MUTE_KEY = 'konv9000.muted';
const storeGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const storeSet = (k, x) => { try { localStorage.setItem(k, x); } catch (e) {} };
function bindVolume(v, muteBtn, slider) {
  const draw = () => { muteBtn.classList.toggle('muted', v.muted || !v.volume); slider.value = v.muted ? 0 : v.volume; };
  const stored = parseFloat(storeGet(VOL_KEY));
  v.volume = stored >= 0 && stored <= 1 ? stored : .8;
  v.muted = storeGet(MUTE_KEY) === '1';
  draw();
  slider.addEventListener('input', () => {
    v.volume = +slider.value; v.muted = false;
    storeSet(VOL_KEY, v.volume); storeSet(MUTE_KEY, '0');
    draw();
  });
  muteBtn.addEventListener('click', () => {
    v.muted = !v.muted;
    if (!v.muted && !v.volume) v.volume = .8;
    storeSet(MUTE_KEY, v.muted ? '1' : '0');
    draw();
  });
  // значение могло поменяться в другом окне
  return () => {
    const x = parseFloat(storeGet(VOL_KEY));
    if (x >= 0 && x <= 1) v.volume = x;
    v.muted = storeGet(MUTE_KEY) === '1';
    draw();
  };
}

const thumbUrl = (p, at, w) => `/thumb?t=${TOKEN}&w=${w}&at=${at}&p=${encodeURIComponent(p)}`;
const fmtDur = s => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
// картинки и GIF показывает сам браузер, остальное играет <video>
const STILL = /\.(png|jpe?g|webp|bmp|tiff?|gif)$/i;

// Плеер на элементах с общей приставкой id: 'pv' — окно, 'pl' — вкладка.
// o.canPlay() — можно ли начать играть само, когда файл готов.
function makePlayer(p, o = {}) {
  const el = n => $(p + n);
  const v = el('Video'), img = el('Img'), stage = el('Stage'), ctl = el('Ctl'), seek = el('Seek');
  const s = {it: null, dur: 0, stop: null, scrub: false, seq: 0};
  const volumeSync = bindVolume(v, el('Mute'), el('Vol'));
  keepSeeking(v);
  trackFrame(v);
  const off = () => ctl.classList.contains('off');

  function note(text) {
    el('Note').textContent = text || '';
    el('Note').classList.toggle('hide', !text);
  }
  function drawTime(at) {
    at = Math.max(0, Math.min(at, s.dur));
    el('Now').textContent = fmtDur(at);
    el('Fill').style.width = (s.dur ? at / s.dur * 100 : 0) + '%';
    seek.setAttribute('aria-valuenow', Math.round(at));
  }
  function tick() {
    if (!s.it || v.paused) return;
    if (!s.scrub) drawTime(v.currentTime);
    requestAnimationFrame(tick);
  }
  // большая картинка: подложка у видео, волна у звука, сам файл у картинок; на чём-то ещё — запасной кадр от ffmpeg
  function showImage(url, fallback) {
    img.classList.remove('hide');
    img.onerror = () => {
      if (fallback) { showImage(fallback); return; }
      img.classList.add('hide');
      note(t('pv.noImage'));
    };
    img.src = url;
  }
  function toggle() {
    if (off()) return;
    if (v.paused) v.play().catch(() => {}); else v.pause();
  }
  // at — вернуться к этому месту и не играть
  async function open(it, at) {
    release();
    const me = ++s.seq;
    s.it = it; s.dur = 0;
    stage.classList.remove('audio', 'canplay');
    v.classList.add('hide');
    note('');
    ctl.classList.add('hide');
    ctl.classList.add('off');
    // адрес с меткой времени: баннеры заменяются на месте, а окно могло запомнить старую картинку
    if (STILL.test(it.name)) showImage(mediaUrl(it.path) + '&v=' + Date.now(), thumbUrl(it.path, .1, 1280));
    else showImage(thumbUrl(it.path, .1, 160));
    el('Meta').innerHTML = `<div>${t('pv.reading')}</div>`;
    const mi = await api('info', {path: it.path});
    if (me !== s.seq) return;
    if (!STILL.test(it.name)) {
      showImage(thumbUrl(it.path, .1, 1280));
      if (mi.dur > 0) player(it, mi, at);
    }
    const m = [];
    if (mi.error) m.push([t('pv.error'), esc(mi.error)]);
    if (mi.w && !mi.cover) m.push([t('pv.resolution'), `${mi.w}×${mi.h}`]);
    if (mi.dur > 0) m.push([t('pv.duration'), fmtDur(mi.dur)]);
    if (mi.vcodec && !mi.cover) m.push([t('pv.video'), esc(mi.vcodec) + (mi.fps ? ` · ${+mi.fps.toFixed(2)} fps` : '')]);
    if (mi.acodec) m.push([t('pv.audio'), esc(mi.acodec) + (mi.ahz ? ` · ${(mi.ahz / 1000).toLocaleString(lang)} ${t('unit.khz')}` : '') + (mi.ach ? ` · ${esc(mi.ach)}` : '')]);
    else if (mi.vcodec && !mi.cover && mi.dur > 0) m.push([t('pv.audio'), t('pv.none')]);
    if (mi.size) m.push([t('pv.size'), fmtSize(mi.size)]);
    el('Meta').innerHTML = m.map(([k, x]) => `<div>${k}<b>${x}</b></div>`).join('');
  }
  function player(it, mi, at) {
    const isVideo = !!mi.vcodec && !mi.cover;
    s.dur = mi.dur;
    stage.classList.toggle('audio', !isVideo);
    ctl.classList.remove('hide');
    el('Shot').classList.toggle('hide', !isVideo);
    el('Dur').textContent = fmtDur(mi.dur);
    seek.setAttribute('aria-valuemax', Math.round(mi.dur));
    drawTime(at || 0);
    volumeSync();
    s.stop = attachMedia(v, it.path, isVideo, {
      ready() {
        note('');
        ctl.classList.remove('off');
        stage.classList.add('canplay');
        if (isVideo) { img.classList.add('hide'); v.classList.remove('hide'); }
        if (at != null) videoSeek(v, at);
        else if (!o.canPlay || o.canPlay()) v.play().catch(() => {});
      },
      wait(pct) { note(t('pv.preparing', {pct: Math.round(pct)})); },
      fail(text) { note(text); },
    });
  }
  function release() {
    s.seq++;
    if (s.stop) s.stop();
    s.stop = null;
    s.it = null;
  }
  // пробел — пауза, стрелки — пять секунд
  function key(e) {
    if (e.target.tagName === 'INPUT' || off()) return;
    if (e.code === 'Space') { e.preventDefault(); toggle(); return; }
    const d = {ArrowLeft: -5, ArrowRight: 5}[e.key];
    if (d) {
      e.preventDefault();
      const at = Math.max(0, Math.min(v.currentTime + d, s.dur));
      drawTime(at);
      videoSeek(v, at);
    }
  }

  stage.addEventListener('click', toggle);
  el('Play').onclick = toggle;
  el('Loop').onclick = () => {
    v.loop = !v.loop;
    el('Loop').classList.toggle('on', v.loop);
  };
  el('Shot').onclick = () => { if (s.it) saveShot(el('Shot'), v, s.it.path); };
  v.addEventListener('play', () => { stage.classList.add('playing'); el('Play').classList.add('playing'); tick(); });
  v.addEventListener('pause', () => { stage.classList.remove('playing'); el('Play').classList.remove('playing'); });
  v.addEventListener('timeupdate', () => { if (s.it && !s.scrub) drawTime(v.currentTime); });

  const seekAt = e => { const r = seek.getBoundingClientRect(); return Math.max(0, Math.min((e.clientX - r.left) / r.width, 1)) * s.dur; };
  const seekTo = e => { const at = seekAt(e); drawTime(at); videoSeek(v, at); };
  seek.addEventListener('pointerdown', e => {
    if (off()) return;
    e.preventDefault();
    seek.focus();
    seek.setPointerCapture(e.pointerId);
    s.scrub = true;
    seekTo(e);
  });
  seek.addEventListener('pointermove', e => { if (s.scrub) seekTo(e); });
  ['pointerup', 'pointercancel'].forEach(n => seek.addEventListener(n, () => { s.scrub = false; }));

  return {v, open, release, key, current: () => s.it};
}
