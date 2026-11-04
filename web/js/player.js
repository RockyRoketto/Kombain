// ---------- общее для окна просмотра и окна обрезки ----------
const mediaUrl = (p, proxy) => `/media?t=${TOKEN}&p=${encodeURIComponent(p)}${proxy ? '&proxy=1' : ''}`;

// Показать файл в <video>: сначала как есть, а если проигрыватель не умеет, то копию от ffmpeg (proxy.go).
// cb.ready() — можно играть, cb.wait(процент) — копия готовится, cb.fail(текст) — не вышло.
// Возвращает функцию, которая всё останавливает.
function attachMedia(v, path, needPicture, cb) {
  let usingProxy = false, alive = true, timer = 0;
  const poll = async () => {
    const r = await api('proxy', {path});
    if (!alive) return;
    if (r.ready) { v.src = mediaUrl(path, true); return; }
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
    else cb.ready();
  };
  v.addEventListener('error', onError);
  v.addEventListener('loadedmetadata', onMeta);
  v.src = mediaUrl(path);
  return () => {
    alive = false;
    clearTimeout(timer);
    v.removeEventListener('error', onError);
    v.removeEventListener('loadedmetadata', onMeta);
    v.pause(); v.removeAttribute('src'); v.load();
    if (usingProxy) api('proxy-stop', {path});
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
