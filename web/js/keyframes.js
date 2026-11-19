// ---------- ключевые кадры рамки слоя: середина, ширина и поворот меняются со временем (Keys в keyframes.go) ----------
// c.kf = {x, y, w, r, o, v}: списки ключей {s, v, e}. s — секунда файла, как у меток клипа, поэтому ключ держится за кадр при обрезке и разрезе;
// v — середина рамки в долях кадра (x, y), ширина рамки в долях кадра (w, высота в той же пропорции), поворот в градусах (r), непрозрачность 0…1 (o, поле клипа op),
// громкость 0…2 (v, поле клипа vol; единственное свойство клипа на звуковой дорожке: поза kfPose ставит vol, просмотр читает его как обычно);
// e — кривая до следующего ключа (KF_EASES). Списки и c.kf меняются только заменой: копии клипов делят их без вреда.
// Перед показом клип ставится в позу текущего момента (kfPose): его x, y, w, h, rot становятся значениями из ключей,
// поэтому вьюпорт, рамка и панель работают как обычно. Правка этих полей мышью или в панели при следующей позе уходит в ключ (kfSync).
// Для отмены и сохранения поля с ключами берутся в позе начала клипа (kfCanon): перемотка не считается правкой.
// эффекты слоя: ключ → поле клипа и пределы значения; 0 — поле не хранится
const KF_FX = {b: {f: 'blur', lo: 0, hi: .2}, sa: {f: 'shA', lo: 0, hi: 1}, sx: {f: 'shX', lo: -1, hi: 1}, sy: {f: 'shY', lo: -1, hi: 1}, sb: {f: 'shB', lo: 0, hi: .2},
  gb: {f: 'cBri', lo: -1, hi: 1}, gc: {f: 'cCon', lo: -1, hi: 1}, gm: {f: 'cMid', lo: -1, hi: 1}, gs: {f: 'cSat', lo: -1, hi: 1}, gt: {f: 'cTemp', lo: -1, hi: 1}, gn: {f: 'cTint', lo: -1, hi: 1},
  kl: {f: 'cl', lo: 0, hi: .98}, kr: {f: 'cr', lo: 0, hi: .98}, kt: {f: 'ct', lo: 0, hi: .98}, kb: {f: 'cb', lo: 0, hi: .98}};
