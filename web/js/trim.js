// ---------- обрезка видео и звука ----------
// Кусок хранится в самом файле списка (it.trim = {start, end}) и уходит в запрос через currentReq.
const TRIMMABLE = /\.(mp4|mov|mkv|avi|webm|flv|wmv|m4v|mpg|mpeg|ts|mts|3gp|mp3|wav|flac|m4a|aac|ogg|opus|wma)$/i;
const TRIM_MIN = .1;      // короче куска не бывает, секунды
// mark — место просмотра; selLoop — идёт показ куска по кругу; frames — проигрывателя нет, вместо него кадры от ffmpeg
const trs = {it: null, dur: 0, start: 0, end: 0, video: false, frames: false, frameTimer: 0, fps: 25, mark: 0, selLoop: false, scrub: false, stop: null};
// 75.52 → 1:15.52: сотые нужны, чтобы видеть границу с точностью до кадра
function trimFmt(s) {
  const cs = Math.round(s * 100), h = Math.floor(cs / 360000), m = Math.floor(cs % 360000 / 6000), x = (cs % 6000 / 100).toFixed(2);
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + x.padStart(5, '0');
}
// «1:15.5», «75,5» или «1:02:03» → секунды; непонятное → NaN
function trimParse(v) {
  const p = v.trim().replace(',', '.').split(':');
  if (p.length > 3 || !p.every(x => /^\d+(\.\d*)?$/.test(x))) return NaN;
  return p.reduce((a, x) => a * 60 + parseFloat(x), 0);
}
const trimTag = it => it.trim ? `<span class="tag">✂ ${trimFmt(it.trim.start)}–${trimFmt(it.trim.end)}</span>` : '';

