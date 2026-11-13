// Вкладка «ИИ-картинки»: экран первого запуска (проверка железа плитками «хватает / на пределе / не хватает»,
// папка для ИИ с подсказкой диска, где больше места, скачивание с прогрессом) и панель «Модели» (скачать, удалить,
// лицензия простыми словами). Оба занимают место холста в центре вкладки. Сервер: aisetup.go (ai-setup, ai-root,
// ai-install, ai-cancel, ai-remove), проверка железа — hwcheck.go.
const gm = {
  data: null,      // ответ ai-setup
  view: '',        // '', 'setup', 'models'
  timer: 0,
  llm: true,       // галочка «ещё помощник запросов» на экране первого запуска
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
  if (j.active) foot = gmProgress(j) + `<div class="gs-note">${esc(t('gs.wait'))}</div>`;
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
  return `<div class="gm-prog"><div class="gm-prog-h"><b>${esc(step)}</b><span>${Math.floor(pct)}%</span></div>
    <div class="gs-meter acc"><i style="width:${pct.toFixed(1)}%"></i></div>
    <div class="gm-prog-f"><span>${esc(t('gm.dl', {done: fmtSize(j.done) || '0', total: fmtSize(j.total), speed: fmtSize(j.speed) || '0'}))}</span>
    <button type="button" class="btn sm" id="gmCancel">${esc(t('gm.cancel'))}</button></div></div>`;
}

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
  else if (e.target.closest('#gmCancel')) api('ai-cancel');
});
$('gnSetup').addEventListener('change', e => { if (e.target.id === 'gsLlm') { gm.llm = e.target.checked; gsRender(); } });

// ---- панель «Модели» ----

function gmListRender() {
  const d = gm.data; if (!d) return;
  const j = d.job, c = d.check;
  $('gmFolder').innerHTML = `<code title="${esc(d.root)}">${esc(d.root)}</code> <span>${esc(t('gm.used', {size: fmtSize(d.used) || '0'}))}${c.disk.value >= 0 ? ' · ' + esc(t('gm.free', {size: fmtSize(c.disk.value)})) : ''}</span>`;
  $('gmChange').disabled = j.active;
  const rows = d.models.map(m => {
    const busy = j.active && j.items.includes(m.id);
    const tags = [m.source === 'user' ? t('gm.own') : '', m.vram > 0 ? t('gm.vram', {n: m.vram}) : '', !m.fits ? t('gm.vramLow') : '',
      m.source === 'catalog' ? t(m.commercial ? 'gm.commercial' : 'gm.noCommercial') : ''].filter(Boolean);
    const act = m.installed
      ? `<button type="button" class="btn sm" data-del="${esc(m.id)}"${j.active ? ' disabled' : ''}>${esc(t('gm.del'))}</button>`
      : busy ? '' : `<button type="button" class="btn sm${m.kind === 'image' ? ' primary' : ''}" data-get="${esc(m.id)}"${j.active || !c.ok ? ' disabled' : ''}>${esc(t('gm.get', {size: fmtSize(m.size)}))}</button>`;
    return `<div class="gm-row${m.installed ? ' on' : ''}" data-id="${esc(m.id)}">
      <div class="gm-pv k-${esc(m.kind)}"></div>
      <div class="gm-b"><div class="gm-n"><b>${esc(m.name)}</b>${m.installed ? `<span class="gm-tag">${esc(t('gm.installed'))}</span>` : ''}<span class="gm-kind">${esc(t(`gm.k.${m.kind}`) || m.kind)}</span></div>
        ${m.purpose ? `<div class="gm-p">${esc(m.purpose)}</div>` : ''}
        <div class="gm-meta">${tags.map(x => `<span>${esc(x)}</span>`).join('')}${m.installed ? `<span>${esc(fmtSize(m.size))}</span>` : ''}</div>
        ${m.license ? `<details class="gm-lic"><summary>${esc(t('gm.license'))}</summary><p>${esc(m.license)}${m.licenseUrl ? ` <a href="#" data-url="${esc(m.licenseUrl)}">${esc(m.licenseUrl.replace(/^https:\/\//, ''))}</a>` : ''}</p></details>` : ''}
        ${busy ? gmProgress(j) : ''}</div>
      <div class="gm-act">${act}</div></div>`;
  });
  const why = !c.ok ? `<div class="gs-cant"><b>${esc(t('gs.cantT'))}</b><span>${esc([c.vram, c.ram, c.disk].filter(v => v.level === 'no').map(v => v.note).join(' '))}</span></div>` : '';
  $('gmList').innerHTML = why + rows.join('');
}

$('gmList').addEventListener('click', async e => {
  const get = e.target.closest('[data-get]'), del = e.target.closest('[data-del]'), a = e.target.closest('a[data-url]');
  if (a) { e.preventDefault(); api('ai-license', {id: a.closest('.gm-row').dataset.id}); return; }
  if (e.target.closest('#gmCancel')) { api('ai-cancel'); return; }
  if (get) { gmInstall([get.dataset.get]); return; }
  if (del) {
    const m = gm.data.models.find(x => x.id === del.dataset.del);
    if (!confirm(t('gm.delAsk', {name: m?.name || del.dataset.del}))) return;
    const r = await api('ai-remove', {id: del.dataset.del});
    if (r.error) { say('warn', t('gm.del'), r.error); return; }
    gm.data = r; gmRender(); gnInfo();
  }
});
$('gmChange').addEventListener('click', () => {
  if (gm.data?.used > 0 && !confirm(t('gm.folderMove', {size: fmtSize(gm.data.used)}))) return;
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
