'use strict';
/**
 * Синхронизация папки сервера с GitHub.
 *
 * Работает без установленного git: используется Git Data API
 * (blobs → tree → commit → ref). Перед запуском сервер забирает
 * изменения из репозитория, после остановки — отправляет свои.
 *
 * Модель простая: «кто последний отправил, тот и прав» (без merge).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_FILE = 40 * 1024 * 1024;    // больше — не отправляем по умолчанию
const HARD_LIMIT = 95 * 1024 * 1024;  // жёсткий лимит GitHub на один blob
const CONCURRENCY = 4;

/* ───────────────────────────── служебное ───────────────────────────── */

function apiBase() {
  return (process.env.OMNI_GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');
}

function normRepo(repo) {
  const s = String(repo || '').trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  const parts = s.split('/');
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    throw new Error('Репозиторий указывается как «владелец/название», например friend/my-server');
  }
  return `${parts[0]}/${parts[1]}`;
}

function normBranch(branch) {
  return String(branch || 'main').trim().replace(/^\/+/, '') || 'main';
}

function normToken(token) {
  const t = String(token || '').trim();
  if (!t) throw new Error('Не указан токен GitHub (Settings → Developer settings → Personal access tokens)');
  return t;
}

function humanError(status, body) {
  const msg = (body && (body.message || body.error)) || '';
  if (status === 401) return 'Токен не подошёл или истёк (401). Проверь права repo.';
  if (status === 403) {
    if (/rate limit/i.test(msg)) return 'GitHub ограничил запросы (403). Подожди немного.';
    return 'Нет прав на запись (403). В токене должна быть галочка «repo».';
  }
  if (status === 404) return 'Репозиторий не найден или у токена нет к нему доступа (404).';
  if (status === 409) return 'Конфликт ветки (409): ветка пустая или изменена параллельно.';
  if (status === 413) return 'Файл слишком большой для GitHub (413).';
  if (status === 422) return `GitHub не принял данные (422): ${msg || 'проверь имя ветки'}`;
  return `GitHub ответил ${status}${msg ? ': ' + msg : ''}`;
}

async function gh(token, urlPath, opts = {}) {
  const url = urlPath.startsWith('http') ? urlPath : apiBase() + urlPath;
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'OmniPanel',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(opts.headers || {}),
  };
  if (token) headers.Authorization = `token ${token}`;
  if (opts.body) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(url, {
      method: opts.method || (opts.body ? 'POST' : 'GET'),
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch (err) {
    throw new Error('Нет связи с GitHub: ' + err.message);
  }

  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 200) }; } }

  if (!res.ok) {
    // пустая ветка в пустом репозитории — это нормально
    if (opts.allow404 && res.status === 404) return null;
    if (opts.allow409 && res.status === 409) return null;
    throw new Error(humanError(res.status, data));
  }
  return data;
}

/* ──────────────────────── что именно синхронизируем ──────────────────────── */

const ALWAYS_SKIP = [
  /(^|\/)\.git(\/|$)/,
  /(^|\/)logs?(\/|$)/,
  /(^|\/)crash-reports(\/|$)/,
  /(^|\/)cache(\/|$)/,
  /(^|\/)libraries(\/|$)/,
  /(^|\/)versions(\/|$)/,
  /(^|\/)backups?(\/|$)/,
  /(^|\/)\.DS_Store$/,
  /(^|\/)Thumbs\.db$/i,
  /\.log(\.\d+)?$/i,
  /(^|\/)session\.lock$/i,
  /\.lock$/i,
];
/* в режиме «весь сервер» тянем и ядро, и плагины; в остальных режимах jar не нужен */
const BINARY_SKIP = [/\.zip$/i, /\.tar$/i, /\.gz$/i, /\.7z$/i];

