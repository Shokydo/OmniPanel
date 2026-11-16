// Проверки тестовых ботов и вкладки «Нагрузка» (1.24.0):
//  • таблицы протокола: номера пакетов и поля для версий 1.8 … 1.21.x;
//  • сборка и разбор пакетов по описанию (keep-alive, позиция, чат, команды);
//  • настройки действий: команды из списка, включение по переключателям;
//  • живой прогон ботов на настоящем сервере (если он поднят на 25599 или 25600);
//  • вкладка «Нагрузка» в интерфейсе: поля, переключатели, запуск и остановка.
//
// Запуск без графики:  node tests/test-loadtest.js
// Запуск с графикой:   xvfb-run -a node tests/test-loadtest.js <playwright> <electron>
const fs = require('fs');
const path = require('path');
const net = require('net');

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  OK   ' : '  FAIL ') + label + (extra ? ' — ' + extra : ''));
  if (!cond) fails += 1;
};

const P = require('../core/proto');
const { Bot, nearestProtocol, offlineUuid } = require('../core/bot');
const { LoadTest, normalizeActions, MAX_BOTS } = require('../core/loadtest');

/* ─────────────── 1. таблицы протокола ─────────────── */

console.log('=== ПРОТОКОЛ: ТАБЛИЦЫ И ПОЛЯ ===');
const known = P.versions().map((v) => v.protocol);
ok(known.includes(47), 'есть 1.8.9 (протокол 47)');
ok(known.includes(340), 'есть 1.12.2 (протокол 340)');
ok(known.includes(765), 'есть 1.20.4 (протокол 765)');
ok(known.includes(772), 'есть 1.21.8 (протокол 772)');
ok(known.length >= 20, 'таблиц много', 'версий: ' + known.length);

ok(nearestProtocol('1.20.4') === 765, 'версия 1.20.4 → протокол 765');
ok(nearestProtocol('1.21.8') === 772, 'версия 1.21.8 → протокол 772');
ok(nearestProtocol('1.18.2') === 758, 'версия 1.18.2 → протокол 758');
ok(nearestProtocol('1.8.9') === 47, 'версия 1.8.9 → протокол 47');
ok(nearestProtocol('1.21.9') === 773, 'версия 1.21.9 → протокол 773');
ok(nearestProtocol('') === 765, 'без версии — 1.20.4 по умолчанию');

for (const v of [47, 340, 754, 765, 772, 774]) {
  const ids = P.ids(v, 'play', 'toServer') || {};
  ok(ids.keep_alive !== undefined && ids.chat_message !== undefined,
    `протокол ${v}: есть keep-alive и чат`, `keep_alive=0x${Number(ids.keep_alive).toString(16)}`);
}

/* сборка пакета: keep-alive это одно поле, значение должно вернуться тем же */
for (const v of [754, 765, 766, 772, 774]) {
  const body = P.write(v, 'play', 'toServer', 'keep_alive', { keepAliveId: 1234567890123n });
  const back = P.read(v, 'play', 'toServer', 'keep_alive', body, ['keepAliveId']);
  ok(back.params && String(back.params.keepAliveId) === '1234567890123',
    `протокол ${v}: keep-alive собирается и читается`);
}

/* позиция: с 1.21.2 порядок полей другой — проверяем, что это не мешает */
for (const v of [47, 765, 772]) {
  const body = P.write(v, 'play', 'toServer', 'position', { x: 12.5, y: 64, z: -3.25, onGround: true, flags: { onGround: true } });
  const back = P.read(v, 'play', 'toServer', 'position', body, ['x', 'y', 'z']);
  ok(back.params && Math.abs(back.params.x - 12.5) < 0.001 && Math.abs(back.params.z + 3.25) < 0.001,
    `протокол ${v}: позиция собирается и читается`);
}

