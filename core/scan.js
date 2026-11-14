'use strict';
/**
 * Сканер локальных серверов: ищет папки, похожие на серверы
 * (Minecraft, Node.js-боты, Python-скрипты и т.п.).
 */
const fs = require('fs');
const path = require('path');

// Папки, в которые не лезем: системный мусор и гигантские каталоги
const SKIP_DIRS = new Set([
  'windows', '$recycle.bin', 'system volume information', 'programdata', 'appdata',
  'node_modules', '.git', '.cache', '.gradle', '.m2', '.nuget', '.vscode', '.idea',
  'program files', 'program files (x86)', 'perflogs', 'recovery', '$windows.~bt',
  '$windows.~ws', 'msocache', 'driverstore', 'winsxs', 'temp', 'tmp', 'cache',
  'steamapps', 'steamlibrary', 'epic games', 'battle.net', 'riot games', 'logs',
  'site-packages', '__pycache__', 'dist', 'build', 'target', 'venv', '.venv',
  // внутри этих папок лежат jar-плагины/библиотеки, а не сами серверы
  'libs', 'lib', 'libraries', 'node_modules',
  // папки миров Minecraft: тысячи файлов регионов, серверов там нет
  'world', 'world_nether', 'world_the_end', 'datapacks',
  // кэши приложений
  'cache2', 'code cache', 'gpucache', 'blob_storage', 'arena-workspace', 'procs',
  'onedrivetemp', 'yandexdisk', 'dropbox', 'google drive',
]);

const MAX_DIRS = 400000;
const READDIR_TIMEOUT = 12000;   // если папка «висит» (сетевой диск, привод) — идём дальше

function isWin() {
  return process.platform === 'win32';
}

/** Список доступных корней для сканирования (диски Windows или корень ФС). */
function listRoots() {
  if (!isWin()) return ['/'];
  const roots = [];
  for (let c = 65; c <= 90; c++) {
    const letter = String.fromCharCode(c) + ':\\';
    try {
      if (fs.existsSync(letter)) roots.push(letter);
    } catch { /* ignore */ }
  }
  return roots.length ? roots : ['C:\\'];
}

function shouldSkipDir(name, fullPath) {
  const lower = name.toLowerCase();
  if (SKIP_DIRS.has(lower)) return true;
  if (lower.startsWith('.')) return true;
  if (isWin() && fullPath.length <= 3) return false;
  return false;
}

// все поддерживаемые типы находок (по умолчанию ищем всё)
const KIND_WEIGHT = {
  minecraft: 1,
  'minecraft-plugin': 1,
  node: 1,
  python: 1,
  exe: 1,
  script: 1,
};

const MC_JAR = /(^|[-_.])(server|paper|spigot|craftbukkit|purpur|pufferfish|fabric-server|forge|neoforge|minecraft_server|mohist|arclight)[-_.\d\w]*\.jar$/i;
const NODE_ENTRY = /^(index|bot|app|main|server)\.(js|mjs|cjs|ts)$/i;

/**
 * Анализирует содержимое одной папки и решает, сервер это или нет.
 * @returns {null|object}
 */
