// «Перерисовать часть»: кисть-маска в окне просмотра галереи (gengallery.js).
// Маска — холст поверх картинки (до GI_MAX точек по стороне, сервер растянет её до размера картинки), закрашенное — перерисовать.
// Мазки хранятся списком, «Отменить» перерисовывает маску заново: так не нужно держать в памяти копии холста.
// Запрос «что нарисовать здесь» идёт через помощника (gen-enhance), стиль, модель и негатив — от исходной картинки.
// Сервер: geninpaint.go (вырезка вокруг выделенного, вклейка с мягким краем); задача встаёт в очередь, как «Вариации».
const GI_MAX = 2048;
const GI_INK = '#e9b872';
const gi = {
  on: false,
  x: null,          // картинка из окна просмотра
  erase: false,     // ластик вместо кисти
  strokes: [],      // {erase, w, pts: [[x, y], …]} или {clear: true}
  cur: null,        // мазок, который сейчас рисуется
};

const giCv = () => $('gnInpCv');

function giOpen() {
  const x = ggCur(), img = $('gnLbImg');
  if (!x || x.meta.cutout || !img.naturalWidth) return;
  const cv = giCv(), k = Math.min(1, GI_MAX / Math.max(img.naturalWidth, img.naturalHeight));
  cv.width = Math.round(img.naturalWidth * k);
  cv.height = Math.round(img.naturalHeight * k);
  Object.assign(gi, {on: true, x, strokes: [], cur: null});
  $('gnLb').classList.add('inp');
  cv.classList.remove('hide');
  $('gnInp').classList.remove('hide');
  $('gnLbT').textContent = t('inp.btn');
  $('gnInpText').value = '';
  giMode(false);
  giRedraw();
  giPlace();
  giNote();
}

function giClose() {
  if (!gi.on) return;
  Object.assign(gi, {on: false, x: null, strokes: [], cur: null});
  $('gnLb').classList.remove('inp');
  for (const id of ['gnInpCv', 'gnInpCur', 'gnInp']) $(id).classList.add('hide');
  if (gg.lb && !$('gnLb').classList.contains('hide')) ggLbRender();
}

// giPlace: холст ровно поверх картинки (она вписана в окно и меняется вместе с ним)
function giPlace() {
  if (!gi.on) return;
  const r = $('gnLbImg').getBoundingClientRect(), s = $('gnLbStage').getBoundingClientRect(), cv = giCv();
  Object.assign(cv.style, {left: r.left - s.left + 'px', top: r.top - s.top + 'px', width: r.width + 'px', height: r.height + 'px'});
}
new ResizeObserver(giPlace).observe($('gnLbStage'));

function giMode(erase) {
  gi.erase = erase;
  document.querySelectorAll('#gnInpMode button').forEach(b => b.classList.toggle('on', (b.dataset.v === 'erase') === erase));
  $('gnInpCur').classList.toggle('erase', erase);
}

// толщина кисти в точках маски: ползунок 1…40 — от 0,5 до 20 % длинной стороны
const giWidth = () => Math.max(2, Math.max(giCv().width, giCv().height) * (+$('gnInpSize').value) / 200);

function giSeg(ctx, s, a, b) {
  ctx.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over';
  ctx.strokeStyle = GI_INK;
  ctx.lineWidth = s.w;
  ctx.lineCap = ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
}

function giRedraw() {
  const cv = giCv(), ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  for (const s of gi.strokes) {
    if (s.clear) { ctx.clearRect(0, 0, cv.width, cv.height); continue; }
    s.pts.forEach((p, i) => giSeg(ctx, s, s.pts[Math.max(0, i - 1)], p));
  }
  giState();
}

// закрашено ли что-нибудь: после последней очистки был мазок кистью (стёртое целиком сервер назовёт пустым)
function giInked() {
  for (let i = gi.strokes.length - 1; i >= 0; i--) {
    if (gi.strokes[i].clear) return false;
    if (!gi.strokes[i].erase) return true;
  }
  return false;
}

function giState() {
  $('gnInpGo').disabled = !giInked();
  $('gnInpUndo').disabled = !gi.strokes.length;
}

function giNote() {
  const id = gi.x?.meta.model, has = (gn.info?.models || []).some(m => m.id === id);
  $('gnInpNote').textContent = t('inp.note', {m: ggModelName(has ? id : gn.set.model), n: gn.set.count});
}

function giPt(e) {
  const cv = giCv(), r = cv.getBoundingClientRect();
  return [(e.clientX - r.left) * cv.width / r.width, (e.clientY - r.top) * cv.height / r.height];
}

function giCursor(e) {
  const c = $('gnInpCur'), cv = giCv(), r = cv.getBoundingClientRect(), s = $('gnLbStage').getBoundingClientRect();
  const d = giWidth() * r.width / cv.width;
  Object.assign(c.style, {width: d + 'px', height: d + 'px', transform: `translate(${e.clientX - s.left - d / 2}px, ${e.clientY - s.top - d / 2}px)`});
  c.classList.remove('hide');
}

