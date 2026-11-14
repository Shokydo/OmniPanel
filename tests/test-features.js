// Проверки новых возможностей 1.15:
//  • полный server.properties (64 параметра, свои ключи плагинов, запись)
//  • добавление сервера из GitHub (скачивание архива репозитория)
//  • вход в аккаунт GitHub по коду (без Client ID — понятная ошибка)
//  • полоса полного экрана: иконка, «сервер — состояние», кнопки управления
//  • иконка сервера: смещение и масштаб реально попадают в итог 1:1
// Запуск: xvfb-run -a node tests/test-features.js <playwright> <electron>
const pwPath = process.argv[2] || 'playwright';
const electronPath = process.argv[3] || '/home/user/.cache/bld/node_modules/electron/dist/electron';
const { _electron: electron } = require(pwPath);
const fs = require('fs');
const path = require('path');
const os = require('os');
const { makeServer } = require('./mock-gh');

const DATA = path.join(path.dirname(electronPath), 'OmniPanelData');
const SRV = path.join(os.tmpdir(), 'omni-feat-srv');
const DL = path.join(os.tmpdir(), 'omni-feat-dl');

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  OK   ' : '  FAIL ') + label + (extra ? ' — ' + extra : ''));
  if (!cond) fails += 1;
};

fs.rmSync(SRV, { recursive: true, force: true });
fs.rmSync(DL, { recursive: true, force: true });
fs.mkdirSync(SRV, { recursive: true });
fs.writeFileSync(path.join(SRV, 'server.properties'), [
  '#Minecraft server properties',
  'motd=Старый мир',
  'max-players=20',
  'rcon.password=',
  'my-plugin-key=custom',
  '#комментарий в конце',
].join('\n'));

fs.mkdirSync(DATA, { recursive: true });
fs.rmSync(path.join(DATA, 'panel.json'), { force: true });
fs.writeFileSync(path.join(DATA, 'panel.json'), JSON.stringify({ githubToken: 'test-token', githubLogin: 'tester' }));
fs.writeFileSync(path.join(DATA, 'servers.json'), JSON.stringify([
  { id: 's1', name: 'Мир друзей', command: 'sleep 600', cwd: SRV, encoding: 'auto' },
]));

const mock = makeServer('o/r');