function analyze(dir, rawEntries) {
  // поддерживаем и Dirent (isDirectory()), и простые объекты { name, isDirectory: bool }
  const isDirOf = (e) => (typeof e.isDirectory === 'function' ? e.isDirectory() : !!e.isDirectory);
  const entries = rawEntries.map((e) => ({ name: e.name, isDirectory: isDirOf(e) }));

  const files = new Map();  // имя -> isDir
  for (const e of entries) files.set(e.name, e.isDirectory);

  const lower = new Map();
  for (const [name, isDir] of files) lower.set(name.toLowerCase(), { name, isDir });

  const has = (n) => lower.has(n.toLowerCase());
  const hasDir = (n) => { const x = lower.get(n.toLowerCase()); return x && x.isDir; };
  const find = (re) => { for (const [name, isDir] of files) if (!isDir && re.test(name)) return name; return null; };

  const hints = [];
  let score = 0;
  let kind = null;
  let stopCommand = '';
  let weak = false; // «слабая» находка: например, папка с плагинами

  // ── Minecraft ──
  const jar = find(/\.jar$/i) && find(MC_JAR) ? find(MC_JAR) : (find(MC_JAR) || null);
  if (has('server.properties')) { score += 3; hints.push('server.properties'); }
  if (has('eula.txt')) { score += 2; hints.push('eula.txt'); }
  if (jar) { score += 3; hints.push(jar); }
  if (hasDir('plugins')) { score += 1; hints.push('plugins/'); }
  if (hasDir('mods')) { score += 1; hints.push('mods/'); }
  if (hasDir('world')) { score += 1; hints.push('world/'); }
  if (has('bukkit.yml') || has('spigot.yml') || has('paper.yml') || has('paper-global.yml')) { score += 1; hints.push('bukkit/paper конфиг'); }

  // Настоящий сервер Minecraft: есть маркеры сервера или jar именно сервера в корне папки
  const hasServerMarker = has('server.properties') || has('eula.txt') || has('bukkit.yml') || has('spigot.yml')
    || has('paper.yml') || has('paper-global.yml') || has('ops.json') || has('whitelist.json') || has('banned-ips.json');
  const serverJar = ['server.jar', 'minecraft_server.jar', 'paper.jar', 'spigot.jar', 'craftbukkit.jar',
    'purpur.jar', 'pufferfish.jar', 'fabric-server-launch.jar', 'forge.jar', 'neoforge.jar', 'mohist.jar', 'arclight.jar']
    .find((n) => has(n)) || find(/^(server|paper|spigot|craftbukkit|purpur|mohist|arclight)[-_\d.]*\.jar$/i);

  if (hasServerMarker || (serverJar && score >= 2)) {
    kind = 'minecraft';
    stopCommand = 'stop';
  } else if (hasDir('plugins') || hasDir('mods')) {
    // папка с плагинами — не сервер; покажем только если включён фильтр «плагины»
    const pluginJars = [...files.keys()].filter((n) => /\.jar$/i.test(n));
    if (pluginJars.length && !has('server.properties') && !has('eula.txt')) {
      return {
        path: dir,
        name: path.basename(dir) || dir,
        kind: 'minecraft-plugin',
        score: 1,
        hints: ['плагины/моды: ' + pluginJars.slice(0, 3).join(', ')],
        command: '',
        stopCommand: '',
      };
    }
  }

  // ── скрипт запуска ──
  // скрипт запуска: сам по себе серьёзный признак сервера
  const starter = ['start.bat', 'start.cmd', 'run.bat', 'run.cmd', 'start.sh', 'run.sh', 'launch.bat', 'launch.cmd', 'server.bat', 'server.cmd']
    .find((n) => has(n));
  const anyBat = find(/\.(bat|cmd|sh)$/i);
  if (starter) {
    score += 3;
    hints.push(starter);
    if (!kind) kind = 'script';
  } else if (anyBat) {
    score += 2;
    hints.push(anyBat);
    if (!kind) kind = 'script';
  }

  // ── Node.js ──
  let nodeEntry = null;
  if (has('package.json')) {
    nodeEntry = ['index.js', 'bot.js', 'app.js', 'main.js', 'server.js'].find((n) => has(n)) || null;
    const entry = find(NODE_ENTRY);
    if (entry) nodeEntry = entry;
    score += nodeEntry ? 3 : 1;
    hints.push('package.json');
    if (nodeEntry) {
      kind = kind && kind !== 'script' ? kind : 'node';
      if (kind === 'node') stopCommand = '';
    }
  }

  // ── Python ──
  let pyEntry = null;
  if (has('requirements.txt') || has('pyproject.toml')) {
    pyEntry = ['main.py', 'bot.py', 'app.py', 'server.py', 'run.py'].find((n) => has(n)) || null;
    if (pyEntry) {
      score += 3;
      hints.push(pyEntry);
      if (!kind) { kind = 'python'; stopCommand = ''; }
    } else {
      score += 1;
    }
  }

  // исполняемый файл сервера
  const exe = find(/^(server|start|run|game|service)[-_]?\w*\.exe$/i);
  if (exe) {
    score += 2;
    hints.push(exe);
    if (!kind) kind = 'exe';
  }

  // папка, в которой лежат только jar-плагины (libs, plugins, downloads с плагином)
  const parent = path.basename(path.dirname(dir)).toLowerCase();
  if (['libs', 'lib', 'plugins', 'mods', 'libraries'].includes(parent) && !kind) return null;

  // сама панель не должна попадать в результаты
  if (has('package.json')) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if ((pkg.name || '').includes('omnipanel') || (pkg.productName || '').includes('OmniPanel')
          || (pkg.name || '').includes('local-server-panel') || (pkg.productName || '').includes('Local Server Panel')) return null;
    } catch { /* ignore */ }
  }
  if (has('preload.js') && hasDir('core') && hasDir('ui')) return null; // похоже на исходники панели

  // Папка с jar-файлами, но без признаков сервера — это «папка плагинов».
  // Показываем такой результат только если пользователь включил этот тип в фильтре.
  if (!kind) {
    const jars = [...files.keys()].filter((n) => /\.jar$/i.test(n));
    if (jars.length) {
      return {
        path: dir,
        name: path.basename(dir) || dir,
        kind: 'minecraft-plugin',
        score: 1,
        hints: ['jar-файлы: ' + jars.slice(0, 3).join(', ') + (jars.length > 3 ? ` и ещё ${jars.length - 3}` : '')],
        command: '',
        stopCommand: '',
      };
    }
    return null;
  }

  if (score < 3) return null;

  // ── предлагаемая команда запуска ──
  let command = '';
  if (kind === 'minecraft') {
    if (starter && /\.(bat|cmd)$/i.test(starter)) command = starter;
    else if (jar) command = `java -Xms1G -Xmx2G -jar "${jar}" nogui`;
    else if (starter) command = starter;
  } else if (kind === 'node') {
    command = nodeEntry ? `node "${nodeEntry}"` : 'npm start';
  } else if (kind === 'python') {
    command = `python "${pyEntry}"`;
    stopCommand = '';
  } else if (kind === 'exe' && exe) {
    command = `"${exe}"`;
  } else if (starter) {
    command = starter;
  }

  return {
    path: dir,
    name: path.basename(dir) || dir,
    kind,
    score,
    hints: [...new Set(hints)].slice(0, 8),
    command,
    stopCommand,
  };
}

