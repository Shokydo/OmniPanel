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

const os = require('os');
const backup = require('./backup');
const zip = require('./zip');
const seven = require('./seven');

/*
 * Пересылка сервера в GitHub одним архивом — основной режим:
 *   отправка:  архивация папки сервера  →  один файл в репозиторий;
 *   забор:     файл из репозитория      →  распаковка в папку сервера.
 *
 * Архив собирается 7-Zip (плотнее и меньше риск упереться в лимит 95 МБ),
 * но читается и старый zip из прошлых версий панели.
 */
const ARCHIVE_7Z = '.omnipanel/сервер.7z';
const ARCHIVE_DIR = '.omnipanel';
/* Разбивка на части: GitHub не принимает файлы больше 95 МБ, поэтому архив
   режется на тома и каждый уезжает отдельным файлом. */
const SPLIT_MB = Number(process.env.OMNI_SPLIT_MB) || 45;   // размер одной части архива
const MAX_PARTS = 90;                 // ≈ 4 ГБ — дальше GitHub не тянет
const ARCHIVE_ZIP = '.omnipanel/сервер.zip';
const LEGACY_ARCHIVES = [ARCHIVE_7Z, ARCHIVE_ZIP];
const MANIFEST_PATH = '.omnipanel/манифест.json';

/* Обратная совместимость: старые тесты и код говорят про «сервер.zip». */
const ARCHIVE_PATH = ARCHIVE_7Z;

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
  if (status === 409) {
    if (/empty/i.test(msg)) return 'Репозиторий ещё пустой: в нём нет ни одного коммита (409). Панель создаёт первый коммит автоматически — повтори отправку.';
    return `Ветка изменилась во время отправки (409)${msg ? ': ' + msg : ''}. Повтори отправку.`;
  }
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
    const err = new Error(humanError(res.status, data));
    err.status = res.status;
    err.body = data;
    err.path = urlPath;
    throw err;
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

/**
 * Первый коммит в пустом репозитории.
 *
 * У репозитория без коммитов нет дерева и нет ветки, поэтому Git Data API
 * отвечает 409 «Git Repository is empty». Единственный надёжный способ
 * создать там первую ветку — Contents API: он делает коммит сам.
 */
const BOOTSTRAP_PATH = '.omnipanel/первый-коммит.md';
const BOOTSTRAP_TEXT = [
  '# OmniPanel',
  '',
  'Этот файл панель создала, чтобы в пустом репозитории появился первый коммит.',
  'Следующая отправка сервера удалит его автоматически.',
  '',
].join('\n');

