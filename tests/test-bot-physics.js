// Физика ботов: гравитация, прыжок, шаг не быстрее игрока, расхождение в стороны.
// Запуск: node tests/test-bot-physics.js
'use strict';
const { Bot } = require('../core/bot');

let fails = 0;
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  OK   ' : '  FAIL ') + label + (extra ? ' — ' + extra : ''));
  if (!cond) fails += 1;
};

/* часы с ручным ходом: тик = 50 мс, иначе бот не станет слать пакеты «слишком часто» */
const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;

function makeBot(opts = {}) {
  const bot = new Bot({
    host: '127.0.0.1', port: 25565, name: opts.name || 'Tst01', version: '1.20.4',
    actions: { walk: true, hop: true, walkMs: 50, ...(opts.actions || {}) },
    index: opts.index || 0, total: opts.total || 1,
    spread: opts.spread !== false, hop: opts.hop !== false,
  });
  bot.state = 'play';
  bot.spawned = true;
  bot.spawnPos = { x: 0.5, y: 64, z: 0.5 };
  bot.pos = { x: 0.5, y: 64, z: 0.5, yaw: 0, pitch: 0, onGround: true };
  bot.groundY = 64;
  bot.pendingSync = false;
  bot.playerLoaded = true;   // «мир загружен» — как после player_loaded на живом сервере
  bot.sent = [];
  bot.sendPacket = (stage, dir, name, values) => { bot.sent.push({ name, ...values }); return true; };
  bot.onEvent = () => {};
  bot.every = () => {};                  // таймеры в тесте не нужны
  bot.startActions();                    // считает сектор и шаг, но без интервалов
  bot.sent = [];
  clock = realNow();
  return bot;
}

function run(bot, ticks) {
  for (let i = 0; i < ticks; i += 1) {
    clock += 50;
    bot.physicsTick();
  }
}

console.log('=== ГРАВИТАЦИЯ И ПРЫЖОК ===');
{
  const bot = makeBot({ hop: false });
  run(bot, 40);
  ok(bot.pos.y === 64 && bot.pos.onGround, 'на земле бот стоит ровно на высоте сервера', `y=${bot.pos.y}`);

  /* прыжок: считаем дугу по тикам */
  const heights = [];
  bot.wantJump = true;
  for (let i = 0; i < 30; i += 1) {
    clock += 50;
    bot.physicsTick();
    heights.push({ y: bot.pos.y, onGround: bot.pos.onGround });
  }
  const peak = Math.max(...heights.map((h) => h.y));
  ok(peak > 65 && peak < 65.6, 'прыжок поднимает как у игрока — около 1.25 блока', `пик y=${peak.toFixed(2)}`);
  const inAir = heights.filter((h) => !h.onGround).length;
  ok(inAir >= 8 && inAir <= 14, 'в воздухе бот проводит как игрок (≈10 тиков)', 'тиков в воздухе: ' + inAir);
  ok(heights[heights.length - 1].onGround && heights[heights.length - 1].y === 64,
    'после прыжка бот приземляется на ту же землю');
  ok(Math.min(...heights.map((h) => h.y)) >= 64, 'бот не проваливается под землю');

  /* в пакетах честный признак «на земле» */
  const airPackets = bot.sent.filter((p) => p.onGround === false).length;
  ok(airPackets > 0, 'во время прыжка сервер получает onGround=false', 'пакетов в воздухе: ' + airPackets);
  const groundOnly = bot.sent.filter((p) => p.onGround === true).length;
  ok(groundOnly > 0, 'на земле сервер получает onGround=true');
}

console.log('\n=== ШАГ НЕ БЫСТРЕЕ ИГРОКА ===');
{
  const bot = makeBot();
  run(bot, 200);
  let maxStep = 0;
  let prev = { x: 0.5, z: 0.5 };
  for (const p of bot.sent) {
    maxStep = Math.max(maxStep, Math.hypot(p.x - prev.x, p.z - prev.z));
    prev = { x: p.x, z: p.z };
  }
  ok(maxStep <= 0.32, 'за один пакет бот не сдвигается быстрее игрока', `максимум ${maxStep.toFixed(3)} блока`);
  const total = Math.hypot(bot.pos.x - 0.5, bot.pos.z - 0.5);
  ok(total > 2 && total < 200, 'за 10 секунд бот проходит разумное расстояние', `${total.toFixed(1)} блока`);
  ok(bot.sent.every((p) => Math.abs(p.y - 64) <= 1.3), 'высота в пакетах не улетает в небо');
}

