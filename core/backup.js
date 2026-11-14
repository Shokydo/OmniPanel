'use strict';
/**
 * Бэкапы папки сервера: создание архива и восстановление из него.
 *
 * Основной формат — .7z (LZMA2, максимум сжатия): 7za.exe едет вместе с панелью,
 * ничего ставить не нужно. Плотнее zip примерно на 5–20 % на мире и заметно
 * сильнее на серверах с тысячами мелких файлов.
 * Если 7-Zip рядом не оказался — бэкап соберётся своим zip-писателем
 * (deflate уровень 9), а старые .zip/.tar.gz по-прежнему восстанавливаются.
 * Синхронизация с GitHub всегда берёт zip: его понимает любой клиент.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const crypto = require('crypto');
const zip = require('./zip');
const seven = require('./seven');

const IS_WIN = process.platform === 'win32';

function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function run(cmd, args, timeout = 0) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message || '').toString().trim() || 'Ошибка архивации'));
      else resolve(String(stdout || ''));
    });
  });
}

function slug(s) {
  return String(s || 'server').replace(/[^\wа-яё\-]+/gi, '_').slice(0, 40) || 'server';
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Список бэкапов сервера (свежие сверху). */
function listBackups(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((f) => /\.(7z|zip|tar\.gz)$/i.test(f))
      .map((f) => {
        const full = path.join(dir, f);
        const st = fs.statSync(full);
        return { file: full, name: f, size: st.size, createdAt: st.mtimeMs };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

/** Что не кладём в архив: то же, что не синхронизируем. */
const SKIP_ALWAYS = [
  /(^|\/)\.git(\/|$)/,
  /(^|\/)cache(\/|$)/,
  /(^|\/)\.DS_Store$/,
  /(^|\/)Thumbs\.db$/i,
  /(^|\/)session\.lock$/i,
];

/** Сколько файлов и байт реально попадёт в архив (без служебного мусора). */
function measure(srcDir, skip = []) {
  const patterns = SKIP_ALWAYS.concat(skip);
  const skipIt = (rel) => patterns.some((re) => re.test(rel));
  let files = 0;
  let bytes = 0;
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    let entries;
    try { entries = fs.readdirSync(path.join(srcDir, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const sub = rel ? rel + '/' + e.name : e.name;
      if (skipIt(sub)) continue;
      if (e.isDirectory()) { stack.push(sub); continue; }
      if (!e.isFile()) continue;   // символические ссылки не считаем
      try { bytes += fs.statSync(path.join(srcDir, sub)).size; files += 1; } catch { /* файл исчез */ }
    }
  }
  return { files, bytes };
}

/**
 * Создаёт архив папки сервера с максимальным сжатием.
 *
 * @param format '7z' | 'zip' | 'auto' — auto берёт 7-Zip, если он есть (по умолчанию)
 * @returns {Promise<{file:string,size:number,name:string,createdAt:number,sha256:string,
 *                    files:number,raw:number,format:string,packer:string}>}
 */
async function createBackup({ srcDir, destDir, label = 'backup', skip = [], format = 'auto' }) {
  if (!srcDir || !fs.existsSync(srcDir)) throw new Error('Папка сервера не найдена: ' + srcDir);
  ensureDir(destDir);

  const use7z = format === '7z' || (format === 'auto' && seven.available());
  const name = `${slug(label)}_${stamp()}.${use7z ? '7z' : 'zip'}`;
  const file = path.join(destDir, name);
  const tmp = file + '.part';

  const count = measure(srcDir, skip);
  let packer = 'zip deflate';
  if (use7z) {
    try {
      await seven.compressDir({ srcDir, outFile: tmp });
      packer = '7z lzma2';
    } catch (err) {
      /* 7-Zip не справился (нет прав, антивирус, битый бинарник) — не теряем бэкап */
      try { fs.unlinkSync(tmp); } catch { /* уже нет */ }
      const fallback = path.join(destDir, name.replace(/\.7z$/, '.zip'));
      zip.zipDir(srcDir, fallback + '.part', { skip: SKIP_ALWAYS.concat(skip) });
      fs.renameSync(fallback + '.part', fallback);
      return finish(fallback, count, 'zip deflate', 'Zip не сработал — ' + err.message);
    }
  } else {
    zip.zipDir(srcDir, tmp, { skip: SKIP_ALWAYS.concat(skip) });
  }
  fs.renameSync(tmp, file);
  return finish(file, count, packer);
}

/** Собирает результат бэкапа: размер, sha256, коэффициент сжатия. */
function finish(file, count, packer, warning = '') {
  const st = fs.statSync(file);
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  const raw = count.bytes || 0;
  return {
    file,
    name: path.basename(file),
    size: st.size,
    createdAt: st.mtimeMs,
    sha256: hash.digest('hex'),
    files: count.files,
    raw,
    format: /\.7z$/i.test(file) ? '7z' : 'zip',
    packer,
    /* во сколько раз сжалось: 3.4 — втрое меньше исходного */
    ratio: raw && st.size ? Number((raw / st.size).toFixed(2)) : 0,
    warning,
  };
}

/**
 * Восстанавливает архив в папку сервера (перезапись существующих файлов).
 */
async function restoreBackup({ file, destDir }) {
  if (!file || !fs.existsSync(file)) throw new Error('Файл бэкапа не найден');
  ensureDir(destDir);

  if (/\.7z$/i.test(file)) {
    await seven.extract({ file, destDir });
    return true;
  }
  if (/\.zip$/i.test(file)) {
    zip.extractFile(file, destDir);
    return true;
  }
  /* старые архивы .tar.gz — только через tar */
  await run('tar', ['-xzf', file, '-C', destDir]);
  return true;
}

function deleteBackup(file) {
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/** Размер папки (для предупреждения перед бэкапом). */
function dirSize(dir, limit = 200000) {
  let total = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length && files < limit) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else {
        try { total += fs.statSync(full).size; files++; } catch { /* ignore */ }
      }
    }
  }
  return { bytes: total, files };
}

module.exports = { listBackups, createBackup, restoreBackup, deleteBackup, ensureDir, dirSize, slug, stamp };
