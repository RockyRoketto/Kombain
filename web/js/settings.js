// ---------- настройки ----------
const FIELDS = ['crf','speed','abr','height','fps','jobs','extra','outDir','codec','target','jpgDir','webpDir','gifPalette','joinFps'];
const CHECKS = ['overwrite', 'copyDup', 'bAutoDirs'];
// Что переживает новый запуск. Остальные поля, формат и вкладка возвращаются к начальным значениям.
const FIELDS_KEEP = ['jobs', 'outDir', 'jpgDir', 'webpDir'];
// Новый запуск программы, а не перезагрузка страницы: sessionStorage живёт, пока открыто окно
const NEW_RUN = (() => {
  try {
    if (sessionStorage.getItem('konv9000.live')) return false;
    sessionStorage.setItem('konv9000.live', '1');
  } catch (e) {}
  return true;
})();
let tab = 'conv';        // вид: 'conv' — конвертер, 'play' — плеер, 'mont' — монтаж, 'color' — цвет; в «Утилитах»: 'util' — фавиконы, 'banner' — баннеры
let utl = 'util';        // последний открытый инструмент «Утилит» ('util' или 'banner')
let outMode = 'same';   // 'same' = рядом с оригиналом, 'folder' = своя папка
let dropOut = '';       // куда класть перетащенные файлы в режиме «рядом с оригиналом»
function save() {
  try {
    const o = {fmt, outMode, dropOut, tab, utl};
    FIELDS.forEach(k => o[k] = $(k).value); CHECKS.forEach(k => o[k] = $(k).checked);
    localStorage.setItem('konv9000', JSON.stringify(o));
  } catch (e) {}
}
function load() {
  try {
    const o = JSON.parse(localStorage.getItem('konv9000') || '{}');
    if (!NEW_RUN && o.fmt && FORMATS[o.fmt]) fmt = o.fmt;
    if (o.outMode === 'folder' || o.outMode === 'same') outMode = o.outMode;
    if (!NEW_RUN && ['conv', 'play', 'mont', 'color', 'banner', 'util'].includes(o.tab)) tab = o.tab;
    if (o.utl === 'banner' || o.utl === 'util') utl = o.utl;
    if (typeof o.dropOut === 'string') dropOut = o.dropOut;
    FIELDS.filter(k => !NEW_RUN || FIELDS_KEEP.includes(k)).forEach(k => { if (o[k] !== undefined) $(k).value = o[k]; });
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
// панель настроек за шестерёнкой: слева разделы, открытый раздел помнится
let setpPage = 'look';
try { setpPage = localStorage.getItem('konv9000.setpPage') || 'look'; } catch (e) {}
if (!document.querySelector(`.setp-page[data-p="${setpPage}"]`)) setpPage = 'look';
function setpShow(p) {
  setpPage = p;
  document.querySelectorAll('.setp-tab').forEach(b => {
    b.classList.toggle('on', b.dataset.p === p);
    b.setAttribute('aria-selected', b.dataset.p === p);
  });
  document.querySelectorAll('.setp-page').forEach(s => s.classList.toggle('on', s.dataset.p === p));
  try { localStorage.setItem('konv9000.setpPage', p); } catch (e) {}
  if (p === 'store' || p === 'about') storeLoad();
  if (p === 'about') aboutRender(snap);
}
$('setpNav').addEventListener('click', e => {
  const b = e.target.closest('.setp-tab');
  if (b) setpShow(b.dataset.p);
});
function setPanel(open) {
  $('setPanel').classList.toggle('hide', !open);
  $('gearBtn').setAttribute('aria-expanded', open);
  if (open) setpShow(setpPage);
}
// ---------- раздел «Хранилище»: что сколько весит ----------
let storeData = null;
// части полосы: модели и их недокачанные хвосты одной частью, копии просмотра вместе с остальным кэшем
const STORE_GROUP = {app: 'app', ffmpeg: 'ffmpeg', model: 'model', models: 'model', tools: 'tools', preview: 'cache', cache: 'cache', webview: 'webview', other: 'other'};
const STORE_ORDER = ['model', 'cache', 'ffmpeg', 'app', 'tools', 'webview', 'other'];
async function storeLoad() {
  const r = await api('storage');
  if (r.error) return;
  storeData = r;
  storeRender();
  aboutRender(snap);
}
function storeRender() {
  if (!storeData) return;
  const parts = storeData.parts || [], sum = {};
  parts.forEach(p => { const g = STORE_GROUP[p.kind] || 'other'; sum[g] = (sum[g] || 0) + p.bytes; });
  const total = parts.reduce((a, p) => a + p.bytes, 0);
  const groups = STORE_ORDER.filter(g => sum[g] > 0).sort((a, b) => sum[b] - sum[a]);   // цвет за частью закреплён, порядок по весу
  $('stTotal').textContent = fmtSize(total) || '0';
  $('stBar').innerHTML = groups.map(g =>
    `<i style="width:${(sum[g] / total * 100).toFixed(2)}%;background:var(--st-${g})" title="${esc(t(`store.k.${g}`))} · ${fmtSize(sum[g])}"></i>`).join('');
  $('stLegend').innerHTML = groups.map(g =>
    `<li style="--c:var(--st-${g})"><span>${esc(t(`store.k.${g}`))}</span><b>${fmtSize(sum[g])}</b></li>`).join('');
  $('stCache').textContent = t('store.cacheSize', {size: fmtSize(sum.cache) || t('store.empty')});
  $('stClear').disabled = !sum.cache;
  // модели по одной и сама программа распознавания, у каждой крестик
  const rows = parts.filter(p => p.kind === 'model' || p.kind === 'tools').map(p => {
    const name = p.kind === 'tools' ? t('store.k.tools') : t(`store.m.${p.name}`);
    return `<div class="st-row"><div><span class="lb">${esc(name)}</span><span class="hint">${fmtSize(p.bytes)}</span></div>` +
      `<button class="x" data-del="${esc(p.kind === 'tools' ? '' : p.name)}" title="${esc(t('store.del'))}" aria-label="${esc(t('store.del') + ': ' + name)}">✕</button></div>`;
  });
  $('stModels').innerHTML = rows.length ? rows.join('') : `<div class="st-empty">${esc(t('store.noModels'))}</div>`;
}
$('stModels').addEventListener('click', async e => {
  const b = e.target.closest('[data-del]');
  if (!b) return;
  const name = b.dataset.del ? t(`store.m.${b.dataset.del}`) : t('store.k.tools');
  if (!confirm(t('store.delAsk', {name}))) return;
  const r = await api('storage-remove', {name: b.dataset.del});
  if (r.error) { say('warn', t('store.del'), r.error); return; }
  storeData = r; storeRender();
});
$('stClear').onclick = async () => {
  if (snap.running) { say('warn', t('store.clear'), t('store.busyPage')); return; }
  const r = await mtFreeCache('storage-clear');
  if (r.error) { say('warn', t('store.clear'), r.error); return; }
  mtTextRefresh();   // картинки надписей открытого проекта рисуются заново
  storeData = r; storeRender(); aboutRender(snap);
};
// ---------- раздел «О программе»: версии и статистика ----------
function aboutRender(s) {
  if ($('setPanel').classList.contains('hide') || setpPage !== 'about') return;
  const u = s.appUpd || {}, f = s.ffv || {}, run = !!s.running;
  $('abApp').textContent = (s.app || {}).version || '';
  let note = '', go = false;
  if (u.active) note = t('app.downloading', {v: esc(u.latest), pct: Math.round(u.pct || 0)});
  else if (u.update) { note = t('about.newer', {v: esc(u.latest)}); go = !!u.supported; }
  else if (u.checkErr) note = t('about.checkFailed');
  else if (u.checked) note = t('about.latest');
  $('abAppNote').innerHTML = note;
  $('abAppNote').classList.toggle('upd', !!u.update);
  $('abAppGo').classList.toggle('hide', !go);
  $('abAppGo').disabled = run;
  $('abFF').textContent = f.local || f.localRaw || '';
  note = ''; go = false;
  if (s.dl && s.dl.active) note = t('about.ffLoading');
  else if (!s.ffmpeg) { note = t('about.ffMissing'); go = true; }
  else if (f.update) { note = t('about.newer', {v: esc(f.latest)}); go = true; }
  else if (f.checking) note = t('about.checking');
  else if (f.checkErr) note = t('about.checkFailed');
  else if (f.checked && f.latest) note = t('about.latest');
  $('abFFNote').innerHTML = note;
  $('abFFNote').classList.toggle('upd', go);
  $('abFFGo').textContent = s.ffmpeg ? t('btn.update') : t('about.download');
  $('abFFGo').classList.toggle('hide', !go);
  $('abFFGo').disabled = run;
  const st = (storeData || {}).stats || {};
  $('abFiles').textContent = (st.files || 0).toLocaleString(lang);
  $('abSaved').textContent = fmtSize(st.saved) || '0';
  const since = st.files && st.since ? new Date(st.since) : null;
  $('abSince').textContent = since ? t('about.since', {date: since.toLocaleDateString(lang)}) : t('about.noStats');
}
$('abAppGo').onclick = async () => {
  const r = await api('app-update');
  if (r.error) say('err', t('app.updateTitle'), r.error);
  pollSoon();
};
$('abFFGo').onclick = async () => {
  const r = await api('download-ffmpeg');
  if (r.error) say('err', 'ffmpeg', r.error);
  pollSoon();
};
$('gearBtn').addEventListener('click', () => setPanel($('setPanel').classList.contains('hide')));
document.addEventListener('pointerdown', e => {
  if (!e.target.closest('#setPanel, #gearBtn')) setPanel(false);
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') setPanel(false); });
// заполненное поле не прячем: иначе аргументы молча действуют на каждую конвертацию
$('extraBox').open = !!$('extra').value.trim();
$('openData').onclick = async () => {
  const r = await api('open-data');
  if (r.error) say('warn', t('folder.title'), r.error);
};
// Что не настройки, а работа пользователя, остаётся
const RESET_KEEP = ['konv9000.presets', 'konv9000.newsSeen', 'konv9000.mtProject'];
$('resetAll').onclick = async () => {
  if (snap.running) { say('warn', t('setp.reset'), t('setp.resetBusy')); return; }
  if (!confirm(t('setp.resetAsk'))) return;
  const r = await api('settings', {reset: true});
  if (r.error) { say('err', t('setp.reset'), r.error); return; }
  try {
    tkAutosave();   // отложенное автосохранение не успело бы до перезагрузки
    Object.keys(localStorage).filter(k => k.startsWith('konv9000') && !RESET_KEEP.includes(k)).forEach(k => localStorage.removeItem(k));
  } catch (e) {}
  location.reload();
};
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
  applyLang(); renderLang(); tkRender(); mtRender(); mtPanel(); clRelang();
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

