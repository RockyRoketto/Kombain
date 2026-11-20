// Вкладка «Генератор»: экран первого запуска (проверка железа плитками «хватает / на пределе / не хватает»,
// папка для ИИ с подсказкой диска, где больше места, скачивание с прогрессом) и панель «Модели» (скачать, удалить,
// лицензия простыми словами). Оба занимают место холста в центре вкладки. Сервер: aisetup.go (ai-setup, ai-root,
// ai-install, ai-cancel, ai-remove), проверка железа — hwcheck.go.
const gm = {
  data: null,      // ответ ai-setup
  view: '',        // '', 'setup', 'models'
  timer: 0,
  llm: true,       // галочка «ещё помощник запросов» на экране первого запуска
  lic: new Set(),  // у каких моделей раскрыта «Лицензия»: список перерисовывается каждую секунду при скачивании
};

function gmCenter(v) {
  gm.view = v;
  if (v && gg.open) ggOpen(false);
  const c = document.querySelector('.gn-center');
  c.classList.toggle('gal', !!v);                    // прячет холст, ленту и плашку железа, как галерея
  $('gnSetup').classList.toggle('hide', v !== 'setup');
  $('gnMods').classList.toggle('hide', v !== 'models');
}

async function gmLoad() {
  const r = await api('ai-setup');
  if (r.error) return;
  gm.data = r;
  gmRender();
  gmWatch();
}

// пока идёт скачивание — спрашиваем раз в секунду; закончилось — обновить вкладку
function gmWatch() {
  clearTimeout(gm.timer);
  if (!gm.data?.job?.active || tab !== 'gen') return;
  gm.timer = setTimeout(async () => {
    const was = gm.data.job.active;
    await gmLoad();
    if (was && !gm.data.job.active) {
      gnInfo();
      if (gm.data.job.err) say('warn', t('gm.failed'), gm.data.job.err);
    }
  }, 1000);
}

function gmRender() {
  if (gm.view === 'setup') gsRender();
  if (gm.view === 'models') gmListRender();
}

const gmGB = b => t('gs.gb', {n: (b / 1073741824).toFixed(b >= 10 * 1073741824 ? 0 : 1).replace('.', lang === 'ru' ? ',' : '.')});

// ---- первый запуск ----

function gsTile(icon, title, value, v, extra) {
  const pct = v.level === 'ok' ? 100 : v.level === 'edge' ? 55 : 18;
  return `<div class="gs-tile ${v.level}"><div class="gs-tile-h"><span class="gs-ic">${icon}</span>${esc(title)}</div>
    <b class="gs-val">${esc(value)}</b><div class="gs-meter"><i style="width:${pct}%"></i></div>
    <div class="gs-lv">${esc(t(`gs.${v.level}`))}</div>${extra ? `<div class="gs-note">${esc(extra)}</div>` : ""}${v.level !== "ok" ? `<div class="gs-note">${esc(v.note)}</div>` : ""}</div>`;
}

const GS_IC = {
  gpu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="9" cy="12" r="2.5"/><path d="M15 10h3M15 14h3M6 18v2M18 18v2"/></svg>',
  ram: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="7" width="18" height="10" rx="1.5"/><path d="M7 10v4M11 10v4M15 10v4M6 17v2M18 17v2"/></svg>',
  disk: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>',
};

