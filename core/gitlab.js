'use strict';
/**
 * Синхронизация сервера через GitLab.
 *
 * Зачем: GitHub не принимает большие запросы («Sorry, your input was too large
 * to process»). В GitLab есть хранилище пакетов (Package Registry), куда файл
 * заливается телом запроса без раздувания в base64 и без лимита в 95 МБ.
 *
 * Поток такой же, как у GitHub:
 *   отправка: архивация 7-Zip с разбивкой на части → заливка частей пакетом
 *             «omnipanel-server/<версия>/» → манифест с контрольными суммами;
 *   забор:    находим свежий пакет → скачиваем части → сверяем sha256 →
 *             распаковываем в папку сервера → удаляем пакет из проекта.
 *
 * Работает с gitlab.com и со своим сервером (адрес API можно переопределить
 * переменной OMNI_GITLAB_API, например https://git.myserver.ru/api/v4).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const backup = require('./backup');
const seven = require('./seven');
const zip = require('./zip');

const PACKAGE = 'omnipanel-server';
const MANIFEST = 'manifest.json';
const SPLIT_MB = Number(process.env.OMNI_SPLIT_MB) || 20;
const MAX_PARTS = 200;

const MB = (bytes) => (Number(bytes || 0) / 1048576).toFixed(1);

/* ───────────────────────────── служебное ───────────────────────────── */

function apiBase() {
  return (process.env.OMNI_GITLAB_API || 'https://gitlab.com/api/v4').replace(/\/+$/, '');
}

/** «GitLab» — не «GitHub»: тексты ошибок у провайдера свои. */
function normProject(project) {
  const s = String(project || '').trim()
    .replace(/^https?:\/\/[^/]+\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  if (!s || !s.includes('/')) {
    throw new Error('Проект указывается как «владелец/название» или «группа/подгруппа/название»');
  }
  return s;
}

function normBranch(branch) {
  return String(branch || 'main').trim().replace(/^\/+/, '') || 'main';
}

function normToken(token) {
  const t = String(token || '').trim();
  if (!t) {
    throw new Error('Не указан токен GitLab (Settings → Access Tokens, права api)');
  }
  return t;
}

function humanError(status, body) {
  const msg = (body && (body.message || body.error || body.error_description)) || '';
  const text = typeof msg === 'string' ? msg : JSON.stringify(msg).slice(0, 200);
  if (status === 401) return 'Токен GitLab не подошёл или истёк (401). Нужен токен с правом «api».';
  if (status === 403) return 'Нет прав на этот проект (403). Проверь право «api» у токена и роль в проекте.';
  if (status === 404) return 'Проект не найден (404). Указывай путь «владелец/название» и проверь доступ к нему.';
  if (status === 413) return 'GitLab не принял файл такого размера (413). Уменьши части (OMNI_SPLIT_MB).';
  return `GitLab ответил ${status}${text ? ': ' + text : ''}`;
}

async function gl(token, urlPath, opts = {}) {
  const url = urlPath.startsWith('http') ? urlPath : apiBase() + urlPath;
  const headers = { 'User-Agent': 'OmniPanel', ...(opts.headers || {}) };
  if (token) headers['PRIVATE-TOKEN'] = token;
  if (opts.json) headers['Content-Type'] = 'application/json';
  if (opts.buffer) headers['Content-Type'] = 'application/octet-stream';

  let res;
  try {
    res = await fetch(url, {
      method: opts.method || (opts.json || opts.buffer ? 'POST' : 'GET'),
      headers,
      body: opts.json ? JSON.stringify(opts.json) : (opts.buffer || undefined),
    });
  } catch (err) {
    throw new Error('Нет связи с GitLab: ' + err.message);
  }

  if (opts.binary) {
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(humanError(res.status, safeJson(text)));
      err.status = res.status;
      throw err;
    }
    return Buffer.from(await res.arrayBuffer());
  }

  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    if (opts.allow404 && res.status === 404) return null;
    const err = new Error(humanError(res.status, data));
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return { message: String(text || '').slice(0, 200) }; }
}

