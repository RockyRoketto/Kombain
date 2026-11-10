// ---------- вкладка «Утилиты»: генератор фавиконов ----------
// Все размеры рисует canvas прямо здесь (SVG тоже), Go только собирает favicon.ico и ZIP (favicon.go).
// Предпросмотры показывают те же картинки, что уйдут в архив.
// Настройки и сами иконки помнит localStorage: konv9000.fav и konv9000.favImg.
const FV_KEY = 'konv9000.fav', FV_IMG_KEY = 'konv9000.favImg';
const FV_DEF = {
  br: {on: false, color: '#ffffff', colorDark: '#1f1f23', radius: 22, pad: 8},   // вкладка браузера, Google, favicon.ico и .svg
  ios: {color: '#ffffff', pad: 10, name: ''},                                     // apple-touch-icon: iOS заливает прозрачное чёрным
  and: {on: true, color: '#ffffff', pad: 12, theme: '#ffffff', name: '', short: ''},   // манифест; с подложкой иконка «maskable»
  path: '/',
};
let fv = JSON.parse(JSON.stringify(FV_DEF));
const fvImg = {light: null, dark: null};   // {name, src (data URL), svg (текст или ''), img, w, h}
let fvOut = null;                           // последние готовые картинки: имя → canvas

function fvLoadState() {
  try {
    const o = JSON.parse(localStorage.getItem(FV_KEY) || '{}');
    for (const k of ['br', 'ios', 'and']) if (o[k] && typeof o[k] === 'object') {
      for (const [f, d] of Object.entries(FV_DEF[k])) if (typeof o[k][f] === typeof d) fv[k][f] = o[k][f];
    }
    if (typeof o.path === 'string') fv.path = o.path;
  } catch (e) {}
}
const fvSaveState = () => { try { localStorage.setItem(FV_KEY, JSON.stringify(fv)); } catch (e) {} };
function fvSaveImgs() {
  const o = {};
  for (const k of ['light', 'dark']) if (fvImg[k]) o[k] = {name: fvImg[k].name, src: fvImg[k].src, svg: fvImg[k].svg};
  try { localStorage.setItem(FV_IMG_KEY, JSON.stringify(o)); }
  catch (e) { try { localStorage.removeItem(FV_IMG_KEY); } catch (e2) {} }   // не влезло: просто не запомним
}

// у SVG без width и height браузер не знает размер: ставим из viewBox, иначе картинка выйдет 300×150
function fvSvgSized(text) {
  try {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml'), s = doc.documentElement;
    if (s.nodeName !== 'svg' || doc.querySelector('parsererror')) return null;
    const vb = (s.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
    const w0 = parseFloat(s.getAttribute('width')), h0 = parseFloat(s.getAttribute('height'));
    let w = vb.length === 4 && vb[2] > 0 ? vb[2] : w0 || 512, h = vb.length === 4 && vb[3] > 0 ? vb[3] : h0 || 512;
    if (!s.getAttribute('viewBox')) s.setAttribute('viewBox', `0 0 ${w0 || w} ${h0 || h}`);
    const k = 1024 / Math.max(w, h);   // крупно: так Chromium растрирует чётко
    s.setAttribute('width', Math.round(w * k)); s.setAttribute('height', Math.round(h * k));
    return new XMLSerializer().serializeToString(s);
  } catch (e) { return null; }
}
const fvB64 = s => btoa(unescape(encodeURIComponent(s)));
const fvImgLoad = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });

// принять файл: kind — 'light' или 'dark'
async function fvTake(file, kind) {
  if (!file) return;
  const isSvg = /\.svg$/i.test(file.name) || file.type === 'image/svg+xml';
  if (!isSvg && !/^image\/(png|jpeg|webp|gif|bmp)$/.test(file.type) && !/\.(png|jpe?g|webp)$/i.test(file.name)) {
    say('warn', t('drop.notSuitableTitle'), t('fv.badType')); return;
  }
  try {
    let src, svg = '';
    if (isSvg) {
      svg = fvSvgSized(await file.text());
      if (!svg) throw new Error('svg');
      src = 'data:image/svg+xml;base64,' + fvB64(svg);
    } else {
      src = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
    }
    await fvSet(kind, {name: file.name, src, svg});
    fvSaveImgs();
  } catch (e) { toast({type: 'warn', title: t('drop.notSuitableTitle'), text: t('fv.badFile', {name: esc(file.name)}), ttl: 7000}); }
}
async function fvSet(kind, it) {
  const img = await fvImgLoad(it.src);
  fvImg[kind] = Object.assign(it, {img, w: img.naturalWidth, h: img.naturalHeight});
  fvRender();
}

// картинка size×size: подложка (цвет, скругление в % от половины стороны), иконка с отступом (% от стороны) по центру
function fvDraw(it, size, o = {}) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  if (o.bg) {
    g.fillStyle = o.bg;
    g.beginPath(); g.roundRect(0, 0, size, size, (o.radius || 0) / 100 * size / 2); g.fill();
  }
  if (!it) return c;
  const box = size * (1 - 2 * (o.pad || 0) / 100), k = Math.min(box / it.w, box / it.h);
  const w = it.w * k, h = it.h * k;
  let src = it.img, sw = it.w, sh = it.h;
  // большую растровую картинку уменьшаем по полшага: так мелкие размеры не рябят
  if (!it.svg) while (sw / 2 >= w * 1.2) {
    const s = document.createElement('canvas');
    s.width = Math.ceil(sw / 2); s.height = Math.ceil(sh / 2);
    const sg = s.getContext('2d'); sg.imageSmoothingQuality = 'high';
    sg.drawImage(src, 0, 0, s.width, s.height);
    src = s; sw = s.width; sh = s.height;
  }
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, (size - w) / 2, (size - h) / 2, w, h);
  return c;
}

const fvBrOpt = dark => fv.br.on ? {bg: dark ? fv.br.colorDark : fv.br.color, radius: fv.br.radius, pad: fv.br.pad} : {};
const fvIosOpt = () => ({bg: fv.ios.color, pad: fv.ios.pad});
const fvAndOpt = () => fv.and.on ? {bg: fv.and.color, pad: fv.and.pad} : {};
const fvPath = () => { let p = (fv.path || '/').trim().replace(/\\/g, '/'); if (!p.startsWith('/') && !/^https?:/i.test(p)) p = '/' + p; return p.endsWith('/') ? p : p + '/'; };
const fvName = () => fv.and.name.trim() || fv.ios.name.trim() || (fvImg.light ? fvImg.light.name.replace(/\.[^.]+$/, '') : '');
const fvEscAttr = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// favicon.svg: обёртка, в которой светлая и тёмная версии переключаются по теме браузера.
// Исходный SVG вкладывается как есть (остаётся векторным), растровый — PNG 256.
function fvSvg() {
  const L = fvImg.light, D = fvImg.dark;
  if (L.svg && !D && !fv.br.on) return L.svg;
  const part = (it, dark, cls) => {
    const o = fvBrOpt(dark);
    let s = o.bg ? `<rect width="256" height="256" rx="${(o.radius / 100 * 128).toFixed(1)}" fill="${o.bg}"/>` : '';
    const pad = (o.pad || 0) / 100 * 256, box = 256 - 2 * pad;
    const href = it.svg ? 'data:image/svg+xml;base64,' + fvB64(it.svg) : fvDraw(it, 256).toDataURL('image/png');
    s += `<image x="${pad.toFixed(1)}" y="${pad.toFixed(1)}" width="${box.toFixed(1)}" height="${box.toFixed(1)}" preserveAspectRatio="xMidYMid meet" href="${href}"/>`;
    return cls ? `<g class="${cls}">${s}</g>` : s;
  };
  const twin = D || fv.br.on && fv.br.colorDark !== fv.br.color;
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">' +
    (twin ? '<style>.d{display:none}@media (prefers-color-scheme:dark){.l{display:none}.d{display:inline}}<\/style>' +   // <\/ — чтобы проверка страницы не приняла строку за конец блока
      part(L, false, 'l') + part(D || L, true, 'd') : part(L, false, '')) + '</svg>';
}

