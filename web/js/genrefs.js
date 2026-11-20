// Референсы вкладки «Генератор»: до 8 плиток, у каждой роль (Стиль, Персонаж, Основа) и «насколько похоже».
// Картинка попадает сюда перетаскиванием на блок, вставкой Ctrl+V (фокус не в тексте или в буфере только картинка),
// выбором файла или из галереи (сетка в режиме выбора, кнопка «В референсы» в окне просмотра).
// @N в запросе ссылается на плитку N; набери @, и появится список. Сервер: genref.go (gen-ref, /gen-ref), llm.go.
const GN_REF_MAX = 8;
const GN_REF_ROLES = ['style', 'character', 'base'];
if (!Array.isArray(gn.set.refs)) gn.set.refs = [];

const gnRefRole = r => t(`gn.ref.role.${r.role}`);
const gnRefSrc = id => `/gen-ref?t=${TOKEN}&id=${id}`;
// модель сама берёт картинку «Персонажа» (FLUX.2 klein, genRefChars в genref.go); «лёгкий намёк» — только словами
const gnRefKlein = () => gnModel()?.arch === 'flux2';
const gnRefImg = r => r.role === 'character' && r.w >= 34 && gnRefKlein();
// без глаз помощник видит только основу (и «Персонажа», которого klein берёт картинкой)
const gnRefSees = r => r.role === 'base' || gnRefImg(r) || !!gn.info?.eyes;
// gnRefWords: «Персонаж» уйдёт модели только описанием словами (лицо так не передать) — говорим прямо
function gnRefWords() {
  const on = gn.set.refs.some(r => r.role === 'character' && r.w >= 34 && gnRefSees(r) && !gnRefImg(r)) && !!gnModel();
  $('gnRefWords').classList.toggle('hide', !on);
  if (!on) return;
  const k = (gn.info?.models || []).find(m => m.arch === 'flux2');
  $('gnRefWordsT').textContent = t('gn.ref.words', {m: gnModel().name});
  $('gnRefWordsGo').textContent = t(k ? 'gn.ref.wordsPick' : 'gn.ref.wordsGet');
}
$('gnRefWordsGo').addEventListener('click', () => {
  const k = (gn.info?.models || []).find(m => m.arch === 'flux2');
  if (!k) { gmOpen(true); return; }
  gn.set.model = k.id; $('gnModel').value = k.id; $('gnModel').dispatchEvent(new Event('change'));
});
// gnRefsFor: что уходит на сервер
const gnRefsFor = () => gn.set.refs.map(r => ({id: r.id, role: r.role, weight: r.w / 100, img: gnRefImg(r)}));
const gnRefsBlind = () => gn.set.refs.some(r => !gnRefSees(r));

function gnRefRender() {
  const refs = gn.set.refs;
  const tiles = refs.map((r, i) => {
    const role = gnRefRole(r);
    return `<div class="gn-ref${gnRefSees(r) ? '' : ' blind'}" data-i="${i}"${gnRefSees(r) ? '' : ` title="${esc(t('gn.ref.blind'))}"`}>
      <img src="${gnRefSrc(r.id)}" alt="">
      <button type="button" class="gn-ref-at" title="${esc(t('gn.ref.at', {n: '@' + (i + 1)}))}">@${i + 1}</button>
      <button type="button" class="gn-ref-x" title="${esc(t('gn.ref.del'))}" aria-label="${esc(t('gn.ref.del'))}">✕</button>
      <button type="button" class="gn-ref-role${r.role === 'base' ? ' base' : ''}" title="${esc(t('gn.ref.roleHint'))}">${esc(role)}</button>
      <input type="range" class="vol" min="0" max="100" step="5" value="${r.w}" title="${esc(t('gn.ref.w', {v: r.w}))}" aria-label="${esc(t('gn.ref.w', {v: r.w}))}">
    </div>`;
  }).join('');
  const add = refs.length < GN_REF_MAX ? `<div class="gn-ref gn-ref-add"><b>+</b><small>${esc(t('gn.ref.add'))}</small>
    <span><button type="button" class="linkb" data-add="file">${esc(t('gn.ref.file'))}</button><button type="button" class="linkb" data-add="gal">${esc(t('gn.ref.gal'))}</button></span></div>` : '';
  $('gnRefs').innerHTML = tiles + add;
  $('gnRefEyes').classList.toggle('hide', !gnRefsBlind());
  gnRefWords();
  $('gnSv_refs').textContent = refs.length ? refs.map((r, i) => '@' + (i + 1) + ' ' + gnRefRole(r)).join(', ') : '';
}

