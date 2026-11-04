// ---------- звуки окончания и ошибки ----------
// Выбор хранится в localStorage: '' — стандартный звук, иначе путь к файлу.
const SOUND_STD = {done: 'tada', error: 'Windows Critical Stop'};
const SOUND_SEL = {done: 'soundDone', error: 'soundError'};
const SOUND_PICK = '*';         // пункт «Свой файл…»
const SOUND_MAX_MS = 10000;     // длинный свой файл не играет дольше
let systemSoundList = [];
let soundPick = {done: '', error: ''};
try {
  const o = JSON.parse(localStorage.getItem('konv9000.sounds') || '{}');
  Object.keys(soundPick).forEach(k => { if (typeof o[k] === 'string') soundPick[k] = o[k]; });
} catch (e) {}
function saveSounds() { try { localStorage.setItem('konv9000.sounds', JSON.stringify(soundPick)); } catch (e) {} }
function soundPath(kind) {
  if (soundPick[kind]) return soundPick[kind];
  const s = systemSoundList.find(x => x.name === SOUND_STD[kind]);
  return s ? s.path : '';
}
// простой сигнал, когда файла нет: окончание идёт вверх, ошибка вниз
function beep(kind) {
  try {
    const c = new (window.AudioContext || window.webkitAudioContext)();
    (kind === 'error' ? [440, 294] : [660, 880]).forEach((f, i) => {
      const t = c.currentTime + i * .14, o = c.createOscillator(), g = c.createGain();
      o.frequency.value = f; o.connect(g); g.connect(c.destination);
      g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(.12, t + .02); g.gain.exponentialRampToValueAtTime(.0001, t + .18);
      o.start(t); o.stop(t + .2);
    });
  } catch (e) {}
}
let soundNow = null, soundTimer = 0;
// onFail: файл не сыграл, вместо него прозвучал простой сигнал
function playSound(kind, onFail) {
  if (soundNow) soundNow.pause();
  clearTimeout(soundTimer);
  const p = soundPath(kind);
  soundNow = null;
  if (!p) { beep(kind); return; }
  const a = soundNow = new Audio(`/media?t=${TOKEN}&p=${encodeURIComponent(p)}`);
  const fail = () => {
    if (soundNow !== a) return;   // уже играет другой звук, это его прервали
    soundNow = null;
    beep(kind);
    if (onFail) onFail();
  };
  a.onerror = fail;
  const started = a.play();
  if (started) started.catch(fail);
  soundTimer = setTimeout(() => a.pause(), SOUND_MAX_MS);
}
// один звук на пачку: хоть одна ошибка — звук ошибки; остановил сам — тишина
function batchSound(s) {
  const fl = s.files || [];
  if (fl.some(f => f.status === 'error')) playSound('error');
  else if (!fl.some(f => f.status === 'canceled')) playSound('done');
}
function renderSounds() {
  Object.keys(SOUND_SEL).forEach(kind => {
    const sel = $(SOUND_SEL[kind]), cur = soundPick[kind];
    const opts = [['', t('sound.std')]];
    systemSoundList.forEach(s => { if (s.name !== SOUND_STD[kind]) opts.push([s.path, s.name]); });
    if (cur && !opts.some(o => o[0] === cur)) opts.push([cur, base(cur)]);
    opts.push([SOUND_PICK, t('sound.pick')]);
    sel.replaceChildren(...opts.map(([v, n]) => new Option(n, v)));
    sel.value = cur;
    sel.title = cur;
  });
}
Object.keys(SOUND_SEL).forEach(kind => {
  const sel = $(SOUND_SEL[kind]);
  sel.addEventListener('change', () => {
    if (sel.value !== SOUND_PICK) { soundPick[kind] = sel.value; sel.title = sel.value; saveSounds(); return; }
    sel.value = soundPick[kind];   // отменил диалог — остаётся прежний
    dialog(async () => {
      const r = await api('pick-sound');
      if (r.error) alert(r.error);
      if (r.path) { soundPick[kind] = r.path; saveSounds(); renderSounds(); }
    });
  });
  $(SOUND_SEL[kind] + 'Test').onclick = () => playSound(kind, () => say('warn', t('sound.failTitle'), t('sound.failText')));
});
renderSounds();
api('sounds').then(r => { systemSoundList = r.sounds || []; renderSounds(); });

