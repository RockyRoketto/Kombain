const TOKEN = '__TOKEN__';
const NATIVE = !!(window.chrome && window.chrome.webview);   // своё окно программы (WebView2)
const NATIVE_DROP = NATIVE && typeof window.chrome.webview.postMessageWithAdditionalObjects === 'function';
if (NATIVE) document.documentElement.classList.add('native');
const FORMATS = {
  small:{i:'fmt.small',k:'small'},
  mp4:{n:'MP4 H.264',k:'video'}, mp4h265:{n:'MP4 H.265',k:'video'}, webm:{n:'WebM',k:'video'},
  mov:{n:'MOV',k:'video'}, mkv:{i:'fmt.mkv',k:'copy'},
  gif:{n:'GIF',k:'gif'}, png:{n:'PNG',k:'image'}, jpg:{n:'JPG',k:'image'}, webp:{n:'WEBP',k:'image'},
  mp3:{n:'MP3',k:'audio'}, m4a:{n:'M4A',k:'audio'}, ogg:{n:'OGG',k:'audio'}, wav:{n:'WAV',k:'audio'}, flac:{n:'FLAC',k:'audio'}
};
const fmtName = id => FORMATS[id].i ? t(FORMATS[id].i) : FORMATS[id].n;
const GROUPS = [['group.video',['mp4','mp4h265','webm','mov','mkv']],['group.photo',['jpg','png','webp']],['group.audio',['mp3','m4a','ogg','wav','flac']],['group.anim',['gif']],['group.compress',['small']]];
// пресет — готовый рецепт под задачу: всё, что в нём не указано, берётся из PRESET_BASE
const PRESET_BASE = {codec:'h265', target:'', crf:23, speed:'medium', abr:192, height:'', fps:''};
const PRESETS = [
  {n:'preset.compress.n', d:'preset.compress.d', s:{format:'small', crf:26}},
  {n:'preset.mail.n', d:'preset.mail.d', s:{format:'small', codec:'h264', target:25}},
  {n:'preset.site.n', d:'preset.site.d', s:{format:'mp4', crf:25, abr:128, height:720}},
  {n:'preset.audio.n', d:'preset.audio.d', s:{format:'mp3'}},
  {n:'preset.gif.n', d:'preset.gif.d', s:{format:'gif', height:480, fps:15}},
  {n:'preset.photo.n', d:'preset.photo.d', s:{format:'webp'}}
];
const MEDIA = /\.(mp4|mov|mkv|avi|webm|flv|wmv|m4v|mpg|mpeg|ts|mts|3gp|gif|mp3|wav|flac|m4a|aac|ogg|opus|wma|png|jpe?g|webp|bmp|tiff?)$/i;
const $ = id => document.getElementById(id);
let files = [];            // {name, dir, path, size, uploading, temp, sel}
let fmt = 'mp4';
let snap = {files:[], running:false, ffmpeg:'', dl:{}, log:[], summary:'', defaultOut:''};
let hadFF = false, doneSeq = null, busy = false, uploadChain = Promise.resolve(), pending = 0;

async function api(path, body) {
  try {
    const r = await fetch('/api/' + path, {method:'POST', headers:{'X-Token':TOKEN,'Content-Type':'application/json'}, body: JSON.stringify(body || {})});
    return await r.json();
  } catch (e) { return {error:t('net.err')}; }
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const base = p => p.split(/[\\/]/).pop();
const dirOf = p => p.slice(0, p.length - base(p).length);
const ext = n => (n.match(/\.([^.]+)$/) || [,'?'])[1].slice(0, 4);
function fmtSize(n) {
  if (!n) return '';
  const u = t('unit.sizes').split('|'); let i = 0;
  while (n >= 1024 && i < 3) { n /= 1024; i++; }
  const v = (n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)).toString();
  return (lang === 'ru' ? v.replace('.', ',') : v) + ' ' + u[i];
}

