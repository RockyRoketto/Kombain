// ---------- Строка «куда лягут файлы»: путь одной компактной строкой с отметкой, что папка уже есть, а что создастся ----------
// Общий кусочек для любого места, где файлы сохраняются в папку. Первой его взяла «Сборка баннеров» (bannermake.js).
// pathLine({root, steps: [{name, ok, strong, title}], chips: [[подпись, число]], warn})
//   root — общая папка целиком (в строке укорочена до последних двух частей, полный путь в подсказке);
//   steps — вложенные папки по порядку; ok: true — уже есть, false — создастся (акцентный цвет и «+»); strong — выделить (последняя папка);
//   chips — что внутри последней папки (формат и число файлов); warn — файлы заменятся (оранжевая точка у последнего шага).
// Возвращает HTML строки; стили .pl* в style.css. Всё, что приходит снаружи, экранируется здесь.
const PL_DIR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4.3l2 2.2h8.7A1.5 1.5 0 0 1 21 9.7v8.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/></svg>';
function plShort(p) {
  const parts = String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return String(p || '').replace(/[\\/]+$/, '');
  return '…\\' + parts.slice(-2).join('\\');
}
function pathLine(o) {
  const sep = '<i class="pl-sep">›</i>';
  let h = `<span class="pl-s root" title="${esc(o.root)}">${PL_DIR}<span>${esc(plShort(o.root))}</span></span>`;
  (o.steps || []).forEach((s, i, a) => {
    const last = i === a.length - 1;
    const cls = (s.ok ? 'have' : 'new') + (s.strong ? ' strong' : '') + (last && o.warn ? ' warn' : '');
    h += sep + `<span class="pl-s ${cls}" title="${esc(s.title || (s.ok ? t('bm.pathHave') : t('bm.pathNew')))}"><span>${esc(s.name)}</span></span>`;
  });
  if (o.chips && o.chips.length) h += `<span class="pl-chips">${o.chips.map(([k, n]) => `<span class="pl-c"><b>${esc(k)}</b>${esc(n)}</span>`).join('')}</span>`;
  return `<div class="pl">${h}</div>`;
}

// Строка под выбором своей папки сохранения: «папка · есть / создам». Меняет только свой блок host (id), пустая папка — блок пуст.
// Проверка у сервера (/api/dir-check) с задержкой, чтобы не спрашивать на каждую букву; устаревший ответ отбрасывается.
const plDirT = {};
function plDir(id, dir) {
  const host = $(id);
  if (!host) return;
  dir = (dir || '').trim();
  host.dataset.want = dir;
  clearTimeout(plDirT[id]);
  if (!dir) { host.innerHTML = ''; return; }
  plDirT[id] = setTimeout(async () => {
    const r = await api('dir-check', {path: dir});
    if (host.dataset.want !== dir || !r) return;
    const st = r.exists ? 'have' : 'new';
    const h = `<div class="pl"><span class="pl-s root" title="${esc(dir)}">${PL_DIR}<span>${esc(plShort(dir))}</span></span>` +
      `<span class="pl-s ${st}"><span>${t(r.exists ? 'bm.pathHave' : 'bm.pathNew')}</span></span></div>`;
    if (host.innerHTML !== h) host.innerHTML = h;
  }, 250);
}
