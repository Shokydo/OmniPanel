//! Боты для проверки нагрузки: вход на сервер по-настоящему, по протоколу
//! Minecraft, а не «постучались в порт».
//!
//! `protocol` — разбор и сборка пакетов по таблицам версий (их собирает
//! `tools/gen-bot-tables.js` из `core/bot-protocols.js`).

pub mod player;
pub mod protocol;

pub use player::{Actions, Bot, Config, Stage, Stats, TICK_MS};
pub use protocol::{name_of, nearest, versions};

/// Версия игры → версия протокола (для подстановки, если человек выбрал версию).
pub const VERSION_PROTOCOL: [(&str, u32); 54] = [
    ("1.8", 47), ("1.8.8", 47), ("1.8.9", 47),
    ("1.9", 107), ("1.9.4", 110), ("1.10", 210), ("1.10.2", 210), ("1.11", 315), ("1.11.2", 316),
    ("1.12", 335), ("1.12.1", 338), ("1.12.2", 340),
    ("1.13", 393), ("1.13.1", 401), ("1.13.2", 404),
    ("1.14", 477), ("1.14.4", 498), ("1.15", 573), ("1.15.2", 578),
    ("1.16", 735), ("1.16.1", 736), ("1.16.2", 751), ("1.16.3", 753), ("1.16.4", 754), ("1.16.5", 754),
    ("1.17", 755), ("1.17.1", 756), ("1.18", 757), ("1.18.1", 757), ("1.18.2", 758),
    ("1.19", 759), ("1.19.1", 760), ("1.19.2", 760), ("1.19.3", 761), ("1.19.4", 762),
    ("1.20", 763), ("1.20.1", 763), ("1.20.2", 764), ("1.20.3", 765), ("1.20.4", 765),
    ("1.20.5", 766), ("1.20.6", 766),
    ("1.21", 767), ("1.21.1", 767), ("1.21.2", 768), ("1.21.3", 768), ("1.21.4", 769),
    ("1.21.5", 770), ("1.21.6", 771), ("1.21.7", 772), ("1.21.8", 772),
    ("1.21.9", 773), ("1.21.10", 773), ("1.21.11", 774),
];

/// Версия игры → протокол; неизвестная — ближайшая известная той же линии.
pub fn protocol_for_version(version: &str) -> u32 {
    let text = version.trim();
    let lookup = |name: &str| VERSION_PROTOCOL.iter().find(|(known, _)| *known == name).map(|(_, id)| *id);

    if let Some(protocol) = lookup(text) {
        return protocol;
    }
    /* «1.20.5-pre1» → «1.20.5»: выпуск перед релизом идёт по той же раскладке */
    let numbers: Vec<&str> = text
        .split(|c: char| !(c.is_ascii_digit() || c == '.'))
        .filter(|part| !part.is_empty())
        .collect();
    if let Some(first) = numbers.first() {
        if let Some(protocol) = lookup(first) {
            return protocol;
        }
        /* «1.21.9» → ищем самую свежую версию этой же линии */
        let numbers: Vec<&str> = first.split('.').collect();
        if numbers.len() >= 2 {
            let line = format!("{}.{}", numbers[0], numbers[1]);
            let mut best: Option<(u32, u32)> = None;
            for (name, protocol) in VERSION_PROTOCOL.iter() {
                let parts: Vec<&str> = name.split('.').collect();
                if parts.len() >= 2 && format!("{}.{}", parts[0], parts[1]) == line {
                    let patch = parts.get(2).and_then(|p| p.parse::<u32>().ok()).unwrap_or(0);
                    if best.map(|(known, _)| patch > known).unwrap_or(true) {
                        best = Some((patch, *protocol));
                    }
                }
            }
            if let Some((_, protocol)) = best {
                return protocol;
            }
        }
    }
    /* совсем незнакомая версия — 1.20.4: с неё боты точно умеют входить */
    765
}
