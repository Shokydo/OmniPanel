'use strict';
/**
 * Бэкапы папки сервера: создание архива и восстановление из него.
 * Windows — встроенный Compress-Archive/Expand-Archive (zip), Unix — tar.gz.
 * Без внешних зависимостей.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

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
      .filter((f) => /\.(zip|tar\.gz)$/i.test(f))
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

/**
 * Создаёт архив папки сервера.
 * @returns {Promise<{file:string,size:number,name:string,createdAt:number}>}
 */
async function createBackup({ srcDir, destDir, label = 'backup' }) {
  if (!srcDir || !fs.existsSync(srcDir)) throw new Error('Папка сервера не найдена: ' + srcDir);
  ensureDir(destDir);

  const name = `${slug(label)}_${stamp()}.${IS_WIN ? 'zip' : 'tar.gz'}`;
  const file = path.join(destDir, name);

  if (IS_WIN) {
    const script =
      `Compress-Archive -Path ${psQuote(path.join(srcDir, '*'))} -DestinationPath ${psQuote(file)} -CompressionLevel Optimal -Force`;
    await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
  } else {
    await run('tar', ['-czf', file, '-C', srcDir, '.']);
  }

  const st = fs.statSync(file);
  return { file, name, size: st.size, createdAt: st.mtimeMs };
}

/**
 * Восстанавливает архив в папку сервера (перезапись существующих файлов).
 */
async function restoreBackup({ file, destDir }) {
  if (!file || !fs.existsSync(file)) throw new Error('Файл бэкапа не найден');
  ensureDir(destDir);

  if (IS_WIN) {
    const script = `Expand-Archive -LiteralPath ${psQuote(file)} -DestinationPath ${psQuote(destDir)} -Force`;
    await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
  } else {
    await run('tar', ['-xzf', file, '-C', destDir]);
  }
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
