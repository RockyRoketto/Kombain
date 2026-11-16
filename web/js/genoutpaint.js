// «Дорисовать за краями» в окне просмотра галереи (gengallery.js).
// Рамка нового холста поверх картинки: тянешь края и углы наружу (Shift — обе стороны сразу) или выбираешь формат.
// Каждая сторона — не больше размера картинки по своей оси. Холст всегда вписан в окно, и пока тянешь, вид уменьшается.
// Сервер: genoutpaint.go (холст с заливкой краёв, маска — новая полоса, дальше как у перерисовки части).
const OUT_MARGIN = 22;   // поле вокруг рамки для ручек, точек экрана
const OUT_MAXSIDE = 8192;
const gop = {
  on: false,
  x: null,               // картинка из окна просмотра
  w: 0, h: 0,            // её размер
  e: [0, 0, 0, 0],       // сколько добавить: слева, сверху, справа, снизу (точки картинки)
  k: 1, ox: 0, oy: 0,    // масштаб и место картинки на сцене (меняются только между перетаскиваниями)
  drag: null,
};

function gopOpen() {
  const x = ggCur(), img = $('gnLbImg');
  if (!x || x.meta.cutout || !img.naturalWidth) return;
  Object.assign(gop, {on: true, x, w: img.naturalWidth, h: img.naturalHeight, e: [0, 0, 0, 0], drag: null});
  $('gnOutImg').src = img.src;
  $('gnLb').classList.add('out');
  $('gnOut').classList.remove('hide');
  $('gnOutP').classList.remove('hide');
  $('gnLbT').textContent = t('out.btn');
  $('gnOutText').value = '';
  const id = x.meta.model, has = (gn.info?.models || []).some(m => m.id === id);
  $('gnOutNote').textContent = t('inp.note', {m: ggModelName(has ? id : gn.set.model), n: gn.set.count});
  gopFmts();
  gopFit();
}

function gopClose() {
  if (!gop.on) return;
  Object.assign(gop, {on: false, x: null, drag: null});
  $('gnLb').classList.remove('out');
  for (const id of ['gnOut', 'gnOutP']) $(id).classList.add('hide');
  if (gg.lb && !$('gnLb').classList.contains('hide')) ggLbRender();
}

// предел стороны: не больше картинки по своей оси и не больше OUT_MAXSIDE у готовой
function gopLim(i) {
  const e = gop.e, horiz = i % 2 === 0;
  const own = horiz ? gop.w : gop.h, other = horiz ? e[2 - i] : e[i === 1 ? 3 : 1];
  return Math.max(0, Math.min(own, OUT_MAXSIDE - own - other));
}

const gopSize = () => [gop.w + gop.e[0] + gop.e[2], gop.h + gop.e[1] + gop.e[3]];

// вписать холст в сцену по центру
function gopFit() {
  if (!gop.on) return;
  const s = $('gnOut').getBoundingClientRect(), [W, H] = gopSize();
  if (!s.width) return;
  gop.k = Math.min((s.width - 2 * OUT_MARGIN) / W, (s.height - 2 * OUT_MARGIN) / H);
  gop.ox = (s.width - W * gop.k) / 2 + gop.e[0] * gop.k;
  gop.oy = (s.height - H * gop.k) / 2 + gop.e[1] * gop.k;
  gopDraw();
}
new ResizeObserver(() => { if (!gop.drag) gopFit(); }).observe($('gnLbStage'));

