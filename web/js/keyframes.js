// ---------- ключевые кадры рамки слоя: середина, ширина и поворот меняются со временем (Keys в keyframes.go) ----------
// c.kf = {x, y, w, r}: списки ключей {s, v, e}. s — секунда файла, как у меток клипа, поэтому ключ держится за кадр при обрезке и разрезе;
// v — середина рамки в долях кадра (x, y), ширина рамки в долях кадра (w, высота в той же пропорции), поворот в градусах (r);
// e — кривая до следующего ключа (KF_EASES). Списки и c.kf меняются только заменой: копии клипов делят их без вреда.
// Перед показом клип ставится в позу текущего момента (kfPose): его x, y, w, h, rot становятся значениями из ключей,
// поэтому вьюпорт, рамка и панель работают как обычно. Правка этих полей мышью или в панели при следующей позе уходит в ключ (kfSync).
// Для отмены и сохранения поля с ключами берутся в позе начала клипа (kfCanon): перемотка не считается правкой.
const KF_PROPS = ['x', 'y', 'w', 'r'], KF_EASES = ['', 'in', 'out', 'inout', 'bounce'];
// те же формулы в kfEase (keyframes.go), проверка графа в keyframes_test.go
function kfEase(e, p) {
  if (e === 'in') return p * p * p;
  if (e === 'out') return 1 - Math.pow(1 - p, 3);
  if (e === 'inout') return p < .5 ? 4 * p * p * p : 1 - Math.pow(2 - 2 * p, 3) / 2;
  if (e === 'bounce') {
    const n = 7.5625, d = 2.75;
    if (p < 1 / d) return n * p * p;
    if (p < 2 / d) return n * Math.pow(p - 1.5 / d, 2) + .75;
    if (p < 2.5 / d) return n * Math.pow(p - 2.25 / d, 2) + .9375;
    return n * Math.pow(p - 2.625 / d, 2) + .984375;
  }
  return p;
}
// секунда ключа на дорожке от начала клипа (kfTrack в keyframes.go)
const kfTime = (c, s) => (c.reverse ? c.from + c.len - s : s - c.from) / c.speed;
const kfOn = (c, p) => !!(c.kf && c.kf[p] && c.kf[p].length);
const kfHas = c => !!c.kf && KF_PROPS.some(p => kfOn(c, p));
const kfList = (c, p) => (kfOn(c, p) ? c.kf[p] : []).map(k => ({t: kfTime(c, k.s), v: k.v, e: k.e || '', k})).sort((a, b) => a.t - b.t);
// значение в секунду t клипа: до первого ключа его значение, после последнего — последнего (kfAt в keyframes.go)
function kfAt(list, t) {
  for (let i = 0; i + 1 < list.length; i++) {
    const a = list[i], b = list[i + 1];
    if (t < b.t && b.t > a.t) return a.v + (b.v - a.v) * kfEase(a.e, Math.min(Math.max((t - a.t) / (b.t - a.t), 0), 1));
  }
  return list[list.length - 1].v;
}
const kfHalf = () => .5 / tkFps();
// значения рамки по полям клипа
function kfNow(c) { const b = mvBox(c); return {x: b.x + b.w / 2, y: b.y + b.h / 2, w: b.w, r: c.rot || 0}; }
function kfApply(o, v) {
  const b = mvBox(o), h = b.h * v.w / b.w;
  o.w = v.w; o.h = h; o.x = v.x - v.w / 2; o.y = v.y - h / 2;
  if (v.r) o.rot = v.r; else delete o.rot;
}
function kfValues(c, at) {
  const now = kfNow(c), t = Math.min(Math.max(at, c.at), tkEnd(c)) - c.at;
  for (const p of KF_PROPS) if (kfOn(c, p)) now[p] = kfAt(kfList(c, p), t);
  return now;
}
const kfPosed = new WeakMap();   // клип → в какую позу его поставили последний раз: {at, x, y, w, r}
// правка полей после прошлой позы уходит в ключ на месте той позы
function kfSync(c) {
  const was = kfPosed.get(c);
  if (!was || !kfHas(c)) return;
  const now = kfNow(c);
  for (const p of KF_PROPS) if (kfOn(c, p) && Math.abs(now[p] - was[p]) > 1e-7) kfPut(c, p, was.at, now[p]);
  kfPosed.set(c, {at: was.at, ...now});
}
function kfPose(c, at) {
  kfSync(c);
  if (!kfHas(c)) { kfPosed.delete(c); return; }
  at = Math.min(Math.max(at, c.at), tkEnd(c) - kfHalf());   // линия кадра не на клипе: поза и правка у ближнего края
  kfApply(c, kfValues(c, at));
  kfPosed.set(c, {at, ...kfNow(c)});
}
// все слои с ключами в момент at; выбранный слой обновляет панель
function kfPoseAll(at) {
  let mine = false;
  const one = tkOne();
  for (const tr of tkTracks) if (tr.kind === 'v') for (const c of tr.clips) if (c.kf) { kfPose(c, at); if (c === one) mine = true; }
  if (mine) kfPanel();
}
// клип для отмены и файла: поля с ключами в позе начала клипа
function kfCanon(c) {
  if (!kfHas(c)) return c;
  kfSync(c);
  const o = {...c};
  kfApply(o, kfValues(c, c.at));
  return o;
}
const kfTracks = () => tkTracks.map(tr => ({...tr, clips: tr.clips.map(kfCanon)}));
// ключ свойства p в момент at дорожки: на этом месте уже есть — новое значение, нет — новый ключ с кривой предыдущего
function kfPut(c, p, at, v) {
  const list = kfOn(c, p) ? c.kf[p] : [], t = at - c.at, half = kfHalf(), i = list.findIndex(k => Math.abs(kfTime(c, k.s) - t) < half);
  v = +v.toFixed(6);
  let next;
  if (i >= 0) next = list.map((k, j) => j === i ? {...k, v} : k);
  else {
    const prev = kfList(c, p).filter(k => k.t < t).pop();
    next = [...list, {s: +mvSrc(c, at).toFixed(4), v, ...(prev && prev.e ? {e: prev.e} : {})}].sort((a, b) => a.s - b.s);
  }
  c.kf = {...(c.kf || {}), [p]: next};
}
function kfSet(c, p, list) {
  const kf = {...(c.kf || {})};
  if (list.length) kf[p] = list; else delete kf[p];
  if (KF_PROPS.some(q => kf[q] && kf[q].length)) c.kf = kf; else delete c.kf;
}
// ключи клипа в секунду t (от начала клипа): [{p, k}]
const kfAtTime = (c, t) => KF_PROPS.flatMap(p => kfList(c, p).filter(x => Math.abs(x.t - t) < kfHalf()).map(x => ({p, k: x.k})));
function kfDrop(c, t) { for (const {p, k} of kfAtTime(c, t)) kfSet(c, p, c.kf[p].filter(x => x !== k)); }
function kfEaseSet(c, t, e) { for (const {p, k} of kfAtTime(c, t)) kfSet(c, p, c.kf[p].map(x => x === k ? {s: x.s, v: x.v, ...(e ? {e} : {})} : x)); }
// ключи из файла проекта: каждое значение проверяется
function kfLoad(kf) {
  if (!kf || typeof kf !== 'object') return {};
  const out = {};
  for (const p of KF_PROPS) {
    const list = (Array.isArray(kf[p]) ? kf[p] : []).filter(k => k && Number.isFinite(k.s) && k.s >= 0 && Number.isFinite(k.v))
      .map(k => ({s: k.s, v: p === 'w' ? Math.min(Math.max(k.v, .002), MV_MAX_BOX) : k.v, ...(KF_EASES.includes(k.e) && k.e ? {e: k.e} : {})})).sort((a, b) => a.s - b.s).slice(0, 500);
    if (list.length) out[p] = list;
  }
  return Object.keys(out).length ? {kf: out} : {};
}
// Разрез: обе части получают все ключи, анимация идёт через разрез без скачка. У фото время ключей от начала клипа:
// правая часть сдвигает их, а вместо ключей до разреза получает ключ на своём начале со значением в месте разреза.
function kfSplit(right, cut) {
  if (!right.kf || !tkPhoto(right)) return;
  const kf = {};
  for (const p of KF_PROPS) if (kfOn(right, p)) {
    const list = kfList(right, p), before = list.filter(k => k.t < cut - 1e-6).pop();
    const late = right.kf[p].filter(k => k.s >= cut - 1e-6).map(k => ({...k, s: +Math.max(k.s - cut, 0).toFixed(4)}));
    kf[p] = before && !late.some(k => k.s === 0) ? [{s: 0, v: +kfAt(list, cut).toFixed(6), ...(before.e ? {e: before.e} : {})}, ...late] : late.length ? late : [{s: 0, v: list[list.length - 1].v}];
  }
  right.kf = kf;
}

