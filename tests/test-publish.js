// Проверки выкладывания обновления в GitHub (tools/upload-update.js) на мок-сервере.
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');
const zip = require('../core/zip');

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  OK   ' : '  FAIL ') + label + (extra ? ' — ' + extra : ''));
  if (!cond) fails += 1;
};

const SCRIPT = path.join(__dirname, '..', 'tools', 'upload-update.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-pub-'));
const KIT = path.join(TMP, 'kit');
fs.mkdirSync(path.join(KIT, 'dist'), { recursive: true });

const code = zip.create([
  { name: 'main.js', data: '// main' },
  { name: 'package.json', data: '{"version":"1.2.3"}' },
  { name: 'ui/index.html', data: '<h1>1.2.3</h1>' },
  { name: 'ui/app.js', data: '// app' },
]);
fs.writeFileSync(path.join(KIT, 'dist', 'OmniPanel-code.zip'), code);
const fullBuf = Buffer.concat([Buffer.from('сборка'), Buffer.alloc(2048, 7)]);
fs.writeFileSync(path.join(KIT, 'dist', 'OmniPanel-win64.zip'), fullBuf);
fs.writeFileSync(path.join(KIT, 'update.json'), JSON.stringify({
  version: '1.2.3',
  notes: 'тестовая версия',
  code: { file: 'dist/OmniPanel-code.zip', size: 1, sha256: 'старое' },
  full: null,
}, null, 2));

/* ─────────────────────────── мок GitHub ─────────────────────────── */

const state = { contents: new Map(), releases: [], uploads: [], log: [], deletes: [] };

function makeMock() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (code2, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(code2, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    };
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      state.log.push(`${req.method} ${url.pathname}`);

      if (!req.headers.authorization || !/token /.test(req.headers.authorization)) {
        return json(401, { message: 'Requires authentication' });
      }
      if (/bad-token/.test(req.headers.authorization)) return json(401, { message: 'Bad credentials' });
      if (/no-rights/.test(req.headers.authorization)) return json(403, { message: 'Resource not accessible' });

      const contentMatch = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/);
      if (contentMatch) {
        const file = decodeURIComponent(contentMatch[1]);
        if (req.method === 'GET') {
          const rec = state.contents.get(file);
          if (!rec) return json(404, { message: 'Not Found' });
          return json(200, { name: file, sha: rec.sha, type: 'file' });
        }
        if (req.method === 'PUT') {
          const parsed = JSON.parse(body.toString('utf8'));
          const data = Buffer.from(parsed.content, 'base64');
          const sha = require('crypto').createHash('sha1').update(data).digest('hex');
          const existed = state.contents.has(file);
          if (existed && !parsed.sha) return json(422, { message: 'sha wasn\'t supplied' });
          state.contents.set(file, { sha, data, branch: parsed.branch, message: parsed.message });
          return json(existed ? 200 : 201, { content: { sha, html_url: `https://github.com/o/r/blob/main/${file}` } });
        }
      }

      const tagMatch = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/releases\/tags\/(.+)$/);
      if (tagMatch && req.method === 'GET') {
        const rel = state.releases.find((r) => r.tag_name === decodeURIComponent(tagMatch[1]));
        return rel ? json(200, rel) : json(404, { message: 'Not Found' });
      }
      if (/\/releases$/.test(url.pathname) && req.method === 'POST') {
        const parsed = JSON.parse(body.toString('utf8'));
        const rel = { id: 100 + state.releases.length, tag_name: parsed.tag_name, name: parsed.name, body: parsed.body, assets: [] };
        state.releases.push(rel);
        return json(201, rel);
      }
      const delMatch = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/releases\/assets\/(\d+)$/);
      if (delMatch && req.method === 'DELETE') {
        state.deletes.push(Number(delMatch[1]));
        for (const rel of state.releases) rel.assets = rel.assets.filter((a) => a.id !== Number(delMatch[1]));
        res.writeHead(204).end();
        return undefined;
      }
      const assetMatch = url.pathname.match(/^\/uploads\/repos\/[^/]+\/[^/]+\/releases\/(\d+)\/assets$/);
      if (assetMatch && req.method === 'POST') {
        const rel = state.releases.find((r) => r.id === Number(assetMatch[1]));
        const name = url.searchParams.get('name');
        const asset = { id: 500 + state.uploads.length, name, size: body.length };
        state.uploads.push({ name, size: body.length, relId: rel && rel.id });
        if (rel) rel.assets.push(asset);
        return json(201, { ...asset, browser_download_url: `https://github.com/o/r/releases/download/${rel && rel.tag_name}/${name}` });
      }
      return json(404, { message: 'Not Found (мок)' });
    });
    return undefined;
  });
}

function run(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, APPDATA: path.join(TMP, 'пусто'), HOME: path.join(TMP, 'пусто'), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('close', (codeExit) => resolve({ codeExit, out }));
  });
}

