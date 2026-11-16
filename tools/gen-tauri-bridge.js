#!/usr/bin/env node
'use strict';
/*
 * Генератор моста между интерфейсом панели и Rust-ядром (Tauri).
 *
 *   node tools/gen-tauri-bridge.js
 *
 * Читает preload.js (154 метода, которыми пользуется ui/app.js) и собирает
 * ui/tauri-bridge.js с той же самой таблицей методов. Благодаря этому
 * интерфейс не переписывается: в Tauri он получает window.desktop,
 * который умеет то же самое, но зовёт Rust.
 *
 * Правила разбора:
 *   ipcRenderer.invoke('a:b', x)  → команда Rust (ipc_invoke)
 *   ipcRenderer.on('a:b', ...)    → подписка на событие (listen)
 *   ipcRenderer.send('a:b', x)    → односторонняя отправка (emit)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'preload.js');
const OUT = path.join(ROOT, 'ui', 'tauri-bridge.js');

/* комментарии-строки убираем заранее: иначе регулярка «съедает» метод после комментария */
const text = fs.readFileSync(SRC, 'utf8')
  .split('\n')
  .filter((line) => !/^\s*\/\*.*\*\/\s*$/.test(line))
  .join('\n');

/** Вытаскиваем «имя метода: (аргументы) => ipcRenderer.X('канал', ...)». */
function parse(js) {
  const out = [];
  const re = /^\s{2}([A-Za-z_][A-Za-z0-9_]*):\s*(?:\(([^)]*)\)|([A-Za-z0-9_]+))\s*=>\s*([\s\S]*?)(?=,\n\s{2}[A-Za-z_]|\n\}\);)/gm;
  let m;
  while ((m = re.exec(js))) {
    const name = m[1];
    const args = (m[2] || m[3] || '').trim();
    const body = m[4];
    const call = body.match(/ipcRenderer\.(invoke|on|send)\(\s*'([^']+)'/);
    if (!call) continue;
    const kind = call[1] === 'invoke' ? 'invoke' : call[1] === 'on' ? 'event' : 'send';
    const channel = call[2];
    const argc = args ? args.split(',').map((a) => a.trim()).filter(Boolean).length : 0;
    /* для событий первый аргумент — функция-обработчик, её в Rust не передаём */
    const passthrough = kind === 'event' ? 0 : argc;
    out.push({ name, channel, kind, argc: passthrough });
  }
  return out;
}

const methods = parse(text);
if (methods.length < 100) {
  console.error(`Разобрано слишком мало методов (${methods.length}) — проверь preload.js`);
  process.exit(1);
}

const lines = methods.map((m) => `  ${JSON.stringify(m.name)}: [${JSON.stringify(m.channel)}, ${m.argc}, ${JSON.stringify(m.kind)}],`);

const bridge = `/* ЭТОТ ФАЙЛ СОБИРАЕТСЯ АВТОМАТИЧЕСКИ: node tools/gen-tauri-bridge.js
 *
 * Мост «интерфейс → Rust» для сборки на Tauri. В Electron он молчит и ничего
 * не делает: там window.desktop уже создаёт preload.js.
 *
 * Таблица ниже — это ровно те же ${methods.length} методов, которыми пользуется
 * интерфейс. Пока команда не перенесена в Rust, она отвечает понятной ошибкой,
 * а не молча ломает окно.
 */
(function bridgeToRust() {
  'use strict';
  const tauri = window.__TAURI__;
  if (!tauri || !tauri.core || !tauri.core.invoke) return;

  const invoke = tauri.core.invoke;
  const listen = tauri.event && tauri.event.listen;

  const TABLE = {
${lines.join('\n')}
  };

  const api = {
    mode: 'desktop',
    tauri: true,
  };

  for (const [name, entry] of Object.entries(TABLE)) {
    const [channel, argc, kind] = entry;
    if (kind === 'event') {
      api[name] = async (cb) => {
        if (typeof cb !== 'function' || !listen) return () => {};
        await listen(channel, (event) => cb(event.payload));
        return () => {};
      };
    } else if (kind === 'send') {
      api[name] = (...args) => {
        invoke('ipc_send', { channel, args: args.slice(0, argc) }).catch(() => {});
      };
    } else {
      api[name] = async (...args) => {
        try {
          return await invoke('ipc_invoke', { channel, args: args.slice(0, argc) });
        } catch (err) {
          const text = String((err && err.message) || err);
          if (text.includes('не перенесено')) {
            throw new Error(text);
          }
          throw err instanceof Error ? err : new Error(text);
        }
      };
    }
  }

  /* интерфейс ждёт window.desktop — отдаём ему мост */
  window.desktop = api;
  if (window.__omnipanelBridge) window.__omnipanelBridge.ready = true;
})();
`;

fs.writeFileSync(OUT, bridge, 'utf8');

/* ── насколько переезд продвинулся: сверяем мост с тем, что умеет Rust ── */
const rustSrc = path.join(ROOT, 'rust', 'omnipanel-core', 'src', 'app.rs');
let ready = new Set();
if (fs.existsSync(rustSrc)) {
  const rust = fs.readFileSync(rustSrc, 'utf8');
  const block = rust.match(/READY_CHANNELS: &\[&str\] = &\[([\s\S]*?)\];/);
  if (block) {
    for (const m of block[1].matchAll(/"([^"]+)"/g)) ready.add(m[1]);
  }
}
const channels = [...new Set(methods.map((m) => m.channel))];
const done = channels.filter((c) => ready.has(c));
const left = channels.filter((c) => !ready.has(c));
const byModule = {};
for (const c of left) {
  const mod = c.split(':')[0];
  byModule[mod] = (byModule[mod] || 0) + 1;
}
console.log(`перенесено в Rust: ${done.length} из ${channels.length} каналов`);
if (left.length) {
  const list = Object.entries(byModule)
    .sort((a, b) => b[1] - a[1])
    .map(([m, n]) => `${m}:${n}`)
    .join(', ');
  console.log(`  ещё не перенесено (${left.length}): ${list}`);
}
const unknown = [...ready].filter((c) => !channels.includes(c));
if (unknown.length) {
  console.log(`  внимание: Rust умеет каналы, которых нет в preload.js: ${unknown.join(', ')}`);
}
const counts = methods.reduce((acc, m) => { acc[m.kind] = (acc[m.kind] || 0) + 1; return acc; }, {});
console.log(`мост собран: ${path.relative(ROOT, OUT)}`);
console.log(`  всего методов: ${methods.length} (команды ${counts.invoke || 0}, события ${counts.event || 0}, отправка ${counts.send || 0})`);
