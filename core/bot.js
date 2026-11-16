'use strict';
/**
 * Тестовый бот: клиент Minecraft для замера нагрузки на сервер.
 *
 * Зачем свой клиент, а не готовая библиотека: панель должна работать без
 * интернета и без node_modules. Из всего протокола боту нужны вход,
 * подтверждения (keep-alive, позиция, чанки) и действия: ходьба, прыжки,
 * чат, команды, взмахи. Номера пакетов и поля берутся из core/bot-protocols.js,
 * поэтому один и тот же код работает и на 1.8.9, и на 1.21.x.
 *
 * Поддерживаются серверы в offline-mode (без проверки лицензии) — именно такие
 * поднимают для тестов. UUID бота считается так же, как это делает сервер.
 */
const net = require('net');
const zlib = require('zlib');
const crypto = require('crypto');

const P = require('./proto');

const MAX_BUF = 16 * 1024 * 1024;

/** Версия игры → версия протокола (для автоподстановки). */
const VERSION_PROTOCOL = {
  '1.8': 47, '1.8.8': 47, '1.8.9': 47,
  '1.9': 107, '1.9.4': 110, '1.10': 210, '1.10.2': 210, '1.11': 315, '1.11.2': 316,
  '1.12': 335, '1.12.1': 338, '1.12.2': 340,
  '1.13': 393, '1.13.1': 401, '1.13.2': 404,
  '1.14': 477, '1.14.4': 498,
  '1.15': 573, '1.15.2': 578,
  '1.16': 735, '1.16.1': 736, '1.16.2': 751, '1.16.3': 753, '1.16.4': 754, '1.16.5': 754,
  '1.17': 755, '1.17.1': 756,
  '1.18': 757, '1.18.1': 757, '1.18.2': 758,
  '1.19': 759, '1.19.1': 760, '1.19.2': 760, '1.19.3': 761, '1.19.4': 762,
  '1.20': 763, '1.20.1': 763, '1.20.2': 764, '1.20.3': 765, '1.20.4': 765,
  '1.20.5': 766, '1.20.6': 766,
  '1.21': 767, '1.21.1': 767, '1.21.2': 768, '1.21.3': 768, '1.21.4': 769,
  '1.21.5': 770, '1.21.6': 771, '1.21.7': 772, '1.21.8': 772,
  '1.21.9': 773, '1.21.10': 773, '1.21.11': 774,
};

/** Версия игры → протокол; если такой нет — ближайшая известная. */
function nearestProtocol(version) {
  const v = String(version || '').match(/\d+\.\d+(\.\d+)?/);
  if (!v) return 765;
  const exact = VERSION_PROTOCOL[v[0]];
  if (exact) return exact;
  const parts = v[0].split('.').map(Number);
  const known = Object.keys(VERSION_PROTOCOL).filter((k) => k.split('.')[0] === String(parts[0]));
  if (!known.length) return 765;
  let best = known[0];
  const key = (s) => s.split('.').map(Number);
  for (const k of known) {
    const a = key(k);
    const b = key(best);
    if (Math.abs((a[1] || 0) - (parts[1] || 0)) < Math.abs((b[1] || 0) - (parts[1] || 0))) best = k;
  }
  return VERSION_PROTOCOL[best];
}

/** UUID offline-режима: md5 от «OfflinePlayer:<ник>» с выставленной версией. */
function offlineUuid(name) {
  const hash = crypto.createHash('md5').update('OfflinePlayer:' + name, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  return `${hash.toString('hex', 0, 4)}-${hash.toString('hex', 4, 6)}-${hash.toString('hex', 6, 8)}-${hash.toString('hex', 8, 10)}-${hash.toString('hex', 10, 16)}`;
}

/* ─────────────────────────── рамки и сжатие ─────────────────────────── */

function writeVarInt(value) {
  const out = [];
  let v = value | 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    out.push(b);
  } while (v !== 0);
  return Buffer.from(out);
}

