// ---------- настройки ----------
const FIELDS = ['crf','speed','abr','height','fps','jobs','extra','outDir','codec','target','jpgDir','webpDir'];
const CHECKS = ['overwrite', 'copyDup'];
let tab = 'conv';        // вкладка: 'conv' — конвертер, 'banner' — баннеры
let outMode = 'same';   // 'same' = рядом с оригиналом, 'folder' = своя папка
let dropOut = '';       // куда класть перетащенные файлы в режиме «рядом с оригиналом»
function save() {
  try {
    const o = {fmt, outMode, dropOut, tab};
    FIELDS.forEach(k => o[k] = $(k).value); CHECKS.forEach(k => o[k] = $(k).checked);
    localStorage.setItem('konv9000', JSON.stringify(o));
  } catch (e) {}
}
function load() {
  try {
    const o = JSON.parse(localStorage.getItem('konv9000') || '{}');
    if (o.fmt && FORMATS[o.fmt]) fmt = o.fmt;
    if (o.outMode === 'folder' || o.outMode === 'same') outMode = o.outMode;
    if (o.tab === 'banner' || o.tab === 'conv') tab = o.tab;
    if (typeof o.dropOut === 'string') dropOut = o.dropOut;
    FIELDS.forEach(k => { if (o[k] !== undefined) $(k).value = o[k]; });
    CHECKS.forEach(k => { if (o[k] !== undefined) $(k).checked = o[k]; });
  } catch (e) {}
}
let lastNote = '';
function renderOut() {
  document.querySelectorAll('#outMode .segb').forEach(b => b.classList.toggle('on', b.dataset.m === outMode));
  $('folderRow').classList.toggle('hide', outMode !== 'folder');
  const dir = $('outDir').value.trim();
  const drop = dropOut || snap.defaultOut || 'Видео\\Konvertor';
  const note = outMode === 'same'
    ? (NATIVE_DROP || !files.some(f => f.temp)
        ? 'Результат ляжет в ту же папку, где лежит исходник.'
        : `Результат ляжет в ту же папку, где лежит исходник.<br>Перетащенные в браузер файлы (браузер не сообщает, откуда они) → <b>${esc(drop)}</b> <button class="linkb" data-act="drop">изменить</button>`)
    : (dir ? `Всё сохранится в <b>${esc(dir)}</b>.<br>Папка запоминается для следующих запусков.`
           : 'Выбери папку. Она запомнится для следующих запусков.');
  if (note !== lastNote) { $('outNote').innerHTML = note; lastNote = note; }
}
function applyKind() {
  const k = FORMATS[fmt].k;
  document.querySelectorAll('[data-k]').forEach(el => {
    let show = el.dataset.k.split(' ').includes(k);
    if (show && el.dataset.f === 'x26') show = ['mp4','mp4h265','mov','webm','small'].includes(fmt);
    el.classList.toggle('hide', !show);
  });
  document.querySelectorAll('#fmtGroups .chip').forEach(c => c.classList.toggle('on', c.dataset.f === fmt));
  $('crfVal').textContent = $('crf').value;
  $('crfHint').textContent = +$('target').value > 0 ? 'если видео и так влезает в размер'
    : k === 'small' ? (($('codec').value === 'h264' ? '20–23' : '24–28') + ' — разницы на глаз не видно') : 'меньше = лучше, но тяжелее файл';
}
function buildFormats() {
  $('fmtGroups').innerHTML = GROUPS.map(([t, ids]) =>
    `<div class="group"><small>${t}</small><div class="chips">` +
    ids.map(id => `<button class="chip" data-f="${id}">${FORMATS[id].n}</button>`).join('') + `</div></div>`).join('');
  $('presets').innerHTML = PRESETS.map((p, i) => `<button class="chip pre" data-p="${i}">${p.n}</button>`).join('');
}
$('fmtGroups').addEventListener('click', e => {
  const c = e.target.closest('.chip'); if (!c) return;
  fmt = c.dataset.f; applyKind(); save();
});
$('presets').addEventListener('click', e => {
  const c = e.target.closest('.chip'); if (!c) return;
  const s = PRESETS[+c.dataset.p].s;
  fmt = s.format;
  $('target').value = '';   // размер — только у пресета, где он задан
  Object.keys(s).forEach(k => { if (k !== 'format') $(k).value = s[k]; });
  applyKind(); save();
});
buildFormats(); load(); applyKind(); renderOut();
[...FIELDS, ...CHECKS].forEach(k => $(k).addEventListener('input', () => { save(); applyKind(); renderOut(); }));
// «копия» и «перезаписать» друг друга исключают
$('copyDup').addEventListener('change', () => { if ($('copyDup').checked) { $('overwrite').checked = false; save(); } });
$('overwrite').addEventListener('change', () => { if ($('overwrite').checked) { $('copyDup').checked = false; save(); } });
$('outMode').addEventListener('click', e => {
  const b = e.target.closest('.segb'); if (!b) return;
  outMode = b.dataset.m; save(); renderOut();
  if (outMode === 'folder' && !$('outDir').value.trim()) $('pickOut').click();
});
$('outNote').addEventListener('click', e => {
  if (!e.target.closest('[data-act="drop"]')) return;
  dialog(async () => {
    const r = await api('pick-folder', {purpose:'out'});
    if (r.error) alert(r.error);
    if (r.path) { dropOut = r.path; save(); renderOut(); }
  });
});

