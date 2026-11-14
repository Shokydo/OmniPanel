'use strict';
/**
 * Выкладывание обновления в репозиторий GitHub — без git и без ручной загрузки файлов.
 *
 *   node tools/upload-update.js [параметры]
 *
 *   --repo  владелец/репозиторий   (по умолчанию из настроек панели или Shokydo/OmniPanel)
 *   --branch main
 *   --token ghp_…                  (если не указан — берётся из настроек панели)
 *   --dir   папка с update.json    (по умолчанию папка, где лежит этот скрипт)
 *   --notes "что нового"
 *   --full  путь к OmniPanel-win64.zip  (приложить к релизу; ищется рядом автоматически)
 *   --no-release                   не создавать релиз, только файлы в репозиторий
 *   --dry                          показать, что будет сделано, ничего не отправляя
 *
 * Что делает:
 *   1. читает update.json и архив кода, считает контрольные суммы;
 *   2. заливает в репозиторий update.json и OmniPanel-code.zip (создаёт или обновляет);
 *   3. создаёт релиз v<версия> и прикладывает к нему полную сборку, если она есть.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

/* ───────────────────────────── параметры ───────────────────────────── */

function arg(name, fallback = '') {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}
const has = (name) => process.argv.includes('--' + name);

const ROOT = path.dirname(__dirname);          // папка программы (…/resources/app)
const HERE = __dirname;

function apiBase() {
  return (process.env.OMNI_GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');
}
function uploadBase() {
  return (process.env.OMNI_GITHUB_UPLOAD || 'https://uploads.github.com').replace(/\/+$/, '');
}

/* ───────────────────────────── токен и репозиторий ───────────────────────────── */

function panelJsonPaths() {
  const out = [];
  const dirs = [];
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'OmniPanel'));
  dirs.push(path.join(os.homedir(), '.config', 'OmniPanel'));
  try { dirs.push(path.join(path.dirname(process.execPath), 'OmniPanelData')); } catch { /* ignore */ }
  dirs.push(path.join(ROOT, 'OmniPanelData'));
  dirs.push(path.join(ROOT, '..', 'OmniPanelData'));
  dirs.push(path.join(ROOT, 'data'));
  for (const d of dirs) out.push(path.join(d, 'panel.json'));
  return out;
}

function readPanelSettings() {
  for (const p of panelJsonPaths()) {
    try {
      if (!fs.existsSync(p)) continue;
      const data = JSON.parse(fs.readFileSync(p, 'utf8')) || {};
      return { file: p, data };
    } catch { /* битый файл — пробуем следующий */ }
  }
  return { file: '', data: {} };
}

function resolveToken() {
  const fromArg = arg('token');
  if (fromArg && fromArg !== true) return { token: String(fromArg).trim(), from: 'параметр --token' };
  const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (env) return { token: String(env).trim(), from: 'переменная окружения' };
  const panel = readPanelSettings();
  if (panel.data.githubToken) return { token: String(panel.data.githubToken).trim(), from: panel.file };
  return { token: '', from: '' };
}

function normRepo(value) {
  const raw = String(value || '').trim();
  const m = raw.match(/github\.com[/:]+([^/\s]+)\/([^/\s#?]+)/i);
  if (m) return `${m[1]}/${m[2].replace(/\.git$/i, '')}`;
  const simple = raw.match(/^([\w.-]+)\/([\w.-]+)$/);
  return simple ? `${simple[1]}/${simple[2].replace(/\.git$/i, '')}` : '';
}

function resolveRepo() {
  const fromArg = arg('repo');
  if (fromArg && fromArg !== true) return normRepo(String(fromArg));
  const panel = readPanelSettings();
  const fromPanel = normRepo(panel.data.updateRepo);
  return fromPanel || 'Shokydo/OmniPanel';
}

/* ───────────────────────────── запросы ───────────────────────────── */

async function api(token, urlPath, opts = {}) {
  const url = urlPath.startsWith('http') ? urlPath : apiBase() + urlPath;
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'OmniPanel-publisher',
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
    throw new Error('нет связи с GitHub: ' + err.message);
  }
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 300) }; } }
  if (!res.ok) {
    if (opts.allow404 && res.status === 404) return null;
    const msg = (data && (data.message || data.error)) || '';
    if (res.status === 401) throw new Error('токен не подошёл (401) — создай новый с галочкой «repo»');
    if (res.status === 403 && /rate limit/i.test(msg)) throw new Error('GitHub ограничил запросы (403), подожди пару минут');
    if (res.status === 403) throw new Error('нет прав на запись (403) — в токене нужна галочка «repo»');
    if (res.status === 404) throw new Error(`репозиторий не найден или у токена нет доступа (404)`);
    throw new Error(`GitHub ответил ${res.status}${msg ? ': ' + msg : ''}`);
  }
  return data;
}

