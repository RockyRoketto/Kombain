$('exitBtn').onclick = async () => {
  await api('exit');
  document.body.innerHTML = `<p style="padding:40px;color:var(--dim);font:15px system-ui">${t('exit.closed')}</p>`;
};
$('logBtn').onclick = () => $('logWrap').classList.toggle('hide');

function updateButtons() {
  const noFF = !snap.ffmpeg;
  $('start').disabled = snap.running || noFF || pending > 0 || !!(snap.dl && snap.dl.active);
  $('stop').classList.toggle('hide', !snap.running);
  $('addFiles').disabled = $('addFolder').disabled = $('clearBtn').disabled = snap.running;
  $('bAddFiles').disabled = $('bAddFolder').disabled = $('bClear').disabled = snap.running;
  plButtons();
  mtButtons();
  $('bStart').disabled = $('start').disabled;
  $('start').classList.toggle('hide', snap.running || tab !== 'conv');
  $('bStart').classList.toggle('hide', snap.running || tab !== 'banner');
  const anyOk = (snap.files || []).some(f => f.status === 'ok' && f.dst);
  $('openOut').classList.toggle('hide', snap.running || !anyOk);
}
// итог в нижней панели и заголовок вкладки
function renderSummary(s) {
  const fl = s.files || [];
  const done = fl.filter(f => ['ok','error','skipped','kept','canceled'].includes(f.status)).length;
  $('summary').textContent = s.running ? t('dock.running', {done, n: fl.length})
    : s.summary || (pending ? t('dock.copying') : tab === 'banner' ? t($('bAutoDirs').checked ? 'dock.idleBannerAuto' : 'dock.idleBanner') : t(tab === 'play' ? 'dock.idlePlayer' : 'dock.idle'));
  $('summary').title = $('summary').textContent;   // в узком окне строка обрезается многоточием
  document.title = s.running ? `${done}/${fl.length} · ${t('app.name')}` : t('app.name');
}

async function poll() {
  const s = await api('state');
  if (!s.error) {
    snap = s;
    if (s.project) mtProjectIncoming(s.project);
    if ((s.incoming || []).length) {   // файлы снаружи: «Отправить» или второй запуск
      if (tab === 'banner' && s.incoming.every(f => /\.png$/i.test(f.path))) bAdd(s.incoming);
      else { setTab('conv'); addInfos(s.incoming); }
    }
    const conv = s.batch !== 'banner';
    (s.files || []).forEach(f => { (conv ? res : bres)[f.path] = f; });
    const dl = s.dl || {}, inst = (s.app || {}).install || {};
    if (ffWasActive && !dl.active && !dl.err && s.ffmpeg && hadFF) ffDoneUntil = Date.now() + 8000;
    if (!dl.active) hadFF = !!s.ffmpeg;
    ffWasActive = !!dl.active;
    if (setupState === 'auto' && inst.supported && inst.offer && !(s.app || {}).setupSeen) openSetup();
    newsBanner(s); appBanner(s); ffBanner(s); renderSetup(s); renderInstallBtn(s);
    renderOut();
    const fl = s.files || [];
    const done = fl.filter(f => ['ok','error','skipped','kept','canceled'].includes(f.status)).length;
    const part = fl.filter(f => f.status === 'running').reduce((a, f) => a + (f.pct || 0) / 100, 0);
    $('total').style.width = fl.length ? ((done + part) / fl.length * 100) + '%' : '0';
    renderSummary(s);
    if (conv) batchEvents(s);
    if (doneSeq === null) doneSeq = s.batchSeq;   // пачки до открытия страницы не наши
    if (!s.running && s.batchSeq !== doneSeq) { doneSeq = s.batchSeq; batchSound(s); conv ? batchDone(s) : bDone(s); }
    if (s.app && $('appVer').textContent === '') $('appVer').textContent = 'v' + s.app.version + ' · ';
    const log = $('logWrap'), bottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
    const logText = (s.log || []).join('\n');
    if (log.textContent !== logText) log.textContent = logText;   // иначе сбрасывается выделение текста в логе
    if (bottom) log.scrollTop = log.scrollHeight;
    updateButtons(); render(); bRender(); mtRender();
  }
  setTimeout(poll, 700);
}

