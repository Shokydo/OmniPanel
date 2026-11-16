'use strict';
/**
 * Самообновление панели из GitHub.
 *
 * Канал — публичный репозиторий. Версия и адреса файлов берутся из:
 *   1) update.json в ветке репозитория (мелкие правки кода, ~2 МБ);
 *   2) GitHub Releases: тег = версия, файлы OmniPanel-code.zip / OmniPanel-win64.zip.
 * Что новее — то и предлагается. Код ставится на месте, полная сборка
 * скачивается архивом и распаковывается отдельным .bat (exe самого себя не перепишет).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const zip = require('./zip');

const CODE_ASSET = 'OmniPanel-code.zip';
const FULL_ASSET = 'OmniPanel-win64.zip';
const SETUP_PATTERN = /^OmniPanel[-_ ]?(Setup|Установка|installer).*\.exe$/i;

/* ───────────────────────────── версии ───────────────────────────── */

/** '1.10.0' → [1,10,0]; мусор → [0,0,0]. */
function parseVersion(v) {
  const m = String(v || '').trim().replace(/^v/i, '').match(/\d+(\.\d+)*/);
  if (!m) return [0, 0, 0];
  const parts = m[0].split('.').map((n) => Number(n) || 0);
  while (parts.length < 3) parts.push(0);
  return parts.slice(0, 3);
}

/** 1, если a новее b; -1, если старее; 0 — равны. */
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (x[i] > y[i]) return 1;
    if (x[i] < y[i]) return -1;
  }
  return 0;
}

/* ───────────────────────────── сеть ───────────────────────────── */

function rawBase() {
  return (process.env.OMNI_UPDATE_RAW || 'https://raw.githubusercontent.com').replace(/\/+$/, '');
}

function apiBase() {
  return (process.env.OMNI_UPDATE_API || process.env.OMNI_GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');
}

/** 'owner/repo', 'https://github.com/owner/repo' → 'owner/repo'. */
function normalizeRepo(repo) {
  const raw = String(repo || '').trim();
  if (!raw) return '';
  const m = raw.match(/github\.com[/:]+([^/\s]+)\/([^/\s#?]+)/i);
  if (m) return `${m[1]}/${m[2].replace(/\.git$/i, '')}`;
  const simple = raw.match(/^([\w.-]+)\/([\w.-]+)$/);
  return simple ? `${simple[1]}/${simple[2].replace(/\.git$/i, '')}` : '';
}

function safeToken(url, token) {
  if (!token) return {};
  try {
    const host = new URL(url).hostname;
    // токен отправляем только самому GitHub, не зеркалам и не CDN
    if (/(^|\.)github\.com$|(^|\.)githubusercontent\.com$/.test(host)) return { Authorization: `Bearer ${token}` };
  } catch { /* ignore */ }
  return {};
}

function request(url, opts = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { reject(new Error('неверный адрес: ' + url)); return; }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.get(u, {
      headers: {
        'User-Agent': 'OmniPanel-updater',
        Accept: opts.accept || 'application/json, application/octet-stream, */*',
        ...safeToken(url, opts.token),
      },
      timeout: opts.timeout || 12000,
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects > 6) { reject(new Error('слишком много перенаправлений')); return; }
        const next = new URL(res.headers.location, url).toString();
        resolve(request(next, opts, redirects + 1));
        return;
      }
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error('сервер не ответил вовремя')));
    req.on('error', reject);
  });
}

async function fetchText(url, opts = {}) {
  const res = await request(url, opts);
  if (res.statusCode === 404) { res.resume(); return { ok: false, status: 404, text: '' }; }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    res.resume();
    return { ok: false, status: res.statusCode, text: '' };
  }
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return { ok: true, status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') };
}

async function fetchJson(url, opts = {}) {
  const r = await fetchText(url, opts);
  if (!r.ok || !r.text) return r;
  try { return { ...r, json: JSON.parse(r.text) }; } catch { return { ok: false, status: r.status, text: r.text }; }
}

