'use strict';
/**
 * Сборка файлов для канала обновлений.
 *
 *   node tools/make-update.js [--full путь-к-OmniPanel-win64.zip] [--notes "что нового"]
 *
 * На выходе в папке dist:
 *   OmniPanel-code.zip   — только код панели (~2 МБ): его панель качает сама
 *   OmniPanel-win64.zip  — полная сборка (если указана или лежит рядом)
 *   update.json          — версия, размеры, контрольные суммы
 *
 * Дальше: залей dist/* и update.json в свой публичный репозиторий —
 * панель увидит новую версию по адресу raw.githubusercontent.com/<владелец>/<репозиторий>/<ветка>/update.json
 * (либо приложи те же два архива к релизу с тегом версии).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zip = require('../core/zip');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

/** Что входит в обновление кода. */
const CODE_ITEMS = [
  'main.js', 'preload.js', 'web.js', 'package.json',
  'README.md', 'ЧИТАЙ-МЕНЯ.txt', 'servers.example.json',
  'ui', 'core', 'assets', 'tools',
];

const SKIP = new Set(['node_modules', '.git', 'dist', 'tests', 'OmniPanelData', 'data']);

function collect(target, base = '', out = []) {
  const abs = path.join(ROOT, target);
  if (!fs.existsSync(abs)) return out;
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(abs).sort()) {
      if (SKIP.has(name)) continue;
      collect(path.join(target, name), path.join(base, name), out);
    }
  } else {
    out.push({ from: abs, name: base.split(path.sep).join('/') });
  }
  return out;
}

/** .bat, который запускает upload-update.js (панельный exe как Node или обычный node). */
function batText() {
  return [
    '@echo off',
    'chcp 65001 >nul',
    'title OmniPanel — выложить обновление на GitHub',
    'cd /d "%~dp0"',
    '',
    'set "RUN="',
    'if exist "%~dp0OmniPanel.exe" set "RUN=%~dp0OmniPanel.exe"',
    'if not defined RUN if exist "%~dp0..\\OmniPanel.exe" set "RUN=%~dp0..\\OmniPanel.exe"',
    'if not defined RUN if exist "%~dp0..\\..\\OmniPanel.exe" set "RUN=%~dp0..\\..\\OmniPanel.exe"',
    '',
    'if defined RUN (',
    '  set ELECTRON_RUN_AS_NODE=1',
    '  "%RUN%" "%~dp0tools/upload-update.js" --dir "%~dp0" %*',
    '  goto done',
    ')',
    '',
    'where node >nul 2>&1',
    'if errorlevel 1 (',
    '  echo Не нашёл ни OmniPanel.exe рядом, ни Node.js.',
    '  echo Можно выложить руками: перетащи в веб-интерфейс GitHub',
    '  echo    update.json в корень репозитория',
    '  echo    папку dist с файлом OmniPanel-code.zip',
    '  pause',
    '  exit /b 1',
    ')',
    'node "%~dp0tools/upload-update.js" --dir "%~dp0" %*',
    '',
    ':done',
    'echo.',
    'pause',
    '',
  ].join('\r\n');
}

function kitReadme(version, repo, fullSrc, full) {
  return [
    `OmniPanel ${version} — набор для выкладывания обновления`,
    '',
    'ЧТО ВНУТРИ',
    '  update.json              — версия и контрольные суммы',
    '  dist/OmniPanel-code.zip  — сам архив обновления (его качает панель)',
    '  tools/upload-update.js   — загрузчик через GitHub API',
    '  Залить-обновление.bat    — запуск в один клик',
    '',
    'КАК ВЫЛОЖИТЬ (нужен только вход в GitHub в самой панели)',
    `  1. Распакуй этот архив в любую папку.`,
    `  2. Запусти Залить-обновление.bat`,
    `     Скрипт сам возьмёт токен из настроек панели (Настройки → GitHub),`,
    `     зальёт update.json и dist/OmniPanel-code.zip в репозиторий ${repo}`,
    `     и создаст релиз v${version}.`,
    '',
    '  Токена в панели нет? Запусти так:',
    '     Залить-обновление.bat --token ghp_твой_токен',
    '  Токен создаётся тут: GitHub → Settings → Developer settings',
    '     → Personal access tokens → галочка "repo".',
    '',
    'ЕСЛИ ХОЧЕШЬ ВРУЧНУЮ',
    '  Перетащи в веб-интерфейс репозитория:',
    '     update.json  → в корень',
    '     dist/OmniPanel-code.zip → в папку dist',
    '  Полную сборку приложи файлом к релизу v' + version + ' (Releases → Draft a new release).',
    '',
    'ПОСЛЕ ВЫКЛАДКИ',
    '  Панель сама увидит новую версию: Настройки → Обновления → Проверить обновления',
    '  (или уведомление при следующем запуске).',
    '',
    full
      ? `  Полная сборка для релиза: ${path.basename(fullSrc)} — положи её в папку dist рядом,`
      : '  Полная сборка не приложена — панель обновится только кодом (этого достаточно).',
    full ? '  тогда скрипт загрузит её к релизу автоматически.' : '  Нужна кнопка "Скачать полную сборку"? Добавь в dist файл OmniPanel-win64.zip.',
    '',
  ].join('\r\n');
}

const has = (name) => process.argv.includes('--' + name);