function gsRender() {
  const d = gm.data; if (!d) return;
  const c = !gm.llm && d.checkImg ? d.checkImg : d.check, j = d.job; // без галочки помощника места нужно меньше
  const need = gm.llm ? d.need.all : d.need.image;
  const disk = c.disk.value >= 0 ? t("gm.free", {size: fmtSize(c.disk.value)}) : "—";
  const gpu = c.gpu ? `${c.gpu}${c.vram.value > 0 ? ', ' + gmGB(c.vram.value * 1048576) : ''}` : t('gs.unknownGPU');
  const ram = c.ram.value > 0 ? gmGB(c.ram.value * 1048576) : '—';
  const bestDrive = c.best && !d.root.toUpperCase().startsWith(c.best.toUpperCase()) ? c.drives.find(x => x.root === c.best) : null;
  const llmSize = d.need.all - d.need.image;
  let foot;
  if (j.active || j.paused) foot = gmProgress(j) + (j.active ? `<div class="gs-note">${esc(t('gs.wait'))}</div>` : '');
  else if (!c.ok) foot = `<div class="gs-cant"><b>${esc(t('gs.cantT'))}</b><span>${esc(t('gs.cant'))}</span></div>`;
  else foot = `${[c.vram, c.ram, c.disk].some(v => v.level === 'edge') ? `<div class="gs-note">${esc(t('gs.edgeNote'))}</div>` : ''}
    ${llmSize > 0 ? `<label class="ck gs-llm"><input type="checkbox" id="gsLlm"${gm.llm ? ' checked' : ''}><span>${esc(t('gs.llm', {size: fmtSize(llmSize)}))}</span></label>` : ''}
    <div class="gs-go"><span>${esc(t('gs.what', {size: fmtSize(need)}))}</span><button type="button" class="btn primary" id="gsGo">${esc(t('gs.go'))}</button></div>`;
  $('gnSetup').innerHTML = `<div class="gs-in">
    <h2 class="gs-title">${esc(t('gs.title'))}</h2><p class="gs-sub">${esc(t('gs.sub'))}</p>
    <div class="gs-tiles">${gsTile(GS_IC.gpu, t('gs.gpu'), gpu, c.vram)}${gsTile(GS_IC.ram, t('gs.ram'), ram, c.ram)}${gsTile(GS_IC.disk, t("gs.disk"), disk, c.disk, t("gs.needSize", {size: fmtSize(need)}))}</div>
    <div class="gs-folder"><span class="lb">${esc(t('gs.folder'))}</span><code title="${esc(d.root)}">${esc(d.root)}</code>
      <button type="button" class="btn sm" id="gsPick"${j.active ? ' disabled' : ''}>${esc(t('gm.change'))}</button></div>
    ${bestDrive ? `<div class="gs-hint">${esc(t('gs.folderHint', {drive: bestDrive.root, size: fmtSize(bestDrive.free)}))}
      <button type="button" class="linkb" id="gsBest" data-root="${esc(bestDrive.root)}"${j.active ? ' disabled' : ''}>${esc(t('gs.folderBest', {drive: bestDrive.root}))}</button></div>` : ''}
    <div class="gs-foot">${foot}</div></div>`;
}

// gmProgress: полоса скачивания с тем, что качается сейчас
function gmProgress(j) {
  const pct = j.total > 0 ? Math.min(100, j.done / j.total * 100) : 0;
  const step = j.cur ? (j.cur.startsWith('engine:') ? t(`gm.step.${j.cur}`) : (gm.data.models.find(m => m.id === j.cur)?.name || j.cur)) : '';
  const info = j.paused ? `${fmtSize(j.done) || '0'} / ${fmtSize(j.total)} · ${t('gm.paused')}` : t('gm.dl', {done: fmtSize(j.done) || '0', total: fmtSize(j.total), speed: fmtSize(j.speed) || '0'});
  return `<div class="gm-prog${j.paused ? ' paused' : ''}"><div class="gm-prog-h"><b>${esc(step)}</b><span>${Math.floor(pct)}%</span></div>
    <div class="gs-meter acc"><i style="width:${pct.toFixed(1)}%"></i></div>
    <div class="gm-prog-f"><span>${esc(info)}</span><span class="gm-prog-b">
    <button type="button" class="btn sm" id="${j.paused ? 'gmResume' : 'gmPause'}">${esc(t(j.paused ? 'gm.resume' : 'gm.pause'))}</button>
    <button type="button" class="btn sm" id="gmCancel">${esc(t('gm.cancel'))}</button></span></div></div>`;
}

// gmNum: число ГБ с одним знаком и запятой по-русски
const gmNum = x => String(Math.round(x * 10) / 10).replace('.', lang === 'ru' ? ',' : '.');

async function gmRoot(path) {
  const r = await api('ai-root', {path: path || ''});
  if (r.error) { say('warn', t('gs.folder'), r.error); return; }
  gm.data = r; gmRender();
}

