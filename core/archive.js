'use strict';
/**
 * Архивы в редакторе файлов: просмотр содержимого, чтение файла из архива
 * и распаковка в папку сервера.
 *
 * zip читает свой писатель (core/zip.js). 7z — через 7za.exe, который едет
 * вместе с панелью (core/seven.js), поэтому бэкапы .7z тоже открываются.
 * RAR, tar, gz, xz, bz2 панель не поддерживает: распакуй архиватором.
 */
const fs = require('fs');
const path = require('path');
const zip = require('./zip');
const seven = require('./seven');
const os = require('os');
const files = require('./files');

const ARCHIVE_EXT = /\.(zip|jar|mcpack|whl|epub)$/i;
const SEVEN_EXT = /\.7z$/i;
const OTHER_ARCHIVE = /\.(rar|7z|tar|gz|tgz|bz2|xz)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico)$/i;

const MAX_ENTRY_READ = 12 * 1024 * 1024;   // один файл из архива
const MAX_ENTRY_IMAGE = 8 * 1024 * 1024;

function kindOfArchive(rel) {
  if (ARCHIVE_EXT.test(rel)) return 'zip';
  if (SEVEN_EXT.test(rel)) return 'seven';
  if (OTHER_ARCHIVE.test(rel)) return 'other';
  return '';
}

/** Временная папка для одного файла из .7z. */
function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'omni-' + tag + '-'));
}

/** Список файлов внутри архива. */
async function open(root, rel) {
  const abs = files.resolveSafe(root, rel);
  const kind = kindOfArchive(abs);
  if (kind === 'other') {
    return { ok: false, error: 'RAR, tar и gz панель не открывает — распакуй архив архиватором, потом правь файлы в папке' };
  }
  if (!kind) return { ok: false, error: 'Это не архив' };
  const st = fs.statSync(abs);
  if (st.size > 512 * 1024 * 1024) return { ok: false, error: 'Архив больше 512 МБ — открой его архиватором' };

  if (kind === 'seven') {
    if (!seven.available()) return { ok: false, error: 'Рядом с панелью нет 7-Zip — распакуй архив архиватором' };
    const items = (await seven.list(abs)).filter((x) => x.Path && !x.isDir);
    const entries = items.map((x) => ({ name: x.Path, size: x.Size || 0, packed: x.Packed || 0 }));
    return {
      ok: true,
      path: rel,
      size: st.size,
      entries,
      total: entries.length,
      raw: entries.reduce((a, b) => a + b.size, 0),
      format: '7z',
    };
  }

  const buf = fs.readFileSync(abs);
  const entries = zip.list(buf)
    .filter((e) => !e.dir)
    .map((e) => ({ name: e.name, size: e.usize, packed: e.csize }));
  return {
    ok: true,
    path: rel,
    size: st.size,
    entries,
    total: entries.length,
    raw: entries.reduce((a, b) => a + b.size, 0),
  };
}

/** Читает один файл из архива: текст или картинку (data URL). */
async function readEntry(root, rel, name) {
  const abs = files.resolveSafe(root, rel);
  if (kindOfArchive(abs) === 'seven') {
    if (!seven.available()) return { ok: false, error: 'Рядом с панелью нет 7-Zip' };
    const want = String(name).replace(/\\/g, '/');
    const items = await seven.list(abs);
    const found = items.find((x) => x.Path && x.Path.replace(/\\/g, '/') === want && !x.isDir);
    if (!found) return { ok: false, error: 'В архиве нет файла ' + name };
    if (found.Size > MAX_ENTRY_READ) {
      return { ok: false, error: `Файл в архиве больше ${Math.round(MAX_ENTRY_READ / 1048576)} МБ — распакуй его на диск` };
    }
    const dir = tmpDir('7zread');
    try {
      await seven.run(['e', abs, want, '-o' + dir, '-y', '-bso0', '-bsp0']);
      const single = path.join(dir, path.basename(want));
      const data = fs.existsSync(single) ? fs.readFileSync(single) : Buffer.alloc(0);
      return describeEntry(name, data);
    } catch (err) {
      return { ok: false, error: 'Не получилось прочитать файл из архива: ' + err.message };
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* временная папка */ }
    }
  }
  const buf = fs.readFileSync(abs);
  const entry = zip.list(buf).find((e) => e.name.replace(/\\/g, '/') === String(name).replace(/\\/g, '/') && !e.dir);
  if (!entry) return { ok: false, error: 'В архиве нет файла ' + name };
  if (entry.usize > MAX_ENTRY_READ) {
    return { ok: false, error: `Файл в архиве больше ${Math.round(MAX_ENTRY_READ / 1048576)} МБ — распакуй его на диск` };
  }
  const data = zip.readEntry(buf, entry);
  return describeEntry(name, data, entry.usize);
}

