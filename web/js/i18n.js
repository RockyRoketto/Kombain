// ---------- язык интерфейса ----------
// Разметку на нужном языке отдаёт сервер (web.go), поэтому при запуске страница не мигает другим языком.
const I18N = __I18N__;
let lang = '__LANG__';   // ru или en
// t('ключ', {имя: значение}): значения подставляются как есть, в HTML их экранирует вызывающий код
function t(key, vars) {
  const s = I18N[lang][key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => k in vars ? vars[k] : m) : s;
}
// tn(5, 'n.files') → «5 файлов» или «5 files»; формы слова в словаре через |
function tn(n, key) {
  const f = t(key).split('|');
  if (lang !== 'ru') return n + ' ' + f[n === 1 ? 0 : 1];
  const m = n % 10, h = n % 100;
  return n + ' ' + f[m === 1 && h !== 11 ? 0 : m >= 2 && m <= 4 && (h < 10 || h >= 20) ? 1 : 2];
}
function applyLang() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach(el => { el.innerHTML = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
  document.querySelectorAll('[data-i18n-aria]').forEach(el => el.setAttribute('aria-label', t(el.dataset.i18nAria)));
  // тексты, которые ставит сам код; показанные раньше всплывашки, сообщения и лог остаются как были
  buildFormats(); applyKind(); renderOut();
  newsBanner(snap); appBanner(snap); ffBanner(snap); renderSetup(snap); renderInstallBtn(snap);
  render(); bLast = ''; bRender(); updateButtons(); renderSummary(snap);
}

