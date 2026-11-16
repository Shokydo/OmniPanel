'use strict';
/*
 * Собирает из core/bot-protocols.js компактные таблицы для ботов на Rust.
 *
 * Полный файл таблиц — 450 КБ на 26 версий. Ботам нужны не все пакеты, а
 * десяток: вход, вход в игру, подтверждение, движение, чат. Поэтому здесь
 * берём только нужное, ссылки на типы раскрываем на месте — и Rust читает
 * результат своим JSON без всякой магии.
 *
 * Запуск:  node tools/gen-bot-tables.js
 * Итог:    rust/omnipanel-core/src/bot/tables.json
 */
const fs = require('fs');
const path = require('path');

const TABLES = require('../core/bot-protocols');

/* Что бот отправляет: раздел/направление/имя пакета. */
const SEND = [
  ['login', 'toServer', 'login_start'],
  ['login', 'toClient', 'success'],
  ['login', 'toClient', 'compress'],
  ['login', 'toClient', 'disconnect'],
  ['play', 'toServer', 'teleport_confirm'],
  ['play', 'toServer', 'chat_command'],
  ['configuration', 'toServer', 'client_information'],
  ['configuration', 'toServer', 'finish_configuration'],
  ['configuration', 'toServer', 'keep_alive'],
  ['configuration', 'toServer', 'pong'],
  ['configuration', 'toServer', 'custom_payload'],
  ['configuration', 'toServer', 'resource_pack_receive'],
  ['configuration', 'toServer', 'select_known_packs'],
  ['configuration', 'toServer', 'cookie_response'],
  ['configuration', 'toClient', 'finish_configuration'],
  ['configuration', 'toClient', 'keep_alive'],
  ['configuration', 'toClient', 'disconnect'],
  ['configuration', 'toClient', 'ping'],
  ['configuration', 'toClient', 'select_known_packs'],
  ['configuration', 'toClient', 'add_resource_pack'],
  ['configuration', 'toClient', 'registry_data'],
  ['configuration', 'toClient', 'cookie_request'],
  ['play', 'toServer', 'keep_alive'],
  ['play', 'toServer', 'client_information'],
  ['play', 'toServer', 'settings'],
  ['play', 'toServer', 'position'],
  ['play', 'toServer', 'position_look'],
  ['play', 'toServer', 'look'],
  ['play', 'toServer', 'flying'],
  ['play', 'toServer', 'chat'],
  ['play', 'toServer', 'chat_message'],
  ['play', 'toServer', 'arm_animation'],
  ['play', 'toServer', 'client_command'],
  ['play', 'toServer', 'custom_payload'],
  ['play', 'toServer', 'player_loaded'],
  ['play', 'toServer', 'tick_end'],
  ['play', 'toServer', 'chunk_batch_received'],
  ['play', 'toClient', 'keep_alive'],
  ['play', 'toClient', 'kick_disconnect'],
  ['play', 'toClient', 'login'],
  ['play', 'toClient', 'position'],
  ['play', 'toClient', 'map_chunk'],
  ['play', 'toClient', 'chunk_batch_start'],
  ['play', 'toClient', 'system_chat'],
  ['play', 'toClient', 'player_chat'],
];

/* Что бот только распознаёт по номеру (номера пакетов различаются по версиям). */
const NAMES = [
  ['login', 'toServer'], ['login', 'toClient'],
  ['configuration', 'toServer'], ['configuration', 'toClient'],
  ['play', 'toServer'], ['play', 'toClient'],
];

const PRIMITIVES = new Set(['u8', 'u16', 'u32', 'u64', 'i8', 'i16', 'i32', 'i64', 'f32', 'f64',
  'bool', 'varint', 'varlong', 'pstring', 'buffer', 'restBuffer', 'void', 'UUID', 'option',
  'mapper', 'container', 'switch', 'array', 'bitfield', 'bitflags']);

