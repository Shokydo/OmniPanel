'use strict';

/* ═════════════════════ API: Electron IPC или HTTP (браузерный режим) ═════════════════════ */

const httpApi = {
  mode: 'web',
  async list() { return (await fetch('/api/servers')).json(); },
  async add(d) { return post('/api/servers', d); },
  async update(id, p) { return post(`/api/servers/${id}`, p); },
  async remove(id) { return (await fetch(`/api/servers/${id}`, { method: 'DELETE' })).json(); },
  async start(id) { return post(`/api/servers/${id}/start`); },
  async stop(id) { return post(`/api/servers/${id}/stop`); },
  async restart(id) { return post(`/api/servers/${id}/restart`); },
  async kill(id) { return post(`/api/servers/${id}/kill`); },
  async command(id, cmd) { return post(`/api/servers/${id}/command`, { cmd }); },
  async logs(id) { return (await fetch(`/api/servers/${id}/logs`)).json(); },
  async clearLogs(id) { return post(`/api/servers/${id}/clearLogs`); },
  async info() { return (await fetch('/api/info')).json(); },
  async checkPath(p) {
    if (!p) return { exists: false };
    return (await fetch('/api/checkPath?path=' + encodeURIComponent(p))).json();
  },
  async openPath(p) { return post('/api/open', { path: p }); },
  async pickIcon() { return null; },        // в браузере картинку выбираем через <input type=file>
  async pickFolder() { return null; },
  async pickFile() { return null; },
  async pickFolders() { return []; },
  async scanRoots() { return (await fetch('/api/scan/roots')).json(); },
  async scanStart(opts) { return post('/api/scan/start', opts); },
  async scanCancel() { return post('/api/scan/cancel'); },
  async autostartGet() { return null; },
  async autostartSet() { return null; },
  async startAll() { await Promise.all(S.servers.map((s) => this.start(s.id))); return true; },
  async stopAll() { await Promise.all(S.servers.map((s) => this.stop(s.id))); return true; },
  async restartAll() { for (const s of S.servers) await this.restart(s.id); return true; },
  async winMinimize() { return false; },
  async winClose() { return false; },
  async winQuit() { return false; },
  async winToggleMax() {
    if (!document.fullscreenElement) { await document.documentElement.requestFullscreen().catch(() => {}); return { fullscreen: true, maximized: false }; }
    await document.exitFullscreen().catch(() => {});
    return { fullscreen: false, maximized: false };
  },
  async winToggleFull() { return this.winToggleMax(); },
  async winIsVisible() { return !document.hidden; },
  async winState() { return { maximized: false, fullscreen: !!document.fullscreenElement }; },
  async winGetStartMode() { return 'window'; },
  async winSetStartMode(m) { return m; },
  async notifyDesktop() { return false; },
  async wallPick() { return null; },
  async updConfig() { return { repo: '', branch: 'main', auto: false, current: '0.0.0', packaged: false }; },
  async updSave() { return this.updConfig(); },
  async updCheck() { return { ok: false, error: 'Обновления работают только в exe-версии' }; },
  async updApply() { return { ok: false, error: 'Обновления работают только в exe-версии' }; },
  async updDownloadFull() { return { ok: false, error: 'Обновления работают только в exe-версии' }; },
  async updRevealBackups() { return { ok: false }; },
  onUpdState() { /* в браузере нет */ },
  onUpdAvailable() { /* в браузере нет */ },
  onUpdProgress() { /* в браузере нет */ },
  async ghVerify() { return { ok: false, error: 'Только в exe-версии' }; },
  async ghAccount() { return { hasToken: false }; },
  async ghLogin() { return { ok: false, error: 'Только в exe-версии' }; },
  async ghLogout() { return { ok: true }; },
  async ghRepos() { return { ok: false, error: 'Только в exe-версии' }; },
  async ghOauthClientId() { return ''; },
  async ghSetOauthClientId() { return ''; },
  async ghDeviceStart() { return { ok: false, error: 'Вход через GitHub — только в exe-версии' }; },
  async ghDevicePoll() { return { ok: false, error: 'Вход через GitHub — только в exe-версии' }; },
  async ghOpenExternal(url) { try { window.open(url, '_blank'); } catch { /* браузер сам */ } return true; },
  async ghDownload() { return { ok: false, error: 'Скачивание из GitHub — только в exe-версии' }; },
  async ghCreateRepo() { return { ok: false, error: 'Только в exe-версии' }; },
  async ghCheck() { return { ok: false, error: 'Только в exe-версии' }; },
  async ghPull() { return { ok: false, error: 'Только в exe-версии' }; },
  async ghPush() { return { ok: false, error: 'Только в exe-версии' }; },
  async ghStatus() { return { commit: null, at: null, files: 0 }; },
  async ghForget() { return { ok: true }; },
  async serverAutoFolder() { return ''; },
  async serverMoveToApp() { return { ok: false, error: 'Только в exe-версии' }; },
  onMoveProgress() { /* в браузере нет */ },
  async wallRemove() { return { ok: true }; },
  onWinState() { /* в браузере нет своего окна */ },
  async backupList(id) { return (await fetch(`/api/servers/${id}/backups`)).json(); },
  async backupCreate(id, opts) { return post(`/api/servers/${id}/backups/create`, opts); },
  async backupRestore(id, file, opts) { return post(`/api/servers/${id}/backups/restore`, { file, ...(opts || {}) }); },
  async backupDelete(file) { return post(`/api/servers/${id}/backups/delete`, { file }); },
  async backupReveal() { return { ok: false, error: 'Только в exe-версии' }; },
  async backupSize() { return { bytes: 0, files: 0 }; },
  async tpsHistory(id) { return (await fetch(`/api/servers/${id}/tps`)).json(); },
  async filesList(id, rel) { return (await fetch(`/api/files/list?id=${encodeURIComponent(id)}&rel=${encodeURIComponent(rel || '')}`)).json(); },
  async filesRead(id, rel) { return (await fetch(`/api/files/read?id=${encodeURIComponent(id)}&rel=${encodeURIComponent(rel || '')}`)).json(); },
  async filesWrite(id, rel, content) { return post(`/api/files/write?id=${encodeURIComponent(id)}`, { rel, content }); },
  async filesMkdir(id, rel) { return post(`/api/files/mkdir?id=${encodeURIComponent(id)}`, { rel }); },
  async filesRemove(id, rel) { return post(`/api/files/remove?id=${encodeURIComponent(id)}`, { rel }); },
  async filesRename(id, rel, name) { return post(`/api/files/rename?id=${encodeURIComponent(id)}`, { rel, name }); },
  async filesSearch(id, q) { return (await fetch(`/api/files/search?id=${encodeURIComponent(id)}&q=${encodeURIComponent(q)}`)).json(); },
  async filesOpenExternal() { return { ok: false, error: 'Только в exe-версии' }; },
  async filesEditor(id, rel) { return post('/api/files/editor', { id, rel }); },
  async serverEditor(id) { return post('/api/server/editor', { id }); },
  async openEditor(p) { return post('/api/server/editor', { path: p }); },
  async filesUpload(id, relDir, name, data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data || []);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return post('/api/files/upload', { id, rel: relDir, name, data: btoa(bin) });
  },
  async addonsList() { return (await fetch('/api/addons/list')).json(); },
  async addonsSetEnabled(id, on) { return post('/api/addons/toggle', { id, on }); },
  async addonsPanel(id) { return (await fetch('/api/addons/panel?id=' + encodeURIComponent(id))).json(); },
  async addonsDirs() { return { user: '', builtin: '' }; },
  async addonsReveal(id) { return { ok: false }; },
  async addonsCall(id, method, args, serverId) { return post('/api/addons/call', { id, method, args, serverId }); },
  async portsCheck(id) { return (await fetch('/api/ports/check?id=' + encodeURIComponent(id))).json(); },
  async portsFree(id, from) { return (await fetch('/api/ports/free?id=' + encodeURIComponent(id) + '&from=' + encodeURIComponent(from))).json(); },
  async portsSet(id, key, port) { return post('/api/ports/set', { id, key, port }); },
  async portsOwn() { return { ok: false, ports: [] }; },
  async modrinthSearch(opts) {
    const q = new URLSearchParams(opts || {}).toString();
    return (await fetch('/api/modrinth/search?' + q)).json();
  },
  async modrinthDetect(id) { return (await fetch('/api/modrinth/info?id=' + encodeURIComponent(id))).json(); },
  async modrinthInstalled(id) { return (await fetch('/api/modrinth/info?id=' + encodeURIComponent(id))).json(); },
  async modrinthInstall(id, opts) { return post('/api/modrinth/install', { id, ...(opts || {}) }); },
  async modrinthVersions() { return { ok: false, versions: [] }; },
  async modrinthCategories() { return { ok: false, categories: [] }; },
  async wallPalette() { return { ok: false, error: 'Подбор цвета работает только в exe-версии' }; },
  async propsRead(id) { return (await fetch(`/api/props?id=${encodeURIComponent(id)}`)).json(); },
  async propsWrite(id, patch) { return post(`/api/props?id=${encodeURIComponent(id)}`, patch); },
  async iconToServer(cwd, dataUrl) { return post('/api/icon/to', { cwd, dataUrl }); },
  async wizardCatalog() { return (await fetch('/api/wizard/catalog')).json(); },
  async wizardVersions(id) { return (await fetch('/api/wizard/versions?id=' + encodeURIComponent(id))).json(); },
  async wizardJava() { return (await fetch('/api/wizard/java')).json(); },
  async wizardOpenJava() { window.open('https://adoptium.net/temurin/releases/?os=windows&arch=x64&package=jdk', '_blank'); return true; },
  async wizardPickParent() { return null; },
  async wizardSuggestDir(parent, name) { return (parent ? parent.replace(/[\\/]+$/, '') + '/' + name : name); },
  async wizardCreate(opts) { return post('/api/wizard/create', opts); },
  onWizardProgress(cb) { (this.subs['wizard-progress'] ||= []).push(cb); },
  async tpsClear(id) { return post(`/api/servers/${id}/tps/clear`); },
  async iconFromServer(cwd) {
    if (!cwd) return null;
    try {
      const r = await fetch('/api/icon?cwd=' + encodeURIComponent(cwd));
      if (!r.ok) return null;
      const d = await r.json();
      return d.dataUrl || null;
    } catch { return null; }
  },
  subs: {},
  onLog(cb) { (this.subs.log ||= []).push(cb); },
  onState(cb) { (this.subs.state ||= []).push(cb); },
  onServers(cb) { (this.subs.servers ||= []).push(cb); },
  onLogsCleared(cb) { (this.subs['logs-cleared'] ||= []).push(cb); },
  onTps(cb) { (this.subs.tps ||= []).push(cb); },
  onMetrics(cb) { (this.subs.metrics ||= []).push(cb); },
  onToast() { /* в браузере тостов от процесса нет */ },
  onScanFound(cb) { (this.subs['scan-found'] ||= []).push(cb); },
  onScanProgress(cb) { (this.subs['scan-progress'] ||= []).push(cb); },
  connect() {
    const es = new EventSource('/api/events');
    for (const name of ['log', 'state', 'servers', 'logs-cleared', 'tps', 'metrics', 'scan-found', 'scan-progress', 'wizard-progress']) {
      es.addEventListener(name, (e) => {
        const data = JSON.parse(e.data);
        for (const cb of this.subs[name] || []) cb(data);
      });
    }
  },
};

async function post(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return r.json();
}

const API = window.desktop || httpApi;
const IS_DESKTOP = API.mode === 'desktop';

/* ═════════════════════ настройки интерфейса ═════════════════════ */

const THEMES = {
  dark: { label: 'Тёмная', bg: '#070708', panel: '#141417', text: '#ececee', accent: '#ffffff' },
  graphite: { label: 'Графит', bg: '#0f0f10', panel: '#19191b', text: '#ededed', accent: '#c9c9cf' },
  contrast: { label: 'Контраст', bg: '#000000', panel: '#131313', text: '#ffffff', accent: '#ffffff' },
  gray: { label: 'Серая', bg: '#22262b', panel: '#31373e', text: '#dfe3e8', accent: '#ffffff' },
  navy: { label: 'Ночь', bg: '#0a0d14', panel: '#121722', text: '#e6ebf5', accent: '#6ea8fe' },
  ocean: { label: 'Океан', bg: '#08100f', panel: '#111c1b', text: '#e3f1ef', accent: '#4fc3b5' },
  forest: { label: 'Лес', bg: '#0b110d', panel: '#131b15', text: '#e6efe8', accent: '#63c98a' },
  amethyst: { label: 'Аметист', bg: '#0d0a14', panel: '#171225', text: '#ece9f6', accent: '#a78bfa' },
  sunset: { label: 'Закат', bg: '#120c10', panel: '#1d1419', text: '#f4e9ee', accent: '#f08a6c' },
  ember: { label: 'Уголь', bg: '#0d0c0a', panel: '#171614', text: '#f0efe9', accent: '#d9a13b' },
  steel: { label: 'Сталь', bg: '#0c1013', panel: '#151b20', text: '#e4edf2', accent: '#8fb8cc' },
  light: { label: 'Светлая', bg: '#f4f5f7', panel: '#ffffff', text: '#1a1c20', accent: '#111111' },
  paper: { label: 'Бумага', bg: '#f6f4ef', panel: '#ffffff', text: '#1b1a17', accent: '#111111' },
  snow: { label: 'Снег', bg: '#eef2f7', panel: '#ffffff', text: '#141a22', accent: '#1f6feb' },
  mint: { label: 'Мята', bg: '#eef5f1', panel: '#ffffff', text: '#12211a', accent: '#12855b' },
  sand: { label: 'Песок', bg: '#f5f1e8', panel: '#fffdf8', text: '#211d16', accent: '#a9743a' },
  custom: { label: 'Кастом', bg: '#0f1014', panel: '#181b22', text: '#e8eaf0', accent: '#8ab4ff' },
};

const prefs = {
  sound: localStorage.getItem('lsp.sound') !== '0',
  fx: localStorage.getItem('lsp.fx') !== '0',
  colors: localStorage.getItem('lsp.colors') === '1',
  autoscroll: localStorage.getItem('lsp.autoscroll') !== '0',
  volume: Number(localStorage.getItem('lsp.volume') ?? 45) / 100,
  theme: localStorage.getItem('lsp.theme') || 'dark',
  radius: localStorage.getItem('lsp.radius') || 'soft',
  startMode: localStorage.getItem('lsp.startMode') || 'window',
  // 0 — под размер окна. Новый ключ: у старых версий масштаб был зафиксирован,
  // поэтому один раз переводим настройку в «под окно».
  density: localStorage.getItem('lsp.density') || 'normal',
  notifSound: localStorage.getItem('lsp.notifSound') !== '0',
  notifMs: Number(localStorage.getItem('lsp.notifMs') || 4200),
  // фон панели: id встроенных обоев, 'custom' или 'none'
  wall: localStorage.getItem('lsp.wall') || 'none',
  wallName: localStorage.getItem('lsp.wallName') || '',
  wallFit: localStorage.getItem('lsp.wallFit') || 'cover',
  wallBlur: Number(localStorage.getItem('lsp.wallBlur') || 0),
  wallVis: Number(localStorage.getItem('lsp.wallVis') || 100) / 100,
  // цветокоррекция всего интерфейса
  hue: Number(localStorage.getItem('lsp.hue') || 0),
  sat: Number(localStorage.getItem('lsp.sat') || 100),
  bright: Number(localStorage.getItem('lsp.bright') || 100),
  contrast: Number(localStorage.getItem('lsp.contrast') || 100),
  alpha: Number(localStorage.getItem('lsp.alpha') || 100) / 100,
  glass: Number(localStorage.getItem('lsp.glass') || 0),
  wallRecent: JSON.parse(localStorage.getItem('lsp.wallRecent') || '[]'),
  themes: JSON.parse(localStorage.getItem('lsp.themes') || '[]'),
  notif: localStorage.getItem('lsp.notif') !== '0',
  desktopNotif: localStorage.getItem('lsp.desktopNotif') !== '0',
  // вид эффекта от клика: wave | dot | ring | cross | off
  clickFx: localStorage.getItem('lsp.clickFx') || 'wave',
  // набор звуков интерфейса: soft | mech | bell | deep | pop
  soundPack: localStorage.getItem('lsp.soundPack') || 'soft',
  custom: JSON.parse(localStorage.getItem('lsp.custom') || 'null') || {
    bg: '#0f1014', panel: '#181b22', text: '#e8eaf0', accent: '#8ab4ff',
  },
  save() {
    localStorage.setItem('lsp.sound', this.sound ? '1' : '0');
    localStorage.setItem('lsp.fx', this.fx ? '1' : '0');
    localStorage.setItem('lsp.colors', this.colors ? '1' : '0');
    localStorage.setItem('lsp.autoscroll', this.autoscroll ? '1' : '0');
    localStorage.setItem('lsp.volume', String(Math.round(this.volume * 100)));
    localStorage.setItem('lsp.theme', this.theme);
    localStorage.setItem('lsp.radius', this.radius);
    localStorage.setItem('lsp.startMode', this.startMode);
    localStorage.setItem('lsp.density', this.density);
    localStorage.setItem('lsp.notifSound', this.notifSound ? '1' : '0');
    localStorage.setItem('lsp.notifMs', String(this.notifMs));
    localStorage.setItem('lsp.wall', this.wall);
    localStorage.setItem('lsp.wallName', this.wallName || '');
    localStorage.setItem('lsp.wallFit', this.wallFit);
    localStorage.setItem('lsp.wallBlur', String(this.wallBlur));
    localStorage.setItem('lsp.wallVis', String(Math.round(this.wallVis * 100)));
    localStorage.setItem('lsp.hue', String(this.hue));
    localStorage.setItem('lsp.sat', String(this.sat));
    localStorage.setItem('lsp.bright', String(this.bright));
    localStorage.setItem('lsp.contrast', String(this.contrast));
    localStorage.setItem('lsp.alpha', String(Math.round(this.alpha * 100)));
    localStorage.setItem('lsp.glass', String(this.glass));
    localStorage.setItem('lsp.wallRecent', JSON.stringify(this.wallRecent.slice(0, 12)));
    localStorage.setItem('lsp.themes', JSON.stringify(this.themes));
    localStorage.setItem('lsp.notif', this.notif ? '1' : '0');
    localStorage.setItem('lsp.desktopNotif', this.desktopNotif ? '1' : '0');
    localStorage.setItem('lsp.clickFx', this.clickFx);
    localStorage.setItem('lsp.soundPack', this.soundPack);
    localStorage.setItem('lsp.custom', JSON.stringify(this.custom));
  },
};

/** Применяет тему, форму кнопок и кастомные цвета. */
/* Встроенные ч/б обои (лежат в assets/wallpapers) */
const WALLPAPERS = [
  { id: 'none', label: 'Без фона' },
  { id: 'aurora', label: 'Аврора', src: '../assets/wallpapers/aurora.png' },
  { id: 'grid', label: 'Сетка', src: '../assets/wallpapers/grid.png' },
  { id: 'waves', label: 'Волны', src: '../assets/wallpapers/waves.png' },
  { id: 'mountains', label: 'Горы', src: '../assets/wallpapers/mountains.png' },
  { id: 'dots', label: 'Точки', src: '../assets/wallpapers/dots.png' },
  { id: 'noise', label: 'Шум', src: '../assets/wallpapers/noise.jpg' },
  { id: 'stripes', label: 'Штрихи', src: '../assets/wallpapers/stripes.png' },
  { id: 'blobs', label: 'Пятна', src: '../assets/wallpapers/blobs.png' },
];

let bgVideo = null;

/** Слой фона: картинка / gif / видео из своих файлов или встроенных. */
function applyBackground() {
  let layer = document.getElementById('appBg');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'appBg';
    document.body.insertBefore(layer, document.body.firstChild);
  }

  const fit = { cover: 'cover', contain: 'contain', fill: 'fill', tile: 'auto' }[prefs.wallFit] || 'cover';
  const repeat = prefs.wallFit === 'tile' ? 'repeat' : 'no-repeat';
  const blur = prefs.wallBlur > 0 ? `blur(${prefs.wallBlur}px)` : 'none';
  const isVideo = /\.(mp4|webm)$/i.test(prefs.wallName || '');
  const src = prefs.wall === 'custom'
    ? (prefs.wallName && /^omni-wall:/.test(prefs.wallName) ? prefs.wallName : `omni-wall://${prefs.wallName}`)
    : (WALLPAPERS.find((w) => w.id === prefs.wall) || {}).src;

  if (bgVideo) { bgVideo.pause(); bgVideo = null; }
  layer.innerHTML = '';

  if (!src) {
    layer.classList.remove('ready');
    document.body.style.setProperty('--wall-vis', '1');
    return;
  }

  if (isVideo && prefs.wall === 'custom') {
    const v = document.createElement('video');
    v.src = src; v.muted = true; v.loop = true; v.autoplay = true; v.playsInline = true;
    v.className = 'bg-video';
    v.style.objectFit = fit;
    v.style.filter = blur;
    layer.appendChild(v);
    bgVideo = v;
    v.play().catch(() => { /* автоплей может быть заблокирован */ });
    const vrow = $('wallVidRow');
    if (vrow) vrow.classList.remove('hidden');
  } else {
    const img = document.createElement('img');
    img.className = 'bg-kimg';
    img.src = src;
    img.alt = '';
    img.style.objectFit = fit;
    img.style.backgroundRepeat = repeat;
    img.style.backgroundSize = fit;
    img.style.filter = blur;
    layer.appendChild(img);
    const vrow = $('wallVidRow');
    if (vrow) vrow.classList.add('hidden');
  }

  const tint = document.createElement('div');
  tint.className = 'bg-tint';
  layer.appendChild(tint);
  layer.classList.add('ready');
  document.body.style.setProperty('--wall-vis', String(prefs.wallVis));
}

/** Цветокоррекция и прозрачность всего интерфейса. */
function applyLook() {
  const root = document.documentElement;
  const filter = `hue-rotate(${prefs.hue}deg) saturate(${prefs.sat}%) brightness(${prefs.bright}%) contrast(${prefs.contrast}%)`;
  const plain = prefs.hue === 0 && prefs.sat === 100 && prefs.bright === 100 && prefs.contrast === 100;
  root.style.setProperty('--app-filter', plain ? 'none' : filter);
  root.style.setProperty('--panel-alpha', String(prefs.alpha));
  root.style.setProperty('--glass-blur', prefs.glass + 'px');

  document.body.classList.toggle('glass', prefs.glass > 0);
  document.body.classList.toggle('translucent', prefs.alpha < 1);
  // если панели прозрачные, а фона нет — подложка должна остаться читаемой
  document.body.classList.toggle('no-wallpaper', !prefs.wall || prefs.wall === 'none');

  const fmt = (id, v) => { const e = $(id); if (e) e.textContent = v; };
  fmt('fxHueVal', prefs.hue + '°');
  fmt('fxSatVal', prefs.sat + '%');
  fmt('fxBrightVal', prefs.bright + '%');
  fmt('fxContrastVal', prefs.contrast + '%');
  fmt('fxAlphaVal', prefs.alpha >= 1 ? 'непрозр.' : Math.round((1 - prefs.alpha) * 100) + '%');
  fmt('fxGlassVal', prefs.glass + ' px');

  for (const el of ['fxHue', 'fxSat', 'fxBright', 'fxContrast', 'fxGlass']) {
    const node = $(el);
    if (!node) continue;
    const key = { fxHue: 'hue', fxSat: 'sat', fxBright: 'bright', fxContrast: 'contrast', fxGlass: 'glass' }[el];
    node.value = prefs[key];
  }
  const alphaEl = $('fxAlpha');
  if (alphaEl) alphaEl.value = Math.round(prefs.alpha * 100);
  const visEl = $('wallBlur');
  if (visEl) visEl.value = prefs.wallBlur;
  const fitEl = $('wallFit');
  if (fitEl) fitEl.value = prefs.wallFit;

  const nameEl = $('wallName');
  if (nameEl) {
    const w = WALLPAPERS.find((x) => x.id === prefs.wall);
    nameEl.textContent = !prefs.wall || prefs.wall === 'none'
      ? 'фон не выбран'
      : (prefs.wall === 'custom' ? 'свой файл: ' + (prefs.wallName || '').replace(/^.*\//, '') : (w ? w.label : ''));
  }
  renderWallGrid();
}

/** Плитки выбора обоев */
function renderWallGrid() {
  const grid = $('wallGrid');
  if (!grid) return;
  grid.innerHTML = '';
  const items = WALLPAPERS.concat([{ id: 'custom', label: 'Своё' }]);
  for (const w of items) {
    const cell = document.createElement('button');
    cell.className = 'wall-cell' + (prefs.wall === w.id ? ' active' : '');
    if (w.id === 'none') {
      cell.innerHTML = '<span class="wall-none">нет</span>';
    } else if (w.id === 'custom') {
      const src = prefs.wallName ? `omni-wall://${prefs.wallName}` : '';
      const isVid = /\.(mp4|webm)$/i.test(prefs.wallName || '');
      cell.innerHTML = src && !isVid
        ? `<img src="${src}" alt=""><span class="wall-tag">своё</span>`
        : `<span class="wall-none">${src ? 'видео' : 'файл…'}</span>`;
    } else {
      cell.innerHTML = `<img src="${w.src}" alt=""><span class="wall-tag">${esc(w.label)}</span>`;
    }
    cell.onclick = async () => {
      if (w.id === 'custom') { await pickWallpaper(); return; }
      prefs.wall = w.id;
      // первый выбор фона: сразу делаем панели чуть прозрачными, чтобы обои читались
      if (w.id !== 'none' && prefs.alpha >= 1 && !prefs.glass) {
        prefs.alpha = 0.84;
        prefs.glass = 10;
      }
      if (w.id !== 'none') pushWallRecent({ kind: w.id, label: w.label });
      prefs.save();
      applyBackground();
      applyLook();
      Sound.play('click');
    };
    grid.appendChild(cell);
  }
}

async function pickWallpaper() {
  if (!IS_DESKTOP) { notify({ title: 'Только в exe-версии', text: 'Свой фон выбирается в приложении.', kind: 'err' }); return; }
  const res = await API.wallPick();
  if (!res) return;
  if (res.ok === false) { notify({ title: 'Не удалось', text: res.error || 'файл не подошёл', kind: 'err' }); return; }
  prefs.wall = 'custom';
  prefs.wallName = res.name;
  if (prefs.alpha >= 1 && !prefs.glass) { prefs.alpha = 0.84; prefs.glass = 10; }
  pushWallRecent({ kind: 'custom', name: res.name, label: res.name.replace(/^.*[\\/]/, '') });
  prefs.save();
  applyBackground();
  applyLook();
  notify({ title: 'Фон установлен', text: res.name, kind: 'ok' });
}

function applyTheme() {
  document.body.dataset.theme = prefs.theme;
  document.body.dataset.radius = prefs.radius;

  // сбрасываем инлайновые переменные от предыдущей темы
  const THEME_VARS = ['--bg', '--bg-2', '--bg-3', '--bg-4', '--line', '--line-2', '--line-3', '--text', '--dim', '--dim-2', '--white', '--strong-fg',
    '--side-grad-1', '--side-grad-2', '--top-grad-1', '--top-grad-2', '--hover-bd', '--focus-bd',
    '--inv-bg', '--inv-bg-h', '--inv-fg', '--ghost-bg', '--ghost-bd', '--ghost-fg', '--ghost-hover-bg', '--ghost-hover-bd',
    '--restart-hover-bg', '--restart-hover-bd', '--srv-hover-bg', '--srv-hover-bd', '--srv-active-bg', '--srv-active-bd',
    '--ico-bg', '--ico-bd', '--ico-fg', '--big-ico-bg', '--big-ico-fg', '--dot-off', '--dot-mid', '--dot-run', '--dot-run-glow',
    '--track', '--track-on', '--knob', '--knob-on', '--meta-sep', '--chip-bg', '--tps-fg', '--accent-bar',
    '--console-bg', '--line-t', '--msg-stdout', '--msg-info', '--msg-debug', '--msg-warn', '--msg-warn-line',
    '--msg-err', '--msg-err-bg', '--msg-err-line', '--msg-system', '--msg-input', '--msg-ok',
    '--menu-bg', '--menu-bd', '--menu-fg', '--menu-hover', '--menu-fg-h', '--code-bg', '--code-fg',
    '--foot-bg', '--scroll', '--scroll-hover', '--accent-check', '--warn', '--ed-bg', '--shadow-modal',
    '--syn-key', '--syn-str', '--syn-num', '--syn-bool', '--syn-cmt', '--syn-tag',
    '--line-4', '--alert-bd', '--alert-fg', '--wc-close-bg', '--wc-close-fg',
    '--fg', '--fg-dim', '--hover-bg'];
  for (const v of THEME_VARS) document.body.style.removeProperty(v);

  // все темы считаются по одной палитре: четыре базовых цвета + необязательные
  // уточнения (для своей темы их можно задать вручную)
  const pal = themePalette();
  const st = document.body.style;
  const set = (k, v) => st.setProperty(k, v);
  const bg = pal.bg, panel = pal.panel, text = pal.text, accent = pal.accent;

  set('--bg', bg);
  set('--bg-2', mix(bg, panel, 0.55));
  set('--bg-3', panel);
  set('--bg-4', mix(panel, text, 0.12));
  set('--line', pal.line || mix(bg, text, 0.14));
  set('--line-2', pal.line ? mix(pal.line, text, 0.14) : mix(bg, text, 0.26));
  set('--line-3', pal.line ? mix(pal.line, text, 0.3) : mix(bg, text, 0.34));
  set('--text', text);
  set('--dim', pal.dim || mix(text, bg, 0.42));
  set('--dim-2', pal.dim ? mix(pal.dim, bg, 0.45) : mix(text, bg, 0.62));
  set('--white', accent);
  set('--strong-fg', text);

  // «светлая» ли тема — от этого зависит, в какую сторону крутить оттенки
  const light = (hexToRgb(bg).reduce((a, b) => a + b, 0) / 3) > 140;
  const shade = (r) => mix(bg, light ? '#000000' : '#ffffff', r);

  set('--side-grad-1', mix(panel, bg, 0.35));
  set('--side-grad-2', bg);
  set('--top-grad-1', mix(panel, bg, 0.5));
  set('--top-grad-2', mix(panel, bg, 0.2));
  set('--hover-bd', mix(bg, text, 0.36));
  set('--focus-bd', mix(bg, text, 0.45));

  const btnBg = pal.btn || accent;
  const btnFg = pal.btnText || (light ? '#ffffff' : mix(bg, '#000000', 0.85));
  set('--inv-bg', btnBg);
  set('--inv-bg-h', mix(btnBg, text, 0.18));
  set('--inv-fg', btnFg);
  set('--ghost-bg', pal.ghost || 'transparent');
  set('--ghost-bd', mix(bg, text, 0.32));
  set('--ghost-fg', pal.ghostText || mix(text, bg, 0.12));
  set('--ghost-hover-bg', mix(panel, text, 0.08));
  set('--ghost-hover-bd', mix(bg, text, 0.46));
  set('--restart-hover-bg', mix(panel, text, 0.06));
  set('--restart-hover-bd', mix(bg, text, 0.55));

  set('--srv-hover-bg', mix(panel, text, 0.05));
  set('--srv-hover-bd', mix(bg, text, 0.2));
  set('--srv-active-bg', mix(panel, accent, 0.10));
  set('--srv-active-bd', mix(bg, text, 0.3));
  set('--ico-bg', pal.icon || mix(panel, text, 0.05));
  set('--ico-bd', mix(bg, text, 0.2));
  set('--ico-fg', mix(text, bg, 0.25));
  set('--big-ico-bg', pal.icon || mix(panel, text, 0.06));
  set('--big-ico-fg', mix(text, bg, 0.15));
  set('--dot-off', mix(bg, text, 0.3));
  set('--dot-mid', mix(text, bg, 0.3));
  set('--dot-run', accent);
  set('--dot-run-glow', `rgba(${hexToRgb(accent).join(',')},.8)`);
  set('--track', mix(panel, text, 0.1));
  set('--track-on', mix(panel, text, 0.28));
  set('--knob', mix(text, bg, 0.55));
  set('--knob-on', btnBg);
  set('--meta-sep', mix(bg, text, 0.3));
  set('--chip-bg', mix(panel, bg, 0.5));
  set('--tps-fg', text);
  set('--accent-bar', accent);

  set('--console-bg', shade(0.02));
  set('--line-t', mix(text, bg, 0.7));
  set('--msg-stdout', mix(text, bg, 0.12));
  set('--msg-info', mix(text, bg, 0.24));
  set('--msg-debug', mix(text, bg, 0.55));
  set('--msg-warn', text);
  set('--msg-warn-line', mix(bg, text, 0.3));
  set('--msg-err', text);
  set('--msg-err-bg', light ? 'rgba(0,0,0,.07)' : 'rgba(255,255,255,.07)');
  set('--msg-err-line', text);
  set('--msg-system', mix(text, bg, 0.45));
  set('--msg-input', text);
  set('--msg-ok', text);

  set('--menu-bg', mix(panel, bg, 0.3));
  set('--menu-bd', mix(bg, text, 0.28));
  set('--menu-fg', text);
  set('--menu-hover', mix(panel, text, 0.1));
  set('--menu-fg-h', accent);
  set('--code-bg', mix(panel, text, 0.07));
  set('--code-fg', mix(text, bg, 0.2));
  set('--foot-bg', mix(bg, panel, 0.6));
  set('--scroll', mix(bg, text, 0.22));
  set('--scroll-hover', mix(bg, text, 0.36));
  set('--accent-check', accent);
  set('--warn', mix(accent, '#d9a13b', 0.5));
  set('--ed-bg', shade(0.03));
  set('--shadow-modal', light ? '0 26px 80px rgba(20,25,35,.18)' : '0 26px 80px rgba(0,0,0,.7)');
  set('--syn-key', light ? '#1a56b8' : '#8ab4ff');
  set('--syn-str', light ? '#2f7a2f' : '#9ad69a');
  set('--syn-num', light ? '#a05a00' : '#e0b070');
  set('--syn-bool', light ? '#8b2f9c' : '#d38ee0');
  set('--syn-cmt', light ? '#8a8f98' : '#6b7280');
  set('--syn-tag', light ? '#0f6f78' : '#7ad0d6');

  set('--fg', text);
  set('--fg-dim', mix(text, bg, 0.42));
  set('--hover-bg', mix(panel, text, 0.1));
  set('--line-4', mix(bg, text, 0.42));
  set('--alert-bd', mix(panel, text, 0.22));
  set('--alert-fg', btnFg);
  set('--wc-close-bg', mix(panel, text, 0.14));
  set('--wc-close-fg', text);
}

/** Палитра текущей темы: для «Кастома» — свои цвета, для остальных — из набора. */
function themePalette() {
  if (prefs.theme === 'custom') {
    const c = prefs.custom || {};
    const base = THEMES.custom;
    return {
      bg: c.bg || base.bg,
      panel: c.panel || base.panel,
      text: c.text || base.text,
      accent: c.accent || base.accent,
      dim: c.dim || '',
      line: c.line || '',
      btn: c.btn || '',
      btnText: c.btnText || '',
      ghost: c.ghost || '',
      ghostText: c.ghostText || '',
      icon: c.icon || '',
    };
  }
  const t = THEMES[prefs.theme] || THEMES.dark;
  return { bg: t.bg, panel: t.panel, text: t.text, accent: t.accent };
}

/** Цвета своей темы: id поля → ключ в prefs.custom. */
const CUSTOM_COLOR_KEYS = {
  cBg: 'bg',
  cPanel: 'panel',
  cLine: 'line',
  cText: 'text',
  cDim: 'dim',
  cAccent: 'accent',
  cBtn: 'btn',
  cBtnText: 'btnText',
  cGhost: 'ghost',
  cGhostText: 'ghostText',
  cIcon: 'icon',
};

const CUSTOM_DEFAULTS = {
  bg: '#0f1014',
  panel: '#181b22',
  line: '#2a2c34',
  text: '#e8eaf0',
  dim: '#9a9daa',
  accent: '#8ab4ff',
  btn: '#8ab4ff',
  btnText: '#0b0d12',
  ghost: '#1c1f27',
  ghostText: '#e8eaf0',
  icon: '#1c1f27',
};

/** Подставляет текущие цвета своей темы в поля настроек. */
function syncCustomColors() {
  const c = prefs.custom || {};
  for (const [id, key] of Object.entries(CUSTOM_COLOR_KEYS)) {
    const input = $(id);
    if (!input) continue;
    const value = c[key] || mix(THEMES.custom.bg, '#ffffff', 0.5);
    if (/^#[0-9a-f]{6}$/i.test(value)) input.value = value;
  }
}

/** Смешивает два hex-цвета. ratio — доля второго цвета. */
function mix(a, b, ratio) {
  const pa = hexToRgb(a), pb = hexToRgb(b);
  const c = pa.map((v, i) => Math.round(v + (pb[i] - v) * ratio));
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}
function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  return [parseInt(h.slice(0, 2), 16) || 0, parseInt(h.slice(2, 4), 16) || 0, parseInt(h.slice(4, 6), 16) || 0];
}

/* ═════════════════════ эффект от клика ═════════════════════ */

function fxLayer() {
  let layer = document.getElementById('fxLayer');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'fxLayer';
    layer.className = 'fx-layer';
    document.body.appendChild(layer);
  }
  return layer;
}

/** Рисует эффект в точке клика: точка, кольцо, крест. */
function clickFxAt(x, y, kind) {
  if (!prefs.fx || !kind || kind === 'off' || kind === 'wave') return;
  const el = document.createElement('span');
  el.className = 'cfx cfx-' + kind;
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  fxLayer().appendChild(el);
  setTimeout(() => el.remove(), 640);
}

/* ═════════════════════ звуки (WebAudio, без файлов) ═════════════════════ */

/**
 * Наборы звуков: одна и та же логика, разные тембры.
 * mul — множитель частоты, type — форма волны, len — длина, gain — громкость.
 */
const SOUND_PACKS = {
  soft: { label: 'Мягкие', type: 'sine', mul: 1, len: 1, gain: 1, cut: 2600 },
  mech: { label: 'Механические', type: 'square', mul: 0.62, len: 0.55, gain: 0.55, cut: 1500 },
  bell: { label: 'Колокольчики', type: 'triangle', mul: 1.9, len: 1.5, gain: 0.75, cut: 5200 },
  deep: { label: 'Низкие', type: 'sine', mul: 0.55, len: 1.35, gain: 1.25, cut: 1400 },
  pop: { label: 'Поп', type: 'triangle', mul: 1.25, len: 0.6, gain: 0.9, cut: 3200 },
};

const Sound = {
  ctx: null,
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  },
  pack() {
    return SOUND_PACKS[prefs.soundPack] || SOUND_PACKS.soft;
  },
  /** Мягкий тон: плавная атака и длинный хвост — без резких щелчков. */
  tone({ freq = 520, to = null, dur = 0.09, type = null, gain = 0.02, delay = 0 }) {
    const ctx = this.ensure();
    if (!ctx) return;
    const vol = Math.max(0, Math.min(1, prefs.volume));
    if (vol <= 0) return;

    const pk = this.pack();
    freq *= pk.mul;
    if (to) to *= pk.mul;
    dur *= pk.len;
    gain *= pk.gain;
    type = type && pk.type === 'sine' ? type : pk.type;

    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    // фильтр срезает «стеклянные» высокие призвуки
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = pk.cut;

    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(40, to), t0 + dur);

    const peak = gain * vol;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + Math.min(0.03, dur * 0.35)); // плавная атака
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);                      // длинный хвост

    osc.connect(lp).connect(g).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  },
  play(kind) {
    if (!prefs.sound) return;
    switch (kind) {
      case 'click': this.tone({ freq: 540, to: 470, dur: 0.07, gain: 0.016 }); break;
      case 'nav': this.tone({ freq: 400, to: 460, dur: 0.1, gain: 0.014 }); break;
      case 'type': this.tone({ freq: 900, to: 780, dur: 0.03, gain: 0.006 }); break;
      case 'start':
        this.tone({ freq: 392, to: 523, dur: 0.16, gain: 0.022 });
        this.tone({ freq: 523, to: 659, dur: 0.2, gain: 0.018, delay: 0.12 });
        break;
      case 'stop':
        this.tone({ freq: 494, to: 349, dur: 0.18, gain: 0.02 });
        this.tone({ freq: 349, to: 262, dur: 0.22, gain: 0.016, delay: 0.13 });
        break;
      case 'ok':
        this.tone({ freq: 587, dur: 0.11, gain: 0.02 });
        this.tone({ freq: 880, dur: 0.16, gain: 0.016, delay: 0.09 });
        break;
      case 'err':
        this.tone({ freq: 262, to: 196, dur: 0.28, gain: 0.022 });
        break;
      default: break;
    }
  },
};

