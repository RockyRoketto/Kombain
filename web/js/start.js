// ---------- запуск ----------
let lastReq = null, startSent = false;
function currentReq() {
  return {
    format: fmt,
    crf: +$('crf').value, abr: +$('abr').value || 192, preset: $('speed').value,
    height: $('height').value, fps: $('fps').value, extra: $('extra').value,
    outDir: outMode === 'folder' ? $('outDir').value.trim() : '', dropOut,
    sameDir: outMode === 'same', overwrite: $('overwrite').checked, copy: $('copyDup').checked,
    jobs: +$('jobs').value || 1,
    codec: $('codec').value, targetMB: +$('target').value > 0 ? +$('target').value : 0,
    join: joinOn(), joinFps: $('joinFps').value, gifPalette: $('gifPalette').value,
    trims: Object.fromEntries(files.filter(f => f.trim && f.path).map(f => [f.path, f.trim])),
    montages: Object.fromEntries(files.filter(f => f.project).map(f => [f.path, f.project]))
  };
}
// startBatch: запуск пачки; base — настройки (по умолчанию текущие), over — разовые поправки (копия/перезапись)
async function startBatch(paths, base, over) {
  if (snap.running) { say('warn', t('start.waitTitle'), t('start.wait')); return; }
  paths = withFrames(paths);
  paths.forEach(p => delete res[p]);
  joined = {};
  snap.files = [];
  newBatch();
  lastReq = Object.assign({}, base || currentReq(), over || {}, {files: paths});
  startSent = true;
  const r = await api('start', lastReq);
  startSent = false;
  if (r.error) say('err', t('start.failed'), r.error);
  else { snap.running = true; joined = r.joined || {}; }   // точное состояние придёт со следующим опросом
}
// повтор из всплывашки знает только первый кадр видео: возвращаем остальные
function withFrames(paths) {
  const wanted = new Set(paths), out = new Set(paths);
  for (const [frame, lead] of Object.entries(joined)) if (wanted.has(lead)) out.add(frame);
  return [...out];
}
$('start').onclick = async () => {
  if (startSent || snap.running) return;   // двойной клик: опрос состояния ещё не успел обновить кнопку
  if (!files.length) { say('warn', t('start.emptyTitle'), t('start.empty')); return; }
  const chosen = files.filter(f => f.sel && f.path);
  if (!chosen.length) { say('warn', t('start.noneTitle'), t('start.none')); return; }
  if (pending) return;
  if (outMode === 'folder' && !$('outDir').value.trim()) { say('warn', t('start.whereTitle'), t('start.where')); return; }
  startBatch(chosen.map(f => f.path));
};
$('stop').onclick = () => api('cancel');
$('openOut').onclick = async () => { const r = await api('open-output'); if (r.error) alert(r.error); };
$('ffDl').onclick = async () => {
  ffDismissed = null;
  const r = await api('download-ffmpeg');
  if (r.error) alert(r.error);
};
const ffDismiss = () => { ffDismissed = (snap.ffv || {}).latest || ''; ffBanner(snap); };
$('ffLater').onclick = ffDismiss;
$('ffSkip').onclick = async () => { await api('ffmpeg-skip'); ffDismiss(); };

