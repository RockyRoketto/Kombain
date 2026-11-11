'use strict';
// «Цвет», инструмент «Контраст»: цвет текста и фона, образец фразой в трёх размерах, оценка AA/AAA и кнопки
// «Подтянуть до AA/AAA» (меняется только светлота текста в OKLCH, оттенок прежний).
// Пара лежит в cl.ctr = {fg, bg} (сохраняется вместе с cl, входит в отмену). Расчёт clContrast — в color.js.

const CTR_DEF = {fg: '#9a9a9a', bg: '#ffffff'};
const ctrOk = o => ({fg: cpValid(o && o.fg, CTR_DEF.fg), bg: cpValid(o && o.bg, CTR_DEF.bg)});
const ctrFmt = r => r.toFixed(2).replace(/\.?0+$/, '');
// пороги WCAG: [AA, AAA] для обычного текста и для крупного
const CTR_LIM = {n: [4.5, 7], big: [3, 4.5]};

function ctrMark(r, big) {
  const [aa, aaa] = big ? CTR_LIM.big : CTR_LIM.n;
  return r >= aaa ? 'AAA' : r >= aa ? 'AA' : t('cl.ctrLow');
}

function ctrDraw() {
  if (!cl.ctr) cl.ctr = ctrOk();
  const {fg, bg} = cl.ctr, r = clContrast(fg, bg);
  const plate = $('ctrPlate');
  plate.style.background = bg; plate.style.color = fg;
  const rows = [['cl.ctrS', '14px', 400, false], ['cl.ctrM', '16px', 400, false], ['cl.ctrL', '24px', 700, true]];
  plate.innerHTML = rows.map(([k, size, w, big]) =>
    `<div class="ctr-row" title="${esc(t(k))}"><span style="font-size:${size};font-weight:${w}">${esc(t('cl.ctrText'))}</span><em>${esc(ctrMark(r, big))}</em></div>`).join('');
  for (const [id, v] of [['ctrFgSw', fg], ['ctrBgSw', bg]]) {
    const sw = $(id);
    if (sw.value !== v && !(cp && cp.el === sw)) sw.value = v;
  }
  $('ctrRatio').innerHTML = `${esc(ctrFmt(r))}:1<small>${esc(t('cl.ctrL'))}: ${esc(ctrMark(r, true))} · ${esc(t('cl.ctrM'))}: ${esc(ctrMark(r, false))}</small>`;
}

// ближайший по светлоте текст, которому хватает target (null — ни светлым, ни тёмным не добиться)
function ctrRaise(fg, bg, target) {
  if (clContrast(fg, bg) >= target) return fg;
  const lch = clLch(cpParse(fg));
  const at = L => cpHex(clFit({...lch, L}), false);
  let best = null;
  for (const end of [0, 1]) {
    if (clContrast(at(end), bg) < target) continue;
    let lo = lch.L, hi = end;   // lo не хватает, hi хватает
    for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (clContrast(at(mid), bg) >= target) hi = mid; else lo = mid; }
    if (!best || Math.abs(hi - lch.L) < Math.abs(best.L - lch.L)) best = {L: hi, hex: at(hi)};
  }
  return best && best.hex;
}

function ctrFix(target) {
  const {fg, bg} = cl.ctr, r = clContrast(fg, bg);
  if (r >= target) { toast({type: 'ok', title: t('cl.ctrOk', {r: ctrFmt(r)}), ttl: 2500}); return; }
  const hex = ctrRaise(fg, bg, target);
  if (!hex) { toast({type: 'warn', title: t('cl.ctrNoFix'), ttl: 4500}); return; }
  cl.ctr.fg = hex;
  clRecentAdd(hex);
  ctrDraw(); clSave(); clLibDraw();
  toast({type: 'ok', title: t('cl.ctrFixed', {r: ctrFmt(clContrast(hex, bg))}), ttl: 2500});
}
$('ctrFixAA').onclick = () => ctrFix(4.5);
$('ctrFixAAA').onclick = () => ctrFix(7);
$('ctrSwap').onclick = () => { const o = cl.ctr; [o.fg, o.bg] = [o.bg, o.fg]; ctrDraw(); clSave(); };

for (const [id, k] of [['ctrFgSw', 'fg'], ['ctrBgSw', 'bg']]) {
  cpField($(id), {live: v => { cl.ctr[k] = cpHex(cpParse(v), false); ctrDraw(); }, done: () => { clSave(); clLibDraw(); }});
}
for (const [id, k] of [['ctrFgEye', 'fg'], ['ctrBgEye', 'bg']]) {
  $(id).onclick = async () => {
    toast({type: 'ok', title: t('cl.eyeGo'), ttl: 2500});
    const hex = await screenColor();   // null — Esc, передумали
    const c = hex && cpParse(hex);
    if (!c) return;
    cl.ctr[k] = cpHex(c, false);
    clRecentAdd(cl.ctr[k]); ctrDraw(); clSave(); clLibDraw();
  };
}