/* ═════════════════════ состояние ═════════════════════ */

const S = {
  servers: [],
  currentId: null,
  filter: '',
  domLines: [],
  info: null,
  tps: new Map(),      // id -> {tps, history}
  tpsFull: new Map(),  // id -> [{t,v}]
  metrics: new Map(),  // id -> {cpu, rss, procs, history}
  backups: [],
  tab: 'console',
  players: new Map(),   // id -> {names:Set, max, at}
  issues: new Map(),    // id -> [{id, t, kind, line, stack}]
  issuesNew: new Map(), // id -> сколько непрочитанных
  addonList: [],          // аддоны панели
  addonOpen: '',          // id открытого аддона
  addons: {               // вкладка плагинов
    type: 'plugin', loader: '', version: '', category: '', sort: 'relevance',
    query: '', hits: [], offset: 0, total: 0, loading: false,
    info: null, installed: { plugins: [], mods: [] },
  },
  scan: {
    running: false, results: [], seen: new Set(), byPath: new Map(),
    types: ['minecraft', 'script', 'exe', 'node', 'python'],
    depthIdx: Number(localStorage.getItem('lsp.scanDepth') ?? 1) || 0,
  },
};

// Что именно ищем. «exe» намеренно выключен по умолчанию:
// иначе в результаты попадают любые приложения с именем server.exe / start.exe.
const SCAN_TYPES = [
  { id: 'minecraft', label: 'Minecraft-сервер' },
  { id: 'script', label: 'bat/cmd-серверы' },
  { id: 'exe', label: 'exe-серверы' },
  { id: 'node', label: 'Node.js' },
  { id: 'python', label: 'Python' },
  { id: 'minecraft-plugin', label: 'папки плагинов' },
];

// по умолчанию ищем всё, кроме «папок плагинов»
const DEFAULT_SCAN_TYPES = ['minecraft', 'script', 'exe', 'node', 'python'];

const KIND_LABEL = {
  minecraft: 'minecraft',
  'minecraft-plugin': 'плагины',
  node: 'node.js',
  python: 'python',
  exe: 'exe',
  script: 'скрипт',
};

const LOG_CACHE = new Map();
let loadSeq = 0;
let pendingIcon = '';   // иконка, выбранная в модалке
let editingId = null;
let ctxServerId = null;

const $ = (id) => document.getElementById(id);

const el = {
  list: $('serverList'), count: $('countBadge'), runningCount: $('runningCount'),
  empty: $('empty'), view: $('view'),
  dot: $('statusDot'), name: $('serverName'), stateText: $('stateText'),
  uptime: $('uptimeText'), pid: $('pidText'),
  bigIcon: $('bigIcon'), tpsBadge: $('tpsBadge'), tpsVal: $('tpsVal'), tpsSpark: $('tpsSpark'),
  btnStart: $('btnStart'), btnStop: $('btnStop'), btnRestart: $('btnRestart'),
  btnKill: $('btnKill'), btnSettings: $('btnSettings'), btnFolder: $('btnFolder'), btnEditor: $('btnEditor'),
  consoleEl: $('console'), filter: $('logFilter'), autoscroll: $('autoscroll'),
  cmd: $('cmdInput'), cmdSend: $('cmdSend'), btnClear: $('btnClear'), btnDownload: $('btnDownload'),
  modal: $('modal'), modalTitle: $('modalTitle'), ctx: $('ctx'),
  toasts: $('toasts'),
  scanModal: $('scanModal'), scanResults: $('scanResults'), scanProgress: $('scanProgress'),
  cfModal: $('confirmModal'), cfTitle: $('cfTitle'), cfText: $('cfText'), cfOk: $('cfOk'),
  cpuNow: $('cpuNow'), ramNow: $('ramNow'), procNow: $('procNow'),
  cpuChart: $('cpuChart'), ramChart: $('ramChart'), tpsChart: $('tpsChart'),
  tpsStats: $('tpsStats'), backupList: $('backupList'), backupSub: $('backupSub'),
};

/* ═════════════════ графика (SVG, без библиотек) ═════════════════ */

