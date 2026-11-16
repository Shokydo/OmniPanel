//! Свой JSON без внешних зависимостей.
//!
//! Панель хранит настройки обычными JSON-файлами, а Rust-ядро обязано читать и
//! писать их ровно так же, как это делал Node: теми же ключами, тем же порядком,
//! с кириллицей как есть (не `\uXXXX`) и с отступами в два пробела.
//!
//! Отдельный модуль нужен ещё и потому, что через него пойдёт обмен с интерфейсом
//! (`ipc_invoke` получает аргументы и отдаёт ответ как `Value`).

use std::fmt;

/// Значение JSON.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    /// Число. Панель нигде не работает с огромными целыми, хватает `f64`.
    Num(f64),
    Str(String),
    Arr(Vec<Value>),
    /// Объект. Порядок ключей сохраняем — так файлы не «прыгают» между записями.
    Obj(Vec<(String, Value)>),
}

impl Value {
    pub fn str(value: impl Into<String>) -> Value {
        Value::Str(value.into())
    }

    pub fn obj(pairs: Vec<(&str, Value)>) -> Value {
        Value::Obj(pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
    }

    /// Достать поле объекта.
    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Obj(pairs) => pairs.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(s) => Some(s),
            _ => None,
        }
    }

    /// Строка из любого значения: числа и флаги тоже приводятся — интерфейс
    /// иногда присылает порт числом, а иногда строкой.
    pub fn text(&self) -> String {
        match self {
            Value::Null => String::new(),
            Value::Bool(b) => b.to_string(),
            Value::Num(n) => {
                if n.fract() == 0.0 && n.abs() < 1e15 {
                    format!("{}", *n as i64)
                } else {
                    format!("{}", n)
                }
            }
            Value::Str(s) => s.clone(),
            other => other.to_json(),
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Value::Num(n) => Some(*n),
            Value::Str(s) => s.trim().parse().ok(),
            Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> bool {
        match self {
            Value::Bool(b) => *b,
            Value::Num(n) => *n != 0.0,
            Value::Str(s) => matches!(s.trim(), "1" | "true" | "on" | "да" | "yes"),
            _ => false,
        }
    }

    pub fn as_arr(&self) -> &[Value] {
        match self {
            Value::Arr(items) => items,
            _ => &[],
        }
    }

    /// Добавляет поле в объект, если его там ещё нет (остальные не трогает).
    pub fn map_with(self, key: &str, value: Value) -> Value {
        match self {
            Value::Obj(mut pairs) => {
                if !pairs.iter().any(|(name, _)| name == key) {
                    pairs.push((key.to_string(), value));
                }
                Value::Obj(pairs)
            }
            Value::Null => Value::Obj(vec![(key.to_string(), value)]),
            other => other,
        }
    }

    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }

    pub fn to_json(&self) -> String {
        let mut out = String::new();
        write_value(&mut out, self, 0, false);
        out
    }

    /// Красивая запись с отступами — так панель пишет свои файлы.
    pub fn to_json_pretty(&self) -> String {
        let mut out = String::new();
        write_value(&mut out, self, 0, true);
        out
    }
}

impl fmt::Display for Value {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_json())
    }
}

impl From<&str> for Value {
    fn from(v: &str) -> Value {
        Value::Str(v.to_string())
    }
}

impl From<String> for Value {
    fn from(v: String) -> Value {
        Value::Str(v)
    }
}

impl From<bool> for Value {
    fn from(v: bool) -> Value {
        Value::Bool(v)
    }
}

impl From<u32> for Value {
    fn from(v: u32) -> Value {
        Value::Num(v as f64)
    }
}

impl From<u64> for Value {
    fn from(v: u64) -> Value {
        Value::Num(v as f64)
    }
}

impl From<usize> for Value {
    fn from(v: usize) -> Value {
        Value::Num(v as f64)
    }
}

impl From<i64> for Value {
    fn from(v: i64) -> Value {
        Value::Num(v as f64)
    }
}

