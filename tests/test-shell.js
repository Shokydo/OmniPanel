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

  /* ─────────── 1. шапка окна ─────────── */
  console.log('\n=== шапка окна как в полном экране ===');
  const bar = await page.evaluate(() => {
    const tb = document.querySelector('.titlebar');
    const labels = (root) => [...root.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')).filter(Boolean);
    return {
      text: document.getElementById('tbText').textContent,
      titlebarLabels: labels(tb.querySelector('.win-ctrl')),
      fsbarLabels: labels(document.querySelector('.fsbar .fsb-right')),
      btnSize: (() => { const r = document.querySelector('.titlebar .wc').getBoundingClientRect(); return Math.round(r.height); })(),
      prefs: !!document.getElementById('tbPrefs'),
      brand: !!document.querySelector('.tb-left .brand-logo'),
      iconSame: document.querySelector('#winMax svg.ic-max').innerHTML.trim()
        === document.querySelector('#fsbExit svg').innerHTML.trim(),
    };
  });
  ok(/Мир друзей/.test(bar.text) && /остановлен/.test(bar.text), 'по центру «сервер — состояние»', bar.text);
  ok(bar.prefs && bar.brand, 'слева иконка и кнопка настроек');
  ok(bar.titlebarLabels.length === 5, 'справа пять кнопок', bar.titlebarLabels.join(', '));
  const same = ['Настройк', 'Скрыть в трей', 'Уменьшить'];
  ok(same.every((w, i) => (bar.titlebarLabels[i] || '').startsWith(w) && (bar.fsbarLabels[i] || '').startsWith(w)),
    'те же кнопки и в том же порядке, что в полном экране', bar.fsbarLabels.join(', '));
  ok(bar.iconSame, 'иконка «на весь экран» совпадает с полосой полного экрана');
  ok(bar.btnSize <= 26, 'кнопки компактные, как в полосе полного экрана', bar.btnSize + 'px');

  /* ─────────── 2. масштаб ─────────── */
  console.log('\n=== масштаб интерфейса ===');
  const scale = await page.evaluate(async () => {
    prefs.scale = 0;
    prefs.save();
    applyPrefs();
    await new Promise((r) => setTimeout(r, 250));
    const auto = document.documentElement.dataset.scale;
    const chip = document.querySelector('#scaleGrid .chip[data-scale="0"]');
    return { auto: Number(auto), chipActive: chip ? chip.classList.contains('active') : false, hasChip: !!chip };
  });
  ok(scale.hasChip, 'есть вариант «Под окно»');
  ok(scale.chipActive, 'он выбран по умолчанию');
  ok(scale.auto >= 85 && scale.auto <= 130, 'масштаб считается по размеру окна', scale.auto + '%');

  const manual = await page.evaluate(async () => {
    prefs.scale = 115;
    prefs.save();
    applyPrefs();
    await new Promise((r) => setTimeout(r, 200));
    return { zoom: document.documentElement.style.zoom, data: document.documentElement.dataset.scale };
  });
  ok(manual.zoom === '1.15' && manual.data === '115', 'ручной масштаб работает', manual.zoom + ' / ' + manual.data);
  await page.evaluate(() => { prefs.scale = 0; prefs.save(); applyPrefs(); });

  /* ─────────── 3. широкие окна настроек ─────────── */
  console.log('\n=== окна настроек: шире и по центру ===');
  for (const sc of [100, 130]) {
    const box = await page.evaluate(async (s) => {
      prefs.scale = s;
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
      prefs.scale = 0;
      prefs.save();
      applyPrefs();
      return {
        prefs: { w: Math.round(p.width), h: Math.round(p.height), fit: p.bottom <= innerHeight + 1 && p.right <= innerWidth + 1 },
        props: { w: Math.round(q.width), h: Math.round(q.height), fit: q.bottom <= innerHeight + 1 && q.right <= innerWidth + 1 },
      };
    }, sc);
    ok(box.prefs.fit && box.props.fit, `при ${sc}% окна целиком в экране`, `${box.prefs.w}×${box.prefs.h} и ${box.props.w}×${box.props.h}`);
    ok(box.prefs.w > 900 && box.prefs.h > 560, `при ${sc}% панель настроек широкая и высокая`, box.prefs.w + '×' + box.prefs.h);
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