function trimDraw() {
  const {dur, start, end} = trs, pct = x => (x / dur * 100) + '%';
  $('trHs').style.left = $('trDimL').style.width = $('trSel').style.left = pct(start);
  $('trHe').style.left = pct(end);
  $('trDimR').style.width = pct(dur - end);
  $('trSel').style.width = pct(end - start);
  $('trLen').textContent = trimFmt(end - start);
  if (document.activeElement !== $('trStart')) $('trStart').value = trimFmt(start);
  if (document.activeElement !== $('trEnd')) $('trEnd').value = trimFmt(end);
  [$('trHs'), $('trHe')].forEach((h, i) => { h.setAttribute('aria-valuemax', dur); h.setAttribute('aria-valuenow', i ? end : start); });
}
function trimPlayhead(t) {
  t = Math.min(t, trs.dur);
  $('trPh').style.left = (t / trs.dur * 100) + '%';
  $('trNow').textContent = trimFmt(t);
}
// показать кадр: в проигрывателе, а пока его нет — картинкой от ffmpeg
function trimSeek(t) {
  trs.mark = t;
  trimPlayhead(t);
  if (!trs.frames) videoSeek(trimVideo, t);
  else if (trs.video) {
    clearTimeout(trs.frameTimer);
    trs.frameTimer = setTimeout(() => { if (trs.it) $('trFrame').src = thumbUrl(trs.it.path, (t / trs.dur).toFixed(3), 960); }, 120);
  }
}
function trimSet(which, t) {
  t = Math.max(0, Math.min(t, trs.dur));
  if (which === 'start') trs.start = Math.min(t, Math.max(trs.end - TRIM_MIN, 0));
  else trs.end = Math.max(t, Math.min(trs.start + TRIM_MIN, trs.dur));
  trimVideo.pause();
  trimDraw();
  trimSeek(trs[which]);
}
// переключение между проигрывателем и кадрами от ffmpeg
function trimUseFrames(on) {
  trs.frames = on;
  trimVideo.classList.toggle('hide', on);
  $('trFrame').classList.toggle('hide', !on || !trs.video);
  $('trCtl').classList.toggle('off', on);
  if (on && trs.video) trimSeek(trs.mark);
}
function trimReady() {
  $('trWait').textContent = '';
  trimUseFrames(false);
  trimSeek(trs.mark);
}
function trimTick() {
  if (!trs.it || trimVideo.paused) return;
  trimBound();
  if (!trs.scrub) trimPlayhead(trimVideo.currentTime);
  requestAnimationFrame(trimTick);
}
// показ куска: дошли до конца — снова к началу
function trimBound() {
  if (trs.selLoop && trimVideo.currentTime >= trs.end) { try { trimVideo.currentTime = trs.start; } catch (e) {} }
}
function trimDrawLoop() { $('trLoop').classList.toggle('on', trs.selLoop); }
async function openTrim(it) {
  trs.it = it; trs.frames = false; trs.selLoop = false; trs.scrub = false;
  trimDrawLoop();
  const v = trimVideo;
  $('trName').textContent = it.name;
  $('trBody').classList.add('hide');
  $('trMsg').classList.remove('hide');
  $('trMsg').textContent = t('pv.reading');
  $('trApply').classList.add('hide');
  $('trReset').classList.add('hide');
  $('trim').classList.remove('hide');
  $('trClose').focus();
  const mi = await api('info', {path: it.path});
  if (trs.it !== it) return;
  if (!(mi.dur > 0)) { $('trMsg').textContent = mi.error || t('trim.noDur'); return; }
  trs.dur = mi.dur;
  trs.video = !!mi.vcodec && !mi.cover;
  trs.start = it.trim ? it.trim.start : 0;
  trs.end = it.trim ? Math.min(it.trim.end, mi.dur) : mi.dur;
  trs.mark = trs.start;
  trs.fps = mi.fps > 0 ? mi.fps : 25;
  $('trAll').textContent = trimFmt(mi.dur);
  $('trBg').className = 'tl-bg' + (trs.video ? '' : ' wave');
  $('trBg').innerHTML = trs.video
    ? [...Array(8)].map((_, i) => `<img src="${thumbUrl(it.path, ((i + .5) / 8).toFixed(3), 160)}" alt="" onerror="this.style.visibility='hidden'">`).join('')
    : `<img src="${thumbUrl(it.path, 0, 1280)}" alt="" onerror="this.remove()">`;
  $('trMsg').classList.add('hide');
  $('trBody').classList.remove('hide');
  $('trApply').classList.remove('hide');
  $('trReset').classList.remove('hide');
  $('trStage').classList.toggle('hide', !trs.video);
  $('trWait').textContent = '';
  $('trCtl').classList.add('off');
  v.classList.remove('hide');
  $('trFrame').classList.add('hide');
  trimVolumeSync();
  trimDraw();
  trimPlayhead(trs.start);
  trs.stop = attachMedia(v, it.path, trs.video, {
    ready: trimReady,
    wait(pct) { if (!trs.frames) trimUseFrames(true); $('trWait').textContent = t('pv.preparing', {pct: Math.round(pct)}); },
    fail(text) { if (!trs.frames) trimUseFrames(true); $('trWait').textContent = text; },
  });
}
function closeTrim() {
  if (trs.stop) trs.stop();
  trs.stop = null;
  clearTimeout(trs.frameTimer);
  trs.it = null;
  $('trim').classList.add('hide');
}
const trimVideo = $('trVideo');
const trimVolumeSync = bindVolume(trimVideo, $('trMute'), $('trVol'));
keepSeeking(trimVideo);
trimVideo.addEventListener('timeupdate', () => { if (trs.it && !trimVideo.paused) trimBound(); });
trimVideo.addEventListener('play', () => { $('trPlay').classList.add('playing'); trimTick(); });
trimVideo.addEventListener('pause', () => {
  $('trPlay').classList.remove('playing');
  trs.selLoop = false;
  trimDrawLoop();
  if (trs.it && !trs.frames) { trs.mark = trimVideo.currentTime; trimPlayhead(trs.mark); }
});
// весь файл, с текущего места
$('trPlay').onclick = () => {
  if (trs.frames) return;
  const v = trimVideo;
  if (!v.paused) { v.pause(); return; }
  v.play().catch(() => {});
};
// только выбранный кусок, снова и снова
$('trLoop').onclick = () => {
  if (trs.frames) return;
  const v = trimVideo;
  if (trs.selLoop) { v.pause(); return; }
  trs.selLoop = true;
  trimDrawLoop();
  try { v.currentTime = trs.start; } catch (e) {}
  v.play().catch(() => {});
};
function trimStep(d) {
  trimVideo.pause();
  trimSeek(Math.max(0, Math.min(trs.mark + d / trs.fps, trs.dur)));
}
$('trPrev').onclick = () => trimStep(-1);
$('trNext').onclick = () => trimStep(1);
const trimAt = e => { const r = $('trLine').getBoundingClientRect(); return (e.clientX - r.left) / r.width * trs.dur; };
// ползунки: тянуть мышью, стрелки на клавиатуре — на 0,1 секунды (с Shift — на секунду)
[['trHs', 'start'], ['trHe', 'end']].forEach(([id, which]) => {
  const h = $(id);
  h.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); h.focus(); h.setPointerCapture(e.pointerId); h.classList.add('drag'); });
  h.addEventListener('pointermove', e => { if (h.classList.contains('drag')) trimSet(which, trimAt(e)); });
  ['pointerup', 'pointercancel'].forEach(n => h.addEventListener(n, () => h.classList.remove('drag')));
  h.addEventListener('keydown', e => {
    const d = {ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1}[e.key];
    if (!d) return;
    e.preventDefault();
    trimSet(which, trs[which] + d * (e.shiftKey ? 1 : TRIM_MIN));
  });
});
// щелчок и протягивание по шкале двигают просмотр, но не границы
const trimScrub = e => trimSeek(Math.max(0, Math.min(trimAt(e), trs.dur)));
$('trLine').addEventListener('pointerdown', e => {
  if (!trs.it || e.target.closest('.tl-h')) return;
  trimVideo.pause();
  $('trLine').setPointerCapture(e.pointerId);
  trs.scrub = true;
  trimScrub(e);
});
$('trLine').addEventListener('pointermove', e => { if (trs.scrub) trimScrub(e); });
['pointerup', 'pointercancel'].forEach(n => $('trLine').addEventListener(n, () => { trs.scrub = false; }));
const trimNow = () => trs.frames || trimVideo.paused ? trs.mark : trimVideo.currentTime;
$('trSetS').onclick = () => trimSet('start', trimNow());
$('trSetE').onclick = () => trimSet('end', trimNow());
[['trStart', 'start'], ['trEnd', 'end']].forEach(([id, which]) => {
  const el = $(id);
  el.addEventListener('change', () => {
    const v = trimParse(el.value);
    if (!isNaN(v)) trimSet(which, v);
    el.value = trimFmt(trs[which]);
  });
  el.addEventListener('keydown', e => { if (e.key === 'Enter') el.blur(); });
});
$('trReset').onclick = () => { trs.start = 0; trs.end = trs.dur; trimVideo.pause(); trimDraw(); trimSeek(0); };
$('trApply').onclick = () => {
  const it = trs.it;
  if (trs.start < .05 && trs.end > trs.dur - .05) delete it.trim;   // весь файл: резать нечего
  else it.trim = {start: +trs.start.toFixed(3), end: +trs.end.toFixed(3)};
  closeTrim();
  render();
};
$('trClose').onclick = closeTrim;
$('trim').addEventListener('click', e => { if (e.target === $('trim')) closeTrim(); });
// Esc закрывает, пробел — пауза, стрелки — кадр, [ и ] — границы (по коду клавиши: работают и в русской раскладке)
document.addEventListener('keydown', e => {
  if (!trs.it) return;
  if (e.key === 'Escape') { closeTrim(); return; }
  if (e.target.tagName === 'INPUT' || !$('trBody').offsetParent) return;
  if (e.code === 'Space') { e.preventDefault(); $('trPlay').click(); }
  else if (e.code === 'BracketLeft') { e.preventDefault(); $('trSetS').click(); }
  else if (e.code === 'BracketRight') { e.preventDefault(); $('trSetE').click(); }
  else if (!e.target.closest('.tl-h') && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault();
    trimStep(e.key === 'ArrowLeft' ? -1 : 1);
  }
});