function gopDraw() {
  const {k, ox, oy, e, w, h} = gop, [W, H] = gopSize();
  Object.assign($('gnOutFr').style, {left: ox - e[0] * k + 'px', top: oy - e[1] * k + 'px', width: W * k + 'px', height: H * k + 'px'});
  Object.assign($('gnOutImg').style, {left: e[0] * k + 'px', top: e[1] * k + 'px', width: w * k + 'px', height: h * k + 'px'});
  const grow = e.some(v => v > 0);
  $('gnOutSize').textContent = grow ? `${w}×${h} → ${W}×${H}` : `${w}×${h}`;
  $('gnOutGo').disabled = !grow;
  $('gnOutReset').disabled = !grow;
  const cur = W / H;
  document.querySelectorAll('#gnOutFmt button[data-r]').forEach(b => {
    const [a, c] = b.dataset.r.split(':').map(Number);
    b.classList.toggle('on', grow && Math.abs(cur - a / c) < 0.01);
  });
}

// форматы: холст под пропорцию, картинка по центру (только раздвигаем, не обрезаем)
function gopFmts() {
  const rs = gn.info?.ratios?.length ? gn.info.ratios : ['1:1', '16:9', '9:16', '4:5', '3:2', '2:3'];
  $('gnOutFmt').innerHTML = rs.map(r => `<button type="button" class="btn sm" data-r="${esc(r)}">${esc(r)}</button>`).join('') +
    `<button type="button" class="btn sm" data-around="1" title="${esc(t('out.aroundS'))}">${esc(t('out.around'))}</button>`;
  document.querySelectorAll('#gnOutFmt button[data-r]').forEach(b => {
    const e = gopRatio(b.dataset.r);
    b.disabled = !e;
    b.title = e ? '' : t('out.fmtNo');
  });
}

// стороны под пропорцию r или null, если не дотянуться (каждая сторона не больше картинки)
function gopRatio(r) {
  const [a, c] = r.split(':').map(Number), {w, h} = gop, want = a / c;
  let W = w, H = h;
  if (w / h < want) W = Math.round(h * want); else H = Math.round(w / want);
  const dx = W - w, dy = H - h;
  if (dx > 2 * w || dy > 2 * h || W > OUT_MAXSIDE || H > OUT_MAXSIDE) return null;
  return [Math.floor(dx / 2), Math.floor(dy / 2), dx - Math.floor(dx / 2), dy - Math.floor(dy / 2)];
}

function gopSet(e) { gop.e = e; gopFit(); }

$('gnOutFmt').addEventListener('click', ev => {
  const b = ev.target.closest('button'); if (!b || b.disabled) return;
  if (b.dataset.around) {
    const dx = Math.round(gop.w / 8), dy = Math.round(gop.h / 8);
    gop.e = gop.e.map((v, i) => v + (i % 2 ? dy : dx));
    gopSet(gop.e.map((v, i) => Math.min(v, gopLim(i))));
  } else {
    const e = gopRatio(b.dataset.r); if (e) gopSet(e);
  }
});
$('gnOutReset').addEventListener('click', () => gopSet([0, 0, 0, 0]));

// перетаскивание краёв и углов
{
  const fr = $('gnOutFr');
  fr.addEventListener('pointerdown', ev => {
    const hd = ev.target.closest('i[data-h]'); if (!hd || ev.button !== 0) return;
    ev.preventDefault();
    hd.setPointerCapture(ev.pointerId);
    gop.drag = {h: hd.dataset.h, x: ev.clientX, y: ev.clientY, e: [...gop.e], k: gop.k};
    $('gnOut').classList.add('drag');
  });
  fr.addEventListener('pointermove', ev => {
    const d = gop.drag; if (!d) return;
    // сдвиг мыши в точках картинки по масштабу начала перетаскивания: холст вписывается заново на каждом шаге,
    // поэтому тянуть можно и тогда, когда рамка уже во всё окно
    const dx = (ev.clientX - d.x) / d.k, dy = (ev.clientY - d.y) / d.k;
    const e = [...d.e];
    const put = (i, v) => { e[i] = v; if (ev.shiftKey) e[(i + 2) % 4] = v; };
    if (d.h.includes('l')) put(0, d.e[0] - dx);
    if (d.h.includes('r')) put(2, d.e[2] + dx);
    if (d.h.includes('t')) put(1, d.e[1] - dy);
    if (d.h.includes('b')) put(3, d.e[3] + dy);
    gop.e = e;
    gop.e = e.map((v, i) => {
      v = Math.round(Math.max(0, Math.min(v, gopLim(i))));
      return v < 4 ? 0 : v;   // почти ноль — без полоски в пару точек
    });
    gopFit();
  });
  const end = () => { if (gop.drag) { gop.drag = null; $('gnOut').classList.remove('drag'); gopFit(); } };
  fr.addEventListener('pointerup', end);
  fr.addEventListener('pointercancel', end);
}