function readVarInt(buf, offset = 0) {
  let value = 0;
  let shift = 0;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos];
    value |= (byte & 0x7f) << shift;
    pos += 1;
    if (!(byte & 0x80)) return { value: value | 0, size: pos - offset };
    shift += 7;
    if (shift > 35) break;
  }
  return null;
}

/* ─────────────────────────── сам бот ─────────────────────────── */

class Bot {
  /**
   * @param {object} opts
   * @param {string} opts.host, opts.port — адрес сервера
   * @param {string} opts.name — ник бота
   * @param {number|string} opts.protocol|opts.version — версия протокола или игры
   * @param {object} opts.actions — walk, jump, chat, cmd, swing и их тайминги
   * @param {function} opts.onEvent — (тип, данные) журнал и статистика
   */
  constructor(opts) {
    this.host = opts.host || '127.0.0.1';
    this.port = Number(opts.port) || 25565;
    this.name = String(opts.name || 'Bot').slice(0, 16);
    this.protocol = Number(opts.protocol) || nearestProtocol(opts.version);
    this.actions = opts.actions || {};
    this.onEvent = opts.onEvent || (() => {});

    this.socket = null;
    this.state = 'idle';        // idle | login | config | play | closed
    this.compression = -1;
    this.buffer = Buffer.alloc(0);
    this.pos = { x: 0.5, y: 64, z: 0.5, yaw: 0, pitch: 0, onGround: true };
    this.spawned = false;
    this.stats = {
      packetsIn: 0, packetsOut: 0, bytesIn: 0, bytesOut: 0,
      chunks: 0, chunkSet: new Set(), chat: 0, cmd: 0, moves: 0, jumps: 0,
    };
    this.timers = [];
    this.keepAlives = 0;
    this.lastError = '';
    this.startedAt = 0;
    this.debug = !!opts.debug;
    this.tickEndAcks = 0;
    this.batchAcks = 0;
  }

  /* ───────────── подключение ───────────── */

  connect() {
    if (this.socket) return this;
    this.state = 'login';
    this.startedAt = Date.now();
    this.socket = net.createConnection({ host: this.host, port: this.port });
    this.socket.setNoDelay(true);
    this.socket.on('connect', () => this.handshake());
    this.socket.on('data', (data) => {
      this.stats.bytesIn += data.length;
      this.buffer = Buffer.concat([this.buffer, data]);
      if (this.buffer.length > MAX_BUF) { this.fail('сервер прислал слишком много данных сразу'); return; }
      this.drain();
    });
    this.socket.on('error', (err) => {
      this.fail(err.code === 'ECONNREFUSED' ? 'сервер не отвечает на порту' : err.message);
    });
    this.socket.on('close', () => {
      this.stopTimers();
      const was = this.state;
      this.state = 'closed';
      this.socket = null;
      this.onEvent('close', { name: this.name, was, reason: this.lastError });
    });
    return this;
  }

  handshake() {
    const host = Buffer.from(this.host, 'utf8');
    this.sendRaw(Buffer.concat([
      writeVarInt(0x00),
      writeVarInt(this.protocol),
      writeVarInt(host.length), host,
      Buffer.from([(this.port >> 8) & 0xff, this.port & 0xff]),
      writeVarInt(2),
    ]));
    this.sendPacket('login', 'toServer', 'login_start', {
      username: this.name,
      playerUUID: offlineUuid(this.name),
      playerUuid: offlineUuid(this.name),
      hasPlayerUuid: true,
    });
  }

  /* ───────────── отправка ───────────── */

  sendRaw(payload) {
    if (!this.socket || this.socket.destroyed) return;
    let frame;
    if (this.compression >= 0) {
      if (payload.length >= this.compression) {
        frame = Buffer.concat([writeVarInt(payload.length), zlib.deflateSync(payload)]);
      } else {
        frame = Buffer.concat([writeVarInt(0), payload]);
      }
    } else {
      frame = payload;
    }
    const out = Buffer.concat([writeVarInt(frame.length), frame]);
    this.socket.write(out);
    this.stats.packetsOut += 1;
    this.stats.bytesOut += out.length;
  }

