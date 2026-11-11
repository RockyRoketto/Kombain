// ---------- Монтаж: читается ли текст и субтитры на кадре под ними (расчёт в readable.js) ----------
// Кадр под надписью собирается заново в маленький холст из тех же <video> и <img>, что во вьюпорте: рамка, кадрирование, поворот,
// прозрачность и режим наложения. Размытие, тень и хромакей не учитываются: для оценки яркости фона этого хватает.
const MR_W = 320;   // ширина холста для замера
let mrTimer = 0, mrTries = 0;
// замер после того, как кадр устоится: на каждую перемотку и правку, во время просмотра ждёт остановки
function mrSoon() { clearTimeout(mrTimer); mrTimer = setTimeout(mrRun, 250); }

// элемент, который сейчас показывает клип, если его кадр готов; false — ещё грузится
function mrEl(c) {
  const e = mv.pool.find(p => p.clip === c.id && p.ready && !p.el.classList.contains('mv-off'));
  const el = e ? e.el : mv.pics.get(c.id);
  if (!el || el.classList.contains('hide')) return null;
  if (el.tagName === 'VIDEO' ? el.readyState < 2 || el.seeking : !el.complete) return false;
  return el;
}
// кадр монтажа из слоёв дорожек ниже top (и с неё самой, кроме клипа skip); null — кадр ещё не готов
function mrFrame(top, skip) {
  const d = mvCanvasDims(), W = MR_W, H = Math.max(1, Math.round(MR_W * d.h / d.w));
  const cv = mrFrame.cv || (mrFrame.cv = document.createElement('canvas'));
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d', {willReadFrequently: true});
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  let ready = true;
  tkTracks.forEach((tr, z) => {
    if (tr.off || tr.kind !== 'v' || z > top) return;
    for (const c of tr.clips) {
      if (c.id === skip || !mvShown(c, tkAt)) continue;
      const el = mrEl(c);
      if (el === false) ready = false;
      if (!el) continue;
      const sw = el.videoWidth || el.naturalWidth, sh = el.videoHeight || el.naturalHeight;
      if (!sw || !sh) continue;
      const b = mvBox(c), o = mvCropOf(c), op = parseFloat(el.style.opacity);
      g.save();
      g.globalAlpha = Number.isFinite(op) ? Math.min(Math.max(op, 0), 1) : 1;
      g.globalCompositeOperation = c.blend || 'source-over';   // названия режимов у canvas те же, что у mix-blend-mode
      g.translate((b.x + b.w / 2) * W, (b.y + b.h / 2) * H);   // поворот вокруг середины всей рамки, как в mvPlace
      if (c.rot) g.rotate(c.rot * Math.PI / 180);
      const cw = 1 - o.l - o.r, ch = 1 - o.t - o.b;
      if (cw > 0 && ch > 0) g.drawImage(el, o.l * sw, o.t * sh, cw * sw, ch * sh, (o.l - .5) * b.w * W, (o.t - .5) * b.h * H, cw * b.w * W, ch * b.h * H);
      g.restore();
    }
  });
  return ready ? g : null;
}
// пиксели кадра в прямоугольнике r (доли холста); undefined — браузер не дал пикселей
function mrPixels(g, r) {
  const W = g.canvas.width, H = g.canvas.height;
  const x0 = Math.max(0, Math.floor(r.x * W)), y0 = Math.max(0, Math.floor(r.y * H));
  const x1 = Math.min(W, Math.ceil((r.x + r.w) * W)), y1 = Math.min(H, Math.ceil((r.y + r.h) * H));
  if (x1 <= x0 || y1 <= y0) return null;
  try { return g.getImageData(x0, y0, x1 - x0, y1 - y0).data; } catch (e) { return undefined; }
}