async function gmInstall(ids) {
  const r = await api('ai-install', {models: ids});
  if (r.error) { say('warn', t('gm.failed'), r.error); return; }
  gm.data = r; gmRender(); gmWatch();
}

$('gnSetup').addEventListener('click', e => {
  if (e.target.closest('#gsPick')) gmRoot('');
  else if (e.target.closest('#gsBest')) gmRoot(e.target.closest('#gsBest').dataset.root + 'Kombain AI');
  else if (e.target.closest('#gsGo')) gmInstall(gm.data.first.filter((id, i) => i === 0 || gm.llm));
  else gmJobBtn(e);
});

// gmJobBtn: кнопки скачивания (общие для экрана первого запуска и списка моделей): пауза, продолжить, отменить
async function gmJobBtn(e) {
  const b = e.target.closest('#gmPause, #gmResume, #gmCancel'); if (!b) return;
  if (b.id === 'gmResume') { gmInstall(gm.data.job.items.filter(x => !x.startsWith('engine:'))); return; }
  await api('ai-cancel', {pause: b.id === 'gmPause'});
  if (b.id === 'gmCancel') await gmLoad();   // отмена на паузе: опроса уже нет, обновляем сами
}
$('gnSetup').addEventListener('change', e => { if (e.target.id === 'gsLlm') { gm.llm = e.target.checked; gsRender(); } });

// ---- панель «Модели» ----

// Иконки моделей: своя у каждой модели каталога (по id), иначе по виду. Рисуются цветом раздела.
const GM_SVG = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const GM_IC = {
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/>',
  crown: '<path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5L3 8z"/><path d="M5 15.5h14"/>',
  textpic: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 9h8M12 9v7"/>',
  palette: '<path d="M12 3a9 9 0 0 0 0 18c1.1 0 1.8-.8 1.8-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.8-1.7 1.7-1.7H17a4 4 0 0 0 4-4c0-4.4-4-8.2-9-8.2z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7" r="1"/>',
  feather: '<path d="M20.2 3.8a6 6 0 0 0-8.5 0L5 10.5V19h8.5l6.7-6.7a6 6 0 0 0 0-8.5z"/><path d="M16 8 2 22M17.5 15H9"/>',
  layers: '<path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-12.2 7.5L3 20.5l1.6-5A8.4 8.4 0 1 1 21 11.5z"/><path d="M12.5 7.5l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9z"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/>',
  upscale: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  cube: '<path d="M21 8 12 3 3 8v8l9 5 9-5V8z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
  sparks: '<path d="M11 3l1.8 5.2L18 10l-5.2 1.8L11 17l-1.8-5.2L4 10l5.2-1.8z"/><path d="M19 14l.8 2.2 2.2.8-2.2.8L19 20l-.8-2.2L16 17l2.2-.8z"/>',
  tools: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
};
const GM_ID_IC = {'flux2-klein-4b': 'bolt', 'qwen-image-2512': 'crown', 'ernie-image': 'textpic', 'chroma1-hd': 'palette', 'zimage-turbo': 'feather',
  'sdxl-base': 'layers', 'gemma3-4b': 'chat', 'gemma3-4b-eyes': 'eye', 'birefnet-matting': 'scissors', 'realesrgan': 'upscale'};
const GM_KIND_IC = {image: 'image', llm: 'chat', bgremove: 'scissors', upscale: 'upscale'};
const gmIcon = m => GM_SVG(GM_IC[(m.source !== 'user' && GM_ID_IC[m.id]) || GM_KIND_IC[m.kind] || 'cube']);

// разделы списка: генераторы, помощники, обработка готовых картинок; всё прочее (свои LoRA и т. п.) — «Другое»
const GM_CATS = [
  {id: 'gen', ic: 'sparks', kinds: ['image']},
  {id: 'help', ic: 'chat', kinds: ['llm']},
  {id: 'tool', ic: 'tools', kinds: ['bgremove', 'upscale']},
  {id: 'other', ic: 'cube', kinds: null},
];

