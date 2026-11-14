// Проверки самообновления: версии, канал update.json, релизы, скачивание,
// распаковка, установка кода поверх «старой» панели, полная сборка.
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const zip = require('../core/zip');
const updater = require('../core/updater');

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  OK   ' : '  FAIL ') + label + (extra ? ' — ' + extra : ''));
  if (!cond) fails += 1;
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-upd-'));

/* ── «панель» старой версии ── */
function makeApp(dir, version, extra = {}) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'ui'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'core'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'main.js'), `// main ${version}`);
  fs.writeFileSync(path.join(dir, 'preload.js'), `// preload ${version}`);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'omnipanel', version }));
  fs.writeFileSync(path.join(dir, 'ui/index.html'), `<h1>${version}</h1>`);
  fs.writeFileSync(path.join(dir, 'ui/app.js'), `// app ${version}`);
  fs.writeFileSync(path.join(dir, 'ui/style.css'), `/* ${version} */`);
  fs.writeFileSync(path.join(dir, 'core/old.js'), '// файл, которого не будет в новой версии');
  for (const [name, content] of Object.entries(extra)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

/* ── архивы обновления ── */
const NEW_FILES = [
  ['main.js', '// main 2.0.0'],
  ['preload.js', '// preload 2.0.0'],
  ['package.json', JSON.stringify({ name: 'omnipanel', version: '2.0.0' })],
  ['ui/index.html', '<h1>2.0.0</h1>'],
  ['ui/app.js', '// app 2.0.0'],
  ['ui/style.css', '/* 2.0.0 */'],
  ['ui/new-file.js', '// новый файл обновления'],
];
const codeZip = zip.create(NEW_FILES.map(([name, data]) => ({ name, data })));
const codePath = path.join(TMP, 'OmniPanel-code.zip');
fs.writeFileSync(codePath, codeZip);
const codeSha = crypto.createHash('sha256').update(codeZip).digest('hex');

const badZip = zip.create([{ name: 'readme.txt', data: 'тут нет панели' }]);
const badPath = path.join(TMP, 'bad.zip');
fs.writeFileSync(badPath, badZip);

const fullBuf = Buffer.concat([Buffer.from('PK-полная сборка'), crypto.randomBytes(4096)]);
const fullPath = path.join(TMP, 'OmniPanel-win64.zip');
fs.writeFileSync(fullPath, fullBuf);

/* ── «GitHub» ── */
const manifest = {
  version: '2.0.0',
  notes: 'Что нового: обновление из GitHub\n· мелочи',
  code: { file: 'dist/OmniPanel-code.zip', size: codeZip.length, sha256: codeSha },
  full: null,
};
const hits = [];
const server = http.createServer((req, res) => {
  hits.push(req.url);
  const send = (code, body, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  };
  if (req.url.startsWith('/m/r/main/update.json')) return send(200, JSON.stringify(manifest));
  if (req.url.startsWith('/m/r/main/dist/OmniPanel-code.zip')) {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': codeZip.length });
    return res.end(codeZip);
  }
  if (req.url === '/repos/o/r/releases/latest') {
    return send(200, JSON.stringify({
      tag_name: 'v2.1.0',
      body: 'Релиз 2.1.0: новая версия',
      assets: [
        { name: 'OmniPanel-code.zip', size: codeZip.length, browser_download_url: `http://127.0.0.1:${port}/asset/code` },
        { name: 'OmniPanel-win64.zip', size: fullBuf.length, browser_download_url: `http://127.0.0.1:${port}/asset/full` },
        { name: 'OmniPanel-Setup-2.1.0.exe', size: 4096, browser_download_url: `http://127.0.0.1:${port}/asset/setup` },
      ],
    }));
  }
  if (req.url === '/asset/code') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': codeZip.length });
    return res.end(codeZip);
  }
  if (req.url === '/asset/setup') {
    const body = Buffer.alloc(4096, 77);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length });
    return res.end(body);
  }
  if (req.url === '/asset/full') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': fullBuf.length });
    return res.end(fullBuf);
  }
  if (req.url === '/repos/o/empty/releases/latest') return send(404, '{}');
  if (req.url.startsWith('/o/empty/main/update.json')) return send(404, 'Not Found', 'text/plain');
  return send(404, '{}');
});

