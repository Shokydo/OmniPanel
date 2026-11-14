// Тихая автоустановка «как Discord»: панель сама скачивает обновление и
// перезапускается на новой версии; если работают серверы — ставит при выходе.
// Запуск: xvfb-run -a node tests/test-autoupdate.js <playwright> <electron>
const pwPath = process.argv[2];
const electronPath = process.argv[3];
const { _electron: electron } = require(pwPath);
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { execSync } = require('child_process');
const zip = require('../core/zip');

const SRC = '/home/user/OmniPanel';
const LIVE = '/tmp/omni-auto';
const NEW_VERSION = '2.5.0';

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  OK   ' : '  FAIL ') + label + (extra ? ' — ' + extra : ''));
  if (!cond) fails += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// после автообновления панель перезапускает себя — гасим остатки, иначе
// новый экземпляр упрётся в «уже запущено» (single instance)
const killLeftovers = () => {
  try { execSync('pkill -f omni-auto || true'); } catch { /* нет процессов */ }
  execSync('sleep 1');
};

/* копия панели «старой» версии + архив обновления */
function prepare() {
  fs.rmSync(LIVE, { recursive: true, force: true });
  fs.mkdirSync(LIVE, { recursive: true });
  for (const item of ['main.js', 'preload.js', 'web.js', 'core', 'ui', 'assets', 'package.json']) {
    fs.cpSync(path.join(SRC, item), path.join(LIVE, item), { recursive: true });
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(LIVE, 'package.json'), 'utf8'));
  pkg.version = '2.4.0';
  fs.writeFileSync(path.join(LIVE, 'package.json'), JSON.stringify(pkg, null, 2));

  const items = [];
  const walk = (rel) => {
    const abs = path.join(LIVE, rel);
    if (fs.statSync(abs).isDirectory()) {
      for (const n of fs.readdirSync(abs)) walk(path.join(rel, n));
    } else {
      items.push({ name: rel.split(path.sep).join('/'), data: fs.readFileSync(abs) });
    }
  };
  for (const item of ['main.js', 'preload.js', 'web.js', 'core', 'ui', 'assets']) walk(item);
  items.push({ name: 'package.json', data: Buffer.from(JSON.stringify({ ...pkg, version: NEW_VERSION }, null, 2)) });
  items.push({ name: 'update-marker.txt', data: Buffer.from('автообновление применено') });
  return zip.create(items);
}

const code = prepare();
const mock = http.createServer((req, res) => {
  const json = (o, c = 200) => {
    const b = JSON.stringify(o);
    res.writeHead(c, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) });
    res.end(b);
  };
  if (req.url.startsWith('/u/r/main/update.json')) {
    return json({ version: NEW_VERSION, notes: 'тихое обновление', code: { file: 'dist/OmniPanel-code.zip', size: code.length }, full: null });
  }
  if (req.url.startsWith('/u/r/main/dist/OmniPanel-code.zip')) {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': code.length });
    return res.end(code);
  }
  return json({ message: 'Not Found' }, 404);
});

function writeSettings(dataDir, extra = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'panel.json'), JSON.stringify({
    updateRepo: 'u/r', updateBranch: 'main', updateAuto: true, updateAutoInstall: true,
    githubLogin: 'tester',
    ...extra,
  }, null, 2));
}

const USER_SERVERS = JSON.stringify([{ id: 's1', name: 'Мой мир', cwd: '/миры/мир', command: 'java -jar server.jar' }], null, 2);

mock.listen(8793, '127.0.0.1', async () => {
  const dataDir = path.join(path.dirname(electronPath), 'OmniPanelData');
  fs.rmSync(path.join(dataDir, 'updates'), { recursive: true, force: true });
  writeSettings(dataDir);
  fs.writeFileSync(path.join(dataDir, 'servers.json'), USER_SERVERS);

  const launch = () => electron.launch({
    executablePath: electronPath,
    args: [LIVE, '--no-sandbox'],
    env: {
      ...process.env,
      ELECTRON_DISABLE_SANDBOX: '1',
      OMNI_UPDATE_RAW: 'http://127.0.0.1:8793',
      OMNI_UPDATE_API: 'http://127.0.0.1:8793',
    },
    timeout: 60000,
  });

  console.log('=== ТИХАЯ АВТОУСТАНОВКА ПРИ ЗАПУСКЕ ===');
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForSelector('.profile-name');
  const startVersion = await page.evaluate(() => window.desktop.info()).then((i) => i.version);
  ok(startVersion === '2.4.0', 'стартовали на 2.4.0', startVersion);

  // ждём, пока фоновая проверка (3,5 с) и установка отработают и панель уйдёт на перезапуск
  await sleep(14000);
  const pkgNow = JSON.parse(fs.readFileSync(path.join(LIVE, 'package.json'), 'utf8'));
  ok(pkgNow.version === NEW_VERSION, 'без единого клика панель обновилась до ' + NEW_VERSION, pkgNow.version);
  ok(fs.existsSync(path.join(LIVE, 'update-marker.txt')), 'файлы обновления разложены');
  ok(fs.readFileSync(path.join(dataDir, 'servers.json'), 'utf8') === USER_SERVERS, 'список серверов не тронут');
  const panel = JSON.parse(fs.readFileSync(path.join(dataDir, 'panel.json'), 'utf8'));
  ok(panel.githubLogin === 'tester' && panel.updateAutoInstall === true, 'настройки и профиль целы');
  ok(!fs.existsSync(path.join(dataDir, 'updates', 'pending.json')), 'отложенного обновления не осталось');
  const backups = fs.existsSync(path.join(dataDir, 'updates', 'backup')) ? fs.readdirSync(path.join(dataDir, 'updates', 'backup')) : [];
  ok(backups.some((b) => b.startsWith('before-2.4.0')), 'бэкап прежней версии есть', backups.join(', '));
  await app.close().catch(() => {});
  killLeftovers();

  console.log('\n=== ВТОРОЙ ЗАПУСК: УЖЕ НОВАЯ ВЕРСИЯ, БЕЗ ПЕРЕЗАПУСКА ===');
  const app2 = await launch();
  const page2 = await app2.firstWindow();
  await page2.waitForSelector('.profile-name');
  const v2 = await page2.evaluate(() => window.desktop.info()).then((i) => i.version);
  ok(v2 === NEW_VERSION, 'панель запускается уже новой версией', v2);
  await sleep(6000);
  ok(fs.readFileSync(path.join(LIVE, 'package.json'), 'utf8').includes(NEW_VERSION), 'повторного обновления нет (нет петли)');
  await app2.close().catch(() => {});
  killLeftovers();

  console.log('\n=== ВЫКЛЮЧЕННАЯ АВТОУСТАНОВКА ===');
  fs.writeFileSync(path.join(LIVE, 'package.json'), JSON.stringify({ ...pkgNow, version: '2.4.5' }, null, 2));
  writeSettings(dataDir, { updateAutoInstall: false });
  const app3 = await launch();
  const page3 = await app3.firstWindow();
  await page3.waitForSelector('.profile-name');
  await sleep(9000);
  const v3 = JSON.parse(fs.readFileSync(path.join(LIVE, 'package.json'), 'utf8')).version;
  ok(v3 === '2.4.5', 'с выключенной автоустановкой панель не трогает себя', v3);
  await app3.close().catch(() => {});

  console.log('\n' + (fails ? `ПРОВАЛОВ: ${fails}` : 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ'));
  mock.close();
  try { execSync('pkill -f omni-auto || true'); } catch { /* ignore */ }
  process.exit(fails ? 1 : 0);
});