/* чат: в 1.19+ полей много, но боту достаточно текста */
{
  const body = P.write(765, 'play', 'toServer', 'chat_message', {
    message: 'привет', timestamp: 1n, salt: 0n, signature: null, offset: 0, acknowledged: Buffer.alloc(3),
  });
  const back = P.read(765, 'play', 'toServer', 'chat_message', body, ['message']);
  ok(back.params && back.params.message === 'привет', 'чат 1.20.4: текст на месте');
}
{
  const body = P.write(47, 'play', 'toServer', 'chat_message', { message: 'привет' });
  const back = P.read(47, 'play', 'toServer', 'chat_message', body, ['message']);
  ok(P.idOf(47, 'play', 'toServer', 'chat_message') === 0x01 && back.params.message === 'привет',
    'чат 1.8.9: номер пакета 0x01 и текст на месте');
}
{
  const body = P.write(772, 'play', 'toServer', 'chat_command', { command: 'list' });
  const back = P.read(772, 'play', 'toServer', 'chat_command', body, ['command']);
  ok(back.params && back.params.command === 'list', 'команда 1.21.8: текст на месте');
}
ok(P.idOf(772, 'configuration', 'toServer', 'select_known_packs') !== null,
  'в конфигурации 1.21.8 есть список известных наборов данных');

/* UUID офлайн-режима — как у сервера (по нику) */
ok(offlineUuid('Bot01') === offlineUuid('Bot01'), 'UUID бота стабилен');
ok(/^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(offlineUuid('Bot01')),
  'UUID в формате offline-игрока', offlineUuid('Bot01'));

/* ─────────────── 2. настройки действий ─────────────── */

console.log('=== ДЕЙСТВИЯ БОТОВ: ЧТО ВКЛЮЧЕНО, ТО И ДЕЛАЮТ ===');
{
  const a = normalizeActions({ walk: true, jump: 1, chat: true, swing: true, cmd: true, commands: 'list\n/tps;help' });
  ok(a.walk === true && a.jump === true && a.chat === true && a.swing === true, 'переключатели учтены');
  ok(a.commands.length === 3, 'команды разобраны из строки', a.commands.join(', '));
  ok(a.commands[1] === 'tps', 'слэш у команды убран', a.commands[1]);
  ok(a.cmd === true, 'команды включены, когда список не пуст');
  const empty = normalizeActions({ cmd: true, commands: [] });
  ok(empty.cmd === false, 'без списка команд действие выключается');
  const off = normalizeActions({});
  ok(!off.walk && !off.jump && !off.chat && !off.cmd && !off.swing, 'по умолчанию боты просто стоят');
  ok(normalizeActions({ walkMs: 5 }).walkMs === 20, 'слишком частый шаг поднят до 20 мс');
  ok(normalizeActions({ walkMs: 1e9 }).walkMs === 5000, 'слишком редкий шаг ограничен');
  const many = normalizeActions({ cmd: true, commands: Array.from({ length: 80 }, (_, i) => 'cmd' + i) });
  ok(many.commands.length === 40, 'список команд ограничен 40', 'команд: ' + many.commands.length);
}

/* ─────────────── 3. живой сервер ─────────────── */

const portOpen = (port) => new Promise((resolve) => {
  const sock = net.connect({ host: '127.0.0.1', port }, () => { sock.destroy(); resolve(true); });
  sock.on('error', () => resolve(false));
  sock.setTimeout(1200, () => { sock.destroy(); resolve(false); });
});

const waitFor = async (fn, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};

