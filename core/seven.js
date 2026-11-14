'use strict';
/**
 * 7-Zip: максимально плотные архивы бэкапов.
 *
 * Панель везёт с собой консольный 7za.exe (assets/bin), поэтому LZMA2 работает
 * без установленного 7-Zip и без интернета. Если бинарника рядом нет
 * (например, при запуске из исходников на Linux) — ищем 7z/7za/7zr в PATH.
 * Если не нашли ничего — бэкап молча соберётся обычным zip (см. core/backup.js).
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const IS_WIN = process.platform === 'win32';
const BIN_DIR = path.join(__dirname, '..', 'assets', 'bin');
const TIMEOUT = 6 * 60 * 60 * 1000;   // большой мир на медленном диске — надолго

let cached = null;

function exists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function whichSync(name) {
  const dirs = String(process.env.PATH || '').split(IS_WIN ? ';' : ':').filter(Boolean);
  const exts = IS_WIN ? ['.exe', ''] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, name + ext);
      if (exists(full)) return full;
    }
  }
  return '';
}

/** Путь к 7-Zip ('' если его нет). Результат запоминается. */
function binary() {
  if (cached !== null) return cached;
  const own = path.join(BIN_DIR, IS_WIN ? '7za.exe' : '7za');
  if (exists(own)) { cached = own; return cached; }
  for (const name of (IS_WIN ? ['7za', '7z'] : ['7z', '7za', '7zr'])) {
    const found = whichSync(name);
    if (found) { cached = found; return cached; }
  }
  cached = '';
  return cached;
}

function available() {
  return !!binary();
}

function run(args, opts = {}) {
  const cmd = binary();
  if (!cmd) return Promise.reject(new Error('7-Zip не найден'));
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      maxBuffer: 32 * 1024 * 1024,
      timeout: TIMEOUT,
      windowsHide: true,
      cwd: opts.cwd || undefined,
    }, (err, stdout, stderr) => {
      if (err) {
        const text = (stderr || stdout || err.message || '').toString().trim();
        reject(new Error(text || 'Ошибка 7-Zip'));
      } else {
        resolve(String(stdout || ''));
      }
    });
  });
}

/**
 * Исключения для 7-Zip: имена и маски, которые не попадают в архив.
 * Соответствуют SKIP_ALWAYS в core/backup.js.
 */
const DEFAULT_EXCLUDES = ['.git', 'cache', 'session.lock', 'Thumbs.db', '.DS_Store'];

function excludeArgs(extra = []) {
  const args = [];
  for (const name of DEFAULT_EXCLUDES.concat(extra)) {
    const clean = String(name || '').trim();
    if (!clean) continue;
    args.push('-xr!' + clean);
  }
  return args;
}

/**
 * Упаковывает папку в .7z с максимумом сжатия.
 * LZMA2, словарь 32 МБ, твёрдый блок — плотнее zip примерно на 5–20 %,
 * а на серверах с тысячами мелких файлов заметно сильнее.
 *
 * @returns {Promise<{file:string,size:number,cmd:string}>}
 */
async function compressDir({ srcDir, outFile, excludes = [], extra = [] }) {
  if (!available()) throw new Error('7-Zip не найден');
  if (!fs.existsSync(srcDir)) throw new Error('Папка не найдена: ' + srcDir);
  try { fs.unlinkSync(outFile); } catch { /* файла ещё нет */ }
  await run([
    'a', '-t7z', outFile, '.',
    '-mx=9',
    '-m0=lzma2',
    '-md=32m',
    '-mfb=64',
    '-ms=on',
    '-mmt=on',
    '-y',
    '-bso0', '-bsp0',
    '-scsUTF-8',
    ...excludeArgs(excludes.concat(extra)),
  ], { cwd: srcDir });
  const st = fs.statSync(outFile);
  return { file: outFile, size: st.size, cmd: '7z lzma2' };
}

/** Распаковывает .7z в папку (перезапись). */
async function extract({ file, destDir }) {
  if (!available()) {
    throw new Error('Для этого архива нужен 7-Zip, а его нет рядом с панелью');
  }
  if (!fs.existsSync(file)) throw new Error('Файл бэкапа не найден');
  fs.mkdirSync(destDir, { recursive: true });
  await run(['x', file, '-o' + destDir, '-y', '-bso0', '-bsp0']);
  return true;
}

/** Проверка целостности архива: 7z t. */
async function test(file) {
  if (!available()) return { ok: false, error: '7-Zip не найден' };
  try {
    const out = await run(['t', file, '-bso0', '-bsp0']);
    return { ok: true, out: out.trim() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Список файлов внутри .7z (нужен для просмотра архива в панели). */
async function list(file) {
  const out = await run(['l', file, '-ba', '-slt']);
  const items = [];
  let cur = null;
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z ]+?) = (.*)$/);
    if (!m) {
      if (cur && cur.Path) { items.push(cur); cur = null; }
      continue;
    }
    if (!cur) cur = {};
    const key = m[1].trim();
    const value = m[2];
    if (key === 'Path') cur.Path = value;
    else if (key === 'Size') cur.Size = Number(value) || 0;
    else if (key === 'Packed Size') cur.Packed = Number(value) || 0;
    else if (key === 'Modified') cur.Modified = value;
    else if (key === 'Folder' || key === 'Attributes') cur.isDir = cur.isDir || /^D/.test(value);
  }
  if (cur && cur.Path) items.push(cur);
  return items;
}

/** Сбросить запомненный путь (нужно тестам и когда 7-Zip появился позже). */
function reset() { cached = null; }

module.exports = {
  binary, available, reset, compressDir, extract, test, list, run, IS_WIN, DEFAULT_EXCLUDES,
};
