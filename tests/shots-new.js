// Скриншоты новых экранов: полоса полного экрана, вход по коду, добавление из GitHub,
// полный редактор server.properties, редактор иконки.
const pwPath = process.argv[2];
const electronPath = process.argv[3];
const OUT = process.argv[4] || '/home/user/shots';
const { _electron: electron } = require(pwPath);
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA = path.join(path.dirname(electronPath), 'OmniPanelData');
const SRV = path.join(os.tmpdir(), 'omni-shots-srv');
fs.rmSync(SRV, { recursive: true, force: true });
fs.mkdirSync(SRV, { recursive: true });
fs.writeFileSync(path.join(SRV, 'server.properties'),
  ['#Minecraft server properties', 'motd=Добро пожаловать', 'server-port=25565', 'max-players=20',
   'difficulty=normal', 'gamemode=survival', 'pvp=true', 'online-mode=true', 'view-distance=10',
   'level-name=world', 'enable-rcon=false', 'my-plugin-key=custom'].join('\n'));
fs.mkdirSync(DATA, { recursive: true });
fs.rmSync(path.join(DATA, 'panel.json'), { force: true });
fs.writeFileSync(path.join(DATA, 'panel.json'), JSON.stringify({ githubLogin: 'Shokydo', githubToken: 'ghp_test', githubAvatar: '' }));
fs.writeFileSync(path.join(DATA, 'servers.json'), JSON.stringify([
  { id: 's1', name: 'Мир друзей', command: 'sleep 600', cwd: SRV, encoding: 'auto' },
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
  fs.mkdirSync(OUT, { recursive: true });

  // 1. обычный вид
  await page.screenshot({ path: path.join(OUT, '1-main.png') });

  // 2. полный экран: полоса с иконкой, текстом и тремя кнопками
  await page.evaluate(() => { document.body.classList.add('is-fullscreen'); window.dispatchEvent(new Event('resize')); });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, '2-fullscreen.png') });
  const fsb = await page.$eval('#fsbText', (e) => e.textContent);
  console.log('полоса полного экрана:', fsb);
  const btnCount = await page.$$eval('.fsb-btn', (b) => b.length);
  console.log('кнопок справа:', btnCount);
  await page.evaluate(() => document.body.classList.remove('is-fullscreen'));

  // 3. полный редактор server.properties
  await page.click('.topbar .btn-icon[data-act="settings"], #btnSettings, .tb-right .btn-icon');
  await page.waitForTimeout(600);
  await page.click('#propsAll');
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT, '3-props-main.png') });
  const groups = await page.$$eval('.props-group', (b) => b.map((x) => x.textContent.trim()));
  console.log('разделы настроек:', groups.join(' | '));
  await page.click('.props-group[data-group="net"]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, '4-props-net.png') });
  const fields = await page.$$eval('#propsFields [data-key]', (b) => b.length);
  console.log('полей в разделе «Сеть и доступ»:', fields);
  await page.click('.props-group[data-group="extra"]');
  await page.waitForTimeout(300);
  const extra = await page.$$eval('#propsFields [data-key]', (b) => b.length);
  console.log('своих ключей найдено:', extra);
  await page.screenshot({ path: path.join(OUT, '5-props-extra.png') });
  await page.click('#propsFullCancel');
  await page.click('#modalClose').catch(() => {});

  // 4. добавление сервера: два варианта
  await page.click('#addBtn');
  await page.waitForTimeout(500);
  await page.click('#addMode .seg-btn[data-mode="gh"]');
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT, '6-add-github.png') });
  await page.click('#ghAddSrc .seg-btn[data-src="token"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, '7-add-github-token.png') });

  // 5. вход в аккаунт по коду
  await page.click('#modalClose').catch(() => {});
  await page.evaluate(() => document.querySelector('#prefsModal').classList.remove('hidden'));
  await page.click('.prefs-tab[data-cat="gh"]');
  await page.waitForTimeout(400);
  await page.click('#ghLogout').catch(() => {});
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, '8-gh-login.png') });
  await page.evaluate(() => {
    document.querySelector('#ghDeviceBox').classList.remove('hidden');
    document.querySelector('#ghDeviceBtn').classList.add('hidden');
    document.querySelector('#ghDeviceCode').textContent = 'A1B2-C3D4';
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, '9-gh-device-code.png') });

  console.log('скриншоты в', OUT);
  await app.close().catch(() => {});
  process.exit(0);
})();