function fmtBytes(b) {
  if (!b) return '0 Б';
  const u = ['Б', 'КБ', 'МБ', 'ГБ'];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

/**
 * Рисует линейный график.
 * @param {HTMLElement} host
 * @param {Array<{t:number, v:number}>} points
 * @param {{unit?:string, min?:number, max?:number, fixedMax?:number, color?:string}} opts
 */
function drawChart(host, points, opts = {}) {
  if (!host) return;
  const W = host.clientWidth || 400;
  const H = host.clientHeight || 110;
  const pad = { l: 34, r: 6, t: 8, b: 16 };

  if (!points || points.length < 2) {
    host.innerHTML = `<svg viewBox="0 0 ${W} ${H}"><text class="empty" x="${W / 2}" y="${H / 2}" text-anchor="middle">данных пока нет</text></svg>`;
    return;
  }

  const values = points.map((p) => p.v).filter((v) => Number.isFinite(v));
  let max = opts.fixedMax != null ? opts.fixedMax : Math.max(...values);
  let min = opts.min != null ? opts.min : Math.min(...values);
  if (max === min) max = min + 1;
  const padTop = opts.fixedMax != null ? 0 : (max - min) * 0.15;
  max += padTop;
  if (opts.max != null) max = Math.max(max, opts.max);

  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const span = Math.max(1, t1 - t0);

  const x = (t) => pad.l + ((t - t0) / span) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - min) / (max - min)) * (H - pad.t - pad.b);

  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const area = `${path} L${x(t1).toFixed(1)},${y(min).toFixed(1)} L${x(t0).toFixed(1)},${y(min).toFixed(1)} Z`;

  // подписи осей
  const yTicks = 3;
  let axis = '';
  for (let i = 0; i <= yTicks; i++) {
    const v = min + ((max - min) / yTicks) * i;
    const yy = y(v);
    axis += `<line class="grid" x1="${pad.l}" y1="${yy.toFixed(1)}" x2="${W - pad.r}" y2="${yy.toFixed(1)}"/>`;
    axis += `<text class="lbl" x="${pad.l - 5}" y="${(yy + 3).toFixed(1)}" text-anchor="end">${v >= 100 ? Math.round(v) : v.toFixed(v < 10 ? 1 : 0)}</text>`;
  }
  const timeLbl = (t) => new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  axis += `<text class="lbl" x="${pad.l}" y="${H - 4}" text-anchor="start">${timeLbl(t0)}</text>`;
  axis += `<text class="lbl" x="${W - pad.r}" y="${H - 4}" text-anchor="end">${timeLbl(t1)}</text>`;

  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    ${axis}
    <path class="area" d="${area}"/>
    <path class="line" d="${path}" ${opts.color ? `style="stroke:${opts.color}"` : ''}/>
  </svg>`;
}

/* ═════════════════════ редактор файлов ═════════════════════ */

const FM_MAX_TABS = 16;   // сколько файлов можно держать открытыми сразу

const FM = {
  bound: false,
  root: '',          // рабочая папка открытого сервера
  openPath: '',      // путь открытого файла (относительно папки сервера)
  content: '',       // что сейчас в редакторе
  saved: '',         // что лежит на диске
  kind: 'text',
  binary: false,
  expanded: new Set(),
  tabs: [],          // открытые файлы: {path, kind, binary, content, saved, dirty, view, archive, image, message}
  activeIdx: -1,
  view: 'text',      // text | image | archive | binary
  lastDir: '',       // папка, в которой создаём файлы (последняя выбранная в дереве)
  dragPath: '',      // что тащим мышкой
  wikiOpen: false,
  searchTimer: null,
};

/** Открытый файл (вкладка) или null. */
function fmActive() {
  return FM.activeIdx >= 0 ? FM.tabs[FM.activeIdx] || null : null;
}

/** Папка файла: 'plugins/A/x.yml' → 'plugins/A'. */
function fmDirOf(rel) {
  const clean = String(rel || '').replace(/\/+$/, '');
  const i = clean.lastIndexOf('/');
  return i < 0 ? '' : clean.slice(0, i);
}

/** Иконка элемента дерева файлов (SVG, а не эмодзи). */
function fmIcon(kind, isDir, expanded) {
  if (isDir) return ico(expanded ? 'folderOpen' : 'folder', 13, 1.6);
  if (kind === 'yaml' || kind === 'json' || kind === 'js') return ico('fileCode', 13, 1.6);
  if (kind === 'properties') return ico('fileCog', 13, 1.6);
  if (kind === 'archive' || kind === 'archive-other' || kind === 'binary') return ico('fileArchive', 13, 1.6);
  if (kind === 'image') return ico('image', 13, 1.6);
  return ico('file', 13, 1.6);
}

function fmEl(id) { return document.getElementById(id); }

function fmOpenServer() {
  const s = current();
  if (!s || !s.cwd) return false;
  if (FM.root !== s.cwd) {
    FM.root = s.cwd;
    FM.openPath = '';
    FM.content = '';
    FM.saved = '';
    FM.expanded = new Set();
    FM.tabs = [];
    FM.activeIdx = -1;
    FM.lastDir = '';
    fmRenderTabs();
    fmEl('fmText').value = '';
    fmEl('fmText').disabled = true;
    fmEl('fmCrumb').textContent = 'файл не выбран';
    fmEl('fmPath').textContent = s.cwd;
    fmRenderHighlight();
    fmRenderGutter();
    fmSetDirty(false);
  }
  return true;
}

async function fmLoadTree() {
  const s = current();
  if (!s || !s.cwd) {
    fmEl('fmTree').innerHTML = '<div class="fm-empty">У сервера не задана рабочая папка.<br>Открой «Настройки» и укажи её.</div>';
    return;
  }
  fmOpenServer();
  fmEl('fmPath').textContent = FM.root;
  const host = fmEl('fmTree');
  host.innerHTML = '<div class="fm-empty">Читаю папку…</div>';
  await fmRenderDir('', host, 0, true);
}

async function fmRenderDir(rel, host, depth, isRoot = false) {
  const s = current();
  if (!s) return;
  const res = await API.filesList(s.id, rel);
  if (!res || res.ok === false || res.error) {
    host.innerHTML = `<div class="fm-empty">${esc((res && res.error) || 'Не удалось прочитать папку')}</div>`;
    return;
  }
  const items = res.items || [];
  host.innerHTML = '';
  if (!items.length) {
    if (isRoot) host.innerHTML = '<div class="fm-empty">Папка пуста</div>';
    return;
  }
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'fm-row' + (it.path === FM.openPath ? ' active' : '');
    row.dataset.path = it.path;
    row.dataset.dir = it.isDir ? '1' : '';
    row.draggable = true;
    if (it.isDir) row.dataset.dropRel = it.path;
    const pad = 7 + depth * 12;
    row.style.paddingLeft = pad + 'px';
    const open = FM.expanded.has(it.path);
    row.innerHTML = `<span class="arrow">${it.isDir ? ico(open ? 'chevronDown' : 'chevronRight', 10, 2) : ''}</span>`
      + `<span class="ico">${fmIcon(it.kind, it.isDir, open)}</span>`
      + `<span class="nm">${esc(it.name)}</span>`
      + (it.isDir ? '' : `<span class="tag">${fmSize(it.size)}</span>`);
    host.appendChild(row);

    if (it.isDir) {
      const kids = document.createElement('div');
      kids.className = 'fm-kids';
      kids.dataset.parent = it.path;
      host.appendChild(kids);
      if (FM.expanded.has(it.path)) await fmRenderDir(it.path, kids, depth + 1);

      row.onclick = async () => {
        if (FM.expanded.has(it.path)) {
          FM.expanded.delete(it.path);
          row.querySelector('.arrow').innerHTML = ico('chevronRight', 10, 2);
          kids.innerHTML = '';
        } else {
          FM.expanded.add(it.path);
          row.querySelector('.arrow').innerHTML = ico('chevronDown', 10, 2);
          kids.innerHTML = '<div class="fm-empty">…</div>';
          await fmRenderDir(it.path, kids, depth + 1);
        }
        Sound.play('click');
      };
    } else {
      row.onclick = () => fmOpenFile(it.path);
    }

    row.oncontextmenu = (ev) => {
      const menu = [];
      if (!it.isDir) menu.push({ label: 'Открыть', act: () => fmOpenFile(it.path) });
      if (it.isDir) menu.push({ label: 'Новый файл здесь', act: () => fmNewFile(it.path) });
      menu.push({ label: 'Переименовать', act: () => fmRename(it) });
      menu.push({ label: 'Удалить', danger: true, act: () => fmDelete(it) });
      menu.push({ sep: true });
      menu.push({ label: 'Открыть в проводнике', disabled: !IS_DESKTOP, act: () => API.filesOpenExternal(current().id, it.path) });
      showMenu(ev, menu);
    };

    /* ── перетаскивание файлов и папок между папками ── */
    row.addEventListener('dragstart', (ev) => {
      FM.dragPath = it.path;
      row.classList.add('dragging');
      try {
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', it.path);
      } catch { /* старые движки */ }
    });
    row.addEventListener('dragend', () => {
      FM.dragPath = '';
      row.classList.remove('dragging');
      for (const el of document.querySelectorAll('.fm-row.drop-on')) el.classList.remove('drop-on');
      fmEl('fmTree').classList.remove('drop-on');
    });
    if (it.isDir) {
      row.addEventListener('dragover', (ev) => {
        if (!FM.dragPath) return;
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'move';
        row.classList.add('drop-on');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-on'));
      row.addEventListener('drop', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        row.classList.remove('drop-on');
        await fmMoveInto(it.path);
      });
    }
  }
}

/** Перенос перетаскиванием: FM.dragPath → toDir. */
async function fmMoveInto(toDir) {
  const s = current();
  const from = FM.dragPath;
  if (!s || !from) return;
  if (from === toDir) return;
  if (toDir === fmDirOf(from)) return;                 // уже там
  if (toDir.startsWith(from + '/')) {
    toast('Нельзя перенести папку внутрь себя', 'err');
    return;
  }
  FM.dragPath = '';
  const res = await API.filesMove(s.id, from, toDir);
  if (!res || res.ok === false || res.error) {
    toast((res && res.error) || 'Не удалось перенести', 'err');
    return;
  }
  const tab = FM.tabs.find((t) => t.path === from);
  if (tab) tab.path = res.path;
  if (FM.openPath === from) FM.openPath = res.path;
  FM.expanded.add(toDir);
  FM.lastDir = toDir;
  await fmLoadTree();
  Sound.play('ok');
  toast(`Перенесено в «${toDir || 'корень сервера'}»`, 'ok');
}

function fmSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return bytes + ' Б';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1).replace('.', ',') + ' КБ';
  return (bytes / 1048576).toFixed(1).replace('.', ',') + ' МБ';
}

/** Сохраняет то, что сейчас в редакторе, в активную вкладку. */
function fmSnapshot() {
  const t = fmActive();
  if (!t) return;
  if (FM.view === 'text' || FM.view === 'binary') {
    t.content = fmEl('fmText').value;
    t.dirty = !t.binary && t.content !== t.saved;
  }
}

function fmRenderTabs() {
  const host = fmEl('fmTabs');
  if (!host) return;
  if (!FM.tabs.length) {
    host.innerHTML = '';
    host.classList.add('hidden');
    return;
  }
  host.classList.remove('hidden');
  host.innerHTML = FM.tabs.map((t, i) => {
    const name = t.path.split('/').pop();
    const cls = ['fm-tab'];
    if (i === FM.activeIdx) cls.push('active');
    if (t.dirty) cls.push('dirty');
    const mark = t.kind === 'archive' ? ico('fileArchive', 11, 1.6)
      : t.kind === 'image' ? ico('image', 11, 1.6)
        : '';
    return `<div class="${cls.join(' ')}" data-tab="${i}">`
      + `<span class="ft-ico">${mark}</span>`
      + `<span class="ft-nm">${esc(name)}</span>`
      + `<span class="ft-x" data-close="${i}">${ico('close', 10, 2)}</span>`
      + '</div>';
  }).join('') + `<span class="fm-tab-count">${FM.tabs.length}/${FM_MAX_TABS}</span>`;
}

/** Показывает активную вкладку: текст, картинку или содержимое архива. */
function fmRenderView() {
  const t = fmActive();
  const gutter = document.querySelector('.fm-gutter');
  const wrap = document.querySelector('.fm-codewrap');
  const arcBox = fmEl('fmArchive');
  const imgBox = fmEl('fmImageBox');
  const ta = fmEl('fmText');
  const extractBtn = fmEl('fmExtractAll');

  const show = (which) => {
    if (gutter) gutter.classList.toggle('hidden', which !== 'text');
    if (wrap) wrap.classList.toggle('hidden', which !== 'text');
    arcBox.classList.toggle('hidden', which !== 'archive');
    imgBox.classList.toggle('hidden', which !== 'image');
    if (extractBtn) extractBtn.classList.toggle('hidden', which !== 'archive');
  };

  if (!t) {
    show('text');
    ta.value = '';
    ta.disabled = true;
    ta.placeholder = 'Выбери файл слева';
    FM.view = 'text';
    FM.openPath = '';
    fmEl('fmCrumb').textContent = 'файл не выбран';
    fmEl('fmKind').textContent = '—';
    fmEl('fmSize').textContent = '—';
    fmRenderHighlight();
    fmRenderGutter();
    fmSetDirty(false);
    return;
  }

  FM.openPath = t.path;
  FM.kind = t.kind;
  FM.binary = !!t.binary;
  FM.view = t.view;
  fmEl('fmCrumb').textContent = t.path;
  fmEl('fmPath').textContent = t.path;
  fmEl('fmPos').classList.toggle('hidden', t.view !== 'text');
  fmEl('fmKind').textContent = t.view === 'archive' ? 'архив'
    : t.view === 'image' ? 'картинка'
      : t.binary ? 'binary' : t.kind;
  fmEl('fmSize').textContent = fmSize(t.size);

  if (t.view === 'archive') {
    show('archive');
    fmRenderArchive();
  } else if (t.view === 'image') {
    show('image');
    fmEl('fmImage').src = t.image || '';
  } else {
    show('text');
    ta.disabled = !!t.binary;
    ta.value = t.content || '';
    ta.placeholder = t.binary ? (t.message || 'Двоичный файл — только просмотр') : 'Выбери файл слева';
    fmRenderHighlight();
    fmRenderGutter();
    fmUpdatePos();
  }
  fmSetDirty(!!t.dirty);
  for (const row of document.querySelectorAll('#fmTree .fm-row')) {
    row.classList.toggle('active', row.dataset.path === t.path);
  }
  fmRenderTabs();
}

/** Список файлов внутри zip-архива с кнопками распаковки. */
function fmRenderArchive() {
  const t = fmActive();
  const host = fmEl('fmArchive');
  if (!t) return;
  const a = t.archive;
  if (!a || a.ok === false || a.error) {
    host.innerHTML = `<div class="fm-empty">${esc((a && a.error) || t.message || 'Архив не открылся')}</div>`;
    return;
  }
  const rows = a.entries.slice(0, 800).map((e) => `<div class="far-row" data-name="${esc(e.name)}">`
    + `<span class="fa-nm">${esc(e.name)}</span>`
    + `<span class="fa-sz">${fmSize(e.size)}</span>`
    + `<button class="btn btn-mini" data-unpack="${esc(e.name)}">Распаковать</button>`
    + '</div>').join('');
  host.innerHTML = '<div class="far-head">'
    + `<span class="fh-name">Содержимое архива</span>`
    + `<span class="fh-meta">${a.total} файлов · внутри ${fmSize(a.raw)} · архив ${fmSize(a.size)}</span>`
    + '</div>'
    + `<div class="far-list">${rows}${a.entries.length > 800 ? '<div class="far-more">показаны первые 800 файлов</div>' : ''}</div>`
    + '<div id="fmArchivePreview" class="far-preview hidden"></div>';
}

/** Просмотр одного файла из архива — по клику по строке. */
async function fmArchivePreview(name) {
  const t = fmActive();
  const s = current();
  if (!t || !s) return;
  const host = fmEl('fmArchivePreview');
  host.classList.remove('hidden');
  host.innerHTML = '<div class="fm-empty">Читаю…</div>';
  const res = await API.archiveRead(s.id, t.path, name);
  if (!res || res.ok === false || res.error) {
    host.innerHTML = `<div class="fm-empty">${esc((res && res.error) || 'Не удалось прочитать файл')}</div>`;
    return;
  }
  host.innerHTML = `<div class="far-preview-head"><span>${esc(name)}</span><button class="btn btn-mini" id="fmArchivePreviewClose">Закрыть</button></div>`;
  fmEl('fmArchivePreviewClose').onclick = () => host.classList.add('hidden');
  if (res.kind === 'image') {
    const img = document.createElement('img');
    img.className = 'far-preview-img';
    img.src = res.dataUrl;
    host.appendChild(img);
  } else {
    const pre = document.createElement('pre');
    pre.className = 'far-preview-text';
    pre.textContent = res.content || '';
    host.appendChild(pre);
  }
}

/** Распаковка архива: весь или один файл — рядом с архивом. */
async function fmExtractArchive(onlyName) {
  const t = fmActive();
  const s = current();
  if (!t || !s) return;
  const dest = fmDirOf(t.path);
  const res = await API.archiveExtract(s.id, t.path, dest, onlyName || '');
  if (!res || res.ok === false || res.error) {
    toast((res && res.error) || 'Не удалось распаковать', 'err');
    return;
  }
  await fmLoadTree();
  Sound.play('ok');
  toast(onlyName ? `Распакован ${onlyName}` : `Распаковано ${res.files} файлов в «${dest || 'корень сервера'}»`, 'ok');
}

async function fmOpenFile(rel) {
  const s = current();
  if (!s) return;
  const existing = FM.tabs.findIndex((t) => t.path === rel);
  if (existing >= 0) {
    await fmSelectTab(existing);
    return;
  }
  if (FM.tabs.length >= FM_MAX_TABS) {
    toast(`Открыто ${FM_MAX_TABS} файлов — закрой одну вкладку`, 'err');
    return;
  }
  const res = await API.filesRead(s.id, rel);
  if (!res || res.ok === false || res.error) {
    toast((res && res.error) || 'Не удалось открыть файл', 'err');
    return;
  }
  const tab = {
    path: res.path || rel,
    kind: res.kind || 'text',
    binary: !!res.binary,
    content: res.content || '',
    saved: res.content || '',
    dirty: false,
    size: res.size || 0,
    message: res.message || '',
    view: 'text',
    archive: null,
    image: '',
  };

  if (tab.kind === 'archive' || tab.kind === 'archive-other') {
    tab.view = 'archive';
    tab.archive = await API.archiveOpen(s.id, tab.path);
  } else if (tab.kind === 'image') {
    tab.view = 'image';
    const img = await API.filesImage(s.id, tab.path);
    if (img && img.ok !== false && !img.error) tab.image = img.dataUrl;
    else tab.message = (img && img.error) || 'Картинка не открылась';
  } else if (tab.binary) {
    tab.view = 'text';
  }

  FM.tabs.push(tab);
  await fmSelectTab(FM.tabs.length - 1);

  // у файлов MythicMobs сразу показываем шпаргалку
  if (/mythicmobs/i.test(tab.path) && !FM.wikiOpen) fmToggleWiki(true);
  Sound.play('click');
}

/** Переключение на вкладку по номеру. */
async function fmSelectTab(idx) {
  fmSnapshot();
  if (idx < 0 || idx >= FM.tabs.length) {
    FM.activeIdx = -1;
    fmRenderView();
    fmRenderTabs();
    return;
  }
  FM.activeIdx = idx;
  fmRenderView();
  fmEl('fmText').scrollTop = 0;
  fmEl('fmText').scrollLeft = 0;
  fmSyncScroll();
}

/** Закрытие вкладки (с проверкой несохранённых правок). */
async function fmCloseTab(idx) {
  if (idx !== FM.activeIdx) fmSnapshot();
  const t = FM.tabs[idx];
  if (!t) return;
  if (t.dirty && idx === FM.activeIdx) {
    const sure = await askConfirm({
      title: 'Есть несохранённые правки',
      text: `Файл «${t.path}» изменён. Закрыть без сохранения?`,
      okLabel: 'Не сохранять',
    });
    if (!sure) return;
  }
  FM.tabs.splice(idx, 1);
  if (!FM.tabs.length) FM.activeIdx = -1;
  else if (FM.activeIdx >= idx) FM.activeIdx = Math.max(0, FM.activeIdx - 1);
  await fmSelectTab(FM.activeIdx);
}

function fmSetDirty(dirty) {
  const d = !!dirty;
  const changed = d !== (FM.dirty || false);
  FM.dirty = d;
  const t = fmActive();
  if (t) t.dirty = d;
  const mark = fmEl('fmDirty');
  mark.innerHTML = d ? ico('dotFill', 9) : '';
  mark.classList.toggle('hidden', !d);
  fmEl('fmSave').disabled = !d || FM.binary || !FM.openPath;
  fmRenderTabs();
  if (changed && d) Sound.play('type');
}

async function fmConfirmLeave() {
  if (!FM.dirty) return true;
  return askConfirm({
    title: 'Есть несохранённые правки',
    text: `Файл «${FM.openPath}» изменён. Открыть другой без сохранения?`,
    okLabel: 'Не сохранять',
  });
}

async function fmSave() {
  if (!FM.openPath || FM.binary) return;
  const s = current();
  if (!s) return;
  fmEl('fmSave').disabled = true;
  const res = await API.filesWrite(s.id, FM.openPath, fmEl('fmText').value);
  if (!res || res.ok === false || res.error) {
    toast((res && res.error) || 'Не удалось сохранить файл', 'err');
    fmEl('fmSave').disabled = false;
    return;
  }
  FM.saved = fmEl('fmText').value;
  FM.content = FM.saved;
  const tab = fmActive();
  if (tab) {
    tab.saved = FM.saved;
    tab.content = FM.saved;
    tab.size = res.size;
    tab.dirty = false;
  }
  fmSetDirty(false);
  fmEl('fmSize').textContent = fmSize(res.size);
  Sound.play('ok');
  toast(`Сохранено: ${FM.openPath.split('/').pop()}`, 'ok');
}

/** В какой папке создавать файл: выбранная в дереве или папка открытого файла. */
function fmTargetDir(explicit) {
  if (explicit != null && explicit !== '') return explicit;
  if (FM.lastDir) return FM.lastDir;
  return fmDirOf(FM.openPath);
}

async function fmNewFile(parentRel = '') {
  const s = current();
  if (!s) return;
  const dir = fmTargetDir(parentRel);
  const name = await askText({
    title: 'Новый файл',
    text: dir ? `Появится в папке «${dir}»` : 'Появится в корне папки сервера',
    value: 'NewFile.yml',
    okLabel: 'Создать',
  });
  if (!name) return;
  const clean = name.trim().replace(/^[/\\]+/, '');
  if (!clean) return;
  if (clean.includes('/')) {
    toast('Нужно только имя файла — папку выбери в дереве слева', 'err');
    return;
  }
  const rel = dir ? dir + '/' + clean : clean;
  const res = await API.filesWrite(s.id, rel, fmTemplateFor(rel));
  if (!res || res.ok === false || res.error) {
    toast((res && res.error) || 'Не удалось создать файл', 'err');
    return;
  }
  FM.expanded = new Set([...FM.expanded, ...fmParents(rel)]);
  await fmLoadTree();
  await fmOpenFile(rel);
  Sound.play('ok');
}

async function fmNewFolder() {
  const s = current();
  if (!s) return;
  const dir = fmTargetDir('');
  const name = await askText({
    title: 'Новая папка',
    text: dir ? `Появится в папке «${dir}»` : 'Появится в корне папки сервера',
    value: 'NewFolder',
    okLabel: 'Создать',
  });
  if (!name) return;
  const clean = name.trim().replace(/^[/\\]+/, '');
  if (!clean) return;
  if (clean.includes('/')) {
    toast('Нужно только имя папки — место выбери в дереве слева', 'err');
    return;
  }
  const rel = dir ? dir + '/' + clean : clean;
  const res = await API.filesMkdir(s.id, rel);
  if (!res || res.ok === false || res.error) {
    toast((res && res.error) || 'Не удалось создать папку', 'err');
    return;
  }
  FM.expanded = new Set([...FM.expanded, ...fmParents(rel + '/x'), rel]);
  FM.lastDir = rel;
  await fmLoadTree();
  Sound.play('ok');
}

function fmParents(rel) {
  const parts = rel.split('/');
  parts.pop();
  const out = [];
  let acc = '';
  for (const p of parts) { acc = acc ? acc + '/' + p : p; out.push(acc); }
  return out;
}

function fmTemplateFor(rel) {
  const name = (rel.split('/').pop() || '').replace(/\.\w+$/, '');
  if (/mythicmobs/i.test(rel) && /\.ya?ml$/i.test(rel)) {
    return `${name}:\n  Type: ZOMBIE\n  Display: '&7${name}'\n  Health: 20\n  Skills:\n    - message{m=&7Привет!} @PlayersInRadius{r=10} ~onSpawn\n`;
  }
  if (/\.ya?ml$/i.test(rel)) return `${name}:\n  Key: value\n`;
  if (/\.json$/i.test(rel)) return '{\n  \n}\n';
  return '';
}

async function fmRename(item) {
  const s = current();
  if (!s) return;
  const next = await askText({
    title: item.isDir ? 'Переименовать папку' : 'Переименовать файл',
    text: item.path,
    value: item.name,
    okLabel: 'Переименовать',
  });
  if (!next || next === item.name) return;
  const res = await API.filesRename(s.id, item.path, next);
  if (!res || res.ok === false || res.error) {
    toast((res && res.error) || 'Не удалось переименовать', 'err');
    return;
  }
  const tab = FM.tabs.find((t) => t.path === item.path);
  if (tab) {
    tab.path = res.path;
    FM.openPath = res.path;
    fmEl('fmCrumb').textContent = res.path;
    fmEl('fmPath').textContent = res.path;
    fmRenderTabs();
  }
  await fmLoadTree();
  Sound.play('ok');
}

async function fmDelete(item) {
  const s = current();
  if (!s) return;
  const what = item.isDir ? 'папку со всем содержимым' : 'файл';
  const sure = await askConfirm({
    title: 'Удаление',
    text: `Удалить ${what} «${item.name}»? Это действие нельзя отменить.`,
    okLabel: 'Удалить',
  });
  if (!sure) return;
  const res = await API.filesRemove(s.id, item.path);
  if (!res || res.ok === false || res.error) {
    toast((res && res.error) || 'Не удалось удалить', 'err');
    return;
  }
  const killed = FM.tabs.findIndex((t) => t.path === item.path || t.path.startsWith(item.path + '/'));
  if (killed >= 0) {
    FM.tabs = FM.tabs.filter((t) => !(t.path === item.path || t.path.startsWith(item.path + '/')));
    FM.activeIdx = FM.tabs.length ? Math.min(FM.activeIdx, FM.tabs.length - 1) : -1;
    FM.dirty = false;
    await fmSelectTab(FM.activeIdx);
  }
  await fmLoadTree();
  Sound.play('stop');
  toast('Удалено', 'ok');
}

/* ── подсветка синтаксиса ── */

function escHtml(t) {
  return String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

const HL_RULES = {
  yaml: /(^[ \t]*#[^\n]*)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|(^[ \t]*(?:-[ \t]+)*[A-Za-z0-9_.$@/-]+(?=[ \t]*:(?:[ \t]|$)))|(\b(?:true|false|null|yes|no|on|off)\b)|(\b-?\d+(?:\.\d+)?\b)|((?:@|~)[A-Za-z][\w:]*)/gim,
  properties: /(^[ \t]*[#!][^\n]*)|(^[ \t]*[^=\n:]+(?=[=:]))|(\b\d+(?:\.\d+)?\b)/gm,
  json: /("(?:[^"\\]|\\.)*"(?=[ \t]*:))|("(?:[^"\\]|\\.)*")|(\b(?:true|false|null)\b)|(-?\b\d+(?:\.\d+)?\b)|(^[ \t]*\/\/[^\n]*)/gm,
  js: /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)|(\b(?:const|let|var|function|return|if|else|for|while|await|async|new|class|import|export|from|try|catch)\b)|(-?\b\d+(?:\.\d+)?\b)/g,
};

const HL_CLASS = {
  yaml: ['t-cmt', 't-str', 't-key', 't-bool', 't-num', 't-tag'],
  properties: ['t-cmt', 't-key', 't-num'],
  json: ['t-key', 't-str', 't-bool', 't-num', 't-cmt'],
  js: ['t-cmt', 't-str', 't-bool', 't-num'],
};

function highlightCode(src, kind) {
  const rules = HL_RULES[kind];
  if (!rules || src.length > 300000) return escHtml(src);
  const classes = HL_CLASS[kind];
  let out = '';
  let last = 0;
  rules.lastIndex = 0;
  let m;
  while ((m = rules.exec(src)) !== null) {
    if (m.index > last) out += escHtml(src.slice(last, m.index));
    let cls = '';
    for (let i = 1; i < m.length; i++) {
      if (m[i] != null) { cls = classes[i - 1] || ''; break; }
    }
    out += cls ? `<span class="${cls}">${escHtml(m[0])}</span>` : escHtml(m[0]);
    last = m.index + m[0].length;
    if (m[0].length === 0) rules.lastIndex++;
  }
  out += escHtml(src.slice(last));
  return out;
}

function fmRenderHighlight() {
  const ta = fmEl('fmText');
  const code = fmEl('fmHlCode');
  const src = ta.value;
  code.innerHTML = src ? highlightCode(src, FM.kind) : '';
  // хвостовой перевод строки не должен «схлопываться»
  if (src.endsWith('\n')) code.innerHTML += '\n';
  fmSyncScroll();
}

function fmRenderGutter() {
  const ta = fmEl('fmText');
  const lines = ta.value ? ta.value.split('\n').length : 1;
  const inner = fmEl('fmGutterInner');
  const cur = fmCursorLine();
  let html = '';
  for (let i = 1; i <= lines; i++) {
    html += i === cur ? `<div style="color:var(--text)">${i}</div>` : `<div>${i}</div>`;
  }
  inner.innerHTML = html;
  fmSyncScroll();
}

function fmSyncScroll() {
  const ta = fmEl('fmText');
  const hl = fmEl('fmHl');
  hl.scrollTop = ta.scrollTop;
  hl.scrollLeft = ta.scrollLeft;
  fmEl('fmGutterInner').style.transform = `translateY(${-ta.scrollTop}px)`;
}

function fmCursorLine() {
  const ta = fmEl('fmText');
  const upto = ta.value.slice(0, ta.selectionStart);
  return upto.split('\n').length;
}

function fmUpdatePos() {
  const ta = fmEl('fmText');
  const upto = ta.value.slice(0, ta.selectionStart);
  const lines = upto.split('\n');
  fmEl('fmPos').textContent = `стр ${lines.length}, стлб ${lines[lines.length - 1].length + 1}`;
}

/** Вставка текста в позицию курсора (используется шпаргалкой). */
function fmInsert(text) {
  const ta = fmEl('fmText');
  if (ta.disabled) {
    toast('Файл не открыт', 'err');
    return;
  }
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const before = ta.value.slice(0, start);
  const after = ta.value.slice(end);
  // аккуратный отступ: если курсор не в начале строки — начинаем с новой строки
  const pad = before && !before.endsWith('\n') ? '\n' : '';
  const value = before + pad + text + after;
  ta.value = value;
  const pos = start + pad.length + text.length;
  ta.selectionStart = ta.selectionEnd = pos;
  ta.focus();
  fmOnInput();
  Sound.play('ok');
}

function fmOnInput() {
  if (!FM.openPath) return;
  fmSetDirty(fmEl('fmText').value !== FM.saved);
  const tab = fmActive();
  if (tab) tab.content = fmEl('fmText').value;
  fmRenderHighlight();
  fmRenderGutter();
  fmUpdatePos();
}

/* ── шпаргалка ── */

function fmRenderWiki() {
  const host = fmEl('fmWikiList');
  if (host.dataset.done) return;
  host.dataset.done = '1';
  host.innerHTML = '';
  for (const sec of MYTHIC_WIKI) {
    const box = document.createElement('details');
    box.className = 'fw-item';
    box.innerHTML = `<summary>${esc(sec.title)}</summary>`
      + (sec.file ? `<div class="fw-file">${esc(sec.file)}</div>` : '')
      + `<div class="fw-note">${esc(sec.note || '')}</div>`
      + `<pre class="fw-code">${escHtml(sec.code)}</pre>`
      + '<div class="fw-actions">'
      + '<button class="btn btn-mini btn-primary" data-act="insert">Вставить</button>'
      + (sec.file ? '<button class="btn btn-mini" data-act="create">Новый файл по шаблону</button>' : '')
      + '</div>';
    box.querySelector('[data-act="insert"]').onclick = () => fmInsert(sec.code);
    const createBtn = box.querySelector('[data-act="create"]');
    if (createBtn) {
      createBtn.onclick = async () => {
        const s = current();
        if (!s) return;
        const res = await API.filesWrite(s.id, sec.file, sec.code);
        if (!res || res.ok === false || res.error) {
          toast((res && res.error) || 'Не удалось создать файл', 'err');
          return;
        }
        FM.expanded = new Set([...FM.expanded, ...fmParents(sec.file)]);
        await fmLoadTree();
        await fmOpenFile(sec.file);
        toast(`Создан ${sec.file}`, 'ok');
      };
    }
    host.appendChild(box);
  }
}

function fmToggleWiki(force) {
  FM.wikiOpen = force != null ? !!force : !FM.wikiOpen;
  fmEl('fmWiki').classList.toggle('hidden', !FM.wikiOpen);
  if (FM.wikiOpen) fmRenderWiki();
  Sound.play('nav');
}

/* ── привязка событий ── */

function fmBind() {
  if (FM.bound) return;
  FM.bound = true;

  const ta = fmEl('fmText');

  ta.addEventListener('input', fmOnInput);
  ta.addEventListener('scroll', fmSyncScroll);
  ta.addEventListener('click', () => { fmUpdatePos(); fmRenderGutter(); });
  ta.addEventListener('keyup', fmUpdatePos);

  ta.addEventListener('keydown', (e) => {
    // Ctrl+S — сохранить
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (FM.dirty) fmSave();
      return;
    }
    // Tab — два пробела
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      ta.value = ta.value.slice(0, start) + '  ' + ta.value.slice(end);
      ta.selectionStart = ta.selectionEnd = start + 2;
      fmOnInput();
      return;
    }
    // Enter — сохраняем отступ текущей строки
    if (e.key === 'Enter') {
      const start = ta.selectionStart;
      if (start !== ta.selectionEnd) return;
      const lineStart = ta.value.lastIndexOf('\n', start - 1) + 1;
      const line = ta.value.slice(lineStart, start);
      const indent = (line.match(/^[ \t]*/) || [''])[0];
      const extra = /:[ \t]*$/.test(line.trim()) || /-[ \t]*$/.test(line.trim()) ? '  ' : '';
      if (!indent && !extra) return;
      e.preventDefault();
      const ins = '\n' + indent + extra;
      ta.value = ta.value.slice(0, start) + ins + ta.value.slice(start);
      ta.selectionStart = ta.selectionEnd = start + ins.length;
      fmOnInput();
    }
  });

  fmEl('fmSave').onclick = () => fmSave();
  fmEl('fmNewFile').onclick = () => fmNewFile('');
  const newFolderBtn = fmEl('fmNewFolder');
  if (newFolderBtn) newFolderBtn.onclick = () => fmNewFolder();
  fmEl('fmWikiBtn').onclick = () => fmToggleWiki();

  /* вкладки открытых файлов */
  fmEl('fmTabs').addEventListener('click', async (ev) => {
    const closeEl = ev.target.closest('[data-close]');
    if (closeEl) {
      ev.stopPropagation();
      await fmCloseTab(Number(closeEl.dataset.close));
      return;
    }
    const tabEl = ev.target.closest('[data-tab]');
    if (tabEl) {
      const idx = Number(tabEl.dataset.tab);
      if (idx !== FM.activeIdx) await fmSelectTab(idx);
    }
  });
  fmEl('fmTabs').addEventListener('auxclick', async (ev) => {
    if (ev.button !== 1) return;
    const tabEl = ev.target.closest('[data-tab]');
    if (tabEl) await fmCloseTab(Number(tabEl.dataset.tab));
  });

  /* кнопка «Распаковать сюда» и работа со списком архива */
  const extractAll = fmEl('fmExtractAll');
  if (extractAll) extractAll.onclick = () => fmExtractArchive('');
  fmEl('fmArchive').addEventListener('click', async (ev) => {
    const unpack = ev.target.closest('[data-unpack]');
    if (unpack) {
      ev.stopPropagation();
      await fmExtractArchive(unpack.dataset.unpack);
      return;
    }
    const row = ev.target.closest('.far-row');
    if (row) await fmArchivePreview(row.dataset.name);
  });

  /* перетаскивание в корень папки сервера */
  const tree = fmEl('fmTree');
  tree.addEventListener('dragover', (ev) => {
    if (!FM.dragPath) return;
    ev.preventDefault();
    tree.classList.add('drop-on');
  });
  tree.addEventListener('dragleave', (ev) => {
    if (ev.target === tree) tree.classList.remove('drop-on');
  });
  tree.addEventListener('drop', async (ev) => {
    ev.preventDefault();
    tree.classList.remove('drop-on');
    await fmMoveInto('');
  });
  fmEl('fmWikiClose').onclick = () => fmToggleWiki(false);
  fmEl('fmOpenExt').onclick = async () => {
    if (!FM.openPath) return toast('Файл не выбран', 'err');
    const res = await API.filesOpenExternal(current().id, FM.openPath);
    if (res && res.ok === false) toast(res.error || 'Только в exe-версии', 'err');
  };

  fmEl('fmSearch').addEventListener('input', () => {
    clearTimeout(FM.searchTimer);
    const q = fmEl('fmSearch').value.trim();
    const host = fmEl('fmSearchRes');
    if (!q) { host.classList.add('hidden'); host.innerHTML = ''; return; }
    FM.searchTimer = setTimeout(async () => {
      const s = current();
      if (!s) return;
      const res = await API.filesSearch(s.id, q);
      const list = (res && (res.results || res)) || [];
      host.classList.remove('hidden');
      if (!list.length) { host.innerHTML = '<div class="fm-empty">Ничего не найдено</div>'; return; }
      host.innerHTML = '';
      for (const f of list.slice(0, 40)) {
        const row = document.createElement('div');
        row.className = 'fm-row';
        row.innerHTML = `<span class="ico">${fmIcon(f.kind)}</span><span class="nm">${esc(f.path)}</span>`;
        row.onclick = () => fmOpenFile(f.path);
        host.appendChild(row);
      }
    }, 250);
  });

  // закрывать без сохранения — предупреждаем при смене сервера
  window.addEventListener('beforeunload', (e) => {
    if (FM.dirty) { e.preventDefault(); e.returnValue = ''; }
  });
}


/* ═════════════════════ редактор иконки (кадрирование, масштаб, поворот) ═════════════════════ */

const IE = { active: false, img: null, zoom: 1, rot: 0, panX: 0, panY: 0, offX: 0, offY: 0, drag: null };

/** Открывает редактор для картинки (data URL). */
function ieOpen(dataUrl) {
  const ed = $('iconEditor');
  if (!dataUrl) { ed.classList.add('hidden'); IE.active = false; return; }
  const img = new Image();
  img.onload = () => {
    IE.img = img;
    IE.zoom = 1; IE.rot = 0; IE.panX = 0; IE.panY = 0; IE.offX = 0; IE.offY = 0;
    IE.active = true;
    ed.classList.remove('hidden');
    $('ieZoom').value = 100;
    $('ieRotate').value = 0;
    $('ieShiftX').value = 0;
    $('ieShiftY').value = 0;
    ieDraw();
    ieInfo();
  };
  img.onerror = () => toast('Не удалось прочитать изображение', 'err');
  img.src = dataUrl;
}

function ieInfo() {
  const w = IE.img ? IE.img.width : 0;
  const h = IE.img ? IE.img.height : 0;
  $('ieInfo').textContent = IE.img
    ? `источник ${w}×${h} · масштаб ${Math.round(IE.zoom * 100)}% · поворот ${IE.rot}° · смещение ${Math.round(IE.offX)}/${Math.round(IE.offY)}`
    : '—';
}

/** Рисует квадратный кроп: масштаб + поворот + сдвиг. */
function ieDraw() {
  const cv = $('ieCanvas');
  if (!cv || !IE.img) return;
  const ctx = cv.getContext('2d');
  const size = cv.width;
  ctx.clearRect(0, 0, size, size);

  const cell = 16;
  for (let y = 0; y < size; y += cell) {
    for (let x = 0; x < size; x += cell) {
      ctx.fillStyle = ((x / cell + y / cell) % 2 === 0) ? 'rgba(128,128,128,.14)' : 'rgba(128,128,128,.04)';
      ctx.fillRect(x, y, cell, cell);
    }
  }

  const img = IE.img;
  const base = Math.max(size / img.width, size / img.height);
  const scale = base * IE.zoom;
  ctx.save();
  ctx.translate(size / 2 + (IE.panX + IE.offX / 100) * size, size / 2 + (IE.panY + IE.offY / 100) * size);
  ctx.rotate((IE.rot * Math.PI) / 180);
  ctx.scale(scale, scale);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, -img.width / 2, -img.height / 2);
  ctx.restore();
}

/** Готовая квадратная иконка (по умолчанию 128×128). */
function ieExport(px = 128) {
  const img = IE.img;
  if (!img) return '';
  const out = document.createElement('canvas');
  out.width = out.height = px;                 // итог всегда 1:1
  const ctx = out.getContext('2d');
  const base = Math.max(px / img.width, px / img.height);
  const scale = base * IE.zoom;
  // ровно как в предпросмотре: перетаскивание + поля смещения
  const dx = (IE.panX + IE.offX / 100) * px;
  const dy = (IE.panY + IE.offY / 100) * px;
  ctx.translate(px / 2 + dx, px / 2 + dy);
  ctx.rotate((IE.rot * Math.PI) / 180);
  ctx.scale(scale, scale);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, -img.width / 2, -img.height / 2);
  return out.toDataURL('image/png');
}

function ieBind() {
  const stage = document.querySelector('.ie-stage');
  if (!stage || stage.dataset.bound) return;
  stage.dataset.bound = '1';

  const start = (e) => {
    if (!IE.active) return;
    IE.drag = { x: e.clientX, y: e.clientY, px: IE.panX, py: IE.panY };
    try { stage.setPointerCapture(e.pointerId); } catch { /* не критично */ }
  };
  const move = (e) => {
    if (!IE.drag) return;
    const rect = stage.getBoundingClientRect();
    IE.panX = IE.drag.px + (e.clientX - IE.drag.x) / rect.width;
    IE.panY = IE.drag.py + (e.clientY - IE.drag.y) / rect.height;
    const sx = $('ieShiftX'), sy = $('ieShiftY');
    if (sx) sx.value = Math.round(Math.max(-100, Math.min(100, (IE.panX + IE.offX / 100) * 100)));
    if (sy) sy.value = Math.round(Math.max(-100, Math.min(100, (IE.panY + IE.offY / 100) * 100)));
    ieDraw();
  };
  const stop = () => { IE.drag = null; };

  stage.addEventListener('pointerdown', start);
  stage.addEventListener('pointermove', move);
  stage.addEventListener('pointerup', stop);
  stage.addEventListener('pointercancel', stop);
  stage.addEventListener('wheel', (e) => {
    if (!IE.active) return;
    e.preventDefault();
    IE.zoom = Math.min(4, Math.max(1, IE.zoom - Math.sign(e.deltaY) * 0.08));
    $('ieZoom').value = Math.round(IE.zoom * 100);
    ieDraw(); ieInfo();
  }, { passive: false });

  $('ieZoom').oninput = () => { IE.zoom = Number($('ieZoom').value) / 100; ieDraw(); ieInfo(); };
  $('ieRotate').oninput = () => { IE.rot = Number($('ieRotate').value); ieDraw(); ieInfo(); };
  for (const [id, key] of [['ieShiftX', 'offX'], ['ieShiftY', 'offY']]) {
    $(id).oninput = () => {
      IE[key] = Math.max(-100, Math.min(100, Number($(id).value) || 0));
      ieDraw(); ieInfo();
    };
  }
  $('ieReset').onclick = () => {
    IE.zoom = 1; IE.rot = 0; IE.panX = 0; IE.panY = 0; IE.offX = 0; IE.offY = 0;
    $('ieZoom').value = 100; $('ieRotate').value = 0;
    $('ieShiftX').value = 0; $('ieShiftY').value = 0;
    ieDraw(); ieInfo();
    Sound.play('click');
  };
  $('ieApply').onclick = () => {
    const data = ieExport(128);
    if (!data) return;
    pendingIcon = data;
    setIconPreview(data, $('f_name').value);
    Sound.play('ok');
    toast('Иконка обновлена', 'ok');
  };
}

/* ═════════════════════ базовые настройки server.properties ═════════════════════ */

const PROP_INPUTS = {
  motd: 'p_motd',
  'server-port': 'p_port',
  'max-players': 'p_maxplayers',
  difficulty: 'p_difficulty',
  gamemode: 'p_gamemode',
  'view-distance': 'p_viewdistance',
  'online-mode': 'p_onlinemode',
  pvp: 'p_pvp',
  'allow-flight': 'p_flight',
  'white-list': 'p_whitelist',
  hardcore: 'p_hardcore',
  'enable-command-block': 'p_cmdblock',
};

const BOOL_PROPS = new Set(['online-mode', 'pvp', 'allow-flight', 'white-list', 'hardcore', 'enable-command-block']);

/** Заполняет поля из server.properties. */
async function propsLoad(server) {
  const state = $('propsState');
  const empty = () => {
    for (const id of Object.values(PROP_INPUTS)) {
      const el = $(id);
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = false;
      else el.value = '';
    }
  };
  if (!server || !server.id || !server.cwd) {
    empty();
    state.textContent = 'нет папки';
    return;
  }
  const res = await API.propsRead(server.id);
  if (!res || res.ok === false || res.error) {
    empty();
    state.textContent = 'недоступно';
    return;
  }
  const props = res.props || {};
  for (const [key, id] of Object.entries(PROP_INPUTS)) {
    const el = $(id);
    if (!el) continue;
    const v = props[key];
    if (BOOL_PROPS.has(key)) el.checked = v === true;
    else el.value = v == null ? '' : String(v);
  }
  state.textContent = res.exists ? 'server.properties' : 'файла нет';
}

/** Записывает только изменённые поля. */
async function propsSave(server) {
  if (!server || !server.id || !server.cwd) return { ok: true, skipped: true };
  const before = await API.propsRead(server.id);
  if (!before || before.ok === false) return { ok: true, skipped: true };
  const old = before.props || {};

  const patch = {};
  for (const [key, id] of Object.entries(PROP_INPUTS)) {
    const el = $(id);
    if (!el) continue;
    if (BOOL_PROPS.has(key)) {
      const v = el.checked;
      if (old[key] === v) continue;
      // ключа нет в файле и галочка снята — не дописываем мусор
      if (old[key] == null && v === false) continue;
      patch[key] = v;
    } else {
      const raw = el.value.trim();
      if (raw === '') continue;
      const value = el.type === 'number' ? Number(raw) : raw;
      if (old[key] != null && String(old[key]) === String(value)) continue;
      patch[key] = value;
    }
  }
  if (!Object.keys(patch).length) return { ok: true, changed: 0 };

  const res = await API.propsWrite(server.id, patch);
  if (!res || res.ok === false || res.error) {
    toast((res && res.error) || 'Не удалось записать server.properties', 'err');
    return { ok: false };
  }
  return { ok: true, changed: Object.keys(patch).length, patch };
}

/* ═════════════════ вкладки ═════════════════ */

function setTab(name) {
  S.tab = name;
  for (const btn of document.querySelectorAll('.tab')) btn.classList.toggle('active', btn.dataset.tab === name);
  const addonId = name.startsWith('addon:') ? name.slice(6) : '';
  for (const pane of document.querySelectorAll('.tab-pane')) {
    const isAddon = pane.dataset && pane.dataset.addonPane;
    pane.classList.toggle('hidden', isAddon ? isAddon !== addonId : pane.id !== 'tab-' + name);
  }
  if (addonId) { S.addonOpen = addonId; openAddonPanel(addonId); }
  const activeTab = document.querySelector('.tabs .tab.active');
  if (activeTab && activeTab.scrollIntoView) activeTab.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  Sound.play('nav');
  if (name === 'perf') { renderPerf(); loadTpsTab(); }
  if (name === 'backups') loadBackups();
  if (name === 'files') fmLoadTree();
  if (name === 'players') renderPlayers();
  if (name === 'addons') {
    addonsLoadInfo().then(() => { addonsCategories(); if (!S.addons.hits.length) addonsSearch(true); });
  }
  if (name === 'issues') {
    const s = current();
    if (s) { rescanIssues(s.id); markIssuesSeen(s.id); renderIssues(); }
  }
  hideCmdSuggest();
}

/* ═════════════════ вкладка производительности ═════════════════ */

function metricsFor(s) {
  return S.metrics.get(s.id) || (s.metrics ? s.metrics : null);
}

function renderPerf() {
  const s = current();
  if (!s) return;
  const m = metricsFor(s);
  const hist = (m && m.history) || [];

  el.cpuNow.textContent = m && m.cpu != null ? m.cpu.toFixed(0) : '—';
  el.ramNow.textContent = m && m.rss ? Math.round(m.rss / 1048576) : '—';
  el.procNow.textContent = m && m.procs ? m.procs : '—';

  drawChart(el.cpuChart, hist.filter((p) => p.cpu != null).map((p) => ({ t: p.t, v: p.cpu })), { fixedMax: 100 });
  drawChart(el.ramChart, hist.filter((p) => p.rss).map((p) => ({ t: p.t, v: p.rss / 1048576 })));
}

/* ═════════════════ TPS внутри «Производительности» ═════════════════ */

let tpsTimerId = null;
let tpsLastTick = 0;

/** Автообновление истории TPS: период задаётся прямо на вкладке. */
function tpsSchedule() {
  clearInterval(tpsTimerId);
  tpsTimerId = null;
  const sel = $('tpsRefresh');
  const sec = sel ? Number(sel.value) || 0 : 0;
  if (!sec) {
    const lbl = $('tpsTimer');
    if (lbl) lbl.textContent = 'таймер: выключен';
    return;
  }
  tpsTimerId = setInterval(async () => {
    if (S.tab !== 'perf' || !current()) return;
    tpsLastTick = Date.now();
    await loadTpsTab(true);
  }, sec * 1000);
  tpsTick();
}

function tpsTick() {
  const lbl = $('tpsTimer');
  if (!lbl) return;
  const sel = $('tpsRefresh');
  const sec = sel ? Number(sel.value) || 0 : 0;
  if (!sec) { lbl.textContent = 'таймер: выключен'; return; }
  const left = Math.max(0, sec - Math.floor((Date.now() - (tpsLastTick || Date.now())) / 1000));
  lbl.textContent = `таймер: обновление через ${left} с`;
}

async function loadTpsTab(force) {
  const s = current();
  if (!s) return;
  let points = S.tpsFull.get(s.id);
  if (!points || force) {
    try { points = await API.tpsHistory(s.id); } catch { points = []; }
    if (!Array.isArray(points)) points = [];
    S.tpsFull.set(s.id, points);
  }
  renderTpsTab();
  tpsFillMonitor();
}

/** Поля «как панель узнаёт TPS» — берём из настроек сервера. */
function tpsFillMonitor() {
  const s = current();
  const cmd = $('tpsCmd');
  const every = $('tpsEvery');
  if (!s || !cmd || !every) return;
  if (document.activeElement === cmd || document.activeElement === every) return;
  cmd.value = s.tpsCommand == null ? '' : s.tpsCommand;
  every.value = s.tpsInterval || 30;
}

async function tpsSaveMonitor() {
  const s = current();
  if (!s) return;
  const tpsCommand = ($('tpsCmd').value || '').trim();
  const tpsInterval = Math.max(5, Math.min(3600, Number($('tpsEvery').value) || 30));
  const res = await API.update(s.id, { tpsCommand, tpsInterval });
  if (!res || res.ok === false || res.error) {
    toast((res && res.error) || 'Не удалось сохранить', 'err');
    return;
  }
  s.tpsCommand = tpsCommand;
  s.tpsInterval = tpsInterval;
  toast(tpsCommand ? `Панель будет спрашивать «${tpsCommand}» каждые ${tpsInterval} с` : 'TPS-монитор выключен', 'ok');
  Sound.play('ok');
}

function renderTpsTab() {
  const s = current();
  if (!s) return;
  const all = S.tpsFull.get(s.id) || [];
  const minutes = Number($('tpsRange').value) || 60;
  const since = Date.now() - minutes * 60000;
  const points = all.filter((p) => p.t >= since).map((p) => ({ t: p.t, v: p.v }));

  drawChart(el.tpsChart, points, { min: 0, fixedMax: 20, color: 'var(--white)' });
  tpsTick();

  if (!points.length) {
    el.tpsStats.textContent = s.tpsCommand
      ? 'Пока нет замеров — сервер должен поработать и ответить на команду TPS.'
      : 'TPS-монитор выключен. Впиши команду ниже — панель начнёт снимать TPS.';
    return;
  }
  const vals = points.map((p) => p.v);
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const last = vals[vals.length - 1];
  el.tpsStats.textContent = `сейчас ${last.toFixed(1)} · среднее ${avg.toFixed(1)} · минимум ${min.toFixed(1)} · максимум ${max.toFixed(1)} · точек: ${points.length}`;
}

/* ═════════════════ вкладка бэкапов ═════════════════ */

async function loadBackups() {
  const s = current();
  if (!s) return;
  el.backupList.innerHTML = '<div class="backup-empty">Загружаю…</div>';
  let list = [];
  try { list = await API.backupList(s.id); } catch { list = []; }
  S.backups = Array.isArray(list) ? list : [];
  renderBackups();

  try {
    const size = await API.backupSize(s.id);
    if (size && size.bytes) {
      el.backupSub.textContent = `Папка сервера: ${fmtBytes(size.bytes)} в ${size.files} файлах · архивов: ${S.backups.length}`;
    } else {
      el.backupSub.textContent = `Архивов: ${S.backups.length}`;
    }
  } catch {
    el.backupSub.textContent = `Архивов: ${S.backups.length}`;
  }
}

function renderBackups() {
  if (!S.backups.length) {
    el.backupList.innerHTML = '<div class="backup-empty">Бэкапов пока нет. Нажми «Создать бэкап» — папка сервера упакуется в архив.</div>';
    return;
  }
  el.backupList.innerHTML = '';
  for (const b of S.backups) {
    const node = document.createElement('div');
    node.className = 'backup-item';
    node.innerHTML = `
      <div class="bk-main">
        <div class="bk-name">${esc(b.name)}</div>
        <div class="bk-meta">${new Date(b.createdAt).toLocaleString('ru-RU')} · ${fmtBytes(b.size)} · ${/\\.7z$/i.test(b.name) ? '7z, максимум сжатия' : 'zip'}</div>
      </div>
      <button class="btn btn-mini bk-restore">Восстановить</button>
      <button class="btn btn-mini btn-ghost bk-del">Удалить</button>`;

    node.querySelector('.bk-restore').onclick = async () => {
      const ok = await askConfirm({
        title: 'Восстановить бэкап?',
        text: `Файлы папки сервера будут перезаписаны содержимым «${b.name}». Сервер будет остановлен, а перед восстановлением автоматически создастся страховочный бэкап.`,
        okLabel: 'Восстановить',
      });
      if (!ok) return;
      toast('Восстанавливаю… сервер остановлен');
      try {
        const res = await API.backupRestore(current().id, b.file, { safety: true, startAfter: true });
        toast(res && res.ok ? 'Бэкап восстановлен' : 'Не удалось восстановить', res && res.ok ? 'ok' : 'err');
      } catch (e) {
        toast('Ошибка восстановления: ' + e.message, 'err');
      }
      await refresh();
      loadBackups();
    };

    node.querySelector('.bk-del').onclick = async () => {
      const ok = await askConfirm({
        title: 'Удалить бэкап?',
        text: `Архив «${b.name}» будет удалён с диска.`,
        okLabel: 'Удалить',
      });
      if (!ok) return;
      await API.backupDelete(b.file);
      toast('Бэкап удалён');
      loadBackups();
    };

    el.backupList.appendChild(node);
  }
}

/* ═════════════════════ утилиты ═════════════════════ */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('ru-RU', { hour12: false });
}
function fmtUptime(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d) return `${d} д ${h} ч`;
  if (h) return `${h} ч ${m} мин`;
  if (m) return `${m} мин ${sec} с`;
  return `${sec} с`;
}
const STATE_LABEL = { stopped: 'остановлен', running: 'работает', stopping: 'остановка…' };

const NOTIF_ICONS = {
  ok: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  err: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 7v7"/><path d="M12 17.4v.2"/><circle cx="12" cy="12" r="9"/></svg>',
  warn: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4.5 3 19.5h18L12 4.5Z"/><path d="M12 10v4"/><path d="M12 16.8v.2"/></svg>',
  info: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><path d="M12 7.6v.2"/></svg>',
};

/**
 * Окно уведомления в правом верхнем углу.
 * notify('текст')  или  notify({title, text, kind, sticky, ms})
 */
function notify(input, kind = '') {
  const opts = typeof input === 'string' ? { text: input, kind } : (input || {});
  if (prefs.notif === false) return null;
  const k = opts.kind || 'info';
  const card = document.createElement('div');
  card.className = 'notif ' + k + (opts.sticky ? ' sticky' : '');
  const title = opts.title || { ok: 'Готово', err: 'Ошибка', warn: 'Внимание', info: 'Уведомление' }[k] || 'Уведомление';
  card.innerHTML = `
    <div class="n-ico">${NOTIF_ICONS[k] || NOTIF_ICONS.info}</div>
    <div class="n-body">
      <div class="n-title">${esc(title)}</div>
      <div class="n-text">${esc(opts.text || '')}</div>
    </div>
    <button class="n-x" aria-label="Закрыть"><svg width="10" height="10" viewBox="0 0 10 10"><path d="M1.6 1.6l6.8 6.8M8.4 1.6 1.6 8.4" stroke="currentColor" stroke-width="1.4"/></svg></button>
    <i class="n-bar"></i>`;

  const defMs = Number(prefs.notifMs) || 4200;
  const ms = Number(opts.ms) || (k === 'err' ? Math.max(defMs, 5500) : defMs);
  const bar = card.querySelector('.n-bar');
  if (!opts.sticky) bar.style.animationDuration = ms + 'ms';

  const close = () => {
    if (card.classList.contains('out')) return;
    card.classList.add('out');
    setTimeout(() => card.remove(), 200);
  };
  card.querySelector('.n-x').onclick = close;
  card.onclick = (e) => { if (!e.target.closest('.n-x') && opts.onClick) opts.onClick(); };

  el.toasts.appendChild(card);
  while (el.toasts.children.length > 4) el.toasts.firstElementChild.remove();
  if (!opts.sticky) setTimeout(close, ms);
  if (prefs.notifSound) {
    if (k === 'err') Sound.play('err');
    else if (k === 'ok') Sound.play('ok');
  }

  // если окно свёрнуто в трей — дублируем системным уведомлением
  if (prefs.desktopNotif && API.notifyDesktop) {
    API.winIsVisible().then((vis) => {
      if (vis === false) API.notifyDesktop({ title, text: opts.text || '' });
    }).catch(() => {});
  }
  return card;
}

function toast(msg, kind = '') {
  return notify({ text: msg, kind: kind || 'info' });
}

/** Время работы сервера: «работает 1 ч 23 мин 05 с» */
function uptimeText(s) {
  if (!s || s.state !== 'running' || !s.startedAt) return s && s.state === 'stopping' ? 'останавливается' : '—';
  const total = Math.max(0, Math.floor((Date.now() - s.startedAt) / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const parts = [];
  if (d) parts.push(`${d} д`);
  if (d || h) parts.push(`${h} ч`);
  if (!d) parts.push(`${m} мин`);
  parts.push(`${String(sec).padStart(2, '0')} с`);
  return parts.join(' ');
}

function setUptime(s) {
  if (!el.uptime) return;
  el.uptime.textContent = uptimeText(s);
  const chip = document.getElementById('uptimeChip');
  if (chip) chip.classList.toggle('live', !!s && s.state === 'running');
}

/** Иконки кнопок окна: «развернуть» ↔ «восстановить» */
/** Крестик: закрывает панель; если серверы работают — сначала спрашивает. */
async function doCloseApp() {
  const running = S.servers.filter((x) => x.state !== 'stopped');
  if (running.length) {
    const ok = await askConfirm({
      title: 'Закрыть панель?',
      text: `Сейчас работает серверов: ${running.length}. Панель остановит их и выйдет.`,
      okLabel: 'Остановить и выйти',
    });
    if (!ok) return;
  }
  if (API.winQuit) await API.winQuit();
  else await API.winClose();
}

function setWinIcons(st) {
  if (!st) return;
  // полный экран (F11) — своя шапка окна полностью скрывается
  document.body.classList.toggle('is-fullscreen', !!st.fullscreen);
  const max = $('winMax');
  if (!max) return;
  const full = !!(st.fullscreen || st.maximized);
  max.querySelector('.ic-max').classList.toggle('hidden', full);
  max.querySelector('.ic-restore').classList.toggle('hidden', !full);
  max.setAttribute('aria-label', full ? 'Восстановить окно' : 'На весь экран');
}

function current() {
  return S.servers.find((s) => s.id === S.currentId) || null;
}

function avatar(s, cls) {
  const letter = esc((s.name || 'S').trim().charAt(0).toUpperCase());
  if (s.icon) return `<div class="${cls}"><img src="${s.icon}" alt="" /></div>`;
  return `<div class="${cls}">${letter}</div>`;
}


/* ═════════════════════ мастер создания сервера ═════════════════════ */

const WIZ = {
  lastLog: '',
  catalog: [],
  kernel: 'paper',
  versions: [],
  version: '',
  java: [],
  javaPath: 'java',
  parent: '',
  busy: false,
};

function wizShow() {
  $('wizModal').classList.remove('hidden');
  $('wizBar').style.width = '0%';
  $('wizStage').textContent = 'Готов к созданию';
  $('wizProgressField').classList.add('hidden');
  $('wizLog').classList.add('hidden');
  $('wizLog').textContent = '';
  WIZ.lastLog = '';
  Sound.play('nav');
  if (!WIZ.catalog.length) wizInit();
}

function wizClose() {
  if (WIZ.busy) {
    toast('Идёт создание сервера — дождись окончания', 'err');
    return;
  }
  $('wizModal').classList.add('hidden');
}

async function wizInit() {
  // каталог ядер
  try {
    WIZ.catalog = await API.wizardCatalog();
  } catch (e) {
    toast('Не удалось загрузить список ядер: ' + e.message, 'err');
    WIZ.catalog = [];
  }
  wizRenderKernels();
  wizSelectKernel(WIZ.kernel);

  // Java
  wizLoadJava();

  // папка по умолчанию
  if (!WIZ.parent) {
    const home = (S.info && S.info.home) || '';
    WIZ.parent = home ? home.replace(/[\\/]+$/, '') : '';
    $('wizParent').value = WIZ.parent;
  }
  wizUpdatePath();
}

async function wizLoadJava() {
  const sel = $('wizJava');
  sel.innerHTML = '<option value="java">java (из PATH)</option>';
  $('wizJavaHint').textContent = 'Ищу установленную Java…';
  $('wizJavaHint').style.color = '';
  try {
    const probes = await API.wizardJava();
    WIZ.java = Array.isArray(probes) ? probes : (probes ? [probes] : []);
  } catch {
    WIZ.java = [];
  }
  if (WIZ.java.length) {
    sel.innerHTML = '';
    for (const j of WIZ.java) {
      const o = document.createElement('option');
      o.value = j.path;
      o.textContent = `Java ${j.major || '?'} — ${j.path}${j.source ? ' (' + j.source + ')' : ''}`;
      sel.appendChild(o);
    }
    WIZ.javaPath = WIZ.java[0].path;
  }
  wizCheckJavaVersion();
}

function wizCheckJavaVersion() {
  const k = WIZ.catalog.find((x) => x.id === WIZ.kernel);
  const need = k && k.javaMin ? k.javaMin : null;
  const cur = WIZ.java.find((j) => j.path === $('wizJava').value) || WIZ.java[0];
  const hint = $('wizJavaHint');
  if (!need) { hint.textContent = ''; hint.style.color = ''; return; }
  if (!cur || !cur.major) {
    hint.textContent = `Нужна Java ${need}+ — не найдена`;
    hint.style.color = 'var(--warn)';
    return;
  }
  if (cur.major < need) {
    hint.textContent = `Нужна Java ${need}+, найдена ${cur.major}`;
    hint.style.color = 'var(--warn)';
  } else {
    hint.textContent = `Java ${cur.major} — подходит`;
    hint.style.color = '';
  }
}

function wizRenderKernels() {
  const host = $('wizKernels');
  host.innerHTML = '';
  const order = [];
  for (const k of WIZ.catalog) if (!order.includes(k.group)) order.push(k.group);

  for (const g of order) {
    const row = document.createElement('div');
    row.className = 'kernel-group';

    const label = document.createElement('span');
    label.className = 'kg-label';
    label.textContent = g;
    row.appendChild(label);

    const cards = document.createElement('div');
    cards.className = 'kg-cards';
    for (const k of WIZ.catalog.filter((x) => x.group === g)) {
      const b = document.createElement('button');
      b.className = 'kernel-card' + (k.id === WIZ.kernel ? ' active' : '');
      b.dataset.kernel = k.id;
      b.innerHTML = `<span class="kc-name">${k.label}</span>`
        + (k.recommended ? '<span class="kc-badge rec">выбор</span>' : '')
        + (k.proxy ? '<span class="kc-badge">прокси</span>' : '')
        + (k.custom ? '<span class="kc-badge">ссылка</span>' : '');
      b.onclick = () => { Sound.play('click'); wizSelectKernel(k.id); };
      cards.appendChild(b);
    }
    row.appendChild(cards);
    host.appendChild(row);
  }
}

async function wizSelectKernel(id) {
  WIZ.kernel = id;
  const k = WIZ.catalog.find((x) => x.id === id) || {};
  for (const c of $('wizKernels').querySelectorAll('.kernel-card')) {
    c.classList.toggle('active', c.dataset.kernel === id);
  }

  wizCheckJavaVersion();

  const isCustom = !!k.custom;
  $('wizUrlField').classList.toggle('hidden', !isCustom);
  $('wizFileNameField').classList.toggle('hidden', !isCustom);
  $('wizVersionField').classList.toggle('hidden', isCustom);
  $('wizOnline').checked = !k.proxy;
  $('wizOnline').closest('.check').classList.toggle('hidden', !!k.proxy);

  if (!k.proxy && $('wizPort').value === '25565' && (id === 'velocity' || id === 'waterfall')) $('wizPort').value = 25565;

  if (isCustom) {
    wizUpdateName();
    wizUpdatePath();
    return;
  }

  const sel = $('wizVersion');
  sel.innerHTML = '<option>загрузка…</option>';
  try {
    const list = await API.wizardVersions(id);
    WIZ.versions = Array.isArray(list) ? list : [];
  } catch (e) {
    WIZ.versions = [];
    notify({ title: 'Версии не загрузились', text: e.message, kind: 'err' });
  }
  sel.innerHTML = '';
  if (!WIZ.versions.length) {
    sel.innerHTML = '<option value="">— нет данных —</option>';
    return;
  }
  for (const v of WIZ.versions) {
    const o = document.createElement('option');
    o.value = v.id;
    o.textContent = v.id + (v.java ? ` (Java ${v.java}+)` : '');
    sel.appendChild(o);
  }
  WIZ.version = WIZ.versions[0].id;
  sel.value = WIZ.version;
  sel.onchange = () => { WIZ.version = sel.value; wizUpdateName(); wizUpdatePath(); };
  wizUpdateName();
  wizUpdatePath();
}

function wizUpdateName() {
  const k = WIZ.catalog.find((x) => x.id === WIZ.kernel) || {};
  const nameEl = $('wizName');
  const folderEl = $('wizFolderName');
  const v = k.custom ? '' : WIZ.version;
  const auto = k.custom ? (k.label || 'server') : `${k.label || WIZ.kernel} ${v}`.trim();
  if (!nameEl.dataset.touched) nameEl.value = auto;
  if (!folderEl.dataset.touched) folderEl.value = auto.replace(/\s+/g, '-').toLowerCase();
  wizUpdatePath();
}

function wizUpdatePath() {
  const parent = $('wizParent').value.trim();
  const folder = $('wizFolderName').value.trim() || 'server';
  const sep = (S.info && S.info.sep) || '/';
  const full = parent ? parent.replace(/[\\/]+$/, '') + sep + folder : folder;
  $('wizPathPreview').textContent = 'Сервер появится в: ' + full;
  return full;
}

let wizTouchedBound = false;
function wizBind() {
  if (wizTouchedBound) return;
  wizTouchedBound = true;

  $('createBtn').onclick = wizShow;
  $('gridCreate').onclick = () => { closeGrid(); wizShow(); };
  const emptyCreate = $('emptyCreate');
  if (emptyCreate) emptyCreate.onclick = wizShow;

  $('wizClose').onclick = wizClose;
  $('wizCancel').onclick = wizClose;
  $('wizModal').addEventListener('click', (e) => { if (e.target.id === 'wizModal') wizClose(); });

  $('wizJava').onchange = wizCheckJavaVersion;
  $('wizJavaDownload').onclick = () => API.wizardOpenJava();
  $('wizJavaRefresh').onclick = async () => {
    $('wizJavaRefresh').disabled = true;
    $('wizJavaHint').textContent = 'Ищу Java…';
    await wizLoadJava();
    $('wizJavaRefresh').disabled = false;
    Sound.play('click');
  };
  $('wizPort').oninput = () => {};

  $('wizPickParent').onclick = async () => {
    const dir = await API.wizardPickParent();
    if (!dir) {
      if (!IS_DESKTOP) toast('Выбор папки доступен только в exe-версии', 'err');
      return;
    }
    WIZ.parent = dir;
    $('wizParent').value = dir;
    wizUpdatePath();
  };

  $('wizParent').oninput = wizUpdatePath;
  $('wizFolderName').oninput = () => { $('wizFolderName').dataset.touched = '1'; wizUpdatePath(); };
  $('wizName').oninput = () => { $('wizName').dataset.touched = '1'; };

  $('wizFlags').onchange = () => {
    $('wizExtraField').classList.toggle('hidden', $('wizFlags').value !== 'custom');
  };

  $('wizUrl').oninput = () => {
    if (!$('wizFileName').dataset.touched) {
      try {
        const u = new URL($('wizUrl').value);
        const base = u.pathname.split('/').filter(Boolean).pop() || '';
        if (/\.jar$/i.test(base)) $('wizFileName').value = base;
      } catch { /* пока невалидный URL — молчим */ }
    }
  };
  $('wizFileName').oninput = () => { $('wizFileName').dataset.touched = '1'; };

  $('wizCreate').onclick = wizCreate;

  API.onWizardProgress((p) => {
    if (!WIZ.busy) return;
    $('wizLog').classList.remove('hidden');
    if (p.stage === 'download') {
      if (p.percent != null) $('wizBar').style.width = Math.max(0, Math.min(100, p.percent)) + '%';
      $('wizStage').textContent = p.text || 'Скачивание…';
    } else if (p.stage === 'error') {
      $('wizBar').style.width = '100%';
      $('wizStage').textContent = 'Ошибка: ' + p.text;
    } else {
      if (p.percent != null) $('wizBar').style.width = p.percent + '%';
      $('wizStage').textContent = p.text || p.stage;
    }
    // в лог — только осмысленные строки, чтобы не забивать его процентами
    if (p.text && !p.quiet && p.text !== WIZ.lastLog) {
      WIZ.lastLog = p.text;
      const log = $('wizLog');
      log.textContent += (log.textContent ? '\n' : '') + p.text;
      log.scrollTop = log.scrollHeight;
    }
  });
}

function wizMemory() {
  let min = parseInt($('wizRamMin').value, 10) || 1024;
  let max = parseInt($('wizRamMax').value, 10) || 4096;
  if (max < min) { const t = min; min = max; max = t; $('wizRamMin').value = min; $('wizRamMax').value = max; }
  return { min, max };
}

async function wizCreate() {
  if (WIZ.busy) return;

  const k = WIZ.catalog.find((x) => x.id === WIZ.kernel) || {};
  const dir = wizUpdatePath();
  const name = $('wizName').value.trim() || 'Сервер';
  const flagsPreset = $('wizFlags').value;

  if (!dir || !$('wizParent').value.trim()) {
    toast('Укажи папку, куда создать сервер', 'err');
    return;
  }
  if (k.custom) {
    const u = $('wizUrl').value.trim();
    if (!/^https?:\/\//i.test(u)) {
      toast('Нужна прямая ссылка http(s):// на jar', 'err');
      return;
    }
  } else if (!WIZ.version) {
    toast('Выбери версию', 'err');
    return;
  }

  WIZ.busy = true;
  $('wizCreate').disabled = true;
  $('wizCreate').textContent = 'Создаю…';
  $('wizBar').style.width = '0%';
  $('wizLog').textContent = '';
  WIZ.lastLog = '';
  $('wizProgressField').classList.remove('hidden');
  $('wizStage').textContent = 'Подготовка…';
  // блок прогресса появляется внизу формы — подкручиваем к нему
  setTimeout(() => $('wizProgressField').scrollIntoView({ block: 'end', behavior: 'smooth' }), 20);
  Sound.play('start');

  const ram = wizMemory();
  const opts = {
    kernel: WIZ.kernel,
    version: k.custom ? '' : WIZ.version,
    customUrl: k.custom ? $('wizUrl').value.trim() : '',
    customName: k.custom ? $('wizFileName').value.trim() : '',
    dir,
    name,
    javaCmd: $('wizJava').value || 'java',
    memoryMb: ram,
    flagsPreset,
    extraFlags: $('wizExtra').value.trim(),
    port: parseInt($('wizPort').value, 10) || 25565,
    motd: $('wizMotd').value || name,
    onlineMode: $('wizOnline').checked,
  };

  let res;
  try {
    res = await API.wizardCreate(opts);
  } catch (e) {
    res = { ok: false, error: e.message };
  }

  WIZ.busy = false;
  $('wizCreate').disabled = false;
  $('wizCreate').textContent = 'Создать и добавить';

  if (!res || !res.ok) {
    $('wizStage').textContent = 'Ошибка: ' + ((res && res.error) || 'неизвестно');
    $('wizBar').style.width = '100%';
    toast('Не получилось создать сервер', 'err');
    return;
  }

  // добавляем в панель
  try {
    const created = await API.add({
      name,
      command: res.command || 'start.bat',
      cwd: res.cwd,
      stopCommand: res.stopCommand || 'stop',
      encoding: 'auto',
      tpsCommand: res.isProxy ? '' : (res.tpsCommand || 'tps'),
      tpsInterval: 30,
    });
    S.currentId = created.id;
  } catch (e) {
    toast('Сервер создан, но не добавился в список: ' + e.message, 'err');
  }

  $('wizBar').style.width = '100%';
  $('wizStage').textContent = 'Готово: ' + name;
  Sound.play('ok');
  toast(`Сервер создан: ${name}`, 'ok');
  await refresh();
  setTimeout(() => { $('wizModal').classList.add('hidden'); }, 700);
}

/* ═════════════════════ сетка всех серверов ═════════════════════ */

function openGrid() {
  $('gridSearch').value = '';
  renderGrid();
  $('gridModal').classList.remove('hidden');
  Sound.play('nav');
  setTimeout(() => $('gridSearch').focus(), 40);
}

function closeGrid() {
  $('gridModal').classList.add('hidden');
}

function renderGrid() {
  const host = $('gridList');
  const q = $('gridSearch').value.trim().toLowerCase();
  const list = S.servers.filter((s) => !q
    || s.name.toLowerCase().includes(q)
    || (s.cwd || '').toLowerCase().includes(q));

  $('gridCount').textContent = S.servers.length;
  const running = S.servers.filter((s) => s.state === 'running').length;
  $('gridHint').textContent = `Активно: ${running} из ${S.servers.length}`;

  if (!list.length) {
    host.innerHTML = `<div class="sg-empty">${S.servers.length ? 'Ничего не найдено по запросу' : 'Серверов пока нет — добавь первый'}</div>`;
    return;
  }

  host.innerHTML = '';
  for (const s of list) {
    const m = S.metrics.get(s.id) || s.metrics;
    const card = document.createElement('div');
    card.className = 'sg-card' + (s.id === S.currentId ? ' current' : '');
    card.innerHTML = `
      <div class="sg-top">
        ${s.icon ? `<div class="sg-ico"><img src="${s.icon}" alt=""/></div>` : `<div class="sg-ico">${esc((s.name || 'S').charAt(0).toUpperCase())}</div>`}
        <div style="min-width:0;flex:1">
          <div class="sg-name">${esc(s.name)}</div>
          <div class="sg-cmd">${esc(s.command || 'команда не задана')}</div>
        </div>
      </div>
      <div class="sg-state">
        <span class="dot ${s.state === 'running' ? 'running' : s.state === 'stopping' ? 'stopping' : ''}"></span>
        ${STATE_LABEL[s.state] || s.state}
        ${s.state === 'running' && s.startedAt ? ` · ${fmtUptime(Date.now() - s.startedAt)} в работе` : ''}
      </div>
      <div class="sg-metrics">${m && s.state === 'running'
        ? `<span>CPU ${m.cpu != null ? m.cpu.toFixed(0) : '—'}%</span><span>RAM ${Math.round((m.rss || 0) / 1048576)} МБ</span>`
        : '<span class="sg-metrics-off">CPU —</span><span class="sg-metrics-off">RAM —</span>'}</div>
      <div class="sg-actions">
        <button class="btn btn-mini sg-start" ${s.state !== 'stopped' ? 'disabled' : ''}>Старт</button>
        <button class="btn btn-mini sg-stop" ${s.state === 'stopped' ? 'disabled' : ''}>Стоп</button>
        <button class="btn btn-mini sg-open">${ico('folder', 13, 1.7)}</button>
      </div>`;

    card.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      selectServer(s.id);
      closeGrid();
    });
    card.querySelector('.sg-start').onclick = (e) => { e.stopPropagation(); doStart(s.id); setTimeout(renderGrid, 400); };
    card.querySelector('.sg-stop').onclick = (e) => { e.stopPropagation(); doStop(s.id); setTimeout(renderGrid, 400); };
    card.querySelector('.sg-open').onclick = (e) => { e.stopPropagation(); doOpenFolder(s); };
    card.addEventListener('contextmenu', (e) => { e.preventDefault(); showContextMenu(e, s); });
    host.appendChild(card);
  }
}

/* ═════════════════════ окно подтверждения ═════════════════════ */

function askConfirm({ title, text, okLabel = 'Да', second = null }) {
  return new Promise((resolve) => {
    let step = 0;
    const close = (result) => {
      el.cfModal.classList.add('hidden');
      el.cfOk.onclick = null;
      $('cfCancel').onclick = null;
      resolve(result);
    };
    el.cfTitle.textContent = title;
    el.cfText.textContent = text;
    el.cfOk.textContent = okLabel;
    el.cfModal.classList.remove('hidden');
    Sound.play('nav');

    el.cfOk.onclick = () => {
      if (step === 0 && second) {
        step = 1;
        el.cfTitle.textContent = second.title;
        el.cfText.textContent = second.text;
        el.cfOk.textContent = second.okLabel || 'Да, точно';
        Sound.play('nav');
        return;
      }
      Sound.play('click');
      close(true);
    };
    $('cfCancel').onclick = () => { Sound.play('click'); close(false); };
  });
}

/** Своё окно ввода строки: window.prompt в Electron не поддерживается. */
function askText({ title, text = '', value = '', okLabel = 'OK' }) {
  return new Promise((resolve) => {
    const modal = $('textModal');
    const input = $('txInput');
    const close = (result) => {
      modal.classList.add('hidden');
      $('txOk').onclick = null;
      $('txCancel').onclick = null;
      input.onkeydown = null;
      resolve(result);
    };
    $('txTitle').textContent = title;
    $('txText').textContent = text;
    input.value = value;
    $('txOk').textContent = okLabel;
    modal.classList.remove('hidden');
    Sound.play('nav');
    setTimeout(() => { input.focus(); input.select(); }, 30);

    $('txOk').onclick = () => { Sound.play('click'); close(input.value.trim() || null); };
    $('txCancel').onclick = () => { Sound.play('click'); close(null); };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); Sound.play('click'); close(input.value.trim() || null); }
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
    };
  });
}

/* ═════════════════════ контекстное меню ═════════════════════ */

function showContextMenu(ev, server) {
  ev.preventDefault();
  ctxServerId = server.id;
  const running = server.state === 'running';

  const items = [
    { label: 'Остановить', key: 'graceful', disabled: !running, act: () => doStop(server.id) },
    { label: 'Перезапустить', key: 'restart', disabled: false, act: () => doRestart(server.id) },
    { label: 'Принудительно выключить', key: 'kill', disabled: !running, act: () => doKill(server.id) },
    { sep: true },
    { label: 'Файлы сервера', key: 'files', disabled: !server.cwd, act: () => { selectServer(server.id); setTab('files'); } },
    { label: 'Открыть в редакторе', key: 'editor', disabled: !server.cwd, act: () => doOpenEditor(server) },
    { label: 'Открыть папку', key: 'folder', disabled: !IS_DESKTOP && !server.cwd, act: () => doOpenFolder(server) },
    ...(isShared(server) ? [
      { label: 'Обновить из GitHub и запустить', key: 'sync', act: () => startShared(server) },
      { label: 'Скачать изменения', key: 'sync', act: () => sharedPull(server) },
      { label: 'Отправить на GitHub', key: 'sync', act: () => sharedPush(server) },
    ] : []),
    { label: 'Настройки', key: 'settings', act: () => openModal(server) },
    { sep: true },
    { label: 'Удалить', key: 'del', danger: true, act: () => doDelete(server.id) },
  ];

  showMenu(ev, items);
}

/** Показывает контекстное меню из произвольного списка пунктов. */
function showMenu(ev, items) {
  ev.preventDefault();
  el.ctx.innerHTML = (items || []).map((it, i) => {
    if (it.sep) return '<div class="ctx-sep"></div>';
    return `<div class="ctx-item${it.danger ? ' danger' : ''}${it.disabled ? ' disabled' : ''}" data-i="${i}">
      <span>${esc(it.label)}</span></div>`;
  }).join('');

  el.ctx.classList.remove('hidden');
  const { innerWidth: vw, innerHeight: vh } = window;
  const r = el.ctx.getBoundingClientRect();
  el.ctx.style.left = Math.min(ev.clientX, vw - r.width - 8) + 'px';
  el.ctx.style.top = Math.min(ev.clientY, vh - r.height - 8) + 'px';

  el.ctx.querySelectorAll('.ctx-item').forEach((node) => {
    node.addEventListener('click', () => {
      const it = items[Number(node.dataset.i)];
      hideContextMenu();
      Sound.play('click');
      if (it && it.act && !it.disabled) it.act();
    });
  });
}

function hideContextMenu() {
  el.ctx.classList.add('hidden');
  ctxServerId = null;
}

/* ═════════════════════ действия ═════════════════════ */

/** Спрашивает, что делать с занятым портом. Возвращает {key, port} | 'force' | null. */
function askPort(info) {
  return new Promise((resolve) => {
    const modal = $('portModal');
    const input = $('portInput');
    const list = $('portList');
    const first = (info.conflicts[0] || info.busy[0] || {});
    const lines = [];
    for (const c of info.conflicts) {
      lines.push(`<div class="port-row"><span class="port-num">${c.port}</span>`
        + `<span class="port-what">${esc(c.label)} — уже занят сервером «${esc(c.serverName || '')}»</span></div>`);
    }
    for (const b of info.busy) {
      lines.push(`<div class="port-row"><span class="port-num">${b.port}</span>`
        + `<span class="port-what">${esc(b.label)} — занят другой программой</span></div>`);
    }
    list.innerHTML = lines.join('');
    $('portText').textContent = info.conflicts.length
      ? 'Этот сервер возьмёт тот же порт, что уже работает у другого сервера — вдвоём они не запустятся.'
      : 'Порт уже занят другой программой на этом компьютере.';
    input.value = String(first.port || 25565);

    const close = (result) => {
      modal.classList.add('hidden');
      $('portApply').onclick = null;
      $('portCancel').onclick = null;
      $('portForce').onclick = null;
      resolve(result);
    };
    modal.classList.remove('hidden');
    Sound.play('nav');

    API.portsFree(info.id, Number(first.port) || 25565).then((res) => {
      if (res && res.ok && res.port) input.value = String(res.port);
    }).catch(() => {});

    $('portApply').onclick = () => {
      const port = Number(input.value);
      if (!Number.isFinite(port) || port < 1 || port > 65535) {
        notify({ title: 'Порт не подходит', text: 'Нужно число от 1 до 65535', kind: 'err' });
        return;
      }
      Sound.play('click');
      close({ key: first.key, port });
    };
    $('portForce').onclick = () => { Sound.play('click'); close('force'); };
    $('portCancel').onclick = () => { Sound.play('click'); close(null); };
  });
}

/** Проверка портов перед стартом: если занято — предлагаем сменить порт. */
async function startWithPortCheck(id) {
  const s = (S.servers || []).find((x) => x.id === id);
  if (!s || !API.portsCheck) return true;
  const info = await API.portsCheck(id).catch(() => null);
  if (!info || !info.ok || !s) return true;
  const bad = (info.conflicts || []).length + (info.busy || []).length;
  if (!bad) return true;
  info.id = id;
  const res = await askPort(info);
  if (res == null) return false;
  if (res === 'force') return true;
  const set = await API.portsSet(id, res.key, res.port).catch(() => null);
  if (!set || !set.ok) {
    notify({ title: 'Порт не записался', text: (set && set.error) || 'нет доступа к server.properties', kind: 'err' });
    return false;
  }
  notify({ title: 'Порт изменён', text: `${res.key} → ${res.port}`, kind: 'ok' });
  return true;
}

async function doStart(id) {
  if (!(await startWithPortCheck(id))) return;
  Sound.play('start');
  await API.start(id);
  setTimeout(refresh, 120);
}
async function doStop(id) {
  Sound.play('stop');
  await API.stop(id);
  setTimeout(refresh, 120);
}
async function doRestart(id) {
  Sound.play('start');
  await API.restart(id);
  setTimeout(refresh, 200);
}

async function doKill(server) {
  const ok = await askConfirm({
    title: 'Принудительно выключить?',
    text: `Процесс «${server.name}» будет убит вместе с дочерними. Несохранённые данные могут потеряться — лучше сначала «Стоп».`,
    okLabel: 'Выключить',
  });
  if (!ok) return;
  Sound.play('stop');
  await API.kill(server.id);
  toast('Процесс принудительно завершён');
  setTimeout(refresh, 200);
}

/** Открывает папку сервера во внешнем редакторе. */
async function doOpenEditor(server) {
  const srv = server || current();
  if (!srv) { toast('Сервер не выбран', 'err'); return; }
  if (!srv.cwd) { toast('У сервера не задана рабочая папка', 'err'); return; }
  const res = await API.serverEditor(srv.id);
  if (res && res.ok === false) { toast(res.error || 'Редактор не найден', 'err'); return; }
  Sound.play('ok');
}

async function doOpenFolder(server) {
  if (!server.cwd) { toast('У сервера не задана рабочая папка', 'err'); return; }
  const res = await API.openPath(server.cwd);
  if (res && res.ok === false) toast(res.error || 'Не удалось открыть папку', 'err');
  else Sound.play('ok');
}


/** Общий (синхронизируемый) сервер: обновить из GitHub и запустить. */
async function startShared(server) {
  const card = notify({ title: 'GitHub', text: 'Проверяю обновления…', kind: 'info', sticky: true });
  const res = await API.ghCheck(server.id);
  if (card) card.remove();
  if (res && res.ok === false) { notify({ title: 'GitHub', text: res.error, kind: 'err' }); return; }
  if (res && res.behind > 0) {
    notify({ title: 'Есть обновления', text: `Новых файлов: ${res.behind} — скачиваю перед запуском`, kind: 'info' });
  } else {
    notify({ title: 'Обновлений нет', text: 'Запускаю сохранённую версию', kind: 'info' });
  }
  await API.start(server.id);
  setTimeout(refresh, 800);
}

async function sharedPull(server) {
  const card = notify({ title: 'GitHub', text: 'Скачиваю изменения…', kind: 'info', sticky: true });
  const res = await API.ghPull(server.id);
  if (card) card.remove();
  if (!res.ok) { notify({ title: 'Не удалось скачать', text: res.error, kind: 'err' }); return; }
  notify({
    title: res.upToDate ? 'Уже актуально' : 'Скачано с GitHub',
    text: res.upToDate ? 'Изменений не было' : `Файлов: ${res.downloaded}, удалено: ${res.removed}`,
    kind: 'ok',
  });
  await refresh();
}

async function sharedPush(server) {
  const card = notify({ title: 'GitHub', text: 'Отправляю изменения…', kind: 'info', sticky: true });
  const res = await API.ghPush(server.id);
  if (card) card.remove();
  if (!res.ok) { notify({ title: 'Не удалось отправить', text: res.error, kind: 'err' }); return; }
  notify({
    title: res.upToDate ? 'Отправлять нечего' : 'Отправлено на GitHub',
    text: res.upToDate ? 'Изменений не было' : `Файлов: ${res.uploaded}${res.skipped ? ' · пропущено крупных: ' + res.skipped : ''}`,
    kind: 'ok',
  });
}

/** Удаление с ДВОЙНЫМ подтверждением */
async function doDelete(id) {
  const s = S.servers.find((x) => x.id === id);
  if (!s) return;
  const ok = await askConfirm({
    title: 'Удалить сервер?',
    text: `«${s.name}» будет убран из панели. Файлы на диске останутся на месте.`,
    okLabel: 'Удалить',
    second: {
      title: 'Точно удалить?',
      text: `Это второе подтверждение. Сервер «${s.name}» исчезнет из списка панели${s.state !== 'stopped' ? ', а его процесс будет остановлен' : ''}.`,
      okLabel: 'Да, удалить навсегда',
    },
  });
  if (!ok) return;
  await API.remove(id);
  LOG_CACHE.delete(id);
  S.tps.delete(id);
  if (S.currentId === id) S.currentId = null;
  await refresh();
  toast('Сервер удалён из панели', 'ok');
}

/* ═════════════════════ отрисовка ═════════════════════ */

function renderSidebar() {
  el.count.textContent = S.servers.length;
  const running = S.servers.filter((s) => s.state === 'running').length;
  el.runningCount.textContent = `${running} / ${S.servers.length}`;
  const ps = document.getElementById('profileStatus');
  if (ps) ps.textContent = running ? `активно ${running} из ${S.servers.length}` : `серверов: ${S.servers.length}`;

  el.list.innerHTML = '';
  if (!S.servers.length) {
    const d = document.createElement('div');
    d.className = 'hint';
    d.style.padding = '14px 6px';
    d.textContent = 'Список пуст — добавь сервер или запусти сканирование';
    el.list.appendChild(d);
    return;
  }

  const local = S.servers.filter((s) => !isShared(s));
  const shared = S.servers.filter((s) => isShared(s));

  const addItem = (s) => {
    const item = document.createElement('div');
    item.className = 'srv' + (s.id === S.currentId ? ' active' : '') + (isShared(s) ? ' shared' : '');
    item.innerHTML = `
      ${avatar(s, 'ico')}
      <div class="info">
        <div class="nm">${esc(s.name)}</div>
        <div class="cmd">${esc(s.command || 'команда не задана')}</div>
      </div>
      <div class="dot ${s.state === 'running' ? 'running' : s.state === 'stopping' ? 'stopping' : ''}"></div>`;

    item.addEventListener('click', () => selectServer(s.id));
    item.addEventListener('contextmenu', (e) => showContextMenu(e, s));
    el.list.appendChild(item);
  };

  const addGroup = (title, count, hintTitle) => {
    const g = document.createElement('div');
    g.className = 'srv-group';
    g.innerHTML = `<span>${esc(title)}</span><span class="g-badge">${count}</span><span class="g-line"></span>`;
    el.list.appendChild(g);
  };

  for (const s of local) addItem(s);
  if (shared.length) {
    addGroup('Общие · GitHub', shared.length);
    for (const s of shared) addItem(s);
  }
}

/** Сервер с включённой синхронизацией — отдельная группа, массовые кнопки его не трогают. */
function isShared(s) {
  return !!(s && s.sync && s.sync.enabled && s.sync.repo);
}

function renderTps(s) {
  const data = S.tps.get(s.id) || (s.tps ? { tps: s.tps, history: s.tpsHistory || [] } : null);
  if (!data || data.tps == null || s.state !== 'running') {
    el.tpsBadge.classList.add('hidden');
    return;
  }
  el.tpsBadge.classList.remove('hidden');
  el.tpsVal.textContent = data.tps.toFixed(1);
  el.tpsVal.classList.toggle('low', data.tps < 15);

  const hist = (data.history || []).map((h) => h.v).slice(-24);
  if (hist.length > 1) {
    const W = 46, H = 16;
    const max = Math.max(20, ...hist);
    const pts = hist.map((v, i) => {
      const x = (i / (hist.length - 1)) * W;
      const y = H - Math.min(1, v / max) * (H - 3) - 1.5;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    el.tpsSpark.innerHTML = `<polyline points="${pts}" fill="none" stroke="#e8e8ee" stroke-width="1.2" stroke-linejoin="round" opacity="0.9"/>`;
  } else {
    el.tpsSpark.innerHTML = '';
  }
}

function renderView() {
  updateOnlineChip();
  renderIssuesBadge();
  const s = current();
  if (!s) {
    el.empty.classList.remove('hidden');
    el.view.classList.add('hidden');
    if (typeof topbarUpdate === 'function') topbarUpdate();
    return;
  }
  el.empty.classList.add('hidden');
  el.view.classList.remove('hidden');

  el.name.textContent = s.name;
  el.bigIcon.innerHTML = s.icon
    ? `<img src="${s.icon}" alt="" />`
    : esc((s.name || 'S').trim().charAt(0).toUpperCase());

  const state = s.state || 'stopped';
  el.dot.className = 'dot ' + (state === 'running' ? 'running' : state === 'stopping' ? 'stopping' : '');
  el.stateText.textContent = STATE_LABEL[state] || state;
  if (typeof topbarUpdate === 'function') topbarUpdate();
  setUptime(s);
  el.pid.textContent = s.pid ? 'PID ' + s.pid : '—';

  el.btnStart.disabled = state !== 'stopped';
  el.btnStop.disabled = state === 'stopped';
  el.btnRestart.disabled = state === 'stopped';
  el.btnKill.disabled = state === 'stopped';
  el.cmd.disabled = state !== 'running';
  el.cmd.placeholder = state === 'running'
    ? 'команда в консоль сервера (Enter — отправить)'
    : 'консоль недоступна';

  renderTps(s);
}

/* ═════════════════════ консоль ═════════════════════ */

function lineLevel(entry) {
  if (entry.s === 'stderr') return 'stderr';
  if (entry.s === 'input') return 'input';
  if (entry.s === 'system') {
    if (/^(Запуск|Перезапуск|Автоперезапуск)/.test(entry.m)) return 'system';
    if (/^Процесс завершён/.test(entry.m)) return 'system';
    if (/^Принудительное завершение/.test(entry.m)) return 'err';
    return 'system';
  }
  const m = entry.m;
  if (/\b(ERROR|SEVERE|FATAL|Exception|Traceback|Caused by|Failed|Ошибка|Исключение)\b/i.test(m)) return 'err';
  if (/\b(WARN|WARNING|Предупреждение)\b/i.test(m)) return 'warn';
  if (/\b(DEBUG|TRACE|\[debug\])/i.test(m)) return 'debug';
  if (/\b(Done|Started|Enabled|Loaded|Готово|Запущен)\b/.test(m)) return 'success';
  if (/\b(INFO|Information)\b/i.test(m)) return 'info';
  return 'stdout';
}

function appendLine(entry) {
  if (S.filter && !entry.m.toLowerCase().includes(S.filter)) return;
  const last = S.domLines[S.domLines.length - 1];
  if (last && last.entry.t === entry.t && last.entry.m === entry.m) return;

  const div = document.createElement('div');
  div.className = 'line ' + lineLevel(entry);
  div.innerHTML = `<span class="t">${fmtTime(entry.t)}</span><span class="m">${esc(entry.m)}</span>`;
  el.consoleEl.appendChild(div);

  S.domLines.push({ node: div, entry });
  if (S.domLines.length > 2500) S.domLines.shift().node.remove();
  if (el.autoscroll.checked) el.consoleEl.scrollTop = el.consoleEl.scrollHeight;
}

function pushLog(id, entry) {
  if (!LOG_CACHE.has(id)) LOG_CACHE.set(id, []);
  const arr = LOG_CACHE.get(id);
  arr.push(entry);
  if (arr.length > 2500) arr.splice(0, arr.length - 2500);
}

async function loadLogs(id) {
  const seq = ++loadSeq;
  const logs = await API.logs(id);
  if (seq !== loadSeq) return;
  LOG_CACHE.set(id, Array.isArray(logs) ? logs.slice(-2500) : []);
  S.players.set(id, { names: new Set(), max: 0, at: 0 });
  for (const e of LOG_CACHE.get(id)) playersOnLog(id, e.m || '');
  S.issues.set(id, []);
  S.issuesNew.set(id, 0);
  rescanIssues(id);
  if (id === S.currentId) { updateOnlineChip(); renderIssuesBadge(); renderPlayers(); }
  el.consoleEl.innerHTML = '';
  S.domLines = [];
  LOG_CACHE.set(id, logs.slice());
  for (const e of logs) appendLine(e);
  if (!S.domLines.length) {
    el.consoleEl.innerHTML = '<div class="placeholder">консоль пуста</div>';
  }
}

/* ═════════════════════ обновление данных ═════════════════════ */

function selectServer(id) {
  if (S.currentId === id) return;
  S.currentId = id;
  Sound.play('nav');
  renderSidebar();
  renderView();
  loadLogs(id);
  updateOnlineChip();
  renderIssuesBadge();
  if (S.tab === 'players') renderPlayers();
  if (S.tab === 'issues') renderIssues();
  if (S.tab === 'addons') addonsLoadInfo().then(() => addonsSearch(true));
}

async function refresh() {
  try {
    S.servers = await API.list();
  } catch { return; }

  if (!S.servers.find((s) => s.id === S.currentId)) {
    const nextId = S.servers.length ? S.servers[0].id : null;
    const changed = nextId && nextId !== S.currentId;
    S.currentId = nextId;
    if (changed) loadLogs(S.currentId);
  }
  renderSidebar();
  renderView();
}

/* ═════════════════════ модалка настроек ═════════════════════ */

function setIconPreview(dataUrl, name) {
  const box = $('iconPrev');
  if (dataUrl) box.innerHTML = `<img src="${dataUrl}" alt="" />`;
  else box.textContent = (name || 'S').trim().charAt(0).toUpperCase();
}

function openModal(server) {
  editingId = server ? server.id : null;
  pendingIcon = server?.icon || '';
  el.modalTitle.textContent = server ? 'Настройки сервера' : 'Новый сервер';
  $('f_name').value = server?.name || '';
  $('f_command').value = server?.command || '';
  $('f_cwd').value = server?.cwd || '';
  $('f_stopCommand').value = server?.stopCommand || '';
  $('f_encoding').value = server?.encoding || 'auto';
  $('f_tpsCommand').value = server?.tpsCommand || '';
  $('f_tpsInterval').value = server?.tpsInterval || 30;
  $('f_autoStart').checked = !!server?.autoStart;
  $('f_autoRestart').checked = !!server?.autoRestart;
  $('f_env').value = Object.entries(server?.env || {}).map(([k, v]) => `${k}=${v}`).join('\n');
  $('btnDelete').classList.toggle('hidden', !server);
  setIconPreview(pendingIcon, $('f_name').value);
  ieBind();
  $('iconEditor').classList.add('hidden');
  IE.active = false;
  // синхронизация с GitHub
  const sc = server?.sync || {};
  $('f_syncEnabled').checked = !!sc.enabled;
  $('f_syncRepo').value = sc.repo || '';
  $('f_syncBranch').value = sc.branch || 'main';
  $('f_syncToken').value = sc.token || '';
  $('f_syncScope').value = sc.scope || 'all';
  $('f_syncPull').checked = sc.pullOnStart !== false;
  $('f_syncPush').checked = sc.pushOnStop !== false;
  if ($('f_syncMode')) $('f_syncMode').checked = sc.mode === 'archive';
  syncToggleBody();
  syncStatusReset(server);
  loadAutoFolder(server);
  fillRepoOptions();
  syncBind(server);
  bindMoveToApp();

  propsLoad(server);
  el.modal.classList.remove('hidden');
  Sound.play('nav');
  setTimeout(() => $('f_name').focus(), 30);

  // если иконки нет, а в папке есть server-icon.png — подставляем автоматически
  if (!pendingIcon && server && server.cwd && API.iconFromServer) {
    API.iconFromServer(server.cwd).then((dataUrl) => {
      if (!dataUrl || pendingIcon) return;
      pendingIcon = dataUrl;
      setIconPreview(pendingIcon, $('f_name').value);
      toast('Иконка взята из server-icon.png', 'ok');
    }).catch(() => {});
  }
}

function closeModal() {
  el.modal.classList.add('hidden');
  editingId = null;
  pendingIcon = '';
}

function parseEnv(text) {
  const env = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return env;
}

/** В браузере иконку выбираем через файловый input + canvas */
function pickIconInBrowser() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/*';
  inp.onchange = () => {
    const file = inp.files && inp.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = 64; c.height = 64;
        const ctx = c.getContext('2d');
        const side = Math.min(img.width, img.height);
        ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 64, 64);
        const data = c.toDataURL('image/png');
        pendingIcon = data;
        setIconPreview(data, $('f_name').value);
        ieOpen(data);
        Sound.play('ok');
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  };
  inp.click();
}

async function saveModal() {
  const data = {
    name: $('f_name').value.trim() || 'Без названия',
    command: $('f_command').value.trim(),
    cwd: $('f_cwd').value.trim(),
    stopCommand: $('f_stopCommand').value,
    encoding: $('f_encoding').value,
    tpsCommand: $('f_tpsCommand').value.trim(),
    tpsInterval: Number($('f_tpsInterval').value) || 30,
    autoStart: $('f_autoStart').checked,
    autoRestart: $('f_autoRestart').checked,
    env: parseEnv($('f_env').value),
    icon: pendingIcon,
    sync: {
      enabled: $('f_syncEnabled').checked,
      repo: $('f_syncRepo').value.trim(),
      branch: $('f_syncBranch').value.trim() || 'main',
      token: $('f_syncToken').value.trim(),
      scope: $('f_syncScope').value,
      pullOnStart: $('f_syncPull').checked,
      pushOnStop: $('f_syncPush').checked,
      mode: ($('f_syncMode') && $('f_syncMode').checked) ? 'archive' : 'files',
    },
  };
  if (data.sync.enabled) {
    const hasAccount = await API.ghAccount().then((a) => !!(a && a.hasToken)).catch(() => false);
    if (!data.sync.repo || (!data.sync.token && !hasAccount)) {
      toast('Для синхронизации нужны репозиторий и токен (или вход в настройках панели → GitHub)', 'err');
      return;
    }
    if (!/^[^/\s]+\/[^/\s]+$/.test(data.sync.repo.replace(/^https?:\/\/github\.com\//i, ''))) {
      toast('Репозиторий пишется как владелец/название', 'err');
      return;
    }
    if (data.sync.scope !== 'world' && !data.cwd) {
      toast('Укажи рабочую папку — иначе непонятно, что синхронизировать', 'err');
      return;
    }
  }
  if (!data.command) { toast('Укажи команду запуска', 'err'); return; }

  if (data.cwd && API.checkPath) {
    const chk = await API.checkPath(data.cwd);
    if (!chk.exists && !(await askConfirm({
      title: 'Папка не найдена',
      text: `По пути «${data.cwd}» ничего нет. Сохранить сервер всё равно?`,
      okLabel: 'Сохранить',
    }))) return;
  }

  // нет иконки — пробуем взять server-icon.png из папки сервера
  if (!data.icon && data.cwd && API.iconFromServer) {
    try {
      const auto = await API.iconFromServer(data.cwd);
      if (auto) data.icon = auto;
    } catch { /* не критично */ }
  }

  let target = null;
  if (editingId) {
    await API.update(editingId, data);
    target = S.servers.find((x) => x.id === editingId) || { id: editingId, cwd: data.cwd };
  } else {
    const created = await API.add(data);
    S.currentId = created.id;
    target = { id: created.id, cwd: data.cwd };
  }

  // server.properties — пишем только то, что реально изменили
  const props = await propsSave({ ...(target || {}), cwd: data.cwd });
  if (props && props.changed) {
    toast(`server.properties: изменено полей — ${props.changed}`, 'ok');
  }

  Sound.play('ok');
  toast('Сохранено', 'ok');
  closeModal();
  await refresh();
  if (S.currentId) loadLogs(S.currentId);
}

/* ═════════════════════ сканер серверов ═════════════════════ */

function renderScanFilters() {
  const host = $('scanFilters');
  host.innerHTML = '';
  for (const t of SCAN_TYPES) {
    const chip = document.createElement('button');
    chip.className = 'chip' + (S.scan.types.includes(t.id) ? ' active' : '');
    chip.textContent = t.label;
    chip.onclick = () => {
      const i = S.scan.types.indexOf(t.id);
      if (i >= 0) S.scan.types.splice(i, 1);
      else S.scan.types.push(t.id);
      if (!S.scan.types.length) S.scan.types = ['minecraft'];
      renderScanFilters();
      Sound.play('click');
    };
    host.appendChild(chip);
  }
}

function openScan() {
  S.scan.results = [];
  S.scan.seen = new Set();
  S.scan.byPath = new Map();
  renderScanFilters();
  el.scanResults.innerHTML = '';
  $('scanProgressWrap').classList.add('hidden');
  $('scanAddAll').classList.add('hidden');
  $('scanStop').classList.add('hidden');
  $('scanCount').textContent = '';
  el.scanModal.classList.remove('hidden');
  Sound.play('nav');
}

function closeScan() {
  el.scanModal.classList.add('hidden');
}

function renderScanItem(f) {
  S.scan.byPath.set(f.path, f);
  const node = document.createElement('div');
  node.className = 'scan-item' + (f.added ? ' added' : '');
  node.dataset.path = f.path;
  const kindLabel = KIND_LABEL[f.kind] || f.kind;
  const isPlugin = f.kind === 'minecraft-plugin';
  node.innerHTML = `
    <div class="si-main">
      <div class="si-name">${esc(f.name)} <span class="si-badge${f.kind === 'minecraft' ? ' mc' : ''}">${esc(kindLabel)}</span></div>
      <div class="si-path">${esc(f.path)}</div>
      <div class="si-hints">${esc((f.hints || []).join(' · '))}</div>
    </div>
    <button class="btn btn-mini si-open">Открыть папку</button>
    ${isPlugin
      ? '<button class="btn btn-mini" disabled>не сервер</button>'
      : `<button class="btn btn-mini btn-primary si-add"${f.added ? ' disabled' : ''}>${f.added ? 'Уже добавлен' : 'Добавить'}</button>`}`;

  node.querySelector('.si-open').onclick = async () => {
    const res = await API.openPath(f.path);
    if (res && res.ok === false) toast(res.error || 'Не удалось открыть', 'err');
  };
  const addBtnRef = node.querySelector('.si-add');
  if (addBtnRef) addBtnRef.onclick = async () => {
    await addFromScan(f);
    node.classList.add('added');
    const btn = node.querySelector('.si-add');
    btn.disabled = true;
    btn.textContent = 'Уже добавлен';
  };
  el.scanResults.prepend(node);
}

async function addFromScan(f) {
  if (S.scan.seen.has(f.path.toLowerCase())) return;
  S.scan.seen.add(f.path.toLowerCase());
  const created = await API.add({
    name: f.name,
    command: f.command || '',
    cwd: f.path,
    stopCommand: f.stopCommand || '',
    encoding: 'auto',
    tpsCommand: f.kind === 'minecraft' ? 'tps' : '',
    tpsInterval: 30,
  });
  Sound.play('ok');
  toast(`Добавлен: ${f.name}`, 'ok');
  if (!S.currentId) S.currentId = created.id;
  await refresh();
}

async function runScan(roots) {
  if (S.scan.running) return;
  S.scan.running = true;
  S.scan.results = [];
  S.scan.seen = new Set(S.servers.map((s) => (s.cwd || '').toLowerCase()));
  el.scanResults.innerHTML = '';
  $('scanProgressWrap').classList.remove('hidden');
  $('scanStop').classList.remove('hidden');
  $('scanAll').disabled = true;
  $('scanPick').disabled = true;
  el.scanProgress.textContent = 'Сканирую…';
  const bar0 = $('scanBar');
  bar0.classList.add('indet');
  bar0.style.width = '2%';
  $('scanCurrent').textContent = 'Начинаю с корневых папок…';
  $('scanStats').innerHTML = '<span>папок: <b>0</b></span><span>найдено: <b>0</b></span>';

  const depth = SCAN_DEPTHS[S.scan.depthIdx ?? 1];
  try {
    const results = await API.scanStart({ roots, maxDepth: depth, types: S.scan.types.slice() });
    // добавим те, что не пришли событиями (или дубли отфильтруем)
    const order = { minecraft: 0, script: 1, exe: 2, node: 3, python: 4, 'minecraft-plugin': 9 };
    const sorted = (results || []).slice().sort((a, b) => (order[a.kind] ?? 5) - (order[b.kind] ?? 5));
    for (const f of sorted) {
      if (el.scanResults.querySelector(`[data-path="${CSS.escape(f.path)}"]`)) continue;
      renderScanItem(f);
    }
    if (results && results.length) $('scanAddAll').classList.remove('hidden');
    for (const f of results || []) S.scan.byPath.set(f.path, f);
  } catch (e) {
    toast('Сканирование не удалось: ' + e.message, 'err');
  } finally {
    S.scan.running = false;
    $('scanStop').classList.add('hidden');
    $('scanAll').disabled = false;
    $('scanPick').disabled = false;
    el.scanProgress.textContent = `Готово. Найдено серверов: ${el.scanResults.children.length}`;
    $('scanCount').textContent = `Найдено: ${el.scanResults.children.length}`;
    Sound.play('ok');
  }
}

/* ═════════════════════ подписки ═════════════════════ */

function bindSubscriptions() {
  API.onLog(({ id, entry }) => {
    pushLog(id, entry);
    playersOnLog(id, entry.m || '');
    issuesOnLog(id, entry);
    if (id !== S.currentId) return;
    if (el.consoleEl.querySelector('.placeholder')) el.consoleEl.innerHTML = '';
    appendLine(entry);
  });

  API.onState(({ id, state, pid, startedAt }) => {
    const s = S.servers.find((x) => x.id === id);
    if (s) { s.state = state; s.pid = pid; s.startedAt = startedAt; }
    if (state === 'running') {
      const st = playersState(id);
      st.names.clear();
      st.at = Date.now();
    }
    if (state === 'stopped') {
      playersState(id).names.clear();
      playersState(id).at = 0;
    }
    updateOnlineChip();
    renderSidebar();
    if (id === S.currentId) renderView();
    if (!$('gridModal').classList.contains('hidden')) renderGrid();
  });

  API.onServers((list) => {
    S.servers = list;
    renderSidebar();
    renderView();
  });

  API.onLogsCleared(({ id }) => {
    LOG_CACHE.set(id, []);
    S.issues.set(id, []);
    S.issuesNew.set(id, 0);
    renderIssuesBadge();
    if (id === S.currentId) renderIssues();
    if (id === S.currentId) {
      el.consoleEl.innerHTML = '<div class="placeholder">Консоль очищена.</div>';
      S.domLines = [];
    }
  });

  API.onTps(({ id, tps, history }) => {
    S.tps.set(id, { tps, history });
    const s = S.servers.find((x) => x.id === id);
    if (s) { s.tps = tps; s.tpsHistory = history; }
    if (id === S.currentId) {
      renderView();
      if (S.tab === 'tps' && tps != null) {
        const full = S.tpsFull.get(id) || [];
        full.push({ t: Date.now(), v: tps });
        S.tpsFull.set(id, full);
        renderTpsTab();
      }
    }
  });

  API.onMetrics((m) => {
    S.metrics.set(m.id, m);
    if (m.id === S.currentId && S.tab === 'perf') renderPerf();
    if (S.tab === 'files') {
      const cur = current();
      if (cur && cur.cwd && cur.cwd !== FM.root && !FM.dirty) fmLoadTree();
    }
    if (!$('gridModal').classList.contains('hidden') && S.tab !== 'perf') {
      // обновляем метрики в карточках сетки не чаще раза в 4 секунды
      if (!S._gridMetricsTick || Date.now() - S._gridMetricsTick > 4000) {
        S._gridMetricsTick = Date.now();
        renderGrid();
      }
    }
  });

  API.onToast(({ kind, text }) => toast(text, kind));

  API.onScanFound((f) => {
    if (el.scanResults.querySelector(`[data-path="${CSS.escape(f.path)}"]`)) return;
    renderScanItem(f);
    $('scanAddAll').classList.remove('hidden');
    $('scanCount').textContent = `Найдено: ${el.scanResults.children.length}`;
  });

  API.onScanProgress((p) => {
    if (!p) return;
    const bar = $('scanBar');

    if (p.done) {
      bar.classList.remove('indet');
      bar.style.width = '100%';
      el.scanProgress.textContent = p.cancelled
        ? `Остановлено. Просмотрено папок: ${p.scanned}, найдено: ${p.found}`
        : `Готово. Просмотрено папок: ${p.scanned}, найдено: ${p.found}`;
      $('scanCurrent').textContent = '';
      $('scanStats').innerHTML = `<span>папок: <b>${p.scanned}</b></span><span>найдено: <b>${p.found}</b></span>`;
      return;
    }

    const percent = p.percent || 0;
    bar.classList.toggle('indet', percent < 1);
    bar.style.width = Math.max(2, percent) + '%';

    el.scanProgress.textContent = `Сканирую… ${percent}%`;
    $('scanCurrent').textContent = p.current || '—';
    $('scanStats').innerHTML = `
      <span>папок: <b>${p.scanned}</b></span>
      <span>в очереди: <b>${p.queued}</b></span>
      <span>найдено: <b>${p.found}</b></span>`;
  });
}

/* ═════════════════════ эффекты ═════════════════════ */

function applyPrefs() {
  applyTheme();
  applyBackground();
  applyLook();
  document.body.classList.toggle('no-fx', !prefs.fx);
  document.body.classList.toggle('color-log', prefs.colors);
  $('tglColors').checked = prefs.colors;
  el.autoscroll.checked = prefs.autoscroll;

  // синхронизируем окно настроек, если оно есть
  $('pSound').checked = prefs.sound;
  $('pFx').checked = prefs.fx;
  $('pColors').checked = prefs.colors;
  $('pVolume').value = Math.round(prefs.volume * 100);
  syncCustomColors();
  for (const cell of document.querySelectorAll('.theme-cell')) {
    cell.classList.toggle('active', cell.dataset.theme === prefs.theme);
  }
  for (const chip of document.querySelectorAll('#radiusGrid .chip')) {
    chip.classList.toggle('active', chip.dataset.radius === prefs.radius);
  }
  for (const chip of document.querySelectorAll('#soundPackGrid .chip')) {
    chip.classList.toggle('active', chip.dataset.pack === prefs.soundPack);
  }
  for (const chip of document.querySelectorAll('#clickFxGrid .chip')) {
    chip.classList.toggle('active', chip.dataset.clickfx === prefs.clickFx);
  }
  const customBox = $('customBox');
  if (customBox) customBox.classList.toggle('hidden', prefs.theme !== 'custom');
  for (const chip of document.querySelectorAll('#startGrid .chip')) {
    chip.classList.toggle('active', chip.dataset.start === prefs.startMode);
  }
  for (const chip of document.querySelectorAll('#densityGrid .chip')) {
    chip.classList.toggle('active', chip.dataset.density === prefs.density);
  }
  applyDensity();
  const volEl = $('pVolVal');
  if (volEl) volEl.textContent = Math.round(prefs.volume * 100) + '%';
  $('pNotif').checked = !!prefs.notif;
  $('pDesktopNotif').checked = !!prefs.desktopNotif;
  $('pNotifSound').checked = !!prefs.notifSound;
  for (const chip of document.querySelectorAll('#notifMsGrid .chip')) {
    chip.classList.toggle('active', Number(chip.dataset.ms) === Number(prefs.notifMs));
  }
}

/**
 * Плотность интерфейса.
 *
 * Масштаб-зум убран совсем: он сжимал всю раскладку и на маленьком окне делал
 * текст нечитаемым, а на большом оставлял пустые поля. Теперь интерфейс
 * растягивается сам (резиновые панели + перестроение), а здесь меняется только
 * плотность строк и размер шрифта.
 */
function applyDensity() {
  const value = ['compact', 'normal', 'large'].includes(prefs.density) ? prefs.density : 'normal';
  document.documentElement.dataset.density = value;
  document.documentElement.style.zoom = '';
  document.documentElement.style.removeProperty('--ui-zoom');
  if (typeof pushAddonTheme === 'function') pushAddonTheme();
  if (typeof topbarUpdate === 'function') topbarUpdate();
}

window.addEventListener('resize', () => {
  if (typeof topbarUpdate === 'function') topbarUpdate();
});

/** Глубина сканирования: одна кнопка, четыре ступени. */
const SCAN_DEPTHS = [4, 5, 7, 10];

function renderScanDepth() {
  const idx = S.scan.depthIdx ?? 1;
  S.scan.depthIdx = idx;
  const val = $('scanDepthVal');
  if (val) val.textContent = SCAN_DEPTHS[idx];
  const dots = $('scanDepthDots');
  if (dots) {
    dots.innerHTML = SCAN_DEPTHS.map((_, i) => `<i class="${i <= idx ? 'on' : ''}"></i>`).join('');
  }
  localStorage.setItem('lsp.scanDepth', String(idx));
}

function bindScanDepth() {
  const btn = $('scanDepthBtn');
  if (!btn) return;
  btn.onclick = () => {
    S.scan.depthIdx = ((S.scan.depthIdx ?? 1) + 1) % SCAN_DEPTHS.length;
    renderScanDepth();
    Sound.play('click');
  };
  renderScanDepth();
}

/* ═════════════════ аккаунт GitHub в настройках панели ═════════════════ */

let GH_REPOS = [];

async function ghRefreshAccount() {
  if (!API.ghAccount) return;
  const acc = await API.ghAccount();
  const signed = !!(acc && acc.hasToken);
  const who = signed ? (acc.login || 'вход выполнен') : 'гость';
  const face = signed && acc.avatar
    ? `<img src="${acc.avatar}" alt="">`
    : esc((signed ? (acc.login || '?') : '?').charAt(0).toUpperCase());

  // карточка в настройках
  const ava = $('ghAva');
  if (ava) ava.innerHTML = face;
  const name = $('ghLoginName');
  if (name) name.textContent = signed ? who : 'не выполнен вход';
  const out = $('ghLogout');
  if (out) out.classList.toggle('hidden', !signed);
  const quick = $('ghQuickLogin');
  if (quick) quick.classList.toggle('hidden', signed);
  const row = $('ghLoginRow');
  if (row) row.classList.toggle('hidden', signed);

  // профиль слева сверху в настройках
  const cardAva = $('prefsGhAva');
  if (cardAva) cardAva.innerHTML = face;
  const cardName = $('prefsGhName');
  if (cardName) cardName.textContent = who;

  // значок аккаунта рядом с брендом
  const tbAva = $('tbAccAva');
  if (tbAva) tbAva.innerHTML = face;
  const tbName = $('tbAccName');
  if (tbName) tbName.textContent = who;

  if (signed && acc.login) loadRepos();
}

async function loadRepos(query = '') {
  const host = $('ghRepoList');
  if (!host) return;
  host.innerHTML = '<div class="gh-repo">загружаю список…</div>';
  const res = await API.ghRepos(query);
  if (!res || !res.ok) {
    host.innerHTML = `<div class="gh-repo">${esc((res && res.error) || 'не удалось загрузить')}</div>`;
    return;
  }
  GH_REPOS = res.repos || [];
  host.innerHTML = '';
  if (!GH_REPOS.length) {
    host.innerHTML = '<div class="gh-repo">репозиториев нет — создай первый ниже</div>';
    return;
  }
  const cur = ($('f_syncRepo') && $('f_syncRepo').value.trim()) || '';
  for (const r of GH_REPOS.slice(0, 60)) {
    const el = document.createElement('div');
    el.className = 'gh-repo act';
    el.dataset.repo = r.full;
    if (r.full === cur) el.classList.add('sel');
    el.innerHTML = `${esc(r.full)}<span class="r-tag">${r.private ? 'приватный' : 'публичный'}${r.push ? '' : ' · только чтение'}</span>`;
    el.title = '';
    el.onclick = () => {
      const f = $('f_syncRepo');
      if (f) { f.value = r.full; f.dispatchEvent(new Event('input', { bubbles: true })); }
      host.querySelectorAll('.gh-repo').forEach((n) => n.classList.remove('sel'));
      el.classList.add('sel');
      notify({ title: 'Репозиторий выбран', text: r.full, kind: 'ok' });
    };
    host.appendChild(el);
  }
}

function bindGithubAccount() {
  const quick = $('ghQuickLogin');
  if (quick) {
    quick.onclick = () => {
      const dev = $('ghDeviceBtn');
      if (dev) dev.click();
      else notify({ title: 'Вход недоступен', text: 'Нет Client ID для входа по коду.', kind: 'err' });
    };
  }
  const tbAcc = $('tbAccount');
  if (tbAcc) {
    tbAcc.onclick = () => {
      openPrefs();
      setPrefsCat('gh');
      Sound.play('click');
    };
  }
  const navCard = $('prefsGhCard');
  if (navCard) {
    navCard.onclick = () => {
      setPrefsCat('gh');
      Sound.play('click');
    };
  }

  const loginBtn = $('ghLogin');
  if (!loginBtn || loginBtn.dataset.bound) return;
  loginBtn.dataset.bound = '1';
  loginBtn.onclick = async () => {
    const token = $('ghToken').value.trim();
    if (!token) { notify({ title: 'Нужен токен', kind: 'err' }); return; }
    loginBtn.disabled = true;
    loginBtn.textContent = 'Вход…';
    const res = await API.ghLogin(token);
    loginBtn.disabled = false;
    loginBtn.textContent = 'Войти';
    if (!res.ok) { notify({ title: 'Вход не удался', text: res.error, kind: 'err' }); return; }
    $('ghToken').value = '';
    notify({ title: 'Вход выполнен', text: `GitHub: ${res.login}`, kind: 'ok' });
    await ghRefreshAccount();
  };
  $('ghLogout').onclick = async () => {
    await API.ghLogout();
    GH_REPOS = [];
    $('ghRepoList').innerHTML = '';
    await ghRefreshAccount();
    notify({ title: 'Выход выполнен', text: 'Токен удалён из настроек панели.', kind: 'info' });
  };
  $('ghRepoReload').onclick = () => loadRepos($('ghRepoSearch').value.trim());
  let repoQuery = null;
  $('ghRepoSearch').oninput = () => {
    clearTimeout(repoQuery);
    repoQuery = setTimeout(() => loadRepos($('ghRepoSearch').value.trim()), 400);
  };
  $('ghCreate').onclick = async () => {
    const nm = $('ghNewName').value.trim();
    if (!nm) { notify({ title: 'Нужно имя репозитория', kind: 'err' }); return; }
    const res = await API.ghCreateRepo(nm, true);
    if (!res.ok) { notify({ title: 'Не удалось создать', text: res.error, kind: 'err' }); return; }
    $('ghNewName').value = '';
    notify({ title: 'Репозиторий создан', text: res.repo, kind: 'ok' });
    await loadRepos();
  };
}

/* ═════════════════ синхронизация с GitHub ═════════════════ */

/** Подставляем в подсказку репозитории из аккаунта GitHub. */
async function fillRepoOptions() {
  const list = $('f_syncRepoList');
  if (!list || !API.ghRepos) return;
  const res = await API.ghRepos('');
  if (!res || !res.ok) return;
  list.innerHTML = (res.repos || []).slice(0, 80)
    .map((r) => `<option value="${esc(r.full)}"></option>`).join('');
}

function syncToggleBody() {
  const on = $('f_syncEnabled').checked;
  $('syncBody').classList.toggle('off', !on);
}

function syncStatusReset(server) {
  const st = $('syncStatus');
  if (!st) return;
  if (!server || !server.sync || !server.sync.enabled) { st.textContent = server ? 'синхронизация выключена' : 'будет включена после сохранения'; return; }
  st.textContent = 'последняя синхронизация: ' + (server.syncLastSync || 'ещё не было');
  if (API.ghStatus && server.id) {
    API.ghStatus(server.id).then((info) => {
      if (!info || !info.commit) return;
      const when = info.at ? new Date(info.at).toLocaleString('ru-RU') : '';
      st.textContent = `коммит ${String(info.commit).slice(0, 7)} · файлов ${info.files}${when ? ' · ' + when : ''}`;
    }).catch(() => {});
  }
}

/** Временные (ещё не сохранённые) настройки из полей модалки. */
function syncFormConfig() {
  return {
    repo: $('f_syncRepo').value.trim(),
    branch: $('f_syncBranch').value.trim() || 'main',
    token: $('f_syncToken').value.trim(),
  };
}

function syncBind(editingServer) {
  const btnVerify = $('syncVerify');
  if (btnVerify) {
    btnVerify.onclick = async () => {
      const cfg = syncFormConfig();
      if (!cfg.repo || !cfg.token) { notify({ title: 'Мало данных', text: 'Нужны репозиторий и токен.', kind: 'err' }); return; }
      btnVerify.disabled = true;
      $('syncStatus').textContent = 'проверяю…';
      const res = await API.ghVerify(cfg);
      btnVerify.disabled = false;
      if (!res.ok) {
        $('syncStatus').textContent = res.error;
        notify({ title: 'GitHub', text: res.error, kind: 'err' });
        return;
      }
      $('syncStatus').textContent = `${res.name}${res.private ? ' (приватный)' : ''} · ${res.branchExists ? 'ветка есть' : 'ветки пока нет'}`;
      notify({
        title: 'Репозиторий доступен',
        text: `${res.name}${res.push ? '' : ' · без права записи'}${res.branchExists ? '' : ' · первый коммит создаст ветку'}`,
        kind: res.push ? 'ok' : 'warn',
      });
    };
  }

  const need = () => {
    if (!editingServer) { notify({ title: 'Сервер не сохранён', kind: 'warn' }); return null; }
    return editingServer.id;
  };

  $('syncPull').onclick = async () => {
    const id = need(); if (!id) return;
    $('syncStatus').textContent = 'скачиваю из GitHub…';
    const res = await API.ghPull(id);
    if (!res.ok) { $('syncStatus').textContent = res.error; notify({ title: 'Не удалось скачать', text: res.error, kind: 'err' }); return; }
    $('syncStatus').textContent = res.upToDate ? 'уже актуально' : `скачано ${res.downloaded}, удалено ${res.removed}`;
    notify({ title: 'Скачано с GitHub', text: res.upToDate ? 'Изменений не было' : `Файлов: ${res.downloaded}, удалено: ${res.removed}`, kind: 'ok' });
    await refresh();
  };

  $('syncPush').onclick = async () => {
    const id = need(); if (!id) return;
    $('syncStatus').textContent = 'отправляю на GitHub…';
    const res = await API.ghPush(id);
    if (!res.ok) { $('syncStatus').textContent = res.error; notify({ title: 'Не удалось отправить', text: res.error, kind: 'err' }); return; }
    $('syncStatus').textContent = res.upToDate ? 'отправлять нечего' : `отправлено ${res.uploaded} · ${String(res.commit).slice(0, 7)}`;
    notify({ title: 'Отправлено на GitHub', text: res.upToDate ? 'Изменений не было' : `Файлов: ${res.uploaded}${res.skipped ? ', пропущено крупных: ' + res.skipped : ''}`, kind: 'ok' });
  };
}

/* ── перенос папки сервера в <программу>/server/<имя> ── */

async function loadAutoFolder(server) {
  const input = $('f_cwdLocal');
  if (!input) return;
  try {
    const base = await API.serverAutoFolder();
    if (!base) { input.value = 'только в exe-версии'; return; }
    const safe = (server?.name || $('f_name').value || 'server').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '_').slice(0, 60) || 'server';
    input.value = base + '\\' + safe;
  } catch { input.value = '—'; }
}

function bindMoveToApp() {
  const btn = $('moveToApp');
  if (!btn) return;
  btn.onclick = async () => {
    if (!editingId) { notify({ title: 'Сервер не сохранён', kind: 'warn' }); return; }
    const srv = S.servers.find((x) => x.id === editingId);
    if (!srv) return;
    if (srv.state !== 'stopped') { notify({ title: 'Сервер запущен', text: 'Останови его перед переносом.', kind: 'err' }); return; }
    const removeOld = await askConfirm({
      title: 'Перенести папку сервера?',
      text: `Папка «${srv.cwd}» будет скопирована в папку программы (server/${(srv.name || 'server')}). Исходную папку удалить после успешного копирования?`,
      okLabel: 'Перенести и удалить старую',
      second: {
        title: 'Точно удалить старую папку?',
        text: 'Файлы будут скопированы, затем исходная папка удалится. Действие необратимо.',
        okLabel: 'Да, перенести',
      },
    });
    if (!removeOld) return;

    btn.disabled = true;
    $('moveToApp').textContent = 'Переношу…';
    const res = await API.serverMoveToApp(srv.id, { removeOld: true });
    btn.disabled = false;
    $('moveToApp').textContent = 'Перенести сюда';
    if (!res.ok) { notify({ title: 'Перенос не удался', text: res.error, kind: 'err' }); return; }
    $('f_cwd').value = res.path;
    notify({ title: 'Папка перенесена', text: res.path + (res.removedOld ? ' · старая удалена' : ' · старая оставлена'), kind: 'ok' });
    await refresh();
  };
}

/* ═════════════════ окно настроек панели ═════════════════ */

function buildThemeGrid() {
  const grid = $('themeGrid');
  grid.innerHTML = '';
  for (const [key, t] of Object.entries(THEMES)) {
    const cell = document.createElement('button');
    cell.className = 'theme-cell';
    cell.dataset.theme = key;
    const c = key === 'custom' ? prefs.custom : t;
    cell.innerHTML = `
      <span class="theme-swatch" style="background:${c.bg}">
        <i style="background:${c.panel}"></i>
        <u style="background:${c.accent}"></u>
      </span>
      <span>${t.label}</span>`;
    cell.onclick = () => {
      prefs.theme = key;
      prefs.save();
      applyPrefs();
      Sound.play('click');
    };
    grid.appendChild(cell);
  }
}

let prefsCat = 'look';

function setPrefsCat(cat) {
  prefsCat = cat;
  for (const btn of document.querySelectorAll('#prefsNav .prefs-tab')) {
    btn.classList.toggle('active', btn.dataset.cat === cat);
  }
  for (const sec of document.querySelectorAll('.prefs-cat')) {
    sec.classList.toggle('hidden', sec.dataset.cat !== cat);
  }
  const body = document.querySelector('.prefs-body');
  if (body) body.scrollTop = 0;
  if (cat === 'gh') ghRefreshAccount();
  if (cat === 'upd') {
    const tab = document.querySelector('#prefsNav .prefs-tab[data-cat="upd"]');
    if (tab) tab.classList.remove('has-new');
  }
}

function buildThemePresets() {
  const host = $('themePresets');
  if (!host) return;
  host.innerHTML = '';
  if (!prefs.themes.length) return;
  for (const t of prefs.themes) {
    const el = document.createElement('div');
    el.className = 'theme-preset';
    el.innerHTML = `
      <span class="mini-swatch"><i style="background:${t.bg}"></i><i style="background:${t.panel}"></i><i style="background:${t.text}"></i><i style="background:${t.accent}"></i></span>
      <span>${esc(t.name)}</span>
      <button class="p-del" aria-label="Удалить">✕</button>`;
    el.onclick = (e) => {
      if (e.target.closest('.p-del')) {
        prefs.themes = prefs.themes.filter((x) => x.name !== t.name);
        prefs.save();
        buildThemePresets();
        return;
      }
      prefs.custom = { bg: t.bg, panel: t.panel, text: t.text, accent: t.accent };
      prefs.theme = 'custom';
      prefs.save();
      applyPrefs();
      buildThemePresets();
      Sound.play('click');
    };
    host.appendChild(el);
  }
}

function buildWallRecent() {
  const host = $('wallRecent');
  if (!host) return;
  host.innerHTML = '';
  const list = (prefs.wallRecent || []).filter((w) => w && w.kind);
  if (!list.length) {
    host.innerHTML = '<span class="empty-note">пусто</span>';
    return;
  }
  for (const w of list) {
    const cell = document.createElement('button');
    cell.className = 'wall-cell' + (prefs.wall === w.kind && (w.kind !== 'custom' || prefs.wallName === w.name) ? ' active' : '');
    const src = w.kind === 'custom' ? `omni-wall://${w.name}` : (WALLPAPERS.find((x) => x.id === w.kind) || {}).src;
    const isVid = /\.(mp4|webm)$/i.test(w.name || '');
    cell.innerHTML = src && !isVid
      ? `<img src="${src}" alt=""><span class="wall-tag">${esc(w.label || '')}</span>`
      : `<span class="wall-none">${esc(w.label || 'видео')}</span>`;
    cell.onclick = async () => {
      prefs.wall = w.kind;
      if (w.kind === 'custom') prefs.wallName = w.name;
      pushWallRecent(w);
      prefs.save();
      applyBackground();
      applyLook();
      Sound.play('click');
    };
    host.appendChild(cell);
  }
}

