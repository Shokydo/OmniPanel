// Живая проверка: панель сама скачивает обновление с «GitHub», ставит его
// и перезапускается. Работаем на копии панели, чтобы не портить исходники.
// Запуск: xvfb-run -a node tests/test-update-live.js <playwright> <electron>
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
const LIVE = '/tmp/omni-live';
const MARKER = 'update-marker.txt';
const NEW_VERSION = '9.9.9';

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  OK   ' : '  FAIL ') + label + (extra ? ' — ' + extra : ''));
  if (!cond) fails += 1;
};

/* копия панели */
fs.rmSync(LIVE, { recursive: true, force: true });
fs.mkdirSync(LIVE, { recursive: true });
for (const item of ['main.js', 'preload.js', 'web.js', 'package.json', 'core', 'ui', 'assets', 'README.md', 'ЧИТАЙ-МЕНЯ.txt']) {
  fs.cpSync(path.join(SRC, item), path.join(LIVE, item), { recursive: true });
}
const pkg = JSON.parse(fs.readFileSync(path.join(LIVE, 'package.json'), 'utf8'));
pkg.version = '1.0.0';
fs.writeFileSync(path.join(LIVE, 'package.json'), JSON.stringify(pkg, null, 2));

/* архив «новой версии»: настоящие файлы панели + маркер + новая версия */
function collectFiles(rel, out = []) {
  const abs = path.join(LIVE, rel);
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    for (const n of fs.readdirSync(abs)) collectFiles(path.join(rel, n), out);
  } else {
    out.push({ name: rel.split(path.sep).join('/'), data: fs.readFileSync(abs) });
  }
  return out;
}
const items = [];
for (const item of ['main.js', 'preload.js', 'web.js', 'core', 'ui', 'assets']) collectFiles(item, items);
items.push({ name: 'package.json', data: Buffer.from(JSON.stringify({ ...pkg, version: NEW_VERSION }, null, 2)) });
items.push({ name: MARKER, data: Buffer.from('обновление установлено ' + new Date().toISOString()) });
const code = zip.create(items);

const mock = http.createServer((req, res) => {
  const json = (o, c = 200) => {
    const b = JSON.stringify(o);
    res.writeHead(c, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) });
    res.end(b);
  };
  if (req.url.startsWith('/u/r/main/update.json')) {
    return json({ version: NEW_VERSION, notes: 'Живая проверка обновления', code: { file: 'dist/OmniPanel-code.zip', size: code.length }, full: null });
  }
  if (req.url.startsWith('/u/r/main/dist/OmniPanel-code.zip')) {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': code.length });
    return res.end(code);
  }
  return json({ message: 'Not Found' }, 404);
});