// gnRefAdd: картинка уже на сервере (id) — новая плитка. Роль по умолчанию: без глаз основа (если её ещё нет), иначе стиль.
function gnRefAdd(id) {
  const refs = gn.set.refs;
  if (refs.some(r => r.id === id)) return;
  if (refs.length >= GN_REF_MAX) { toast({type: 'info', title: t('gn.ref.full'), ttl: 3000}); return; }
  const hasBase = refs.some(r => r.role === 'base');
  refs.push({id, role: !gn.info?.eyes && !hasBase ? 'base' : 'style', w: 50});
  gnSave(); gnRefRender();
}

// gnRefUpload: файлы (перетаскивание, буфер, выбор файла) — на сервер по одному
async function gnRefUpload(files) {
  for (const f of files) {
    if (!/^image\//.test(f.type)) continue;
    if (gn.set.refs.length >= GN_REF_MAX) { toast({type: 'info', title: t('gn.ref.full'), ttl: 3000}); return; }
    try {
      const r = await (await fetch('/api/gen-ref', {method: 'POST', headers: {'X-Token': TOKEN}, body: f})).json();
      if (r.error) { say('warn', t('warn.title'), r.error); continue; }
      gnRefAdd(r.id);
    } catch (e) { say('warn', t('warn.title'), String(e)); }
  }
}

// gnRefFromGallery: картинка галереи по пути
async function gnRefFromGallery(path) {
  const r = await api('gen-ref', {path});
  if (r.error) { say('warn', t('warn.title'), r.error); return; }
  gnRefAdd(r.id);
  toast({type: 'ok', title: t('gn.ref.added'), ttl: 2500});
}

// gnRefAtInsert: вставить @n в запрос там, где курсор
function gnRefAtInsert(n, replaceAt) {
  const ta = $('gnPrompt'), v = ta.value;
  let a = ta.selectionStart ?? v.length, b = ta.selectionEnd ?? a;
  if (replaceAt && v[a - 1] === '@') a--;
  const ins = '@' + n + ' ';
  ta.value = v.slice(0, a) + ins + v.slice(b);
  ta.focus();
  ta.selectionStart = ta.selectionEnd = a + ins.length;
  gn.set.prompt = ta.value; gnSave();
  ta.dispatchEvent(new Event('input'));
}

$('gnRefs').addEventListener('click', e => {
  const add = e.target.closest('[data-add]');
  if (add) {
    if (add.dataset.add === 'file') $('gnRefFile').click();
    else { gg.pick = true; ggOpen(true); toast({type: 'info', title: t('gn.ref.pick'), ttl: 4000}); }
    return;
  }
  const tile = e.target.closest('.gn-ref[data-i]'); if (!tile) return;
  const i = +tile.dataset.i, r = gn.set.refs[i];
  if (e.target.closest('.gn-ref-x')) { gn.set.refs.splice(i, 1); gnSave(); gnRefRender(); return; }
  if (e.target.closest('.gn-ref-at')) { gnRefAtInsert(i + 1); return; }
  if (e.target.closest('.gn-ref-role')) {
    r.role = GN_REF_ROLES[(GN_REF_ROLES.indexOf(r.role) + 1) % GN_REF_ROLES.length];
    // основа одна: прежняя становится стилем
    if (r.role === 'base') gn.set.refs.forEach(x => { if (x !== r && x.role === 'base') x.role = 'style'; });
    gnSave(); gnRefRender();
  }
});
$('gnRefs').addEventListener('input', e => {
  const tile = e.target.closest('.gn-ref[data-i]'); if (!tile || e.target.type !== 'range') return;
  const r = gn.set.refs[+tile.dataset.i];
  r.w = +e.target.value;
  e.target.title = t('gn.ref.w', {v: r.w});
  gnSave();
  // слабый «Персонаж» у klein уходит только словами: плитка и плашки под блоком меняются (без перерисовки плиток,
  // чтобы не сбить перетаскивание ползунка)
  const see = gnRefSees(r);
  tile.classList.toggle('blind', !see);
  if (see) tile.removeAttribute('title'); else tile.title = t('gn.ref.blind');
  $('gnRefEyes').classList.toggle('hide', !gnRefsBlind());
  gnRefWords();
});
// картинка пропала с диска (её убрала чистка через 60 дней) — плитка уходит
$('gnRefs').addEventListener('error', e => {
  const tile = e.target.closest?.('.gn-ref[data-i]'); if (!tile || e.target.tagName !== 'IMG') return;
  gn.set.refs.splice(+tile.dataset.i, 1); gnSave(); gnRefRender();
}, true);
$('gnRefFile').addEventListener('change', () => { const f = [...$('gnRefFile').files]; $('gnRefFile').value = ''; gnRefUpload(f); });
$('gnRefEyesGet').addEventListener('click', () => gmOpen(true));
$('gnLbRef').addEventListener('click', () => { const x = ggCur(); if (!x) return; ggLbClose(); if (gg.open) ggOpen(false); gnRefFromGallery(x.path); });

// Ctrl+V: картинка из буфера (скриншот). В поле ввода — только если в буфере нет текста, иначе это обычная вставка.
document.addEventListener('paste', e => {
  if (tab !== 'gen' || document.querySelector('.modal:not(.hide)')) return;
  const cd = e.clipboardData; if (!cd) return;
  const imgs = [...cd.files].filter(f => /^image\//.test(f.type));
  if (!imgs.length) return;
  const inText = e.target.closest && e.target.closest('input, textarea, [contenteditable]');
  if (inText && cd.getData('text/plain')) return;
  e.preventDefault();
  gnRefUpload(imgs);
});

// подсветка блока, когда над ним несут файл (drop.js отдаёт брошенное сюда через gnRefDrop)
function gnRefOver(e) { $('gnRefsSec').classList.toggle('over', !!(e && e.target.closest && e.target.closest('#gnRefsSec'))); }
function gnRefDrop(e) {
  gnRefOver(null);
  if (!e.target.closest || !e.target.closest('#gnRefsSec')) return false;
  $('gnRefsSec').open = true;
  gnRefUpload([...e.dataTransfer.files]);
  return true;
}

// ---- @ в запросе: список плиток ----

function gnAtShow(on) {
  const box = $('gnAt');
  if (!on || !gn.set.refs.length) { box.classList.add('hide'); return; }
  box.innerHTML = gn.set.refs.map((r, i) => `<button type="button" data-n="${i + 1}"${i ? '' : ' class="on"'}><img src="${gnRefSrc(r.id)}" alt="">@${i + 1} ${esc(gnRefRole(r))}</button>`).join('');
  box.style.top = ($('gnPrompt').offsetTop + $('gnPrompt').offsetHeight) + 'px';
  box.classList.remove('hide');
}
$('gnPrompt').addEventListener('input', e => {
  const ta = $('gnPrompt');
  gnAtShow(e.inputType === 'insertText' && e.data === '@' && ta.value[ta.selectionStart - 1] === '@');
});
$('gnPrompt').addEventListener('keydown', e => {
  const box = $('gnAt'); if (box.classList.contains('hide')) return;
  const bs = [...box.querySelectorAll('button')], k = bs.findIndex(b => b.classList.contains('on'));
  if (e.ctrlKey || e.metaKey || e.altKey) gnAtShow(false);
  else if (e.key === 'Escape') { gnAtShow(false); e.preventDefault(); e.stopPropagation(); }
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = (k + (e.key === 'ArrowDown' ? 1 : bs.length - 1)) % bs.length;
    bs.forEach((b, j) => b.classList.toggle('on', j === n));
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault(); gnAtShow(false); gnRefAtInsert(+bs[Math.max(k, 0)].dataset.n, true);
  } else if (e.key !== 'Shift') gnAtShow(false);
}, true);
$('gnPrompt').addEventListener('blur', () => setTimeout(() => gnAtShow(false), 150));
$('gnAt').addEventListener('mousedown', e => {
  const b = e.target.closest('button[data-n]'); if (!b) return;
  e.preventDefault(); gnAtShow(false); gnRefAtInsert(+b.dataset.n, true);
});

gnRefRender();
