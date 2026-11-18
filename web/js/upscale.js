// ---------- «Увеличить» в «Утилитах»: любые картинки с диска, результат <имя>-x2.png или -x4.png рядом (upscale.go, /api/up-file) ----------
let upFiles = [];         // {name, dir, path, size, st: '' | run | ok | error, msg, out}
let upBusy = false;
let upAbort = null;       // «Стоп»: обрыв запроса, сервер останавливает sd-cli
const UP_EXT = /\.(png|jpe?g|webp|gif)$/i;
function upAdd(list) {
  const have = new Set(upFiles.map(f => f.path.toLowerCase()));
  let skipped = 0;
  for (const f of list || []) {
    if (!UP_EXT.test(f.path)) { skipped++; continue; }
    if (have.has(f.path.toLowerCase())) continue;
    upFiles.push({name: base(f.path), dir: dirOf(f.path), path: f.path, size: f.size, st: ''});
    have.add(f.path.toLowerCase());
  }
  if (skipped && !upFiles.length) say('warn', t('drop.notSuitableTitle'), t('bgc.onlyImg'));
  upRender();
}
function upRender() {
  const list = upFiles.map(it => {
    const sub = it.st === 'error' ? esc(it.msg) : it.st === 'ok' ? esc(t('upc.saved', {name: base(it.out)})) : esc(it.dir) + ' · ' + fmtSize(it.size);
    const pill = it.st === 'run' ? '<span class="spin"></span>' : it.st === 'ok' ? t('status.ok') : it.st === 'error' ? t('status.error') : '';
    const ext = it.name.split('.').pop().toLowerCase();
    return `<div class="f sel ${it.st === 'run' ? 'running' : it.st}" title="${esc(it.path)}">` +
      (snap.ffmpeg ? `<div class="badge th"><img src="${thumbUrl(it.path, .1, 160)}" alt="" loading="lazy" onerror="this.remove()"><span class="ex">${esc(ext)}</span></div>` : `<div class="badge">${esc(ext)}</div>`) +
      `<div class="meta"><div class="n">${esc(it.name)}</div><div class="sub">${sub}</div></div>` +
      `<div class="pill">${pill}</div>` + (upBusy ? '' : `<button class="x" data-upx="${esc(it.path)}" title="${t('list.remove')}">✕</button>`) + '</div>';
  }).join('');
  if ($('upList').innerHTML !== list) $('upList').innerHTML = list;
  $('upEmpty').classList.toggle('hide', upFiles.length > 0);
  $('upList').classList.toggle('hide', !upFiles.length);
  $('upCnt').textContent = upFiles.length ? String(upFiles.length) : '';
  $('upAddFiles').disabled = $('upAddFolder').disabled = $('upClear').disabled = $('upFactor').disabled = $('upKind').disabled = $('upOutDir').disabled = $('upPickOut').disabled = upBusy;
  updateButtons();
}
const upPending = () => upFiles.filter(f => f.st !== 'ok');
async function upRun() {
  if (upBusy || !upPending().length) return;
  const factor = +$('upFactor').value, kind = $('upKind').value;
  if (upOutMode === 'folder' && !$('upOutDir').value.trim()) { say('warn', t('start.whereTitle'), t('start.where')); return; }
  const outDir = upOutMode === 'folder' ? $('upOutDir').value.trim() : '';
  upBusy = true; upAbort = new AbortController(); upRender();
  let done = 0, fail = 0, last = '', stopped = false;
  for (const it of upPending()) {
    it.st = 'run'; upRender();
    const r = await api('up-file', {path: it.path, factor, kind, outDir}, upAbort.signal);
    if (r.aborted) { stopped = true; break; }
    if (r.error) {
      it.st = 'error'; it.msg = r.error; fail++;
      if (r.needModel) { upNeedModel(r.error); break; }
    } else { it.st = 'ok'; it.out = r.path; done++; last = r.path; }
    upRender();
  }
  upFiles.forEach(f => { if (f.st === 'run') f.st = ''; });
  upBusy = false; upAbort = null; upRender();
  if (stopped) toast({type: 'warn', title: t('upc.stopped'), text: done ? esc(t('upc.done', {n: done})) : '', ttl: 3000});
  else if (done) toast({type: 'ok', title: t('upc.done', {n: done}), text: fail ? esc(t('upc.fail', {n: fail})) : '', ttl: 4000, actions: last ? [{t: t('bgc.show'), fn: () => api('gen-reveal', {path: last})}] : []});
  else if (fail) toast({type: 'warn', title: t('gg.upFail'), text: esc(upFiles.find(f => f.st === 'error').msg), ttl: 8000});
}
function upNeedModel(msg) {
  toast({type: 'warn', title: t('gg.upFail'), text: esc(msg), ttl: 8000, actions: [{t: t('gn.err.models'), fn: () => { setTab('gen'); gmOpen(true); }}]});
}
// куда сохранять: рядом с оригиналом или в свою папку (запоминается)
const UP_KEY = 'k9000.upOut';
let upOutMode = 'same';   // same | folder
function upOutSync() {
  document.querySelectorAll('#upOutMode .segb').forEach(b => b.classList.toggle('on', b.dataset.m === upOutMode));
  $('upFolderRow').classList.toggle('hide', upOutMode !== 'folder');
}
function upOutSave() {
  try { localStorage.setItem(UP_KEY, JSON.stringify({mode: upOutMode, dir: $('upOutDir').value.trim()})); } catch (e) {}
}
try {
  const o = JSON.parse(localStorage.getItem(UP_KEY) || 'null');
  if (o && typeof o.dir === 'string') $('upOutDir').value = o.dir;
  if (o && o.mode === 'folder') upOutMode = 'folder';
} catch (e) {}
upOutSync();
$('upOutMode').addEventListener('click', e => {
  const b = e.target.closest('.segb'); if (!b || upBusy) return;
  upOutMode = b.dataset.m; upOutSync(); upOutSave();
  if (upOutMode === 'folder' && !$('upOutDir').value.trim()) $('upPickOut').click();
});
$('upOutDir').addEventListener('input', upOutSave);
$('upPickOut').onclick = () => dialog(async () => {
  const r = await api('pick-folder', {purpose: 'out'});
  if (r.error) alert(r.error);
  if (r.path) { $('upOutDir').value = r.path; upOutMode = 'folder'; upOutSync(); upOutSave(); }
});
pickButtons('upAddFiles', 'upAddFolder', upAdd);
$('upClear').onclick = () => { if (!upBusy) { upFiles = []; upRender(); } };
$('upStart').onclick = upRun;
$('upStop').onclick = () => { if (upAbort) upAbort.abort(); };
$('upList').addEventListener('click', e => {
  const x = e.target.closest('[data-upx]');
  if (x && !upBusy) { upFiles = upFiles.filter(f => f.path !== x.dataset.upx); upRender(); }
});