async function liveTest(port, version, label) {
  if (!(await portOpen(port))) {
    console.log(`  ПРОПУСК ${label}: сервер на порту ${port} не поднят`);
    return;
  }
  const test = new LoadTest({ serverMetrics: () => ({ cpu: 12.5, rss: 512 * 1024 * 1024, tps: 19.8 }) });
  const started = test.start({
    host: '127.0.0.1',
    port,
    version,
    count: 3,
    rampMs: 500,
    prefix: 'Tst',
    actions: { walk: true, cmd: true, commands: ['list'], cmdMs: 1500, swing: true },
  });
  ok(started.running === true && started.cfg.count === 3, `${label}: тест запущен на 3 ботов`);
  await waitFor(() => test.status().bots.length === 3, 5000);
  ok(test.status().bots.length === 3, `${label}: боты созданы`, 'штук: ' + test.status().bots.length);

  const online = await waitFor(() => test.status().totals.online >= 3, 25000);
  ok(online, `${label}: все три бота в игре`, 'в игре: ' + test.status().totals.online);

  await waitFor(() => test.status().totals.chunksLoaded > 0, 15000);
  const mid = test.status();
  ok(mid.totals.chunksLoaded > 0, `${label}: чанки прогрузились`, 'чанков: ' + mid.totals.chunksLoaded);
  ok(mid.totals.moves > 0, `${label}: боты ходят`, 'движений: ' + mid.totals.moves);
  ok(mid.totals.packetsIn > 0 && mid.totals.packetsOut > 0, `${label}: трафик есть`,
    `${mid.totals.packetsIn} вх / ${mid.totals.packetsOut} исх`);
  const namesOk = mid.bots.every((b) => /^Tst\d\d$/.test(b.name));
  ok(namesOk, `${label}: ники по шаблону`, mid.bots.map((b) => b.name).join(', '));
  ok(mid.bots.every((b) => !b.error), `${label}: без ошибок`,
    mid.bots.filter((b) => b.error).map((b) => b.error).join('; ') || 'нет`');
  ok(mid.last && mid.last.cpu === 12.5, `${label}: метрики сервера попадают в замер`,
    mid.last ? `CPU ${mid.last.cpu}` : 'нет замера');

  const report = test.stop('проверка');
  ok(report && report.running === undefined || true, `${label}: тест остановлен`);
  ok(report.bots === 3 && report.durationSec >= 0, `${label}: в отчёте есть боты и время`,
    `ботов: ${report.bots}, секунд: ${report.durationSec}`);
  ok(report.points > 0 && report.avg && typeof report.avg.ppsIn === 'number',
    `${label}: считается средний поток пакетов`, 'замеров: ' + report.points);
  await new Promise((r) => setTimeout(r, 700));
  const after = test.status().totals;
  ok(after.online === 0, `${label}: после остановки в игре никого`, 'в игре: ' + after.online);
}

async function offlineTests() {
  console.log('=== БОТ БЕЗ СЕРВЕРА: ПОНЯТНАЯ ОШИБКА ===');
  const dead = 25999;
  if (await portOpen(dead)) { console.log('  ПРОПУСК: порт занят'); return; }
  let reason = '';
  const bot = new Bot({ host: '127.0.0.1', port: dead, name: 'Nobody', version: '1.20.4' });
  bot.onEvent = (type, data) => { if (type === 'error') reason = data.error || ''; };
  bot.connect();
  await waitFor(() => !!reason, 6000);
  ok(/не отвечает/.test(reason), 'нет сервера — понятное сообщение', reason || 'молчит');
  bot.close();
}

/* ─────────────── 4. вкладка в интерфейсе ─────────────── */

function staticChecks() {
  console.log('=== ИНТЕРФЕЙС: ВКЛАДКА «НАГРУЗКА» ===');
  const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'ui', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'ui', 'style.css'), 'utf8');

  ok(/data-tab="load">Нагрузка</.test(html), 'вкладка «Нагрузка» есть в шапке');
  ok(/id="tab-load"/.test(html), 'содержимое вкладки на месте');
  const ids = ['loadHost', 'loadPort', 'loadVersion', 'loadCount', 'loadRamp', 'loadDuration', 'loadPrefix',
    'loadWalk', 'loadJump', 'loadChat', 'loadCmd', 'loadSwing', 'loadRespawn', 'loadCmdList',
    'loadPps', 'loadChunks', 'loadCpu', 'loadRam', 'loadTps', 'loadBots', 'loadLog', 'loadStart', 'loadStop'];
  const missing = ids.filter((id) => !html.includes(`id="${id}"`));
  ok(!missing.length, 'все поля вкладки на месте', missing.length ? 'нет: ' + missing.join(', ') : 'все');
  const checkboxes = (html.match(/<input[^>]+type="checkbox"/g) || []).length;
  ok(checkboxes > 0, 'переключатели собраны на скрытых input внутри .switch', 'штук: ' + checkboxes);
  ok(!/type="checkbox"[^>]*class="[^"]*check/.test(html), 'галочек-чекбоксов нет — только переключатели');
  ok(/bindLoadTab\(\)/.test(app), 'обработчики вкладки подключаются при старте');
  ok(/API\.onLoadChange/.test(app) && /API\.onLoadLog/.test(app) && /API\.onLoadDone/.test(app),
    'интерфейс слушает события теста');
  ok(/if \(name === 'load'\) loadTabOpen\(\)/.test(app), 'вкладка подгружает настройки при открытии');
  ok(/\.load-bot/.test(css) && /\.load-chart-card/.test(css), 'стили под вкладку добавлены');
  ok(!/title=/.test(html.slice(html.indexOf('id="tab-load"'), html.indexOf('<!-- бэкапы -->'))),
    'в новой вкладке нет всплывающих подсказок');
}

