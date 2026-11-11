'use strict';
// «Цвет», инструмент «Смешать»: два цвета A и B, доля ползунком, режим OKLCH или RGB и ряд промежуточных шагов.
// Смесь считает clMix из color.js. Состояние лежит в cl.mix = {a, b, k (доля B, 0–100), n (число шагов), mode}
// (сохраняется вместе с cl, входит в отмену).

// проверка сохранённого cl.mix (mixOk) лежит в color.js: она нужна в clLoad до загрузки этого файла
// цвет при доле k (0–1) в виде #rrggbb
const mixAt = (m, k) => cpHex(clMix(cpParse(m.a), cpParse(m.b), k, m.mode), false);
// ряд из n цветов от A до B включительно
const mixRow = (m = cl.mix) => Array.from({length: m.n}, (_, i) => mixAt(m, i / (m.n - 1)));

function mixDraw() {
  if (!cl.mix) cl.mix = mixOk();
  const m = cl.mix, res = mixAt(m, m.k / 100), row = mixRow(m);
  for (const [id, v] of [['mixASw', m.a], ['mixBSw', m.b]]) {
    const sw = $(id);
    if (sw.value !== v && !(cp && cp.el === sw)) sw.value = v;
  }
  const big = $('mixBig');
  big.style.background = res;
  const w = clContrast(res, '#ffffff') >= clContrast(res, '#000000');
  big.style.color = w ? '#ffffff' : '#000000';
  big.innerHTML = `<b>${esc(clUp(res))}</b><span>${esc(t('cl.mixAt', {a: 100 - m.k, b: m.k}))}</span>`;
  $('mixRow').innerHTML = row.map((c, i) => {
    const wt = clContrast(c, '#ffffff') >= clContrast(c, '#000000') ? '#ffffff' : '#000000';
    return `<button type="button" class="mix-t" data-i="${i}" style="background:${c};color:${wt}" title="${esc(t('cl.mixCopy1', {v: clUp(c)}))}"><span>${esc(clUp(c))}</span></button>`;
  }).join('');
  clSegSync('mixMode', m.mode);
  clSegSync('mixN', String(m.n));
  if (document.activeElement !== $('mixK')) $('mixK').value = m.k;
  if (document.activeElement !== $('mixKn')) $('mixKn').value = m.k;
}
// рисует ползунок вместе с числом, живое изменение без записи в историю
function mixSetK(v, commit) {
  if (!Number.isFinite(v)) return;
  cl.mix.k = Math.min(Math.max(Math.round(v), 0), 100);
  mixDraw();
  if (commit) clSave();
}
$('mixK').addEventListener('input', () => mixSetK(+$('mixK').value, false));
$('mixK').addEventListener('change', () => mixSetK(+$('mixK').value, true));
$('mixKn').addEventListener('input', () => { if ($('mixKn').value !== '') mixSetK(+$('mixKn').value, false); });
$('mixKn').addEventListener('change', () => { mixSetK(+$('mixKn').value, true); $('mixKn').value = cl.mix.k; });
$('mixMode').addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (b) { cl.mix.mode = b.dataset.v; mixDraw(); clSave(); } });
$('mixN').addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (b) { cl.mix.n = +b.dataset.v; mixDraw(); clSave(); } });
$('mixSwap').onclick = () => { const m = cl.mix; [m.a, m.b] = [m.b, m.a]; m.k = 100 - m.k; mixDraw(); clSave(); };
$('mixBig').onclick = () => { const c = mixAt(cl.mix, cl.mix.k / 100); clRecentAdd(c); clCopy(clUp(c)); clLibDraw(); };
$('mixRow').addEventListener('click', e => {
  const b = e.target.closest('.mix-t');
  if (b) clCopy(clUp(mixRow()[+b.dataset.i]));
});
$('mixCopyRow').onclick = () => clCopy(mixRow().map(clUp).join(', '), t('cl.mixCopied', {n: cl.mix.n}));

for (const [id, k] of [['mixASw', 'a'], ['mixBSw', 'b']]) {
  cpField($(id), {live: v => { cl.mix[k] = cpHex(cpParse(v), false); mixDraw(); }, done: () => { clSave(); clLibDraw(); }});
}
for (const [id, k] of [['mixAEye', 'a'], ['mixBEye', 'b']]) {
  $(id).onclick = async () => {
    toast({type: 'ok', title: t('cl.eyeGo'), ttl: 2500});
    const hex = await screenColor();   // null — Esc, передумали
    const c = hex && cpParse(hex);
    if (!c) return;
    cl.mix[k] = cpHex(c, false);
    clRecentAdd(cl.mix[k]); mixDraw(); clSave(); clLibDraw();
  };
}
$('mixBig').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('mixBig').click(); } });