  /** Собрать и отправить пакет: id + поля по описанию версии. */
  sendPacket(section, dir, name, values) {
    const id = P.idOf(this.protocol, section, dir, name);
    if (id === null) return false;
    let body;
    try {
      body = P.write(this.protocol, section, dir, name, values || {});
    } catch (e) {
      this.lastError = `пакет ${name}: ${e.message}`;
      return false;
    }
    this.sendRaw(Buffer.concat([writeVarInt(id), body]));
    return true;
  }

  /* ───────────── приём ───────────── */

  drain() {
    while (this.buffer.length) {
      const len = readVarInt(this.buffer, 0);
      if (!len) return;
      if (this.buffer.length < len.size + len.value) return;
      let body = this.buffer.slice(len.size, len.size + len.value);
      this.buffer = this.buffer.slice(len.size + len.value);

      if (this.compression >= 0) {
        const dataLen = readVarInt(body, 0);
        if (!dataLen) continue;
        body = body.slice(dataLen.size);
        if (dataLen.value > 0) {
          try { body = zlib.inflateSync(body); } catch { continue; }
        }
      }
      this.stats.packetsIn += 1;
      this.handlePacket(body);
      if (this.state === 'closed') return;
    }
  }

  handlePacket(body) {
    const id = readVarInt(body, 0);
    if (!id) return;
    const data = body.slice(id.size);
    const section = this.state === 'login' ? 'login' : this.state === 'config' ? 'configuration' : 'play';
    if (section === 'play' && !P.ids(this.protocol, 'play', 'toClient')) return;
    const name = P.nameOf(this.protocol, section, 'toClient', id.value);
    if (!name) return;
    if (this.debug) console.log(`[${this.name}] <- ${section}/${name} (${data.length} б)`);
    this.handle(section, name, data);
  }

  readField(section, name, data, fields) {
    try {
      return P.read(this.protocol, section, 'toClient', name, data, fields).params || {};
    } catch {
      return {};
    }
  }

