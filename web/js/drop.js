// ---------- диалоги ----------
async function dialog(fn) { if (busy) return; busy = true; try { await fn(); } finally { busy = false; } }
$('addFiles').onclick = () => dialog(async () => { const r = await api('pick-files'); if (r.error) alert(r.error); addInfos(r.files); });
$('addFolder').onclick = () => dialog(async () => { const r = await api('pick-folder', {purpose:'add'}); if (r.error) alert(r.error); addInfos(r.files); });
$('pickOut').onclick = () => dialog(async () => {
  const r = await api('pick-folder', {purpose:'out'});
  if (r.error) alert(r.error);
  if (r.path) { $('outDir').value = r.path; outMode = 'folder'; save(); renderOut(); }
});

// ---------- перетаскивание ----------
let dragDepth = 0;
let dropAim = null;   // куда на дорожках бросили: пути файлов приходят от программы позже
const dropEl = () => $(tab === 'color' ? 'clView' : tab === 'util' ? 'fvDrop' : tab === 'banner' ? 'bDrop' :tab === 'play' ? 'plDrop' : tab === 'mont' ? 'mtDrop' : 'drop');
const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; if (tab === 'util') fvDropHover(e); else if (tab !== 'color') dropEl().classList.add('over'); });
window.addEventListener('dragover', e => {
  if (!hasFiles(e)) return;
  e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
  if (tab === 'util') fvDropHover(e);   // подсвечивается ячейка иконки, а не всё окно
  if (tab === 'mont') dropEl().classList.toggle('over', !mtDropHover(e));   // над дорожкой файл встанет на неё, окно файлов не подсвечивается
});
window.addEventListener('dragleave', e => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth) return;
  dropEl().classList.remove('over'); fvDropHover(null);
  if (tab === 'mont') mtDropHide();
});
window.addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; dropEl().classList.remove('over'); fvDropHover(null);
  const aim = tab === 'mont' ? mtDropHover(e) : null;
  if (tab === 'mont') mtDropHide();
  if (tab === 'color') return;   // на вкладку «Цвет» файлы пока не бросают (палитра из фото будет на этапе 2)
  if (tab === 'util') { fvDrop(e); return; }   // фавиконам нужен сам файл в окне, путь на диске не нужен
  if (snap.running &&tab !== 'play' && tab !== 'mont') return;   // смотреть и монтировать можно и во время конвертации
  if (NATIVE_DROP) {
    try { window.chrome.webview.postMessageWithAdditionalObjects('konv:drop', e.dataTransfer.files); dropAim = aim; return; } catch (err) {}
  }
  if (tab === 'play' || tab === 'mont') {   // браузер даёт только копии, а плееру и монтажу нужен сам файл
    say('warn', t('drop.notSuitableTitle'), t('pl.noDrop'));
    return;
  }
  if (tab === 'banner') {   // браузер даёт только копии, а пережатые PNG надо записать на место
    say('warn', t('drop.notSuitableTitle'), t('drop.notSuitable'));
    return;
  }
  // entries нужно получить синхронно, пока dataTransfer жив
  const entries = [];
  for (const it of e.dataTransfer.items) {
    const en = it.webkitGetAsEntry && it.webkitGetAsEntry();
    if (en) entries.push(en); else if (it.kind === 'file') { const f = it.getAsFile(); if (f) entries.push({plain:f}); }
  }
  collect(entries).then(list => enqueueUpload(list));
});
window.__konvDrop = list => {
  const aim = dropAim;
  dropAim = null;
  if (tab === 'mont' && aim) mtAddAt(list, aim);
  else if (tab === 'banner') bAdd(list);
  else if (tab === 'play') plAdd(list);
  else if (tab === 'mont') mtAdd(list);
  else addInfos(list);
};
function readAll(reader) {
  return new Promise(res => {
    const out = [];
    const step = () => reader.readEntries(b => { if (!b.length) res(out); else { out.push(...b); step(); } }, () => res(out));
    step();
  });
}
async function walk(en, inDir, out) {
  if (en.plain) { out.push(en.plain); return; }
  if (en.isFile) {
    const f = await new Promise(r => en.file(r, () => r(null)));
    if (f && (!inDir || MEDIA.test(f.name))) out.push(f);
  } else if (en.isDirectory) {
    for (const ch of await readAll(en.createReader())) await walk(ch, true, out);
  }
}
async function collect(entries) { const out = []; for (const en of entries) await walk(en, false, out); return out; }

function enqueueUpload(list) {
  for (const f of list) {
    const it = {name: f.name, dir: '', path: null, size: f.size, uploading: true, temp: true, sel: true};
    files.push(it); pending++;
    uploadChain = uploadChain.then(async () => {
      try {
        const r = await fetch('/api/upload?name=' + encodeURIComponent(f.name), {method:'POST', headers:{'X-Token':TOKEN}, body: f});
        const j = await r.json();
        if (j.path) { it.path = j.path; it.size = j.size; it.uploading = false; }
        else { files = files.filter(x => x !== it); alert(t('drop.copyFailed', {name: f.name, err: j.error || ''})); }
      } catch (e) { files = files.filter(x => x !== it); }
      pending--; render(); updateButtons();
    });
  }
  render(); updateButtons();
}

// Изнутри программы системное перетаскивание не нужно: файлы и клипы переносятся своим кодом, а оно оборвало бы их на полпути.
document.addEventListener('dragstart', e => e.preventDefault());
