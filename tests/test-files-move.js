// Перенос файлов в ядре: обычный путь, другой диск (EXDEV), занятый файл (EBUSY),
// занятое имя, папка внутрь себя, перенос в корень и защита от выхода наружу.
// Запуск: node tests/test-files-move.js
'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const files = require('../core/files');

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  OK   ' : '  FAIL ') + label + (extra ? ' — ' + extra : ''));
  if (!cond) fails += 1;
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-move-'));

function seed() {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, 'plugins'), { recursive: true });
  fs.mkdirSync(path.join(root, 'config', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'server.properties'), 'level-name=world\n');
  fs.writeFileSync(path.join(root, 'config', 'sub', 'deep.yml'), 'a: 1\n');
}

const realRename = fsp.rename;

(async () => {
  console.log('Перенос файлов');

  /* 1. обычный перенос файла в папку */
  seed();
  let res = await files.move(root, 'server.properties', 'plugins');
  ok(res.ok && res.path === 'plugins/server.properties', 'файл переехал в папку', res.path);
  ok(fs.existsSync(path.join(root, 'plugins', 'server.properties')), 'файл лежит на новом месте');
  ok(!fs.existsSync(path.join(root, 'server.properties')), 'на старом месте файла нет');

  /* 2. перенос папки с содержимым */
  seed();
  res = await files.move(root, 'config', 'plugins');
  ok(res.ok && res.path === 'plugins/config', 'папка переехала в папку', res.path);
  ok(fs.existsSync(path.join(root, 'plugins', 'config', 'sub', 'deep.yml')), 'содержимое папки цело');

  /* 3. другой диск: rename отвечает EXDEV — должен сработать копированием */
  seed();
  fsp.rename = async () => { const e = new Error('cross-device link not permitted'); e.code = 'EXDEV'; throw e; };
  res = await files.move(root, 'config', 'plugins');
  fsp.rename = realRename;
  ok(res.ok && res.copied === true, 'другой диск: копирование вместо переименования', JSON.stringify(res));
  ok(fs.existsSync(path.join(root, 'plugins', 'config', 'sub', 'deep.yml')), 'при копировании файлы на месте');
  ok(!fs.existsSync(path.join(root, 'config')), 'исходная папка убрана после копирования');

  /* 4. занятый файл: первые две попытки EBUSY, потом успех */
  seed();
  let calls = 0;
  fsp.rename = async (a, b) => {
    calls += 1;
    if (calls <= 2) { const e = new Error('resource busy'); e.code = 'EBUSY'; throw e; }
    return realRename(a, b);
  };
  res = await files.move(root, 'server.properties', 'plugins');
  fsp.rename = realRename;
  ok(res.ok && calls === 3, 'занятый файл: перенос со второй попытки', 'попыток: ' + calls);

  /* 5. файл занят всё время — понятный текст ошибки */
  seed();
  const busy = () => { const e = new Error('resource busy'); e.code = 'EBUSY'; throw e; };
  const realCp = fsp.cp;
  fsp.rename = async () => busy();
  fsp.cp = async () => busy();
  let errText = '';
  try { await files.move(root, 'server.properties', 'plugins'); } catch (e) { errText = e.message; }
  fsp.rename = realRename;
  fsp.cp = realCp;
  ok(/занят/i.test(errText), 'занятый файл: ошибка объясняет причину', errText);

  /* 6. имя уже занято */
  seed();
  fs.writeFileSync(path.join(root, 'plugins', 'server.properties'), 'other');
  errText = '';
  try { await files.move(root, 'server.properties', 'plugins'); } catch (e) { errText = e.message; }
  ok(/уже есть/i.test(errText), 'занятое имя: отказ с понятным текстом', errText);

  /* 7. папку внутрь себя нельзя */
  seed();
  errText = '';
  try { await files.move(root, 'config', 'config/sub'); } catch (e) { errText = e.message; }
  ok(/внутрь себя/i.test(errText), 'папка внутрь себя: отказ', errText);

  /* 8. перенос в корень сервера */
  seed();
  res = await files.move(root, 'config/sub/deep.yml', '');
  ok(res.ok && res.path === 'deep.yml', 'файл переехал в корень', res.path);

  /* 9. уже в этой папке — без ошибки и без копии */
  seed();
  res = await files.move(root, 'server.properties', '');
  ok(res.ok && res.same === true, '«уже здесь» не считается ошибкой', JSON.stringify(res));

  /* 10. наружу нельзя */
  seed();
  errText = '';
  try { await files.move(root, 'server.properties', '../outside'); } catch (e) { errText = e.message; }
  ok(/вне папки сервера/i.test(errText), 'выход за папку сервера запрещён', errText);

  /* 11. цель-папка создаётся, если её нет */
  seed();
  res = await files.move(root, 'server.properties', 'brand/new/dir');
  ok(res.ok && fs.existsSync(path.join(root, 'brand', 'new', 'dir', 'server.properties')), 'недостающая папка создаётся');

  /* 12. переименование тоже переживает EXDEV */
  seed();
  fsp.rename = async () => { const e = new Error('cross-device'); e.code = 'EXDEV'; throw e; };
  res = await files.rename(root, 'server.properties', 'renamed.properties');
  fsp.rename = realRename;
  ok(res.ok && fs.existsSync(path.join(root, 'renamed.properties')), 'переименование через копирование', JSON.stringify(res));

  fs.rmSync(root, { recursive: true, force: true });
  console.log(fails ? `\nПровалено: ${fails}` : '\nВсё прошло');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('Упало:', e);
  try { fsp.rename = realRename; } catch { /* уже */ }
  process.exit(1);
});
