// ---------- переходы на краю клипа: вкладка инспектора «Переходы», плашки на дорожке, клавиша D ----------
// Поля клипа trIn и trOut (tracks.js), правила стыка как в mvTrMap и tlTransitions. Переход выбирается щелчком по плашке,
// он не клип: выбор клипов при этом снимается. Всё, что меняет проект, идёт через tkDo или tkCommit, поэтому отменяется.

// Всё объявлено через var и function: mtTabs и tkRender могут позвать сюда раньше, чем выполнится этот файл
var tkTrSel = null;          // выбранный переход {id: клип, side: 'i' начало, 'o' конец}
var tkTrNow = new Map();     // переходы всех дорожек на время отрисовки (mvTrMap с выключенными дорожками)
var TK_TR_DEF = {k: 'fade', d: 1};   // клавиша D и звук рядом с картинкой
function tkTrKey(side) { return side === 'i' ? 'trIn' : 'trOut'; }
function tkTrOf(s) { const c = s && tkById(s.id), t = c && c[tkTrKey(s.side)]; return t ? {c, t} : null; }
// вплотную, как tlMeet: картинка с картинкой одного режима наложения, звук со звуком
function tkTrMeet(tr, a, b) { return Math.abs(tkEnd(a) - b.at) < TK_EPS && (tr.kind === 'a' || (a.blend || '') === (b.blend || '')); }
function tkTrPrev(c) { const tr = tkTrackOf(c); return tr.clips.find(o => o !== c && tkTrMeet(tr, o, c)) || null; }
function tkTrNext(c) { const tr = tkTrackOf(c); return tr.clips.find(o => o !== c && tkTrMeet(tr, c, o)) || null; }
// край клипа: конец перед соседом вплотную — это начало соседа (стык хранится у правого клипа)
function tkTrNorm(c, side) {
  const n = side === 'o' && tkTrNext(c);
  return n ? {c: n, side: 'i'} : {c, side};
}
function tkTrSound(c) { return tkTrackOf(c).kind === 'a'; }
// длительность в пределах: кадр, TK_TRANS_MAX, длина клипа (у стыка половина на каждого из двух)
function tkTrClamp(c, side, d) {
  const f = tkFps(), p = side === 'i' && tkTrPrev(c);
  const max = Math.min(TK_TRANS_MAX, p ? 2 * Math.min(tkLen(p), tkLen(c)) : tkLen(c));
  return +Math.max(Math.round(Math.min(d, max) * f) / f, Math.min(1 / f, max)).toFixed(3);
}
// Поставить переход. withSound: и на связанный звук той же длины, если его край там же
function tkTrPut(c, side, t, withSound) {
  ({c, side} = tkTrNorm(c, side));
  const k = tkTrSound(c) ? 'fade' : t.k, d = tkTrClamp(c, side, t.d);
  c[tkTrKey(side)] = {k, d};
  if (side === 'i') { const p = tkTrPrev(c); if (p) delete p.trOut; }   // у левого соседа уход в пустоту больше не действует
  if (withSound && !tkTrSound(c) && c.link) {
    const a = tkGroup(c).find(o => o !== c && tkTrSound(o));
    if (a && Math.abs(side === 'i' ? a.at - c.at : tkEnd(a) - tkEnd(c)) < TK_EPS) tkTrPut(a, side, {k: 'fade', d}, false);
  }
  return {id: c.id, side};
}
// где сейчас переход на дорожке (секунды): у стыка по центру, у свободного края внутри клипа
function tkTrSpan(c, side, d) {
  if (side === 'i' && tkTrPrev(c)) return [c.at - d / 2, c.at + d / 2];
  return side === 'i' ? [c.at, c.at + d] : [tkEnd(c) - d, tkEnd(c)];
}

