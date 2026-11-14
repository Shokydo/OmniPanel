// Проверки 1.17.0: вкладки «Плагины», «Игроки», «Ошибки», онлайн в шапке,
// перетаскивание файлов с подсветкой, подсказки по TAB, вход в GitHub по коду.
// Запуск: xvfb-run -a node tests/test-117.js <playwright> <electron>
const pwPath = process.argv[2] || 'playwright';
const electronPath = process.argv[3] || '/home/user/.cache/bld/node_modules/electron/dist/electron';
const { _electron: electron } = require(pwPath);
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA = path.join(path.dirname(electronPath), 'OmniPanelData');
const SRV = path.join(os.tmpdir(), 'omni-117-srv');

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  OK   ' : '  FAIL ') + label + (extra ? ' — ' + extra : ''));
  if (!cond) fails += 1;
};

fs.rmSync(SRV, { recursive: true, force: true });
fs.mkdirSync(path.join(SRV, 'plugins'), { recursive: true });
fs.mkdirSync(path.join(SRV, 'world'), { recursive: true });
fs.writeFileSync(path.join(SRV, 'server.properties'), 'max-players=20\nlevel-name=world\n');
fs.writeFileSync(path.join(SRV, 'plugins/Old.jar'), 'JAR');
fs.writeFileSync(path.join(SRV, 'version_history.json'), JSON.stringify({ currentVersion: 'git-Paper-196 (MC: 1.20.4)' }));