function fvManifest() {
  const p = fvPath(), purpose = fv.and.on ? 'maskable' : 'any';
  return JSON.stringify({
    name: fv.and.name.trim() || fvName(), short_name: fv.and.short.trim() || fv.and.name.trim() || fvName(),
    icons: [192, 512].map(n => ({src: `${p}web-app-manifest-${n}x${n}.png`, sizes: `${n}x${n}`, type: 'image/png', purpose})),
    theme_color: fv.and.theme, background_color: fv.and.on ? fv.and.color : '#ffffff', display: 'standalone',
  }, null, 2) + '\n';
}

function fvHtml() {
  const p = fvPath(), title = fv.ios.name.trim();
  return [
    `<link rel="icon" type="image/png" href="${p}favicon-96x96.png" sizes="96x96">`,
    `<link rel="icon" type="image/svg+xml" href="${p}favicon.svg">`,
    `<link rel="shortcut icon" href="${p}favicon.ico">`,
    `<link rel="apple-touch-icon" sizes="180x180" href="${p}apple-touch-icon.png">`,
    title ? `<meta name="apple-mobile-web-app-title" content="${fvEscAttr(title)}">` : '',
    `<link rel="manifest" href="${p}site.webmanifest">`,
    `<meta name="theme-color" content="${fv.and.theme}">`,
  ].filter(Boolean).join('\n');
}

// ---------- отрисовка вкладки ----------
let fvRaf = 0;
const fvRender = () => { if (!fvRaf) fvRaf = requestAnimationFrame(() => { fvRaf = 0; fvPaint(); }); };
function fvPaint() {
  const L = fvImg.light, D = fvImg.dark;
  for (const k of ['light', 'dark']) {
    const el = $(k === 'light' ? 'fvSlotLight' : 'fvSlotDark'), it = fvImg[k];
    el.classList.toggle('has', !!it);
    el.querySelector('img').src = it ? it.src : '';
    el.querySelector('.x').classList.toggle('hide', !it);
  }
  $('fvEmpty').classList.toggle('hide', !!L);
  $('fvMocks').classList.toggle('hide', !L);
  $('fvSave').disabled = !L;
  $('fvInfo').textContent = L ? `${L.name} · ${L.svg ? 'SVG' : L.w + '×' + L.h}` : '';
  // предупреждения: мелкая или не квадратная картинка
  const warn = [];
  for (const it of [L, D]) if (it) {
    if (!it.svg && Math.min(it.w, it.h) < 512) warn.push(t('fv.small', {name: esc(it.name), w: it.w, h: it.h}));
    if (Math.abs(it.w - it.h) > Math.max(it.w, it.h) * .02) warn.push(t('fv.notSquare', {name: esc(it.name)}));
  }
  $('fvWarn').innerHTML = warn.join('<br>');
  $('fvWarn').classList.toggle('hide', !warn.length);
  // поля
  $('fvBrOpts').classList.toggle('off', !fv.br.on);
  $('fvBrDarkRow').classList.toggle('hide', !D);
  $('fvAndOpts').classList.toggle('off', !fv.and.on);
  for (const [id, v] of [['fvBrRadius', fv.br.radius], ['fvBrPad', fv.br.pad], ['fvIosPad', fv.ios.pad], ['fvAndPad', fv.and.pad]]) $(id + 'V').textContent = v + ' %';
  if (!L) { fvOut = null; return; }
  // картинки
  const out = {
    tab: fvDraw(L, 32, fvBrOpt(false)), tabDark: fvDraw(D || L, 32, fvBrOpt(true)),
    serp: fvDraw(L, 96, fvBrOpt(false)),
    ios: fvDraw(L, 180, fvIosOpt()), and: fvDraw(L, 192, fvAndOpt()), splash: fvDraw(L, 512, fvAndOpt()),
  };
  fvOut = out;
  document.querySelectorAll('#fvMocks img[data-fv]').forEach(im => { im.src = out[im.dataset.fv].toDataURL(); });
  $('fvMocks').querySelector('.fv-m-and .me').classList.toggle('mask', fv.and.on);
  $('fvSplash').style.background = fv.and.on ? fv.and.color : '#ffffff';
  $('fvSplash').style.color = fvLight(fv.and.on ? fv.and.color : '#ffffff') ? '#1d1c1a' : '#f3f3f4';
  const name = fvName() || t('fv.site');
  document.querySelectorAll('#fvMocks [data-fv-name]').forEach(el => { el.textContent = name; });
  document.querySelectorAll('#fvMocks [data-fv-url]').forEach(el => { el.textContent = 'https://example.com'; });
  document.querySelectorAll('#fvMocks [data-fv-ios]').forEach(el => { el.textContent = fv.ios.name.trim() || name; });
  document.querySelectorAll('#fvMocks [data-fv-short]').forEach(el => { el.textContent = fv.and.short.trim() || fv.and.name.trim() || name; });
  document.querySelectorAll('#fvMocks [data-fv-full]').forEach(el => { el.textContent = fv.and.name.trim() || name; });
  const code = fvHtml();
  if ($('fvCode').textContent !== code) $('fvCode').textContent = code;
}
const fvLight = hex => { const c = cpParse(hex) || {r: 255, g: 255, b: 255}; return .299 * c.r + .587 * c.g + .114 * c.b > 150; };

