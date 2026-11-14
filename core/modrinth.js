'use strict';
/**
 * Modrinth: поиск плагинов и модов, версии под конкретный сервер, скачивание файла
 * в папку plugins/ или mods/ этого сервера.
 *
 * Ничего не хранит: работает напрямую с api.modrinth.com.
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const API = 'https://api.modrinth.com/v2';
const UA = 'OmniPanel/1.17.1 (github.com/Shokydo/OmniPanel)';

function get(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        get(res.headers.location).then(resolve, reject);
        return;
      }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { buf += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Modrinth ответил ${res.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('Ответ Modrinth не разобрать')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(new Error('Modrinth не ответил вовремя')); });
  });
}

function facetsParam(facets) {
  return encodeURIComponent(JSON.stringify(facets));
}

/** Поиск проектов. type: 'mod' | 'plugin' | 'datapack'. */
async function search(opts = {}) {
  const type = opts.type === 'plugin' ? 'plugin' : opts.type === 'datapack' ? 'datapack' : 'mod';
  const facets = [[`project_type:${type}`]];
  if (opts.loader) facets.push([`categories:${opts.loader}`]);
  if (opts.version) facets.push([`versions:${opts.version}`]);
  if (opts.category) facets.push([`categories:${opts.category}`]);
  if (opts.side === 'server') facets.push(['server_side:required', 'server_side:optional']);

  const index = ['relevance', 'downloads', 'follows', 'newest', 'updated'].includes(opts.sort)
    ? opts.sort : 'relevance';
  const limit = Math.min(40, Math.max(5, Number(opts.limit) || 20));
  const offset = Math.max(0, Number(opts.offset) || 0);

  const url = `${API}/search?query=${encodeURIComponent(opts.query || '')}`
    + `&facets=${facetsParam(facets)}&index=${index}&limit=${limit}&offset=${offset}`;
  const data = await get(url);
  const hits = (data.hits || []).map((h) => ({
    id: h.project_id || h.slug,
    slug: h.slug,
    title: h.title,
    description: h.description,
    author: h.author,
    icon: h.icon_url,
    downloads: h.downloads,
    follows: h.follows,
    categories: h.categories || [],
    versions: (h.versions || []).slice(-6),
    updated: h.date_modified,
    type,
  }));
  return { ok: true, total: data.total_hits || hits.length, hits };
}

/** Версии проекта под лоадер и версию игры. */
async function versions(id, opts = {}) {
  const parts = [];
  if (opts.loader) parts.push(`loaders=${encodeURIComponent(JSON.stringify([opts.loader]))}`);
  if (opts.version) parts.push(`game_versions=${encodeURIComponent(JSON.stringify([opts.version]))}`);
  const url = `${API}/project/${encodeURIComponent(id)}/version${parts.length ? '?' + parts.join('&') : ''}`;
  const list = await get(url);
  const out = (Array.isArray(list) ? list : []).map((v) => ({
    id: v.id,
    name: v.name,
    number: v.version_number,
    type: v.version_type,
    gameVersions: v.game_versions || [],
    loaders: v.loaders || [],
    date: v.date_published,
    downloads: v.downloads,
    file: (v.files || []).filter((f) => f.primary)[0] || (v.files || [])[0] || null,
  })).filter((v) => v.file);
  return { ok: true, versions: out };
}

/** Теги-категории (для фильтров). */
async function categories(type = 'plugin') {
  const list = await get(`${API}/tag/category`);
  const arr = (Array.isArray(list) ? list : [])
    .filter((c) => (c.project_type || 'mod') === type && !(c.name || '').includes(':'))
    .map((c) => ({ name: c.name, label: c.name, icon: c.icon }));
  return { ok: true, categories: arr };
}

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) { reject(new Error('слишком много перенаправлений')); return; }
    const u = new URL(url);
    const req = https.get({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers: { 'User-Agent': UA, Accept: '*/*' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        download(res.headers.location, dest, redirects + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`файл не скачался (${res.statusCode})`)); return; }
      const tmp = dest + '.part';
      const out = fs.createWriteStream(tmp);
      res.pipe(out);
      out.on('finish', () => {
        out.close(() => {
          try { fs.renameSync(tmp, dest); resolve(dest); } catch (e) { reject(e); }
        });
      });
      out.on('error', (e) => { try { fs.unlinkSync(tmp); } catch { /* ignore */ } reject(e); });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(new Error('скачивание зависло')); });
  });
}

/**
 * Что у сервера внутри: папка plugins или mods, версия игры и лоадер.
 * Смотрим папки, версию — из version_history.json / logs / libraries.
 */
