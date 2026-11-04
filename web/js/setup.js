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
  $('stGo').textContent = t('setup.installing');
  $('stErr').classList.add('hide');
  const r = await api('install', {desktop: setupDesk, ffmpeg: ff});
  setupBusy = false;
  $('stGo').disabled = $('stLater').disabled = false;
  if (r.error) {
    $('stErr').textContent = t('setup.failed', {err: r.error});
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
  if (!s.ffmpeg) return {key:'dl', text:t('setup.ffDownload', {v: v.latest ? ' ' + esc(v.latest) : ''}), on:true};
  if (v.checking || !v.checked) return {key:'checking', text:t('setup.ffChecking'), disabled:true};
  if (v.update) return {key:'upd', text:t('setup.ffUpdate', {from: esc(v.local), to: esc(v.latest)}), on:true};
  if (v.local && v.latest) return {key:'ok', text:t('setup.ffOk', {v: esc(v.local)}) + ' <span class="tick">✓</span>', stat:true};
  if (!v.local && v.latest) return {key:'git', text:t('setup.ffReplace', {v: esc(shortVer(v.localRaw) || t('setup.ffGit')), to: esc(v.latest)}), on:false};
  return {key:'nocheck', text:t('setup.ffNoCheck', {v: esc(v.local || '')}), stat:true};
}

function renderSetup(s) {
  if ($('setup').classList.contains('hide')) return;
  const app = s.app || {}, inst = app.install || {}, dl = s.dl || {}, up = inst.offer === 'upgrade';
  if (setupStage === 'done') {
    $('stEyebrow').textContent = t('setup.eyebrowDone');
    $('stTitle').innerHTML = (up ? t('setup.doneUpdated') : t('setup.doneInstalled')) + ' <span class="tick">✓</span>';
    $('stSub').textContent = setupDesk ? t('setup.doneSubDesk') : t('setup.doneSub');
    $('stOpts').classList.add('hide');
    $('stLater').classList.add('hide');
    $('stGo').textContent = t('setup.go');
    $('stProg').classList.toggle('hide', !dl.active);
    $('stProg').firstElementChild.style.width = (dl.pct || 0) + '%';
    $('stNote').innerHTML = dl.active ? t('setup.ffProgress', {pct: Math.round(dl.pct || 0)})
      : dl.err ? '' : (s.ffmpeg && s.ffv && s.ffv.localRaw ? t('setup.ffReady', {v: esc(s.ffv.local || shortVer(s.ffv.localRaw))}) + ' <span class="tick">✓</span>' : '');
    if (dl.err && !dl.active) { $('stErr').textContent = t('setup.ffFailed', {err: dl.err}); $('stErr').classList.remove('hide'); }
    return;
  }
  $('stEyebrow').textContent = up ? t('setup.eyebrowUpdate') : t('setup.eyebrowInstall');
  $('stTitle').textContent = up ? t('setup.titleUpdate', {from: inst.version, to: app.version}) : t('setup.title');
  $('stSub').textContent = up ? t('setup.subUpdate') : t('setup.sub');
  if (!setupBusy) $('stGo').textContent = up ? t('btn.update') : t('install.btn');
  $('stLater').textContent = up ? t('btn.later') : t('setup.later');
  const row = ffSetupRow(s), cb = $('stFF');
  $('stFFText').innerHTML = row.text;
  $('stFFRow').classList.toggle('static', !!row.stat);
  cb.disabled = !!row.disabled || !!row.stat;
  if (row.key !== stFFKey) { cb.checked = !!row.on; stFFKey = row.key; }
  $('stNote').textContent = row.key === 'dl' || row.key === 'upd' || row.key === 'git' ? t('setup.ffSource') : '';
}

function renderInstallBtn(s) {
  const inst = (s.app || {}).install || {};
  $('installBtn').textContent = inst.offer === 'upgrade' ? t('install.btnUpgrade') : t('install.btn');
  $('installBtn').classList.toggle('hide', !inst.supported || !inst.offer || setupStage === 'done' || !$('setup').classList.contains('hide'));
}

