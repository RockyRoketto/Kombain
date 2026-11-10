// ---------- инструмент «Текст»: клип с картинкой, которую рисует сама страница ----------
// Настройки лежат в поле клипа text и не меняются на месте: копии клипа делят один объект. PNG можно нарисовать заново в любой момент,
// поэтому файл лежит в кэше, а проект хранит только настройки. Для движка это обычный слой-картинка: просмотр и результат совпадают.
const MT_TEXT_SCALE = 2;   // запас резкости, если рамку растянут
const MT_RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;

// Перенос по словам. Слово шире области остаётся целым и обрежется краем картинки.
function mtTextWrap(g, para, width) {
  const out = [];
  let cur = '';
  for (const word of para.split(/\s+/).filter(Boolean)) {
    const next = cur ? cur + ' ' + word : word;
    if (cur && g.measureText(next).width > width) { out.push(cur); cur = word; } else cur = next;
  }
  out.push(cur);
  return out;
}
// box — область текста в пикселях холста: картинка получает её размер, строки переносятся по ширине, текст стоит по центру высоты.
// Без box картинка по размеру текста, строки только из Enter.
function mtTextDraw(x, H, box) {
  const cv = document.createElement('canvas'), k = MT_TEXT_SCALE, px = x.size * H * k, sw = x.stroke * px, see = cpSee(x.color);
  const font = `${x.italic ? 'italic ' : ''}${x.bold ? 'bold ' : ''}${px}px "${x.font}"`;
  let g = cv.getContext('2d');
  g.font = font;
  const pad = Math.ceil(px * .1 + sw), areaW = box ? Math.max(Math.ceil(box.w * k), 2) : 0;
  const lines = (x.s || ' ').split('\n').flatMap(l => box ? mtTextWrap(g, l, areaW - pad * 2) : [l]), wide = Math.max(...lines.map(l => g.measureText(l || ' ').width));
  const m = g.measureText('Ag'), asc = m.fontBoundingBoxAscent || px, line = asc + (m.fontBoundingBoxDescent || px * .25);
  cv.width = box ? areaW : Math.max(Math.ceil(wide + pad * 2), 2);
  cv.height = box ? Math.max(Math.ceil(box.h * k), 2) : Math.max(Math.ceil(line * lines.length + pad * 2), 2);
  const top = box ? (cv.height - line * lines.length) / 2 : pad;
  g = cv.getContext('2d');   // смена размера сбрасывает настройки
  g.font = font;
  g.lineJoin = 'round';
  g.textBaseline = 'alphabetic';
  lines.forEach((l, i) => {
    const y = top + asc + i * line, rtl = MT_RTL.test(l);
    g.direction = rtl ? 'rtl' : 'ltr';
    g.textAlign = x.align;
    const at = x.align === 'left' ? pad : x.align === 'right' ? cv.width - pad : cv.width / 2;
    if (sw > 0) {
      g.strokeStyle = cpStyle(g, x.strokeColor, cv.width, cv.height); g.lineWidth = sw * 2; g.strokeText(l, at, y);
      // полупрозрачная заливка: под ней обводки нет, видно то, что под текстом
      if (see) { g.globalCompositeOperation = 'destination-out'; g.fillStyle = '#000'; g.fillText(l, at, y); g.globalCompositeOperation = 'source-over'; }
    }
    g.fillStyle = cpStyle(g, x.color, cv.width, cv.height);   // градиент в долях всей картинки (рамки слоя)
    g.fillText(l, at, y);
  });
  return {cv, w: cv.width / k, h: cv.height / k};
}
// картинка на диске, размер в долях холста
async function mtTextMake(x, c) {
  const d = mvCanvasDims();
  try { await document.fonts.load(`${x.size * 100}px "${x.font}"`); } catch (e) {}
  const pic = mtTextDraw(x, d.h, x.box && c && c.w > 0 ? {w: c.w * d.w, h: c.h * d.h} : null);
  const r = await api('text-png', {data: pic.cv.toDataURL('image/png').split(',')[1]});
  if (r.error) { say('err', t('mt.secText'), r.error); return null; }
  if (!mtFile(r.path)) mtKnown.set(mtKey(r.path), {name: base(r.path), dir: dirOf(r.path), path: r.path, size: 0, w: pic.cv.width, h: pic.cv.height, kind: 'p', bad: false, audio: false, reading: Promise.resolve()});
  return {path: r.path, fresh: r.fresh, w: pic.w / d.w, h: pic.h / d.h};
}
// Положить новую картинку в клип: середина и растяжение рамки остаются
const mtTextTurn = new Map();
async function mtTextRedraw(c) {
  const turn = (mtTextTurn.get(c.id) || 0) + 1, text = c.text;
  mtTextTurn.set(c.id, turn);
  const made = await mtTextMake(text, c);
  const now = tkById(c.id);
  if (!made || !now || now.text !== text || mtTextTurn.get(c.id) !== turn) return;
  if (now.path === made.path && now.w > 0) {
    if (made.fresh) {   // файл убрала чистка кэша и он появился снова: окно и дорожка могли не дождаться его
      const pic = mv.pics.get(now.id), el = tkEls.get(now.id);
      if (pic) delete pic.dataset.url;
      if (el) delete el.dataset.sig;
      tkChanged();
    }
    return;
  }
  if (text.box && now.w > 0) {   // рамку задаёт пользователь, картинка её только заполняет
    Object.assign(now, {path: made.path, nw: now.w});
    tkChanged();
    return;
  }
  const k = now.nw > 0 && now.w > 0 ? now.w / now.nw : 1;
  const cx = now.w > 0 ? now.x + now.w / 2 : .5, cy = now.w > 0 ? now.y + now.h / 2 : .5, w = made.w * k, h = made.h * k;
  Object.assign(now, {path: made.path, nw: made.w, w, h, x: cx - w / 2, y: cy - h / 2});
  tkChanged();
}
// Первая правка рамки делает её областью текста. Растянутая раньше надпись остаётся того же размера: растяжение переходит в шрифт.
function mtTextBoxed(c) {
  const k = c.nw > 0 && c.w > 0 ? c.w / c.nw : 1;
  c.text = {...c.text, box: true, size: mtRnd(c.text.size * k, 4)};
}
// Рамка меняется: новая картинка не чаще, чем раз в 100 мс, последняя обязательно. Новый объект text отменяет запоздавшие картинки.
let mtTextBoxTimer = 0;
function mtTextBoxMove(c) {
  c.text = {...c.text};
  if (mtTextBoxTimer) return;
  mtTextBoxTimer = setTimeout(() => { mtTextBoxTimer = 0; const now = tkById(c.id); if (now && now.text) mtTextRedraw(now); }, 100);
}
// после открытия проекта и отмены файлов может не быть, а значения клипа могли стать другими
function mtTextRefresh() { tkClips().filter(c => c.text).forEach(mtTextRedraw); if (mtShapesReady) mtShapeRefresh(); }   // фигуры так же (shapes.js)

