// Проверки 1.25.0 в живом Electron: скорость консоли и окна ошибок,
// приближение картинок, перенос файлов перетаскиванием.
// Запуск: xvfb-run -a node tests/test-fix-125.js [путь-к-playwright] [путь-к-electron]
'use strict';
const pwPath = process.argv[2] || '/home/user/.cache/bld/node_modules/playwright';
const electronPath = process.argv[3] || '/home/user/.cache/bld/node_modules/electron/dist/electron';
const { _electron: electron } = require(pwPath);
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA = path.join(path.dirname(electronPath), 'OmniPanelData');
const SRV = path.join(os.tmpdir(), 'omni125-srv');

/** Простой BMP 900×600 — чтобы проверить приближение без внешних библиотек. */
function writeBmp(file, w, h) {
  const rowSize = Math.ceil((w * 3) / 4) * 4;
  const size = 54 + rowSize * h;
  const buf = Buffer.alloc(size);
  buf.write('BM', 0);
  buf.writeUInt32LE(size, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(rowSize * h, 34);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const off = 54 + y * rowSize + x * 3;
      buf[off] = (x * 255 / w) | 0;
      buf[off + 1] = (y * 255 / h) | 0;
      buf[off + 2] = 128;
    }
  }
  fs.writeFileSync(file, buf);
}

fs.rmSync(SRV, { recursive: true, force: true });
fs.mkdirSync(path.join(SRV, 'plugins'), { recursive: true });
fs.mkdirSync(path.join(SRV, 'config'), { recursive: true });
fs.mkdirSync(path.join(SRV, 'world'), { recursive: true });
fs.writeFileSync(path.join(SRV, 'server.properties'), 'level-name=world\n');
fs.writeFileSync(path.join(SRV, 'a.txt'), 'файл A\n');
fs.writeFileSync(path.join(SRV, 'b.txt'), 'файл B\n');
fs.writeFileSync(path.join(SRV, 'config', 'deep.yml'), 'a: 1\n');
fs.writeFileSync(path.join(SRV, 'plugins', 'inside.txt'), 'внутри\n');
writeBmp(path.join(SRV, 'shot.bmp'), 900, 600);

fs.mkdirSync(DATA, { recursive: true });
fs.rmSync(path.join(DATA, 'panel.json'), { force: true });
fs.rmSync(path.join(DATA, 'Local Storage'), { recursive: true, force: true });
fs.writeFileSync(path.join(DATA, 'servers.json'), JSON.stringify([
  { id: 's1', name: 'Тестовый', command: 'sleep 900', cwd: SRV, stopCommand: '', encoding: 'auto', tpsCommand: '', tpsInterval: 30 },
  { id: 's2', name: 'Второй', command: 'sleep 900', cwd: SRV, stopCommand: '', encoding: 'auto', tpsCommand: '', tpsInterval: 30 },
]));

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  OK   ' : '  FAIL ') + label + (extra ? ' — ' + extra : ''));
  if (!cond) fails += 1;
};
const exists = (rel) => fs.existsSync(path.join(SRV, rel));

