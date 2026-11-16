'use strict';
/**
 * Файловый менеджер панели: просмотр и правка файлов внутри папки сервера.
 *
 * Безопасность: любой путь резолвится относительно корня (папки сервера)
 * и проверяется — выйти за пределы корня нельзя, символические ссылки
 * наружу тоже отсекаются.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const MAX_READ = 16 * 1024 * 1024;     // в редактор грузим до 16 МБ — логи и большие yml влезают
const MAX_WRITE = 32 * 1024 * 1024;    // и записывать столько же
const MAX_IMAGE = 12 * 1024 * 1024;    // картинки показываем до 12 МБ
const MAX_TREE_ENTRIES = 4000;         // предохранитель от гигантских папок

/** Корень папки сервера + проверка, что rel не вылезает наружу. */
function resolveSafe(root, rel = '') {
  if (!root) throw new Error('У сервера не задана рабочая папка');
  const rootAbs = path.resolve(root);
  const target = path.resolve(rootAbs, String(rel || '').replace(/^[/\\]+/, ''));
  if (target !== rootAbs && !target.startsWith(rootAbs + path.sep)) {
    throw new Error('Путь вне папки сервера — отказано');
  }
  // симлинк внутрь/наружу: сверяем реальные пути, если файл существует
  try {
    const realRoot = fs.realpathSync(rootAbs);
    const realTarget = fs.realpathSync(target);
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
      throw new Error('Ссылка указывает вне папки сервера — отказано');
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return target;
}

/** Относительный путь в стиле панели (всегда через «/»). */
function relOf(root, abs) {
  const r = path.relative(path.resolve(root), abs);
  return r.split(path.sep).join('/');
}

function kindOf(name) {
  const ext = path.extname(name).toLowerCase();
  if (['.yml', '.yaml'].includes(ext)) return 'yaml';
  if (ext === '.json' || ext === '.json5') return 'json';
  if (['.properties', '.env', '.conf', '.ini', '.cfg', '.toml'].includes(ext)) return 'properties';
  if (ext === '.txt' || ext === '.log' || ext === '.md' || ext === '.mcfunction' || ext === '.sh' || ext === '.bat') return 'text';
  if (ext === '.js' || ext === '.mjs' || ext === '.ts') return 'js';
  if (IMAGE_EXT.test(ext)) return 'image';
  if (ARCHIVE_EXT.test(ext)) return 'archive';
  if (['.rar', '.7z', '.tar', '.gz', '.tgz', '.bz2', '.xz'].includes(ext)) return 'archive-other';
  if (ext === '.jar' || ext === '.dat' || ext === '.mca' || ext === '.lock') return 'binary';
  return 'text';
}

const IMAGE_EXT = /^\.(png|jpe?g|gif|webp|bmp|ico)$/i;
const ARCHIVE_EXT = /^\.(zip|jar|mcpack|whl|epub)$/i;

const BINARY_KINDS = new Set(['binary', 'archive', 'archive-other']);

const IMAGE_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
};

/** Картинка как data URL — чтобы показать её прямо в редакторе. */
async function readImage(root, rel) {
  const abs = resolveSafe(root, rel);
  const st = await fsp.stat(abs);
  if (st.size > MAX_IMAGE) throw new Error(`Картинка больше ${Math.round(MAX_IMAGE / 1048576)} МБ — не показываю`);
  const ext = path.extname(abs).toLowerCase();
  const mime = IMAGE_MIME[ext] || 'application/octet-stream';
  const buf = await fsp.readFile(abs);
  return {
    path: relOf(root, abs),
    kind: 'image',
    size: st.size,
    mtime: st.mtimeMs,
    dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
  };
}

/** Список одной папки. */
async function listDir(root, rel = '') {
  const abs = resolveSafe(root, rel);
  const st = await fsp.stat(abs);
  if (!st.isDirectory()) throw new Error('Это не папка');

  const names = await fsp.readdir(abs, { withFileTypes: true });
  const items = [];
  for (const d of names) {
    const full = path.join(abs, d.name);
    let size = 0;
    let mtime = 0;
    try {
      const s = await fsp.lstat(full);
      size = s.size;
      mtime = s.mtimeMs;
    } catch { /* файл мог исчезнуть между readdir и stat */ }
    items.push({
      name: d.name,
      path: relOf(root, full),
      isDir: d.isDirectory(),
      size,
      mtime,
      kind: d.isDirectory() ? 'dir' : kindOf(d.name),
      ext: path.extname(d.name).toLowerCase(),
    });
    if (items.length >= MAX_TREE_ENTRIES) break;
  }

  // папки сверху, внутри — по алфавиту, но с «человеческим» сравнением
  const cmp = (a, b) => a.localeCompare(b, 'ru', { numeric: true, sensitivity: 'base' });
  items.sort((a, b) => (b.isDir - a.isDir) || cmp(a.name, b.name));
  return { path: relOf(root, abs), items };
}