function readDirSafe(dir) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };

    const timer = setTimeout(() => finish(null), READDIR_TIMEOUT);
    fs.readdir(dir, { withFileTypes: true }, (err, entries) => {
      clearTimeout(timer);
      if (err) return finish(null);
      finish(entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() })));
    });
  });
}

/**
 * Сканирует диски и возвращает найденные серверы.
 * @param {object} opts
 * @param {string[]} opts.roots
 * @param {number}   opts.maxDepth
 * @param {Function} opts.isCancelled
 * @param {Function} opts.onFound
 * @param {Function} opts.onProgress
 */
async function scanServers({
  roots = [], maxDepth = 4, isCancelled = () => false, onFound = null, onProgress = null,
  ignorePaths = [], types = null,
} = {}) {
  const ignore = new Set(ignorePaths.filter(Boolean).map((p) => path.resolve(p).toLowerCase()));
  // какие типы находок показывать (плагины — только по явному запросу)
  const allowed = new Set(types && types.length ? types : Object.keys(KIND_WEIGHT));
  const accept = (found) => found && allowed.has(found.kind);
  const queue = roots.map((r) => ({ dir: r, depth: 0 }));
  const results = [];
  const seen = new Set();
  let scanned = 0;
  let dirsVisited = 0;
  let totalQueued = 0;
  const CONCURRENCY = 48;   // на Windows это в разы быстрее, чем 12
  let lastProgress = 0;

  while (queue.length && !isCancelled() && dirsVisited < MAX_DIRS) {
    const batch = queue.splice(0, CONCURRENCY);
    totalQueued = Math.max(totalQueued, dirsVisited + queue.length + batch.length);

    await Promise.all(batch.map(async ({ dir, depth }) => {
      if (isCancelled() || seen.has(dir)) return;
      seen.add(dir);
      dirsVisited++;
      scanned++;

      if (ignore.has(path.resolve(dir).toLowerCase())) return;

      const entries = await readDirSafe(dir);
      if (!entries) return;

      const found = analyze(dir, entries);

      // «папка плагинов» — это не сервер: показываем по запросу, но внутрь всё равно идём
      const isContainer = found && found.kind === 'minecraft-plugin';
      if (found && !isContainer && accept(found)) {
        results.push(found);
        if (onFound) onFound(found);
      } else if (isContainer && accept(found)) {
        results.push(found);
        if (onFound) onFound(found);
      }

      // из настоящего сервера вглубь не спускаемся, а из «плагинов» — спускаемся
      if ((found && !isContainer) || depth >= maxDepth) return;

      for (const e of entries) {
        if (!e.isDirectory) continue;
        if (shouldSkipDir(e.name, path.join(dir, e.name))) continue;
        queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
      }
    }));

    if (onProgress) {
      const now = Date.now();
      if (now - lastProgress > 300) {
        lastProgress = now;
        const pending = dirsVisited + queue.length;
        const percent = pending > 0 ? Math.min(99, Math.round((dirsVisited / pending) * 100)) : 0;
        onProgress({
          scanned,
          found: results.length,
          queued: queue.length,
          current: batch[0]?.dir || '',
          percent,
          cancelled: isCancelled(),
        });
      }
    }
  }

  if (onProgress) onProgress({ scanned, found: results.length, queued: 0, current: '', percent: 100, done: true, cancelled: isCancelled() });
  return results;
}

module.exports = { scanServers, listRoots, analyze, SKIP_DIRS };
