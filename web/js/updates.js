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
// ---------- окна «Что нового» и «Вышел Kombain X.Y»: поверх программы, раскладку не сдвигают ----------
// текст из CHANGELOG: «- пункт» становится списком, «## 2.2» (если версий несколько) — заголовком
function notesHtml(text) {
  let html = '', ul = false;
  for (const raw of String(text || '').split('\n')) {
    const l = raw.trim();
    if (!l) continue;
    const li = /^[-*•]\s+/.test(l);
    if (li !== ul) { html += li ? '<ul>' : '</ul>'; ul = li; }
    if (li) html += `<li>${esc(l.replace(/^[-*•]\s+/, ''))}</li>`;
    else if (/^#+\s/.test(l)) html += `<h4>${esc(l.replace(/^#+\s+/, ''))}</h4>`;
    else html += `<p>${esc(l)}</p>`;
  }
  return html + (ul ? '</ul>' : '');
}
// не перерисовывать список при каждом опросе: иначе сбрасывается прокрутка
function setNotes(el, text) {
  if (el.dataset.src === text) return;
  el.dataset.src = text;
  el.innerHTML = notesHtml(text);
}
const setupOpen = () => !$('setup').classList.contains('hide');

let newsClosed = false;
// страница тоже помнит «Понятно»: если отметка программы не сохранилась, окно не вернётся, а отметка уйдёт ещё раз
function newsMark(ver) {
  try { if (ver === undefined) return localStorage.getItem('konv9000.newsSeen'); localStorage.setItem('konv9000.newsSeen', ver); } catch (e) {}
}
const newsOn = s => !!s.news && !newsClosed && !setupOpen();
function newsBanner(s) {
  const ver = (s.app || {}).version;
  if (s.news && !newsClosed && ver && newsMark() === ver) { newsClosed = true; api('news-seen'); }
  const on = newsOn(s);
  $('newsWin').classList.toggle('hide', !on);
  if (!on) return;
  $('newsTitle').textContent = 'Kombain ' + (ver || '');
  setNotes($('newsNotes'), lang === 'en' && s.newsEn ? s.newsEn : s.news);
}
const newsClose = () => { newsClosed = true; newsMark((snap.app || {}).version || ''); newsBanner(snap); appBanner(snap); api('news-seen'); };
$('newsOk').onclick = newsClose;
$('newsX').onclick = newsClose;
$('newsWin').addEventListener('click', e => { if (e.target === $('newsWin')) newsClose(); });

let appDismissed = null, appMode = '';
function appBanner(s) {
  const u = s.appUpd || {}, run = !!s.running;
  const off = appDismissed === (u.latest || '');
  let mode = '';
  if (u.restart) mode = 'restart';
  else if (u.active) mode = 'dl';
  else if (u.update && u.supported && u.err && !off) mode = 'err';
  else if (u.update && u.supported && !u.skipped && !off) mode = 'upd';
  if (setupOpen() || newsOn(s)) mode = ''; // сначала «Что нового», потом предложение обновиться
  appMode = mode;
  $('appWin').classList.toggle('hide', !mode);
  if (!mode) return;
  const show = (id, on) => $(id).classList.toggle('hide', !on);
  const ask = mode === 'upd' || mode === 'err';
  show('appRow', ask);
  show('appX', ask);
  show('appSkip', mode === 'upd');
  show('appProg', mode === 'dl');
  const notes = mode === 'upd' && !!u.notes;
  show('appBody', notes);
  const card = $('appCard');
  card.classList.toggle('compact', !notes);
  card.classList.toggle('dl', mode === 'dl');
  card.querySelector('.upd-ico').classList.toggle('ok', mode === 'restart');
  $('appGo').disabled = run;
  $('appGo').textContent = mode === 'err' ? t('btn.retry') : t('btn.update');
  $('appGo').title = run ? t('app.waitConvert') : '';
  $('appProg').firstElementChild.style.width = (u.pct || 0) + '%';
  const cur = (s.app || {}).version || '';
  // строка под заголовком: в обычном окне «2.2 → 2.3 · перезапустится сама»
  let eye = t('app.updateTitle'), title, meta;
  if (mode === 'upd') {
    eye = t('app.eyeNew'); title = 'Kombain ' + u.latest;
    meta = (cur ? `<span class="upd-ver"><s>${esc(cur)}</s>→<b>${esc(u.latest)}</b></span>` : '') +
      `<span>${esc(t('app.restartNote'))}</span>` + (run ? `<span class="upd-warn">${esc(t('app.afterConvert').trim())}</span>` : '');
  } else if (mode === 'dl') { title = t('app.dlTitle', {v: u.latest}); meta = `<span>${Math.round(u.pct || 0)}%</span>`; }
  else if (mode === 'err') { title = t('app.failTitle'); meta = `<span>${esc(t('app.failSub', {err: u.err}))}</span>`; }
  else { title = t('app.restartTitle', {v: u.latest}); meta = `<span>${esc(t('app.restartSub'))}</span>`; }
  $('appEye').textContent = eye;
  $('appTitle').textContent = title;
  if ($('appMeta').innerHTML !== meta) $('appMeta').innerHTML = meta;
  if (notes) setNotes($('appNotes'), lang === 'en' && u.notesEn ? u.notesEn : u.notes);
}
$('appGo').onclick = async () => {
  const r = await api('app-update');
  if (r.error) say('err', t('app.updateTitle'), r.error);
};
// закрыть можно, только пока программа спрашивает: скачивание и перезапуск идут до конца
const appDismiss = () => { if (appMode !== 'upd' && appMode !== 'err') return; appDismissed = (snap.appUpd || {}).latest || ''; appBanner(snap); };
$('appLater').onclick = appDismiss;
$('appX').onclick = appDismiss;
$('appWin').addEventListener('click', e => { if (e.target === $('appWin')) appDismiss(); });
$('appSkip').onclick = async () => { await api('app-skip'); appDismiss(); };
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!$('newsWin').classList.contains('hide')) { e.stopPropagation(); newsClose(); }
  else if (!$('appWin').classList.contains('hide')) { e.stopPropagation(); appDismiss(); }
}, true);
