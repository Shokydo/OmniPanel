// Пересылка сервера в GitHub одним архивом через интерфейс:
// «Отправить на GitHub» = архивация → отправка файла,
// «Забрать с GitHub»   = скачивание архива → распаковка в папку сервера.
// GitHub подменён локальным двойником, интернет не нужен.
// Запуск: xvfb-run -a node tests/test-sync-gui.js <playwright> <electron>
const pwPath = process.argv[2] || 'playwright';
const electronPath = process.argv[3] || '/home/user/.cache/bld/node_modules/electron/dist/electron';
const { _electron: electron } = require(pwPath);
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const mock = require(path.join(ROOT, 'tests/mock-gh'));

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  OK   ' : '  FAIL ') + label + (extra ? ' — ' + extra : ''));
  if (!cond) fails += 1;
};

const DATA = path.join(path.dirname(electronPath), 'OmniPanelData');
const PUSH_DIR = path.join(os.tmpdir(), 'omni-syncgui-push');
const PULL_DIR = path.join(os.tmpdir(), 'omni-syncgui-pull');

for (const dir of [PUSH_DIR, PULL_DIR]) fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(path.join(PUSH_DIR, 'plugins/MyPlugin'), { recursive: true });
fs.mkdirSync(path.join(PUSH_DIR, 'world'), { recursive: true });
fs.writeFileSync(path.join(PUSH_DIR, 'server.properties'), 'level-name=world\nmotd=Мир друзей\n');
fs.writeFileSync(path.join(PUSH_DIR, 'plugins/MyPlugin/config.yml'),
  'settings:\n  enabled: true\n  interval: 20\n'.repeat(200));
fs.writeFileSync(path.join(PUSH_DIR, 'world/level.dat'), Buffer.alloc(80000, 3));
fs.mkdirSync(PULL_DIR, { recursive: true });
fs.writeFileSync(path.join(PULL_DIR, 'server.properties'), 'level-name=empty\n');

fs.mkdirSync(DATA, { recursive: true });
fs.rmSync(path.join(DATA, 'panel.json'), { force: true });
fs.rmSync(path.join(DATA, 'Local Storage'), { recursive: true, force: true });
fs.writeFileSync(path.join(DATA, 'servers.json'), JSON.stringify([
  {
    id: 'push1', name: 'Мир друзей', command: 'sleep 300', cwd: PUSH_DIR, encoding: 'auto',
    sync: { enabled: true, repo: 'o/r', branch: 'main', token: 'test-token', scope: 'all' },
  },
  {
    id: 'pull1', name: 'Второй ПК', command: 'sleep 300', cwd: PULL_DIR, encoding: 'auto',
    sync: { enabled: true, repo: 'o/r', branch: 'main', token: 'test-token', scope: 'all' },
  },
]));

/** Ждёт, пока строка состояния синхронизации не совпадёт с шаблоном. */
async function waitStatus(page, re, timeout = 25000) {
  const started = Date.now();
  let text = '';
  while (Date.now() - started < timeout) {
    text = await page.evaluate(() => {
      const el = document.getElementById('syncStatus');
      return el ? el.textContent : '';
    });
    if (re.test(text)) return text;
    await page.waitForTimeout(150);
  }
  return text;
}

async function openSync(page, serverIndex) {
  await page.evaluate((i) => {
    const row = document.querySelectorAll('#serverList .srv')[i];
    if (row) row.click();
  }, serverIndex);
  await page.waitForTimeout(400);
  await page.evaluate(() => document.getElementById('btnSettings').click());
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    document.getElementById('f_syncEnabled').checked = true;
    document.getElementById('syncBody').classList.remove('off');
  });
}