function detect(dir) {
  const out = { dir: dir || '', kind: 'plugin', folder: 'plugins', version: '', loader: '' };
  if (!dir || !fs.existsSync(dir)) return out;

  const exists = (name) => fs.existsSync(path.join(dir, name));
  const hasPlugins = exists('plugins');
  const hasMods = exists('mods');
  const jars = (() => {
    try {
      return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.jar'));
    } catch { return []; }
  })();

  const jarText = jars.join(' ').toLowerCase();
  if (hasMods && !hasPlugins) out.kind = 'mod';
  else if (hasPlugins && !hasMods) out.kind = 'plugin';
  else if (hasMods && hasPlugins) out.kind = 'mod';
  else out.kind = /fabric|forge|neoforge|quilt/.test(jarText) ? 'mod' : 'plugin';
  out.folder = out.kind === 'mod' ? 'mods' : 'plugins';

  if (/fabric/.test(jarText)) out.loader = 'fabric';
  else if (/neoforge/.test(jarText)) out.loader = 'neoforge';
  else if (/forge/.test(jarText)) out.loader = 'forge';
  else if (/quilt/.test(jarText)) out.loader = 'quilt';
  else if (/paper/.test(jarText)) out.loader = 'paper';
  else if (/purpur/.test(jarText)) out.loader = 'purpur';
  else if (/spigot/.test(jarText)) out.loader = 'spigot';
  else if (/velocity/.test(jarText)) out.loader = 'velocity';
  else if (/bukkit/.test(jarText)) out.loader = 'bukkit';

  // версия игры: version_history.json → latest.log → libraries
  const tryJson = (file) => {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      const name = d.currentVersion || d.version || (d.versions && d.versions[0]) || '';
      const m = String(name).match(/(\d+\.\d+(?:\.\d+)?)/);
      return m ? m[1] : '';
    } catch { return ''; }
  };
  out.version = tryJson('version_history.json') || tryJson('version.json');

  if (!out.version) {
    const logs = ['logs/latest.log', 'logs/fml-server-latest.log', 'log/latest.log'];
    for (const rel of logs) {
      try {
        const txt = fs.readFileSync(path.join(dir, rel), 'utf8');
        const m = txt.match(/[Ss]tarting minecraft server version\s*([\d.]+\w*)/)
          || txt.match(/Minecraft [Vv]ersion[:\s]+([\d.]+\w*)/)
          || txt.match(/(?:Loading Minecraft|minecraft)\s+([\d]+\.[\d]+(?:\.[\d]+)?)/);
        if (m) { out.version = m[1]; break; }
      } catch { /* файла нет */ }
    }
  }

  if (!out.version) {
    try {
      for (const f of fs.readdirSync(path.join(dir, 'libraries', 'net', 'minecraft', 'server'))) {
        const m = f.match(/(\d+\.\d+(?:\.\d+)?)/);
        if (m) { out.version = m[1]; break; }
      }
    } catch { /* нет libraries */ }
  }

  return out;
}

/** Ставит проект на сервер: выбирает версию и кладёт jar в plugins/ или mods/. */
async function install(dir, opts = {}) {
  const info = detect(dir);
  if (!info.dir || !fs.existsSync(info.dir)) return { ok: false, error: 'Папка сервера не найдена' };

  const loader = opts.loader || info.loader || '';
  const version = opts.version || info.version || '';
  const res = await versions(opts.id, { loader, version });
  if (!res.ok || !res.versions.length) {
    // без фильтров берём последнюю подходящую
    const all = await versions(opts.id, {});
    if (!all.ok || !all.versions.length) return { ok: false, error: 'У проекта нет файлов' };
    res.versions = all.versions;
  }
  const pick = res.versions.find((v) => v.type === 'release') || res.versions[0];
  const file = pick.file;
  const target = path.join(info.dir, info.folder);
  fs.mkdirSync(target, { recursive: true });
  const dest = path.join(target, file.filename);
  await download(file.url, dest);
  return {
    ok: true,
    path: dest,
    folder: info.folder,
    file: file.filename,
    version: pick.number,
    gameVersions: pick.gameVersions,
  };
}

/** Что уже стоит у сервера в plugins/ и mods/. */
function installed(dir) {
  const out = { plugins: [], mods: [] };
  const read = (folder) => {
    try {
      return fs.readdirSync(path.join(dir, folder))
        .filter((f) => /\.jar$/i.test(f))
        .map((f) => {
          const full = path.join(dir, folder, f);
          let size = 0;
          try { size = fs.statSync(full).size; } catch { /* ignore */ }
          return { name: f, size };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch { return []; }
  };
  out.plugins = read('plugins');
  out.mods = read('mods');
  return out;
}

module.exports = { search, versions, categories, install, detect, installed };
