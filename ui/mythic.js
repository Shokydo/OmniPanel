'use strict';
/**
 * Шпаргалка по MythicMobs и MythicCrucible для встроенного редактора.
 * Содержимое — короткие шаблоны, которые вставляются в файл в позицию курсора.
 * Официальная вики: https://wiki.mythiccraft.io
 */
const MYTHIC_WIKI = [
  {
    id: 'mob',
    title: 'Моб',
    file: 'plugins/MythicMobs/Mobs/MyMob.yml',
    note: 'Файл в MythicMobs/Mobs. Имя в первой строке — это ID моба (по нему /mm m spawn <id>).',
    code: `MyBoss:
  Type: SKELETON            # сущность Minecraft
  Display: '&cМой босс'     # имя над головой (цвета через &)
  Health: 300
  Damage: 8
  Armor: 5
  Options:
    MovementSpeed: 0.3
    FollowRange: 40
    PreventOtherDrops: true
    Despawn: false
    AlwaysShowName: true
  Equipment:
    - IRON_HELMET HEAD
    - DIAMOND_SWORD HAND
  Skills:
    - skill{s=MySlash} @target ~onAttack
    - message{m=&7Ты не пройдёшь!} @PlayersInRadius{r=20} ~onSpawn
  Drops:
    - exp 50
    - MyItem 1 0.5         # предмет, количество, шанс (0..1)
`,
  },
  {
    id: 'item',
    title: 'Предмет',
    file: 'plugins/MythicMobs/Items/MyItem.yml',
    note: 'Файл в MythicMobs/Items. Id — ванильный материал, Model — CustomModelData из ресурспака.',
    code: `MySword:
  Id: DIAMOND_SWORD           # в старых конфигах — Material:
  Display: '&bМеч зари'
  Model: 1001                 # CustomModelData
  Lore:
    - '&7Сделан из света'
    - '&8Не ломается'
  Options:
    Unbreakable: true
    HideFlags: true
    AppendType: false
  Enchantments:
    - DAMAGE_ALL:5
    - FIRE_ASPECT:2
  Attributes:
    MainHand:
      AttackDamage: 12
      AttackSpeed: 1.6
`,
  },
  {
    id: 'skill',
    title: 'Навык',
    file: 'plugins/MythicMobs/Skills/MySkills.yml',
    note: 'Навык вызывается из моба через - skill{s=MySlash}. Триггеры начинаются с ~, цели — с @.',
    code: `MySlash:
  Skills:
    - damage{amount=8} @target
    - ignite{ticks=60} @target
    - effect:particles{p=flame;a=30;hS=1;vS=0.5} @self
    - sound{s=entity.blaze.hurt;v=1} @self
    - potion{p=SLOW;d=100;lvl=1} @target
    - message{m=&cТы ранен!} @target
    - skill{s=MySecond} @target ~onTimer:20

# Частые триггеры: ~onAttack ~onDamaged ~onDeath ~onSpawn ~onTimer:100 ~onInteract ~onKill
# Частые цели:    @self @target @trigger @PlayersInRadius{r=10} @MobsInRadius{r=5} @PIR{r=8}
# Механики:       damage message ignite potion summon teleport effect:particles effect:sound
#                 push pull velocity lightning heal sethealth giveitem dropitem command
`,
  },
  {
    id: 'drops',
    title: 'Дропы',
    file: 'plugins/MythicMobs/Mobs/Drops.yml',
    note: 'Drops пишутся внутри моба. Шанс — от 0 до 1, количество можно задать диапазоном.',
    code: `Drops:
  - exp 100                  # опыт
  - MySword 1 0.15           # предмет, количество, шанс 15%
  - GOLD_INGOT 1-4 0.5       # случайное количество из диапазона
  - money 500 0.3            # если подключена экономика Vault
  - MythicDrop               # без шанса = 100%

# Отдельный стол дропов:
MyDropTable:
  Drops:
    - DIAMOND 1 0.1
    - EMERALD 2 0.5
# и в мобе:  - skill{s=MyDropTable} ~onDeath
`,
  },
  {
    id: 'spawner',
    title: 'Спавнер',
    file: 'plugins/MythicMobs/RandomSpawns/MySpawns.yml',
    note: 'Спавн мобов в мире: файл RandomSpawns. Для точечных спавнеров удобнее /mm s create.',
    code: `MySpawner:
  MobName: MyBoss
  World: world
  SpawnRadius: 20
  Radius: 20
  MaxMobs: 3
  MobsPerSpawn: 1
  Cooldown: 300
  Warmup: 0

# Точечный спавнер (командой, без файла):
#   /mm s create MySpawner MyBoss
#   /mm s set MySpawner radius 10
#   /mm s set MySpawner mobsperminute 2
`,
  },
  {
    id: 'crucible',
    title: 'MythicCrucible',
    file: 'plugins/MythicMobs/Items/MyFurniture.yml',
    note: 'Аддон MythicCrucible: мебель, блоки, рассаживание игроков. Поле Type: FURNITURE обязательно.',
    code: `MyChair:
  Id: PAPER
  Model: 1                    # модель в руке
  Display: '&eСтул'
  Type: FURNITURE
  Furniture:
    Material: PAPER           # как выглядит поставленный
    Model: 1                  # CustomModelData поставленного
    Placement: FLOOR          # FLOOR / WALL / CEILING / HANGING
    Health: 3                 # клики до поломки
    Barriers:                 # хитбокс относительно рамки
      - 0,0,0
    Seats:                    # где можно сесть (x,y,z,поворот)
      - 0,0.9,0,180
    Lights:
      - 0,1,0 15              # свет: координаты и уровень
    Drops:
      - MyChair               # что выпадет при поломке
    DefaultState: NORMAL
    States:
      BROKEN:
        Model: 2
  FurnitureSkills:
    - sound{s=entity.chicken.egg} @self ~onBlockPlace
    - sound{s=block.lever.click} @self ~onInteract
    - sound{s=entity.zombie.attack_wooden_door} @self ~onBlockBreak
`,
  },
  {
    id: 'crucible-block',
    title: 'Блок (Crucible)',
    file: 'plugins/MythicMobs/Items/MyBlock.yml',
    note: 'Кастомный блок из MythicCrucible: ставится как обычный блок, но со своей моделью и навыками.',
    code: `MyLamp:
  Id: GLOWSTONE
  Display: '&eЛампа'
  Type: BLOCK
  Block:
    Material: GLOWSTONE
    Model: 10
    LightLevel: 15
    Hardness: 1.5
  BlockSkills:
    - effect:particles{p=end_rod;a=20} @self ~onBlockPlace
    - sound{s=block.amethyst_block.chime} @self ~onInteract
    - giveitem{i=MyLamp;amount=1} @trigger ~onBlockBreak
`,
  },
  {
    id: 'commands',
    title: 'Полезные команды',
    file: '',
    note: 'Список команд для проверки прямо из консоли панели.',
    code: `/mm reload                       перезагрузить все конфиги MythicMobs
/mm m spawn MyBoss world         заспавнить моба
/mm i get MySword                выдать предмет себе
/mm s create MySpawner MyBoss    создать спавнер
/mm skills                       список навыков
/mm mobs                         список мобов
/mythicmobs debug                режим отладки навыков
`,
  },
];

/** Подсказки по полям: атрибут → короткое описание (для панели «наведи и пойми»). */
const MYTHIC_FIELDS = {
  Type: 'сущность или тип предмета (FURNITURE, BLOCK для Crucible)',
  Display: 'имя с цветами &c, &l',
  Health: 'максимальное здоровье',
  Damage: 'урон атаки',
  Armor: 'броня',
  Options: 'поведение: MovementSpeed, FollowRange, PreventOtherDrops, Despawn',
  Skills: 'список навыков с целями и триггерами',
  Drops: 'что выпадает: предмет количество шанс',
  Equipment: 'экипировка: МАТЕРИАЛ СЛОТ (HEAD/HAND/CHEST/LEGS/FEET)',
  Id: 'ванильный материал (в старых версиях — Material)',
  Model: 'CustomModelData из ресурспака',
  Lore: 'описание предмета',
  Enchantments: 'зачарования: - ИМЯ:уровень',
  Attributes: 'атрибуты: MainHand/HEAD/… → AttackDamage, AttackSpeed',
  Furniture: 'настройки мебели Crucible: Material, Model, Barriers, Seats, Lights',
  FurnitureSkills: 'навыки на события мебели: ~onBlockPlace, ~onInteract, ~onBlockBreak',
};
