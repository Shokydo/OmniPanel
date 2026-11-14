'use strict';
/**
 * Игроки и блокировки.
 *
 * Minecraft держит баны в двух JSON рядом с ядром:
 *   banned-players.json — ник, UUID, причина, кто забанил, срок;
 *   banned-ips.json     — IP, причина, срок.
 * Панель читает эти файлы напрямую (работает и на остановленном сервере)
 * и умеет снимать блокировку: на запущенном сервере командой (ядро само
 * перепишет файл), на остановленном — правкой JSON.
 */
const fs = require('fs');
const path = require('path');

const PLAYERS_FILE = 'banned-players.json';
const IPS_FILE = 'banned-ips.json';

function readList(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
    if (!text) return [];
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeList(file, list) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** Срок бана: «навсегда» у ванильного сервера — строка "forever". */
function expiry(value) {
  if (!value || value === 'forever') return 'навсегда';
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return String(value);
  if (t <= Date.now()) return 'истёк ' + new Date(t).toLocaleString('ru-RU');
  return 'до ' + new Date(t).toLocaleString('ru-RU');
}

/**
 * Все блокировки сервера.
 * @returns {{players: Array, ips: Array}}
 */
function listBans(cwd) {
  const dir = cwd || '';
  const players = readList(path.join(dir, PLAYERS_FILE)).map((b) => ({
    kind: 'player',
    name: b.name || '',
    uuid: b.uuid && b.uuid !== '-' ? b.uuid : '',
    ip: '',
    reason: b.reason || 'без причины',
    source: b.source || 'консоль',
    created: b.created || '',
    expires: b.expires || 'forever',
    until: expiry(b.expires),
  }));
  const ips = readList(path.join(dir, IPS_FILE)).map((b) => ({
    kind: 'ip',
    name: '',
    uuid: '',
    ip: b.ip || '',
    reason: b.reason || 'без причины',
    source: b.source || 'консоль',
    created: b.created || '',
    expires: b.expires || 'forever',
    until: expiry(b.expires),
  }));
  return { players, ips };
}

/** Снять бан игрока на остановленном сервере: убрать запись из JSON. */
function unbanOffline(cwd, { name, ip }) {
  if (ip) {
    const file = path.join(cwd, IPS_FILE);
    const list = readList(file);
    const left = list.filter((b) => String(b.ip) !== String(ip));
    if (left.length === list.length) return { ok: false, error: `IP ${ip} в блокировках не числится` };
    writeList(file, left);
    return { ok: true, removed: list.length - left.length };
  }
  const file = path.join(cwd, PLAYERS_FILE);
  const list = readList(file);
  const key = String(name || '').toLowerCase();
  const left = list.filter((b) => String(b.name || '').toLowerCase() !== key);
  if (left.length === list.length) return { ok: false, error: `Игрок ${name} в блокировках не числится` };
  writeList(file, left);
  return { ok: true, removed: list.length - left.length };
}

/** Команда снятия блокировки для сервера. */
function unbanCommand({ name, ip }) {
  return ip ? `pardon-ip ${ip}` : `unban ${name}`;
}

module.exports = { listBans, unbanOffline, unbanCommand, PLAYERS_FILE, IPS_FILE };