// ---------- панель: ромбик у каждого свойства рамки ----------
const KF_ROWS = {x: 'mtPosX', y: 'mtPosY', w: 'mtScale', r: 'mtRot'};
function kfPanel() {
  const c = mtFrameOne();
  if (c) kfPose(c, tkAt);
  mtFramePanel();
}
// вид ромбиков: свойство без ключей, с ключами, ключ в этом месте
function kfDiamonds() {
  const c = mtFrameOne(), dt = c ? tkAt - c.at : 0, here = c && mvUnder(c, tkAt);
  for (const p of KF_PROPS) {
    const b = $('kf_' + p);
    if (!b) continue;
    const on = !!c && kfOn(c, p), at = on && here && kfList(c, p).some(k => Math.abs(k.t - dt) < kfHalf());
    b.classList.toggle('on', on);
    b.classList.toggle('at', !!at);
    b.disabled = !c || !here;
    b.title = t(!on ? 'kf.add' : at ? 'kf.remove' : 'kf.addHere');
  }
}
function kfToggle(p) {
  const c = mtFrameOne();
  if (!c || !mvUnder(c, tkAt)) return;
  tkDo(() => {
    kfPose(c, tkAt);
    const t = tkAt - c.at, hit = kfList(c, p).find(k => Math.abs(k.t - t) < kfHalf());
    if (hit) kfSet(c, p, c.kf[p].filter(k => k !== hit.k));
    else kfPut(c, p, tkAt, kfNow(c)[p]);
    kfPose(c, tkAt);
  });
}
for (const p of KF_PROPS) {
  const row = $(KF_ROWS[p]).closest('.mt-row'), b = document.createElement('button');
  b.className = 'kf-d';
  b.id = 'kf_' + p;
  b.type = 'button';
  b.dataset.kf = p;
  b.onclick = () => kfToggle(p);   // правый клик: kfMenu через ctxItems (ctxmenu.js)
  row.classList.add('kf');
  row.appendChild(b);
}
// переход к соседнему ключу клипа: dir −1 назад, +1 вперёд; p — только этого свойства
function kfJump(c, dir, p) {
  const t = tkAt - c.at, all = (p ? [p] : KF_PROPS).flatMap(q => kfList(c, q).map(k => k.t)).filter(x => x >= -1e-6 && x <= tkLen(c) + 1e-6);
  const to = dir < 0 ? all.filter(x => x < t - kfHalf()).sort((a, b) => b - a)[0] : all.filter(x => x > t + kfHalf()).sort((a, b) => a - b)[0];
  if (to !== undefined) tkSeek(c.at + to);
}
const kfEaseName = e => ({'': t('kf.ease.line'), in: t('kf.ease.in'), out: t('kf.ease.out'), inout: t('kf.ease.inout'), bounce: t('kf.ease.bounce')})[e];
// меню ключа: кривая, удаление, переходы. p — меню ромбика одного свойства, без p — ключи всех свойств в этом месте
function kfMenu(c, at, p) {
  const keys = kfAtTime(c, at).filter(x => !p || x.p === p), cur = keys.length ? keys[0].k.e || '' : null;
  return [
    ...KF_EASES.map(e => ({label: (cur === e ? '✓ ' : '') + kfEaseName(e), off: !keys.length, run: () => tkDo(() => {
      if (p) for (const {k} of keys) kfSet(c, p, c.kf[p].map(x => x === k ? {s: x.s, v: x.v, ...(e ? {e} : {})} : x));
      else kfEaseSet(c, at, e);
    })})),
    '-',
    {label: t('kf.prev'), run: () => kfJump(c, -1, p)},
    {label: t('kf.next'), run: () => kfJump(c, 1, p)},
    '-',
    {label: t('kf.del'), off: !keys.length, run: () => tkDo(() => { if (p) kfSet(c, p, c.kf[p].filter(x => !keys.some(y => y.k === x))); else kfDrop(c, at); kfPose(c, tkAt); })},
    {label: t(p ? 'kf.delAllProp' : 'kf.delAll'), off: !(p ? kfOn(c, p) : kfHas(c)), run: () => tkDo(() => { kfPose(c, tkAt); if (p) kfSet(c, p, []); else delete c.kf; kfPosed.delete(c); })},
  ];
}

