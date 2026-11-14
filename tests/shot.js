// Свежие скриншоты для документации и архива исходников.
// Запуск: xvfb-run -a node tests/shot.js <playwright> <electron>
const pwPath = process.argv[2];
const electronPath = process.argv[3];
const { _electron: electron } = require(pwPath);
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA = path.join(path.dirname(electronPath), 'OmniPanelData');
const SRV = path.join(os.tmpdir(), 'omni-shot-srv');
const OUT = '/home/user/OmniPanel';

fs.rmSync(SRV, { recursive: true, force: true });
for (const d of ['world/region', 'plugins/Essentials', 'logs', 'config']) fs.mkdirSync(path.join(SRV, d), { recursive: true });
fs.writeFileSync(path.join(SRV, 'server.properties'), 'motd=Добро пожаловать\nmax-players=20\n');
fs.writeFileSync(path.join(SRV, 'world/level.dat'), 'x');
fs.writeFileSync(path.join(SRV, 'world/region/r.0.0.mca'), 'x');
fs.writeFileSync(path.join(SRV, 'server.jar'), 'x');
fs.writeFileSync(path.join(SRV, 'plugins/Essentials/config.yml'), 'kit: starter\n');
fs.writeFileSync(path.join(SRV, 'logs/latest.log'), '[12:00:00] [Server thread/INFO]: Done (3.512s)! Загружено триггеров предметов: 42\n');
fs.mkdirSync(DATA, { recursive: true });
fs.rmSync(path.join(DATA, 'panel.json'), { force: true });
fs.rmSync(path.join(DATA, 'Local Storage'), { recursive: true, force: true });
fs.writeFileSync(path.join(DATA, 'servers.json'), JSON.stringify([
  { id: 's1', name: 'Мир друзей', command: 'sleep 900', cwd: SRV, stopCommand: 'stop', encoding: 'auto', tpsCommand: 'tps', tpsInterval: 30, sync: { enabled: true, repo: 'friend/minecraft-world', branch: 'main', scope: 'all', pull: true, push: true } },
  { id: 's2', name: 'Тестовый Paper', command: 'sleep 900', cwd: SRV, stopCommand: 'stop', encoding: 'auto' },
]));

(async () => {
  const app = await electron.launch({
    executablePath: electronPath,
    args: ['/home/user/OmniPanel', '--no-sandbox'],
    env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' },
    timeout: 60000,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.profile-name');
  await page.waitForTimeout(1200);

  await page.screenshot({ path: path.join(OUT, 'screenshot.png') });

  // категории настроек
  await page.click('#profileBtn');
  await page.waitForTimeout(500);
  await page.click('#prefsNav .prefs-tab[data-cat="gh"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'screenshot-prefs-github.png') });
  await page.click('#prefsNav .prefs-tab[data-cat="upd"]');
  await page.waitForTimeout(300);
  await page.fill('#updRepo', 'mks/omnipanel-updates');
  await page.dispatchEvent('#updRepo', 'change');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'screenshot-updates.png') });
  await page.click('#prefsDone');
  await page.waitForTimeout(300);

  // светлая тема
  await page.evaluate(() => { prefs.theme = 'light'; prefs.save(); applyPrefs(); });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, 'screenshot-light.png') });
  await page.evaluate(() => { prefs.theme = 'dark'; prefs.save(); applyPrefs(); });
  await page.waitForTimeout(400);

  // настройки сервера: блок синхронизации
  await page.click('#serverList .srv');
  await page.waitForTimeout(400);
  await page.click('#btnSettings');
  await page.waitForTimeout(700);
  await page.$eval('#modal .modal-body', (e) => { e.scrollTop = e.scrollHeight; });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'screenshot-sync.png') });
  await page.click('#modalClose');
  await page.waitForTimeout(300);

  // сканер
  await page.click('#scanBtn');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, 'screenshot-scan.png') });

  await app.close();
  console.log('скриншоты обновлены');
})();
