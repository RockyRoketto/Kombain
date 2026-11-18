// ---------- «Пакет картинок» в «Утилитах»: размер, формат, метаданные, водяной знак; результат <имя>-edit.<формат> рядом (imgbatch.go, /api/img-file) ----------
let imFiles = [];         // {name, dir, path, size, st: '' | run | ok | error, msg, out}
let imBusy = false;
let imWm = '';            // путь к картинке водяного знака
const IM_EXT = /\.(png|jpe?g|webp|bmp|tiff?|gif)$/i;
const IM_KEY = 'k9000.imOpts';
function imAdd(list) {
  const have = new Set(imFiles.map(f => f.path.toLowerCase()));
  let skipped = 0;
  for (const f of list || []) {
    if (!IM_EXT.test(f.path)) { skipped++; continue; }
    if (have.has(f.path.toLowerCase())) continue;
    imFiles.push({name: base(f.path), dir: dirOf(f.path), path: f.path, size: f.size, st: ''});
    have.add(f.path.toLowerCase());
  }
  if (skipped && !imFiles.length) say('warn', t('drop.notSuitableTitle'), t('imc.onlyImg'));
  imRender();
}
function imRender() {
  const list = imFiles.map(it => {
    const sub = it.st === 'error' ? esc(it.msg) : it.st === 'ok' ? esc(t('imc.saved', {name: base(it.out)})) : esc(it.dir) + ' · ' + fmtSize(it.size);
    const pill = it.st === 'run' ? '<span class="spin"></span>' : it.st === 'ok' ? t('status.ok') : it.st === 'error' ? t('status.error') : '';
    const ext = it.name.split('.').pop().toLowerCase();
    return `<div class="f sel ${it.st === 'run' ? 'running' : it.st}" title="${esc(it.path)}">` +
      (snap.ffmpeg ? `<div class="badge th"><img src="${thumbUrl(it.path, .1, 160)}" alt="" loading="lazy" onerror="this.remove()"><span class="ex">${esc(ext)}</span></div>` : `<div class="badge">${esc(ext)}</div>`) +
      `<div class="meta"><div class="n">${esc(it.name)}</div><div class="sub">${sub}</div></div>` +
      `<div class="pill">${pill}</div>` + (imBusy ? '' : `<button class="x" data-imx="${esc(it.path)}" title="${t('list.remove')}">✕</button>`) + '</div>';
  }).join('');
  if ($('imList').innerHTML !== list) $('imList').innerHTML = list;
  $('imEmpty').classList.toggle('hide', imFiles.length > 0);
  $('imList').classList.toggle('hide', !imFiles.length);
  $('imCnt').textContent = imFiles.length ? String(imFiles.length) : '';
  $('imAddFiles').disabled = $('imAddFolder').disabled = $('imClear').disabled = imBusy;
  imSync();
  updateButtons();
}
// видимость полей и подпись единиц по выбранному
function imSync() {
  const rs = $('imResize').value;
  $('imValRow').classList.toggle('hide', !rs);
  $('imUnit').textContent = rs === 'percent' ? '%' : t('imc.px');
  $('imNoUp').closest('label').classList.toggle('hide', !rs);
  $('imQRow').classList.toggle('hide', !['jpg', 'webp'].includes($('imFormat').value));
  $('imWmSet').classList.toggle('hide', !imWm);
  $('imWmClear').classList.toggle('hide', !imWm);
  $('imWmName').textContent = imWm ? base(imWm) : t('imc.wmNone');
}
const imNum = (id, d, lo, hi) => { const v = Math.round(+$(id).value); return Number.isFinite(v) && v >= lo ? Math.min(v, hi) : d; };
function imOpts() {
  return {
    resize: $('imResize').value, value: imNum('imValue', 1920, 1, 20000), noUp: $('imNoUp').checked,
    format: $('imFormat').value, quality: imNum('imQuality', 85, 1, 100), strip: $('imStrip').checked,
    wmPath: imWm, wmPos: $('imWmPos').value, wmSize: imNum('imWmSize', 20, 2, 100), wmAlpha: imNum('imWmAlpha', 100, 5, 100),
    outDir: imOutMode === 'folder' ? $('imOutDir').value.trim() : '',
  };
}
let imOutMode = 'same';   // same | folder
function imOutSync() {
  document.querySelectorAll('#imOutMode .segb').forEach(b => b.classList.toggle('on', b.dataset.m === imOutMode));
  $('imFolderRow').classList.toggle('hide', imOutMode !== 'folder');
}
function imSaveOpts() {
  const o = imOpts(); delete o.wmPath; o.outMode = imOutMode; o.outDir = $('imOutDir').value.trim();
  try { localStorage.setItem(IM_KEY, JSON.stringify(o)); } catch (e) {}
}
function imLoadOpts() {
  let o = null;
  try { o = JSON.parse(localStorage.getItem(IM_KEY) || 'null'); } catch (e) {}
  if (!o || typeof o !== 'object') return;
  if (['', 'fit', 'width', 'height', 'percent'].includes(o.resize)) $('imResize').value = o.resize;
  if (o.value > 0) $('imValue').value = o.value;
  if (typeof o.noUp === 'boolean') $('imNoUp').checked = o.noUp;
  if (['', 'jpg', 'png', 'webp'].includes(o.format)) $('imFormat').value = o.format;
  if (o.quality > 0) $('imQuality').value = o.quality;
  if (typeof o.strip === 'boolean') $('imStrip').checked = o.strip;
  if (['br', 'bl', 'tr', 'tl', 'c'].includes(o.wmPos)) $('imWmPos').value = o.wmPos;
  if (o.wmSize > 0) $('imWmSize').value = o.wmSize;
  if (o.wmAlpha > 0) $('imWmAlpha').value = o.wmAlpha;
  if (typeof o.outDir === 'string') $('imOutDir').value = o.outDir;
  if (o.outMode === 'folder') imOutMode = 'folder';
  imOutSync();
}
const imPending = () => imFiles.filter(f => f.st !== 'ok');
let imAbort = null;       // «Стоп»: обрыв запроса, сервер гасит ffmpeg
async function imRun() {
  if (imBusy || !imPending().length) return;
  if (imOutMode === 'folder' && !$('imOutDir').value.trim()) { say('warn', t('start.whereTitle'), t('start.where')); return; }
  imBusy = true; imAbort = new AbortController(); imSaveOpts(); imRender();
  const opts = imOpts();
  let done = 0, fail = 0, last = '', stopped = false;
  for (const it of imPending()) {
    it.st = 'run'; imRender();
    const r = await api('img-file', {path: it.path, opts}, imAbort.signal);
    if (r.aborted) { stopped = true; break; }
    if (r.error) { it.st = 'error'; it.msg = r.error; fail++; }
    else { it.st = 'ok'; it.out = r.path; done++; last = r.path; }
    imRender();
  }
  imFiles.forEach(f => { if (f.st === 'run') f.st = ''; });
  imBusy = false; imAbort = null; imRender();
  if (stopped) toast({type: 'warn', title: t('upc.stopped'), text: done ? esc(t('imc.done', {n: done})) : '', ttl: 3000});
  else if (done) toast({type: 'ok', title: t('imc.done', {n: done}), text: fail ? esc(t('imc.fail', {n: fail})) : '', ttl: 4000, actions: last ? [{t: t('bgc.show'), fn: () => api('gen-reveal', {path: last})}] : []});
  else if (fail) toast({type: 'warn', title: t('imc.failTitle'), text: esc(imFiles.find(f => f.st === 'error').msg), ttl: 8000});
}
pickButtons('imAddFiles', 'imAddFolder', imAdd);
$('imClear').onclick = () => { if (!imBusy) { imFiles = []; imRender(); } };
$('imStart').onclick = imRun;
$('imStop').onclick = () => { if (imAbort) imAbort.abort(); };
$('imList').addEventListener('click', e => {
  const x = e.target.closest('[data-imx]');
  if (x && !imBusy) { imFiles = imFiles.filter(f => f.path !== x.dataset.imx); imRender(); }
});
$('imWmPick').onclick = () => dialog(async () => {
  const r = await api('pick-files'); if (r.error) { alert(r.error); return; }
  const f = (r.files || []).find(f => IM_EXT.test(f.path));
  if (f) { imWm = f.path; imRender(); }
});
$('imOutMode').addEventListener('click', e => {
  const b = e.target.closest('.segb'); if (!b || imBusy) return;
  imOutMode = b.dataset.m; imOutSync(); imSaveOpts();
  if (imOutMode === 'folder' && !$('imOutDir').value.trim()) $('imPickOut').click();
});
$('imOutDir').addEventListener('input', imSaveOpts);
$('imPickOut').onclick = () => dialog(async () => {
  const r = await api('pick-folder', {purpose: 'out'});
  if (r.error) alert(r.error);
  if (r.path) { $('imOutDir').value = r.path; imOutMode = 'folder'; imOutSync(); imSaveOpts(); }
});
$('imWmClear').onclick =() => { imWm = ''; imRender(); };
['imResize', 'imFormat'].forEach(id => $(id).addEventListener('change', () => { imSync(); imSaveOpts(); }));
['imValue', 'imNoUp', 'imQuality', 'imStrip', 'imWmPos', 'imWmSize', 'imWmAlpha'].forEach(id => $(id).addEventListener('change', imSaveOpts));
imLoadOpts();
