// UI-проверки в живом Electron: категории настроек, тумблеры, глубина скана,
// история фонов, сохранение темы, вход в GitHub через мок.
// Запуск: xvfb-run -a node tests/test-ui.js <путь-к-playwright> <путь-к-electron>
const pwPath = process.argv[2] || 'playwright';
const electronPath = process.argv[3] || '/home/user/.cache/bld/etl/electron';
const { _electron: electron } = require(pwPath);
const fs = require('fs');
const path = require('path');
const { makeServer } = require('./mock-gh');
const { makeUpdateServer, VERSION: UPD_VERSION } = require('./mock-update');

const DATA = path.join(path.dirname(electronPath), 'OmniPanelData');
const SRV = path.join(require('os').tmpdir(), 'omnitest-srv');

fs.rmSync(SRV, { recursive: true, force: true });
fs.mkdirSync(path.join(SRV, 'world'), { recursive: true });
fs.writeFileSync(path.join(SRV, 'world/level.dat'), 'LEVEL');
fs.writeFileSync(path.join(SRV, 'server.properties'), 'level-name=world\n');
fs.mkdirSync(DATA, { recursive: true });
// чистое состояние: ни аккаунта GitHub, ни прошлых настроек
fs.rmSync(path.join(DATA, 'panel.json'), { force: true });
fs.rmSync(path.join(DATA, 'Local Storage'), { recursive: true, force: true });
fs.writeFileSync(path.join(DATA, 'servers.json'), JSON.stringify([
  { id: 's1', name: 'Тестовый', command: 'sleep 600', cwd: SRV, stopCommand: '', encoding: 'auto', tpsCommand: '', tpsInterval: 30 },
]));

const clearToasts = (page) => page.evaluate(() => {
  document.querySelectorAll('#toasts .notif').forEach((n) => n.remove());
});

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  OK   ' : '  FAIL ') + label + (extra ? ' — ' + extra : ''));
  if (!cond) fails += 1;
};

