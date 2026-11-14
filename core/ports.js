'use strict';
/**
 * Порты сервера: какие порты возьмёт сервер при запуске, свободны ли они,
 * и какой ближайший свободный порт предложить, если занято.
 *
 * Читает server.properties (server-port, query.port, rcon.port) и проверяет
 * занятость двумя способами: чужой запущенный сервер панели и реальная
 * попытка занять порт в системе.
 */
const net = require('net');
const files = require('./files');

const PORTS = [
  { key: 'server-port', label: 'Порт сервера', def: 25565, needs: null },
  { key: 'query.port', label: 'Порт query', def: 25565, needs: 'enable-query' },
  { key: 'rcon.port', label: 'Порт RCON', def: 25575, needs: 'enable-rcon' },
];

/** Какие порты возьмёт этот сервер (по его server.properties). */
async function own(root) {
  const res = await files.readServerProperties(root).catch(() => null);
  const props = (res && res.props) || {};
  const out = [];
  for (const p of PORTS) {
    if (p.needs && props[p.needs] !== true) continue;
    const val = Number(props[p.key]);
    out.push({
      key: p.key,
      label: p.label,
      port: Number.isFinite(val) && val > 0 ? val : p.def,
    });
  }
  return out;
}

/** Свободен ли порт прямо сейчас (пробуем занять и сразу отпускаем). */
function isFree(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    try {
      srv.listen({ port, host, exclusive: true });
    } catch {
      resolve(false);
    }
  });
}

/**
 * Проверка перед запуском.
 * @param {string} root      папка сервера
 * @param {Array}  busyList  чужие занятые порты: [{id, name, ports:[{key,port,label}]}]
 */
async function check(root, busyList = []) {
  const ports = await own(root);
  const conflicts = [];
  const busy = [];
  for (const p of ports) {
    for (const other of busyList) {
      if (!other || !Array.isArray(other.ports)) continue;
      const hit = other.ports.find((x) => Number(x.port) === p.port);
      if (!hit) continue;
      conflicts.push({ ...p, serverId: other.id, serverName: other.name, otherKey: hit.key });
      break;
    }
  }
  const takenBySystem = [];
  for (const p of ports) {
    if (conflicts.some((c) => c.key === p.key)) continue;
    const free = await isFree(p.port);
    if (!free) {
      busy.push({ ...p, reason: 'other-app' });
      takenBySystem.push(p.port);
    }
  }
  return { ok: true, ports, conflicts, busy };
}

/** Ближайший свободный порт, начиная со следующего за текущим. */
async function freePort(from, taken = []) {
  const start = Math.max(1024, Math.min(65000, Number(from) || 25565));
  for (let port = start + 1; port < Math.min(65535, start + 300); port += 1) {
    if (taken.includes(port)) continue;
    /* eslint-disable no-await-in-loop */
    if (await isFree(port)) return port;
    /* eslint-enable no-await-in-loop */
  }
  return 0;
}

/** Записать новый порт в server.properties. */
async function set(root, key, port) {
  const allowed = PORTS.some((p) => p.key === key);
  if (!allowed) return { ok: false, error: 'Такой порт панель не меняет' };
  const num = Number(port);
  if (!Number.isFinite(num) || num < 1 || num > 65535) return { ok: false, error: 'Порт должен быть от 1 до 65535' };
  await files.writeServerProperties(root, { [key]: num });
  return { ok: true, key, port: num };
}

module.exports = { own, check, isFree, freePort, set, PORTS };
