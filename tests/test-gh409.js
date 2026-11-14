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

  /* ── режим «одним архивом, как бэкап» ── */
  state.commits = 0;
  state.refs.clear();
  state.trees.clear();
  state.calls.length = 0;
  const archOpts = { ...opts, mode: 'archive', repo: 'friend/archive-server', stateFile: path.join(stateDir, 'state2.json') };
  const archPush = await github.push(archOpts);
  assert.strictEqual(archPush.ok, true, 'отправка архивом: ' + archPush.error);
  assert.ok(archPush.archive && /\.zip$/.test(archPush.archive), 'собран zip сервера');
  assert.ok(archPush.size > 0, 'размер архива известен');
  const archTree = state.trees.get(state.trees.get('commit:' + state.refs.get('main')).tree) || [];
  assert.ok(archTree.some((e) => /\.omnipanel\/сервер\.zip$/.test(e.path)), 'в репозитории один файл сервера');
  assert.ok(archTree.some((e) => /манифест\.json$/.test(e.path)), 'манифест бэкапа на месте');

  /* второй прогон — «нечего отправлять» */
  const archAgain = await github.push(archOpts);
  assert.strictEqual(archAgain.ok, true, 'повтор архивом: ' + archAgain.error);
  assert.strictEqual(archAgain.upToDate, true, 'архив не изменился — отправлять нечего');

  /* забираем архив на «другую машину» */
  const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh409-other-'));
  const archPull = await github.pull({
    dir: otherDir,
    repo: 'friend/archive-server',
    branch: 'main',
    token: 'test-token',
    stateFile: path.join(stateDir, 'state3.json'),
    mode: 'archive',
  });
  assert.strictEqual(archPull.ok, true, 'забрать архив: ' + archPull.error);
  assert.strictEqual(fs.readFileSync(path.join(otherDir, 'server.properties'), 'utf8'), 'level-name=world\n',
    'server.properties восстановлен из архива');
  assert.strictEqual(fs.readFileSync(path.join(otherDir, 'world', 'level.dat'), 'utf8'), 'мир изменился',
    'мир восстановлен из архива');

  console.log('409 на пустом репозитории: первый коммит создан через Contents API, вторая отправка обычная — ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
  console.log('режим «одним архивом»: отправка, «нечего отправлять», распаковка на другой машине — ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
  server.close();
})().catch((err) => {
  console.error('ОШИБКА:', err.message);
  server.close();
  process.exit(1);
});