async function putFile(token, repo, branch, remotePath, localFile, message) {
  const content = fs.readFileSync(localFile);
  const existing = await api(token, `/repos/${repo}/contents/${encodeURI(remotePath)}?ref=${encodeURIComponent(branch)}`, { allow404: true });
  if (existing && Array.isArray(existing)) {
    throw new Error(`${remotePath} на GitHub — это папка, а нужен файл`);
  }
  const body = {
    message,
    content: content.toString('base64'),
    branch,
  };
  if (existing && existing.sha) body.sha = existing.sha;
  const res = await api(token, `/repos/${repo}/contents/${encodeURI(remotePath)}`, { method: 'PUT', body });
  return {
    path: remotePath,
    bytes: content.length,
    sha: (res && res.content && res.content.sha) || '',
    created: !(existing && existing.sha),
    html: (res && res.content && res.content.html_url) || '',
  };
}

async function ensureRelease(token, repo, version, notes) {
  const tag = 'v' + String(version).replace(/^v/i, '');
  const existing = await api(token, `/repos/${repo}/releases/tags/${tag}`, { allow404: true });
  if (existing) return { release: existing, created: false, tag };
  const release = await api(token, `/repos/${repo}/releases`, {
    method: 'POST',
    body: {
      tag_name: tag,
      name: `OmniPanel ${version}`,
      body: notes || `OmniPanel ${version}`,
      draft: false,
      prerelease: false,
    },
  });
  return { release, created: true, tag };
}

