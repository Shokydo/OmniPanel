'use strict';
/*
 * Разбор и сборка пакетов Minecraft по таблицам из core/bot-protocols.js.
 *
 * Зачем свой интерпретатор: у каждой версии сервера свой набор полей в пакете
 * (например, в «настройках клиента» с 1.21.2 появился ещё один параметр),
 * и расписывать это руками на 26 версий — гарантированные ошибки. Здесь поля
 * читаются и пишутся по описанию, а недостающие значения подставляются сами.
 */

const TABLES = require('./bot-protocols');

const PRIMITIVES = new Set(['u8', 'u16', 'u32', 'u64', 'i8', 'i16', 'i32', 'i64', 'f32', 'f64',
  'bool', 'varint', 'varlong', 'pstring', 'buffer', 'restBuffer', 'void', 'UUID', 'option',
  'mapper', 'container', 'switch', 'array', 'bitfield', 'bitflags']);

/** Ближайшая известная версия протокола (сервер новее таблиц — берём самую свежую). */
function nearest(protocol) {
  const known = Object.keys(TABLES).map(Number).sort((a, b) => a - b);
  if (!known.length) return null;
  if (TABLES[protocol]) return protocol;
  let best = null;
  for (const p of known) if (p <= protocol) best = p;
  return best === null ? known[0] : best;
}

function table(protocol) {
  const p = nearest(protocol);
  return p === null ? null : TABLES[p];
}

/* ---------- чтение ---------- */

class Reader {
  constructor(buf, ctx) {
    this.buf = buf;
    this.off = 0;
    this.ctx = ctx;
    this.stack = [];
  }

  need(n) {
    if (this.off + n > this.buf.length) throw new Error('пакет короче, чем нужно');
  }

  def(name) {
    const t = this.ctx.table;
    return t.types[`${this.ctx.section}:${this.ctx.dir}.${name}`] || t.types[name] || null;
  }

  readVarInt() {
    let result = 0;
    let shift = 0;
    for (let i = 0; i < 5; i += 1) {
      this.need(1);
      const b = this.buf[this.off];
      this.off += 1;
      result += (b & 0x7f) << shift;
      if (!(b & 0x80)) return result | 0;
      shift += 7;
    }
    throw new Error('испорченный varint');
  }

