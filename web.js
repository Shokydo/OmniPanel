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
const { scanServers, listRoots } = require('./core/scan');
const backup = require('./core/backup');
const kernels = require('./core/kernels');
const files = require('./core/files');
const opener = require('./core/opener');
const pkgVersion = () => { try { return require('./package.json').version; } catch { return '0.0.0'; } };
const { readJson, writeJson } = require('./core/store');

const PORT = Number(process.env.PORT || 7777);
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'servers.json');
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

  /* ── server.properties и VS Code ── */
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
  if (p === '/api/server/vscode' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const srv = body.id ? manager.get(body.id) : null;
      const target = srv ? srv.cwd : body.path;
      if (!target) return sendJson(res, 200, { ok: false, error: 'Нет пути' });
      return sendJson(res, 200, { path: target, ...(await opener.openInVSCode(target)) });
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
      if (action === 'vscode') {
        const body = req.method === 'POST' ? await readBody(req) : {};
        const target = files.resolveSafe(rootOk(), body.rel || rel);
        return sendJson(res, 200, await opener.openInVSCode(target));
      }
      if (action === 'search') return sendJson(res, 200, { results: await files.search(rootOk(), url.searchParams.get('q') || '') });
      if (req.method === 'POST') {
        const body = await readBody(req);
        const relBody = body.rel || rel;
        if (action === 'write') return sendJson(res, 200, await files.writeFile(rootOk(), relBody, body.content));
        if (action === 'mkdir') return sendJson(res, 200, await files.mkdir(rootOk(), relBody));
        if (action === 'remove') return sendJson(res, 200, await files.remove(rootOk(), relBody));
        if (action === 'rename') return sendJson(res, 200, await files.rename(rootOk(), relBody, body.name));
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
        const info = await backup.createBackup({ srcDir: srv.cwd, destDir: backupsDir(id), label: body.name || srv.name });
        return sendJson(res, 200, info);
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
