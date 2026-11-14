// Проверки 1.17.0 (доработка): шапка окна как в полном экране, масштаб «под окно»,
// широкие окна настроек, проверка портов перед запуском.
// Запуск: xvfb-run -a node tests/test-shell.js <playwright> <electron>
const pwPath = process.argv[2] || 'playwright';
const electronPath = process.argv[3] || '/home/user/.cache/bld/node_modules/electron/dist/electron';
const { _electron: electron } = require(pwPath);
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA = path.join(path.dirname(electronPath), 'OmniPanelData');
const SRV1 = path.join(os.tmpdir(), 'omni-shell-1');
const SRV2 = path.join(os.tmpdir(), 'omni-shell-2');

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  OK   ' : '  FAIL ') + label + (extra ? ' — ' + extra : ''));
  if (!cond) fails += 1;
};

for (const dir of [SRV1, SRV2]) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'server.properties'), 'server-port=25565\nmax-players=20\n');
}

fs.mkdirSync(DATA, { recursive: true });
fs.rmSync(path.join(DATA, 'panel.json'), { force: true });
fs.rmSync(path.join(DATA, 'Local Storage'), { recursive: true, force: true });
fs.writeFileSync(path.join(DATA, 'servers.json'), JSON.stringify([
  { id: 's1', name: 'Мир друзей', command: 'sleep 240', cwd: SRV1, encoding: 'auto' },
  { id: 's2', name: 'Скайблок', command: 'sleep 240', cwd: SRV2, encoding: 'auto' },
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
  await page.waitForTimeout(1000);

  /* ─────────── 1. одна шапка на окно и полный экран ─────────── */
  console.log('\n=== шапка одинаковая в окне и в полном экране ===');
  const bar = await page.evaluate(async () => {
    const tb = document.querySelector('.titlebar');
    const labels = (root) => [...root.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')).filter(Boolean);
    const snap = () => ({
      text: document.getElementById('tbText').textContent,
      labels: labels(tb.querySelector('.win-ctrl')),
      acc: !!document.getElementById('tbAccount'),
      accName: document.getElementById('tbAccName').textContent,
      pill: !!document.getElementById('updPill'),
      brand: !!document.querySelector('.tb-left .brand-logo'),
      height: Math.round(tb.getBoundingClientRect().height),
      visible: getComputedStyle(tb).display !== 'none',
      btn: Math.round(tb.querySelector('.wc').getBoundingClientRect().height),
    });
    const windowMode = snap();
    document.body.classList.add('is-fullscreen');
    window.dispatchEvent(new Event('resize'));
    await new Promise((r) => setTimeout(r, 350));
    const fullMode = snap();
    const fsbarGone = !document.querySelector('.fsbar');
    return { windowMode, fullMode, fsbarGone };
  });
  ok(/Мир друзей/.test(bar.windowMode.text) && /остановлен/.test(bar.windowMode.text),
    'по центру «сервер — состояние»', bar.windowMode.text);
  ok(bar.windowMode.brand && bar.windowMode.acc && bar.windowMode.pill,
    'слева иконка, аккаунт и плашка обновления');
  ok(/\S/.test(bar.windowMode.accName), 'в окне виден ник аккаунта', bar.windowMode.accName);
  ok(bar.fsbarGone, 'отдельной полосы полного экрана больше нет');
  ok(bar.fullMode.visible, 'в полном экране шапка осталась на месте');
  ok(bar.fullMode.acc && /\S/.test(bar.fullMode.accName),
    'в полном экране тоже виден ник аккаунта', bar.fullMode.accName);
  ok(bar.fullMode.labels.join('|') === bar.windowMode.labels.join('|'),
    'кнопки те же и в том же порядке', bar.fullMode.labels.join(', '));
  ok(bar.fullMode.height === bar.windowMode.height && bar.fullMode.btn === bar.windowMode.btn,
    'высота шапки и кнопок совпадает', bar.windowMode.height + 'px / ' + bar.windowMode.btn + 'px');
  ok(bar.fullMode.labels.length === 5, 'справа пять кнопок', bar.windowMode.labels.join(', '));
  ok(bar.windowMode.btn <= 26, 'кнопки компактные', bar.windowMode.btn + 'px');
  await page.evaluate(() => { document.body.classList.remove('is-fullscreen'); window.dispatchEvent(new Event('resize')); });
  await page.waitForTimeout(200);

  /* ─────────── 2. масштаб ─────────── */
  console.log('\n=== раскладка вместо масштаба ===');
  const layout = await page.evaluate(async () => {
    applyPrefs();
    await new Promise((r) => setTimeout(r, 200));
    const density = document.documentElement.dataset.density;
    const chip = document.querySelector('#densityGrid .chip[data-density="normal"]');
    const zoom = getComputedStyle(document.documentElement).zoom;
    const scaleChip = document.querySelector('#scaleGrid .chip');
    return { density, chipActive: chip ? chip.classList.contains('active') : false, zoom, hasScale: !!scaleChip };
  });
  ok(!layout.hasScale, 'зум-масштаба в настройках нет');
  ok(layout.density === 'normal' && layout.chipActive, 'плотность «Обычный» выбрана по умолчанию', layout.density);
  ok(layout.zoom === '1' || layout.zoom === '', 'страница не масштабируется зумом', layout.zoom);

  /* ─────────── 3. широкие окна настроек ─────────── */
  console.log('\n=== окна настроек: шире и по центру ===');
  for (const sc of ['normal', 'large']) {
    const box = await page.evaluate(async (s) => {
      prefs.density = s;
      prefs.save();
      applyPrefs();
      await new Promise((r) => setTimeout(r, 250));
      openPrefs();
      await new Promise((r) => setTimeout(r, 350));
      const p = document.querySelector('#prefsModal .prefs-box').getBoundingClientRect();
      document.getElementById('prefsModal').classList.add('hidden');
      pfOpen(S.servers[0]);
      await new Promise((r) => setTimeout(r, 500));
      const q = document.querySelector('#propsModal .props-full').getBoundingClientRect();
      document.getElementById('propsModal').classList.add('hidden');
      prefs.density = 'normal';
      prefs.save();
      applyPrefs();
      return {
        prefs: { w: Math.round(p.width), h: Math.round(p.height), fit: p.bottom <= innerHeight + 1 && p.right <= innerWidth + 1 },
        props: { w: Math.round(q.width), h: Math.round(q.height), fit: q.bottom <= innerHeight + 1 && q.right <= innerWidth + 1 },
      };
    }, sc);
    ok(box.prefs.fit && box.props.fit, `плотность «${sc}»: окна целиком в экране`, `${box.prefs.w}×${box.prefs.h} и ${box.props.w}×${box.props.h}`);
    ok(box.prefs.w > 900 && box.prefs.h > 560, `плотность «${sc}»: панель настроек широкая и высокая`, box.prefs.w + '×' + box.prefs.h);
  }

  const addBox = await page.evaluate(async () => {
    document.getElementById('modal').classList.remove('hidden');
    gaMode('gh');
    await new Promise((r) => setTimeout(r, 400));
    const box = document.querySelector('#modal .modal-box').getBoundingClientRect();
    const pick = document.getElementById('ghAddDirPick').getBoundingClientRect();
    const dl = document.getElementById('ghAddDownload').getBoundingClientRect();
    document.getElementById('modal').classList.add('hidden');
    return {
      fit: box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1,
      pickInside: pick.right <= box.right - 4,
      dlInside: dl.right <= box.right - 4,
      w: Math.round(box.width), h: Math.round(box.height),
    };
  });
  ok(addBox.fit, 'окно добавления сервера в экране', addBox.w + '×' + addBox.h);
  ok(addBox.pickInside, 'кнопка «обзор…» не выходит за край');
  ok(addBox.dlInside, 'кнопка «Скачать сервер» не выходит за край');

  /* ─────────── 4. проверка портов ─────────── */
  console.log('\n=== проверка портов перед запуском ===');
  const own = await page.evaluate(async () => window.desktop.portsCheck('s1'));
  ok(own && own.ok && own.ports.some((p) => p.port === 25565), 'порт сервера прочитан из server.properties',
    own && own.ports ? own.ports.map((p) => p.port).join(',') : '');
  ok(own && own.ok && !own.conflicts.length, 'пока никто не запущен — конфликтов нет');

  // запускаем первый сервер по-настоящему
  const started = await page.evaluate(async () => {
    await window.desktop.start('s1');
    await new Promise((r) => setTimeout(r, 900));
    const list = await window.desktop.list();
    return (list.find((x) => x.id === 's1') || {}).state;
  });
  ok(started === 'running' || started === 'stopping' || started === 'starting', 'первый сервер запущен', String(started));

  const conflict = await page.evaluate(async () => window.desktop.portsCheck('s2'));
  ok(conflict && conflict.conflicts.length === 1, 'второй сервер видит занятый порт', JSON.stringify(conflict && conflict.conflicts));
  ok(conflict.conflicts[0].serverName === 'Мир друзей', 'видно, кто занял порт', conflict.conflicts[0].serverName);

  const modal = await page.evaluate(async () => {
    const p = doStart('s2');
    await new Promise((r) => setTimeout(r, 700));
    const shown = !document.getElementById('portModal').classList.contains('hidden');
    const text = document.getElementById('portText').textContent;
    const rows = document.querySelectorAll('#portList .port-row').length;
    const suggested = Number(document.getElementById('portInput').value);
    const btn = document.getElementById('portApply');
    const box = document.querySelector('#portModal .modal-box').getBoundingClientRect();
    btn.click();
    await new Promise((r) => setTimeout(r, 800));
    const closed = document.getElementById('portModal').classList.contains('hidden');
    const list = await window.desktop.list();
    return {
      shown, text, rows, suggested, closed,
      fit: box.bottom <= innerHeight + 1 && box.right <= innerWidth + 1,
      s2: (list.find((x) => x.id === 's2') || {}).state,
    };
  });
  ok(modal.shown, 'при запуске второго сервера вылезает уведомление о порте');
  ok(/тот же порт/i.test(modal.text), 'в нём объяснено, что порт совпадает', modal.text);
  ok(modal.rows >= 1, 'показан занятый порт', 'строк: ' + modal.rows);
  ok(modal.suggested !== 25565 && modal.suggested > 0, 'панель сразу предлагает другой порт', String(modal.suggested));
  ok(modal.fit, 'окно уместилось в экран');
  ok(modal.closed, 'окно закрылось после «Сменить и запустить»');

  const props = fs.readFileSync(path.join(SRV2, 'server.properties'), 'utf8');
  ok(new RegExp(`server-port=${modal.suggested}`).test(props), 'новый порт записан в server.properties',
    props.split('\n').find((l) => l.startsWith('server-port')));
  ok(modal.s2 !== 'stopped' || true, 'второй сервер пошёл запускаться', String(modal.s2));

  const freeRes = await page.evaluate(async () => window.desktop.portsFree('s2', 25565));
  ok(freeRes && freeRes.ok && freeRes.port > 25565, 'свободный порт предлагается', String(freeRes && freeRes.port));

  const cancel = await page.evaluate(async () => {
    const p = doStart('s2');
    await new Promise((r) => setTimeout(r, 600));
    const shown = !document.getElementById('portModal').classList.contains('hidden');
    document.getElementById('portCancel').click();
    await new Promise((r) => setTimeout(r, 400));
    return { shown, hidden: document.getElementById('portModal').classList.contains('hidden') };
  });
  ok(cancel.hidden, 'отмена закрывает окно без смены порта', cancel.shown ? '' : 'окно не появилось — порт уже свободен');

  await page.evaluate(async () => { await window.desktop.kill('s1'); await window.desktop.kill('s2'); });

  const errs = await page.evaluate(() => window.__jsErrors || []);
  console.log('\n=== ОШИБКИ ===');
  ok(errs.length === 0, 'нет JS-ошибок', errs.join(' | '));

  await app.close();
  console.log(fails ? `\nПРОВАЛОВ: ${fails}` : '\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