/** Чтение файла как текста (UTF-8). */
async function readFile(root, rel) {
  const abs = resolveSafe(root, rel);
  const st = await fsp.stat(abs);
  if (st.isDirectory()) throw new Error('Это папка, а не файл');
  if (st.size > MAX_READ) {
    throw new Error(`Файл больше ${Math.round(MAX_READ / 1048576)} МБ — редактор его не откроет`);
  }

  const buf = await fsp.readFile(abs);
  const kind = kindOf(abs);
  if (kind === 'image' || kind === 'archive' || kind === 'archive-other') {
    /* такие файлы не редактируют текстом — панель покажет картинку или список архива */
    const hint = kind === 'image'
      ? 'Картинка — открою в просмотрщике'
      : kind === 'archive'
        ? 'Архив — покажу содержимое'
        : 'Этот формат архива не поддерживается';
    return { path: relOf(root, abs), kind, size: st.size, binary: true, content: '', message: hint };
  }
  if (BINARY_KINDS.has(kind) || buf.subarray(0, 8000).includes(0)) {
    return {
      path: relOf(root, abs), kind: 'binary', size: st.size, binary: true,
      content: '', message: 'Двоичный файл — редактирование недоступно',
    };
  }

  // BOM срезаем, перевод строки оставляем как есть
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return {
    path: relOf(root, abs),
    kind,
    size: st.size,
    mtime: st.mtimeMs,
    binary: false,
    content: text,
    lines: text.split('\n').length,
  };
}

/** Запись файла (создаёт папки по пути). */
async function writeFile(root, rel, content) {
  const abs = resolveSafe(root, rel);
  const data = String(content == null ? '' : content);
  if (Buffer.byteLength(data, 'utf8') > MAX_WRITE) throw new Error('Слишком большой файл для записи');
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, data, 'utf8');
  const st = await fsp.stat(abs);
  return { ok: true, path: relOf(root, abs), size: st.size, mtime: st.mtimeMs };
}

async function mkdir(root, rel) {
  const abs = resolveSafe(root, rel);
  await fsp.mkdir(abs, { recursive: true });
  return { ok: true, path: relOf(root, abs) };
}

async function remove(root, rel) {
  const abs = resolveSafe(root, rel);
  if (path.resolve(abs) === path.resolve(root)) throw new Error('Нельзя удалить корневую папку сервера');
  const st = await fsp.lstat(abs);
  if (st.isDirectory()) await fsp.rm(abs, { recursive: true, force: true });
  else await fsp.unlink(abs);
  return { ok: true };
}

async function rename(root, rel, newName) {
  const abs = resolveSafe(root, rel);
  if (path.resolve(abs) === path.resolve(root)) throw new Error('Нельзя переименовать корневую папку');
  const clean = String(newName || '').replace(/[/\\]/g, '').trim();
  if (!clean) throw new Error('Пустое имя');
  const dest = path.join(path.dirname(abs), clean);
  resolveSafe(root, relOf(root, dest));           // проверяем, что не вылезли наружу
  if (samePath(dest, abs) && path.resolve(dest) === path.resolve(abs)) {
    return { ok: true, path: relOf(root, dest), same: true };
  }
  if (!samePath(dest, abs) && fs.existsSync(dest)) throw new Error('Файл с таким именем уже есть');
  try {
    await relocate(abs, dest, (await fsp.lstat(abs)).isDirectory());
  } catch (err) {
    throw moveError(err, clean);
  }
  return { ok: true, path: relOf(root, dest) };
}

/* ─────────────────────────── перенос файлов ─────────────────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Пути совпадают? На Windows и macOS регистр не важен. */
function samePath(a, b) {
  const x = path.resolve(a);
  const y = path.resolve(b);
  return process.platform === 'win32' || process.platform === 'darwin'
    ? x.toLowerCase() === y.toLowerCase()
    : x === y;
}

async function exists(abs) {
  try { await fsp.lstat(abs); return true; } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

/** Понятный текст вместо кода ошибки файловой системы. */
function moveError(err, name) {
  const code = err && err.code;
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
    return new Error(`Файл «${name}» занят другой программой (обычно сервером) — останови сервер и попробуй снова`);
  }
  if (code === 'ENOENT') return new Error(`«${name}» не найден — возможно, его уже перенесли`);
  if (code === 'ENOSPC') return new Error('На диске закончилось место');
  if (code === 'EISDIR' || code === 'ENOTDIR') return new Error(`«${name}» — это папка, а не файл`);
  if (code === 'ENAMETOOLONG') return new Error('Слишком длинное имя файла или путь');
  if (code === 'EXDEV') return new Error('Разные диски: не удалось перенести файл целиком');
  return new Error(`Не удалось перенести «${name}»: ${err && err.message ? err.message : 'неизвестная ошибка'}`);
}

