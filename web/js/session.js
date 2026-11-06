// ---------- начало и конец работы: возврат проекта после сбоя, вопрос при закрытии ----------
// buttons: [{id, text, primary}]. Ответ: id нажатой кнопки, Esc даёт 'cancel'.
let askDone = null;
function askBox(title, text, buttons) {
  $('askTitle').textContent = title;
  $('askText').textContent = text;
  const act = $('askAct');
  act.textContent = '';
  for (const b of buttons) {
    const el = document.createElement('button');
    el.className = b.primary ? 'btn primary' : 'linkbtn';
    el.textContent = b.text;
    el.onclick = () => askDone(b.id);
    act.append(el);
  }
  $('askBox').classList.remove('hide');
  act.querySelector('.primary').focus();
  return new Promise(res => {
    askDone = id => { askDone = null; $('askBox').classList.add('hide'); res(id); };
  });
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && askDone) { e.stopPropagation(); askDone('cancel'); }
}, true);

// Окно просит закрыться. running: про идущую конвертацию уже спросили и получили согласие.
window.__konvClose = async running => {
  api('close-ack');
  if (askDone) return;
  if (tkDirty()) {
    const a = await askBox(t('close.saveTitle'), t('close.saveText'), [
      {id: 'cancel', text: t('close.cancel')},
      {id: 'drop', text: t('close.drop')},
      {id: 'save', text: t('close.save'), primary: true},
    ]);
    if (a === 'cancel' || (a === 'save' && !await mtProjectSave(false))) return;
  } else if (!running && (files.length || plFiles.length || bFiles.length)) {
    const a = await askBox(t('close.title'), t('close.text'), [
      {id: 'cancel', text: t('close.cancel')},
      {id: 'close', text: t('close.close'), primary: true},
    ]);
    if (a !== 'close') return;
  }
  api('close-go');
};

// Новый запуск чистый. Автосохранение нужно только затем, чтобы вернуть проект после сбоя.
if (NEW_RUN) (async () => {
  let saved = null;
  try { saved = JSON.parse(storeGet(TK_SAVE_KEY) || 'null'); } catch (e) {}
  storeSet(TK_SAVE_KEY, '');
  if (!saved || !Array.isArray(saved.tracks) || !saved.tracks.some(x => x && x.clips && x.clips.length)) return;
  const r = await api('session');
  // без поля dirty проект записала прежняя версия: он мог быть не сохранён, поэтому тоже спрашиваем
  if (saved.dirty !== undefined && !(r.crashed && saved.dirty)) return;
  const a = await askBox(t('restore.title'), t('restore.text'), [
    {id: 'cancel', text: t('restore.no')},
    {id: 'restore', text: t('restore.yes'), primary: true},
  ]);
  if (a !== 'restore' || !tkLoad(saved, saved.path)) return;
  tkSavedWork = '';
  setTab('mont');
  tkChanged();
  mtTextRefresh();
  tkFit();
})();
