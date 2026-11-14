// Проверки ядра: кодировки + синхронизация GitHub (без интернета, на моке).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { makeServer } = require('./mock-gh');
const github = require('../core/github');
const { detectEncoding, decodeSingleByte, repairMojibake, CP1251, CP866 } = require('../core/encodings');

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  OK   ' : '  FAIL ') + label + (extra ? ' — ' + extra : ''));
  if (!cond) fails += 1;
};

function enc(str, table) {
  const rev = new Map();
  for (let i = 0; i < table.length; i++) rev.set(table[i], 0x80 + i);
  const out = [];
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (rev.has(ch)) out.push(rev.get(ch));
    else out.push(0x3F);
  }
  return Buffer.from(out);
}

console.log('=== КОДИРОВКИ ===');
const words = ['Загружено триггеров предметов: 0', 'Сервер запущен, порт 25565', 'Плагин MythicPassiveSkills включён'];
ok(detectEncoding(enc(words[0], CP1251)) === 'cp1251', 'cp1251 определяется как cp1251');
ok(detectEncoding(enc(words[0], CP866)) === 'cp866', 'cp866 определяется как cp866');
ok(detectEncoding(Buffer.from(words[0], 'utf8')) === 'utf8', 'utf8 определяется как utf8');
ok(repairMojibake('╟руЁєцхэю ЄЁшуухЁют яЁхфьхЄют: 0') === 'Загружено триггеров предметов: 0', 'кракозябры лечатся');
ok(repairMojibake('════ Сервер загружен ════') === '════ Сервер загружен ════', 'декоративные рамки не ломаются');

function makeServerDir(root, tag) {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'world/region'), { recursive: true });
  fs.mkdirSync(path.join(root, 'plugins/Essentials'), { recursive: true });
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'world/level.dat'), 'LEVEL-' + tag);
  fs.writeFileSync(path.join(root, 'world/region/r.0.0.mca'), 'REGION-' + tag);
  fs.writeFileSync(path.join(root, 'plugins/Essentials/config.yml'), 'kit: ' + tag);
  fs.writeFileSync(path.join(root, 'plugins/Essentials.jar'), 'PLUGIN-JAR');
  fs.writeFileSync(path.join(root, 'server.jar'), 'CORE-JAR');
  fs.writeFileSync(path.join(root, 'logs/latest.log'), 'log');
  fs.writeFileSync(path.join(root, 'world/session.lock'), 'lock');
  return root;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-'));
const A = makeServerDir(path.join(tmp, 'A'), 'one');
const B = makeServerDir(path.join(tmp, 'B'), 'two');
const stateA = path.join(tmp, 'a.json');
const stateB = path.join(tmp, 'b.json');

const srv = makeServer('o/r');
srv.listen(8787, '127.0.0.1', async () => {
  process.env.OMNI_GITHUB_API = 'http://127.0.0.1:8787';
  const T = 'test-token';

  console.log('\n=== АККАУНТ ===');
  const user = await github.getUser(T);
  ok(user.ok && user.login === 'tester', 'вход по токену', JSON.stringify(user));
  const repos = await github.listRepos(T);
  ok(repos.ok && repos.repos.length >= 1 && repos.repos[0].full === 'o/r', 'список репозиториев', JSON.stringify(repos.repos));
  const created = await github.createRepo(T, 'new-world', true);
  ok(created.ok && created.repo === 'tester/new-world', 'создание репозитория', JSON.stringify(created));
  ok((await github.getUser('bad')).ok === false, 'плохой токен отклонён');

  console.log('\n=== ПОЛНЫЙ СЕРВЕР (scope=all по умолчанию) ===');
  const push1 = await github.push({ dir: A, repo: 'o/r', branch: 'main', token: T, scope: 'all', stateFile: stateA, message: 'full' });
  ok(push1.ok, 'push прошёл', JSON.stringify(push1));
  const tree = [...require('./mock-gh').store.trees.values()].pop().map((e) => e.path).sort();
  ok(tree.includes('server.jar') && tree.includes('plugins/Essentials.jar'), 'ядро и плагины-джарники синхронизируются', tree.join(', '));
  ok(tree.includes('world/level.dat') && tree.includes('plugins/Essentials/config.yml'), 'мир и конфиги на месте');
  ok(!tree.some((p) => p.startsWith('logs/') || p.endsWith('.lock')), 'логи и lock-файлы не тащим');
  ok(tree.length === 5, 'всего файлов в коммите: 5', String(tree.length));

  console.log('\n=== ОБНОВЛЕНИЕ НА ВТОРОМ ПК ===');
  const chk = await github.check({ dir: B, repo: 'o/r', branch: 'main', token: T, scope: 'all', stateFile: stateB });
  ok(chk.ok && chk.behind > 0, 'видны обновления', `behind=${chk.behind}`);
  const pull = await github.pull({ dir: B, repo: 'o/r', branch: 'main', token: T, scope: 'all', stateFile: stateB });
  ok(pull.ok && pull.downloaded === 5, 'скачан полный сервер', JSON.stringify(pull));
  ok(fs.readFileSync(path.join(B, 'server.jar'), 'utf8') === 'CORE-JAR', 'ядро обновилось локально');

  console.log('\n=== ПОВТОРНЫЙ PUSH БЕЗ ИЗМЕНЕНИЙ ===');
  const push2 = await github.push({ dir: A, repo: 'o/r', branch: 'main', token: T, scope: 'all', stateFile: stateA });
  ok(push2.ok && push2.upToDate, 'нечего отправлять', JSON.stringify(push2));

  console.log('\n=== УДАЛЕНИЕ ФАЙЛА ===');
  fs.unlinkSync(path.join(A, 'plugins/Essentials/config.yml'));
  const push3 = await github.push({ dir: A, repo: 'o/r', branch: 'main', token: T, scope: 'all', stateFile: stateA });
  ok(push3.ok && push3.removed === 1, 'удаление отправлено', JSON.stringify(push3));
  const pull3 = await github.pull({ dir: B, repo: 'o/r', branch: 'main', token: T, scope: 'all', stateFile: stateB });
  ok(pull3.ok && pull3.removed === 1 && !fs.existsSync(path.join(B, 'plugins/Essentials/config.yml')), 'удаление применилось локально');

  console.log('\n=== ОШИБКИ ===');
  ok((await github.push({ dir: A, repo: 'кривой', branch: 'main', token: T, stateFile: stateA })).ok === false, 'кривой репозиторий отклонён');
  ok((await github.pull({ dir: '/нет/такой', repo: 'o/r', branch: 'main', token: T, stateFile: stateB })).ok === false, 'нет папки — ошибка');

  console.log('\n' + (fails ? `ПРОВАЛОВ: ${fails}` : 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ'));
  srv.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
});
