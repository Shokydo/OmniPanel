// Проверки 1.19: аддоны панели (по умолчанию, вкл/выкл, вкладка, мост),
// вики и адаптация кода MythicMobs, белый список, вход в GitHub без спама.
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
  "  Display: 'Король скелетов'",
  '  Health: 120',
  '  Skills: []',
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

/** Ждёт, пока панель аддона нарисует нужное условие. */
async function waitAddon(page, id, test) {
  for (let i = 0; i < 50; i += 1) {
    const res = await page.evaluate(({ addonId, expr }) => {
      const f = document.querySelector(`.addon-frame[data-addon-id="${addonId}"]`);
      if (!f || !f.contentDocument) return null;
      const doc = f.contentDocument;
      // eslint-disable-next-line no-new-func
      return new Function('doc', `return (${expr});`)(doc);
    }, { addonId: id, expr: test });
    if (res) return res;
    await page.waitForTimeout(150);
  }
  return null;
}

(async () => {
  const app = await electron.launch({
    executablePath: electronPath,
    args: ['/home/user/OmniPanel', '--no-sandbox'],
    env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' },
    timeout: 60000,
  });
  const page = await app.firstWindow();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.waitForSelector('.profile-name');
  await page.waitForTimeout(1200);

  /* ─────────── 1. что включено по умолчанию ─────────── */
  console.log('\n=== аддоны: список и значения по умолчанию ===');
  const list = await page.evaluate(() => window.desktop.addonsList());
  const byId = Object.fromEntries((list || []).map((a) => [a.id, a]));
  ok(Array.isArray(list) && list.length >= 2, 'встроенные аддоны найдены', (list || []).map((a) => a.id).join(','));
  ok(byId['mythic-mobs'] && byId['mythic-mobs'].enabled === false, '«Мифические мобы» выключены по умолчанию');
  ok(byId.whitelist && byId.whitelist.enabled === true, '«Белый список» включён по умолчанию');

  const manager = await page.evaluate(async () => {
    openPrefs();
    document.querySelector('#prefsNav .prefs-tab[data-cat="addons"]').click();
    await new Promise((r) => setTimeout(r, 500));
    const rows = [...document.querySelectorAll('#addonManager .addon-manage-row')];
    return {
      rows: rows.length,
      toggles: document.querySelectorAll('#addonManager input[type="checkbox"]').length,
      names: rows.map((r) => r.querySelector('.am-name').textContent),
      states: rows.map((r) => r.querySelector('input').checked),
      hasFolder: !!document.getElementById('addonsFolder'),
    };
  });
  ok(manager.rows >= 2 && manager.toggles === manager.rows, 'в настройках список с переключателями', manager.names.join(', '));
  ok(manager.states.filter(Boolean).length === 1, 'включён ровно один — белый список', JSON.stringify(manager.states));
  ok(manager.hasFolder, 'есть кнопка «Открыть папку аддонов»');

  /* включаем «Мифических мобов» переключателем, как это делает человек */
  const turnedOn = await page.evaluate(async () => {
    const row = [...document.querySelectorAll('#addonManager .addon-manage-row')]
      .find((r) => /Мифические/.test(r.textContent));
    row.querySelector('input').click();
    await new Promise((r) => setTimeout(r, 700));
    return {
      tabs: [...document.querySelectorAll('#view .tabs .tab')].map((t) => t.dataset.tab),
      rowsOn: [...document.querySelectorAll('#addonManager .addon-manage-row input')].filter((i) => i.checked).length,
    };
  });
  ok(turnedOn.rowsOn === 2, 'переключатель включил второй аддон');
  ok(turnedOn.tabs.includes('addon:mythic-mobs'), 'появилась вкладка «Мифические мобы»', turnedOn.tabs.join(','));
  await page.evaluate(() => closePrefs());

  /* ─────────── 2. вика MythicMobs ─────────── */
  console.log('\n=== аддон «Мифические мобы»: вика ===');
  await page.evaluate(() => setTab('addon:mythic-mobs'));
  const cards = await waitAddon(page, 'mythic-mobs', "doc.querySelectorAll('#wikiList .card').length || 0");
  ok(cards >= 5, 'вика показала разделы', 'разделов: ' + cards);
  const hasCode = await page.evaluate(() => {
    const doc = document.querySelector('.addon-frame[data-addon-id="mythic-mobs"]').contentDocument;
    const pre = doc.querySelector('#wikiList pre');
    return { text: pre ? pre.textContent : '', bg: getComputedStyle(doc.body).backgroundColor };
  });
  ok(/Type:\s*ZOMBIE/.test(hasCode.text), 'в вики есть готовый пример моба');
  ok(hasCode.bg !== 'rgb(255, 255, 255)', 'панель аддона в цветах темы', hasCode.bg);

  /* ─────────── 3. адаптация кода ─────────── */
  console.log('\n=== адаптация кода MythicMobs ===');
  const adapt = await page.evaluate(async () => {
    const doc = document.querySelector('.addon-frame[data-addon-id="mythic-mobs"]').contentDocument;
    doc.getElementById('tabFix').click();
    await new Promise((r) => setTimeout(r, 150));
    doc.getElementById('src').value = 'BadMob:\n\tType: ZOMBIE\n\tSkill:\n\t\t- ignite{ticks=40} @Target ~onAttack';
    doc.getElementById('savePath').value = '';
    doc.getElementById('fixBtn').click();
    await new Promise((r) => setTimeout(r, 300));
    return {
      verdict: doc.getElementById('verdict').textContent,
      out: doc.getElementById('out').textContent,
      savePath: doc.getElementById('savePath').value,
    };
  });
  ok(/табуляц/i.test(adapt.verdict), 'нашёл табуляцию', adapt.verdict.slice(0, 90));
  ok(!/\t/.test(adapt.out), 'табуляция заменена пробелами');
  ok(/Skills:/.test(adapt.out) && !/^\s*Skill:/m.test(adapt.out), 'Skill: исправлен на Skills:');
  ok(/Health:/.test(adapt.out), 'добавил обязательный Health');
  ok(/MythicMobs\/Mobs\/BadMob\.yml/.test(adapt.savePath), 'подставил путь файла', adapt.savePath);

  const saved = await page.evaluate(async () => {
    const doc = document.querySelector('.addon-frame[data-addon-id="mythic-mobs"]').contentDocument;
    doc.getElementById('saveBtn').click();
    await new Promise((r) => setTimeout(r, 900));
    return doc.getElementById('verdict').textContent;
  });
  ok(fs.existsSync(path.join(SRV, 'MythicMobs/Mobs/BadMob.yml')), 'аддон записал файл через мост');
  const savedText = fs.existsSync(path.join(SRV, 'MythicMobs/Mobs/BadMob.yml'))
    ? fs.readFileSync(path.join(SRV, 'MythicMobs/Mobs/BadMob.yml'), 'utf8') : '';
  ok(!/\t/.test(savedText) && /Skills:/.test(savedText), 'в файле нет табуляции, ключ Skills на месте');
  ok(/Сохранено/.test(saved), 'панель подтвердила запись', saved.slice(0, 70));

  /* ─────────── 4. проверка файлов ─────────── */
  console.log('\n=== проверка файлов аддоном ===');
  const scan = await page.evaluate(async () => {
    const doc = document.querySelector('.addon-frame[data-addon-id="mythic-mobs"]').contentDocument;
    doc.getElementById('tabFiles').click();
    doc.getElementById('scanBtn').click();
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 150));
      const rows = [...doc.querySelectorAll('#files div')].filter((d) => d.querySelector('.n'));
      if (rows.length >= 3) {
        return { rows: rows.length, states: rows.map((r) => r.querySelector('.n').textContent + ': ' + r.querySelector('.st').textContent) };
      }
    }
    return { rows: 0, states: [] };
  });
  ok(scan.rows >= 3, 'список файлов MythicMobs получен', 'файлов: ' + scan.rows);
  ok(scan.states.some((s) => /Broken\.yml/.test(s) && /табуляц/i.test(s)), 'кривой файл помечен', scan.states.join(' · ').slice(0, 120));

  /* ─────────── 5. белый список ─────────── */
  console.log('\n=== аддон «Белый список» ===');
  await page.evaluate(() => setTab('addon:whitelist'));
  const wlItems = await waitAddon(page, 'whitelist', "doc.querySelectorAll('#rows tr').length || 0");
  ok(wlItems === 1, 'игрок из whitelist.json показан', 'строк: ' + wlItems);
  const wlUuid = await page.evaluate(() => {
    const doc = document.querySelector('.addon-frame[data-addon-id="whitelist"]').contentDocument;
    return doc.querySelector('#rows tr td.uuid').textContent;
  });
  ok(wlUuid === '— нет uuid —' || /-/.test(wlUuid), 'у записи видно состояние UUID', wlUuid.slice(0, 40));

  const wlAdd = await page.evaluate(async () => {
    const doc = document.querySelector('.addon-frame[data-addon-id="whitelist"]').contentDocument;
    doc.getElementById('nick').value = 'Alex';
    doc.getElementById('add').click();
    await new Promise((r) => setTimeout(r, 1600));
    return { items: doc.querySelectorAll('#rows tr').length, hint: doc.getElementById('hint').textContent };
  });
  ok(wlAdd.items === 2, 'игрок добавлен', 'в списке: ' + wlAdd.items + ' · ' + wlAdd.hint.slice(0, 60));
  const wlFile = JSON.parse(fs.readFileSync(path.join(SRV, 'whitelist.json'), 'utf8'));
  ok(wlFile.some((x) => (x.name || '') === 'Alex'), 'whitelist.json обновлён на диске', JSON.stringify(wlFile).slice(0, 100));

  const wlSwitch = await page.evaluate(async () => {
    const doc = document.querySelector('.addon-frame[data-addon-id="whitelist"]').contentDocument;
    doc.getElementById('on').checked = true;
    doc.getElementById('on').dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 900));
    return doc.getElementById('hint').textContent;
  });
  ok(/Белый список включён/.test(wlSwitch), 'переключатель белого списка работает', wlSwitch.slice(0, 60));
  ok(/white-list=true/.test(fs.readFileSync(path.join(SRV, 'server.properties'), 'utf8')),
    'server.properties обновлён аддоном');

  /* ─────────── 6. выключение аддона ─────────── */
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

  /* ─────────── 7. вход в GitHub: без спама ─────────── */
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
    GD.code = 'неверный-код';
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

  /* ─────────── 8. ошибки ─────────── */
  console.log('\n=== ОШИБКИ ===');
  ok(errs.length === 0, 'нет JS-ошибок', errs.join(' | '));

  await app.close();
  console.log(fails ? `\nПРОВАЛОВ: ${fails}` : '\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