(async () => {
  const app = await electron.launch({
    executablePath: electronPath,
    args: ['/home/user/OmniPanel', '--no-sandbox'],
    env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1', OMNI_GITHUB_API: 'http://127.0.0.1:9', OMNI_UPDATE_RAW: 'http://127.0.0.1:9', OMNI_UPDATE_API: 'http://127.0.0.1:9' },
    timeout: 90000,
  });
  const page = await app.firstWindow();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.waitForSelector('.profile-name');
  await page.waitForTimeout(1200);

  /* ─────────────── 1. КОНСОЛЬ ─────────────── */
  console.log('\n=== КОНСОЛЬ: 2500 строк без фризов ===');
  const cons = await page.evaluate(() => new Promise((resolve) => {
    const list = [];
    for (let i = 0; i < 2500; i += 1) {
      list.push({ t: Date.now() - (2500 - i) * 1000, m: `[12:00:00] [Server thread/INFO]: строка лога ${i} — что-то происходит`, s: 'stdout' });
    }
    // долгие задачи браузера: чем они короче, тем отзывчивее интерфейс
    let longest = 0;
    let longTasks = 0;
    let observer = null;
    try {
      observer = new PerformanceObserver((l) => {
        for (const e of l.getEntries()) { longTasks += 1; longest = Math.max(longest, e.duration); }
      });
      observer.observe({ entryTypes: ['longtask'] });
    } catch { /* нет поддержки — не беда */ }

    LOG_CACHE.set(S.currentId, list);                 // как после загрузки логов
    const t1 = performance.now();
    consoleRenderHistory(list);                       // запуск отрисовки
    const sync = performance.now() - t1;
    // сразу приходит живая строка — она должна встать после истории
    S.consolePending.push({ t: Date.now(), m: '[12:00:01] [Server thread/INFO]: ЖИВАЯ СТРОКА', s: 'stdout' });
    let frames = 0;
    let worst = 0;
    let prev = performance.now();
    const tick = () => {
      const now = performance.now();
      worst = Math.max(worst, now - prev);
      prev = now;
      frames += 1;
      if (S.consoleBusy && frames < 400) { requestAnimationFrame(tick); return; }
      const nodes = document.querySelectorAll('#console .line');
      if (observer) { for (const e of observer.takeRecords()) { longTasks += 1; longest = Math.max(longest, e.duration); } }
      resolve({
        sync: Math.round(sync * 10) / 10,
        frames,
        worst: Math.round(worst),
        total: Math.round(performance.now() - t1),
        nodes: nodes.length,
        last: nodes.length ? nodes[nodes.length - 1].textContent.trim() : '',
        longest: Math.round(longest),
        longTasks,
      });
    };
    requestAnimationFrame(tick);
  }));
  ok(cons.sync < 60, 'запуск показа истории мгновенный', cons.sync + ' мс');
  ok(cons.longest < 300, 'интерфейс не замирает во время отрисовки', `самая долгая задача ${cons.longest} мс, кадров ${cons.frames}`);
  ok(cons.nodes === 1500, 'в окне держится 1500 строк, остальное в кеше', 'узлов: ' + cons.nodes);
  ok(cons.last.includes('ЖИВАЯ СТРОКА'), 'живая строка встала в конец, а не в середину', cons.last.slice(-60));
  await page.waitForTimeout(250);
  const scroll = await page.evaluate(() => {
    const c = document.getElementById('console');
    return Math.round(c.scrollHeight - c.scrollTop - c.clientHeight);
  });
  ok(scroll < 40, 'консоль осталась прокрученной в конец', 'до конца ' + scroll + 'px');

  // для сравнения — как было раньше: узел на строку и прокрутка на каждую строку
  const oldWay = await page.evaluate(() => new Promise((resolve) => {
    const host = document.getElementById('console');
    const lines = [];
    for (let i = 0; i < 300; i += 1) {
      lines.push({ t: Date.now() - i * 1000, m: `[12:00:00] [Server thread/INFO]: строка лога ${i} — что-то происходит`, s: 'stdout' });
    }
    host.innerHTML = '';
    let longest = 0;
    let observer = null;
    try {
      observer = new PerformanceObserver((l) => { for (const e of l.getEntries()) longest = Math.max(longest, e.duration); });
      observer.observe({ entryTypes: ['longtask'] });
    } catch { /* нет поддержки */ }
    const t0 = performance.now();
    for (const e of lines) {
      const div = document.createElement('div');
      div.className = 'line ' + lineLevel(e);
      div.innerHTML = `<span class="t">${fmtTime(e.t)}</span><span class="m">${esc(e.m)}</span>`;
      host.appendChild(div);
      host.scrollTop = host.scrollHeight;
    }
    const blocked = Math.round(performance.now() - t0);
    const finish = () => {
      if (observer) { for (const e of observer.takeRecords()) longest = Math.max(longest, e.duration); }
      resolve({ blocked, longest: Math.round(longest) });
    };
    requestAnimationFrame(() => requestAnimationFrame(finish));
  }));
  ok(oldWay.longest > cons.longest * 3, 'прежний способ заметно тяжелее нового',
    `было: одна задача ${oldWay.longest} мс (блокировка ${oldWay.blocked} мс) → стало: ${cons.longest} мс`);

  ok(cons.total < 4000, 'вся история дорисована за разумное время', cons.total + ' мс');

  // фильтр по консоли: срабатывает с короткой задержкой, но не подвешивает окно
  const filt = await page.evaluate(() => new Promise((resolve) => {
    const input = document.getElementById('logFilter');
    input.value = 'строка лога 100 ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    setTimeout(() => {
      const n = document.querySelectorAll('#console .line').length;
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      setTimeout(() => resolve({ n, back: document.querySelectorAll('#console .line').length }), 600);
    }, 700);
  }));
  ok(filt.n > 0 && filt.n < 100, 'фильтр оставляет только совпавшие строки', 'строк: ' + filt.n);
  ok(filt.back > filt.n, 'после очистки фильтра строки возвращаются', 'строк: ' + filt.back);

  // переключение сервера: вызов не должен блокировать окно
  const sw = await page.evaluate(() => new Promise((resolve) => {
    const big = [];
    for (let i = 0; i < 2000; i += 1) big.push({ t: Date.now() - i * 1000, m: `[12:00:00] [Server thread/INFO]: лог ${i}`, s: 'stdout' });
    LOG_CACHE.set('s1', big);
    LOG_CACHE.set('s2', big);
    const t0 = performance.now();
    selectServer('s2');
    const ret = performance.now() - t0;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      resolve({ ret: Math.round(ret * 10) / 10, total: Math.round(performance.now() - t0) });
    }));
  }));
  ok(sw.ret < 40, 'переключение сервера не блокирует окно', sw.ret + ' мс');
  ok(sw.total < 400, 'окно отрисовалось сразу после переключения', sw.total + ' мс');

  // быстрый вывод 800 живых строк подряд — пачками, без задержек
  const live = await page.evaluate(() => {
    const t0 = performance.now();
    for (let i = 0; i < 800; i += 1) appendLine({ t: Date.now(), m: '[12:00:02] [Server thread/INFO]: живая ' + i, s: 'stdout' });
    return Math.round(performance.now() - t0);
  });
  ok(live < 900, '800 живых строк выводятся быстро', live + ' мс');

  /* ─────────────── 2. ОКНО ОШИБОК ─────────────── */
  console.log('\n=== ОШИБКИ: открытие и обновление ===');
  const iss = await page.evaluate(() => new Promise((resolve) => {
    const id = S.currentId;
    S.issues.set(id, []);
    S.issuesNew.set(id, 0);
    issuesRenderNow(true);
    const t0 = performance.now();
    for (let i = 0; i < 200; i += 1) issuesAdd(id, 'error', `java.lang.RuntimeException: беда номер ${i}`);
    const sync = Math.round((performance.now() - t0) * 10) / 10;
    let frames = 0;
    const tick = () => {
      frames += 1;
      const cards = document.querySelectorAll('#issuesList .issue-card');
      if (cards.length < 200 && frames < 200) { requestAnimationFrame(tick); return; }
      resolve({ sync, frames, cards: cards.length, sub: (document.getElementById('issuesSub') || {}).textContent });
    };
    requestAnimationFrame(tick);
  }));
  ok(iss.sync < 90, '200 новых ошибок принимаются мгновенно', iss.sync + ' мс');
  ok(iss.cards === 200, 'все карточки на месте', 'карточек: ' + iss.cards);
  ok(iss.frames >= 8, 'карточки рисуются порциями, а не одним залпом', 'кадров: ' + iss.frames);
  ok(/найдено 200/.test(iss.sub || ''), 'подпись со счётчиком верная', iss.sub);

  const patch = await page.evaluate(() => new Promise((resolve) => {
    const id = S.currentId;
    const cards = [...document.querySelectorAll('#issuesList .issue-card')];
    cards.forEach((c, i) => { c.dataset.mark = 'm' + i; });
    const first = cards[0];
    const key = first.dataset.key;
    const line = (S.issues.get(id) || []).find((x) => x.key === key).line;
    issuesAdd(id, 'error', line);                 // повтор уже известной ошибки
    const t0 = performance.now();
    let frames = 0;
    const tick = () => {
      frames += 1;
      const now = document.querySelectorAll('#issuesList .issue-card');
      const same = now[0] === first;
      const count = first.querySelector('.issue-count').textContent;
      const marked = now.length && [...now].every((c) => c.dataset.mark);
      if (!same && frames < 60) { requestAnimationFrame(tick); return; }
      resolve({ same, count, marked, rebuilt: !marked, ms: Math.round((performance.now() - t0) * 10) / 10 });
    };
    requestAnimationFrame(tick);
  }));
  ok(patch.same, 'при повторе ошибки карточка не пересоздаётся');
  ok(patch.count === '×2', 'счётчик повторов обновился на месте', patch.count);
  ok(!patch.rebuilt, 'список не перерисовывается целиком');

  const tabOpen = await page.evaluate(() => new Promise((resolve) => {
    const t0 = performance.now();
    setTab('issues');
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(Math.round(performance.now() - t0))));
  }));
  ok(tabOpen < 400, 'вкладка ошибок открывается без фризов', tabOpen + ' мс');

  /* ─────────────── 3. ПРИБЛИЖЕНИЕ КАРТИНОК ─────────────── */
  console.log('\n=== ПРИБЛИЖЕНИЕ КАРТИНОК ===');
  await page.click('.tab[data-tab="files"]');
  await page.waitForSelector('#fmTree .fm-row[data-path="shot.bmp"]', { timeout: 15000 });
  await page.click('#fmTree .fm-row[data-path="shot.bmp"]');
  await page.waitForFunction(() => {
    const img = document.getElementById('fmImage');
    return img && img.naturalWidth > 0;
  }, { timeout: 15000 });
  await page.waitForTimeout(300);

  const fitState = await page.evaluate(() => {
    const img = document.getElementById('fmImage');
    const stage = document.getElementById('fmImageStage');
    return {
      visible: !document.getElementById('fmImageBox').classList.contains('hidden'),
      w: Math.round(img.getBoundingClientRect().width),
      stageW: Math.round(stage.clientWidth),
      stageH: Math.round(stage.clientHeight),
      label: document.getElementById('fmZoomVal').textContent,
      natural: img.naturalWidth,
    };
  });
  ok(fitState.visible, 'картинка открылась в просмотрщике');
  ok(fitState.w <= fitState.stageW && fitState.w > 40, 'сначала вписана по размеру окна', `${fitState.w}px в окне ${fitState.stageW}px · ${fitState.label}`);

  await page.click('#fmZoomIn');
  await page.waitForTimeout(120);
  const afterIn = await page.evaluate(() => ({
    w: Math.round(document.getElementById('fmImage').getBoundingClientRect().width),
    label: document.getElementById('fmZoomVal').textContent,
    pannable: document.getElementById('fmImageBox').classList.contains('pannable'),
  }));
  ok(afterIn.w > fitState.w, 'кнопка «+» приближает', `${fitState.w}px → ${afterIn.w}px · ${afterIn.label}`);

  await page.evaluate(() => {
    const box = document.getElementById('fmImageBox');
    const r = box.getBoundingClientRect();
    box.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(120);
  const afterWheel = await page.evaluate(() => Math.round(document.getElementById('fmImage').getBoundingClientRect().width));
  ok(afterWheel > afterIn.w, 'колесо мыши приближает', `${afterIn.w}px → ${afterWheel}px`);

  await page.click('#fmZoomOut');
  await page.waitForTimeout(120);
  const afterOut = await page.evaluate(() => Math.round(document.getElementById('fmImage').getBoundingClientRect().width));
  ok(afterOut < afterWheel, 'кнопка «−» отдаляет', `${afterWheel}px → ${afterOut}px`);

  await page.evaluate(() => {
    for (let i = 0; i < 6; i += 1) document.getElementById('fmZoomIn').click();
  });
  await page.waitForTimeout(150);
  const big = await page.evaluate(() => {
    const box = document.getElementById('fmImageBox');
    const stage = document.getElementById('fmImageStage');
    return { pannable: box.classList.contains('pannable'), scrollable: stage.scrollWidth > stage.clientWidth };
  });
  ok(big.pannable && big.scrollable, 'увеличенную картинку можно прокручивать рукой');

  await page.click('#fmZoomFit');
  await page.waitForTimeout(150);
  const back = await page.evaluate(() => {
    const img = document.getElementById('fmImage');
    const stage = document.getElementById('fmImageStage');
    return {
      w: Math.round(img.getBoundingClientRect().width),
      stageW: stage.clientWidth,
      label: document.getElementById('fmZoomVal').textContent,
      pannable: document.getElementById('fmImageBox').classList.contains('pannable'),
    };
  });
  ok(back.w <= back.stageW, 'кнопка «по размеру окна» возвращает вписанный вид', `${back.w}px · ${back.label}`);
  ok(!back.pannable, 'после возврата прокрутка не нужна');

  const actual = await page.evaluate(() => {
    const box = document.getElementById('fmImageBox');
    box.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));
    const img = document.getElementById('fmImage');
    return { w: Math.round(img.getBoundingClientRect().width), natural: img.naturalWidth, label: document.getElementById('fmZoomVal').textContent };
  });
  ok(Math.abs(actual.w - actual.natural) <= 2, 'клавиша «1» — настоящий размер 1:1', `${actual.w}px из ${actual.natural}px · ${actual.label}`);

  const dbl = await page.evaluate(() => {
    const img = document.getElementById('fmImage');
    img.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return Math.round(img.getBoundingClientRect().width);
  });
  ok(dbl !== actual.w, 'двойной щелчок переключает вид', `${actual.w}px → ${dbl}px`);

  /* ─────────────── 4. ПЕРЕНОС ПЕРЕТАСКИВАНИЕМ ─────────────── */
  console.log('\n=== ПЕРЕНОС ФАЙЛОВ ПЕРЕТАСКИВАНИЕМ ===');
  await page.evaluate(() => { FM.tabs = []; FM.activeIdx = -1; FM.expanded.clear(); fmRenderView(); fmRenderTabs(); });
  await page.evaluate(() => fmLoadTree());
  await page.waitForSelector('#fmTree .fm-row[data-path="a.txt"]', { timeout: 15000 });

  const dragTo = (fromSel, toSel) => page.evaluate(([f, t]) => {
    const src = document.querySelector(f);
    const dst = document.querySelector(t);
    if (!src) return 'нет источника';
    if (!dst) return 'нет цели';
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    const marked = !!(document.querySelector('#fmTree .fm-row.drop-on') || document.querySelector('#fmTree.drop-on'));
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return marked ? 'ok+подсветка' : 'ok';
  }, [fromSel, toSel]);

  // 4.1 файл → папка
  let r = await dragTo('#fmTree .fm-row[data-path="a.txt"]', '#fmTree .fm-row[data-path="plugins"]');
  await page.waitForTimeout(600);
  ok(r.startsWith('ok'), 'бросок файла на папку принят', r);
  ok(exists('plugins/a.txt') && !exists('a.txt'), 'файл действительно переехал в папку');

  // 4.2 файл → другой файл (значит, в его папку)
  await page.evaluate(() => fmLoadTree());
  await page.waitForSelector('#fmTree .fm-row[data-path="b.txt"]', { timeout: 10000 });
  r = await dragTo('#fmTree .fm-row[data-path="b.txt"]', '#fmTree .fm-row[data-path="plugins/inside.txt"]');
  await page.waitForTimeout(600);
  ok(exists('plugins/b.txt') && !exists('b.txt'), 'бросок на файл кладёт его в ту же папку', r);

  // 4.3 файл → пустое место дерева (корень)
  await page.evaluate(() => fmLoadTree());
  await page.waitForTimeout(300);
  r = await dragTo('#fmTree .fm-row[data-path="plugins/b.txt"]', '#fmTree');
  await page.waitForTimeout(600);
  ok(exists('b.txt') && !exists('plugins/b.txt'), 'бросок на пустое место возвращает в корень', r);

  // 4.4 папка → папка (с содержимым)
  await page.evaluate(() => fmLoadTree());
  await page.waitForTimeout(300);
  await dragTo('#fmTree .fm-row[data-path="config"]', '#fmTree .fm-row[data-path="world"]');
  await page.waitForTimeout(600);
  ok(exists('world/config/deep.yml') && !exists('config'), 'папка переехала вместе с содержимым');

  // 4.5 быстрое перетаскивание (без пауз между событиями) — раньше терялось
  await page.evaluate(() => fmLoadTree());
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const src = document.querySelector('#fmTree .fm-row[data-path="server.properties"]');
    const dst = document.querySelector('#fmTree .fm-row[data-path="plugins"]');
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await page.waitForTimeout(700);
  ok(exists('plugins/server.properties'), 'быстрое перетаскивание без dragover тоже работает');

  // 4.6 бросок в ту же папку — понятное уведомление, файла не теряем
  await page.evaluate(() => document.querySelectorAll('#toasts .notif').forEach((n) => n.remove()));
  await page.evaluate(() => fmLoadTree());
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const src = document.querySelector('#fmTree .fm-row[data-path="plugins/server.properties"]');
    if (!src) return;
    document.querySelector('#fmTree .fm-row[data-path="plugins"]').dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
  });
  await page.evaluate(() => {
    const src = document.querySelector('#fmTree .fm-row[data-path="plugins/server.properties"]');
    const dst = document.querySelector('#fmTree .fm-row[data-path="plugins"]');
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await page.waitForTimeout(500);
  const sameDir = await page.evaluate(() => {
    const t = [...document.querySelectorAll('#toasts .notif')].map((e) => e.innerText.replace(/\n/g, ' ')).join(' | ');
    return t + ' [drag=' + JSON.stringify(FM.dragPath) + ']';
  });
  ok(exists('plugins/server.properties'), 'бросок в свою же папку файл не ломает');
  ok(/уже в этой папке/.test(sameDir), 'бросок в свою же папку объясняется уведомлением', sameDir.slice(0, 80));

  // 4.7 открытая вкладка переезжает вместе с файлом
  await page.evaluate(() => fmLoadTree());
  await page.waitForTimeout(300);
  await page.click('#fmTree .fm-row[data-path="plugins/server.properties"]');
  await page.waitForTimeout(400);
  await page.evaluate(() => fmLoadTree());
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const src = document.querySelector('#fmTree .fm-row[data-path="plugins/server.properties"]');
    const dst = document.querySelector('#fmTree .fm-row[data-path="world"]');
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  await page.waitForTimeout(700);
  const tabMoved = await page.evaluate(() => (FM.tabs[0] || {}).path || '');
  ok(tabMoved === 'world/server.properties', 'открытая вкладка переехала вместе с файлом', tabMoved);

  console.log('\n=== ОШИБКИ СТРАНИЦЫ ===');
  ok(errs.length === 0, 'нет ошибок JavaScript', errs.slice(0, 3).join(' | '));

  await page.screenshot({ path: '/home/user/OmniPanel/docs/screens/screenshot-zoom.png' });
  await app.close();
  console.log(fails ? `\nПровалено: ${fails}` : '\nВсё прошло');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('Упало:', e);
  process.exit(1);
});
