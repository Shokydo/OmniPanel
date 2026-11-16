//! Баны и история TPS.
//!
//! Файлы `banned-players.json` и `banned-ips.json` — обычный JSON от сервера,
//! поэтому читаем и пишем своим разбором, ничего не теряя: незнакомые поля
//! остаются на месте.

use crate::json::Value;
use std::path::Path;

/// Запись о блокировке в том виде, в котором её показывает панель.
#[derive(Debug, Clone, PartialEq)]
pub struct BanEntry {
    pub kind: String,
    pub name: String,
    pub uuid: String,
    pub ip: String,
    pub reason: String,
    pub source: String,
    pub created: String,
    pub expires: String,
    pub until: Option<String>,
}

/// Список блокировок сервера: игроки и адреса.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Bans {
    pub players: Vec<BanEntry>,
    pub ips: Vec<BanEntry>,
}

/// «forever» и прочие записи о сроке: панель показывает понятный текст.
fn until_text(expires: &str) -> Option<String> {
    if expires.is_empty() || expires == "forever" || expires == "forever," {
        return None;
    }
    Some(expires.to_string())
}

fn read_list(path: &Path) -> Vec<Value> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    match crate::json::parse(&text) {
        Ok(Value::Arr(items)) => items,
        _ => Vec::new(),
    }
}

fn text_of(value: &Value, key: &str) -> String {
    value.get(key).map(|v| v.text()).unwrap_or_default()
}

/// Читает оба списка блокировок.
pub fn list(dir: &Path) -> Bans {
    let players = read_list(&dir.join("banned-players.json"))
        .iter()
        .map(|b| {
            let expires = text_of(b, "expires");
            let until = until_text(&expires);
            let uuid = text_of(b, "uuid");
            BanEntry {
                kind: "player".to_string(),
                name: text_of(b, "name"),
                uuid: if uuid == "-" { String::new() } else { uuid },
                ip: String::new(),
                reason: or_default(text_of(b, "reason"), "без причины"),
                source: or_default(text_of(b, "source"), "консоль"),
                created: text_of(b, "created"),
                expires: or_default(expires, "forever"),
                until,
            }
        })
        .collect();
    let ips = read_list(&dir.join("banned-ips.json"))
        .iter()
        .map(|b| {
            let expires = text_of(b, "expires");
            let until = until_text(&expires);
            BanEntry {
                kind: "ip".to_string(),
                name: String::new(),
                uuid: String::new(),
                ip: text_of(b, "ip"),
                reason: or_default(text_of(b, "reason"), "без причины"),
                source: or_default(text_of(b, "source"), "консоль"),
                created: text_of(b, "created"),
                expires: or_default(expires, "forever"),
                until,
            }
        })
        .collect();
    Bans { players, ips }
}

fn or_default(value: String, fallback: &str) -> String {
    if value.trim().is_empty() {
        fallback.to_string()
    } else {
        value
    }
}

/// Убирает блокировку из файла. Возвращает число снятых записей или понятную ошибку.
pub fn unban(dir: &Path, name: &str, ip: &str) -> Result<usize, String> {
    if !ip.trim().is_empty() {
        let file = dir.join("banned-ips.json");
        let list = read_list(&file);
        let before = list.len();
        let left: Vec<Value> = list.into_iter().filter(|b| text_of(b, "ip") != ip).collect();
        if left.len() == before {
            return Err(format!("IP {} в блокировках не числится", ip));
        }
        write_list(&file, &left)?;
        return Ok(before - left.len());
    }
    let file = dir.join("banned-players.json");
    let list = read_list(&file);
    let before = list.len();
    let key = name.to_lowercase();
    let left: Vec<Value> = list
        .into_iter()
        .filter(|b| text_of(b, "name").to_lowercase() != key)
        .collect();
    if left.len() == before {
        return Err(format!("Игрок {} в блокировках не числится", name));
    }
    write_list(&file, &left)?;
    Ok(before - left.len())
}

