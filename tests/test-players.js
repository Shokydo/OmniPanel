// Проверки нового прохода 1.22.0 без графики и с графикой:
//  • блокировки: чтение banned-players.json / banned-ips.json, разбан правкой файла и командой;
//  • «своё окно» вместо системного диалога: main спрашивает — интерфейс отвечает;
//  • вкладка «Игроки»: кнопки режима игры, инвентаря, убийства и бана;
//  • вкладка «Блокировки»: строки с ником, UUID и IP, кнопка «Разбанить»;
//  • TPS-график показывает первую точку сразу, а не «данных пока нет».
//
// Запуск без графики:     node tests/test-players.js
// Запуск с графикой:      xvfb-run -a node tests/test-players.js <playwright> <electron>
const path = require('path');
const fs = require('fs');
const os = require('os');

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  OK   ' : '  FAIL ') + label + (extra ? ' — ' + extra : ''));
  if (!cond) fails += 1;
};

const players = require('../core/players');

/* ─────────────── 1. блокировки без графики ─────────────── */

console.log('=== БЛОКИРОВКИ: ЧТЕНИЕ ФАЙЛОВ СЕРВЕРА ===');
const SRV = path.join(os.tmpdir(), 'omni-bans-srv');
fs.rmSync(SRV, { recursive: true, force: true });
fs.mkdirSync(SRV, { recursive: true });
fs.writeFileSync(path.join(SRV, 'banned-players.json'), JSON.stringify([
  { uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5', name: 'Notch', created: '2026-11-01 10:00:00 +0000', source: 'Server', expires: 'forever', reason: 'взлом мира' },
  { uuid: '853c80ef-3c37-49fd-aa99-762f914c1d2a', name: 'Steve', created: '2026-11-02 10:00:00 +0000', source: 'Admin', expires: '2026-12-01 00:00:00 +0000', reason: 'читы' },
]));
fs.writeFileSync(path.join(SRV, 'banned-ips.json'), JSON.stringify([
  { ip: '203.0.113.7', created: '2026-11-03 09:00:00 +0000', source: 'Server', expires: 'forever', reason: 'флуд' },
]));

const bans = players.listBans(SRV);
ok(bans.players.length === 2, 'игроки прочитаны', 'строк: ' + bans.players.length);
ok(bans.players[0].name === 'Notch', 'ник на месте', bans.players[0].name);
ok(/^[0-9a-f-]{36}$/.test(bans.players[0].uuid), 'uuid на месте', bans.players[0].uuid);
ok(bans.players[0].until === 'навсегда', 'срок «навсегда» понятен человеку', bans.players[0].until);
ok(/^до /.test(bans.players[1].until), 'временный бан показывает дату', bans.players[1].until);
ok(bans.players[0].reason === 'взлом мира', 'причина прочитана', bans.players[0].reason);
ok(bans.ips.length === 1 && bans.ips[0].ip === '203.0.113.7', 'IP-блокировка прочитана', JSON.stringify(bans.ips[0]));

console.log('\n=== БЛОКИРОВКИ: РАЗБАН НА ОСТАНОВЛЕННОМ СЕРВЕРЕ ===');
const un = players.unbanOffline(SRV, { name: 'notch' });
ok(un.ok && un.removed === 1, 'бан снят по нику без учёта регистра', JSON.stringify(un));
ok(players.listBans(SRV).players.length === 1, 'остался один игрок');
const unIp = players.unbanOffline(SRV, { ip: '203.0.113.7' });
ok(unIp.ok, 'IP-блокировка снята');
ok(players.listBans(SRV).ips.length === 0, 'IP-список пуст');
const again = players.unbanOffline(SRV, { name: 'Notch' });
ok(again.ok === false && /не числится/.test(again.error), 'повторный разбан — понятная ошибка', again.error);

console.log('\n=== БЛОКИРОВКИ: КОМАНДЫ ===');
ok(players.unbanCommand({ name: 'Steve' }) === 'unban Steve', 'для ника — unban');
ok(players.unbanCommand({ ip: '1.2.3.4' }) === 'pardon-ip 1.2.3.4', 'для IP — pardon-ip');
ok(players.listBans(path.join(os.tmpdir(), 'нет-такой-папки')).players.length === 0,
  'нет файлов — пустой список, без падения');

/* ─────────────── 2. графическая часть ─────────────── */

const pwPath = process.argv[2];
const electronPath = process.argv[3];
if (!pwPath || !electronPath) {
  console.log('\n(графическую часть пропускаю: не переданы playwright и electron)');
  console.log(fails ? `\nПРОВАЛОВ: ${fails}` : '\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
  process.exit(fails ? 1 : 0);
}

const { _electron: electron } = require(pwPath);
const { makeServer } = require('./mock-gh');
const DATA = path.join(path.dirname(electronPath), 'OmniPanelData');

fs.mkdirSync(DATA, { recursive: true });
fs.rmSync(path.join(DATA, 'panel.json'), { force: true });
fs.rmSync(path.join(DATA, 'Local Storage'), { recursive: true, force: true });
/* файлы блокировок — заново: выше мы их уже частично разбанили */
fs.writeFileSync(path.join(SRV, 'banned-players.json'), JSON.stringify([
  { uuid: '853c80ef-3c37-49fd-aa99-762f914c1d2a', name: 'Steve', created: '2026-11-02 10:00:00 +0000', source: 'Admin', expires: 'forever', reason: 'читы' },
]));
fs.writeFileSync(path.join(SRV, 'banned-ips.json'), JSON.stringify([
  { ip: '203.0.113.7', created: '2026-11-03 09:00:00 +0000', source: 'Server', expires: 'forever', reason: 'флуд' },
]));

/* сервер для проверки команд: `cat` возвращает всё, что панель пишет в консоль,
   поэтому отправленные команды видно в живом логе — без заглушек в интерфейсе */
fs.writeFileSync(path.join(DATA, 'servers.json'), JSON.stringify([
  {
    id: 'p1', name: 'Мир', command: 'cat', cwd: SRV,
    stopCommand: '', encoding: 'utf8', tpsCommand: '', tpsInterval: 10,
  },
]));

const mock = makeServer('o/r');

(async () => {
  await new Promise((r) => mock.listen(8796, '127.0.0.1', r));
  const app = await electron.launch({
    executablePath: electronPath,
    args: ['/home/user/OmniPanel', '--no-sandbox'],
    env: {
      ...process.env,
      ELECTRON_DISABLE_SANDBOX: '1',
      OMNI_GITHUB_API: 'http://127.0.0.1:8796',
      OMNI_GITHUB_RAW: 'http://127.0.0.1:8796',
    },
    timeout: 60000,
  });
  const page = await app.firstWindow();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.waitForSelector('.profile-name');
  await page.waitForTimeout(600);

  console.log('\n=== ВКЛАДКА «БЛОКИРОВКИ» ===');
  await page.click('.tab[data-tab="bans"]');
  await page.waitForTimeout(600);
  const rows = await page.$$eval('#bansList .ban-row', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ')));
  ok(rows.length === 2, 'две строки: игрок и IP', 'строк: ' + rows.length);
  ok(rows.some((t) => /Steve/.test(t)), 'ник виден');
  ok(rows.some((t) => /853c80ef-3c37-49fd-aa99-762f914c1d2a/.test(t)), 'uuid виден');
  ok(rows.some((t) => /203\.0\.113\.7/.test(t)), 'IP виден');
  ok(await page.$eval('#bansBadge', (e) => e.textContent === '2' && !e.classList.contains('hidden')),
    'на вкладке видно число блокировок');

  await page.click('#bansList .ban-row .ban-un');
  await page.waitForTimeout(400);
  await page.click('#cfOk');
  await page.waitForTimeout(900);
  const left = await page.$$eval('#bansList .ban-row', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ')));
  ok(left.length === 1 && left[0].includes('203.0.113.7'), 'разбан убрал строку игрока', 'строк: ' + left.length);
  const file = JSON.parse(fs.readFileSync(path.join(SRV, 'banned-players.json'), 'utf8'));
  ok(file.length === 0, 'файл блокировок очищен', 'записей: ' + file.length);

  console.log('\n=== ВКЛАДКА «ИГРОКИ»: КНОПКИ ===');
  await page.evaluate(() => window.desktop.start('p1'));
  for (let i = 0; i < 40; i += 1) {
    const st = await page.evaluate(async () => (await window.desktop.list()).find((x) => x.id === 'p1'));
    if (st && st.state === 'running') break;
    await page.waitForTimeout(150);
  }
  ok(true, 'сервер-эхо запущен для проверки команд');

  await page.click('.tab[data-tab="players"]');
  await page.waitForTimeout(300);
  /* подставляем игрока, как будто сервер ответил на list */
  await page.evaluate(() => playersSet(S.currentId, ['Alex'], 20));
  await page.waitForTimeout(300);

  const buttons = await page.$$eval('#playerList .player-card .pl-btn', (els) => els.map((e) => e.innerText.trim()));
  ok(buttons.length === 4, 'у игрока четыре кнопки', buttons.join(' | '));
  const modes = await page.$$eval('#playerList .pl-mode option', (els) => els.map((e) => e.textContent));
  ok(modes.length === 4, 'четыре режима игры на выбор', modes.join(', '));

  await page.selectOption('#playerList .pl-mode', 'creative');
  await page.waitForTimeout(250);
  await page.click('#playerList [data-act="clear"]');
  await page.waitForTimeout(250);
  await page.click('#playerList [data-act="kill"]');
  await page.waitForTimeout(250);

  await page.click('#playerList [data-act="ban"]');
  await page.waitForTimeout(400);
  const banModal = await page.$eval('#textModal', (e) => !e.classList.contains('hidden'));
  ok(banModal, 'бан спрашивает причину своим окном, а не системным');
  await page.fill('#txInput', 'читы');
  await page.click('#txOk');
  await page.waitForTimeout(600);

  const live = await page.evaluate(() => document.getElementById('console').innerText);
  ok(/gamemode creative Alex/.test(live), 'режим игры ушёл командой gamemode', live.split('\n').filter((l) => /gamemode/.test(l)).join(' '));
  ok(/clear Alex/.test(live), 'инвентарь чистится командой clear');
  ok(/kill Alex/.test(live), 'убить — командой kill');
  ok(/ban Alex читы/.test(live), 'бан ушёл командой с причиной');
  await page.evaluate(() => window.desktop.stop('p1'));
  await page.waitForTimeout(400);

  console.log('\n=== СВОЁ ОКНО ВМЕСТО СИСТЕМНОГО ===');
  const answered = await page.evaluate(async () => {
    const payload = {
      rid: 99,
      title: 'Синхронизация не удалась',
      text: 'В репозитории нет файла сервера.',
      kind: 'warn',
      buttons: [
        { id: 'cancel', label: 'Не запускать' },
        { id: 'start', label: 'Запустить как есть', primary: true },
      ],
    };
    const p = askFromMain(payload);
    await new Promise((r) => setTimeout(r, 250));
    const shown = !document.getElementById('askModal').classList.contains('hidden');
    const title = document.getElementById('askTitle').textContent;
    const btns = [...document.querySelectorAll('#askFoot .btn')].map((b) => b.textContent);
    document.querySelector('#askFoot .btn-primary').click();
    const id = await p;
    return { shown, title, btns, id, closed: document.getElementById('askModal').classList.contains('hidden') };
  });
  ok(answered.shown, 'окно в дизайне панели показано');
  ok(answered.title === 'Синхронизация не удалась', 'заголовок из ядра', answered.title);
  ok(answered.btns.length === 2 && answered.btns[1] === 'Запустить как есть', 'кнопки на месте', answered.btns.join(' | '));
  ok(answered.id === 'start' && answered.closed, 'ответ вернулся и окно закрылось', answered.id);

  console.log('\n=== TPS: ГРАФИК С ПЕРВОЙ ТОЧКИ ===');
  const chart = await page.evaluate(() => {
    const host = document.createElement('div');
    host.style.width = '400px';
    host.style.height = '110px';
    document.body.appendChild(host);
    drawChart(host, [{ t: Date.now(), v: 19.4 }], { min: 0, fixedMax: 20 });
    const svg = host.querySelector('svg');
    const out = {
      dot: !!host.querySelector('circle'),
      empty: /данных пока нет/.test(host.textContent),
      label: /первый замер/.test(host.textContent),
      has: !!svg,
    };
    host.remove();
    return out;
  });
  ok(chart.has && chart.dot, 'одна точка — уже точка на графике', JSON.stringify(chart));
  ok(!chart.empty, 'надпись «данных пока нет» не показывается');
  ok(chart.label, 'подписано «первый замер» со временем');

  console.log('\n=== НЕУДАЧНАЯ СИНХРОНИЗАЦИЯ ПРИ ЗАПУСКЕ: СВОЁ ОКНО, А НЕ СИСТЕМНОЕ ===');
  /* включаем синхронизацию на пустой репозиторий: забор не найдёт архива */
  await page.evaluate(async () => {
    await window.desktop.update('p1', {
      sync: {
        enabled: true, repo: 'o/r', branch: 'main', token: 'test-token',
        scope: 'all', mode: 'archive', pullOnStart: true, pushOnStop: false,
      },
    });
  });
  await page.waitForTimeout(400);
  /* запуск ждёт ответа в окне — поэтому не ждём его сами */
  await page.evaluate(() => { window.desktop.start('p1').catch(() => {}); });
  await page.waitForTimeout(2500);
  const askedTitle = await page.evaluate(() => {
    const modal = document.getElementById('askModal');
    return modal.classList.contains('hidden') ? '' : document.getElementById('askTitle').textContent;
  });
  ok(askedTitle === 'Синхронизация не удалась', 'ядерный вопрос показан своим окном', askedTitle || '(окно не открылось)');
  const askedText = await page.evaluate(() => document.getElementById('askText').textContent);
  ok(/нет файла сервера|не найден|сначала отправь/i.test(askedText), 'в окне текст ошибки', askedText.slice(0, 80));
  const askedBtns = await page.$$eval('#askFoot .btn', (els) => els.map((e) => e.textContent));
  ok(askedBtns.length === 2 && askedBtns[0] === 'Не запускать', 'кнопки свои, в дизайне панели', askedBtns.join(' | '));
  await page.click('#askFoot .btn');
  await page.waitForTimeout(700);
  const st = await page.evaluate(async () => (await window.desktop.list()).find((x) => x.id === 'p1'));
  ok(st.state === 'stopped', '«не запускать» действительно не запускает', st.state);

  console.log('\n=== ОШИБКИ ===');
  ok(errs.length === 0, 'нет JS-ошибок', errs.slice(0, 2).join(' | '));

  console.log('\n' + (fails ? `ПРОВАЛОВ: ${fails}` : 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ'));
  await app.close();
  mock.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('ОШИБКА ПРОГОНА: ' + e.message);
  process.exit(1);
});