/** Сначала переименование (быстро), потом копирование с удалением (между дисками). */
async function relocate(src, dest, isDir) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fsp.rename(src, dest);
      return { copied: false };
    } catch (err) {
      lastErr = err;
      /* EXDEV — другой диск, переименование невозможно: сразу копируем.
         EBUSY/EPERM — файл занят: даём программе отпустить его и пробуем снова. */
      if (err.code === 'EXDEV') break;
      if (!['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(err.code)) throw err;
      if (attempt < 2) await sleep(150 * (attempt + 1));
    }
  }
  if (lastErr && !['EXDEV', 'EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(lastErr.code)) {
    throw lastErr;
  }
  /* переносим копированием: работает между дисками, томами и через точки монтирования */
  try {
    await fsp.cp(src, dest, {
      recursive: isDir,
      force: true,
      errorOnExist: false,
      preserveTimestamps: true,
      dereference: false,
    });
    await fsp.rm(src, { recursive: isDir, force: true });
    return { copied: true };
  } catch (err) {
    /* недоделанную копию убираем, чтобы не оставить половину файла */
    try { await fsp.rm(dest, { recursive: isDir, force: true }); } catch { /* уже нет */ }
    throw err;
  }
}

/**
 * Перенос файла или папки в другую папку (перетаскивание в дереве).
 *
 * Почему не просто rename: на Windows он падает, если файл занят (например, его
 * держит запущенный сервер) и если папка лежит на другом диске. Поэтому здесь
 * три попытки переименования, а потом копирование с удалением — так перенос
 * работает и через диски, и с файлами, которые вот-вот отпустят.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.overwrite] заменить существующий файл с тем же именем
 */
async function move(root, from, toDir, opts = {}) {
  const abs = resolveSafe(root, from);
  const destDirAbs = resolveSafe(root, toDir || '');
  if (!String(from || '').trim()) throw new Error('Не выбран файл для переноса');
  if (samePath(abs, path.resolve(root))) throw new Error('Нельзя перенести корневую папку сервера');

  let st;
  try {
    st = await fsp.lstat(abs);
  } catch (err) {
    throw moveError(err, path.basename(abs));
  }
  const isDir = st.isDirectory();
  const name = path.basename(abs);

  /* куда переносим: папка должна существовать и быть папкой */
  if (await exists(destDirAbs)) {
    const dirStat = await fsp.stat(destDirAbs);
    if (!dirStat.isDirectory()) throw new Error('Переносить можно только в папку');
  } else {
    await fsp.mkdir(destDirAbs, { recursive: true });
  }

  const destAbs = path.join(destDirAbs, name);

  /* уже на месте: на Windows это ещё и смена регистра имени */
  if (samePath(destAbs, abs)) {
    if (path.resolve(destAbs) === path.resolve(abs)) {
      return { ok: true, path: relOf(root, abs), same: true };
    }
    const tmp = path.join(path.dirname(abs), `.omnipanel-${Date.now()}-${name}`);
    try {
      await fsp.rename(abs, tmp);
      await fsp.rename(tmp, destAbs);
    } catch (err) {
      try { if (await exists(tmp)) await fsp.rename(tmp, abs); } catch { /* вернуть не вышло */ }
      throw moveError(err, name);
    }
    return { ok: true, path: relOf(root, destAbs), renamed: true };
  }

  /* нельзя перенести папку внутрь себя же */
  const relToDest = path.relative(abs, destDirAbs);
  if (isDir && (relToDest === '' || (!relToDest.startsWith('..') && !path.isAbsolute(relToDest)))) {
    throw new Error('Нельзя перенести папку внутрь себя');
  }

  if (await exists(destAbs)) {
    if (!opts.overwrite) throw new Error(`В этой папке уже есть «${name}»`);
    try {
      await fsp.rm(destAbs, { recursive: true, force: true });
    } catch (err) {
      throw moveError(err, name);
    }
  }

  let result;
  try {
    result = await relocate(abs, destAbs, isDir);
  } catch (err) {
    throw moveError(err, name);
  }
  return { ok: true, path: relOf(root, destAbs), copied: !!result.copied };
}

/** Поиск по именам файлов внутри папки сервера (для быстрого открытия). */
async function search(root, query, limit = 60) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return [];
  const found = [];
  const skip = new Set(['.git', 'node_modules', 'cache', 'logs', 'crash-reports']);

  async function walk(dir, depth) {
    if (found.length >= limit || depth > 6) return;
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch { return; }
    for (const d of entries) {
      if (found.length >= limit) return;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (skip.has(d.name.toLowerCase())) continue;
        await walk(full, depth + 1);
      } else if (d.name.toLowerCase().includes(q)) {
        found.push({ name: d.name, path: relOf(root, full), kind: kindOf(d.name) });
      }
    }
  }
  await walk(path.resolve(root), 0);
  return found;
}