  handle(section, name, data) {
    /* ── общие для всех фаз ── */
    if (name === 'keep_alive') {
      this.keepAlives += 1;
      const p = this.readField(section, name, data, ['keepAliveId']);
      const value = p.keepAliveId !== undefined ? p.keepAliveId : (data.length >= 8 ? data.readBigInt64BE(0) : 0);
      this.sendPacket(section, 'toServer', 'keep_alive', { keepAliveId: value });
      return;
    }
    if (name === 'ping') {
      const p = this.readField(section, name, data, ['id', 'payload', 'pingId']);
      this.sendPacket(section, 'toServer', 'pong', { id: p.id !== undefined ? p.id : p.pingId || 0, payload: p.payload });
      if (P.idOf(this.protocol, section, 'toServer', 'pong') === null && section === 'play') {
        this.sendPacket('play', 'toServer', 'pong', p);
      }
      return;
    }
    if (name === 'disconnect' || name === 'kick_disconnect') {
      const p = this.readField(section, name, data, ['reason']);
      this.lastError = this.reasonText(p.reason) || 'сервер отключил бота';
      this.onEvent('kick', { name: this.name, reason: this.lastError });
      this.close();
      return;
    }

    /* ── вход ── */
    if (section === 'login') {
      if (name === 'compress') {
        const p = this.readField(section, name, data, ['threshold']);
        this.compression = Number(p.threshold) || 0;
        return;
      }
      if (name === 'encryption_begin') {
        this.fail('сервер в онлайн-режиме: тестовые боты заходят только на offline-mode');
        return;
      }
      if (name === 'login_plugin_request') {
        const p = this.readField(section, name, data, ['messageId']);
        this.sendPacket('login', 'toServer', 'login_plugin_response', {
          messageId: p.messageId || 0,
          data: null,
          successful: false,
        });
        return;
      }
      if (name === 'success') {
        const p = this.readField(section, name, data, ['username']);
        this.onEvent('login', { name: this.name, confirmedAs: p.username || this.name });
        if (this.hasConfigPhase()) {
          this.sendPacket('login', 'toServer', 'login_acknowledged', {});
          this.state = 'config';
          this.sendClientSettings('configuration');
          this.sendBrand('configuration');
          this.sendKnownPacks('configuration');
          return;
        }
        this.enterPlay();
        return;
      }
      return;
    }

    /* ── конфигурация (1.20.2+) ── */
    if (section === 'configuration') {
      if (name === 'finish_configuration') {
        this.sendPacket('configuration', 'toServer', 'finish_configuration', {});
        this.enterPlay();
        return;
      }
      if (name === 'add_resource_pack') {
        this.declineResourcePack('configuration', data);
        return;
      }
      if (name === 'select_known_packs') {
        /* сервер сверил наборы данных: если он пришлёт реестры — просто примем */
        return;
      }
      if (name === 'finish_configuration_ack') return;
      if (name === 'cookie_request') {
        const p = this.readField(section, name, data, ['key']);
        this.sendPacket('configuration', 'toServer', 'cookie_response', { key: p.key || '', payload: null });
        return;
      }
      return;
    }

    /* ── игра ── */
    if (name === 'map_chunk' || name === 'chunk_biomes') {
      const p = this.readField('play', name, data, ['x', 'z']);
      this.stats.chunks += 1;
      if (p.x !== undefined && p.z !== undefined) this.stats.chunkSet.add(`${p.x}:${p.z}`);
      return;
    }
    if (name === 'unload_chunk') {
      const p = this.readField('play', name, data, ['chunkX', 'chunkZ']);
      if (p.chunkX !== undefined) this.stats.chunkSet.delete(`${p.chunkX}:${p.chunkZ}`);
      return;
    }
    if (name === 'chunk_batch_start') {
      /* 1.20.5+: сервер ждёт, сколько чанков за тик бот готов принять */
      this.batchAcks += 1;
      this.sendPacket('play', 'toServer', 'chunk_batch_received', { chunksPerTick: 12 });
      return;
    }
    if (name === 'tick_end') {
      /* 1.21.2+: сервер двигает тик дальше только после подтверждения */
      this.tickEndAcks += 1;
      this.sendPacket('play', 'toServer', 'tick_end', {});
      return;
    }
    if (name === 'position' || name === 'sync_entity_position') {
      const p = this.readField('play', name, data, ['x', 'y', 'z', 'yaw', 'pitch', 'teleportId']);
      if (p.x !== undefined) {
        this.pos.x = Number(p.x);
        this.pos.y = Number(p.y);
        this.pos.z = Number(p.z);
        this.pos.yaw = Number(p.yaw) || 0;
        this.pos.pitch = Number(p.pitch) || 0;
      }
      if (p.teleportId !== undefined) {
        this.sendPacket('play', 'toServer', 'teleport_confirm', { teleportId: p.teleportId });
      }
      if (!this.spawned) {
        this.spawned = true;
        this.onEvent('spawn', { name: this.name, x: this.pos.x, y: this.pos.y, z: this.pos.z });
      }
      return;
    }
    if (name === 'login') {
      /* «вход в мир»: сообщаем серверу, что мы на месте */
      if (!this.spawned) this.sendPosition(false);
      return;
    }
    if (name === 'add_resource_pack' || name === 'resource_pack_send') {
      this.declineResourcePack('play', data);
      return;
    }
    if (name === 'system_chat' || name === 'chat' || name === 'player_chat') {
      this.stats.chatIn = (this.stats.chatIn || 0) + 1;
      return;
    }
    if (name === 'death_combat_event') {
      this.onEvent('death', { name: this.name });
      return;
    }
    if (name === 'start_configuration') {
      /* сервер может вернуть бота в конфигурацию: при смене мира или /reload */
      this.sendPacket('play', 'toServer', 'configuration_acknowledged', {});
      this.state = 'config';
      this.stopTimers();
      this.started = false;
      return;
    }
    if (name === 'select_known_packs') {
      this.sendKnownPacks('play');
      return;
    }
    if (name === 'set_compression') {
      const p = this.readField('play', name, data, ['threshold']);
      this.compression = Number(p.threshold) || 0;
    }
  }