const mock = makeServer('o/r');
const updMock = makeUpdateServer('u/r');
mock.listen(8788, '127.0.0.1', () => updMock.listen(8790, '127.0.0.1', async () => {
  const app = await electron.launch({
    executablePath: electronPath,
    args: ['/home/user/OmniPanel', '--no-sandbox'],
    env: {
      ...process.env,
      ELECTRON_DISABLE_SANDBOX: '1',
      OMNI_GITHUB_API: 'http://127.0.0.1:8788',
      OMNI_UPDATE_RAW: 'http://127.0.0.1:8790',
      OMNI_UPDATE_API: 'http://127.0.0.1:8790',
    },
    timeout: 60000,
  });
  const page = await app.firstWindow();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('requestfailed', (r) => console.log('  [сеть] не загрузилось: ' + r.url()));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // внешние картинки (аватар из мока) в песочнице недоступны — это не ошибка панели
    if (/ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION/.test(m.text())) return;
    errs.push('console: ' + m.text());
  });
  await page.waitForSelector('.profile-name');
  await page.waitForTimeout(700);

  console.log('\n=== КАТЕГОРИИ НАСТРОЕК ===');
  await page.click('#profileBtn');
  await page.waitForTimeout(500);
  const cats = await page.$$eval('#prefsNav .prefs-tab', (els) => els.map((e) => e.dataset.cat));
  ok(cats.length === 8, 'восемь категорий настроек', cats.join(','));
  for (const c of ['bg', 'fx', 'win', 'notif', 'gh', 'sound', 'upd']) {
    await page.click(`#prefsNav .prefs-tab[data-cat="${c}"]`);
    await page.waitForTimeout(150);
    const visible = await page.$eval(`.prefs-cat[data-cat="${c}"]`, (e) => !e.classList.contains('hidden'));
    ok(visible, `категория «${c}» открывается`);
  }
  await page.screenshot({ path: '/home/user/OmniPanel/screenshot-prefs-categories.png' });

  console.log('\n=== ТУМБЛЕРЫ ВМЕСТО ГАЛОЧЕК ===');
  const sw = await page.evaluate(() => {
    const inp = document.getElementById('pDesktopNotif');
    const cs = getComputedStyle(inp);
    return { appearance: cs.appearance, w: cs.width, h: cs.height, radius: cs.borderRadius };
  });
  ok(sw.appearance === 'none' && sw.w === '34px' && sw.h === '18px', 'галочка выглядит как переключатель', JSON.stringify(sw));

  console.log('\n=== ИСТОРИЯ ФОНОВ И СОХРАНЕНИЕ ТЕМЫ ===');
  await page.click('#prefsNav .prefs-tab[data-cat="bg"]');
  await page.waitForTimeout(200);
  await page.click('#wallGrid .wall-cell:nth-child(2)');
  await page.waitForTimeout(300);
  await page.click('#wallGrid .wall-cell:nth-child(3)');
  await page.waitForTimeout(300);
  const recent = await page.$$eval('#wallRecent .wall-cell', (els) => els.length);
  ok(recent >= 2, 'выбранные фоны попали в историю', 'элементов: ' + recent);
  await page.screenshot({ path: '/home/user/OmniPanel/screenshot-wallpapers.png' });

  await page.click('#prefsNav .prefs-tab[data-cat="look"]');
  await page.waitForTimeout(200);
  await page.evaluate(() => { prefs.custom = { bg: '#101820', panel: '#1a2632', text: '#e6eef6', accent: '#7fd1ff' }; prefs.save(); applyPrefs(); });
  await page.fill('#themeName', 'Моя ночь');
  await page.click('#themeSave');
  await page.waitForTimeout(300);
  const presets = await page.$$eval('#themePresets .theme-preset', (els) => els.map((e) => e.textContent.trim()));
  ok(presets.some((t) => t.includes('Моя ночь')), 'тема сохранена в пресеты', JSON.stringify(presets));

  console.log('\n=== ВХОД В GITHUB И СПИСОК РЕПОЗИТОРИЕВ ===');
  await page.click('#prefsNav .prefs-tab[data-cat="gh"]');
  await page.waitForTimeout(300);
  ok(await page.$eval('#ghDeviceBtn', (e) => !e.classList.contains('hidden')), 'кнопка «Войти через GitHub» показана');
  ok(await page.$eval('#ghLoginName', (e) => e.textContent === 'не выполнен вход'), 'статус «вход не выполнен»');
  // поле токена — за кнопкой «Вход по токену»
  ok(await page.$eval('#ghTokenRow', (e) => e.classList.contains('hidden')), 'поле токена спрятано по умолчанию');
  await page.click('#ghTokenToggle');
  await page.waitForTimeout(200);
  ok(await page.$eval('#ghTokenRow', (e) => !e.classList.contains('hidden')), 'поле токена открылось кнопкой');
  await page.fill('#ghToken', 'test-token');
  await page.click('#ghLogin');
  await page.waitForTimeout(1500);
  const ghState = await page.evaluate(() => ({
    name: document.getElementById('ghLoginName').textContent,
    repos: [...document.querySelectorAll('#ghRepoList .gh-repo')].map((e) => e.textContent.trim()),
  }));
  ok(ghState.name === 'tester', 'вход выполнен, логин показан', ghState.name);
  ok(ghState.repos.some((r) => r.includes('o/r')), 'репозитории подгрузились', JSON.stringify(ghState.repos));
  ok(await page.$eval('#ghLoginRow', (e) => e.classList.contains('hidden')), 'при активном входе весь блок входа скрыт');
  await page.click('#ghRepoList .gh-repo');
  await page.waitForTimeout(300);
  ok(await page.$eval('#ghRepoList .gh-repo', (e) => e.classList.contains('sel')), 'репозиторий помечен выбранным');
  const selRepo = await page.$eval('#ghRepoList .gh-repo.sel', (e) => e.dataset.repo);
  ok(selRepo === 'o/r', 'клик по репозиторию выбирает его', selRepo);
  for (const c of ['look', 'fx', 'win', 'notif']) {
    await page.click(`#prefsNav .prefs-tab[data-cat="${c}"]`);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `/home/user/OmniPanel/screenshot-prefs-${c}.png` });
  }
  await page.click('#prefsNav .prefs-tab[data-cat="gh"]');
  await page.waitForTimeout(250);
  await page.screenshot({ path: '/home/user/OmniPanel/screenshot-github-auth.png' });
  console.log('\n=== ОБНОВЛЕНИЯ ===');
  await clearToasts(page);
  await page.click('#prefsNav .prefs-tab[data-cat="upd"]');
  await page.waitForTimeout(300);
  const curVer = await page.$eval('#updCurVer', (e) => e.textContent.trim());
  ok(/Версия \d+\.\d+\.\d+/.test(curVer), 'текущая версия показана', curVer);
  ok(await page.$eval('#updApplyBtn', (e) => e.disabled), 'до проверки кнопка обновления выключена');

  await page.fill('#updRepo', 'u/r');
  await page.dispatchEvent('#updRepo', 'change');
  await page.waitForTimeout(400);

  await page.click('#updCheckBtn');
  await page.waitForTimeout(1800);
  const updState = await page.$eval('#updState', (e) => e.textContent.trim());
  ok(updState.includes(UPD_VERSION), 'новая версия найдена в канале', updState);
  const updNotes = await page.$eval('#updNotes', (e) => e.textContent.trim());
  ok(updNotes.includes('Обновление из GitHub'), 'описание обновления показано', updNotes.split('\n')[0]);
  ok(!(await page.$eval('#updApplyBtn', (e) => e.disabled)), 'кнопка «Обновить» включилась');
  ok(await page.$eval('#updFullBtn', (e) => e.disabled), 'полной сборки в канале нет — кнопка выключена');
  await page.screenshot({ path: '/home/user/OmniPanel/screenshot-updates.png' });

  ok(await page.$eval('.prefs-tab[data-cat="upd"]', (e) => e.classList.contains('has-new')), 'на вкладке появился маркер обновления');
  await clearToasts(page);
  const savedCfg = await page.evaluate(() => window.desktop.updConfig());
  ok(savedCfg.repo === 'u/r' && savedCfg.branch === 'main' && savedCfg.auto === true, 'канал сохранён в настройках', JSON.stringify(savedCfg.repo));
  await clearToasts(page);
  await page.click('#updAuto');
  await page.waitForTimeout(300);
  const cfg2 = await page.evaluate(() => window.desktop.updConfig());
  ok(cfg2.auto === false, 'проверка при запуске выключается тумблером');
  await page.click('#updAuto');
  await page.waitForTimeout(300);

  await clearToasts(page);
  await page.click('#prefsDone');
  await page.waitForTimeout(300);

  console.log('\n=== ГЛУБИНА СКАНИРОВАНИЯ — КНОПКА ===');
  await page.click('#scanBtn');
  await page.waitForTimeout(500);
  const d1 = await page.evaluate(() => ({ v: document.getElementById('scanDepthVal').textContent, dots: document.querySelectorAll('#scanDepthDots i.on').length }));
  await page.click('#scanDepthBtn');
  await page.waitForTimeout(200);
  const d2 = await page.evaluate(() => ({ v: document.getElementById('scanDepthVal').textContent, dots: document.querySelectorAll('#scanDepthDots i.on').length }));
  ok(d1.v !== d2.v, 'кнопка переключает глубину', `${d1.v} → ${d2.v}`);
  ok(d2.dots === d1.dots + 1, 'индикатор ступеней растёт вместе с глубиной', `${d1.dots} → ${d2.dots}`);
  await page.screenshot({ path: '/home/user/OmniPanel/screenshot-scan-depth.png' });

  await page.click('#scanClose');
  await page.waitForTimeout(300);

  console.log('\n=== МАСШТАБ ИНТЕРФЕЙСА ===');
  await page.click('#profileBtn');
  await page.waitForTimeout(400);
  await page.click('#prefsNav .prefs-tab[data-cat="win"]');
  await page.waitForTimeout(200);
  await page.click('#scaleGrid .chip[data-scale="115"]');
  await page.waitForTimeout(300);
  const zoom = await page.evaluate(() => getComputedStyle(document.documentElement).zoom);
  ok(zoom === '1.15', 'масштаб применился', zoom);
  await page.screenshot({ path: '/home/user/OmniPanel/screenshot-prefs-win.png' });
  await page.click('#scaleGrid .chip[data-scale="100"]');
  await page.waitForTimeout(200);
  await page.click('#prefsDone');
  await page.waitForTimeout(200);

  console.log('\n=== ФОРМА СЕРВЕРА: СИНХРОНИЗАЦИЯ ===');
  await page.click('#serverList .srv');
  await page.waitForTimeout(400);
  await page.click('#btnSettings');
  await page.waitForTimeout(700);
  const scope = await page.$$eval('#f_syncScope option', (els) => els.map((e) => e.value));
  ok(scope[0] === 'all', 'по умолчанию весь сервер', scope.join(','));
  ok(await page.$eval('#f_syncScope', (e) => e.value === 'all'), 'поле стоит на «весь сервер»');
  ok(await page.$eval('#f_syncRepo', (e) => !!e.getAttribute('list')), 'поле репозитория связано со списком');
  const dl = await page.$$eval('#f_syncRepoList option', (els) => els.map((e) => e.value));
  ok(dl.includes('o/r'), 'репозиторий предложен в подсказке списка', JSON.stringify(dl));
  await page.$eval('#modal .modal-body', (e) => { e.scrollTop = e.scrollHeight; });
  await page.waitForTimeout(400);
  await page.screenshot({ path: '/home/user/OmniPanel/screenshot-sync-scope.png' });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  console.log('\n=== ОШИБКИ ===');
  ok(errs.length === 0, 'нет JS-ошибок', errs.slice(0, 3).join(' | '));

  console.log('\n' + (fails ? `ПРОВАЛОВ: ${fails}` : 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ'));
  await app.close();
  mock.close();
  updMock.close();
  process.exit(fails ? 1 : 0);
}));