/** Запоминаем фон в истории (без дублей, максимум 12). */
function pushWallRecent(entry) {
  if (!entry || !entry.kind || entry.kind === 'none') return;
  const key = entry.kind + ':' + (entry.name || '');
  prefs.wallRecent = [entry, ...(prefs.wallRecent || []).filter((w) => (w.kind + ':' + (w.name || '')) !== key)].slice(0, 12);
  prefs.save();
  buildWallRecent();
}

function openPrefs() {
  loadAddonList();
  buildThemeGrid();
  buildThemePresets();
  buildWallRecent();
  applyPrefs();
  if (API.updConfig) updLoad();
  setPrefsCat(prefsCat);
  $('prefsModal').classList.remove('hidden');
  Sound.play('nav');
}

function closePrefs() {
  $('prefsModal').classList.add('hidden');
  applyPrefs();
}

function bindEffects() {
  document.addEventListener('pointerdown', (e) => {
    if (!prefs.fx) return;
    const kind = prefs.clickFx;

    // волна внутри кнопки
    if (kind === 'wave') {
      const btn = e.target.closest('.btn');
      if (btn) {
        const r = btn.getBoundingClientRect();
        const d = Math.max(r.width, r.height);
        const span = document.createElement('span');
        span.className = 'ripple';
        span.style.width = span.style.height = d + 'px';
        span.style.left = (e.clientX - r.left - d / 2) + 'px';
        span.style.top = (e.clientY - r.top - d / 2) + 'px';
        btn.appendChild(span);
        setTimeout(() => span.remove(), 520);
      }
      return;
    }

    // эффект прямо на экране, в точке нажатия
    clickFxAt(e.clientX, e.clientY, kind);
  });

  // звуки кликов
  document.addEventListener('click', (e) => {
    if (e.target.closest('.btn, .srv, .ctx-item, .check, .mini-toggle, .switch')) Sound.play('click');
  });

  // звуки печати
  let lastType = 0;
  document.addEventListener('input', (e) => {
    if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) return;
    const now = Date.now();
    if (now - lastType < 45) return;
    lastType = now;
    Sound.play('type');
  });

  // закрытие контекстного меню
  document.addEventListener('click', (e) => {
    if (!el.ctx.classList.contains('hidden') && !e.target.closest('#ctx')) hideContextMenu();
  });
  // закрываем меню только при прокрутке страницы, а не консоли
  document.addEventListener('scroll', (e) => {
    if (e.target === document || e.target === document.documentElement) hideContextMenu();
  }, true);
  window.addEventListener('blur', hideContextMenu);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideContextMenu();
      if (!el.cfModal.classList.contains('hidden')) $('cfCancel').click();
      if (!$('gridModal').classList.contains('hidden')) closeGrid();
    }
  });
}