  reasonText(reason) {
    if (reason === undefined || reason === null) return '';
    if (Buffer.isBuffer(reason)) return reason.toString('utf8').slice(0, 300);
    if (typeof reason === 'string') {
      const m = reason.match(/"text"\s*:\s*"([^"]*)"/) || reason.match(/"translate"\s*:\s*"([^"]*)"/);
      return (m ? m[1] : reason).slice(0, 300);
    }
    if (typeof reason === 'object') {
      if (typeof reason.text === 'string') return reason.text.slice(0, 300);
      if (reason.translate) return String(reason.translate).slice(0, 300);
    }
    return '';
  }

  hasConfigPhase() {
    const t = P.table(this.protocol);
    return !!(t && t.configuration);
  }

  sendClientSettings(section) {
    this.sendPacket(section, 'toServer', 'client_information', {
      locale: 'ru_ru',
      viewDistance: 8,
      chatFlags: 0,
      chatColors: true,
      skinParts: 0x7f,
      mainHand: 1,
      enableTextFiltering: false,
      enableServerListing: true,
      particleStatus: 'all',
    });
  }

  /** Список известных наборов данных (1.20.5+). Пустой список — сервер
      пришлёт реестры целиком, боту это и нужно, чтобы зайти на любой сервер. */
  sendKnownPacks(section) {
    const has = P.idOf(this.protocol, section, 'toServer', 'select_known_packs');
    if (has === null) return;
    this.sendPacket(section, 'toServer', 'select_known_packs', { packs: [] });
  }

  sendBrand(section) {
    this.sendPacket(section, 'toServer', 'custom_payload', {
      channel: 'minecraft:brand',
      data: (() => {
        const body = Buffer.from('OmniPanel', 'utf8');
        return Buffer.concat([writeVarInt(body.length), body]);
      })(),
    });
  }

  declineResourcePack(section, data) {
    const p = this.readField(section, 'add_resource_pack', data, ['uuid', 'hash']);
    this.sendPacket(section, 'toServer', 'resource_pack_receive', {
      uuid: p.uuid || '00000000-0000-0000-0000-000000000000',
      hash: p.hash || '',
      result: 1,            // 1 — отказ; боту ресурспаки не нужны
    });
  }

  enterPlay() {
    this.state = 'play';
    this.onEvent('play', { name: this.name, protocol: this.protocol });
    this.sendClientSettings('play');
    this.startActions();
  }

  fail(reason) {
    this.lastError = reason;
    this.onEvent('error', { name: this.name, error: reason });
    this.close();
  }

  /* ───────────── действия ───────────── */

  every(ms, fn) {
    if (!ms || ms <= 0) return;
    const timer = setInterval(() => {
      if (this.state !== 'play') return;
      try { fn(); } catch (err) { this.lastError = err.message; }
    }, ms);
    if (timer.unref) timer.unref();
    this.timers.push(timer);
  }

