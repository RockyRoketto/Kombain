// ---------- вкладка «Баннеры» ----------
let bFiles = [];          // {name, dir, path, size}
const bres = {};          // путь -> состояние с сервера (последний прогон баннеров)
// имя без расширения: нижний регистр, латинская x (вместо × и русской х), без пробелов
const bKey = n => n.replace(/\.[^.]+$/, '').toLowerCase().replace(/[×х]/g, 'x').replace(/\s/g, '');
const bWanted = n => (snap.banner || []).find(w => w.toLowerCase() === bKey(n)) || '';
function setTab(t) {
  tab = t; save();
  document.querySelectorAll('#tabs .tab').forEach(b => b.classList.toggle('on', b.dataset.t === tab));
  $('convView').classList.toggle('hide', tab !== 'conv');
  $('bannerView').classList.toggle('hide', tab !== 'banner');
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
}
let bLast = '';
function bRender() {
  const labels = {pending:'ожидает', running:'<span class="spin"></span>', ok:'готово', error:'ошибка', canceled:'остановлен'};
  const names = snap.banner || [], got = new Set(bFiles.map(f => bWanted(f.name)).filter(Boolean));
  const html = names.map(n => `<div class="${got.has(n) ? 'got' : ''}">${esc(n)}<i>${got.has(n) ? '✓' : 'нет'}</i></div>`).join('');
  const list =
    bFiles.map(it => {
      const s = bres[it.path], w = bWanted(it.name);
      let cls = '', status = '', sub = esc(it.dir) + ' · ' + fmtSize(it.size);
      if (it.size > 500 * 1024) sub += '<span class="tag big">больше 500 КБ</span>';
      if (!w) sub += '<span class="tag">не из списка</span>';
      if (s) {
        cls = s.status; status = labels[s.status] || '';
        if (s.status === 'error') sub = esc(s.hint || s.msg);
        else if (s.msg) sub = esc(s.msg);
      }
      return `<div class="f sel ${cls}" title="${esc(it.path)}">` +
        (snap.ffmpeg ? `<div class="badge th" data-bprev="${esc(it.path)}" title="Посмотреть"><img src="${thumbUrl(it.path, .1, 160) + (s && s.dstSize ? '&v=' + s.dstSize : '')}" alt="" loading="lazy" onerror="this.remove()"><span class="ex">png</span></div>`
                     : '<div class="badge">png</div>') +
        `<div class="meta"><div class="n">${esc(it.name)}</div><div class="sub">${sub}</div></div>` +
        `<div class="pill">${status}</div>` + (snap.running ? '' : `<button class="x" data-bx="${esc(it.path)}" title="Убрать из списка">✕</button>`) + '</div>';
    }).join('');
  if (html + list === bLast) return;   // не перерисовываем без нужды — иначе мигают превью
  bLast = html + list;
  $('bNeed').innerHTML = html;
  $('bList').innerHTML = list;
  $('bFound').textContent = names.length ? `найдено ${got.size} из ${names.length}` : '';
  $('bEmpty').classList.toggle('hide', bFiles.length > 0);
  $('bList').classList.toggle('hide', !bFiles.length);
  $('bCnt').textContent = bFiles.length ? bFiles.length + ' PNG' : '';
}
$('bList').addEventListener('click', e => {
  const pv = e.target.closest('[data-bprev]');
  if (pv) { const it = bFiles.find(f => f.path === pv.dataset.bprev); if (it) openPreview(it); return; }
  const x = e.target.closest('[data-bx]');
  if (x && !snap.running) { bFiles = bFiles.filter(f => f.path !== x.dataset.bx); delete bres[x.dataset.bx]; bRender(); }
});
$('bAddFiles').onclick = () => dialog(async () => { const r = await api('pick-files'); if (r.error) alert(r.error); bAdd(r.files); });
$('bAddFolder').onclick = () => dialog(async () => { const r = await api('pick-folder', {purpose:'add'}); if (r.error) alert(r.error); bAdd(r.files); });
$('bClear').onclick = () => { if (!snap.running) { bFiles = []; Object.keys(bres).forEach(k => delete bres[k]); bRender(); } };
document.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => dialog(async () => {
  const r = await api('pick-folder', {purpose:'out'});
  if (r.error) alert(r.error);
  if (r.path) { $(b.dataset.pick).value = r.path; save(); }
}));
$('bStart').onclick = async () => {
  if (startSent || snap.running) return;
  if (!bFiles.length) { say('warn', 'Список пуст', 'Добавь PNG: перетащи их в окно или нажми «+ Файлы».'); return; }
  const jpgDir = $('jpgDir').value.trim(), webpDir = $('webpDir').value.trim();
  if (!jpgDir || !webpDir) { say('warn', 'Куда сохранять?', 'Выбери папки для JPEG и для WebP.'); return; }
  if (!bFiles.some(f => bWanted(f.name))) { say('warn', 'Нет нужных файлов', 'Среди добавленных PNG нет ни одного из списка — проверь имена.'); return; }
  bFiles.forEach(f => delete bres[f.path]);
  snap.files = []; newBatch(); bLast = '';
  startSent = true;
  const r = await api('banners', {files: bFiles.map(f => f.path), jpgDir, webpDir});
  startSent = false;
  if (r.error) say('err', 'Не запустилось', r.error);
  else snap.running = true;
};
function bDone(s) {
  const fl = s.files || [], er = fl.filter(f => f.status === 'error');
  const made = fl.filter(f => f.status === 'ok' && f.dst).length;
  const miss = (s.banner || []).filter(n => !fl.some(f => bWanted(f.name) === n));
  const open = p => async () => { const r = await api('open-dir', {path: p}); if (r.error) say('warn', 'Папка', r.error); };
  toast({id: 'done', type: er.length ? 'err' : miss.length || fl.some(f => f.status === 'canceled') ? 'warn' : 'ok',
    title: fl.some(f => f.status === 'canceled') ? 'Остановлено' : `Готово: ${made} JPEG + ${made} WebP`,
    text: esc(s.summary || ''),
    list: er.map(f => `<b style="display:inline;font-size:12.5px;color:#d4d4d8">${esc(f.name)}</b> — ${esc(f.hint || f.msg)}`)
      .concat(miss.length ? ['Не было в списке файлов: ' + miss.map(esc).join(', ')] : []),
    actions: made ? [{t: 'Открыть JPEG', primary: true, keep: true, fn: open($('jpgDir').value.trim())},
                     {t: 'Открыть WebP', keep: true, fn: open($('webpDir').value.trim())}] : [],
    ttl: er.length ? 0 : 15000});
}

