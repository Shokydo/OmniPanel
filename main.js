'use strict';
/**
 * Electron-обёртка: окно + иконка в трее.
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, dialog, shell, Notification, screen, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { ServerManager } = require('./core/manager');
const { scanServers, listRoots } = require('./core/scan');
const backup = require('./core/backup');
const kernels = require('./core/kernels');
const files = require('./core/files');
const opener = require('./core/opener');
const github = require('./core/github');
const updater = require('./core/updater');
const { readJson, writeJson } = require('./core/store');

const APP_NAME = 'OmniPanel';
app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId('OmniPanel');

const IS_DEV = !app.isPackaged;
let win = null;
let tray = null;
let quitting = false;
let manager = null;

/* ------------------------------ конфиг ------------------------------ */

// Portable-режим: данные храним рядом с .exe (в папке OmniPanelData),
// а если папка только для чтения — откатываемся в %APPDATA%.
let DATA_DIR = null;

function resolveDataDir() {
  migrateLegacyData();
  const candidates = [];
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    candidates.push(path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'OmniPanelData'));
  }
  try { candidates.push(path.join(path.dirname(process.execPath), 'OmniPanelData')); } catch { /* ignore */ }
  candidates.push(path.join(app.getPath('appData'), APP_NAME));

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch { /* пробуем следующий */ }
  }
  return app.getPath('userData');
}

/** Перенос данных из старых версий (LocalPanelData → OmniPanelData). */
function migrateLegacyData() {
  const bases = [];
  if (process.env.PORTABLE_EXECUTABLE_DIR) bases.push(process.env.PORTABLE_EXECUTABLE_DIR);
  try { bases.push(path.dirname(process.execPath)); } catch { /* ignore */ }
  for (const base of bases) {
    const oldDir = path.join(base, 'LocalPanelData');
    const newDir = path.join(base, 'OmniPanelData');
    try {
      if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) {
        fs.renameSync(oldDir, newDir);
        console.log('[panel] данные перенесены:', oldDir, '→', newDir);
      }
    } catch { /* не критично */ }
  }
}

/* сохранённые параметры окна (режим при запуске) */
function windowPrefsPath() {
  return path.join(dataDir(), 'panel.json');
}

function readWindowPrefs() {
  try {
    const raw = readJson(windowPrefsPath(), {}) || {};
    return { startMode: raw.startMode === 'fullscreen' || raw.startMode === 'maximized' ? raw.startMode : 'window' };
  } catch {
    return { startMode: 'window' };
  }
}

function readPanel() {
  try { return readJson(windowPrefsPath(), {}) || {}; } catch { return {}; }
}

function readGithubAccount() {
  const p = readPanel();
  return { token: p.githubToken || '', login: p.githubLogin || '', name: p.githubName || '', avatar: p.githubAvatar || '' };
}

/** Записать произвольные поля в panel.json. */
function writePanel(patch) {
  const cur = readPanel();
  const next = { ...cur, ...patch };
  writeJson(windowPrefsPath(), next);
  return next;
}

function writeGithubAccount(patch) {
  const cur = readPanel();
  writeJson(windowPrefsPath(), { ...cur, ...patch });
  return readGithubAccount();
}

function writeWindowPrefs(patch) {
  const cur = readWindowPrefs();
  const next = { ...cur, ...patch };
  writeJson(windowPrefsPath(), next);
  return next;
}

function dataDir() {
  return DATA_DIR || app.getPath('userData');
}

/* ------------------------- обновления из GitHub ------------------------- */

const UPD = {
  last: null,
  busy: false,
};

/** Репозиторий обновлений по умолчанию — собственный репозиторий панели. */
const UPDATE_REPO_DEFAULT = 'Shokydo/OmniPanel';

const updatesDir = () => path.join(dataDir(), 'updates');
const updBackupDir = () => path.join(updatesDir(), 'backup');
const updDownloadDir = () => path.join(updatesDir(), 'download');

/** Настройки канала обновлений из panel.json. */
function updConfig() {
  const p = readPanel();
  return {
    repo: updater.normalizeRepo(p.updateRepo || UPDATE_REPO_DEFAULT),
    repoDefault: UPDATE_REPO_DEFAULT,
    branch: p.updateBranch || 'main',
    auto: p.updateAuto !== false,
    autoInstall: p.updateAutoInstall !== false,
    lastCheck: p.updateLastCheck || null,
    lastVersion: p.updateLastVersion || '',
    current: app.getVersion(),
    packaged: app.isPackaged,
    appDir: app.getAppPath(),
  };
}

function updSaveConfig(patch = {}) {
  const data = {
    updateRepo: patch.repo !== undefined ? String(patch.repo || '').trim() : readPanel().updateRepo,
    updateBranch: patch.branch !== undefined ? String(patch.branch || 'main').trim() : readPanel().updateBranch,
    updateAuto: patch.auto !== undefined ? !!patch.auto : readPanel().updateAuto,
    updateAutoInstall: patch.autoInstall !== undefined ? !!patch.autoInstall : readPanel().updateAutoInstall,
  };
  writePanel(data);
  return updConfig();
}

/** Всплывающее уведомление внутри окна панели. */
function notifyRenderer(payload) {
  if (win && !win.isDestroyed()) win.webContents.send('toast', payload);
}