/* ═════════════════════ привязка событий ═════════════════════ */

function bindActions() {
  el.btnStart.onclick = () => current() && doStart(current().id);
  el.btnStop.onclick = () => current() && doStop(current().id);
  el.btnRestart.onclick = () => current() && doRestart(current().id);
  el.btnKill.onclick = () => current() && doKill(current());
  el.btnSettings.onclick = () => openModal(current());
  el.btnFolder.onclick = () => current() && doOpenFolder(current());
  el.btnEditor.onclick = () => current() && doOpenEditor(current());

  el.cmd.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !el.cmd.value.trim()) return;
    const s = current();
    if (!s) return;
    Sound.play('click');
    API.command(s.id, el.cmd.value);
    el.cmd.value = '';
  });
  el.cmdSend.onclick = () => {
    if (!el.cmd.value.trim()) return;
    const s = current();
    if (s) API.command(s.id, el.cmd.value);
    el.cmd.value = '';
  };

  el.filter.addEventListener('input', () => {
    S.filter = el.filter.value.trim().toLowerCase();
    const logs = LOG_CACHE.get(S.currentId) || [];
    el.consoleEl.innerHTML = '';
    S.domLines = [];
    for (const e of logs) appendLine(e);
    if (!S.domLines.length) el.consoleEl.innerHTML = '<div class="placeholder">Ничего не найдено.</div>';
  });

  el.btnClear.onclick = async () => {
    const s = current();
    if (!s) return;
    LOG_CACHE.set(s.id, []);
    await API.clearLogs(s.id);
    el.consoleEl.innerHTML = '<div class="placeholder">Консоль очищена.</div>';
    S.domLines = [];
  };

  el.btnDownload.onclick = () => {
    const s = current();
    if (!s) return;
    const logs = LOG_CACHE.get(s.id) || [];
    const text = logs.map((e) => `[${fmtTime(e.t)}] ${e.m}`).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    a.download = `${s.name.replace(/[^\wа-я\-]+/gi, '_')}-log.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // префы
  $('tglColors').onchange = (e) => { prefs.colors = e.target.checked; prefs.save(); applyPrefs(); };
  el.autoscroll.onchange = (e) => { prefs.autoscroll = e.target.checked; prefs.save(); };

  // свои кнопки окна: скрыть · уменьшить · развернуть · закрыть
  $('winHide').onclick = () => API.winClose();
  $('winMin').onclick = () => API.winMinimize();
  const prefsBtn = $('tbPrefs');
  if (prefsBtn) prefsBtn.onclick = () => openPrefs();
  $('winClose').onclick = doCloseApp;
  $('winMax').onclick = async () => {
    /* в полном экране та же кнопка выводит из него, а не разворачивает окно */
    if (document.body.classList.contains('is-fullscreen')) {
      setWinIcons(await API.winToggleFull());
      return;
    }
    setWinIcons(await API.winToggleMax());
  };
  if (API.onWinState) API.onWinState((st) => setWinIcons(st));
  // двойной клик по пустому месту шапки — развернуть/восстановить
  const tb = document.querySelector('.titlebar');
  if (tb) {
    tb.addEventListener('dblclick', async (e) => {
      if (e.target.closest('.win-ctrl') || e.target.closest('.tb-left')) return;
      if (document.body.classList.contains('is-fullscreen')) setWinIcons(await API.winToggleFull());
      else setWinIcons(await API.winToggleMax());
    });
  }
  // F11 — полный экран, Esc — выйти из него, Ctrl+W — свернуть в трей
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F11') { e.preventDefault(); API.winToggleFull().then(setWinIcons); return; }
    if (e.key === 'Escape' && document.body.classList.contains('is-fullscreen')) {
      const modalOpen = !!document.querySelector('.modal:not(.hidden)');
      if (!modalOpen) { e.preventDefault(); API.winToggleFull().then(setWinIcons); return; }
    }
    if (e.ctrlKey && (e.key === 'w' || e.key === 'W') && IS_DESKTOP) { e.preventDefault(); doCloseApp(); }
  });

  // все серверы
  $('allStart').onclick = async () => {
    if (!S.servers.length) { notify({ title: 'Серверов нет', kind: 'warn' }); return; }
    await API.startAll();
    notify({ title: 'Запускаю все', text: `Серверов к запуску: ${S.servers.length}`, kind: 'ok' });
    setTimeout(refresh, 700);
  };
  $('allStop').onclick = async () => {
    if (!S.servers.some((s) => s.state !== 'stopped')) { notify({ title: 'Все уже остановлены', text: 'Активных серверов нет.', kind: 'info' }); return; }
    await API.stopAll();
    notify({ title: 'Останавливаю все', text: 'Отправлена команда корректной остановки.', kind: 'warn' });
    setTimeout(refresh, 700);
  };
  $('allRestart').onclick = async () => {
    if (!S.servers.length) { notify({ title: 'Серверов нет', kind: 'warn' }); return; }
    await API.restartAll();
    notify({ title: 'Перезапускаю все', text: 'Серверы перезапускаются по очереди.', kind: 'warn' });
    setTimeout(refresh, 900);
  };

  // сетка серверов
  $('btnGrid').onclick = openGrid;
  $('gridBtnSide').onclick = openGrid;
  $('gridClose').onclick = $('gridDone').onclick = closeGrid;
  $('gridModal').addEventListener('mousedown', (e) => { if (e.target === $('gridModal')) closeGrid(); });
  $('gridSearch').addEventListener('input', renderGrid);
  $('gridAdd').onclick = () => { closeGrid(); openModal(null); };
  $('gridStartAll').onclick = async () => { await Promise.all(S.servers.map((s) => API.start(s.id))); setTimeout(() => { refresh(); renderGrid(); }, 600); };
  $('gridStopAll').onclick = async () => { await Promise.all(S.servers.map((s) => API.stop(s.id))); setTimeout(() => { refresh(); renderGrid(); }, 600); };

  // вкладки (клик делегируем: вкладки аддонов появляются позже)
  for (const nav of document.querySelectorAll('.tabs')) {
    nav.addEventListener('click', (e) => {
      const btn = e.target.closest('.tab');
      if (!btn || !btn.dataset.tab) return;
      setTab(btn.dataset.tab);
    });
  }

  // настройки панели
  $('settingsBtn').onclick = openPrefs;
  $('profileBtn').onclick = openPrefs;
  $('prefsClose').onclick = $('prefsDone').onclick = closePrefs;
  $('prefsModal').addEventListener('mousedown', (e) => { if (e.target === $('prefsModal')) closePrefs(); });
  $('pSound').onchange = (e) => { prefs.sound = e.target.checked; prefs.save(); applyPrefs(); if (prefs.sound) Sound.play('ok'); };
  $('pFx').onchange = (e) => { prefs.fx = e.target.checked; prefs.save(); applyPrefs(); };
  $('pColors').onchange = (e) => { prefs.colors = e.target.checked; prefs.save(); applyPrefs(); };
  // фон
  $('wallPick').onclick = pickWallpaper;
  $('wallClear').onclick = () => {
    prefs.wall = 'none';
    prefs.save();
    applyBackground();
    applyLook();
    Sound.play('click');
  };
  $('wallFit').onchange = (e) => { prefs.wallFit = e.target.value; prefs.save(); applyBackground(); };
  $('wallBlur').oninput = (e) => { prefs.wallBlur = Number(e.target.value); prefs.save(); applyBackground(); };
  const rlt = (id, key, scale = 1) => {
    $(id).oninput = (e) => {
      prefs[key] = Number(e.target.value) / scale;
      prefs.save();
      if (key === 'alpha') applyPrefs(); else applyLook();
    };
  };
  rlt('fxHue', 'hue');
  rlt('fxSat', 'sat');
  rlt('fxBright', 'bright');
  rlt('fxContrast', 'contrast');
  rlt('fxAlpha', 'alpha', 100);
  rlt('fxGlass', 'glass');
  $('fxMono').onclick = () => {
    prefs.sat = 0;
    prefs.hue = 0;
    prefs.save();
    applyLook();
    Sound.play('click');
  };
  $('fxResetFx').onclick = () => {
    prefs.hue = 0; prefs.sat = 100; prefs.bright = 100; prefs.contrast = 100; prefs.alpha = 1; prefs.glass = 0;
    prefs.save();
    applyPrefs();
    notify({ title: 'Эффекты сброшены', text: 'Цвет, прозрачность и размытие вернулись к обычным.', kind: 'ok' });
  };

  $('f_syncEnabled').onchange = () => syncToggleBody();
  $('f_name').addEventListener('input', () => loadAutoFolder(S.servers.find((x) => x.id === editingId)));

  // категории настроек
  for (const tab of document.querySelectorAll('#prefsNav .prefs-tab')) {
    tab.onclick = () => { setPrefsCat(tab.dataset.cat); Sound.play('click'); };
  }
  bindGithubAccount();
  bindGithubDevice();
  bindGithubAdd();
  bindPropsFull();
  topbarUpdate();

  // сохранение собственной темы
  $('themeSave').onclick = () => {
    const raw = $('themeName').value.trim();
    const name = raw || ('Моя тема ' + (prefs.themes.length + 1));
    prefs.themes = [
      { name, ...prefs.custom },
      ...prefs.themes.filter((t) => t.name !== name),
    ].slice(0, 20);
    prefs.save();
    $('themeName').value = '';
    buildThemePresets();
    notify({ title: 'Тема сохранена', text: name, kind: 'ok' });
  };
  $('themeResetCustom').onclick = () => {
    prefs.custom = { ...CUSTOM_DEFAULTS };
    prefs.theme = 'custom';
    prefs.save();
    applyPrefs();
    buildThemePresets();
  };

  $('pVolVal').textContent = Math.round(prefs.volume * 100) + '%';

  $('pNotif').onchange = (e) => {
    prefs.notif = e.target.checked;
    prefs.save();
    applyPrefs();
    if (prefs.notif) notify({ title: 'Уведомления включены', text: 'Так выглядят всплывающие окна.', kind: 'ok' });
  };
  $('pDesktopNotif').onchange = (e) => { prefs.desktopNotif = e.target.checked; prefs.save(); };
  $('pNotifSound').onchange = (e) => {
    prefs.notifSound = e.target.checked;
    prefs.save();
    if (prefs.notifSound) notify({ title: 'Звук включён', text: 'Так звучит уведомление.', kind: 'ok' });
  };
  for (const chip of document.querySelectorAll('[data-snd]')) {
    chip.onclick = () => Sound.play(chip.dataset.snd);
  }
  for (const chip of document.querySelectorAll('#notifMsGrid .chip')) {
    chip.onclick = () => {
      prefs.notifMs = Number(chip.dataset.ms);
      prefs.save();
      applyPrefs();
      Sound.play('click');
    };
  }
  for (const chip of document.querySelectorAll('#startGrid .chip')) {
    chip.onclick = async () => {
      prefs.startMode = chip.dataset.start;
      prefs.save();
      applyPrefs();
      Sound.play('click');
      if (API.winSetStartMode) await API.winSetStartMode(prefs.startMode);
    };
  }
  for (const chip of document.querySelectorAll('#densityGrid .chip')) {
    chip.onclick = () => {
      prefs.density = chip.dataset.density;
      prefs.save();
      applyPrefs();
      Sound.play('click');
    };
  }
  $('pAutostart').onchange = async (e) => {
    const res = await API.autostartSet(e.target.checked);
    if (res == null) { notify({ title: 'Недоступно', text: 'Автозапуск работает только в exe-версии.', kind: 'err' }); e.target.checked = false; return; }
    notify({
      title: res ? 'Автозапуск включён' : 'Автозапуск отключён',
      text: res ? 'OmniPanel будет открываться вместе с Windows.' : 'Панель больше не запускается сама.',
      kind: 'ok',
    });
  };
  $('pVolume').oninput = (e) => { prefs.volume = Number(e.target.value) / 100; prefs.save(); $('pVolVal').textContent = e.target.value + '%'; };
  $('pVolume').onchange = () => Sound.play('click');
  for (const id of Object.keys(CUSTOM_COLOR_KEYS)) {
    $(id).oninput = (e) => {
      prefs.custom[CUSTOM_COLOR_KEYS[id]] = e.target.value;
      prefs.save();
      applyTheme();
      syncCustomColors();
    };
  }

  // наборы звуков
  for (const chip of document.querySelectorAll('#soundPackGrid .chip')) {
    chip.onclick = () => {
      prefs.soundPack = chip.dataset.pack;
      prefs.save();
      applyPrefs();
      Sound.play('ok');
    };
  }

  // эффект от клика
  for (const chip of document.querySelectorAll('#clickFxGrid .chip')) {
    chip.onclick = () => {
      prefs.clickFx = chip.dataset.clickfx;
      prefs.save();
      applyPrefs();
      Sound.play('click');
      if (prefs.clickFx !== 'off' && prefs.fx) {
        const r = chip.getBoundingClientRect();
        clickFxAt(r.left + r.width / 2, r.top + r.height / 2, prefs.clickFx);
      }
    };
  }
  for (const chip of document.querySelectorAll('#radiusGrid .chip')) {
    chip.onclick = () => { prefs.radius = chip.dataset.radius; prefs.save(); applyPrefs(); Sound.play('click'); };
  }
  $('prefsReset').onclick = () => {
    prefs.theme = 'dark';
    prefs.radius = 'soft';
    prefs.volume = 0.45;
    prefs.custom = { ...CUSTOM_DEFAULTS };
    prefs.save();
    applyPrefs();
    toast('Настройки оформления сброшены', 'ok');
  };

  // вкладки плагинов, игроков и ошибок
  bindAddons();
  bindFileDrop();
  bindCmdComplete();
  bindAddonsPage();

  const playersRefresh = $('playersRefresh');
  if (playersRefresh) {
    playersRefresh.onclick = async () => {
      const s = current();
      if (!s) return;
      if (s.state !== 'running') { notify({ title: 'Сервер остановлен', kind: 'warn' }); return; }
      await API.command(s.id, 'list');
      Sound.play('click');
    };
  }
  const issuesScan = $('issuesScan');
  if (issuesScan) {
    issuesScan.onclick = () => {
      const s = current();
      if (!s) return;
      rescanIssues(s.id);
      const found = (S.issues.get(s.id) || []).length;
      notify({ title: found ? 'Ошибки найдены' : 'Ошибок нет', text: found ? 'всего: ' + found : '', kind: found ? 'err' : 'ok' });
    };
  }
  const issuesClear = $('issuesClear');
  if (issuesClear) {
    issuesClear.onclick = () => {
      const s = current();
      if (!s) return;
      S.issues.set(s.id, []);
      S.issuesNew.set(s.id, 0);
      renderIssues();
      renderIssuesBadge();
    };
  }
  const fromWall = $('themeFromWall');
  if (fromWall) fromWall.onclick = () => themeFromWallpaper();

  // вкладка TPS
  $('tpsRange').onchange = () => renderTpsTab();
  $('tpsClearBtn').onclick = async () => {
    const s = current();
    if (!s) return;
    const ok = await askConfirm({ title: 'Очистить историю TPS?', text: 'Сохранённые замеры этого сервера будут удалены.', okLabel: 'Очистить' });
    if (!ok) return;
    await API.tpsClear(s.id);
    S.tpsFull.set(s.id, []);
    renderTpsTab();
    toast('История TPS очищена');
  };

  // вкладка бэкапов
  $('backupCreate').onclick = async () => {
    const s = current();
    if (!s) return;
    if (!s.cwd) { toast('У сервера не задана рабочая папка', 'err'); return; }
    const btn = $('backupCreate');
    btn.disabled = true;
    btn.textContent = 'Архивирую…';
    let made = null;
    try {
      const res = await API.backupCreate(s.id, {});
      if (res && res.ok === false) throw new Error(res.error || 'не удалось упаковать папку');
      made = res && res.name ? res : null;
      toast(made
        ? `Бэкап создан: ${made.name}` + (made.ratio ? ` · плотнее в ${made.ratio} раза` : '')
        : 'Бэкап создан', 'ok');
    } catch (e) {
      toast('Не удалось создать бэкап: ' + e.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Создать бэкап';
      await loadBackups();
      /* архив пишется на диск не мгновенно — если его ещё нет в списке, обновим ещё раз */
      if (made && !S.backups.some((b) => b.name === made.name)) {
        await new Promise((r) => setTimeout(r, 500));
        await loadBackups();
      }
    }
  };
  $('backupReveal').onclick = async () => {
    const s = current();
    if (!s) return;
    const res = await API.backupReveal(s.id);
    if (res && res.ok === false) toast(res.error || 'Только в exe-версии', 'err');
  };

  // серверы
  $('addBtn').onclick = () => openModal(null);
  $('emptyAdd').onclick = () => openModal(null);
  $('scanBtn').onclick = openScan;
  $('emptyScan').onclick = openScan;

  // модалка сервера
  $('modalClose').onclick = $('modalCancel').onclick = closeModal;
  $('modalSave').onclick = saveModal;
  $('btnDelete').onclick = () => { const id = editingId; closeModal(); if (id) doDelete(id); };
  el.modal.addEventListener('mousedown', (e) => { if (e.target === el.modal) closeModal(); });
  $('f_name').addEventListener('input', () => { if (!pendingIcon) setIconPreview('', $('f_name').value); });

  $('pickIcon').onclick = async () => {
    if (!IS_DESKTOP) { pickIconInBrowser(); return; }
    const dataUrl = await API.pickIcon();
    if (!dataUrl) return;
    pendingIcon = dataUrl;
    setIconPreview(pendingIcon, $('f_name').value);
    ieOpen(dataUrl);
    Sound.play('ok');
  };
  $('clearIcon').onclick = () => {
    pendingIcon = '';
    setIconPreview('', $('f_name').value);
    $('iconEditor').classList.add('hidden');
    IE.active = false;
  };

  // текущая аватарка → server-icon.png в папке сервера
  $('iconToServer').onclick = async () => {
    const cwd = $('f_cwd').value.trim();
    if (!cwd) { toast('Папка не задана', 'err'); return; }
    if (!pendingIcon) { toast('Иконка не выбрана', 'err'); return; }
    const res = await API.iconToServer(cwd, pendingIcon);
    if (!res || res.ok === false) { toast((res && res.error) || 'Не удалось записать server-icon.png', 'err'); return; }
    Sound.play('ok');
    toast('server-icon.png записан (64×64)', 'ok');
  };

  $('propsReload').onclick = async () => {
    const id = editingId;
    const srv = id ? { id, cwd: $('f_cwd').value.trim() } : null;
    await propsLoad(srv);
    Sound.play('click');
  };
  $('iconFromServer').onclick = async () => {
    const cwd = $('f_cwd').value.trim();
    if (!cwd) { toast('Папка не задана', 'err'); return; }
    const dataUrl = await API.iconFromServer(cwd);
    if (!dataUrl) { toast('server-icon.png не найден в папке сервера', 'err'); return; }
    pendingIcon = dataUrl;
    setIconPreview(pendingIcon, $('f_name').value);
    ieOpen(dataUrl);
    toast('Иконка взята из server-icon.png', 'ok');
  };

  $('pickFolder').onclick = async () => {
    const p = await API.pickFolder();
    if (p) $('f_cwd').value = p;
    else if (!IS_DESKTOP) toast('Выбор папки — только в exe-версии, впиши путь вручную', 'err');
  };
  $('pickFile').onclick = async () => {
    const p = await API.pickFile();
    if (!p) { if (!IS_DESKTOP) toast('Выбор файла — только в exe-версии', 'err'); return; }
    $('f_command').value = /\s/.test(p) ? `"${p}"` : p;
    if (!$('f_cwd').value.trim()) {
      const dir = p.replace(/[\\/][^\\/]+$/, '');
      if (dir) $('f_cwd').value = dir;
    }
  };

  // сканер
  $('scanClose').onclick = $('scanDone').onclick = closeScan;
  $('scanAll').onclick = async () => {
    const roots = await API.scanRoots();
    runScan(roots);
  };
  $('scanPick').onclick = async () => {
    const dirs = await API.pickFolders();
    if (dirs && dirs.length) runScan(dirs);
    else if (!IS_DESKTOP) toast('В браузерном режиме сканируются диски целиком', 'err');
  };
  $('scanStop').onclick = () => { API.scanCancel(); toast('Останавливаю сканирование…'); };
  $('scanAddAll').onclick = async () => {
    const pending = [...S.scan.byPath.values()]
      .filter((f) => f.kind !== 'minecraft-plugin' && !S.scan.seen.has(f.path.toLowerCase()));
    if (!pending.length) { toast('Все найденные серверы уже добавлены'); return; }
    for (const f of pending) {
      await addFromScan(f);
      const node = el.scanResults.querySelector(`[data-path="${CSS.escape(f.path)}"]`);
      if (node) {
        node.classList.add('added');
        const btn = node.querySelector('.si-add');
        if (btn) { btn.disabled = true; btn.textContent = 'Уже добавлен'; }
      }
    }
    toast(`Добавлено серверов: ${pending.length}`, 'ok');
  };
}



/* ═════════════════ шапка (одна и та же в окне и в полном экране) ═════════════════ */

/** По центру — «Сервер — состояние»; обновляется и в окне, и в полном экране. */
function topbarUpdate() {
  const s = S.servers.find((x) => x.id === S.currentId);
  const text = (() => {
    if (!s) return 'OmniPanel — сервер не выбран';
    const state = STATE_LABEL[s.state] || s.state || 'остановлен';
    const up = s.state === 'running' && s.startedAt ? ` · ${fmtUptime(Date.now() - s.startedAt)}` : '';
    return `${s.name} — ${state}${up}`;
  })();
  for (const id of ['tbText']) {
    const box = $(id);
    if (!box) continue;
    box.textContent = text;
    if (s) {
      box.classList.toggle('live', s.state === 'running');
      box.classList.toggle('warn', s.state === 'stopping');
    }
  }
}

/** Совместимость: раньше полоса полного экрана обновлялась отдельно. */
function fsbUpdate() {
  topbarUpdate();
}


/* ═════════════════ server.properties: полная настройка ═════════════════ */

const PF = { id: null, cwd: '', props: {}, exists: false, group: 'main', search: '' };

function pfSchema() {
  return (typeof PROP_SCHEMA !== 'undefined' && PROP_SCHEMA) ? PROP_SCHEMA : { groups: [], props: [], byKey: {} };
}

function pfValue(key) {
  const def = pfSchema().byKey[key];
  const v = PF.props[key];
  if (v === null || v === undefined) return def && def.def !== undefined ? def.def : '';
  return v;
}

function pfFieldHtml(p) {
  const val = pfValue(p.key);
  const cur = val === null || val === undefined ? '' : String(val);
  const common = `data-key="${esc(p.key)}" data-type="${p.type}"`;
  if (p.type === 'bool') {
    const on = String(cur).toLowerCase() === 'true' || cur === '1';
    return `<div class="field pf-bool"><span class="lbl">${esc(p.label)}</span>
      <span class="pf-toggle"><em class="pf-key">${esc(p.key)}</em>
      <label class="check"><input type="checkbox" ${common} ${on ? 'checked' : ''}/><span></span></label></span></div>`;
  }
  if (p.type === 'enum') {
    const opts = (p.options || []).map((o) => `<option value="${esc(o.v)}"${o.v === cur ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
    return `<label class="field"><span class="lbl">${esc(p.label)} <em class="pf-key">${esc(p.key)}</em></span>
      <select ${common}>${opts}</select></label>`;
  }
  if (p.type === 'num') {
    const min = p.min !== undefined ? ` min="${p.min}"` : '';
    const max = p.max !== undefined ? ` max="${p.max}"` : '';
    return `<label class="field"><span class="lbl">${esc(p.label)} <em class="pf-key">${esc(p.key)}</em></span>
      <input type="number"${min}${max} value="${esc(cur)}" ${common} /></label>`;
  }
  return `<label class="field"><span class="lbl">${esc(p.label)} <em class="pf-key">${esc(p.key)}</em></span>
    <input type="text" value="${esc(cur)}" spellcheck="false" ${common} /></label>`;
}

