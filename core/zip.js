'use strict';
/**
 * Минимальный ZIP: чтение и запись без внешних зависимостей.
 * Нужен самообновлению — панель качает архив с GitHub и распаковывает сама,
 * а сборщик обновлений тем же кодом упаковывает файлы.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const EOCD = 0x06054b50;
const CDIR = 0x02014b50;
const LOCAL = 0x04034b50;

/* ───────────────────────────── чтение ───────────────────────────── */

function findEocd(buf) {
  const stop = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= stop; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD) return i;
  }
  return -1;
}

function decodeName(bytes, flags) {
  if (flags & 0x800) return bytes.toString('utf8');
  // имена без флага UTF-8: сначала пробуем utf8, при явных ошибках — cp866/cp1251
  const utf = bytes.toString('utf8');
  if (!utf.includes('\uFFFD')) return utf;
  try { return bytes.toString('cp866'); } catch { return bytes.toString('latin1'); }
}

function safeJoin(root, name) {
  const clean = name.replace(/\\/g, '/').replace(/^\/+/, '');
  const out = path.join(root, clean);
  const rel = path.relative(root, out);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('в архиве недопустимый путь: ' + name);
  return out;
}

/** Список файлов архива: [{name, dir, method, csize, usize, utf8}]. */
function list(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('файл не похож на zip-архив');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CDIR) throw new Error('список файлов архива повреждён');
    const flags = buf.readUInt16LE(off + 8);
    const method = buf.readUInt16LE(off + 10);
    const crc = buf.readUInt32LE(off + 16);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = decodeName(buf.slice(off + 46, off + 46 + nameLen), flags);
    entries.push({
      name, dir: name.endsWith('/'), method, crc, csize, usize, localOff, utf8: !!(flags & 0x800),
    });
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return entries;
}

/** Данные одного файла. */
function readEntry(buf, entry) {
  const lo = entry.localOff;
  if (buf.readUInt32LE(lo) !== LOCAL) throw new Error('локальный заголовок повреждён: ' + entry.name);
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const raw = buf.slice(start, start + entry.csize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error('сжатие zip не поддерживается (метод ' + entry.method + ')');
}

/**
 * Распаковать архив в папку.
 * @returns {{files: string[], bytes: number}}
 */
function extractFile(zipPath, destDir, opts = {}) {
  const buf = fs.readFileSync(zipPath);
  const entries = list(buf);
  const files = [];
  let bytes = 0;
  for (const entry of entries) {
    if (entry.dir) continue;
    const target = safeJoin(destDir, entry.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const data = readEntry(buf, entry);
    fs.writeFileSync(target, data);
    files.push(entry.name.replace(/\\/g, '/'));
    bytes += data.length;
  }
  if (opts.expect && !files.includes(opts.expect)) {
    throw new Error('в архиве нет файла ' + opts.expect + ' — это не обновление панели');
  }
  return { files, bytes };
}

/* ───────────────────────────── запись ───────────────────────────── */

function dosTime(d = new Date()) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((Math.floor(d.getSeconds() / 2)) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

/**
 * Собрать zip из [{name, data}] (порядок сохраняется).
 * @returns {Buffer}
 */
function create(entries) {
  const { time, date } = dosTime();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const item of entries) {
    const name = item.name.replace(/\\/g, '/');
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(item.data) ? item.data : Buffer.from(item.data);
    const crc = zlib.crc32 ? zlib.crc32(data) : crc32(data);
    let method = 8;
    let body = zlib.deflateRawSync(data, { level: 9 });
    if (body.length >= data.length) { method = 0; body = data; }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4);          // версия для распаковки
    local.writeUInt16LE(0x800, 6);       // имена в UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CDIR, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    locals.push(local, nameBuf, body);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }

  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localPart, centralPart, eocd]);
}

/** crc32 без нативной поддержки (старые Node). */
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** Собрать zip из файлов на диске: [{from, name}] → Buffer. */
function createFromFiles(items) {
  return create(items.map((it) => ({ name: it.name, data: fs.readFileSync(it.from) })));
}

/* ─────────────────────── запись папки потоком ─────────────────────── */

/**
 * Пакует папку в zip с максимальным сжатием, не держа весь архив в памяти.
 * @param {string} srcDir  что пакуем
 * @param {string} destFile куда писать
 * @param {{skip?: RegExp[], onProgress?: Function}} opts
 */
function zipDir(srcDir, destFile, opts = {}) {
  const skip = opts.skip || [];
  const { time, date } = dosTime();
  const fd = fs.openSync(destFile, 'w');
  const centrals = [];
  let offset = 0;
  let count = 0;
  let rawBytes = 0;
  let packedBytes = 0;

  const push = (entry, nameBuf, crc, method, body, size) => {
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    fs.writeSync(fd, local);
    fs.writeSync(fd, nameBuf);
    fs.writeSync(fd, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CDIR, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + body.length;
    count += 1;
    rawBytes += size;
    packedBytes += body.length;
    if (opts.onProgress && count % 50 === 0) opts.onProgress({ files: count, rawBytes, packedBytes });
    void entry;
  };

  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const abs = rel ? path.join(srcDir, rel) : srcDir;
    let entries = [];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const childRel = rel ? rel + '/' + e.name : e.name;
      if (skip.some((re) => re.test(childRel.replace(/\\/g, '/')))) continue;
      if (e.isDirectory()) { stack.push(childRel); continue; }
      if (!e.isFile()) continue;
      let data;
      try { data = fs.readFileSync(path.join(srcDir, childRel)); } catch { continue; }
      const nameBuf = Buffer.from(childRel, 'utf8');
      const crc = zlib.crc32 ? zlib.crc32(data) : crc32(data);
      let method = 8;
      /* уровень 9 — максимум, который даёт deflate; уже сжатые форматы не трогаем */
      const packed = /\\.(zip|gz|tgz|rar|7z|png|jpg|jpeg|webp|mp3|mp4|ogg|jar)$/i.test(childRel)
        ? data
        : zlib.deflateRawSync(data, { level: 9 });
      let body = packed;
      if (packed.length >= data.length) { method = 0; body = data; }
      push(e, nameBuf, crc, method, body, data.length);
    }
  }

  const centralPart = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  fs.writeSync(fd, centralPart);
  fs.writeSync(fd, eocd);
  fs.closeSync(fd);
  return { file: destFile, files: count, bytes: rawBytes, packed: packedBytes + centralPart.length + 22 };
}

module.exports = { list, readEntry, extractFile, create, createFromFiles, crc32, zipDir };