function mtTextPatch(patch) {
  const c = tkOne();
  if (!c || !c.text) return;
  c.text = {...c.text, ...patch};
  mtTextRedraw(c);
}
function mtTextFill() {
  const c = tkOne(), x = c && c.text;
  $('mtTextBox').classList.toggle('hide', !x);
  if (!x) return;
  if (document.activeElement !== $('mtTextS')) $('mtTextS').value = x.s;
  mtFontPut($('mtTextFont'), x.font);
  mtVal('mtTextSize', mtRnd(x.size * 100, 1));
  mtVal('mtTextStroke', mtRnd(x.stroke * 100, 1));
  $('mtTextColor').value = x.color;
  $('mtTextStrokeColor').value = x.strokeColor;
  $('mtTextBold').classList.toggle('on', x.bold);
  $('mtTextItalic').classList.toggle('on', x.italic);
  $('mtTextAlign').value = x.align;
}
// Текст печатают: картинка обновляется на ходу, а отмена шагает на весь ввод сразу
let mtTextBefore = null, mtTextTimer = 0;
$('mtTextS').addEventListener('focus', () => { mtTextBefore = tkState(); });
$('mtTextS').addEventListener('input', () => {
  clearTimeout(mtTextTimer);
  mtTextTimer = setTimeout(() => mtTextPatch({s: $('mtTextS').value}), 120);
});
$('mtTextS').addEventListener('blur', () => {
  clearTimeout(mtTextTimer);
  const c = tkOne();
  if (c && c.text && c.text.s !== $('mtTextS').value) mtTextPatch({s: $('mtTextS').value});
  if (mtTextBefore !== null) tkCommit(mtTextBefore);
  mtTextBefore = null;
});
const mtTextDo = patch => tkDo(() => mtTextPatch(patch));
$('mtTextFont').addEventListener('change', () => { $('mtTextFont').blur(); mtTextDo({font: $('mtTextFont').value}); });
$('mtTextAlign').addEventListener('change', () => { $('mtTextAlign').blur(); mtTextDo({align: $('mtTextAlign').value}); });
mtColor('mtTextColor', v => mtTextPatch({color: v}), true, true);
mtColor('mtTextStrokeColor', v => mtTextPatch({strokeColor: v}), true, true);
$('mtTextBold').onclick = () => { const c = tkOne(); if (c && c.text) mtTextDo({bold: !c.text.bold}); };
$('mtTextItalic').onclick = () => { const c = tkOne(); if (c && c.text) mtTextDo({italic: !c.text.italic}); };
mtRow('mtTextSize', .1, v => mtTextPatch({size: mtRnd(Math.min(Math.max(v, 1), 50) / 100, 4)}));
mtRow('mtTextStroke', .05, v => mtTextPatch({stroke: mtRnd(Math.min(Math.max(v, 0), 30) / 100, 4)}));

