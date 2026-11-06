// ---------- своё меню правой кнопки. Меню браузера выключено везде: в окне настройкой (ui_windows.go), в браузере здесь ----------
let ctxEl = null;
function ctxClose() {
  if (ctxEl) { ctxEl.remove(); ctxEl = null; }
}
// items: {label, key, run, off} или '-' для разделителя
function ctxOpen(x, y, items) {
  ctxClose();
  const m = ctxEl = document.createElement('div');
  m.className = 'ctx';
  for (const it of items) {
    if (it === '-') { m.appendChild(document.createElement('hr')); continue; }
    const b = document.createElement('button');
    b.disabled = !!it.off;
    if (it.title) b.title = it.title;
    b.innerHTML = `<span>${esc(it.label)}</span>${it.key ? `<kbd>${esc(it.key)}</kbd>` : ''}`;
    b.onclick = () => { ctxClose(); it.run(); };
    m.appendChild(b);
  }
  m.addEventListener('mousedown', e => e.preventDefault());   // фокус остаётся в поле ввода, иначе «Вставить» некуда
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(Math.min(x, innerWidth - r.width - 6), 6) + 'px';
  m.style.top = Math.max(Math.min(y, innerHeight - r.height - 6), 6) + 'px';
}
function ctxText(el) {
  const ro = el.readOnly || el.disabled;
  let has = false;
  try { has = el.selectionStart !== el.selectionEnd; } catch (e) {}
  if (el.selectionStart === null) has = !!String(getSelection());   // поле числа не отдаёт выделение
  return [
    {label: t('ctx.cut'), key: 'Ctrl+X', off: ro || !has, run: () => document.execCommand('cut')},
    {label: t('ctx.copy'), key: 'Ctrl+C', off: !has, run: () => document.execCommand('copy')},
    {label: t('ctx.paste'), key: 'Ctrl+V', off: ro, run: () => { navigator.clipboard.readText().then(s => { el.focus(); document.execCommand('insertText', false, s); }).catch(() => {}); }},
    '-',
    {label: t('kh.all'), key: 'Ctrl+A', off: !el.value, run: () => el.select()},
  ];
}
function ctxCue(el) {
  const i = +el.dataset.i;
  if (!mtCuePicked(i)) mtCueSelect(i, false);
  const many = mtCueMany.size > 1, list = mtCueList();
  return [
    {label: t('mt.cue.split'), off: many, run: mtCueSplit},
    {label: t('mt.cue.merge'), off: many || mtCueCur() + 1 >= list.length, run: mtCueMerge},
    {label: many ? t('ctx.cuesDel', {n: mtCueMany.size}) : t('mt.cue.del'), key: 'Delete', run: mtCueDelete},
    '-',
    {label: t('ctx.cueAll'), key: 'Ctrl+A', run: mtCueAll},
  ];
}
function ctxClip(el) {
  const c = tkById(+el.dataset.id);
  if (!c) return null;
  if (!tkSel.has(c.id)) { tkSel = new Set(tkIds(c)); tkSelChanged(); }
  if (mtCueSel !== null || mtCueMany.size) { mtCueNone(); mtCueLane(); mtCuesFill(); }   // иначе Delete снёс бы и реплики, которых в меню нет
  const here = tkSelected().some(x => tkAt > x.at && tkAt < tkEnd(x));
  return [
    {label: t('kh.cut'), key: 'Ctrl+K', off: !here, run: tkCutHere},
    {label: t('kh.unlink'), key: 'Ctrl+L', run: tkLinkToggle},
    '-',
    {label: t('ctx.cut'), key: 'Ctrl+X', run: () => { tkCopy(); tkRemove(false); }},
    {label: t('ctx.copy'), key: 'Ctrl+C', run: tkCopy},
    {label: t('kh.dup'), key: 'Ctrl+D', run: tkDuplicate},
    '-',
    {label: t('kh.del'), key: 'Delete', run: () => tkRemove(false)},
    {label: t('kh.ripple'), key: 'Shift+Delete', run: () => tkRemove(true)},
  ];
}
// что предложить в этом месте; пусто — меню нет
function ctxItems(e) {
  const el = e.target;
  if (el.closest && el.closest('input:not([type=range]):not([type=checkbox]):not([type=radio]),textarea')) return ctxText(el.closest('input,textarea'));
  if (tab !== 'mont' || !el.closest || !el.closest('#tkScroll') || el.closest('.tk-th,.tk-rowh,#tkRuler')) return null;
  const cue = el.closest('.tk-cue');
  if (cue) return ctxCue(cue);
  const clip = el.closest('.tk-clip');
  if (clip) return ctxClip(clip);
  return [
    {label: t('ctx.paste'), key: 'Ctrl+V', off: !tkBoard.length, run: () => tkInsert(tkBoard, tkAt)},
    {label: t('kh.marker'), key: 'M', run: tkPutMarker},
    {label: t('kh.all'), key: 'Ctrl+A', off: !tkClips().length, run: TK_CTRL_KEYS.KeyA},
  ];
}
document.addEventListener('contextmenu', e => {
  const done = e.defaultPrevented;   // правый клик по метке уже удалил её
  e.preventDefault();
  const items = done ? null : ctxItems(e);
  if (items) ctxOpen(e.clientX, e.clientY, items); else ctxClose();
});
document.addEventListener('pointerdown', e => { if (ctxEl && !ctxEl.contains(e.target)) ctxClose(); }, true);
document.addEventListener('keydown', e => { if (ctxEl && e.key === 'Escape') { e.stopPropagation(); ctxClose(); } }, true);
document.addEventListener('wheel', () => ctxClose(), {capture: true, passive: true});
window.addEventListener('blur', ctxClose);
window.addEventListener('resize', ctxClose);
