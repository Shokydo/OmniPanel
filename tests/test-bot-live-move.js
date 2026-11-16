// Живая проверка движения ботов на настоящем сервере Paper:
// ходят, прыгают, расходятся в стороны и НЕ получают кик за полёт.
// Запуск: node tests/test-bot-live-move.js [порт] [версия] [лог сервера]
'use strict';
const fs = require('fs');
const net = require('net');
const { LoadTest } = require('../core/loadtest');

const PORT = Number(process.argv[2]) || 25599;
const VERSION = process.argv[3] || '1.20.4';
const LOG = process.argv[4] || '/tmp/mcsrv/srv.log';
const SECONDS = Number(process.env.OMNI_LIVE_SECONDS) || 60;

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  OK   ' : '  FAIL ') + label + (extra ? ' — ' + extra : ''));
  if (!cond) fails += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const portOpen = (port) => new Promise((resolve) => {
  const s = net.createConnection({ host: '127.0.0.1', port });
  s.setTimeout(1500);
  s.on('connect', () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false));
  s.on('timeout', () => { s.destroy(); resolve(false); });
});

/** Хвост лога сервера — по нему видно, ругался ли он на движение. */
function serverLogTail(from) {
  try {
    const text = fs.readFileSync(LOG, 'utf8');
    return text.slice(from);
  } catch { return ''; }
}

(async () => {
  if (!(await portOpen(PORT))) {
    console.log(`  ПРОПУСК: сервер на порту ${PORT} не поднят`);
    process.exit(0);
  }
  const logFrom = (() => { try { return fs.statSync(LOG).size; } catch { return 0; } })();

  const test = new LoadTest({ serverMetrics: () => ({ cpu: 20, rss: 300 * 1024 * 1024, tps: 20 }) });
  test.start({
    host: '127.0.0.1', port: PORT, version: VERSION,
    count: 8, rampMs: 2000, prefix: 'Mov',
    actions: {
      walk: true, hop: true, spread: true,
      jump: true, jumpMs: 4000,
      swing: true,
    },
  });

  const bots = () => test.bots.filter((s) => s && s.bot);
  const alive = () => bots().filter((s) => s.bot.state === 'play');

  console.log(`=== БОТЫ НА СЕРВЕРЕ ${VERSION} (порт ${PORT}), ${SECONDS} с ===`);
  await sleep(12000);
  ok(alive().length >= 8, 'все восемь ботов в игре', 'в игре: ' + alive().length);

  const startPos = bots().map((s) => ({ ...s.bot.pos }));
  const startY = startPos.map((p) => p.y);
  await sleep(SECONDS * 1000);

  const inGame = alive().length;
  ok(inGame >= 8, 'за всё время никого не выкинуло за полёт', 'в игре к концу: ' + inGame + ' из 8');

  const errs = bots().map((s) => s.bot.lastError).filter(Boolean);
  ok(!errs.length, 'ошибок у ботов нет', errs.join('; ') || 'нет');

  const log = serverLogTail(logFrom);
  const flyKick = /Flying is not enabled|kicked for floating|moved too quickly/i.test(log);
  ok(!flyKick, 'сервер не кикал за полёт и скорость',
    (log.match(/Flying is not enabled|kicked for floating|moved too quickly/gi) || []).slice(0, 3).join(' | ') || 'чисто');
  /* боты не видят мир, поэтому иногда упираются в блок: сервер пишет предупреждение
     и поправляет позицию — это нормально, лишь бы не кик */
  const wrong = (log.match(/moved wrongly/gi) || []).length;
  ok(wrong < 60, 'предупреждений «moved wrongly» немного', 'за тест: ' + wrong);
  const kick = /\[Mov\d+\] .*lost connection|disconnect/i.test(log);
  ok(!kick, 'в логе сервера нет отключений ботов', kick ? 'есть отключения' : 'нет');

  /* разошлись ли в стороны */
  const pos = bots().map((s) => ({ name: s.name, ...s.bot.pos }));
  const dists = pos.map((p) => Math.hypot(p.x, p.z));
  const moved = bots().map((s, i) => Math.hypot(s.bot.pos.x - startPos[i].x, s.bot.pos.z - startPos[i].z));
  ok(moved.filter((d) => d > 8).length >= 6, 'боты реально ушли от точки появления',
    'дали больше 8 блоков: ' + moved.filter((d) => d > 8).length + ' из 8, минимум ' + Math.round(Math.min(...moved)));
  const maxPairwise = Math.max(...pos.map((a) => Math.max(...pos.map((b) => Math.hypot(a.x - b.x, a.z - b.z)))));
  ok(maxPairwise > 30, 'боты разбрелись, а не стоят кучей', 'максимум между двумя: ' + Math.round(maxPairwise) + ' блоков');

  const dirs = pos.map((p) => Math.round((Math.atan2(p.z, p.x) * 180 / Math.PI + 360) % 360));
  const buckets = new Set(dirs.map((d) => Math.floor(d / 45)));
  ok(buckets.size >= 5, 'направления разные — расходятся по сторонам', 'секторов занято: ' + buckets.size + ' из 8');

  /* физика: высота как у игрока, прыжки были, полёта нет */
  const jumps = bots().reduce((a, s) => a + (s.bot.stats.jumps || 0), 0);
  ok(jumps > 5, 'боты прыгают', 'прыжков всего: ' + jumps);
  const airNow = bots().filter((s) => !s.bot.pos.onGround).length;
  ok(airNow <= 2, 'в воздухе одновременно почти никого', 'в воздухе: ' + airNow);
  const flight = bots().filter((s) => s.bot.pos.y - (s.bot.groundY || 0) > 2);
  ok(!flight.length, 'никто не висит в воздухе', flight.map((s) => `${s.name}:+${(s.bot.pos.y - s.bot.groundY).toFixed(1)}`).join(', ') || 'все на земле');
  const corr = bots().reduce((a, s) => a + (s.bot.stats.corrections || 0), 0);
  const moves = bots().reduce((a, s) => a + (s.bot.stats.moves || 0), 0);
  ok(corr < moves / 20, 'сервер почти не поправляет позиции', `правок ${corr} на ${moves} пакетов движения`);

  const walked = bots().reduce((a, s) => a + (s.bot.stats.distance || 0), 0);
  ok(walked > 100, 'боты прошли заметное расстояние', 'всего ' + Math.round(walked) + ' блоков');
  const chunks = test.status().totals.chunksLoaded;
  ok(chunks > 50, 'чанки прогружаются по пути', 'чанков: ' + chunks);

  void dists; void startY;
  test.stop('проверка движения');
  await sleep(1000);
  ok(test.status().totals.online === 0, 'после остановки в игре никого');

  console.log(fails ? `\nПровалено: ${fails}` : '\nВсё прошло');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('Упало:', e);
  process.exit(1);
});