/** Текст или картинка из архива — общий ответ для zip и 7z. */
function describeEntry(name, data, size = 0) {
  const isImage = IMAGE_EXT.test(name);
  if (isImage) {
    if (size > MAX_ENTRY_IMAGE) return { ok: false, error: 'Картинка слишком большая для просмотра' };
    const mime = /\.png$/i.test(name) ? 'image/png'
      : /\.gif$/i.test(name) ? 'image/gif'
        : /\.webp$/i.test(name) ? 'image/webp'
          : /\.bmp$/i.test(name) ? 'image/bmp'
            : 'image/jpeg';
    return { ok: true, kind: 'image', name, size: size || data.length, dataUrl: `data:${mime};base64,${data.toString('base64')}` };
  }
  if (data.subarray(0, 8000).includes(0)) {
    return { ok: false, error: 'Двоичный файл — можно только распаковать' };
  }
  return { ok: true, kind: 'text', name, size: size || data.length, content: data.toString('utf8') };
}

/**
 * Распаковывает архив в папку сервера (всю или один файл).
 * destRel — папка назначения внутри сервера ('' — корень сервера).
 */
async function extract(root, rel, destRel = '', onlyName = '') {
  const abs = files.resolveSafe(root, rel);
  const dest = files.resolveSafe(root, destRel || '');
  fs.mkdirSync(dest, { recursive: true });

  if (kindOfArchive(abs) === 'seven') {
    if (!seven.available()) return { ok: false, error: 'Рядом с панелью нет 7-Zip' };
    const want = onlyName ? String(onlyName).replace(/\\/g, '/') : '';
    try {
      await seven.run(['x', abs, '-o' + dest, '-y', '-bso0', '-bsp0'].concat(want ? ['-i!' + want] : []));
    } catch (err) {
      return { ok: false, error: 'Не получилось распаковать: ' + err.message };
    }
    const names = want ? [want] : (await seven.list(abs)).filter((x) => !x.isDir).map((x) => x.Path);
    return {
      ok: true,
      files: names.length,
      list: names.slice(0, 20),
      bytes: 0,
      dest: destRel || '/',
    };
  }

  const buf = fs.readFileSync(abs);
  const entries = zip.list(buf).filter((e) => !e.dir);
  const wanted = onlyName ? entries.filter((e) => e.name.replace(/\\/g, '/') === String(onlyName).replace(/\\/g, '/')) : entries;
  if (!wanted.length) return { ok: false, error: 'Нечего распаковывать' };

  const written = [];
  let bytes = 0;
  for (const entry of wanted) {
    const plain = entry.name.replace(/\\/g, '/');
    const target = path.join(dest, plain);
    const relTarget = path.relative(dest, target);
    if (relTarget.startsWith('..') || path.isAbsolute(relTarget)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const data = zip.readEntry(buf, entry);
    fs.writeFileSync(target, data);
    written.push(plain);
    bytes += data.length;
  }
  return { ok: true, files: written.length, list: written.slice(0, 20), bytes, dest: destRel || '/' };
}

module.exports = { open, readEntry, extract, describeEntry, kindOfArchive, ARCHIVE_EXT, SEVEN_EXT, OTHER_ARCHIVE, IMAGE_EXT };
