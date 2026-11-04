$('exitBtn').onclick = async () => {
  await api('exit');
  document.body.innerHTML = '<p style="padding:40px;color:var(--dim);font:15px system-ui">Программа закрыта. Можно закрыть вкладку.</p>';
};
$('logBtn').onclick = () => $('logWrap').classList.toggle('hide');

function updateButtons() {
  const noFF = !snap.ffmpeg;
  $('start').disabled = snap.running || noFF || pending > 0 || !!(snap.dl && snap.dl.active);
  $('stop').classList.toggle('hide', !snap.running);
  $('addFiles').disabled = $('addFolder').disabled = $('clearBtn').disabled = snap.running;
  $('bAddFiles').disabled = $('bAddFolder').disabled = $('bClear').disabled = snap.running;
  $('bStart').disabled = $('start').disabled;
  $('start').classList.toggle('hide', snap.running || tab !== 'conv');
  $('bStart').classList.toggle('hide', snap.running || tab !== 'banner');
  const anyOk = (snap.files || []).some(f => f.status === 'ok' && f.dst);
  $('openOut').classList.toggle('hide', snap.running || !anyOk);
}
function beep() {
  try {
    const c = new (window.AudioContext || window.webkitAudioContext)();
    [660, 880].forEach((f, i) => {
      const t = c.currentTime + i * .14, o = c.createOscillator(), g = c.createGain();
      o.frequency.value = f; o.connect(g); g.connect(c.destination);
      g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(.12, t + .02); g.gain.exponentialRampToValueAtTime(.0001, t + .18);
      o.start(t); o.stop(t + .2);
    });
  } catch (e) {}
}

async function poll() {
  const s = await api('state');
  if (!s.error) {
    snap = s;
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
    $('summary').textContent = s.running ? `Идёт: ${done} из ${fl.length}` : (s.summary || (pending ? 'Копирую файлы…' : 'Добавь файлы и жми кнопку'));
    document.title = s.running ? `${done}/${fl.length} · Конвертер 9000` : 'Конвертер 9000';
    if (conv) batchEvents(s);
    if (prevRunning && !s.running) { beep(); conv ? batchDone(s) : bDone(s); }
    if (s.app && $('appVer').textContent === '') $('appVer').textContent = 'v' + s.app.version + ' · ';
    prevRunning = s.running;
    const log = $('logWrap'), bottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
    const logText = (s.log || []).join('\n');
    if (log.textContent !== logText) log.textContent = logText;   // иначе сбрасывается выделение текста в логе
    if (bottom) log.scrollTop = log.scrollHeight;
    if (!s.running && !s.summary && !pending && tab === 'banner') $('summary').textContent = 'Добавь PNG, выбери папки и жми «Кодировать»';
    updateButtons(); render(); bRender();
  }
  setTimeout(poll, 700);
}

