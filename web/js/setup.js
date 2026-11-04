// ---------- установка ----------
let setupState = 'auto', setupStage = 'ask', setupBusy = false, setupDesk = true, stFFKey = '';
const shortVer = v => String(v || '').split('-').slice(0, 2).join('-');
function openSetup() { setupState = 'open'; $('setup').classList.remove('hide'); renderSetup(snap); setTimeout(() => $('stGo').focus(), 30); }
function closeSetup() { setupState = 'closed'; $('setup').classList.add('hide'); ffBanner(snap); renderInstallBtn(snap); }
$('installBtn').onclick = openSetup;
$('stLater').onclick = async () => { if (setupBusy) return; closeSetup(); await api('setup-later'); };
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('setup').classList.contains('hide') && !setupBusy) closeSetup();
});
$('stGo').onclick = async () => {
  if (setupStage === 'done') { closeSetup(); return; }
  if (setupBusy) return;
  setupBusy = true;
  setupDesk = $('stDesk').checked;
  const ff = $('stFF').checked && !$('stFF').disabled && !$('stFFRow').classList.contains('static');
  $('stGo').disabled = $('stLater').disabled = true;
  $('stGo').textContent = 'Устанавливаю…';
  $('stErr').classList.add('hide');
  const r = await api('install', {desktop: setupDesk, ffmpeg: ff});
  setupBusy = false;
  $('stGo').disabled = $('stLater').disabled = false;
  if (r.error) {
    $('stErr').textContent = 'Не получилось: ' + r.error;
    $('stErr').classList.remove('hide');
  } else {
    setupStage = 'done';
    if (r.ffError) { $('stErr').textContent = r.ffError; $('stErr').classList.remove('hide'); }
  }
  renderSetup(snap);
};

// строка про ffmpeg в окне установки
function ffSetupRow(s) {
  const v = s.ffv || {};
  if (!s.ffmpeg) return {key:'dl', text:`Скачать ffmpeg${v.latest ? ' ' + esc(v.latest) : ''} (~100 МБ)`, on:true};
  if (v.checking || !v.checked) return {key:'checking', text:'ffmpeg: проверяю свежую версию…', disabled:true};
  if (v.update) return {key:'upd', text:`Обновить ffmpeg ${esc(v.local)} → ${esc(v.latest)}`, on:true};
  if (v.local && v.latest) return {key:'ok', text:`ffmpeg ${esc(v.local)} — свежая версия <span class="tick">✓</span>`, stat:true};
  if (!v.local && v.latest) return {key:'git', text:`Заменить ffmpeg (${esc(shortVer(v.localRaw) || 'сборка из git')}) на релиз ${esc(v.latest)}`, on:false};
  return {key:'nocheck', text:`ffmpeg ${esc(v.local || '')} найден, свежую версию проверить не удалось`, stat:true};
}

function renderSetup(s) {
  if ($('setup').classList.contains('hide')) return;
  const app = s.app || {}, inst = app.install || {}, dl = s.dl || {}, up = inst.offer === 'upgrade';
  if (setupStage === 'done') {
    $('stEyebrow').textContent = 'готово';
    $('stTitle').innerHTML = (up ? 'Обновлено' : 'Установлено') + ' <span class="tick">✓</span>';
    $('stSub').textContent = `Ярлык — в меню «Пуск»${setupDesk ? ' и на рабочем столе' : ''}. Этот exe больше не нужен: после закрытия программы его можно удалить.`;
    $('stOpts').classList.add('hide');
    $('stLater').classList.add('hide');
    $('stGo').textContent = 'Поехали';
    $('stProg').classList.toggle('hide', !dl.active);
    $('stProg').firstElementChild.style.width = (dl.pct || 0) + '%';
    $('stNote').innerHTML = dl.active ? `Скачиваю ffmpeg: ${Math.round(dl.pct || 0)}% — можно закрыть окно, докачается само.`
      : dl.err ? '' : (s.ffmpeg && s.ffv && s.ffv.localRaw ? `ffmpeg ${esc(s.ffv.local || shortVer(s.ffv.localRaw))} готов <span class="tick">✓</span>` : '');
    if (dl.err && !dl.active) { $('stErr').textContent = 'ffmpeg не скачался: ' + dl.err; $('stErr').classList.remove('hide'); }
    return;
  }
  $('stEyebrow').textContent = up ? 'обновление' : 'установка';
  $('stTitle').textContent = up ? `Обновить Конвертер ${inst.version} → ${app.version}?` : 'Установить на компьютер?';
  $('stSub').textContent = up ? 'Заменим установленную программу этой версией. Ярлыки и настройки останутся.'
    : 'Конвертер появится в меню «Пуск» и в «Установленных приложениях» и сам будет проверять, не вышла ли новая версия Конвертера или ffmpeg.';
  if (!setupBusy) $('stGo').textContent = up ? 'Обновить' : 'Установить';
  $('stLater').textContent = up ? 'Не сейчас' : 'Без установки';
  const row = ffSetupRow(s), cb = $('stFF');
  $('stFFText').innerHTML = row.text;
  $('stFFRow').classList.toggle('static', !!row.stat);
  cb.disabled = !!row.disabled || !!row.stat;
  if (row.key !== stFFKey) { cb.checked = !!row.on; stFFKey = row.key; }
  $('stNote').textContent = row.key === 'dl' || row.key === 'upd' || row.key === 'git' ? 'ffmpeg берётся с gyan.dev (запасной вариант — GitHub BtbN).' : '';
}

function renderInstallBtn(s) {
  const inst = (s.app || {}).install || {};
  $('installBtn').textContent = inst.offer === 'upgrade' ? 'Обновить установленную' : 'Установить';
  $('installBtn').classList.toggle('hide', !inst.supported || !inst.offer || setupStage === 'done' || !$('setup').classList.contains('hide'));
}