const mock = makeMock();
mock.listen(8792, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:8792';
  const env = { OMNI_GITHUB_API: base, OMNI_GITHUB_UPLOAD: base + '/uploads' };

  console.log('=== ПЕРВАЯ ПУБЛИКАЦИЯ (репозиторий пустой) ===');
  let r = await run(['--repo', 'o/r', '--token', 'good-token', '--dir', KIT], env);
  ok(r.codeExit === 0, 'скрипт завершился без ошибок', r.out.includes('ОШИБКА') ? r.out.split('\n').filter((l) => l.includes('ОШИБКА')).join(' ') : '');
  ok(state.contents.has('dist/OmniPanel-code.zip'), 'архив кода залит в dist/');
  ok(state.contents.has('update.json'), 'update.json залит в корень');
  const man = JSON.parse(state.contents.get('update.json').data.toString('utf8'));
  ok(man.version === '1.2.3', 'в репозитории верная версия');
  ok(man.code.sha256 && man.code.sha256 === require('crypto').createHash('sha256').update(code).digest('hex'), 'контрольная сумма пересчитана');
  ok(man.code.size === code.length, 'размер архива записан');
  ok(state.releases.length === 1 && state.releases[0].tag_name === 'v1.2.3', 'релиз создан', state.releases.map((x) => x.tag_name).join(','));
  ok(state.uploads.length === 1 && state.uploads[0].name === 'OmniPanel-win64.zip', 'полная сборка приложена к релизу', JSON.stringify(state.uploads));
  ok(state.uploads[0].size === fullBuf.length, 'сборка загружена целиком', `${state.uploads[0].size} байт`);
  ok(/готово/.test(r.out) && r.out.includes('releases/tag/v1.2.3'), 'ссылки выведены', r.out.split('\n').pop());

  console.log('\n=== ПОВТОРНАЯ ПУБЛИКАЦИЯ ТОЙ ЖЕ ВЕРСИИ ===');
  state.log.length = 0;
  r = await run(['--repo', 'o/r', '--token', 'good-token', '--dir', KIT], env);
  ok(r.codeExit === 0, 'повтор прошёл');
  ok(state.releases.length === 1, 'второй релиз не создаётся — берётся существующий');
  ok(state.deletes.length >= 1, 'старый файл релиза удалён перед повторной загрузкой', 'удалено: ' + state.deletes.length);
  ok(state.uploads.length === 2, 'сборка загружена заново');
  const puts = state.log.filter((l) => l.startsWith('PUT'));
  ok(puts.length === 2, 'на повторной отправке — два PUT (файлы обновлены)', puts.join(', '));

  console.log('\n=== НОВАЯ ВЕРСИЯ ===');
  fs.writeFileSync(path.join(KIT, 'update.json'), JSON.stringify({ version: '1.2.4', notes: 'ещё новее', code: { file: 'dist/OmniPanel-code.zip' } }, null, 2));
  r = await run(['--repo', 'o/r', '--token', 'good-token', '--dir', KIT], env);
  ok(r.codeExit === 0 && state.releases.length === 2, 'для новой версии создан новый релиз', state.releases.map((x) => x.tag_name).join(','));
  ok(JSON.parse(state.contents.get('update.json').data.toString('utf8')).version === '1.2.4', 'update.json обновился');

  console.log('\n=== ОШИБКИ ===');
  r = await run(['--repo', 'o/r', '--token', 'bad-token', '--dir', KIT], env);
  ok(r.codeExit === 1 && /токен не подошёл/.test(r.out), 'плохой токен — понятная ошибка', r.out.split('\n').filter((l) => l.includes('ОШИБКА')).join(' '));
  r = await run(['--repo', 'o/r', '--token', 'no-rights', '--dir', KIT], env);
  ok(r.codeExit === 1 && /нет прав|403/.test(r.out), 'без прав — понятная ошибка');
  r = await run(['--dir', path.join(TMP, 'нет-такой'), '--token', 'good-token'], env);
  ok(r.codeExit === 1 && /update\.json/.test(r.out), 'без update.json — понятная ошибка');

  const noTokenDir = path.join(TMP, 'без-токена');
  fs.mkdirSync(noTokenDir, { recursive: true });
  r = await run(['--repo', 'o/r', '--dir', KIT], { ...env, GITHUB_TOKEN: '', GH_TOKEN: '' });
  ok(r.codeExit === 1 && /нужен токен/.test(r.out), 'без токена подсказывает, где его взять');

  console.log('\n=== DRY RUN ===');
  const before = state.log.length;
  r = await run(['--repo', 'o/r', '--token', 'good-token', '--dir', KIT, '--dry'], env);
  ok(r.codeExit === 0 && /ничего не отправляю/.test(r.out), 'dry-run ничего не отправляет');
  ok(state.log.length === before, 'запросов к GitHub не было', `${state.log.length - before} шт.`);

  console.log('\n=== ТОКЕН ИЗ ПАНЕЛИ ===');
  const appData = path.join(TMP, 'панель', 'OmniPanel');
  fs.mkdirSync(appData, { recursive: true });
  fs.writeFileSync(path.join(appData, 'panel.json'), JSON.stringify({ githubToken: 'good-token', updateRepo: 'panel/repo' }));
  r = await run(['--dir', KIT], { ...env, APPDATA: path.join(TMP, 'панель') });
  ok(r.codeExit === 0 && r.out.includes('найден'), 'токен подхватывается из настроек панели', r.out.split('\n').find((l) => l.startsWith('токен')));
  ok(r.out.includes('panel/repo'), 'репозиторий тоже берётся из настроек панели');

  console.log('\n' + (fails ? `ПРОВАЛОВ: ${fails}` : 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ'));
  mock.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
});
