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
    text = dl.err ? t('ffu.dlFailed', {err: esc(dl.err)}) : t('ffu.notFound') + (v.latest ? t('ffu.willFetch', {v: esc(v.latest)}) : '');
    btn = t('ffu.dlBtn'); note = t('ffu.oneTime');
  } else if (mode === 'dl') {
    text = noFF ? t('ffu.downloading') : v.latest ? t('ffu.updatingTo', {v: esc(v.latest)}) : t('ffu.updating');
    note = t('ffu.progress', {pct: Math.round(dl.pct || 0)});
  } else if (mode === 'err') {
    text = t('ffu.updFailed', {err: esc(dl.err)});
    btn = t('btn.retry');
  } else if (mode === 'upd') {
    text = t('ffu.available', {v: esc(v.latest), local: esc(v.local)});
    btn = t('btn.update');
  } else if (mode === 'done') {
    text = t('ffu.updated', {v: esc(v.local || shortVer(v.localRaw))});
  }
  $('ffText').innerHTML = text;
  if (btn) $('ffDl').textContent = btn;
  $('ffNote').textContent = note;
}
// ---------- плашка «Что нового» после обновления ----------
let newsClosed = false;
// страница тоже помнит «Понятно»: если отметка программы не сохранилась, окно не вернётся, а отметка уйдёт ещё раз
function newsMark(ver) {
  try { if (ver === undefined) return localStorage.getItem('konv9000.newsSeen'); localStorage.setItem('konv9000.newsSeen', ver); } catch (e) {}
}
function newsBanner(s) {
  const ver = (s.app || {}).version;
  if (s.news && !newsClosed && ver && newsMark() === ver) { newsClosed = true; api('news-seen'); }
  const on = !!s.news && !newsClosed && $('setup').classList.contains('hide');
  $('newsBanner').classList.toggle('hide', !on);
  if (!on) return;
  $('newsText').innerHTML = t('app.news', {v: esc((s.app || {}).version || '')});
  const news = lang === 'en' && s.newsEn ? s.newsEn : s.news;
  if ($('newsNotes').textContent !== news) $('newsNotes').textContent = news; // не сбрасывать прокрутку при каждом опросе
}
$('newsOk').onclick = () => { newsClosed = true; newsMark((snap.app || {}).version || ''); newsBanner(snap); api('news-seen'); };
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
  $('appGo').textContent = mode === 'err' ? t('btn.retry') : t('btn.update');
  $('appGo').title = run ? t('app.waitConvert') : '';
  $('appProg').firstElementChild.style.width = (u.pct || 0) + '%';
  let text = '';
  if (mode === 'upd') text = t('app.available', {v: esc(u.latest), cur: esc((s.app || {}).version || '')}) +
    (run ? t('app.afterConvert') : '');
  else if (mode === 'dl') text = t('app.downloading', {v: esc(u.latest), pct: Math.round(u.pct || 0)});
  else if (mode === 'err') text = t('app.failed', {err: esc(u.err)});
  else text = t('app.restarting', {v: esc(u.latest)});
  $('appText').innerHTML = text;
  if (mode === 'upd') $('appNotes').textContent = lang === 'en' && u.notesEn ? u.notesEn : u.notes;
}
$('appGo').onclick = async () => {
  const r = await api('app-update');
  if (r.error) say('err', t('app.updateTitle'), r.error);
};
const appDismiss = () => { appDismissed = (snap.appUpd || {}).latest || ''; appBanner(snap); };
$('appLater').onclick = appDismiss;
$('appSkip').onclick = async () => { await api('app-skip'); appDismiss(); };