{
  const cv = giCv();
  cv.addEventListener('pointerdown', e => {
    if (e.button !== 0 && e.button !== 2) return;
    e.preventDefault();
    cv.setPointerCapture(e.pointerId);
    const p = giPt(e);
    gi.cur = {erase: gi.erase || e.button === 2, w: giWidth(), pts: [p]};
    gi.strokes.push(gi.cur);
    giSeg(cv.getContext('2d'), gi.cur, p, p);
  });
  cv.addEventListener('pointermove', e => {
    giCursor(e);
    if (!gi.cur) return;
    const p = giPt(e), pts = gi.cur.pts;
    giSeg(cv.getContext('2d'), gi.cur, pts[pts.length - 1], p);
    pts.push(p);
  });
  const end = () => { if (gi.cur) { gi.cur = null; giState(); } };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
  cv.addEventListener('pointerleave', () => $('gnInpCur').classList.add('hide'));
  cv.addEventListener('contextmenu', e => e.preventDefault());   // правая кнопка — ластик, а не меню
}

function giUndo() { if (gi.strokes.length && !gi.cur) { gi.strokes.pop(); giRedraw(); } }
function giClear() { if (giInked()) { gi.strokes.push({clear: true}); giRedraw(); } }
function giSize(d) { const r = $('gnInpSize'); r.value = Math.min(+r.max, Math.max(+r.min, +r.value + d)); }

// маска для сервера: белое там, где закрашено, остальное прозрачное
function giMask() {
  const cv = giCv(), c = document.createElement('canvas');
  c.width = cv.width; c.height = cv.height;
  const g = c.getContext('2d');
  g.drawImage(cv, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

async function giGo() {
  const x = gi.x, b = $('gnInpGo');
  if (!x || !giInked() || b.classList.contains('busy')) return;
  const lbl = b.querySelector('span');
  b.classList.add('busy');
  try {
    const r = await ggRestore(x.path); if (!r) return;
    const inf = gn.info || {models: [], presets: []};
    const model = inf.models.some(m => m.id === r.model) ? r.model : gn.set.model;
    const preset = inf.presets.includes(r.preset) ? r.preset : 'none';
    // пусто — то же место по прежнему промту; иначе помощник переводит и расписывает запрос в стиле картинки
    const what = $('gnInpText').value.trim();
    let prompt = r.prompt || '', expanded = r.expanded || '';
    if (what) {
      prompt = what; expanded = '';
      if (inf.llm) {
        lbl.textContent = t('inp.writing');
        const e = await api('gen-enhance', {prompt: what, preset, count: 1, refs: [], own: false});
        if (!e.error) expanded = e.prompts?.[0] || e.prompt || '';
      }
    }
    if (!prompt.trim()) prompt = expanded || r.expanded || 'picture';
    const mask = giMask();
    const res = await api('gen-add', {model, preset, negative: r.negative || '', ratio: r.ratio || '1:1', count: gn.set.count, seed: -1,
      steps: r.steps || 0, cfg: r.cfg || 0, preview: gn.set.build, refs: [], prompt, expanded, init: x.path, inpaint: true, mask, inpStrength: (+$('gnInpStr').value || 90) / 100});
    if (ggErr(res)) return;
    gn.masks[res.id] = mask;
    ggLbClose();
    if (gg.open) ggOpen(false);
    gn.view = res.id;
    gnPoll();
    toast({type: 'ok', title: t('inp.sent'), text: esc(t('inp.sentS')), ttl: 4000});
  } finally {
    b.classList.remove('busy');
    lbl.textContent = t('inp.go');
  }
}

$('gnLbInp').addEventListener('click', giOpen);
$('gnInpCancel').addEventListener('click', giClose);
$('gnInpGo').addEventListener('click', giGo);
$('gnInpUndo').addEventListener('click', giUndo);
$('gnInpClear').addEventListener('click', giClear);
$('gnInpMode').addEventListener('click', e => { const b = e.target.closest('button[data-v]'); if (b) giMode(b.dataset.v === 'erase'); });
$('gnLbImg').addEventListener('load', giPlace);
$('gnInpText').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); giGo(); } });

// клавиши работают раньше клавиш окна просмотра: Esc выходит из кисти, а не закрывает окно; Del ничего не удаляет
document.addEventListener('keydown', e => {
  if (!gi.on) return;
  const typing = e.target.closest && e.target.closest('input, textarea, select');
  const c = e.code;
  if (e.key === 'Escape') giClose();
  else if (typing) return;
  else if ((e.ctrlKey || e.metaKey) && c === 'KeyZ') giUndo();
  else if (e.ctrlKey || e.metaKey || e.altKey) return;
  else if (c === 'KeyB') giMode(false);
  else if (c === 'KeyE') giMode(true);
  else if (c === 'BracketLeft') giSize(-1);
  else if (c === 'BracketRight') giSize(1);
  else if (['Delete', 'ArrowLeft', 'ArrowRight', 'KeyF'].includes(c)) {}   // окно просмотра в режиме кисти эти клавиши не получает
  else return;
  e.preventDefault(); e.stopPropagation();
}, true);