/** Каталоги мира: level-name + стандартные измерения. */
function worldDirs(dir) {
  const names = new Set(['world', 'world_nether', 'world_the_end']);
  try {
    const props = fs.readFileSync(path.join(dir, 'server.properties'), 'utf8');
    const m = /^level-name\s*=\s*(.+)$/m.exec(props);
    if (m && m[1].trim()) names.add(m[1].trim());
  } catch { /* файла может не быть */ }
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (fs.existsSync(path.join(dir, entry.name, 'level.dat'))) names.add(entry.name);
    }
  } catch { /* папки может не быть */ }
  return [...names].filter(Boolean);
}

const CONFIG_EXT = /\.(ya?ml|json|properties|txt|conf|cfg|toml|xml|ini|md|mcmeta|snbt)$/i;

/**
 * Фильтр файлов по выбранному режиму.
 *  world   — только мир (регион-файлы, level.dat и т.п.)
 *  config  — мир + server.properties + конфиги плагинов
 *  all     — вся папка сервера (кроме мусора, логов и jar/zip)
 */
function makeMatcher(scope, dir) {
  const worlds = worldDirs(dir);
  const inWorld = (rel) => worlds.some((w) => rel === w || rel.startsWith(w + '/'));

  return (rel) => {
    if (ALWAYS_SKIP.some((re) => re.test(rel))) return false;
    if (BINARY_SKIP.some((re) => re.test(rel))) return false;
    if (scope === 'all') return true;
    if (/\.jar$/i.test(rel)) return false;
    if (inWorld(rel)) return true;
    if (scope === 'config') {
      if (rel === 'server.properties' || rel === 'bukkit.yml' || rel === 'spigot.yml' || rel === 'paper.yml') return true;
      if (CONFIG_EXT.test(rel) && /(^|\/)(plugins|config|data)(\/|$)/.test(rel)) return true;
      return false;
    }
    return false; // scope === 'world'
  };
}

/* ───────────────────────────── локальные файлы ───────────────────────────── */

function walk(root, match, limit = 20000) {
  const out = [];
  const stack = [''];
  while (stack.length && out.length < limit) {
    const rel = stack.pop();
    let entries;
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (ALWAYS_SKIP.some((re) => re.test(childRel + '/'))) continue;
        stack.push(childRel);
      } else if (entry.isFile()) {
        if (!match(childRel)) continue;
        let st;
        try { st = fs.statSync(path.join(root, childRel)); } catch { continue; }
        out.push({ rel: childRel, size: st.size, mtime: st.mtimeMs });
      }
    }
  }
  return out;
}

function blobSha(buf) {
  return crypto.createHash('sha1')
    .update(`blob ${buf.length}\0`)
    .update(buf)
    .digest('hex');
}

function readLocal(root, rel) {
  const buf = fs.readFileSync(path.join(root, rel));
  return { buf, sha: blobSha(buf) };
}

async function mapLimit(items, limit, fn) {
  const queue = items.slice();
  const workers = new Array(Math.min(limit, queue.length)).fill(0).map(async () => {
    while (queue.length) {
      const item = queue.shift();
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/* ─────────────────────────────── GitHub ─────────────────────────────── */

async function getHead(token, repo, branch) {
  const ref = await gh(token, `/repos/${repo}/git/ref/heads/${encodeURI(branch)}`, { allow404: true, allow409: true });
  return ref && ref.object ? { commit: ref.object.sha } : null;
}

async function getTreeOfCommit(token, repo, commitSha) {
  const commit = await gh(token, `/repos/${repo}/git/commits/${commitSha}`);
  const tree = await gh(token, `/repos/${repo}/git/trees/${commit.tree.sha}?recursive=1`);
  return { treeSha: commit.tree.sha, entries: (tree && tree.tree) || [] };
}

async function downloadBlob(token, repo, sha) {
  const data = await gh(token, `/repos/${repo}/git/blobs/${sha}`);
  return Buffer.from(data.content || '', data.encoding === 'base64' ? 'base64' : 'utf8');
}

/* ─────────────────────────────── состояние ─────────────────────────────── */

function loadState(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { commit: raw.commit || null, files: raw.files || {}, at: raw.at || null, branch: raw.branch || null };
  } catch {
    return { commit: null, files: {}, at: null, branch: null };
  }
}

function saveState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...state, at: new Date().toISOString() }, null, 1));
  } catch { /* не критично */ }
}

