#!/usr/bin/env node
'use strict';
/*
 * Генератор таблиц протокола для тестовых ботов.
 *
 * Берёт описания пакетов из открытого набора minecraft-data (PrismarineJS)
 * и складывает в core/bot-protocols.js только то, что нужно ботам:
 * номера пакетов и структуры полей для нужных версий сервера.
 *
 * Запуск:  node tools/gen-bot-protocols.js [--out core/bot-protocols.js]
 * Нужен интернет — но только на этапе сборки. Готовый файл лежит в репозитории,
 * поэтому панель в работе в сеть за таблицами не ходит.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');

const BASE = 'https://raw.githubusercontent.com/PrismarineJS/minecraft-data/master/data';

/* протокол -> папка с описанием в minecraft-data */
const VERSIONS = [
  [47, '1.8', '1.8.9'],
  [110, '1.9.4', '1.9.4'],
  [316, '1.11', '1.11.2'],
  [340, '1.12.2', '1.12.2'],
  [404, '1.13.2', '1.13.2'],
  [498, '1.14.4', '1.14.4'],
  [578, '1.15.2', '1.15.2'],
  [754, '1.16.2', '1.16.5'],
  [756, '1.17.1', '1.17.1'],
  [758, '1.18.2', '1.18.2'],
  [759, '1.19', '1.19'],
  [760, '1.19.2', '1.19.2'],
  [761, '1.19.3', '1.19.3'],
  [762, '1.19.4', '1.19.4'],
  [763, '1.20', '1.20.1'],
  [764, '1.20.2', '1.20.2'],
  [765, '1.20.3', '1.20.4'],
  [766, '1.20.5', '1.20.6'],
  [767, '1.21.1', '1.21.1'],
  [768, '1.21.3', '1.21.3'],
  [769, '1.21.4', '1.21.4'],
  [770, '1.21.5', '1.21.5'],
  [771, '1.21.6', '1.21.6'],
  [772, '1.21.8', '1.21.8'],
  [773, '1.21.9', '1.21.10'],
  [774, '1.21.11', '1.21.11'],
];

/* что именно нужно ботам: секция -> направление -> имена пакетов */
const NEED = {
  login: {
    toServer: ['login_start', 'encryption_begin', 'login_plugin_response', 'login_acknowledged'],
    toClient: ['disconnect', 'success', 'compress', 'login_plugin_request', 'encryption_begin'],
  },
  configuration: {
    toServer: ['settings', 'custom_payload', 'finish_configuration', 'keep_alive', 'pong', 'resource_pack_receive',
      'cookie_response', 'client_information', 'select_known_packs', 'configuration_acknowledged'],
    toClient: ['disconnect', 'keep_alive', 'finish_configuration', 'custom_payload', 'add_resource_pack', 'plugin_message',
      'cookie_request', 'ping', 'reset_chat', 'select_known_packs', 'registry_data'],
  },
  play: {
    toServer: [
      'teleport_confirm', 'position', 'position_look', 'look', 'flying', 'chat', 'chat_message',
      'chat_command', 'settings', 'client_information', 'custom_payload', 'keep_alive', 'arm_animation',
      'chunk_batch_received', 'tick_end', 'pong', 'client_command', 'resource_pack_receive', 'entity_action',
      'configuration_acknowledged', 'select_known_packs',
    ],
    toClient: [
      'keep_alive', 'login', 'position', 'map_chunk', 'chat', 'system_chat', 'player_chat', 'kick_disconnect',
      'set_compression', 'chunk_batch_start', 'chunk_batch_finished', 'unload_chunk', 'add_resource_pack',
      'resource_pack_send', 'death_combat_event', 'spawn_position', 'update_view_position', 'sync_entity_position',
      'tick_end', 'ping', 'disconnect', 'respawn', 'start_configuration', 'select_known_packs',
    ],
  },
};

/* крупные структуры (реестры, теги, спавн) ботам не нужны — считаем их «сырыми» */
const OPAQUE_BYTES = 12000;

