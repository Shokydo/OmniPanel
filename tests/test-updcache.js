// Проверка: свежая версия сразу после релиза не должна падать из-за пятиминутного
// кэша raw.githubusercontent. Двойник GitHub отдаёт сначала старый файл, потом новый.
// Запуск: node tests/test-updcache.js
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const updater = require(path.join(ROOT, 'core/updater'));

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  OK   ' : '  FAIL ') + label + (extra ? ' — ' + extra : ''));
  if (!cond) fails += 1;
};

const FRESH = Buffer.from('новая версия панели 1.19.2');
const STALE = Buffer.from('старая версия панели 1.19.1, которую успел закэшировать CDN');
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

let served = 0;
let staleFor = 2;      // сколько первых запросов отдать старьё
const seen = [];

const server = http.createServer((req, res) => {
  seen.push(req.url);
  const body = served < staleFor ? STALE : FRESH;
  served += 1;
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': body.length,
    // ровно как у raw.githubusercontent: кэш на пять минут
    'Cache-Control': 'max-age=300',
  });
  res.end(body);
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/u/r/main/dist/OmniPanel-code.zip`;
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'upd-')), 'code.zip');

  console.log('=== кэш отдал старую копию ===');
  staleFor = 1;
  served = 0;
  seen.length = 0;
  const good = await updater.downloadChecked(base, dest, { sha256: sha(FRESH) });
  ok(good.attempts === 2, 'панель повторила скачивание', 'попыток: ' + good.attempts);
  ok(fs.readFileSync(dest).equals(FRESH), 'на диск лёг именно новый файл');
  ok(seen.length === 2, 'было два запроса', seen.join(' '));
  ok(seen.every((u) => /[?&]_=/.test(u)), 'каждый запрос со свежим параметром против кэша',
    seen[0].slice(-24));
  ok(new Set(seen).size === seen.length, 'адреса разные, кэш промахивается');

  console.log('\n=== кэш не отдаёт новое вообще ===');
  staleFor = 99;
  served = 0;
  let err = '';
  try {
    await updater.downloadChecked(base, dest, { sha256: sha(FRESH) });
  } catch (e) { err = e.message; }
  ok(/контрольная сумма/.test(err), 'честная ошибка вместо битой установки', err.slice(0, 70));

  console.log('\n=== ссылки без контрольной суммы ===');
  staleFor = 0;
  served = 0;
  const plain = await updater.downloadChecked(base, dest, {});
  ok(plain.attempts === 1, 'без sha файл берётся с первой попытки');
  ok(fs.readFileSync(dest).equals(FRESH), 'содержимое верное');

  console.log('\n=== адрес с параметрами не ломается ===');
  const busted = updater.bust('https://raw.githubusercontent.com/o/r/main/dist/x.zip?ref=main');
  ok(/_=\d+/.test(busted) && /ref=main/.test(busted), 'старые параметры сохранены', busted.slice(-40));

  console.log('\n=== update.json: API свежий, raw отдаёт прошлую версию ===');
  const NEWVER = { version: '1.19.3', notes: 'новая', code: { file: 'dist/OmniPanel-code.zip', size: FRESH.length, sha256: sha(FRESH) }, full: null };
  const OLDVER = { version: '1.19.2', notes: 'прошлая', code: { file: 'dist/OmniPanel-code.zip', size: STALE.length, sha256: sha(STALE) }, full: null };
  const gh = http.createServer((req, res) => {
    const json = (obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    };
    // API всегда отдаёт актуальное
    if (req.url.startsWith('/api/repos/u/r/contents/update.json')) {
      const body = JSON.stringify(NEWVER);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      return res.end(body);
    }
    if (req.url.startsWith('/api/repos/u/r/releases/latest')) return json({ message: 'Not Found' });
    // raw «закэширован»: отдаёт прошлую версию, параметр в адресе игнорирует
    if (req.url.startsWith('/raw/u/r/main/update.json')) return json(OLDVER);
    // API-ссылка на архив кода: отдаём файл только с правильным Accept
    if (req.url.startsWith('/api/repos/u/r/contents/dist/OmniPanel-code.zip')) {
      if (!/application\/vnd\.github\.raw/.test(String(req.headers.accept))) return json({ message: 'нужен Accept' });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': FRESH.length });
      return res.end(FRESH);
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => gh.listen(0, '127.0.0.1', r));
  const port = gh.address().port;
  process.env.OMNI_UPDATE_API = `http://127.0.0.1:${port}/api`;
  process.env.OMNI_UPDATE_RAW = `http://127.0.0.1:${port}/raw`;

  const info = await updater.check({ repo: 'u/r', current: '1.19.0' });
  ok(info.ok && info.latest === '1.19.3', 'версия берётся из API, а не из кэша raw', info.latest);
  ok(/\/api\//.test(info.code.url || ''), 'ссылка на архив ведёт в API, а не в raw-кэш', (info.code.url || '').slice(0, 60));
  ok(!!info.code.accept, 'ссылке нужен заголовок Accept', info.code.accept);
  const fresh = await updater.downloadChecked(info.code.url, dest, { sha256: info.code.sha256, accept: info.code.accept });
  ok(fresh.attempts === 1 && fs.readFileSync(dest).equals(FRESH), 'архив скачался свежим с первой попытки');
  gh.close();

  server.close();
  console.log(fails ? `\nПРОВАЛОВ: ${fails}` : '\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ОШИБКА', e); server.close(); process.exit(1); });
