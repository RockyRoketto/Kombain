// ---------- превью ----------
const thumbUrl = (p, at, w) => `/thumb?t=${TOKEN}&w=${w}&at=${at}&p=${encodeURIComponent(p)}`;
const fmtDur = s => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
const AT = [.05, .25, .5, .75, .95];
let prevPath = '';
async function openPreview(it) {
  prevPath = it.path;
  $('pvName').textContent = it.name;
  $('pvBig').innerHTML = `<img src="${thumbUrl(it.path, .1, 160)}" alt="">`;
  $('pvStrip').innerHTML = ''; $('pvMeta').innerHTML = '<div>Читаю файл…</div>'; $('pvOut').innerHTML = outLine(); $('pvOut').classList.toggle('hide', tab !== 'conv');
  $('prev').classList.remove('hide');
  $('pvClose').focus();
  const mi = await api('info', {path: it.path});
  if (prevPath !== it.path) return;
  const big = (at) => `<img src="${thumbUrl(it.path, at, 960)}" alt="" onerror="this.outerHTML='<span class=ph>Нет картинки для превью</span>'">`;
  $('pvBig').innerHTML = big(.1);
  const isVideo = mi.vcodec && !mi.cover && mi.dur > 1;
  $('pvStrip').innerHTML = isVideo ? AT.map((a, i) => `<button data-at="${a}" class="${i === 0 ? 'on' : ''}" title="${fmtDur(mi.dur * a)}"><img src="${thumbUrl(it.path, a, 240)}" alt="" loading="lazy"></button>`).join('') : '';
  $('pvStrip').classList.toggle('hide', !isVideo);
  $('pvStrip').onclick = e => {
    const b = e.target.closest('[data-at]'); if (!b) return;
    $('pvStrip').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    $('pvBig').innerHTML = big(b.dataset.at);
  };
  const m = [];
  if (mi.error) m.push(['Ошибка', esc(mi.error)]);
  if (mi.w && !mi.cover) m.push(['Разрешение', `${mi.w}×${mi.h}`]);
  if (mi.dur > 0) m.push(['Длительность', fmtDur(mi.dur)]);
  if (mi.vcodec && !mi.cover) m.push(['Видео', esc(mi.vcodec) + (mi.fps ? ` · ${+mi.fps.toFixed(2)} fps` : '')]);
  if (mi.acodec) m.push(['Звук', esc(mi.acodec) + (mi.ahz ? ` · ${(mi.ahz / 1000).toLocaleString('ru')} кГц` : '') + (mi.ach ? ` · ${esc(mi.ach)}` : '')]);
  else if (mi.vcodec && !mi.cover && mi.dur > 0) m.push(['Звук', 'нет']);
  if (mi.size) m.push(['Размер', fmtSize(mi.size)]);
  $('pvMeta').innerHTML = m.map(([k, v]) => `<div>${k}<b>${v}</b></div>`).join('');
}
function outLine() {
  const F = FORMATS[fmt], k = F.k, h = $('height').value, fps = $('fps').value, t = +$('target').value, bits = [];
  if (k === 'small') bits.push('видео → MP4 ' + ($('codec').value === 'h264' ? 'H.264' : 'H.265'));
  if (['video', 'small'].includes(k)) bits.push(t > 0 ? 'видео не больше ' + esc($('target').value) + ' МБ' : 'качество CRF ' + $('crf').value);
  if (['video', 'gif', 'image', 'small'].includes(k)) bits.push(h ? 'высота ' + h + ' px' : 'размер как в оригинале');
  if (['video', 'gif', 'small'].includes(k) && fps) bits.push(fps + ' fps');
  if (['video', 'audio', 'small'].includes(k)) bits.push('звук ' + $('abr').value + ' kbps');
  return `Получится: <b>${esc(F.n)}</b>` + (bits.length ? ' · ' + bits.join(' · ') : '');
}
$('pvClose').onclick = () => { prevPath = ''; $('prev').classList.add('hide'); };
$('prev').addEventListener('click', e => { if (e.target === $('prev')) $('pvClose').click(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('prev').classList.contains('hide')) $('pvClose').click(); });