// ---------- ромбики на клипе в дорожке: щелчок ставит линию кадра на ключ, тяга двигает все ключи этого места ----------
function kfClipTimes(c) {
  const out = [];
  for (const p of KF_PROPS) for (const k of kfList(c, p)) if (k.t >= -1e-6 && k.t <= tkLen(c) + 1e-6 && !out.some(x => Math.abs(x.t - k.t) < kfHalf())) out.push({t: k.t, e: k.e});
  return out;
}
function kfPaintClip(el, c) {
  let box = el.querySelector('.tk-kfs');
  if (!box) { box = document.createElement('div'); box.className = 'tk-kfs'; el.appendChild(box); }
  const tip = t('kf.clipTip');
  const pick = kfPick && kfPick.id === c.id ? kfPick.t : null;
  const html = kfClipTimes(c).map(k => `<em class="tk-kf${pick !== null && Math.abs(pick - k.t) < kfHalf() ? ' sel' : ''}" data-t="${k.t}" title="${esc(tip)}" style="left:${Math.min(Math.max(k.t * tkPps, 8), Math.max(tkLen(c) * tkPps - 8, 8))}px"></em>`).join('');
  if (box.dataset.h !== html) { box.dataset.h = html; box.innerHTML = html; }
}
// выбранный ромбик на клипе: {id, t}. Delete удаляет ключи этого места (tkDeleteSel), щелчок мимо снимает выбор
let kfPick = null;
function kfPickSet(p) {
  kfPick = p;
  for (const tr of tkTracks) for (const c of tr.clips) { const el = tkEls.get(c.id); if (el && (c.kf || el.querySelector('.tk-kfs'))) kfPaintClip(el, c); }
}
function kfPickDrop() {
  const c = kfPick && tkById(kfPick.id), at = kfPick && kfPick.t;
  kfPickSet(null);
  if (!c || !kfAtTime(c, at).length) return false;
  tkDo(() => { kfPose(c, tkAt); kfDrop(c, at); kfPosed.delete(c); kfPose(c, tkAt); });
  return true;
}
function kfClipDrag(e, c, t0) {
  const before = tkState(), el = tkEls.get(c.id), pts = tkSnapPts(new Set([c.id])), keys = kfAtTime(c, t0), x0 = e.clientX;
  let moved = false;
  tkDrag(e, ev => {
    if (!moved && Math.abs(ev.clientX - x0) < 3) return;
    moved = true;
    let x = tkTimeAt(ev);
    x += tkSnapBy([x], pts);
    x = tkRound(Math.min(Math.max(x, c.at), tkEnd(c)));   // ключ на кадре, как и линия кадра
    const s = +mvSrc(c, x).toFixed(4);
    for (const it of keys) {   // ключи меняются заменой, it.k помнит новый
      const nk = {...it.k, s};
      kfSet(c, it.p, c.kf[it.p].map(y => y === it.k ? nk : y).sort((a, b) => a.s - b.s));
      it.k = nk;
    }
    kfPosed.delete(c);
    kfPaintClip(el, c);
    tkSeek(x);
  }, () => {
    $('tkSnapLine').classList.add('hide');
    if (moved) tkCommit(before); else tkSeek(c.at + t0);
    kfPickSet({id: c.id, t: moved ? tkAt - c.at : t0});
  });
}