function updSend(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** Проверить обновления; результат уходит и в ответ, и событием в окно. */
async function updCheck(opts = {}) {
  const cfg = updConfig();
  if (!cfg.repo) {
    const res = { ok: false, error: 'не задан репозиторий обновлений', current: cfg.current, repo: '' };
    updSend('upd:state', res);
    return res;
  }
  const res = await updater.check({
    repo: cfg.repo,
    branch: cfg.branch,
    token: accountToken(),
    current: cfg.current,
  });
  UPD.last = res;
  writePanel({ updateLastCheck: new Date().toISOString(), updateLatest: res.ok ? res.latest : '' });
  updSend('upd:state', res);
  if (res.ok && res.hasUpdate && opts.announce) {
    updSend('upd:available', res);
    if (win && !win.isVisible() && Notification.isSupported()) {
      const n = new Notification({
        title: 'Доступно обновление OmniPanel',
        body: `Версия ${res.latest} — открой панель, чтобы установить`,
      });
      n.on('click', showWindow);
      n.show();
    }
  }
  return res;
}

/** Есть ли запущенные серверы — на время обновления их нужно остановить. */
function anyRunning() {
  return !!(manager && manager.list().some((s) => s.state !== 'stopped'));
}

const pendingFile = () => path.join(updatesDir(), 'pending.json');

function readPending() {
  try { return JSON.parse(fs.readFileSync(pendingFile(), 'utf8')); } catch { return null; }
}

function writePending(data) {
  try {
    fs.mkdirSync(updatesDir(), { recursive: true });
    if (data) fs.writeFileSync(pendingFile(), JSON.stringify({ ...data, at: new Date().toISOString() }, null, 1), 'utf8');
    else fs.rmSync(pendingFile(), { force: true });
  } catch { /* не критично */ }
}

/** Скачать архив обновления кода в папку данных. */
async function fetchCodeArchive(check) {
  const file = path.join(updDownloadDir(), updater.CODE_ASSET);
  if (fs.existsSync(file) && check.code.size && fs.statSync(file).size === check.code.size) return file;
  updSend('upd:progress', { phase: 'download', received: 0, total: check.code.size || 0 });
  await updater.download(check.code.url, file, {
    token: accountToken(),
    onProgress: (p) => updSend('upd:progress', { phase: 'download', ...p }),
  });
  if (check.code.sha256 && updater.sha256File(file) !== check.code.sha256) {
    fs.rmSync(file, { force: true });
    throw new Error('контрольная сумма не совпала');
  }
  return file;
}

/** Поставить скачанный архив кода и перезапуститься. */
function applyCodeArchive(file, version, current) {
  updSend('upd:progress', { phase: 'install' });
  const res = updater.applyCode({
    appDir: app.getAppPath(),
    zipPath: file,
    backupDir: updBackupDir(),
    version,
    backupLabel: current,
  });
  if (!res.ok) return res;
  updater.pruneBackups(updBackupDir(), 2);
  writePanel({ updateLastVersion: version, updateInstalledAt: new Date().toISOString() });
  writePending(null);
  updSend('upd:progress', { phase: 'restart' });
  setTimeout(() => {
    quitting = true;
    app.relaunch();
    app.exit(0);
  }, 900);
  return res;
}

/**
 * Тихая проверка и установка (режим Discord).
 *  - ничего не запущено → обновляемся и перезапускаемся сразу;
 *  - серверы работают → скачиваем втихую и ставим при выходе, следующий
 *    запуск уже на новой версии.
 */
async function autoUpdate() {
  const cfg = updConfig();
  if (!cfg.repo || !cfg.autoInstall) return null;

  const res = await updCheck({ announce: true });
  if (!res || !res.ok || !res.hasUpdate || !res.code) return res;

  // уже качали — не гоняем трафик повторно
  const file = path.join(updDownloadDir(), updater.CODE_ASSET);
  const fresh = fs.existsSync(file) && res.code.size && fs.statSync(file).size === res.code.size;

  if (!fresh && anyRunning()) {
    // серверы заняты: просто сообщаем, что обновление будет при выходе
    updSend('upd:ready', { version: res.latest, when: 'exit' });
    notifyRenderer({
      title: 'Обновление ' + res.latest + ' готово',
      text: 'Установится, когда закроешь панель. Серверы не трогаю.',
      kind: 'info',
    });
    writePending({ version: res.latest, url: res.code.url, size: res.code.size, sha256: res.code.sha256 });
    return res;
  }

  try {
    const archive = await fetchCodeArchive(res);
    if (anyRunning()) {
      writePending({ version: res.latest, file: archive, size: res.code.size, sha256: res.code.sha256 });
      updSend('upd:ready', { version: res.latest, when: 'exit' });
      notifyRenderer({
        title: 'Обновление ' + res.latest + ' скачано',
        text: 'Установится, когда закроешь панель — серверы ждать не будут.',
        kind: 'info',
      });
      return res;
    }
    notifyRenderer({
      title: 'Обновляюсь до ' + res.latest,
      text: 'Панель перезапустится сама через пару секунд.',
      kind: 'info',
      ms: 4000,
    });
    applyCodeArchive(archive, res.latest, res.current);
    return res;
  } catch (err) {
    writePending(null);
    notifyRenderer({ title: 'Обновление не скачалось', text: err.message, kind: 'err' });
    return { ...res, error: err.message };
  }
}

/** Отложенное обновление: поставить перед выходом (серверы уже остановлены). */
function applyPendingOnQuit() {
  const pending = readPending();
  if (!pending || !pending.version || pending.version === app.getVersion()) return false;
  let file = pending.file && fs.existsSync(pending.file) ? pending.file : path.join(updDownloadDir(), updater.CODE_ASSET);
  if (!fs.existsSync(file)) return false;
  if (pending.sha256 && updater.sha256File(file) !== pending.sha256) return false;
  const res = updater.applyCode({
    appDir: app.getAppPath(),
    zipPath: file,
    backupDir: updBackupDir(),
    version: pending.version,
    backupLabel: app.getVersion(),
  });
  if (!res.ok) return false;
  updater.pruneBackups(updBackupDir(), 2);
  writePanel({ updateLastVersion: pending.version, updateInstalledAt: new Date().toISOString() });
  writePending(null);
  console.log('[panel] обновление', pending.version, 'установлено при выходе');
  return true;
}

function configPath() {
  return path.join(dataDir(), 'servers.json');
}

function backupsDir(serverId) {
  return path.join(dataDir(), 'backups', serverId);
}

function tpsDir() {
  return path.join(dataDir(), 'tps');
}

function tpsFile(serverId) {
  return path.join(tpsDir(), String(serverId).replace(/[^\w-]/g, '_') + '.json');
}

const tpsStore = {
  load(serverId) {
    return readJson(tpsFile(serverId), []);
  },
  save(serverId, points) {
    writeJson(tpsFile(serverId), Array.isArray(points) ? points : []);
  },
};

/* --------------------- синхронизация с GitHub --------------------- */

function syncStateFile(serverId) {
  return path.join(dataDir(), 'github', String(serverId).replace(/[^\w-]/g, '_') + '.json');
}

function syncEnabled(srv) {
  if (!srv || !srv.sync || !srv.sync.enabled || !srv.sync.repo) return false;
  return !!(srv.sync.token || accountToken());
}

function accountToken() {
  return readGithubAccount().token || '';
}

function syncOptions(srv) {
  const sc = srv.sync || {};
  return {
    dir: srv.cwd,
    repo: sc.repo,
    branch: sc.branch || 'main',
    token: sc.token || accountToken(),
    scope: sc.scope || 'all',
    stateFile: syncStateFile(srv.id),
    message: `OmniPanel: ${srv.name} — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    onLog: (text) => manager && manager.note(srv.id, 'GitHub: ' + text),
  };
}

/** Идентификаторы «общих» серверов — их не трогаем массовыми кнопками. */
function sharedIds() {
  return manager.list().filter((s) => s.sync && s.sync.enabled).map((s) => s.id);
}

/** Запуск с проверкой обновлений на GitHub (если включено). */
async function startWithSync(id) {
  const srv = manager.get(id);
  if (!srv) throw new Error('Сервер не найден');
  if (syncEnabled(srv) && srv.sync.pullOnStart !== false) {
    manager.note(id, 'GitHub: проверяю обновления перед запуском…');
    const res = await github.pull(syncOptions(srv));
    if (!res.ok) {
      manager.note(id, 'GitHub: ' + res.error);
      const cont = await dialog.showMessageBox(win, {
        type: 'warning',
        title: 'Синхронизация не удалась',
        message: 'Не удалось получить обновления из GitHub',
        detail: res.error + '\n\nСервер всё равно запустить?',
        buttons: ['Не запускать', 'Запустить как есть'],
        defaultId: 0,
        cancelId: 0,
      });
      if (cont.response !== 1) return manager.status(id);
    } else if (res.upToDate) {
      manager.note(id, 'GitHub: обновлений нет');
    } else {
      manager.note(id, `GitHub: обновлено — скачано ${res.downloaded}, удалено ${res.removed}`);
      if (win && !win.isDestroyed()) {
        win.webContents.send('toast', {
          kind: 'ok',
          text: `${srv.name}: получено обновление (${res.downloaded} файлов)`,
        });
      }
    }
  }
  return manager.start(id);
}

/** После остановки — отправляем мир на GitHub (если включено). */
const pushing = new Set();
async function pushAfterStop(id) {
  const srv = manager.get(id);
  if (!srv || !syncEnabled(srv) || srv.sync.pushOnStop === false) return;
  if (quitting || pushing.has(id)) return;
  pushing.add(id);
  try {
    manager.note(id, 'GitHub: отправляю изменения…');
    const res = await github.push(syncOptions(srv));
    if (res.ok) {
      if (res.upToDate) manager.note(id, 'GitHub: отправлять нечего');
      else manager.note(id, `GitHub: отправлено файлов — ${res.uploaded}, коммит ${String(res.commit).slice(0, 7)}`);
    } else {
      manager.note(id, 'GitHub: ' + res.error);
    }
    if (win && !win.isDestroyed()) {
      win.webContents.send('toast', res.ok
        ? { kind: 'ok', text: res.upToDate ? `${srv.name}: изменений для GitHub нет` : `${srv.name}: мир отправлен на GitHub` }
        : { kind: 'err', text: `${srv.name}: GitHub — ${res.error}` });
    }
  } finally {
    pushing.delete(id);
  }
}

function loadServers() {
  const file = configPath();
  const data = readJson(file, null);
  if (Array.isArray(data)) return data;
  // первый запуск — берём пример из комплекта
  const example = readJson(path.join(__dirname, 'servers.example.json'), []);
  return Array.isArray(example) ? example.map((s) => ({ ...s, id: require('crypto').randomUUID() })) : [];
}

function saveServers(list) {
  writeJson(configPath(), list);
}

/* ------------------------------ окно ------------------------------- */

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 860,
    minHeight: 560,
    backgroundColor: '#0e1116',
    show: false,
    frame: false,
    title: APP_NAME,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.once('ready-to-show', () => {
    const mode = readWindowPrefs().startMode;
    if (mode === 'maximized') win.maximize();
    else if (mode === 'fullscreen') win.setFullScreen(true);
    win.show();
    sendWinState();
  });

  const sendWinState = () => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('win:state', {
      maximized: win.isMaximized(),
      fullscreen: win.isFullScreen(),
      visible: win.isVisible(),
    });
  };
  for (const ev of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'show', 'hide']) {
    win.on(ev, sendWinState);
  }

  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });

  win.on('closed', () => { win = null; });
}

function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/* ------------------------------ трей ------------------------------- */

function trayIcon(state) {
  const name = state === 'running' ? 'tray-running.png' : 'tray-idle.png';
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', name));
  return img.isEmpty() ? nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray-idle.png')) : img;
}

function refreshTray() {
  if (!tray) return;
  const list = manager.list();
  const running = list.filter((s) => s.state === 'running').length;

  const serverItems = list.length
    ? list.map((s) => ({
        label: `${s.state === 'running' ? '●' : '○'}  ${s.name}`,
        submenu: [
          { label: 'Запустить', enabled: s.state === 'stopped', click: () => manager.start(s.id) },
          { label: 'Остановить', enabled: s.state !== 'stopped', click: () => manager.stop(s.id) },
          { label: 'Перезапустить', click: () => manager.restart(s.id) },
        ],
      }))
    : [{ label: 'Серверов пока нет', enabled: false }];

  tray.setImage(trayIcon(running > 0 ? 'running' : 'idle'));
  tray.setToolTip(`${APP_NAME} — активно: ${running}/${list.length}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Открыть ${APP_NAME}`, click: showWindow },
    { type: 'separator' },
    { label: 'Серверы', submenu: serverItems },
    { type: 'separator' },
    { label: 'Запустить все', click: () => manager.startAll() },
    { label: 'Остановить все', click: () => manager.stopAll() },
    { type: 'separator' },
    { label: 'Выход (серверы будут остановлены)', click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  try {
    tray = new Tray(trayIcon('idle'));
  } catch (e) {
    console.warn('Трей недоступен в этой системе:', e.message);
    return;
  }
  tray.setToolTip(APP_NAME);
  tray.on('click', () => {
    if (win && win.isVisible() && !win.isMinimized()) win.hide();
    else showWindow();
  });
  refreshTray();
}

/**
 * Системное уведомление о смене состояния сервера — только когда окно
 * свёрнуто в трей (иначе хватает уведомлений внутри окна).
 */
function notifyDesktop(payload) {
  try {
    if (!win || win.isVisible()) return;
    if (!Notification.isSupported()) return;
    const srv = manager.get(payload.id);
    if (!srv) return;
    const map = {
      running: ['Сервер запущен', `${srv.name} работает`],
      stopped: ['Сервер остановлен', `${srv.name} остановлен`],
      stopping: null,
    };
    const text = map[payload.state];
    if (!text) return;
    const n = new Notification({
      title: text[0],
      body: text[1],
      icon: path.join(__dirname, 'assets', 'icon.png'),
      silent: true,
    });
    n.on('click', showWindow);
    n.show();
  } catch { /* уведомления не критичны */ }
}

/* --------------------------- обои (фон) ---------------------------- */

/** Папка для своих обоев: любой png/gif/mp4 из проводника. */
function wallpapersDir() {
  const dir = path.join(dataDir(), 'wallpapers');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return dir;
}

const WALL_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'mp4', 'webm'];

/* ------------------------------ IPC -------------------------------- */

function wireIpc() {
  ipcMain.handle('servers:list', () => manager.list());

  /* ── своя шапка окна ── */
  ipcMain.handle('win:minimize', () => { if (win) win.minimize(); return true; });
  ipcMain.handle('win:close', () => { if (win) win.hide(); return true; });
  ipcMain.handle('win:toggleMax', () => {
    if (!win) return { maximized: false, fullscreen: false };
    if (win.isFullScreen()) {
      win.setFullScreen(false);
    } else if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
      // запасной вариант, если оконный менеджер не поддерживает maximize
      if (!win.isMaximized()) {
        try {
          const area = screen.getPrimaryDisplay().workArea;
          win.setBounds({ x: area.x, y: area.y, width: area.width, height: area.height });
        } catch { /* ignore */ }
      }
    }
    return { maximized: win.isMaximized(), fullscreen: win.isFullScreen() };
  });
  ipcMain.handle('win:toggleFull', () => {
    if (!win) return { maximized: false, fullscreen: false };
    win.setFullScreen(!win.isFullScreen());
    return { maximized: win.isMaximized(), fullscreen: win.isFullScreen() };
  });
  ipcMain.handle('win:state', () => (win ? {
    maximized: win.isMaximized(),
    fullscreen: win.isFullScreen(),
    visible: win.isVisible(),
  } : { maximized: false, fullscreen: false, visible: false }));
  ipcMain.handle('win:getStartMode', () => readWindowPrefs().startMode);
  ipcMain.handle('win:setStartMode', (_e, mode) => {
    const val = mode === 'fullscreen' || mode === 'maximized' ? mode : 'window';
    writeWindowPrefs({ startMode: val });
    if (win) {
      if (win.isFullScreen()) win.setFullScreen(false);
      if (win.isMaximized()) win.unmaximize();
      if (val === 'fullscreen') win.setFullScreen(true);
      else if (val === 'maximized') win.maximize();
    }
    return val;
  });

  /* ── операции «со всеми серверами» ── */
  ipcMain.handle('servers:startAll', async () => {
    const skip = sharedIds();
    for (const s of manager.list()) {
      if (skip.includes(s.id)) continue;
      await startWithSync(s.id);
    }
    return { ok: true, skipped: skip.length };
  });
  ipcMain.handle('servers:stopAll', () => {
    const skip = sharedIds();
    manager.stopAll(skip);
    return { ok: true, skipped: skip.length };
  });
  ipcMain.handle('servers:restartAll', async () => {
    const skip = sharedIds();
    await manager.restartAll(skip);
    return { ok: true, skipped: skip.length };
  });

  /* ── GitHub: проверка, скачивание, отправка ── */
  ipcMain.handle('gh:verify', (_e, cfg) => github.verify({ ...(cfg || {}), token: (cfg && cfg.token) || accountToken() }));
  ipcMain.handle('gh:account', () => {
    const acc = readGithubAccount();
    return { token: acc.token ? '•'.repeat(8) : '', hasToken: !!acc.token, login: acc.login, name: acc.name, avatar: acc.avatar };
  });
  ipcMain.handle('gh:login', async (_e, token) => {
    const tk = String(token || '').trim() || accountToken();
    const user = await github.getUser(tk);
    if (!user.ok) return user;
    writeGithubAccount({ githubToken: tk, githubLogin: user.login, githubName: user.name, githubAvatar: user.avatar });
    return { ...user, hasToken: true };
  });
  ipcMain.handle('gh:logout', () => {
    writeGithubAccount({ githubToken: '', githubLogin: '', githubName: '', githubAvatar: '' });
    return { ok: true };
  });
  ipcMain.handle('gh:repos', async (_e, query) => github.listRepos(accountToken(), query));
  ipcMain.handle('gh:createRepo', async (_e, name, isPrivate) => github.createRepo(accountToken(), name, isPrivate !== false));
  ipcMain.handle('gh:check', async (_e, id) => {
    const srv = manager.get(id);
    if (!srv) return { ok: false, error: 'Сервер не найден' };
    if (!syncEnabled(srv)) return { ok: false, error: 'Синхронизация не настроена' };
    return github.check(syncOptions(srv));
  });
  ipcMain.handle('gh:pull', async (_e, id) => {
    const srv = manager.get(id);
    if (!srv) return { ok: false, error: 'Сервер не найден' };
    if (!syncEnabled(srv)) return { ok: false, error: 'Синхронизация не настроена' };
    const st = manager.status(id).state;
    if (st === 'running' || st === 'starting') {
      return { ok: false, error: 'Сначала останови сервер — файлы мира заняты' };
    }
    manager.note(id, 'GitHub: скачиваю изменения…');
    const res = await github.pull(syncOptions(srv));
    manager.note(id, res.ok
      ? (res.upToDate ? 'GitHub: всё уже актуально' : `GitHub: скачано ${res.downloaded}, удалено ${res.removed}`)
      : 'GitHub: ' + res.error);
    return res;
  });
  ipcMain.handle('gh:push', async (_e, id) => {
    const srv = manager.get(id);
    if (!srv) return { ok: false, error: 'Сервер не найден' };
    if (!syncEnabled(srv)) return { ok: false, error: 'Синхронизация не настроена' };
    manager.note(id, 'GitHub: отправляю изменения…');
    const res = await github.push(syncOptions(srv));
    manager.note(id, res.ok
      ? (res.upToDate ? 'GitHub: отправлять нечего' : `GitHub: отправлено ${res.uploaded}, коммит ${String(res.commit).slice(0, 7)}`)
      : 'GitHub: ' + res.error);
    return res;
  });
  ipcMain.handle('gh:status', (_e, id) => {
    const st = github.loadState(syncStateFile(id));
    return { commit: st.commit, at: st.at, files: Object.keys(st.files || {}).length, branch: st.branch };
  });
  ipcMain.handle('gh:forget', (_e, id) => {
    try { fs.unlinkSync(syncStateFile(id)); return { ok: true }; } catch { return { ok: false }; }
  });

  /* ── перенос папки сервера в папку программы: <программа>/server/<имя> ── */
  ipcMain.handle('server:autoFolder', () => {
    const base = app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..');
    return path.join(base, 'server');
  });
  ipcMain.handle('server:moveToApp', async (_e, id, opts = {}) => {
    try {
      const srv = manager.get(id);
      if (!srv) return { ok: false, error: 'Сервер не найден' };
      if (!srv.cwd) return { ok: false, error: 'У сервера не задана рабочая папка' };
      if (manager.status(id).state !== 'stopped') return { ok: false, error: 'Останови сервер перед переносом' };

      const base = app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..');
      const root = path.join(base, 'server');
      fs.mkdirSync(root, { recursive: true });

      const safe = String(srv.name || 'server')
        .replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '_').slice(0, 60) || 'server';
      let dest = path.join(root, safe);
      let n = 2;
      while (fs.existsSync(dest) && path.resolve(dest) !== path.resolve(srv.cwd)) dest = path.join(root, `${safe}_${n++}`);
      if (path.resolve(dest) === path.resolve(srv.cwd)) {
        return { ok: true, path: srv.cwd, unchanged: true };
      }

      const src = path.resolve(srv.cwd);
      if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
      const send = (payload) => {
        if (win && !win.isDestroyed()) win.webContents.send('move-progress', payload);
      };
      send({ stage: 'copy', text: 'Копирую файлы…' });

      const copyDir = (from, to) => {
        fs.mkdirSync(to, { recursive: true });
        for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
          const a = path.join(from, entry.name);
          const b = path.join(to, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) copyDir(a, b);
          else if (entry.isFile()) fs.copyFileSync(a, b);
        }
      };
      copyDir(src, dest);

      manager.update(id, { cwd: dest });
      send({ stage: 'done', text: 'Готово: ' + dest });

      let removedOld = false;
      if (opts.removeOld) {
        try {
          fs.rmSync(src, { recursive: true, force: true });
          removedOld = true;
        } catch (err) {
          manager.note(id, 'Старую папку удалить не удалось: ' + err.message);
        }
      }
      manager.note(id, `Папка сервера перенесена: ${dest}`);
      return { ok: true, path: dest, removedOld };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /* ── системные уведомления (когда окно в трее) ── */
  ipcMain.handle('notify:desktop', (_e, payload = {}) => {
    try {
      if (!Notification.isSupported()) return false;
      const n = new Notification({
        title: String(payload.title || APP_NAME),
        body: String(payload.text || ''),
        icon: path.join(__dirname, 'assets', 'icon.png'),
        silent: payload.silent !== false,
      });
      n.on('click', showWindow);
      n.show();
      return true;
    } catch { return false; }
  });
  ipcMain.handle('win:isVisible', () => !!(win && win.isVisible() && !win.isMinimized()));

  ipcMain.handle('servers:add', (_e, data) => manager.add(data));
  ipcMain.handle('servers:update', (_e, id, patch) => manager.update(id, patch));
  ipcMain.handle('servers:remove', (_e, id) => manager.remove(id));
  ipcMain.handle('servers:reorder', (_e, ids) => manager.reorder(ids));

  ipcMain.handle('server:start', async (_e, id) => startWithSync(id));
  ipcMain.handle('server:stop', (_e, id) => manager.stop(id));
  ipcMain.handle('server:restart', (_e, id) => manager.restart(id));
  ipcMain.handle('server:kill', (_e, id) => manager.kill(id));
  ipcMain.handle('server:command', (_e, id, cmd) => manager.sendCommand(id, cmd));
  ipcMain.handle('server:logs', (_e, id) => manager.logs(id));
  ipcMain.handle('server:clearLogs', (_e, id) => manager.clearLogs(id));

  /* ── обновления из GitHub ── */
  ipcMain.handle('upd:config', () => updConfig());
  ipcMain.handle('upd:save', (_e, patch) => updSaveConfig(patch || {}));
  ipcMain.handle('upd:check', () => updCheck({ announce: true }));

  ipcMain.handle('upd:auto', () => autoUpdate());

  ipcMain.handle('upd:apply', async () => {
    if (UPD.busy) return { ok: false, error: 'обновление уже идёт' };
    const last = UPD.last || (await updCheck());
    if (!last || !last.ok) return { ok: false, error: (last && last.error) || 'сначала проверь обновления' };
    if (!last.hasUpdate) return { ok: false, error: 'установлена последняя версия' };
    if (!last.code) return { ok: false, error: 'в обновлении нет файла с кодом панели' };
    if (anyRunning()) return { ok: false, error: 'сначала останови запущенные серверы' };

    UPD.busy = true;
    try {
      const file = path.join(updDownloadDir(), updater.CODE_ASSET);
      updSend('upd:progress', { phase: 'download', received: 0, total: last.code.size || 0 });
      await updater.download(last.code.url, file, {
        token: accountToken(),
        onProgress: (p) => updSend('upd:progress', { phase: 'download', ...p }),
      });
      if (last.code.sha256) {
        const got = updater.sha256File(file);
        if (got !== last.code.sha256) {
          return { ok: false, error: 'контрольная сумма не совпала — файл повреждён, попробуй снова' };
        }
      }
      updSend('upd:progress', { phase: 'install' });
      const res = updater.applyCode({
        appDir: app.getAppPath(),
        zipPath: file,
        backupDir: updBackupDir(),
        version: last.latest,
        backupLabel: last.current,
      });
      if (!res.ok) return res;
      updater.pruneBackups(updBackupDir(), 2);
      writePanel({ updateLastVersion: last.latest, updateInstalledAt: new Date().toISOString() });
      updSend('upd:progress', { phase: 'restart' });
      setTimeout(() => {
        quitting = true;
        app.relaunch();
        app.exit(0);
      }, 900);
      return {
        ok: true,
        version: last.latest,
        files: res.applied.length,
        removed: res.removed.length,
        backup: res.backup,
        kept: res.kept || [],
        restored: res.restored || [],
        blocked: res.blocked || [],
      };
    } catch (err) {
      const hint = err.code === 'EACCES' || err.code === 'EPERM'
        ? 'нет прав на запись в папку программы — распакуй панель в свою папку (не в Program Files)'
        : err.message;
      return { ok: false, error: hint };
    } finally {
      UPD.busy = false;
    }
  });

  ipcMain.handle('upd:downloadFull', async () => {
    const last = UPD.last || (await updCheck());
    if (!last || !last.ok || !(last.setup || last.full)) {
      return { ok: false, error: 'в обновлении нет ни установщика, ни полной сборки' };
    }
    if (UPD.busy) return { ok: false, error: 'уже качается' };
    UPD.busy = true;
    try {
      // установщик удобнее: он сам обновит панель и сохранит данные
      if (last.setup) {
        const name = last.setup.name || `OmniPanel-Setup-${last.latest}.exe`;
        const setupFile = path.join(updDownloadDir(), name);
        await updater.download(last.setup.url, setupFile, {
          token: accountToken(),
          onProgress: (p) => updSend('upd:progress', { phase: 'full', ...p }),
        });
        if (last.setup.sha256 && updater.sha256File(setupFile) !== last.setup.sha256) {
          return { ok: false, error: 'контрольная сумма установщика не совпала' };
        }
        updSend('upd:progress', { phase: 'full-done' });
        shell.showItemInFolder(setupFile);
        return { ok: true, setup: true, archive: setupFile, version: last.latest };
      }
      const file = path.join(updDownloadDir(), updater.FULL_ASSET);
      await updater.download(last.full.url, file, {
        token: accountToken(),
        onProgress: (p) => updSend('upd:progress', { phase: 'full', ...p }),
      });
      if (last.full.sha256 && updater.sha256File(file) !== last.full.sha256) {
        return { ok: false, error: 'контрольная сумма не совпала' };
      }
      const res = updater.saveFullPackage({
        zipPath: file,
        exeDir: path.dirname(app.getPath('exe')),
        updatesDir: updatesDir(),
      });
      updSend('upd:progress', { phase: 'full-done' });
      if (res.ok) shell.showItemInFolder(res.script);
      return { ...res, version: last.latest };
    } catch (err) {
      return { ok: false, error: err.message };
    } finally {
      UPD.busy = false;
    }
  });

  ipcMain.handle('upd:revealBackups', () => {
    const dir = updBackupDir();
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
    return { ok: true, dir };
  });

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    configPath: configPath(),
    platform: process.platform,
    mode: 'desktop',
    dataDir: DATA_DIR,
    home: app.getPath('documents'),
    sep: process.platform === 'win32' ? '\\' : '/',
    packaged: app.isPackaged,
    appDir: app.getAppPath(),
  }));

  ipcMain.handle('path:check', (_e, p) => {
    if (!p) return { exists: false };
    try {
      const st = fs.statSync(p);
      return { exists: true, isDir: st.isDirectory(), isFile: st.isFile() };
    } catch {
      return { exists: false };
    }
  });

  ipcMain.handle('shell:openPath', async (_e, p) => {
    if (!p) return { ok: false, error: 'Путь не указан' };
    if (!fs.existsSync(p)) return { ok: false, error: 'Папка не найдена: ' + p };
    const err = await shell.openPath(p);
    return err ? { ok: false, error: err } : { ok: true };
  });

  /* ── свои иконки серверов ── */
  ipcMain.handle('icon:pick', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Выберите иконку сервера',
      properties: ['openFile'],
      filters: [{ name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'ico', 'gif', 'webp', 'bmp'] }],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const file = res.filePaths[0];

    try {
      const img = nativeImage.createFromPath(file);
      if (!img.isEmpty()) {
        return img.resize({ width: 128, height: 128, quality: 'best' }).toDataURL();
      }
      const buf = fs.readFileSync(file);
      if (buf.length > 1024 * 1024) return null;
      const ext = path.extname(file).slice(1).toLowerCase();
      const mime = ext === 'jpg' ? 'jpeg' : ext;
      return `data:image/${mime};base64,${buf.toString('base64')}`;
    } catch {
      return null;
    }
  });

  ipcMain.handle('shell:vscode', async (_e, target) => opener.openInVSCode(target));

  /* ── свои обои: выбор файла через системный диалог и копирование в данные ── */
  ipcMain.handle('wall:pick', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Выберите фон панели',
      properties: ['openFile'],
      filters: [
        { name: 'Картинки и видео', extensions: WALL_EXT },
        { name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
        { name: 'Видео', extensions: ['mp4', 'webm'] },
      ],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const src = res.filePaths[0];
    const ext = path.extname(src).slice(1).toLowerCase();
    if (!WALL_EXT.includes(ext)) return { ok: false, error: 'Неподдерживаемый формат: ' + ext };
    try {
      const st = fs.statSync(src);
      if (st.size > 120 * 1024 * 1024) return { ok: false, error: 'Файл больше 120 МБ' };
      const base = (path.basename(src, path.extname(src)) || 'wall')
        .replace(/[^\w\u0400-\u04FF.-]+/g, '_').slice(0, 40);
      const name = `${base}-${Date.now().toString(36)}.${ext}`;
      const dest = path.join(wallpapersDir(), name);
      fs.copyFileSync(src, dest);
      return { ok: true, name, url: 'omni-wall://' + name, size: st.size };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('wall:remove', (_e, name) => {
    try {
      const safe = path.basename(String(name || ''));
      if (!safe) return { ok: false };
      const file = path.join(wallpapersDir(), safe);
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /** Текущая иконка сервера → server-icon.png (64×64) в папке сервера. */
  ipcMain.handle('icon:toServer', async (_e, cwd, dataUrl) => {
    try {
      if (!cwd || !dataUrl) return { ok: false, error: 'Нет папки или иконки' };
      if (!fs.existsSync(cwd)) return { ok: false, error: 'Папка не найдена: ' + cwd };
      const base64 = String(dataUrl).replace(/^data:image\/png;base64,/, '');
      const img = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'));
      if (img.isEmpty()) return { ok: false, error: 'Не удалось прочитать картинку' };
      const png = img.resize({ width: 64, height: 64, quality: 'best' }).toPNG();
      const dest = path.join(cwd, 'server-icon.png');
      fs.writeFileSync(dest, png);
      return { ok: true, path: dest };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /* ── редактор файлов ── */
  const rootOf = (id) => {
    const s = manager.get(id);
    if (!s) throw new Error('Сервер не найден');
    if (!s.cwd) throw new Error('У сервера не задана рабочая папка');
    return s.cwd;
  };
  const fsWrap = (fn) => async (_e, ...args) => {
    try {
      return { ok: true, ...(await fn(...args)) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  };
  ipcMain.handle('files:list', fsWrap(async (id, rel) => files.listDir(rootOf(id), rel)));
  ipcMain.handle('files:read', fsWrap(async (id, rel) => files.readFile(rootOf(id), rel)));
  ipcMain.handle('files:write', fsWrap(async (id, rel, content) => files.writeFile(rootOf(id), rel, content)));
  ipcMain.handle('files:mkdir', fsWrap(async (id, rel) => files.mkdir(rootOf(id), rel)));
  ipcMain.handle('files:remove', fsWrap(async (id, rel) => files.remove(rootOf(id), rel)));
  ipcMain.handle('files:rename', fsWrap(async (id, rel, name) => files.rename(rootOf(id), rel, name)));
  ipcMain.handle('files:search', fsWrap(async (id, q) => ({ results: await files.search(rootOf(id), q) })));
  ipcMain.handle('props:read', fsWrap(async (id) => files.readServerProperties(rootOf(id))));
  ipcMain.handle('props:write', fsWrap(async (id, patch) => files.writeServerProperties(rootOf(id), patch)));
  ipcMain.handle('server:vscode', async (_e, id) => {
    try { return await opener.openInVSCode(rootOf(id)); } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('files:vscode', async (_e, id, rel) => {
    try {
      return await opener.openInVSCode(files.resolveSafe(rootOf(id), rel));
    } catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('files:openExternal', async (_e, id, rel) => {
    try {
      await shell.openPath(files.resolveSafe(rootOf(id), rel));
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  /* ── мастер создания сервера ── */
  ipcMain.handle('wizard:catalog', () => kernels.catalog());
  ipcMain.handle('wizard:versions', (_e, id) => kernels.versions(id));
  ipcMain.handle('wizard:java', () => kernels.detectJava());
  ipcMain.handle('wizard:openJava', async () => {
    await shell.openExternal('https://adoptium.net/temurin/releases/?os=windows&arch=x64&package=jdk');
    return true;
  });
  ipcMain.handle('wizard:pickParent', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Куда создать папку сервера',
      properties: ['openDirectory', 'createDirectory'],
    });
    return res.canceled ? null : res.filePaths[0];
  });
  ipcMain.handle('wizard:suggestDir', (_e, parent, name) => {
    const safe = String(name || 'server').replace(/[\\/:*?"<>|]+/g, '').trim() || 'server';
    return path.join(parent || app.getPath('documents'), safe);
  });
  ipcMain.handle('wizard:create', async (_e, opts) => {
    const send = (payload) => {
      if (win && !win.isDestroyed()) win.webContents.send('wizard-progress', payload);
    };
    try {
      const result = await kernels.createServer(opts, send);
      return { ok: true, ...result };
    } catch (err) {
      send({ stage: 'error', text: err.message });
      return { ok: false, error: err.message };
    }
  });

  /* ── бэкапы ── */
  const serverCwd = (id) => {
    const srv = manager.get(id);
    if (!srv) throw new Error('Сервер не найден');
    if (!srv.cwd) throw new Error('У сервера не задана рабочая папка');
    return srv.cwd;
  };

  ipcMain.handle('backup:list', (_e, id) => backup.listBackups(backupsDir(id)));

  ipcMain.handle('backup:create', async (_e, id, opts = {}) => {
    const srv = manager.get(id);
    const src = serverCwd(id);
    const info = await backup.createBackup({
      srcDir: src,
      destDir: backupsDir(id),
      label: opts.name || srv.name,
    });
    if (win && !win.isDestroyed()) win.webContents.send('toast', { kind: 'ok', text: `Бэкап создан: ${info.name}` });
    return info;
  });

  ipcMain.handle('backup:restore', async (_e, id, file, opts = {}) => {
    const srv = manager.get(id);
    const dest = serverCwd(id);

    // 1. остановить сервер, если работает
    const wasRunning = manager.status(id).state !== 'stopped';
    if (wasRunning) {
      manager.stop(id);
      const started = Date.now();
      while (manager.status(id).state !== 'stopped' && Date.now() - started < 30000) {
        await new Promise((r) => setTimeout(r, 300));
      }
      if (manager.status(id).state !== 'stopped') manager.kill(id);
      await new Promise((r) => setTimeout(r, 800));
    }

    // 2. страховочный бэкап текущего состояния
    let safety = null;
    if (opts.safety !== false) {
      try {
        safety = await backup.createBackup({ srcDir: dest, destDir: backupsDir(id), label: (srv.name || 'server') + '_before_restore' });
      } catch { /* не критично */ }
    }

    // 3. распаковать
    await backup.restoreBackup({ file, destDir: dest });

    if (opts.startAfter && wasRunning) manager.start(id);
    return { ok: true, safety };
  });

  ipcMain.handle('backup:delete', (_e, file) => backup.deleteBackup(file));

  ipcMain.handle('backup:reveal', async (_e, id) => {
    const dir = backupsDir(id);
    backup.ensureDir(dir);
    await shell.openPath(dir);
    return true;
  });

  ipcMain.handle('backup:size', (_e, id) => {
    try { return backup.dirSize(serverCwd(id)); } catch { return { bytes: 0, files: 0 }; }
  });

  /* ── история TPS ── */
  ipcMain.handle('tps:history', (_e, id) => manager.tpsHistory(id));
  ipcMain.handle('tps:clear', (_e, id) => manager.clearTpsHistory(id));

  /* ── иконка из server-icon.png ── */
  ipcMain.handle('icon:fromServer', (_e, cwd) => {
    if (!cwd) return null;
    const candidates = ['server-icon.png', 'icon.png', 'logo.png', 'server-icon.jpg'];
    for (const name of candidates) {
      const file = path.join(cwd, name);
      if (!fs.existsSync(file)) continue;
      try {
        const img = nativeImage.createFromPath(file);
        if (!img.isEmpty()) return img.resize({ width: 128, height: 128, quality: 'best' }).toDataURL();
        const buf = fs.readFileSync(file);
        if (buf.length > 2 * 1024 * 1024) continue;
        const ext = path.extname(file).slice(1).toLowerCase() || 'png';
        return `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${buf.toString('base64')}`;
      } catch { /* пробуем следующий */ }
    }
    return null;
  });

  /* ── автозапуск вместе с Windows ── */
  const loginOpts = () => ({
    path: process.execPath,
    args: app.isPackaged ? [] : [path.join(__dirname)],
  });
  ipcMain.handle('autostart:get', () => {
    try { return app.getLoginItemSettings(loginOpts()).openAtLogin; } catch { return false; }
  });
  ipcMain.handle('autostart:set', (_e, value) => {
    try {
      app.setLoginItemSettings({ openAtLogin: !!value, ...loginOpts() });
      return app.getLoginItemSettings(loginOpts()).openAtLogin;
    } catch { return false; }
  });

  /* ── сканер серверов ── */
  let scanCancelled = false;
  ipcMain.handle('scan:roots', () => listRoots());
  ipcMain.handle('scan:cancel', () => { scanCancelled = true; return true; });
  ipcMain.handle('scan:start', async (_e, opts = {}) => {
    scanCancelled = false;
    const roots = Array.isArray(opts.roots) && opts.roots.length ? opts.roots : listRoots();
    const maxDepth = Number(opts.maxDepth) > 0 ? Math.min(Number(opts.maxDepth), 8) : 4;
    const known = new Set(manager.list().map((s) => (s.cwd || '').toLowerCase()));

    const send = (channel, payload) => {
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    };

    const results = await scanServers({
      roots,
      maxDepth,
      types: Array.isArray(opts.types) && opts.types.length ? opts.types : null,
      ignorePaths: [app.getAppPath(), path.dirname(process.execPath)],
      isCancelled: () => scanCancelled,
      onFound: (f) => {
        f.added = known.has(f.path.toLowerCase());
        send('scan-found', f);
      },
      onProgress: (p) => send('scan-progress', p),
    });

    for (const f of results) f.added = known.has(f.path.toLowerCase());
    return results;
  });

  ipcMain.handle('dialog:pickFolders', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Выберите диски или папки для сканирования',
      properties: ['openDirectory', 'multiSelections'],
    });
    return res.canceled ? [] : res.filePaths;
  });

  ipcMain.handle('dialog:pickFolder', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Выберите папку сервера',
      properties: ['openDirectory'],
    });
    return res.canceled ? null : res.filePaths[0];
  });

  ipcMain.handle('dialog:pickFile', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Выберите файл запуска',
      properties: ['openFile'],
      filters: [
        { name: 'Скрипты и архивы', extensions: ['bat', 'cmd', 'exe', 'jar', 'ps1', 'sh'] },
        { name: 'Все файлы', extensions: ['*'] },
      ],
    });
    return res.canceled ? null : res.filePaths[0];
  });
}

/* ------------------------------ старт ------------------------------ */

/* свои обои раздаём безопасным протоколом omni-wall://<файл> */
protocol.registerSchemesAsPrivileged([
  { scheme: 'omni-wall', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false } },
]);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    DATA_DIR = resolveDataDir();
    try { app.setPath('userData', DATA_DIR); } catch { /* ignore */ }
    console.log('[panel]', APP_NAME, 'данные:', DATA_DIR);

    manager = new ServerManager({ servers: loadServers(), save: saveServers, tpsStore });

    manager.on('log', (payload) => {
      if (win && !win.isDestroyed()) win.webContents.send('log', payload);
    });
    manager.on('state', (payload) => {
      if (win && !win.isDestroyed()) win.webContents.send('state', payload);
      refreshTray();
      notifyDesktop(payload);
      if (payload.state === 'stopped') {
        setTimeout(() => { pushAfterStop(payload.id).catch(() => {}); }, 1200);
      }
    });
    manager.on('servers', (list) => {
      if (win && !win.isDestroyed()) win.webContents.send('servers', list);
      refreshTray();
    });
    manager.on('metrics', (payload) => {
      if (win && !win.isDestroyed()) win.webContents.send('metrics', payload);
    });
    manager.on('tps', (payload) => {
      if (win && !win.isDestroyed()) win.webContents.send('tps', payload);
    });
    manager.on('logs-cleared', (payload) => {
      if (win && !win.isDestroyed()) win.webContents.send('logs-cleared', payload);
    });

    protocol.handle('omni-wall', (request) => {
      try {
        const u = new URL(request.url);
        // omni-wall://файл.png — имя может попасть и в host, и в path
        const raw = (u.hostname ? u.hostname + u.pathname : u.pathname).replace(/\/+$/, '');
        const name = path.basename(decodeURIComponent(raw));
        const file = path.join(wallpapersDir(), name);
        if (!name || !fs.existsSync(file)) return new Response('not found', { status: 404 });
        return net.fetch(pathToFileURL(file).toString());
      } catch (err) {
        console.error('[wall]', err.message);
        return new Response('bad request', { status: 400 });
      }
    });

    wireIpc();
    createWindow();
    createTray();
    manager.startAutostart();

    if (process.env.LSP_DEBUG_SHOT) {
      win.webContents.once('did-finish-load', () => {
        setTimeout(async () => {
          try {
            const img = await win.webContents.capturePage();
            fs.writeFileSync(process.env.LSP_DEBUG_SHOT, img.toPNG());
          } catch (e) { console.error('shot failed', e); }
          app.exit(0);
        }, Number(process.env.LSP_DEBUG_DELAY || 4000));
      });
    }

    // тихая проверка обновлений при запуске; если включена автоустановка —
    // обновляемся сами, как Discord: скачали, поставили, перезапустились
    const updCfg = updConfig();
    if (updCfg.auto && updCfg.repo) {
      setTimeout(() => { autoUpdate().catch(() => {}); }, 3500);
    }

    const tick = setInterval(refreshTray, 30000);
    app.on('before-quit', () => clearInterval(tick));
  });

  // Аккуратно гасим серверы перед выходом: даём им до 4 секунд на корректную остановку
  let shuttingDown = false;
  app.on('before-quit', (e) => {
    quitting = true;
    if (!manager || shuttingDown) return;
    const running = manager.list().some((s) => s.state !== 'stopped');
    if (!running) {
      try { applyPendingOnQuit(); } catch { /* не критично */ }
      return;
    }

    e.preventDefault();
    shuttingDown = true;
    manager.shutdownAll();
    const iv = setInterval(() => {
      if (!manager.list().some((s) => s.state !== 'stopped')) {
        clearInterval(iv);
        try { applyPendingOnQuit(); } catch { /* не критично */ }
        app.exit(0);
      }
    }, 300);
    setTimeout(() => { clearInterval(iv); app.exit(0); }, 4000);
  });

  // Окно закрывается — приложение остаётся в трее
  app.on('window-all-closed', () => { /* ничего: работаем в трее */ });

  app.on('activate', showWindow);
}

process.on('uncaughtException', (err) => {
  try {
    fs.appendFileSync(path.join(DATA_DIR || app.getPath('userData'), 'error.log'), `[${new Date().toISOString()}] ${err.stack}\n`);
  } catch { /* ignore */ }
});
