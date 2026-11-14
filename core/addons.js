'use strict';
/**
 * Аддоны OmniPanel — как расширения в редакторах кода.
 *
 * Аддон — это папка с файлом addon.json:
 *   {
 *     "id": "mythic-mobs",
 *     "name": "Мифические мобы",
 *     "version": "1.0.0",
 *     "author": "OmniPanel",
 *     "description": "…",
 *     "icon": "M",
 *     "panel": { "title": "Мифические мобы", "file": "panel.html" },
 *     "permissions": ["files", "command"]
 *   }
 *
 * Где лежат:
 *   assets/addons/<id>/      — встроенные (едут вместе с панелью)
 *   <данные>/addons/<id>/    — свои (OmniPanelData/addons)
 *
 * Состояние «включён/выключен» хранится в <данные>/addons.json.
 * Панель аддона открывается в отдельной вкладке сервера в изолированном
 * окне (iframe sandbox) и общается с панелью только через мост.
 */
const fs = require('fs');
const path = require('path');

const BUILTIN_DIR = path.join(__dirname, '..', 'assets', 'addons');
const MANIFEST = 'addon.json';
const ID_RE = /^[a-z0-9][a-z0-9-_.]{1,40}$/;

/** Папка своих аддонов рядом с данными панели. */
function userDir(dataDir) {
  const dir = path.join(dataDir, 'addons');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* нет прав — не страшно */ }
  return dir;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
    return true;
  } catch { return false; }
}

function stateFile(dataDir) {
  return path.join(dataDir, 'addons.json');
}

function readState(dataDir) {
  const st = readJson(stateFile(dataDir)) || {};
  return { enabled: st.enabled && typeof st.enabled === 'object' ? st.enabled : {} };
}

function writeState(dataDir, state) {
  return writeJson(stateFile(dataDir), state);
}

/** Собирает манифест с проверкой полей. */
function normManifest(raw, dir, builtin) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || path.basename(dir)).trim();
  if (!ID_RE.test(id)) return null;
  const panel = raw.panel && typeof raw.panel === 'object' ? raw.panel : null;
  const file = panel && typeof panel.file === 'string' ? panel.file : '';
  const panelFile = file ? path.join(dir, path.basename(file)) : '';
  const hasPanel = !!panelFile && fs.existsSync(panelFile);
  return {
    id,
    name: String(raw.name || id).slice(0, 80),
    version: String(raw.version || '1.0.0').slice(0, 20),
    author: String(raw.author || '').slice(0, 60),
    description: String(raw.description || '').slice(0, 400),
    icon: String(raw.icon || (raw.name || id).slice(0, 1).toUpperCase()).slice(0, 3),
    builtin: !!builtin,
    dir,
    hasPanel,
    panelTitle: hasPanel ? String((panel && panel.title) || raw.name || id).slice(0, 40) : '',
    panelFile,
    permissions: Array.isArray(raw.permissions) ? raw.permissions.filter((p) => typeof p === 'string') : ['files'],
  };
}

/** Все найденные аддоны (без учёта включения). */
function scan(dataDir) {
  const list = [];
  const seen = new Set();
  const roots = [
    { dir: userDir(dataDir), builtin: false },
    { dir: BUILTIN_DIR, builtin: true },
  ];
  for (const root of roots) {
    let names = [];
    try { names = fs.readdirSync(root.dir); } catch { continue; }
    for (const name of names.sort()) {
      const dir = path.join(root.dir, name);
      let stat = null;
      try { stat = fs.statSync(dir); } catch { continue; }
      if (!stat.isDirectory()) continue;
      const manifest = readJson(path.join(dir, MANIFEST));
      const item = normManifest(manifest, dir, root.builtin);
      if (!item) continue;
      if (seen.has(item.id)) continue;   // своя версия важнее встроенной
      seen.add(item.id);
      list.push(item);
    }
  }
  return list;
}

/** Список для интерфейса: с флагами включения. */
function list(dataDir) {
  const state = readState(dataDir);
  return scan(dataDir).map((it) => ({
    ...it,
    panelFile: undefined,
    enabled: state.enabled[it.id] !== false,
  }));
}

function setEnabled(dataDir, id, on) {
  const found = scan(dataDir).find((x) => x.id === id);
  if (!found) return { ok: false, error: 'Аддон не найден' };
  const state = readState(dataDir);
  state.enabled[id] = !!on;
  writeState(dataDir, state);
  return { ok: true, id, enabled: !!on };
}

/** HTML панели аддона (только если он включён). */
function panel(dataDir, id) {
  const item = scan(dataDir).find((x) => x.id === id);
  if (!item) return { ok: false, error: 'Аддон не найден' };
  const state = readState(dataDir);
  if (state.enabled[item.id] === false) return { ok: false, error: 'Аддон выключен' };
  if (!item.hasPanel) return { ok: false, error: 'У аддона нет панели' };
  let html = '';
  try { html = fs.readFileSync(item.panelFile, 'utf8'); } catch (err) {
    return { ok: false, error: 'Не прочитать панель: ' + err.message };
  }
  return {
    ok: true,
    id: item.id,
    title: item.panelTitle,
    permissions: item.permissions,
    html,
  };
}

function dirs(dataDir) {
  return { user: userDir(dataDir), builtin: BUILTIN_DIR };
}

module.exports = { list, setEnabled, panel, scan, dirs, userDir, BUILTIN_DIR, ID_RE };
