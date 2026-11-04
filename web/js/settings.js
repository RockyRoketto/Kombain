// ---------- настройки ----------
const FIELDS = ['crf','speed','abr','height','fps','jobs','extra','outDir','codec','target','jpgDir','webpDir','gifPalette','joinFps'];
const CHECKS = ['overwrite', 'copyDup', 'bAutoDirs'];
let tab = 'conv';        // вкладка: 'conv' — конвертер, 'play' — плеер, 'banner' — баннеры
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
    if (['conv', 'play', 'banner'].includes(o.tab)) tab = o.tab;
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
  if (val('gifPalette')) sum.push(t('gifpal.frameShort'));
  $('paramsSum').textContent = sum.join(' · ') || (['copy', 'fixed'].includes(FORMATS[fmt].k) ? t('param.nothing') : t('param.asOriginal'));
}
const presetValues = p => Object.assign({}, PRESET_BASE, p.s);
// свои пресеты: {n: название, s: рецепт как у готовых}
let userPresets = [];
try {
  const up = JSON.parse(localStorage.getItem('konv9000.presets') || '[]');
  if (Array.isArray(up)) userPresets = up.filter(p => p && typeof p.n === 'string' && p.s && FORMATS[p.s.format]);
} catch (e) {}
function saveUserPresets() { try { localStorage.setItem('konv9000.presets', JSON.stringify(userPresets)); } catch (e) {} }
// под названием своего пресета — коротко, что в нём
function userPresetDesc(s) {
  const k = FORMATS[s.format].k, bits = [fmtName(s.format)];
  if (['video', 'small'].includes(k)) bits.push(+s.target > 0 ? t('param.upTo', {v: s.target}) : 'CRF ' + s.crf);
  if (['video', 'vfix', 'pro', 'gif', 'anim', 'image', 'seq', 'small'].includes(k) && s.height) bits.push(s.height + 'p');
  if (['video', 'vfix', 'audio', 'small'].includes(k)) bits.push(s.abr + ' kbps');
  return bits.join(' · ');
}
// кнопка пресета → его рецепт: готовые по номеру в PRESETS, свои по номеру в userPresets
const presetOf = b => b.dataset.u !== undefined ? {name: userPresets[+b.dataset.u].n, v: presetValues(userPresets[+b.dataset.u])}
  : {name: t(PRESETS[+b.dataset.p].n), v: presetValues(PRESETS[+b.dataset.p])};
// пресет подсвечен, пока настройки совпадают с его рецептом
function renderPresets() {
  let active = '';
  document.querySelectorAll('#presets .pre').forEach(b => {
    const {name, v} = presetOf(b);
    const on = fmt === v.format && Object.keys(v).every(k => k === 'format' || String($(k).value) === String(v[k]));
    b.classList.toggle('on', on);
    if (on && !active) active = name;
  });
  $('presetSum').textContent = active || t('preset.none');
}
function buildPresets() {
  $('presets').innerHTML = PRESETS.map((p, i) => `<button class="pre" data-p="${i}"><b>${t(p.n)}</b><span>${t(p.d)}</span></button>`).join('') +
    userPresets.map((p, i) => `<div class="prew"><button class="pre" data-u="${i}" title="${esc(p.n)}"><b>${esc(p.n)}</b><span>${esc(userPresetDesc(p.s))}</span></button>` +
      `<button class="x prex" data-ux="${i}" title="${t('preset.delete')}" aria-label="${t('preset.delete')}">✕</button></div>`).join('');
}
// «Собрать картинки в одно видео»: только когда это возможно. Галочка не запоминается между запусками:
// забытая, она превратила бы следующую пачку фото в видео.
const joinAvailable = () => ['video', 'vfix', 'pro', 'gif', 'anim'].includes(FORMATS[fmt].k) &&
  files.filter(f => f.sel && IMAGES.test(f.name)).length >= 2;
const joinOn = () => joinAvailable() && $('joinSeq').checked;
function renderJoin() {
  $('joinBox').classList.toggle('hide', !joinAvailable());
  $('joinFpsRow').classList.toggle('hide', !$('joinSeq').checked);
  $('fmtSum').textContent = fmtName(fmt) + (joinOn() ? ' · ' + t('join.short') : '');
}
$('joinSeq').addEventListener('change', renderJoin);
function applyKind() {
  const k = FORMATS[fmt].k;
  document.querySelectorAll('[data-k]').forEach(el => {
    el.classList.toggle('hide', !el.dataset.k.split(' ').includes(k));
  });
  document.querySelectorAll('#fmtGroups .chip').forEach(c => c.classList.toggle('on', c.dataset.f === fmt));
  // редкие форматы свёрнуты, но выбранный прятать нельзя
  const rareOn = GROUPS.some(g => g[2] && g[1].includes(fmt));
  $('fmtRare').classList.toggle('hide', !fmtMore && !rareOn);
  $('fmtMore').classList.toggle('hide', rareOn);
  $('fmtMore').textContent = t(fmtMore ? 'fmt.less' : 'fmt.more');
  $('crfVal').textContent = $('crf').value;
  $('crfHint').textContent = +$('target').value > 0 ? t('crf.hintTarget')
    : k === 'small' ? t('crf.hintSmall', {range: $('codec').value === 'h264' ? '20–23' : '24–28'}) : t('crf.hint');
  renderParamSum(); renderPresets();
  renderJoin();
  // свои аргументы теперь спрятаны в панели: точка на шестерёнке напоминает, что они заданы
  $('gearBtn').classList.toggle('dot', !!$('extra').value.trim());
}
let fmtMore = false;   // открыты ли редкие форматы
function buildFormats() {
  const row = ([g, ids, rare]) =>
    `<div class="fgroup"${rare ? ' id="fmtRare"' : ''}><small>${t(g)}</small><div class="chips">` +
    ids.map(id => `<button class="chip" data-f="${id}">${fmtName(id)}</button>`).join('') + `</div></div>`;
  $('fmtGroups').innerHTML = GROUPS.filter(g => !g[2]).map(row).join('') +
    `<button class="fmore" id="fmtMore"></button>` + GROUPS.filter(g => g[2]).map(row).join('');
  buildPresets();
}
$('fmtGroups').addEventListener('click', e => {
  if (e.target.closest('#fmtMore')) { fmtMore = !fmtMore; applyKind(); return; }
  const c = e.target.closest('.chip'); if (!c) return;
  fmt = c.dataset.f; applyKind(); save();
});
$('presets').addEventListener('click', e => {
  const del = e.target.closest('[data-ux]');
  if (del) { userPresets.splice(+del.dataset.ux, 1); saveUserPresets(); buildPresets(); renderPresets(); return; }
  const c = e.target.closest('.pre'); if (!c) return;
  const {v} = presetOf(c);
  fmt = v.format;
  Object.keys(v).forEach(k => { if (k !== 'format') $(k).value = v[k]; });
  applyKind(); save();
});
// сохранить текущие настройки как свой пресет; то же название заменяет прежний
$('presetSave').onclick = () => {
  const name = $('presetName').value.trim();
  if (!name) { $('presetName').focus(); return; }
  const s = {format: fmt};
  Object.keys(PRESET_BASE).forEach(k => { s[k] = $(k).value; });
  const was = userPresets.findIndex(p => p.n.toLowerCase() === name.toLowerCase());
  if (was >= 0) userPresets[was] = {n: name, s}; else userPresets.push({n: name, s});
  saveUserPresets(); buildPresets(); renderPresets();
  $('presetName').value = '';
};
$('presetName').addEventListener('keydown', e => { if (e.key === 'Enter') $('presetSave').click(); });
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

