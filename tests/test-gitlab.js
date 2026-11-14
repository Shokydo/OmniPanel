// Проверки 1.23.0: GitLab как второй провайдер и лечение ошибки GitHub
// «Sorry, your input was too large» (422) уменьшением размера частей.
//
// Запуск: node tests/test-gitlab.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  OK   ' : '  FAIL ') + label + (extra ? ' — ' + extra : ''));
  if (!cond) fails += 1;
};

const { makeGitLab } = require('./mock-gitlab');

const SRC = path.join(os.tmpdir(), 'omni-gl-src');
const DEST = path.join(os.tmpdir(), 'omni-gl-dest');
const STATE = path.join(os.tmpdir(), 'omni-gl-state.json');

function buildServer(dir, bytes = 2.5) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'world'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'server.properties'), 'level-name=world\nmotd=Тест\n');
  fs.writeFileSync(path.join(dir, 'world', 'region.mca'), crypto.randomBytes(Math.round(bytes * 1024 * 1024)));
  fs.writeFileSync(path.join(dir, 'plugins', 'config.yml'), 'enabled: true\n'.repeat(500));
}

buildServer(SRC);
fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(DEST, { recursive: true });
fs.rmSync(STATE, { force: true });

const mock = makeGitLab('me/server', 'gl-token');
const PORT = 8813;
process.env.OMNI_GITLAB_API = `http://127.0.0.1:${PORT}/api/v4`;
process.env.OMNI_SPLIT_MB = '1';

const gitlab = require('../core/gitlab');