/** Раскрывает ссылки на типы, чтобы Rust не ходил по таблице сам. */
function resolve(t, section, dir, spec, depth = 0) {
  if (depth > 8) return null;
  if (typeof spec === 'string') {
    if (PRIMITIVES.has(spec)) return spec;
    /* тип ищется как в прежней панели: сначала в своём разделе, потом общий
       (например, «string» → pstring с длиной varint) */
    const next = t.types[`${section}:${dir}.${spec}`]
      || t.types[`${section}:${dir}.${spec}.fields`]
      || t.types[spec];
    if (next === undefined) return null;
    return resolve(t, section, dir, next, depth + 1);
  }
  if (Array.isArray(spec)) {
    const [name, args] = spec;
    if (typeof name !== 'string') return null;
    if (!PRIMITIVES.has(name)) {
      const next = t.types[`${section}:${dir}.${name}`]
        || t.types[`${section}:${dir}.${name}.fields`]
        || t.types[name];
      if (next === undefined) return null;
      return resolve(t, section, dir, next, depth + 1);
    }
    /* вложенные описания внутри switch/array/container тоже раскрываем */
    if (!args) return [name];
    const out = Array.isArray(args) ? args.slice() : { ...args };
    const walk = (value) => {
      if (typeof value === 'string') return value;
      if (Array.isArray(value)) return value.map(walk);
      if (value && typeof value === 'object') {
        const obj = {};
        for (const [k, v] of Object.entries(value)) obj[k] = walk(v);
        return obj;
      }
      return value;
    };
    if (name === 'container') {
      return [name, Array.isArray(out) ? out.map((f) => (
        f && typeof f === 'object' && f.type !== undefined
          ? { ...f, type: resolve(t, section, dir, f.type, depth + 1) }
          : f
      )) : out];
    }
    if (name === 'array') {
      return [name, {
        count: out.count,
        countType: out.countType,
        type: resolve(t, section, dir, out.type, depth + 1),
      }];
    }
    if (name === 'bitfield') {
      return [name, walk(out)];
    }
    if (name === 'switch') {
      const fields = out.fields
        ? Object.fromEntries(Object.entries(out.fields).map(([k, v]) => [k, resolve(t, section, dir, v, depth + 1)]))
        : undefined;
      return [name, {
        compareTo: out.compareTo,
        fields,
        default: out.default === undefined ? undefined : resolve(t, section, dir, out.default, depth + 1),
      }];
    }
    return [name, walk(out)];
  }
  return null;
}

const out = { versions: {} };
for (const [key, t] of Object.entries(TABLES)) {
  const section = (name) => (name === 'configuration' ? t.configuration : t[name]) || null;
  const entry = {
    version: t.version,
    protocol: t.protocol,
    send: {},
    names: {},
  };

  for (const [sec, dir, name] of SEND) {
    const map = section(sec);
    if (!map || !map[dir]) continue;
    const id = map[dir][name];
    if (id === undefined) continue;
    const raw = t.types[`${sec}:${dir}.${name}.fields`] || t.types[`${sec}:${dir}.${name}`];
    const spec = raw === undefined ? ['container', []] : resolve(t, sec, dir, raw);
    if (spec === null) continue;
    /* направление обязательно в ключе: у finish_configuration есть и
       toServer, и toClient с разными номерами */
    entry.send[`${sec}/${dir}/${name}`] = { id, spec };
  }

  for (const [sec, dir] of NAMES) {
    const map = section(sec);
    if (!map || !map[dir]) continue;
    const byId = {};
    for (const [name, id] of Object.entries(map[dir])) {
      if (byId[id] === undefined) byId[id] = name;
    }
    entry.names[`${sec}/${dir}`] = byId;
  }

  out.versions[key] = entry;
}

const dir = path.join(__dirname, '..', 'rust', 'omnipanel-core', 'src', 'bot');
fs.mkdirSync(dir, { recursive: true });
const json = JSON.stringify(out);
fs.writeFileSync(path.join(dir, 'tables.json'), json, 'utf8');

/* Что получилось — коротко в консоль */
const versions = Object.keys(out.versions);
const sample = out.versions['765'];
console.log(`версий: ${versions.length} (${versions[0]}…${versions[versions.length - 1]})`);
console.log(`размер таблиц: ${(json.length / 1024).toFixed(0)} КБ`);
console.log(`пакетов на версию 1.20.4 (765): ${Object.keys(sample.send).length}`);
console.log(`пример: login_start = №${sample.send['login/toServer/login_start'].id}, ` +
  `keep_alive (play) = №${sample.send['play/toServer/keep_alive'].id}`);
for (const name of ['play/toServer/position_look', 'play/toServer/client_information', 'play/toServer/player_loaded', 'play/toClient/keep_alive']) {
  const present = versions.filter((v) => out.versions[v].send[name]);
  console.log(`  ${name}: ${present.length ? `есть в ${present.length} версиях` : 'нет ни в одной'}`);
}