function arg(name, fallback = '') {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function info(file, urlPath) {
  const st = fs.statSync(file);
  return { file: urlPath, size: st.size, sha256: sha256(file) };
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  let repoHint = arg('repo', '');
  if (!repoHint) {
    for (const p of [path.join(ROOT, 'OmniPanelData', 'panel.json'), path.join(ROOT, '..', 'OmniPanelData', 'panel.json')]) {
      try {
        if (fs.existsSync(p)) { repoHint = JSON.parse(fs.readFileSync(p, 'utf8')).updateRepo || ''; break; }
      } catch { /* ignore */ }
    }
  }
  const version = pkg.version;
  fs.mkdirSync(DIST, { recursive: true });

  // 1. код панели
  const items = [];
  for (const entry of CODE_ITEMS) collect(entry, entry, items);
  if (!items.some((i) => i.name === 'main.js')) {
    console.error('не нашёл main.js рядом с tools/ — запускай из папки OmniPanel');
    process.exit(1);
  }
  const codeZip = zip.createFromFiles(items);
  const codePath = path.join(DIST, 'OmniPanel-code.zip');
  fs.writeFileSync(codePath, codeZip);

  // 2. полная сборка (если есть)
  let fullNote = 'полная сборка не приложена';
  let full = null;
  const candidates = [
    arg('full'),
    path.join(ROOT, '..', 'OmniPanel-win64.zip'),
    path.join(ROOT, 'OmniPanel-win64.zip'),
  ].filter(Boolean);
  const fullSrc = candidates.find((p) => fs.existsSync(p));
  if (fullSrc) {
    // в dist копируем только по явному запросу: сборка на 105 МБ, а update.json
    // её не описывает — она прикладывается файлом к релизу
    if (has('copy-full') || path.resolve(fullSrc) === path.resolve(path.join(DIST, 'OmniPanel-win64.zip'))) {
      const fullPath = path.join(DIST, 'OmniPanel-win64.zip');
      if (path.resolve(fullSrc) !== path.resolve(fullPath)) fs.copyFileSync(fullSrc, fullPath);
      full = info(fullPath, 'dist/OmniPanel-win64.zip');
    } else {
      full = { file: fullSrc, size: fs.statSync(fullSrc).size, sha256: sha256(fullSrc) };
    }
    fullNote = 'полная сборка: ' + path.basename(fullSrc);
  }

  // 3. манифест
  // Полную сборку в update.json не прописываем: 105 МБ GitHub в файлы репозитория
  // не пустит (лимит 100 МБ). Её место — файл релиза с именем OmniPanel-win64.zip,
  // панель найдёт его сама. Если сборка лежит на другом хосте — --full-url.
  const fullUrl = arg('full-url');
  const manifest = {
    version,
    notes: arg('notes', `OmniPanel ${version}`),
    at: new Date().toISOString(),
    code: info(codePath, 'dist/OmniPanel-code.zip'),
    full: fullUrl ? { url: fullUrl, size: full ? full.size : 0, sha256: full ? full.sha256 : '' } : null,
  };
  const manifestPath = path.join(DIST, 'update.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  // 4. набор для выкладывания: распаковал → запустил bat → файлы на GitHub
  const kitName = `OmniPanel-обновление-${version}.zip`;
  const kitEntries = [
    { name: 'update.json', data: fs.readFileSync(manifestPath) },
    { name: 'dist/', data: Buffer.alloc(0) },
    { name: 'dist/OmniPanel-code.zip', data: fs.readFileSync(codePath) },
    { name: 'tools/', data: Buffer.alloc(0) },
    { name: 'tools/upload-update.js', data: fs.readFileSync(path.join(__dirname, 'upload-update.js')) },
    { name: 'Залить-обновление.bat', data: Buffer.from(batText(), 'utf8') },
    { name: 'ЧИТАТЬ-МЕНЯ.txt', data: Buffer.from(kitReadme(version, repoHint || 'Shokydo/OmniPanel', fullSrc, full), 'utf8') },
  ];
  const kitPath = path.join(DIST, kitName);
  fs.writeFileSync(kitPath, zip.create(kitEntries));

  const mb = (n) => (n / 1048576).toFixed(2) + ' МБ';
  console.log(`версия ${version}`);
  console.log(`  код:      dist/OmniPanel-code.zip — ${mb(manifest.code.size)} (${items.length} файлов)`);
  if (full) console.log(`  сборка:   ${path.relative(ROOT, full.file) || full.file} — ${mb(full.size)} (файл релиза)`);
  console.log(`  манифест: dist/update.json`);
  console.log(`  ${fullNote}`);
  console.log('');
  console.log(`  набор:    dist/${kitName} — распакуй и запусти «Залить-обновление.bat»`);
  console.log('');
  console.log('как выложить:');
  console.log('  1) залей в репозиторий: update.json и dist/OmniPanel-code.zip (папку dist сохрани)');
  console.log(`  2) полную сборку приложи файлом к релизу с тегом v${version}:`);
  console.log('     GitHub → Releases → Draft a new release → файл dist/OmniPanel-win64.zip');
  console.log('     (в обычные файлы репозитория 105 МБ не влезут — лимит 100 МБ)');
}

if (require.main === module) main();

module.exports = { CODE_ITEMS };