function get(url, redirect = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'OmniPanel-bot-protocols' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirect < 4) {
        res.resume();
        resolve(get(res.headers.location, redirect + 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} ${url}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

/* тип-спецификация в minecraft-data: строка-имя либо [имя, аргументы] */
function walkType(t, ns, take) {
  if (typeof t === 'string') { take(t, ns); return; }
  if (!Array.isArray(t)) return;
  walkType(t[0], ns, take);
  walkArgs(t[0], t[1], ns, take);
}

function walkArgs(name, args, ns, take) {
  if (args === undefined || args === null) return;
  switch (name) {
    case 'switch':
      for (const v of Object.values(args.fields || {})) walkType(v, ns, take);
      if (args.default) walkType(args.default, ns, take);
      return;
    case 'array':
      walkType(args.type, ns, take);
      return;
    case 'option':
      walkType(args, ns, take);
      return;
    case 'container':
      for (const f of args) {
        if (f && f.type !== undefined) walkType(f.type, ns, take);
        else if (f && f.anon) walkType(f.anon, ns, take);
      }
      return;
    default:
      if (typeof args === 'object' && args.type !== undefined) walkType(args.type, ns, take);
  }
}

async function buildProtocol(protocol, dir, mcVersion) {
  const file = path.join(__dirname, '..', '.cache-protocols', `${dir}.json`);
  let raw;
  if (fs.existsSync(file)) raw = fs.readFileSync(file);
  else {
    raw = await get(`${BASE}/pc/${dir}/protocol.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, raw);
  }
  const data = JSON.parse(raw.toString('utf8'));
  const out = { version: mcVersion, protocol, login: {}, configuration: null, play: {}, types: {}, aliases: {} };
  const pool = out.types;

  /* в каждой секции лежит контейнер packet: внутри mapper «номер -> имя»
     и switch «имя -> описание полей». Достаём и то, и другое. */
  const sectionInfo = (section, dirn) => {
    const sec = data[section];
    const types = sec && sec[dirn] && sec[dirn].types;
    if (!types || !types.packet) return null;
    const ids = {};
    const decls = {};
    for (const f of types.packet[1]) {
      if (f.name === 'name' && Array.isArray(f.type) && f.type[0] === 'mapper') {
        for (const [hex, name] of Object.entries(f.type[1].mappings)) {
          if (/^0x[0-9a-f]+$/i.test(hex)) ids[String(name).replace(/^packet_/, '')] = parseInt(hex, 16);
        }
      }
      if (f.type === 'name' && f.name === 'name') continue;
    }
    for (const f of types.packet[1]) {
      if (f.name === 'data' || f.name === 'params') {
        const spec = f.type;
        if (Array.isArray(spec) && spec[0] === 'switch') {
          for (const [name, decl] of Object.entries(spec[1].fields || {})) {
            decls[String(name).replace(/^packet_/, '')] = decl;
          }
        }
      }
    }
    return { ids, decls, types };
  };

  const add = (name, ns, depth = 0) => {
    if (depth > 8) return null;
    if (/^(u|i)(8|16|32|64)$/.test(name) || ['bool', 'f32', 'f64', 'varint', 'varlong', 'pstring',
      'buffer', 'restBuffer', 'void', 'UUID', 'option', 'mapper', 'container', 'switch', 'array',
      'bitfield', 'bitflags'].includes(name)) return `${ns}:${name}`;
    const [section, dirn] = ns.split('.');
    const sec = data[section];
    const keyBySection = `${section}:${dirn}.${name}`;
    if (pool[keyBySection]) return keyBySection;
    let found = null;
    if (sec && sec[dirn] && sec[dirn].types[name]) found = { def: sec[dirn].types[name], key: keyBySection, ns };
    if (!found) {
      const other = dirn === 'toServer' ? 'toClient' : 'toServer';
      if (sec && sec[other] && sec[other].types[name]) found = { def: sec[other].types[name], key: `${section}:${other}.${name}`, ns: `${section}.${other}` };
    }
    if (!found && data.types && data.types[name]) found = { def: data.types[name], key: name, ns: 'global' };
    if (!found) return null;
    const size = JSON.stringify(found.def).length;
    pool[found.key] = size > OPAQUE_BYTES ? ['restBuffer', {}] : found.def;
    if (size <= OPAQUE_BYTES) walkType(found.def, found.ns, (n, s) => add(n, s, depth + 1));
    return found.key;
  };

  for (const section of ['login', 'configuration', 'play']) {
    for (const dirn of ['toServer', 'toClient']) {
      const info = sectionInfo(section, dirn);
      if (!info) continue;
      const want = (NEED[section] && NEED[section][dirn]) || [];
      const ns = `${section}.${dirn}`;
      const ids = {};
      for (const name of want) {
        if (info.ids[name] === undefined) continue;
        ids[name] = info.ids[name];
        const decl = info.decls[name];
        if (decl) {
          const key = `${section}:${dirn}.${name}`;
          pool[key] = ['container', [{ name: 'params', type: decl }]];
          walkType(decl, ns, (n, s) => add(n, s));
        }
      }
      if (!Object.keys(ids).length) continue;
      if (section === 'configuration') {
        out.configuration = out.configuration || {};
        out.configuration[dirn] = ids;
      } else {
        out[section][dirn] = ids;
      }
    }
  }

  /* описание пакета кладём отдельной записью, чтобы ботам не пришлось
     знать про обёртку switch */
  for (const section of ['login', 'configuration', 'play']) {
    for (const dirn of ['toServer', 'toClient']) {
      const info = sectionInfo(section, dirn);
      if (!info) continue;
      const ids = (section === 'configuration' ? (out.configuration || {})[dirn] : (out[section] || {})[dirn]) || {};
      for (const name of Object.keys(ids)) {
        const decl = info.decls[name];
        if (decl) pool[`${section}:${dirn}.${name}.fields`] = decl;
      }
    }
  }

  /* в 1.8–1.12 пакет чата зовётся просто chat, в 1.19+ — chat_message,
     а настройки клиента до 1.20.2 — settings. Ботам удобнее одно имя. */
  const alias = (section, dirn, from, to) => {
    const ids = (section === 'configuration' ? (out.configuration || {})[dirn] : (out[section] || {})[dirn]) || {};
    if (ids[from] === undefined || ids[to] !== undefined) return;
    ids[to] = ids[from];
    const pairs = [[`${section}:${dirn}.${from}`, `${section}:${dirn}.${to}`],
      [`${section}:${dirn}.${from}.fields`, `${section}:${dirn}.${to}.fields`]];
    for (const [src, dst] of pairs) if (pool[src] !== undefined && pool[dst] === undefined) pool[dst] = pool[src];
  };
  alias('play', 'toServer', 'chat', 'chat_message');
  alias('play', 'toServer', 'chat_message', 'chat');
  alias('play', 'toServer', 'settings', 'client_information');
  alias('play', 'toServer', 'client_information', 'settings');
  alias('configuration', 'toServer', 'settings', 'client_information');
  alias('configuration', 'toServer', 'client_information', 'settings');
  alias('play', 'toClient', 'chat', 'system_chat');
  alias('play', 'toClient', 'system_chat', 'chat');
  return out;
}

async function main() {
  const outArg = process.argv.indexOf('--out');
  const outFile = outArg > 0 ? process.argv[outArg + 1] : path.join(__dirname, '..', 'core', 'bot-protocols.js');
  const table = {};
  for (const [protocol, dir, mc] of VERSIONS) {
    process.stdout.write(`протокол ${protocol} (${mc})… `);
    try {
      table[protocol] = await buildProtocol(protocol, dir, mc);
      const ids = Object.keys(table[protocol].play.toServer || {}).length;
      const ids2 = Object.keys(table[protocol].play.toClient || {}).length;
      console.log(`ок: ${ids} своих пакетов, ${ids2} входящих, ${Object.keys(table[protocol].types).length} структур`);
    } catch (e) {
      console.log(`пропуск (${e.message})`);
    }
  }
  const body = `'use strict';\n/* Сгенерировано tools/gen-bot-protocols.js — не править руками.\n` +
    ` * Источник: minecraft-data (PrismarineJS). Таблицы номеров пакетов и структур\n` +
    ` * полей для версий протокола ${Object.keys(table)[0]}…${Object.keys(table).slice(-1)[0]}. */\n` +
    `module.exports = ${JSON.stringify(table)};\n`;
  fs.writeFileSync(outFile, body);
  const gz = zlib.gzipSync(body).length;
  console.log(`\nзаписано: ${outFile} — ${(body.length / 1024).toFixed(0)} КБ (gzip ${(gz / 1024).toFixed(0)} КБ), версий: ${Object.keys(table).length}`);
}

main().catch((e) => { console.error('ошибка:', e.message); process.exit(1); });