async function bootstrapEmpty(token, repo, branch, message) {
  const body = {
    message: message || 'OmniPanel: первый коммит',
    content: Buffer.from(BOOTSTRAP_TEXT, 'utf8').toString('base64'),
    branch,
  };
  const cur = await gh(token, `/repos/${repo}/contents/${encodeURI(BOOTSTRAP_PATH)}?ref=${encodeURIComponent(branch)}`, {
    allow404: true, allow409: true,
  });
  if (cur && cur.sha) body.sha = cur.sha;
  await gh(token, `/repos/${repo}/contents/${encodeURI(BOOTSTRAP_PATH)}`, { method: 'PUT', body });
  return getHead(token, repo, branch);
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

/* ─────────────────── отправка «через бэкап» (одним архивом) ─────────────────── */

const MB = (bytes) => (bytes / 1048576).toFixed(1);

/**
 * Шаг 1: архивация папки сервера. Шаг 2: отправка одного файла в репозиторий.
 *
 * Для больших миров это надёжнее поштучной отправки: десятки тысяч мелких файлов
 * превращаются в один, git-дерево не разрастается, а лимит на размер одного blob
 * проверяется один раз.
 */
async function pushArchive(token, repo, branch, opts) {
  const { dir, message, stateFile, onLog = () => {}, cleanup = true } = opts;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-gh-'));
  try {
    const format = seven.available() ? '7z' : 'zip';
    /* zip-писатель панели не умеет тома, поэтому разбивка только для 7z */
    const volumeMb = format === '7z' ? SPLIT_MB : 0;

    /* ── шаг 1: архив ── */
    onLog(`шаг 1 из 2: архивирую сервер${format === '7z' ? ` (7-Zip, части по ${SPLIT_MB} МБ)` : ' (zip)'}…`);
    const info = await backup.createBackup({ srcDir: dir, destDir: tmpDir, label: 'server', format, volumeMb });
    const parts = info.file ? (info.parts && info.parts.length ? info.parts : [info.file]) : [];
    const local = parts.map((file) => ({
      file,
      name: path.basename(file).replace(/^server_\d{4}-[\d-]+_\d{2}-\d{2}-\d{2}\./, 'сервер.'),
      size: fs.statSync(file).size,
      sha256: sha256Of(fs.readFileSync(file)),
    }));
    const totalSize = local.reduce((sum, p) => sum + p.size, 0);

    onLog(`архив готов: ${MB(totalSize)} МБ из ${MB(info.raw)} МБ`
      + (info.ratio ? `, плотнее в ${info.ratio} раза` : '')
      + `, файлов ${info.files}`
      + (local.length > 1 ? `, частей ${local.length} по ${MB(local[0].size)} МБ` : ''));

    if (totalSize > HARD_LIMIT * MAX_PARTS) {
      return {
        ok: false,
        error: `Сервер упакован в ${MB(totalSize)} МБ — это больше, чем GitHub готов принять `
          + `(${MAX_PARTS} частей по ${SPLIT_MB} МБ). Убери крупные файлы из папки сервера `
          + 'или выбери в настройках отправку по файлам.',
      };
    }
    if (format !== '7z' && totalSize > HARD_LIMIT) {
      return {
        ok: false,
        error: `7-Zip рядом не нашёлся, а обычный zip получился ${MB(totalSize)} МБ — GitHub не принимает `
          + `файлы больше 95 МБ, и разрезать zip панель не умеет. Положи 7za.exe в папку assets/bin `
          + 'рядом с панелью или выбери в настройках отправку по файлам.',
      };
    }
    const oversized = local.find((p) => p.size > HARD_LIMIT);
    if (oversized) {
      return { ok: false, error: `Одна часть архива получилась ${MB(oversized.size)} МБ — GitHub не принимает файлы больше 95 МБ.` };
    }

    const head = await getHead(token, repo, branch);
    const state = loadState(stateFile);
    const manifest = {
      createdAt: new Date().toISOString(),
      format,
      files: info.files,
      raw: info.raw,
      packed: totalSize,
      parts: local.map((p) => ({ name: p.name, size: p.size, sha256: p.sha256 })),
      cleanup: cleanup !== false,
    };

    /* если архив побайтово тот же, что уже лежит в репозитории — отправлять нечего */
    const remoteParts = head ? await archiveParts(token, repo, head.commit) : null;
    const samePart = (p, i) => {
      const mine = local[i];
      if (p.sha256 && mine.sha256) return p.sha256 === mine.sha256;
      return !p.size || p.size === mine.size;   // размер может быть неизвестен — не придираемся
    };
    if (head && remoteParts
      && remoteParts.parts.length === local.length
      && remoteParts.parts.every(samePart)) {
      saveState(stateFile, {
        commit: head.commit, branch, mode: 'archive',
        files: Object.fromEntries(remoteParts.parts.map((p) => [p.path, p.sha])),
      });
      return { ok: true, upToDate: true, commit: head.commit, uploaded: 0, removed: 0, changed: 0,
        archive: local[0].name, size: totalSize, raw: info.raw, format, parts: local.length };
    }

    /* ── шаг 2: отправка ── */
    onLog(`шаг 2 из 2: отправляю на GitHub ${local.length > 1 ? local.length + ' частей' : 'архив'} (${MB(totalSize)} МБ)…`);
    const entries = [];
    for (let i = 0; i < local.length; i += 1) {
      const part = local[i];
      const blob = await gh(token, `/repos/${repo}/git/blobs`, {
        body: { content: fs.readFileSync(part.file).toString('base64'), encoding: 'base64' },
      });
      const rel = `${ARCHIVE_DIR}/${part.name}`;
      entries.push({ path: rel, mode: '100644', type: 'blob', sha: blob.sha });
      if (local.length > 1) onLog(`  часть ${i + 1} из ${local.length}: ${part.name} — ${MB(part.size)} МБ`);
    }
    const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 1), 'utf8');
    const manifestBlob = await gh(token, `/repos/${repo}/git/blobs`, {
      body: { content: manifestBuf.toString('base64'), encoding: 'base64' },
    });
    entries.push({ path: MANIFEST_PATH, mode: '100644', type: 'blob', sha: manifestBlob.sha });

    /* убираем из репозитория то, чего в новом наборе нет: старые части, старый одиночный архив,
       пофайловые копии из прошлых версий */
    let removed = 0;
    const keep = new Set(entries.map((e) => e.path));
    const stale = new Set(Object.keys(state.files || {}));
    if (head) {
      const tree = await getTreeOfCommit(token, repo, head.commit);
      for (const e of tree.entries) {
        if (e.type === 'blob' && isArchivePath(e.path)) stale.add(e.path);
      }
    }
    for (const rel of stale) {
      if (keep.has(rel)) continue;
      entries.push({ path: rel, mode: '100644', type: 'blob', sha: null });
      removed += 1;
    }
    if (removed) onLog(`в репозитории остались файлы прошлой отправки — убираю ${removed}`);

    const sendTree = async (baseTree, parent) => {
      const body = { tree: entries };
      if (baseTree) body.base_tree = baseTree;
      const tree = await gh(token, `/repos/${repo}/git/trees`, { body });
      const commit = await gh(token, `/repos/${repo}/git/commits`, {
        body: { message, tree: tree.sha, parents: parent ? [parent] : [] },
      });
      if (parent) {
        await gh(token, `/repos/${repo}/git/refs/heads/${encodeURI(branch)}`, {
          method: 'PATCH', body: { sha: commit.sha, force: false },
        });
      } else {
        await gh(token, `/repos/${repo}/git/refs`, { body: { ref: `refs/heads/${branch}`, sha: commit.sha } });
      }
      return commit;
    };

    let commit;
    if (!head) {
      onLog('репозиторий пустой — создаю первый коммит');
      const boot = await bootstrapEmpty(token, repo, branch, message);
      if (!boot) throw new Error('Не удалось создать первый коммит в пустом репозитории.');
      const t = await getTreeOfCommit(token, repo, boot.commit);
      commit = await sendTree(t.treeSha, boot.commit);
    } else {
      const t = await getTreeOfCommit(token, repo, head.commit);
      commit = await sendTree(t.treeSha, head.commit);
    }

    saveState(stateFile, {
      commit: commit.sha, branch, mode: 'archive',
      files: Object.fromEntries(entries.filter((e) => e.sha).map((e) => [e.path, e.sha])),
    });
    onLog(`готово: ${local.length > 1 ? 'части архива' : 'архив'} в репозитории, коммит ${String(commit.sha).slice(0, 7)}`);
    return {
      ok: true,
      commit: commit.sha,
      uploaded: local.length,
      removed,
      changed: 1,
      archive: local[0].name,
      archivePath: `${ARCHIVE_DIR}/${local[0].name}`,
      format,
      parts: local.length,
      size: totalSize,
      raw: info.raw,
      files: info.files,
    };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* временная папка */ }
  }
}

