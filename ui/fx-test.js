/*
 * Проверка эффектов панели без браузера: частицы и след за курсором.
 *
 * Запуск:  node ui/fx-test.js
 *
 * Браузера в сборочной среде нет, поэтому canvas поддельный: он считает
 * вызовы arc/stroke/line, а не рисует. Сам код эффектов берётся из ui/app.js
 * как есть (между метками), чтобы тест не разошёлся с настоящей панелью.
 */

const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const START = '/* ═════════════════════ частицы и след за курсором ═════════════════════ */';
const END = '/* ═════════════════════ звуки (WebAudio, без файлов) ═════════════════════ */';
const from = source.indexOf(START);
const to = source.indexOf(END);
if (from < 0 || to < 0) {
  console.error('в ui/app.js не нашлись метки блока эффектов');
  process.exit(1);
}
const block = source.slice(from, to);

const calls = { arc: 0, line: 0, fill: 0, stroke: 0, clear: 0 };

function fakeCtx() {
  return {
    globalAlpha: 1,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: '',
    lineJoin: '',
    shadowColor: '',
    shadowBlur: 0,
    setTransform() {},
    save() {},
    restore() {},
    clearRect() { calls.clear += 1; },
    beginPath() {},
    moveTo() {},
    lineTo() { calls.line += 1; },
    arc() { calls.arc += 1; },
    fill() { calls.fill += 1; },
    stroke() { calls.stroke += 1; },
  };
}

const listeners = {};
const sandbox = {
  THEMES: { dark: { label: 'Тёмная', text: '#ececee', accent: '#8ab4ff' } },
  prefs: {
    fx: true,
    theme: 'dark',
    custom: null,
    ambient: 'snow',
    ambientDensity: 100,
    ambientOpacity: 80,
    ambientColor: '',
    effectSize: 100,
    trail: true,
    trailStyle: 'sparks',
    trailSize: 60,
    trailLength: 40,
    trailOpacity: 35,
    trailColor: '',
  },
  mix(a, b, ratio) {
    const hex = (h) => [1, 3, 5].map((i) => parseInt(String(h).slice(i, i + 2), 16));
    const pa = hex(a);
    const pb = hex(b);
    return ('#' + pa.map((v, i) => Math.round(v + (pb[i] - v) * ratio).toString(16).padStart(2, '0')).join(''));
  },
  $: () => null,
  Sound: { play() {} },
  setTimeout,
  clearTimeout,
  window: {
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 2,
    addEventListener(name, fn) {
      (listeners[name] = listeners[name] || []).push(fn);
    },
  },
  document: {
    hidden: false,
    body: { appendChild() {} },
    getElementById: () => null,
    createElement(tag) {
      return {
        tagName: tag,
        id: '',
        className: '',
        style: {},
        isConnected: false,
        width: 0,
        height: 0,
        getContext: () => fakeCtx(),
      };
    },
    addEventListener() {},
  },
  requestAnimationFrame: () => 1,
  performance: { now: () => Date.now() },
};

const names = Object.keys(sandbox);
const runner = new Function(
  ...names,
  `${block}
  return {
    state: fxCanvasState,
    startFx, fxSeed, fxTick, fxResize, fxEnsure, fxCanvas,
    fxAmbientColor, fxTrailColor, fxParticleCount,
    prefs,
  };`,
);
const fx = runner(...names.map((name) => sandbox[name]));
const { prefs, state } = fx;

const problems = [];
const check = (condition, text) => {
  if (!condition) problems.push(text);
};
/* один кадр длиной 50 мс — предел, который ставит сам движок */
const frame = (from, to) => {
  state.last = from;
  fx.fxTick(to);
};

/* ── 1. окно и слежение за курсором ── */
fx.startFx();
check(!!state.ctx, 'canvas не создан');
check(!!listeners.pointermove, 'слежение за курсором не включилось');
fx.fxResize();
check(state.w === 1280 && state.h === 800, `размер холста ${state.w}×${state.h}`);

/* ── 2. плотность частиц: 70 штук при 100 % ── */
fx.fxSeed();
check(state.parts.length === 70, `при 100 % частиц ${state.parts.length}`);
prefs.ambientDensity = 200;
fx.fxSeed();
check(state.parts.length === 140, `при 200 % частиц ${state.parts.length}`);
prefs.ambientDensity = 30;
fx.fxSeed();
check(state.parts.length === 21, `при 30 % частиц ${state.parts.length}`);
prefs.ambientDensity = 100;
fx.fxSeed();