// ---------- готовые анимации появления и исчезания: обычные ключи у начала или конца клипа ----------
// c.anim = {i, o}: {k, d, e} — вид (KF_ANIMS), длительность на дорожке, кривая. По ним панель показывает выбор,
// а новое применение заменяет ключи прошлого. Ключи свойства внутри отрезка анимации заменяются, ручные вне его остаются.
// Поза в конце отрезка (для исчезания — в начале) берётся из ключей и полей клипа: туда слой прилетает или оттуда улетает.
const KF_ANIMS = ['', 'left', 'right', 'top', 'bottom', 'zoom', 'spin', 'pop'];
const KF_ANIM_PROPS = {left: ['x'], right: ['x'], top: ['y'], bottom: ['y'], zoom: ['w'], spin: ['w', 'r'], pop: ['w']};
const kfAProps = a => (a && KF_ANIM_PROPS[a.k]) || [];
const kfADef = {i: {d: .5, e: 'out'}, o: {d: .5, e: 'in'}};   // длина и кривая для клипа без анимации этой стороны
let kfASide = 'i';
const kfAEnd = c => Math.max(tkLen(c) - 1 / tkFps(), 0);   // кадр, на котором исчезание кончается: последний кадр клипа
const kfAMirror = e => ({in: 'out', out: 'in'})[e] || e;
// ход анимации по свойствам: {p: [[t, v, e]]}, t — секунда клипа. Пишется как появление (доля отрезка, значение, кривая до
// следующей точки; последняя точка — поза отдыха), исчезание — то же задом наперёд с зеркальными кривыми.
function kfAPath(c, side, a, rest, end) {
  const b = mvBox(c), dims = mvCanvasDims(), rw = rest.w, rh = b.h * rw / b.w, rad = rest.r * Math.PI / 180;
  const cs = Math.abs(Math.cos(rad)), sn = Math.abs(Math.sin(rad));
  const ex = (cs * rw * dims.w + sn * rh * dims.h) / 2 / dims.w + .01, ey = (sn * rw * dims.w + cs * rh * dims.h) / 2 / dims.h + .01;   // полрамки с поворотом: слой целиком за краем
  const e = side === 'o' ? kfAMirror(a.e) : a.e, small = Math.min(.002, rw), far = {left: -ex, right: 1 + ex, top: -ey, bottom: 1 + ey}[a.k];
  const form = {};
  if (far !== undefined) { const p = a.k === 'left' || a.k === 'right' ? 'x' : 'y'; form[p] = [[0, far, e], [1, rest[p]]]; }
  if (a.k === 'zoom' || a.k === 'spin') form.w = [[0, small, e], [1, rw]];
  if (a.k === 'spin') form.r = [[0, rest.r + (side === 'o' ? 360 : -360), e], [1, rest.r]];
  if (a.k === 'pop') form.w = [[0, small, 'out'], [.6, Math.min(rw * 1.12, MV_MAX_BOX), 'inout'], [.8, rw * .96, 'inout'], [1, rw]];
  const out = {};
  for (const p in form) {
    const f = form[p];
    out[p] = side === 'i' ? f.map(([x, v, k]) => [x * a.d, v, k])
      : f.map(([x, v], j) => [end - x * a.d, v, j ? kfAMirror(f[j - 1][2]) : undefined]);
  }
  return out;
}
// поставить анимацию a ({k, d, e}) или убрать (null) у стороны side ('i' — появление, 'o' — исчезание)
function kfAnimSet(c, side, a) {
  kfPose(c, tkAt);
  const end = kfAEnd(c), half = kfHalf(), old = c.anim && c.anim[side], other = c.anim && c.anim[side === 'i' ? 'o' : 'i'];
  if (a && a.k) a = {k: a.k, d: +Math.min(Math.max(a.d, .1), Math.max(end - (other ? other.d : 0), 0)).toFixed(3), ...(a.e ? {e: a.e} : {})};
  if (a && (!a.k || a.d < 1.5 / tkFps())) a = null;   // места меньше двух кадров: анимации нет
  const d = a ? a.d : 0, D = Math.max(d, old ? Math.min(old.d, end) : 0), edge = side === 'i' ? D : end - D;
  const inZone = t => side === 'i' ? t <= D + half : t >= end - D - half;
  const now = kfNow(c), rest = {}, free = {};
  for (const p of KF_PROPS) rest[p] = kfOn(c, p) ? kfAt(kfList(c, p), edge) : now[p];
  const path = a ? kfAPath(c, side, a, rest, end) : {};
  const key = (t, v, e) => ({s: +mvSrc(c, c.at + t).toFixed(4), v: +v.toFixed(6), ...(e ? {e} : {})});
  for (const p of new Set([...kfAProps(old), ...kfAProps(a)])) {
    const list = kfList(c, p), keep = list.filter(k => !inZone(k.t)).map(k => k.k);
    const lead = side === 'i' ? (list.filter(k => k.t <= edge + half).pop() || {}).e : '';   // кривая, что шла через конец отрезка, остаётся у позы отдыха
    const add = path[p] ? path[p].map(([t, v, e], j, all) => key(t, v, side === 'i' && j === all.length - 1 ? lead : e)) : [];   // убранная анимация новых ключей не ставит
    kfSet(c, p, [...keep, ...add].sort((x, y) => x.s - y.s));
    if (!kfOn(c, p)) free[p] = rest[p];
  }
  if (Object.keys(free).length) kfApply(c, {...kfNow(c), ...free});
  const anim = {...(c.anim || {})};
  if (a) anim[side] = a; else delete anim[side];
  if (anim.i || anim.o) c.anim = anim; else delete c.anim;
  kfPosed.delete(c);
  kfPose(c, tkAt);
}
// из файла проекта
function kfAnimLoad(x) {
  if (!x || typeof x !== 'object') return {};
  const out = {};
  for (const s of ['i', 'o']) {
    const a = x[s];
    if (a && a.k && KF_ANIMS.includes(a.k) && a.d > 0 && a.d < 3600) out[s] = {k: a.k, d: a.d, ...(KF_EASES.includes(a.e) && a.e ? {e: a.e} : {})};
  }
  return out.i || out.o ? {anim: out} : {};
}

