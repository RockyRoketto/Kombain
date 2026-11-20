// Сравнение «до / после» в окне просмотра галереи (gengallery.js): после «Убрать фон» и «Увеличить»
// поверх готовой картинки ложится исходная, граница — вертикальная полоска, которую можно тянуть.
const gcmp = {on: false, pos: 50, drag: false};

const gcmpBox = () => $('gnCmpBox');

// рамка сравнения ровно по картинке под ней (та же площадь, что у #gnLbImg)
function gcmpPlace() {
  if (!gcmp.on) return;
  const im = $('gnLbImg').getBoundingClientRect(), st = $('gnLbStage').getBoundingClientRect(), b = gcmpBox().style;
  if (!im.width) return;
  b.left = (im.left - st.left) + 'px'; b.top = (im.top - st.top) + 'px';
  b.width = im.width + 'px'; b.height = im.height + 'px';
  const x = $('gnCmpClose').style;
  x.left = (im.left - st.left + im.width / 2) + 'px'; x.top = Math.max(4, im.top - st.top - 38) + 'px';
}

function gcmpSet(p) {
  gcmp.pos = Math.min(100, Math.max(0, p));
  $('gnCmpBefore').style.clipPath = `inset(0 ${100 - gcmp.pos}% 0 0)`;
  $('gnCmpH').style.left = gcmp.pos + '%';
  $('gnCmpBox').classList.toggle('lo', gcmp.pos < 14);   // подпись прячется, когда ей не хватает места
  $('gnCmpBox').classList.toggle('hi', gcmp.pos > 86);
}

// gcmpOpen: before — путь исходной картинки; после неё сейчас открыта новая (ggCur)
function gcmpOpen(before) {
  const x = ggCur(); if (!x) return;
  gcmp.on = true;
  $('gnCmpBefore').src = mediaUrl(before);
  $('gnCmpAfter').src = mediaUrl(x.path);
  $('gnCmpAfter').classList.toggle('cut', !!x.meta.cutout);
  $('gnCmp').classList.remove('hide');
  $('gnLb').classList.add('cmp');
  gcmpSet(50);
  gcmpPlace();
  requestAnimationFrame(gcmpPlace);
}

function gcmpClose() {
  if (!gcmp.on) return;
  gcmp.on = gcmp.drag = false;
  $('gnCmp').classList.add('hide');
  $('gnLb').classList.remove('cmp');
  $('gnCmpBefore').removeAttribute('src'); $('gnCmpAfter').removeAttribute('src');
}

function gcmpMove(e) {
  const r = gcmpBox().getBoundingClientRect();
  if (r.width) gcmpSet((e.clientX - r.left) / r.width * 100);
}

// тянуть полоску: общее для окна галереи и окна «Утилит»; set(p) — положение в процентах
function gcmpDrag(box, set) {
  let on = false;
  const mv = e => { const r = box.getBoundingClientRect(); if (r.width) set((e.clientX - r.left) / r.width * 100); };
  box.addEventListener('pointerdown', e => { on = true; box.setPointerCapture(e.pointerId); mv(e); e.preventDefault(); });
  box.addEventListener('pointermove', e => { if (on) mv(e); });
  for (const ev of ['pointerup', 'pointercancel']) box.addEventListener(ev, () => { on = false; });
}
gcmpDrag(gcmpBox(), gcmpSet);

// ---- «Утилиты»: до / после для готового файла (кнопка в строке списка), своё окно ----
const utc = {on: false, pos: 50};
function utCmpSet(p) {
  utc.pos = Math.min(100, Math.max(0, p));
  $('utCmpBefore').style.clipPath = `inset(0 ${100 - utc.pos}% 0 0)`;
  $('utCmpH').style.left = utc.pos + '%';
  $('utCmpBox').classList.toggle('lo', utc.pos < 14);
  $('utCmpBox').classList.toggle('hi', utc.pos > 86);
}
// рамка вписывается в окно по пропорциям готовой картинки (исходная у увеличенной другого размера, но тех же пропорций)
function utCmpFit() {
  const im = $('utCmpAfter'), st = $('utCmpStage'), b = $('utCmpBox').style;
  if (!im.naturalWidth) return;
  const k = Math.min(st.clientWidth / im.naturalWidth, st.clientHeight / im.naturalHeight);
  b.width = Math.round(im.naturalWidth * k) + 'px'; b.height = Math.round(im.naturalHeight * k) + 'px';
}
function utCmpOpen(before, after, cut, name) {
  utc.on = true;
  $('utCmpT').textContent = t('ut.cmpT', {name});
  $('utCmpAfter').classList.toggle('cut', !!cut);
  $('utCmpBefore').src = mediaUrl(before);
  $('utCmpAfter').src = mediaUrl(after) + '&_=' + Date.now();
  utCmpSet(50);
  $('utCmp').classList.remove('hide');
  utCmpFit();
}
function utCmpClose() {
  utc.on = false; $('utCmp').classList.add('hide');
  $('utCmpBefore').removeAttribute('src'); $('utCmpAfter').removeAttribute('src');
}
gcmpDrag($('utCmpBox'), utCmpSet);
$('utCmpAfter').addEventListener('load', utCmpFit);
new ResizeObserver(() => { if (utc.on) utCmpFit(); }).observe($('utCmpStage'));
$('utCmpClose').addEventListener('click', utCmpClose);
$('utCmp').addEventListener('click', e => { if (e.target === $('utCmp')) utCmpClose(); });
document.addEventListener('keydown', e => {
  if (utc.on && e.key === 'Escape') { utCmpClose(); e.preventDefault(); e.stopPropagation(); }
}, true);

// подпись идущего файла «Нейросеть работает… 0:07 · 2 / 5»: время тикает прямо в строке (bgcut.js, upscale.js)
function utRunSub(it, files) {
  const n = files.filter(f => f.st === 'ok').length + 1;
  return `${esc(t('ut.working'))}… <span data-t0="${it.t0}">0:00</span> · ${n} / ${files.length}`;
}
setInterval(() => {
  for (const e of document.querySelectorAll('[data-t0]')) {
    const s = Math.max(0, Math.round((Date.now() - +e.dataset.t0) / 1000));
    e.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
}, 500);
$('gnCmpClose').addEventListener('click', gcmpClose);
$('gnLbImg').addEventListener('load', gcmpPlace);
new ResizeObserver(gcmpPlace).observe($('gnLbStage'));