/** sha256 буфера. */
function sha256Of(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Это файл нашей пересылки сервера? (архив, его части, манифест) */
function isArchivePath(rel) {
  if (rel === MANIFEST_PATH) return true;
  return /^\.omnipanel\/(сервер\.(7z|zip))(\.\d{3})?$/.test(rel);
}

/**
 * Что лежит в репозитории по нашей пересылке:
 * части архива (отсортированы), манифест, суммарный размер.
 */
async function archiveParts(token, repo, commitSha) {
  const { entries } = await getTreeOfCommit(token, repo, commitSha);
  const blobs = entries.filter((e) => e.type === 'blob' && isArchivePath(e.path));
  if (!blobs.length) return null;

  let manifest = null;
  const manEntry = blobs.find((e) => e.path === MANIFEST_PATH);
  if (manEntry) {
    try {
      manifest = JSON.parse((await downloadBlob(token, repo, manEntry.sha)).toString('utf8'));
    } catch { /* манифеста нет или он битый — берём имена файлов */ }
  }

  const partEntries = blobs
    .filter((e) => e.path !== MANIFEST_PATH)
    .sort((a, b) => a.path.localeCompare(b.path, 'ru'));
  const parts = partEntries.map((e) => ({
    path: e.path,
    sha: e.sha,
    size: e.size || 0,
    sha256: (manifest && (manifest.parts || []).find((p) => p.path === e.path
      || e.path.endsWith('/' + p.name))) ? (manifest.parts.find((p) => e.path.endsWith('/' + p.name)) || {}).sha256 : '',
  }));
  return {
    manifest,
    parts,
    total: parts.reduce((sum, p) => sum + p.size, 0),
    first: parts[0] || null,
  };
}

/** sha файла по пути в дереве коммита (или null). */
async function shaOfPath(token, repo, commitSha, rel) {
  const { entries } = await getTreeOfCommit(token, repo, commitSha);
  const hit = entries.find((e) => e.type === 'blob' && e.path === rel);
  return hit ? hit.sha : null;
}

/**
 * Забрать сервер из архива в репозитории.
 * Шаг 1: скачать архив (одну часть или все). Шаг 2: распаковать в папку сервера.
 * После успешной распаковки части архива по умолчанию удаляются из репозитория,
 * чтобы он не рос: репозиторий работает как канал пересылки, а не как хранилище.
 */
async function pullArchive(token, repo, branch, opts) {
  const { dir, stateFile, onLog = () => {}, cleanup } = opts;
  const head = await getHead(token, repo, branch);
  if (!head) return { ok: false, error: `В репозитории ${repo} ещё нет отправленного сервера — сначала отправь его.` };
  const state = loadState(stateFile);

  const remote = await archiveParts(token, repo, head.commit);
  if (!remote || !remote.first) {
    return { ok: false, error: 'В репозитории нет файла сервера. Его нужно отправить из панели (архивом).' };
  }
  const already = state.commit === head.commit
    && remote.parts.every((p) => state.files && state.files[p.path] === p.sha);
  if (already) {
    return { ok: true, changed: 0, downloaded: 0, removed: 0, commit: head.commit, upToDate: true };
  }

  const multi = remote.parts.length > 1;
  /* ── шаг 1: скачать ── */
  onLog(`шаг 1 из 2: скачиваю архив с GitHub (${MB(remote.total)} МБ${multi ? `, частей ${remote.parts.length}` : ''})…`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-gh-pull-'));
  try {
    const localFiles = [];
    for (let i = 0; i < remote.parts.length; i += 1) {
      const part = remote.parts[i];
      const buf = await downloadBlob(token, repo, part.sha);
      const name = path.basename(part.path);
      const target = path.join(tmpDir, name);
      fs.writeFileSync(target, buf);
      if (part.sha256 && sha256Of(buf) !== part.sha256) {
        return { ok: false, error: `Часть ${name} скачалась битой — контрольная сумма не совпала. Повтори забор.` };
      }
      localFiles.push(target);
      if (multi) onLog(`  часть ${i + 1} из ${remote.parts.length}: ${name} — ${MB(buf.length)} МБ`);
    }

    /* ── шаг 2: распаковать ── */
    const first = localFiles[0];
    const is7z = /\.7z(\.\d{3})?$/i.test(first) || /^\.7z$/i.test(path.extname(first).replace('.001', '.7z'));
    const looks7z = fs.readFileSync(first).subarray(0, 6)
      .equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]));
    onLog(`шаг 2 из 2: распаковываю архив в папку сервера (${is7z || looks7z ? '7z' : 'zip'})…`);
    let files = 0;
    if (is7z || looks7z) {
      if (!seven.available()) {
        return { ok: false, error: 'В репозитории архив .7z, а рядом с панелью нет 7-Zip — обнови панель' };
      }
      await seven.extract({ file: first, destDir: dir });
      files = (await seven.list(first).catch(() => [])).filter((x) => x.Path && !x.isDir).length;
      if (!files) files = countFiles(dir);
    } else {
      const res = zip.extractFile(first, dir);
      files = res.files.length;
    }

    /* ── шаг 3 (по желанию): убрать архив из репозитория ── */
    const wantCleanup = cleanup !== undefined
      ? cleanup !== false
      : !(remote.manifest && remote.manifest.cleanup === false);
    let removedFromRepo = 0;
    let finalCommit = head.commit;
    if (wantCleanup) {
      try {
        removedFromRepo = await dropArchive(token, repo, branch, head.commit, onLog);
        finalCommit = removedFromRepo ? (await getHead(token, repo, branch)).commit : head.commit;
      } catch (err) {
        onLog('архив распакован, но убрать его из репозитория не удалось: ' + err.message);
      }
    }

    saveState(stateFile, {
      commit: finalCommit,
      branch,
      mode: 'archive',
      files: removedFromRepo ? {} : Object.fromEntries(remote.parts.map((p) => [p.path, p.sha])),
    });
    onLog(`готово: распаковано файлов ${files}`
      + (removedFromRepo ? `, части архива удалены из репозитория (${removedFromRepo})` : ''));
    return {
      ok: true,
      commit: finalCommit,
      changed: files,
      downloaded: files,
      removed: 0,
      total: files,
      format: is7z || looks7z ? '7z' : 'zip',
      archive: path.basename(remote.first.path),
      parts: remote.parts.length,
      size: remote.total,
      repoCleaned: removedFromRepo,
    };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* временная папка */ }
  }
}

