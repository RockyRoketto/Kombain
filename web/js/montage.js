// ---------- вкладка «Монтаж»: склейка, скорость, реверс, повтор (montage.go) ----------
let mtFiles = [];       // порядок здесь — порядок склейки: {name, dir, path, size, trim, dur, w, h, fps}
let mtCur = null;       // что открыто в плеере
let mtAt = 0;           // место просмотра, пока плеер отпущен
let mtLast = '';
const mtr = makePlayer('mt', {canPlay: () => false});
const MT_GROUPS = ['group.video', 'group.pro', 'group.anim', 'group.audio', 'group.lossless'];
const MT_FORMAT_KEY = 'konv9000.mtFormat';
// Качество результата: выше, чем по умолчанию в конвертере, потому что после монтажа файл обычно ещё обрабатывают
const MT_QUALITY = {crf: 20, abr: 192, preset: 'medium'};

const mtFits = name => MEDIA.test(name) && !IMAGES.test(name);
function mtFormats() {
  const box = $('mtFormat'), want = storeGet(MT_FORMAT_KEY) || box.value || 'mp4';
  box.innerHTML = GROUPS.filter(g => MT_GROUPS.includes(g[0])).map(g =>
    `<optgroup label="${esc(t(g[0]))}">` + g[1].filter(id => FORMATS[id].k !== 'copy').map(id => `<option value="${id}">${esc(fmtName(id))}</option>`).join('') + '</optgroup>').join('');
  box.value = want;
  if (!box.value) box.value = 'mp4';
}
// Отпущен ли плеер: копия для просмотра готовится одна, поэтому плеер монтажа держит файл, только пока вкладка открыта
function mtOpen(it, at) {
  mtCur = it;
  mtAt = at || 0;
  $('mtName').textContent = it.name;
  if (tab === 'mont' && !trs.it) { plHold(); mtr.open(it, mtAt); }
  mtRender();
}
function mtRelease() {
  if (mtr.current()) mtAt = mtr.v.currentTime;
  mtr.release();
}
function mtTabChanged() {
  if (tab !== 'mont') { mtRelease(); return; }
  plHold();
  if (mtCur && !mtr.current()) mtr.open(mtCur, mtAt);
  mtRender();
}
// окно обрезки закрылось: файл снова показывает плеер вкладки
function mtTrimClosed() {
  if (tab === 'mont' && mtCur && !mtr.current()) mtr.open(mtCur, mtAt);
}
// Файлы снаружи: дописываются в конец. Что уже в списке, второй раз не встаёт: обрезка у файла одна.
function mtAdd(list) {
  const bad = [];
  let first = null;
  for (const f of list || []) {
    const name = base(f.path);
    if (!mtFits(name)) { bad.push(name); continue; }
    if (mtFiles.some(x => x.path.toLowerCase() === f.path.toLowerCase())) continue;
    const it = {name, dir: dirOf(f.path), path: f.path, size: f.size};
    mtFiles.push(it);
    first = first || it;
    mtRead(it);
  }
  if (bad.length) say('warn', t('mt.notMedia'), bad.join(', '));
  if (first && !mtCur) mtOpen(first); else mtRender();
}
// файл из плеера: встаёт в конец списка, если его там ещё нет, и сразу открывается
function mtShow(f) {
  mtAdd([f]);
  const it = mtFiles.find(x => x.path.toLowerCase() === f.path.toLowerCase());
  if (it && it !== mtCur) mtOpen(it);
}
async function mtRead(it) {
  const mi = await api('info', {path: it.path});
  it.dur = mi.dur; it.w = mi.w; it.h = mi.h; it.fps = mi.fps;
  mtRender();
}
function mtRemove(it) {
  const i = mtFiles.indexOf(it);
  mtFiles = mtFiles.filter(x => x !== it);
  if (it !== mtCur) { mtRender(); return; }
  const next = mtFiles[i] || mtFiles[i - 1];
  if (next) mtOpen(next);
  else mtClear();
}
function mtClear() {
  mtr.release();
  mtFiles = []; mtCur = null; mtAt = 0;
  mtRender();
}
function mtMove(from, to) {
  if (from === to || to < 0 || to >= mtFiles.length) return;
  mtFiles.splice(to, 0, mtFiles.splice(from, 1)[0]);
  mtRender();
}
const mtSpeed = () => +$('mtSpeed').value || 1;
const mtRepeat = () => Math.min(Math.max(Math.round(+$('mtRepeat').value) || 1, 1), 20);
const mtLen = it => it.trim ? it.trim.end - it.trim.start : it.dur || 0;
// строка под настройками: сколько получится и что программа сделает сама
function mtInfo() {
  const parts = [];
  const glue = $('mtGlue').checked && mtFiles.length > 1;
  if (mtFiles.length && mtFiles.every(it => it.dur > 0)) {
    const one = mtFiles.reduce((a, it) => a + mtLen(it), 0) / mtSpeed() * mtRepeat();
    parts.push(t(glue || mtFiles.length === 1 ? 'mt.total' : 'mt.totalEach', {dur: fmtDur(one)}));
  }
  const lead = mtFiles[0];
  if (glue && lead.w && mtFiles.some(it => it.w && (it.w !== lead.w || it.h !== lead.h)))
    parts.push(t('mt.sizes', {size: `${lead.w}×${lead.h}`}));
  if ($('mtReverse').checked) parts.push(t('mt.revNote'));
  const html = parts.map(esc).join('<br>');
  if ($('mtInfo').innerHTML !== html) $('mtInfo').innerHTML = html;
}
function mtRender() {
  $('mtEmpty').classList.toggle('hide', !!mtCur);
  $('mtBody').classList.toggle('hide', !mtCur);
  $('mtHint').classList.toggle('hide', mtFiles.length > 0);
  $('mtCnt').textContent = mtFiles.length ? tn(mtFiles.length, 'n.pcs') : '';
  const state = snap.batch === 'mont' ? snap.files || [] : [];
  const glueRun = state.length === 1 && !!state[0].name && state[0].name !== base(state[0].path);
  const labels = {pending: t('status.pending'), error: t('status.error'), canceled: t('status.canceled'), ok: t('status.ok')};
  const html = mtFiles.map((it, i) => {
    const s = glueRun ? null : state.find(f => f.path === it.path);
    const pill = !s ? '' : s.status === 'running' ? Math.round(s.pct || 0) + '%' : labels[s.status] || '';
    const tools = snap.running ? '' :
      (TRIMMABLE.test(it.name) ? `<button class="x" data-a="trim" title="${t('trim.open')}">✂</button>` : '') +
      `<button class="x" data-a="up" title="${t('mt.up')}"${i ? '' : ' disabled'}>↑</button>` +
      `<button class="x" data-a="down" title="${t('mt.down')}"${i < mtFiles.length - 1 ? '' : ' disabled'}>↓</button>` +
      `<button class="x" data-a="rm" title="${t('list.remove')}">✕</button>`;
    return `<div class="f sel${it === mtCur ? ' cur' : ''}${s ? ' ' + s.status : ''}" data-i="${i}" draggable="${snap.running ? 'false' : 'true'}" title="${esc(it.path)}">` +
      `<div class="badge th${TRIMMABLE.test(it.name) ? ' vid' : ''}"><img src="${thumbUrl(it.path, .1, 160)}" alt="" loading="lazy" onerror="this.remove()"><span class="ex">${esc(ext(it.name))}</span></div>` +
      `<div class="meta"><div class="n">${i + 1}. ${esc(it.name)}</div><div class="sub">${it.dur > 0 ? fmtDur(mtLen(it)) + ' · ' : ''}${fmtSize(it.size)}${trimTag(it)}</div></div>` +
      `<div class="pill">${pill}</div>${tools}</div>`;
  }).join('');
  if (html !== mtLast) { $('mtList').innerHTML = html; mtLast = html; }
  mtInfo();
}
function mtButtons() {
  $('mtAddFiles').disabled = $('mtAddFolder').disabled = $('mtClear').disabled = snap.running;
  $('mtStart').disabled = $('start').disabled;
  $('mtStart').classList.toggle('hide', snap.running || tab !== 'mont');
}
// Предпросмотр скорости: плеер играет исходник быстрее или медленнее. Реверс и повтор видны только в результате.
function mtPreviewRate() { mtr.v.defaultPlaybackRate = mtr.v.playbackRate = mtSpeed(); }

