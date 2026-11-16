/* ЭТОТ ФАЙЛ СОБИРАЕТСЯ АВТОМАТИЧЕСКИ: node tools/gen-props-schema.js
 *
 * Источник — ui/props-schema.js (по нему рисуется окно настроек).
 * Руками не править: правь схему и запусти генератор.
 *
 * Полей: 64 (флаги 31, числа 17, текстовые 16).
 */

/// Как разбирать значение настройки.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Bool,
    Num,
    Text,
}

/// Одна настройка server.properties.
#[derive(Debug, Clone, Copy)]
pub struct Field {
    pub key: &'static str,
    pub kind: Kind,
    /// Раздел окна настроек (main, world, players, net, pack, perf, debug).
    pub group: &'static str,
    /// Что подставляет сам сервер, если ключа в файле нет.
    pub def: &'static str,
}

/// Все настройки, которые правит панель.
pub const FIELDS: &[Field] = &[
    Field { key: "motd", kind: Kind::Text, group: "main", def: "A Minecraft Server" },
    Field { key: "server-port", kind: Kind::Num, group: "main", def: "25565" },
    Field { key: "server-ip", kind: Kind::Text, group: "main", def: "" },
    Field { key: "max-players", kind: Kind::Num, group: "main", def: "20" },
    Field { key: "gamemode", kind: Kind::Text, group: "main", def: "survival" },
    Field { key: "force-gamemode", kind: Kind::Bool, group: "main", def: "false" },
    Field { key: "difficulty", kind: Kind::Text, group: "main", def: "easy" },
    Field { key: "hardcore", kind: Kind::Bool, group: "main", def: "false" },
    Field { key: "online-mode", kind: Kind::Bool, group: "main", def: "true" },
    Field { key: "enable-status", kind: Kind::Bool, group: "main", def: "true" },
    Field { key: "hide-online-players", kind: Kind::Bool, group: "main", def: "false" },
    Field { key: "enable-jmx-monitoring", kind: Kind::Bool, group: "main", def: "false" },
    Field { key: "allow-flight", kind: Kind::Bool, group: "main", def: "false" },
    Field { key: "allow-nether", kind: Kind::Bool, group: "main", def: "true" },
    Field { key: "allow-end", kind: Kind::Bool, group: "main", def: "true" },
    Field { key: "pause-when-empty-seconds", kind: Kind::Num, group: "main", def: "0" },
    Field { key: "level-name", kind: Kind::Text, group: "world", def: "world" },
    Field { key: "level-seed", kind: Kind::Text, group: "world", def: "" },
    Field { key: "level-type", kind: Kind::Text, group: "world", def: "minecraft:normal" },
    Field { key: "generator-settings", kind: Kind::Text, group: "world", def: "{}" },
    Field { key: "generate-structures", kind: Kind::Bool, group: "world", def: "true" },
    Field { key: "spawn-monsters", kind: Kind::Bool, group: "world", def: "true" },
    Field { key: "spawn-animals", kind: Kind::Bool, group: "world", def: "true" },
    Field { key: "spawn-npcs", kind: Kind::Bool, group: "world", def: "true" },
    Field { key: "spawn-protection", kind: Kind::Num, group: "world", def: "16" },
    Field { key: "max-world-size", kind: Kind::Num, group: "world", def: "29999984" },
    Field { key: "initial-enabled-packs", kind: Kind::Text, group: "world", def: "vanilla" },
    Field { key: "initial-disabled-packs", kind: Kind::Text, group: "world", def: "" },
    Field { key: "only-generate-structures", kind: Kind::Bool, group: "world", def: "false" },
    Field { key: "pvp", kind: Kind::Bool, group: "players", def: "true" },
    Field { key: "white-list", kind: Kind::Bool, group: "players", def: "false" },
    Field { key: "enforce-whitelist", kind: Kind::Bool, group: "players", def: "false" },
    Field { key: "enforce-secure-profile", kind: Kind::Bool, group: "players", def: "true" },
    Field { key: "player-idle-timeout", kind: Kind::Num, group: "players", def: "0" },
    Field { key: "op-permission-level", kind: Kind::Num, group: "players", def: "4" },
    Field { key: "function-permission-level", kind: Kind::Num, group: "players", def: "2" },
    Field { key: "enable-command-block", kind: Kind::Bool, group: "players", def: "false" },
    Field { key: "allow-cheats", kind: Kind::Bool, group: "players", def: "false" },
    Field { key: "broadcast-console-to-ops", kind: Kind::Bool, group: "players", def: "true" },
    Field { key: "broadcast-rcon-to-ops", kind: Kind::Bool, group: "players", def: "true" },
    Field { key: "log-ips", kind: Kind::Bool, group: "players", def: "true" },
    Field { key: "network-compression-threshold", kind: Kind::Num, group: "net", def: "256" },
    Field { key: "prevent-proxy-connections", kind: Kind::Bool, group: "net", def: "false" },
    Field { key: "use-native-transport", kind: Kind::Bool, group: "net", def: "true" },
    Field { key: "enable-rcon", kind: Kind::Bool, group: "net", def: "false" },
    Field { key: "rcon.port", kind: Kind::Num, group: "net", def: "25575" },
    Field { key: "rcon.password", kind: Kind::Text, group: "net", def: "" },
    Field { key: "enable-query", kind: Kind::Bool, group: "net", def: "false" },
    Field { key: "query.port", kind: Kind::Num, group: "net", def: "25565" },
    Field { key: "accept-transfers", kind: Kind::Bool, group: "net", def: "false" },
    Field { key: "text-filtering-config", kind: Kind::Text, group: "net", def: "" },
    Field { key: "require-resource-pack", kind: Kind::Bool, group: "pack", def: "false" },
    Field { key: "resource-pack", kind: Kind::Text, group: "pack", def: "" },
    Field { key: "resource-pack-prompt", kind: Kind::Text, group: "pack", def: "" },
    Field { key: "resource-pack-sha1", kind: Kind::Text, group: "pack", def: "" },
    Field { key: "resource-pack-id", kind: Kind::Text, group: "pack", def: "" },
    Field { key: "view-distance", kind: Kind::Num, group: "perf", def: "10" },
    Field { key: "simulation-distance", kind: Kind::Num, group: "perf", def: "10" },
    Field { key: "entity-broadcast-range-percentage", kind: Kind::Num, group: "perf", def: "100" },
    Field { key: "max-tick-time", kind: Kind::Num, group: "perf", def: "60000" },
    Field { key: "sync-chunk-writes", kind: Kind::Bool, group: "perf", def: "true" },
    Field { key: "max-chained-neighbor-updates", kind: Kind::Num, group: "perf", def: "1000000" },
    Field { key: "debug", kind: Kind::Bool, group: "debug", def: "false" },
    Field { key: "rate-limit", kind: Kind::Num, group: "debug", def: "0" },
];

/// Настройка по ключу.
pub fn field(key: &str) -> Option<&'static Field> {
    FIELDS.iter().find(|f| f.key == key)
}

/// Все ключи схемы — то, что панель показывает в окне настроек.
pub fn keys() -> Vec<&'static str> {
    FIELDS.iter().map(|f| f.key).collect()
}
