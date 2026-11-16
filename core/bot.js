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
const terrain = require('./terrain');

const MAX_BUF = 16 * 1024 * 1024;

/* ── физика движения ──
   Сервер (и особенно Paper) выкидывает бота за полёт, если тот «прыгает»
   по карте рывками, висит в воздухе или двигается быстрее игрока.
   Поэтому бот считает движение как настоящий клиент: 20 тиков в секунду,
   гравитация, прыжок с начальной скоростью 0.42, шаг не быстрее спринта. */
const TICK_MS = 50;               // 20 тиков в секунду — как у клиента игры
const GRAVITY = 0.08;             // на столько скорость падения растёт за тик
const JUMP_VY = 0.42;             // с такой скоростью игрок отталкивается от земли
const SPEED_WALK = 0.2158;        // блоков за тик — 4.32 блока/с
const SPEED_SPRINT = 0.2806;      // блоков за тик — 5.61 блока/с
const MAX_STEP = 0.32;            // выше этого сервер начинает ругаться «слишком быстро»

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
    /* физика: скорость, «пол» под ногами, курс и точка похода */
    this.vel = { y: 0 };
    this.groundY = null;        // высота, на которой бот стоит (сервер присылает её при входе)
    this.spawnPos = null;       // где бот появился — оттуда расходимся в стороны
    this.heading = 0;           // курс в радианах
    this.sector = null;         // свой сектор расхождения: 0…2π
    this.waypoint = null;       // дальняя точка похода (прогрузка чанков)
    this.ticks = 0;
    this.wantJump = false;
    this.stuckTicks = 0;
    this.pauseUntil = 0;
    this.recentFixes = [];
    this.collided = false;      // упёрлись в стену — сервер это учитывает при проверке движения
    this.pendingSync = true;
    this.teleportHold = 0;      // после телепорта сервер ждёт подтверждения —
                                // старое положение в это время слать нельзя
    this.heights = new Map();   // запомненные высоты поверхности: «клетка 2×2» → y
    this.terrain = new Map();   // рельеф из пакетов чанка: «чанк» → высоты 16×16
    this.minY = -64;            // низ мира (для разбора карты высот)
    this.probeAt = 0;           // когда в следующий раз проверять, есть ли под ногами опора
    this.escapeUntil = 0;       // до какого времени выходим из закутка по прямой
    this.detourUntil = 0;       // до какого времени обходим препятствие
    this.detourHeading = 0;     // курс обхода
    this.stuckCheckAt = 0;      // когда в последний раз проверяли, не застряли ли
    this.stuckFrom = null;      // откуда считаем пройденное расстояние
    this.probing = false;       // идёт проверка опоры (падаем и ждём ответа сервера)
    this.falling = false;       // земля ниже, чем мы думали: падаем до неё
    this.lastSentAt = 0;
    this.stepMs = TICK_MS;      // как часто шлём позицию
    this.index = Number(opts.index) || 0;
    this.total = Math.max(1, Number(opts.total) || 1);
    this.spread = opts.spread !== false;      // расходиться в разные стороны
    this.hop = opts.hop !== false;            // подпрыгивать на ходу
    this.spawned = false;
    this.playerLoaded = false;  // сообщили серверу, что мир загружен (1.21.4+)
    this.stats = {
      packetsIn: 0, packetsOut: 0, bytesIn: 0, bytesOut: 0,
      chunks: 0, chunkSet: new Set(), chat: 0, cmd: 0, moves: 0, jumps: 0,
      corrections: 0, distance: 0,
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

  /**
   * «Мир загружен» — с 1.21.4 сервер держит игрока в состоянии «ещё грузится»
   * и, если клиент не прислал player_loaded, каждые 3 секунды возвращает его
   * на точку появления. Именно из-за этого боты не могли уйти от спавна,
   * а сервер писал «moved too quickly». Отправляем один раз после первых чанков.
   */
  /** Запоминаем рельеф чанка: по нему бот знает, где земля, и не идёт по воздуху. */
  rememberTerrain(data) {
    const info = terrain.analyze(data, this.minY);
    if (!info) return;
    this.terrain.set(`${info.x}:${info.z}`, info.terrain);
    if (this.terrain.size > 4096) {
      /* старые чанки забываем — далеко они уже не нужны */
      const first = this.terrain.keys().next().value;
      this.terrain.delete(first);
    }
  }

  /** Высота поверхности (где стоят ноги) в точке; null — рельеф ещё неизвестен. */
  groundAt(x, z) {
    const cx = Math.floor(x / 16);
    const cz = Math.floor(z / 16);
    const chunk = this.terrain.get(`${cx}:${cz}`);
    if (!chunk) return null;
    const lx = Math.floor(x) - cx * 16;
    const lz = Math.floor(z) - cz * 16;
    return chunk[lz * 16 + lx];
  }

  reportTerrainLoaded() {
    if (this.playerLoaded) return;
    if (!this.spawned || this.stats.chunks < 8) return;
    if (P.idOf(this.protocol, 'play', 'toServer', 'player_loaded') === null) {
      this.playerLoaded = true;   // в этой версии такого пакета нет
      return;
    }
    this.playerLoaded = this.sendPacket('play', 'toServer', 'player_loaded', {});
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
      if (name === 'map_chunk') this.rememberTerrain(data);
      const p = this.readField('play', name, data, ['x', 'z']);
      this.stats.chunks += 1;
      if (p.x !== undefined && p.z !== undefined) this.stats.chunkSet.add(`${p.x}:${p.z}`);
      this.reportTerrainLoaded();
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
    if (name === 'position') {
      /* Только пакет положения самого игрока. sync_entity_position — это движение
         чужих сущностей (мобов, лодок): принимать его за «нас поправили» нельзя,
         иначе бота швыряет по всей карте. */
      const p = this.readField('play', name, data, ['x', 'y', 'z', 'dx', 'dy', 'dz', 'yaw', 'pitch', 'teleportId', 'flags']);
      if (p.x !== undefined) {
        const was = this.spawned;
        /* с 1.21.2 сервер может присылать не координаты, а СМЕЩЕНИЕ:
           биты в flags говорят, что именно относительное. Без этого бот
           «не соглашается» с телепортом, и сервер повторяет его каждый пакет. */
        const rel = p.flags && typeof p.flags === 'object' ? p.flags : {};
        const relX = !!rel.x;
        const relY = !!rel.y;
        const relZ = !!rel.z;
        const relYaw = !!rel.yaw;
        const relPitch = !!rel.pitch;
        if (relX) p.x = this.pos.x + Number(p.dx || 0);
        if (relY) p.y = this.pos.y + Number(p.dy || 0);
        if (relZ) p.z = this.pos.z + Number(p.dz || 0);
        if (relYaw) p.yaw = this.pos.yaw + Number(p.yaw || 0);
        if (relPitch) p.pitch = this.pos.pitch + Number(p.pitch || 0);
        const dx = Number(p.x) - this.pos.x;
        const dy = Number(p.y) - this.pos.y;
        const dz = Number(p.z) - this.pos.z;
        const moved = Math.hypot(dx, dz);
        this.pos.x = Number(p.x);
        this.pos.y = Number(p.y);
        this.pos.z = Number(p.z);
        this.pos.yaw = Number(p.yaw) || this.pos.yaw || 0;
        this.pos.pitch = Number(p.pitch) || 0;
        /* сервер знает мир лучше нас: его высота — это и есть земля под ногами */
        this.groundY = this.pos.y;
        this.vel.y = 0;
        this.pos.onGround = true;
        if (!was) {
          this.spawnPos = { x: this.pos.x, y: this.pos.y, z: this.pos.z };
        } else if (moved > 0.05 || Math.abs(dy) > 0.05) {
          /* сервер не согласился с движением: ступенька, стена или провал.
             Любая такая правка уточняет высоту поверхности в этой клетке. */
          this.stats.corrections += 1;
          this.heights.set(this.cellKey(this.pos.x, this.pos.z), this.pos.y);
          this.probing = false;
          this.falling = false;
          this.groundY = this.pos.y;
          const nowFix = Date.now();
          this.recentSmall = (this.recentSmall || []).filter((t) => nowFix - t < 1600);
          if (moved <= 0.7 && Math.abs(dy) <= 1.3 && this.recentSmall.length === 0) {
            /* первая мелкая правка — скорее всего ступенька: шагаем дальше тем же курсом */
            this.recentSmall.push(nowFix);
            this.stepUp = dy > 0.05;
            this.probeAt = nowFix + 1500;
          } else {
            /* мелкая правка повторилась на том же месте — это стена, а не ступенька.
               Настоящий игрок в таком случае останавливается и обходит. */
            this.recentSmall.push(nowFix);
            this.onCorrected();
          }
        }
      }
      if (p.teleportId !== undefined) {
        /* Телепорт от сервера. Пока сервер ждёт подтверждения, он сверяет наше
           положение с целью ТОЧНО (до последнего знака), а любой шаг в сторону
           считает «moved too quickly» и телепортирует снова — так бот никогда не
           сдвигался с места. Поэтому: подтверждаем, отвечаем ровно той же
           координатой (без округления) и замираем на четверть секунды. */
        this.teleportHold = Date.now() + 300;
        this.pauseUntil = Math.max(this.pauseUntil || 0, this.teleportHold);
        this.recentFixes = [];
        this.vel.y = 0;
        this.probing = false;
        this.falling = false;
        this.sendPacket('play', 'toServer', 'teleport_confirm', { teleportId: p.teleportId });
        this.sendRawPosition(p.x, p.y, p.z, this.pos.yaw, this.pos.pitch);
      }
      if (!this.spawned) {
        this.spawned = true;
        this.onEvent('spawn', { name: this.name, x: this.pos.x, y: this.pos.y, z: this.pos.z });
      }
      return;
    }
    if (name === 'login') {
      /* «вход в мир». Позицию до первого пакета положения не шлём:
         мы ещё не знаем, куда сервер поставил бота, — иначе он ругается
         «moved too quickly» на ровном месте. */
      this.pendingSync = false;
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

  /* ───────────── действия и движение ───────────── */

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

    /* куда бот пойдёт: свой сектор круга, чтобы толпа расходилась в стороны */
    this.sector = (Math.PI * 2 * (this.index % this.total)) / this.total
      + (Math.random() - 0.5) * ((Math.PI * 2) / this.total) * 0.6;
    this.heading = this.sector;

    /* один тик движения на всё: 20 раз в секунду, как у настоящего клиента */
    this.stepMs = Math.max(TICK_MS, Math.min(2000, Number(a.walkMs) || TICK_MS));
    this.every(TICK_MS, () => this.physicsTick());

    /* дальние походы: цель выбираем один раз и идём к ней, пока не дойдём.
       Раньше цель менялась по таймеру — бот не успевал её достичь и топтался
       на месте, разворачиваясь вслед за новой точкой. */
    if (a.jump) {
      this.pickWaypoint();
      this.every(Number(a.jumpMs) || 3000, () => { if (!this.waypoint) this.pickWaypoint(); });
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
        const cmd = String(this.actions.commands[i % this.actions.commands.length]).replace(/^\/+/, '').trim();
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

  /**
   * Один тик движения: курс, шаг, гравитация, прыжок, отправка позиции.
   * Всё считается как у настоящего игрока, поэтому сервер не видит полёта.
   */
  physicsTick() {
    const a = this.actions;
    if (this.state !== 'play' || !this.spawned) return;
    this.ticks += 1;
    const now = Date.now();
    if (this.teleportHold && now < this.teleportHold) {
      /* сервер ещё сверяет наше место после телепорта: стоим как вкопанные */
      this.lastSentAt = now;
      return;
    }
    if (!this.playerLoaded) {
      /* Мир ещё не «загрузился» (как экран загрузки у игрока): не двигаемся.
         Всё, что бот отправит до player_loaded, сервер не засчитывает — а потом
         видит скачок на десяток блоков и пишет «moved too quickly». */
      this.lastSentAt = now;
      return;
    }
    const paused = this.pauseUntil && now < this.pauseUntil;
    const walking = !!(a.walk || a.jump) && !paused;
    const sprint = !!a.jump && !!this.waypoint;   // в дальний поход — бегом

    if (walking) {
      if (this.detourUntil && now < this.detourUntil) {
        /* идём в обход препятствия, не поворачивая обратно к цели */
        this.heading = this.detourHeading + (Math.random() - 0.5) * 0.02;
      } else if (this.escapeUntil && now < this.escapeUntil) {
        /* выходим из закутка: идём прямо, не петляя */
        this.heading += (Math.random() - 0.5) * 0.004;
      } else if (a.jump && this.waypoint) {
        this.steerToWaypoint();
      } else {
        this.wander();
      }

      /* высота поверхности в этой клетке: если сервер её уже показывал — идём по ней */
      /* смотрим и на шаг вперёд, и дальше: препятствие бывает прямо под носом */
      const aheadX = this.pos.x + Math.cos(this.heading) * 0.9;
      const aheadZ = this.pos.z + Math.sin(this.heading) * 0.9;
      const nearX = this.pos.x + Math.cos(this.heading) * 0.35;
      const nearZ = this.pos.z + Math.sin(this.heading) * 0.35;
      const near = this.groundAt(nearX, nearZ);
      const fromMap = this.groundAt(aheadX, aheadZ);
      const far = fromMap === null ? this.heights.get(this.cellKey(aheadX, aheadZ)) : fromMap;
      const known = near === null ? far : (far === null || far === undefined ? near : Math.max(near, far));
      if (known !== undefined && !this.probing) {
        if (known - this.pos.y > 1.05) {
          /* выше, чем можно запрыгнуть — обходим. Обход держим пару секунд,
             иначе бот тут же разворачивается назад к цели и топчется у стены */
          this.detourHeading = this.heading + Math.PI * (0.4 + Math.random() * 0.4)
            * (Math.random() < 0.5 ? 1 : -1);
          this.detourUntil = now + 900 + Math.random() * 900;
          this.probeAt = now + 1200;
        } else if (known < this.pos.y - 0.05) {
          /* впереди ниже: не телепортируемся вниз, а падаем по-настоящему —
             резкий скачок высоты сервер принимает за «moved too quickly» */
          this.groundY = known;
          if (this.pos.onGround) {
            this.pos.onGround = false;
            this.vel.y = 0;
            this.falling = false;
          }
        } else if (known > this.pos.y + 0.05 && this.pos.onGround) {
          /* впереди выше на блок — запрыгиваем, как игрок, и дальше идём по новой высоте */
          this.wantJump = true;
          this.groundY = known;
        }
      }

      const speed = Math.min(MAX_STEP, sprint ? SPEED_SPRINT : SPEED_WALK);
      this.pos.x += Math.cos(this.heading) * speed;
      this.pos.z += Math.sin(this.heading) * speed;
      this.pos.yaw = ((this.heading * 180) / Math.PI + 90) % 360;
      this.stats.distance += speed;

      /* Опора под ногами: если рельеф этой клетки уже известен из чанка — никаких
         проверок не нужно, сервер и так видит твёрдый блок. Проверяем только там,
         где рельеф неизвестен: иначе бот без нужды «прыгает в пустоту», и сервер
         считает его висящим в воздухе. */
      const haveTerrain = this.groundAt(this.pos.x, this.pos.z) !== null;
      if (!haveTerrain && this.pos.onGround && !this.probing && now >= this.probeAt) {
        this.probing = true;
        this.probeStartY = this.pos.y;
        this.pos.onGround = false;
        this.vel.y = 0;
        this.probeAt = now + 1800 + Math.random() * 1200;
      }

      /* Застряли? Если за пять секунд почти не сдвинулись с места — значит упёрлись
       в угол или ходим по кругу. Настоящий игрок в такой ситуации разворачивается. */
    if (walking && now >= this.stuckCheckAt) {
      if (!this.stuckFrom) {
        this.stuckFrom = { x: this.pos.x, z: this.pos.z, at: now };
        this.stuckCheckAt = now + 5000;
      } else if (Math.hypot(this.pos.x - this.stuckFrom.x, this.pos.z - this.stuckFrom.z) < 2) {
        this.heading += Math.PI * (0.5 + Math.random());
        this.escapeUntil = now + 1500;
        this.pauseUntil = Math.max(this.pauseUntil || 0, now + 300);
        if (this.waypoint) this.pickWaypoint();
        this.stuckFrom = { x: this.pos.x, z: this.pos.z, at: now };
        this.stuckCheckAt = now + 5000;
      } else {
        this.stuckFrom = { x: this.pos.x, z: this.pos.z, at: now };
        this.stuckCheckAt = now + 5000;
      }
    }

    /* прыжки на ходу: изредка, как настоящий игрок (и заодно проверка опоры) */
      const fixesRecently = this.recentFixes && this.recentFixes.some((t) => now - t < 3000);
      if (this.hop && this.pos.onGround && !fixesRecently && !this.probing) {
        const chance = sprint ? 0.014 : 0.006;
        if (Math.random() < chance) this.wantJump = true;
      }
    }

    /* прыжок: только стоя на земле, с настоящей скоростью отталкивания */
    if (this.wantJump && this.pos.onGround) {
      this.vel.y = JUMP_VY;
      this.pos.onGround = false;
      this.wantJump = false;
      this.probing = false;
      this.stats.jumps += 1;
      this.onEvent('jump', { name: this.name, x: Math.round(this.pos.x), z: Math.round(this.pos.z) });
    }

    /* гравитация: настоящее падение вниз — сервер такое принимает,
       в отличие от висения в воздухе, за которое он и кикает */
    if (!this.pos.onGround || this.vel.y !== 0) {
      /* порядок как в игре: сначала шаг по текущей скорости, затем гравитация и трение */
      this.pos.y += this.vel.y;
      this.vel.y = (this.vel.y - GRAVITY) * 0.98;
      const ground = this.groundY === null ? this.pos.y : this.groundY;
      if (!this.falling && this.pos.y <= ground) {
        /* приземлились на известную высоту */
        this.pos.y = ground;
        this.vel.y = 0;
        this.pos.onGround = true;
        if (this.probing) {
          /* опора оказалась на месте — проверка закончена */
          this.probing = false;
          this.heights.set(this.cellKey(this.pos.x, this.pos.z), this.pos.y);
        }
      } else {
        this.pos.onGround = false;
        if (this.probing && this.probeStartY - this.pos.y > 0.5) {
          /* под известной высотой ничего нет: земля ниже — падаем до неё,
             пока сервер своей правкой не скажет, где поверхность */
          this.probing = false;
          this.falling = true;
        }
      }
    } else {
      /* стоим на земле: подтягиваем высоту только на ступеньку, а не на пропасть */
      if (this.groundY === null) {
        this.pos.onGround = true;
      } else if (Math.abs(this.groundY - this.pos.y) <= 0.6) {
        this.pos.y = this.groundY;
        this.pos.onGround = true;
      } else {
        /* земля сильно ниже — надо падать, а не мгновенно оказываться внизу */
        this.pos.onGround = false;
        this.vel.y = 0;
      }
    }

    /* шлём позицию не чаще выбранного шага; стоя на месте — раз в секунду,
       чтобы не забивать канал пустыми пакетами */
    const active = walking || !this.pos.onGround || this.pendingSync;
    const interval = active ? this.stepMs : 1000;
    if (!this.lastSentAt || now - this.lastSentAt >= interval) {
      this.lastSentAt = now;
      this.collided = false;
      this.pendingSync = false;
      this.sendPosition(true);
    }
  }

  /** Ключ клетки 2×2 блока — по нему запоминаем высоту поверхности. */
  cellKey(x, z) {
    return `${Math.floor(x / 2)}:${Math.floor(z / 2)}`;
  }

  /** Спокойная ходьба: курс медленно гуляет внутри своего сектора. */
  wander() {
    this.heading += (Math.random() - 0.5) * 0.02;
    if (!this.spread) return;
    /* если бот ушёл из своего сектора — плавно возвращаем курс */
    const diff = ((this.sector - this.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    if (Math.abs(diff) > 0.9) this.heading += Math.sign(diff) * 0.02;
  }

  /** Дальняя точка похода: свой сектор, расстояние 120–380 блоков. */
  pickWaypoint() {
    const from = this.spawnPos || { x: this.pos.x, z: this.pos.z };
    const dir = this.spread
      ? this.sector + (Math.random() - 0.5) * 0.5
      : Math.random() * Math.PI * 2;
    const dist = 120 + Math.random() * 260;
    this.waypoint = {
      x: from.x + Math.cos(dir) * dist,
      z: from.z + Math.sin(dir) * dist,
    };
  }

  /** Курс на выбранную точку; дошли — берём следующую. */
  steerToWaypoint() {
    const w = this.waypoint;
    if (!w) return;
    const dx = w.x - this.pos.x;
    const dz = w.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 8) { this.pickWaypoint(); return; }
    const want = Math.atan2(dz, dx);
    let diff = ((want - this.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    /* поворачиваем плавно, не «телепортом» курса */
    this.heading += Math.max(-0.25, Math.min(0.25, diff));
  }

  /**
   * Сервер поправил позицию: значит, бот куда-то влез или провалился.
   * Подпрыгиваем и меняем курс, как поступил бы игрок.
   */
  /**
   * Сервер не согласился с движением: впереди блок, обрыв или бот провалился.
   *
   * Главное правило — не долбиться в стену. Настоящий игрок в такой ситуации
   * останавливается и обходит, а бот, который продолжает шагать и прыгать в
   * стену, получает от сервера «floating too long» и кик за полёт.
   * Поэтому: разворот в сторону, короткая остановка (стоим как обычный игрок,
   * без прыжков), потом идём в новом направлении.
   */
  onCorrected() {
    const now = Date.now();
    this.collided = true;
    this.pendingSync = true;
    this.recentFixes = (this.recentFixes || []).filter((t) => now - t < 3000);
    this.recentFixes.push(now);

    if (this.recentFixes.length >= 3) {
      /* колбасит: три правки за три секунды — разворачиваемся и уходим прочь,
         откуда пришли. Там точно было свободно. */
      this.pauseUntil = now + 1200;
      this.heading += Math.PI * (0.85 + Math.random() * 0.3);
      this.escapeUntil = now + 3000;
      this.recentFixes = [];
    } else {
      /* одна правка — короткая заминка и небольшой поворот: цель не теряем */
      this.pauseUntil = Math.max(this.pauseUntil || 0, now + 150);
      this.heading += Math.PI * (0.15 + Math.random() * 0.25) * (Math.random() < 0.5 ? 1 : -1);
      if (!this.escapeUntil || this.escapeUntil < now) this.escapeUntil = now + 1200;
    }
    /* прыгать в застрявшем состоянии нельзя — именно из-за этого кикало */
    this.stuckTicks = 0;
    this.wantJump = false;
    if (this.waypoint) this.pickWaypoint();
    if (this.stats.corrections === 1) {
      this.onEvent('corrected', { name: this.name, x: Math.round(this.pos.x), z: Math.round(this.pos.z) });
    }
  }

  /** Позиция «как есть», без округления — так отвечают на телепорт. */
  sendRawPosition(x, y, z, yaw, pitch) {
    this.stats.moves += 1;
    this.sendPacket('play', 'toServer', 'position_look', {
      x: Number(x), y: Number(y), z: Number(z),
      onGround: true,
      flags: { onGround: true, hasHorizontalCollision: false },
      yaw: Number(yaw) || 0,
      pitch: Number(pitch) || 0,
    });
  }

  sendPosition(withLook) {
    this.stats.moves += 1;
    const values = {
      x: Number(this.pos.x.toFixed(4)),
      y: Number(this.pos.y.toFixed(4)),
      z: Number(this.pos.z.toFixed(4)),
      onGround: !!this.pos.onGround,
      flags: { onGround: !!this.pos.onGround, hasHorizontalCollision: !!this.collided },
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