function mtDone(s) {
  const fl = s.files || [], ok = fl.filter(f => f.status === 'ok' && f.dst), er = fl.filter(f => f.status === 'error');
  if (fl.some(f => f.status === 'canceled')) {
    toast({id: 'done', type: 'info', title: t('done.stopped'), text: t('done.stoppedText', {ok: ok.length, n: fl.length}), ttl: 8000});
    return;
  }
  if (er.length) toast({id: 'err', type: 'err', title: er.length === 1 ? t('fail.titleOne', {name: er[0].name}) : t('fail.titleN', {files: tn(er.length, 'n.files')}),
    text: er.length === 1 ? esc(er[0].hint || er[0].msg) : '',
    list: er.length === 1 ? [] : nameList(er, f => `<b style="display:inline;font-size:12.5px;color:var(--tx-em)">${esc(f.name)}</b> — ${esc(f.hint || f.msg)}`),
    actions: [{t: t('fail.details'), keep: true, fn: () => { $('logWrap').classList.remove('hide'); $('logWrap').scrollIntoView({behavior: 'smooth', block: 'center'}); }}]});
  if (!ok.length) return;
  toast({id: 'done', type: 'ok', title: t('mt.doneTitle', {files: tn(ok.length, 'n.files')}), text: ok.length === 1 ? esc(base(ok[0].dst)) : '', ttl: 15000,
    actions: [
      {t: t('mt.watch'), primary: true, fn: () => { setTab('play'); plAdd(ok.map(f => ({path: f.dst, size: f.dstSize}))); }},
      {t: t('btn.openFolder'), fn: async () => { const r = await api('open-output'); if (r.error) say('warn', t('folder.title'), r.error); }}
    ]});
}