async function gopGo() {
  const x = gop.x, b = $('gnOutGo');
  if (!x || !gop.e.some(v => v > 0) || b.classList.contains('busy')) return;
  const lbl = b.querySelector('span');
  b.classList.add('busy');
  try {
    const r = await ggRestore(x.path); if (!r) return;
    const inf = gn.info || {models: [], presets: []};
    const model = inf.models.some(m => m.id === r.model) ? r.model : gn.set.model;
    const preset = inf.presets.includes(r.preset) ? r.preset : 'none';
    // пусто — описываем только продолжение; иначе помощник расписывает, что должно быть вокруг
    const what = $('gnOutText').value.trim();
    let prompt = r.prompt || '', expanded = r.expanded || '';
    if (!what) {
      // движок рисует только новую полосу, а прежний промт описывает героя целиком («по пояс, руки…»): модель
      // рисует героя заново в каждой полосе (дубли рук и плеч). Отрицания она не понимает, поэтому прежний промт
      // не шлём: описываем только продолжение; с низа (герой обрезан) — его одежда и тело, с остальных сторон — фон
      const [, , , eb] = gop.e;
      prompt = eb > 0
        ? 'The same photograph continued below the cut: the clothes and body of the person continue naturally downward, same light, same background, one continuous photo, photorealistic.'
        : 'Only the empty out-of-focus background of the same photograph, the same place, light and colours, continuing smoothly to the edges, photorealistic.';
      expanded = '';
    }
    if (what) {
      prompt = what; expanded = '';
      if (inf.llm) {
        lbl.textContent = t('inp.writing');
        const e = await api('gen-enhance', {prompt: what, preset, count: 1, refs: [], own: false});
        if (!e.error) expanded = e.prompts?.[0] || e.prompt || '';
      }
    }
    if (!prompt.trim()) prompt = expanded || r.expanded || 'picture';
    const neg = [r.negative, 'duplicate, cloned, extra arms, extra hands, second person'].filter(Boolean).join(', ');
    const res = await api('gen-add', {model, preset, negative: neg, ratio: r.ratio || '1:1', count: gn.set.count, seed: -1,
      steps: r.steps || 0, cfg: r.cfg || 0, preview: gn.set.build, refs: [], prompt, expanded, init: x.path, outpaint: [...gop.e]});
    if (ggErr(res)) return;
    ggLbClose();
    if (gg.open) ggOpen(false);
    gn.view = res.id;
    gnPoll();
    toast({type: 'ok', title: t('out.sent'), text: esc(t('inp.sentS')), ttl: 4000});
  } finally {
    b.classList.remove('busy');
    lbl.textContent = t('out.go');
  }
}

$('gnLbOut').addEventListener('click', gopOpen);
$('gnOutCancel').addEventListener('click', gopClose);
$('gnOutGo').addEventListener('click', gopGo);
$('gnOutText').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); gopGo(); } });

// Esc выходит из рамки, а не закрывает окно; стрелки и Del окно просмотра в этом режиме не получает
document.addEventListener('keydown', e => {
  if (!gop.on) return;
  if (e.key === 'Escape') gopClose();
  else if (e.target.closest && e.target.closest('input, textarea, select')) return;
  else if (!['Delete', 'ArrowLeft', 'ArrowRight', 'KeyF'].includes(e.code)) return;
  e.preventDefault(); e.stopPropagation();
}, true);
