// Удаление фона и цветокоррекция в просмотре. Поверх слоя кладётся canvas с WebGL, сам слой становится невидимым, но продолжает играть.
// Формулы те же, что у ffmpeg (tlKeyChain и tlGradeChain в timeline.go): просмотр и результат совпадают.
const chromaLayers = new Map();   // элемент-источник → {cv, gl, u}
const CHROMA_FRAG = `precision mediump float;
varying vec2 v;
uniform sampler2D tex;
uniform vec3 key;
uniform float sim, soft, spill, mode, keyed;
uniform vec3 gain;
uniform float mid, con, bri, sat;
void main() {
  vec4 s = texture2D(tex, v);
  vec3 c = s.rgb;
  float a = 1.0;
  if (keyed > 0.5) {
    float d = length(c - key) / 1.7320508;
    a = soft > 0.0001 ? clamp((d - sim) / soft, 0.0, 1.0) : step(sim, d);
    if (mode > 1.5) c.b = max(c.b - max(c.b - (c.r + c.g) * 0.5, 0.0) * spill, 0.0);
    else if (mode > 0.5) c.g = max(c.g - max(c.g - (c.r + c.b) * 0.5, 0.0) * spill, 0.0);
  }
  c = pow(clamp(c * gain, 0.0, 1.0), vec3(mid));
  c = clamp((c - 0.5) * con + 0.5 + bri, 0.0, 1.0);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = clamp(l + (c - l) * sat, 0.0, 1.0);
  gl_FragColor = vec4(c, a * s.a);
}`;
const CHROMA_VERT = 'attribute vec2 p; varying vec2 v; void main() { v = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }';
function chromaLayer(src) {
  let l = chromaLayers.get(src);
  if (l) return l;
  const cv = document.createElement('canvas');
  cv.className = 'mv-layer';
  const gl = cv.getContext('webgl', {premultipliedAlpha: false, antialias: false});
  if (!gl) return null;
  const prog = gl.createProgram();
  [[gl.VERTEX_SHADER, CHROMA_VERT], [gl.FRAGMENT_SHADER, CHROMA_FRAG]].forEach(([kind, text]) => {
    const sh = gl.createShader(kind);
    gl.shaderSource(sh, text);
    gl.compileShader(sh);
    gl.attachShader(prog, sh);
  });
  gl.bindAttribLocation(prog, 0, 'p');
  gl.linkProgram(prog);
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  const u = {};
  ['key', 'sim', 'soft', 'spill', 'mode', 'keyed', 'gain', 'mid', 'con', 'bri', 'sat'].forEach(n => { u[n] = gl.getUniformLocation(prog, n); });
  l = {cv, gl, u};
  chromaLayers.set(src, l);
  mvCv.appendChild(cv);
  // на паузе кадр меняется только после перемотки или загрузки
  ['seeked', 'loadeddata', 'load'].forEach(n => src.addEventListener(n, () => mvLook()));
  return l;
}
const chromaRGB = hex => [1, 3, 5].map(i => parseInt(hex.substr(i, 2), 16) / 255);
// Какой канал освобождать от отсвета: 1 зелёный, 2 синий, 0 никакой. Как в tlKeyChain
const chromaMode = ([r, g, b]) => g >= r && g >= b ? 1 : b >= r ? 2 : 0;
const chromaGraded = c => !!(c.cBri || c.cCon || c.cMid || c.cSat || c.cTemp || c.cTint);
function chromaShow(src, c, used) {
  if ((!c.key && !chromaGraded(c)) || mv.file) return;
  const w = src.videoWidth || src.naturalWidth, h = src.videoHeight || src.naturalHeight, l = w && h ? chromaLayer(src) : null;
  if (!l) return;
  const {cv, gl, u} = l, rgb = c.key ? chromaRGB(c.key) : [0, 0, 0];
  // Качество просмотра: считать меньше точек. У копии файл уже уменьшен, второй раз не делим
  const it = mtFile(c.path), s = Math.min(1, ((it && it.w) || w) / mvQual / w), cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
  if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; gl.viewport(0, 0, cw, ch); }
  try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src); } catch (err) { return; }
  gl.uniform1f(u.keyed, c.key ? 1 : 0);
  gl.uniform3f(u.gain, 1 + .3 * (c.cTemp || 0), 1 - .3 * (c.cTint || 0), 1 - .3 * (c.cTemp || 0));
  gl.uniform1f(u.mid, Math.pow(2, -(c.cMid || 0)));
  gl.uniform1f(u.con, Math.pow(2, 2 * (c.cCon || 0)));
  gl.uniform1f(u.bri, (c.cBri || 0) / 2);
  gl.uniform1f(u.sat, 1 + (c.cSat || 0));
  gl.uniform3fv(u.key, rgb);
  gl.uniform1f(u.sim, c.keySim || 0);
  gl.uniform1f(u.soft, c.keyBlend || 0);
  gl.uniform1f(u.spill, c.keySpill || 0);
  gl.uniform1f(u.mode, chromaMode(rgb));
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  mvPlace(cv, c);
  cv.style.zIndex = src.style.zIndex;
  cv.style.opacity = src.style.opacity;
  cv.classList.remove('hide');
  src.style.opacity = 0;
  used.add(cv);
}
// Что в этом кадре не показано, прячется; слой от удалённого элемента убирается совсем
function chromaSweep(used) {
  for (const [src, l] of chromaLayers) {
    if (!src.isConnected) { l.cv.remove(); chromaLayers.delete(src); }
    else if (!used.has(l.cv)) l.cv.classList.add('hide');
  }
}

