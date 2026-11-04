const TOKEN = '__TOKEN__';
const NATIVE = !!(window.chrome && window.chrome.webview);   // своё окно программы (WebView2)
const NATIVE_DROP = NATIVE && typeof window.chrome.webview.postMessageWithAdditionalObjects === 'function';
if (NATIVE) document.documentElement.classList.add('native');
const FORMATS = {
  small:{n:'Сжать, формат как был',k:'small'},
  mp4:{n:'MP4 H.264',k:'video'}, mp4h265:{n:'MP4 H.265',k:'video'}, webm:{n:'WebM',k:'video'},
  mov:{n:'MOV',k:'video'}, mkv:{n:'MKV без перекодирования',k:'copy'},
  gif:{n:'GIF',k:'gif'}, png:{n:'PNG',k:'image'}, jpg:{n:'JPG',k:'image'}, webp:{n:'WEBP',k:'image'},
  mp3:{n:'MP3',k:'audio'}, m4a:{n:'M4A',k:'audio'}, ogg:{n:'OGG',k:'audio'}, wav:{n:'WAV',k:'audio'}, flac:{n:'FLAC',k:'audio'}
};
const GROUPS = [['Сжатие',['small']],['Видео',['mp4','mp4h265','webm','mov','mkv']],['Анимация и картинки',['gif','png','jpg','webp']],['Аудио',['mp3','m4a','ogg','wav','flac']]];
const PRESETS = [
  {n:'Сжать без потери качества', s:{format:'small', codec:'h265', crf:26, speed:'medium', height:'', fps:''}},
  {n:'Видео до 25 МБ для почты', s:{format:'small', codec:'h264', crf:23, speed:'medium', target:25, height:'', fps:''}},
  {n:'720p для сайта', s:{format:'mp4', crf:25, speed:'medium', height:'720'}},
  {n:'Только звук MP3', s:{format:'mp3', abr:192}},
  {n:'GIF 480p', s:{format:'gif', height:'480', fps:'15'}},
  {n:'Картинки в WebP', s:{format:'webp', height:''}}
];
const MEDIA = /\.(mp4|mov|mkv|avi|webm|flv|wmv|m4v|mpg|mpeg|ts|mts|3gp|gif|mp3|wav|flac|m4a|aac|ogg|opus|wma|png|jpe?g|webp|bmp|tiff?)$/i;
const $ = id => document.getElementById(id);
let files = [];            // {name, dir, path, size, uploading, temp, sel}
let fmt = 'mp4';
let snap = {files:[], running:false, ffmpeg:'', dl:{}, log:[], summary:'', defaultOut:''};
let hadFF = false, prevRunning = false, busy = false, uploadChain = Promise.resolve(), pending = 0;

async function api(path, body) {
  try {
    const r = await fetch('/api/' + path, {method:'POST', headers:{'X-Token':TOKEN,'Content-Type':'application/json'}, body: JSON.stringify(body || {})});
    return await r.json();
  } catch (e) { return {error:'нет связи с программой'}; }
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const base = p => p.split(/[\\/]/).pop();
const dirOf = p => p.slice(0, p.length - base(p).length);
const ext = n => (n.match(/\.([^.]+)$/) || [,'?'])[1].slice(0, 4);
function fmtSize(n) {
  if (!n) return '';
  const u = ['Б','КБ','МБ','ГБ']; let i = 0;
  while (n >= 1024 && i < 3) { n /= 1024; i++; }
  return (n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)).toString().replace('.', ',') + ' ' + u[i];
}

