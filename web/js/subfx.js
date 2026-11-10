// Плитки помечены data-fx: data-k занят форматами конвертера (applyKind в settings.js прячет такие элементы).
// Эффекты субтитров: один эффект сразу на все реплики, хранится в tkSubs.fx. Пока есть печатная машинка (k: 'type').
// Расчёт тот же, что subsFxStep и subsFxState в subtitles.go: просмотр не должен расходиться с вжиганием.
const SUBFX_CPS = 20, SUBFX_BLINK = .5, SUBFX_END = .85, SUBFX_CUR_W = .06;   // ширина курсора от высоты строки, как subsFxCurW
function subFxLoad(f) {
  return {k: f.k === 'type' ? 'type' : '', ...(f.cps >= 1 && f.cps <= 100 ? {cps: f.cps} : {}),
    cur: /^#[0-9a-f]{6}$/i.test(f.cur) ? f.cur : '', blink: f.blink === true};
}
// время на одну букву: не успевает к SUBFX_END длины реплики — печатает быстрее
function subFxStep(fx, n, dur) { return n > 0 ? Math.min(1 / (fx.cps || SUBFX_CPS), SUBFX_END * dur / n) : dur; }
// сколько букв видно через t секунд от начала реплики и виден ли курсор. Первая буква сразу.
function subFxState(fx, n, dur, t) {
  // 1e-9: ровно на границе буквы деление дробей даёт 13,999…, и буква опоздала бы
  return [Math.min(n, Math.floor(t / subFxStep(fx, n, dur) + 1e-9) + 1), !!fx.cur && (!fx.blink || Math.floor(t / SUBFX_BLINK + 1e-9) % 2 === 0)];
}
// реплика в момент at: напечатанное, курсор (1 виден, -1 спрятан, 0 нет), ненапечатанное — оно спрятано, но держит место, строка не прыгает
function subFxParts(fx, c, text, at) {
  const r = [...text], n = r.filter(x => x !== '\n').length, [k, on] = subFxState(fx, n, c.b - c.a, at - c.a);
  let cut = 0;
  for (let seen = 0; cut < r.length && seen < k; cut++) if (r[cut] !== '\n') seen++;
  return {shown: r.slice(0, cut).join(''), cur: fx.cur ? (on ? 1 : -1) : 0, rest: r.slice(cut).join('')};
}
// span субтитров во вьюпорте по частям реплик (mvSubsDraw)
function subFxPaint(span, parts, fx) {
  span.textContent = '';
  parts.forEach((p, i) => {
    if (i) span.append('\n');
    span.append(p.shown);
    // курсор нулевой ширины (как полоска с \fsp в subsFxType): пустой строчный элемент, рамка слева и такой же минус справа.
    // Не символ и не inline-block: на них браузер может перенести строку посреди слова.
    if (p.cur > 0) { const b = document.createElement('b'); b.className = 'mv-subs-cur'; b.style.borderLeftColor = fx.cur; span.append(b); }
    if (p.rest) { const e = document.createElement('em'); e.className = 'mv-subs-hid'; e.textContent = p.rest; span.append(e); }
  });
}
function subFxFill() {
  const s = tkSubs;
  if (!s) return;
  const fx = s.fx || {};
  for (const b of $('mtSubsFx').children) b.classList.toggle('on', b.dataset.fx === (fx.k || ''));
  mtSum('mtSumSubsFx', fx.k === 'type' ? t('mt.fxType') : '');
  $('mtSubsFxType').classList.toggle('hide', fx.k !== 'type');
  mtVal('mtSubsCps', fx.cps || SUBFX_CPS);
  $('mtSubsCurOn').checked = !!fx.cur;
  $('mtSubsCurBody').classList.toggle('hide', !fx.cur);
  if (fx.cur) $('mtSubsCur').value = fx.cur;
  $('mtSubsBlink').checked = !!fx.blink;
}
const subFxSet = patch => { if (tkSubs) tkDo(() => { tkSubs = {...tkSubs, fx: {...(tkSubs.fx || {}), ...patch}}; }); };
// первый выбор машинки: курсор цвета текста, мигает. Дальше настройки запоминаются и при выключении эффекта.
$('mtSubsFx').addEventListener('click', e => {
  const b = e.target.closest('[data-fx]');
  if (!b || !tkSubs) return;
  const k = b.dataset.fx, fx = tkSubs.fx || {};
  subFxSet(k && !('cps' in fx) ? {k, cps: SUBFX_CPS, cur: tkSubs.color || '#ffffff', blink: true} : {k});
});
$('mtSubsCurOn').addEventListener('change', () => { $('mtSubsCurOn').blur(); subFxSet({cur: $('mtSubsCurOn').checked ? $('mtSubsCur').value : ''}); });
$('mtSubsCur').addEventListener('change', () => subFxSet({cur: $('mtSubsCur').value}));
$('mtSubsBlink').addEventListener('change', () => subFxSet({blink: $('mtSubsBlink').checked}));
mtRow('mtSubsCps', .25, v => mtSubsLive({fx: {...(tkSubs.fx || {}), cps: Math.round(Math.min(Math.max(v, 1), 100))}}));
