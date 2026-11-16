'use strict';
/**
 * Браузерный режим (без Electron): `npm run web`
 * Открывает панель в обычном браузере на http://localhost:7777
 * Полезно, если не хочется ставить Electron, или чтобы управлять серверами с телефона в домашней сети.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { ServerManager } = require('./core/manager');
const { LoadTest, normalizeActions } = require('./core/loadtest');
const { nearestProtocol, versions: protoVersions } = require('./core/proto');
const { scanServers, listRoots } = require('./core/scan');
const backup = require('./core/backup');
const playersCore = require('./core/players');
const kernels = require('./core/kernels');
const files = require('./core/files');
const archive = require('./core/archive');
const modrinth = require('./core/modrinth');
const ports = require('./core/ports');
const addons = require('./core/addons');
const opener = require('./core/opener');
const pkgVersion = () => { try { return require('./package.json').version; } catch { return '0.0.0'; } };
const { readJson, writeJson } = require('./core/store');

const PORT = Number(process.env.PORT || 7777);
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'servers.json');
const dataDir = () => DATA_DIR;
const backupsDir = (id) => path.join(DATA_DIR, 'backups', id);
const tpsFile = (id) => path.join(DATA_DIR, 'tps', String(id).replace(/[^\w-]/g, '_') + '.json');
const UI_DIR = path.join(__dirname, 'ui');

let servers = readJson(DATA_FILE, null);
if (!Array.isArray(servers)) {
  servers = readJson(path.join(__dirname, 'servers.example.json'), []).map((s) => ({
    ...s, id: require('crypto').randomUUID(),
  }));
}

const manager = new ServerManager({
  servers,
  save: (list) => writeJson(DATA_FILE, list),
  tpsStore: {
    load: (id) => readJson(tpsFile(id), []),
    save: (id, points) => writeJson(tpsFile(id), points),
  },
});

/* --------------------------- SSE-подписчики --------------------------- */
const clients = new Set();
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}
manager.on('log', (p) => broadcast('log', p));
manager.on('state', (p) => broadcast('state', p));
manager.on('servers', (p) => broadcast('servers', p));
manager.on('logs-cleared', (p) => broadcast('logs-cleared', p));
manager.on('tps', (p) => broadcast('tps', p));
manager.on('metrics', (p) => broadcast('metrics', p));

/* --------------------- нагрузочные боты (браузер) --------------------- */
const loadTests = new Map();

function loadPortOf(srv) {
  try {
    const file = path.join(srv.cwd || '', 'server.properties');
    const text = fs.readFileSync(file, 'utf8');
    const m = text.match(/^server-port=(\d+)/m);
    if (m) return Number(m[1]);
  } catch { /* файла нет — стандартный порт */ }
  return 25565;
}

function mcVersionOf(srv) {
  if (srv.mcVersion) return String(srv.mcVersion);
  const cwd = srv.cwd || '';
  try {
    const vj = path.join(cwd, 'version.json');
    if (fs.existsSync(vj)) {
      const data = JSON.parse(fs.readFileSync(vj, 'utf8'));
      if (data && data.id) return String(data.id);
    }
  } catch { /* нет файла */ }
  try {
    for (const jar of fs.readdirSync(cwd).filter((f) => /\.jar$/i.test(f))) {
      const m = jar.match(/(\d+\.\d+(?:\.\d+)?)/);
      if (m) return m[1];
    }
  } catch { /* папка недоступна */ }
  return '';
}

function startLoadTest(srv, opts) {
  const test = new LoadTest({ serverMetrics: () => {
    const st = manager.status(srv.id);
    return { cpu: st.metrics ? st.metrics.cpu : null, rss: st.metrics ? st.metrics.rss : null, tps: st.tps != null ? st.tps : null };
  } });
  test.on('log', (line) => broadcast('load:log', { id: srv.id, line }));
  test.on('change', (status) => broadcast('load:change', { id: srv.id, status }));
  test.on('done', (report) => broadcast('load:done', { id: srv.id, report }));
  loadTests.set(srv.id, test);
  test.start({
    host: (opts && opts.host) || '127.0.0.1',
    port: Number(opts && opts.port) || loadPortOf(srv),
    version: (opts && opts.version) || mcVersionOf(srv),
    protocol: Number(opts && opts.protocol) || 0,
    count: opts && opts.count,
    rampMs: opts && opts.rampMs,
    durationMs: opts && opts.durationMs,
    prefix: opts && opts.prefix,
    respawn: !(opts && opts.respawn === false),
    actions: normalizeActions(opts && opts.actions),
    serverName: srv.name,
  });
  return test;
}

