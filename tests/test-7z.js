// Проверки плотных архивов: бэкапы в 7z (LZMA2), плотность против zip,
// восстановление, старые zip, просмотр .7z в редакторе и запасной путь без 7-Zip.
// Запуск: node tests/test-7z.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const seven = require(path.join(ROOT, 'core/seven'));
const backup = require(path.join(ROOT, 'core/backup'));
const archive = require(path.join(ROOT, 'core/archive'));

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  OK   ' : '  FAIL ') + label + (extra ? ' — ' + extra : ''));
  if (!cond) fails += 1;
};

/* ── «сервер»: конфиги, тысяча мелких файлов, кусок мира, служебный мусор ── */
const SRV = path.join(os.tmpdir(), 'omni-7z-srv');
const BAK = path.join(os.tmpdir(), 'omni-7z-bak');
fs.rmSync(SRV, { recursive: true, force: true });
fs.rmSync(BAK, { recursive: true, force: true });
fs.mkdirSync(path.join(SRV, 'plugins/MyPlugin/data'), { recursive: true });
fs.mkdirSync(path.join(SRV, 'world/region'), { recursive: true });
fs.mkdirSync(path.join(SRV, 'cache'), { recursive: true });
fs.mkdirSync(path.join(SRV, '.git'), { recursive: true });
fs.writeFileSync(path.join(SRV, 'server.properties'), 'server-port=25565\nmotd=Мир друзей\n'.repeat(120));
for (let i = 0; i < 600; i += 1) {
  fs.writeFileSync(path.join(SRV, `plugins/MyPlugin/data/row${i}.yml`),
    `id: ${i}\nname: player_${i}\nflags:\n  - online\n  - trusted\n`.repeat(12));
}
/* играбельный, но не случайный мир: так регионы ведут себя как настоящие */
const world = Buffer.alloc(3 * 1024 * 1024);
for (let i = 0; i < world.length; i += 1) world[i] = (i * 31 + (i >> 7)) % 251;
fs.writeFileSync(path.join(SRV, 'world/region/r.0.0.mca'), world);
fs.writeFileSync(path.join(SRV, 'cache/junk.bin'), Buffer.alloc(400000, 9));
fs.writeFileSync(path.join(SRV, '.git/config'), 'x'.repeat(500));

