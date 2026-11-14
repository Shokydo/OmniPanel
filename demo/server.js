/**
 * Демо-сервер для проверки панели.
 * Настройки: команда `node server.js`, рабочая папка — эта папка.
 * Понимает команды: stop (выход), say <текст> (эхо), crash (падение для проверки автоперезапуска).
 */
let ticks = 0;
const start = new Date();

console.log('Демо-сервер запущен. Команды: say <текст>, crash, stop');
console.log('Рабочая папка:', process.cwd());

const timer = setInterval(() => {
  ticks += 1;
  const up = Math.round((Date.now() - start.getTime()) / 1000);
  console.log(`[tick ${ticks}] работает ${up} c, память ${Math.round(process.memoryUsage().rss / 1048576)} МБ`);
}, 2000);

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  for (const raw of chunk.split('\n')) {
    const cmd = raw.trim();
    if (!cmd) continue;
    if (cmd === 'stop') { console.log('Получена команда stop — корректно завершаюсь.'); clearInterval(timer); process.exit(0); }
    else if (cmd === 'crash') { console.log('Имитирую падение…'); process.exit(1); }
    else if (cmd.startsWith('say ')) console.log('Эхо:', cmd.slice(4));
    else console.log('Неизвестная команда:', cmd);
  }
});
