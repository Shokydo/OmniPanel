'use strict';
/**
 * Локальный «GitHub» для проверки обновлений:
 * отдаёт update.json и архив с кодом, релизов нет.
 */
const http = require('http');
const zip = require('../core/zip');

const VERSION = '9.9.9';

function buildCodeZip() {
  return zip.create([
    { name: 'main.js', data: '// тестовое обновление' },
    { name: 'preload.js', data: '// тестовое обновление' },
    { name: 'package.json', data: JSON.stringify({ name: 'omnipanel', version: VERSION }) },
    { name: 'ui/index.html', data: '<h1>обновление</h1>' },
    { name: 'ui/app.js', data: '// тестовое обновление' },
  ]);
}

function makeUpdateServer(repo = 'u/r') {
  const code = buildCodeZip();
  const manifest = {
    version: VERSION,
    notes: 'Обновление из GitHub — тест\n· проверка канала обновлений',
    code: { file: 'dist/OmniPanel-code.zip', size: code.length },
    full: null,
  };
  const server = http.createServer((req, res) => {
    const json = (obj, code2 = 200) => {
      const body = JSON.stringify(obj);
      res.writeHead(code2, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    };
    if (req.url.startsWith(`/${repo}/main/update.json`)) return json(manifest);
    if (req.url.startsWith(`/${repo}/main/dist/OmniPanel-code.zip`)) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': code.length });
      return res.end(code);
    }
    return json({ message: 'Not Found' }, 404);
  });
  server.codeZip = code;
  server.version = VERSION;
  return server;
}

module.exports = { makeUpdateServer, VERSION };
