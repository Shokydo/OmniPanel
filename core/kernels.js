'use strict';
/**
 * Каталог ядер Minecraft-серверов: получение списка версий,
 * прямых ссылок на скачивание и генерация файлов сервера.
 *
 * Используются официальные API:
 *  - PaperMC  (fill.papermc.io v3)  — paper, folia, velocity, waterfall
 *  - Purpur   (api.purpurmc.org v2)
 *  - Fabric   (meta.fabricmc.net)
 *  - Vanilla  (piston-meta.mojang.com)
 *  - Forge    (files.minecraftforge.net + maven)
 *  - NeoForge (maven.neoforged.net)
 */
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const { execFile } = require('child_process');

const IS_WIN = process.platform === 'win32';
const UA = { 'User-Agent': 'LocalServerPanel/1.4 (+local app)' };

/* ─────────────────────────── вспомогательное ─────────────────────────── */

async function getJson(url, timeout = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { headers: UA, signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status} для ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function getText(url, timeout = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { headers: UA, signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status} для ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Скачивание файла с прогрессом. */
async function download(url, destFile, onProgress = null) {
  const ctrl = new AbortController();
  const res = await fetch(url, { headers: UA, signal: ctrl.signal, redirect: 'follow' });
  if (!res.ok) throw new Error(`Не удалось скачать: HTTP ${res.status}`);

  const total = Number(res.headers.get('content-length') || 0);
  let received = 0;
  let lastTick = 0;

  const tmp = destFile + '.part';
  fs.mkdirSync(path.dirname(destFile), { recursive: true });

  const stream = Readable.fromWeb(res.body);
  stream.on('data', (chunk) => {
    received += chunk.length;
    const now = Date.now();
    if (onProgress && (now - lastTick > 250 || received === total)) {
      lastTick = now;
      onProgress({ received, total, percent: total ? Math.round((received / total) * 100) : null });
    }
  });

  await pipeline(stream, fs.createWriteStream(tmp));
  fs.renameSync(tmp, destFile);
  if (onProgress) onProgress({ received, total, percent: 100, done: true });
  return { file: destFile, size: received };
}

/* ───────────────────────────── Java ───────────────────────────── */

function runJava(args, timeout = 8000, bin = 'java') {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || '') + String(stderr || '') });
    });
  });
}