  readVarLong() {
    let result = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i += 1) {
      this.need(1);
      const b = this.buf[this.off];
      this.off += 1;
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return result;
      shift += 7n;
    }
    throw new Error('испорченный varlong');
  }

  readType(spec) {
    if (typeof spec === 'string') return this.readNamed(spec);
    if (!Array.isArray(spec)) throw new Error('непонятное описание поля');
    return this.readNamed(spec[0], spec[1]);
  }

  readNamed(name, args) {
    const t = this.ctx.table;
    if (!PRIMITIVES.has(name)) {
      const ref = t.types[`${this.ctx.section}:${this.ctx.dir}.${name}`] || t.types[`${this.ctx.section}:${this.ctx.dir}.${name}.fields`] || t.types[name];
      if (ref === null || ref === undefined) throw new Error(`неизвестный тип ${name}`);
      return this.readType(ref);
    }
    switch (name) {
      case 'void': return undefined;
      case 'bool': { this.need(1); const v = this.buf[this.off] !== 0; this.off += 1; return v; }
      case 'u8': { this.need(1); const v = this.buf.readUInt8(this.off); this.off += 1; return v; }
      case 'i8': { this.need(1); const v = this.buf.readInt8(this.off); this.off += 1; return v; }
      case 'u16': { this.need(2); const v = this.buf.readUInt16BE(this.off); this.off += 2; return v; }
      case 'i16': { this.need(2); const v = this.buf.readInt16BE(this.off); this.off += 2; return v; }
      case 'u32': { this.need(4); const v = this.buf.readUInt32BE(this.off); this.off += 4; return v; }
      case 'i32': { this.need(4); const v = this.buf.readInt32BE(this.off); this.off += 4; return v; }
      case 'u64': { this.need(8); const v = this.buf.readBigUInt64BE(this.off); this.off += 8; return v; }
      case 'i64': { this.need(8); const v = this.buf.readBigInt64BE(this.off); this.off += 8; return v; }
      case 'f32': { this.need(4); const v = this.buf.readFloatBE(this.off); this.off += 4; return v; }
      case 'f64': { this.need(8); const v = this.buf.readDoubleBE(this.off); this.off += 8; return v; }
      case 'varint': return this.readVarInt();
      case 'varlong': return this.readVarLong();
      case 'pstring': {
        const len = this.readNamed((args && args.countType) || 'varint');
        this.need(len);
        const v = this.buf.toString('utf8', this.off, this.off + len);
        this.off += len;
        return v;
      }
      case 'buffer': {
        if (args && args.rest) { const v = this.buf.slice(this.off); this.off = this.buf.length; return v; }
        const len = args && args.count !== undefined ? args.count : this.readNamed(args.countType);
        this.need(len);
        const v = this.buf.slice(this.off, this.off + len);
        this.off += len;
        return v;
      }
      case 'restBuffer': { const v = this.buf.slice(this.off); this.off = this.buf.length; return v; }
      case 'UUID': {
        this.need(16);
        const hex = this.buf.toString('hex', this.off, this.off + 16);
        this.off += 16;
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      }
      case 'option': {
        this.need(1);
        const present = this.buf[this.off] !== 0;
        this.off += 1;
        return present ? this.readType(args) : null;
      }
      case 'mapper': {
        const raw = this.readType(args.type);
        const key = typeof raw === 'bigint' ? `0x${raw.toString(16)}` : String(raw);
        const found = (args.mappings || {})[key];
        if (found !== undefined) return found;
        threshold: {
          for (const [k, v] of Object.entries(args.mappings || {})) {
            if (Number(k) === Number(raw)) return v;
          }
        }
        return raw;
      }
      case 'container': {
        const frame = {};
        this.stack.push(frame);
        for (const f of args) {
          if (f.anon) continue;
          frame[f.name] = this.readType(f.type);
        }
        this.stack.pop();
        return frame;
      }
      case 'switch': {
        let val = this.stack[this.stack.length - 1];
        const parts = String(args.compareTo).split('/');
        let i = 0;
        if (parts[0] === '..') { i = 1; val = this.stack[this.stack.length - 2]; }
        for (const p of parts.slice(i)) val = val === undefined || val === null ? undefined : val[p];
        const key = typeof val === 'bigint' ? `0x${val.toString(16)}` : String(val);
        const spec = (args.fields && (args.fields[key] !== undefined ? args.fields[key] : args.fields[val])) || args.default;
        if (spec === undefined) throw new Error(`switch: нет ветки ${key}`);
        return this.readType(spec);
      }
      case 'array': {
        const frame = {};
        this.stack.push(frame);
        const count = args.count !== undefined ? args.count : this.readType(args.countType);
        const out = [];
        for (let i = 0; i < count; i += 1) out.push(this.readType(args.type));
        this.stack.pop();
        return out;
      }
      case 'bitfield': {
        let val = 0n;
        let total = 0;
        for (const f of args) total += f.size;
        const bytes = Math.ceil(total / 8);
        this.need(bytes);
        for (let i = 0; i < bytes; i += 1) val = (val << 8n) | BigInt(this.buf[this.off + i]);
        this.off += bytes;
        const out = {};
        let shift = BigInt(total);
        for (const f of args) {
          shift -= BigInt(f.size);
          const mask = (1n << BigInt(f.size)) - 1n;
          let part = (val >> shift) & mask;
          if (f.signed) {
            const half = 1n << BigInt(f.size - 1);
            if (part >= half) part -= (1n << BigInt(f.size));
          }
          out[f.name] = f.signed ? Number(part) : Number(part);
        }
        return out;
      }
      case 'bitflags': {
        const raw = BigInt(this.readType(args.type));
        const out = {};
        const flags = args.flags || {};
        let bit = 0n;
        for (const [name, flag] of Object.entries(flags)) {
          if (typeof flag === 'object' && flag !== null) {
            bit = BigInt(flag.bit ?? Object.keys(flags).indexOf(name));
            out[name] = (raw & (1n << bit)) !== 0n;
          }
        }
        return out;
      }
      default:
        throw new Error(`чтение типа ${name} не поддержано`);
    }
  }
}

