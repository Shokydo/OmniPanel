/*
 * Полный список настроек server.properties для панели OmniPanel.
 *
 * Один файл для всего: его читает панель (окно), сервер настроек в Node
 * (core/files.js) и браузерный режим — просто подключается как <script>.
 *
 * Поля записи:
 *   key     — как в server.properties
 *   label   — русское название
 *   group   — раздел окна настроек
 *   type    — 'bool' | 'num' | 'text' | 'enum'
 *   min/max/step — для чисел
 *   options — варианты для 'enum': [{ v, label }]
 *   def     — значение, которое подставляет сам сервер, если ключа нет
 */
(function (root, factory) {
  const schema = factory();
  if (typeof module === 'object' && module.exports) module.exports = schema;
  if (root) root.PROP_SCHEMA = schema;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const groups = [
    { id: 'main', label: 'Основное' },
    { id: 'world', label: 'Мир' },
    { id: 'players', label: 'Игроки и правила' },
    { id: 'net', label: 'Сеть и доступ' },
    { id: 'pack', label: 'Ресурспаки' },
    { id: 'perf', label: 'Производительность' },
    { id: 'debug', label: 'Логи и отладка' },
  ];

  const bool = (v) => (v ? 'true' : 'false');
  const list = (...pairs) => pairs.map(([v, label]) => ({ v, label }));

  const props = [
    /* ── основное ── */
    { key: 'motd', label: 'Сообщение в списке серверов (MOTD)', group: 'main', type: 'text', def: 'A Minecraft Server' },
    { key: 'server-port', label: 'Порт', group: 'main', type: 'num', min: 1, max: 65535, def: '25565' },
    { key: 'server-ip', label: 'Свой IP (пусто — все сетевые карты)', group: 'main', type: 'text', def: '' },
    { key: 'max-players', label: 'Лимит игроков', group: 'main', type: 'num', min: 1, max: 10000, def: '20' },
    {
      key: 'gamemode', label: 'Режим игры по умолчанию', group: 'main', type: 'enum', def: 'survival',
      options: list(['survival', 'выживание'], ['creative', 'творческий'], ['adventure', 'приключение'], ['spectator', 'наблюдатель']),
    },
    { key: 'force-gamemode', label: 'Возвращать игрока в этот режим при входе', group: 'main', type: 'bool', def: bool(false) },
    {
      key: 'difficulty', label: 'Сложность', group: 'main', type: 'enum', def: 'easy',
      options: list(['peaceful', 'мирная'], ['easy', 'лёгкая'], ['normal', 'обычная'], ['hard', 'сложная']),
    },
    { key: 'hardcore', label: 'Хардкор (одна жизнь)', group: 'main', type: 'bool', def: bool(false) },
    { key: 'online-mode', label: 'Проверка лицензии Minecraft', group: 'main', type: 'bool', def: bool(true) },
    { key: 'enable-status', label: 'Отвечать на запросы списка серверов', group: 'main', type: 'bool', def: bool(true) },
    { key: 'hide-online-players', label: 'Скрывать список игроков в статусе', group: 'main', type: 'bool', def: bool(false) },
    { key: 'enable-jmx-monitoring', label: 'JMX-мониторинг', group: 'main', type: 'bool', def: bool(false) },
    { key: 'allow-flight', label: 'Разрешить полёт (античит иначе выкинет)', group: 'main', type: 'bool', def: bool(false) },
    { key: 'allow-nether', label: 'Разрешить Нижний мир', group: 'main', type: 'bool', def: bool(true) },
    { key: 'allow-end', label: 'Разрешить Край', group: 'main', type: 'bool', def: bool(true) },
    {
      key: 'pause-when-empty-seconds', label: 'Пауза сервера без игроков, секунд (0 — не ставить)', group: 'main', type: 'num', min: 0, max: 86400, def: '0',
    },

    /* ── мир ── */
    { key: 'level-name', label: 'Папка мира', group: 'world', type: 'text', def: 'world' },
    { key: 'level-seed', label: 'Сид мира', group: 'world', type: 'text', def: '' },
    {
      key: 'level-type', label: 'Тип генерации', group: 'world', type: 'enum', def: 'minecraft:normal',
      options: list(
        ['minecraft:normal', 'обычный'], ['minecraft:flat', 'плоский'], ['minecraft:large_biomes', 'крупные биомы'],
        ['minecraft:amplified', 'усиленный'], ['minecraft:single_biome_surface', 'один биом'],
      ),
    },
    { key: 'generator-settings', label: 'Настройки генератора (JSON)', group: 'world', type: 'text', def: '{}' },
    { key: 'generate-structures', label: 'Генерировать строения', group: 'world', type: 'bool', def: bool(true) },
    { key: 'spawn-monsters', label: 'Спавнить мобов', group: 'world', type: 'bool', def: bool(true) },
    { key: 'spawn-animals', label: 'Спавнить животных', group: 'world', type: 'bool', def: bool(true) },
    { key: 'spawn-npcs', label: 'Спавнить жителей', group: 'world', type: 'bool', def: bool(true) },
    { key: 'spawn-protection', label: 'Радиус защиты спавна, блоков', group: 'world', type: 'num', min: 0, max: 1000, def: '16' },
    { key: 'max-world-size', label: 'Максимальный радиус мира, блоков', group: 'world', type: 'num', min: 1, max: 29999984, def: '29999984' },
    { key: 'initial-enabled-packs', label: 'Включённые наборы данных при создании мира', group: 'world', type: 'text', def: 'vanilla' },
    { key: 'initial-disabled-packs', label: 'Отключённые наборы данных', group: 'world', type: 'text', def: '' },
    { key: 'only-generate-structures', label: 'Только строения (пустой мир)', group: 'world', type: 'bool', def: bool(false) },

    /* ── игроки и правила ── */
    { key: 'pvp', label: 'PvP между игроками', group: 'players', type: 'bool', def: bool(true) },
    { key: 'white-list', label: 'Белый список (white-list.json)', group: 'players', type: 'bool', def: bool(false) },
    { key: 'enforce-whitelist', label: 'Выкидывать тех, кого нет в белом списке', group: 'players', type: 'bool', def: bool(false) },
    { key: 'enforce-secure-profile', label: 'Требовать подписанные профили (лицензия)', group: 'players', type: 'bool', def: bool(true) },
    { key: 'player-idle-timeout', label: 'Выкинуть бездействующего через N минут (0 — не выкидывать)', group: 'players', type: 'num', min: 0, max: 10000, def: '0' },
    { key: 'op-permission-level', label: 'Права оператора (1–4)', group: 'players', type: 'num', min: 0, max: 4, def: '4' },
    { key: 'function-permission-level', label: 'Права функций команд (1–4)', group: 'players', type: 'num', min: 1, max: 4, def: '2' },
    { key: 'enable-command-block', label: 'Блоки команд', group: 'players', type: 'bool', def: bool(false) },
    { key: 'allow-cheats', label: 'Разрешить читы', group: 'players', type: 'bool', def: bool(false) },
    { key: 'broadcast-console-to-ops', label: 'Показывать операторам команды из консоли', group: 'players', type: 'bool', def: bool(true) },
    { key: 'broadcast-rcon-to-ops', label: 'Показывать операторам команды из RCON', group: 'players', type: 'bool', def: bool(true) },
    { key: 'log-ips', label: 'Писать IP игроков в логи', group: 'players', type: 'bool', def: bool(true) },

    /* ── сеть и доступ ── */
    { key: 'network-compression-threshold', label: 'Порог сжатия пакетов, байт (-1 — выключить)', group: 'net', type: 'num', min: -1, max: 65536, def: '256' },
    { key: 'prevent-proxy-connections', label: 'Блокировать подключения через прокси/VPN', group: 'net', type: 'bool', def: bool(false) },
    { key: 'use-native-transport', label: 'Быстрый сетевой транспорт Linux', group: 'net', type: 'bool', def: bool(true) },
    { key: 'enable-rcon', label: 'RCON (удалённая консоль)', group: 'net', type: 'bool', def: bool(false) },
    { key: 'rcon.port', label: 'Порт RCON', group: 'net', type: 'num', min: 1, max: 65535, def: '25575' },
    { key: 'rcon.password', label: 'Пароль RCON', group: 'net', type: 'text', def: '' },
    { key: 'enable-query', label: 'Query-запросы (статистика сервера)', group: 'net', type: 'bool', def: bool(false) },
    { key: 'query.port', label: 'Порт Query', group: 'net', type: 'num', min: 1, max: 65535, def: '25565' },
    { key: 'accept-transfers', label: 'Принимать переводы игроков с другого сервера', group: 'net', type: 'bool', def: bool(false) },
    { key: 'text-filtering-config', label: 'Конфиг фильтрации чата', group: 'net', type: 'text', def: '' },

    /* ── ресурспаки ── */
    { key: 'require-resource-pack', label: 'Обязательный ресурспак', group: 'pack', type: 'bool', def: bool(false) },
    { key: 'resource-pack', label: 'Ссылка на ресурспак', group: 'pack', type: 'text', def: '' },
    { key: 'resource-pack-prompt', label: 'Сообщение при установке пака', group: 'pack', type: 'text', def: '' },
    { key: 'resource-pack-sha1', label: 'SHA1 ресурспака', group: 'pack', type: 'text', def: '' },
    { key: 'resource-pack-id', label: 'ID ресурспака (UUID)', group: 'pack', type: 'text', def: '' },

    /* ── производительность ── */
    { key: 'view-distance', label: 'Дальность прорисовки, чанков', group: 'perf', type: 'num', min: 2, max: 32, def: '10' },
    { key: 'simulation-distance', label: 'Дальность симуляции, чанков', group: 'perf', type: 'num', min: 3, max: 32, def: '10' },
    { key: 'entity-broadcast-range-percentage', label: 'Дальность видимости сущностей, %', group: 'perf', type: 'num', min: 10, max: 1000, def: '100' },
    { key: 'max-tick-time', label: 'Предел одного тика, мс (-1 — не следить)', group: 'perf', type: 'num', min: -1, max: 600000, def: '60000' },
    { key: 'sync-chunk-writes', label: 'Синхронная запись чанков', group: 'perf', type: 'bool', def: bool(true) },
    { key: 'max-chained-neighbor-updates', label: 'Предел цепочки обновлений блоков', group: 'perf', type: 'num', min: 0, max: 10000000, def: '1000000' },

    /* ── логи и отладка ── */
    { key: 'debug', label: 'Отладочный режим', group: 'debug', type: 'bool', def: bool(false) },
    { key: 'rate-limit', label: 'Лимит пакетов в секунду на игрока (0 — без лимита)', group: 'debug', type: 'num', min: 0, max: 1000000, def: '0' },
  ];

  const byKey = {};
  for (const p of props) byKey[p.key] = p;

  return { groups, props, byKey };
});
