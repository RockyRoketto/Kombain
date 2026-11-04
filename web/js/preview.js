// ---------- окно плеера ----------
const pv = makePlayer('pv');

function openPreview(it) {
  plHold();
  pv.open(it);
  $('pvName').textContent = it.name;
  $('pvTrim').classList.toggle('hide', !(files.includes(it) && !snap.running && TRIMMABLE.test(it.name)));
  $('pvOut').innerHTML = outLine(); $('pvOut').classList.toggle('hide', tab !== 'conv');
  $('prev').classList.remove('hide');
  $('pvClose').focus();
}
function outLine() {
  const F = FORMATS[fmt], k = F.k, h = $('height').value, fps = $('fps').value, mb = +$('target').value, bits = [];
  if (k === 'small') bits.push(t('pv.toMp4', {c: $('codec').value === 'h264' ? 'H.264' : 'H.265'}));
  if (['video', 'small'].includes(k)) bits.push(mb > 0 ? t('pv.videoLimit', {v: esc($('target').value)}) : t('pv.crf', {v: $('crf').value}));
  if (['video', 'vfix', 'pro', 'gif', 'anim', 'image', 'seq', 'small'].includes(k)) bits.push(h ? t('pv.height', {v: h}) : t('pv.sameSize'));
  if (['video', 'vfix', 'pro', 'gif', 'anim', 'seq', 'small'].includes(k) && fps) bits.push(fps + ' fps');
  if (['video', 'vfix', 'audio', 'small'].includes(k)) bits.push(t('pv.audioRate', {v: $('abr').value}));
  return t('pv.result', {f: esc(fmtName(fmt))}) + (bits.length ? ' · ' + bits.join(' · ') : '');
}
$('pvClose').onclick = () => { pv.release(); $('prev').classList.add('hide'); };
$('prev').addEventListener('click', e => { if (e.target === $('prev')) $('pvClose').click(); });
$('pvTrim').onclick = () => { const it = pv.current(); $('pvClose').click(); if (it) openTrim(it); };

// Esc закрывает, пробел — пауза, стрелки — пять секунд
document.addEventListener('keydown', e => {
  if ($('prev').classList.contains('hide')) return;
  if (e.key === 'Escape') { $('pvClose').click(); return; }
  pv.key(e);
});

