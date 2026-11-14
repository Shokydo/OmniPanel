// Проверки 1.19: редактор файлов — вкладки, архивы, картинки, перетаскивание,
// создание файла по имени, обновление списка бэкапов.
// Запуск: xvfb-run -a node tests/test-editor.js <playwright> <electron>
const pwPath = process.argv[2] || 'playwright';
const electronPath = process.argv[3] || '/home/user/.cache/bld/node_modules/electron/dist/electron';
const { _electron: electron } = require(pwPath);
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const zip = require(path.join(ROOT, 'core/zip'));
const DATA = path.join(path.dirname(electronPath), 'OmniPanelData');
const SRV = path.join(os.tmpdir(), 'omni-editor-srv');

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  OK   ' : '  FAIL ') + label + (extra ? ' — ' + extra : ''));
  if (!cond) fails += 1;
};

/* ── сервер с файлами, архивом и картинкой ── */
fs.rmSync(SRV, { recursive: true, force: true });
fs.mkdirSync(path.join(SRV, 'plugins/MyPlugin'), { recursive: true });
fs.mkdirSync(path.join(SRV, 'images'), { recursive: true });
fs.writeFileSync(path.join(SRV, 'server.properties'), 'level-name=world\n');
for (let i = 1; i <= 4; i += 1) {
  fs.writeFileSync(path.join(SRV, `plugins/MyPlugin/config${i}.yml`), `name: config${i}\nvalue: ${i}\n`);
}
fs.writeFileSync(path.join(SRV, 'plugins/MyPlugin/Target.yml'), 'move: me\n');

/* zip с двумя файлами — как настоящий архив плагина */
const pack = path.join(SRV, 'plugins/pack.zip');
fs.writeFileSync(pack, zip.create([
  { name: 'plugin.yml', data: 'name: Pack\nversion: 1.0\n' },
  { name: 'config/inner.yml', data: 'inside: yes\n' },
]));
fs.writeFileSync(path.join(SRV, 'plugins/fake.rar'), 'Rar!\u001a\u0007\u0000данные');
/* настоящая картинка — иконка панели */
fs.copyFileSync(path.join(ROOT, 'assets/icon.png'), path.join(SRV, 'images/logo.png'));

fs.mkdirSync(DATA, { recursive: true });
fs.rmSync(path.join(DATA, 'panel.json'), { force: true });
fs.rmSync(path.join(DATA, 'backups'), { recursive: true, force: true });
fs.rmSync(path.join(DATA, 'Local Storage'), { recursive: true, force: true });
fs.writeFileSync(path.join(DATA, 'servers.json'), JSON.stringify([
  { id: 's1', name: 'Мир друзей', command: 'sleep 300', cwd: SRV, encoding: 'auto' },
]));

