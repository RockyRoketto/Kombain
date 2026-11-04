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
  const drop = dropOut || snap.defaultOut || t('out.defaultDir');
  const note = outMode === 'same'
    ? (NATIVE_DROP || !files.some(f => f.temp)
        ? t('out.noteSame')
        : t('out.noteSame') + '<br>' + t('out.noteBrowser', {dir: esc(drop)}))
    : (dir ? t('out.noteFolder', {dir: esc(dir)})
           : t('out.notePick'));
  if (note !== lastNote) { $('outNote').innerHTML = note; lastNote = note; }
  const name = base(dir.replace(/[\\/]+$/, '')) || dir;
  const sum = [outMode === 'same' ? t('out.same') : dir ? t('out.sumFolder', {name}) : t('out.noFolder')];
  if ($('copyDup').checked) sum.push(t('out.sumCopy'));
  if ($('overwrite').checked) sum.push(t('out.sumOverwrite'));
  $('outSum').textContent = sum.join(' · ');
  $('outSum').title = outMode === 'folder' ? dir : '';
}
// сводка «Параметров»: только поля, видимые для выбранного формата
function renderParamSum() {
  const vis = id => !$(id).closest('.field').classList.contains('hide');
  const val = id => vis(id) ? $(id).value.trim() : '';
  const sum = [];
  if (val('codec')) sum.push($('codec').value === 'h264' ? 'H.264' : 'H.265');
  if (+val('target') > 0) sum.push(t('param.upTo', {v: val('target')}));
  if (val('crf')) sum.push('CRF ' + val('crf'));
  if (val('speed') && val('speed') !== 'medium') sum.push($('speed').selectedOptions[0].textContent);
  if (val('abr')) sum.push(val('abr') + ' kbps');
  if (val('height')) sum.push(val('height') + 'p');
  if (val('fps')) sum.push(val('fps') + ' FPS');
  const gif = FORMATS[fmt].k === 'gif';   // пустые поля GIF на деле значат 480p и 15 кадров (buildArgs)
  if (gif && !val('height')) sum.unshift('480p');
  if (gif && !val('fps')) sum.push('15 FPS');
  $('paramsSum').textContent = sum.join(' · ') || (FORMATS[fmt].k === 'copy' ? t('param.nothing') : t('param.asOriginal'));
}
const presetValues = p => Object.assign({}, PRESET_BASE, p.s);
// пресет подсвечен, пока настройки совпадают с его рецептом
function renderPresets() {
  let active = '';
  document.querySelectorAll('#presets .pre').forEach(b => {
    const p = PRESETS[+b.dataset.p], v = presetValues(p);
    const on = fmt === v.format && Object.keys(v).every(k => k === 'format' || String($(k).value) === String(v[k]));
    b.classList.toggle('on', on);
    if (on) active = t(p.n);
  });
  $('presetSum').textContent = active || t('preset.none');
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
  $('crfHint').textContent = +$('target').value > 0 ? t('crf.hintTarget')
    : k === 'small' ? t('crf.hintSmall', {range: $('codec').value === 'h264' ? '20–23' : '24–28'}) : t('crf.hint');
  renderParamSum(); renderPresets();
  $('fmtSum').textContent = fmtName(fmt);
  // свои аргументы теперь спрятаны в панели: точка на шестерёнке напоминает, что они заданы
  $('gearBtn').classList.toggle('dot', !!$('extra').value.trim());
}
function buildFormats() {
  $('fmtGroups').innerHTML = GROUPS.map(([g, ids]) =>
    `<div class="fgroup"><small>${t(g)}</small><div class="chips">` +
    ids.map(id => `<button class="chip" data-f="${id}">${fmtName(id)}</button>`).join('') + `</div></div>`).join('');
  $('presets').innerHTML = PRESETS.map((p, i) => `<button class="pre" data-p="${i}"><b>${t(p.n)}</b><span>${t(p.d)}</span></button>`).join('');
}
$('fmtGroups').addEventListener('click', e => {
  const c = e.target.closest('.chip'); if (!c) return;
  fmt = c.dataset.f; applyKind(); save();
});
$('presets').addEventListener('click', e => {
  const c = e.target.closest('.pre'); if (!c) return;
  const v = presetValues(PRESETS[+c.dataset.p]);
  fmt = v.format;
  Object.keys(v).forEach(k => { if (k !== 'format') $(k).value = v[k]; });
  applyKind(); save();
});
buildFormats(); load(); applyKind(); renderOut();
[...FIELDS, ...CHECKS].forEach(k => $(k).addEventListener('input', () => { save(); applyKind(); renderOut(); }));
// «копия» и «перезаписать» друг друга исключают
$('copyDup').addEventListener('change', () => { if ($('copyDup').checked) { $('overwrite').checked = false; save(); renderOut(); } });
$('overwrite').addEventListener('change', () => { if ($('overwrite').checked) { $('copyDup').checked = false; save(); renderOut(); } });
// разделы правой колонки: открыт только один
document.querySelectorAll('.acc-h').forEach(h => h.addEventListener('click', () => {
  const was = h.parentElement.classList.contains('open');
  document.querySelectorAll('.acc').forEach(a => {
    a.classList.remove('open');
    a.querySelector('.acc-h').setAttribute('aria-expanded', 'false');
  });
  if (!was) { h.parentElement.classList.add('open'); h.setAttribute('aria-expanded', 'true'); }
}));
// панель настроек за шестерёнкой
function setPanel(open) {
  $('setPanel').classList.toggle('hide', !open);
  $('gearBtn').setAttribute('aria-expanded', open);
}
$('gearBtn').addEventListener('click', () => setPanel($('setPanel').classList.contains('hide')));
document.addEventListener('pointerdown', e => {
  if (!e.target.closest('#setPanel, #gearBtn')) setPanel(false);
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') setPanel(false); });
// тема: сама применяется в applyTheme (index.html), выбор хранит программа в settings.json
function renderTheme() {
  document.querySelectorAll('#themeSeg .segb').forEach(b => {
    b.classList.toggle('on', b.dataset.v === themePref);
    b.setAttribute('aria-pressed', b.dataset.v === themePref);
  });
}
renderTheme();
$('themeSeg').addEventListener('click', async e => {
  const b = e.target.closest('.segb');
  if (!b || b.dataset.v === themePref) return;
  themePref = b.dataset.v;
  applyTheme(); renderTheme();
  const r = await api('settings', {theme: themePref});
  if (r.error) say('warn', t('theme.saveFailed'), r.error);
});
// язык: применение в applyLang (i18n.js), выбор хранит программа в settings.json
function renderLang() {
  document.querySelectorAll('#langSeg .segb').forEach(b => {
    b.classList.toggle('on', b.dataset.v === lang);
    b.setAttribute('aria-pressed', b.dataset.v === lang);
  });
}
renderLang();
$('langSeg').addEventListener('click', async e => {
  const b = e.target.closest('.segb');
  if (!b || b.dataset.v === lang) return;
  lang = b.dataset.v;
  applyLang(); renderLang();
  const r = await api('settings', {lang});
  if (r.error) say('warn', t('lang.saveFailed'), r.error);
});
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

