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
const dropEl = () => $(tab === 'banner' ? 'bDrop' : 'drop');
const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; dropEl().classList.add('over'); });
window.addEventListener('dragover', e => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
window.addEventListener('dragleave', e => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropEl().classList.remove('over'); });
window.addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; dropEl().classList.remove('over');
  if (snap.running) return;
  if (NATIVE_DROP) {
    try { window.chrome.webview.postMessageWithAdditionalObjects('konv:drop', e.dataTransfer.files); return; } catch (err) {}
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
window.__konvDrop = list => tab === 'banner' ? bAdd(list) : addInfos(list);
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