console.log('\n=== СТОЯЩИЙ БОТ НЕ ЗАБИВАЕТ КАНАЛ ===');
{
  const bot = makeBot({ actions: { walk: false, hop: false } });
  run(bot, 100);          // 5 секунд
  ok(bot.sent.length <= 6, 'стоящий бот шлёт позицию редко', 'пакетов за 5 с: ' + bot.sent.length);
  ok(bot.pos.x === 0.5 && bot.pos.z === 0.5, 'стоящий бот не уезжает сам по себе');
  ok(bot.pos.onGround, 'стоящий бот на земле');
}

console.log('\n=== РАСХОДЯТСЯ В РАЗНЫЕ СТОРОНЫ ===');
{
  const bots = [];
  for (let i = 0; i < 8; i += 1) bots.push(makeBot({ index: i, total: 8, name: 'Tst0' + (i + 1) }));
  runAll(bots, 60);
  const dirs = bots.map((b) => Math.atan2(b.pos.z - 0.5, b.pos.x - 0.5));
  const angles = dirs.map((d) => ((d % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)).sort((a, b) => a - b);
  let maxGap = 0;
  for (let i = 0; i < angles.length; i += 1) {
    const next = i === angles.length - 1 ? angles[0] + Math.PI * 2 : angles[i + 1];
    maxGap = Math.max(maxGap, next - angles[i]);
  }
  ok(maxGap < 1.4, 'восемь ботов разошлись по кругу, а не в одну кучу', 'макс. разрыв: ' + maxGap.toFixed(2) + ' рад');
  const dists = bots.map((b) => Math.hypot(b.pos.x - 0.5, b.pos.z - 0.5));
  ok(dists.every((d) => d > 1.5), 'все боты ушли от точки появления', 'минимум ' + Math.min(...dists).toFixed(1) + ' блока');
  const uniqueDirs = new Set(angles.map((a) => Math.round(a * 2))).size;
  ok(uniqueDirs >= 6, 'курсы ботов разные', 'разных направлений: ' + uniqueDirs);
}

console.log('\n=== ДАЛЬНИЕ ПОХОДЫ (ПРОГРУЗКА ЧАНКОВ) ===');
{
  const bot = makeBot({ actions: { jump: true, jumpMs: 3000 } });
  bot.pickWaypoint();
  const w = bot.waypoint;
  ok(w && Math.hypot(w.x - 0.5, w.z - 0.5) > 100, 'точка похода далеко — по пути прогружаются чанки',
    w ? Math.round(Math.hypot(w.x - 0.5, w.z - 0.5)) + ' блоков' : 'нет точки');
  const dists = [];
  for (let i = 0; i < 400; i += 1) {
    clock += 50;
    bot.physicsTick();
    dists.push(Math.hypot(bot.waypoint.x - bot.pos.x, bot.waypoint.z - bot.pos.z));
  }
  ok(dists[dists.length - 1] < dists[0], 'бот идёт к цели, а не кружит на месте',
    `${Math.round(dists[0])} → ${Math.round(dists[dists.length - 1])} блоков`);
  const walked = bot.stats.distance;
  ok(walked > 60, 'пройденный путь считается', Math.round(walked) + ' блоков');
  ok(bot.sent.every((p) => Math.hypot(p.x - 0.5, p.z - 0.5) < 1000), 'без телепортов через полкарты');
}

console.log('\n=== ПРАВКА ОТ СЕРВЕРА: ПРЫЖОК И НОВЫЙ КУРС ===');
{
  const bot = makeBot();
  run(bot, 20);
  const before = bot.heading;
  bot.pos.x = 12.5; bot.pos.z = -3.5; bot.pos.y = 70;
  bot.onCorrected();
  ok(bot.heading !== before, 'после правки бот меняет курс', `${before.toFixed(2)} → ${bot.heading.toFixed(2)}`);
  ok(bot.pauseUntil > Date.now(), 'после правки бот останавливается, а не бьётся в стену');
  ok(bot.wantJump === false, 'после правки бот не прыгает — иначе сервер кикает за полёт');
  ok(bot.collided && bot.pendingSync, 'серверу сообщается о столкновении');
}

function runAll(bots, ticks) {
  for (let i = 0; i < ticks; i += 1) {
    clock += 50;
    for (const b of bots) b.physicsTick();
  }
}

Date.now = realNow;
console.log(fails ? `\nПровалено: ${fails}` : '\nВсё прошло');
process.exit(fails ? 1 : 0);