function pfRender() {
  const host = $('propsFields');
  const nav = $('propsGroups');
  if (!host || !nav) return;
  const schema = pfSchema();
  const q = PF.search.trim().toLowerCase();

  // ключи, которых нет в схеме (плагины, моды) — отдельным разделом
  const known = new Set(schema.props.map((p) => p.key));
  const extras = Object.keys(PF.props).filter((k) => !known.has(k));

  const groups = schema.groups.slice();
  if (extras.length) groups.push({ id: 'extra', label: 'Свои ключи' });

  nav.innerHTML = groups.map((g) => {
    const count = g.id === 'extra' ? extras.length : schema.props.filter((p) => p.group === g.id).length;
    return `<button class="props-group${g.id === PF.group ? ' active' : ''}" data-group="${g.id}">${esc(g.label)}<span>${count}</span></button>`;
  }).join('');
  for (const b of nav.querySelectorAll('.props-group')) {
    b.onclick = () => { PF.group = b.dataset.group; pfRender(); };
  }

  let list;
  if (q) list = schema.props.filter((p) => p.key.toLowerCase().includes(q) || p.label.toLowerCase().includes(q));
  else if (PF.group === 'extra') list = extras.map((k) => ({ key: k, label: k, type: 'extra', group: 'extra' }));
  else list = schema.props.filter((p) => p.group === PF.group);

  if (!list.length) { host.innerHTML = '<div class="pf-empty">ничего не найдено</div>'; return; }

  host.innerHTML = list.map((p) => (p.type === 'extra'
    ? `<label class="field"><span class="lbl">${esc(p.key)} <em class="pf-key">свой ключ</em></span>
        <input type="text" value="${esc(String(PF.props[p.key] == null ? '' : PF.props[p.key]))}" spellcheck="false" data-key="${esc(p.key)}" data-type="extra" /></label>`
    : pfFieldHtml(p))).join('');

  // числа: не даём выйти за границы, но и не мешаем печатать
  for (const inp of host.querySelectorAll('input[type=number]')) {
    inp.addEventListener('blur', () => {
      const min = inp.min !== '' ? Number(inp.min) : null;
      const max = inp.max !== '' ? Number(inp.max) : null;
      let v = Number(inp.value);
      if (inp.value.trim() === '' || Number.isNaN(v)) return;
      if (min !== null && v < min) v = min;
      if (max !== null && v > max) v = max;
      inp.value = String(v);
    });
  }
}