/* ---------- запись ---------- */

function varInt(n) {
  const out = [];
  let v = n | 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    out.push(b);
  } while (v !== 0);
  return Buffer.from(out);
}

function varLong(n) {
  const out = [];
  let v = BigInt(n);
  if (v < 0n) v += 1n << 64n;
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) b |= 0x80;
    out.push(b);
  } while (v !== 0n);
  return Buffer.from(out);
}

class Writer {
  constructor(ctx) {
    this.ctx = ctx;
    this.parts = [];
    this.stack = [];
  }

  def(name) {
    const t = this.ctx.table;
    return t.types[`${this.ctx.section}:${this.ctx.dir}.${name}`] || t.types[name] || null;
  }

  writeType(spec, value) {
    if (typeof spec === 'string') return this.writeNamed(spec, undefined, value);
    if (!Array.isArray(spec)) throw new Error('непонятное описание поля');
    return this.writeNamed(spec[0], spec[1], value);
  }

  push(buf) { if (buf && buf.length) this.parts.push(buf); }

  writeNamed(name, args, value) {
    const t = this.ctx.table;
    if (!PRIMITIVES.has(name)) {
      const ref = t.types[`${this.ctx.section}:${this.ctx.dir}.${name}`] || t.types[name];
      if (ref === null || ref === undefined) throw new Error(`неизвестный тип ${name}`);
      return this.writeType(ref, value);
    }
    switch (name) {
      case 'void': return;
      case 'bool': return this.push(Buffer.from([value ? 1 : 0]));
      case 'u8': case 'i8': { const b = Buffer.alloc(1); name === 'u8' ? b.writeUInt8(Math.max(0, Math.min(255, Number(value) || 0)), 0) : b.writeInt8(Number(value) || 0, 0); return this.push(b); }
      case 'u16': { const b = Buffer.alloc(2); b.writeUInt16BE(Math.max(0, Math.min(65535, Number(value) || 0)), 0); return this.push(b); }
      case 'i16': { const b = Buffer.alloc(2); b.writeInt16BE(Number(value) || 0, 0); return this.push(b); }
      case 'u32': { const b = Buffer.alloc(4); b.writeUInt32BE(Math.max(0, Number(value) || 0) >>> 0, 0); return this.push(b); }
      case 'i32': { const b = Buffer.alloc(4); b.writeInt32BE(Number(value) || 0, 0); return this.push(b); }
      case 'u64': { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(value || 0), 0); return this.push(b); }
      case 'i64': { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(typeof value === 'bigint' ? value : Number(value) || 0), 0); return this.push(b); }
      case 'f32': { const b = Buffer.alloc(4); b.writeFloatBE(Number(value) || 0, 0); return this.push(b); }
      case 'f64': { const b = Buffer.alloc(8); b.writeDoubleBE(Number(value) || 0, 0); return this.push(b); }
      case 'varint': return this.push(varInt(Number(value) || 0));
      case 'varlong': return this.push(varLong(value === undefined || value === null ? 0 : value));
      case 'pstring': {
        const str = Buffer.from(String(value === undefined || value === null ? '' : value), 'utf8');
        this.writeNamed((args && args.countType) || 'varint', undefined, str.length);
        return this.push(str);
      }
      case 'buffer': {
        const buf = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
        if (args && args.rest) return this.push(buf);
        const len = args && args.count !== undefined ? args.count : buf.length;
        if (args && args.count === undefined) this.writeNamed(args.countType, undefined, len);
        const fixed = Buffer.alloc(len);
        buf.copy(fixed, 0, 0, Math.min(len, buf.length));
        return this.push(fixed);
      }
      case 'restBuffer': return this.push(Buffer.isBuffer(value) ? value : Buffer.from(value || []));
      case 'UUID': {
        const clean = String(value || '').replace(/[^0-9a-f]/gi, '').padEnd(32, '0').slice(0, 32);
        return this.push(Buffer.from(clean, 'hex'));
      }
      case 'option': {
        if (value === undefined || value === null) return this.push(Buffer.from([0]));
        this.push(Buffer.from([1]));
        return this.writeType(args, value);
      }
      case 'mapper': {
        let key = String(value);
        if (args.mappings[key] === undefined) {
          for (const [k, v] of Object.entries(args.mappings || {})) if (v === value) { key = k; break; }
        }
        const num = /^0x/i.test(key) ? parseInt(key, 16) : key;
        return this.writeType(args.type, num);
      }
      case 'container': {
        const frame = value && typeof value === 'object' ? value : {};
        this.stack.push(frame);
        for (const f of args) {
          if (f.anon) continue;
          const v = frame[f.name] !== undefined ? frame[f.name] : this.defaultValue(f.type);
          this.writeType(f.type, v);
        }
        this.stack.pop();
        return;
      }
      case 'switch': {
        let val = this.stack[this.stack.length - 1];
        const parts = String(args.compareTo).split('/');
        let i = 0;
        if (parts[0] === '..') { i = 1; val = this.stack[this.stack.length - 2]; }
        for (const p of parts.slice(i)) val = val === undefined || val === null ? undefined : val[p];
        const key = String(val);
        const spec = (args.fields && (args.fields[key] !== undefined ? args.fields[key] : args.fields[val])) || args.default;
        if (spec === undefined) return;
        return this.writeType(spec, value);
      }
      case 'array': {
        const frame = { count: 0 };
        this.stack.push(frame);
        const list = Array.isArray(value) ? value : [];
        if (args.count === undefined) this.writeType(args.countType, list.length);
        for (const item of list) this.writeType(args.type, item);
        this.stack.pop();
        return;
      }
      case 'bitfield': {
        const frame = value || {};
        let total = 0;
        for (const f of args) total += f.size;
        const bytes = Math.ceil(total / 8);
        let val = 0n;
        for (const f of args) {
          let part = BigInt(Math.trunc(Number(frame[f.name]) || 0));
          if (part < 0n) part += 1n << BigInt(f.size);
          val = (val << BigInt(f.size)) | (part & ((1n << BigInt(f.size)) - 1n));
        }
        const out = Buffer.alloc(bytes);
        for (let i = bytes - 1; i >= 0; i -= 1) { out[i] = Number(val & 0xffn); val >>= 8n; }
        return this.push(out);
      }
      case 'bitflags': {
        const frame = value || {};
        let val = 0n;
        let idx = 0;
        for (const [flagName, flag] of Object.entries(args.flags || {})) {
          const bit = typeof flag === 'object' && flag !== null && flag.bit !== undefined ? flag.bit : idx;
          if (frame[flagName]) val |= 1n << BigInt(bit);
          idx += 1;
        }
        return this.writeType(args.type, val);
      }
      default:
        throw new Error(`запись типа ${name} не поддержана`);
    }
  }

  /** Значение по умолчанию — чтобы не расписывать поля, которые не важны боту. */
  defaultValue(spec, depth = 0) {
    if (depth > 6) return 0;
    if (typeof spec === 'string') {
      const d = this.def(spec);
      return d === null ? this.primitiveDefault(spec) : this.defaultValue(d, depth + 1);
    }
    if (!Array.isArray(spec)) return 0;
    if (!PRIMITIVES.has(spec[0])) {
      const d = this.def(spec[0]);
      return d === null ? this.primitiveDefault(spec[0]) : this.defaultValue(d, depth + 1);
    }
    const [name, args] = spec;
    switch (name) {
      case 'bool': return false;
      case 'i8': case 'u8': return 0;
      case 'i16': case 'u16': case 'i32': case 'u32': case 'varint': return 0;
      case 'i64': case 'u64': case 'varlong': return 0;
      case 'f32': case 'f64': return 0;
      case 'pstring': return '';
      case 'buffer': return Buffer.alloc(args && args.count !== undefined ? args.count : 0);
      case 'restBuffer': return Buffer.alloc(0);
      case 'void': return undefined;
      case 'UUID': return '00000000-0000-0000-0000-000000000000';
      case 'option': return null;
      case 'mapper': { const first = Object.values(args.mappings || {})[0]; return first === undefined ? 0 : first; }
      case 'container': { const o = {}; for (const f of args) if (!f.anon) o[f.name] = this.defaultValue(f.type, depth + 1); return o; }
      case 'switch': return 0;
      case 'array': return [];
      case 'bitfield': { const o = {}; for (const f of args) o[f.name] = 0; return o; }
      case 'bitflags': return {};
      default: return 0;
    }
  }

  primitiveDefault(name) {
    if (['i8', 'u8', 'i16', 'u16', 'i32', 'u32', 'i64', 'u64', 'varint', 'varlong', 'f32', 'f64'].includes(name)) return 0;
    if (name === 'bool') return false;
    if (name === 'pstring') return '';
    if (name === 'UUID') return '00000000-0000-0000-0000-000000000000';
    return 0;
  }
}