/* ───────────────────────────────── pull ───────────────────────────────── */

/**
 * Забрать изменения из GitHub в папку сервера.
 * Возвращает {ok, changed, downloaded, removed, commit} либо {ok:false, error}.
 */
async function pull(opts) {
  const { dir, repo: rawRepo, branch: rawBranch, token: rawToken, scope = 'all', stateFile, onLog = () => {} } = opts;
  try {
    const repo = normRepo(rawRepo);
    const branch = normBranch(rawBranch);
    const token = normToken(rawToken);
    if (!fs.existsSync(dir)) return { ok: false, error: 'Папка сервера не найдена: ' + dir };

    const head = await getHead(token, repo, branch);
    if (!head) return { ok: false, error: `В репозитории ${repo} нет ветки ${branch} — сначала отправь сервер на GitHub.` };

    const state = loadState(stateFile);
    if (state.commit === head.commit) {
      return { ok: true, changed: 0, downloaded: 0, removed: 0, commit: head.commit, upToDate: true };
    }

    const { entries } = await getTreeOfCommit(token, repo, head.commit);
    const match = makeMatcher(scope, dir);
    const remote = new Map();
    for (const e of entries) {
      if (e.type !== 'blob' || !match(e.path)) continue;
      remote.set(e.path, { sha: e.sha, size: e.size || 0 });
    }

    // что качать: нет в состоянии, sha изменился, или файла нет на диске
    const need = [];
    for (const [rel, info] of remote) {
      const localAbs = path.join(dir, rel);
      const known = state.files[rel];
      if (known === info.sha && fs.existsSync(localAbs)) continue;
      if (info.size > HARD_LIMIT) { onLog(`пропущен большой файл ${rel}`); continue; }
      need.push({ rel, sha: info.sha });
    }

    const downloaded = [];
    await mapLimit(need, CONCURRENCY, async ({ rel, sha }) => {
      try {
        const buf = await downloadBlob(token, repo, sha);
        const abs = path.join(dir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, buf);
        downloaded.push(rel);
      } catch (err) {
        onLog(`не удалось скачать ${rel}: ${err.message}`);
      }
    });

    // удалённое в репозитории — убираем и локально (только внутри области синхронизации)
    const removed = [];
    for (const rel of Object.keys(state.files)) {
      if (remote.has(rel)) continue;
      if (!match(rel)) continue;
      const abs = path.join(dir, rel);
      try {
        if (fs.existsSync(abs)) { fs.unlinkSync(abs); removed.push(rel); }
      } catch { /* занят — пропускаем */ }
    }

    const files = {};
    for (const [rel, info] of remote) files[rel] = info.sha;
    saveState(stateFile, { commit: head.commit, branch, files });

    return {
      ok: true,
      commit: head.commit,
      changed: downloaded.length + removed.length,
      downloaded: downloaded.length,
      removed: removed.length,
      total: remote.size,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ───────────────────────────────── push ───────────────────────────────── */

/**
 * Отправить папку сервера в GitHub (коммит поверх текущей ветки).
 * Возвращает {ok, changed, uploaded, removed, commit}.
 */
async function push(opts) {
  const {
    dir, repo: rawRepo, branch: rawBranch, token: rawToken, scope = 'all',
    message = 'OmniPanel: сохранение мира', stateFile, onLog = () => {},
    maxFile = MAX_FILE,
  } = opts;
  try {
    const repo = normRepo(rawRepo);
    const branch = normBranch(rawBranch);
    const token = normToken(rawToken);
    if (!fs.existsSync(dir)) return { ok: false, error: 'Папка сервера не найдена: ' + dir };

    const match = makeMatcher(scope, dir);
    const localFiles = walk(dir, match);

    // хеши локальных файлов
    const local = new Map();
    const skipped = [];
    for (const f of localFiles) {
      if (f.size > Math.min(maxFile, HARD_LIMIT)) { skipped.push(f.rel); continue; }
      try {
        const { sha } = readLocal(dir, f.rel);
        local.set(f.rel, { sha, size: f.size });
      } catch (err) {
        onLog(`не читается ${f.rel}: ${err.message}`);
      }
    }

    const head = await getHead(token, repo, branch);
    let remote = new Map();
    let baseTree = null;
    let parentCommit = null;
    if (head) {
      const info = await getTreeOfCommit(token, repo, head.commit);
      baseTree = info.treeSha;
      parentCommit = head.commit;
      for (const e of info.entries) {
        if (e.type === 'blob') remote.set(e.path, e.sha);
      }
    }

    // что изменилось
    const changed = [...local].filter(([rel, info]) => remote.get(rel) !== info.sha);

    // удаления: были в репозитории, пропали локально (только в области синхронизации)
    const deletions = [...remote.keys()].filter((rel) => match(rel) && !local.has(rel));

    if (!changed.length && !deletions.length) {
      const files = {};
      for (const [rel, info] of local) files[rel] = info.sha;
      saveState(stateFile, { commit: head ? head.commit : null, branch, files });
      return { ok: true, changed: 0, uploaded: 0, removed: 0, commit: head ? head.commit : null, upToDate: true, skipped: skipped.length };
    }

    // 1. заливаем изменённые файлы как blobs
    const entries = [];
    let uploaded = 0;
    await mapLimit(changed, CONCURRENCY, async ([rel]) => {
      const { buf } = readLocal(dir, rel);
      const data = await gh(token, `/repos/${repo}/git/blobs`, {
        body: { content: buf.toString('base64'), encoding: 'base64' },
      });
      entries.push({ path: rel, mode: '100644', type: 'blob', sha: data.sha });
      uploaded += 1;
      if (uploaded % 10 === 0) onLog(`отправлено файлов: ${uploaded}/${changed.length}`);
    });

    // 2. удаления в дереве — sha: null
    for (const rel of deletions) entries.push({ path: rel, mode: '100644', type: 'blob', sha: null });

    // 3. дерево
    const treeBody = { tree: entries };
    if (baseTree) treeBody.base_tree = baseTree;
    const tree = await gh(token, `/repos/${repo}/git/trees`, { body: treeBody });

    // 4. коммит
    const commitBody = { message, tree: tree.sha, parents: parentCommit ? [parentCommit] : [] };
    const commit = await gh(token, `/repos/${repo}/git/commits`, { body: commitBody });

    // 5. ветка
    if (parentCommit) {
      await gh(token, `/repos/${repo}/git/refs/heads/${encodeURI(branch)}`, {
        method: 'PATCH',
        body: { sha: commit.sha, force: false },
      });
    } else {
      await gh(token, `/repos/${repo}/git/refs`, {
        body: { ref: `refs/heads/${branch}`, sha: commit.sha },
      });
    }

    const files = {};
    for (const [rel, info] of local) files[rel] = info.sha;
    saveState(stateFile, { commit: commit.sha, branch, files });

    return {
      ok: true,
      commit: commit.sha,
      changed: changed.length + deletions.length,
      uploaded,
      removed: deletions.length,
      skipped: skipped.length,
      skippedList: skipped.slice(0, 5),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ───────────────────────────────── check ───────────────────────────────── */

/** Есть ли на GitHub что-то новее, чем в прошлый раз. */
async function check(opts) {
  const { dir, repo: rawRepo, branch: rawBranch, token: rawToken, scope = 'all', stateFile } = opts;
  try {
    const repo = normRepo(rawRepo);
    const branch = normBranch(rawBranch);
    const token = normToken(rawToken);

    const head = await getHead(token, repo, branch);
    if (!head) return { ok: true, empty: true, behind: 0, remoteCommit: null, localCommit: null };

    const state = loadState(stateFile);
    if (state.commit === head.commit) {
      return { ok: true, behind: 0, remoteCommit: head.commit, localCommit: state.commit, upToDate: true };
    }

    const { entries } = await getTreeOfCommit(token, repo, head.commit);
    const match = makeMatcher(scope, dir || '.');
    let behind = 0;
    const seen = new Set();
    for (const e of entries) {
      if (e.type !== 'blob' || !match(e.path)) continue;
      seen.add(e.path);
      if (state.files[e.path] !== e.sha) behind += 1;
    }
    for (const rel of Object.keys(state.files)) if (!seen.has(rel) && match(rel)) behind += 1;

    return { ok: true, behind, remoteCommit: head.commit, localCommit: state.commit, upToDate: behind === 0 };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ─────────────────────────────── проверка связи ─────────────────────────────── */

async function verify(opts) {
  const { repo: rawRepo, token: rawToken, branch: rawBranch } = opts;
  try {
    const repo = normRepo(rawRepo);
    const token = normToken(rawToken);
    const branch = normBranch(rawBranch);
    const data = await gh(token, `/repos/${repo}`);
    const head = await getHead(token, repo, branch).catch(() => null);
    return {
      ok: true,
      repo,
      name: data.full_name || repo,
      private: !!data.private,
      push: !!(data.permissions && data.permissions.push),
      branchExists: !!head,
      commit: head ? head.commit : null,
      htmlUrl: data.html_url || `https://github.com/${repo}`,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}


/* ─────────────────────── аккаунт: вход и репозитории ─────────────────────── */

/** Кто владелец токена. */
async function getUser(token) {
  try {
    const data = await gh(normToken(token), '/user');
    return { ok: true, login: data.login, name: data.name || data.login, avatar: data.avatar_url || '', url: data.html_url || '' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Список репозиториев, куда можно писать (свежие сверху). */
async function listRepos(token, query = '') {
  try {
    const out = [];
    for (let page = 1; page <= 4; page++) {
      const chunk = await gh(normToken(token), `/user/repos?per_page=100&sort=updated&page=${page}`);
      if (!Array.isArray(chunk) || !chunk.length) break;
      for (const r of chunk) {
        out.push({
          full: r.full_name,
          name: r.name,
          owner: r.owner ? r.owner.login : '',
          private: !!r.private,
          push: !!(r.permissions && r.permissions.push),
          updated: r.updated_at || '',
          size: r.size || 0,
        });
      }
      if (chunk.length < 100) break;
    }
    const q = String(query || '').trim().toLowerCase();
    const list = (q ? out.filter((r) => r.full.toLowerCase().includes(q)) : out)
      .sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
    return { ok: true, repos: list };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Создать приватный репозиторий под сервер. */
async function createRepo(token, name, isPrivate = true) {
  try {
    const clean = String(name || '').trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!clean) throw new Error('Пустое имя репозитория');
    const data = await gh(normToken(token), '/user/repos', {
      body: { name: clean, private: !!isPrivate, auto_init: true, description: 'OmniPanel: мир сервера' },
    });
    return { ok: true, repo: data.full_name, private: !!data.private, htmlUrl: data.html_url || '' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}


/* ───────────────── вход в аккаунт (OAuth device flow) ───────────────── */
/*
 * Никакого токена руками: панель показывает короткий код, ты вводишь его
 * на github.com/login/device — и аккаунт подключён. Нужен client_id
 * своего OAuth App (в нём включён Device Flow): он принадлежит владельцу
 * аккаунта, поэтому его указывают один раз в настройках панели.
 */

const https = require('https');
const httpMod = require('http');

function formPost(url, form, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(form).toString();
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? httpMod : https;
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'OmniPanel',
        ...headers,
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data || '{}')); }
        catch { reject(new Error('GitHub ответил непонятно: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', (err) => reject(new Error('Нет связи с GitHub: ' + err.message)));
    req.setTimeout(20000, () => req.destroy(new Error('GitHub не ответил за 20 секунд')));
    req.write(body);
    req.end();
  });
}

/** Шаг 1: получить код для входа. */
async function deviceStart(clientId, scope = 'repo read:user') {
  const id = String(clientId || '').trim();
  if (!id) return { ok: false, error: 'client_id не заполнен', needClientId: true };
  try {
    const data = await formPost('https://github.com/login/device/code', {
      client_id: id,
      scope,
    });
    if (data.error) {
      return {
        ok: false,
        error: data.error === 'unauthorized_client'
          ? 'В OAuth App не включён Device Flow (галочка «Enable Device Flow»).'
          : (data.error_description || data.error),
      };
    }
    return {
      ok: true,
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: data.verification_uri || 'https://github.com/login/device',
      interval: Number(data.interval) || 5,
      expiresIn: Number(data.expires_in) || 900,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Шаг 2: спросить, ввёл ли человек код. pending=true — ждём дальше. */
async function devicePoll(clientId, deviceCode) {
  const id = String(clientId || '').trim();
  if (!id || !deviceCode) return { ok: false, code: 'no-data', error: 'Нет данных для ожидания входа' };
  try {
    const data = await formPost('https://github.com/login/oauth/access_token', {
      client_id: id,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    if (data.access_token) {
      const user = await getUser(data.access_token);
      return { ok: true, token: data.access_token, login: user.login || '', avatar: user.avatar || '' };
    }
    if (data.error === 'authorization_pending') return { ok: false, pending: true };
    if (data.error === 'slow_down') return { ok: false, pending: true, slow: true };
    if (data.error === 'expired_token') return { ok: false, code: 'expired_token', error: 'Код устарел — начни вход заново.' };
    if (data.error === 'access_denied') return { ok: false, code: 'access_denied', error: 'Вход отменён на GitHub.' };
    if (data.error === 'incorrect_device_code' || data.error === 'device_flow_disabled') {
      return { ok: false, code: data.error, error: data.error_description || data.error };
    }
    return { ok: false, code: data.error || '', error: data.error_description || data.error || 'Не удалось войти' };
  } catch (err) {
    /* сеть моргнула — это не повод обрывать вход */
    return { ok: false, code: 'network', error: err.message };
  }
}

/* ───────────────── скачать сервер из репозитория ───────────────── */

/** Скачивает zip-архив ветки в файл (нужен для «добавить сервер с GitHub»). */
function downloadRepoZip(token, repo, branch, destFile) {
  return new Promise((resolve, reject) => {
    const full = normRepo(repo);
    const br = normBranch(branch);
    const url = `${apiBase()}/repos/${full}/zipball/${encodeURIComponent(br)}`;
    const headers = { 'User-Agent': 'OmniPanel', Accept: 'application/vnd.github+json' };
    if (token) headers.Authorization = `Bearer ${normToken(token)}`;

    const go = (target, hops) => {
      if (hops > 6) { reject(new Error('Слишком много перенаправлений')); return; }
      const u = new URL(target);
      const lib = u.protocol === 'http:' ? httpMod : https;
      lib.get({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search,
        headers,
      }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          go(res.headers.location, hops + 1);
          return;
        }
        if (res.statusCode !== 200) {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { body += c; });
          res.on('end', () => reject(new Error(humanError(res.statusCode, (() => {
            try { return JSON.parse(body); } catch { return {}; }
          })()))));
          return;
        }
        const out = fs.createWriteStream(destFile);
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve({ ok: true, file: destFile })));
        out.on('error', (err) => reject(err));
      }).on('error', (err) => reject(new Error('Не удалось скачать архив: ' + err.message)));
    };
    go(url, 0);
  });
}

module.exports = {
  pull, push, check, verify, loadState, saveState,
  getUser, listRepos, createRepo,
  deviceStart, devicePoll, downloadRepoZip,
  makeMatcher, worldDirs, blobSha, normRepo, normBranch,
  MAX_FILE, HARD_LIMIT,
};