/** Сколько файлов в папке (для отчёта после распаковки). */
function countFiles(dir) {
  let n = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) stack.push(path.join(cur, e.name));
      else n += 1;
    }
  }
  return n;
}

/**
 * Удаляет файлы пересылки (части архива и манифест) из ветки одним коммитом.
 * @returns {Promise<number>} сколько файлов убрано
 */
async function dropArchive(token, repo, branch, commitSha, onLog = () => {}) {
  const { entries } = await getTreeOfCommit(token, repo, commitSha);
  const files = entries.filter((e) => e.type === 'blob' && isArchivePath(e.path));
  if (!files.length) return 0;

  onLog(`убираю архив из репозитория (${files.length} файл${files.length === 1 ? '' : 'ов'})…`);
  const tree = await gh(token, `/repos/${repo}/git/trees`, {
    body: {
      base_tree: (await getTreeOfCommit(token, repo, commitSha)).treeSha,
      tree: files.map((e) => ({ path: e.path, mode: '100644', type: 'blob', sha: null })),
    },
  });
  const commit = await gh(token, `/repos/${repo}/git/commits`, {
    body: {
      message: 'OmniPanel: части архива удалены после распаковки',
      tree: tree.sha,
      parents: [commitSha],
    },
  });
  await gh(token, `/repos/${repo}/git/refs/heads/${encodeURI(branch)}`, {
    method: 'PATCH', body: { sha: commit.sha, force: false },
  });
  return files.length;
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
  const { dir, repo: rawRepo, branch: rawBranch, token: rawToken, scope = 'all', stateFile, onLog = () => {}, mode = 'archive' } = opts;
  try {
    const repo = normRepo(rawRepo);
    const branch = normBranch(rawBranch);
    const token = normToken(rawToken);
    if (!fs.existsSync(dir)) return { ok: false, error: 'Папка сервера не найдена: ' + dir };

    const head = await getHead(token, repo, branch);
    if (!head) return { ok: false, error: `В репозитории ${repo} нет ветки ${branch} — сначала отправь сервер на GitHub.` };
    if (mode === 'archive') return await pullArchive(token, repo, branch, opts);

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
    maxFile = MAX_FILE, mode = 'archive',
  } = opts;
  try {
    const repo = normRepo(rawRepo);
    const branch = normBranch(rawBranch);
    const token = normToken(rawToken);
    if (!fs.existsSync(dir)) return { ok: false, error: 'Папка сервера не найдена: ' + dir };

    if (mode === 'archive') {
      /* одним архивом имеет смысл гнать только весь сервер целиком */
      if (scope !== 'all') onLog('выбран не весь сервер — отправляю по файлам');
      else return await pushArchive(token, repo, branch, opts);
    }

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

    let head = await getHead(token, repo, branch);
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

    /* 3–5. дерево → коммит → ветка.
       В пустом репозитории любой из этих шагов может ответить 409:
       тогда создаём первый коммит через Contents API и повторяем один раз. */
    const sendTree = async () => {
      const treeBody = { tree: entries };
      if (baseTree) treeBody.base_tree = baseTree;
      const tree = await gh(token, `/repos/${repo}/git/trees`, { body: treeBody });

      const commitBody = { message, tree: tree.sha, parents: parentCommit ? [parentCommit] : [] };
      const commit = await gh(token, `/repos/${repo}/git/commits`, { body: commitBody });

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
      return commit;
    };

    let commit;
    try {
      commit = await sendTree();
    } catch (err) {
      const empty = err.status === 409 || err.status === 404 || /empty/i.test(err.message || '');
      if (!empty) throw err;
      onLog('репозиторий пустой — создаю первый коммит');
      head = await bootstrapEmpty(token, repo, branch, message);
      if (!head) throw new Error('Не удалось создать первый коммит в пустом репозитории. Проверь права токена на запись (Contents: read and write).');
      /* после первого коммита ветка есть — дальше обычный путь */
      const info = await getTreeOfCommit(token, repo, head.commit);
      baseTree = info.treeSha;
      parentCommit = head.commit;
      for (const e of info.entries) if (e.type === 'blob') remote.set(e.path, e.sha);
      commit = await sendTree();
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
    const t = normToken(token);
    const data = await gh(t, '/user/repos', {
      body: { name: clean, private: !!isPrivate, auto_init: true, description: 'OmniPanel: сервер целиком' },
    });
    /* Свежий репозиторий иногда ещё не виден токену (fine-grained токен
       с доступом к выбранным репозиториям). Проверяем сразу, чтобы потом
       не ловить 404 при отправке. */
    const checkLater = await gh(t, `/repos/${data.full_name}`, { allow404: true }).catch(() => null);
    return {
      ok: true,
      repo: data.full_name,
      private: !!data.private,
      htmlUrl: data.html_url || '',
      invisible: !checkLater,
      note: checkLater
        ? ''
        : 'Репозиторий создан, но токен его пока не видит. Открой токен на GitHub и выбери «All repositories» (или добавь этот репозиторий в список) — иначе отправка упрётся в 404.',
    };
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
  archiveParts, dropArchive, isArchivePath,
  pull, push, check, verify, loadState, saveState,
  getUser, listRepos, createRepo,
  deviceStart, devicePoll, downloadRepoZip,
  makeMatcher, worldDirs, blobSha, normRepo, normBranch,
  MAX_FILE, HARD_LIMIT,
};
