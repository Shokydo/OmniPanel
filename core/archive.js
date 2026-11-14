'use strict';
/**
 * Архивы в редакторе файлов: просмотр содержимого zip, чтение файла из архива
 * и распаковка в папку сервера.
 *
 * RAR и 7z сознательно не поддерживаются: для них нужен внешний распаковщик,
 * а тащить его в portable-сборку ради просмотра — лишние 3 МБ. Панель честно
 * говорит, что формат не поддерживается, и предлагает распаковать вручную.
 */
const fs = require('fs');
const path = require('path');
const zip = require('./zip');
const files = require('./files');

const ARCHIVE_EXT = /\.(zip|jar|mcpack|whl|epub)$/i;
const OTHER_ARCHIVE = /\.(rar|7z|tar|gz|tgz|bz2|xz)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico)$/i;

const MAX_ENTRY_READ = 12 * 1024 * 1024;   // один файл из архива
const MAX_ENTRY_IMAGE = 8 * 1024 * 1024;

function kindOfArchive(rel) {
  if (ARCHIVE_EXT.test(rel)) return 'zip';
  if (OTHER_ARCHIVE.test(rel)) return 'other';
  return '';
}

/** Список файлов внутри архива. */
function open(root, rel) {
  const abs = files.resolveSafe(root, rel);
  const kind = kindOfArchive(abs);
  if (kind === 'other') {
    return { ok: false, error: 'RAR и 7z панель не открывает — распакуй архив архиватором, потом правь файлы в папке' };
  }
  if (!kind) return { ok: false, error: 'Это не архив' };
  const st = fs.statSync(abs);
  if (st.size > 512 * 1024 * 1024) return { ok: false, error: 'Архив больше 512 МБ — открой его архиватором' };

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
function readEntry(root, rel, name) {
  const abs = files.resolveSafe(root, rel);
  const buf = fs.readFileSync(abs);
  const entry = zip.list(buf).find((e) => e.name.replace(/\\/g, '/') === String(name).replace(/\\/g, '/') && !e.dir);
  if (!entry) return { ok: false, error: 'В архиве нет файла ' + name };
  if (entry.usize > MAX_ENTRY_READ) {
    return { ok: false, error: `Файл в архиве больше ${Math.round(MAX_ENTRY_READ / 1048576)} МБ — распакуй его на диск` };
  }
  const data = zip.readEntry(buf, entry);

  const isImage = IMAGE_EXT.test(name);
  if (isImage) {
    if (entry.usize > MAX_ENTRY_IMAGE) return { ok: false, error: 'Картинка слишком большая для просмотра' };
    const mime = /\.png$/i.test(name) ? 'image/png'
      : /\.gif$/i.test(name) ? 'image/gif'
        : /\.webp$/i.test(name) ? 'image/webp'
          : /\.bmp$/i.test(name) ? 'image/bmp'
            : 'image/jpeg';
    return { ok: true, kind: 'image', name, size: entry.usize, dataUrl: `data:${mime};base64,${data.toString('base64')}` };
  }
  if (data.subarray(0, 8000).includes(0)) {
    return { ok: false, error: 'Двоичный файл — можно только распаковать' };
  }
  return { ok: true, kind: 'text', name, size: entry.usize, content: data.toString('utf8') };
}

/**
 * Распаковывает архив в папку сервера (всю или один файл).
 * destRel — папка назначения внутри сервера ('' — корень сервера).
 */
function extract(root, rel, destRel = '', onlyName = '') {
  const abs = files.resolveSafe(root, rel);
  const dest = files.resolveSafe(root, destRel || '');
  fs.mkdirSync(dest, { recursive: true });

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

module.exports = { open, readEntry, extract, kindOfArchive, ARCHIVE_EXT, OTHER_ARCHIVE, IMAGE_EXT };