// ---------- плашки: рисуются внутри клипов, поэтому едут вместе с ними при перетаскивании и обрезке ----------
// У стыка две половинки: конец левого клипа и начало правого, обе про один переход правого клипа
function tkTrPaint(el, c) {
  let box = el.querySelector('.tk-trs');
  const x = tkTrNow && tkTrNow.get(c.id), parts = [];
  if (x && x.i) parts.push({id: c.id, side: 'i', at: 'left', h: x.i.h, cut: x.i.cut, k: x.i.k});
  if (x && x.o) {
    const n = x.o.cut && tkTrNext(c);
    if (!x.o.cut || n) parts.push({id: n ? n.id : c.id, side: n ? 'i' : 'o', at: 'right', h: x.o.h, cut: x.o.cut, k: x.o.k});
  }
  const sound = tkTrSound(c);
  const html = parts.map(p => {
    const tr = tkTrOf(p), on =tkTrSel && tkTrSel.id === p.id && tkTrSel.side === p.side;
    const tip = `${sound ? t('tr.sound') : trName(p.k)} · ${tkTrSecs(tr ? tr.t.d : 0)}`;
    const grip = p.at === 'left' ? 'r' : 'l';   // тянется край, который дальше от края клипа
    return `<i class="tk-tr ${p.at}${p.cut ? ' cut' : ''}${on ? ' on' : ''}" data-id="${p.id}" data-side="${p.side}" title="${esc(tip)}" style="width:${(p.h * tkPps).toFixed(1)}px">` +
      `<b class="tk-tre ${grip}"></b></i>`;
  }).join('');
  if (!html && !box) return;
  if (!box) { box = document.createElement('div'); box.className = 'tk-trs'; el.appendChild(box); }
  if (box.dataset.h !== html) { box.dataset.h = html; box.innerHTML = html; }
}
function trName(k) { return t(`tr.k.${k}`); }   // tr.k.fade, tr.k.wipeleft …
function tkTrSecs(d) { return `${String(+d.toFixed(2)).replace('.', lang === 'ru' ? ',' : '.')} ${t('tr.sec')}`; }
// перед отрисовкой дорожек: карта переходов и проверка выбранного (после отмены его могло не стать)
function tkTrPrep() {
  tkTrNow = mvTrMap(true);
  if (tkTrSel && !tkTrOf(tkTrSel)) tkTrSel = null;
}
function tkTrPick(s) {
  tkTrSel = s;
  if (s) { tkSel.clear(); $('trSelBox').open = true; mtTabGo('trans'); }   // настройки выбранного всегда на виду
  tkSelChanged();
}
function tkTrRemove() {
  const s = tkTrOf(tkTrSel);
  if (!s) return false;
  tkDo(() => { delete s.c[tkTrKey(tkTrSel.side)]; tkTrSel = null; });
  return true;
}
// Щелчок по плашке выбирает переход, край плашки тянет длительность
function tkTrDown(e, el) {
  const s = {id: +el.dataset.id, side: el.dataset.side}, got = tkTrOf(s);
  if (!got) return;
  if (!tkTrSel || tkTrSel.id !== s.id || tkTrSel.side !== s.side) tkTrPick(s);
  if (!e.target.closest('.tk-tre')) { e.preventDefault(); return; }
  const before = tkState(), {c} = got, key = tkTrKey(s.side), cut = s.side === 'i' && !!tkTrPrev(c);
  const pts = tkSnapPts(new Set([c.id]));
  tkDrag(e, ev => {
    const x0 = tkTimeAt(ev), x = x0 + tkSnapBy([x0], pts), d = cut ? 2 * Math.abs(x - c.at) : s.side === 'i' ? x - c.at : tkEnd(c) - x;
    c[key] = {...c[key], d: tkTrClamp(c, s.side, d)};
    tkRender(); mvShow(); trFill();
  }, () => { $('tkSnapLine').classList.add('hide'); tkCommit(before); });
}

