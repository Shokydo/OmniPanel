/*
 * Сверка интерфейса и ядра: «кнопка есть, а метода нет» больше не пройдёт.
 *
 * Запуск:  node ui/api-check.js
 *
 * Зачем: окно панели грузит интерфейс с локального сервера, поэтому все вызовы
 * идут через httpApi. Если у метода нет пары — в интерфейсе он просто не
 * работает: так было с переносом файлов (`API.filesMove` отсутствовал, а
 * перетаскивание молча ничего не делало) и с архивами (не было и маршрутов).
 *
 * Что проверяется:
 *  1. каждый вызов `API.метод(` есть в объекте httpApi;
 *  2. каждый адрес `/api/...` из app.js есть в таблице маршрутов http.rs
 *     (точно или как известный префикс вроде /api/servers/);
 *  3. каналы, которые http.rs вызывает нативно, есть в READY_CHANNELS ядра.
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const appJs = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const httpRs = fs.readFileSync(path.join(root, 'rust/omnipanel-core/src/http.rs'), 'utf8');
const appRs = fs.readFileSync(path.join(root, 'rust/omnipanel-core/src/app.rs'), 'utf8');

const problems = [];

/* ── 1. методы клиента ── */

const apiStart = appJs.indexOf('const httpApi = {');
const apiEnd = appJs.indexOf('\n};', apiStart);
if (apiStart < 0 || apiEnd < 0) {
  console.error('в ui/app.js не нашёлся объект httpApi');
  process.exit(1);
}
const apiBlock = appJs.slice(apiStart, apiEnd);
const defined = new Set([
  ...[...apiBlock.matchAll(/async\s+([A-Za-z0-9_]+)\s*\(/g)].map((m) => m[1]),
  ...[...apiBlock.matchAll(/^\s{2}([A-Za-z0-9_]+)\s*\(/gm)].map((m) => m[1]),
]);
const used = new Set([...appJs.matchAll(/API\.([A-Za-z0-9_]+)\s*\(/g)].map((m) => m[1]));
for (const name of [...used].sort()) {
  if (!defined.has(name)) problems.push(`API.${name}() вызывается, но в httpApi его нет`);
}

/* ── 2. маршруты сервера ── */

/* что http.rs понимает: точные адреса и префиксы из strip_prefix */
const exactRoutes = new Set([...httpRs.matchAll(/"(\/api\/[A-Za-z0-9_\/]+)"/g)].map((m) => m[1]));
const prefixes = [...httpRs.matchAll(/strip_prefix\("(\/api\/[A-Za-z0-9_\/]*)"\)/g)].map((m) => m[1]);

/* адреса, которые дёргает интерфейс (первая часть шаблонной строки) */
const urls = new Set();
for (const match of appJs.matchAll(/(?:post|fetch)\(\s*[`'"]((?:\/api\/)[^`'"?]*)/g)) {
  let url = match[1];
  /* `/api/servers/${id}/start` → /api/servers/ */
  const dynamic = url.indexOf('${');
  if (dynamic >= 0) url = url.slice(0, dynamic);
  urls.add(url);
}
for (const url of [...urls].sort()) {
  if (exactRoutes.has(url)) continue;
  const covered = prefixes.some((prefix) => url.startsWith(prefix));
  if (!covered) problems.push(`${url} — интерфейс зовёт, а маршрута в http.rs нет`);
}

/* ── 3. каналы ядра ── */

/** Каналы, которые ядро объявило готовыми. */
function readyChannels() {
  const start = appRs.indexOf('pub const READY_CHANNELS');
  const end = appRs.indexOf('];', start);
  return new Set([...appRs.slice(start, end).matchAll(/"([a-zA-Z0-9]+:[a-zA-Z0-9]+)"/g)].map((m) => m[1]));
}

/* Нативные каналы, которые http.rs зовёт по имени (динамические files:/archive: пропускаем) */
const nativeChannels = new Set(
  [...httpRs.matchAll(/\("([a-z]+:[a-zA-Z0-9]+)"/g)].map((m) => m[1]),
);
const ready = readyChannels();
for (const channel of [...nativeChannels].sort()) {
  if (!ready.has(channel)) {
    problems.push(`канал ${channel} вызывается из http.rs, но его нет в READY_CHANNELS`);
  }
}

if (problems.length) {
  console.error('интерфейс и ядро: есть расхождения');
  for (const text of problems) console.error('  •', text);
  process.exit(1);
}
console.log(
  `интерфейс и ядро: сверено (методов ${defined.size}, адресов ${urls.size}, каналов ${nativeChannels.size})`,
);