// ---------- пипетка: следующее нажатие во вьюпорте берёт цвет фона ----------
let chromaPick = false;
const chromaPicking = () => chromaPick;
function chromaPickToggle() {
  chromaPick = !chromaPick;
  mvStage.classList.toggle('mv-pick', chromaPick);
}
function chromaSample(src, u, v) {
  const w = src.videoWidth || src.naturalWidth, h = src.videoHeight || src.naturalHeight;
  if (!w || !h) return '';
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d', {willReadFrequently: true});
  g.drawImage(src, 0, 0, w, h);
  // среднее по маленькому квадрату: один пиксель видео шумит
  const x = Math.max(Math.round(u * w) - 2, 0), y = Math.max(Math.round(v * h) - 2, 0), d = g.getImageData(x, y, 5, 5).data, sum = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < d.length; i += 4) { if (d[i + 3]) { sum[0] += d[i]; sum[1] += d[i + 1]; sum[2] += d[i + 2]; n++; } }
  return n ? '#' + sum.map(s => Math.round(s / n).toString(16).padStart(2, '0')).join('') : '';
}
// перехват раньше обработчиков вьюпорта: в этом режиме нажатие не двигает и не выбирает слой
mvStage.addEventListener('pointerdown', e => {
  if (!chromaPick || e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  chromaPickToggle();
  const c = mtFrameOne(), live = c && mv.live.find(x => x.c.id === c.id), src = live ? live.e.el : c && mv.pics.get(c.id);
  if (src) {
    // от точки на экране к точке исходника: без поворота, в долях рамки слоя
    const r = mvCv.getBoundingClientRect(), b = mvBox(c), a = -(c.rot || 0) * Math.PI / 180;
    const dx = e.clientX - r.left - (b.x + b.w / 2) * r.width, dy = e.clientY - r.top - (b.y + b.h / 2) * r.height;
    const u = .5 + (dx * Math.cos(a) - dy * Math.sin(a)) / (b.w * r.width), v = .5 + (dx * Math.sin(a) + dy * Math.cos(a)) / (b.h * r.height);
    const color = u >= 0 && u <= 1 && v >= 0 && v <= 1 ? chromaSample(src, u, v) : '';
    if (color) { tkDo(() => { c.key = color; }); return; }
  }
  mtFramePanel();
}, true);
