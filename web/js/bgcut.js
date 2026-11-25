// ---------- «Убрать фон» в «Утилитах»: любые картинки с диска, результат <имя>-nobg.png рядом (bgremove.go, /api/bg-file) ----------
let bgFiles = [];         // {name, dir, path, size, st: '' | run | ok | error, msg, out}
let bgBusy = false;
let bgSel = "";          // выбранная щелчком строка: её открывает «Доработать» в карточке справа (пусто — первая)
// значок «Доработать» (кисть с искрой): тот же, что у кнопки в галерее генератора (index.html, #gnLbFix)
const CE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 3.5a2 2 0 0 0-2.8 0L9.5 11.7l2.8 2.8 8.2-8.2a2 2 0 0 0 0-2.8z"/><path d="M9 12.5c-2 0-3.5 1.5-3.5 3.5 0 1.6-1.2 2.4-2.5 2.8 1 1 2.6 1.7 4.5 1.7 2.5 0 4.3-1.8 4.3-4.3"/><path d="M5 2.5v4M3 4.5h4"/></svg>';
const BG_EXT = /\.(png|jpe?g|webp|gif)$/i;
function bgAdd(list) {
  const have = new Set(bgFiles.map(f => f.path.toLowerCase()));
  let skipped = 0;
  for (const f of list || []) {
    if (!BG_EXT.test(f.path)) { skipped++; continue; }
    if (have.has(f.path.toLowerCase())) continue;
    bgFiles.push({name: base(f.path), dir: dirOf(f.path), path: f.path, size: f.size, st: ''});
    have.add(f.path.toLowerCase());
  }
  if (skipped && !bgFiles.length) say('warn', t('drop.notSuitableTitle'), t('bgc.onlyImg'));
  bgRender();
}
function bgRender() {
  const list = bgFiles.map(it => {
    const sub = it.st === 'run' ? utRunSub(it, bgFiles) : it.st === 'error' ? esc(it.msg) : it.st === 'ok' ? esc(t('bgc.saved', {name: base(it.out)})) : esc(it.dir) + ' · ' + fmtSize(it.size);
    const pill = it.st === 'run' ? '<span class="spin"></span>' : it.st === 'ok' ? t('status.ok') : it.st === 'error' ? t('status.error') : '';
    const ext = it.name.split('.').pop().toLowerCase();
    return `<div class="f sel ${it.st === 'run' ? 'running' : it.st}${bgFixItem() === it && bgFiles.length > 1 ? ' picked' : ''}" data-bgp="${esc(it.path)}" title="${esc(it.path)}">` +
      (snap.ffmpeg ? `<div class="badge th"><img src="${thumbUrl(it.path, .1, 160)}" alt="" loading="lazy" onerror="this.remove()"><span class="ex">${esc(ext)}</span></div>` : `<div class="badge">${esc(ext)}</div>`) +
      `<div class="meta"><div class="n">${esc(it.name)}</div><div class="sub">${sub}</div></div>` +
      (it.st === 'ok' ? `<button class="cmpb" data-bgc="${esc(it.path)}">${t('ut.cmp')}</button><button class="cmpb ce-go" data-bgf="${esc(it.path)}" title="${esc(t('ce.btn') + ': ' + t('ce.btnS'))}" aria-label="${esc(t('ce.btn'))}">${CE_ICON}<span>${t('ce.btn')}</span></button>` : '') +
      `<div class="pill">${pill}</div>` + (bgBusy ? '' : `<button class="x" data-bgx="${esc(it.path)}" title="${t('list.remove')}">✕</button>`) + '</div>';
  }).join('');
  if ($('bgList').innerHTML !== list) { $('bgList').innerHTML = list; nextGlowSync(); }
  $('bgEmpty').classList.toggle('hide', bgFiles.length > 0);
  $('bgList').classList.toggle('hide', !bgFiles.length);
  $('bgCnt').textContent = bgFiles.length ? String(bgFiles.length) : '';
  $('bgAddFiles').disabled = $('bgAddFolder').disabled = $('bgClear').disabled = $('bgOutDir').disabled = $('bgPickOut').disabled = bgBusy;
  bgFixSync();
  updateButtons();
}
const bgPending = () => bgFiles.filter(f => f.st !== 'ok');
let bgAbort = null;       // «Стоп»: обрыв запроса, сервер бросает картинку и гасит обработчик
async function bgRun() {
  if (bgBusy || !bgPending().length) return;
  if (bgOutMode === 'folder' && !$('bgOutDir').value.trim()) { say('warn', t('start.whereTitle'), t('start.where')); return; }
  const outDir = bgOutMode === 'folder' ? $('bgOutDir').value.trim() : '';
  bgBusy = true; bgAbort = new AbortController(); bgRender();
  let done = 0, fail = 0, last = '', stopped = false;
  for (const it of bgPending()) {
    it.st = 'run'; it.t0 = Date.now(); bgRender();
    const r = await api('bg-file', {path: it.path, outDir}, bgAbort.signal);
    if (r.aborted) { stopped = true; break; }
    if (r.error) {
      it.st = 'error'; it.msg = r.error; fail++;
      if (r.needModel) { bgNeedModel(r.error); break; }
    } else { it.st = 'ok'; it.out = r.path; done++; last = r.path; }
    bgRender();
  }
  bgFiles.forEach(f => { if (f.st === 'run') f.st = ''; });
  bgBusy = false; bgAbort = null; bgRender();
  if (stopped) toast({type: 'warn', title: t('upc.stopped'), text: done ? esc(t('bgc.done', {n: done})) : '', ttl: 3000});
  else if (done) toast({type: 'ok', title: t('bgc.done', {n: done}), text: fail ? esc(t('bgc.fail', {n: fail})) : '', ttl: 4000, actions: last ? [{t: t('bgc.show'), fn: () => api('gen-reveal', {path: last})}] : []});
  // следующий шаг — «Доработать» у первой готовой строки
  const first = bgFiles.find(f => f.st === 'ok');
  if (done && first) nextGlow(`#bgList [data-bgf="${CSS.escape(first.path)}"]`);
  else if (fail) toast({type: 'warn', title: t('gg.bgFail'), text: esc(bgFiles.find(f => f.st === 'error').msg), ttl: 8000});
}
function bgNeedModel(msg) {
  toast({type: 'warn', title: t('gg.bgFail'), text: esc(msg), ttl: 8000, actions: [{t: t('gn.err.models'), fn: () => { setTab('gen'); gmOpen(true); }}]});
}
// куда сохранять: рядом с оригиналом или в свою папку (запоминается)
const BG_KEY = 'k9000.bgOut';
let bgOutMode = 'same';   // same | folder
function bgOutSync() {
  document.querySelectorAll('#bgOutMode .segb').forEach(b => b.classList.toggle('on', b.dataset.m === bgOutMode));
  $('bgFolderRow').classList.toggle('hide', bgOutMode !== 'folder');
  plDir('bgLine', bgOutMode === 'folder' ? $('bgOutDir').value : '');
}
function bgOutSave() {
  try { localStorage.setItem(BG_KEY, JSON.stringify({mode: bgOutMode, dir: $('bgOutDir').value.trim()})); } catch (e) {}
  plDir('bgLine', bgOutMode === 'folder' ? $('bgOutDir').value : '');
}
try {
  const o = JSON.parse(localStorage.getItem(BG_KEY) || 'null');
  if (o && typeof o.dir === 'string') $('bgOutDir').value = o.dir;
  if (o && o.mode === 'folder') bgOutMode = 'folder';
} catch (e) {}
bgOutSync();
$('bgOutMode').addEventListener('click', e => {
  const b = e.target.closest('.segb'); if (!b || bgBusy) return;
  bgOutMode = b.dataset.m; bgOutSync(); bgOutSave();
  if (bgOutMode === 'folder' && !$('bgOutDir').value.trim()) $('bgPickOut').click();
});
$('bgOutDir').addEventListener('input', bgOutSave);
$('bgPickOut').onclick = () => dialog(async () => {
  const r = await api('pick-folder', {purpose: 'out'});
  if (r.error) alert(r.error);
  if (r.path) { $('bgOutDir').value = r.path; bgOutMode = 'folder'; bgOutSync(); bgOutSave(); }
});
pickButtons('bgAddFiles', 'bgAddFolder', bgAdd);
$('bgClear').onclick = () => { if (!bgBusy) { bgFiles = []; bgSel = ''; bgRender(); } };
$('bgStart').onclick = bgRun;
$('bgStop').onclick = () => { if (bgAbort) bgAbort.abort(); };
$('bgList').addEventListener('click', e => {
  const c = e.target.closest('[data-bgc]'), it = c && bgFiles.find(f => f.path === c.dataset.bgc);
  if (it && it.out) { utCmpOpen(it.path, it.out, true, it.name); return; }
  // «Доработать» в строке: правится последняя готовая копия, оригинал — исходный файл строки (cutedit.js)
  const f = e.target.closest('[data-bgf]'), fi = f && bgFiles.find(x => x.path === f.dataset.bgf);
  if (fi) { bgFixOpen(fi); return; }
  const x = e.target.closest('[data-bgx]');
  if (x && !bgBusy) { bgFiles = bgFiles.filter(f => f.path !== x.dataset.bgx); if (bgSel === x.dataset.bgx) bgSel = ''; bgRender(); return; }
  // щелчок по строке выбирает файл для «Доработать» в карточке справа
  const row = e.target.closest('[data-bgp]');
  if (row && bgSel !== row.dataset.bgp) { bgSel = row.dataset.bgp; bgRender(); }
});
// карточка «Редактор вырезки» справа: одна кнопка «Доработать» на файле из списка слева — выбранном щелчком или первом.
// Готовый после «Убрать фон» открывается вырезкой (оригинал — исходный файл), необработанный — как есть, с фоном.
// Пока список пуст или идёт обработка, кнопка неактивна.
const bgFixItem = () => bgFiles.find(f => f.path === bgSel) || bgFiles[0] || null;
function bgFixSync() {
  const it = bgFixItem(), b = $('bgFixPick');
  b.disabled = !it || bgBusy;
  const tip = it ? t('ce.dockOn', {name: it.name}) : t('ce.dockOff');
  b.title = tip;
  $('bgFixNote').textContent = tip;
}
function bgFixOpen(it) {
  if (!it || bgBusy) return;
  if (it.out) ceOpen({path: it.out, src: it.path, done: p => { it.out = p; bgRender(); }});
  else ceOpen({path: it.path});
}
$('bgFixPick').onclick = () => bgFixOpen(bgFixItem());
bgFixSync();   // подсказка «Положи картинку слева» сразу при запуске
