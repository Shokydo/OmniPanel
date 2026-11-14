// Проверки 1.18.0: аддоны панели (вкл/выкл, вкладка, мост), вход в GitHub без спама,
// масштаб «под окно», широкие настройки.
// Запуск: xvfb-run -a node tests/test-addons.js <playwright> <electron>
const pwPath = process.argv[2] || 'playwright';
const electronPath = process.argv[3] || '/home/user/.cache/bld/node_modules/electron/dist/electron';
const { _electron: electron } = require(pwPath);
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA = path.join(path.dirname(electronPath), 'OmniPanelData');
const SRV = path.join(os.tmpdir(), 'omni-addons-srv');

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  OK   ' : '  FAIL ') + label + (extra ? ' — ' + extra : ''));
  if (!cond) fails += 1;
};

fs.rmSync(SRV, { recursive: true, force: true });
fs.mkdirSync(path.join(SRV, 'MythicMobs/Mobs'), { recursive: true });
fs.writeFileSync(path.join(SRV, 'MythicMobs/Mobs/SkeletonKing.yml'), [
  'SkeletonKing:',
  '  Type: SKELETON',
  '  Display: \'Король скелетов\'',
  '  Health: 120',
].join('\n'));
fs.writeFileSync(path.join(SRV, 'MythicMobs/Mobs/Broken.yml'), 'Broken:\n\tType: ZOMBIE\n');
fs.writeFileSync(path.join(SRV, 'server.properties'), 'server-port=25565\nwhite-list=false\nmax-players=20\n');
fs.writeFileSync(path.join(SRV, 'whitelist.json'), JSON.stringify([{ uuid: '', name: 'Steve' }]));

