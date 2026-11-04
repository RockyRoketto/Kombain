// ---------- плашка ffmpeg: нет / скачивается / вышла новая версия ----------
// «Не сейчас» запоминает версию: когда выйдет более новая, плашка появится снова
let ffDismissed = null, ffWasActive = false, ffDoneUntil = 0;
function ffBanner(s) {
  const dl = s.dl || {}, v = s.ffv || {}, noFF = !s.ffmpeg;
  const off = ffDismissed === (v.latest || '');
  let mode = '';
  if (dl.active) mode = 'dl';
  else if (noFF) mode = 'none';
  else if (dl.err && !off) mode = 'err';
  else if (Date.now() < ffDoneUntil) mode = 'done';
  else if (v.update && !v.skipped && !off) mode = 'upd';
  if (!$('setup').classList.contains('hide')) mode = ''; // всё видно в окне установки
  const b = $('ffBanner');
  b.classList.toggle('hide', !mode);
  b.classList.toggle('okb', mode === 'done');
  if (!mode) return;
  const show = (id, on) => $(id).classList.toggle('hide', !on);
  show('ffRow', mode !== 'done');
  show('ffDl', mode === 'none' || mode === 'err' || mode === 'upd');
  show('ffLater', mode === 'err' || mode === 'upd');
  show('ffSkip', mode === 'upd');
  show('ffProg', mode === 'dl');
  $('ffDl').disabled = !!dl.active;
  $('ffProg').firstElementChild.style.width = (dl.pct || 0) + '%';
  let text = '', btn = '', note = '';
  if (mode === 'none') {
    text = dl.err ? '<b>Не удалось скачать ffmpeg:</b> ' + esc(dl.err) : '<b>ffmpeg не найден.</b>' + (v.latest ? ` Скачаем свежий ${esc(v.latest)}.` : '');
    btn = 'Скачать ffmpeg автоматически (~100 МБ)'; note = 'Скачается один раз и сохранится.';
  } else if (mode === 'dl') {
    text = noFF ? '<b>Скачиваю ffmpeg…</b>' : `<b>Обновляю ffmpeg${v.latest ? ' до ' + esc(v.latest) : ''}…</b> Конвертировать можно будет сразу после.`;
    note = 'Скачивание: ' + Math.round(dl.pct || 0) + '%';
  } else if (mode === 'err') {
    text = '<b>Не удалось обновить ffmpeg:</b> ' + esc(dl.err) + '. Старый остался и работает.';
    btn = 'Повторить';
  } else if (mode === 'upd') {
    text = `<b>Вышел ffmpeg ${esc(v.latest)}.</b> У тебя ${esc(v.local)}. Обновить? (~100 МБ)`;
    btn = 'Обновить';
  } else if (mode === 'done') {
    text = `<b>ffmpeg обновлён ✓</b> Теперь ${esc(v.local || shortVer(v.localRaw))}.`;
  }
  $('ffText').innerHTML = text;
  if (btn) $('ffDl').textContent = btn;
  $('ffNote').textContent = note;
}
// ---------- плашка «Что нового» после обновления ----------
let newsClosed = false;
function newsBanner(s) {
  const on = !!s.news && !newsClosed && $('setup').classList.contains('hide');
  $('newsBanner').classList.toggle('hide', !on);
  if (!on) return;
  $('newsText').innerHTML = `<b>Конвертер обновлён до ${esc((s.app || {}).version || '')}.</b> Что нового:`;
  if ($('newsNotes').textContent !== s.news) $('newsNotes').textContent = s.news; // не сбрасывать прокрутку при каждом опросе
}
$('newsOk').onclick = () => { newsClosed = true; newsBanner(snap); api('news-seen'); };
// ---------- плашка новой версии Конвертера ----------
let appDismissed = null;
function appBanner(s) {
  const u = s.appUpd || {}, run = !!s.running;
  const off = appDismissed === (u.latest || '');
  let mode = '';
  if (u.restart) mode = 'restart';
  else if (u.active) mode = 'dl';
  else if (u.update && u.supported && u.err && !off) mode = 'err';
  else if (u.update && u.supported && !u.skipped && !off) mode = 'upd';
  if (!$('setup').classList.contains('hide')) mode = '';
  const b = $('appBanner');
  b.classList.toggle('hide', !mode);
  b.classList.toggle('okb', mode === 'restart');
  if (!mode) return;
  const show = (id, on) => $(id).classList.toggle('hide', !on);
  show('appRow', mode === 'upd' || mode === 'err');
  show('appSkip', mode === 'upd');
  show('appProg', mode === 'dl');
  show('appNotes', mode === 'upd' && !!u.notes);
  $('appGo').disabled = run;
  $('appGo').textContent = mode === 'err' ? 'Повторить' : 'Обновить';
  $('appGo').title = run ? 'Сначала дождись конца конвертации' : '';
  $('appProg').firstElementChild.style.width = (u.pct || 0) + '%';
  let text = '';
  if (mode === 'upd') text = `<b>Вышел Конвертер ${esc(u.latest)}.</b> У тебя ${esc((s.app || {}).version || '')}. Обновить? Программа перезапустится сама.` +
    (run ? ' Можно будет после конца конвертации.' : '');
  else if (mode === 'dl') text = `<b>Скачиваю Конвертер ${esc(u.latest)}…</b> ${Math.round(u.pct || 0)}%`;
  else if (mode === 'err') text = '<b>Не удалось обновить Конвертер:</b> ' + esc(u.err) + '. Старая версия работает как раньше.';
  else text = `<b>Конвертер обновлён до ${esc(u.latest)} ✓</b> Перезапускаю…`;
  $('appText').innerHTML = text;
  if (mode === 'upd') $('appNotes').textContent = u.notes;
}
$('appGo').onclick = async () => {
  const r = await api('app-update');
  if (r.error) say('err', 'Обновление', r.error);
};
const appDismiss = () => { appDismissed = (snap.appUpd || {}).latest || ''; appBanner(snap); };
$('appLater').onclick = appDismiss;
$('appSkip').onclick = async () => { await api('app-skip'); appDismiss(); };