/** Скачать файл с прогрессом. */
async function download(url, dest, opts = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = await request(url, opts);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    res.resume();
    throw new Error(res.statusCode === 404 ? 'файл не найден на GitHub' : `GitHub ответил ${res.statusCode}`);
  }
  const total = Number(res.headers['content-length']) || 0;
  const tmp = dest + '.part';
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmp);
    let received = 0;
    let last = 0;
    res.on('data', (chunk) => {
      received += chunk.length;
      const now = Date.now();
      if (opts.onProgress && now - last > 120) {
        last = now;
        opts.onProgress({ received, total });
      }
    });
    res.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    res.pipe(out);
  });
  fs.renameSync(tmp, dest);
  const size = fs.statSync(dest).size;
  if (opts.onProgress) opts.onProgress({ received: size, total: size, done: true });
  return { file: dest, size };
}

function sha256File(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

/* ───────────────────────────── источники ───────────────────────────── */

function resolveAsset(spec, repoBase) {
  if (!spec) return null;
  if (typeof spec === 'string') {
    return { url: /^https?:/i.test(spec) ? spec : `${repoBase}/${spec.replace(/^\/+/, '')}`, size: 0, sha256: '' };
  }
  const url = spec.url ? String(spec.url) : `${repoBase}/${String(spec.file || '').replace(/^\/+/, '')}`;
  if (!spec.url && !spec.file) return null;
  return { url, size: Number(spec.size) || 0, sha256: String(spec.sha256 || '') };
}

/**
 * Адрес со «свежим» параметром. raw.githubusercontent отдаёт файлы с кэшем
 * в пять минут: сразу после релиза по старому адресу прилетал предыдущий архив,
 * не сходилась sha256, и обновление падало («файл повреждён»). С nonce кэш
 * промахивается и отдаёт настоящий файл.
 */
function bust(url) {
  try {
    const u = new URL(url);
    u.searchParams.set('_', `${Date.now()}${Math.random().toString(36).slice(2, 8)}`);
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Скачивание с обходом кэша и проверкой sha256.
 * Если сумма не сошлась — значит CDN отдал старую копию: качаем ещё раз
 * по новому адресу. Только после второй неудачи отдаём ошибку.
 *
 * @returns {Promise<{file:string,size:number,sha256:string,attempts:number}>}
 */
async function downloadChecked(url, dest, opts = {}) {
  const want = String(opts.sha256 || '');
  let lastError = '';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const target = bust(url);
    const r = await download(target, dest, opts);
    const got = sha256File(dest);
    if (!want || got === want) return { ...r, sha256: got, attempts: attempt };
    lastError = `контрольная сумма не совпала (ждали ${want.slice(0, 12)}…, получили ${got.slice(0, 12)}…)`;
    if (attempt === 1) await new Promise((res) => setTimeout(res, 1200));
  }
  throw new Error(lastError || 'файл не скачался');
}

/**
 * update.json из ветки репозитория.
 *
 * raw.githubusercontent.com кэширует файлы на пять минут и при этом игнорирует
 * параметр-обходчик в адресе, поэтому сразу после релиза оттуда приходит прошлая
 * версия. Сначала спрашиваем API (он отдаёт актуальное дерево), и только если
 * API недоступен — идём на raw.
 */
async function fromManifest({ repo, branch = 'main', token }) {
  const base = `${rawBase()}/${repo}/${branch}`;

  const viaApi = await fetchText(
    `${apiBase()}/repos/${repo}/contents/update.json?ref=${encodeURIComponent(branch)}`,
    { token, accept: 'application/vnd.github.raw' },
  ).catch(() => null);
  const apiJson = (() => {
    if (!viaApi || !viaApi.ok || !viaApi.text) return null;
    try { return JSON.parse(viaApi.text); } catch { return null; }
  })();
  const apiBaseUrl = `${apiBase()}/repos/${repo}/contents`;
  const fromApi = apiJson && apiJson.version ? {
    source: 'файл update.json',
    version: String(apiJson.version),
    notes: String(apiJson.notes || ''),
    code: resolveApiAsset(apiJson.code, apiBaseUrl, branch),
    full: resolveApiAsset(apiJson.full, apiBaseUrl, branch),
  } : null;
  if (fromApi) return fromApi;

  const r = await fetchJson(`${base}/update.json?_=${Date.now()}`, { token });
  if (!r.ok || !r.json) return null;
  const m = r.json;
  if (!m.version) return null;
  return {
    source: 'файл update.json',
    version: String(m.version),
    notes: String(m.notes || ''),
    code: resolveAsset(m.code, base),
    full: resolveAsset(m.full, base),
  };
}

/**
 * Ссылка на файл из update.json, но через API — там нет пятиминутного кэша.
 * API отдаёт содержимое файла, если попросить Accept: application/vnd.github.raw.
 */
function resolveApiAsset(spec, apiContents, branch) {
  if (!spec) return null;
  const rel = typeof spec === 'string' ? spec : String(spec.file || '');
  const size = typeof spec === 'string' ? 0 : Number(spec.size) || 0;
  const sha256 = typeof spec === 'string' ? '' : String(spec.sha256 || '');
  if (!rel) {
    if (typeof spec === 'object' && spec.url) return resolveAsset(spec, '');
    return null;
  }
  const clean = rel.replace(/^\/+/, '');
  return {
    url: `${apiContents}/${clean}?ref=${encodeURIComponent(branch)}`,
    size,
    sha256,
    accept: 'application/vnd.github.raw',
  };
}

/** Последний релиз через API GitHub. */
async function fromRelease({ repo, token }) {
  const r = await fetchJson(`${apiBase()}/repos/${repo}/releases/latest`, { token });
  if (!r.ok || !r.json || !r.json.tag_name) return null;
  const rel = r.json;
  const find = (name) => (rel.assets || []).find((a) => a.name === name);
  const codeAsset = find(CODE_ASSET);
  const fullAsset = find(FULL_ASSET);
  const setupAsset = (rel.assets || []).find((a) => SETUP_PATTERN.test(a.name));
  return {
    source: 'релиз ' + rel.tag_name,
    version: String(rel.tag_name).replace(/^v/i, ''),
    notes: String(rel.body || ''),
    code: codeAsset ? { url: codeAsset.browser_download_url, size: codeAsset.size || 0, sha256: '' } : null,
    full: fullAsset ? { url: fullAsset.browser_download_url, size: fullAsset.size || 0, sha256: '' } : null,
    setup: setupAsset ? { url: setupAsset.browser_download_url, size: setupAsset.size || 0, name: setupAsset.name, sha256: '' } : null,
  };
}

/**
 * Проверить обновления.
 * @param {{repo:string, branch?:string, token?:string, current:string}} opts
 */
async function check(opts = {}) {
  const repo = normalizeRepo(opts.repo);
  const current = String(opts.current || '0.0.0');
  if (!repo) return { ok: false, error: 'не указан репозиторий обновлений (владелец/репозиторий)' };

  const branch = opts.branch || 'main';
  const [man, rel] = await Promise.all([
    fromManifest({ repo, branch, token: opts.token }).catch(() => null),
    fromRelease({ repo, token: opts.token }).catch(() => null),
  ]);

  const found = [man, rel].filter(Boolean);
  if (!found.length) {
    return { ok: false, error: 'на GitHub не нашёл ни update.json, ни релизов в ' + repo, repo, current };
  }

  const latest = found.reduce((a, b) => (compareVersions(b.version, a.version) > 0 ? b : a));
  // недостающие ссылки добираем из второго источника
  /* архив кода лучше брать из релиза: там отдаёт не raw-кэш, а хранилище ассетов.
     raw.githubusercontent отдаёт до пяти минут прошлую версию, поэтому он — последний. */
  const codeList = [rel, man].filter(Boolean).map((f) => f.code).filter(Boolean);
  const code = codeList.find((c) => !/raw\.githubusercontent\.com/i.test(c.url)) || codeList[0] || null;
  /* у ассетов релиза GitHub не отдаёт контрольную сумму — берём её из update.json
     той же версии, чтобы скачанное всё равно проверялось */
  if (code && !code.sha256) {
    const withSha = found
      .filter((f) => compareVersions(f.version, latest.version) === 0 && f.code && f.code.sha256)
      .map((f) => f.code)[0];
    if (withSha) code.sha256 = withSha.sha256;
  }
  /* Установщик и полную сборку берём только у ТОЙ ЖЕ версии, что признана свежей.
     Иначе панель с новым кодом предлагала бы «полную сборку» из старого релиза —
     то есть откат на предыдущую версию. */
  const same = found.filter((f) => compareVersions(f.version, latest.version) === 0);
  const full = latest.full || (same.map((f) => f.full).find(Boolean) || null);
  const setup = latest.setup || (same.map((f) => f.setup).find(Boolean) || null);

  return {
    ok: true,
    repo,
    branch,
    current,
    latest: latest.version,
    hasUpdate: compareVersions(latest.version, current) > 0,
    notes: latest.notes,
    source: latest.source,
    code,
    full,
    setup,
    checkedAt: new Date().toISOString(),
  };
}

/* ───────────────────────────── установка кода ───────────────────────────── */

const CODE_ROOTS = ['main.js', 'preload.js', 'web.js', 'package.json', 'README.md', 'ЧИТАЙ-МЕНЯ.txt', 'servers.example.json', 'ui', 'core', 'assets', 'tools', 'demo'];
const MUST_HAVE = ['main.js', 'package.json', 'ui/index.html', 'ui/app.js'];

/**
 * Данные пользователя — их обновление трогать не имеет права.
 * Настройки серверов, профиль GitHub, избранное, бэкапы, история TPS лежат
 * в OmniPanelData рядом с программой; в браузерном режиме — в data.
 */
const PROTECTED_DIRS = ['omnipaneldata', 'data', 'backups', 'tps', 'logs', 'updates'];
const PROTECTED_FILES = ['servers.json', 'panel.json'];

function isProtected(rel) {
  const parts = String(rel).replace(/\\/g, '/').split('/');
  const first = (parts[0] || '').toLowerCase();
  if (PROTECTED_DIRS.includes(first)) return true;
  if (parts.length === 1 && PROTECTED_FILES.includes(first)) return true;
  return false;
}

/** Копия пользовательских настроек перед обновлением (только мелкие файлы). */
function snapshotUserConfig(appDir, destDir) {
  const saved = [];
  const candidates = [
    path.join(appDir, 'OmniPanelData', 'servers.json'),
    path.join(appDir, 'OmniPanelData', 'panel.json'),
    path.join(appDir, 'data', 'servers.json'),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const rel = path.relative(appDir, file);
    const target = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file, target);
    saved.push(rel);
  }
  return saved;
}

function restoreUserConfig(appDir, snapDir, saved) {
  const restored = [];
  for (const rel of saved) {
    const target = path.join(appDir, rel);
    if (fs.existsSync(target)) continue;
    const from = path.join(snapDir, rel);
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(from, target);
    restored.push(rel);
  }
  return restored;
}

const listFile = (appDir) => path.join(appDir, 'update-installed.json');

function readInstalled(appDir) {
  try { return JSON.parse(fs.readFileSync(listFile(appDir), 'utf8')); } catch { return { files: [] }; }
}

/** Файлы самой панели, которые сейчас лежат в папке программы. */
function currentFiles(appDir) {
  const out = [];
  for (const root of CODE_ROOTS) {
    const abs = path.join(appDir, root);
    if (!fs.existsSync(abs)) continue;
    if (fs.statSync(abs).isDirectory()) copyDir(abs, abs, out, root); // только обходим, ничего не копируем
    else out.push(root);
  }
  return out;
}

function copyDir(src, dst, files, rel = '') {
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name);
    const to = path.join(dst, name);
    const relPath = rel ? `${rel}/${name}` : name;
    const st = fs.statSync(from);
    if (st.isDirectory()) {
      fs.mkdirSync(to, { recursive: true });
      copyDir(from, to, files, relPath);
    } else {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      files.push(relPath);
    }
  }
}