// поля → состояние
function fvFields() {
  $('fvBrOn').checked = fv.br.on; $('fvAndOn').checked = fv.and.on;
  $('fvBrRadius').value = fv.br.radius; $('fvBrPad').value = fv.br.pad; $('fvIosPad').value = fv.ios.pad; $('fvAndPad').value = fv.and.pad;
  $('fvIosName').value = fv.ios.name; $('fvAndName').value = fv.and.name; $('fvAndShort').value = fv.and.short; $('fvPath').value = fv.path;
  for (const [id, o, k] of FV_COLORS) $(id).value = o()[k];
}
const FV_COLORS = [['fvBrColor', () => fv.br, 'color'], ['fvBrColorDark', () => fv.br, 'colorDark'], ['fvIosColor', () => fv.ios, 'color'],
  ['fvAndColor', () => fv.and, 'color'], ['fvAndTheme', () => fv.and, 'theme']];
const fvChanged = () => { fvSaveState(); fvRender(); };
for (const [id, o, k] of FV_COLORS) {
  let was;
  cpField($(id), {
    live: v => { if (was === undefined) was = o()[k]; o()[k] = v; fvRender(); },
    done: ok => { if (!ok && was !== undefined) o()[k] = was; else o()[k] = $(id).value; was = undefined; fvChanged(); },
  });
}
for (const [id, o, k] of [['fvBrOn', () => fv.br, 'on'], ['fvAndOn', () => fv.and, 'on']]) $(id).addEventListener('change', () => { o()[k] = $(id).checked; fvChanged(); });
for (const [id, o, k] of [['fvBrRadius', () => fv.br, 'radius'], ['fvBrPad', () => fv.br, 'pad'], ['fvIosPad', () => fv.ios, 'pad'], ['fvAndPad', () => fv.and, 'pad']]) {
  $(id).addEventListener('input', () => { o()[k] = +$(id).value; fvRender(); });
  $(id).addEventListener('change', fvSaveState);
}
for (const [id, o, k] of [['fvIosName', () => fv.ios, 'name'], ['fvAndName', () => fv.and, 'name'], ['fvAndShort', () => fv.and, 'short'], ['fvPath', () => fv, 'path']]) {
  $(id).addEventListener('input', () => { o()[k] = $(id).value; fvChanged(); });
}