/// Экранирование строки в кавычках. Кириллицу и прочий нормальный текст
/// оставляем как есть — панель хранит файлы в UTF-8.
pub fn quote(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn indent(out: &mut String, level: usize) {
    for _ in 0..level {
        out.push_str("  ");
    }
}

fn write_value(out: &mut String, value: &Value, level: usize, pretty: bool) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Num(n) => {
            if n.is_nan() || n.is_infinite() {
                out.push_str("null");
            } else if n.fract() == 0.0 && n.abs() < 1e15 {
                out.push_str(&format!("{}", *n as i64));
            } else {
                out.push_str(&format!("{}", n));
            }
        }
        Value::Str(s) => out.push_str(&quote(s)),
        Value::Arr(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                if pretty {
                    out.push('\n');
                    indent(out, level + 1);
                }
                write_value(out, item, level + 1, pretty);
            }
            if pretty {
                out.push('\n');
                indent(out, level);
            }
            out.push(']');
        }
        Value::Obj(pairs) => {
            if pairs.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            for (i, (key, item)) in pairs.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                if pretty {
                    out.push('\n');
                    indent(out, level + 1);
                }
                out.push_str(&quote(key));
                out.push(':');
                if pretty {
                    out.push(' ');
                }
                write_value(out, item, level + 1, pretty);
            }
            if pretty {
                out.push('\n');
                indent(out, level);
            }
            out.push('}');
        }
    }
}

/// Разбор JSON. Пустой текст — `Null`, битый текст — понятная ошибка по-русски.
pub fn parse(text: &str) -> Result<Value, String> {
    let mut p = Parser {
        chars: text.chars().collect(),
        pos: 0,
    };
    p.skip_space();
    let value = p.value()?;
    p.skip_space();
    if p.pos < p.chars.len() {
        return Err(format!("лишние символы в JSON на позиции {}", p.pos));
    }
    Ok(value)
}

/// Разбор с запасным вариантом: битый файл настроек не должен ронять панель.
pub fn parse_or(text: &str, fallback: Value) -> Value {
    parse(text).unwrap_or(fallback)
}

struct Parser {
    chars: Vec<char>,
    pos: usize,
}