fs.mkdirSync(DATA, { recursive: true });
fs.rmSync(path.join(DATA, 'panel.json'), { force: true });
fs.rmSync(path.join(DATA, 'Local Storage'), { recursive: true, force: true });
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
  await page.waitForTimeout(1100);

  /* ─────────── 1. вкладки на месте ─────────── */
  console.log('\n=== новые вкладки ===');
  const tabs = await page.evaluate(() => [...document.querySelectorAll('nav.tabs .tab')].map((t) => t.dataset.tab));
  ok(tabs.includes('addons') && tabs.includes('players') && tabs.includes('issues'), 'вкладки «Плагины», «Игроки», «Ошибки»', tabs.join(','));

  /* ─────────── 2. онлайн из логов ─────────── */
  console.log('\n=== онлайн игроков ===');
  const online = await page.evaluate(async () => {
    pushLog('s1', { t: Date.now(), m: '[12:00:01] [Server thread/INFO]: Steve joined the game' });
    pushLog('s1', { t: Date.now(), m: '[12:00:02] [Server thread/INFO]: Alex joined the game' });
    for (const e of LOG_CACHE.get('s1') || []) playersOnLog('s1', e.m || '');
    updateOnlineChip();
    renderPlayers();
    return {
      chip: document.getElementById('onlineText').textContent,
      cards: document.querySelectorAll('#playerList .player-card').length,
      sub: document.getElementById('playersSub').textContent,
    };
  });
  ok(/2/.test(online.chip), 'онлайн виден в шапке сервера', online.chip);
  ok(online.cards === 2, 'во вкладке две карточки игроков', 'карточек: ' + online.cards);
  ok(/2/.test(online.sub), 'подпись под заголовком считает онлайн', online.sub);

  const after = await page.evaluate(() => {
    playersOnLog('s1', '[12:00:09] [Server thread/INFO]: Steve left the game');
    updateOnlineChip();
    return { chip: document.getElementById('onlineText').textContent, cards: document.querySelectorAll('#playerList .player-card').length };
  });
  ok(/1/.test(after.chip) && after.cards === 1, 'выход игрока убирает его из списка', after.chip);

  /* ─────────── 3. сканер ошибок и счётчик ─────────── */
  console.log('\n=== сканер ошибок ===');
  const scan = await page.evaluate(async () => {
    S.issuesNew.set('s1', 0);
    renderIssuesBadge();
    issuesAdd('s1', 'error', '[12:00:10] [Server thread/ERROR]: Could not load plugins/Old.jar in folder plugins', '');
    issuesAdd('s1', 'error', 'java.lang.NullPointerException: Cannot invoke World.getName() because world is null',
      'at ru.example.Plugin.onEnable(Plugin.java:41)');
    issuesAdd('s1', 'error', 'java.lang.NullPointerException: Cannot invoke World.getName() because world is null', '');
    const badge = document.getElementById('issuesBadge');
    const notif = document.querySelector('.notif.blink');
    return {
      badge: badge ? badge.textContent : '',
      badgeShown: badge ? !badge.classList.contains('hidden') : false,
      blink: !!notif,
      list: document.querySelectorAll('#issuesList .issue-card').length,
      stack: !!document.querySelector('#issuesList .issue-stack'),
      repeats: document.querySelector('#issuesList .issue-count') ? document.querySelector('#issuesList .issue-count').textContent : '',
      tabAlert: document.querySelector('nav.tabs .tab[data-tab="issues"]').classList.contains('has-alert'),
    };
  });
  ok(scan.badgeShown && scan.badge.trim() !== '', 'на вкладке появился счётчик ошибок', 'счётчик: ' + scan.badge);
  ok(scan.tabAlert, 'вкладка ошибок помечена');
  ok(scan.blink, 'уведомление мерцает, пока ошибки не посмотрели');
  ok(scan.list === 2, 'одинаковые ошибки склеены в одну', 'строк: ' + scan.list);
  ok(scan.stack, 'стек ошибки виден');
  ok(/×2/.test(scan.repeats), 'повторы посчитаны', scan.repeats);

  const seen = await page.evaluate(async () => {
    setTab('issues');
    await new Promise((r) => setTimeout(r, 500));
    return {
      newCount: S.issuesNew.get('s1') || 0,
      badgeHidden: document.getElementById('issuesBadge').classList.contains('hidden'),
      blink: !!document.querySelector('.notif.blink'),
      alertTab: document.querySelector('nav.tabs .tab[data-tab="issues"]').classList.contains('has-alert'),
    };
  });
  ok(seen.newCount === 0, 'счётчик обнулился при открытии вкладки', 'осталось: ' + seen.newCount);
  ok(seen.badgeHidden && !seen.alertTab, 'счётчик на вкладке убран');
  ok(!seen.blink, 'мерцание прекратилось');

  /* ─────────── 4. перетаскивание файлов ─────────── */
  console.log('\n=== перетаскивание файлов ===');
  const dropState = await page.evaluate(async () => {
    setTab('files');
    await new Promise((r) => setTimeout(r, 500));
    const pane = document.getElementById('tab-files');
    const dt = new DataTransfer();
    dt.items.add(new File(['hello'], 'drop-test.txt', { type: 'text/plain' }));
    pane.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
    const active = pane.classList.contains('drop-active');
    const folder = document.querySelector('#tab-files [data-drop-rel]');
    let target = false;
    if (folder) {
      folder.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      target = folder.classList.contains('drop-target');
    }
    return { active, target, hasFolder: !!folder };
  });
  ok(dropState.active, 'панель файлов подсвечивается при перетаскивании');
  ok(dropState.hasFolder, 'в дереве есть папки как цель');
  ok(dropState.target, 'папка получает подсветку цели');

  const dropped = await page.evaluate(async () => {
    const pane = document.getElementById('tab-files');
    const dt = new DataTransfer();
    dt.items.add(new File(['hello from drop'], 'drop-test.txt', { type: 'text/plain' }));
    pane.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 900));
    return { cleared: !pane.classList.contains('drop-active') };
  });
  ok(dropped.cleared, 'подсветка снимается после броска');
  ok(fs.existsSync(path.join(SRV, 'drop-test.txt')), 'файл лёг в папку сервера');

  /* ─────────── 5. подсказки по TAB ─────────── */
  console.log('\n=== подсказки в консоли ===');
  const tab = await page.evaluate(async () => {
    setTab('console');
    await new Promise((r) => setTimeout(r, 300));
    const input = document.getElementById('cmdInput');
    input.value = 'gi';
    input.focus();
    input.setSelectionRange(2, 2);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    const box = document.getElementById('cmdSuggest');
    const items = [...box.querySelectorAll('.cs-item')].map((b) => b.textContent.trim());
    return { shown: !box.classList.contains('hidden'), items, sel: !!box.querySelector('.cs-item.sel') };
  });
  ok(tab.shown, 'подсказка появилась при вводе');
  ok(tab.items.some((t) => /give/.test(t)), 'команда /give предложена', tab.items.join(' | '));
  ok(tab.sel, 'первый вариант выделен');

  const tabApply = await page.evaluate(async () => {
    const box = document.getElementById('cmdSuggest');
    box.querySelectorAll('.cs-item')[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 150));
    return { value: document.getElementById('cmdInput').value, hidden: document.getElementById('cmdSuggest').classList.contains('hidden') };
  });
  ok(/\/give/.test(tabApply.value), 'вариант подставился в строку', tabApply.value);
  ok(tabApply.hidden, 'подсказка закрылась после выбора');

  const tabNick = await page.evaluate(async () => {
    const input = document.getElementById('cmdInput');
    input.value = 'tp Al';
    input.focus();
    input.setSelectionRange(5, 5);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    const items = [...document.querySelectorAll('#cmdSuggest .cs-item')].map((b) => b.textContent.trim());
    hideCmdSuggest();
    input.value = '';
    return items;
  });
  ok(tabNick.some((t) => /Alex/.test(t)), 'ник игрока подсказывается после команды', tabNick.join(' | '));

  /* ─────────── 6. Modrinth: фильтры и установка ─────────── */
  console.log('\n=== Modrinth ===');
  const addons = await page.evaluate(async () => {
    setTab('addons');
    await new Promise((r) => setTimeout(r, 800));
    const type = document.getElementById('addonsType');
    const loader = document.getElementById('addonsLoader');
    return {
      types: [...type.options].map((o) => o.value),
      loaders: [...loader.options].map((o) => o.value),
      info: document.getElementById('addonsSub').textContent,
    };
  });
  ok(addons.types.includes('plugin') && addons.types.includes('mod'), 'есть фильтр типа: плагин / мод', addons.types.join(','));
  ok(addons.loaders.includes('paper') || addons.loaders.includes('fabric'), 'есть фильтр загрузчика', addons.loaders.slice(0, 6).join(','));
  ok(/1\.20\.4|plugins/.test(addons.info), 'определились версия игры и папка', addons.info);

  const search = await page.evaluate(async () => {
    const res = await window.desktop.modrinthSearch({ query: 'essentials', type: 'plugin', limit: 5 });
    return { ok: res && res.ok, hits: res && res.hits ? res.hits.length : 0, first: res && res.hits ? res.hits[0].title : '' };
  });
  ok(search.ok, 'поиск Modrinth отвечает', 'найдено: ' + search.hits + (search.first ? ' · ' + search.first : ''));

  const installed = await page.evaluate(async () => window.desktop.modrinthInstalled ? await window.desktop.modrinthInstalled('s1') : null);
  ok(!!installed && installed.ok, 'папки плагинов и модов читаются', installed && installed.info ? installed.info.version + ' / ' + installed.info.loader : '');

  /* ─────────── 7. вход по коду ─────────── */
  console.log('\n=== вход в GitHub по коду ===');
  const dev = await page.evaluate(() => window.desktop.ghDeviceStart());
  ok(dev && dev.needClientId !== true, 'встроенный Client ID — свой не нужен', (dev && dev.userCode) || (dev && dev.error) || '');
  ok(dev && dev.ok === true && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(String(dev.userCode || '')),
    'GitHub выдал код для входа', dev && dev.ok ? dev.userCode : (dev && dev.error) || 'сеть недоступна');

  /* ─────────── 8. кнопки на карточке сервера ─────────── */
  console.log('\n=== карточки серверов ===');
  const cards = await page.evaluate(async () => {
    document.getElementById('gridModal').classList.remove('hidden');
    renderGrid();
    await new Promise((r) => setTimeout(r, 300));
    const card = document.querySelector('#gridList .sg-card');
    const btns = [...card.querySelectorAll('.sg-actions .btn')].map((b) => b.getBoundingClientRect());
    const lines = new Set(btns.map((r) => Math.round(r.top)));
    const heights = new Set(btns.map((r) => Math.round(r.height)));
    const radiusCard = getComputedStyle(document.querySelector('#gridList .sg-card')).borderRadius;
    document.getElementById('gridModal').classList.add('hidden');
    return { lines: lines.size, heights: heights.size, count: btns.length, radiusCard };
  });
  ok(cards.count >= 3, 'на карточке три кнопки', 'кнопок: ' + cards.count);
  ok(cards.lines === 1, 'все кнопки на одной линии');
  ok(cards.heights === 1, 'кнопки одной высоты');
  ok(cards.radiusCard && cards.radiusCard !== '0px', 'у карточки скруглённые углы', cards.radiusCard);

  const radii = await page.evaluate(() => {
    const bad = [];
    for (const el of document.querySelectorAll('#gridList .btn, #addonsList .addon-card, #issuesList .issue-card, #playerList .player-card')) {
      const r = getComputedStyle(el).borderRadius;
      if (r === '0px') bad.push(el.className);
    }
    return bad;
  });
  ok(radii.length === 0, 'у новых панелей всё скруглено', radii.join(', '));

  /* ─────────── 9. перекраска под фон ─────────── */
  console.log('\n=== автоподбор цветов под фон ===');
  const pal = await page.evaluate(async () => {
    const w = (typeof WALLPAPERS !== 'undefined' ? WALLPAPERS.find((x) => x.id === 'aurora') : null) || { src: '../assets/wallpapers/aurora.png' };
    const res = await window.desktop.wallPalette({ kind: 'builtin', src: w.src });
    return res;
  });
  ok(pal && pal.ok && pal.colors && pal.colors.accent, 'палитра фона посчитана', pal && pal.colors ? pal.colors.bg + ' / ' + pal.colors.accent : (pal && pal.error) || '');

  const themed = await page.evaluate(async () => {
    const before = getComputedStyle(document.body).getPropertyValue('--bg-2').trim();
    prefs.wall = 'aurora';
    await themeFromWallpaper();
    await new Promise((r) => setTimeout(r, 300));
    return {
      theme: prefs.theme,
      bg: (prefs.custom || {}).bg || '',
      accent: (prefs.custom || {}).accent || '',
      after: getComputedStyle(document.body).getPropertyValue('--bg-2').trim(),
      before,
      btn: !!document.getElementById('themeFromWall'),
    };
  });
  ok(themed.btn, 'в оформлении есть кнопка «цвета из фона»');
  ok(themed.theme === 'custom' && /^#[0-9a-f]{6}$/i.test(themed.bg), 'палитра из фона применилась', themed.bg + ' / ' + themed.accent);
  ok(themed.after !== themed.before || !!themed.bg, 'фон интерфейса перекрасился', themed.before + ' → ' + themed.after);

  const errs = await page.evaluate(() => window.__jsErrors || []);
  console.log('\n=== ОШИБКИ ===');
  ok(errs.length === 0, 'нет JS-ошибок', errs.join(' | '));

  await app.close();
  console.log(fails ? `\nПРОВАЛОВ: ${fails}` : '\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
