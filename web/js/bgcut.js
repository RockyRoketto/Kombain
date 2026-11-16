// ---------- «Убрать фон» в «Утилитах»: любые картинки с диска, результат <имя>-nobg.png рядом (bgremove.go, /api/bg-file) ----------
let bgFiles = [];         // {name, dir, path, size, st: '' | run | ok | error, msg, out}
let bgBusy = false;
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
    const sub = it.st === 'error' ? esc(it.msg) : it.st === 'ok' ? esc(t('bgc.saved', {name: base(it.out)})) : esc(it.dir) + ' · ' + fmtSize(it.size);
    const pill = it.st === 'run' ? '<span class="spin"></span>' : it.st === 'ok' ? t('status.ok') : it.st === 'error' ? t('status.error') : '';
    const ext = it.name.split('.').pop().toLowerCase();
    return `<div class="f sel ${it.st === 'run' ? 'running' : it.st}" title="${esc(it.path)}">` +
      (snap.ffmpeg ? `<div class="badge th"><img src="${thumbUrl(it.path, .1, 160)}" alt="" loading="lazy" onerror="this.remove()"><span class="ex">${esc(ext)}</span></div>` : `<div class="badge">${esc(ext)}</div>`) +
      `<div class="meta"><div class="n">${esc(it.name)}</div><div class="sub">${sub}</div></div>` +
      `<div class="pill">${pill}</div>` + (bgBusy ? '' : `<button class="x" data-bgx="${esc(it.path)}" title="${t('list.remove')}">✕</button>`) + '</div>';
  }).join('');
  if ($('bgList').innerHTML !== list) $('bgList').innerHTML = list;
  $('bgEmpty').classList.toggle('hide', bgFiles.length > 0);
  $('bgList').classList.toggle('hide', !bgFiles.length);
  $('bgCnt').textContent = bgFiles.length ? String(bgFiles.length) : '';
  $('bgAddFiles').disabled = $('bgAddFolder').disabled = $('bgClear').disabled = bgBusy;
  updateButtons();
}
const bgPending = () => bgFiles.filter(f => f.st !== 'ok');
async function bgRun() {
  if (bgBusy || !bgPending().length) return;
  bgBusy = true; bgRender();
  let done = 0, fail = 0, last = '';
  for (const it of bgPending()) {
    it.st = 'run'; bgRender();
    const r = await api('bg-file', {path: it.path});
    if (r.error) {
      it.st = 'error'; it.msg = r.error; fail++;
      if (r.needModel) { bgNeedModel(r.error); break; }
    } else { it.st = 'ok'; it.out = r.path; done++; last = r.path; }
    bgRender();
  }
  bgFiles.forEach(f => { if (f.st === 'run') f.st = ''; });
  bgBusy = false; bgRender();
  if (done) toast({type: 'ok', title: t('bgc.done', {n: done}), text: fail ? esc(t('bgc.fail', {n: fail})) : '', ttl: 4000, actions: last ? [{t: t('bgc.show'), fn: () => api('gen-reveal', {path: last})}] : []});
  else if (fail) toast({type: 'warn', title: t('gg.bgFail'), text: esc(bgFiles.find(f => f.st === 'error').msg), ttl: 8000});
}
function bgNeedModel(msg) {
  toast({type: 'warn', title: t('gg.bgFail'), text: esc(msg), ttl: 8000, actions: [{t: t('gn.err.models'), fn: () => { setTab('gen'); gmOpen(true); }}]});
}
$('bgAddFiles').onclick = () => dialog(async () => { const r = await api('pick-files'); if (r.error) alert(r.error); bgAdd(r.files); });
$('bgAddFolder').onclick = () => dialog(async () => { const r = await api('pick-folder', {purpose: 'add'}); if (r.error) alert(r.error); bgAdd(r.files); });
$('bgClear').onclick = () => { if (!bgBusy) { bgFiles = []; bgRender(); } };
$('bgStart').onclick = bgRun;
$('bgList').addEventListener('click', e => {
  const x = e.target.closest('[data-bgx]');
  if (x && !bgBusy) { bgFiles = bgFiles.filter(f => f.path !== x.dataset.bgx); bgRender(); }
});