// ---------- панель: раздел «Анимация» ----------
function kfAName(side, k) {
  const i = side === 'i';
  return {'': t('anim.none'), left: t(i ? 'anim.inLeft' : 'anim.outLeft'), right: t(i ? 'anim.inRight' : 'anim.outRight'), top: t(i ? 'anim.inTop' : 'anim.outTop'),
    bottom: t(i ? 'anim.inBottom' : 'anim.outBottom'), zoom: t(i ? 'anim.inZoom' : 'anim.outZoom'), spin: t('anim.spin'), pop: t('anim.pop')}[k];
}
function kfAIcon(side, k) {
  const arrow = deg => `<g transform="rotate(${deg} 12 12)"><path d="M4 12h15M13 6l6 6-6 6"/></g>`;
  const turn = {left: [0, 180], right: [180, 0], top: [90, -90], bottom: [-90, 90]}[k];
  const body = turn ? arrow(turn[side === 'i' ? 0 : 1])
    : k === 'zoom' ? (side === 'i' ? '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>' : '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>') + '<rect x="9.5" y="9.5" width="5" height="5" rx="1"/>'
    : k === 'spin' ? '<path d="M20 11A8 8 0 1 0 17.7 17.7M20 4v7h-7"/>'
    : k === 'pop' ? '<path d="M3 20h18M4 16q4-12 8 0q4-8 8 0"/>'
    : '<circle cx="12" cy="12" r="8"/><path d="M6.5 17.5l11-11"/>';
  return `<svg viewBox="0 0 24 24">${body}</svg>`;
}
function kfATiles() {
  const box = $('mtAnimTiles');
  if (box.dataset.side === kfASide + lang) return;
  box.dataset.side = kfASide + lang;
  box.innerHTML = KF_ANIMS.map(k => { const n = esc(kfAName(kfASide, k)); return `<button type="button" class="mt-anim-t" data-k="${k}" title="${n}">${kfAIcon(kfASide, k)}<span>${n}</span></button>`; }).join('');
}
function kfAnimFill() {
  const c = mtFrameOne();
  if (!c) return;
  const a = c.anim && c.anim[kfASide], cur = a || kfADef[kfASide], sel = $('mtAnimE');
  kfATiles();
  for (const b of $('mtAnimSides').children) { b.classList.toggle('on', b.dataset.side === kfASide); b.classList.toggle('mark', !!(c.anim && c.anim[b.dataset.side])); }
  for (const b of $('mtAnimTiles').children) b.classList.toggle('on', b.dataset.k === (a ? a.k : ''));
  if (sel.dataset.lang !== lang) { sel.dataset.lang = lang; sel.innerHTML = KF_EASES.map(e => `<option value="${e}">${esc(kfEaseName(e))}</option>`).join(''); }
  sel.value = cur.e || '';
  sel.disabled = !!a && a.k === 'pop';   // у отскока свои кривые
  $('mtAnimD').max = $('mtAnimDR').max = Math.max(mtRnd(kfAEnd(c), 2), .1);
  mtVal('mtAnimD', mtRnd(cur.d, 2));
  mtSum('mtSumAnim', ['i', 'o'].filter(s => c.anim && c.anim[s]).map(s => (s === 'i' ? '↗' : '↘') + kfAName(s, c.anim[s].k)).join(' '));
}
// выбор в панели: у клипа с анимацией этой стороны меняется она, без анимации — запоминается на следующую
function kfAChange(ch) {
  const c = mtFrameOne(), a = c && c.anim && c.anim[kfASide];
  if (a) kfAnimSet(c, kfASide, {...a, ...ch});
  else { Object.assign(kfADef[kfASide], ch); kfAnimFill(); }
}
$('mtAnimSides').onclick = e => { const b = e.target.closest('[data-side]'); if (b) { kfASide = b.dataset.side; kfAnimFill(); } };
$('mtAnimTiles').onclick = e => {
  const b = e.target.closest('[data-k]'), c = mtFrameOne();
  if (!b || !c) return;
  const base = (c.anim && c.anim[kfASide]) || kfADef[kfASide];
  tkDo(() => kfAnimSet(c, kfASide, b.dataset.k ? {k: b.dataset.k, d: base.d, e: base.e} : null));
};
mtRow('mtAnimD', .02, v => kfAChange({d: v}));
$('mtAnimE').onchange = () => tkDo(() => kfAChange({e: $('mtAnimE').value}));
