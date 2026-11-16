/*
 * Рельеф из пакета чанка — чтобы бот знал, где земля, и не шёл по воздуху.
 *
 * Сервер считает игрока «висящим в воздухе» (floating), если под ним нет твёрдого
 * блока. Боту достаточно знать высоту поверхности в клетке — тогда он всегда идёт
 * ровно по земле, как настоящий игрок, и никаких киков за полёт не будет.
 *
 * Карта высот приходит в самом пакете чанка (MOTION_BLOCKING) — разбираем её.
 */
'use strict';

/** Чтение varint из буфера: значение и длина. */
function readVarInt(buf, off) {
  let value = 0;
  let shift = 0;
  let i = off;
  while (i < buf.length) {
    const byte = buf[i];
    value |= (byte & 0x7f) << shift;
    i += 1;
    if ((byte & 0x80) === 0) return { value, size: i - off };
    shift += 7;
    if (shift > 35) break;
  }
  return null;
}

/**
 * Распаковка карты высот: значения по 9 бит, по 7 штук на long (так их кладёт
 * игра с 1.16 — один бит в каждом long остаётся пустым).
 */
function unpack9(longs, count) {
  const out = new Array(count);
  const perLong = 7;
  for (let index = 0; index < count; index += 1) {
    const startLong = Math.floor(index / perLong);
    const offset = BigInt((index % perLong) * 9);
    const value = (BigInt.asUintN(64, longs[startLong] || 0n) >> offset) & 0x1ffn;
    out[index] = Number(value);
  }
  return out;
}

/**
 * Разбор «карт высот» в формате NBT (1.20.x и часть 1.21.x):
 * compound, внутри long-массивы MOTION_BLOCKING / MOTION_BLOCKING_NO_LEAVES.
 */
function parseNbt(buf, off) {
  let i = off;
  if (buf[i] !== 0x0a) return null;
  i += 1;
  /* «безымянный» NBT (как в пакете чанка): после типа сразу идут поля.
     Обычный NBT начинается с длины имени (обычно 0) — учитываем оба случая. */
  const maybeName = buf.readUInt16BE(i);
  if (maybeName === 0) i += 2;
  else if (maybeName < 64 && i + 2 + maybeName < buf.length && buf[i + 2] > 0) i += 2 + maybeName;
  const found = {};
  for (let guard = 0; guard < 64; guard += 1) {
    const tag = buf[i];
    i += 1;
    if (tag === 0) break;                       // конец compound
    const len = buf.readUInt16BE(i);
    i += 2;
    const key = buf.toString('utf8', i, i + len);
    i += len;
    if (tag === 12) {                           // long array
      const count = buf.readInt32BE(i);
      i += 4;
      const longs = [];
      for (let k = 0; k < count; k += 1) {
        longs.push(buf.readBigInt64BE(i));
        i += 8;
      }
      found[key] = longs;
    } else if (tag === 3) { i += 4; }            // int
    else if (tag === 4) { i += 8; }              // long
    else return null;                            // остальное в карте высот не встречается
  }
  const key = Object.keys(found).find((k) => k === 'MOTION_BLOCKING')
    || Object.keys(found).find((k) => k === 'MOTION_BLOCKING_NO_LEAVES')
    || Object.keys(found).find((k) => k === 'WORLD_SURFACE');
  if (!key) return null;
  return { heights: unpack9(found[key], 256), end: i };
}

/** Карты высот в виде массива пар «номер типа + длинный массив» (1.21.5+). */
function parseArray(buf, off) {
  const count = readVarInt(buf, off);
  if (!count) return null;
  let i = off + count.size;
  let best = null;
  for (let k = 0; k < count.value; k += 1) {
    const type = readVarInt(buf, i);
    if (!type) return null;
    i += type.size;
    const len = readVarInt(buf, i);
    if (!len) return null;
    i += len.size;
    const longs = [];
    for (let n = 0; n < len.value; n += 1) {
      longs.push(buf.readBigInt64BE(i));
      i += 8;
    }
    /* 4 = motion_blocking, 5 = motion_blocking_no_leaves */
    if (type.value === 4 || (best === null && type.value === 5)) best = longs;
  }
  if (!best) return null;
  return { heights: unpack9(best, 256), end: i };
}

/**
 * Достаёт из пакета чанка карту высот.
 * Возвращает { x, z, heights } — heights[z * 16 + x], в высотах «где стоят ноги»
 * относительно низа мира (minY).
 */
function analyze(data, minY = -64) {
  if (!data || data.length < 24) return null;
  const x = data.readInt32BE(0);
  const z = data.readInt32BE(4);
  let off = 8;
  /* карты высот: либо NBT (0x0a), либо массив */
  const maps = data[off] === 0x0a ? parseNbt(data, off) : parseArray(data, off);
  if (!maps || !maps.heights) return null;
  const terrain = new Int16Array(256);
  for (let i = 0; i < 256; i += 1) {
    const value = maps.heights[i];
    /* в карте высот лежит «высота верхнего блока + 1» от низа мира */
    terrain[i] = value === 0 ? minY - 64 : minY + value;
  }
  return { x, z, terrain };
}

module.exports = { analyze, unpack9, readVarInt };
