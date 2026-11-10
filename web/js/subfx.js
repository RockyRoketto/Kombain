// Плитки помечены data-fx: data-k занят форматами конвертера (applyKind в settings.js прячет такие элементы).
// Эффекты субтитров: один эффект сразу на все реплики, хранится в tkSubs.fx: печатная машинка (k: 'type'), по слову (k: 'word').
// Расчёт тот же, что subsFxStep, subsFxState, subsFxWordTimes и subsFxPeak в subtitles.go: просмотр не должен расходиться с вжиганием.
// Настройки всех эффектов лежат вместе: выбрал другой эффект и вернулся — свои настройки на месте.
const SUBFX_CPS = 20, SUBFX_BLINK = .5, SUBFX_END = .85, SUBFX_CUR_W = .06;   // ширина курсора от высоты строки, как subsFxCurW
const SUBFX_DUR = .3, SUBFX_BOUNCE = .15, SUBFX_PEAK = .6;   // как subsFxDur, subsFxPeak; отскок по умолчанию при первом выборе
function subFxLoad(f) {
  return {k: ['type', 'word'].includes(f.k) ? f.k : '', ...(f.cps >= 1 && f.cps <= 100 ? {cps: f.cps} : {}),
    cur: /^#[0-9a-f]{6}$/i.test(f.cur) ? f.cur : '', blink: f.blink === true,
    ...(f.dur >= .1 && f.dur <= .6 ? {dur: f.dur} : {}), ...(f.bounce >= 0 && f.bounce <= .3 ? {bounce: f.bounce} : {})};
}
// отскок «по слову», если он включён: на него строки стоят дальше друг от друга (распорки в subsFxWord)
const subFxBounce = s => s && s.fx && s.fx.k === 'word' ? s.fx.bounce || 0 : 0;
// ---------- по слову ----------
// слова как \S+ в Go (RE2): пробелом считаются только эти пять знаков
const SUBFX_WORD = /[^\t\n\f\r ]+/g;
// Зеркало subsFxWordHeads в subtitles.go: какие слова появляются одним толчком. Для каждого слова — номер первого слова его группы.
// Слово только из знаков (тире тоже) липнет к предыдущему; короткое служебное (1–2 буквы или из SUBFX_GLUE,
// без знака после букв) — к следующему. Правила менять в обоих местах.
// SUBFX_GLUE: для без над под при про или the and for with (кириллица кодами: в js её вне словаря тест не пускает)
const SUBFX_GLUE = ['\u0434\u043b\u044f', '\u0431\u0435\u0437', '\u043d\u0430\u0434', '\u043f\u043e\u0434', '\u043f\u0440\u0438', '\u043f\u0440\u043e', '\u0438\u043b\u0438', 'the', 'and', 'for', 'with'];
function subFxWordHeads(words) {
  const heads = [];
  let forward = false;   // предыдущее слово просит следующее в свою группу
  words.forEach((w, i) => {
    const punct = /^[\p{P}\p{S}]+$/u.test(w);
    heads.push(i > 0 && (punct || forward) ? heads[i - 1] : i);
    if (!punct || i === 0) {
      const core = w.replace(/^[^\p{L}\p{N}]+/u, '');
      forward = punct || (/^[\p{P}\p{S}]*[\p{L}\p{N}]+$/u.test(w) && ([...core].length <= 2 || SUBFX_GLUE.includes(core.toLowerCase())));
    }
  });
  return heads;
}
// начала слов в секундах от начала реплики: время whisper (c.w), если слов столько же, иначе равномерно по буквам.
// Слова группы (subFxWordHeads) берут время её первого слова
function subFxWordTimes(c, words) {
  const dur = c.b - c.a, letters = words.map(w => [...w].length), total = letters.reduce((s, n) => s + n, 0), own = Array.isArray(c.w) && c.w.length === words.length;
  let before = 0;
  const out = [];
  words.forEach((w, i) => {
    let v = own ? c.w[i] - c.a : total ? SUBFX_END * dur * before / total : 0;
    before += letters[i];
    v = Math.min(Math.max(v, 0), SUBFX_END * dur);
    out.push(i ? Math.max(v, out[i - 1]) : v);
  });
  return subFxWordHeads(words).map(h => out[h]);
}
// масштаб слова через u секунд от его начала; до начала null — слова не видно, но место держит.
// Рост до 1+bounce за SUBFX_PEAK долю времени, потом обратно к 1; без отскока сразу до 1. Ускорение как subsFxAccel: k = доля^0,5
function subFxWordAt(fx, u) {
  if (u < 0) return null;
  const d = fx.dur || SUBFX_DUR, b = fx.bounce || 0, p = b > 0 ? SUBFX_PEAK * d : d;
  if (u < p) return (1 + b) * Math.sqrt(u / p);
  return u >= d ? 1 : 1 + b - b * Math.sqrt((u - p) / (d - p));
}
// span по словам: каждое слово inline-block (переносится как обычное слово, transform не двигает строку),
// между ними обычный текст. Состав перестраивается при смене реплик, вид слов — каждый кадр.
function subFxWordPaint(span, cues, line, fx, at) {
  const key = 'w' + JSON.stringify(cues.map(c => [c.a, c.b, line(c), c.w]));
  if (span.dataset.k !== key) {
    span.dataset.k = key;
    span.textContent = '';
    cues.forEach((c, n) => {
      if (n) span.append('\n');
      const text = line(c), words = text.match(SUBFX_WORD) || [], times = subFxWordTimes(c, words);
      let from = 0, i = 0;
      for (const m of text.matchAll(SUBFX_WORD)) {
        span.append(text.slice(from, m.index));
        const b = document.createElement('b');
        b.className = 'mv-subs-w';
        b.textContent = m[0];
        b.dataset.at = c.a + times[i++];
        span.append(b);
        from = m.index + m[0].length;
      }
      span.append(text.slice(from));
    });
  }
  for (const b of span.querySelectorAll('.mv-subs-w')) {
    const s = subFxWordAt(fx, at - b.dataset.at);
    b.style.transform = s === null || s === 1 ? '' : `scale(${s})`;
    b.style.opacity = s === null ? 0 : '';
  }
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
  mtSum('mtSumSubsFx', {type: t('mt.fxType'), word: t('mt.fxWord')}[fx.k] || '');
  $('mtSubsFxType').classList.toggle('hide', fx.k !== 'type');
  $('mtSubsFxWord').classList.toggle('hide', fx.k !== 'word');
  mtVal('mtSubsWDur', fx.dur || SUBFX_DUR);
  mtVal('mtSubsBounce', Math.round((fx.bounce || 0) * 100));
  mtVal('mtSubsCps', fx.cps || SUBFX_CPS);
  $('mtSubsCurOn').checked = !!fx.cur;
  $('mtSubsCurBody').classList.toggle('hide', !fx.cur);
  if (fx.cur) $('mtSubsCur').value = fx.cur;
  $('mtSubsBlink').checked = !!fx.blink;
}
const subFxSet = patch => { if (tkSubs) tkDo(() => { tkSubs = {...tkSubs, fx: {...(tkSubs.fx || {}), ...patch}}; }); };
// первый выбор машинки: курсор цвета текста, мигает; первый выбор «по слову»: 0,3 с, отскок 15%. Дальше настройки запоминаются и при выключении эффекта.
$('mtSubsFx').addEventListener('click', e => {
  const b = e.target.closest('[data-fx]');
  if (!b || !tkSubs) return;
  const k = b.dataset.fx, fx = tkSubs.fx || {};
  if (k === 'type' && !('cps' in fx)) subFxSet({k, cps: SUBFX_CPS, cur: tkSubs.color || '#ffffff', blink: true});
  else if (k === 'word' && !('bounce' in fx)) subFxSet({k, dur: fx.dur || SUBFX_DUR, bounce: SUBFX_BOUNCE});
  else subFxSet({k});
});
mtRow('mtSubsWDur', .005, v => mtSubsLive({fx: {...(tkSubs.fx || {}), dur: Math.round(Math.min(Math.max(v, .1), .6) * 100) / 100}}));
mtRow('mtSubsBounce', .25, v => mtSubsLive({fx: {...(tkSubs.fx || {}), bounce: Math.round(Math.min(Math.max(v, 0), 30)) / 100}}));
$('mtSubsCurOn').addEventListener('change', () => { $('mtSubsCurOn').blur(); subFxSet({cur: $('mtSubsCurOn').checked ? $('mtSubsCur').value : ''}); });
$('mtSubsCur').addEventListener('change', () => subFxSet({cur: $('mtSubsCur').value}));
$('mtSubsBlink').addEventListener('change', () => subFxSet({blink: $('mtSubsBlink').checked}));
mtRow('mtSubsCps', .25, v => mtSubsLive({fx: {...(tkSubs.fx || {}), cps: Math.round(Math.min(Math.max(v, 1), 100))}}));
