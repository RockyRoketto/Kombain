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
    codec: $('codec').value, targetMB: +$('target').value > 0 ? +$('target').value : 0
  };
}
// startBatch: запуск пачки; base — настройки (по умолчанию текущие), over — разовые поправки (копия/перезапись)
async function startBatch(paths, base, over) {
  if (snap.running) { say('warn', 'Подожди', 'Сейчас идёт конвертация — дождись конца или останови её.'); return; }
  paths.forEach(p => delete res[p]);
  snap.files = [];
  newBatch();
  lastReq = Object.assign({}, base || currentReq(), over || {}, {files: paths});
  startSent = true;
  const r = await api('start', lastReq);
  startSent = false;
  if (r.error) say('err', 'Не запустилось', r.error);
  else snap.running = true;   // точное состояние придёт со следующим опросом
}
$('start').onclick = async () => {
  if (startSent || snap.running) return;   // двойной клик: опрос состояния ещё не успел обновить кнопку
  if (!files.length) { say('warn', 'Список пуст', 'Добавь файлы: перетащи их в окно или нажми «+ Файлы».'); return; }
  const chosen = files.filter(f => f.sel && f.path);
  if (!chosen.length) { say('warn', 'Ничего не отмечено', 'Отметь галочками файлы, которые надо конвертировать.'); return; }
  if (pending) return;
  if (outMode === 'folder' && !$('outDir').value.trim()) { say('warn', 'Куда сохранять?', 'Выбери папку для сохранения или переключись на «Рядом с оригиналом».'); return; }
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