function sha256Of(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Отпечаток папки: сколько файлов, сколько байт и самый свежий mtime. */
function dirSignature(dir, skip = []) {
  const patterns = backup.SKIP_ALWAYS.concat(skip);
  const skipIt = (rel) => patterns.some((re) => re.test(rel));
  let files = 0;
  let bytes = 0;
  let newest = 0;
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    let entries;
    try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const sub = rel ? rel + '/' + e.name : e.name;
      if (skipIt(sub)) continue;
      if (e.isDirectory()) { stack.push(sub); continue; }
      if (!e.isFile()) continue;
      try {
        const st = fs.statSync(path.join(dir, sub));
        bytes += st.size;
        files += 1;
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      } catch { /* файл исчез */ }
    }
  }
  return `${files}:${bytes}:${Math.round(newest)}`;
}

function loadState(file) {
  if (!file) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function saveState(file, data) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 1), 'utf8');
  } catch { /* отчётность не критична */ }
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function countFiles(dir) {
  let n = 0;
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    let entries;
    try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) stack.push(rel ? rel + '/' + e.name : e.name);
      else if (e.isFile()) n += 1;
    }
  }
  return n;
}

/* ───────────────────────────── проверка связи ───────────────────────────── */

/**
 * Проверяет токен и проект: виден ли проект, есть ли ветка.
 * Возвращает имя проекта и ветку по умолчанию — панель подставит их в поля.
 */
