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
const GROUPS = [['Видео',['mp4','mp4h265','webm','mov','mkv']],['Фото',['jpg','png','webp']],['Аудио',['mp3','m4a','ogg','wav','flac']],['Анимация',['gif']],['Сжатие',['small']]];
// пресет — готовый рецепт под задачу: всё, что в нём не указано, берётся из PRESET_BASE
const PRESET_BASE = {codec:'h265', target:'', crf:23, speed:'medium', abr:192, height:'', fps:''};
const PRESETS = [
  {n:'Сжать файлы', d:'Формат прежний, на глаз разницы нет', s:{format:'small', crf:26}},
  {n:'Видео для почты', d:'До 25 МБ, открывается везде', s:{format:'small', codec:'h264', target:25}},
  {n:'Видео для сайта', d:'И для чатов: MP4, 720p, лёгкий файл', s:{format:'mp4', crf:25, abr:128, height:720}},
  {n:'Достать звук', d:'Из видео в MP3, 192 kbps', s:{format:'mp3'}},
  {n:'GIF из видео', d:'480p, 15 кадров в секунду', s:{format:'gif', height:480, fps:15}},
  {n:'Фото для сайта', d:'WEBP, размер в пикселях прежний', s:{format:'webp'}}
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

