// Скриншоты нового оформления: шапка, темы, кастом-палитра, звуки, эффекты клика.
// Запуск: xvfb-run -a node tests/shots.js <pw> <electron> <dir>
const pwPath = process.argv[2] || 'playwright';
const electronPath = process.argv[3] || '/home/user/.cache/bld/node_modules/electron/dist/electron';
const outDir = process.argv[4] || '/home/user/OmniPanel/docs/screens';
const { _electron: electron } = require(pwPath);
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA = path.join(path.dirname(electronPath), 'OmniPanelData');
const SRV = path.join(os.tmpdir(), 'omni-shots-srv');

fs.rmSync(SRV, { recursive: true, force: true });
fs.mkdirSync(path.join(SRV, 'world'), { recursive: true });
fs.writeFileSync(path.join(SRV, 'world/level.dat'), 'LEVEL');
fs.writeFileSync(path.join(SRV, 'server.properties'), 'level-name=world\n');
fs.mkdirSync(DATA, { recursive: true });
fs.rmSync(path.join(DATA, 'panel.json'), { force: true });
fs.rmSync(path.join(DATA, 'Local Storage'), { recursive: true, force: true });
fs.writeFileSync(path.join(DATA, 'servers.json'), JSON.stringify([
  { id: 's1', name: 'Мир друзей', command: 'sleep 600', cwd: SRV, stopCommand: '', encoding: 'auto', tpsCommand: '', tpsInterval: 30 },
  { id: 's2', name: 'Скайблок', command: 'sleep 600', cwd: SRV, stopCommand: '', encoding: 'auto', tpsCommand: '', tpsInterval: 30 },
]));

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const app = await electron.launch({
    executablePath: electronPath,
    args: ['/home/user/OmniPanel', '--no-sandbox'],
    env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' },
    timeout: 60000,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.profile-name');
  await page.waitForTimeout(900);
  const shot = (name) => page.screenshot({ path: path.join(outDir, name + '.png') });

  await shot('window-bar');
  await page.click('#profileBtn');
  await page.waitForTimeout(400);
  await shot('themes-grid');

  await page.click('#themeGrid .theme-cell[data-theme="custom"]');
  await page.waitForTimeout(300);
  await shot('custom-theme');

  await page.click('#prefsNav .prefs-tab[data-cat="gh"]');
  await page.waitForTimeout(350);
  await shot('github-account');

  await page.click('#prefsNav .prefs-tab[data-cat="sound"]');
  await page.waitForTimeout(250);
  await shot('sound-packs');

  await page.click('#prefsNav .prefs-tab[data-cat="fx"]');
  await page.waitForTimeout(250);
  await shot('click-fx');

  // разные темы на живом интерфейсе
  const themes = ['light', 'navy', 'forest', 'sunset', 'amethyst', 'paper'];
  for (const th of themes) {
    await page.evaluate((t) => { prefs.theme = t; prefs.save(); applyPrefs(); }, th);
    await page.waitForTimeout(250);
    await shot('theme-' + th);
  }

  // главное окно в светлой теме (без модалки)
  await page.click('#prefsDone');
  await page.waitForTimeout(250);
  await page.evaluate(() => { prefs.theme = 'light'; prefs.save(); applyPrefs(); });
  await page.waitForTimeout(250);
  await shot('main-light');

  // мерцающая плашка обновления
  await page.evaluate(() => {
    prefs.theme = 'dark';
    prefs.save();
    applyPrefs();
    setUpdPill({ hasUpdate: true, latest: '1.16.0' });
  });
  await page.waitForTimeout(400);
  await shot('update-pill');

  // эффект клика по экрану
  await page.evaluate(() => {
    prefs.clickFx = 'ring';
    prefs.save();
    applyPrefs();
    clickFxAt(420, 300, 'ring');
    clickFxAt(500, 340, 'ring');
  });
  await page.waitForTimeout(120);
  await shot('click-fx-screen');

  // полный экран: своя полоса
  await page.evaluate(() => { setUpdPill({ hasUpdate: false }); document.body.classList.add('is-fullscreen'); fsbUpdate(); });
  await page.waitForTimeout(300);
  await shot('fullscreen-bar');

  // полные настройки server.properties
  await page.evaluate(() => { document.body.classList.remove('is-fullscreen'); fsbUpdate(); });
  await page.evaluate(() => pfOpen(S.servers[0]));
  await page.waitForTimeout(900);
  await shot('props-all');
  await page.evaluate(() => { document.getElementById('propsModal').classList.add('hidden'); });

  // добавление сервера из GitHub
  await page.evaluate(() => { document.getElementById('modal').classList.remove('hidden'); gaMode('gh'); });
  await page.waitForTimeout(600);
  await shot('add-from-github');
  await page.evaluate(() => { document.getElementById('modal').classList.add('hidden'); });

  // вход по коду
  await page.click('#profileBtn');
  await page.waitForTimeout(300);
  await page.click('#prefsNav .prefs-tab[data-cat="gh"]');
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    document.getElementById('ghDeviceBox').classList.remove('hidden');
    document.getElementById('ghDeviceCode').textContent = 'A1B2-C3D4';
  });
  await page.waitForTimeout(300);
  await shot('github-device-login');
  await page.click('#prefsDone');

  await page.evaluate(() => { setUpdPill({ hasUpdate: false }); });
  await app.close();
  console.log('скриншоты готовы: ' + outDir);
})().catch((e) => { console.error(e); process.exit(1); });