/* ───────────── server.properties ───────────── */

/** Поля, которые правим из панели: ключ → как разбирать. */
/* Типы полей берём из общей схемы (ui/props-schema.js) — она же рисует окно настроек. */
const PROP_SCHEMA = require('../ui/props-schema');

const PROP_FIELDS = {};
for (const p of PROP_SCHEMA.props) {
  PROP_FIELDS[p.key] = p.type === 'bool' ? 'bool' : p.type === 'num' ? 'number' : 'string';
}

/* Свои ключи (плагины, моды) тоже можно писать, если имя безопасное. */
const EXTRA_KEY = /^[A-Za-z0-9._-]{1,120}$/;

function propFile(root) {
  return path.join(resolveSafe(root, 'server.properties'));
}

function parseProps(text) {
  const map = {};
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw || /^\s*[#!]/.test(raw)) continue;
    const i = raw.indexOf('=');
    if (i < 0) continue;
    map[raw.slice(0, i).trim()] = raw.slice(i + 1);
  }
  return map;
}

/** Читает базовые настройки server.properties (если файла нет — значения по умолчанию). */
async function readServerProperties(root) {
  const file = propFile(root);
  let text = '';
  try { text = await fsp.readFile(file, 'utf8'); } catch { /* файла ещё нет */ }
  const map = parseProps(text);
  const out = {};
  for (const [key, type] of Object.entries(PROP_FIELDS)) {
    const raw = map[key];
    if (type === 'bool') out[key] = raw == null ? null : raw.trim().toLowerCase() === 'true';
    else if (type === 'number') out[key] = raw == null || raw.trim() === '' ? null : Number(raw);
    else out[key] = raw == null ? null : decodePropsText(raw);
  }
  /* ключи, которых нет в схеме (плагины, моды) — отдельно, чтобы их тоже можно было править */
  const other = {};
  for (const [key, raw] of Object.entries(map)) {
    if (key in PROP_FIELDS) continue;
    if (!EXTRA_KEY.test(key)) continue;
    other[key] = decodePropsText(raw);
  }
  return { exists: fs.existsSync(file), path: 'server.properties', props: out, other };
}

/** Кириллицу в server.properties пишем как \uXXXX (так делают все версии Minecraft). */
function escapeProps(value) {
  return String(value).replace(/[^\x20-\x7E]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
}

/** В server.properties кириллица хранится как \uXXXX — превращаем обратно в текст. */
function decodePropsText(v) {
  return String(v).replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/** Пишет базовые настройки, сохраняя все остальные строки файла. */
async function writeServerProperties(root, patch = {}) {
  const file = propFile(root);
  let text = '';
  try { text = await fsp.readFile(file, 'utf8'); } catch { /* создаём с нуля */ }

  const lines = text ? text.split(/\r?\n/) : [
    '#Minecraft server properties',
    '#создано панелью OmniPanel',
  ];
  const known = new Set();
  const booleans = Object.entries(PROP_FIELDS).filter(([, t]) => t === 'bool').map(([k]) => k);

  const encode = (key, value) => {
    if (booleans.includes(key)) return value ? 'true' : 'false';
    return escapeProps(value);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || /^\s*[#!]/.test(line)) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!(key in patch)) continue;
    known.add(key);
    lines[i] = `${key}=${encode(key, patch[key])}`;
  }
  // то, чего в файле не было, дописываем в конец
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in PROP_FIELDS) && !EXTRA_KEY.test(key)) continue;   // чужие и подозрительные ключи не трогаем
    if (known.has(key)) continue;
    lines.push(`${key}=${encode(key, value)}`);
  }

  await fsp.writeFile(file, lines.join('\n'), 'utf8');
  return { ok: true, path: 'server.properties' };
}

module.exports = {
  readServerProperties, writeServerProperties, PROP_FIELDS,
  resolveSafe, listDir, readFile, writeFile, mkdir, remove, rename, search,
  kindOf, readImage, move, MAX_READ, MAX_IMAGE, ARCHIVE_EXT, IMAGE_EXT,
};