(async () => {
  console.log('=== 7-Zip рядом с панелью ===');
  const bin = seven.binary();
  ok(!!bin, '7-Zip найден', bin || 'не найден — бэкапы уйдут в zip');
  if (!bin) {
    console.log('\n7-Zip нет в системе: проверяю только запасной путь в zip');
  }

  console.log('\n=== бэкап в 7z и в zip: что плотнее ===');
  const zipped = await backup.createBackup({ srcDir: SRV, destDir: BAK, label: 'Мир друзей', format: 'zip' });
  ok(/\.zip$/.test(zipped.name), 'zip-бэкап собран', zipped.name);
  ok(zipped.files > 600, 'служебный мусор не считается', 'файлов: ' + zipped.files);

  let packed = null;
  if (bin) {
    packed = await backup.createBackup({ srcDir: SRV, destDir: BAK, label: 'Мир друзей', format: 'auto' });
    ok(/\.7z$/.test(packed.name), 'по умолчанию бэкап в 7z', packed.name);
    ok(packed.packer === '7z lzma2', 'сжатие LZMA2', packed.packer);
    ok(packed.size < zipped.size, '7z меньше zip', `${packed.size} Б против ${zipped.size} Б, выигрыш ${(100 - (packed.size / zipped.size) * 100).toFixed(1)}%`);
    ok(packed.ratio > 1, 'коэффициент сжатия посчитан', 'в ' + packed.ratio + ' раза');
  }

  console.log('\n=== исключения: мусор не попадает в архив ===');
  const rawNames = [];
  if (bin) {
    for (const item of await seven.list(packed.file)) if (item.Path) rawNames.push(item.Path);
  } else {
    const zip = require(path.join(ROOT, 'core/zip'));
    for (const e of zip.list(fs.readFileSync(zipped.file))) rawNames.push(e.name);
  }
  ok(!rawNames.some((n) => /(^|\/)cache\//.test(n)), 'cache не попал');
  ok(!rawNames.some((n) => /(^|\/)\.git\//.test(n)), '.git не попал');
  ok(rawNames.some((n) => /server\.properties$/.test(n)), 'server.properties внутри');
  ok(rawNames.some((n) => /world\/region\/r\.0\.0\.mca$/.test(n)), 'мир внутри');

  console.log('\n=== восстановление ===');
  const dest7z = path.join(os.tmpdir(), 'omni-7z-restore');
  fs.rmSync(dest7z, { recursive: true, force: true });
  if (packed) {
    await backup.restoreBackup({ file: packed.file, destDir: dest7z });
    ok(fs.existsSync(path.join(dest7z, 'server.properties')), 'server.properties восстановлен');
    ok(fs.readFileSync(path.join(dest7z, 'server.properties'), 'utf8').startsWith('server-port=25565'),
      'содержимое совпадает');
    ok(fs.statSync(path.join(dest7z, 'world/region/r.0.0.mca')).size === world.length, 'мир целый по размеру');
    ok(fs.readFileSync(path.join(dest7z, 'world/region/r.0.0.mca')).equals(world), 'мир совпал побайтово');
    ok(fs.existsSync(path.join(dest7z, 'plugins/MyPlugin/data/row599.yml')), 'вложенные файлы на месте');
    const tested = await seven.test(packed.file);
    ok(tested.ok, 'архив проходит проверку целостности 7z t');
  }

  const destZip = path.join(os.tmpdir(), 'omni-zip-restore');
  fs.rmSync(destZip, { recursive: true, force: true });
  await backup.restoreBackup({ file: zipped.file, destDir: destZip });
  ok(fs.existsSync(path.join(destZip, 'server.properties')), 'старый zip-бэкап тоже восстанавливается');

  console.log('\n=== список бэкапов ===');
  const list = backup.listBackups(BAK);
  ok(list.length === (packed ? 2 : 1), 'оба формата видны в списке', list.map((x) => x.name).join(', '));
  ok(list.some((x) => /\.7z$/.test(x.name)) || !packed, '7z в списке');
  ok(list.some((x) => /\.zip$/.test(x.name)), 'zip в списке');

  console.log('\n=== .7z в редакторе файлов ===');
  if (packed) {
    fs.copyFileSync(packed.file, path.join(SRV, 'backup.7z'));
    const opened = await archive.open(SRV, 'backup.7z');
    ok(opened.ok && opened.total > 600, 'архив открылся списком', 'файлов: ' + opened.total);
    ok(opened.format === '7z', 'формат определён как 7z');
    const text = await archive.readEntry(SRV, 'backup.7z', 'server.properties');
    ok(text.ok && /server-port=25565/.test(text.content), 'файл из архива читается без распаковки');
    const one = await archive.extract(SRV, 'backup.7z', 'one', 'server.properties');
    ok(one.ok && fs.existsSync(path.join(SRV, 'one/server.properties')), 'один файл распакован');
    const all = await archive.extract(SRV, 'backup.7z', 'all');
    ok(all.ok && fs.existsSync(path.join(SRV, 'all/world/region/r.0.0.mca')), 'весь архив распакован', 'файлов: ' + all.files);
  }

  console.log('\n=== запасной путь: 7-Zip рядом не оказался ===');
  const oldPath = process.env.PATH;
  process.env.PATH = '';
  seven.reset();
  ok(!seven.available(), '7-Zip не видно');
  const fallback = await backup.createBackup({ srcDir: SRV, destDir: BAK, label: 'Без 7zip' });
  ok(/\.zip$/.test(fallback.name), 'бэкап всё равно создан, но в zip', fallback.name);
  ok(fallback.size > 0, 'архив не пустой', fallback.size + ' Б');
  process.env.PATH = oldPath;
  seven.reset();
  ok(seven.available(), 'после возврата PATH 7-Zip снова виден');

  console.log('\n=== разбивка на части (для пересылки на GitHub) ===');
  const SPLIT = path.join(os.tmpdir(), 'omni-7z-split');
  fs.rmSync(SPLIT, { recursive: true, force: true });
  const bigSrc = path.join(os.tmpdir(), 'omni-7z-big');
  fs.rmSync(bigSrc, { recursive: true, force: true });
  fs.mkdirSync(path.join(bigSrc, 'world'), { recursive: true });
  fs.writeFileSync(path.join(bigSrc, 'world', 'blob.bin'), require('crypto').randomBytes(2.5 * 1024 * 1024));
  fs.writeFileSync(path.join(bigSrc, 'server.properties'), 'level-name=big\n');
  const split = await backup.createBackup({ srcDir: bigSrc, destDir: SPLIT, label: 'Большой', format: '7z', volumeMb: 1 });
  ok(split.parts.length >= 3, 'архив разбит на части', 'частей: ' + split.parts.length);
  ok(split.partNames.every((n) => /\.7z\.\d{3}$/.test(n)), 'имена частей как у 7-Zip', split.partNames.slice(0, 2).join(', '));
  ok(split.partNames[0].endsWith('.001'), 'первая часть — .001');
  const partSum = split.parts.reduce((sum, f) => sum + fs.statSync(f).size, 0);
  ok(split.size === partSum, 'размер бэкапа — сумма всех частей', split.size + ' Б');
  const listed = backup.listBackups(SPLIT);
  ok(listed.length === 1, 'в списке бэкапов одна строка, а не по строке на часть', 'строк: ' + listed.length);
  ok(listed[0].parts === split.parts.length, 'в списке видно число частей', 'частей: ' + listed[0].parts);

  const joinBack = path.join(os.tmpdir(), 'omni-7z-split-restore');
  fs.rmSync(joinBack, { recursive: true, force: true });
  await backup.restoreBackup({ file: split.file, destDir: joinBack });
  ok(fs.statSync(path.join(joinBack, 'world', 'blob.bin')).size === 2.5 * 1024 * 1024,
    'разбитый архив восстанавливается целиком');
  ok(backup.deleteBackup(split.file), 'удаление бэкапа проходит');
  ok(fs.readdirSync(SPLIT).length === 0, 'удаляются все части, мусора не остаётся');

  console.log('\n=== «лёгкий» бэкап: без libraries, versions и логов ===');
  const leanSrc = path.join(os.tmpdir(), 'omni-7z-lean');
  fs.rmSync(leanSrc, { recursive: true, force: true });
  fs.mkdirSync(path.join(leanSrc, 'libraries/net'), { recursive: true });
  fs.mkdirSync(path.join(leanSrc, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(leanSrc, 'world'), { recursive: true });
  fs.writeFileSync(path.join(leanSrc, 'world', 'level.dat'), 'мир');
  fs.writeFileSync(path.join(leanSrc, 'server.properties'), 'level-name=world\n');
  /* библиотеки — как настоящие .jar: уже сжаты, поэтому вес виден сразу */
  for (let i = 0; i < 20; i += 1) {
    fs.writeFileSync(path.join(leanSrc, `libraries/net/lib${i}.jar`), require('crypto').randomBytes(200000));
  }
  for (let i = 0; i < 5; i += 1) {
    fs.writeFileSync(path.join(leanSrc, `logs/${i}.log`), 'player joined the game\n'.repeat(4000));
  }
  const leanDst = path.join(os.tmpdir(), 'omni-7z-lean-out');
  fs.rmSync(leanDst, { recursive: true, force: true });
  const full = await backup.createBackup({ srcDir: leanSrc, destDir: leanDst, label: 'full', format: '7z' });
  const lean = await backup.createBackup({
    srcDir: leanSrc, destDir: leanDst, label: 'lean', format: '7z',
    skip: backup.leanSkip(), skipNames: backup.leanNames(),
  });
  ok(lean.raw < full.raw, 'в лёгкий бэкап попадает меньше данных',
    `${(full.raw / 1048576).toFixed(1)} → ${(lean.raw / 1048576).toFixed(1)} МБ`);
  ok(lean.size < full.size, 'лёгкий архив меньше', `${full.size} → ${lean.size} Б`);
  ok(full.files > lean.files + 20, 'библиотеки и логи не попали', `файлов ${full.files} → ${lean.files}`);
  const leanNames = await seven.list(lean.file);
  const leanPaths = leanNames.filter((x) => !x.isDir).map((x) => x.Path).filter(Boolean);
  ok(!leanPaths.some((x) => /(^|\/)libraries\//.test(x)), 'libraries исключены');
  ok(!leanPaths.some((x) => /(^|\/)logs\//.test(x)), 'logs исключены');
  ok(leanPaths.some((x) => /world\/level\.dat$/.test(x)), 'мир на месте');
  ok(leanPaths.some((x) => /server\.properties$/.test(x)), 'конфиги на месте');

  console.log('\n=== отчёт: что занимает место ===');
  const heavy = backup.topDirs(leanSrc, 3);
  ok(heavy.length >= 3, 'папки посчитаны', heavy.map((d) => `${d.name} ${d.bytes}`).join(', '));
  ok(heavy[0].bytes >= heavy[1].bytes, 'самая тяжёлая папка первая', heavy[0].name + ' ' + heavy[0].bytes);

  console.log(fails ? `\nПРОВАЛОВ: ${fails}` : '\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ОШИБКА', e); process.exit(1); });
