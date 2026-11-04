// ---------- вкладка «Баннеры» ----------
let bFiles = [];          // {name, dir, path, size}
const bres = {};          // путь -> состояние с сервера (последний прогон баннеров)
// имя без расширения: нижний регистр, латинская x (вместо × и русской х), без пробелов
const bKey = n => n.replace(/\.[^.]+$/, '').toLowerCase().replace(/[×х]/g, 'x').replace(/\s/g, '');
const bWanted = n => (snap.banner || []).find(w => w.toLowerCase() === bKey(n)) || '';
// размер картинки не тот, что в имени файла: [ширина, высота] из имени, иначе null. Пока размер не прочитан — тоже null
function bBadSize(it) {
  const m = bKey(it.name).match(/(\d+)x(\d+)/);
  return m && it.w && (it.w !== +m[1] || it.h !== +m[2]) ? [+m[1], +m[2]] : null;
}
// прочитать настоящие размеры; force — заново, файлы могли измениться
async function bCheckSizes(force) {
  for (const it of [...bFiles]) {
    if (it.w && !force) continue;
    const mi = await api('info', {path: it.path});
    if (mi.w) { it.w = mi.w; it.h = mi.h; }
  }
  bRender();
}
function setTab(t) {
  tab = t; save();
  document.querySelectorAll('#tabs .tab').forEach(b => b.classList.toggle('on', b.dataset.t === tab));
  $('convView').classList.toggle('hide', tab !== 'conv');
  $('bannerView').classList.toggle('hide', tab !== 'banner');
  $('playView').classList.toggle('hide', tab !== 'play');
  plTabChanged();
  updateButtons(); bRender();
}
$('tabs').addEventListener('click', e => { const b = e.target.closest('.tab'); if (b) setTab(b.dataset.t); });
function bAdd(list) {
  const have = new Set(bFiles.map(f => f.path.toLowerCase()));
  for (const f of list || []) {
    if (!/\.png$/i.test(f.path) || have.has(f.path.toLowerCase())) continue;
    bFiles.push({name: base(f.path), dir: dirOf(f.path), path: f.path, size: f.size});
    have.add(f.path.toLowerCase());
  }
  // сначала файлы из списка, в его порядке
  const order = n => { const i = (snap.banner || []).indexOf(bWanted(n)); return i < 0 ? 99 : i; };
  bFiles.sort((a, b) => order(a.name) - order(b.name));
  bRender();
  bSyncDirs();
  bCheckSizes();
}
let bLast = '';
let bOut = null;          // {jpg, webp}: куда сохранил последний запуск
let bDirs = {};           // ответ /api/banner-dirs: где папки для текущих PNG
const bFilled = {};       // что подставила программа: такой путь уходит вместе со сменой проекта
// режим «создать папки»: ручной выбор скрыт, в подсказке куда лягут файлы
function bRenderDirs() {
  const auto = $('bAutoDirs').checked;
  $('bManualDirs').classList.toggle('hide', auto);
  $('bAutoNote').classList.toggle('hide', !auto);
  if (!auto) return;
  const line = (name, dir, found) => t('b.autoNoteDir', {name, dir: esc(dir), state: t(found ? 'b.dirExists' : 'b.dirNew')});
  const html = bDirs.base ? line('JPEG', bDirs.jpgDir, bDirs.jpgFound) + '<br>' + line('WebP', bDirs.webpDir, bDirs.webpFound) : t('b.autoNote');
  if ($('bAutoNote').innerHTML !== html) $('bAutoNote').innerHTML = html;   // опрос не сбрасывает выделение текста
}
// спросить, где папки для текущих PNG; chosen — только что выбранная вручную папка
async function bSyncDirs(chosen) {
  const r = await api('banner-dirs', Object.assign({files: bFiles.map(f => f.path)}, chosen));
  const moved = !!r.base && r.base !== bDirs.base;
  const fill = (id, dir, found) => {
    const el = $(id), cur = el.value.trim();
    if (found && (moved || !cur)) { el.value = dir; bFilled[id] = dir; }
    else if (!found && moved && cur && cur === bFilled[id]) el.value = '';   // чужой проект: не сохранять в его папку
  };
  if (r.base) { fill('jpgDir', r.jpgDir, r.jpgFound); fill('webpDir', r.webpDir, r.webpFound); save(); }
  bDirs = r.base ? r : (bFiles.length ? bDirs : {});
  bRenderDirs();
}
$('bAutoDirs').addEventListener('change', () => bSyncDirs());
function bRender() {
  bRenderDirs();
  const labels = {pending:t('status.pending'), running:'<span class="spin"></span>', ok:t('status.ok'), error:t('status.error'), canceled:t('status.canceled')};
  const names = snap.banner || [], got = new Set(bFiles.map(f => bWanted(f.name)).filter(Boolean));
  const bad = new Set(bFiles.filter(bBadSize).map(f => bWanted(f.name)).filter(Boolean));
  const html = names.map(n => `<div class="${bad.has(n) ? 'bad' : got.has(n) ? 'got' : ''}">${esc(n)}<i>${bad.has(n) ? t('b.sizeShort') : got.has(n) ? '✓' : t('b.missing')}</i></div>`).join('');
  const list =
    bFiles.map(it => {
      const s = bres[it.path], w = bWanted(it.name);
      let cls = '', status = '', sub = esc(it.dir) + ' · ' + fmtSize(it.size);
      if (it.size > 500 * 1024) sub += `<span class="tag big">${t('b.over500')}</span>`;
      if (!w) sub += `<span class="tag">${t('b.notListed')}</span>`;
      if (s) {
        cls = s.status; status = labels[s.status] || '';
        if (s.status === 'error') sub = esc(s.hint || s.msg);
        else if (s.msg) sub = esc(s.msg);
      }
      const need = bBadSize(it);
      if (need) sub = `<span class="tag big">${t(it.size > 500 * 1024 ? 'b.sizeFix' : 'b.sizeBad', {w: it.w, h: it.h, nw: need[0], nh: need[1]})}</span>` + sub;   // первой: длинный путь обрезается многоточием
      return `<div class="f sel ${cls}" title="${esc(it.path)}">` +
        (snap.ffmpeg ? `<div class="badge th" data-bprev="${esc(it.path)}" title="${t('list.preview')}"><img src="${thumbUrl(it.path, .1, 160) + (s && s.dstSize ? '&v=' + s.dstSize : '')}" alt="" loading="lazy" onerror="this.remove()"><span class="ex">png</span></div>`
                     : '<div class="badge">png</div>') +
        `<div class="meta"><div class="n">${esc(it.name)}</div><div class="sub">${sub}</div></div>` +
        `<div class="pill">${status}</div>` + (snap.running ? '' : `<button class="x" data-bx="${esc(it.path)}" title="${t('list.remove')}">✕</button>`) + '</div>';
    }).join('');
  if (html + list === bLast) return;   // не перерисовываем без нужды — иначе мигают превью
  bLast = html + list;
  $('bNeed').innerHTML = html;
  $('bList').innerHTML = list;
  $('bFound').textContent = names.length ? t('b.found', {k: got.size, n: names.length}) : '';
  $('bEmpty').classList.toggle('hide', bFiles.length > 0);
  $('bList').classList.toggle('hide', !bFiles.length);
  $('bCnt').textContent = bFiles.length ? bFiles.length + ' PNG' : '';
}
$('bList').addEventListener('click', e => {
  const pv = e.target.closest('[data-bprev]');
  if (pv) { const it = bFiles.find(f => f.path === pv.dataset.bprev); if (it) openPreview(it); return; }
  const x = e.target.closest('[data-bx]');
  if (x && !snap.running) { bFiles = bFiles.filter(f => f.path !== x.dataset.bx); delete bres[x.dataset.bx]; bRender(); bSyncDirs(); }
});
$('bAddFiles').onclick = () => dialog(async () => { const r = await api('pick-files'); if (r.error) alert(r.error); bAdd(r.files); });
$('bAddFolder').onclick = () => dialog(async () => { const r = await api('pick-folder', {purpose:'add'}); if (r.error) alert(r.error); bAdd(r.files); });
$('bClear').onclick = () => { if (!snap.running) { bFiles = []; Object.keys(bres).forEach(k => delete bres[k]); bRender(); bSyncDirs(); } };
document.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => dialog(async () => {
  const r = await api('pick-folder', {purpose:'out'});
  if (r.error) alert(r.error);
  if (r.path) { $(b.dataset.pick).value = r.path; save(); await bSyncDirs({[b.dataset.pick]: r.path}); }
}));
$('bStart').onclick = async () => {
  if (startSent || snap.running) return;
  if (!bFiles.length) { say('warn', t('start.emptyTitle'), t('b.emptyAdd')); return; }
  const jpgDir = $('jpgDir').value.trim(), webpDir = $('webpDir').value.trim();
  const autoDirs = $('bAutoDirs').checked;
  if (!autoDirs && (!jpgDir || !webpDir)) { say('warn', t('start.whereTitle'), t('b.pickDirs')); return; }
  if (!bFiles.some(f => bWanted(f.name))) { say('warn', t('b.noNeededTitle'), t('b.noNeeded')); return; }
  bFiles.forEach(f => delete bres[f.path]);
  snap.files = []; newBatch(); bLast = '';
  startSent = true;
  const r = await api('banners', {files: bFiles.map(f => f.path), jpgDir, webpDir, autoDirs});
  startSent = false;
  if (r.error) say('err', t('start.failed'), r.error);
  else { bOut = {jpg: r.jpgDir, webp: r.webpDir}; snap.running = true; }
};
async function bDone(s) {
  bSyncDirs();   // папки могли появиться
  await bCheckSizes(true);   // большие PNG теперь другого размера: в итоге только те, что так и не совпали
  const wrong = bFiles.filter(f => bWanted(f.name) && bBadSize(f)).map(f => `${esc(f.name)} (${f.w}×${f.h})`);
  const fl = s.files || [], er = fl.filter(f => f.status === 'error');
  const made = fl.filter(f => f.status === 'ok' && f.dst).length;
  const miss = (s.banner || []).filter(n => !fl.some(f => bWanted(f.name) === n));
  const open = p => async () => { const r = await api('open-dir', {path: p}); if (r.error) say('warn', t('folder.title'), r.error); };
  const out = bOut || {jpg: $('jpgDir').value.trim(), webp: $('webpDir').value.trim()};
  toast({id: 'done', type: er.length ? 'err' : miss.length || wrong.length || fl.some(f => f.status === 'canceled') ? 'warn' : 'ok',
    title: fl.some(f => f.status === 'canceled') ? t('done.stopped') : t('b.doneTitle', {n: made}),
    text: esc(s.summary || ''),
    list: er.map(f => `<b style="display:inline;font-size:12.5px;color:var(--tx-em)">${esc(f.name)}</b> — ${esc(f.hint || f.msg)}`)
      .concat(miss.length ? [t('b.notAmong', {names: miss.map(esc).join(', ')})] : [])
      .concat(wrong.length ? [t('b.sizeList', {names: wrong.join(', ')})] : []),
    actions: made ? [{t: t('b.openJpeg'), primary: true, keep: true, fn: open(out.jpg)},
                     {t: t('b.openWebp'), keep: true, fn: open(out.webp)}] : [],
    ttl: er.length ? 0 : 15000});
}

