'use strict';
/**
 * Публикация вики на GitHub из папки docs/wiki.
 *
 * Вики — это отдельный git-репозиторий (<owner>/<repo>.wiki.git), API для него нет,
 * поэтому скрипт просто копирует markdown-файлы и делает push.
 *
 * Требования:
 *   - вики включена в настройках репозитория (Settings → Features → Wikis);
 *   - токен с правами на Contents: read/write (для вики нужен classic-токен с repo).
 *
 * Запуск:
 *   GITHUB_TOKEN=... node tools/publish-wiki.js --repo Shokydo/OmniPanel
 *   GITHUB_TOKEN=... node tools/publish-wiki.js --repo Shokydo/OmniPanel --dry
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const getArg = (name, fallback = '') => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const repo = getArg('repo', process.env.GITHUB_REPO || '');
const token = process.env.GITHUB_TOKEN || '';
const dry = args.includes('--dry');
const srcDir = path.resolve(__dirname, '..', 'docs', 'wiki');

if (!repo || !repo.includes('/')) {
  console.error('Укажи репозиторий: --repo владелец/имя');
  process.exit(1);
}
if (!fs.existsSync(srcDir)) {
  console.error('Нет папки docs/wiki — нечего публиковать');
  process.exit(1);
}

const files = fs.readdirSync(srcDir).filter((f) => f.toLowerCase().endsWith('.md'));
if (!files.length) {
  console.error('В docs/wiki нет markdown-файлов');
  process.exit(1);
}
console.log(`Файлов вики: ${files.length} → ${repo}`);
for (const f of files) console.log('  •', f);

if (dry) {
  console.log('\nПробный прогон: ничего не отправлено.');
  process.exit(0);
}
if (!token) {
  console.error('\nНужен GITHUB_TOKEN: GITHUB_TOKEN=... node tools/publish-wiki.js --repo ' + repo);
  process.exit(1);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-wiki-'));
const remotePlain = `https://github.com/${repo}.wiki.git`;
const remoteAuth = `https://x-access-token:${token}@github.com/${repo}.wiki.git`;

const git = (gitArgs, opts = {}) => execFileSync('git', gitArgs, {
  cwd: work,
  stdio: opts.quiet ? 'pipe' : 'inherit',
  encoding: 'utf8',
});

try {
  fs.mkdirSync(work, { recursive: true });
  try {
    git(['clone', '--depth', '1', remoteAuth, '.'], { quiet: true });
    console.log('Вики уже есть — обновляю');
  } catch {
    console.log('Вики ещё нет — создаю первую страницу');
    git(['init', '-q']);
    git(['remote', 'add', 'origin', remoteAuth]);
  }

  for (const f of files) {
    fs.copyFileSync(path.join(srcDir, f), path.join(work, f));
  }
  /* GitHub показывает Home.md как главную страницу вики */
  fs.writeFileSync(path.join(work, '_Sidebar.md'), [
    '# OmniPanel',
    '',
    ...files.filter((f) => f !== 'Home.md').map((f) => `- [${f.replace(/\.md$/, '').replace(/-/g, ' ')}](${f.replace(/\.md$/, '')})`),
    '',
  ].join('\n'), 'utf8');

  git(['add', '-A']);
  let status = '';
  try { status = git(['status', '--porcelain'], { quiet: true }); } catch { status = 'x'; }
  if (!status.trim()) {
    console.log('Вики уже совпадает с docs/wiki — отправлять нечего');
    process.exit(0);
  }

  git(['-c', 'user.name=OmniPanel', '-c', 'user.email=omnipanel@local', 'commit', '-m', 'Вики: обновление из панели']);
  git(['push', 'origin', 'HEAD:master']);
  console.log('\nГотово: https://github.com/' + repo + '/wiki');
} catch (err) {
  const text = (err.stderr || err.stdout || err.message || '').toString();
  console.error('\nНе удалось опубликовать вики.');
  if (/not found|404|Authentication failed|could not read/i.test(text)) {
    console.error('Похоже, вики выключена или токен не подходит.');
    console.error('Включи: Settings → Features → Wikis. Для вики нужен classic-токен с правом repo.');
  } else {
    console.error(text.slice(0, 600));
  }
  if (remotePlain) console.error('Репозиторий вики: ' + remotePlain);
} finally {
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* временная папка */ }
}