  startActions() {
    const a = this.actions;
    if (this.started) return;
    this.started = true;

    /* ходьба по кругу: постоянный поток движения */
    if (a.walk) {
      let angle = Math.random() * Math.PI * 2;
      this.every(Number(a.walkMs) || 50, () => {
        /* шаг за тик — как у настоящего игрока при спринте */
        angle += 0.06;
        this.pos.x += Math.cos(angle) * 0.28;
        this.pos.z += Math.sin(angle) * 0.28;
        this.pos.yaw = (angle * 180 / Math.PI) % 360;
        this.sendPosition(true);
      });
    }

    /* «прогрузка чанков»: редкие большие прыжки — сервер обязан выдать новые чанки */
    if (a.jump) {
      this.every(Number(a.jumpMs) || 3000, () => {
        this.pos.x += (Math.random() - 0.5) * 320;
        this.pos.z += (Math.random() - 0.5) * 320;
        this.stats.jumps += 1;
        this.sendPosition(false);
        this.onEvent('jump', { name: this.name, x: Math.round(this.pos.x), z: Math.round(this.pos.z) });
      });
    }

    /* спам в чат */
    if (a.chat) {
      const text = String(a.chatText || 'нагрузочный тест OmniPanel').slice(0, 240);
      this.every(Number(a.chatMs) || 1000, () => {
        if (this.sendChat(text)) this.stats.chat += 1;
      });
    }

    /* команды из списка — по кругу */
    if (a.cmd && Array.isArray(a.commands) && a.commands.length) {
      let i = 0;
      this.every(Number(a.cmdMs) || 1500, () => {
        const cmd = String(this.actions.commands[i % this.actions.commands.length]).replace(/^\//, '').trim();
        i += 1;
        if (!cmd) return;
        if (this.sendCommand(cmd)) this.stats.cmd += 1;
      });
    }

    /* взмахи рукой — дешёвый «живой» трафик */
    if (a.swing) {
      this.every(Number(a.swingMs) || 700, () => {
        this.sendPacket('play', 'toServer', 'arm_animation', { hand: 0 });
      });
    }
  }

  sendPosition(withLook) {
    this.stats.moves += 1;
    const values = {
      x: Number(this.pos.x.toFixed(4)),
      y: Number(this.pos.y.toFixed(4)),
      z: Number(this.pos.z.toFixed(4)),
      onGround: true,
      flags: { onGround: true },
    };
    if (withLook) {
      values.yaw = this.pos.yaw;
      values.pitch = this.pos.pitch;
      this.sendPacket('play', 'toServer', 'position_look', values);
    } else {
      this.sendPacket('play', 'toServer', 'position', values);
    }
  }

  sendChat(text) {
    const ok = this.sendPacket('play', 'toServer', 'chat_message', {
      message: text,
      timestamp: BigInt(Date.now()),
      salt: 0n,
      signature: null,
      offset: 0,
      acknowledged: Buffer.alloc(3),
      checksum: 0,
    });
    /* в 1.19+ неподписанный чат сервер может не принять — тогда шлём командой /msg себе */
    if (!ok) return false;
    return true;
  }

  sendCommand(cmd) {
    const clean = String(cmd).replace(/^\//, '');
    if (P.idOf(this.protocol, 'play', 'toServer', 'chat_command') !== null) {
      return this.sendPacket('play', 'toServer', 'chat_command', {
        command: clean,
        timestamp: BigInt(Date.now()),
        salt: 0n,
        argumentSignatures: [],
        messageCount: 0,
        acknowledged: Buffer.alloc(3),
      });
    }
    return this.sendPacket('play', 'toServer', 'chat_message', { message: '/' + clean, hash: '' });
  }

  stopTimers() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  close() {
    this.stopTimers();
    const sock = this.socket;
    this.socket = null;
    this.state = 'closed';
    if (sock && !sock.destroyed) sock.destroy();
  }

  get online() {
    return this.state === 'play';
  }

  get snapshot() {
    return {
      name: this.name,
      state: this.state,
      error: this.lastError,
      stats: {
        packetsIn: this.stats.packetsIn,
        packetsOut: this.stats.packetsOut,
        bytesIn: this.stats.bytesIn,
        bytesOut: this.stats.bytesOut,
        chunks: this.stats.chunks,
        chunksLoaded: this.stats.chunkSet.size,
        chat: this.stats.chat,
        cmd: this.stats.cmd,
        moves: this.stats.moves,
        jumps: this.stats.jumps,
      },
    };
  }
}

module.exports = { Bot, VERSION_PROTOCOL, nearestProtocol, offlineUuid, writeVarInt, readVarInt, protocols: P };