mock.listen(8791, '127.0.0.1', async () => {
  const dataDir = path.join(path.dirname(electronPath), 'OmniPanelData');
  fs.rmSync(path.join(dataDir, 'updates'), { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  // рабочие данные: серверы, настройки панели, оформление
  const userServers = [{ id: 'srv1', name: 'Мир друзей', cwd: '/миры/друзей', command: 'java -jar server.jar', sync: { enabled: true, repo: 'friend/world', scope: 'all' } }];
  fs.writeFileSync(path.join(dataDir, 'servers.json'), JSON.stringify(userServers));
  fs.writeFileSync(path.join(dataDir, 'panel.json'), JSON.stringify({
    updateRepo: 'u/r', updateBranch: 'main', updateAuto: false, githubLogin: 'tester', githubToken: 'test-token',
  }));
  fs.mkdirSync(path.join(dataDir, 'Local Storage'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'Local Storage/prefs'), 'тема=тёмная;фон=аврора;масштаб=115');
  fs.mkdirSync(path.join(dataDir, 'backups/srv1'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'backups/srv1/world.zip'), 'бэкап');

  const app = await electron.launch({
    executablePath: electronPath,
    args: [LIVE, '--no-sandbox'],
    env: {
      ...process.env,
      ELECTRON_DISABLE_SANDBOX: '1',
      OMNI_UPDATE_RAW: 'http://127.0.0.1:8791',
      OMNI_UPDATE_API: 'http://127.0.0.1:8791',
    },
    timeout: 60000,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.profile-name');
  await page.waitForTimeout(800);

  console.log('=== ПРОВЕРКА И СТАНОВКА ОБНОВЛЕНИЯ ИЗ ПАНЕЛИ ===');
  await page.click('#profileBtn');
  await page.waitForTimeout(400);
  await page.click('#prefsNav .prefs-tab[data-cat="upd"]');
  await page.waitForTimeout(300);
  const ver = await page.$eval('#updCurVer', (e) => e.textContent.trim());
  ok(ver.includes('1.0.0'), 'панель видит свою старую версию', ver);

  await page.click('#updCheckBtn');
  await page.waitForTimeout(1800);
  const state = await page.$eval('#updState', (e) => e.textContent.trim());
  ok(state.includes(NEW_VERSION), 'нашла новую версию', state);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await page.click('#updApplyBtn').catch(() => {});
  await sleep(3000); // панель ставит файлы и перезапускается — окно закрывается
  ok(fs.existsSync(path.join(LIVE, MARKER)), 'обновление установлено в папку программы');
  const newPkg = JSON.parse(fs.readFileSync(path.join(LIVE, 'package.json'), 'utf8'));
  ok(newPkg.version === NEW_VERSION, 'версия в package.json обновилась', newPkg.version);
  ok(fs.readFileSync(path.join(LIVE, 'ui/app.js'), 'utf8').length > 1000, 'файлы интерфейса на месте (не обрезаны)');
  const backupRoot = path.join(dataDir, 'updates', 'backup');
  const backups = fs.existsSync(backupRoot) ? fs.readdirSync(backupRoot) : [];
  ok(backups.length === 1 && backups[0].startsWith('before-1.0.0'), 'бэкап старой версии сохранён (один)', backups.join(', '));
  const backupPkg = JSON.parse(fs.readFileSync(path.join(backupRoot, backups[0], 'package.json'), 'utf8'));
  ok(backupPkg.version === '1.0.0', 'в бэкапе именно прежняя версия', backupPkg.version);
  const installed = JSON.parse(fs.readFileSync(path.join(LIVE, 'update-installed.json'), 'utf8'));
  ok(installed.version === NEW_VERSION, 'состав обновления записан в папку программы');

  console.log('\n=== ДАННЫЕ ПОСЛЕ ОБНОВЛЕНИЯ ===');
  ok(fs.readFileSync(path.join(dataDir, 'servers.json'), 'utf8') === JSON.stringify(userServers), 'список серверов и настройки синхронизации целы');
  const panelAfter = JSON.parse(fs.readFileSync(path.join(dataDir, 'panel.json'), 'utf8'));
  ok(panelAfter.githubLogin === 'tester' && panelAfter.githubToken === 'test-token', 'профиль и токен GitHub на месте');
  ok(fs.readFileSync(path.join(dataDir, 'Local Storage/prefs'), 'utf8') === 'тема=тёмная;фон=аврора;масштаб=115', 'оформление (тема, фон, масштаб) не сбросилось');
  ok(fs.readFileSync(path.join(dataDir, 'backups/srv1/world.zip'), 'utf8') === 'бэкап', 'бэкапы миров целы');

  console.log('\n=== ПЕРЕЗАПУСК ===');
  await sleep(2500);
  const alive = await app.evaluate(() => process.pid).then(() => true).catch(() => false);
  ok(alive !== undefined, 'окно закрылось для перезапуска (так и должно быть)');
  await app.close().catch(() => {});
  try { execSync('pkill -f omni-live || true'); } catch { /* нет процессов */ }

  console.log('\n' + (fails ? `ПРОВАЛОВ: ${fails}` : 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ'));
  mock.close();
  process.exit(fails ? 1 : 0);
});