/// Дописывает блокировку в файл (когда сервер выключен).
pub fn add(dir: &Path, name: &str, ip: &str, reason: &str) -> Result<(), String> {
    if !ip.trim().is_empty() {
        let file = dir.join("banned-ips.json");
        let mut list = read_list(&file);
        if list.iter().any(|b| text_of(b, "ip") == ip) {
            return Err(format!("IP {} уже заблокирован", ip));
        }
        list.push(Value::obj(vec![
            ("ip", Value::str(ip)),
            ("created", Value::str(now_text())),
            ("source", Value::str("Панель")),
            ("expires", Value::str("forever")),
            ("reason", Value::str(if reason.is_empty() { "Заблокирован из панели" } else { reason })),
        ]));
        return write_list(&file, &list);
    }
    let file = dir.join("banned-players.json");
    let mut list = read_list(&file);
    if list.iter().any(|b| text_of(b, "name").to_lowercase() == name.to_lowercase()) {
        return Err(format!("Игрок {} уже заблокирован", name));
    }
    list.push(Value::obj(vec![
        ("uuid", Value::str("-")),
        ("name", Value::str(name)),
        ("created", Value::str(now_text())),
        ("source", Value::str("Панель")),
        ("expires", Value::str("forever")),
        ("reason", Value::str(if reason.is_empty() { "Заблокирован из панели" } else { reason })),
    ]));
    write_list(&file, &list)
}

fn write_list(path: &Path, list: &[Value]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let text = Value::Arr(list.to_vec()).to_json_pretty();
    std::fs::write(path, text).map_err(|e| format!("не удалось записать файл блокировок: {}", e))
}

fn now_text() -> String {
    /* сервер пишет время вида 2024-01-01 12:00:00 +0300 */
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (days, rest) = (secs / 86400, secs % 86400);
    let (year, month, day) = civil_from_days(days as i64);
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02} +0000",
        year,
        month,
        day,
        rest / 3600,
        (rest % 3600) / 60,
        rest % 60
    )
}

/// Гражданская дата из числа дней с 1970 года (алгоритм Говарда Хиннанта).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Понятная запись о сроке блокировки (панель показывает её рядом с ником).
pub fn until_human(entry: &BanEntry) -> String {
    match &entry.until {
        None => "навсегда".to_string(),
        Some(text) => text.clone(),
    }
}

/// Первые числа TPS из строки сервера.
///
/// Понимает Paper/Spigot (`TPS from last 1m, 5m, 15m: 20.0, 20.0, 20.0`),
/// Forge (`Mean TPS: 20.000`) и старый Forge (`20.000 TPS`).
pub fn parse_tps(line: &str) -> Option<f32> {
    let lower = line.to_lowercase();
    if let Some(at) = lower.find("tps from last") {
        let tail = &line[at..];
        if let Some(colon) = tail.find(':') {
            let numbers = &tail[colon + 1..];
            let first: String = numbers
                .trim_start()
                .chars()
                .take_while(|c| c.is_ascii_digit() || *c == '.' || *c == ',')
                .collect();
            return first.replace(',', ".").parse().ok();
        }
    }
    if let Some(at) = lower.find("mean tps:") {
        let tail = &line[at + 9..];
        let first: String = tail
            .trim_start()
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '.' || *c == ',')
            .collect();
        return first.replace(',', ".").parse().ok();
    }
    if lower.contains(" tps") {
        let trimmed = line.trim();
        let first: String = trimmed
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '.' || *c == ',')
            .collect();
        if !first.is_empty() {
            return first.replace(',', ".").parse().ok();
        }
    }
    None
}

/// Точка истории TPS: время и значение.
#[derive(Debug, Clone, PartialEq)]
pub struct TpsPoint {
    pub at: u64,
    pub value: f32,
}

impl TpsPoint {
    pub fn to_json(&self) -> Value {
        Value::obj(vec![
            ("at", Value::from(self.at)),
            ("tps", Value::Num(self.value as f64)),
        ])
    }
}
