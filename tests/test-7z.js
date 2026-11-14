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

  console.log(fails ? `\nПРОВАЛОВ: ${fails}` : '\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ОШИБКА', e); process.exit(1); });