(async () => {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [ROOT, '--no-sandbox'],
    env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' },
    timeout: 60000,
  });
  const page = await app.firstWindow();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.waitForSelector('.profile-name');
  await page.waitForTimeout(1200);

  /* ─────────── 1. вкладки открытых файлов ─────────── */
  console.log('\n=== вкладки открытых файлов ===');
  await page.evaluate(() => setTab('files'));
  await page.waitForTimeout(600);
  const limit = await page.evaluate(() => FM_MAX_TABS);
  ok(limit >= 12, 'лимит открытых файлов поднят', String(limit));

  for (let i = 1; i <= 4; i += 1) {
    await page.evaluate((n) => fmOpenFile(`plugins/MyPlugin/config${n}.yml`), i);
    await page.waitForTimeout(180);
  }
  const tabs = await page.evaluate(() => ({
    count: document.querySelectorAll('#fmTabs .fm-tab').length,
    names: [...document.querySelectorAll('#fmTabs .ft-nm')].map((e) => e.textContent),
    active: FM.activeIdx,
    value: document.getElementById('fmText').value,
    counter: (document.querySelector('.fm-tab-count') || {}).textContent || '',
  }));
  ok(tabs.count === 4, 'четыре файла открыты во вкладках', tabs.names.join(', '));
  ok(/name: config4/.test(tabs.value), 'в редакторе последний открытый файл', tabs.value.trim());
  ok(/\d+\/\d+/.test(tabs.counter), 'виден счётчик открытых', tabs.counter);

  const switched = await page.evaluate(async () => {
    document.querySelectorAll('#fmTabs .fm-tab')[0].click();
    await new Promise((r) => setTimeout(r, 250));
    return { value: document.getElementById('fmText').value, idx: FM.activeIdx };
  });
  ok(/name: config1/.test(switched.value) && switched.idx === 0, 'переключение на первую вкладку', switched.value.trim());

  /* правка + закрытие вкладки без сохранения через средний клик */
  const closed = await page.evaluate(async () => {
    document.getElementById('fmText').value += 'edited: yes\n';
    fmOnInput();
    const before = document.querySelectorAll('#fmTabs .fm-tab').length;
    document.querySelectorAll('#fmTabs .ft-x')[3].click();
    await new Promise((r) => setTimeout(r, 250));
    const modal = !document.getElementById('textModal').classList.contains('hidden');
    return { before, after: document.querySelectorAll('#fmTabs .fm-tab').length, modal };
  });
  ok(closed.after === closed.before - 1, 'вкладка закрывается крестиком', `${closed.before} → ${closed.after}`);

  /* ─────────── 2. архив ─────────── */
  console.log('\n=== архивы ===');
  await page.evaluate(() => fmOpenFile('plugins/pack.zip'));
  await page.waitForTimeout(500);
  const arch = await page.evaluate(() => ({
    view: FM.view,
    visible: !document.getElementById('fmArchive').classList.contains('hidden'),
    codeHidden: document.querySelector('.fm-codewrap').classList.contains('hidden'),
    rows: [...document.querySelectorAll('#fmArchive .far-row .fa-nm')].map((e) => e.textContent),
    extractBtn: !document.getElementById('fmExtractAll').classList.contains('hidden'),
  }));
  ok(arch.view === 'archive' && arch.visible, 'архив открылся списком файлов');
  ok(arch.codeHidden, 'редактор кода убран — вместо него список архива');
  ok(arch.rows.join(',') === 'plugin.yml,config/inner.yml', 'файлы внутри архива показаны', arch.rows.join(', '));
  ok(arch.extractBtn, 'есть кнопка «Распаковать сюда»');

  const preview = await page.evaluate(async () => {
    document.querySelectorAll('#fmArchive .far-row')[0].click();
    await new Promise((r) => setTimeout(r, 500));
    const box = document.getElementById('fmArchivePreview');
    return { hidden: box.classList.contains('hidden'), text: (box.querySelector('pre') || {}).textContent || '' };
  });
  ok(!preview.hidden && /name: Pack/.test(preview.text), 'файл из архива видно без распаковки', preview.text.trim().slice(0, 30));

  await page.evaluate(() => document.getElementById('fmExtractAll').click());
  await page.waitForTimeout(900);
  ok(fs.existsSync(path.join(SRV, 'plugins/plugin.yml')), 'архив распакован рядом с собой');
  ok(fs.existsSync(path.join(SRV, 'plugins/config/inner.yml')), 'вложенные папки созданы при распаковке');

  const rar = await page.evaluate(() => {
    const tab = FM.tabs.find((t) => t.path === 'plugins/fake.rar');
    return tab ? tab.archive && tab.archive.error : 'нет вкладки';
  });
  await page.evaluate(() => fmOpenFile('plugins/fake.rar'));
  await page.waitForTimeout(400);
  const rarMsg = await page.evaluate(() => {
    const host = document.getElementById('fmArchive');
    return host.textContent.trim();
  });
  ok(/RAR/.test(rarMsg) && /архиватор/.test(rarMsg), 'rar честно не поддерживается — есть предупреждение', rarMsg.slice(0, 60));
  void rar;

  /* ─────────── 3. картинки ─────────── */
  console.log('\n=== картинки ===');
  await page.evaluate(() => fmOpenFile('images/logo.png'));
  await page.waitForTimeout(500);
  const img = await page.evaluate(() => {
    const box = document.getElementById('fmImageBox');
    const el = document.getElementById('fmImage');
    return {
      view: FM.view,
      visible: !box.classList.contains('hidden'),
      src: (el.src || '').slice(0, 22),
      w: el.naturalWidth,
      kind: document.getElementById('fmKind').textContent,
    };
  });
  ok(img.view === 'image' && img.visible, 'картинка открылась просмотрщиком');
  ok(img.src.startsWith('data:image/png'), 'картинка отдана как data URL', img.src);
  ok(img.w > 0, 'картинка реально загрузилась', img.w + 'px');
  ok(img.kind === 'картинка', 'в статусе подписано, что это картинка', img.kind);

  /* ─────────── 4. перетаскивание между папками ─────────── */
  console.log('\n=== перетаскивание файлов ===');
  const dnd = await page.evaluate(async () => {
    FM.expanded = new Set(['plugins', 'plugins/MyPlugin']);
    await fmLoadTree();
    await new Promise((r) => setTimeout(r, 400));
    const file = [...document.querySelectorAll('#fmTree .fm-row')]
      .find((r) => r.dataset.path === 'plugins/MyPlugin/Target.yml');
    const folder = [...document.querySelectorAll('#fmTree .fm-row')]
      .find((r) => r.dataset.path === 'plugins');
    if (!file || !folder) return { error: 'не нашёл строки дерева: ' + [...document.querySelectorAll('#fmTree .fm-row')].map((r) => r.dataset.path).join(',') };
    const dt = new DataTransfer();
    file.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    folder.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    const highlighted = folder.classList.contains('drop-on');
    folder.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    await new Promise((r) => setTimeout(r, 900));
    return { highlighted, dragPath: FM.dragPath };
  });
  ok(!dnd.error, 'строки дерева нашлись', dnd.error || 'есть');
  ok(dnd.highlighted, 'папка подсвечивается при наведении');
  ok(fs.existsSync(path.join(SRV, 'plugins/Target.yml')), 'файл переехал в другую папку');
  ok(!fs.existsSync(path.join(SRV, 'plugins/MyPlugin/Target.yml')), 'из старой папки файл убран');

  /* защита: папку внутрь себя переносить нельзя */
  const selfMove = await page.evaluate(async () => {
    FM.dragPath = 'plugins';
    await fmMoveInto('plugins/MyPlugin');
    return true;
  });
  ok(selfMove && fs.existsSync(path.join(SRV, 'plugins/Target.yml')), 'папка не может уехать внутрь себя');

  /* ─────────── 5. создание файла: только имя ─────────── */
  console.log('\n=== создание файла по одному имени ===');
  const dialog = await page.evaluate(async () => {
    FM.lastDir = 'plugins/MyPlugin';
    fmNewFile('');
    await new Promise((r) => setTimeout(r, 250));
    const input = document.getElementById('txInput');
    return {
      shown: !document.getElementById('textModal').classList.contains('hidden'),
      value: input.value,
      text: document.getElementById('txText').textContent,
    };
  });
  ok(dialog.shown, 'окно создания файла открылось');
  ok(!/[\\/]/.test(dialog.value), 'в поле только имя, без пути', dialog.value);
  ok(/MyPlugin/.test(dialog.text), 'подписано, в какую папку попадёт файл', dialog.text);

  await page.fill('#txInput', 'NewFile.yml');
  await page.click('#txOk');
  await page.waitForTimeout(800);
  ok(fs.existsSync(path.join(SRV, 'plugins/MyPlugin/NewFile.yml')), 'файл создан в выбранной папке');

  const withSlash = await page.evaluate(async () => {
    fmNewFile('');
    await new Promise((r) => setTimeout(r, 200));
    document.getElementById('txInput').value = 'plugins/MyPlugin/bad.yml';
    document.getElementById('txOk').click();
    await new Promise((r) => setTimeout(r, 400));
    return document.getElementById('toasts').innerText.replace(/\s+/g, ' ');
  });
  ok(/только имя файла/i.test(withSlash), 'путь вместо имени отклоняется с подсказкой', withSlash.slice(-90));

  /* ─────────── 6. бэкап: список обновился ─────────── */
  console.log('\n=== бэкап и обновление списка ===');
  await page.evaluate(() => setTab('backups'));
  await page.waitForTimeout(500);
  const before = await page.evaluate(() => S.backups.length);
  await page.click('#backupCreate');
  await page.waitForTimeout(3500);
  const after = await page.evaluate(() => ({
    count: S.backups.length,
    names: S.backups.map((b) => b.name),
    items: document.querySelectorAll('#backupList .backup-item').length,
    sub: document.getElementById('backupSub').textContent,
  }));
  ok(after.count === before + 1, 'новый бэкап появился в списке без перезагрузки', `${before} → ${after.count}`);
  ok(after.items === after.count, 'список отрисован', 'строк: ' + after.items);
  const packFile = fs.existsSync(path.join(DATA, 'backups/s1'))
    ? fs.readdirSync(path.join(DATA, 'backups/s1')).find((f) => /\.(7z|zip)$/.test(f))
    : '';
  ok(!!packFile, 'архив лежит на диске', packFile || 'нет файла');
  ok(/\.7z$/.test(packFile || ''), 'бэкап собран в 7z (максимум сжатия)', packFile || 'нет файла');

  /* сжатие: zip с уровнем 9 должен быть заметно меньше исходника */
  const sizes = await page.evaluate(() => {
    const b = S.backups[0];
    return { size: b.size };
  });
  const raw = await page.evaluate(() => API.backupSize('s1').then((r) => r.bytes || 0));
  ok(sizes.size > 0 && (raw === 0 || sizes.size < raw), 'архив сжат', `${sizes.size} Б из ${raw} Б`);

  /* ─────────── 7. ошибки ─────────── */
  console.log('\n=== ОШИБКИ ===');
  ok(errs.length === 0, 'нет JS-ошибок', errs.slice(0, 3).join(' | '));

  await app.close();
  console.log(fails ? `\nПРОВАЛОВ: ${fails}` : '\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