/** Ищет установленные Java: в PATH и в типовых папках Windows. */
async function detectJava() {
  const found = [];

  const parseVer = (out) => {
    const m = out.match(/version "([^"]+)"/) || out.match(/openjdk ([^\s]+)/i);
    return m ? m[1] : '';
  };

  const main = await runJava(['-version']);
  if (main.out) {
    const v = parseVer(main.out);
    if (v) found.push({ path: 'java', version: v, source: 'PATH' });
  }

  // JAVA_HOME — часто единственный способ найти JDK, если он не в PATH
  if (process.env.JAVA_HOME) {
    const exe = path.join(process.env.JAVA_HOME, 'bin', IS_WIN ? 'java.exe' : 'java');
    if (fs.existsSync(exe)) {
      const r = await runJava(['-version'], 8000, exe);
      const v = parseVer(r.out);
      if (v) found.push({ path: exe, version: v, source: 'JAVA_HOME' });
    }
  }

  if (IS_WIN) {
    const roots = [
      'C:\\Program Files\\Java', 'C:\\Program Files\\Eclipse Adoptium',
      'C:\\Program Files\\Amazon Corretto', 'C:\\Program Files\\Microsoft\\jdk',
      'C:\\Program Files\\Zulu', 'C:\\Program Files\\BellSoft',
    ];
    for (const root of roots) {
      let dirs = [];
      try { dirs = fs.readdirSync(root); } catch { continue; }
      for (const d of dirs) {
        const exe = path.join(root, d, 'bin', 'java.exe');
        if (!fs.existsSync(exe)) continue;
        const r = await runJava(['-version'], 8000, exe).catch(() => null);
        const v = (r && parseVer(r.out)) || d;
        found.push({ path: exe, version: v, source: root });
      }
    }
  }

  // убираем дубли по версии
  const seen = new Set();
  const unique = found.filter((j) => {
    const key = j.version + '|' + j.path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const major = (v) => {
    const m = String(v || '').match(/(\d+)/);
    if (!m) return 0;
    const n = Number(m[1]);
    return n === 1 ? Number((String(v).match(/^1\.(\d+)/) || [])[1] || 0) : n;
  };

  return unique.map((j) => ({ ...j, major: major(j.version) }));
}

/* ─────────────────────── каталог ядер ─────────────────────── */

const PMC = 'https://fill.papermc.io/v3/projects';

const KERNELS = {
  paper: {
    id: 'paper',
    label: 'Paper',
    group: 'Оптимизированные',
    hint: 'Самый популярный оптимизированный сервер. Плагины Bukkit/Spigot.',
    recommended: true,
    javaMin: 21,
    async versions() {
      const data = await getJson(`${PMC}/paper/versions`);
      const list = [];
      for (const item of data.versions || []) {
        const v = item.version || {};
        if (!v.id) continue;
        if (v.support && v.support.status && !/SUPPORTED|SUPPORT|MAINTENANCE/i.test(v.support.status)) continue;
        list.push({
          id: v.id,
          java: v.java?.version?.minimum || null,
        });
      }
      return list;
    },
    async resolve(version) {
      const builds = await getJson(`${PMC}/paper/versions/${encodeURIComponent(version)}/builds`);
      const arr = Array.isArray(builds) ? builds : builds.builds || [];
      if (!arr.length) throw new Error('Для этой версии нет сборок Paper');
      const stable = arr.find((b) => (b.channel || 'STABLE') === 'STABLE') || arr[0];
      const dl = stable.downloads['server:default'] || Object.values(stable.downloads)[0];
      return {
        url: dl.url,
        fileName: dl.name || `paper-${version}.jar`,
        size: dl.size,
        sha256: dl.checksums?.sha256 || null,
        build: stable.id,
        java: stable.java?.version?.minimum || null,
      };
    },
  },

  folia: {
    id: 'folia',
    label: 'Folia',
    group: 'Оптимизированные',
    hint: 'Многопоточный Paper для больших ферм. Многие плагины несовместимы.',
    javaMin: 21,
    async versions() {
      const data = await getJson(`${PMC}/folia/versions`);
      return (data.versions || []).map((i) => ({ id: i.version?.id, java: i.version?.java?.version?.minimum }))
        .filter((v) => v.id);
    },
    async resolve(version) {
      const builds = await getJson(`${PMC}/folia/versions/${encodeURIComponent(version)}/builds`);
      const arr = Array.isArray(builds) ? builds : builds.builds || [];
      const stable = arr.find((b) => (b.channel || 'STABLE') === 'STABLE') || arr[0];
      if (!stable) throw new Error('Нет сборок Folia для этой версии');
      const dl = stable.downloads['server:default'] || Object.values(stable.downloads)[0];
      return { url: dl.url, fileName: dl.name, size: dl.size, build: stable.id };
    },
  },

  purpur: {
    id: 'purpur',
    label: 'Purpur',
    group: 'Оптимизированные',
    hint: 'Форк Paper с кучей настроек геймплея.',
    javaMin: 21,
    async versions() {
      const data = await getJson('https://api.purpurmc.org/v2/purpur');
      return (data.versions || []).slice().reverse().map((v) => ({ id: v }));
    },
    async resolve(version) {
      return {
        url: `https://api.purpurmc.org/v2/purpur/${encodeURIComponent(version)}/latest/download`,
        fileName: `purpur-${version}.jar`,
      };
    },
  },

  fabric: {
    id: 'fabric',
    label: 'Fabric',
    group: 'Моды',
    hint: 'Лёгкий загрузчик модов. Подходит для клиент-серверных модпаков.',
    javaMin: 21,
    async versions() {
      const data = await getJson('https://meta.fabricmc.net/v2/versions/game');
      return data.filter((v) => v.stable).map((v) => ({ id: v.version }));
    },
    async resolve(version) {
      const [loaders, installers] = await Promise.all([
        getJson('https://meta.fabricmc.net/v2/versions/loader'),
        getJson('https://meta.fabricmc.net/v2/versions/installer'),
      ]);
      const loader = (loaders.find((l) => l.stable) || loaders[0]).version;
      const installer = (installers.find((i) => i.stable) || installers[0]).version;
      return {
        url: `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(version)}/${loader}/${installer}/server/jar`,
        fileName: 'fabric-server.jar',
        note: `Fabric loader ${loader}`,
      };
    },
  },

  vanilla: {
    id: 'vanilla',
    label: 'Vanilla',
    group: 'Официальные',
    hint: 'Чистый сервер от Mojang, без плагинов и модов.',
    javaMin: 21,
    async versions() {
      const data = await getJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
      return (data.versions || []).filter((v) => v.type === 'release').map((v) => ({ id: v.id, url: v.url }));
    },
    async resolve(version, all) {
      const meta = await getJson(`https://piston-meta.mojang.com/v1/packages/${await versionUrl(version)}`);
      const server = meta.downloads && meta.downloads.server;
      if (!server) throw new Error('У этой версии нет серверного jar');
      return { url: server.url, fileName: `minecraft_server-${version}.jar`, size: server.size, sha1: server.sha1 };
    },
  },

  forge: {
    id: 'forge',
    label: 'Forge',
    group: 'Моды',
    hint: 'Классический загрузчик модов. Устанавливается через установщик (несколько минут).',
    javaMin: 17,
    installer: true,
    async versions() {
      const data = await getJson('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
      const map = new Map();
      for (const [key, build] of Object.entries(data.promos || {})) {
        const m = key.match(/^(.+)-(latest|recommended)$/);
        if (!m) continue;
        const mc = m[1];
        if (!map.has(mc)) map.set(mc, { id: mc, build, type: m[2] });
        else if (m[2] === 'recommended') map.set(mc, { id: mc, build, type: 'recommended' });
      }
      return [...map.values()].sort((a, b) => cmpVer(b.id, a.id));
    },
    async resolve(version) {
      const data = await getJson('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
      const build = (data.promos || {})[`${version}-recommended`] || (data.promos || {})[`${version}-latest`];
      if (!build) throw new Error('Не удалось определить версию Forge');
      return {
        url: `https://maven.minecraftforge.net/net/minecraftforge/forge/${version}-${build}/forge-${version}-${build}-installer.jar`,
        fileName: 'forge-installer.jar',
        runInstaller: true,
        note: `Forge ${build}`,
      };
    },
  },

  neoforge: {
    id: 'neoforge',
    label: 'NeoForge',
    group: 'Моды',
    hint: 'Современный форк Forge для 1.20.2+. Устанавливается через установщик.',
    javaMin: 21,
    installer: true,
    async versions() {
      const xml = await getText('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml');
      const list = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
      return list.filter((v) => !/beta|alpha/i.test(v)).sort((a, b) => cmpVer(b, a))
        .map((v) => ({ id: v }));
    },
    async resolve(version) {
      return {
        url: `https://maven.neoforged.net/releases/net/neoforged/neoforge/${version}/neoforge-${version}-installer.jar`,
        fileName: 'neoforge-installer.jar',
        runInstaller: true,
        note: `NeoForge ${version}`,
      };
    },
  },

  velocity: {
    id: 'velocity',
    label: 'Velocity',
    group: 'Прокси',
    hint: 'Быстрый прокси для объединения нескольких серверов.',
    javaMin: 17,
    proxy: true,
    async versions() {
      const data = await getJson(`${PMC}/velocity/versions`);
      return (data.versions || []).map((i) => ({ id: i.version?.id })).filter((v) => v.id);
    },
    async resolve(version) {
      const builds = await getJson(`${PMC}/velocity/versions/${encodeURIComponent(version)}/builds`);
      const arr = Array.isArray(builds) ? builds : builds.builds || [];
      const stable = arr.find((b) => (b.channel || 'STABLE') === 'STABLE') || arr[0];
      if (!stable) throw new Error('Нет сборок Velocity');
      const dl = stable.downloads['server:default'] || Object.values(stable.downloads)[0];
      return { url: dl.url, fileName: dl.name, size: dl.size };
    },
  },

  waterfall: {
    id: 'waterfall',
    label: 'Waterfall',
    group: 'Прокси',
    hint: 'Прокси на базе BungeeCord (устаревает, лучше Velocity).',
    javaMin: 17,
    proxy: true,
    async versions() {
      const data = await getJson(`${PMC}/waterfall/versions`);
      return (data.versions || []).map((i) => ({ id: i.version?.id })).filter((v) => v.id);
    },
    async resolve(version) {
      const builds = await getJson(`${PMC}/waterfall/versions/${encodeURIComponent(version)}/builds`);
      const arr = Array.isArray(builds) ? builds : builds.builds || [];
      const stable = arr.find((b) => (b.channel || 'STABLE') === 'STABLE') || arr[0];
      if (!stable) throw new Error('Нет сборок Waterfall');
      const dl = stable.downloads['server:default'] || Object.values(stable.downloads)[0];
      return { url: dl.url, fileName: dl.name, size: dl.size };
    },
  },

  custom: {
    id: 'custom',
    label: 'Своя ссылка',
    group: 'Другое',
    hint: 'Любой jar по прямой ссылке (Dropbox, GitHub Releases, maven, свой хостинг).',
    custom: true,
    async versions() { return []; },
    async resolve() { throw new Error('Для своей ссылки версия не нужна'); },
  },
};

// помогает vanilla-резолверу найти URL метаданных версии
const versionUrlCache = new Map();
async function versionUrl(version) {
  if (versionUrlCache.has(version)) return versionUrlCache.get(version);
  const data = await getJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
  const v = (data.versions || []).find((x) => x.id === version);
  if (!v) throw new Error('Версия не найдена в манифесте Mojang');
  const rest = v.url.split('/v1/packages/')[1];
  versionUrlCache.set(version, rest);
  return rest;
}

/** Сравнение версий вида 1.21.4 / 26.3 / 0.20.1 */
function cmpVer(a, b) {
  const pa = String(a).split(/[.\-+]/).map((x) => Number(x) || 0);
  const pb = String(b).split(/[.\-+]/).map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function catalog() {
  return Object.values(KERNELS).map((k) => ({
    id: k.id,
    label: k.label,
    group: k.group,
    hint: k.hint,
    recommended: !!k.recommended,
    installer: !!k.installer,
    proxy: !!k.proxy,
    custom: !!k.custom,
    javaMin: k.javaMin || null,
  }));
}

async function versions(kernelId) {
  const k = KERNELS[kernelId];
  if (!k) throw new Error('Неизвестное ядро: ' + kernelId);
  const list = await k.versions();
  // показываем новые сверху, ограничиваем разумным числом
  return list.slice(0, 60);
}

async function resolve(kernelId, version) {
  const k = KERNELS[kernelId];
  if (!k) throw new Error('Неизвестное ядро: ' + kernelId);
  return k.resolve(version);
}

/* ─────────────────── генерация файлов сервера ─────────────────── */

/** Путь с пробелами («C:\\Program Files\\…») в bat/sh нужно брать в кавычки. */
function quoteExe(cmd) {
  const c = String(cmd || 'java');
  if (/^["'].*["']$/.test(c)) return c;
  return /\s/.test(c) ? `"${c}"` : c;
}

/** Minecraft читает server.properties в UTF-8 с 1.13, но старые версии — в ISO-8859-1.
 *  Экранируем не-ASCII в \uXXXX, чтобы кириллица работала везде. */
function escapeProps(value) {
  return String(value).replace(/[^\x20-\x7E]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
}

function startScript({ name, jar, javaArgs, javaCmd = 'java', proxy = false, ram }) {
  const lines = [];
  if (IS_WIN) {
    lines.push('@echo off');
    lines.push('chcp 65001 >nul');
    lines.push(`title ${name}`);
    lines.push('cd /d "%~dp0"');
    lines.push(`${quoteExe(javaCmd)} ${javaArgs} -jar "${jar}"${proxy ? '' : ' nogui'}`);
    lines.push('pause');
    return { fileName: 'start.bat', content: lines.join('\r\n') };
  }
  lines.push('#!/bin/sh');
  lines.push('cd "$(dirname "$0")"');
  lines.push(`exec ${quoteExe(javaCmd)} ${javaArgs} -jar "${jar}"${proxy ? '' : ' nogui'}`);
  return { fileName: 'start.sh', content: lines.join('\n') };
}

function serverProperties({ port = 25565, motd = 'OmniPanel', onlineMode = true, maxPlayers = 20, difficulty = 'easy' }) {
  return [
    `#Minecraft server properties`,
    `#создано панелью OmniPanel`,
    `server-port=${port}`,
    `motd=${escapeProps(motd)}`,
    `online-mode=${onlineMode}`,
    `max-players=${maxPlayers}`,
    `difficulty=${difficulty}`,
    `gamemode=survival`,
    `pvp=true`,
    `allow-flight=false`,
    `allow-nether=true`,
    `enable-command-block=true`,
    `spawn-protection=16`,
    `view-distance=10`,
    `simulation-distance=10`,
    `white-list=false`,
    `level-name=world`,
    `level-seed=`,
    `enable-rcon=false`,
    `sync-chunk-writes=true`,
    ``,
  ].join('\n');
}

const AIKAR = [
  '-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-XX:MaxGCPauseMillis=200',
  '-XX:+UnlockExperimentalVMOptions', '-XX:+DisableExplicitGC', '-XX:+AlwaysPreTouch',
  '-XX:G1NewSizePercent=30', '-XX:G1MaxNewSizePercent=40', '-XX:G1HeapRegionSize=8M',
  '-XX:G1ReservePercent=20', '-XX:G1HeapWastePercent=5', '-XX:G1MixedGCCountTarget=4',
  '-XX:InitiatingHeapOccupancyPercent=15', '-XX:G1MixedGCLiveThresholdPercent=90',
  '-XX:G1RSetUpdatingPauseTimePercent=5', '-XX:SurvivorRatio=32', '-XX:+PerfDisableSharedMem',
  '-XX:MaxTenuringThreshold=1', '-Dusing.aikars.flags=https://mcflags.emc.gs', '-Daikars.new.flags=true',
].join(' ');

/**
 * Создаёт сервер: скачивает ядро, генерирует конфиги и скрипт запуска.
 * @param {object} opts
 */
async function createServer(opts, onProgress = () => {}) {
  const {
    kernel, version, customUrl, customName,
    dir, name, javaCmd = 'java', memoryMb = { min: 1024, max: 4096 },
    flagsPreset = 'aikar', extraFlags = '', port = 25565, motd = 'OmniPanel',
    onlineMode = true, generateStartScript = true, installTimeout = 600000,
  } = opts;

  if (!dir) throw new Error('Не указана папка для сервера');
  fs.mkdirSync(dir, { recursive: true });

  const log = (stage, data = {}) => onProgress({ stage, ...data });

  /* 1. ссылка на ядро */
  let resolved;
  if (kernel === 'custom') {
    if (!customUrl || !/^https?:\/\//i.test(customUrl)) throw new Error('Нужна прямая http(s)-ссылка на jar');
    let fileName = customName && customName.trim() ? customName.trim() : '';
    if (!fileName) {
      try {
        const u = new URL(customUrl);
        const base = decodeURIComponent(path.basename(u.pathname) || '');
        // ссылки вида /download, /latest, /server/jar — имя берём по умолчанию
        fileName = /\.jar$/i.test(base) ? base : 'server.jar';
      } catch { fileName = 'server.jar'; }
    }
    if (!/\.jar$/i.test(fileName)) fileName += '.jar';
    resolved = { url: customUrl, fileName };
  } else {
    if (!version) throw new Error('Не выбрана версия');
    log('resolve', { text: `Ищу сборку ${kernel} ${version}…` });
    resolved = await resolve(kernel, version);
  }

  /* 2. скачивание */
  const jarPath = path.join(dir, resolved.fileName);
  if (fs.existsSync(jarPath) && fs.statSync(jarPath).size > 0) {
    log('download', { text: `Файл уже есть: ${resolved.fileName}`, percent: 100 });
  } else {
    log('download', { text: `Скачиваю ${resolved.fileName}…`, percent: 0 });
    const mb = (n) => (n / 1048576).toFixed(1).replace('.', ',');
    await download(resolved.url, jarPath, (p) => {
      const size = p.total
        ? ` — ${p.percent}% (${mb(p.received)} из ${mb(p.total)} МБ)`
        : ` — ${mb(p.received)} МБ`;
      log('download', {
        text: `Скачиваю ${resolved.fileName}${size}`,
        percent: p.percent,
        received: p.received,
        total: p.total,
        quiet: (p.percent || 0) < 100,   // в лог пишем только ключевые строки
      });
    });
  }

  /* 3. установщик (Forge / NeoForge) */
  let installedJar = null;
  if (resolved.runInstaller) {
    log('install', { text: 'Запускаю установщик — это может занять несколько минут…', percent: 0 });
    await new Promise((resolvePromise, rejectPromise) => {
      const child = execFile(javaCmd, ['-jar', resolved.fileName, '--installServer'], {
        cwd: dir, windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: installTimeout,
      }, (err, stdout, stderr) => {
        if (err) return rejectPromise(new Error('Установщик не смог завершиться: ' + (stderr || err.message).slice(-300)));
        resolvePromise();
      });
      let acc = '';
      const onData = (d) => {
        acc += d.toString();
        const lines = acc.split(/\r?\n/);
        acc = lines.pop();
        for (const line of lines) {
          if (/downloading|installing|extracting/i.test(line)) {
            log('install', { text: line.trim().slice(0, 160) });
          }
        }
      };
      if (child.stdout) child.stdout.on('data', onData);
      if (child.stderr) child.stderr.on('data', onData);
    });

    // ищем чем запускать: run.bat (Forge), run.sh, либо forge-*.jar
    const entries = fs.readdirSync(dir);
    if (IS_WIN && entries.includes('run.bat')) installedJar = 'run.bat';
    else if (entries.some((f) => /^forge-.*\.jar$/i.test(f))) installedJar = entries.find((f) => /^forge-.*\.jar$/i.test(f));
    else if (entries.some((f) => /^neoforge-.*\.jar$/i.test(f))) installedJar = entries.find((f) => /^neoforge-.*\.jar$/i.test(f));
    log('install', { text: 'Установщик завершён', percent: 100 });
  }

  /* 4. файлы сервера */
  const isProxy = kernel === 'velocity' || kernel === 'waterfall';
  const isFabric = kernel === 'fabric';

  if (!isProxy) {
    const eula = path.join(dir, 'eula.txt');
    if (!fs.existsSync(eula)) {
      fs.writeFileSync(eula,
        '#Согласие с EULA Minecraft\n#https://aka.ms/MinecraftEULA\n' +
        'eula=true\n', 'utf8');
    }

    const props = path.join(dir, 'server.properties');
    if (!fs.existsSync(props)) fs.writeFileSync(props, serverProperties({ port, motd, onlineMode }), 'utf8');
  }

  /* 5. скрипт запуска */
  const args = [];
  args.push(`-Xms${memoryMb.min}M`);
  args.push(`-Xmx${memoryMb.max}M`);
  if (flagsPreset === 'aikar') args.push(AIKAR);
  else if (flagsPreset === 'simple') args.push('-XX:+UseG1GC -XX:+ParallelRefProcEnabled');
  if (extraFlags && extraFlags.trim()) args.push(extraFlags.trim());
  if (isFabric) args.push('-Dfabric.server=true');

  let command;
  if (generateStartScript) {
    const script = startScript({
      name: name || path.basename(dir),
      jar: installedJar || resolved.fileName,
      javaArgs: args.join(' '),
      javaCmd,
      proxy: isProxy,
      ram: memoryMb,
    });
    if (installedJar === 'run.bat') {
      command = 'run.bat';
    } else {
      fs.writeFileSync(path.join(dir, script.fileName), script.content, 'utf8');
      if (!IS_WIN) {
        try { fs.chmodSync(path.join(dir, script.fileName), 0o755); } catch { /* ignore */ }
      }
      command = script.fileName;
    }
  } else {
    command = `${javaCmd} ${args.join(' ')} -jar "${installedJar || resolved.fileName}"${isProxy ? '' : ' nogui'}`;
  }

  log('done', {
    text: 'Сервер готов',
    percent: 100,
    command,
    dir,
    jar: installedJar || resolved.fileName,
  });

  return {
    command,
    cwd: dir,
    stopCommand: isProxy ? 'end' : 'stop',
    tpsCommand: isProxy ? '' : 'tps',
    isProxy,
    jar: installedJar || resolved.fileName,
    version,
    kernel,
  };
}

module.exports = {
  catalog, versions, resolve, createServer, detectJava,
  download, serverProperties, startScript, AIKAR, KERNELS,
};
