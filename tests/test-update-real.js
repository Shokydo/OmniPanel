// Полный сценарий на реальном GitHub: «установленная» панель старой версии сама
// проверяет канал Shokydo/OmniPanel, скачивает обновление и ставит его,
// при этом настройки, серверы и оформление остаются нетронутыми.
// Запуск: xvfb-run -a node tests/test-update-real.js <playwright> <electron> [токен]
const pwPath = process.argv[2];
const electronPath = process.argv[3];
const TOKEN = process.argv[4] || process.env.GH_TEST_TOKEN || '';
const { _electron: electron } = require(pwPath);
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const https = require('https');

// версию в канале не зашиваем — спрашиваем у самого GitHub
function channelVersion(repo, branch = 'main') {
  const url = `https://raw.githubusercontent.com/${repo}/${branch}/update.json`;
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'OmniPanel-test' } }, (res) => {
      if (res.statusCode !== 200) { reject(new Error('update.json: ' + res.statusCode)); return; }
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(String(JSON.parse(body).version || '').trim()); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// установщик ищем сами: берём самый свежий OmniPanel-Установка-<версия>.exe рядом с репозиторием
function findInstaller() {
  const dirs = ['/home/user', path.join(__dirname, '..'), path.join(__dirname, '..', 'installer')];
  const found = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const m = name.match(/^OmniPanel[-_ ]?(Установка|Setup)[-_ ]?(\d+\.\d+\.\d+)\.exe$/i);
      if (m) found.push({ file: path.join(dir, name), ver: m[2] });
    }
  }
  found.sort((a, b) => a.ver.localeCompare(b.ver, undefined, { numeric: true }));
  return found.length ? found[found.length - 1].file : null;
}
const INSTALLER = findInstaller();
if (!INSTALLER) {
  console.log('НЕ НАЙДЕН УСТАНОВЩИК OmniPanel-Установка-<версия>.exe — собери его: installer/build-all.sh <версия>');
  process.exit(2);
}
console.log('=== УСТАНОВЩИК: ' + path.basename(INSTALLER) + ' ===');
const ROOT = path.join(os.tmpdir(), 'omni-real');
const APP = path.join(ROOT, 'OmniPanel');           // как после установщика
const DATA = path.join(APP, 'OmniPanelData');
const REPO = 'Shokydo/OmniPanel';

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  OK   ' : '  FAIL ') + label + (extra ? ' — ' + extra : ''));
  if (!cond) fails += 1;
};

/* 1. «установка» из установщика */
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(APP, { recursive: true });
execSync(`python3 - "${INSTALLER}" "${ROOT}/payload.zip" <<'PY'
import struct, sys
exe, out = sys.argv[1], sys.argv[2]
data = open(exe, 'rb').read()
size = struct.unpack('<Q', data[-8:])[0]
open(out, 'wb').write(data[-16 - size:-16])
PY`);
execSync(`cd "${APP}" && unzip -q "${ROOT}/payload.zip" && rm -f "${ROOT}/payload.zip"`);

/* 2. откатываем версию до 1.11.0 — как будто панель установлена раньше */
const appPkg = path.join(APP, 'resources/app/package.json');
const pkg = JSON.parse(fs.readFileSync(appPkg, 'utf8'));
const hadVersion = pkg.version;
pkg.version = '1.11.0';
fs.writeFileSync(appPkg, JSON.stringify(pkg, null, 2));

/* 3. рабочие данные пользователя */
fs.mkdirSync(DATA, { recursive: true });
const servers = [
  { id: 'srv1', name: 'Мир друзей', cwd: '/миры/друзей', command: 'java -jar server.jar', stopCommand: 'stop', encoding: 'auto', sync: { enabled: true, repo: 'friend/world', branch: 'main', scope: 'all' } },
  { id: 'srv2', name: 'Тестовый Paper', cwd: '/миры/тест', command: 'java -jar paper.jar' },
];
fs.writeFileSync(path.join(DATA, 'servers.json'), JSON.stringify(servers, null, 2));
fs.writeFileSync(path.join(DATA, 'panel.json'), JSON.stringify({
  updateRepo: REPO, updateBranch: 'main', updateAuto: false,
  githubLogin: 'Shokydo', githubToken: TOKEN, startMode: 'window',
}, null, 2));
fs.mkdirSync(path.join(DATA, 'Local Storage'), { recursive: true });
const prefsValue = 'тема=тёмная;фон=аврора;масштаб=115;звуки=вкл';
fs.writeFileSync(path.join(DATA, 'Local Storage/prefs'), prefsValue);
fs.mkdirSync(path.join(DATA, 'tps'), { recursive: true });
fs.writeFileSync(path.join(DATA, 'tps/srv1.json'), JSON.stringify([{ t: 1, v: 19.8 }]));
fs.mkdirSync(path.join(DATA, 'backups/srv1'), { recursive: true });
fs.writeFileSync(path.join(DATA, 'backups/srv1/world-2026.zip'), 'архив мира');