async function check({ token, project, branch }) {
  try {
    const t = normToken(token);
    const proj = normProject(project);
    const info = await gl(t, `/projects/${encodeURIComponent(proj)}`);
    const want = normBranch(branch);
    const br = await gl(t, `/projects/${encodeURIComponent(proj)}/repository/branches/${encodeURIComponent(want)}`, { allow404: true });
    const packages = await gl(t, `/projects/${encodeURIComponent(proj)}/packages?package_type=generic&per_page=1`)
      .catch(() => null);
    return {
      ok: true,
      provider: 'gitlab',
      project: info.path_with_namespace || proj,
      branch: want,
      branchExists: !!br,
      defaultBranch: info.default_branch || want,
      // хранилище пакетов может быть выключено администратором сервера
      packages: Array.isArray(packages),
      web: info.web_url || '',
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Проекты пользователя — для подсказки в поле «проект». */
async function listProjects(token) {
  const t = normToken(token);
  const data = await gl(t, '/projects?membership=true&per_page=50&order_by=last_activity_at');
  return (data || []).map((p) => ({
    full: p.path_with_namespace,
    name: p.name,
    private: p.visibility !== 'public',
  }));
}

/* ───────────────────────────── отправка ───────────────────────────── */

/**
 * Отправляет папку сервера в проект GitLab частями.
 *
 * @returns {Promise<{ok:boolean, upToDate?:boolean, parts?:number, size?:number,
 *                    raw?:number, format?:string, version?:string, uploaded?:number}>}
 */
async function push({ token, project, dir, onLog = () => {}, stateFile, cleanup = true, branch }) {
  const t = normToken(token);
  const proj = normProject(project);
  const enc = encodeURIComponent(proj);
  if (!dir || !fs.existsSync(dir)) return { ok: false, error: 'Папка сервера не найдена: ' + dir };

  /* быстрый выход: папка не менялась с прошлой отправки */
  const state = loadState(stateFile);
  const signature = dirSignature(dir);
  if (state.signature === signature && state.provider === 'gitlab' && state.project === proj) {
    return { ok: true, upToDate: true, uploaded: 0, project: proj, branch: normBranch(branch) };
  }

  const format = seven.available() ? '7z' : 'zip';
  const volumeMb = format === '7z' ? SPLIT_MB : 0;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-gl-'));

  try {
    onLog(`шаг 1 из 2: архивирую сервер${format === '7z' ? ` (7-Zip, части по ${SPLIT_MB} МБ)` : ' (zip)'}…`);
    const info = await backup.createBackup({
      srcDir: dir, destDir: tmpDir, label: 'server', format, volumeMb,
      skip: backup.leanSkip(), skipNames: backup.leanNames(),
    });
    const parts = info.parts && info.parts.length ? info.parts : [info.file];
    if (parts.length > MAX_PARTS) {
      return { ok: false, error: `Архив распался на ${parts.length} частей — это больше, чем разумно. Увеличь размер части (OMNI_SPLIT_MB).` };
    }
    const totalSize = parts.reduce((sum, f) => sum + fs.statSync(f).size, 0);
    onLog(`архив готов: ${MB(totalSize)} МБ из ${MB(info.raw)} МБ`
      + (info.ratio ? `, плотнее в ${info.ratio} раза` : '')
      + `, файлов ${info.files}`
      + (parts.length > 1 ? `, частей ${parts.length} по ${MB(fs.statSync(parts[0]).size)} МБ` : ''));

    const version = stamp();
    const manifest = {
      provider: 'gitlab',
      createdAt: new Date().toISOString(),
      version,
      format,
      files: info.files,
      raw: info.raw,
      packed: totalSize,
      cleanup: cleanup !== false,
      parts: parts.map((f) => ({
        name: path.basename(f).replace(/^server_\d{4}-[\d-]+_[\d-]+-[^.]*\./, 'сервер.'),
        size: fs.statSync(f).size,
        sha256: sha256Of(fs.readFileSync(f)),
      })),
    };

    onLog(`шаг 2 из 2: отправляю в GitLab ${parts.length > 1 ? parts.length + ' частей' : 'архив'} (${MB(totalSize)} МБ)…`);
    for (let i = 0; i < parts.length; i += 1) {
      const file = parts[i];
      const part = manifest.parts[i];
      const target = `/projects/${enc}/packages/generic/${PACKAGE}/${version}/${encodeURIComponent(part.name)}`;
      await gl(t, target, { method: 'PUT', buffer: fs.readFileSync(file) });
      onLog(`  часть ${i + 1} из ${parts.length}: ${part.name} — ${MB(part.size)} МБ`);
    }
    const manBuf = Buffer.from(JSON.stringify(manifest, null, 1), 'utf8');
    await gl(t, `/projects/${enc}/packages/generic/${PACKAGE}/${version}/${MANIFEST}`, {
      method: 'PUT', buffer: manBuf,
    });

    saveState(stateFile, {
      provider: 'gitlab',
      project: proj,
      branch: normBranch(branch),
      version,
      signature,
      at: new Date().toISOString(),
    });
    onLog('готово: сервер в GitLab');
    return {
      ok: true,
      project: proj,
      branch: normBranch(branch),
      version,
      uploaded: parts.length,
      parts: parts.length,
      size: totalSize,
      raw: info.raw,
      format,
      files: info.files,
      commit: version,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* временная папка */ }
  }
}

/* ───────────────────────────── забор ───────────────────────────── */

/** Свежий пакет «omnipanel-server» в проекте (или null). */
async function latestPackage(token, enc) {
  const list = await gl(token, `/projects/${enc}/packages?package_type=generic&package_name=${PACKAGE}&order_by=created_at&sort=desc&per_page=20`);
  if (!Array.isArray(list) || !list.length) return null;
  return list[0];
}

/**
 * Скачивает сервер из GitLab, распаковывает и (по умолчанию) удаляет пакет
 * из проекта, чтобы проект не распухал.
 */
async function pull({ token, project, dir, onLog = () => {}, stateFile, cleanup }) {
  const t = normToken(token);
  const proj = normProject(project);
  const enc = encodeURIComponent(proj);
  if (!dir) return { ok: false, error: 'У сервера не задана рабочая папка' };

  try {
    const pkg = await latestPackage(t, enc);
    if (!pkg) {
      return { ok: false, error: `В проекте ${proj} ещё нет отправленного сервера — сначала отправь его из панели.` };
    }
    const files = await gl(t, `/projects/${enc}/packages/${pkg.id}/package_files?per_page=200`);
    const list = Array.isArray(files) ? files : [];
    const manifestFile = list.find((f) => f.file_name === MANIFEST);
    if (!manifestFile) {
      return { ok: false, error: 'В пакете нет манифеста — он собран не панелью или удалён.' };
    }
    const manBuf = await gl(t, `/projects/${enc}/packages/${pkg.id}/package_files/${manifestFile.id}/download`, { binary: true });
    const manifest = safeJson(manBuf.toString('utf8'));
    if (!Array.isArray(manifest.parts) || !manifest.parts.length) {
      return { ok: false, error: 'Манифест пакета пуст или испорчен.' };
    }

    const total = manifest.parts.reduce((sum, p) => sum + (p.size || 0), 0);
    onLog(`шаг 1 из 2: скачиваю архив из GitLab (${MB(total)} МБ${manifest.parts.length > 1 ? `, частей ${manifest.parts.length}` : ''})…`);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-gl-pull-'));
    try {
      const local = [];
      for (let i = 0; i < manifest.parts.length; i += 1) {
        const part = manifest.parts[i];
        const remote = list.find((f) => f.file_name === part.name);
        if (!remote) {
          return { ok: false, error: `В пакете нет части ${part.name}. Отправь сервер заново.` };
        }
        const buf = await gl(t, `/projects/${enc}/packages/${pkg.id}/package_files/${remote.id}/download`, { binary: true });
        if (part.sha256 && sha256Of(buf) !== part.sha256) {
          return { ok: false, error: `Часть ${part.name} скачалась битой — контрольная сумма не совпала. Повтори забор.` };
        }
        const target = path.join(tmpDir, part.name);
        fs.writeFileSync(target, buf);
        local.push(target);
        if (manifest.parts.length > 1) onLog(`  часть ${i + 1} из ${manifest.parts.length}: ${part.name} — ${MB(buf.length)} МБ`);
      }

      const first = local[0];
      const head = fs.readFileSync(first).subarray(0, 6);
      const looks7z = head.equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]));
      onLog(`шаг 2 из 2: распаковываю архив в папку сервера (${looks7z ? '7z' : 'zip'})…`);
      let extracted = 0;
      if (looks7z) {
        if (!seven.available()) {
          return { ok: false, error: 'В GitLab лежит архив .7z, а рядом с панелью нет 7-Zip — обнови панель' };
        }
        await seven.extract({ file: first, destDir: dir });
        extracted = (await seven.list(first).catch(() => [])).filter((x) => x.Path && !x.isDir).length;
        if (!extracted) extracted = countFiles(dir);
      } else {
        const res = zip.extractFile(first, dir);
        extracted = res.files.length;
      }

      const wantCleanup = cleanup !== undefined
        ? cleanup !== false
        : manifest.cleanup !== false;
      let repoCleaned = false;
      if (wantCleanup) {
        try {
          await gl(t, `/projects/${enc}/packages/${pkg.id}`, { method: 'DELETE' });
          repoCleaned = true;
          onLog(`пакет ${PACKAGE}/${manifest.version || pkg.version} удалён из GitLab`);
        } catch (err) {
          onLog('архив распакован, но удалить пакет из GitLab не удалось: ' + err.message);
        }
      }

      saveState(stateFile, {
        provider: 'gitlab',
        project: proj,
        version: manifest.version || pkg.version,
        signature: dirSignature(dir),
        at: new Date().toISOString(),
      });

      return {
        ok: true,
        provider: 'gitlab',
        downloaded: extracted,
        changed: extracted,
        removed: 0,
        parts: manifest.parts.length,
        format: looks7z ? '7z' : 'zip',
        size: total,
        version: manifest.version || pkg.version,
        repoCleaned,
        commit: manifest.version || pkg.version,
      };
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* временная папка */ }
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  check, push, pull, listProjects,
  dirSignature, normProject, normBranch, PACKAGE, MANIFEST, SPLIT_MB,
};
