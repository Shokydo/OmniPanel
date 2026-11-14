'use strict';
/**
 * Открытие папок и файлов во внешнем редакторе кода.
 * Ищем бинарник редактора в PATH и в типовых местах установки, потому что
 * на Windows PATH обновляется только после перезапуска проводника.
 * Если редактор не найден — открываем путь системным приложением.
 */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

function editorBins() {
  const out = [];
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    if (local) {
      out.push(path.join(local, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'));
      out.push(path.join(local, 'Programs', 'Microsoft VS Code Insiders', 'bin', 'code-insiders.cmd'));
      out.push(path.join(local, 'Programs', 'VSCodium', 'bin', 'codium.cmd'));
    }
    for (const pf of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
      if (pf) out.push(path.join(pf, 'Microsoft VS Code', 'bin', 'code.cmd'));
    }
    out.push('code.cmd', 'code');
  } else if (process.platform === 'darwin') {
    out.push('/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code');
    out.push('code');
  } else {
    out.push('/usr/bin/code', '/usr/local/bin/code', '/snap/bin/code', 'code', 'codium');
  }
  return out;
}

function run(bin, args) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    try {
      const child = execFile(
        bin,
        args,
        { windowsHide: true, shell: process.platform === 'win32', timeout: 20000 },
        (err) => finish(err ? { ok: false, error: err.message } : { ok: true, bin }),
      );
      child.on('error', (err) => finish({ ok: false, error: err.message }));
    } catch (e) {
      finish({ ok: false, error: e.message });
    }
  });
}

/** Открывает папку или файл в редакторе кода. */
async function openInEditor(target) {
  if (!target) return { ok: false, error: 'Путь не указан' };
  let full = target;
  try { full = path.resolve(target); } catch { /* оставляем как есть */ }
  if (!fs.existsSync(full)) return { ok: false, error: 'Не найдено: ' + full };

  let lastError = '';
  for (const bin of editorBins()) {
    if (bin.includes(path.sep) && !fs.existsSync(bin)) continue;
    const res = await run(bin, ['--reuse-window', full]);
    if (res.ok) return { ok: true, editor: 'editor', bin };
    lastError = res.error || '';
  }

  // редактора нет — открываем системным приложением, чтобы кнопка не была пустой
  try {
    const { shell } = require('electron');
    const err = await shell.openPath(full);
    if (!err) return { ok: true, editor: 'system', bin: '' };
    lastError = err;
  } catch (e) {
    lastError = e.message;
  }

  return {
    ok: false,
    error: 'Не удалось открыть путь'
      + (lastError ? ' (' + String(lastError).slice(0, 120) + ')' : ''),
  };
}

module.exports = { openInEditor };