$('mtStart').onclick = async () => {
  if (startSent || snap.running) return;
  if (!mtFiles.length) { say('warn', t('start.emptyTitle'), t('mt.empty')); return; }
  storeSet(MT_FORMAT_KEY, $('mtFormat').value);
  snap.files = []; newBatch(); mtLast = '';
  startSent = true;
  const r = await api('montage', Object.assign({
    files: mtFiles.map(f => f.path), format: $('mtFormat').value, dropOut,
    trims: Object.fromEntries(mtFiles.filter(f => f.trim).map(f => [f.path, f.trim])),
    glue: $('mtGlue').checked, speed: mtSpeed(), reverse: $('mtReverse').checked, repeat: mtRepeat(),
  }, MT_QUALITY));
  startSent = false;
  if (r.error) say('err', t('start.failed'), r.error);
  else snap.running = true;
};
$('mtSpeed').addEventListener('change', () => { mtPreviewRate(); mtInfo(); });
['mtRepeat', 'mtGlue', 'mtReverse'].forEach(id => $(id).addEventListener('change', mtInfo));
$('mtRepeat').addEventListener('change', () => { $('mtRepeat').value = mtRepeat(); mtInfo(); });
$('mtFormat').addEventListener('change', () => storeSet(MT_FORMAT_KEY, $('mtFormat').value));
$('mtAddFiles').onclick = () => dialog(async () => { const r = await api('pick-files'); if (r.error) alert(r.error); mtAdd(r.files); });
$('mtAddFolder').onclick = () => dialog(async () => { const r = await api('pick-folder', {purpose:'add'}); if (r.error) alert(r.error); mtAdd(r.files); });
$('mtClear').onclick = () => { if (!snap.running) mtClear(); };
$('mtList').addEventListener('click', e => {
  const row = e.target.closest('.f'); if (!row) return;
  const it = mtFiles[+row.dataset.i]; if (!it) return;
  const act = (e.target.closest('[data-a]') || {dataset: {}}).dataset.a;
  if (act === 'rm') mtRemove(it);
  else if (act === 'up') mtMove(+row.dataset.i, +row.dataset.i - 1);
  else if (act === 'down') mtMove(+row.dataset.i, +row.dataset.i + 1);
  else if (act === 'trim') { mtRelease(); openTrim(it); }
  else if (it !== mtCur) mtOpen(it);
});
// порядок можно менять и перетаскиванием строки; файлы снаружи ловит общий обработчик в drop.js
let mtDrag = -1;
$('mtList').addEventListener('dragstart', e => {
  const row = e.target.closest('.f'); if (!row) return;
  mtDrag = +row.dataset.i;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', row.dataset.i);
});
$('mtList').addEventListener('dragover', e => { if (mtDrag >= 0) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } });
$('mtList').addEventListener('drop', e => {
  if (mtDrag < 0) return;
  e.preventDefault();
  const row = e.target.closest('.f'), to = row ? +row.dataset.i : mtFiles.length - 1;
  mtMove(mtDrag, to);
  mtDrag = -1;
});
$('mtList').addEventListener('dragend', () => { mtDrag = -1; });
document.addEventListener('keydown', e => {
  if (tab !== 'mont' || !mtCur || document.querySelector('.modal:not(.hide)') || e.target.closest('.btn') || ['SELECT', 'INPUT'].includes(e.target.tagName)) return;
  mtr.key(e);
});
mtFormats();