function pfCollect() {
  const patch = {};
  const host = $('propsFields');
  if (!host) return patch;
  for (const inp of host.querySelectorAll('[data-key]')) {
    const key = inp.dataset.key;
    const type = inp.dataset.type;
    if (type === 'bool') {
      const v = !!inp.checked;
      if (PF.props[key] === v) continue;
      patch[key] = v;
    } else if (type === 'num') {
      const raw = inp.value.trim();
      if (raw === '') continue;
      const v = Number(raw);
      if (Number.isNaN(v)) continue;
      if (String(PF.props[key]) === String(v)) continue;
      patch[key] = v;
    } else {
      const v = inp.value;
      if (String(PF.props[key] == null ? '' : PF.props[key]) === v) continue;
      patch[key] = v;
    }
  }
  return patch;
}

async function pfOpen(server) {
  const s = server || S.servers.find((x) => x.id === S.currentId);
  if (!s || !s.id || !s.cwd) {
    notify({ title: 'Нет папки сервера', text: 'Папка не задана.', kind: 'warn' });
    return;
  }
  PF.id = s.id;
  PF.cwd = s.cwd;
  PF.group = 'main';
  PF.search = '';
  const res = await API.propsRead(s.id);
  if (!res || res.ok === false || res.error) {
    notify({ title: 'Не удалось прочитать', text: (res && res.error) || 'server.properties недоступен', kind: 'err' });
    return;
  }
  PF.props = { ...(res.props || {}), ...(res.other || {}) };
  PF.exists = !!res.exists;
  $('propsSearch').value = '';
  $('propsFullState').textContent = PF.exists ? 'server.properties найден' : 'файла нет — создам при сохранении';
  pfRender();
  $('propsModal').classList.remove('hidden');
  Sound.play('nav');
}

async function pfSave() {
  const patch = pfCollect();
  if (!Object.keys(patch).length) {
    $('propsModal').classList.add('hidden');
    toast('Ничего не изменилось');
    return;
  }
  const res = await API.propsWrite(PF.id, patch);
  if (!res || res.ok === false || res.error) {
    toast((res && res.error) || 'Не удалось записать server.properties', 'err');
    return;
  }
  $('propsModal').classList.add('hidden');
  Sound.play('ok');
  toast(`server.properties обновлён — параметров: ${Object.keys(patch).length}`, 'ok');
  const s = S.servers.find((x) => x.id === PF.id);
  if (s) propsLoad(s);
}

function bindPropsFull() {
  const open = $('propsAll');
  if (open) open.onclick = () => pfOpen();
  const close = $('propsModalClose');
  if (close) close.onclick = () => $('propsModal').classList.add('hidden');
  const cancel = $('propsFullCancel');
  if (cancel) cancel.onclick = () => $('propsModal').classList.add('hidden');
  const save = $('propsFullSave');
  if (save) save.onclick = () => pfSave();
  const search = $('propsSearch');
  if (search) search.oninput = () => { PF.search = search.value; pfRender(); };
  const defs = $('propsFullDefaults');
  if (defs) {
    defs.onclick = () => {
      for (const p of pfSchema().props) {
        if (p.def === undefined) continue;
        if (p.type === 'bool') PF.props[p.key] = p.def === 'true';
        else if (p.type === 'num') PF.props[p.key] = Number(p.def);
        else PF.props[p.key] = p.def;
      }
      pfRender();
      Sound.play('click');
      toast('Подставлены значения по умолчанию');
    };
  }
}


/* ═════════════════ добавление сервера из GitHub ═════════════════ */

const GA = { src: 'account', repo: '', token: '', repos: [] };

function gaMode(mode) {
  for (const b of document.querySelectorAll('#addMode .seg-btn')) b.classList.toggle('active', b.dataset.mode === mode);
  $('ghAdd').classList.toggle('hidden', mode !== 'gh');
  if (mode === 'gh') gaSource(GA.src);
}

function gaSource(src) {
  GA.src = src;
  for (const b of document.querySelectorAll('#ghAddSrc .seg-btn')) b.classList.toggle('active', b.dataset.src === src);
  $('ghAddAccount').classList.toggle('hidden', src !== 'account');
  $('ghAddTokenRow').classList.toggle('hidden', src !== 'token');
  if (src === 'account') gaLoadRepos();
}

async function gaLoadRepos(query = '') {
  const host = $('ghAddRepos');
  if (!host) return;
  host.innerHTML = '<div class="gh-repo">загружаю список…</div>';
  const res = await API.ghRepos(query);
  if (!res || !res.ok) {
    host.innerHTML = `<div class="gh-repo">${esc((res && res.error) || 'не удалось загрузить — войди в аккаунт или вставь токен')}</div>`;
    return;
  }
  GA.repos = res.repos || [];
  if (!GA.repos.length) { host.innerHTML = '<div class="gh-repo">репозиториев нет</div>'; return; }
  host.innerHTML = '';
  for (const r of GA.repos.slice(0, 80)) {
    const el = document.createElement('div');
    el.className = 'gh-repo act';
    el.dataset.repo = r.full;
    if (r.full === GA.repo) el.classList.add('sel');
    el.innerHTML = `${esc(r.full)}<span class="r-tag">${r.private ? 'приватный' : 'публичный'}</span>`;
    el.onclick = () => {
      GA.repo = r.full;
      host.querySelectorAll('.gh-repo').forEach((n) => n.classList.remove('sel'));
      el.classList.add('sel');
      $('ghAddState').textContent = 'выбран: ' + r.full;
      if (!$('f_name').value.trim()) $('f_name').value = r.name || r.full.split('/')[1];
      Sound.play('click');
    };
    host.appendChild(el);
  }
}

async function gaDownload() {
  if (!GA.repo) { notify({ title: 'Репозиторий не выбран', text: 'Выбери репозиторий из списка.', kind: 'warn' }); return; }
  const dir = $('ghAddDir').value.trim();
  if (!dir) { notify({ title: 'Куда скачать?', text: 'Выбери папку кнопкой «обзор…».', kind: 'warn' }); return; }
  const btn = $('ghAddDownload');
  btn.disabled = true;
  btn.textContent = 'Скачиваю…';
  $('ghAddState').textContent = 'качаю архив репозитория…';
  const res = await API.ghDownload({
    repo: GA.repo,
    branch: $('ghAddBranch').value.trim() || 'main',
    dir,
    token: GA.src === 'token' ? ($('ghAddToken').value.trim() || GA.token) : '',
  });
  btn.disabled = false;
  btn.textContent = 'Скачать сервер';
  if (!res || !res.ok) {
    $('ghAddState').textContent = 'не вышло';
    notify({ title: 'Не удалось скачать', text: (res && res.error) || 'ошибка GitHub', kind: 'err' });
    return;
  }
  $('ghAddState').textContent = `готово: файлов ${res.files}`;
  $('f_cwd').value = res.dir;
  if (res.command && !$('f_command').value.trim()) $('f_command').value = res.command;
  if (!$('f_name').value.trim()) $('f_name').value = String(res.repo || '').split('/')[1] || '';
  // сразу привязываем синхронизацию к этому репозиторию
  $('f_syncEnabled').checked = true;
  $('f_syncRepo').value = res.repo;
  $('f_syncBranch').value = res.branch || 'main';
  syncToggleBody();
  gaMode('local');
  notify({ title: 'Сервер скачан', text: `${res.repo} → ${res.dir}`, kind: 'ok' });
  Sound.play('ok');
}

function bindGithubAdd() {
  for (const b of document.querySelectorAll('#addMode .seg-btn')) b.onclick = () => gaMode(b.dataset.mode);
  for (const b of document.querySelectorAll('#ghAddSrc .seg-btn')) b.onclick = () => gaSource(b.dataset.src);
  const reload = $('ghAddReload');
  if (reload) reload.onclick = () => gaLoadRepos($('ghAddSearch').value.trim());
  let q = null;
  const search = $('ghAddSearch');
  if (search) search.oninput = () => { clearTimeout(q); q = setTimeout(() => gaLoadRepos(search.value.trim()), 400); };
  const apply = $('ghAddTokenApply');
  if (apply) apply.onclick = async () => {
    const tk = $('ghAddToken').value.trim();
    if (!tk) { notify({ title: 'Токен пустой', text: 'Вставь токен GitHub с правами repo.', kind: 'err' }); return; }
    const res = await API.ghLogin(tk);
    if (!res || !res.ok) { notify({ title: 'Токен не подошёл', text: (res && res.error) || 'проверь права repo', kind: 'err' }); return; }
    GA.token = tk;
    notify({ title: 'Токен принят', text: `GitHub: ${res.login}`, kind: 'ok' });
    gaSource('account');
    ghRefreshAccount();
  };
  const pick = $('ghAddDirPick');
  if (pick) pick.onclick = async () => {
    const p = await API.pickFolder();
    if (p) $('ghAddDir').value = p;
  };
  const dl = $('ghAddDownload');
  if (dl) dl.onclick = () => gaDownload();
}


/* ═════════════════ вход в аккаунт GitHub по коду ═════════════════ */

const GD = { timer: null, code: '', interval: 5, run: 0, busy: false, fails: 0 };

function gdShow(on) {
  $('ghDeviceBox').classList.toggle('hidden', !on);
  $('ghDeviceBtn').classList.toggle('hidden', on);
}

function gdStop(msg) {
  GD.run += 1;
  if (GD.timer) { clearTimeout(GD.timer); GD.timer = null; }
  GD.busy = false;
  GD.fails = 0;
  GD.code = '';
  if (msg) $('ghDeviceState').textContent = msg;
  if (!msg) $('ghDeviceState').textContent = 'вход завершён';
}

/** Один шаг ожидания: setTimeout, а не setInterval — иначе запросы накладываются. */
function gdSchedule(run) {
  if (run !== GD.run) return;
  GD.timer = setTimeout(() => gdTick(run), GD.interval * 1000);
}

async function gdTick(run) {
  if (run !== GD.run) return;
  if (GD.busy) { gdSchedule(run); return; }
  const code = GD.code;
  if (!code) { gdStop(''); gdShow(false); return; }
  GD.busy = true;
  const r = await API.ghDevicePoll(code).catch(() => null);
  GD.busy = false;
  if (run !== GD.run) return;

  if (r && r.pending) {
    GD.fails = 0;
    $('ghDeviceState').textContent = 'ждём подтверждения на GitHub…';
    if (r.slow) GD.interval += 5;
    gdSchedule(run);
    return;
  }
  if (r && r.ok) {
    gdStop('');
    gdShow(false);
    $('ghDeviceState').textContent = 'ждём подтверждения на GitHub…';
    await ghRefreshAccount();
    gaLoadRepos();
    notify({ title: 'Вход выполнен', text: `GitHub: ${r.login || 'аккаунт'}`, kind: 'ok' });
    return;
  }
  /* сеть моргнула — пробуем ещё пару раз, вход не обрываем */
  const transient = r && (r.code === 'network' || r.code === 'no-data' || (!r.code && r.error));
  if (transient && GD.fails < 3) {
    GD.fails += 1;
    $('ghDeviceState').textContent = 'связь с GitHub пропала — пробую снова…';
    gdSchedule(run);
    return;
  }
  /* настоящая ошибка: одно уведомление и стоп */
  gdStop('');
  gdShow(false);
  notify({ title: 'Вход не выполнен', text: (r && r.error) || 'не удалось', kind: 'err' });
}

async function gdStart() {
  if (GD.code && GD.timer) { gdTick(GD.run); return; }   // уже ждём — второй код не просим
  const btn = $('ghDeviceBtn');
  btn.disabled = true;
  const res = await API.ghDeviceStart().catch(() => null);
  btn.disabled = false;
  if (!res || !res.ok || !res.deviceCode) {
    notify({ title: 'Не удалось начать вход', text: (res && res.error) || 'GitHub не выдал код', kind: 'err' });
    return;
  }
  GD.run += 1;
  const run = GD.run;
  GD.code = String(res.deviceCode);
  GD.interval = Math.max(5, Number(res.interval) || 5);
  GD.busy = false;
  GD.fails = 0;
  $('ghDeviceCode').textContent = String(res.userCode || '').toUpperCase();
  $('ghDeviceState').textContent = 'ждём подтверждения на GitHub…';
  gdShow(true);
  Sound.play('ok');
  gdSchedule(run);
}

function bindGithubDevice() {
  const btn = $('ghDeviceBtn');
  if (!btn) return;
  btn.onclick = () => gdStart();
  const open = $('ghDeviceOpen');
  if (open) open.onclick = () => API.ghOpenExternal('https://github.com/login/device');
  const copy = $('ghDeviceCopy');
  if (copy) copy.onclick = async () => {
    const code = $('ghDeviceCode').textContent.trim();
    try { await navigator.clipboard.writeText(code); toast('Код скопирован: ' + code, 'ok'); }
    catch { toast('Код: ' + code); }
  };
  const stop = $('ghDeviceStop');
  if (stop) stop.onclick = () => { gdStop('вход отменён'); gdShow(false); };
  const toggle = $('ghTokenToggle');
  if (toggle) {
    toggle.onclick = () => {
      const row = $('ghTokenRow');
      const open = row.classList.contains('hidden');
      row.classList.toggle('hidden', !open);
      toggle.classList.toggle('active', open);
      if (open) setTimeout(() => $('ghToken').focus(), 30);
    };
  }
}

/* ═════════════════════ обновления из GitHub ═════════════════════ */

const UPD = { cfg: null, last: null, busy: false };

function updFmtMB(bytes) {
  if (!bytes) return '';
  return (bytes / 1048576).toFixed(bytes > 10485760 ? 0 : 1) + ' МБ';
}

function updRenderState(res, extra = '') {
  const state = $('updState');
  const notes = $('updNotes');
  const tab = document.querySelector('.prefs-tab[data-cat="upd"]');
  if (tab) tab.classList.toggle('has-new', !!(res && res.ok && res.hasUpdate));
  if (!state) return;
  state.classList.remove('new', 'err');
  if (!res) {
    state.textContent = 'проверка не выполнялась';
    notes.textContent = '';
    $('updApplyBtn').disabled = true;
    $('updFullBtn').disabled = true;
    return;
  }
  if (!res.ok) {
    state.textContent = res.error || 'не удалось проверить';
    state.classList.add('err');
    notes.textContent = '';
    return;
  }
  if (res.hasUpdate) {
    const parts = [`доступна версия ${res.latest}`];
    if (res.code) parts.push('код ' + updFmtMB(res.code.size));
    if (res.setup) parts.push('установщик ' + updFmtMB(res.setup.size));
    else if (res.full) parts.push('сборка ' + updFmtMB(res.full.size));
    state.textContent = parts.join(' · ');
    state.classList.add('new');
  } else {
    state.textContent = `последняя версия · проверено ${new Date(res.checkedAt || Date.now()).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
  }
  notes.textContent = res.notes ? res.notes : '';
  if (res.ok && res.hasUpdate) {
    $('updApplyBtn').disabled = !res.code;
    $('updFullBtn').disabled = !(res.setup || res.full);
  } else {
    $('updApplyBtn').disabled = true;
    $('updFullBtn').disabled = !(res.ok && (res.setup || res.full));
  }
  if (extra) notes.textContent = extra;
}

async function updLoad() {
  if (!API.updConfig) return;
  const cfg = await API.updConfig().catch(() => null);
  if (!cfg) return;
  UPD.cfg = cfg;
  $('updCurVer').textContent = 'Версия ' + (cfg.current || '—');
  $('updRepo').value = cfg.repo || cfg.repoDefault || '';
  $('updBranch').value = cfg.branch || 'main';
  $('updAuto').checked = cfg.auto !== false;
  $('updAutoInstall').checked = cfg.autoInstall !== false;
  if (cfg.repo) {
    // репозиторий известен (свой или заданный) — просто ждём проверки
  }
  if (!cfg.repo) {
    $('updState').textContent = 'укажи репозиторий обновлений';
  } else if (UPD.last) {
    updRenderState(UPD.last);
  } else {
    $('updState').textContent = cfg.lastCheck ? 'готово к проверке' : 'проверка не выполнялась';
  }
  updRenderState(UPD.last);
  if (!cfg.repo) $('updState').textContent = 'укажи репозиторий обновлений';
}

async function updCheckFlow() {
  if (UPD.busy) return;
  UPD.busy = true;
  $('updCheckBtn').disabled = true;
  $('updState').textContent = 'проверяю GitHub…';
  $('updNotes').textContent = '';
  try {
    const res = await API.updCheck();
    UPD.last = res;
    updRenderState(res);
    if (res.ok && res.hasUpdate) {
      notify({ title: 'Есть обновление', text: `OmniPanel ${res.latest}`, kind: 'ok' });
    } else if (res.ok) {
      notify({ title: 'Обновлений нет', text: 'Установлена последняя версия.', kind: 'ok' });
    } else {
      notify({ title: 'Не удалось проверить', text: res.error, kind: 'err' });
    }
  } finally {
    UPD.busy = false;
    $('updCheckBtn').disabled = false;
  }
}

async function updApplyFlow() {
  if (UPD.busy) return;
  const res = await API.updApply();
  if (!res.ok) { notify({ title: 'Обновление не встало', text: res.error, kind: 'err' }); return; }
  $('updState').textContent = `обновлено до ${res.version}, перезапускаюсь…`;
  const kept = (res.kept || []).length;
  const extra = kept ? ' Настройки и серверы на месте.' : '';
  notify({
    title: 'Обновлено до ' + res.version,
    text: `Файлов: ${res.files}.${extra} Панель перезапустится сама.`,
    kind: 'ok',
    ms: 7000,
  });
}

async function updFullFlow() {
  if (UPD.busy) return;
  UPD.busy = true;
  $('updState').textContent = 'скачиваю установщик…';
  try {
    const res = await API.updDownloadFull();
    if (!res.ok) { notify({ title: 'Не удалось скачать установщик', text: res.error, kind: 'err' }); $('updState').textContent = res.error; return; }
    if (res.setup) {
      $('updNotes').textContent = `Установщик скачан: ${res.archive}\nЗапусти его — он обновит панель и сохранит все настройки и серверы.`;
      notify({ title: 'Установщик скачан', text: 'Запусти файл из открывшейся папки — данные сохранятся.', kind: 'ok', ms: 7000 });
    } else {
      $('updNotes').textContent = `Сборка скачана: ${res.archive}\nЗапусти «Обновить-OmniPanel.bat» рядом с папкой программы.`;
      notify({ title: 'Сборка скачана', text: 'Запусти «Обновить-OmniPanel.bat» рядом с папкой программы.', kind: 'ok', ms: 7000 });
    }
  } finally {
    UPD.busy = false;
  }
}

/** Мерцающая плашка «доступно обновление» в шапке окна. */
function setUpdPill(info) {
  const pill = $('updPill');
  if (!pill) return;
  const has = !!(info && info.hasUpdate && info.latest);
  const tab = document.querySelector('#prefsNav .prefs-tab[data-cat="upd"]');
  if (tab) tab.classList.toggle('has-new', has);
  if (!has) { pill.classList.add('hidden'); return; }
  const text = $('updPillText');
  if (text) text.textContent = 'обновление ' + info.latest;
  pill.classList.remove('hidden');
  pill.onclick = () => {
    openPrefs();
    setPrefsCat('upd');
    updLoad();
    Sound.play('click');
  };
}

function bindUpdates() {
  if (!API.updConfig) return;

  const saveCfg = async (patch) => {
    const cfg = await API.updSave(patch).catch(() => null);
    if (cfg) UPD.cfg = cfg;
  };

  $('updRepo').onchange = (e) => {
    const v = e.target.value.trim();
    e.target.value = v;
    saveCfg({ repo: v });
    UPD.last = null;
    $('updState').textContent = v ? 'готово к проверке' : 'репозиторий не задан';
    $('updNotes').textContent = '';
  };
  $('updBranch').onchange = (e) => {
    const v = e.target.value.trim() || 'main';
    e.target.value = v;
    saveCfg({ branch: v });
  };
  $('updAuto').onchange = (e) => saveCfg({ auto: e.target.checked });
  $('updAutoInstall').onchange = (e) => saveCfg({ autoInstall: e.target.checked });

  $('updCheckBtn').onclick = updCheckFlow;
  $('updApplyBtn').onclick = updApplyFlow;
  $('updFullBtn').onclick = updFullFlow;
  $('updBackups').onclick = async () => {
    const res = await API.updRevealBackups();
    if (res && res.ok) notify({ title: 'Папка бэкапов', text: res.dir, kind: 'info' });
  };

  if (API.onUpdState) {
    API.onUpdState((st) => { if (st && st.ok) setUpdPill(st); });
  }

  if (API.onUpdProgress) {
    API.onUpdProgress((p) => {
      const bar = $('updProg');
      if (!bar) return;
      if (p.phase === 'download' || p.phase === 'full') {
        bar.classList.remove('hidden');
        const pct = p.total ? Math.min(100, Math.round((p.received / p.total) * 100)) : 8;
        bar.querySelector('i').style.width = pct + '%';
        if (p.phase === 'full') $('updState').textContent = `качаю полную сборку… ${updFmtMB(p.received)}`;
      } else if (p.phase === 'retry') {
        $('updState').textContent = 'кэш GitHub отдал старую копию — качаю заново…';
      } else if (p.phase === 'install') {
        bar.classList.remove('hidden');
        bar.querySelector('i').style.width = '100%';
        $('updState').textContent = 'раскладываю файлы…';
      } else if (p.phase === 'restart') {
        $('updState').textContent = 'перезапуск…';
      } else if (p.phase === 'full-done') {
        bar.querySelector('i').style.width = '100%';
        setTimeout(() => bar.classList.add('hidden'), 1500);
      }
    });
  }

  if (API.onUpdReady) {
    API.onUpdReady((info) => {
      const note = info && info.when === 'exit'
        ? 'Обновление скачано и встанет, когда закроешь панель.'
        : 'Обновление готово к установке.';
      $('updState').textContent = note;
    });
  }

  if (API.onUpdAvailable) {
    API.onUpdAvailable((info) => {
      UPD.last = info;
      setUpdPill(info);
      notify({
        title: 'Доступно обновление',
        text: `OmniPanel ${info.latest}. Нажми, чтобы открыть настройки обновлений.`,
        kind: 'info',
        ms: 9000,
        onClick: () => {
          openPrefs();
          setPrefsCat('upd');
          updLoad();
        },
      });
      updRenderState(info);
    });
  }
}

/* ═════════════════════ игроки онлайн ═════════════════════ */

const PLAYER_RE = [
  // Paper / Spigot / Vanilla
  { re: /^([A-Za-z0-9_]{3,16})\s+joined the game/i, on: true },
  { re: /^([A-Za-z0-9_]{3,16})\s+left the game/i, on: false },
  // Forge / старые ядра
  { re: /^([A-Za-z0-9_]{3,16}) ?\[\/[0-9.]+\] logged in with entity id/i, on: true },
  { re: /^([A-Za-z0-9_]{3,16})\s+lost connection/i, on: false },
  // ответ на list
  { re: /There are (\d+) of a max(?:imum)? of (\d+) players online:?\s*(.*)$/i, list: true },
  { re: /There are (\d+)\/(\d+) players online:?\s*(.*)$/i, list: true },
];

function playersState(id) {
  if (!S.players.has(id)) S.players.set(id, { names: new Set(), max: 0, at: 0 });
  return S.players.get(id);
}

function playersSet(id, names, max) {
  const st = playersState(id);
  st.names = new Set(names);
  if (max) st.max = max;
  st.at = Date.now();
  if (id === S.currentId) { renderPlayers(); updateOnlineChip(); }
}

function playersOnLog(id, line) {
  const text = stripLogPrefix(line);
  for (const rule of PLAYER_RE) {
    const m = text.match(rule.re);
    if (!m) continue;
    if (rule.list) {
      const names = m[3].split(/,\s*/).map((x) => x.trim()).filter(Boolean);
      playersSet(id, names, Number(m[2]) || names.length);
      return;
    }
    const name = m[1];
    const st = playersState(id);
    if (rule.on) st.names.add(name);
    else st.names.delete(name);
    st.at = Date.now();
    if (id === S.currentId) { renderPlayers(); updateOnlineChip(); }
    return;
  }
}

function updateOnlineChip() {
  const chip = $('onlineChip');
  if (!chip) return;
  const s = current();
  const st = s ? S.players.get(s.id) : null;
  const count = st ? st.names.size : 0;
  const show = !!s && (s.state === 'running' || count > 0);
  chip.classList.toggle('hidden', !show);
  const txt = $('onlineText');
  if (txt) txt.textContent = st && st.max ? `${count} из ${st.max}` : String(count);
}

function headUrl(name, size = 40) {
  return `https://mc-heads.net/avatar/${encodeURIComponent(name)}/${size}`;
}

function renderPlayers() {
  const host = $('playerList');
  if (!host) return;
  const s = current();
  if (!s) { host.innerHTML = ''; return; }
  const st = playersState(s.id);
  const names = [...st.names].sort((a, b) => a.localeCompare(b));
  const sub = $('playersSub');
  if (sub) {
    sub.textContent = st.max
      ? `онлайн ${names.length} из ${st.max}${st.at ? ' · обновлено ' + fmtTime(st.at) : ''}`
      : `онлайн ${names.length}${st.at ? ' · обновлено ' + fmtTime(st.at) : ''}`;
  }
  if (!names.length) {
    host.innerHTML = `<div class="empty-note">${s.state === 'running' ? 'игроков нет' : 'сервер не запущен'}</div>`;
    return;
  }
  host.innerHTML = '';
  for (const name of names) {
    const card = document.createElement('div');
    card.className = 'player-card';
    card.innerHTML = `
      <span class="pl-ava"><img src="${headUrl(name)}" alt="" loading="lazy" /></span>
      <span class="pl-name">${esc(name)}</span>
      <button class="btn btn-mini pl-kick">Кик</button>`;
    const img = card.querySelector('img');
    img.onerror = () => { card.querySelector('.pl-ava').textContent = name.slice(0, 1).toUpperCase(); };
    card.querySelector('.pl-kick').onclick = async () => {
      await API.command(s.id, `kick ${name}`);
      notify({ title: 'Команда отправлена', text: `kick ${name}`, kind: 'info' });
    };
    host.appendChild(card);
  }
}

/* ═════════════════════ ошибки при запуске ═════════════════════ */

const ISSUE_RULES = [
  { re: /\[(?:ERROR|SEVERE|FATAL)\]|\[(?:ERROR|SEVERE|FATAL)\]/i, kind: 'error' },
  { re: /\b(?:java|javax|net|io|org|com|kotlin)\.[\w.$]+(?:Exception|Error)\b/, kind: 'error' },
  { re: /\b(?:Caused by|Exception in thread)\b/, kind: 'error' },
  { re: /\bOutOfMemoryError\b|\bOutOfMemory\b/, kind: 'crash' },
  { re: /Address already in use|EADDRINUSE/i, kind: 'crash' },
  { re: /UnsupportedClassVersionError|Unsupported class file major version/i, kind: 'crash' },
  { re: /Failed to (?:start|load|bind|initialize|download|create)\b/i, kind: 'error' },
  { re: /Could not (?:load|find|open|start|bind)\b/i, kind: 'error' },
  { re: /(?:^|\s)(?:Error|ERROR):\s/, kind: 'error' },
  { re: /(?:Traceback \(most recent call last\))/, kind: 'error' },
  { re: /EROFS|ENOENT|EACCES|permission denied/i, kind: 'error' },
  { re: /Процесс завершён \(код: [1-9]/ , kind: 'exit' },
];

const STACK_RE = /^\s*(?:at\s|\.\.\.\s*\d+\s*more|Caused by:|\tat\s|File\s")/;

const ISSUE_LABEL = { error: 'ошибка', crash: 'падение', exit: 'выход с ошибкой', warn: 'предупреждение' };

function stripLogPrefix(line) {
  return String(line)
    .replace(/^\[[^\]]*\]\s*/, '')
    .replace(/^\[[^\]]*\/[A-Z]+\]:\s*/, '')
    .replace(/^\[[^\]]+\]:\s*/, '')
    .trim();
}

