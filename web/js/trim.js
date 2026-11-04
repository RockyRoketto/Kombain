// ---------- обрезка видео и звука ----------
// Кусок хранится в самом файле списка (it.trim = {start, end}) и уходит в запрос через currentReq.
const TRIMMABLE = /\.(mp4|mov|mkv|avi|webm|flv|wmv|m4v|mpg|mpeg|ts|mts|3gp|mp3|wav|flac|m4a|aac|ogg|opus|wma)$/i;
const TRIM_MIN = .1;      // короче куска не бывает, секунды
const trs = {it: null, dur: 0, start: 0, end: 0, video: false, frames: false, frameTimer: 0};
// 75.5 → 1:15.5
function trimFmt(s) {
  const ds = Math.round(s * 10), h = Math.floor(ds / 36000), m = Math.floor(ds % 36000 / 600), x = (ds % 600 / 10).toFixed(1);
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + x.padStart(4, '0');
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
function trimPlayhead(t) { $('trPh').style.left = (Math.min(t, trs.dur) / trs.dur * 100) + '%'; }
// показать кадр: в проигрывателе, а если формат ему не по силам — картинкой от ffmpeg
function trimSeek(t) {
  trimPlayhead(t);
  const v = $('trVideo');
  if (!trs.frames) { try { v.currentTime = t; } catch (e) {} }
  else if (trs.video) {
    clearTimeout(trs.frameTimer);
    trs.frameTimer = setTimeout(() => { $('trFrame').src = thumbUrl(trs.it.path, (t / trs.dur).toFixed(3), 640); }, 120);
  }
}
function trimSet(which, t) {
  t = Math.max(0, Math.min(t, trs.dur));
  if (which === 'start') trs.start = Math.min(t, Math.max(trs.end - TRIM_MIN, 0));
  else trs.end = Math.max(t, Math.min(trs.start + TRIM_MIN, trs.dur));
  $('trVideo').pause();
  trimDraw();
  trimSeek(trs[which]);
}
// проигрыватель не смог: перемотка картинками, кнопки прослушивания нет
function trimNoPlayer() {
  trs.frames = true;
  $('trPlay').classList.add('hide');
  $('trVideo').classList.add('hide');
  $('trFrame').classList.toggle('hide', !trs.video);
  if (trs.video) trimSeek(trs.start);
}
async function openTrim(it) {
  trs.it = it; trs.frames = false;
  const v = $('trVideo');
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
  $('trBg').className = 'tl-bg' + (trs.video ? '' : ' wave');
  $('trBg').innerHTML = trs.video
    ? [...Array(8)].map((_, i) => `<img src="${thumbUrl(it.path, ((i + .5) / 8).toFixed(3), 160)}" alt="" onerror="this.style.visibility='hidden'">`).join('')
    : `<img src="${thumbUrl(it.path, 0, 1280)}" alt="" onerror="this.remove()">`;
  $('trMsg').classList.add('hide');
  $('trBody').classList.remove('hide');
  $('trApply').classList.remove('hide');
  $('trReset').classList.remove('hide');
  $('trStage').classList.toggle('hide', !trs.video);
  $('trPlay').classList.remove('hide');
  $('trPlay').textContent = t(trs.video ? 'trim.play' : 'trim.listen');
  v.classList.remove('hide');
  $('trFrame').classList.add('hide');
  v.src = `/media?t=${TOKEN}&p=${encodeURIComponent(it.path)}`;
  trimDraw();
  trimPlayhead(trs.start);
}
function closeTrim() {
  const v = $('trVideo');
  v.pause(); v.removeAttribute('src'); v.load();
  clearTimeout(trs.frameTimer);
  trs.it = null;
  $('trim').classList.add('hide');
}
const trimVideo = $('trVideo');
trimVideo.addEventListener('error', () => { if (trs.it && trimVideo.getAttribute('src')) trimNoPlayer(); });
trimVideo.addEventListener('loadedmetadata', () => {
  if (!trs.it) return;
  if (trs.video && !trimVideo.videoWidth) { trimNoPlayer(); return; }   // звук играет, а картинку не показать
  trimSeek(trs.start);
});
trimVideo.addEventListener('timeupdate', () => {
  if (!trs.it) return;
  trimPlayhead(trimVideo.currentTime);
  if (!trimVideo.paused && trimVideo.currentTime >= trs.end) { trimVideo.pause(); trimVideo.currentTime = trs.end; }
});
trimVideo.addEventListener('play', () => { $('trPlay').textContent = t('trim.pause'); });
trimVideo.addEventListener('pause', () => { if (trs.it) $('trPlay').textContent = t(trs.video ? 'trim.play' : 'trim.listen'); });
$('trPlay').onclick = () => {
  const v = trimVideo;
  if (!v.paused) { v.pause(); return; }
  if (v.currentTime < trs.start || v.currentTime >= trs.end - .05) v.currentTime = trs.start;
  v.play().catch(trimNoPlayer);
};
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
// щелчок по шкале двигает просмотр, но не границы
$('trLine').addEventListener('pointerdown', e => {
  if (!trs.it || e.target.closest('.tl-h')) return;
  trimVideo.pause();
  trimSeek(Math.max(0, Math.min(trimAt(e), trs.dur)));
  trs.mark = Math.max(0, Math.min(trimAt(e), trs.dur));
});
const trimNow = () => trs.frames ? (trs.mark ?? trs.start) : trimVideo.currentTime;
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
document.addEventListener('keydown', e => { if (e.key === 'Escape' && trs.it) closeTrim(); });
