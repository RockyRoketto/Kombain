const TOKEN = '__TOKEN__';
const NATIVE = !!(window.chrome && window.chrome.webview);   // своё окно программы (WebView2)
const NATIVE_DROP = NATIVE && typeof window.chrome.webview.postMessageWithAdditionalObjects === 'function';
if (NATIVE) document.documentElement.classList.add('native');
const FORMATS = {
  small:{i:'fmt.small',k:'small'},
  // видео
  mp4:{n:'MP4 H.264',k:'video'}, mp4h265:{n:'MP4 H.265',k:'video'}, mp4av1:{n:'MP4 AV1',k:'video'},
  webm:{n:'WebM',k:'video'}, webmvp8:{n:'WebM VP8',k:'video'}, webmav1:{n:'WebM AV1',k:'video'},
  mov:{n:'MOV',k:'video'}, mov265:{n:'MOV H.265',k:'video'}, mkv:{i:'fmt.mkv',k:'copy'}, mkv264:{n:'MKV H.264',k:'video'}, mkv265:{n:'MKV H.265',k:'video'},
  m4v:{n:'M4V',k:'video'}, avi264:{n:'AVI H.264',k:'video'}, avixvid:{n:'AVI Xvid',k:'vfix'}, wmv:{n:'WMV',k:'vfix'}, flv:{n:'FLV',k:'video'},
  mpg1:{n:'MPG MPEG-1',k:'vfix'}, mpg2:{n:'MPG MPEG-2',k:'vfix'}, vob:{n:'VOB',k:'vfix'}, ts:{n:'TS',k:'video'}, m2ts:{n:'M2TS',k:'video'}, '3gp':{n:'3GP',k:'video'}, ogv:{n:'OGV',k:'vfix'},
  // для монтажа
  prores422:{n:'ProRes 422',k:'pro'}, prores4444:{n:'ProRes 4444',k:'pro'}, dnxhr:{n:'DNxHR',k:'pro'}, dnxhrmxf:{n:'DNxHR MXF',k:'pro'}, mxf:{n:'MXF MPEG-2',k:'pro'},
  cineform:{n:'CineForm',k:'pro'}, ffv1:{n:'FFV1',k:'pro'}, utvideo:{n:'Ut Video',k:'pro'}, huffyuv:{n:'HuffYUV',k:'pro'}, qtrle:{n:'QuickTime RLE',k:'pro'}, x264ll:{i:'fmt.x264ll',k:'pro'}, mjpeg:{n:'MJPEG',k:'pro'},
  // картинки
  jpg:{n:'JPG',k:'image'}, png:{n:'PNG',k:'image'}, webp:{n:'WEBP',k:'image'}, avif:{n:'AVIF',k:'image'}, tiff:{n:'TIFF',k:'image'}, bmp:{n:'BMP',k:'image'}, tga:{n:'TGA',k:'image'},
  jp2:{n:'JPEG 2000',k:'image'}, ico:{n:'ICO',k:'image'}, dpx:{n:'DPX',k:'image'}, exr:{n:'EXR',k:'image'}, hdr:{n:'HDR',k:'image'}, qoi:{n:'QOI',k:'image'},
  // анимация
  gif:{n:'GIF',k:'gif'}, apng:{n:'APNG',k:'anim'}, animwebp:{i:'fmt.animwebp',k:'anim'}, animavif:{i:'fmt.animavif',k:'anim'},
  // звук
  mp3:{n:'MP3',k:'audio'}, m4a:{n:'M4A',k:'audio'}, aac:{n:'AAC',k:'audio'}, ogg:{n:'OGG',k:'audio'}, opus:{n:'Opus',k:'audio'}, vorbis:{n:'OGG Vorbis',k:'audio'}, wma:{n:'WMA',k:'audio'},
  ac3:{n:'AC3',k:'audio'}, eac3:{n:'E-AC3',k:'audio'}, mp2:{n:'MP2',k:'audio'}, dts:{n:'DTS',k:'fixed'}, amr:{n:'AMR',k:'fixed'},
  wav:{n:'WAV',k:'fixed'}, flac:{n:'FLAC',k:'fixed'}, alac:{n:'ALAC',k:'fixed'}, aiff:{n:'AIFF',k:'fixed'}, wv:{n:'WavPack',k:'fixed'}, tta:{n:'TTA',k:'fixed'}, mka:{n:'MKA',k:'fixed'}, caf:{n:'CAF',k:'fixed'}, w64:{n:'W64',k:'fixed'},
  // редкие
  dv:{n:'DV',k:'fixed'}, nut:{n:'NUT',k:'video'}, '3g2':{n:'3G2',k:'video'}, asf:{n:'ASF',k:'vfix'}, swf:{n:'SWF',k:'vfix'}, rm:{n:'RealMedia',k:'vfix'},
  ppm:{n:'PPM',k:'image'}, pam:{n:'PAM',k:'image'}, pcx:{n:'PCX',k:'image'}, sgi:{n:'SGI',k:'image'}, ras:{n:'Sun Raster',k:'image'}, xbm:{n:'XBM',k:'image'}, xwd:{n:'XWD',k:'image'},
  au:{n:'AU',k:'fixed'}, voc:{n:'VOC',k:'fixed'}, gsm:{n:'GSM',k:'fixed'}, spx:{n:'Speex',k:'fixed'}, mmf:{n:'MMF',k:'fixed'}
};
const fmtName = id => FORMATS[id].i ? t(FORMATS[id].i) : FORMATS[id].n;
// и категории, и форматы внутри идут от самых ходовых к редким; третье значение: группа свёрнута под кнопкой «Ещё»
const GROUPS = [
  ['group.video',['mp4','mp4h265','webm','mov','mkv','avi264','mp4av1','wmv','mkv264','mkv265','mov265','flv','ts','mpg2','m4v','avixvid','webmav1','webmvp8','m2ts','vob','3gp','mpg1','ogv']],
  ['group.compress',['small']],
  ['group.photo',['jpg','png','webp','tiff','bmp','avif','ico','tga','jp2','exr','hdr','dpx','qoi']],
  ['group.audio',['mp3','m4a','aac','ogg','wma','opus','ac3','vorbis','eac3','mp2','dts','amr']],
  ['group.lossless',['wav','flac','alac','aiff','mka','wv','tta','caf','w64']],
  ['group.anim',['gif','animwebp','apng','animavif']],
  ['group.pro',['prores422','prores4444','dnxhr','mjpeg','dnxhrmxf','mxf','cineform','ffv1','x264ll','qtrle','huffyuv','utvideo']],
  ['group.rare',['dv','asf','swf','rm','3g2','nut','pcx','ppm','pam','sgi','ras','xwd','xbm','au','voc','spx','gsm','mmf'],true]
];
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
const MEDIA = /\.(mp4|mov|mkv|avi|webm|flv|wmv|m4v|mpg|mpeg|ts|mts|m2ts|mxf|vob|ogv|dv|nut|3gp|3g2|asf|f4v|rm|rmvb|divx|swf|gif|apng|mp3|wav|flac|m4a|m4b|aac|ogg|oga|opus|wma|aiff?|ac3|eac3|dts|mp2|wv|tta|mka|caf|au|w64|amr|awb|spx|gsm|voc|mmf|ra|ape|png|jpe?g|webp|bmp|tiff?|avif|jp2|j2k|tga|ico|dpx|exr|hdr|qoi|ppm|pgm|pbm|pam|pcx|sgi|ras|xbm|xwd)$/i;
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