/* ------------------------------ статика ------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 5e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (p === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (p === '/api/servers' && req.method === 'GET') return sendJson(res, 200, manager.list());

  /* ── сканер серверов ── */
  let scanCancelled = false;
  if (p === '/api/scan/roots') return sendJson(res, 200, listRoots());
  if (p === '/api/scan/cancel') { scanCancelled = true; return sendJson(res, 200, { ok: true }); }
  if (p === '/api/scan/start' && req.method === 'POST') {
    try {
    const body = await readBody(req);
    scanCancelled = false;
    const roots = Array.isArray(body.roots) && body.roots.length ? body.roots : listRoots();
    const maxDepth = Number(body.maxDepth) > 0 ? Math.min(Number(body.maxDepth), 8) : 4;
    const known = new Set(manager.list().map((s) => (s.cwd || '').toLowerCase()));
    const results = await scanServers({
      roots,
      maxDepth,
      ignorePaths: [__dirname],
      types: Array.isArray(body.types) && body.types.length ? body.types : null,
      isCancelled: () => scanCancelled,
      onFound: (f) => broadcast('scan-found', { ...f, added: known.has(f.path.toLowerCase()) }),
      onProgress: (pr) => broadcast('scan-progress', pr),
    });
    for (const f of results) f.added = known.has(f.path.toLowerCase());
    return sendJson(res, 200, results);
    } catch (e) {
      return sendJson(res, 500, { error: e.message, found: [] });
    }
  }
  if (p === '/api/autostart') return sendJson(res, 200, { supported: false });

  /* ── server.properties и внешний редактор ── */
  if (p === '/api/props') {
    const srv = manager.get(url.searchParams.get('id'));
    if (!srv || !srv.cwd) return sendJson(res, 200, { ok: false, error: 'Сервер не найден' });
    try {
      if (req.method === 'POST') {
        const body = await readBody(req);
        return sendJson(res, 200, { ok: true, ...(await files.writeServerProperties(srv.cwd, body)) });
      }
      return sendJson(res, 200, { ok: true, ...(await files.readServerProperties(srv.cwd)) });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }
  /* ── Modrinth ── */
  if (p === '/api/modrinth/search') {
    try {
      const q = url.searchParams;
      const hits = await modrinth.search({
        query: q.get('query') || '',
        type: q.get('type') || 'plugin',
        loader: q.get('loader') || '',
        version: q.get('version') || '',
        category: q.get('category') || '',
        sort: q.get('sort') || 'relevance',
        offset: Number(q.get('offset') || 0),
        limit: Number(q.get('limit') || 20),
      });
      return sendJson(res, 200, hits);
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: e.message });
    }
  }
  if (p === '/api/modrinth/info') {
    const srv = manager.get(url.searchParams.get('id'));
    if (!srv || !srv.cwd) return sendJson(res, 200, { ok: false, error: 'Сервер не найден' });
    return sendJson(res, 200, { ok: true, ...modrinth.detect(srv.cwd), ...modrinth.installed(srv.cwd) });
  }
  if (p === '/api/modrinth/install' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const srv = manager.get(body.id);
      if (!srv || !srv.cwd) return sendJson(res, 200, { ok: false, error: 'Сервер не найден' });
      const r = await modrinth.install(srv.cwd, body);
      return sendJson(res, 200, r);
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: e.message });
    }
  }
  if (p === '/api/addons/list') {
    return sendJson(res, 200, addons.list(dataDir()));
  }
  if (p === '/api/addons/toggle' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      return sendJson(res, 200, addons.setEnabled(dataDir(), body.id, !!body.on));
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: e.message });
    }
  }
  if (p === '/api/addons/panel') {
    return sendJson(res, 200, addons.panel(dataDir(), url.searchParams.get('id')));
  }
  if (p === '/api/addons/call' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const item = addons.list(dataDir()).find((x) => x.id === body.id && x.enabled);
      if (!item) return sendJson(res, 200, { ok: false, error: 'Аддон выключен' });
      const srv = manager.get(body.serverId);
      if (!srv || !srv.cwd) return sendJson(res, 200, { ok: false, error: 'Сервер не найден' });
      const perms = item.permissions || [];
      const a = Array.isArray(body.args) ? body.args : [];
      const method = String(body.method || '');
      if (['list', 'read', 'write', 'props'].includes(method)) {
        if (!perms.includes('files')) return sendJson(res, 200, { ok: false, error: 'Аддону не разрешены файлы' });
      }
      if (method === 'command' && !perms.includes('command')) return sendJson(res, 200, { ok: false, error: 'Аддону не разрешена консоль' });
      if (method === 'list') return sendJson(res, 200, { ok: true, data: await files.listDir(srv.cwd, String(a[0] || '')) });
      if (method === 'read') return sendJson(res, 200, { ok: true, data: await files.readFile(srv.cwd, String(a[0] || '')) });
      if (method === 'write') return sendJson(res, 200, { ok: true, data: await files.writeFile(srv.cwd, String(a[0] || ''), String(a[1] == null ? '' : a[1])) });
      if (method === 'props') return sendJson(res, 200, { ok: true, data: await files.writeServerProperties(srv.cwd, a[0] || {}) });
      if (method === 'command') {
        if (!srv.state || srv.state !== 'running') return sendJson(res, 200, { ok: false, error: 'Сервер не запущен' });
        manager.sendCommand(srv.id, String(a[0] || ''));
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 200, { ok: false, error: 'Аддону неизвестно действие: ' + method });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: e.message });
    }
  }
  if (p === '/api/ports/check') {
    try {
      const srv = manager.get(url.searchParams.get('id'));
      if (!srv || !srv.cwd) return sendJson(res, 200, { ok: false, error: 'Сервер не найден' });
      const busyList = [];
      for (const other of manager.list()) {
        if (other.id === srv.id || other.state === 'stopped' || !other.cwd) continue;
        try { busyList.push({ id: other.id, name: other.name, ports: await ports.own(other.cwd) }); } catch { /* ignore */ }
      }
      return sendJson(res, 200, await ports.check(srv.cwd, busyList));
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: e.message });
    }
  }
  if (p === '/api/ports/free') {
    try {
      const srv = manager.get(url.searchParams.get('id'));
      if (!srv || !srv.cwd) return sendJson(res, 200, { ok: false, error: 'Сервер не найден' });
      const taken = [];
      for (const other of manager.list()) {
        if (other.id === srv.id || other.state === 'stopped' || !other.cwd) continue;
        try { for (const x of await ports.own(other.cwd)) taken.push(x.port); } catch { /* ignore */ }
      }
      const port = await ports.freePort(Number(url.searchParams.get('from') || 0), taken);
      return sendJson(res, 200, { ok: !!port, port });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: e.message });
    }
  }
  if (p === '/api/ports/set' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const srv = manager.get(body.id);
      if (!srv || !srv.cwd) return sendJson(res, 200, { ok: false, error: 'Сервер не найден' });
      return sendJson(res, 200, await ports.set(srv.cwd, body.key, body.port));
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: e.message });
    }
  }
  if (p === '/api/files/upload' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const srv = manager.get(body.id);
      if (!srv || !srv.cwd) return sendJson(res, 200, { ok: false, error: 'Сервер не найден' });
      const dir = files.resolveSafe(srv.cwd, body.rel || '');
      fs.mkdirSync(dir, { recursive: true });
      const name = path.basename(String(body.name || 'file')).replace(/[\\/:*?"<>|]+/g, '_');
      const dest = path.join(dir, name);
      const buf = Buffer.from(String(body.data || ''), 'base64');
      fs.writeFileSync(dest, buf);
      return sendJson(res, 200, { ok: true, name, size: buf.length });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: e.message });
    }
  }
  if (p === '/api/wall/palette') {
    return sendJson(res, 200, { ok: false, error: 'Подбор цвета работает только в exe-версии' });
  }

  if (p === '/api/server/editor' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const srv = body.id ? manager.get(body.id) : null;
      const target = srv ? srv.cwd : body.path;
      if (!target) return sendJson(res, 200, { ok: false, error: 'Нет пути' });
      return sendJson(res, 200, { path: target, ...(await opener.openInEditor(target)) });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: e.message });
    }
  }
  if (p === '/api/icon/to' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      if (!body.cwd || !body.dataUrl) return sendJson(res, 200, { ok: false, error: 'Нет папки или иконки' });
      const base64 = String(body.dataUrl).replace(/^data:image\/png;base64,/, '');
      fs.writeFileSync(path.join(body.cwd, 'server-icon.png'), Buffer.from(base64, 'base64'));
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: e.message });
    }
  }

  /* ── редактор файлов ── */
  if (p.startsWith('/api/files/')) {
    const action = p.slice('/api/files/'.length);
    const id = url.searchParams.get('id');
    const rel = url.searchParams.get('rel') || '';
    const srv = manager.get(id);
    const rootOk = () => {
      if (!srv) throw new Error('Сервер не найден');
      if (!srv.cwd) throw new Error('У сервера не задана рабочая папка');
      return srv.cwd;
    };
    try {
      if (action === 'list') return sendJson(res, 200, await files.listDir(rootOk(), rel));
      if (action === 'read') return sendJson(res, 200, await files.readFile(rootOk(), rel));
      if (action === 'editor') {
        const body = req.method === 'POST' ? await readBody(req) : {};
        const target = files.resolveSafe(rootOk(), body.rel || rel);
        return sendJson(res, 200, await opener.openInEditor(target));
      }
      if (action === 'search') return sendJson(res, 200, { results: await files.search(rootOk(), url.searchParams.get('q') || '') });
      if (action === 'image') return sendJson(res, 200, await files.readImage(rootOk(), rel));
      if (action === 'archive') return sendJson(res, 200, await archive.open(rootOk(), rel));
      if (req.method === 'POST') {
        const body = await readBody(req);
        const relBody = body.rel || rel;
        if (action === 'write') return sendJson(res, 200, await files.writeFile(rootOk(), relBody, body.content));
        if (action === 'mkdir') return sendJson(res, 200, await files.mkdir(rootOk(), relBody));
        if (action === 'remove') return sendJson(res, 200, await files.remove(rootOk(), relBody));
        if (action === 'rename') return sendJson(res, 200, await files.rename(rootOk(), relBody, body.name));
        if (action === 'move') return sendJson(res, 200, await files.move(rootOk(), relBody, body.toDir || ''));
        if (action === 'archiveRead') return sendJson(res, 200, await archive.readEntry(rootOk(), relBody, body.name));
        if (action === 'archiveExtract') {
          return sendJson(res, 200, await archive.extract(rootOk(), relBody, body.destRel || '', body.onlyName || ''));
        }
      }
      return sendJson(res, 404, { error: 'Неизвестное действие' });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  /* ── мастер создания сервера (браузерный режим) ── */
  if (p === '/api/wizard/catalog') return sendJson(res, 200, kernels.catalog());
  if (p === '/api/wizard/versions') {
    try {
      return sendJson(res, 200, await kernels.versions(url.searchParams.get('id')));
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }
  if (p === '/api/wizard/java') return sendJson(res, 200, await kernels.detectJava());
  if (p === '/api/wizard/create' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const result = await kernels.createServer(body, (payload) => broadcast('wizard-progress', payload));
      return sendJson(res, 200, { ok: true, ...result });
    } catch (e) {
      broadcast('wizard-progress', { stage: 'error', text: e.message });
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  /* ── бэкапы ── */
  const bm = p.match(/^\/api\/servers\/([^/]+)\/backups(?:\/(\w+))?$/);
  if (bm) {
    const [, id, action] = bm;
    const srv = manager.get(id);
    if (!srv) return sendJson(res, 404, { error: 'Сервер не найден' });
    if (!srv.cwd) return sendJson(res, 400, { error: 'У сервера не задана рабочая папка' });

    try {
      if (!action && req.method === 'GET') return sendJson(res, 200, backup.listBackups(backupsDir(id)));
      if (action === 'create') {
        const body = await readBody(req);
        const info = await backup.createBackup({
          srcDir: srv.cwd,
          destDir: backupsDir(id),
          label: body.name || srv.name,
          skip: body.lean === false ? [] : backup.leanSkip(),
          skipNames: body.lean === false ? [] : backup.leanNames(),
        });
        return sendJson(res, 200, { ok: true, ...info });
      }
      if (action === 'restore') {
        const body = await readBody(req);
        const wasRunning = manager.status(id).state !== 'stopped';
        if (wasRunning) {
          manager.stop(id);
          const t0 = Date.now();
          while (manager.status(id).state !== 'stopped' && Date.now() - t0 < 30000) {
            await new Promise((r) => setTimeout(r, 300));
          }
          if (manager.status(id).state !== 'stopped') manager.kill(id);
          await new Promise((r) => setTimeout(r, 800));
        }
        let safety = null;
        if (body.safety !== false) {
          try {
            safety = await backup.createBackup({ srcDir: srv.cwd, destDir: backupsDir(id), label: (srv.name || 'server') + '_before_restore' });
          } catch { /* ignore */ }
        }
        await backup.restoreBackup({ file: body.file, destDir: srv.cwd });
        if (body.startAfter && wasRunning) manager.start(id);
        return sendJson(res, 200, { ok: true, safety });
      }
      if (action === 'delete') {
        const body = await readBody(req);
        return sendJson(res, 200, { ok: backup.deleteBackup(body.file) });
      }
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  /* блокировки: список и снятие */
  const bansMatch = p.match(/^\/api\/servers\/([^/]+)\/bans(?:\/(\w+))?$/);
  if (bansMatch) {
    const [, id, action] = bansMatch;
    const srv = manager.get(id);
    if (!srv) return sendJson(res, 404, { error: 'Сервер не найден' });
    if (req.method === 'GET') {
      return sendJson(res, 200, srv.cwd ? playersCore.listBans(srv.cwd) : { players: [], ips: [] });
    }
    const body = await readBody(req);
    if (action === 'ban') {
      if (manager.status(id).state !== 'running') {
        return sendJson(res, 400, { ok: false, error: 'Сервер остановлен — забанить можно только на запущенном' });
      }
      const reason = String(body.reason || '').trim();
      const cmd = `ban ${body.name}${reason ? ' ' + reason : ''}`;
      manager.sendCommand(id, cmd, { silent: true });
      return sendJson(res, 200, { ok: true, text: cmd });
    }
    if (action === 'unban') {
      if (manager.status(id).state === 'running') {
        manager.sendCommand(id, playersCore.unbanCommand(body), { silent: true });
        return sendJson(res, 200, { ok: true, via: 'command' });
      }
      return sendJson(res, 200, playersCore.unbanOffline(srv.cwd, body));
    }
    return sendJson(res, 404, { error: 'Неизвестное действие' });
  }

  /* ── нагрузочные боты ── */
  if (p === '/api/load/versions') {
    return sendJson(res, 200, protoVersions().sort((a, b) => b.protocol - a.protocol));
  }
  if (p === '/api/load/info') {
    const srv = manager.get(url.searchParams.get('id'));
    if (!srv) return sendJson(res, 404, { ok: false, error: 'Сервер не найден' });
    const saved = srv.loadtest || {};
    const test = loadTests.get(srv.id);
    return sendJson(res, 200, {
      ok: true,
      host: saved.host || '127.0.0.1',
      port: saved.port || loadPortOf(srv),
      version: saved.version || mcVersionOf(srv),
      count: Number(saved.count) > 0 ? Number(saved.count) : 5,
      rampMs: Number(saved.rampMs) || 3000,
      durationMs: Number(saved.durationMs) || 0,
      prefix: saved.prefix || 'Bot',
      actions: normalizeActions(saved.actions || {}),
      running: !!(test && test.running),
      status: test ? test.status() : null,
    });
  }
  if (p === '/api/load/start' && req.method === 'POST') {
    const srv = manager.get(url.searchParams.get('id'));
    if (!srv) return sendJson(res, 404, { ok: false, error: 'Сервер не найден' });
    const runningTest = loadTests.get(srv.id);
    if (runningTest && runningTest.running) return sendJson(res, 200, { ok: false, error: 'тест уже идёт' });
    const body = await readBody(req);
    try {
      const test = startLoadTest(srv, body);
      try {
        manager.update(srv.id, { loadtest: { ...body, actions: normalizeActions(body.actions), protocol: 0 } });
      } catch { /* настройки не сохранились — не беда */ }
      return sendJson(res, 200, { ok: true, status: test.status() });
    } catch (err) {
      return sendJson(res, 200, { ok: false, error: err.message });
    }
  }
  if (p === '/api/load/stop') {
    const srv = manager.get(url.searchParams.get('id'));
    const test = srv && loadTests.get(srv.id);
    if (!test || !test.running) return sendJson(res, 200, { ok: false, error: 'тест не идёт' });
    return sendJson(res, 200, { ok: true, report: test.stop('остановлено вручную') });
  }
  if (p === '/api/load/status') {
    const srv = manager.get(url.searchParams.get('id'));
    const test = srv && loadTests.get(srv.id);
    return sendJson(res, 200, { ok: true, running: !!(test && test.running), status: test ? test.status() : null });
  }

  const tm = p.match(/^\/api\/servers\/([^/]+)\/tps(?:\/(\w+))?$/);
  if (tm) {
    const [, id, action] = tm;
    if (action === 'clear') return sendJson(res, 200, { ok: manager.clearTpsHistory(id) });
    return sendJson(res, 200, manager.tpsHistory(id));
  }

  // иконка сервера из папки (server-icon.png и т.п.)
  if (p === '/api/icon') {
    const cwd = url.searchParams.get('cwd') || '';
    const names = ['server-icon.png', 'icon.png', 'logo.png', 'server-icon.jpg'];
    for (const name of names) {
      const file = path.join(cwd, name);
      try {
        if (!fs.existsSync(file)) continue;
        const st = fs.statSync(file);
        if (st.size > 2 * 1024 * 1024) continue;
        const ext = path.extname(file).slice(1).toLowerCase() || 'png';
        const mime = ext === 'jpg' ? 'jpeg' : ext;
        return sendJson(res, 200, { dataUrl: `data:image/${mime};base64,${fs.readFileSync(file).toString('base64')}` });
      } catch { /* следующий */ }
    }
    return sendJson(res, 404, { error: 'server-icon.png не найден' });
  }

  // проверка существования пути (папки/файла) на этом ПК
  if (p === '/api/checkPath') {
    const target = url.searchParams.get('path') || '';
    try {
      const st = fs.statSync(target);
      return sendJson(res, 200, { exists: true, isDir: st.isDirectory(), isFile: st.isFile() });
    } catch {
      return sendJson(res, 200, { exists: false });
    }
  }

  // открыть папку сервера в системном проводнике
  if (p === '/api/open' && req.method === 'POST') {
    const body = await readBody(req);
    const target = body.path || '';
    if (!target || !fs.existsSync(target)) return sendJson(res, 400, { ok: false, error: 'Папка не найдена: ' + target });
    const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    execFile(cmd, [target], () => {});
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/info') {
    const os = require('os');
    return sendJson(res, 200, {
      mode: 'web', platform: process.platform, configPath: DATA_FILE, version: pkgVersion(),
      home: os.homedir() + (process.platform === 'win32' ? '\\Servers' : '/Servers'),
      sep: process.platform === 'win32' ? '\\' : '/',
    });
  }

  const m = p.match(/^\/api\/servers(?:\/([^/]+))?(?:\/(\w+))?$/);
  if (m) {
    const [, id, action] = m;
    const body = req.method === 'POST' ? await readBody(req) : {};

    try {
      if (!id && req.method === 'POST') return sendJson(res, 200, manager.add(body));
      if (id && !action && req.method === 'POST') return sendJson(res, 200, manager.update(id, body));
      if (id && !action && req.method === 'DELETE') return sendJson(res, 200, { ok: manager.remove(id) });
      if (action === 'startAll') { manager.startAll(); return sendJson(res, 200, { ok: true }); }
      if (action === 'stopAll') { manager.stopAll(); return sendJson(res, 200, { ok: true }); }
      if (action === 'restartAll') { manager.restartAll(); return sendJson(res, 200, { ok: true }); }
      if (id && action === 'start') return sendJson(res, 200, manager.start(id));
      if (id && action === 'stop') return sendJson(res, 200, manager.stop(id));
      if (id && action === 'restart') return sendJson(res, 200, manager.restart(id));
      if (id && action === 'kill') return sendJson(res, 200, manager.kill(id));
      if (id && action === 'command') return sendJson(res, 200, { ok: manager.sendCommand(id, body.cmd) });
      if (id && action === 'logs') return sendJson(res, 200, manager.logs(id));
      if (id && action === 'clearLogs') return sendJson(res, 200, { ok: manager.clearLogs(id) ?? true });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    return sendJson(res, 404, { error: 'not found' });
  }

  // статические файлы
  const file = path.join(UI_DIR, p === '/' ? 'index.html' : p.replace(/^\/+/, ''));
  if (!file.startsWith(UI_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  const ips = Object.values(nets).flat().filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address);
  console.log(`\n  OmniPanel (браузерный режим)`);
  console.log(`  Локально:  http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  В сети:    http://${ip}:${PORT}`);
  console.log(`  Конфиг:    ${DATA_FILE}\n`);
  manager.startAutostart();
});

process.on('SIGINT', () => {
  manager.shutdownAll();
  setTimeout(() => process.exit(0), 1200);
});
