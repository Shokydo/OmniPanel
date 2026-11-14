'use strict';
/**
 * Ядро панели: управление локальными процессами (серверами).
 * Не зависит от Electron — используется и в оконном, и в браузерном режиме.
 */
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');
const { decodeSingleByte, detectEncoding, repairMojibake } = require('./encodings');
const metrics = require('./metrics');

const MAX_LOG_LINES = 4000;   // сколько строк лога держим в памяти на сервер
const DEFAULT_STOP_TIMEOUT = 15000;
const RESTART_DELAY = 3000;
const TPS_HISTORY = 60;          // точек для мини-графика в шапке
const TPS_FULL_LIMIT = 8640;      // полная история: 24 часа при опросе раз в 10 с
const METRICS_INTERVAL = 2000;

class ServerManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {Array}  opts.servers  массив конфигов серверов
   * @param {Function} opts.save   функция сохранения конфигов (опционально)
   */
  constructor({ servers = [], save = null, tpsStore = null } = {}) {
    super();
    this.servers = servers;
    this.save = save;
    this.tpsStore = tpsStore; // { load(id), save(id, points) }
    this.rt = new Map();      // id -> runtime
    this._metricsTimer = null;
    this._startMetrics();
  }

  /* -------------------------- сбор метрик --------------------------- */

  _startMetrics() {
    clearInterval(this._metricsTimer);
    this._metricsTimer = setInterval(async () => {
      if (this._metricsBusy) return; // не запускаем второй замер, пока идёт первый
      const targets = this.servers
        .map((s) => ({ id: s.id, pid: this._rt(s.id).pid }))
        .filter((t) => t.pid);
      if (!targets.length) return;

      let result;
      this._metricsBusy = true;
      try {
        result = await metrics.collect(targets);
      } catch {
        this._metricsBusy = false;
        return;
      }
      this._metricsBusy = false;
      for (const [id, m] of result) {
        const r = this._rt(id);
        if (r.state !== 'running') continue;
        r.metrics = {
          cpu: m.cpu,
          rss: m.rss,
          procs: m.procs,
          history: [...(r.metrics?.history || []), { t: Date.now(), cpu: m.cpu, rss: m.rss }].slice(-180),
        };
        this.emit('metrics', { id, ...r.metrics });
      }
    }, METRICS_INTERVAL);
    if (this._metricsTimer.unref) this._metricsTimer.unref();
  }

  stopMetrics() {
    clearInterval(this._metricsTimer);
    this._metricsTimer = null;
  }

  /* ------------------------ история TPS ----------------------------- */

  tpsHistory(id) {
    const r = this._rt(id);
    if (!r.tpsFull) {
      r.tpsFull = [];
      if (this.tpsStore) {
        try {
          const saved = this.tpsStore.load(id);
          if (Array.isArray(saved)) r.tpsFull = saved.slice(-TPS_FULL_LIMIT);
        } catch { /* ignore */ }
      }
    }
    return r.tpsFull;
  }

  clearTpsHistory(id) {
    const r = this._rt(id);
    r.tpsFull = [];
    r.tpsHistory = [];
    r.tps = null;
    if (this.tpsStore) {
      try { this.tpsStore.save(id, []); } catch { /* ignore */ }
    }
    this.emit('tps', { id, tps: null, history: [] });
    return true;
  }

  _persistTps(id) {
    if (!this.tpsStore || !this.rt.has(id)) return;
    const r = this._rt(id);
    clearTimeout(r.tpsSaveTimer);
    r.tpsSaveTimer = setTimeout(() => {
      try { this.tpsStore.save(id, r.tpsFull || []); } catch { /* ignore */ }
    }, 3000);
  }

  /* ----------------------------- конфиги ----------------------------- */

  get(id) {
    return this.servers.find((s) => s.id === id);
  }

  list() {
    return this.servers.map((s) => ({ ...s, ...this.status(s.id) }));
  }

  add(server) {
    const s = {
      id: server.id || require('crypto').randomUUID(),
      name: (server.name || 'Новый сервер').trim(),
      command: (server.command || '').trim(),
      cwd: (server.cwd || '').trim(),
      stopCommand: server.stopCommand ?? '',
      autoRestart: !!server.autoRestart,
      autoStart: !!server.autoStart,
      env: server.env || {},
      icon: server.icon || '',
      encoding: server.encoding || 'auto',
      tpsCommand: server.tpsCommand ?? '',
      tpsInterval: Number(server.tpsInterval) > 0 ? Number(server.tpsInterval) : 30,
    };
    this.servers.push(s);
    this._persist();
    return s;
  }

  update(id, patch) {
    const s = this.get(id);
    if (!s) throw new Error('Сервер не найден');
    Object.assign(s, patch, { id: s.id });
    this._persist();
    this.emit('servers', this.list());
    return s;
  }

  remove(id) {
    const s = this.get(id);
    if (!s) return false;
    const state = this.status(id).state;
    if (state !== 'stopped') this.kill(id);
    this.servers = this.servers.filter((x) => x.id !== id);
    const r = this.rt.get(id);
    if (r) { clearInterval(r.tpsTimer); clearTimeout(r.tpsSaveTimer); }
    metrics.forget(id);
    this.rt.delete(id);
    this._persist();
    this.emit('servers', this.list());
    return true;
  }

  reorder(ids) {
    const map = new Map(this.servers.map((s) => [s.id, s]));
    const next = ids.map((id) => map.get(id)).filter(Boolean);
    for (const s of this.servers) if (!ids.includes(s.id)) next.push(s);
    this.servers = next;
    this._persist();
    this.emit('servers', this.list());
  }

  _persist() {
    if (typeof this.save === 'function') {
      try { this.save(this.servers); } catch (e) { /* ignore */ }
    }
  }

  /* ----------------------------- runtime ----------------------------- */

  _rt(id) {
    if (!this.rt.has(id)) {
      this.rt.set(id, {
        state: 'stopped',
        pid: null,
        startedAt: null,
        exitCode: null,
        proc: null,
        logs: [],
        stopTimer: null,
        restartTimer: null,
        tpsTimer: null,
        tpsFirstTimer: null,
        tpsPendingUntil: 0,
        tps: null,
        tpsHistory: [],
        stopping: false,
        manualStop: false,
        enc: null,        // определённая кодировка вывода
        decoder: null,    // StringDecoder для utf8
        probe: null,      // буфер для определения кодировки
      });
    }
    return this.rt.get(id);
  }

  status(id) {
    const r = this._rt(id);
    return {
      state: r.state,
      pid: r.pid,
      startedAt: r.startedAt,
      exitCode: r.exitCode,
      uptime: r.state === 'running' && r.startedAt ? Date.now() - r.startedAt : 0,
      encoding: r.enc,
      tps: r.tps,
      tpsHistory: r.tpsHistory.slice(-TPS_HISTORY),
      metrics: r.metrics
        ? { cpu: r.metrics.cpu, rss: r.metrics.rss, procs: r.metrics.procs, history: (r.metrics.history || []).slice(-180) }
        : null,
    };
  }

  logs(id) {
    return this._rt(id).logs.slice();
  }

  clearLogs(id) {
    this._rt(id).logs = [];
    this.emit('logs-cleared', { id });
  }

  _setState(id, state, extra = {}) {
    const r = this._rt(id);
    r.state = state;
    Object.assign(r, extra);
    this.emit('state', { id, ...this.status(id) });
  }

  _log(id, stream, message) {
    const r = this._rt(id);
    // разбиваем многострочные куски на отдельные строки
    for (const line of String(message).split(/\r\n|\n|\r/)) {
      if (line === '') continue;
      const e = { t: Date.now(), s: stream, m: line };
      r.logs.push(e);
      if (r.logs.length > MAX_LOG_LINES) r.logs.splice(0, r.logs.length - MAX_LOG_LINES);
      this.emit('log', { id, entry: e });
    }
  }

  /* --------------------- декодирование вывода ------------------------ */

  _decode(r, srv, buf) {
    const forced = srv.encoding && srv.encoding !== 'auto' ? srv.encoding : null;

    if (forced && forced !== 'utf8') return repairMojibake(decodeSingleByte(buf, forced));

    if (forced === 'utf8' || r.enc === 'utf8') {
      if (!r.decoder) r.decoder = new StringDecoder('utf8');
      return r.decoder.write(buf);
    }
    if (r.enc) return repairMojibake(decodeSingleByte(buf, r.enc));

    // кодировка ещё не определена: копим буфер до первого не-ASCII байта
    r.probe = r.probe ? Buffer.concat([r.probe, buf]) : buf;
    const hasHigh = r.probe.some((b) => b > 0x7f);

    if (hasHigh || r.probe.length > 8192) {
      r.enc = detectEncoding(r.probe);
      const text = r.enc === 'utf8' ? r.probe.toString('utf8') : decodeSingleByte(r.probe, r.enc);
      r.probe = null;
      if (r.enc === 'utf8') r.decoder = new StringDecoder('utf8');
      if (r.enc !== 'utf8') this._log(srv.id, 'system', `Кодировка вывода определена как ${r.enc.toUpperCase()} — кириллица должна отображаться нормально`);
      return repairMojibake(text);
    }

    const text = r.probe.toString('latin1');
    r.probe = null;
    return text;
  }

  /* --------------------------- TPS монитор --------------------------- */

  _parseTps(line) {
    let m;
    // Paper / Spigot: "TPS from last 1m, 5m, 15m: 20.0, 20.0, 20.0"
    m = line.match(/TPS from last[^:]*:\s*\*?([\d]+[.,]?[\d]*)/i);
    if (m) return Number(m[1].replace(',', '.'));
    // Forge / NeoForge: "Overall: 20.000 mean tick time: 0.123 ms. Mean TPS: 20.000"
    m = line.match(/Mean TPS:\s*([\d]+[.,]?[\d]*)/i);
    if (m) return Number(m[1].replace(',', '.'));
    // Forge (старый): "Dim minecraft:overworld (minecraft:overworld): 20.000 TPS"
    m = line.match(/:\s*([\d]+[.,][\d]+)\s*TPS/i);
    if (m) return Number(m[1].replace(',', '.'));
    // "Overall : Mean tick time: 0.123 ms. Mean TPS: 20.000"
    m = line.match(/Overall\s*:\s*([\d]+[.,]?[\d]*)/i);
    if (m) return Number(m[1].replace(',', '.'));
    return null;
  }

  _pushTps(id, value) {
    const r = this._rt(id);
    if (!Number.isFinite(value) || value <= 0 || value > 1000) return;
    r.tps = Math.round(value * 10) / 10;
    const point = { t: Date.now(), v: r.tps };
    r.tpsHistory.push(point);
    if (r.tpsHistory.length > TPS_HISTORY) r.tpsHistory.splice(0, r.tpsHistory.length - TPS_HISTORY);

    const full = this.tpsHistory(id);
    full.push(point);
    if (full.length > TPS_FULL_LIMIT) full.splice(0, full.length - TPS_FULL_LIMIT);
    this._persistTps(id);

    this.emit('tps', { id, tps: r.tps, history: r.tpsHistory.slice(-TPS_HISTORY), fullCount: full.length });
  }

  _startTpsPolling(id) {
    const srv = this.get(id);
    const r = this._rt(id);
    clearInterval(r.tpsTimer);
    clearTimeout(r.tpsFirstTimer);
    if (!srv || !(srv.tpsCommand || '').trim()) return;

    const interval = (Number(srv.tpsInterval) > 0 ? Number(srv.tpsInterval) : 30) * 1000;
    const ask = () => {
      if (this._rt(id).state !== 'running') return;
      r.tpsPendingUntil = Date.now() + 5000;
      this.sendCommand(id, srv.tpsCommand, { silent: true });
    };
    // первый замер — когда сервер уже прогрелся
    r.tpsFirstTimer = setTimeout(ask, Math.min(15000, interval));
    r.tpsTimer = setInterval(ask, interval);
  }

  _stopTpsPolling(id) {
    const r = this._rt(id);
    clearInterval(r.tpsTimer);
    clearTimeout(r.tpsFirstTimer);
    r.tpsTimer = null;
    r.tpsFirstTimer = null;
    r.tpsPendingUntil = 0;
  }

  /* ----------------------------- действия ---------------------------- */

  start(id) {
    const srv = this.get(id);
    if (!srv) throw new Error('Сервер не найден');
    const r = this._rt(id);
    if (r.state === 'running' || r.state === 'starting') return this.status(id);
    if (!srv.command) {
      this._log(id, 'system', 'Команда запуска не задана — открой настройки сервера.');
      return this.status(id);
    }

    clearTimeout(r.restartTimer);
    r.manualStop = false;
    r.stopping = false;
    r.exitCode = null;
    r.enc = null;
    r.decoder = null;
    r.probe = null;
    r.tps = null;
    r.tpsHistory = [];
    r.metrics = null;
    metrics.forget(id);

    const opts = {
      cwd: srv.cwd && srv.cwd.trim() ? srv.cwd : process.cwd(),
      shell: true,
      env: { ...process.env, ...(srv.env || {}), PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
      // на Unix создаём свою группу процессов, чтобы kill гасил всё дерево;
      // на Windows дерево гасит taskkill /T
      detached: process.platform !== 'win32',
    };

    this._log(id, 'system', `Запуск: ${srv.command}`);
    this._log(id, 'system', `  Рабочая папка: ${opts.cwd}`);

    let proc;
    try {
      proc = spawn(srv.command, [], opts);
    } catch (err) {
      this._log(id, 'stderr', `Ошибка запуска: ${err.message}`);
      this._setState(id, 'stopped', { pid: null, startedAt: null, proc: null });
      return this.status(id);
    }

    r.proc = proc;
    r.pid = proc.pid;
    r.startedAt = Date.now();
    this._setState(id, 'running', { pid: proc.pid, startedAt: r.startedAt });

    if (proc.stdout) {
      proc.stdout.on('data', (d) => this._onOutput(id, srv, 'stdout', d));
    }
    if (proc.stderr) {
      proc.stderr.on('data', (d) => this._onOutput(id, srv, 'stderr', d));
    }

    proc.on('error', (err) => {
      this._log(id, 'stderr', `Ошибка процесса: ${err.message}`);
    });

    proc.on('exit', (code, signal) => {
      clearTimeout(r.stopTimer);
      const wasStopping = r.stopping;
      r.proc = null;
      r.pid = null;
      r.stopping = false;
      r.exitCode = code;
      this._stopTpsPolling(id);
      r.metrics = null;
      metrics.forget(id);
      this._log(id, 'system', `Процесс завершён (код: ${code ?? '—'}${signal ? `, сигнал: ${signal}` : ''})`);
      this._setState(id, 'stopped', { pid: null, startedAt: null });

      const s = this.get(id);
      if (!s) return;
      if (!r.manualStop && s.autoRestart && !wasStopping) {
        this._log(id, 'system', `Автоперезапуск через ${RESTART_DELAY / 1000} с…`);
        r.restartTimer = setTimeout(() => {
          if (this.get(id)) this.start(id);
        }, RESTART_DELAY);
      }
    });

    this._startTpsPolling(id);
    return this.status(id);
  }

  _onOutput(id, srv, stream, buf) {
    const r = this._rt(id);
    const text = this._decode(r, srv, buf);
    if (!text) return;

    this._log(id, stream, text);

    // ловим ответ на запрос TPS
    if (r.tpsPendingUntil && Date.now() < r.tpsPendingUntil) {
      for (const line of text.split(/\r?\n/)) {
        const v = this._parseTps(line);
        if (v != null) {
          this._pushTps(id, v);
          r.tpsPendingUntil = 0;
          break;
        }
      }
    }
  }

  stop(id) {
    const srv = this.get(id);
    if (!srv) throw new Error('Сервер не найден');
    const r = this._rt(id);
    if (r.state !== 'running' || !r.proc) return this.status(id);

    r.manualStop = true;
    clearTimeout(r.restartTimer);
    this._stopTpsPolling(id);

    const graceful = (srv.stopCommand || '').trim();
    if (graceful) {
      this._log(id, 'system', `⏹ Остановка: отправляю «${graceful}» в консоль…`);
      r.stopping = true;
      this._setState(id, 'stopping');
      try {
        r.proc.stdin.write(graceful + '\n');
      } catch (e) {
        this._log(id, 'system', 'Не удалось отправить команду остановки, завершаю принудительно.');
        this.kill(id);
        return this.status(id);
      }
      const timeout = Number(srv.stopTimeout) > 0 ? Number(srv.stopTimeout) : DEFAULT_STOP_TIMEOUT;
      clearTimeout(r.stopTimer);
      r.stopTimer = setTimeout(() => {
        if (this._rt(id).proc) {
          this._log(id, 'system', `Сервер не ответил за ${Math.round(timeout / 1000)} с — принудительное завершение.`);
          this.kill(id);
        }
      }, timeout);
    } else {
      this._log(id, 'system', '⏹ Остановка (принудительно): команда остановки не задана.');
      this.kill(id);
    }
    return this.status(id);
  }

  restart(id) {
    const srv = this.get(id);
    if (!srv) throw new Error('Сервер не найден');
    const r = this._rt(id);
    clearTimeout(r.restartTimer);

    if (r.state === 'stopped' || !r.proc) {
      return this.start(id);
    }

    this._log(id, 'system', 'Перезапуск…');
    r.manualStop = true;
    const waitExit = () => {
      if (this._rt(id).proc) {
        setTimeout(waitExit, 200);
        return;
      }
      setTimeout(() => {
        if (this.get(id)) this.start(id);
      }, 400);
    };
    this.stop(id);
    waitExit();
    return this.status(id);
  }

  kill(id) {
    const r = this._rt(id);
    clearTimeout(r.stopTimer);
    this._stopTpsPolling(id);
    const pid = r.pid;
    if (!pid) return this.status(id);
    this._log(id, 'system', `Принудительное завершение процесса (PID ${pid})`);
    r.manualStop = true;
    try {
      if (process.platform === 'win32') {
        execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {});
      } else {
        try { process.kill(-pid, 'SIGKILL'); } catch { process.kill(pid, 'SIGKILL'); }
      }
    } catch (e) {
      this._log(id, 'stderr', `Не удалось завершить процесс: ${e.message}`);
    }
    return this.status(id);
  }

  sendCommand(id, cmd, { silent = false } = {}) {
    const r = this._rt(id);
    if (!r.proc || !r.proc.stdin) return false;
    const text = String(cmd);
    if (!silent) this._log(id, 'input', '> ' + text);
    try {
      r.proc.stdin.write(text + '\n');
      return true;
    } catch (e) {
      if (!silent) this._log(id, 'stderr', `Не удалось отправить команду: ${e.message}`);
      return false;
    }
  }

  /** Публичная заметка в консоль сервера (для синхронизации и служебных сообщений). */
  note(id, text) {
    this._log(id, 'system', String(text));
  }

  startAll(skip = []) {
    const skipSet = new Set(skip.map(String));
    for (const s of this.servers) if (!skipSet.has(String(s.id))) this.start(s.id);
  }

  stopAll(skip = []) {
    const skipSet = new Set(skip.map(String));
    for (const s of this.servers) if (!skipSet.has(String(s.id))) this.stop(s.id);
  }

  /** Перезапуск всех серверов по очереди (без гонки за порты). */
  async restartAll(skip = []) {
    const skipSet = new Set(skip.map(String));
    for (const s of this.servers) {
      if (skipSet.has(String(s.id))) continue;
      try {
        await this.restart(s.id);
        await new Promise((r) => setTimeout(r, 400));
      } catch { /* продолжаем остальные */ }
    }
  }

  startAutostart() {
    for (const s of this.servers) if (s.autoStart) this.start(s.id);
  }

  /** Аккуратно гасим всё при выходе из приложения */
  shutdownAll() {
    for (const s of this.servers) {
      const r = this._rt(s.id);
      if (!r.proc) continue;
      r.manualStop = true;
      this._stopTpsPolling(s.id);
      const graceful = (s.stopCommand || '').trim();
      try {
        if (graceful) r.proc.stdin.write(graceful + '\n');
      } catch { /* ignore */ }
      setTimeout(() => {
        if (this._rt(s.id).proc) this.kill(s.id);
      }, 2500);
    }
  }
}

module.exports = { ServerManager, MAX_LOG_LINES };