/* ── 3. частицы двигаются и не вылетают за экран ── */
const before = state.parts.map((p) => p.y);
frame(950, 1000);
const moved = state.parts.filter((p, i) => p.y !== before[i]).length;
check(moved > 60, `сдвинулось ${moved} частиц из 70`);
check(
  state.parts.every((p) => p.y > -80 && p.y < 900),
  'частица вышла за экран',
);

/* ── 4. упавшая за нижний край возвращается сверху ── */
state.parts[0] = { x: 100, y: 799, r: 2, vy: 5000, vx: 0, kind: 'snow', alpha: 1, phase: 0 };
frame(1950, 2000);
check(state.parts.length === 70, `частиц стало ${state.parts.length}`);
check(state.parts[0].y < 100, `частица не вернулась сверху: y=${state.parts[0].y}`);

/* ── 5. все виды частиц рисуются ── */
for (const kind of ['snow', 'stars', 'dust', 'sticks']) {
  prefs.ambient = kind;
  fx.fxSeed();
  calls.arc = 0;
  calls.stroke = 0;
  frame(2950, 3000);
  const drawn = calls.arc + calls.stroke;
  check(drawn >= 60, `вид «${kind}» нарисовал всего ${drawn} фигур`);
}

/* ── 6. старые точки следа забываются ── */
prefs.trail = true;
prefs.trailStyle = 'line';
prefs.ambient = 'off';
state.trail = [
  { x: 10, y: 10, t: 0 },
  { x: 20, y: 20, t: 100 },
  { x: 30, y: 30, t: 4850 },
];
calls.line = 0;
frame(4950, 5000);
check(state.trail.length === 1, `в следе осталось ${state.trail.length} точек вместо 1`);

/* ── 7. линия, кисть и свечение рисуются ── */
for (const style of ['line', 'brush', 'glow']) {
  prefs.trailStyle = style;
  state.trail = [
    { x: 10, y: 10, t: 900 },
    { x: 40, y: 60, t: 950 },
    { x: 80, y: 90, t: 990 },
  ];
  calls.arc = 0;
  calls.line = 0;
  calls.fill = 0;
  calls.stroke = 0;
  frame(950, 1000);
  check(calls.arc + calls.line > 0, `след «${style}» ничего не нарисовал`);
}

/* ── 8. искры появляются на движение и гаснут ── */
prefs.trailStyle = 'sparks';
listeners.pointermove[0]({ clientX: 300, clientY: 200 });
listeners.pointermove[0]({ clientX: 340, clientY: 240 });
check(state.sparks.length === 4, `искр ${state.sparks.length} вместо 4`);
let tick = 1000;
for (let i = 0; i < 70; i += 1) {
  frame(tick, tick + 16);
  tick += 16;
}
check(state.sparks.length === 0, `искры не погасли: ${state.sparks.length}`);

/* ── 9. выключенные эффекты не рисуют и не крутят кадры ── */
prefs.fx = false;
calls.arc = 0;
calls.line = 0;
fx.fxTick(9000);
check(calls.arc === 0 && calls.line === 0, 'при выключенных эффектах всё равно рисует');
check(state.raf === 0, 'кадры крутятся при выключенных эффектах');
prefs.fx = true;

/* ── 10. цвета: свой из настроек, иначе из темы ── */
check(fx.fxTrailColor() === '#8ab4ff', `цвет следа не из темы: ${fx.fxTrailColor()}`);
prefs.trailColor = '#ff0000';
check(fx.fxTrailColor() === '#ff0000', 'свой цвет следа не применился');
prefs.trailColor = '';
check(/^#[0-9a-f]{6}$/.test(fx.fxAmbientColor()), `цвет частиц не hex: ${fx.fxAmbientColor()}`);

/* ── 11. «без частиц» очищает список ── */
prefs.ambient = 'off';
fx.fxEnsure();
check(state.parts.length === 0, 'частицы остались при виде «без частиц»');

if (problems.length) {
  console.error('эффекты: есть ошибки');
  for (const text of problems) console.error('  •', text);
  process.exit(1);
}
console.log('эффекты: все проверки прошли');