// Что проверять сейчас: текст выбранного клипа и субтитры. Ответ кладётся в mr.text и mr.subs вместе с пикселями для подсказок.
const mr = {text: null, subs: null};
function mrRun() {
  mrTimer = 0;
  if (tab !== 'mont' || mv.file || mv.playing) return;
  const a = mrTextCheck(), b = mrSubsCheck();
  if ((a === false || b === false) && ++mrTries < 20) { mrSoon(); return; }   // кадр ещё грузится
  mrTries = 0;
  mr.text = a || null;
  mr.subs = b || null;
  mrShow('mtTextRead', mr.text, true);
  mrShow('mtSubsRead', mr.subs, false);
}
function mrTextCheck() {
  const c = tkOne(), x = c && c.text;
  if (!x || !mvShown(c, tkAt)) return null;
  const z = tkTracks.findIndex(tr => tr.clips.includes(c)), g = mrFrame(z, c.id);
  if (!g) return false;
  const px = mrPixels(g, mvBox(c));
  if (!px) return null;
  const r = rdCheck(px, x.color, {back: x.back ? {c: x.back, a: x.backA} : null, edge: x.stroke > 0 ? {c: x.strokeColor, w: x.stroke} : null});
  return r && {...r, id: c.id, px, ink: x.color};
}
function mrSubsCheck() {
  const s = tkSubs, el = $('mvSubs'), span = el.querySelector('span');
  if (!s || s.off || s.mode === 'track' || el.classList.contains('hide') || !span) return null;
  const cv = mvCv.getBoundingClientRect(), b = span.getBoundingClientRect();
  if (!cv.width || !b.width) return null;
  const g = mrFrame(Infinity, -1);
  if (!g) return false;
  const px = mrPixels(g, {x: (b.left - cv.left) / cv.width, y: (b.top - cv.top) / cv.height, w: b.width / cv.width, h: b.height / cv.height});
  if (!px) return null;
  // без подложки у букв всегда чёрная обводка (subsOutline в subtitles.go)
  const r = rdCheck(px, s.color || '#ffffff', s.back ? {back: {c: s.back, a: s.backA > 0 ? s.backA : .6}} : {edge: {c: '#000000', w: .06}});
  return r && {...r, px, ink: s.color || '#ffffff'};
}
// предупреждение в панели: видно, только если текст читается плохо
function mrShow(id, r, edge) {
  const box = $(id), bad = !!(r && !r.ok);
  box.classList.toggle('hide', !bad);
  if (!bad) return;
  const key = JSON.stringify([rdShow(r.ratio), edge, lang]);
  if (box.dataset.k === key) return;
  box.dataset.k = key;
  box.innerHTML = `<span>${esc(t('mt.readBad', {r: rdShow(r.ratio), min: RD_MIN}))}</span><span class="mt-read-do">`
    + (edge ? `<button type="button" class="btn sm" data-fix="edge" title="${esc(t('mt.readEdgeTip'))}">${esc(t('mt.readEdge'))}</button>` : '')
    + `<button type="button" class="btn sm" data-fix="back" title="${esc(t('mt.readBackTip'))}">${esc(t('mt.readBack'))}</button></span>`;
}
$('mtTextRead').addEventListener('click', e => {
  const b = e.target.closest('[data-fix]'), r = mr.text, c = tkOne();
  if (!b || !r || !c || !c.text || c.id !== r.id) return;
  const guard = rdGuard(c.text.color);
  if (b.dataset.fix === 'edge') mtTextDo({stroke: Math.max(c.text.stroke, .06), strokeColor: guard});
  else mtTextDo({back: guard, backA: rdBackAlpha(r.px, c.text.color, guard)});
});
$('mtSubsRead').addEventListener('click', e => {
  const b = e.target.closest('[data-fix=back]'), r = mr.subs;
  if (!b || !r || !tkSubs) return;
  const guard = rdGuard(r.ink), a = rdBackAlpha(r.px, r.ink, guard);
  tkDo(() => { tkSubs = {...tkSubs, back: guard, backA: a}; });
});
