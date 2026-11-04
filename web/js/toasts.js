// ---------- всплывашки ----------
const plural = (n, a, b, c) => { const m = n % 10, h = n % 100; return n + ' ' + (m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 10 || h >= 20) ? b : c); };
const toastMap = {};
// toast({id, type: ok|warn|err|info, title, text, list, actions:[{t, primary, fn}], ttl})
function toast(o) {
  const id = o.id || ('t' + Math.random().toString(36).slice(2));
  let el = toastMap[id];
  if (!el) {
    el = document.createElement('div');
    el.setAttribute('role', o.type === 'err' ? 'alert' : 'status');
    $('toasts').appendChild(el);
    toastMap[id] = el;
  }
  clearTimeout(el._t);
  el.className = 'toast ' + (o.type || 'info');
  el.innerHTML = `<b>${esc(o.title || '')}</b>` + (o.text ? `<p>${o.text}</p>` : '') +
    (o.list && o.list.length ? '<ul>' + o.list.map(x => `<li>${x}</li>`).join('') + '</ul>' : '') +
    (o.actions && o.actions.length ? '<div class="ta">' + o.actions.map((a, i) => `<button class="btn${a.primary ? ' primary' : ''}" data-a="${i}">${esc(a.t)}</button>`).join('') + '</div>' : '') +
    '<button class="tx" title="Закрыть">✕</button>';
  el.onclick = e => {
    if (e.target.closest('.tx')) { closeToast(id); return; }
    const b = e.target.closest('[data-a]');
    if (b) { const a = o.actions[+b.dataset.a]; if (a.keep !== true) closeToast(id); a.fn(); }
  };
  if (o.ttl) el._t = setTimeout(() => closeToast(id), o.ttl);
  const all = $('toasts').children;
  if (all.length > 4) closeToast(Object.keys(toastMap).find(k => toastMap[k] === all[0]));
  return id;
}
function closeToast(id) {
  const el = toastMap[id]; if (!el) return;
  delete toastMap[id];
  el.classList.add('out');
  setTimeout(() => el.remove(), 200);
}
function say(type, title, text) { toast({type, title, text: esc(text), ttl: type === 'err' ? 0 : 7000}); }
window.alert = m => say('warn', 'Внимание', String(m));

// события пачки: пропуски, ошибки, итог
let batch = {skipped: {}, errors: {}};
function newBatch() {
  batch = {skipped: {}, errors: {}, req: null};
  closeToast('skip'); closeToast('err'); closeToast('done');
}
const nameList = (arr, f) => arr.slice(0, 4).map(f).concat(arr.length > 4 ? [`и ещё ${arr.length - 4}`] : []);
function batchEvents(s) {
  let chSkip = false, chErr = false;
  (s.files || []).forEach(f => {
    if (f.status === 'skipped' && !batch.skipped[f.path]) { batch.skipped[f.path] = f; chSkip = true; }
    if (f.status === 'error' && !batch.errors[f.path]) { batch.errors[f.path] = f; chErr = true; }
  });
  const req = lastReq;
  if (chSkip) {
    const sk = Object.values(batch.skipped), n = sk.length, paths = sk.map(f => f.path);
    toast({id: 'skip', type: 'warn',
      title: n === 1 ? 'Уже сконвертировано' : `Уже сконвертировано: ${plural(n, 'файл', 'файла', 'файлов')}`,
      text: n === 1
        ? `«${esc(sk[0].name)}» не перекодирован: <b>${esc(base(sk[0].dst))}</b> уже лежит в папке «${esc(dirOf(sk[0].dst).replace(/[\\/]$/, ''))}». Пропустил, чтобы не затереть.`
        : 'Результаты уже лежат в папке — пропустил, чтобы не затереть:',
      list: n === 1 ? [] : nameList(sk, f => `${esc(f.name)} → ${esc(base(f.dst))}`),
      actions: [
        {t: n === 1 ? 'Создать копию' : 'Создать копии', primary: true, fn: () => startBatch(paths, req, {copy: true, overwrite: false})},
        {t: n === 1 ? 'Перезаписать' : 'Перезаписать все', fn: () => startBatch(paths, req, {overwrite: true, copy: false})}
      ]});
  }
  if (chErr) {
    const er = Object.values(batch.errors), n = er.length, paths = er.map(f => f.path);
    toast({id: 'err', type: 'err',
      title: n === 1 ? `Не получилось: «${er[0].name}»` : `Не получилось: ${plural(n, 'файл', 'файла', 'файлов')}`,
      text: n === 1 ? esc(er[0].hint || er[0].msg) : '',
      list: n === 1 ? [] : nameList(er, f => `<b style="display:inline;font-size:12.5px;color:var(--tx-em)">${esc(f.name)}</b> — ${esc(f.hint || f.msg)}`),
      actions: [
        {t: 'Повторить', fn: () => startBatch(paths, req)},
        {t: 'Подробности', keep: true, fn: () => { $('logWrap').classList.remove('hide'); $('logWrap').scrollIntoView({behavior: 'smooth', block: 'center'}); }}
      ]});
  }
}
function batchDone(s) {
  const fl = s.files || [];
  const ok = fl.filter(f => f.status === 'ok'), canc = fl.filter(f => f.status === 'canceled').length;
  if (canc) {
    toast({id: 'done', type: 'info', title: 'Остановлено', text: `Готово ${ok.length} из ${fl.length}. Недоделанные файлы удалены.`, ttl: 8000});
    return;
  }
  const kept = fl.filter(f => f.status === 'kept');
  const keptText = kept.length ? `Оставил как есть: ${plural(kept.length, 'файл', 'файла', 'файлов')} — меньше не получилось или и так влезали.` : '';
  if (!ok.length) { // про пропуски и ошибки уже сказали
    if (kept.length) toast({id: 'done', type: 'info', title: 'Сжимать нечего', text: esc(keptText), list: nameList(kept, f => `${esc(f.name)} — ${esc(f.msg)}`), ttl: 12000});
    return;
  }
  const src = ok.reduce((a, f) => a + (f.srcSize || 0), 0), dst = ok.reduce((a, f) => a + (f.dstSize || 0), 0);
  const d = src && dst ? Math.round((1 - dst / src) * 100) : null;
  toast({id: 'done', type: 'ok', title: `Готово: ${plural(ok.length, 'файл', 'файла', 'файлов')}`,
    text: (src && dst ? `${fmtSize(src)} → ${fmtSize(dst)}` + (d !== null ? (d >= 0 ? ` (меньше на ${d}%)` : ` (больше на ${-d}%)`) : '') : '') +
      (keptText ? (src && dst ? '<br>' : '') + esc(keptText) : ''),
    actions: [{t: 'Открыть папку', primary: true, fn: async () => { const r = await api('open-output'); if (r.error) say('warn', 'Папка', r.error); }}],
    ttl: 12000});
}