// Инструмент «Текст»: кнопка или T включает режим, щелчок в кадре ставит туда надпись. Esc и повторное нажатие отменяют.
// Над самой кнопкой курсор обычный, курсор T только над вьюпортом в режиме.
let mtTextOn = false;
function mtTextTool(on) {
  if (on === mtTextOn) return;
  mtTextOn = on;
  if (on) { mtShapeTool(false); mtPenTool(false); mtPtsTool(false); mvFileOff(); if (chromaPicking()) { chromaPickToggle(); mtFramePanel(); } }
  mvStage.classList.toggle('mv-texting', on);
  $('mtText').classList.toggle('on', on);
}
$('mtText').onclick = () => mtTextTool(!mtTextOn);
// перехват раньше обработчиков вьюпорта: нажатие не выбирает и не двигает слой
$('mtStage').addEventListener('pointerdown', e => {
  if (!mtTextOn || e.button !== 0 || mvHand) return;   // с зажатым пробелом нажатие двигает вид (viewzoom.js)
  e.preventDefault();
  e.stopImmediatePropagation();   // выбор слоя висит на том же элементе
  mtTextTool(false);
  const r = mvCv.getBoundingClientRect(), in01 = v => Math.min(Math.max(v, 0), 1);
  mtTextAdd(in01((e.clientX - r.left) / r.width), in01((e.clientY - r.top) / r.height));
}, true);

// Новый текст серединой в точку (fx, fy) в долях кадра, целиком в кадре, если влезает. С текущего места, на верхней дорожке; если там занято, на новой.
const mtTextAdd = (fx, fy) => dialog(async () => {
  const x = {...MT_TEXT_DEF, s: t('mt.textDefault')}, made = await mtTextMake(x);
  if (!made) return;
  const put = (p, s) => s < 1 ? Math.min(Math.max(p - s / 2, 0), 1 - s) : p - s / 2;
  const at = tkAt, v = tkTracks.filter(tr => tr.kind === 'v'), top = v[v.length - 1];
  const busy = top.off || top.clips.some(c => c.at < at + TK_PHOTO && tkEnd(c) > at), alone = !tkCanvas && !tkClips().some(c => !c.text), dims = mvCanvasDims();
  tkDo(() => {
    if (alone) tkCanvas = {w: dims.w, h: dims.h};   // иначе холст взял бы размер самой надписи
    let row = top;
    if (busy) { row = {kind: 'v', thin: false, clips: []}; tkTracks.splice(v.length, 0, row); }
    const c = {id: tkNext++, path: made.path, at, from: 0, len: TK_PHOTO, speed: 1, reverse: false, src: 0, text: x, nw: made.w, x: put(fx, made.w), y: put(fy, made.h), w: made.w, h: made.h};
    row.clips.push(c);
    tkSel = new Set([c.id]);
  });
  mtTab = 'frame';
  mtTabs();
  document.querySelector('details[data-sec=text]').open = true;
  $('mtTextS').focus();
  $('mtTextS').select();
});

// ---------- шрифты Windows: для текста и для субтитров ----------
let mtFontList = [];
// Название показано своим шрифтом. В значковых шрифтах вместо букв рисунки, название было бы не прочитать.
const MT_FONT_ICONS = /^(wingdings|webdings|symbol|marlett|ms outlook|bookshelf symbol|mt extra)/i;
function mtFontOpt(font) {
  const o = new Option(font, font);
  if (!MT_FONT_ICONS.test(font)) o.style.fontFamily = `"${font}"`;
  return o;
}
function mtFontPut(sel, font) {
  // шрифта с другого компьютера может не быть в списке: значение всё равно показать
  if (![...sel.options].some(o => o.value === font)) sel.add(mtFontOpt(font));
  sel.value = font;
}
async function mtFontsLoad() {
  const r = await api('fonts');
  mtFontList = r.fonts && r.fonts.length ? r.fonts : ['Arial', 'Segoe UI', 'Tahoma', 'Verdana', 'Times New Roman', 'Georgia', 'Impact'];
  [$('mtTextFont'), $('mtSubsFont')].forEach(sel => { const keep = sel.value; sel.replaceChildren(...mtFontList.map(mtFontOpt)); if (keep) mtFontPut(sel, keep); });
  mtPanel();
}
mtFontsLoad();
