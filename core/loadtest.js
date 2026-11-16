'use strict';
/**
 * Нагрузочный тест: запускает ботов на сервер и собирает, что при этом
 * происходит с сервером и с самими ботами.
 *
 * Задачи простые и честные:
 *  - поднять N ботов с разбегом (чтобы вход не выглядел как одна пачка);
 *  - включить им выбранные действия (ходьба, прыжки, чат, команды, взмахи);
 *  - раз в секунду снять показания: пакеты/с, байты/с, чанки, CPU, RAM, TPS;
 *  - показать это всё в панели и отдать итоговый отчёт.
 */
const { EventEmitter } = require('events');
const { Bot, nearestProtocol } = require('./bot');

const SAMPLE_MS = 1000;
const TIMELINE_LIMIT = 600;      // 10 минут по секунде
const MAX_BOTS = 200;
const RESPAWN_LIMIT = 3;

/** Настройки действий по умолчанию: всё выключено, пока не включили. */
function normalizeActions(raw) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const num = (v, def, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return def;
    return Math.max(min, Math.min(max, Math.round(n)));
  };
  const commands = Array.isArray(a.commands)
    ? a.commands.map((c) => String(c || '').replace(/^\//, '').trim()).filter(Boolean).slice(0, 40)
    : String(a.commands || '').split(/[\n,;]+/).map((c) => c.replace(/^\//, '').trim()).filter(Boolean).slice(0, 40);
  return {
    walk: !!a.walk,
    walkMs: num(a.walkMs, 50, 20, 5000),
    jump: !!a.jump,
    jumpMs: num(a.jumpMs, 3000, 500, 600000),
    spread: a.spread !== false,          // расходиться в разные стороны
    hop: a.hop !== false,                // подпрыгивать на ходу
    chat: !!a.chat,
    chatText: String(a.chatText || 'нагрузочный тест OmniPanel').slice(0, 240),
    chatMs: num(a.chatMs, 1000, 200, 600000),
    cmd: !!a.cmd && commands.length > 0,
    commands,
    cmdMs: num(a.cmdMs, 1500, 200, 600000),
    swing: !!a.swing,
    swingMs: num(a.swingMs, 700, 100, 600000),
  };
}

class LoadTest extends EventEmitter {
  /**
   * @param {object} opts
   * @param {function} opts.serverMetrics — () => {cpu, rss, tps} для своего сервера
   */
  constructor(opts = {}) {
    super();
    this.serverMetrics = typeof opts.serverMetrics === 'function' ? opts.serverMetrics : null;
    this.running = false;
    this.bots = [];              // { bot, slot, respawns, dead }
    this.timeline = [];
    this.startedAt = 0;
    this.finishedAt = 0;
    this.stopReason = '';
    this.cfg = null;
    this.prev = null;
    this.timer = null;
    this.spawnTimers = [];
    this.durationTimer = null;
    this.logs = [];
  }

  log(text) {
    const line = { t: Date.now(), text };
    this.logs.push(line);
    if (this.logs.length > 300) this.logs.shift();
    this.emit('log', line);
  }

  /* ───────────── запуск ───────────── */

  start(raw) {
    if (this.running) throw new Error('тест уже идёт');
    const cfg = {
      host: String(raw.host || '127.0.0.1'),
      port: Number(raw.port) || 25565,
      version: raw.version || '',
      protocol: Number(raw.protocol) || 0,
      count: Math.max(1, Math.min(MAX_BOTS, Number(raw.count) || 5)),
      rampMs: Math.max(0, Math.min(60000, Number(raw.rampMs) || 0)),
      durationMs: Math.max(0, Math.min(24 * 3600 * 1000, Number(raw.durationMs) || 0)),
      prefix: String(raw.prefix || 'Bot').replace(/[^A-Za-z0-9_]/g, '').slice(0, 10) || 'Bot',
      actions: normalizeActions(raw.actions),
      respawn: raw.respawn !== false,
      serverName: String(raw.serverName || ''),
    };
    if (!cfg.protocol) cfg.protocol = nearestProtocol(cfg.version);
    this.cfg = cfg;
    this.running = true;
    this.startedAt = Date.now();
    this.finishedAt = 0;
    this.stopReason = '';
    this.timeline = [];
    this.prev = null;
    this.logs = [];
    this.bots = [];

    const enabled = [];
    if (cfg.actions.walk) enabled.push('ходьба' + (cfg.actions.hop ? ' с прыжками' : ''));
    if (cfg.actions.jump) enabled.push('дальние походы (прогрузка чанков)');
    if (cfg.actions.spread) enabled.push('расходятся в стороны');
    if (cfg.actions.chat) enabled.push('спам в чат');
    if (cfg.actions.cmd) enabled.push(`команды (${cfg.actions.commands.join(', ')})`);
    if (cfg.actions.swing) enabled.push('взмахи');
    this.log(`${cfg.count} бот(ов) на ${cfg.host}:${cfg.port}, версия ${cfg.version || cfg.protocol}`);
    this.log(enabled.length ? `действия: ${enabled.join('; ')}` : 'действия выключены — боты просто стоят');

    for (let i = 0; i < cfg.count; i += 1) {
      const delay = cfg.rampMs ? Math.round((cfg.rampMs * i) / Math.max(1, cfg.count)) : 0;
      if (!delay) { this.spawn(i); continue; }
      const timer = setTimeout(() => this.spawn(i), delay);
      if (timer.unref) timer.unref();
      this.spawnTimers.push(timer);
    }

    /* первый замер сразу: иначе на очень коротком тесте график остаётся пустым */
    this.sample();
    this.timer = setInterval(() => this.sample(), SAMPLE_MS);
    if (this.timer.unref) this.timer.unref();

    if (cfg.durationMs > 0) {
      this.durationTimer = setTimeout(() => this.stop('время теста вышло'), cfg.durationMs);
      if (this.durationTimer.unref) this.durationTimer.unref();
    }
    this.emit('start', this.status());
    return this.status();
  }

  botName(i) {
    const n = String(i + 1).padStart(2, '0');
    return `${this.cfg.prefix}${n}`.slice(0, 16);
  }

  spawn(i) {
    if (!this.running) return;
    const name = this.botName(i);
    const slot = { slot: i, name, respawns: 0, bot: null, lastError: '' };
    const bot = new Bot({
      host: this.cfg.host,
      port: this.cfg.port,
      name,
      protocol: this.cfg.protocol,
      actions: this.cfg.actions,
      index: i,
      total: this.cfg.count,
      spread: this.cfg.actions.spread,
      hop: this.cfg.actions.hop,
      onEvent: (type, data) => this.botEvent(slot, type, data),
    });
    slot.bot = bot;
    this.bots[i] = slot;
    try {
      bot.connect();
    } catch (e) {
      slot.lastError = e.message;
      this.log(`${name}: не удалось подключиться — ${e.message}`);
    }
  }

  botEvent(slot, type, data) {
    const name = slot.name;
    if (type === 'error') {
      slot.lastError = data.error || 'ошибка';
      this.log(`${name}: ${slot.lastError}`);
      if (/онлайн-режим/.test(slot.lastError)) this.stop('сервер в онлайн-режиме: боты не зайдут');
      return;
    }
    if (type === 'corrected') {
      this.log(`${name}: сервер поправил позицию — бот подпрыгнул и сменил курс`);
      return;
    }
    if (type === 'kick') {
      slot.lastError = data.reason || 'кик';
      this.log(`${name}: отключён — ${slot.lastError}`);
      return;
    }
    if (type === 'play') {
      this.emit('change', this.status());
      return;
    }
    if (type === 'close') {
      const wasHealthy = data.was === 'play';
      if (this.running && this.cfg.respawn && slot.respawns < RESPAWN_LIMIT) {
        slot.respawns += 1;
        const t = setTimeout(() => {
          if (this.running) { slot.bot = null; this.spawn(slot.slot); }
        }, 2000 + slot.respawns * 1500);
        if (t.unref) t.unref();
        this.spawnTimers.push(t);
        this.log(`${name}: переподключаю (попытка ${slot.respawns} из ${RESPAWN_LIMIT})`);
      } else if (this.running) {
        this.log(`${name}: выбыл${slot.lastError ? ` — ${slot.lastError}` : ''}`);
      }
      void wasHealthy;
      this.emit('change', this.status());
    }
  }

  /* ───────────── показания ───────────── */

  totals() {
    const t = {
      bots: 0, online: 0, dead: 0,
      packetsIn: 0, packetsOut: 0, bytesIn: 0, bytesOut: 0,
      chunks: 0, chunksLoaded: 0, chat: 0, cmd: 0, moves: 0, jumps: 0, chatIn: 0,
      distance: 0, corrections: 0,
    };
    for (const slot of this.bots) {
      if (!slot || !slot.bot) continue;
      const s = slot.bot.stats;
      t.bots += 1;
      if (slot.bot.state === 'play') t.online += 1;
      else if (slot.bot.state === 'closed') t.dead += 1;
      t.packetsIn += s.packetsIn;
      t.packetsOut += s.packetsOut;
      t.bytesIn += s.bytesIn;
      t.bytesOut += s.bytesOut;
      t.chunks += s.chunks;
      t.chunksLoaded += s.chunkSet.size;
      t.chat += s.chat;
      t.cmd += s.cmd;
      t.moves += s.moves;
      t.jumps += s.jumps;
      t.distance += s.distance || 0;
      t.corrections += s.corrections || 0;
      t.chatIn += s.chatIn || 0;
    }
    return t;
  }

  async sample() {
    if (!this.running) return;
    const now = Date.now();
    const totals = this.totals();
    let server = null;
    if (this.serverMetrics) {
      try { server = await this.serverMetrics(); } catch { server = null; }
    }
    const dt = this.prev ? (now - this.prev.t) / 1000 : 0;
    const rate = (cur, before) => (dt > 0 && cur >= before ? Math.round((cur - before) / dt) : 0);
    const point = {
      t: now,
      online: totals.online,
      bots: totals.bots,
      packetsIn: totals.packetsIn,
      packetsOut: totals.packetsOut,
      ppsIn: rate(totals.packetsIn, this.prev ? this.prev.packetsIn : totals.packetsIn),
      ppsOut: rate(totals.packetsOut, this.prev ? this.prev.packetsOut : totals.packetsOut),
      kbpsIn: rate(totals.bytesIn, this.prev ? this.prev.bytesIn : totals.bytesIn) / 1024,
      kbpsOut: rate(totals.bytesOut, this.prev ? this.prev.bytesOut : totals.bytesOut) / 1024,
      chunksLoaded: totals.chunksLoaded,
      cpu: server && server.cpu != null ? server.cpu : null,
      rss: server && server.rss ? server.rss : null,
      tps: server && server.tps != null ? server.tps : null,
    };
    this.timeline.push(point);
    if (this.timeline.length > TIMELINE_LIMIT) this.timeline.shift();
    this.prev = { t: now, packetsIn: totals.packetsIn, packetsOut: totals.packetsOut, bytesIn: totals.bytesIn, bytesOut: totals.bytesOut };
    this.emit('sample', point);
    this.emit('change', this.status());
  }

  status() {
    const totals = this.totals();
    const last = this.timeline[this.timeline.length - 1] || null;
    return {
      running: this.running,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      elapsed: this.running ? Date.now() - this.startedAt : (this.finishedAt && this.startedAt ? this.finishedAt - this.startedAt : 0),
      stopReason: this.stopReason,
      cfg: this.cfg,
      totals,
      last,
      timeline: this.timeline.slice(-120),
      logs: this.logs.slice(-60),
      bots: this.bots.filter(Boolean).map((slot) => {
        const snap = slot.bot ? slot.bot.snapshot : { name: slot.name, state: 'closed', stats: null, error: slot.lastError };
        return { ...snap, slot: slot.slot, respawns: slot.respawns, error: snap.error || slot.lastError || '' };
      }),
    };
  }

  /* ───────────── остановка ───────────── */

  stop(reason = 'остановлено вручную') {
    if (!this.running) return this.status();
    this.running = false;
    this.stopReason = reason;
    this.finishedAt = Date.now();
    for (const t of this.spawnTimers) clearTimeout(t);
    this.spawnTimers = [];
    clearInterval(this.timer);
    this.timer = null;
    clearTimeout(this.durationTimer);
    this.durationTimer = null;
    for (const slot of this.bots) {
      if (slot && slot.bot) slot.bot.close();
    }
    this.log(`тест остановлен: ${reason}`);
    const report = this.report();
    this.emit('done', report);
    this.emit('change', this.status());
    return report;
  }

  /** Итог теста: что получилось в среднем и в пике. */
  report() {
    const tl = this.timeline;
    const peak = (key) => tl.reduce((m, p) => (p[key] != null && p[key] > m ? p[key] : m), 0);
    const low = (key) => tl.reduce((m, p) => (p[key] != null && (m === null || p[key] < m) ? p[key] : m), null);
    const avg = (key) => {
      const vals = tl.map((p) => p[key]).filter((v) => v != null);
      if (!vals.length) return null;
      return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
    };
    const totals = this.totals();
    const kickReasons = this.bots.filter(Boolean).map((s) => s.lastError).filter(Boolean);
    return {
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      durationSec: Math.round(((this.finishedAt || Date.now()) - this.startedAt) / 1000),
      stopReason: this.stopReason,
      server: this.cfg ? `${this.cfg.host}:${this.cfg.port}` : '',
      version: this.cfg ? (this.cfg.version || String(this.cfg.protocol)) : '',
      bots: this.cfg ? this.cfg.count : 0,
      online: totals.online,
      actions: this.cfg ? this.cfg.actions : null,
      avg: {
        cpu: avg('cpu'),
        tps: avg('tps'),
        rss: avg('rss'),
        ppsIn: avg('ppsIn'),
        ppsOut: avg('ppsOut'),
        kbpsIn: avg('kbpsIn'),
        kbpsOut: avg('kbpsOut'),
        online: avg('online'),
      },
      peak: {
        cpu: peak('cpu'),
        tps: peak('tps'),
        rss: peak('rss'),
        ppsIn: peak('ppsIn'),
        ppsOut: peak('ppsOut'),
        online: peak('online'),
      },
      low: { tps: low('tps'), cpu: low('cpu') },
      totals,
      errors: kickReasons.slice(0, 20),
      points: tl.length,
    };
  }
}

module.exports = { LoadTest, normalizeActions, MAX_BOTS };