(async () => {
  const server = mock.makeServer('o/r');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.OMNI_GITHUB_API = `http://127.0.0.1:${server.address().port}`;

  /* пустой репозиторий двойника: ветка есть, дерево пустое */
  mock.store.trees.set('t0', []);
  mock.store.commits.set('c0', { sha: 'c0', tree: { sha: 't0' }, parents: [], message: 'init' });
  mock.store.refs.set('main', 'c0');

  const app = await electron.launch({
    executablePath: electronPath,
    args: [ROOT, '--no-sandbox'],
    env: { ...process.env, OMNI_GITHUB_API: process.env.OMNI_GITHUB_API },
    timeout: 60000,
  });
  const page = await app.firstWindow();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.waitForSelector('#serverList .srv', { timeout: 30000 });
  await page.waitForTimeout(1200);

  /* ─────────── 1. отправка: архивация → GitHub ─────────── */
  console.log('=== отправка: архивация → GitHub ===');
  await openSync(page, 0);
  const before = mock.store.blobs.size;
  await page.evaluate(() => document.getElementById('syncPush').click());

  const pushStatus = await waitStatus(page, /отправлен|нечего|Не |ошибк/i);
  ok(/отправлен/.test(pushStatus), 'строка состояния говорит об успешной отправке', pushStatus.slice(0, 100));
  ok(/7z/.test(pushStatus), 'отправлен архив 7z (максимум сжатия)', pushStatus.slice(0, 60));

  const stagePushed = await page.evaluate(() => window.__ghStage || '');
  void stagePushed;
  const notes = await page.evaluate(() => {
    const el = document.getElementById('console');
    return el ? el.innerText : '';
  });
  ok(/шаг 1 из 2: архивирую/.test(notes), 'в консоли виден шаг 1 — архивация', notes.slice(-160));
  ok(/шаг 2 из 2: отправляю архив на GitHub/.test(notes), 'в консоли виден шаг 2 — отправка');
  ok(mock.store.blobs.size > before + 1, 'в репозиторий легли blob-ы архива и манифеста',
    `${before} → ${mock.store.blobs.size}`);

  const tree = mock.store.trees.get(mock.store.commits.get(mock.store.refs.get('main')).tree.sha)
    || mock.store.trees.get(mock.store.commits.get(mock.store.refs.get('main')).tree);
  const paths = (tree || []).map((e) => e.path);
  ok(paths.includes('.omnipanel/сервер.7z'), 'в репозитории один файл сервера', paths.join(', '));
  ok(paths.some((p) => /манифест\.json$/.test(p)), 'манифест архива рядом');
  ok(!paths.includes('server.properties'), 'пофайловых копий нет');
  const blob = mock.store.blobs.get((tree || []).find((e) => e.path === '.omnipanel/сервер.7z').sha);
  ok(blob && blob.subarray(0, 2).toString('hex') === '377a', 'в репозитории настоящий 7z',
    blob ? blob.length + ' Б' : 'нет файла');

  /* ─────────── 2. повторная отправка: нечего ─────────── */
  console.log('\n=== повторная отправка без изменений ===');
  await page.evaluate(() => document.getElementById('syncPush').click());
  const againStatus = await waitStatus(page, /нечего|отправлен/i);
  ok(/нечего/.test(againStatus), 'второй раз отправлять нечего', againStatus.slice(0, 80));

  /* ─────────── 3. забор на втором ПК: скачать → распаковать ─────────── */
  console.log('\n=== забор: архив с GitHub → распаковка ===');
  await page.evaluate(() => document.getElementById('modal').classList.add('hidden'));
  await page.waitForTimeout(300);
  await openSync(page, 1);
  await page.evaluate(() => document.getElementById('syncPull').click());
  const pullStatus = await waitStatus(page, /распакован|актуально|Не |ошибк/i);
  ok(/распакован/.test(pullStatus), 'строка состояния говорит о распаковке', pullStatus.slice(0, 100));
  ok(/7z/.test(pullStatus), 'распознан формат 7z', pullStatus.slice(0, 40));

  ok(fs.existsSync(path.join(PULL_DIR, 'server.properties')), 'server.properties появился в папке второго ПК');
  ok(fs.readFileSync(path.join(PULL_DIR, 'server.properties'), 'utf8').includes('motd=Мир друзей'),
    'содержимое совпадает с отправленным');
  ok(fs.existsSync(path.join(PULL_DIR, 'plugins/MyPlugin/config.yml')), 'вложенные файлы распакованы');
  ok(fs.statSync(path.join(PULL_DIR, 'world/level.dat')).size === 80000, 'файл мира распакован целиком');

  const notes2 = await page.evaluate(() => document.getElementById('console').innerText);
  ok(/шаг 1 из 2: скачиваю архив/.test(notes2), 'в консоли виден шаг 1 забора — скачивание');
  ok(/шаг 2 из 2: распаковываю/.test(notes2), 'в консоли виден шаг 2 забора — распаковка');

  /* ─────────── 4. состояние переключателя и подсказка ─────────── */
  console.log('\n=== настройки ===');
  const ui = await page.evaluate(() => ({
    mode: document.getElementById('f_syncMode').checked,
    hint: document.querySelector('.sync-hint').textContent,
  }));
  ok(ui.mode === true, 'пересылка архивом включена по умолчанию');
  ok(/упаковывает папку сервера в архив/i.test(ui.hint), 'подсказка объясняет отправку архивом');

  console.log('\n=== ОШИБКИ ===');
  ok(errs.length === 0, 'нет JS-ошибок', errs.slice(0, 2).join(' | '));

  await app.close();
  server.close();
  console.log(fails ? `\nПРОВАЛОВ: ${fails}` : '\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ОШИБКА', e); process.exit(1); });
