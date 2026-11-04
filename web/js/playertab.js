// ---------- вкладка «Плеер»: смотреть файлы, не добавляя их в конвертацию ----------
let plFiles = [];       // очередь: {name, dir, path, size}
let plCur = null;       // что открыто
let plHeld = null;      // {at}: плеер отпущен ради окна просмотра или обрезки
let plLast = '';
const plr = makePlayer('pl', {canPlay: () => tab === 'play'});

function plPlay(it) {
  plCur = it; plHeld = null;
  $('plName').textContent = it.name;
  plr.open(it);
  if (document.activeElement) document.activeElement.blur();   // иначе пробел нажмёт кнопку, а не поставит на паузу
  plButtons();
  plRender();
}
function plStop() {
  plr.release();
  plCur = null; plHeld = null;
  plRender();
}
// Файлы снаружи: первый из них играет сразу. Что уже в очереди, второй раз не встаёт.
function plAdd(list) {
  const bad = [];
  let first = null;
  for (const f of list || []) {
    const name = base(f.path);
    if (!MEDIA.test(name)) { bad.push(name); continue; }
    let it = plFiles.find(x => x.path.toLowerCase() === f.path.toLowerCase());
    if (!it) { it = {name, dir: dirOf(f.path), path: f.path, size: f.size}; plFiles.push(it); }
    first = first || it;
  }
  if (bad.length) say('warn', t('pl.notMedia'), bad.join(', '));
  if (first) plPlay(first); else plRender();
}
function plRemove(it) {
  const i = plFiles.indexOf(it);
  plFiles = plFiles.filter(x => x !== it);
  if (it !== plCur) { plRender(); return; }
  const next = plFiles[i] || plFiles[i - 1];
  if (next) plPlay(next); else plStop();
}
function plRender() {
  const has = !!plCur;
  $('plEmpty').classList.toggle('hide', has);
  $('plBody').classList.toggle('hide', !has);
  $('plHint').classList.toggle('hide', plFiles.length > 0);
  $('plCnt').textContent = plFiles.length ? tn(plFiles.length, 'n.pcs') : '';
  const html = plFiles.map((it, i) =>
    `<div class="f sel${it === plCur ? ' cur' : ''}" data-i="${i}" title="${esc(it.path)}">` +
    `<div class="badge th${TRIMMABLE.test(it.name) ? ' vid' : ''}"><img src="${thumbUrl(it.path, .1, 160)}" alt="" loading="lazy" onerror="this.remove()"><span class="ex">${esc(ext(it.name))}</span></div>` +
    `<div class="meta"><div class="n">${esc(it.name)}</div><div class="sub">${fmtSize(it.size)}</div></div>` +
    `<button class="x" title="${t('list.remove')}">✕</button></div>`).join('');
  if (html !== plLast) { $('plList').innerHTML = html; plLast = html; }
}
// кнопки зависят от файла и от того, идёт ли конвертация; зовёт и опрос (updateButtons)
function plButtons() {
  $('plToConv').disabled = $('plTrim').disabled = snap.running;
  $('plTrim').classList.toggle('hide', !plCur || !TRIMMABLE.test(plCur.name));
}
// окно просмотра или обрезки заняло копию для просмотра (она готовится одна): плеер отпускает файл и помнит место
function plHold() {
  if (!plCur || plHeld) return;
  plHeld = {at: plr.v.currentTime};
  plr.release();
}
function plTabChanged() {
  if (tab !== 'play') { plr.v.pause(); return; }
  if (plHeld) { const at = plHeld.at; plHeld = null; plr.open(plCur, at); }
  plRender();
}
// отправить файл на вкладку конвертера: возвращает его строку в списке
function plSend(it) {
  addInfos([it]);
  setTab('conv');
  return files.find(f => f.path === it.path);
}

plr.v.addEventListener('ended', () => {
  const next = plFiles[plFiles.indexOf(plCur) + 1];
  if (next && tab === 'play') plPlay(next);
});
$('plList').addEventListener('click', e => {
  const row = e.target.closest('.f'); if (!row) return;
  const it = plFiles[+row.dataset.i]; if (!it) return;
  if (e.target.closest('.x')) plRemove(it);
  else if (it !== plCur) plPlay(it);
});
$('plAddFiles').onclick = () => dialog(async () => { const r = await api('pick-files'); if (r.error) alert(r.error); plAdd(r.files); });
$('plAddFolder').onclick = () => dialog(async () => { const r = await api('pick-folder', {purpose:'add'}); if (r.error) alert(r.error); plAdd(r.files); });
$('plClear').onclick = () => { plFiles = []; plStop(); };
$('plToConv').onclick = () => { if (plCur && !snap.running) plSend(plCur); };
$('plTrim').onclick = () => {
  if (!plCur || snap.running) return;
  const f = plSend(plCur);
  if (f) openTrim(f);
};
$('plFolder').onclick = async () => {
  if (!plCur) return;
  const r = await api('open-dir', {path: plCur.dir});
  if (r.error) say('warn', t('folder.title'), r.error);
};
// те же клавиши, что в окне просмотра; кнопки с текстом пробел нажимает как обычно
document.addEventListener('keydown', e => {
  if (tab !== 'play' || !plCur || document.querySelector('.modal:not(.hide)') || e.target.closest('.btn')) return;
  plr.key(e);
});