impl Parser {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).copied()
    }

    fn take(&mut self) -> Option<char> {
        let ch = self.peek();
        if ch.is_some() {
            self.pos += 1;
        }
        ch
    }

    fn skip_space(&mut self) {
        while let Some(ch) = self.peek() {
            if ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r' {
                self.pos += 1;
            } else {
                break;
            }
        }
    }

    fn expect(&mut self, ch: char) -> Result<(), String> {
        match self.take() {
            Some(c) if c == ch => Ok(()),
            Some(c) => Err(format!("ожидался «{}», а встретилось «{}»", ch, c)),
            None => Err(format!("неожиданный конец текста, ожидался «{}»", ch)),
        }
    }

    fn value(&mut self) -> Result<Value, String> {
        self.skip_space();
        match self.peek() {
            None => Err("текст закончился, а значение не началось".to_string()),
            Some('{') => self.object(),
            Some('[') => self.array(),
            Some('"') => Ok(Value::Str(self.string()?)),
            Some('t') => self.keyword("true", Value::Bool(true)),
            Some('f') => self.keyword("false", Value::Bool(false)),
            Some('n') => self.keyword("null", Value::Null),
            Some(c) if c == '-' || c.is_ascii_digit() => self.number(),
            Some(c) => Err(format!("непонятный символ «{}» на позиции {}", c, self.pos)),
        }
    }

    fn keyword(&mut self, word: &str, value: Value) -> Result<Value, String> {
        for expected in word.chars() {
            if self.take() != Some(expected) {
                return Err(format!("ожидалось «{}»", word));
            }
        }
        Ok(value)
    }

    fn number(&mut self) -> Result<Value, String> {
        let start = self.pos;
        if self.peek() == Some('-') {
            self.pos += 1;
        }
        while let Some(c) = self.peek() {
            if c.is_ascii_digit() || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-' {
                self.pos += 1;
            } else {
                break;
            }
        }
        let text: String = self.chars[start..self.pos].iter().collect();
        text.parse::<f64>()
            .map(Value::Num)
            .map_err(|_| format!("не число: «{}»", text))
    }

    fn string(&mut self) -> Result<String, String> {
        self.expect('"')?;
        let mut out = String::new();
        while let Some(ch) = self.take() {
            match ch {
                '"' => return Ok(out),
                '\\' => match self.take() {
                    Some('"') => out.push('"'),
                    Some('\\') => out.push('\\'),
                    Some('/') => out.push('/'),
                    Some('b') => out.push('\u{08}'),
                    Some('f') => out.push('\u{0c}'),
                    Some('r') => out.push('\r'),
                    Some('t') => out.push('\t'),
                    Some('n') => out.push('\n'),
                    Some('u') => out.push(self.unicode_escape()?),
                    Some(c) => return Err(format!("непонятная escape-последовательность «\\{}»", c)),
                    None => return Err("строка оборвалась".to_string()),
                },
                c => out.push(c),
            }
        }
        Err("строка не закрыта кавычкой".to_string())
    }

    fn unicode_escape(&mut self) -> Result<char, String> {
        let mut code = 0u32;
        for _ in 0..4 {
            let ch = self.take().ok_or("обрыв в \\uXXXX")?;
            let digit = ch.to_digit(16).ok_or_else(|| format!("«{}» не шестнадцатеричная цифра", ch))?;
            code = code * 16 + digit;
        }
        /* суррогатная пара: старшая половина идёт первой */
        if (0xD800..0xDC00).contains(&code) {
            if self.take() == Some('\\') && self.take() == Some('u') {
                let mut low = 0u32;
                for _ in 0..4 {
                    let ch = self.take().ok_or("обрыв в \\uXXXX")?;
                    let digit = ch.to_digit(16).ok_or("не шестнадцатеричная цифра")?;
                    low = low * 16 + digit;
                }
                if (0xDC00..0xE000).contains(&low) {
                    let full = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
                    return char::from_u32(full).ok_or_else(|| "неверная суррогатная пара".to_string());
                }
            }
            return Ok('\u{FFFD}');
        }
        char::from_u32(code).ok_or_else(|| format!("неверный код символа {}", code))
    }

    fn array(&mut self) -> Result<Value, String> {
        self.expect('[')?;
        let mut items = Vec::new();
        self.skip_space();
        if self.peek() == Some(']') {
            self.pos += 1;
            return Ok(Value::Arr(items));
        }
        loop {
            items.push(self.value()?);
            self.skip_space();
            match self.take() {
                Some(',') => continue,
                Some(']') => return Ok(Value::Arr(items)),
                Some(c) => return Err(format!("в списке ожидалась «,» или «]», а встретилось «{}»", c)),
                None => return Err("список не закрыт".to_string()),
            }
        }
    }

    fn object(&mut self) -> Result<Value, String> {
        self.expect('{')?;
        let mut pairs: Vec<(String, Value)> = Vec::new();
        self.skip_space();
        if self.peek() == Some('}') {
            self.pos += 1;
            return Ok(Value::Obj(pairs));
        }
        loop {
            self.skip_space();
            let key = self.string()?;
            self.skip_space();
            self.expect(':')?;
            let value = self.value()?;
            /* повтор ключа — берём последнее значение, как JSON.parse */
            if let Some(slot) = pairs.iter_mut().find(|(k, _)| *k == key) {
                slot.1 = value;
            } else {
                pairs.push((key, value));
            }
            self.skip_space();
            match self.take() {
                Some(',') => continue,
                Some('}') => return Ok(Value::Obj(pairs)),
                Some(c) => return Err(format!("в объекте ожидалась «,» или «}}», а встретилось «{}»", c)),
                None => return Err("объект не закрыт".to_string()),
            }
        }
    }
}