/* ---------- публичный интерфейс ---------- */

function ids(protocol, section, dir) {
  const t = table(protocol);
  if (!t) return null;
  if (section === 'configuration') return (t.configuration && t.configuration[dir]) || null;
  return (t[section] && t[section][dir]) || null;
}

function nameOf(protocol, section, dir, id) {
  const map = ids(protocol, section, dir);
  if (!map) return null;
  for (const [name, value] of Object.entries(map)) if (value === id) return name;
  return null;
}

function idOf(protocol, section, dir, name) {
  const map = ids(protocol, section, dir);
  return map && map[name] !== undefined ? map[name] : null;
}

/** Описание полей пакета (или null, если полей не знаем). */
function fieldsOf(protocol, section, dir, name) {
  const t = table(protocol);
  if (!t) return null;
  return t.types[`${section}:${dir}.${name}.fields`] || null;
}

/**
 * Разобрать пакет. fields — какие поля нужны. Читаем по одному полю и
 * останавливаемся, как только нужное собрано: так бот не спотыкается о
 * структуры вроде реестров и карт высот, которые ему не нужны.
 */
function read(protocol, section, dir, name, payload, fields) {
  const t = table(protocol);
  if (!t) throw new Error('нет таблиц для этой версии');
  const ctx = { table: t, section, dir };
  const reader = new Reader(payload, ctx);
  const spec = resolveSpec(ctx, fieldsOf(protocol, section, dir, name));
  if (!spec || spec[0] !== 'container') return { params: null, offset: 0, full: !payload.length };
  const frame = {};
  reader.stack.push(frame);
  const wanted = fields && fields.length ? fields : null;
  for (const f of spec[1]) {
    if (f.anon) continue;
    try {
      frame[f.name] = reader.readType(f.type);
    } catch (e) {
      reader.stack.pop();
      return { params: frame, offset: reader.off, error: e.message };
    }
    if (wanted && wanted.every((x) => frame[x] !== undefined)) break;
  }
  reader.stack.pop();
  return { params: frame, offset: reader.off, full: reader.off >= payload.length };
}

/** Развернуть ссылку на описание («packet_keep_alive» -> container). */
function resolveSpec(ctx, spec, depth = 0) {
  if (depth > 8 || typeof spec !== 'string') return spec;
  const t = ctx.table;
  const next = t.types[`${ctx.section}:${ctx.dir}.${spec}`] || t.types[spec];
  if (next === undefined) return null;
  return resolveSpec(ctx, next, depth + 1);
}

/** Собрать тело пакета (без номера). Недостающие поля заполняются сами. */
function write(protocol, section, dir, name, values) {
  const t = table(protocol);
  if (!t) throw new Error('нет таблиц для этой версии');
  const ctx = { table: t, section, dir };
  const writer = new Writer(ctx);
  const spec = fieldsOf(protocol, section, dir, name) || ['container', []];
  writer.writeType(spec, values || {});
  return Buffer.concat(writer.parts);
}

function supported(protocol) {
  return !!TABLES[protocol];
}

function versions() {
  return Object.values(TABLES).map((t) => ({ protocol: t.protocol, version: t.version }));
}

module.exports = { TABLES, Reader, Writer, read, write, ids, idOf, nameOf, fieldsOf, table, nearest, supported, versions, resolveSpec };
