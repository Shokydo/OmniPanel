'use strict';
/**
 * Проверка отправки в ПУСТОЙ репозиторий (ошибка 409 «Git Repository is empty»).
 *
 * Настоящий GitHub для этого не нужен: тест поднимает локальный сервер,
 * который ведёт себя как GitHub — пока в репозитории нет коммитов, он
 * отвечает 409 на /git/trees, /git/commits и /git/refs, а первый коммит
 * создаётся только через Contents API (PUT /contents/...).
 *
 * Запуск: node tests/test-gh409.js
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const state = { commits: 0, refs: new Map(), trees: new Map(), blobs: new Map(), calls: [] };
let nextSha = 0;
let tagNum = 0xab;
const sha = () => ((++nextSha).toString(16) + (tagNum++).toString(16) + '0'.repeat(40)).slice(0, 40);

function body(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const json = (code, data) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  state.calls.push(`${req.method} ${p}`);
  const empty = state.commits === 0;
  const emptyErr = () => json(409, { message: 'Git Repository is empty.' });

  if (req.method === 'GET' && /\/git\/ref\/heads\//.test(p)) {
    if (empty) return emptyErr();
    const ref = state.refs.get(p.split('/heads/')[1]);
    if (!ref) return json(404, { message: 'Not Found' });
    return json(200, { ref: 'refs/heads/' + p.split('/heads/')[1], object: { sha: ref } });
  }
  if (req.method === 'POST' && p.endsWith('/git/blobs')) {
    const b = await body(req);
    const buf = Buffer.from(b.content || '', 'base64');
    /* настоящий git-хеш blob — чтобы панель сравнивала файлы как с GitHub */
    const s = require('crypto').createHash('sha1')
      .update(`blob ${buf.length}\0`).update(buf).digest('hex');
    state.blobs.set(s, b.content);
    return json(201, { sha: s });
  }
  if (req.method === 'GET' && /\/git\/blobs\/[0-9a-f]+$/.test(p)) {
    const sha = p.split('/').pop();
    const content = state.blobs.get(sha);
    if (!content) return json(404, { message: 'Not Found' });
    return json(200, { sha, content, encoding: 'base64' });
  }
  if (req.method === 'POST' && p.endsWith('/git/trees')) {
    if (empty) return emptyErr();
    const b = await body(req);
    const s = sha();
    /* как настоящий GitHub: base_tree дополняется новыми записями,
       а записи с sha: null удаляются */
    const merged = new Map();
    if (b.base_tree) for (const e of (state.trees.get(b.base_tree) || [])) merged.set(e.path, e);
    for (const e of (b.tree || [])) {
      if (e.sha === null) merged.delete(e.path);
      else merged.set(e.path, { path: e.path, type: 'blob', sha: e.sha, mode: e.mode || '100644' });
    }
    const list = [...merged.values()];
    state.trees.set(s, list);
    return json(201, { sha: s, tree: list });
  }
  if (req.method === 'POST' && p.endsWith('/git/commits')) {
    if (empty) return emptyErr();
    const b = await body(req);
    const s = sha();
    state.commits += 1;
    state.trees.set('commit:' + s, { tree: b.tree, parents: b.parents || [] });
    return json(201, { sha: s, tree: { sha: b.tree } });
  }
  if (req.method === 'GET' && /\/git\/commits\/[0-9a-f]+$/.test(p)) {
    const s = p.split('/').pop();
    const info = state.trees.get('commit:' + s);
    if (!info) return json(404, { message: 'Not Found' });
    return json(200, { sha: s, tree: { sha: info.tree }, parents: info.parents.map((x) => ({ sha: x })) });
  }
  if (req.method === 'GET' && /\/git\/trees\/[0-9a-f]+/.test(p)) {
    const s = p.split('/git/trees/')[1].split('?')[0];
    const list = state.trees.get(s) || [];
    return json(200, { sha: s, tree: list.map((e) => ({ path: e.path, type: e.type || 'blob', sha: e.sha, size: 1 })) });
  }
  if (req.method === 'POST' && p.endsWith('/git/refs')) {
    if (empty) return emptyErr();
    const b = await body(req);
    state.refs.set(b.ref.replace('refs/heads/', ''), b.sha);
    return json(201, { ref: b.ref, object: { sha: b.sha } });
  }
  if (req.method === 'PATCH' && /\/git\/refs\/heads\//.test(p)) {
    if (empty) return emptyErr();
    const b = await body(req);
    state.refs.set(p.split('/heads/')[1], b.sha);
    return json(200, { object: { sha: b.sha } });
  }
  /* Contents API — единственный путь создать первый коммит */
  if (p.includes('/contents/')) {
    if (req.method === 'GET') {
      if (empty) return emptyErr();
      return json(404, { message: 'Not Found' });
    }
    if (req.method === 'PUT') {
      const b = await body(req);
      const treeSha = sha();
        state.trees.set(treeSha, [{ path: decodeURIComponent(p.split('/contents/')[1]), type: 'blob', sha: sha(), mode: '100644' }]);
      const commitSha = sha();
      state.commits += 1;
      state.trees.set('commit:' + commitSha, { tree: treeSha, parents: [] });
      state.refs.set(b.branch || 'main', commitSha);
      return json(201, { content: { sha: 'x' }, commit: { sha: commitSha } });
    }
  }
  console.log('НЕИЗВЕСТНЫЙ ЗАПРОС', req.method, req.url);
  return json(404, { message: 'Not Found: ' + p });
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.OMNI_GITHUB_API = `http://127.0.0.1:${server.address().port}`;
  const github = require('../core/github');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh409-'));
  fs.mkdirSync(path.join(dir, 'world'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'server.properties'), 'level-name=world\n');
  fs.writeFileSync(path.join(dir, 'world', 'level.dat'), Buffer.from('данные мира'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh409-state-'));
  const stateFile = path.join(stateDir, 'state.json');
  const opts = {
    dir,
    repo: 'friend/empty-server',
    branch: 'main',
    token: 'test-token',
    scope: 'all',
    mode: 'files',
    stateFile,
    message: 'OmniPanel: проверка',
  };

  const logs = [];
  const first = await github.push({ ...opts, onLog: (t) => logs.push(t) });
  assert.strictEqual(first.ok, true, 'отправка в пустой репозиторий: ' + first.error);
  assert.ok(first.commit, 'должен быть коммит');
  assert.ok(logs.some((l) => /пустой/i.test(l)), 'в логах должно быть сообщение о первом коммите');
  assert.ok(state.calls.some((c) => c.startsWith('PUT') && c.includes('/contents/')), 'первый коммит — через Contents API');
  assert.ok(state.refs.get('main'), 'ветка main появилась');
  const firstCommit = first.commit;

  /* вторая отправка идёт обычным путём, без Contents API */
  const before = state.calls.filter((c) => c.startsWith('PUT')).length;
  fs.writeFileSync(path.join(dir, 'world', 'level.dat'), Buffer.from('мир изменился'));
  const second = await github.push(opts);
  assert.strictEqual(second.ok, true, 'вторая отправка: ' + second.error);
  assert.notStrictEqual(second.commit, firstCommit, 'второй коммит должен быть новым');
  assert.strictEqual(state.calls.filter((c) => c.startsWith('PUT')).length, before, 'Contents API больше не нужен');
  assert.strictEqual(state.refs.get('main'), second.commit, 'ветка сдвинулась на новый коммит');

  /* pull после успешной отправки — забирать нечего */
  const pullRes = await github.pull({ ...opts });
  assert.strictEqual(pullRes.ok, true, 'pull: ' + pullRes.error);
  assert.strictEqual(pullRes.upToDate, true, 'после отправки забирать нечего');

  /* повторная отправка без изменений — «отправлять нечего» */
  const third = await github.push(opts);
  assert.strictEqual(third.ok, true);
  assert.strictEqual(third.upToDate, true, 'нечего отправлять');

  /* ── пересылка одним архивом: архивация → GitHub → распаковка ── */
  state.commits = 0;
  state.refs.clear();
  state.trees.clear();
  state.calls.length = 0;
  /* чуть «мяса», чтобы архив действительно сжимал: конфиги плагина с повторами */
  fs.mkdirSync(path.join(dir, 'plugins', 'MyPlugin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugins', 'MyPlugin', 'config.yml'),
    'settings:\n  enabled: true\n  interval: 20\n  worlds:\n    - world\n    - world_nether\n'.repeat(400));
  const archOpts = { ...opts, mode: 'archive', repo: 'friend/archive-server', stateFile: path.join(stateDir, 'state2.json') };
  const archLogs = [];
  const archPush = await github.push({ ...archOpts, onLog: (t) => archLogs.push(t) });
  assert.strictEqual(archPush.ok, true, 'отправка архивом: ' + archPush.error);
  assert.ok(/\.7z$/.test(archPush.archive), 'собран архив 7z: ' + archPush.archive);
  assert.strictEqual(archPush.format, '7z', 'формат архива — 7z');
  assert.ok(archPush.size > 0, 'размер архива известен');
  assert.ok(archPush.raw > archPush.size * 3, 'архив заметно меньше исходника: ' + archPush.size + ' из ' + archPush.raw);
  assert.ok(archLogs.some((l) => /шаг 1 из 2: архивирую/.test(l)), 'первый шаг — архивация', archLogs.join(' | ').slice(0, 120));
  assert.ok(archLogs.some((l) => /шаг 2 из 2: отправляю архив на GitHub/.test(l)), 'второй шаг — отправка');
  assert.ok(archLogs.some((l) => /архив готов/.test(l)), 'в логе видно имя и плотность архива');

  const archTree = state.trees.get(state.trees.get('commit:' + state.refs.get('main')).tree) || [];
  assert.ok(archTree.some((e) => /\.omnipanel\/сервер\.7z$/.test(e.path)), 'в репозитории один файл сервера (.7z)');
  assert.ok(!archTree.some((e) => /\.omnipanel\/сервер\.zip$/.test(e.path)), 'старый zip в репозитории не остался');
  assert.ok(archTree.some((e) => /манифест\.json$/.test(e.path)), 'манифест архива на месте');
  assert.ok(!archTree.some((e) => e.path === 'server.properties'), 'пофайловых копий нет — только архив');

  /* второй прогон — «нечего отправлять» */
  const archAgain = await github.push(archOpts);
  assert.strictEqual(archAgain.ok, true, 'повтор архивом: ' + archAgain.error);
  assert.strictEqual(archAgain.upToDate, true, 'архив не изменился — отправлять нечего');

  /* забираем архив на «другую машину»: скачать и распаковать */
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh409-other-'));
  const pullLogs = [];
  const archPull = await github.pull({
    dir: otherDir,
    repo: 'friend/archive-server',
    branch: 'main',
    token: 'test-token',
    stateFile: path.join(stateDir, 'state3.json'),
    mode: 'archive',
    onLog: (t) => pullLogs.push(t),
  });
  assert.strictEqual(archPull.ok, true, 'забрать архив: ' + archPull.error);
  assert.strictEqual(archPull.format, '7z', 'распознан формат 7z');
  assert.ok(pullLogs.some((l) => /шаг 1 из 2: скачиваю архив/.test(l)), 'первый шаг забора — скачивание');
  assert.ok(pullLogs.some((l) => /шаг 2 из 2: распаковываю/.test(l)), 'второй шаг забора — распаковка');
  assert.strictEqual(fs.readFileSync(path.join(otherDir, 'server.properties'), 'utf8'), 'level-name=world\n',
    'server.properties восстановлен из архива');
  assert.strictEqual(fs.readFileSync(path.join(otherDir, 'world', 'level.dat'), 'utf8'), 'мир изменился',
    'мир восстановлен из архива');

  /* режим по умолчанию — именно архив, без указания mode */
  const { mode: _omitted, ...optsNoMode } = opts;
  const defPush = await github.push({ ...optsNoMode, repo: 'friend/default-mode', stateFile: path.join(stateDir, 'state4.json') });
  assert.strictEqual(defPush.format, '7z', 'без указания режима отправляется архив');

  /* обратная совместимость: в репозитории лежит старый zip из прошлых версий */
  const legacyRepo = 'friend/legacy-server';
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh409-legacy-'));
  fs.writeFileSync(path.join(legacyDir, 'server.properties'), 'level-name=legacy\n');
  fs.writeFileSync(path.join(legacyDir, 'motd.txt'), 'старый сервер');
  const legacyZip = path.join(stateDir, 'legacy.zip');
  await require('../core/backup').createBackup({ srcDir: legacyDir, destDir: stateDir, label: 'legacy', format: 'zip' });
  const packed = fs.readdirSync(stateDir).find((f) => /^legacy_.*\.zip$/.test(f));
  fs.renameSync(path.join(stateDir, packed), legacyZip);
  const zipBuf = fs.readFileSync(legacyZip);
  const blobRes = await fetch(`${process.env.OMNI_GITHUB_API}/repos/${legacyRepo}/git/blobs`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify({ content: zipBuf.toString('base64'), encoding: 'base64' }),
  }).then((r) => r.json());
  const treeRes = await fetch(`${process.env.OMNI_GITHUB_API}/repos/${legacyRepo}/git/trees`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify({ tree: [{ path: '.omnipanel/сервер.zip', mode: '100644', type: 'blob', sha: blobRes.sha }] }),
  }).then((r) => r.json());
  const commitRes = await fetch(`${process.env.OMNI_GITHUB_API}/repos/${legacyRepo}/git/commits`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'старая версия панели: zip', tree: treeRes.sha, parents: [] }),
  }).then((r) => r.json());
  await fetch(`${process.env.OMNI_GITHUB_API}/repos/${legacyRepo}/git/refs`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify({ ref: 'refs/heads/main', sha: commitRes.sha }),
  });

  const legacyOut = fs.mkdtempSync(path.join(os.tmpdir(), 'gh409-legacy-out-'));
  const legacyPull = await github.pull({
    dir: legacyOut, repo: legacyRepo, branch: 'main', token: 'test-token',
    stateFile: path.join(stateDir, 'state5.json'), mode: 'archive',
  });
  assert.strictEqual(legacyPull.ok, true, 'старый zip забирается: ' + legacyPull.error);
  assert.strictEqual(legacyPull.format, 'zip', 'формат распознан как zip');
  assert.strictEqual(fs.readFileSync(path.join(legacyOut, 'server.properties'), 'utf8'), 'level-name=legacy\n',
    'старый zip распакован');

  console.log('409 на пустом репозитории: первый коммит создан через Contents API, вторая отправка обычная — ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
  console.log('пересылка архивом: архивация → GitHub → скачивание и распаковка, включая старый zip и режим по умолчанию — ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
  server.close();
})().catch((err) => {
  console.error('ОШИБКА:', err.message);
  server.close();
  process.exit(1);
});