const beforeServers = fs.readFileSync(path.join(DATA, 'servers.json'), 'utf8');

(async () => {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [path.join(APP, 'resources/app'), '--no-sandbox'],
    // как у portable-сборки: данные лежат рядом с программой
    env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1', PORTABLE_EXECUTABLE_DIR: APP },
    timeout: 60000,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.profile-name');
  await page.waitForTimeout(1000);

  const NEWVER = await channelVersion(REPO);
  ok(!!NEWVER, 'канал отдаёт update.json', 'версия в канале: ' + NEWVER);

  console.log(`\n=== ПАНЕЛЬ ${hadVersion} ВНУТРИ «УСТАНОВЛЕННОЙ» ПАПКИ ===`);
  ok(fs.readFileSync(appPkg, 'utf8').includes('"1.11.0"'), 'стартовая версия 1.11.0');
  const serversOnScreen = await page.$$eval('#serverList .srv', (els) => els.length);
  ok(serversOnScreen === 2, 'панель видит два сервера', 'серверов: ' + serversOnScreen);

  console.log('\n=== ПРОВЕРКА КАНАЛА (реальный GitHub) ===');
  await page.click('#profileBtn');
  await page.waitForTimeout(400);
  await page.click('#prefsNav .prefs-tab[data-cat="upd"]');
  await page.waitForTimeout(300);
  const repoField = await page.$eval('#updRepo', (e) => e.value);
  ok(repoField === REPO, 'репозиторий канала из настроек', repoField);

  await page.click('#updCheckBtn');
  await page.waitForTimeout(4000);
  const state = await page.$eval('#updState', (e) => e.textContent.trim());
  ok(state.includes(NEWVER), 'GitHub отдал новую версию', state);
  const applyDisabled = await page.$eval('#updApplyBtn', (e) => e.disabled);
  ok(!applyDisabled, 'кнопка «Обновить и перезапустить» доступна');
  const fullDisabled = await page.$eval('#updFullBtn', (e) => e.disabled);
  ok(!fullDisabled, 'полная сборка тоже в канале (кнопка активна)');
  await page.screenshot({ path: '/home/user/OmniPanel/screenshot-update-real.png' });

  console.log('\n=== УСТАНОВКА ОБНОВЛЕНИЯ ===');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await page.click('#updApplyBtn').catch(() => {});
  await sleep(6000);

  const afterVer = JSON.parse(fs.readFileSync(appPkg, 'utf8')).version;
  ok(afterVer === NEWVER, 'версия панели стала ' + NEWVER, afterVer);
  ok(fs.existsSync(path.join(APP, 'resources/app/core/updater.js')), 'код на месте');
  ok(fs.readFileSync(path.join(DATA, 'servers.json'), 'utf8') === beforeServers, 'список серверов не изменился');
  ok(fs.readFileSync(path.join(DATA, 'Local Storage/prefs'), 'utf8') === prefsValue, 'оформление (тема, фон, масштаб) цело');
  ok(JSON.parse(fs.readFileSync(path.join(DATA, 'panel.json'), 'utf8')).githubLogin === 'Shokydo', 'профиль GitHub цел');
  ok(fs.readFileSync(path.join(DATA, 'backups/srv1/world-2026.zip'), 'utf8') === 'архив мира', 'бэкапы миров целы');
  ok(fs.readFileSync(path.join(DATA, 'tps/srv1.json'), 'utf8').includes('19.8'), 'история TPS цела');
  const backupRoot = path.join(DATA, 'updates', 'backup');
  const backups = fs.existsSync(backupRoot) ? fs.readdirSync(backupRoot) : [];
  ok(backups.some((b) => b.startsWith('before-1.11.0')), 'бэкап прежней версии сохранён', backups.join(', '));

  await app.close().catch(() => {});
  console.log('\n' + (fails ? `ПРОВАЛОВ: ${fails}` : 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ'));
  process.exit(fails ? 1 : 0);
})();