let port = 0;
server.listen(0, '127.0.0.1', async () => {
  port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  process.env.OMNI_UPDATE_RAW = base;
  process.env.OMNI_UPDATE_API = base;

  console.log('=== ВЕРСИИ ===');
  ok(updater.compareVersions('1.11.0', '1.10.9') === 1, '1.11.0 новее 1.10.9');
  ok(updater.compareVersions('v1.10.0', '1.10') === 0, 'префикс v и хвост версии не мешают');
  ok(updater.compareVersions('2.0', '10.0') === -1, '2.0 старее 10.0');
  ok(updater.parseVersion('мусор').join('.') === '0.0.0', 'мусор → 0.0.0');
  ok(updater.normalizeRepo('https://github.com/vasya/omni.git') === 'vasya/omni', 'ссылка на репозиторий разбирается');
  ok(updater.normalizeRepo('vasya/omni') === 'vasya/omni', 'владелец/репозиторий как есть');
  ok(updater.normalizeRepo('ерунда') === '', 'неверный формат отклонён');

  console.log('\n=== ПРОВЕРКА ЧЕРЕЗ update.json ===');
  const m = await updater.check({ repo: 'm/r', branch: 'main', current: '1.10.0' });
  ok(m.ok && m.latest === '2.0.0', 'версия из манифеста', JSON.stringify({ latest: m.latest, has: m.hasUpdate }));
  ok(m.hasUpdate, 'обновление найдено');
  ok(m.code && m.code.url === `${base}/m/r/main/dist/OmniPanel-code.zip`, 'ссылка на архив кода собрана верно', m.code && m.code.url);
  ok(!m.full, 'в манифесте полной сборки нет — она живёт в релизе');
  ok(/^sha256|[a-f0-9]{64}$/.test(m.code.sha256), 'контрольная сумма передана');
  const noUpd = await updater.check({ repo: 'm/r', branch: 'main', current: '2.0.0' });
  ok(noUpd.ok && !noUpd.hasUpdate, 'на последней версии обновления нет');

  console.log('\n=== ПРОВЕРКА ЧЕРЕЗ РЕЛИЗ ===');
  const rel = await updater.check({ repo: 'o/r', branch: 'main', current: '2.0.0' });
  ok(rel.ok && rel.latest === '2.1.0', 'релиз новее манифеста — берётся релиз', JSON.stringify({ latest: rel.latest, src: rel.source }));
  ok(!!rel.full, 'полная сборка найдена в файлах релиза');
  ok(!!rel.setup && /Setup/.test(rel.setup.name), 'установщик найден в файлах релиза', rel.setup && rel.setup.name);
  ok(!!rel.code, 'архив кода взят из релиза или манифеста');

  const empty = await updater.check({ repo: 'o/empty', branch: 'main', current: '1.0.0' });
  ok(empty.ok === false && /update\.json|релиз/.test(empty.error), 'пустой репозиторий — понятная ошибка', empty.error);
  const broken = await updater.check({ repo: 'что', current: '1.0.0' });
  ok(broken.ok === false, 'без репозитория проверка не идёт');

  console.log('\n=== СКАЧИВАНИЕ ===');
  const dl = path.join(TMP, 'dl.zip');
  const prog = [];
  const got = await updater.download(m.code.url, dl, { onProgress: (p) => prog.push(p) });
  ok(got.size === codeZip.length, 'размер совпал', `${got.size} / ${codeZip.length}`);
  ok(prog.length > 0, 'прогресс сообщается');
  ok(updater.sha256File(dl) === codeSha, 'контрольная сумма файла сходится');

  console.log('\n=== УСТАНОВКА КОДА ===');
  const app = makeApp(path.join(TMP, 'app'), '1.10.0');
  const res = updater.applyCode({
    appDir: app, zipPath: dl, backupDir: path.join(TMP, 'backup'), version: '2.0.0',
  });
  ok(res.ok, 'установка прошла', res.error || '');
  ok(fs.readFileSync(path.join(app, 'ui/app.js'), 'utf8') === '// app 2.0.0', 'файлы заменены');
  ok(fs.existsSync(path.join(app, 'ui/new-file.js')), 'новый файл появился');
  ok(fs.existsSync(path.join(app, 'core/old.js')) === false, 'лишний файл убран');
  ok(fs.readFileSync(path.join(app, 'ui/index.html'), 'utf8') === '<h1>2.0.0</h1>', 'интерфейс обновился');
  ok(fs.existsSync(path.join(res.backup, 'ui/app.js')), 'бэкап старых файлов сделан');
  ok(fs.readFileSync(path.join(res.backup, 'ui/app.js'), 'utf8') === '// app 1.10.0', 'в бэкапе именно старая версия');
  const inst = JSON.parse(fs.readFileSync(path.join(app, 'update-installed.json'), 'utf8'));
  ok(inst.version === '2.0.0' && inst.files.includes('ui/app.js'), 'состав обновления записан');

  console.log('\n=== ДАННЫЕ ПОЛЬЗОВАТЕЛЯ ПЕРЕЖИВАЮТ ОБНОВЛЕНИЕ ===');
  // как в жизни: панель установлена в .../OmniPanel, данные — в .../OmniPanel/OmniPanelData
  const live = path.join(TMP, 'live/OmniPanel');
  const appLive = makeApp(live, '1.10.0');
  const dataDir = path.join(appLive, 'OmniPanelData');
  fs.mkdirSync(path.join(dataDir, 'backups/srv1'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'tps'), { recursive: true });
  const servers = [{ id: 'srv1', name: 'Мир друзей', cwd: '/миры/друзей', command: 'java -jar server.jar' }];
  fs.writeFileSync(path.join(dataDir, 'servers.json'), JSON.stringify(servers));
  fs.writeFileSync(path.join(dataDir, 'panel.json'), JSON.stringify({ githubLogin: 'tester', updateRepo: 'Shox/OmniPanel', updateAuto: true }));
  fs.writeFileSync(path.join(dataDir, 'tps/srv1.json'), JSON.stringify([{ t: 1, v: 20 }]));
  fs.writeFileSync(path.join(dataDir, 'backups/srv1/world.zip'), 'бэкап мира');
  fs.mkdirSync(path.join(dataDir, 'Local Storage'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'Local Storage/prefs'), 'тема=тёмная; фон=аврора; масштаб=115');

  const before = {
    servers: fs.readFileSync(path.join(dataDir, 'servers.json'), 'utf8'),
    panel: fs.readFileSync(path.join(dataDir, 'panel.json'), 'utf8'),
    tps: fs.readFileSync(path.join(dataDir, 'tps/srv1.json'), 'utf8'),
    backup: fs.readFileSync(path.join(dataDir, 'backups/srv1/world.zip'), 'utf8'),
    prefs: fs.readFileSync(path.join(dataDir, 'Local Storage/prefs'), 'utf8'),
  };

  // обновление, в котором ЗЛОНАМЕРЕННО лежат файлы данных — их надо проигнорировать
  const evil = zip.create([
    ...NEW_FILES.map(([n, d]) => ({ name: n, data: d })),
    { name: 'OmniPanelData/servers.json', data: '[]' },
    { name: 'OmniPanelData/panel.json', data: '{"сломано":true}' },
    { name: 'servers.json', data: '[]' },
    { name: 'data/servers.json', data: '[]' },
  ]);
  const evilPath = path.join(TMP, 'evil.zip');
  fs.writeFileSync(evilPath, evil);

  const liveRes = updater.applyCode({ appDir: appLive, zipPath: evilPath, backupDir: path.join(TMP, 'backup-live'), version: '2.0.0', backupLabel: '1.10.0' });
  ok(liveRes.ok, 'обновление поставилось', liveRes.error || '');
  ok(fs.readFileSync(path.join(dataDir, 'servers.json'), 'utf8') === before.servers, 'список серверов не изменился');
  ok(JSON.parse(fs.readFileSync(path.join(dataDir, 'servers.json'), 'utf8'))[0].cwd === '/миры/друзей', 'пути к мирам целы');
  ok(fs.readFileSync(path.join(dataDir, 'panel.json'), 'utf8') === before.panel, 'настройки панели и профиль GitHub не тронуты');
  ok(fs.readFileSync(path.join(dataDir, 'tps/srv1.json'), 'utf8') === before.tps, 'история TPS цела');
  ok(fs.readFileSync(path.join(dataDir, 'backups/srv1/world.zip'), 'utf8') === before.backup, 'бэкапы миров целы');
  ok(fs.readFileSync(path.join(dataDir, 'Local Storage/prefs'), 'utf8') === before.prefs, 'оформление (тема, фон, масштаб) цело');
  ok((liveRes.blocked || []).length === 4, 'файлы данных из архива заблокированы', JSON.stringify(liveRes.blocked));
  ok(fs.existsSync(path.join(appLive, 'servers.json')) === false, 'корневой servers.json из архива не создан');
  ok(liveRes.kept.length >= 2, 'настройки зафиксированы как сохранённые', JSON.stringify(liveRes.kept));
  ok(fs.readFileSync(path.join(appLive, 'ui/app.js'), 'utf8') === '// app 2.0.0', 'код при этом обновился');
  ok(fs.existsSync(path.join(liveRes.backup, '_user-config/OmniPanelData/servers.json')), 'копия настроек лежит в бэкапе');

  // второе обновление подряд — данные тоже на месте
  const again = updater.applyCode({ appDir: appLive, zipPath: evilPath, backupDir: path.join(TMP, 'backup-live'), version: '2.0.1' });
  ok(again.ok, 'второе обновление подряд прошло');
  ok(fs.readFileSync(path.join(dataDir, 'servers.json'), 'utf8') === before.servers, 'после второго обновления серверы на месте');
  ok(fs.readFileSync(path.join(dataDir, 'Local Storage/prefs'), 'utf8') === before.prefs, 'оформление после второго обновления цело');

  console.log('\n=== ПОВТОРНОЕ ОБНОВЛЕНИЕ ===');
  const other = zip.create([
    ...NEW_FILES.filter(([n]) => n !== 'ui/new-file.js').map(([name, data]) => ({ name, data })),
    { name: 'ui/next.js', data: '// следующая версия' },
  ]);
  const otherPath = path.join(TMP, 'next.zip');
  fs.writeFileSync(otherPath, other);
  const res2 = updater.applyCode({ appDir: app, zipPath: otherPath, backupDir: path.join(TMP, 'backup'), version: '2.0.1' });
  ok(res2.ok, 'второе обновление прошло');
  ok(!fs.existsSync(path.join(app, 'ui/new-file.js')), 'файл из прошлого обновления убран');
  ok(fs.existsSync(path.join(app, 'ui/next.js')), 'файл новой версии на месте');

  console.log('\n=== ПЛОХИЕ АРХИВЫ ===');
  const bad = updater.applyCode({ appDir: app, zipPath: badPath, backupDir: path.join(TMP, 'backup'), version: '3.0.0' });
  ok(bad.ok === false && /нет файла|нет файлов/.test(bad.error), 'архив без панели отклонён', bad.error);
  const missing = updater.applyCode({ appDir: app, zipPath: path.join(TMP, 'нет.zip'), backupDir: TMP, version: '3' });
  ok(missing.ok === false, 'отсутствующий архив отклонён');

  console.log('\n=== ОБЫЧНЫЙ ZIP (не наш) ===');
  const sysZip = path.join(TMP, 'sys.zip');
  require('child_process').execSync(`cd ${JSON.stringify(TMP)} && rm -rf sz && mkdir sz && cd sz && echo "// main sys" > main.js && mkdir ui core && echo "<h1>sys</h1>" > ui/index.html && echo "// app" > ui/app.js && echo '{}' > package.json && zip -qr ${JSON.stringify(sysZip)} .`);
  const sysApp = makeApp(path.join(TMP, 'app2'), '1.0.0');
  const sysRes = updater.applyCode({ appDir: sysApp, zipPath: sysZip, backupDir: path.join(TMP, 'backup'), version: '9.9.9' });
  ok(sysRes.ok, 'архив от обычного zip тоже ставится', sysRes.error || '');
  ok(fs.readFileSync(path.join(sysApp, 'main.js'), 'utf8').includes('main sys'), 'содержимое распаковано');

  console.log('\n=== ПОЛНАЯ СБОРКА ===');
  const full = await updater.download(rel.full.url, path.join(TMP, 'full.zip'), {});
  ok(full.size === fullBuf.length, 'полная сборка скачана целиком', `${full.size} байт`);
  const exeDir = path.join(TMP, 'prog/OmniPanel');
  fs.mkdirSync(exeDir, { recursive: true });
  fs.writeFileSync(path.join(exeDir, 'OmniPanel.exe'), 'exe');
  const saved = updater.saveFullPackage({ zipPath: full.file, exeDir, updatesDir: path.join(TMP, 'updates') });
  ok(saved.ok && fs.existsSync(saved.archive), 'архив лежит в папке данных', saved.archive);
  ok(fs.existsSync(saved.script), 'скрипт обновления создан', saved.script);
  const bat = fs.readFileSync(saved.script, 'utf8');
  ok(/taskkill \/im OmniPanel\.exe/.test(bat), 'скрипт закрывает панель');
  ok(bat.includes('Expand-Archive') && bat.includes(exeDir), 'скрипт распаковывает в папку программы');
  ok(bat.includes(path.join(exeDir, 'OmniPanel.exe')), 'скрипт запускает панель обратно');

  console.log('\n=== БЭКАПЫ ===');
  const bdir = path.join(TMP, 'many');
  for (const n of ['before-1', 'before-2', 'before-3', 'before-4']) {
    fs.mkdirSync(path.join(bdir, n), { recursive: true });
    fs.writeFileSync(path.join(bdir, n, 'f'), n);
    const t = Date.now() - (4 - Number(n.slice(-1))) * 1000;
    fs.utimesSync(path.join(bdir, n), t / 1000, t / 1000);
  }
  updater.pruneBackups(bdir, 2);
  ok(fs.readdirSync(bdir).sort().join(',') === 'before-3,before-4', 'остаются два свежих бэкапа', fs.readdirSync(bdir).sort().join(','));

  console.log('\n' + (fails ? `ПРОВАЛОВ: ${fails}` : 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ'));
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
});