// ---------- перетаскивание образца из вкладки на стык или край ----------
// Край под мышью: внутри клипа ближний из двух его краёв, рядом с клипом край в пределах 30 точек
function tkTrEdgeAt(ev) {
  const r = tkRowAt(ev.clientY), tr = tkShown()[r], box = $('tkScroll').getBoundingClientRect();
  if (!tr || ev.clientX < box.left || ev.clientX > box.right) return null;
  const x = tkTimeAt(ev), hit = tr.clips.find(c => x >= c.at && x <= tkEnd(c));
  let best = hit ? {c: hit, side: x - hit.at <= tkEnd(hit) - x ? 'i' : 'o'} : null, dist = 30 / tkPps;
  if (!hit) for (const c of tr.clips) for (const [side, at] of [['i', c.at], ['o', tkEnd(c)]]) {
    if (Math.abs(x - at) < dist) { dist = Math.abs(x - at); best = {c, side}; }
  }
  return best && {...tkTrNorm(best.c, best.side), r};
}
function trCardDrag(e, k) {
  const x0 = e.clientX, y0 = e.clientY, drop = $('tkDrop');
  let ghost = null, follow = null, aim = null;
  const move = ev => {
    if (ev.pointerId !== e.pointerId) return;
    if (!ghost) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < KIN.drag) return;
      ghost = document.createElement('div');
      ghost.className = 'tk-ghost';
      ghost.textContent = trName(k);
      ghost.style.left = x0 + 'px';
      ghost.style.top = y0 + 'px';
      document.body.appendChild(ghost);
      follow = kinFollow(ghost, {still: true});
    }
    follow.aim(ev.clientX - x0, ev.clientY - y0);
    aim = tkTrEdgeAt(ev);
    drop.classList.toggle('hide', !aim);
    if (!aim) return;
    const old = aim.c[tkTrKey(aim.side)], [a, b] = tkTrSpan(aim.c, aim.side, tkTrClamp(aim.c, aim.side, old ? old.d : TK_TR_DEF.d));
    $('tkLanes').querySelectorAll('.tk-lane')[aim.r].appendChild(drop);
    drop.style.left = a * tkPps + 'px';
    drop.style.width = (b - a) * tkPps + 'px';
  };
  const end = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
  };
  const up = ev => {
    if (ev.pointerId !== e.pointerId) return;
    end();
    if (!ghost) {   // щелчок по образцу: вид выбранного перехода
      const s = tkTrOf(tkTrSel);
      if (s && !tkTrSound(s.c)) tkDo(() => { s.c[tkTrKey(tkTrSel.side)] = {...s.t, k}; });
      return;
    }
    drop.classList.add('hide');
    if (ev.type === 'pointerup' && aim) {
      follow.stop();
      ghost.remove();
      const {c, side} = aim, old = c[tkTrKey(side)];
      let s = null;
      tkDo(() => { s = tkTrPut(c, side, {k, d: old ? old.d : TK_TR_DEF.d}, !old); });
      tkTrPick(s);
    } else follow.land(0, 0, () => ghost.remove());
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

// ---------- клавиша D: переход по умолчанию на ближайший к линии кадра стык ----------
// Сначала картинка (с ней сам ставится звук), стыков картинки нет — звук
function tkTrDefault() {
  let best = null;
  for (const kind of ['v', 'a']) {
    for (const tr of tkTracks) {
      if (tr.kind !== kind) continue;
      for (const c of tr.clips) {
        if (!tkTrPrev(c)) continue;
        const far = Math.abs(c.at - tkAt);
        if (!best || far < best.far - TK_EPS) best = {c, far};
      }
    }
    if (best) break;
  }
  if (!best) { say('info', t('tr.noCutTitle'), t('tr.noCut')); return; }
  const {c} = best;
  if (c.trIn) { tkTrPick({id: c.id, side: 'i'}); return; }
  let s = null;
  tkDo(() => { s = tkTrPut(c, 'i', TK_TR_DEF, true); });
  tkTrPick(s);
}

// ---------- вкладка «Переходы»: образцы и настройки выбранного ----------
// Образец рисуется по тем же формулам, что просмотр (mvTrLook): A уходит, B приходит. При наведении играет
function trDraw(cv, k, P) {
  const W = cv.width, H = cv.height, g = cv.getContext('2d'), img = g.createImageData(W, H), px = img.data;
  const La = mvTrLook({k, P, role: 'a', cut: true}), Lb = mvTrLook({k, P, role: 'b', cut: true}), R = Math.hypot(.5 * W, .5 * H);
  const colA = (u, v) => ((u * 6 + v * 3) % 1 < .5 ? [74, 86, 104] : [96, 110, 130]);
  const colB = (u, v) => (Math.hypot(u - .5, (v - .5) * H / W) < .18 ? [255, 236, 200] : [233, 184, 114]);
  const layer = (L, u, v) => {
    if (L.poly) {
      const xs = L.poly.map(p => p[0]), ys = L.poly.map(p => p[1]);
      if (u < Math.min(...xs) || u > Math.max(...xs) || v < Math.min(...ys) || v > Math.max(...ys)) return 0;
    }
    const lu = .5 + (u - L.dx - .5) / L.zoom, lv = .5 + (v - L.dy - .5) / L.zoom;
    if (lu < 0 || lu > 1 || lv < 0 || lv > 1) return 0;
    return L.op * (L.circle ? L.circle(Math.hypot((u - .5) * W, (v - .5) * H) / R) : 1);
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = (x + .5) / W, v = (y + .5) / H, i = (y * W + x) * 4;
    let c = [24, 26, 30];
    const mix = (to, a) => { if (a > 0) c = c.map((q, j) => q + (to[j] - q) * Math.min(a, 1)); };
    const loc = L => [.5 + (u - L.dx - .5) / L.zoom, .5 + (v - L.dy - .5) / L.zoom];
    mix(colB(...loc(Lb)), layer(Lb, u, v));
    mix(colA(...loc(La)), layer(La, u, v));
    if (La.bg) mix(La.bg.color === '#000' ? [0, 0, 0] : [255, 255, 255], La.bg.a);
    px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
}
var trPlay = null;
function trCards() {
  const box = $('trCards');
  if (box.children.length) return;
  box.innerHTML = TK_TRANS.map(k => `<button class="tr-card" data-k="${k}" title="${esc(t('tr.dragTip'))}"><canvas width="64" height="36"></canvas><span>${esc(trName(k))}</span></button>`).join('');
  box.querySelectorAll('.tr-card').forEach(b => trDraw(b.firstChild, b.dataset.k, .5));
  box.addEventListener('pointerover', e => {
    const b = e.target.closest('.tr-card');
    if (!b || (trPlay && trPlay.b === b)) return;
    if (trPlay) trPlay.stop();
    const t0 = performance.now(), cv = b.firstChild, k = b.dataset.k;
    let raf = 0;
    const step = now => { const q = ((now - t0) / 1600) % 1; trDraw(cv, k, 1 - Math.min(Math.max((q - .1) / .7, 0), 1)); raf = requestAnimationFrame(step); };
    raf = requestAnimationFrame(step);
    trPlay = {b, stop: () => { cancelAnimationFrame(raf); trDraw(cv, k, .5); trPlay = null; }};
  });
  box.addEventListener('pointerleave', () => { if (trPlay) trPlay.stop(); });
  box.addEventListener('pointerdown', e => {
    const b = e.target.closest('.tr-card');
    if (e.button !== 0 || !b) return;
    e.preventDefault();
    trCardDrag(e, b.dataset.k);
  });
}
// настройки выбранного перехода; зовётся из mtTabs
function trFill() {
  trCards();
  const s = tkTrOf(tkTrSel), sound = !!s && tkTrSound(s.c);
  $('trSelBox').classList.toggle('hide', !s);
  $('trCards').querySelectorAll('.tr-card').forEach(b => b.classList.toggle('on', !!s && !sound && b.dataset.k === s.t.k));
  if (!s) return;
  const kind = $('trKind');
  if (!kind.options.length) kind.innerHTML = TK_TRANS.map(k => `<option value="${k}">${esc(trName(k))}</option>`).join('');
  kind.value = s.t.k;
  $('trKindRow').classList.toggle('hide', sound);
  $('trSoundNote').classList.toggle('hide', !sound);
  const max = tkTrClamp(s.c, tkTrSel.side, Infinity);
  $('trDur').max = $('trDurR').max = max;
  $('trDur').min = $('trDurR').min = +(1 / tkFps()).toFixed(3);
  if (document.activeElement !== $('trDur')) mtVal('trDur', s.t.d);
  else $('trDurR').value = s.t.d;
  $('trWhere').textContent = t(tkTrSel.side === 'i' && tkTrPrev(s.c) ? 'tr.atCut' : tkTrSel.side === 'i' ? 'tr.atIn' : 'tr.atOut');
}
mtRow('trDur', .02, v => {
  const s = tkTrOf(tkTrSel);
  if (s) { s.c[tkTrKey(tkTrSel.side)] = {...s.t, d: tkTrClamp(s.c, tkTrSel.side, v)}; tkRender(); }
});
$('trKind').addEventListener('change', () => {
  const s = tkTrOf(tkTrSel);
  if (s && TK_TRANS.includes($('trKind').value)) tkDo(() => { s.c[tkTrKey(tkTrSel.side)] = {...s.t, k: $('trKind').value}; });
});
$('trDel').onclick = tkTrRemove;
