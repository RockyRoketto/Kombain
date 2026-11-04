// ---------- превью ----------
const thumbUrl = (p, at, w) => `/thumb?t=${TOKEN}&w=${w}&at=${at}&p=${encodeURIComponent(p)}`;
const fmtDur = s => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
// картинки и GIF показывает сам браузер, остальное играет <video>
const STILL = /\.(png|jpe?g|webp|bmp|tiff?|gif)$/i;
const pvs = {it: null, dur: 0, stop: null, scrub: false};
const pvVideo = $('pvVideo'), pvImg = $('pvImg');
const pvVolumeSync = bindVolume(pvVideo, $('pvMute'), $('pvVol'));
keepSeeking(pvVideo);
trackFrame(pvVideo);

function pvNote(text) {
  $('pvNote').textContent = text || '';
  $('pvNote').classList.toggle('hide', !text);
}
function pvDrawTime(at) {
  at = Math.max(0, Math.min(at, pvs.dur));
  $('pvNow').textContent = fmtDur(at);
  $('pvFill').style.width = (pvs.dur ? at / pvs.dur * 100 : 0) + '%';
  $('pvSeek').setAttribute('aria-valuenow', Math.round(at));
}
function pvTick() {
  if (!pvs.it || pvVideo.paused) return;
  if (!pvs.scrub) pvDrawTime(pvVideo.currentTime);
  requestAnimationFrame(pvTick);
}
// большая картинка: подложка у видео, волна у звука, сам файл у картинок; на чём-то ещё — запасной кадр от ffmpeg
function pvShowImage(url, fallback) {
  pvImg.classList.remove('hide');
  pvImg.onerror = () => {
    if (fallback) { pvShowImage(fallback); return; }
    pvImg.classList.add('hide');
    pvNote(t('pv.noImage'));
  };
  pvImg.src = url;
}
function pvToggle() {
  if ($('pvCtl').classList.contains('off')) return;
  if (pvVideo.paused) pvVideo.play().catch(() => {}); else pvVideo.pause();
}
async function openPreview(it) {
  pvRelease();
  pvs.it = it; pvs.dur = 0;
  $('pvName').textContent = it.name;
  const stage = $('pvStage');
  stage.classList.remove('audio', 'canplay');
  pvVideo.classList.add('hide');
  pvNote('');
  $('pvCtl').classList.add('hide');
  $('pvCtl').classList.add('off');
  $('pvTrim').classList.toggle('hide', !(files.includes(it) && !snap.running && TRIMMABLE.test(it.name)));
  // адрес с меткой времени: баннеры заменяются на месте, а окно могло запомнить старую картинку
  if (STILL.test(it.name)) pvShowImage(mediaUrl(it.path) + '&v=' + Date.now(), thumbUrl(it.path, .1, 1280));
  else pvShowImage(thumbUrl(it.path, .1, 160));
  $('pvMeta').innerHTML = `<div>${t('pv.reading')}</div>`; $('pvOut').innerHTML = outLine(); $('pvOut').classList.toggle('hide', tab !== 'conv');
  $('prev').classList.remove('hide');
  $('pvClose').focus();
  const mi = await api('info', {path: it.path});
  if (pvs.it !== it) return;
  if (!STILL.test(it.name)) {
    pvShowImage(thumbUrl(it.path, .1, 1280));
    if (mi.dur > 0) pvPlayer(it, mi);
  }
  const m = [];
  if (mi.error) m.push([t('pv.error'), esc(mi.error)]);
  if (mi.w && !mi.cover) m.push([t('pv.resolution'), `${mi.w}×${mi.h}`]);
  if (mi.dur > 0) m.push([t('pv.duration'), fmtDur(mi.dur)]);
  if (mi.vcodec && !mi.cover) m.push([t('pv.video'), esc(mi.vcodec) + (mi.fps ? ` · ${+mi.fps.toFixed(2)} fps` : '')]);
  if (mi.acodec) m.push([t('pv.audio'), esc(mi.acodec) + (mi.ahz ? ` · ${(mi.ahz / 1000).toLocaleString(lang)} ${t('unit.khz')}` : '') + (mi.ach ? ` · ${esc(mi.ach)}` : '')]);
  else if (mi.vcodec && !mi.cover && mi.dur > 0) m.push([t('pv.audio'), t('pv.none')]);
  if (mi.size) m.push([t('pv.size'), fmtSize(mi.size)]);
  $('pvMeta').innerHTML = m.map(([k, v]) => `<div>${k}<b>${v}</b></div>`).join('');
}
function outLine() {
  const F = FORMATS[fmt], k = F.k, h = $('height').value, fps = $('fps').value, mb = +$('target').value, bits = [];
  if (k === 'small') bits.push(t('pv.toMp4', {c: $('codec').value === 'h264' ? 'H.264' : 'H.265'}));
  if (['video', 'small'].includes(k)) bits.push(mb > 0 ? t('pv.videoLimit', {v: esc($('target').value)}) : t('pv.crf', {v: $('crf').value}));
  if (['video', 'vfix', 'pro', 'gif', 'anim', 'image', 'small'].includes(k)) bits.push(h ? t('pv.height', {v: h}) : t('pv.sameSize'));
  if (['video', 'vfix', 'pro', 'gif', 'anim', 'small'].includes(k) && fps) bits.push(fps + ' fps');
  if (['video', 'vfix', 'audio', 'small'].includes(k)) bits.push(t('pv.audioRate', {v: $('abr').value}));
  return t('pv.result', {f: esc(fmtName(fmt))}) + (bits.length ? ' · ' + bits.join(' · ') : '');
}
function pvPlayer(it, mi) {
  const isVideo = !!mi.vcodec && !mi.cover;
  pvs.dur = mi.dur;
  $('pvStage').classList.toggle('audio', !isVideo);
  $('pvCtl').classList.remove('hide');
  $('pvShot').classList.toggle('hide', !isVideo);
  $('pvDur').textContent = fmtDur(mi.dur);
  $('pvSeek').setAttribute('aria-valuemax', Math.round(mi.dur));
  pvDrawTime(0);
  pvVolumeSync();
  pvs.stop = attachMedia(pvVideo, it.path, isVideo, {
    ready() {
      pvNote('');
      $('pvCtl').classList.remove('off');
      $('pvStage').classList.add('canplay');
      if (isVideo) { pvImg.classList.add('hide'); pvVideo.classList.remove('hide'); }
      pvVideo.play().catch(() => {});
    },
    wait(pct) { pvNote(t('pv.preparing', {pct: Math.round(pct)})); },
    fail(text) { pvNote(text); },
  });
}
function pvRelease() {
  if (pvs.stop) pvs.stop();
  pvs.stop = null;
  pvs.it = null;
}
$('pvClose').onclick = () => { pvRelease(); $('prev').classList.add('hide'); };
$('prev').addEventListener('click', e => { if (e.target === $('prev')) $('pvClose').click(); });
$('pvStage').addEventListener('click', pvToggle);
$('pvPlay').onclick = pvToggle;
$('pvLoop').onclick = () => {
  pvVideo.loop = !pvVideo.loop;
  $('pvLoop').classList.toggle('on', pvVideo.loop);
};
$('pvShot').onclick = () => { if (pvs.it) saveShot($('pvShot'), pvVideo, pvs.it.path); };
$('pvTrim').onclick =() => { const it = pvs.it; $('pvClose').click(); if (it) openTrim(it); };
pvVideo.addEventListener('play', () => { $('pvStage').classList.add('playing'); $('pvPlay').classList.add('playing'); pvTick(); });
pvVideo.addEventListener('pause', () => { $('pvStage').classList.remove('playing'); $('pvPlay').classList.remove('playing'); });
pvVideo.addEventListener('timeupdate', () => { if (pvs.it && !pvs.scrub) pvDrawTime(pvVideo.currentTime); });