// выбор файла: щелчок по ячейке или кнопка «Выбрать иконку»
let fvPickKind = 'light';
const fvPick = kind => { fvPickKind = kind; $('fvFile').value = ''; $('fvFile').click(); };
$('fvFile').addEventListener('change', () => fvTake($('fvFile').files[0], fvPickKind));
$('fvPick').onclick = () => fvPick('light');
for (const id of ['fvSlotLight', 'fvSlotDark']) {
  const el = $(id), kind = el.dataset.slot;
  el.addEventListener('click', e => {
    if (e.target.closest('.x')) { fvImg[kind] = null; fvSaveImgs(); fvRender(); return; }
    fvPick(kind);
  });
  el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fvPick(kind); } });
}
// перетаскивание (вызывает drop.js): на ячейку тёмной — в неё; два файла — светлая и тёмная
function fvDrop(e) {
  const list = [...(e.dataTransfer.files || [])];
  if (!list.length) return;
  const onDark = e.target.closest && e.target.closest('#fvSlotDark');
  if (onDark) { fvTake(list[0], 'dark'); return; }
  fvTake(list[0], 'light');
  if (list[1]) fvTake(list[1], 'dark');
}
$('fvCopy').onclick = async () => {
  try { await navigator.clipboard.writeText(fvHtml()); toast({type: 'ok', title: t('fv.copied'), ttl: 2500}); }
  catch (e) { say('warn', t('warn.title'), t('fv.copyFail')); }
};

// ---------- сохранение ----------
const fvPng = c => c.toDataURL('image/png').split(',')[1];
const fvText = s => fvB64(s);
$('fvSave').onclick = () => dialog(async () => {
  const L = fvImg.light;
  if (!L) return;
  const files = [
    {name: 'favicon-96x96.png', data: fvPng(fvDraw(L, 96, fvBrOpt(false)))},
    {name: 'favicon.svg', data: fvText(fvSvg())},
    {name: 'apple-touch-icon.png', data: fvPng(fvDraw(L, 180, fvIosOpt()))},
    {name: 'web-app-manifest-192x192.png', data: fvPng(fvDraw(L, 192, fvAndOpt()))},
    {name: 'web-app-manifest-512x512.png', data: fvPng(fvDraw(L, 512, fvAndOpt()))},
    {name: 'site.webmanifest', data: fvText(fvManifest())},
    {name: 'head.html', data: fvText(fvHtml() + '\n')},
  ];
  const ico = [16, 32, 48].map(n => fvPng(fvDraw(L, n, fvBrOpt(false))));
  const r = await api('favicon-save', {files, ico});
  if (r.error) { say('err', t('fv.saveFail'), r.error); return; }
  if (!r.path) return;   // передумали
  toast({id: 'done', type: 'ok', title: t('fv.saved'), text: esc(r.path), ttl: 12000,
    actions: [{t: t('fv.openDir'), primary: true, keep: true, fn: async () => { const x = await api('open-dir', {path: dirOf(r.path)}); if (x.error) say('warn', t('folder.title'), x.error); }}]});
});

// ---------- запуск ----------
fvLoadState();
fvFields();
(async () => {
  try {
    const o = JSON.parse(localStorage.getItem(FV_IMG_KEY) || '{}');
    for (const k of ['light', 'dark']) if (o[k] && typeof o[k].src === 'string' && o[k].src.startsWith('data:image/')) {
      try { await fvSet(k, {name: String(o[k].name || 'icon'), src: o[k].src, svg: typeof o[k].svg === 'string' ? o[k].svg : ''}); } catch (e) {}
    }
  } catch (e) {}
  fvRender();
})();
