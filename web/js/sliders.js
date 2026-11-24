// ---------- риска исходного значения и лёгкий магнит у ползунков ----------
// Ползунок с data-origin="значение" получает риску (рисует style.css по --sl-p), а шарик под мышью прилипает к ней.
// Клавиатура, поле с числом и Alt магнита не знают: так задаются точные значения рядом с риской.
const SL_ZONE = 3;   // ширина магнита в пикселях по обе стороны от риски; у ползунка можно своя: data-snap="8"
const SL_SEL = 'input[type=range][data-origin]';
let slDrag = null;

function slPlace(r) {
  const a = +r.min || 0, b = r.max === '' ? 100 : +r.max;
  r.style.setProperty('--sl-p', b > a ? Math.min(Math.max((+r.dataset.origin - a) / (b - a), 0), 1) : 0);
}
// Заливка шкалы (data-fill): "left" — от начала до шарика, "mid" — от риски (нуля) до шарика в сторону движения.
// Края заливки в долях шкалы кладём в --sl-lo и --sl-hi, рисует их style.css. После программной смены value звать slFill.
function slFill(r) {
  const f = r.dataset.fill;
  if (!f) return;
  const a = +r.min || 0, b = r.max === '' ? 100 : +r.max, w = b > a ? b - a : 1;
  const v = Math.min(Math.max((+r.value - a) / w, 0), 1);
  const o = f === 'mid' ? Math.min(Math.max((+r.dataset.origin - a) / w, 0), 1) : 0;
  r.style.setProperty('--sl-lo', Math.min(o, v));
  r.style.setProperty('--sl-hi', Math.max(o, v));
}
addEventListener('input', e => { if (e.target.matches && e.target.matches('input[type=range][data-fill]')) slFill(e.target); });
// Если шарик за одно движение ушёл и вернулся на риску, браузер не пошлёт change: значение то же, что в начале.
// Посылаем сами: на нём держится отмена одним шагом в mtRow. Второй change от браузера никому не мешает.
function slEnd() {
  if (!slDrag) return;
  const {r, moved} = slDrag;
  slDrag = null;
  if (moved) r.dispatchEvent(new Event('change', {bubbles: true}));
}
// слушаем на окне в фазе перехвата: значение должно быть поправлено раньше всех обработчиков самого ползунка
addEventListener('pointerdown', e => { if (e.button === 0 && e.target.matches && e.target.matches(SL_SEL)) slDrag = {r: e.target, moved: false, free: e.altKey}; }, true);
addEventListener('pointermove', e => { if (slDrag) slDrag.free = e.altKey; }, true);
addEventListener('input', e => {
  if (!slDrag || e.target !== slDrag.r) return;
  const r = slDrag.r, o = +r.dataset.origin, unit = (+r.max - +r.min) / r.getBoundingClientRect().width;
  slDrag.moved = true;
  if (!slDrag.free && Math.abs(+r.value - o) <= (+r.dataset.snap || SL_ZONE) * unit) r.value = o;
}, true);
addEventListener('pointerup', slEnd, true);
addEventListener('pointercancel', slEnd, true);
// диапазон X и Y зависит от холста, а значит риска должна ехать вслед за min и max
const slWatch = new MutationObserver(list => list.forEach(m => slPlace(m.target)));
document.querySelectorAll(SL_SEL).forEach(r => { slPlace(r); slWatch.observe(r, {attributes: true, attributeFilter: ['min', 'max']}); });
