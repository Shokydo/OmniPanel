// Диагностика: какие элементы остаются скруглёнными в режиме «Квадрат».
// Запуск: xvfb-run -a node tests/diag-radius.js <pw> <electron>
const pwPath = process.argv[2] || '/tmp/bld/node_modules/playwright';
const electronPath = process.argv[3] || '/tmp/bld/node_modules/electron/dist/electron';
const { _electron: electron } = require(pwPath);
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(path.dirname(electronPath), 'OmniPanelData');
const SRV = path.join(os.tmpdir(), 'omni-diag-srv');

fs.rmSync(SRV, { recursive: true, force: true });
fs.mkdirSync(path.join(SRV, 'MythicMobs/Mobs'), { recursive: true });
fs.writeFileSync(path.join(SRV, 'MythicMobs/Mobs/A.yml'), 'A:\n  Type: ZOMBIE\n');
fs.writeFileSync(path.join(SRV, 'server.properties'), 'level-name=world\n');
fs.mkdirSync(DATA, { recursive: true });
fs.rmSync(path.join(DATA, 'panel.json'), { force: true });
fs.rmSync(path.join(DATA, 'Local Storage'), { recursive: true, force: true });
fs.writeFileSync(path.join(DATA, 'servers.json'), JSON.stringify([
  { id: 's1', name: 'Мир друзей', command: 'sleep 300', cwd: SRV, encoding: 'auto' },
]));

const SCAN = `(() => {
  const bad = new Map();
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    const v = parseFloat(cs.borderTopLeftRadius);
    if (!v || v <= 2.5) continue;
    if (!el.offsetWidth || !el.offsetHeight) continue;
    const key = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : '');
    if (!bad.has(key)) bad.set(key, Math.round(v) + 'px «' + (el.textContent || '').trim().slice(0, 24) + '»');
  }
  return [...bad.entries()];
})()`;

(async () => {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [ROOT, '--no-sandbox'],
    env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' },
    timeout: 60000,
  });
  const page = await app.firstWindow();
  await page.waitForSelector('.profile-name');
  await page.waitForTimeout(1200);
  await page.evaluate(() => { prefs.radius = 'square'; prefs.save(); applyPrefs(); });
  await page.waitForTimeout(400);

  const report = {};
  const grab = async (name) => {
    let rows = [];
    try { rows = await page.evaluate(SCAN); } catch (e) { console.log('\n=== ' + name + ' === (ошибка: ' + e.message.split('\n')[0] + ')'); return; }
    report[name] = rows;
    console.log('\n=== ' + name + ' ===');
    if (!rows.length) { console.log('  всё квадратное'); return; }
    for (const [sel, info] of rows.slice(0, 40)) console.log('  ' + sel + ' → ' + info);
    if (rows.length > 40) console.log('  … ещё ' + (rows.length - 40));
  };

  await grab('главное окно');
  for (const tab of ['files', 'perf', 'backups', 'addons', 'players', 'issues']) {
    await page.evaluate((t) => setTab(t), tab);
    await page.waitForTimeout(600);
    await grab('вкладка ' + tab);
  }
  await page.evaluate(() => { openPrefs(); });
  await page.waitForTimeout(700);
  await grab('настройки панели');
  await page.evaluate(() => {
    document.querySelector('#prefsNav .prefs-tab[data-cat="addons"]').click();
  });
  await page.waitForTimeout(500);
  await grab('настройки: аддоны');
  await page.evaluate(() => closePrefs());
  await page.evaluate(() => { setTab('console'); openModal(S.servers[0]); });
  await page.waitForTimeout(700);
  await grab('настройки сервера');
  await page.evaluate(() => closeModal());
  await page.evaluate(() => pfOpen(S.servers[0]));
  await page.waitForTimeout(800);
  await grab('server.properties');
  await page.evaluate(() => document.getElementById('propsModal').classList.add('hidden'));
  await page.evaluate(() => { document.getElementById('gridModal').classList.remove('hidden'); renderGrid(); });
  await page.waitForTimeout(500);
  await grab('карточки серверов');
  await page.evaluate(() => document.getElementById('gridModal').classList.add('hidden'));

  /* тосты, меню, диалоги — всё, что появляется поверх */
  await page.evaluate(() => {
    notify({ kind: 'ok', title: 'Проверка', text: 'Скругления' }, 'ok');
    try { toast('Ещё одно уведомление', 'ok'); } catch (e) {}
    try { showMenu({ clientX: 300, clientY: 200, preventDefault() {} }, [{ label: 'Открыть', act: () => {} }, { label: 'Удалить', danger: true, act: () => {} }]); } catch (e) {}
    try { askText({ title: 'Новый файл', text: 'Только имя', value: 'NewFile.yml', okLabel: 'Создать' }); } catch (e) {}
  });
  await page.waitForTimeout(700);
  await grab('уведомления и меню');
  await page.evaluate(() => {
    document.querySelectorAll('.modal').forEach((m) => m.classList.add('hidden'));
    document.querySelectorAll('.ctx').forEach((e) => e.remove());
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => { try { askConfirm({ title: 'Удаление', text: 'Удалить файл?', okLabel: 'Удалить' }); } catch (e) {} });
  await page.waitForTimeout(600);
  await grab('подтверждение');
  await page.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => m.classList.add('hidden')); });

  /* аддоны: их панели живут в iframe со своими стилями */
  await page.evaluate(async () => {
    await window.desktop.addonsSetEnabled('mythic-mobs', true);
    await loadAddonList();
    setTab('addon:mythic-mobs');
  });
  await page.waitForTimeout(1600);
  const addon = await page.evaluate(() => {
    const f = document.querySelector('.addon-frame[data-addon-id="mythic-mobs"]');
    if (!f || !f.contentDocument) return [];
    const bad = new Map();
    for (const el of f.contentDocument.querySelectorAll('body *')) {
      const cs = f.contentWindow.getComputedStyle(el);
      const v = parseFloat(cs.borderTopLeftRadius);
      if (!v || v <= 2.5) continue;
      if (!el.offsetWidth || !el.offsetHeight) continue;
      const key = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : '');
      if (!bad.has(key)) bad.set(key, Math.round(v) + 'px');
    }
    return [...bad.entries()];
  });
  report['аддон mythic-mobs'] = addon;

  for (const [where, rows] of Object.entries(report)) {
    console.log('\n=== ' + where + ' ===');
    if (!rows.length) { console.log('  всё квадратное'); continue; }
    for (const [sel, info] of rows.slice(0, 40)) console.log('  ' + sel + ' → ' + info);
    if (rows.length > 40) console.log('  … ещё ' + (rows.length - 40));
  }

  await app.close();
})().catch((e) => { console.error(e); process.exit(1); });