fs.mkdirSync(DATA, { recursive: true });
fs.rmSync(path.join(DATA, 'panel.json'), { force: true });
fs.rmSync(path.join(DATA, 'addons.json'), { force: true });
fs.rmSync(path.join(DATA, 'Local Storage'), { recursive: true, force: true });
fs.writeFileSync(path.join(DATA, 'servers.json'), JSON.stringify([
  { id: 's1', name: 'Мир друзей', command: 'sleep 300', cwd: SRV, encoding: 'auto' },
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

  /* ─────────── 1. список аддонов ─────────── */
  console.log('\n=== аддоны: список и переключатели ===');
  const list = await page.evaluate(() => window.desktop.addonsList());
  ok(Array.isArray(list) && list.length >= 2, 'встроенные аддоны найдены', list.map((a) => a.id).join(','));
  ok(list.every((a) => a.builtin), 'они помечены как встроенные');
  ok(list.every((a) => a.enabled), 'по умолчанию включены');

  const manager = await page.evaluate(async () => {
    openPrefs();
    document.querySelector('#prefsNav .prefs-tab[data-cat="addons"]').click();
    await new Promise((r) => setTimeout(r, 500));
    const rows = [...document.querySelectorAll('#addonManager .addon-manage-row')];
    return {
      rows: rows.length,
      toggles: document.querySelectorAll('#addonManager input[type="checkbox"]').length,
      names: rows.map((r) => r.querySelector('.am-name').textContent),
      checked: rows.every((r) => r.querySelector('input').checked),
      hasFolder: !!document.getElementById('addonsFolder'),
    };
  });
  ok(manager.rows >= 2 && manager.toggles === manager.rows, 'в настройках список с переключателями', manager.names.join(', '));
  ok(manager.checked, 'переключатели включены');
  ok(manager.hasFolder, 'есть кнопка «Открыть папку аддонов»');
  await page.evaluate(() => closePrefs());

  /* ─────────── 2. вкладка аддона ─────────── */
  console.log('\n=== вкладка аддона и его панель ===');
  const tabs = await page.evaluate(() => {
    renderAddonTabs();
    return [...document.querySelectorAll('#view .tabs .tab')].map((t) => t.dataset.tab);
  });
  ok(tabs.includes('addon:mythic-mobs'), 'появилась вкладка «Мифические мобы»', tabs.join(','));
  ok(tabs.includes('addon:whitelist'), 'появилась вкладка «Белый список»');

  const panel = await page.evaluate(async () => {
    setTab('addon:mythic-mobs');
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 150));
      const f = document.querySelector('.addon-frame[data-addon-id="mythic-mobs"]');
      if (f && f.dataset.loaded === '1' && f.contentDocument) {
        const doc = f.contentDocument;
        const cards = doc.querySelectorAll('.mob').length;
        if (cards) return { loaded: true, cards, sub: doc.getElementById('sub').textContent };
      }
    }
    const f = document.querySelector('.addon-frame[data-addon-id="mythic-mobs"]');
    return { loaded: !!(f && f.dataset.loaded === '1'), cards: 0, sub: '' };
  });
  ok(panel.loaded, 'панель аддона загрузилась в изолированном окне');
  ok(panel.cards === 2, 'аддон прочитал файлы MythicMobs/Mobs', 'карточек: ' + panel.cards + ' · ' + panel.sub);

  const inside = await page.evaluate(async () => {
    const f = document.querySelector('.addon-frame[data-addon-id="mythic-mobs"]');
    const doc = f.contentDocument;
    doc.getElementById('scan').click();
    await new Promise((r) => setTimeout(r, 400));
    const status = doc.getElementById('status');
    const body = doc.body.innerText;
    const bg = getComputedStyle(doc.body).backgroundColor;
    return { status: status.textContent, cls: status.className, bg };
  });
  ok(/проблемы/.test(inside.status), 'проверка файлов нашла кривой моб', inside.status.slice(0, 80));
  ok(inside.bg !== 'rgb(255, 255, 255)', 'панель аддона в цветах темы', inside.bg);

  const write = await page.evaluate(async () => {
    const doc = document.querySelector('.addon-frame[data-addon-id="mythic-mobs"]').contentDocument;
    doc.getElementById('newName').value = 'TestMob';
    doc.getElementById('new').click();
    await new Promise((r) => setTimeout(r, 1400));
    return doc.querySelectorAll('.mob').length;
  });
  ok(fs.existsSync(path.join(SRV, 'MythicMobs/Mobs/TestMob.yml')), 'аддон создал файл моба через мост');
  ok(write >= 3, 'список обновился после создания', 'карточек: ' + write);

  /* ─────────── 3. белый список ─────────── */
  console.log('\n=== аддон «Белый список» ===');
  const wl = await page.evaluate(async () => {
    setTab('addon:whitelist');
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 150));
      const f = document.querySelector('.addon-frame[data-addon-id="whitelist"]');
      if (f && f.contentDocument && f.contentDocument.querySelectorAll('.item').length) {
        const doc = f.contentDocument;
        return { items: doc.querySelectorAll('.item').length, sub: doc.getElementById('sub').textContent };
      }
    }
    return { items: 0, sub: '' };
  });
  ok(wl.items === 1, 'игрок из whitelist.json показан', wl.sub);

  const wlAdd = await page.evaluate(async () => {
    const doc = document.querySelector('.addon-frame[data-addon-id="whitelist"]').contentDocument;
    doc.getElementById('nick').value = 'Alex';
    doc.getElementById('add').click();
    await new Promise((r) => setTimeout(r, 1500));
    return { items: doc.querySelectorAll('.item').length, status: doc.getElementById('status').textContent };
  });
  ok(wlAdd.items === 2, 'игрок добавлен', 'в списке: ' + wlAdd.items);
  const wlFile = JSON.parse(fs.readFileSync(path.join(SRV, 'whitelist.json'), 'utf8'));
  ok(wlFile.some((x) => x.name === 'Alex'), 'whitelist.json обновлён на диске', wlFile.map((x) => x.name).join(','));

  const wlSwitch = await page.evaluate(async () => {
    const doc = document.querySelector('.addon-frame[data-addon-id="whitelist"]').contentDocument;
    doc.getElementById('sw').click();
    await new Promise((r) => setTimeout(r, 900));
    return doc.getElementById('swlbl').textContent;
  });
  ok(/включён/.test(wlSwitch), 'переключатель белого списка работает', wlSwitch);
  ok(/white-list=true/.test(fs.readFileSync(path.join(SRV, 'server.properties'), 'utf8')),
    'server.properties обновлён аддоном');

  /* ─────────── 4. выключение аддона ─────────── */
  console.log('\n=== выключение аддона ===');
  const off = await page.evaluate(async () => {
    const res = await window.desktop.addonsSetEnabled('whitelist', false);
    await loadAddonList();
    return {
      res,
      tabs: [...document.querySelectorAll('#view .tabs .tab')].map((t) => t.dataset.tab),
      active: S.tab,
      panel: await window.desktop.addonsPanel('whitelist'),
    };
  });
  ok(off.res.ok && off.res.enabled === false, 'аддон выключен');
  ok(!off.tabs.includes('addon:whitelist'), 'вкладка исчезла', off.tabs.join(','));
  ok(off.panel && off.panel.ok === false, 'панель выключенного аддона не отдаётся', off.panel.error);
  ok(off.active !== 'addon:whitelist', 'панель переключилась на другую вкладку', off.active);

  const back = await page.evaluate(async () => {
    await window.desktop.addonsSetEnabled('whitelist', true);
    await loadAddonList();
    return [...document.querySelectorAll('#view .tabs .tab')].map((t) => t.dataset.tab);
  });
  ok(back.includes('addon:whitelist'), 'после включения вкладка вернулась');

  /* ─────────── 5. вход в GitHub: без спама ─────────── */
  console.log('\n=== вход в GitHub по коду ===');
  const auth = await page.evaluate(async () => {
    openPrefs();
    document.querySelector('#prefsNav .prefs-tab[data-cat="gh"]').click();
    await new Promise((r) => setTimeout(r, 400));
    const a = document.getElementById('ghDeviceBtn').getBoundingClientRect();
    const b = document.getElementById('ghTokenToggle').getBoundingClientRect();
    const tokensHidden = document.getElementById('ghTokenRow').classList.contains('hidden');
    document.getElementById('ghTokenToggle').click();
    await new Promise((r) => setTimeout(r, 200));
    const tokenOpen = !document.getElementById('ghTokenRow').classList.contains('hidden');
    const row = {
      buttons: {
        sameRow: Math.abs(a.top - b.top) < 2,
        sameW: Math.abs(a.width - b.width) < 2,
        h: Math.round(a.height),
        h2: Math.round(b.height),
      },
      tokensHidden,
      tokenOpen,
    };
    closePrefs();
    return row;
  });
  ok(auth.tokensHidden && auth.tokenOpen, 'строка токена раскрывается кнопкой');
  ok(auth.buttons.sameRow, 'кнопки «Вход по коду» и «Вход по токену» в одной строке');
  ok(auth.buttons.sameW && auth.buttons.h === auth.buttons.h2, 'кнопки одного размера',
    auth.buttons.h + 'px / ' + auth.buttons.h2 + 'px');

  const flow = await page.evaluate(async () => {
    const notifs = [];
    const origNotify = window.notify;
    window.notify = (o) => { notifs.push((o && o.title) || ''); };
    gdStop('');
    const res = await window.desktop.ghDeviceStart();
    GD.code = res.deviceCode;
    GD.interval = 5;
    GD.run += 1;
    gdSchedule(GD.run);
    const timerFirst = GD.timer;
    // второе нажатие при уже идущем ожидании не должно плодить второй опрос
    await gdStart();
    const sameTimer = timerFirst !== null && timerFirst === GD.timer;
    gdStop('');
    window.notify = origNotify;
    return { sameTimer, notifs: notifs.length };
  });
  ok(flow.sameTimer, 'повторное нажатие «Вход по коду» не создаёт второй опрос');

  const spam = await page.evaluate(async () => {
    const notifs = [];
    const origNotify = window.notify;
    window.notify = (o) => { notifs.push((o && o.title) || ''); };
    gdStop('');
    const res = await window.desktop.ghDeviceStart();
    GD.code = 'неверный-код';           // GitHub ответит ошибкой — как при сбое входа
    GD.interval = 0;
    GD.run += 1;
    gdSchedule(GD.run);
    await new Promise((r) => setTimeout(r, 1800));
    const after = { timer: !!GD.timer, code: GD.code };
    const count = notifs.filter((t) => /не выполнен/i.test(t)).length;
    window.notify = origNotify;
    return { errors: count, after };
  });
  ok(spam.errors === 1, 'при сбое входа только одно уведомление', 'уведомлений: ' + spam.errors);


  ok(!spam.after.timer && !spam.after.code, 'опрос останавливается сам', JSON.stringify(spam.after));

  /* ─────────── 6. масштаб ─────────── */
  console.log('\n=== масштаб под окно ===');
  const scale = await page.evaluate(async () => {
    prefs.scale = 0;
    prefs.save();
    applyPrefs();
    await new Promise((r) => setTimeout(r, 200));
    const before = Number(document.documentElement.dataset.scale);
    const w = innerWidth;
    const need = Math.round(Math.min(w / 1120, innerHeight / 700) * 100);
    return { before, need, hasChip: !!document.querySelector('#scaleGrid .chip[data-scale="0"]') };
  });
  ok(scale.hasChip, 'есть пункт «Под окно»');
  ok(Math.abs(scale.before - scale.need) <= 5, 'масштаб считается от размера окна', scale.before + '% против ' + scale.need + '%');

  const resize = await page.evaluate(async () => {
    const before = Number(document.documentElement.dataset.scale);
    // имитируем изменение размера окна
    Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 1000, configurable: true });
    window.dispatchEvent(new Event('resize'));
    await new Promise((r) => setTimeout(r, 400));
    const after = Number(document.documentElement.dataset.scale);
    return { before, after };
  });
  ok(resize.after > resize.before, 'при увеличении окна интерфейс растёт', resize.before + '% → ' + resize.after + '%');

  /* ─────────── 7. ошибки ─────────── */
  const errs = await page.evaluate(() => window.__jsErrors || []);
  console.log('\n=== ОШИБКИ ===');
  ok(errs.length === 0, 'нет JS-ошибок', errs.join(' | '));

  await app.close();
  console.log(fails ? `\nПРОВАЛОВ: ${fails}` : '\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