// gmFit: полоса «пойдёт ли на этом компьютере»: хорошо / медленно / не потянет / не знаю, с причиной
// (считает aiFit в aisetup.go: видеопамять, а когда модель не влезает в неё целиком — ещё и обычная память)
function gmFit(m, c) {
  if (!m.fit) return '';
  const vram = gmNum(c.vram.value / 1024), ram = gmNum(c.ram.value / 1024);
  const d = m.fit === 'good' ? t('gm.fit.d.good', {have: vram, need: gmNum(m.good)})
    : m.fit === 'mid' ? t('gm.fit.d.mid', {have: vram, need: gmNum(m.good)})
    : m.fit === 'unknown' ? t('gm.fit.d.unknown', {need: gmNum(m.vram)})
    : m.why === 'ram' ? t('gm.fit.d.ram', {have: ram, need: gmNum(m.ramNeed)})
    : t('gm.fit.d.bad', {have: vram, need: gmNum(m.vram)});
  return `<div class="gm-fit f-${m.fit}"><i></i><b>${esc(t(`gm.fit.${m.fit}`))}</b><span>${esc(d)}</span></div>`;
}

function gmCard(m, c, j) {
  const busy = (j.active || j.paused) && j.items.includes(m.id);
  const act = m.installed
    ? `<button type="button" class="btn sm" data-del="${esc(m.id)}"${j.active ? ' disabled' : ''}>${esc(t('gm.del'))}</button>`
    : busy ? '' : `<button type="button" class="btn sm${m.kind === 'image' && m.fit !== 'bad' ? ' primary' : ''}" data-get="${esc(m.id)}"${j.active || !c.ok ? ' disabled' : ''}>${esc(t('gm.get', {size: fmtSize(m.size)}))}</button>`;
  const lic = m.source === 'catalog' ? ` · ${t(m.commercial ? 'gm.commercial' : 'gm.noCommercial')}` : '';
  const state = (m.installed ? `<span class="gm-on">${esc(t('gm.installed'))} · ${esc(fmtSize(m.size))}</span>`
    : `<span>${esc(t('gm.notInstalled'))}</span>`) + esc(lic);
  const badges = [...(m.source === 'user' ? ['own'] : []), ...(m.badges || [])];
  const licOpen = m.license && gm.lic.has(m.id);
  const foot = m.license ? `<button type="button" class="gm-lic-b${licOpen ? ' on' : ''}" data-lic>${esc(t('gm.license'))}</button>` : '<span></span>';
  const licText = licOpen ? `<div class="gm-lic-t">${esc(m.license)}${m.licenseUrl ? ` <a href="#" data-url="${esc(m.licenseUrl)}">${esc(m.licenseUrl.replace(/^https:\/\//, ''))}</a>` : ''}</div>` : '';
  return `<div class="gm-card${m.installed ? ' on' : ''}" data-id="${esc(m.id)}">
    <div class="gm-top"><div class="gm-ic">${gmIcon(m)}</div>
      <div class="gm-hd"><b class="gm-name">${esc(m.name)}</b><div class="gm-st">${state}</div></div></div>
    ${badges.length ? `<div class="gm-badges">${badges.map(b => `<span class="gm-badge b-${esc(b)}">${esc(t(b === 'own' ? 'gm.own' : `gm.b.${b}`))}</span>`).join('')}</div>` : ''}
    ${m.purpose ? `<div class="gm-p">${esc(m.purpose)}</div>` : ''}
    ${gmFit(m, c)}
    ${busy ? gmProgress(j) : ''}
    <div class="gm-foot">${foot}${act ? `<div class="gm-act">${act}</div>` : ''}</div>${licText}</div>`;
}

function gmListRender() {
  const d = gm.data; if (!d) return;
  const keep = $('gmList').scrollTop;   // список перерисовывается каждую секунду скачивания: не сбрасывать прокрутку
  const j = d.job, c = d.check;
  $('gmFolder').innerHTML = `<code title="${esc(d.root)}">${esc(d.root)}</code> <span>${esc(t('gm.used', {size: fmtSize(d.used) || '0'}))}${c.disk.value >= 0 ? ' · ' + esc(t('gm.free', {size: fmtSize(c.disk.value)})) : ''}</span>`;
  $('gmChange').disabled = j.active || j.paused;
  const known = GM_CATS.flatMap(s => s.kinds || []);
  const secs = GM_CATS.map(s => {
    const ms = d.models.filter(m => s.kinds ? s.kinds.includes(m.kind) : !known.includes(m.kind));
    if (!ms.length) return '';
    const on = ms.filter(m => m.installed).length;
    return `<section class="gm-sec c-${s.id}"><div class="gm-sec-h"><span class="gm-sec-ic">${GM_SVG(GM_IC[s.ic])}</span>
      <b>${esc(t(`gm.sec.${s.id}`))}</b><span class="gm-sec-n">${esc(t('gm.sec.n', {n: on, all: ms.length}))}</span>
      <span class="gm-sec-d">${esc(t(`gm.sec.${s.id}.d`))}</span></div>
      <div class="gm-grid">${ms.map(m => gmCard(m, c, j)).join('')}</div></section>`;
  });
  const why = !c.ok ? `<div class="gs-cant"><b>${esc(t('gs.cantT'))}</b><span>${esc([c.vram, c.ram, c.disk].filter(v => v.level === 'no').map(v => v.note).join(' '))}</span></div>` : '';
  $('gmList').innerHTML = why + secs.join('');
  $('gmList').scrollTop = keep;
}

$('gmList').addEventListener('click', async e => {
  const get = e.target.closest('[data-get]'), del = e.target.closest('[data-del]'), a = e.target.closest('a[data-url]');
  if (a) { e.preventDefault(); api('ai-license', {id: a.closest('.gm-card').dataset.id}); return; }
  if (e.target.closest('#gmPause, #gmResume, #gmCancel')) { gmJobBtn(e); return; }
  const lb = e.target.closest('[data-lic]');
  // «Лицензия»: раскрытые запоминаем в gm.lic, иначе перерисовка при скачивании сворачивает их сразу после клика
  if (lb) { const id = lb.closest('.gm-card').dataset.id; gm.lic[gm.lic.has(id) ? 'delete' : 'add'](id); gmListRender(); return; }
  if (get) {
    const m = gm.data.models.find(x => x.id === get.dataset.get), ck = gm.data.check;
    if (m?.fit === 'bad') {
      const ask = m.why === 'ram' ? t('gm.fitAskRam', {name: m.name, have: gmNum(ck.ram.value / 1024), need: gmNum(m.ramNeed), size: fmtSize(m.size)})
        : t('gm.fitAsk', {name: m.name, have: gmNum(ck.vram.value / 1024), need: gmNum(m.vram), size: fmtSize(m.size)});
      if (!await askYes(ask, t('gm.getAnyway'))) return;
    }
    gmInstall([get.dataset.get]);
    return;
  }
  if (del) {
    const m = gm.data.models.find(x => x.id === del.dataset.del);
    if (!await askYes(t('gm.delAsk', {name: m?.name || del.dataset.del}), t('ask.del'))) return;
    const r = await api('ai-remove', {id: del.dataset.del});
    if (r.error) { say('warn', t('gm.del'), r.error); return; }
    gm.data = r; gmRender(); gnInfo();
  }
});
$('gmChange').addEventListener('click', async () => {
  if (gm.data?.used > 0 && !await askYes(t('gm.folderMove', {size: fmtSize(gm.data.used)}), t('ask.change'))) return;
  gmRoot('');
});
$('gmBack').addEventListener('click', () => gmOpen(false));
$('gnModelsBtn').addEventListener('click', () => gmOpen(true));

// gmOpen: панель «Модели» вместо холста. Без готового генератора назад ведёт на экран первого запуска.
function gmOpen(on) {
  if (on) { gmCenter('models'); gmLoad(); return; }
  gmCenter(gn.info && !gn.info.ready ? 'setup' : '');
  if (gm.view === 'setup') gmLoad();
}

// gmSync: зовёт gnInfo. Генератор не готов — экран первого запуска (если не открыты «Модели»).
function gmSync(info) {
  if (!info.ready) { if (gm.view !== 'models') gmCenter('setup'); gmLoad(); }
  else if (gm.view === 'setup') gmCenter('');
  else if (gm.view === 'models') gmLoad();
}
