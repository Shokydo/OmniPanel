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
fs.writeFileSync(path.join(SRV, 'server.properties'), 'level-name=world\nwhite-list=false\n');
fs.mkdirSync(path.join(SRV, 'MythicMobs/Mobs'), { recursive: true });
fs.writeFileSync(path.join(SRV, 'MythicMobs/Mobs/SkeletonKing.yml'),
  'SkeletonKing:\n  Type: SKELETON\n  Health: 120\n  Damage: 8\n  Display: Король скелетов\n');
fs.writeFileSync(path.join(SRV, 'MythicMobs/Mobs/AncientGolem.yml'),
  'AncientGolem:\n  Type: IRON_GOLEM\n  Health: 400\n  Damage: 14\n');
fs.writeFileSync(path.join(SRV, 'whitelist.json'), JSON.stringify([
  { uuid: '8667ba71-b85a-4004-af54-457a9734eed7', name: 'Steve' },
  { uuid: 'ec561538-f3fd-461d-aff5-086b22154bce', name: 'Alex' },
], null, 2));
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

  // новые вкладки 1.17: плагины с Modrinth, игроки, ошибки, карточки серверов
  await page.evaluate(() => {
    const s = S.servers[0];
    playersSet(s.id, ['Steve', 'Alex', 'Notch'], 20);
    updateOnlineChip();
    S.addons.hits = [
      { id: '1', slug: 'worldguard', title: 'WorldGuard', author: 'EngineHub', description: 'Защита регионов: приватные территории, флаги и права.', downloads: 41234567, categories: ['management', 'utility'], icon: '', versions: ['7.0.9'] },
      { id: '2', slug: 'essentialsx', title: 'EssentialsX', author: 'EssentialsX', description: 'Дома, телепорты, киты и права — базовый набор для сервера.', downloads: 38100000, categories: ['utility'], icon: '', versions: ['2.20.1'] },
      { id: '3', slug: 'luckperms', title: 'LuckPerms', author: 'Luck', description: 'Гибкая система прав и групп с веб-редактором.', downloads: 29500000, categories: ['management'], icon: '', versions: ['5.4.1'] },
    ];
    S.addons.total = 3;
    renderAddons();
    issuesAdd(s.id, 'exception', 'java.lang.NullPointerException: Cannot invoke World.getName() because world is null',
      'at ru.example.Plugin.onEnable(Plugin.java:41)');
    issuesAdd(s.id, 'exception', "Could not load plugins/Old.jar in folder plugins", '');
    issuesAdd(s.id, 'warn', 'Can not keep up! Is the server overloaded? Running 2451ms or 49 ticks behind', '');
    issuesAdd(s.id, 'exception', "Could not load plugins/Old.jar in folder plugins", '');
    S.issuesNew.set(s.id, 4);
    renderIssuesBadge();
  });
  await page.evaluate(() => { setTab('players'); renderPlayers(); updateOnlineChip(); });
  await page.waitForTimeout(500);
  await shot('tab-players');
  await page.evaluate(() => { setTab('issues'); renderIssues(); });
  await page.waitForTimeout(400);
  await shot('tab-issues');
  await page.evaluate(() => { setTab('addons'); renderAddons(); });
  await page.waitForTimeout(600);
  await shot('tab-addons');
  await page.evaluate(() => {
    setTab('console');
    showCmdSuggest([
      { value: '/give', kind: 'команда', label: '/give' },
      { value: '/gamemode', kind: 'команда', label: '/gamemode' },
      { value: '/gamerule', kind: 'команда', label: '/gamerule' },
      { value: 'Steve', kind: 'игрок', label: 'Steve' },
    ]);
  });
  await page.waitForTimeout(350);
  await shot('cmd-suggest');
  await page.evaluate(() => {
    hideCmdSuggest();
    const s0 = S.servers[0];
    s0.state = 'running';
    s0.startedAt = Date.now() - 5400000;
    S.metrics.set(s0.id, { cpu: 12, rss: 860 * 1048576 });
    document.getElementById('gridModal').classList.remove('hidden');
    renderGrid();
  });
  await page.waitForTimeout(450);
  await shot('server-cards');
  await page.evaluate(() => {
    document.getElementById('gridModal').classList.add('hidden');
    S.servers[0].state = 'stopped';
    S.servers[0].startedAt = 0;
    renderGrid();
    setTab('console');
  });

  // 1.17: окно «порт занят» и широкие настройки
  await page.evaluate(() => {
    document.getElementById('prefsModal').classList.add('hidden');
    askPort({ id: S.servers[0].id, conflicts: [{ key: 'server-port', label: 'Порт сервера', port: 25565, serverName: 'Скайблок' }], busy: [] });
  });
  await page.waitForTimeout(600);
  await shot('port-busy');
  await page.evaluate(() => document.getElementById('portModal').classList.add('hidden'));

  await page.evaluate(() => { prefs.scale = 0; prefs.save(); applyPrefs(); openPrefs(); });
  await page.waitForTimeout(700);
  await shot('prefs-wide');
  await page.evaluate(() => document.getElementById('prefsModal').classList.add('hidden'));

  // аддоны: настройки, вкладки аддонов
  await page.evaluate(async () => {
    document.getElementById('prefsModal').classList.remove('hidden');
    document.querySelector('#prefsNav .prefs-tab[data-cat="addons"]').click();
    await loadAddonList();
  });
  await page.waitForTimeout(700);
  await shot('prefs-addons');
  await page.evaluate(() => document.getElementById('prefsModal').classList.add('hidden'));

  await page.evaluate(() => setTab('addon:mythic-mobs'));
  await page.waitForTimeout(1500);
  await shot('addon-mythic');
  await page.evaluate(() => setTab('addon:whitelist'));
  await page.waitForTimeout(1500);
  await shot('addon-whitelist');
  await page.evaluate(() => setTab('console'));

  await page.evaluate(() => { setUpdPill({ hasUpdate: false }); });
  await app.close();
  console.log('скриншоты готовы: ' + outDir);
})().catch((e) => { console.error(e); process.exit(1); });