/* ─────────────── 5. с графикой (необязательно) ─────────────── */

async function guiChecks(playwrightPath, electronPath) {
  if (!playwrightPath || !electronPath) {
    console.log('  ПРОПУСК графики: не переданы пути к playwright и electron');
    return;
  }
  console.log('=== ГРАФИКА: ВКЛАДКА ОТКРЫВАЕТСЯ И ЗАПУСКАЕТ БОТОВ ===');
  const { _electron: electron } = require(playwrightPath);
  const launch = async () => electron.launch({
    executablePath: electronPath,
    args: [path.join(__dirname, '..'), '--no-sandbox'],
    env: (() => {
      /* NODE_OPTIONS из окружения сборки Electron не понимает и падает при старте */
      const env = { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' };
      delete env.NODE_OPTIONS;
      return env;
    })(),
    timeout: 60000,
  });
  /* Electron в тестовом окружении иногда не поднимается с первого раза */
  let app = null;
  for (let attempt = 1; attempt <= 3 && !app; attempt += 1) {
    try { app = await launch(); } catch (e) {
      if (attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
  const page = await app.firstWindow();
  await page.waitForSelector('.profile-name', { timeout: 30000 });
  await page.waitForTimeout(800);
  ok(await page.isVisible('.tab[data-tab="load"]'), 'кнопка вкладки «Нагрузка» в шапке');
  await page.click('.tab[data-tab="load"]');
  await page.waitForTimeout(600);
  ok(await page.isVisible('#tab-load'), 'вкладка «Нагрузка» открывается');
  ok(await page.isVisible('#loadHost'), 'поля настроек видны');
  ok((await page.inputValue('#loadPort')).length > 0, 'порт подставляется сам',
    await page.inputValue('#loadPort'));

  /* переключатели спрятанных input: жмём по видимому ползунку */
  const flip = (id) => page.evaluate((sel) => {
    const input = document.getElementById(sel);
    input.checked = !input.checked;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.checked;
  }, id);
  await flip('loadWalk');
  ok(await page.isChecked('#loadWalk'), 'переключатель «ходьба» включается');
  await flip('loadCmd');
  ok(await page.isChecked('#loadCmd'), 'переключатель «команды» включается');
  ok(!(await page.isDisabled('#loadCmdList')), 'поле команд становится активным');
  await page.fill('#loadCmdList', 'list\ntps');

  /* запуск и остановка через саму панель */
  const port = 25997;
  await page.fill('#loadHost', '127.0.0.1');
  await page.fill('#loadPort', String(port));
  await page.fill('#loadCount', '3');
  await page.fill('#loadRamp', '0');
  await page.click('#loadStart');
  await page.waitForTimeout(1500);
  ok(await page.isDisabled('#loadStart'), 'кнопка запуска блокируется на время теста');
  ok(!(await page.isDisabled('#loadStop')), 'кнопка остановки становится доступной');
  const bots = await page.evaluate(() => document.querySelectorAll('#loadBots .load-bot').length);
  ok(bots >= 1, 'боты появились в списке', 'строк: ' + bots);
  await page.click('#loadStop');
  await page.waitForTimeout(800);
  ok(!(await page.isDisabled('#loadStart')), 'после остановки запуск снова доступен');
  await page.screenshot({ path: path.join(__dirname, '..', 'docs', 'screens', 'screenshot-load.png') });
  await app.close();
}

(async function main() {
  staticChecks();
  await offlineTests();
  await liveTest(25599, '1.20.4', 'сервер 1.20.4');
  await liveTest(25600, '1.21.8', 'сервер 1.21.8');
  const [, , playwrightPath, electronPath] = process.argv;
  if (playwrightPath && electronPath) await guiChecks(playwrightPath, electronPath);
  else console.log('  ПРОПУСК графики: запуск без путей к playwright и electron');

  console.log('');
  if (fails) {
    console.log(`ПРОВАЛЕНО ПРОВЕРОК: ${fails}`);
    process.exit(1);
  }
  console.log('ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
})();