function issuesState(id) {
  if (!S.issues.has(id)) S.issues.set(id, []);
  return S.issues.get(id);
}

function issuesAdd(id, kind, line, extraStack = '') {
  const list = issuesState(id);
  const clean = stripLogPrefix(line).slice(0, 400);
  const key = clean.toLowerCase();
  const found = list.find((it) => it.key === key);
  if (found) {
    found.count += 1;
    found.t = Date.now();
    if (extraStack && !found.stack.length) found.stack = [extraStack];
  } else {
    list.push({ key, kind, line: clean, stack: extraStack ? [extraStack] : [], t: Date.now(), count: 1 });
    if (list.length > 200) list.splice(0, list.length - 200);
    bumpIssueCounter(id, clean);
  }
  if (id === S.currentId) {
    renderIssues();
    if (S.tab === 'issues') markIssuesSeen(id);
  }
}

/** Счётчик непрочитанных: растёт плашкой на вкладке и в шапке. */
function bumpIssueCounter(id, line) {
  const srv = S.servers.find((x) => x.id === id);
  const name = srv ? srv.name : 'сервер';
  const has = (S.issuesNew.get(id) || 0);
  if (!has) {
    const card = notify({
      title: `Ошибка: ${name}`,
      text: line.slice(0, 150),
      kind: 'err',
      ms: 9000,
      onClick: () => { if (id === S.currentId) setTab('issues'); },
    });
    if (card) {
      card.classList.add('blink');
      card.dataset.issueFor = id;
    }
  }
  S.issuesNew.set(id, has + 1);
  renderIssuesBadge();
}

function renderIssuesBadge() {
  const badge = $('issuesBadge');
  if (!badge) return;
  const s = current();
  const n = s ? (S.issuesNew.get(s.id) || 0) : 0;
  badge.textContent = String(n);
  badge.classList.toggle('hidden', n <= 0);
  const tab = document.querySelector('.tab[data-tab="issues"]');
  if (tab) tab.classList.toggle('has-alert', n > 0);
}

/** Открыли вкладку — счётчик обнуляется, мерцание прекращается. */
function markIssuesSeen(id) {
  S.issuesNew.set(id, 0);
  renderIssuesBadge();
  const srv = S.servers.find((x) => x.id === id);
  for (const card of el.toasts.querySelectorAll('.notif.blink')) {
    if (card.dataset.issueFor === id) {
      card.classList.remove('blink');
      card.classList.add('seen');
      if (srv) {
        const t = card.querySelector('.n-title');
        if (t) t.textContent = `Прочитано: ${srv.name}`;
      }
    }
  }
}

function issuesOnLog(id, entry) {
  const line = entry.m || '';
  const clean = stripLogPrefix(line);

  // продолжение стека приклеиваем к последней ошибке
  if (STACK_RE.test(line) || STACK_RE.test(clean)) {
    const list = issuesState(id);
    const last = list[list.length - 1];
    if (last && Date.now() - last.t < 60000 && last.stack.length < 12) {
      last.stack.push(clean.slice(0, 240));
      if (id === S.currentId && S.tab === 'issues') renderIssues();
      return;
    }
  }

  for (const rule of ISSUE_RULES) {
    if (rule.re.test(clean)) {
      issuesAdd(id, rule.kind, line);
      return;
    }
  }
}

function rescanIssues(id) {
  const logs = LOG_CACHE.get(id) || [];
  const keep = new Set((S.issues.get(id) || []).map((i) => i.key));
  S.issues.set(id, (S.issues.get(id) || []).filter((i) => keep.has(i.key)));
  let stack = [];
  for (const e of logs) {
    const clean = stripLogPrefix(e.m || '');
    if (STACK_RE.test(clean)) { stack.push(clean.slice(0, 240)); continue; }
    let hit = null;
    for (const rule of ISSUE_RULES) if (rule.re.test(clean)) { hit = rule; break; }
    if (hit) {
      issuesAdd(id, hit.kind, e.m || '', stack.join('\n'));
      stack = [];
    } else if (clean) {
      stack = [];
    }
  }
  if (id === S.currentId) renderIssues();
}

function renderIssues() {
  const host = $('issuesList');
  if (!host) return;
  const s = current();
  if (!s) { host.innerHTML = ''; return; }
  const list = (S.issues.get(s.id) || []).slice().reverse();
  const sub = $('issuesSub');
  if (sub) {
    sub.textContent = list.length
      ? `найдено ${list.length} разных ошибок · всего повторов: ${list.reduce((a, b) => a + b.count, 0)}`
      : 'ошибок не найдено';
  }
  if (!list.length) {
    host.innerHTML = '<div class="empty-note">в логах чисто</div>';
    return;
  }
  host.innerHTML = '';
  for (const it of list) {
    const card = document.createElement('div');
    card.className = 'issue-card kind-' + it.kind;
    card.innerHTML = `
      <div class="issue-head">
        <span class="issue-kind">${esc(ISSUE_LABEL[it.kind] || 'ошибка')}</span>
        <span class="issue-time">${fmtTime(it.t)}</span>
        ${it.count > 1 ? `<span class="issue-count">×${it.count}</span>` : ''}
      </div>
      <div class="issue-line">${esc(it.line)}</div>
      ${it.stack.length ? `<pre class="issue-stack">${esc(it.stack.slice(0, 12).join('\n'))}</pre>` : ''}
      <div class="issue-actions">
        <button class="btn btn-mini issue-copy">Скопировать</button>
        <button class="btn btn-mini btn-ghost issue-hide">Скрыть</button>
      </div>`;
    card.querySelector('.issue-copy').onclick = () => {
      const text = it.line + (it.stack.length ? '\n' + it.stack.join('\n') : '');
      navigator.clipboard.writeText(text).then(
        () => toast('Скопировано', 'ok'),
        () => toast('Не удалось скопировать', 'err'),
      );
    };
    card.querySelector('.issue-hide').onclick = () => {
      S.issues.set(s.id, (S.issues.get(s.id) || []).filter((x) => x.key !== it.key));
      renderIssues();
    };
    host.appendChild(card);
  }
}

/* ═════════════════════ плагины и моды (Modrinth) ═════════════════════ */

const ADDON_LOADERS = {
  plugin: [
    ['', 'любой загрузчик'], ['paper', 'Paper'], ['spigot', 'Spigot'], ['bukkit', 'Bukkit'],
    ['purpur', 'Purpur'], ['folia', 'Folia'], ['velocity', 'Velocity'], ['bungeecord', 'BungeeCord'],
    ['waterfall', 'Waterfall'],
  ],
  mod: [
    ['', 'любой загрузчик'], ['fabric', 'Fabric'], ['forge', 'Forge'], ['neoforge', 'NeoForge'], ['quilt', 'Quilt'],
  ],
  datapack: [['', 'любой загрузчик']],
};

const MC_VERSIONS = (() => {
  const out = [];
  for (let major = 1; major <= 1; major += 1) { /* заглушка, список ниже */ }
  const list = ['1.21.4', '1.21.3', '1.21.1', '1.21', '1.20.6', '1.20.4', '1.20.2', '1.20.1', '1.20',
    '1.19.4', '1.19.2', '1.18.2', '1.17.1', '1.16.5', '1.15.2', '1.14.4', '1.12.2', '1.8.9'];
  out.push(...list);
  return out;
})();

function addonsState() {
  return S.addons;
}

function fillAddonFilters() {
  const st = addonsState();
  const loaderSel = $('addonsLoader');
  if (loaderSel) {
    const list = ADDON_LOADERS[st.type] || ADDON_LOADERS.plugin;
    loaderSel.innerHTML = list.map(([v, label]) => `<option value="${v}"${v === st.loader ? ' selected' : ''}>${esc(label)}</option>`).join('');
  }
  const verSel = $('addonsVersion');
  if (verSel && !verSel.options.length) {
    verSel.innerHTML = '<option value="">любая версия</option>'
      + MC_VERSIONS.map((v) => `<option value="${v}">${v}</option>`).join('');
  }
}

async function addonsCategories() {
  const st = addonsState();
  const sel = $('addonsCategory');
  if (!sel) return;
  const res = await API.modrinthCategories(st.type).catch(() => null);
  const list = (res && res.categories) || [];
  sel.innerHTML = '<option value="">все категории</option>'
    + list.map((c) => `<option value="${c.name}">${esc(c.label)}</option>`).join('');
  sel.value = st.category || '';
}

async function addonsLoadInfo() {
  const s = current();
  if (!s) return;
  const st = addonsState();
  const res = await API.modrinthDetect(s.id).catch(() => null);
  st.info = res && res.ok ? res : null;
  const inst = await API.modrinthInstalled(s.id).catch(() => null);
  st.installed = inst && inst.ok ? inst : { plugins: [], mods: [] };

  if (st.info) {
    if (!st.loader) st.loader = st.info.loader || '';
    if (!st.version) st.version = st.info.version || '';
    if (!st.type) st.type = st.info.kind === 'mod' ? 'mod' : 'plugin';
  }
  const typeSel = $('addonsType');
  if (typeSel) typeSel.value = st.type;
  fillAddonFilters();
  const verSel = $('addonsVersion');
  if (verSel) verSel.value = st.version || '';
  const loaderSel = $('addonsLoader');
  if (loaderSel) loaderSel.value = st.loader || '';

  const title = $('addonsTitle');
  if (title) title.textContent = st.type === 'mod' ? 'Моды' : st.type === 'datapack' ? 'Датапаки' : 'Плагины';
  const sub = $('addonsSub');
  if (sub) {
    const parts = [];
    if (st.info && st.info.version) parts.push('Minecraft ' + st.info.version);
    if (st.info && st.info.loader) parts.push(st.info.loader);
    if (st.info) parts.push('папка ' + st.info.folder);
    parts.push('стоит: ' + ((st.installed.plugins || []).length + (st.installed.mods || []).length));
    sub.textContent = parts.join(' · ');
  }
}

function addonVersionText(hit) {
  const v = (hit.versions || []).filter(Boolean);
  if (!v.length) return '';
  const last = v[v.length - 1];
  return last;
}

function renderAddons() {
  const host = $('addonsList');
  if (!host) return;
  const st = addonsState();
  if (st.loading && !st.hits.length) {
    host.innerHTML = '<div class="empty-note">загрузка…</div>';
    return;
  }
  if (!st.hits.length) {
    host.innerHTML = '<div class="empty-note">ничего не найдено</div>';
    return;
  }
  host.innerHTML = '';
  for (const hit of st.hits) {
    const card = document.createElement('div');
    card.className = 'addon-card';
    const dl = hit.downloads >= 1000000 ? (hit.downloads / 1000000).toFixed(1) + ' млн'
      : hit.downloads >= 1000 ? Math.round(hit.downloads / 1000) + ' тыс' : String(hit.downloads || 0);
    card.innerHTML = `
      <div class="addon-ico">${hit.icon ? `<img src="${esc(hit.icon)}" alt="" loading="lazy" />` : esc((hit.title || '?').slice(0, 1))}</div>
      <div class="addon-body">
        <div class="addon-title">${esc(hit.title)}</div>
        <div class="addon-author">${esc(hit.author || '')}${addonVersionText(hit) ? ' · ' + esc(addonVersionText(hit)) : ''}</div>
        <div class="addon-desc">${esc(hit.description || '')}</div>
        <div class="addon-meta">
          ${(hit.categories || []).slice(0, 3).map((c) => `<span class="addon-tag">${esc(c)}</span>`).join('')}
          <span class="addon-dl">${dl} загрузок</span>
        </div>
      </div>
      <div class="addon-actions">
        <button class="btn btn-mini addon-install">Установить</button>
        <button class="btn btn-mini btn-ghost addon-open">На сайте</button>
      </div>`;
    const img = card.querySelector('img');
    if (img) img.onerror = () => { img.remove(); card.querySelector('.addon-ico').textContent = (hit.title || '?').slice(0, 1).toUpperCase(); };
    card.querySelector('.addon-install').onclick = async (e) => {
      const btn = e.currentTarget;
      const s = current();
      if (!s) return;
      btn.disabled = true;
      btn.textContent = 'Ставлю…';
      const res = await API.modrinthInstall(s.id, { id: hit.id, loader: st.loader, version: st.version });
      btn.disabled = false;
      if (!res || !res.ok) {
        btn.textContent = 'Установить';
        notify({ title: 'Не установилось', text: (res && res.error) || 'Неизвестная ошибка', kind: 'err' });
        return;
      }
      btn.textContent = 'Готово';
      notify({ title: 'Установлено', text: `${hit.title} → ${res.folder}/${res.file}`, kind: 'ok' });
      Sound.play('ok');
      addonsLoadInfo();
      setTimeout(() => { btn.textContent = 'Установить'; }, 2500);
    };
    card.querySelector('.addon-open').onclick = () => {
      API.ghOpenExternal(`https://modrinth.com/project/${hit.slug || hit.id}`);
    };
    host.appendChild(card);
  }
  const more = $('addonsMore');
  if (more) more.classList.toggle('hidden', st.hits.length >= st.total);
}

async function addonsSearch(reset = false) {
  const st = addonsState();
  if (st.loading) return;
  if (reset) { st.hits = []; st.offset = 0; }
  st.loading = true;
  renderAddons();
  const res = await API.modrinthSearch({
    query: st.query, type: st.type, loader: st.loader, version: st.version,
    category: st.category, sort: st.sort, offset: st.offset, limit: 20,
  }).catch(() => null);
  st.loading = false;
  if (!res || !res.ok) {
    notify({ title: 'Modrinth не ответил', text: (res && res.error) || 'Проверь соединение', kind: 'err' });
    renderAddons();
    return;
  }
  st.hits = st.offset ? st.hits.concat(res.hits) : res.hits;
  st.total = res.total || st.hits.length;
  const sub = $('addonsSub');
  if (sub && !st.info) sub.textContent = `найдено ${st.total}`;
  renderAddons();
}

async function addonsShowInstalled() {
  const s = current();
  if (!s) return;
  const st = addonsState();
  const res = await API.modrinthInstalled(s.id).catch(() => null);
  if (!res || !res.ok) return;
  st.installed = res;
  const list = (res.plugins || []).map((f) => ({ ...f, folder: 'plugins' }))
    .concat((res.mods || []).map((f) => ({ ...f, folder: 'mods' })));
  const host = $('addonsList');
  if (!host) return;
  if (!list.length) {
    host.innerHTML = '<div class="empty-note">ничего не установлено</div>';
    return;
  }
  host.innerHTML = '';
  for (const f of list) {
    const card = document.createElement('div');
    card.className = 'addon-card installed';
    card.innerHTML = `
      <div class="addon-ico">${ico('puzzle', 18, 1.6)}</div>
      <div class="addon-body">
        <div class="addon-title">${esc(f.name)}</div>
        <div class="addon-author">${esc(f.folder)} · ${(f.size / 1048576).toFixed(1)} МБ</div>
      </div>`;
    host.appendChild(card);
  }
}

function bindAddons() {
  const search = $('addonsSearch');
  let timer = null;
  if (search) {
    search.oninput = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { addonsState().query = search.value.trim(); addonsSearch(true); }, 350);
    };
  }
  const on = (id, key, after) => {
    const node = $(id);
    if (!node) return;
    node.onchange = () => {
      addonsState()[key] = node.value;
      if (after) after();
      addonsSearch(true);
      Sound.play('click');
    };
  };
  on('addonsSort', 'sort');
  on('addonsCategory', 'category');
  on('addonsLoader', 'loader');
  on('addonsVersion', 'version');
  const type = $('addonsType');
  if (type) {
    type.onchange = () => {
      addonsState().type = type.value;
      addonsState().category = '';
      fillAddonFilters();
      addonsCategories();
      addonsSearch(true);
    };
  }
  const refresh = $('addonsRefresh');
  if (refresh) refresh.onclick = () => { addonsLoadInfo().then(() => addonsSearch(true)); };
  const inst = $('addonsInstalledBtn');
  if (inst) inst.onclick = () => addonsShowInstalled();
  const more = $('addonsMoreBtn');
  if (more) more.onclick = () => { addonsState().offset += 20; addonsSearch(false); };
}

/* ═════════════════════ перетаскивание файлов ═════════════════════ */

let dropDepth = 0;

function fmCurrentDir() {
  return (typeof FM !== 'undefined' && FM.dir) ? FM.dir : '';
}

/** Кладёт перетащенные файлы в папку сервера. rel — путь внутри папки сервера. */
async function dropFiles(s, files, rel) {
  if (!s || !files.length) return;
  let ok = 0;
  for (const file of files) {
    const buf = await file.arrayBuffer();
    const res = await API.filesUpload(s.id, rel, file.name, new Uint8Array(buf)).catch(() => null);
    if (res && res.ok) ok += 1;
    else notify({ title: 'Файл не загрузился', text: (res && res.error) || file.name, kind: 'err' });
  }
  if (ok) {
    notify({ title: 'Файлы загружены', text: `файлов: ${ok} → ${rel || '/'}`, kind: 'ok' });
    Sound.play('ok');
    if (S.tab === 'files') { fmLoadTree(); if (typeof fmSearchRefresh === 'function') fmSearchRefresh(); }
  }
}

function bindFileDrop() {
  const pane = $('tab-files');
  const hasFiles = (e) => !!(e.dataTransfer && [...e.dataTransfer.types].includes('Files'));
  const clear = () => {
    dropDepth = 0;
    if (pane) pane.classList.remove('drop-active');
    document.body.classList.remove('drop-active');
    for (const z of document.querySelectorAll('.drop-target')) z.classList.remove('drop-target');
  };
  const dropRelOf = (target) => {
    const row = target instanceof Element ? target.closest('[data-drop-rel]') : null;
    return row ? row.dataset.dropRel : null;
  };

  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });

  // подсветка цели: папка в дереве — акцент, иначе подсвечиваем всю панель файлов
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    for (const z of document.querySelectorAll('.drop-target')) z.classList.remove('drop-target');
    const row = e.target instanceof Element ? e.target.closest('[data-drop-rel]') : null;
    if (row) row.classList.add('drop-target');
    if (pane) pane.classList.toggle('drop-active', !row);
    document.body.classList.toggle('drop-active', !pane || S.tab !== 'files');
  });

  if (pane) {
    pane.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dropDepth += 1;
      pane.classList.add('drop-active');
    });
    pane.addEventListener('dragleave', () => {
      dropDepth = Math.max(0, dropDepth - 1);
      if (!dropDepth) clear();
    });
  }

  window.addEventListener('dragleave', (e) => {
    if (e.relatedTarget || (e.clientX > 0 && e.clientY > 0)) return;
    clear();
  });

  // файл бросаем в любое место программы — он всё равно попадёт в папку сервера
  window.addEventListener('drop', async (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
    e.preventDefault();
    const files = [...e.dataTransfer.files];
    const s = current();
    const rel = dropRelOf(e.target) || (S.tab === 'files' ? fmCurrentDir() : '');
    clear();
    if (!s) { notify({ title: 'Некуда класть', text: 'Сначала выбери сервер', kind: 'err' }); return; }
    await dropFiles(s, files, rel);
  });
}

/* ═════════════════════ TAB: подсказки команд и ников ═════════════════════ */

const CMD_BASE = [
  'stop', 'restart', 'save-all', 'save-off', 'save-on', 'whitelist', 'ban', 'pardon', 'kick',
  'op', 'deop', 'list', 'tps', 'timings', 'plugins', 'version', 'seed', 'reload', 'say', 'tell',
  'me', 'msg', 'tp', 'tphere', 'gamemode', 'difficulty', 'time', 'weather', 'give', 'clear',
  'effect', 'enchant', 'xp', 'spawn', 'setworldspawn', 'teleport', 'kill', 'heal', 'gamerule',
  'summon', 'execute', 'fill', 'clone', 'setblock', 'particle', 'playsound', 'title', 'scoreboard',
  'team', 'advancement', 'recipe', 'datapack', 'function', 'forceload', 'jfr', 'spark', 'worldborder',
];

let cmdSuggestIdx = -1;
let cmdSuggestItems = [];

function hideCmdSuggest() {
  const box = $('cmdSuggest');
  if (!box) return;
  box.classList.add('hidden');
  box.innerHTML = '';
  cmdSuggestIdx = -1;
  cmdSuggestItems = [];
}

function showCmdSuggest(items) {
  const box = $('cmdSuggest');
  if (!box) return;
  if (!items.length) { hideCmdSuggest(); return; }
  cmdSuggestItems = items.slice(0, 8);
  cmdSuggestIdx = 0;
  renderCmdSuggest();
}

function renderCmdSuggest() {
  const box = $('cmdSuggest');
  if (!box) return;
  box.innerHTML = cmdSuggestItems.map((it, i) => `
    <button class="cs-item${i === cmdSuggestIdx ? ' sel' : ''}" data-i="${i}">
      <span class="cs-name">${esc(it.label)}</span>
      <span class="cs-kind">${esc(it.kind)}</span>
    </button>`).join('');
  box.classList.remove('hidden');
  for (const b of box.querySelectorAll('.cs-item')) {
    b.onmousedown = (e) => { e.preventDefault(); applyCmdSuggest(Number(b.dataset.i)); };
  }
}

function applyCmdSuggest(i) {
  const input = $('cmdInput');
  const item = cmdSuggestItems[i];
  if (!input || !item) return;
  input.value = item.value;
  hideCmdSuggest();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

/** Собирает варианты: ник игрока, если он онлайн, иначе команда. */
function cmdCandidates() {
  const input = $('cmdInput');
  const s = current();
  if (!input || !s) return [];
  const raw = input.value;
  const at = input.selectionStart ?? raw.length;
  const left = raw.slice(0, at);
  const token = (left.match(/([^\s]*)$/) || ['', ''])[1];
  const before = left.slice(0, left.length - token.length);
  const isCommandStart = /^\/?[^\s]*$/.test(left) && !before.trim();

  const players = [...playersState(s.id).names];
  const out = [];

  const push = (value, kind, label) => out.push({ value, kind, label: label || value });

  if (isCommandStart) {
    for (const c of CMD_BASE) if (c.startsWith(token.toLowerCase())) push('/' + c, 'команда', '/' + c);
  } else {
    for (const p of players) {
      if (p.toLowerCase().startsWith(token.toLowerCase())) push(before + p, 'игрок', p);
    }
    // аргумент-команда (gamemode creative и т.п.)
    const common = ['creative', 'survival', 'adventure', 'spectator', 'true', 'false', 'day', 'night', 'clear'];
    for (const c of common) if (c.startsWith(token.toLowerCase())) push(before + c, 'значение', c);
  }
  const exact = out.find((o) => o.value === raw);
  return exact ? [] : out;
}

function bindCmdComplete() {
  const input = $('cmdInput');
  if (!input) return;

  input.addEventListener('input', () => {
    const items = cmdCandidates();
    if (!items.length || !items[0].label) { hideCmdSuggest(); return; }
    // показываем только когда есть что подставлять
    showCmdSuggest(items);
  });

  input.addEventListener('keydown', (e) => {
    const box = $('cmdSuggest');
    const open = box && !box.classList.contains('hidden');
    if (e.key === 'Tab') {
      e.preventDefault();
      if (!open) {
        const items = cmdCandidates();
        if (!items.length) return;
        showCmdSuggest(items);
        applyCmdSuggest(0);
        return;
      }
      applyCmdSuggest(cmdSuggestIdx >= 0 ? cmdSuggestIdx : 0);
      return;
    }
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      cmdSuggestIdx = (cmdSuggestIdx + 1) % cmdSuggestItems.length;
      renderCmdSuggest();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      cmdSuggestIdx = (cmdSuggestIdx - 1 + cmdSuggestItems.length) % cmdSuggestItems.length;
      renderCmdSuggest();
    } else if (e.key === 'Enter' && cmdSuggestItems.length) {
      e.preventDefault();
      applyCmdSuggest(cmdSuggestIdx >= 0 ? cmdSuggestIdx : 0);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hideCmdSuggest();
    }
  });

  input.addEventListener('blur', () => setTimeout(hideCmdSuggest, 120));
}

/* ═════════════════════ цвета из фона ═════════════════════ */

async function themeFromWallpaper() {
  let source = null;
  if (prefs.wall === 'custom' && prefs.wallName) source = { kind: 'custom', name: prefs.wallName };
  else {
    const w = WALLPAPERS.find((x) => x.id === prefs.wall);
    if (w && w.src) source = { kind: 'builtin', src: w.src };
  }
  if (!source) {
    notify({ title: 'Сначала выбери фон', text: 'Оформление → Фон', kind: 'warn' });
    return;
  }
  const res = await API.wallPalette(source).catch(() => null);
  if (!res || !res.ok) {
    notify({ title: 'Не получилось подобрать', text: (res && res.error) || 'Фон не читается', kind: 'err' });
    return;
  }
  prefs.custom = { ...prefs.custom, ...res.colors };
  prefs.theme = 'custom';
  prefs.save();
  applyPrefs();
  syncCustomColors();
  Sound.play('ok');
  notify({ title: 'Цвета взяты из фона', text: res.colors.bg + ' · ' + res.colors.accent, kind: 'ok' });
}

/* ═════════════════════ аддоны панели ═════════════════════ */

let addonSeq = 0;

function addonTheme() {
  const cs = getComputedStyle(document.body);
  const get = (name, fb) => (cs.getPropertyValue(name) || '').trim() || fb;
  return {
    bg: get('--bg', '#0f1014'),
    panel: get('--bg-2', '#16181d'),
    panel3: get('--bg-3', '#1e2128'),
    line: get('--line', '#2a2d36'),
    text: get('--text', '#e8eaf0'),
    dim: get('--dim', '#9aa0ae'),
    accent: get('--accent-bar', '#8ab4ff'),
    /* скругления — чтобы панель аддона жила по тем же правилам, что и вся панель */
    radius: {
      xs: get('--r-xs', '4px'),
      sm: get('--r-sm', '8px'),
      md: get('--r-md', '12px'),
      lg: get('--r-lg', '16px'),
      pill: get('--r-pill', '999px'),
      circle: get('--r-circle', '50%'),
      card: get('--radius-card', '12px'),
    },
  };
}

function addonServer() {
  const s = current();
  return s ? { id: s.id, name: s.name, running: s.state === 'running' } : null;
}

async function loadAddonList() {
  const list = await API.addonsList().catch(() => null);
  S.addonList = Array.isArray(list) ? list : [];
  renderAddonTabs();
  renderAddonManager();
  return S.addonList;
}

/** Вкладки включённых аддонов после обычных вкладок. */
function renderAddonTabs() {
  const nav = document.querySelector('#view .tabs');
  if (!nav) return;
  for (const old of nav.querySelectorAll('.tab.tab-addon')) old.remove();
  for (const pane of document.querySelectorAll('[data-addon-pane]')) pane.remove();
  const host = document.querySelector('#view .view-body') || document.querySelector('#view');
  for (const a of S.addonList) {
    if (!a.enabled || !a.hasPanel) continue;
    const tab = document.createElement('button');
    tab.className = 'tab tab-addon';
    tab.dataset.tab = 'addon:' + a.id;
    tab.textContent = a.panelTitle || a.name;
    nav.appendChild(tab);

    const pane = document.createElement('section');
    pane.className = 'tab-pane addon-pane hidden';
    pane.dataset.addonPane = a.id;
    const frame = document.createElement('iframe');
    frame.className = 'addon-frame';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.dataset.addonId = a.id;
    pane.appendChild(frame);
    (host || nav.parentElement).appendChild(pane);
  }
  if (S.tab && S.tab.startsWith('addon:')) {
    const id = S.tab.slice(6);
    if (!S.addonList.some((a) => a.id === id && a.enabled)) setTab('console');
  }
}

function addonFrame(id) {
  return document.querySelector(`.addon-frame[data-addon-id="${id}"]`);
}

/** Загружает панель аддона в изолированное окно. */
async function openAddonPanel(id) {
  const frame = addonFrame(id);
  if (!frame) return;
  if (frame.dataset.loaded === '1') return;
  const res = await API.addonsPanel(id).catch(() => null);
  if (!res || !res.ok) {
    const doc = frame.contentDocument;
    if (doc) {
      doc.open();
      doc.write('<body style="font:13px sans-serif;color:#999;padding:20px">' +
        esc((res && res.error) || 'панель аддона не открылась') + '</body>');
      doc.close();
    }
    return;
  }
  frame.dataset.loaded = '1';
  frame.srcdoc = res.html;
}

/** Ответ аддону: страница в iframe спрашивает — панель отвечает. */
async function addonBridge(ev) {
  const data = ev.data;
  if (!data || data.omni !== 1) return;
  const frame = ev.source ? [...document.querySelectorAll('.addon-frame')].find((f) => f.contentWindow === ev.source) : null;
  const id = frame ? frame.dataset.addonId : '';
  if (!id) return;
  const answer = (payload) => {
    try { frame.contentWindow.postMessage({ omni: 2, ...payload }, '*'); } catch { /* окно закрыто */ }
  };
  if (data.method === 'init') {
    await openAddonPanel(id);
    answer({ type: 'init-ok', rid: data.rid, server: addonServer(), theme: addonTheme() });
    return;
  }
  const s = current();
  const r = await API.addonsCall(id, data.method, data.args || [], s ? s.id : '').catch(() => ({ ok: false, error: 'нет связи' }));
  answer({ rid: data.rid, ok: !!(r && r.ok), data: (r && r.data) || null, error: (r && r.error) || '' });
}

function pushAddonTheme() {
  const theme = addonTheme();
  const server = addonServer();
  for (const f of document.querySelectorAll('.addon-frame')) {
    try { f.contentWindow.postMessage({ omni: 2, type: 'theme', theme }, '*'); } catch { /* ignore */ }
    try { f.contentWindow.postMessage({ omni: 2, type: 'server-changed', server }, '*'); } catch { /* ignore */ }
  }
}

/** Список аддонов в настройках: переключатели вкл/выкл. */
function renderAddonManager() {
  const host = $('addonManager');
  if (!host) return;
  if (!S.addonList.length) {
    host.innerHTML = '<div class="empty-note">аддонов нет — положи папку с addon.json в OmniPanelData/addons</div>';
    return;
  }
  host.innerHTML = '';
  for (const a of S.addonList) {
    const card = document.createElement('div');
    card.className = 'addon-manage-row';
    card.innerHTML = `
      <div class="am-ico">${esc(a.icon || a.name.slice(0, 1).toUpperCase())}</div>
      <div class="am-body">
        <div class="am-top">
          <span class="am-name">${esc(a.name)}</span>
          <span class="am-ver">${esc(a.version || '')}</span>
          ${a.builtin ? '<span class="am-tag">встроенный</span>' : '<span class="am-tag">свой</span>'}
        </div>
        <div class="am-desc">${esc(a.description || '')}</div>
      </div>
      <label class="mini-toggle am-toggle"><input type="checkbox" ${a.enabled ? 'checked' : ''} /><span class="sw"></span></label>`;
    const input = card.querySelector('input');
    input.onchange = async () => {
      const on = input.checked;
      const res = await API.addonsSetEnabled(a.id, on).catch(() => null);
      if (!res || !res.ok) {
        input.checked = !on;
        notify({ title: 'Не переключилось', text: (res && res.error) || 'нет доступа', kind: 'err' });
        return;
      }
      a.enabled = on;
      Sound.play(on ? 'ok' : 'click');
      await loadAddonList();
      if (on && a.hasPanel && current()) notify({ title: 'Аддон включён', text: a.name, kind: 'ok' });
    };
    host.appendChild(card);
  }
}

function bindAddonsPage() {
  const folder = $('addonsFolder');
  if (folder) folder.onclick = async () => {
    const res = await API.addonsReveal().catch(() => null);
    if (!res || !res.ok) notify({ title: 'Папка не открылась', text: (res && res.error) || 'только в exe-версии', kind: 'err' });
  };
  const reload = $('addonsReload');
  if (reload) reload.onclick = async () => {
    await loadAddonList();
    notify({ title: 'Список обновлён', text: 'аддонов: ' + S.addonList.length, kind: 'info' });
  };
  window.addEventListener('message', addonBridge);
}

/* ═════════════════════ старт ═════════════════════ */

(async function init() {
  applyTheme();
  applyPrefs();
  bindActions();
  bindEffects();
  bindSubscriptions();
  if (API.connect) API.connect();

  try { S.info = await API.info(); } catch { S.info = null; }

  wizBind();
  fmBind();
  bindScanDepth();
  bindUpdates();

  if (IS_DESKTOP) {
    const autostart = await API.autostartGet();
    $('pAutostartRow').classList.remove('hidden');
    if (autostart != null) $('pAutostart').checked = !!autostart;
    if (API.winGetStartMode) {
      const mode = await API.winGetStartMode().catch(() => null);
      if (mode) { prefs.startMode = mode; prefs.save(); }
    }
    const st = await Promise.resolve(API.winState && API.winState()).catch(() => null);
    if (st) setWinIcons(st);
  } else {
    for (const id of ['pickFile', 'pickFolder']) {
      const b = $(id);
      if (b) { b.disabled = true; b.textContent = 'только в exe'; }
    }
  }

  await refresh();
  await loadAddonList();

  setInterval(() => {
    const s = current();
    if (s && s.state === 'running' && s.startedAt) {
      setUptime(s);
    }
  }, 1000);

  setInterval(refresh, 5000);

  // перерисовка графиков при изменении размера окна
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (S.tab === 'perf') renderPerf();
      if (S.tab === 'perf') renderTpsTab();
    }, 180);
  });
})();
