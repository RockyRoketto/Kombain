// ---------- список файлов ----------
const res = {};   // последний результат по каждому файлу (путь -> состояние с сервера)
let lastIdx = null, lastList = '';
function render() {
  const labels = {pending:t('status.pending'), ok:t('status.ok'), error:t('status.error'), skipped:t('status.skipped'), kept:t('status.kept'), canceled:t('status.canceled')};
  $('empty').classList.toggle('hide', files.length > 0);
  $('list').classList.toggle('hide', files.length === 0);
  $('listbar').classList.toggle('hide', files.length === 0);
  const html = files.map((it, i) => {
    const s = it.path ? res[it.path] : null;
    let cls = '', status = '', sub = '', pb = '';
    if (it.uploading) { status = '<span class="spin"></span>' + t('list.copying'); sub = fmtSize(it.size); }
    else {
      sub = (it.temp ? '' : esc(it.dir)) + (it.size ? (it.temp ? '' : ' · ') + fmtSize(it.size) : '');
      if (s) {
        cls = s.status;
        if (s.status === 'running') { status = s.pct ? Math.round(s.pct) + '%' : '<span class="spin"></span>'; pb = `<div class="pb"><i style="width:${s.pct}%"></i></div>`; }
        else status = labels[s.status] || '';
        if (s.status === 'ok' && s.srcSize && s.dstSize) {
          const d = Math.round((1 - s.dstSize / s.srcSize) * 100);
          sub = fmtSize(s.srcSize) + ' → ' + fmtSize(s.dstSize) + ' · ' + t('list.savedIn', {dir: esc(dirOf(s.dst))});
          status = d >= 0 ? `−${d}%` : `+${-d}%`;
          if (s.msg) sub = esc(s.msg) + ' · ' + sub;
        }
        if (s.status === 'skipped') sub = t('list.skipped', {name: esc(base(s.dst))});
        else if (s.status === 'error') sub = esc(s.hint || s.msg);
        else if (s.msg && s.status !== 'ok') sub = esc(s.msg);
      }
    }
    const dis = snap.running || it.uploading;
    return `<div class="f ${cls}${it.sel ? ' sel' : ''}" data-i="${i}" title="${esc(it.path || it.name)}">` +
      `<label class="ck"><input type="checkbox" ${it.sel ? 'checked' : ''} ${dis ? 'disabled' : ''}></label>` +
      (it.path && snap.ffmpeg
        ? `<div class="badge th" data-prev="${i}" title="${t('list.preview')}"><img src="${thumbUrl(it.path, .1, 160)}" alt="" loading="lazy" onerror="this.remove()"><span class="ex">${esc(ext(it.name))}</span></div>`
        : `<div class="badge">${esc(ext(it.name))}</div>`) +
      `<div class="meta"><div class="n">${esc(it.name)}</div><div class="sub">${sub}</div></div>` +
      `<div class="pill">${status}</div>` +
      (snap.running ? '' : `<button class="x" title="${t('list.remove')}">✕</button>`) + pb + `</div>`;
  }).join('');
  // опрос идёт каждые 700 мс: без изменений не перерисовываем, иначе теряются клики и мигают превью
  if (html !== lastList) { $('list').innerHTML = html; lastList = html; }
  const n = files.length, k = files.filter(f => f.sel).length;
  $('cnt').textContent = n ? (k === n ? tn(n, 'n.pcs') : t('list.selected', {k, n})) : '';
  const m = $('selAll');
  m.checked = n > 0 && k === n; m.indeterminate = k > 0 && k < n; m.disabled = snap.running;
  $('selTxt').textContent = (n > 0 && k === n) ? t('list.clearAll') : t('list.selectAll');
  $('start').textContent = n ? t('btn.startN', {k}) : t('btn.start');
}
function addInfos(list) {
  const have = new Set(files.map(f => f.path));
  for (const f of list || []) {
    if (have.has(f.path)) continue;
    files.push({name: base(f.path), dir: dirOf(f.path), path: f.path, size: f.size, uploading: false, temp: false, sel: true});
    have.add(f.path);
  }
  render();
}
function dropItems(pred) {
  const gone = files.filter(pred);
  if (!gone.length) return;
  const tmp = gone.filter(f => f.temp && f.path).map(f => f.path);
  if (tmp.length) api('discard', {paths: tmp});
  files = files.filter(f => !gone.includes(f));
  gone.forEach(f => { if (f.path) delete res[f.path]; });
  lastIdx = null; render();
}
$('list').addEventListener('click', e => {
  const pv = e.target.closest('[data-prev]');
  if (pv) { const it = files[+pv.dataset.prev]; if (it) openPreview(it); return; }
  if (snap.running) return;
  const row = e.target.closest('.f'); if (!row) return;
  const i = +row.dataset.i, it = files[i]; if (!it) return;
  if (e.target.closest('.x')) { dropItems(f => f === it); return; }
  if (it.uploading) return;
  const onInput = e.target.tagName === 'INPUT';
  if (e.target.closest('label.ck') && !onInput) return;   // дождёмся клика по самому чекбоксу
  const want = onInput ? e.target.checked : !it.sel;
  if (e.shiftKey && lastIdx !== null && files[lastIdx]) {
    const a = Math.min(lastIdx, i), b = Math.max(lastIdx, i);
    for (let j = a; j <= b; j++) if (!files[j].uploading) files[j].sel = want;
  } else it.sel = want;
  lastIdx = i; render();
});
$('selAll').addEventListener('change', e => { files.forEach(f => { if (!f.uploading) f.sel = e.target.checked; }); render(); });
$('selInv').onclick = () => { if (!snap.running) { files.forEach(f => { if (!f.uploading) f.sel = !f.sel; }); render(); } };
$('selErr').onclick = () => { if (!snap.running) { files.forEach(f => { f.sel = !!(f.path && res[f.path] && res[f.path].status === 'error'); }); render(); } };
$('rmDone').onclick = () => { if (!snap.running) dropItems(f => f.path && res[f.path] && res[f.path].status === 'ok'); };
$('clearBtn').onclick = () => {
  if (snap.running) return;
  const tmp = files.filter(f => f.temp && f.path).map(f => f.path);
  if (tmp.length) api('discard', {paths: tmp});
  files = []; snap.files = []; snap.summary = ''; Object.keys(res).forEach(k => delete res[k]); lastIdx = null; render();
};