async function uploadAsset(token, repo, release, file, forceName = '') {
  // имя файла в релизе важно: панель ищет ровно OmniPanel-win64.zip / OmniPanel-code.zip
  const base = path.basename(file);
  let name = forceName || base;
  if (!forceName) {
    if (/^OmniPanel-code\.zip$/i.test(base)) name = 'OmniPanel-code.zip';
    else if (/win64|setup|win/i.test(base) || /\.zip$/i.test(base)) name = 'OmniPanel-win64.zip';
  }
  const already = (release.assets || []).find((a) => a.name === name);
  if (already) {
    // старый файл удаляем, чтобы не было 422 при повторной загрузке
    await api(token, `/repos/${repo}/releases/assets/${already.id}`, { method: 'DELETE' });
  }
  const data = fs.readFileSync(file);
  const url = `${uploadBase()}/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `token ${token}`,
        'User-Agent': 'OmniPanel-publisher',
        'Content-Type': 'application/zip',
        'Content-Length': String(data.length),
      },
      body: data,
    });
  } catch (err) {
    throw new Error('не удалось загрузить сборку: ' + err.message);
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  if (!res.ok) {
    throw new Error(`сборка не загрузилась: GitHub ответил ${res.status}${json && json.message ? ' — ' + json.message : ''}`);
  }
  return { name, size: data.length, url: (json && json.browser_download_url) || '' };
}

/* ───────────────────────────── основное ───────────────────────────── */

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Где искать update.json: --dir, потом папка рядом со скриптом, потом родительская. */
function findDir() {
  const fromArg = arg('dir');
  const candidates = fromArg && fromArg !== true
    ? [String(fromArg)]
    : [path.basename(HERE) === 'tools' ? path.dirname(HERE) : HERE, HERE, path.dirname(HERE)];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'update.json'))) return c;
  }
  return candidates[0];
}

async function main() {
  const dir = findDir();
  const manifestPath = path.join(dir, 'update.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`не нашёл update.json в ${dir} — положи скрипт рядом с update.json или укажи --dir`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const version = String(manifest.version || '').trim();
  if (!version) throw new Error('в update.json нет поля version');

  // архив кода: путь из манифеста (dist/OmniPanel-code.zip) или рядом,
  // локальный путь можно переопределить параметром --code
  const codeRel = (manifest.code && manifest.code.file) || 'dist/OmniPanel-code.zip';
  const codeOverride = arg('code');
  const codeLocal = codeOverride && codeOverride !== true
    ? String(codeOverride)
    : (path.isAbsolute(codeRel) ? codeRel : path.join(dir, codeRel));
  if (!fs.existsSync(codeLocal)) throw new Error(`не нашёл архив кода ${codeLocal}`);

  // контрольные суммы считаем заново — файл мог измениться
  manifest.code = { ...(manifest.code || {}), file: codeRel, size: fs.statSync(codeLocal).size, sha256: sha256(codeLocal) };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  const repo = resolveRepo();
  const branch = String(arg('branch', 'main'));
  const notes = String(arg('notes', manifest.notes || `OmniPanel ${version}`));
  const { token, from } = resolveToken();

  // полная сборка — если лежит рядом
  let setupFile = '';
  const setupArg = arg('exe');
  if (setupArg && setupArg !== true) setupFile = String(setupArg);
  if (setupFile && !fs.existsSync(setupFile)) throw new Error(`не нашёл установщик ${setupFile}`);

  let fullFile = '';
  const fullArg = arg('full');
  const fullCandidates = [
    fullArg && fullArg !== true ? String(fullArg) : '',
    path.join(dir, 'dist', 'OmniPanel-win64.zip'),
    path.join(dir, 'OmniPanel-win64.zip'),
  ].filter(Boolean);
  fullFile = fullCandidates.find((p) => fs.existsSync(p)) || '';

  console.log(`репозиторий: ${repo} (ветка ${branch})`);
  console.log(`версия:      ${version}`);
  console.log(`код:         ${codeRel} — ${(manifest.code.size / 1048576).toFixed(2)} МБ (локально: ${path.relative(process.cwd(), codeLocal) || codeLocal})`);
  console.log(`установщик:  ${setupFile ? path.basename(setupFile) + ' — ' + (fs.statSync(setupFile).size / 1048576).toFixed(1) + ' МБ' : 'не указан'}`);
  console.log(`сборка:      ${fullFile ? path.basename(fullFile) + ' — ' + (fs.statSync(fullFile).size / 1048576).toFixed(1) + ' МБ' : 'не найдена (только код)'}`);
  console.log(`токен:       ${token ? 'найден (' + from + ')' : 'НЕ НАЙДЕН'}`);

  if (has('dry')) {
    console.log('\n--dry: ничего не отправляю');
    return { ok: true, dry: true };
  }
  if (!token) {
    throw new Error('нужен токен GitHub: либо войди в панели (Настройки → GitHub), либо запусти с --token ghp_…');
  }

  console.log('\n1/3 файлы в репозиторий…');
  const codePut = await putFile(token, repo, branch, codeRel, codeLocal, `OmniPanel ${version}: архив кода`);
  console.log(`   ${codePut.created ? 'создан' : 'обновлён'} ${codePut.path}`);

  // update.json отправляем после архива, чтобы сумма точно совпадала с файлом в репозитории
  const manPut = await putFile(token, repo, branch, 'update.json', manifestPath, `OmniPanel ${version}: версия и контрольные суммы`);
  console.log(`   ${manPut.created ? 'создан' : 'обновлён'} update.json`);
  manifest.full = null;

  let rel = null;
  let asset = null;
  if (!has('no-release')) {
    console.log('\n2/3 релиз…');
    rel = await ensureRelease(token, repo, version, notes);
    console.log(`   ${rel.created ? 'создан' : 'уже был'} релиз ${rel.tag}`);
    if (setupFile) {
      console.log('\n3/4 установщик к релизу…');
      const setupName = `OmniPanel-Setup-${version}.exe`;
      asset = await uploadAsset(token, repo, rel.release, setupFile, setupName);
      console.log(`   загружено ${asset.name} (${(asset.size / 1048576).toFixed(1)} МБ)`);
    }
    if (fullFile) {
      console.log('\n4/4 полная сборка к релизу…');
      const fullAsset = await uploadAsset(token, repo, rel.release, fullFile, 'OmniPanel-win64.zip');
      console.log(`   загружено ${fullAsset.name} (${(fullAsset.size / 1048576).toFixed(1)} МБ)`);
    }
    if (!setupFile && !fullFile) {
      console.log('\n3/3 ни установщик, ни сборка не найдены — панель обновится только кодом');
    }
  }

  console.log('\nготово:');
  console.log(`   https://github.com/${repo}`);
  if (rel) console.log(`   https://github.com/${repo}/releases/tag/${rel.tag}`);
  console.log(`\nв панели: Настройки → Обновления → репозиторий «${repo}», ветка ${branch}`);
  return { ok: true, repo, branch, version, code: codePut, manifest: manPut, release: rel && rel.tag, asset, setup: !!setupFile };
}

if (require.main === module) {
  main().then(() => {
    process.exitCode = 0;
  }).catch((err) => {
    console.error('\nОШИБКА: ' + err.message);
    process.exitCode = 1;
  });
}

module.exports = { main, putFile, ensureRelease, uploadAsset, normRepo, resolveToken };