const pvSeekAt = e => { const r = $('pvSeek').getBoundingClientRect(); return Math.max(0, Math.min((e.clientX - r.left) / r.width, 1)) * pvs.dur; };
const pvSeekTo = e => { const at = pvSeekAt(e); pvDrawTime(at); videoSeek(pvVideo, at); };
$('pvSeek').addEventListener('pointerdown', e => {
  if ($('pvCtl').classList.contains('off')) return;
  e.preventDefault();
  $('pvSeek').focus();
  $('pvSeek').setPointerCapture(e.pointerId);
  pvs.scrub = true;
  pvSeekTo(e);
});
$('pvSeek').addEventListener('pointermove', e => { if (pvs.scrub) pvSeekTo(e); });
['pointerup', 'pointercancel'].forEach(n => $('pvSeek').addEventListener(n, () => { pvs.scrub = false; }));

// Esc закрывает, пробел — пауза, стрелки — пять секунд
document.addEventListener('keydown', e => {
  if ($('prev').classList.contains('hide')) return;
  if (e.key === 'Escape') { $('pvClose').click(); return; }
  if (e.target.tagName === 'INPUT' || $('pvCtl').classList.contains('off')) return;
  if (e.code === 'Space') { e.preventDefault(); pvToggle(); return; }
  const d = {ArrowLeft: -5, ArrowRight: 5}[e.key];
  if (d) {
    e.preventDefault();
    const at = Math.max(0, Math.min(pvVideo.currentTime + d, pvs.dur));
    pvDrawTime(at);
    videoSeek(pvVideo, at);
  }
});

