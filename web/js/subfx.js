// Плитки помечены data-fx: data-k занят форматами конвертера (applyKind в settings.js прячет такие элементы).
// Эффекты субтитров: один эффект сразу на все реплики, хранится в tkSubs.fx: печатная машинка (k: 'type'), по слову (k: 'word').
// Расчёт тот же, что subsFxStep, subsFxState, subsFxWordTimes и subsFxPeak в subtitles.go: просмотр не должен расходиться с вжиганием.
// Настройки всех эффектов лежат вместе: выбрал другой эффект и вернулся — свои настройки на месте.
const SUBFX_CPS = 20, SUBFX_BLINK = .5, SUBFX_END = .85, SUBFX_CUR_W = .06;   // ширина курсора от высоты строки, как subsFxCurW
const SUBFX_DUR = .3, SUBFX_BOUNCE = .15, SUBFX_PEAK = .6;   // как subsFxDur, subsFxPeak; отскок по умолчанию при первом выборе
function subFxLoad(f) {
  return {k: ['type', 'word', 'kar', 'act'].includes(f.k) ? f.k : '', ...(f.cps >= 1 && f.cps <= 100 ? {cps: f.cps} : {}),
    ...(/^#[0-9a-f]{6}$/i.test(f.hi) ? {hi: f.hi} : {}), ...(f.big >= 0 && f.big <= .3 ? {big: f.big} : {}), keep: f.keep === true, soft: f.soft === true,
    cur: /^#[0-9a-f]{6}$/i.test(f.cur) ? f.cur : '', blink: f.blink === true,
    ...(f.dur >= .1 && f.dur <= .6 ? {dur: f.dur} : {}), ...(f.bounce >= 0 && f.bounce <= .3 ? {bounce: f.bounce} : {}),
    ...(['grow', 'jump', 'fill'].includes(f.m) ? {m: f.m} : {}), ...(/^#[0-9a-f]{6}$/i.test(f.pill) ? {pill: f.pill} : {}),
    ...(/^#[0-9a-f]{6}$/i.test(f.on) ? {on: f.on} : {}), ...(f.r >= 0 && f.r <= 1 ? {r: f.r} : {}), smooth: f.smooth === true};
}
// ---------- куски («Слов на экране») ----------
// Зеркало subs_chunks.go: реплики режутся на короткие куски, каждый — своя реплика {a, b, t, w}, эффект работает на нём как обычно.
// chunk: 0 — целиком, 1–3 — не больше стольких слов, -1 — авто (паузы, знаки, длина). Числа и правила менять в обоих местах.
const SUBCH = {words: 3, chars: 16, pause: .3, letter: .07, long: .6, end: '.!?…', soft: ',;:'};
function subChunkTimes(c, words) {
  const n = words.length, dur = c.b - c.a, own = Array.isArray(c.w) && c.w.length === n, total = words.reduce((s, w) => s + [...w].length, 0), out = [];
  let before = 0;
  words.forEach((w, i) => {
    let v = own ? c.w[i] - c.a : total ? dur * before / total : 0;
    before += [...w].length;
    v = Math.min(Math.max(v, 0), dur);
    out.push(i ? Math.max(v, out[i - 1]) : v);
  });
  return out;
}
const subEndsWith = (w, set) => set.includes([...w].pop());
function subChunks(cues, mode) {
  if (!mode) return cues;
  const limit = mode < 0 ? SUBCH.words : mode, out = [];
  for (const c of cues) {
    const words = c.t.split(/\s+/).filter(Boolean);
    if (!words.length || c.b <= c.a) { out.push(c); continue; }
    const at = subChunkTimes(c, words), heads = subFxWordHeads(words), own = Array.isArray(c.w) && c.w.length === words.length, ps = [];
    for (let i = 0; i < words.length;) {
      let j = i + 1;
      while (j < words.length && heads[j] === heads[i]) j++;
      if (j - i > Math.max(limit, 2)) j = i + 2 - (j - i) % 2;   // длинная цепочка коротких слов — парами с конца
      const p = ps[ps.length - 1];
      if (p) {
        const last = words[p.to - 1];
        let cut = p.to - p.from + j - i > limit || subEndsWith(last, SUBCH.end);
        if (mode < 0 && !cut) {
          const sound = Math.min(SUBCH.letter * [...last].length, SUBCH.long);
          cut = [...words.slice(p.from, j).join(' ')].length > SUBCH.chars || subEndsWith(last, SUBCH.soft) || own && at[i] - at[p.to - 1] - sound >= SUBCH.pause;
        }
        if (!cut || at[i] <= at[p.from]) { p.to = j; i = j; continue; }
      }
      ps.push({from: i, to: j});
      i = j;
    }
    ps.forEach((p, k) => out.push({a: k ? c.a + at[p.from] : c.a, b: k + 1 < ps.length ? c.a + at[ps[k + 1].from] : c.b,
      t: words.slice(p.from, p.to).join(' '), ...(own ? {w: c.w.slice(p.from, p.to)} : {})}));
  }
  return out;
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
// ---------- караоке ----------
// Зеркало subs_karaoke.go: куски, их время, перенос строк, плашки. Режимы m: grow, jump, fill; smooth — плавно (grow и fill).
const SUBFX_KAR = {pill: '#e9b872', on: '#1b1b1b', r: .5}, SUBFX_SLIDE = .12, SUBFX_LAST = .6, SUBFX_PADX = .15, SUBFX_PADY = .03;
const subFxKarSmooth = fx => !!fx.smooth && fx.m !== 'jump';
// куски: слово или группа subFxWordHeads в пределах одной строки текста; t — начало от начала реплики, d — время перехода
function subFxKarChunks(c, text, smooth) {
  const ms = [...text.matchAll(SUBFX_WORD)], words = ms.map(m => m[0]), at = subFxWordTimes(c, words), heads = subFxWordHeads(words), out = [];
  let para = 0, prevEnd = 0;
  ms.forEach((m, i) => {
    const p = para + (text.slice(prevEnd, m.index).match(/\n/g) || []).length;
    prevEnd = m.index + m[0].length;
    if (i && heads[i] !== i && p === para) { const k = out[out.length - 1]; k.to = prevEnd; k.text += ' ' + words[i]; return; }
    para = p;
    out.push({from: m.index, to: prevEnd, text: words[i], para: p, t: at[i], line: 0, x0: 0, x1: 0});
  });
  const dur = c.b - c.a;
  out.forEach((k, i) => {
    const next = out.slice(i + 1).find(n => n.t > k.t), gap = next ? next.t - k.t : Math.max(Math.min(dur - k.t, SUBFX_LAST), .01);
    k.d = smooth ? gap : Math.min(SUBFX_SLIDE, gap);
  });
  return out;
}
// перенос как subsKarBreak: число строк жадно, потом самая узкая ширина с тем же числом строк. Возвращает начала строк
function subFxKarBreak(w, space, limit) {
  const greedy = l => {
    const starts = [0];
    let cur = 0;
    w.forEach((v, i) => {
      if (i && cur + space + v > l + 1e-6) { starts.push(i); cur = v; return; }
      cur += (i ? space : 0) + v;
    });
    return starts;
  };
  const n = greedy(limit).length;
  let lo = Math.max(0, ...w), hi = limit;
  if (hi < lo) return greedy(lo);
  for (let it = 0; it < 24; it++) { const mid = (lo + hi) / 2; if (greedy(mid).length <= n) hi = mid; else lo = mid; }
  return greedy(hi);
}
const subFxKarEase = (p, smooth) => { p = Math.min(Math.max(p, 0), 1); return smooth ? p : 1 - (1 - p) ** 3; };
// плашки в момент u от начала реплики: [{line, a, b}], как subsKarPills
function subFxKarPills(ch, m, smooth, u, pad) {
  let cur = -1;
  ch.forEach((k, i) => { if (k.t <= u) cur = i; });
  if (cur < 0) return [];
  let prev = -1;
  for (let j = cur - 1; j >= 0; j--) if (ch[j].t < ch[cur].t) { prev = j; break; }
  const c = ch[cur], k = subFxKarEase((u - c.t) / c.d, smooth && m === 'grow'), lerp = (x, y) => x + (y - x) * k;
  const a1 = c.x0 - pad, b1 = c.x1 + pad;
  if (m === 'jump') {
    let a0 = (a1 + b1) / 2, b0 = a0;
    if (prev >= 0 && ch[prev].line === c.line) { a0 = ch[prev].x0 - pad; b0 = ch[prev].x1 + pad; }
    return [{line: c.line, a: lerp(a0, a1), b: lerp(b0, b1)}];
  }
  const first = {}, out = [];
  for (let i = 0; i <= cur; i++) if (!(ch[i].line in first)) first[ch[i].line] = i;
  for (let i = 0; i <= cur; i++) if (ch[i].line !== c.line && (i === cur || ch[i + 1].line !== ch[i].line)) out.push({line: ch[i].line, a: ch[first[ch[i].line]].x0 - pad, b: ch[i].x1 + pad});
  const a = ch[first[c.line]].x0 - pad, b0 = prev >= 0 && ch[prev].line === c.line ? ch[prev].x1 + pad : a;
  out.push({line: c.line, a, b: lerp(b0, b1)});
  return out;
}
// перекрашено ли слово куска i в момент u (по словам): как subsKarOn
function subFxKarIsOn(ch, m, i, u) {
  const on = ch[i].t + ch[i].d / 2, off = m === 'jump' && i + 1 < ch.length ? ch[i + 1].t + ch[i + 1].d / 2 : Infinity;
  return u >= on && u < off;
}
const subFxKarMeasure = font => {
  const g = (subFxKarMeasure.g ||= document.createElement('canvas').getContext('2d'));
  g.font = `${100 / mvSubLine(font)}px "${font}"`;
  return s => g.measureText(s).width / 100;   // в высотах строки, как textWidth / size
};
const subFxKarEl = (k, cls) => { const b = document.createElement('b'); b.className = cls; b.textContent = b.dataset.t = k.text; k.el = b; return b; };
// куски реплик в span, строки переносит программа (white-space: pre), как subsKarLayout: каждая строка текста отдельно по ширине рамки.
// Кусок — <b class=cls>, k.el и k.line. В span._kar — [{c, ch}]. Общая для караоке и «Активного слова».
function subFxKarLay(span, cues, line, s, smooth, cls) {
  const measure = subFxKarMeasure(s.font), sp = measure('a b') - measure('ab'), limit = (s.w || .9) * mvCv.clientWidth / (s.size * mvCv.clientHeight);
  span._kar = [];
  cues.forEach((c, n) => {
    if (n) span.append('\n');
    const ch = subFxKarChunks(c, line(c), smooth);
    span._kar.push({c, ch});
    let ln = 0;
    for (let i = 0; i < ch.length;) {
      let j = i;
      while (j < ch.length && ch[j].para === ch[i].para) j++;
      const starts = [...subFxKarBreak(ch.slice(i, j).map(k => measure(k.text)), sp, limit), j - i];
      for (let r = 0; r + 1 < starts.length; r++) {
        if (ln) span.append('\n');
        for (let q = i + starts[r]; q < i + starts[r + 1]; q++) { if (q > i + starts[r]) span.append(' '); ch[q].line = ln; span.append(subFxKarEl(ch[q], cls)); }
        ln++;
      }
      i = j;
    }
  });
}
// span караоке: куски — <b class="mv-subs-k">. Плашки в слое <u> под текстом (span — свой слой, z-index), строки переносит сама программа
// (white-space: pre), как subsFxKar. Заливка: перенос обычный, буквы красит ::after с обрезкой --kp.
function subFxKarPaint(span, cues, line, fx, at, s) {
  const m = fx.m || 'jump', smooth = subFxKarSmooth(fx), cw = mvCv.clientWidth, chh = mvCv.clientHeight;
  const key = 'k' + JSON.stringify([cues.map(c => [c.a, c.b, line(c), c.w]), m, smooth, s.font, s.w, s.size, m === 'fill' ? 0 : Math.round(cw / chh * 1000)]);
  if (span.dataset.k !== key) {
    span.dataset.k = key;
    span.textContent = '';
    span.classList.toggle('mv-subs-kar', m !== 'fill');
    if (m !== 'fill') { const u = document.createElement('u'); u.className = 'mv-subs-pl'; span.append(u); subFxKarLay(span, cues, line, s, smooth, 'mv-subs-k'); }
    else {
      span._kar = [];
      cues.forEach((c, n) => {
        if (n) span.append('\n');
        const text = line(c), ch = subFxKarChunks(c, text, smooth);
        span._kar.push({c, ch});
        let from = 0;
        ch.forEach(k => { span.append(text.slice(from, k.from), subFxKarEl(k, 'mv-subs-k')); from = k.to; });
        span.append(text.slice(from));
      });
    }
  }
  const size = s.size * chh, layer = span.querySelector('.mv-subs-pl');
  const o = layer && layer.getBoundingClientRect(), html = [];
  for (const {c, ch} of span._kar || []) {
    const u = at - c.a;
    if (m === 'fill') {
      for (const k of ch) k.el.style.setProperty('--kp', subFxKarEase((u - k.t) / k.d, smooth) * 100 + '%');
      continue;
    }
    const tops = {};
    for (const k of ch) {
      const r = k.el.getBoundingClientRect();
      k.x0 = r.left - o.left; k.x1 = r.right - o.left;
      tops[k.line] = r.top - o.top + (r.height - size) / 2;
    }
    for (const p of subFxKarPills(ch, m, smooth, u, SUBFX_PADX * size)) {
      if (p.b - p.a < .5) continue;
      const h = size * (1 - 2 * SUBFX_PADY);
      html.push(`<div style="left:${p.a}px;top:${tops[p.line] + SUBFX_PADY * size}px;width:${p.b - p.a}px;height:${h}px;border-radius:${Math.min((fx.r ?? SUBFX_KAR.r) * h / 2, (p.b - p.a) / 2)}px;background:${fx.pill || SUBFX_KAR.pill}"></div>`);
    }
    ch.forEach((k, i) => {
      const on = smooth ? u >= k.t + k.d : subFxKarIsOn(ch, m, i, u);
      k.el.style.color = on && !smooth ? fx.on || SUBFX_KAR.on : '';
      k.el.style.webkitTextStrokeColor = on ? fx.pill || SUBFX_KAR.pill : '';
      if (smooth) k.el.style.setProperty('--kp', subFxKarEase((u - k.t) / k.d, true) * 100 + '%');
      else k.el.style.removeProperty('--kp');
    });
  }
  if (layer) { const v = html.join(''); if (layer._v !== v) { layer._v = v; layer.innerHTML = v; } }
  span.style.setProperty('--kc', m === 'fill' ? fx.pill || SUBFX_KAR.pill : fx.on || SUBFX_KAR.on);
}
// ---------- активное слово ----------
// Зеркало subs_active.go: произносимый кусок цвета hi и крупнее на big, соседи по строке расступаются на половину прироста,
// строка по центру. Переходы линейные: soft — за SUBFX_ACT_SLIDE, иначе скачком.
const SUBFX_ACT = {hi: '#ffe000', big: .15}, SUBFX_ACT_SLIDE = .12;
// когда кусок активен: {on, off (-1 — до конца реплики), dOn, dOff}, как subsActTimes
function subFxActTimes(ch, dur, soft) {
  const next = i => { for (let j = i + 1; j < ch.length; j++) if (ch[j].t > ch[i].t) return [j, ch[j].t]; return [-1, dur]; };
  const slide = i => soft ? Math.min(SUBFX_ACT_SLIDE, next(i)[1] - ch[i].t) : 0;
  return ch.map((k, i) => { const [j, e] = next(i); return {on: k.t, off: j >= 0 ? e : -1, dOn: slide(i), dOff: j >= 0 ? slide(j) : 0}; });
}
const subFxActRamp = (u, a, d) => d <= 0 ? (u >= a ? 1 : 0) : Math.min(Math.max((u - a) / d, 0), 1);
// [размер, цвет]: насколько кусок активен и насколько окрашен в момент u, как subsActLevel
function subFxActLevel(t, u, keep) {
  const on = subFxActRamp(u, t.on, t.dOn), size = t.off >= 0 ? on - subFxActRamp(u, t.off, t.dOff) : on;
  return [size, keep ? on : size];
}
// цвет между a и b (#rrggbb), как subsActMix: каналы округляются
const subFxActMix = (a, b, k) => '#' + [1, 3, 5].map(i => { const x = parseInt(a.slice(i, i + 2), 16), y = parseInt(b.slice(i, i + 2), 16); return Math.round(x + (y - x) * k).toString(16).padStart(2, '0'); }).join('');
// span «Активного слова»: строки как у караоке (subFxKarLay), кусок — inline-block <b class="mv-subs-a">: scale от середины не двигает строку,
// а поля по big·W/2 с каждой стороны раздвигают соседей ровно на прирост — браузер сам держит строку по центру, подложка растёт с ней.
// Обводка у libass от \fscx не толстеет, поэтому её толщина делится на масштаб.
function subFxActPaint(span, cues, line, fx, at, s) {
  const key = 'a' + JSON.stringify([cues.map(c => [c.a, c.b, line(c), c.w]), s.font, s.w, s.size, Math.round(mvCv.clientWidth / mvCv.clientHeight * 1000)]);
  if (span.dataset.k !== key) {
    span.dataset.k = key;
    span.textContent = '';
    span.classList.add('mv-subs-kar');
    subFxKarLay(span, cues, line, s, false, 'mv-subs-a');
  }
  const big = fx.big || 0, hi = fx.hi || SUBFX_ACT.hi, col = s.color || '#ffffff', stroke = s.back ? 0 : s.size * mvCv.clientHeight * .12;
  const items = [];
  for (const {c, ch} of span._kar || []) {
    const ts = subFxActTimes(ch, c.b - c.a, !!fx.soft);
    // ширина без масштаба: offsetWidth округляет до пикселя, поэтому рамка, делённая на прошлый масштаб
    ch.forEach((k, i) => items.push([k.el, k.el.getBoundingClientRect().width / (k.el._sc || 1), subFxActLevel(ts[i], at - c.a, !!fx.keep)]));
  }
  for (const [el, w, [sz, cl]] of items) {
    const sc = el._sc = 1 + big * sz;
    el.style.transform = sc === 1 ? '' : `scale(${sc})`;
    el.style.margin = sz ? `0 ${big * sz * w / 2}px` : '';
    el.style.color = cl ? subFxActMix(col, hi, cl) : '';
    el.style.webkitTextStrokeWidth = sc !== 1 && stroke ? stroke / sc + 'px' : '';
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
  mtSum('mtSumSubsFx', {type: t('mt.fxType'), word: t('mt.fxWord'), kar: t('mt.fxKar'), act: t('mt.fxAct')}[fx.k] || '');
  $('mtSubsFxAct').classList.toggle('hide', fx.k !== 'act');
  $('mtSubsActHi').value = fx.hi || SUBFX_ACT.hi;
  mtVal('mtSubsActBig', Math.round((fx.big ?? SUBFX_ACT.big) * 100));
  $('mtSubsActKeep').checked = !!fx.keep;
  $('mtSubsActSoft').checked = !!fx.soft;
  $('mtSubsFxType').classList.toggle('hide', fx.k !== 'type');
  $('mtSubsFxWord').classList.toggle('hide', fx.k !== 'word');
  $('mtSubsFxKar').classList.toggle('hide', fx.k !== 'kar');
  $('mtSubsChunk').value = String(s.chunk || 0);
  const km = fx.m || 'jump';
  $('mtSubsKarM').value = km;
  $('mtSubsKarSmoothRow').classList.toggle('hide', km === 'jump');
  $('mtSubsKarSmooth').checked = !!fx.smooth;
  $('mtSubsKarPill').value = fx.pill || SUBFX_KAR.pill;
  $('mtSubsKarOn').value = fx.on || SUBFX_KAR.on;
  $('mtSubsKarBox').classList.toggle('hide', km === 'fill');
  mtVal('mtSubsKarR', Math.round((fx.r ?? SUBFX_KAR.r) * 100));
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
  else if (k === 'kar' && !('m' in fx)) subFxSet({k, m: 'jump', ...SUBFX_KAR});
  else if (k === 'act' && !('hi' in fx)) subFxSet({k, ...SUBFX_ACT, soft: true});
  else subFxSet({k});
});
$('mtSubsActHi').addEventListener('change', () => subFxSet({hi: $('mtSubsActHi').value}));
mtRow('mtSubsActBig', .25, v => mtSubsLive({fx: {...(tkSubs.fx || {}), big: Math.round(Math.min(Math.max(v, 0), 30)) / 100}}));
$('mtSubsActKeep').addEventListener('change', () => { $('mtSubsActKeep').blur(); subFxSet({keep: $('mtSubsActKeep').checked}); });
$('mtSubsActSoft').addEventListener('change', () => { $('mtSubsActSoft').blur(); subFxSet({soft: $('mtSubsActSoft').checked}); });
mtRow('mtSubsWDur', .005, v => mtSubsLive({fx: {...(tkSubs.fx || {}), dur: Math.round(Math.min(Math.max(v, .1), .6) * 100) / 100}}));
mtRow('mtSubsBounce', .25, v => mtSubsLive({fx: {...(tkSubs.fx || {}), bounce: Math.round(Math.min(Math.max(v, 0), 30)) / 100}}));
$('mtSubsCurOn').addEventListener('change', () => { $('mtSubsCurOn').blur(); subFxSet({cur: $('mtSubsCurOn').checked ? $('mtSubsCur').value : ''}); });
$('mtSubsCur').addEventListener('change', () => subFxSet({cur: $('mtSubsCur').value}));
$('mtSubsBlink').addEventListener('change', () => subFxSet({blink: $('mtSubsBlink').checked}));
mtRow('mtSubsCps', .25, v => mtSubsLive({fx: {...(tkSubs.fx || {}), cps: Math.round(Math.min(Math.max(v, 1), 100))}}));
$('mtSubsChunk').addEventListener('change', () => {
  $('mtSubsChunk').blur();
  const v = +$('mtSubsChunk').value;
  if (tkSubs) tkDo(() => { const {chunk, ...rest} = tkSubs; tkSubs = v ? {...rest, chunk: v} : rest; });
});
$('mtSubsKarM').addEventListener('change', () => { $('mtSubsKarM').blur(); subFxSet({m: $('mtSubsKarM').value}); });
$('mtSubsKarSmooth').addEventListener('change', () => { $('mtSubsKarSmooth').blur(); subFxSet({smooth: $('mtSubsKarSmooth').checked}); });
$('mtSubsKarPill').addEventListener('change', () => subFxSet({pill: $('mtSubsKarPill').value}));
$('mtSubsKarOn').addEventListener('change', () => subFxSet({on: $('mtSubsKarOn').value}));
mtRow('mtSubsKarR', .5, v => mtSubsLive({fx: {...(tkSubs.fx || {}), r: Math.round(Math.min(Math.max(v, 0), 100)) / 100}}));