const KF_PROPS = ['x', 'y', 'w', 'r', 'o', 'v', ...Object.keys(KF_FX)], KF_EASES = ['', 'in', 'out', 'inout', 'bounce'];
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
// Рамка есть только у клипа на видеодорожке; громкость (v) у любого: у клипа на звуковой дорожке других значений нет.
const kfVisual = c => { const tr = tkTrackOf(c); return !tr || tr.kind === 'v'; };
function kfNow(c) {
  const now = {v: c.vol ?? 1};
  if (kfVisual(c)) { const b = mvBox(c); Object.assign(now, {x: b.x + b.w / 2, y: b.y + b.h / 2, w: b.w, r: c.rot || 0, o: c.op ?? 1});
    for (const p in KF_FX) now[p] = c[KF_FX[p].f] || 0;
  }
  return now;
}
function kfApply(o, v) {
  if ('w' in v) {
    const b = mvBox(o), h = b.h * v.w / b.w;
    o.w = v.w; o.h = h; o.x = v.x - v.w / 2; o.y = v.y - h / 2;
    if (v.r) o.rot = v.r; else delete o.rot;
    if (v.o < 1) o.op = +Math.max(v.o, 0).toFixed(4); else delete o.op;
    for (const p in KF_FX) { const x = Math.min(Math.max(v[p], KF_FX[p].lo), KF_FX[p].hi); if (x) o[KF_FX[p].f] = +x.toFixed(4); else delete o[KF_FX[p].f]; }
  }
  if ('v' in v) { if (v.v !== 1) o.vol = +Math.min(Math.max(v.v, 0), 2).toFixed(4); else delete o.vol; }
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
  for (const tr of tkTracks) for (const c of tr.clips) if (c.kf) { kfPose(c, at); if (c === one) mine = true; }
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
      .map(k => ({s: k.s, v: p === 'w' ? Math.min(Math.max(k.v, .002), MV_MAX_BOX) : p === 'o' ? Math.min(Math.max(k.v, 0), 1) : p === 'v' ? Math.min(Math.max(k.v, 0), 2) : KF_FX[p] ? Math.min(Math.max(k.v, KF_FX[p].lo), KF_FX[p].hi) : k.v, ...(KF_EASES.includes(k.e) && k.e ? {e: k.e} : {})})).sort((a, b) => a.s - b.s).slice(0, 500);
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
const KF_ROWS = {x: 'mtPosX', y: 'mtPosY', w: 'mtScale', r: 'mtRot', o: 'mtOpacity', v: 'mtVolume', b: 'mtBlur', sa: 'mtShA', sx: 'mtShX', sy: 'mtShY', sb: 'mtShB',
  gb: 'mtColBri', gc: 'mtColCon', gm: 'mtColMid', gs: 'mtColSat', gt: 'mtColTemp', gn: 'mtColTint', kl: 'mtCropL', kr: 'mtCropR', kt: 'mtCropT', kb: 'mtCropB'};
// клип ромбика свойства p: громкость — один выбранный клип со звуком, остальное — слой кадра
const kfOne = p => { if (p !== 'v') return mtFrameOne(); const s = mtSoundClips(); return s.length === 1 ? s[0] : null; };
function kfPanel() {
  const c = mtFrameOne(), s = kfOne('v');
  if (c) kfPose(c, tkAt);
  if (s && s !== c) kfPose(s, tkAt);
  mtFramePanel();
  mtSoundPanel();
}
// вид ромбиков: свойство без ключей, с ключами, ключ в этом месте
function kfDiamonds() {
  for (const p of KF_PROPS) {
    const b = $('kf_' + p), c = kfOne(p), dt = c ? tkAt - c.at : 0, here = c && mvUnder(c, tkAt);
    if (!b) continue;
    const on = !!c && kfOn(c, p), at = on && here && kfList(c, p).some(k => Math.abs(k.t - dt) < kfHalf());
    b.classList.toggle('on', on);
    b.classList.toggle('at', !!at);
    b.disabled = !c || !here;
    b.title = t(!on ? 'kf.add' : at ? 'kf.remove' : 'kf.addHere');
  }
}
function kfToggle(p) {
  const c = kfOne(p);
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
// fade — проявление/затухание на ключах непрозрачности o; shake — тряска (x, y, мягко нарастает и стихает внутри отрезка);
// push — наезд камеры: ширина плавно растёт до (1 + сила) от позы отдыха и остаётся такой (поза отдыха у наезда на краю клипа, не на дальнем конце).
const KF_ANIMS = ['', 'left', 'right', 'top', 'bottom', 'zoom', 'spin', 'pop', 'fade', 'shake', 'push'];
const KF_ANIM_PROPS = {left: ['x'], right: ['x'], top: ['y'], bottom: ['y'], zoom: ['w'], spin: ['w', 'r'], pop: ['w'], fade: ['o'], shake: ['x', 'y'], push: ['w']};
const KF_ANIM_STR = ['shake', 'push'];   // у этих есть сила (a.s, 0.1…1)
const kfAProps = a => (a && KF_ANIM_PROPS[a.k]) || [];
const kfAStr = s => Number.isFinite(s) ? +Math.min(Math.max(s, .1), 1).toFixed(2) : .5;
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
  if (a.k === 'fade') form.o = [[0, 0, e], [1, rest.o]];
  const st = a.s ?? .5;
  if (a.k === 'push') { const big = Math.min(rw * (1.05 + .4 * st), MV_MAX_BOX); form.w = side === 'i' ? [[0, rw, e], [1, big]] : [[0, big, e], [1, rw]]; }
  if (a.k === 'shake') {   // ~14 рывков в секунду, размах в пикселях одинаков по обеим осям, у краёв отрезка слой на месте
    const n = Math.min(Math.max(Math.round(a.d * 14), 4), 150), ax = .06 * st, ay = ax * dims.w / dims.h;
    form.x = [[0, rest.x, '']]; form.y = [[0, rest.y, '']];
    for (let j = 1; j <= n; j++) {
      const u = j / (n + 1), env = Math.sin(Math.PI * u);
      form.x.push([u, rest.x + ax * env * (j % 2 ? 1 : -1) * (.6 + .4 * Math.abs(Math.sin(j * 2.1 + .5))), '']);
      form.y.push([u, rest.y + ay * env * Math.sin(j * 3.7 + 1) * (.6 + .4 * Math.abs(Math.cos(j * 1.3))), '']);
    }
    form.x.push([1, rest.x]); form.y.push([1, rest.y]);
  }
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
  if (a && a.k) a = {k: a.k, d: +Math.min(Math.max(a.d, .1), Math.max(end - (other ? other.d : 0), 0)).toFixed(3), ...(a.e ? {e: a.e} : {}), ...(KF_ANIM_STR.includes(a.k) ? {s: kfAStr(a.s)} : {})};
  if (a && (!a.k || a.d < 1.5 / tkFps())) a = null;   // места меньше двух кадров: анимации нет
  const d = a ? a.d : 0, D = Math.max(d, old ? Math.min(old.d, end) : 0), edge = side === 'i' ? D : end - D;
  const inZone = t => side === 'i' ? t <= D + half : t >= end - D - half;
  const now = kfNow(c), rest = {}, free = {};
  // прошлый наезд оставил на дальнем конце «увеличенную» позу, поэтому поза отдыха берётся на краю клипа, где он начинался
  const at = p => old && old.k === 'push' && p === 'w' ? (side === 'i' ? 0 : end) : edge;
  for (const p of KF_PROPS) rest[p] = kfOn(c, p) ? kfAt(kfList(c, p), at(p)) : now[p];
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
    if (a && a.k && KF_ANIMS.includes(a.k) && a.d > 0 && a.d < 3600) out[s] = {k: a.k, d: a.d, ...(KF_EASES.includes(a.e) && a.e ? {e: a.e} : {}), ...(KF_ANIM_STR.includes(a.k) ? {s: kfAStr(a.s)} : {})};
  }
  return out.i || out.o ? {anim: out} : {};
}