/**
 * Поставить скачанный архив с кодом поверх текущей панели.
 * Перед этим старые файлы панели копируются в папку бэкапа.
 * @returns {{ok:boolean, applied:string[], removed:string[], backup:string, version:string}}
 */
function applyCode({ appDir, zipPath, backupDir, version = '', backupLabel = '' }) {
  if (!fs.existsSync(zipPath)) return { ok: false, error: 'архив обновления не найден' };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-upd-'));
  try {
    let files;
    try {
      ({ files } = zip.extractFile(zipPath, tmp, { expect: 'main.js' }));
    } catch (err) {
      return { ok: false, error: err.message };
    }
    const missing = MUST_HAVE.filter((f) => !files.includes(f));
    if (missing.length) return { ok: false, error: 'в архиве нет файлов панели: ' + missing.join(', ') };

    // данные пользователя не трогаем, даже если они случайно попали в архив
    const blocked = files.filter((f) => isProtected(f));
    const codeFiles = files.filter((f) => !isProtected(f));
    if (!codeFiles.includes('main.js')) return { ok: false, error: 'в архиве нет main.js' };

    // 1. бэкап текущих файлов панели
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backup = path.join(backupDir, `before-${backupLabel || version || 'update'}-${stamp}`);
    fs.mkdirSync(backup, { recursive: true });
    const backed = [];
    for (const root of CODE_ROOTS) {
      const from = path.join(appDir, root);
      if (!fs.existsSync(from)) continue;
      const st = fs.statSync(from);
      if (st.isDirectory()) {
        fs.mkdirSync(path.join(backup, root), { recursive: true });
        copyDir(from, path.join(backup, root), backed, root);
      } else {
        fs.copyFileSync(from, path.join(backup, root));
        backed.push(root);
      }
    }

    // 1b. страховка: снимок пользовательских настроек (мелкие json)
    const userSnap = path.join(backup, '_user-config');
    const userSaved = snapshotUserConfig(appDir, userSnap);

    // 2. убрать файлы прошлого обновления, которых нет в новом
    // что было раньше: состав прошлого обновления + файлы, реально лежащие на диске
    const prev = new Set([...(readInstalled(appDir).files || []), ...currentFiles(appDir)]);
    const removed = [];
    for (const rel of prev) {
      if (files.includes(rel) || isProtected(rel)) continue;
      const target = path.join(appDir, rel);
      if (!fs.existsSync(target)) continue;
      try { fs.unlinkSync(target); removed.push(rel); } catch { /* занят — пропускаем */ }
    }

    // 3. разложить новые файлы (только код)
    for (const rel of codeFiles) {
      const from = path.join(tmp, rel);
      const to = path.join(appDir, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }

    // 4. проверить, что настройки пользователя на месте (и вернуть, если что-то пропало)
    const restored = restoreUserConfig(appDir, userSnap, userSaved);

    // 5. запомнить состав, чтобы следующее обновление знало, что убирать
    fs.writeFileSync(listFile(appDir), JSON.stringify({
      version, at: new Date().toISOString(), files: codeFiles,
    }, null, 1), 'utf8');

    return {
      ok: true,
      applied: codeFiles,
      removed,
      backup,
      version,
      kept: userSaved.filter((f) => fs.existsSync(path.join(appDir, f))),
      restored,
      blocked: blocked.length ? blocked : undefined,
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/* ───────────────────────────── полная сборка ───────────────────────────── */

/**
 * Сохранить полную сборку и подготовить .bat, который заменит папку программы.
 * Файл кладём рядом с папкой панели: сама папка во время работы занята.
 */
function saveFullPackage({ zipPath, exeDir, updatesDir }) {
  const programDir = path.resolve(exeDir);
  const parent = path.dirname(programDir);
  const folder = path.basename(programDir);
  fs.mkdirSync(updatesDir, { recursive: true });
  const saved = path.join(updatesDir, FULL_ASSET);
  fs.copyFileSync(zipPath, saved);

  const bat = path.join(parent, 'Обновить-OmniPanel.bat');
  const lines = [
    '@echo off',
    'chcp 65001 >nul',
    'title Обновление OmniPanel',
    'echo Закрываю панель...',
    'taskkill /im OmniPanel.exe /f >nul 2>&1',
    'timeout /t 2 /nobreak >nul',
    `echo Распаковываю новую версию в ${parent}`,
    `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${saved}' -DestinationPath '${parent}' -Force"`,
    'if errorlevel 1 (',
    '  echo Не удалось распаковать архив.',
    '  pause',
    '  exit /b 1',
    ')',
    `start "" "${path.join(parent, folder, 'OmniPanel.exe')}"`,
    'del "%~f0" >nul 2>&1',
  ];
  fs.writeFileSync(bat, lines.join('\r\n') + '\r\n', 'utf8');
  return { ok: true, archive: saved, script: bat, parent, folder };
}

/* ───────────────────────────── обслуживание ───────────────────────────── */

/** Удалить старые бэкапы обновлений, оставив последние `keep`. */
function pruneBackups(backupDir, keep = 2) {
  try {
    const dirs = fs.readdirSync(backupDir)
      .filter((n) => n.startsWith('before-'))
      .map((n) => ({ n, t: fs.statSync(path.join(backupDir, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const d of dirs.slice(keep)) fs.rmSync(path.join(backupDir, d.n), { recursive: true, force: true });
  } catch { /* не критично */ }
}

module.exports = {
  bust, downloadChecked,
  parseVersion,
  compareVersions,
  normalizeRepo,
  check,
  download,
  sha256File,
  applyCode,
  saveFullPackage,
  pruneBackups,
  CODE_ASSET,
  FULL_ASSET,
  SETUP_PATTERN,
  CODE_ROOTS,
  currentFiles,
  isProtected,
};