mock.listen(PORT, '127.0.0.1', async () => {
  try {
    console.log('=== ПРОВЕРКА ТОКЕНА И ПРОЕКТА ===');
    const bad = await gitlab.check({ token: 'wrong', project: 'me/server' });
    ok(bad.ok === false && /401/.test(bad.error), 'плохой токен — понятная ошибка', bad.error);
    const noProj = await gitlab.check({ token: 'gl-token', project: 'без-слэша' });
    ok(noProj.ok === false && /владелец/.test(noProj.error), 'путь проекта без группы — подсказка', noProj.error);
    const good = await gitlab.check({ token: 'gl-token', project: 'me/server', branch: 'main' });
    ok(good.ok && good.project === 'me/server', 'проект найден', JSON.stringify(good).slice(0, 90));
    ok(good.branchExists === true, 'ветка main видна');
    ok(good.packages === true, 'хранилище пакетов доступно');
    const noBranch = await gitlab.check({ token: 'gl-token', project: 'me/server', branch: 'нет-такой' });
    ok(noBranch.ok && noBranch.branchExists === false, 'отсутствие ветки — не ошибка', 'ветка: ' + noBranch.branch);

    console.log('\n=== ОТПРАВКА ЧАСТЯМИ ===');
    const logs = [];
    const push = await gitlab.push({
      token: 'gl-token', project: 'me/server', dir: SRC, branch: 'main',
      stateFile: STATE, onLog: (t) => logs.push(t),
    });
    ok(push.ok, 'отправка прошла', push.error || '');
    ok(push.parts >= 3, 'архив разбит на части', 'частей: ' + push.parts);
    ok(push.format === '7z', 'архив в 7z', push.format);
    const pkg = mock.state.packages[0];
    const names = [...pkg.files.keys()];
    ok(names.some((n) => /\.7z\.001$/.test(n)), 'первая часть лежит в хранилище', names.join(', '));
    ok(names.includes('manifest.json'), 'манифест лежит рядом');
    const manifest = JSON.parse(pkg.files.get('manifest.json').buf.toString('utf8'));
    ok(manifest.parts.length === push.parts, 'в манифесте все части', 'частей: ' + manifest.parts.length);
    ok(manifest.parts[0].sha256 && manifest.parts[0].sha256.length === 64, 'в манифесте контрольные суммы');
    ok(/шаг 1 из 2: архивирую/.test(logs.join('\n')), 'в логе шаг 1 — архивация');
    ok(/шаг 2 из 2: отправляю в GitLab/.test(logs.join('\n')), 'в логе шаг 2 — отправка');

    console.log('\n=== ПОВТОРНАЯ ОТПРАВКА БЕЗ ИЗМЕНЕНИЙ ===');
    const again = await gitlab.push({ token: 'gl-token', project: 'me/server', dir: SRC, stateFile: STATE, onLog: () => {} });
    ok(again.ok && again.upToDate, 'второй раз отправлять нечего', JSON.stringify(again).slice(0, 80));
    ok(mock.state.packages.length === 1, 'новый пакет не создавался', 'пакетов: ' + mock.state.packages.length);

    console.log('\n=== ЗАБОР: СКАЧАТЬ → РАСПАКОВАТЬ → УДАЛИТЬ ПАКЕТ ===');
    const pullLogs = [];
    const pull = await gitlab.pull({
      token: 'gl-token', project: 'me/server', dir: DEST, stateFile: STATE,
      onLog: (t) => pullLogs.push(t),
    });
    ok(pull.ok, 'забор прошёл', pull.error || '');
    ok(pull.parts === push.parts, 'скачаны все части', `${pull.parts} из ${push.parts}`);
    ok(fs.readFileSync(path.join(DEST, 'server.properties'), 'utf8').includes('motd=Тест'), 'конфиг распакован с текстом');
    ok(fs.statSync(path.join(DEST, 'world', 'region.mca')).size === fs.statSync(path.join(SRC, 'world', 'region.mca')).size,
      'файл мира совпадает по размеру');
    ok(fs.readFileSync(path.join(DEST, 'plugins', 'config.yml'), 'utf8') === fs.readFileSync(path.join(SRC, 'plugins', 'config.yml'), 'utf8'),
      'содержимое файлов совпадает');
    ok(pull.repoCleaned === true, 'пакет удалён из GitLab после распаковки');
    ok(mock.state.packages.length === 0, 'в проекте не осталось пакетов', 'пакетов: ' + mock.state.packages.length);
    ok(/пакет .* удалён из GitLab/.test(pullLogs.join('\n')), 'в логе видно удаление пакета');

    console.log('\n=== ПУСТОЙ ПРОЕКТ ===');
    const empty = await gitlab.pull({ token: 'gl-token', project: 'me/server', dir: DEST, onLog: () => {} });
    ok(empty.ok === false && /сначала отправь/.test(empty.error), 'пустой проект — подсказка отправить', empty.error);

    console.log('\n=== БИТАЯ ЧАСТЬ: СУММА НЕ СОВПАЛА ===');
    buildServer(SRC, 2.5);
    fs.rmSync(STATE, { force: true });
    const push2 = await gitlab.push({ token: 'gl-token', project: 'me/server', dir: SRC, stateFile: STATE, onLog: () => {} });
    ok(push2.ok, 'отправка для проверки суммы прошла');
    const pkg2 = mock.state.packages[0];
    const partName = [...pkg2.files.keys()].find((n) => /\.7z\.00\d$/.test(n));
    mock.state.corrupt.set(partName, Buffer.from('испорчено'));
    const badPull = await gitlab.pull({ token: 'gl-token', project: 'me/server', dir: DEST, onLog: () => {} });
    ok(badPull.ok === false && /контрольная сумма/.test(badPull.error), 'битая часть не распаковывается', badPull.error);
    ok(mock.state.packages.length === 1, 'пакет остался на месте — данные не потеряны');
    mock.state.corrupt.clear();

    console.log('\n=== ХРАНИЛИЩЕ НЕ ПРИНИМАЕТ ФАЙЛ (413) ===');
    mock.state.failUpload.add('сервер.7z.001');
    fs.rmSync(STATE, { force: true });
    const tooBig = await gitlab.push({ token: 'gl-token', project: 'me/server', dir: SRC, stateFile: STATE, onLog: () => {} });
    ok(tooBig.ok === false && /413|слишком|размер/i.test(tooBig.error), 'ошибка размера объяснена', tooBig.error);
    mock.state.failUpload.clear();

    console.log('\n=== РЕЖИМ «НЕ УДАЛЯТЬ ПАКЕТ» ===');
    fs.rmSync(STATE, { force: true });
    const keepPush = await gitlab.push({ token: 'gl-token', project: 'me/server', dir: SRC, stateFile: STATE, onLog: () => {} });
    ok(keepPush.ok, 'отправка с сохранением пакета');
    const keepPull = await gitlab.pull({ token: 'gl-token', project: 'me/server', dir: DEST, cleanup: false, onLog: () => {} });
    ok(keepPull.ok && keepPull.repoCleaned === false, 'cleanup:false оставляет пакет', String(keepPull.repoCleaned));
    ok(mock.state.packages.length === 1, 'пакет на месте', 'пакетов: ' + mock.state.packages.length);
    await gitlab.pull({ token: 'gl-token', project: 'me/server', dir: DEST, onLog: () => {} });
    ok(mock.state.packages.length === 0, 'следующий забор штатно удаляет пакет');

    /* ─────────── GitHub: 422 «input was too large» лечится мельче ─────────── */
    console.log('\n=== GITHUB: 422 «INPUT WAS TOO LARGE» — РЕЖЕМ МЕЛЬЧЕ ===');
    const { makeServer, store } = require('./mock-gh');
    delete require.cache[require.resolve('../core/github')];
    const ghMock = makeServer('o/r');
    await new Promise((r) => ghMock.listen(8814, '127.0.0.1', r));
    process.env.OMNI_GITHUB_API = 'http://127.0.0.1:8814';
    process.env.OMNI_GITHUB_RAW = 'http://127.0.0.1:8814';
    process.env.OMNI_SPLIT_MB = '4';
    delete require.cache[require.resolve('../core/gitlab')];
    const github = require('../core/github');

    const ghSrc = path.join(os.tmpdir(), 'omni-gh-422');
    fs.rmSync(ghSrc, { recursive: true, force: true });
    fs.mkdirSync(path.join(ghSrc, 'world'), { recursive: true });
    fs.writeFileSync(path.join(ghSrc, 'world', 'big.mca'), crypto.randomBytes(6 * 1024 * 1024));
    const ghState = path.join(os.tmpdir(), 'omni-gh-422-state.json');
    fs.rmSync(ghState, { force: true });
    /* ветка уже есть: мок не умеет Contents API, которым панель делает первый коммит */
    store.trees.set('tree0', []);
    store.commits.set('commit0', { sha: 'commit0', tree: { sha: 'tree0' }, parents: [], message: 'init' });
    store.refs.set('main', 'commit0');
    /* мок, как настоящий GitHub, не принимает blob больше 1,5 МБ */
    store.blobLimit = 1.5 * 1024 * 1024;
    store.tooLarge = 0;
    const ghLogs = [];
    const ghPush = await github.push({
      dir: ghSrc, repo: 'o/r', branch: 'main', token: 'test-token', mode: 'archive',
      stateFile: ghState, onLog: (t) => ghLogs.push(t),
    });
    ok(store.tooLarge > 0, 'мок отказал с 422, как настоящий GitHub', 'отказов: ' + store.tooLarge);
    ok(ghPush.ok, 'панель справилась: архив ушёл мельче', ghPush.error || '');
    ok(/режу мельче/.test(ghLogs.join('\n')), 'в логе видно, что части уменьшены',
      ghLogs.filter((l) => /режу мельче/.test(l)).join(' '));
    ok(ghPush.parts >= 3, 'частей стало больше', 'частей: ' + ghPush.parts);
    ghMock.close();

    console.log('\n' + (fails ? `ПРОВАЛОВ: ${fails}` : 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ'));
    mock.close();
    fs.rmSync(SRC, { recursive: true, force: true });
    fs.rmSync(DEST, { recursive: true, force: true });
    process.exit(fails ? 1 : 0);
  } catch (err) {
    console.error('ОШИБКА ПРОГОНА: ' + err.message);
    mock.close();
    process.exit(1);
  }
});
