// ---------- инструмент «Текст»: клип с картинкой, которую рисует сама страница ----------
// Настройки лежат в поле клипа text и не меняются на месте: копии клипа делят один объект. PNG можно нарисовать заново в любой момент,
// поэтому файл лежит в кэше, а проект хранит только настройки. Для движка это обычный слой-картинка: просмотр и результат совпадают.
const MT_TEXT_SCALE = 2;   // запас резкости, если рамку растянут
const MT_RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;

function mtTextDraw(x, H) {
  const cv = document.createElement('canvas'), k = MT_TEXT_SCALE, px = x.size * H * k, sw = x.stroke * px;
  const font = `${x.italic ? 'italic ' : ''}${x.bold ? 'bold ' : ''}${px}px "${x.font}"`;
  let g = cv.getContext('2d');
  g.font = font;
  const lines = (x.s || ' ').split('\n'), wide = Math.max(...lines.map(l => g.measureText(l || ' ').width));
  const m = g.measureText('Ag'), asc = m.fontBoundingBoxAscent || px, line = asc + (m.fontBoundingBoxDescent || px * .25), pad = Math.ceil(px * .1 + sw);
  cv.width = Math.max(Math.ceil(wide + pad * 2), 2);
  cv.height = Math.max(Math.ceil(line * lines.length + pad * 2), 2);
  g = cv.getContext('2d');   // смена размера сбрасывает настройки
  g.font = font;
  g.lineJoin = 'round';
  g.textBaseline = 'alphabetic';
  lines.forEach((l, i) => {
    const y = pad + asc + i * line, rtl = MT_RTL.test(l);
    g.direction = rtl ? 'rtl' : 'ltr';
    g.textAlign = x.align;
    const at = x.align === 'left' ? pad : x.align === 'right' ? cv.width - pad : cv.width / 2;
    if (sw > 0) { g.strokeStyle = x.strokeColor; g.lineWidth = sw * 2; g.strokeText(l, at, y); }
    g.fillStyle = x.color;
    g.fillText(l, at, y);
  });
  return {cv, w: cv.width / k, h: cv.height / k};
}
// картинка на диске, размер в долях холста
async function mtTextMake(x) {
  const d = mvCanvasDims();
  try { await document.fonts.load(`${x.size * 100}px "${x.font}"`); } catch (e) {}
  const pic = mtTextDraw(x, d.h);
  const r = await api('text-png', {data: pic.cv.toDataURL('image/png').split(',')[1]});
  if (r.error) { say('err', t('mt.secText'), r.error); return null; }
  if (!mtFile(r.path)) mtKnown.set(mtKey(r.path), {name: base(r.path), dir: dirOf(r.path), path: r.path, size: 0, w: pic.cv.width, h: pic.cv.height, kind: 'p', bad: false, audio: false, reading: Promise.resolve()});
  return {path: r.path, w: pic.w / d.w, h: pic.h / d.h};
}
// Положить новую картинку в клип: середина и растяжение рамки остаются
const mtTextTurn = new Map();
async function mtTextRedraw(c) {
  const turn = (mtTextTurn.get(c.id) || 0) + 1, text = c.text;
  mtTextTurn.set(c.id, turn);
  const made = await mtTextMake(text);
  const now = tkById(c.id);
  if (!made || !now || now.text !== text || mtTextTurn.get(c.id) !== turn) return;
  if (now.path === made.path && now.w > 0) return;
  const k = now.nw > 0 && now.w > 0 ? now.w / now.nw : 1;
  const cx = now.w > 0 ? now.x + now.w / 2 : .5, cy = now.w > 0 ? now.y + now.h / 2 : .5, w = made.w * k, h = made.h * k;
  Object.assign(now, {path: made.path, nw: made.w, w, h, x: cx - w / 2, y: cy - h / 2});
  tkChanged();
}
// после открытия проекта и отмены файлов может не быть, а значения клипа могли стать другими
function mtTextRefresh() { tkClips().filter(c => c.text).forEach(mtTextRedraw); }

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
$('mtTextColor').addEventListener('change', () => mtTextDo({color: $('mtTextColor').value}));
$('mtTextStrokeColor').addEventListener('change', () => mtTextDo({strokeColor: $('mtTextStrokeColor').value}));
$('mtTextBold').onclick = () => { const c = tkOne(); if (c && c.text) mtTextDo({bold: !c.text.bold}); };
$('mtTextItalic').onclick = () => { const c = tkOne(); if (c && c.text) mtTextDo({italic: !c.text.italic}); };
mtRow('mtTextSize', .1, v => mtTextPatch({size: mtRnd(Math.min(Math.max(v, 1), 50) / 100, 4)}));
mtRow('mtTextStroke', .05, v => mtTextPatch({stroke: mtRnd(Math.min(Math.max(v, 0), 30) / 100, 4)}));

// Новый текст: с текущего места, на верхней дорожке; если там занято, на новой
$('mtText').onclick = () => dialog(async () => {
  const x = {...MT_TEXT_DEF, s: t('mt.textDefault')}, made = await mtTextMake(x);
  if (!made) return;
  const at = tkAt, v = tkTracks.filter(tr => tr.kind === 'v'), top = v[v.length - 1];
  const busy = top.off || top.clips.some(c => c.at < at + TK_PHOTO && tkEnd(c) > at), alone = !tkCanvas && !tkClips().some(c => !c.text), dims = mvCanvasDims();
  tkDo(() => {
    if (alone) tkCanvas = {w: dims.w, h: dims.h};   // иначе холст взял бы размер самой надписи
    let row = top;
    if (busy) { row = {kind: 'v', thin: false, clips: []}; tkTracks.splice(v.length, 0, row); }
    const c = {id: tkNext++, path: made.path, at, from: 0, len: TK_PHOTO, speed: 1, reverse: false, src: 0, text: x, nw: made.w, x: .5 - made.w / 2, y: .5 - made.h / 2, w: made.w, h: made.h};
    row.clips.push(c);
    tkSel = new Set([c.id]);
  });
  mtTab = 'v';
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
