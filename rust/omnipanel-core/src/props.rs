//! `server.properties`: чтение и запись с сохранением комментариев и порядка строк.
//!
//! Правила взяты из JS-версии (`core/files.js`), чтобы панель вела себя одинаково:
//! * строки `#` и `!` — комментарии, не трогаем;
//! * кириллица и прочий не-ASCII пишутся как `\uXXXX` (так делает сам Minecraft);
//! * при записи меняются только указанные ключи, остальные строки остаются как были;
//! * недостающие ключи дописываются в конец.

use std::collections::BTreeMap;

/// Что получилось из файла: значения, комментарии и порядок строк.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PropsFile {
    /// Значения в том порядке, в котором они лежат в файле.
    pub values: Vec<(String, String)>,
    /// Все строки файла как есть (для сохранения комментариев).
    pub lines: Vec<String>,
}

impl PropsFile {
    /// Разбирает текст `server.properties`.
    pub fn parse(text: &str) -> Self {
        let mut values = Vec::new();
        let mut lines = Vec::new();
        for raw in text.split('\n') {
            let line = raw.strip_suffix('\r').unwrap_or(raw).to_string();
            if let Some((key, value)) = split_line(&line) {
                if !values.iter().any(|(k, _): &(String, String)| *k == key) {
                    values.push((key, value));
                }
            }
            lines.push(line);
        }
        PropsFile { values, lines }
    }

    /// Пустое содержимое для нового файла.
    fn empty() -> Self {
        PropsFile {
            values: Vec::new(),
            lines: vec![
                "#Minecraft server properties".to_string(),
                "#создано панелью OmniPanel".to_string(),
            ],
        }
    }

    /// Значение по ключу.
    pub fn get(&self, key: &str) -> Option<&str> {
        self.values
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    /// Значение как строка с раскодированной кириллицей.
    pub fn get_text(&self, key: &str) -> Option<String> {
        self.get(key).map(decode)
    }

    /// Значение как `bool` («true» без учёта регистра и пробелов).
    pub fn get_bool(&self, key: &str) -> Option<bool> {
        self.get(key).map(|v| v.trim().eq_ignore_ascii_case("true"))
    }

    /// Значение как число.
    pub fn get_number(&self, key: &str) -> Option<f64> {
        self.get(key).and_then(|v| v.trim().parse::<f64>().ok())
    }

    /// Возвращает текст файла с изменёнными ключами.
    ///
    /// `patch` — что поменять; `booleans` — какие ключи писать как `true/false`.
    pub fn apply(&self, patch: &BTreeMap<String, String>, booleans: &[&str]) -> String {
        let mut lines = self.lines.clone();
        /* пустой файл (или файл из одних переводов строк) — начинаем с заголовка */
        if lines.iter().all(|l| l.trim().is_empty()) {
            lines = PropsFile::empty().lines;
        }
        let mut touched: Vec<String> = Vec::new();

        for line in lines.iter_mut() {
            let Some((key, _)) = split_line(line) else { continue };
            let Some(value) = patch.get(&key) else { continue };
            let encoded = if booleans.iter().any(|b| *b == key) {
                if value.trim().eq_ignore_ascii_case("true") { "true" } else { "false" }.to_string()
            } else {
                escape(value)
            };
            *line = format!("{key}={encoded}");
            touched.push(key);
        }

        /* ключей не было в файле — дописываем в конец, как это делает сервер */
        for (key, value) in patch {
            if touched.iter().any(|k| k == key) {
                continue;
            }
            let encoded = if booleans.iter().any(|b| *b == key) {
                if value.trim().eq_ignore_ascii_case("true") { "true" } else { "false" }.to_string()
            } else {
                escape(value)
            };
            lines.push(format!("{key}={encoded}"));
        }

        let mut out = lines.join("\n");
        if !out.ends_with('\n') {
            out.push('\n');
        }
        out
    }

    /// Значения, которых нет в известной схеме (плагины, моды) — их тоже можно править.
    pub fn extra(&self, known: &[&str]) -> BTreeMap<String, String> {
        let mut out = BTreeMap::new();
        for (key, value) in &self.values {
            if known.contains(&key.as_str()) {
                continue;
            }
            if !valid_key(key) {
                continue;
            }
            out.insert(key.clone(), decode(value));
        }
        out
    }
}

/// Разбор одной строки `ключ=значение` (None — комментарий или мусор).
fn split_line(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim_start();
    if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('!') {
        return None;
    }
    let eq = line.find('=')?;
    let key = line[..eq].trim();
    if key.is_empty() || !valid_key(key) {
        return None;
    }
    Some((key.to_string(), line[eq + 1..].to_string()))
}

/// Ключи в `server.properties` — буквы, цифры, точка, минус и подчёркивание.
fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
}

/// Не-ASCII символы превращаем в `\uXXXX` — иначе Java прочитает их неправильно.
pub fn escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        let code = ch as u32;
        if (0x20..=0x7e).contains(&code) && ch != '\\' {
            out.push(ch);
        } else if ch == '\\' {
            out.push_str("\\\\");
        } else {
            out.push_str(&format!("\\u{code:04x}"));
        }
    }
    out
}

/// Обратное к [`escape`]: `\uXXXX` снова становится буквой.
pub fn decode(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let mut out = String::with_capacity(value.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '\\' && i + 5 < chars.len() && chars[i + 1] == 'u' {
            let hex: String = chars[i + 2..i + 6].iter().collect();
            if let Ok(code) = u32::from_str_radix(&hex, 16) {
                if let Some(ch) = char::from_u32(code) {
                    out.push(ch);
                    i += 6;
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// Настройки `server.properties` по схеме интерфейса (`ui/props-schema.js`).
///
/// Таблица полей лежит в `props_schema.rs` и собирается генератором
/// `tools/gen-props-schema.js`: список настроек один на всю панель, чтобы окно
/// и ядро не разъехались.
pub struct Props {
    pub file: PropsFile,
}

impl Props {
    /// Все ключи схемы — остальное панель считает «прочими» (плагины, моды).
    pub fn all_keys() -> Vec<&'static str> {
        crate::props_schema::keys()
    }

    /// Настройка по ключу вместе с типом.
    pub fn field(key: &str) -> Option<&'static crate::props_schema::Field> {
        crate::props_schema::field(key)
    }

    pub fn parse(text: &str) -> Self {
        Props { file: PropsFile::parse(text) }
    }

    /// Значения для окна настроек: все поля схемы; отсутствующие — пустые.
    pub fn view(&self) -> BTreeMap<String, Option<String>> {
        let mut out = BTreeMap::new();
        for field in crate::props_schema::FIELDS {
            let value = match field.kind {
                crate::props_schema::Kind::Bool => self
                    .file
                    .get_bool(field.key)
                    .map(|b| if b { "true".into() } else { "false".into() }),
                crate::props_schema::Kind::Num => self.file.get(field.key).map(|s| s.trim().to_string()),
                crate::props_schema::Kind::Text => self.file.get_text(field.key),
            };
            out.insert(field.key.to_string(), value);
        }
        out
    }

    /// Прочие ключи файла (не из схемы) — их панель тоже показывает и правит.
    pub fn extra(&self) -> BTreeMap<String, String> {
        let keys = Self::all_keys();
        self.file.extra(&keys)
    }
}