// ---------- панель: раздел «Анимация» ----------
function kfAName(side, k) {
  const i = side === 'i';
  return {'': t('anim.none'), left: t(i ? 'anim.inLeft' : 'anim.outLeft'), right: t(i ? 'anim.inRight' : 'anim.outRight'), top: t(i ? 'anim.inTop' : 'anim.outTop'),
    bottom: t(i ? 'anim.inBottom' : 'anim.outBottom'), zoom: t(i ? 'anim.inZoom' : 'anim.outZoom'), spin: t('anim.spin'), pop: t('anim.pop'),
    fade: t(i ? 'anim.inFade' : 'anim.outFade'), shake: t('anim.shake'), push: t('anim.push')}[k];
}
function kfAIcon(side, k) {
  const arrow = deg => `<g transform="rotate(${deg} 12 12)"><path d="M4 12h15M13 6l6 6-6 6"/></g>`;
  const turn = {left: [0, 180], right: [180, 0], top: [90, -90], bottom: [-90, 90]}[k];
  const body = turn ? arrow(turn[side === 'i' ? 0 : 1])
    : k === 'zoom' ? (side === 'i' ? '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>' : '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>') + '<rect x="9.5" y="9.5" width="5" height="5" rx="1"/>'
    : k === 'spin' ? '<path d="M20 11A8 8 0 1 0 17.7 17.7M20 4v7h-7"/>'
    : k === 'pop' ? '<path d="M3 20h18M4 16q4-12 8 0q4-8 8 0"/>'
    : k === 'fade' ? '<rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="2 3"/><path d="M' + (side === 'i' ? '4 20L20 4' : '4 4L20 20') + '"/>'
    : k === 'shake' ? '<path d="M3 12l3-5 3 10 3-10 3 10 3-10 3 5"/>'
    : k === 'push' ? '<rect x="3" y="6" width="18" height="12" rx="1.5"/><rect x="8" y="9" width="8" height="6" rx="1"/><path d="M3 3l4 4M21 3l-4 4M3 21l4-4M21 21l-4-4"/>'
    : '<circle cx="12" cy="12" r="8"/><path d="M6.5 17.5l11-11"/>';
  return `<svg viewBox="0 0 24 24">${body}</svg>`;
}
function kfATiles() {
  const box = $('mtAnimTiles');
  if (box.dataset.side === kfASide + lang) return;
  box.dataset.side = kfASide + lang;
  box.innerHTML = KF_ANIMS.map(k => { const n = esc(kfAName(kfASide, k)); return `<button type="button" class="mt-anim-t" data-k="${k}" title="${n}">${kfAIcon(kfASide, k)}<span>${n}</span></button>`; }).join('');
}
// Раздел работает с одним клипом и с несколькими выбранными. Показывает общее: одинаковое у всех — значение, разное — пусто.
// У нескольких клипов выбор плитки меняет их все за один шаг отмены.
const kfAClips = () => mtFrameClips();
const kfAOf = (c, side) => c.anim && c.anim[side];
// общий вид и общее значение поля у всех клипов, где есть анимация этой стороны
const kfACommon = (clips, side, f) => { const a0 = kfAOf(clips[0], side); if (!a0) return undefined; const v = f(a0); return clips.every(c => kfAOf(c, side) && f(kfAOf(c, side)) === v) ? v : undefined; };
function kfAnimFill() {
  const clips = kfAClips();
  if (!clips.length) return;
  const sel = $('mtAnimE'), kind = kfACommon(clips, kfASide, a => a.k);
  const dd = kfACommon(clips, kfASide, a => a.d), ee = kfACommon(clips, kfASide, a => a.e || ''), ss = kfACommon(clips, kfASide, a => a.s ?? .5);
  const cur = clips.every(c => kfAOf(c, kfASide)) ? {d: dd ?? '', e: ee ?? '', s: ss ?? ''} : {...kfADef[kfASide], s: kfADef[kfASide].s ?? .5};
  kfATiles();
  for (const b of $('mtAnimSides').children) { b.classList.toggle('on', b.dataset.side === kfASide); b.classList.toggle('mark', clips.some(c => kfAOf(c, b.dataset.side))); }
  for (const b of $('mtAnimTiles').children) b.classList.toggle('on', b.dataset.k === (kind || ''));
  if (sel.dataset.lang !== lang) { sel.dataset.lang = lang; sel.innerHTML = KF_EASES.map(e => `<option value="${e}">${esc(kfEaseName(e))}</option>`).join(''); }
  sel.value = cur.e || '';
  sel.disabled = kind === 'pop' || kind === 'shake';   // у отскока и тряски свои кривые
  $('mtAnimSRow').classList.toggle('hide', !clips.every(c => KF_ANIM_STR.includes((kfAOf(c, kfASide) || {}).k)));
  $('mtAnimD').max = $('mtAnimDR').max = Math.max(mtRnd(Math.min(...clips.map(kfAEnd)), 2), .1);
  mtVal('mtAnimD', cur.d === '' ? '' : mtRnd(cur.d, 2));
  mtVal('mtAnimS', cur.s === '' ? '' : Math.round(cur.s * 100));
  const sum = clips.length === 1 ? ['i', 'o'].filter(s => kfAOf(clips[0], s)).map(s => (s === 'i' ? '↗' : '↘') + kfAName(s, kfAOf(clips[0], s).k)).join(' ')
    : ['i', 'o'].filter(s => clips.some(c => kfAOf(c, s))).map(s => s === 'i' ? '↗' : '↘').join(' ');
  mtSum('mtSumAnim', sum);
}
// выбор в панели: у клипов с анимацией этой стороны меняется она, остальным ничего не ставится, а значение запоминается на следующую
function kfAChange(ch) {
  const clips = kfAClips();
  let plain = false;
  for (const c of clips) {
    const a = kfAOf(c, kfASide);
    if (a) kfAnimSet(c, kfASide, {...a, ...ch}); else plain = true;
  }
  if (plain) { const {s, ...rest} = ch; Object.assign(kfADef[kfASide], rest, s === undefined ? {} : {s}); }
  kfAnimFill();
}
$('mtAnimSides').onclick = e => { const b = e.target.closest('[data-side]'); if (b) { kfASide = b.dataset.side; kfAnimFill(); } };
$('mtAnimTiles').onclick = e => {
  const b = e.target.closest('[data-k]'), clips = kfAClips();
  if (!b || !clips.length) return;
  const k = b.dataset.k, side = kfASide;
  // общие длина, кривая и сила, если у всех клипов они одинаковые, иначе запомненные
  const all = clips.every(c => kfAOf(c, side)), same = f => all ? kfACommon(clips, side, f) : undefined;
  const base = {d: same(a => a.d) ?? kfADef[side].d, e: same(a => a.e || '') ?? kfADef[side].e, s: same(a => a.s ?? .5) ?? kfADef[side].s ?? .5};
  tkDo(() => {
    for (const c of clips) {
      const cur = kfAOf(c, side);
      const d = k === 'push' && !(cur && cur.k === 'push') ? kfAEnd(c) : base.d;   // наезд по умолчанию на весь клип
      kfAnimSet(c, side, k ? {k, d, e: base.e, ...(KF_ANIM_STR.includes(k) ? {s: base.s} : {})} : null);
    }
  });
};
mtRow('mtAnimD', .02, v => kfAChange({d: v}));
mtRow('mtAnimS', 1, v => kfAChange({s: v / 100}));
$('mtAnimE').onchange = () => tkDo(() => kfAChange({e: $('mtAnimE').value}));