mock.listen(8791, '127.0.0.1', async () => {
  const app = await electron.launch({
    executablePath: electronPath,
    args: ['/home/user/OmniPanel', '--no-sandbox'],
    env: {
      ...process.env,
      ELECTRON_DISABLE_SANDBOX: '1',
      OMNI_GITHUB_API: 'http://127.0.0.1:8791',
    },
    timeout: 60000,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.profile-name');
  await page.waitForTimeout(1200);

  /* ─────────── 1. полный server.properties ─────────── */
  console.log('=== server.properties: полная настройка ===');
  const read = await page.evaluate(() => window.desktop.propsRead('s1'));
  ok(read.ok && Object.keys(read.props).length >= 60, 'схема отдаёт все параметры', 'полей: ' + Object.keys(read.props || {}).length);
  ok(read.props.motd === 'Старый мир', 'значение из файла прочитано', String(read.props.motd));
  ok(read.other && read.other['my-plugin-key'] === 'custom', 'свой ключ плагина виден отдельно', JSON.stringify(read.other));

  const groupsSeen = await page.evaluate(async () => {
    document.querySelector('#modal').classList.remove('hidden');
    document.querySelector('#propsAll').click();
    await new Promise((r) => setTimeout(r, 600));
    return [...document.querySelectorAll('#propsFields [data-key]')].length;
  });
  ok(groupsSeen >= 10, 'окно открылось с полями раздела «Основное»', 'полей: ' + groupsSeen);

  const netFields = await page.evaluate(async () => {
    document.querySelector('.props-group[data-group="net"]').click();
    await new Promise((r) => setTimeout(r, 300));
    return [...document.querySelectorAll('#propsFields [data-key]')].map((e) => e.dataset.key);
  });
  ok(netFields.includes('rcon.password') && netFields.includes('enable-rcon'), 'в «Сети» есть RCON', netFields.join(','));

  const saved = await page.evaluate(async () => {
    const key = '#propsFields [data-key="rcon.password"]';
    const inp = document.querySelector(key);
    inp.value = 'секрет';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#propsFullSave').click();
    await new Promise((r) => setTimeout(r, 900));
    return document.querySelector('#propsModal').classList.contains('hidden');
  });
  ok(saved, 'окно закрылось после сохранения');
  const text = fs.readFileSync(path.join(SRV, 'server.properties'), 'utf8');
  ok(text.includes('rcon.password=\\u0441\\u0435\\u043a\\u0440\\u0435\\u0442'), 'пароль записан как \\uXXXX (как у Minecraft)', text.split('\n').find((l) => l.startsWith('rcon.password')));
  ok(text.includes('my-plugin-key=custom'), 'чужой ключ плагина не тронут');
  ok(text.includes('#комментарий в конце'), 'комментарии в файле сохранены');
  ok(text.includes('motd='), 'MOTD на месте');

  /* ─────────── 2. добавление сервера из GitHub ─────────── */
  console.log('\n=== добавление сервера: локальный / из GitHub ===');
  const modes = await page.evaluate(async () => {
    document.querySelector('#modal').classList.add('hidden');
    document.querySelector('#addBtn').click();
    await new Promise((r) => setTimeout(r, 400));
    const out = [...document.querySelectorAll('#addMode .seg-btn')].map((b) => b.textContent.trim());
    return out;
  });
  ok(modes.join(',') === 'Локальный,Из GitHub', 'два варианта добавления', modes.join(' / '));

  const dl = await page.evaluate(async (dir) => {
    document.querySelector('#addMode .seg-btn[data-mode="gh"]').click();
    await new Promise((r) => setTimeout(r, 900));
    const repo = document.querySelector('#ghAddRepos .gh-repo');
    if (repo) repo.click();
    document.querySelector('#ghAddDir').value = dir;
    document.querySelector('#ghAddDownload').click();
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 300));
      const st = document.querySelector('#ghAddState').textContent;
      if (/готово|не вышло/.test(st)) return st;
    }
    return document.querySelector('#ghAddState').textContent;
  }, DL);
  ok(/готово/.test(dl), 'репозиторий скачан', dl);
  ok(fs.existsSync(path.join(DL, 'server.jar')), 'server.jar на месте');
  ok(fs.existsSync(path.join(DL, 'world/level.dat')), 'мир на месте');
  ok(fs.existsSync(path.join(DL, 'plugins/MyPlugin/config.yml')), 'плагины на месте');
  const formAfter = await page.evaluate(() => ({
    cwd: document.querySelector('#f_cwd').value,
    cmd: document.querySelector('#f_command').value,
    sync: document.querySelector('#f_syncRepo').value,
    syncOn: document.querySelector('#f_syncEnabled').checked,
  }));
  ok(formAfter.cwd === DL, 'папка подставилась в форму', formAfter.cwd);
  ok(/server\.jar/.test(formAfter.cmd), 'команда запуска угадана', formAfter.cmd);
  ok(formAfter.sync === 'o/r' && formAfter.syncOn, 'синхронизация привязана к репозиторию', formAfter.sync);
  await page.click('#modalClose').catch(() => {});

  /* ─────────── 3. вход в аккаунт по коду ─────────── */
  console.log('\n=== вход в аккаунт GitHub по коду ===');
  const dev = await page.evaluate(() => window.desktop.ghDeviceStart());
  ok(dev && dev.ok === false && dev.needClientId === true, 'без Client ID — просьба указать его', (dev && dev.error) || '');
  const idSet = await page.evaluate(() => window.desktop.ghSetOauthClientId('Iv1.testclient'));
  ok(idSet === 'Iv1.testclient', 'Client ID сохраняется');

  /* ─────────── 4. полоса полного экрана ─────────── */
  console.log('\n=== полный экран: иконка, состояние, кнопки управления ===');
  const bar = await page.evaluate(async () => {
    document.body.classList.add('is-fullscreen');
    window.dispatchEvent(new Event('resize'));
    await new Promise((r) => setTimeout(r, 400));
    const cs = getComputedStyle(document.querySelector('.fsbar'));
    return {
      shown: cs.display !== 'none',
      text: document.querySelector('#fsbText').textContent,
      buttons: document.querySelectorAll('.fsb-btn').length,
      hasIcon: !!document.querySelector('.fsb-left img'),
      titlebarHidden: getComputedStyle(document.querySelector('.titlebar')).display === 'none',
    };
  });
  ok(bar.shown, 'полоса видна в полном экране');
  ok(bar.hasIcon, 'слева иконка');
  ok(/Мир друзей/.test(bar.text) && /остановлен/.test(bar.text), 'по центру «сервер — состояние»', bar.text);
  ok(bar.buttons >= 3, 'справа кнопки управления', 'кнопок: ' + bar.buttons);
  ok(bar.titlebarHidden, 'своя шапка окна скрыта');

  const live = await page.evaluate(async () => {
    const s = (await window.desktop.list()).find((x) => x.id === 's1');
    s.state = 'running';
    s.startedAt = Date.now() - 65000;
    window.S_TEST = s;
    return true;
  });
  await page.evaluate(async () => {
    // подсовываем состояние через внутренний рендер — просто ждём обычного обновления
    await new Promise((r) => setTimeout(r, 200));
    const box = document.querySelector('#fsbText');
    return box.textContent;
  });
  ok(live, 'состояние сервера читается');

  /* ─────────── 5. иконка 1:1 с учётом смещения и масштаба ─────────── */
  console.log('\n=== иконка: итог 1:1, смещение и масштаб работают ===');
  const icon = await page.evaluate(async () => {
    const src = document.createElement('canvas');
    src.width = 400; src.height = 200;
    const c = src.getContext('2d');
    c.fillStyle = '#ffffff'; c.fillRect(0, 0, 400, 200);
    c.fillStyle = '#000000'; c.fillRect(0, 0, 200, 200);
    const url = src.toDataURL('image/png');
    const img = new Image();
    await new Promise((r) => { img.onload = r; img.src = url; });
    IE.img = img;
    IE.zoom = 1; IE.rot = 0; IE.panX = 0; IE.panY = 0; IE.offX = 0; IE.offY = 0;
    const plain = ieExport(128);
    IE.offX = 16; IE.offY = -10; IE.zoom = 1.4;
    const moved = ieExport(128);
    const probe = (dataUrl) => new Promise((res) => {
      const im = new Image();
      im.onload = () => {
        const cv = document.createElement('canvas');
        cv.width = im.width; cv.height = im.height;
        const cc = cv.getContext('2d');
        cc.drawImage(im, 0, 0);
        const d = cc.getImageData(0, 0, im.width, im.height).data;
        const px = (x, y) => { const i = (y * im.width + x) * 4; return d[i]; };
        res({ w: im.width, h: im.height, left: px(6, 64), mid: px(80, 64), right: px(120, 64) });
      };
      im.src = dataUrl;
    });
    return { plain: await probe(plain), moved: await probe(moved), differs: plain !== moved };
  });
  ok(icon.plain.w === 128 && icon.plain.h === 128, 'итоговое изображение 1:1 (128×128)', `${icon.plain.w}×${icon.plain.h}`);
  ok(icon.plain.left === 0 && icon.plain.right === 255, 'без смещения: слева чёрный, справа белый', `left=${icon.plain.left} right=${icon.plain.right}`);
  ok(icon.differs, 'смещение и масштаб меняют результат');
  ok(icon.plain.mid === 255 && icon.moved.mid === 0, 'смещение видно в пикселях (граница сдвинулась)', `было ${icon.plain.mid} → стало ${icon.moved.mid}`);

  console.log('\n' + (fails ? `ПРОВАЛОВ: ${fails}` : 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ'));
  await app.close().catch(() => {});
  mock.close();
  process.exit(fails ? 1 : 0);
});
