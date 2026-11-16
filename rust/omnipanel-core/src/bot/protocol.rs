//! Разбор и сборка пакетов Minecraft по компактным таблицам версий.
//!
//! Таблицы собирает `tools/gen-bot-tables.js` из `core/bot-protocols.js` —
//! там номера пакетов и раскладка полей для 26 версий игры. Здесь только
//! интерпретатор: читаем и пишем по описанию, недостающие поля заполняем сами.
//!
//! Разбор один в один с прежней панелью (`core/proto.js`), иначе боты будут
//! спотыкаться о пакеты, которые у панели на Node работали.

use crate::json::{self, Value};
use std::sync::OnceLock;

/// Таблицы версий: `id версии протокола` → данные из `tables.json`.
static TABLES: OnceLock<Vec<(u32, Value)>> = OnceLock::new();

fn loaded() -> &'static Vec<(u32, Value)> {
    TABLES.get_or_init(|| {
        let raw = include_str!("tables.json");
        let root = json::parse(raw).unwrap_or(Value::Obj(Vec::new()));
        let Some(versions) = root.get("versions") else {
            return Vec::new();
        };
        let pairs = match versions {
            Value::Obj(pairs) => pairs.clone(),
            _ => Vec::new(),
        };
        let mut out: Vec<(u32, Value)> = pairs
            .into_iter()
            .filter_map(|(key, value)| key.parse::<u32>().ok().map(|id| (id, value)))
            .collect();
        out.sort_by_key(|(id, _)| *id);
        out
    })
}

/// Ближайшая известная версия протокола: сервер новее таблиц — берём самую свежую.
pub fn nearest(protocol: u32) -> Option<u32> {
    let list = loaded();
    if list.is_empty() {
        return None;
    }
    if list.iter().any(|(id, _)| *id == protocol) {
        return Some(protocol);
    }
    let mut best: Option<u32> = None;
    for (id, _) in list {
        if *id <= protocol {
            best = Some(*id);
        }
    }
    Some(best.unwrap_or(list[0].0))
}

/// Таблица версии (уже приведённая к ближайшей известной).
pub fn table(protocol: u32) -> Option<&'static Value> {
    let id = nearest(protocol)?;
    loaded().iter().find(|(other, _)| *other == id).map(|(_, value)| value)
}

/// Все версии, которые знают таблицы: `[{protocol, version}]`.
pub fn versions() -> Vec<(u32, String)> {
    loaded()
        .iter()
        .map(|(id, value)| {
            let version = value.get("version").map(|v| v.text()).unwrap_or_default();
            (*id, version)
        })
        .collect()
}

/// Запись о пакете: номер и раскладка полей.
fn packet(protocol: u32, section: &str, dir: &str, name: &str) -> Option<(u32, Value)> {
    let table = table(protocol)?;
    let entry = table.get("send")?.get(&format!("{}/{}/{}", section, dir, name))?;
    let id = entry.get("id").and_then(|v| v.as_f64()).unwrap_or(0.0) as u32;
    let spec = entry.get("spec").cloned().unwrap_or(Value::Null);
    Some((id, spec))
}

/// Ищет пакет в любом направлении: бот и разбирает чужие, и собирает свои.
fn packet_any(protocol: u32, section: &str, name: &str) -> Option<(u32, Value, &'static str)> {
    if let Some((id, spec)) = packet(protocol, section, "toServer", name) {
        return Some((id, spec, "toServer"));
    }
    packet(protocol, section, "toClient", name).map(|(id, spec)| (id, spec, "toClient"))
}

/// Номер пакета, который бот отправляет (`None` — в этой версии такого нет).
pub fn id_of(protocol: u32, section: &str, name: &str) -> Option<u32> {
    packet_any(protocol, section, name).map(|(id, _, _)| id)
}

/// Номер пакета в нужном направлении.
pub fn id_of_dir(protocol: u32, section: &str, dir: &str, name: &str) -> Option<u32> {
    packet(protocol, section, dir, name).map(|(id, _)| id)
}

/// Имя пакета, который сервер прислал (`None` — не знаем такой номер).
pub fn name_of(protocol: u32, section: &str, dir: &str, id: u32) -> Option<String> {
    let table = table(protocol)?;
    let map = table.get("names")?.get(&format!("{}/{}", section, dir))?;
    map.get(&id.to_string()).map(|v| v.text())
}

/* ─────────────────────────────── чтение ─────────────────────────────── */

struct Reader<'a> {
    buf: &'a [u8],
    off: usize,
    stack: Vec<Value>,
}

impl<'a> Reader<'a> {
    fn new(buf: &'a [u8]) -> Reader<'a> {
        Reader { buf, off: 0, stack: Vec::new() }
    }

    fn need(&self, count: usize) -> Result<(), String> {
        if self.off + count > self.buf.len() {
            return Err("пакет короче, чем нужно".to_string());
        }
        Ok(())
    }

    fn varint(&mut self) -> Result<i32, String> {
        let mut result: i32 = 0;
        let mut shift = 0;
        for _ in 0..5 {
            self.need(1)?;
            let byte = self.buf[self.off];
            self.off += 1;
            result |= ((byte & 0x7f) as i32) << shift;
            if byte & 0x80 == 0 {
                return Ok(result);
            }
            shift += 7;
        }
        Err("испорченный varint".to_string())
    }

    fn varlong(&mut self) -> Result<i64, String> {
        let mut result: i64 = 0;
        let mut shift = 0;
        for _ in 0..10 {
            self.need(1)?;
            let byte = self.buf[self.off];
            self.off += 1;
            result |= ((byte & 0x7f) as i64) << shift;
            if byte & 0x80 == 0 {
                return Ok(result);
            }
            shift += 7;
        }
        Err("испорченный varlong".to_string())
    }

    fn take(&mut self, count: usize) -> Result<&'a [u8], String> {
        self.need(count)?;
        let slice = &self.buf[self.off..self.off + count];
        self.off += count;
        Ok(slice)
    }

    fn read(&mut self, spec: &Value) -> Result<Value, String> {
        let (name, args) = match spec {
            Value::Str(name) => (name.clone(), Value::Null),
            Value::Arr(items) if !items.is_empty() => {
                (items[0].text(), items.get(1).cloned().unwrap_or(Value::Null))
            }
            _ => return Err("непонятное описание поля".to_string()),
        };
        match name.as_str() {
            "void" => Ok(Value::Null),
            "bool" => {
                self.need(1)?;
                let value = self.buf[self.off] != 0;
                self.off += 1;
                Ok(Value::Bool(value))
            }
            "u8" => {
                self.need(1)?;
                let value = self.buf[self.off];
                self.off += 1;
                Ok(Value::Num(value as f64))
            }
            "i8" => {
                self.need(1)?;
                let value = self.buf[self.off] as i8;
                self.off += 1;
                Ok(Value::Num(value as f64))
            }
            "u16" | "i16" => {
                let bytes = self.take(2)?;
                let raw = u16::from_be_bytes([bytes[0], bytes[1]]);
                Ok(Value::Num(if name == "i16" { (raw as i16) as f64 } else { raw as f64 }))
            }
            "u32" | "i32" => {
                let bytes = self.take(4)?;
                let raw = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
                Ok(Value::Num(if name == "i32" { (raw as i32) as f64 } else { raw as f64 }))
            }
            "u64" | "i64" => {
                let bytes = self.take(8)?;
                let mut raw = [0u8; 8];
                raw.copy_from_slice(bytes);
                Ok(Value::Num(if name == "i64" {
                    i64::from_be_bytes(raw) as f64
                } else {
                    u64::from_be_bytes(raw) as f64
                }))
            }
            "f32" => {
                let bytes = self.take(4)?;
                Ok(Value::Num(f32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as f64))
            }
            "f64" => {
                let bytes = self.take(8)?;
                let mut raw = [0u8; 8];
                raw.copy_from_slice(bytes);
                Ok(Value::Num(f64::from_be_bytes(raw)))
            }
            "varint" => Ok(Value::Num(self.varint()? as f64)),
            "varlong" => Ok(Value::Num(self.varlong()? as f64)),
            "pstring" => {
                let length = self.count(&args)?;
                let bytes = self.take(length)?;
                Ok(Value::str(String::from_utf8_lossy(bytes).to_string()))
            }
            "buffer" => {
                if args.get("rest").map(|v| v.as_bool()).unwrap_or(false) {
                    let bytes = &self.buf[self.off..];
                    self.off = self.buf.len();
                    return Ok(Value::str(base64(bytes)));
                }
                let length = self.count(&args)?;
                let bytes = self.take(length)?;
                Ok(Value::str(base64(bytes)))
            }
            "restBuffer" => {
                let bytes = &self.buf[self.off..];
                self.off = self.buf.len();
                Ok(Value::str(base64(bytes)))
            }
            "UUID" => {
                let bytes = self.take(16)?;
                let hex: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();
                Ok(Value::str(format!(
                    "{}-{}-{}-{}-{}",
                    &hex[0..8],
                    &hex[8..12],
                    &hex[12..16],
                    &hex[16..20],
                    &hex[20..32]
                )))
            }
            "option" => {
                self.need(1)?;
                let present = self.buf[self.off] != 0;
                self.off += 1;
                if present {
                    self.read(&args)
                } else {
                    Ok(Value::Null)
                }
            }
            "mapper" => {
                let raw = self.read(&args.get("type").cloned().unwrap_or(Value::Null))?;
                let key = raw.text();
                if let Some(found) = args.get("mappings").and_then(|m| m.get(&key)) {
                    return Ok(found.clone());
                }
                Ok(raw)
            }
            "container" => {
                let fields = args.as_arr().to_vec();
                let mut frame = Vec::new();
                self.stack.push(Value::Obj(frame.clone()));
                for field in &fields {
                    if field.get("anon").map(|v| v.as_bool()).unwrap_or(false) {
                        continue;
                    }
                    let field_name = field.get("name").map(|v| v.text()).unwrap_or_default();
                    let field_type = field.get("type").cloned().unwrap_or(Value::Null);
                    let value = self.read(&field_type)?;
                    frame.push((field_name, value));
                }
                self.stack.pop();
                Ok(Value::Obj(frame))
            }
            "switch" => {
                let compare = args.get("compareTo").map(|v| v.text()).unwrap_or_default();
                let mut parts: Vec<&str> = compare.split('/').collect();
                let mut frame = self.stack.last().cloned().unwrap_or(Value::Null);
                if parts.first() == Some(&"..") {
                    parts.remove(0);
                    frame = self
                        .stack
                        .get(self.stack.len().saturating_sub(2))
                        .cloned()
                        .unwrap_or(Value::Null);
                }
                let mut value = frame;
                for part in parts {
                    value = value.get(part).cloned().unwrap_or(Value::Null);
                }
                let key = value.text();
                let chosen = args
                    .get("fields")
                    .and_then(|fields| fields.get(&key))
                    .cloned()
                    .or_else(|| args.get("default").cloned());
                match chosen {
                    Some(spec) if !spec.is_null() => self.read(&spec),
                    _ => Err(format!("switch: нет ветки {}", key)),
                }
            }
            "array" => {
                let frame = Value::Obj(vec![("count".to_string(), Value::Num(0.0))]);
                self.stack.push(frame);
                let count = match args.get("count") {
                    Some(count) if !count.is_null() => count.as_f64().unwrap_or(0.0) as usize,
                    _ => {
                        let count_type = args.get("countType").cloned().unwrap_or(Value::str("varint"));
                        self.read(&count_type)?.as_f64().unwrap_or(0.0) as usize
                    }
                };
                let item = args.get("type").cloned().unwrap_or(Value::Null);
                let mut out = Vec::with_capacity(count.min(1024));
                for _ in 0..count {
                    out.push(self.read(&item)?);
                }
                self.stack.pop();
                Ok(Value::Arr(out))
            }
            "bitfield" => {
                let fields = args.as_arr().to_vec();
                let total: usize = fields
                    .iter()
                    .map(|f| f.get("size").and_then(|v| v.as_f64()).unwrap_or(0.0) as usize)
                    .sum();
                let bytes = (total + 7) / 8;
                let raw = self.take(bytes)?;
                let mut value: u64 = 0;
                for byte in raw {
                    value = (value << 8) | *byte as u64;
                }
                let mut out = Vec::new();
                let mut shift = total as i32;
                for field in &fields {
                    let size = field.get("size").and_then(|v| v.as_f64()).unwrap_or(0.0) as i32;
                    shift -= size;
                    let mask = if size >= 64 { u64::MAX } else { (1u64 << size) - 1 };
                    let part = (value >> shift.max(0) as u32) & mask;
                    let name = field.get("name").map(|v| v.text()).unwrap_or_default();
                    out.push((name, Value::Num(part as f64)));
                }
                Ok(Value::Obj(out))
            }
            "bitflags" => {
                let raw = self.read(&args.get("type").cloned().unwrap_or(Value::str("varint")))?;
                let bits = raw.as_f64().unwrap_or(0.0) as u64;
                let mut out = Vec::new();
                let flags = args.get("flags").cloned().unwrap_or(Value::Null);
                let list: Vec<(String, usize)> = match &flags {
                    Value::Arr(items) => items
                        .iter()
                        .enumerate()
                        .map(|(index, item)| (item.text(), index))
                        .collect(),
                    Value::Obj(pairs) => pairs
                        .iter()
                        .enumerate()
                        .map(|(index, (name, flag))| {
                            let bit = flag
                                .get("bit")
                                .and_then(|v| v.as_f64())
                                .map(|v| v as usize)
                                .unwrap_or(index);
                            (name.clone(), bit)
                        })
                        .collect(),
                    _ => Vec::new(),
                };
                for (name, bit) in list {
                    out.push((name, Value::Bool(bits & (1u64 << bit) != 0)));
                }
                Ok(Value::Obj(out))
            }
            other => Err(format!("чтение типа {} не поддержано", other)),
        }
    }

    fn count(&mut self, args: &Value) -> Result<usize, String> {
        if let Some(count) = args.get("count") {
            if !count.is_null() {
                return Ok(count.as_f64().unwrap_or(0.0) as usize);
            }
        }
        let count_type = args.get("countType").cloned().unwrap_or(Value::str("varint"));
        let value = self.read(&count_type)?;
        Ok(value.as_f64().unwrap_or(0.0).max(0.0) as usize)
    }
}

/// Разбирает тело пакета по описанию. `fields` — какие поля нужны: как только
/// они собраны, чтение останавливается (реестры и карты высот боту не нужны).
pub fn read(protocol: u32, section: &str, name: &str, payload: &[u8], fields: &[&str]) -> Result<Value, String> {
    let dir = packet_any(protocol, section, name)
        .map(|(_, _, dir)| dir)
        .ok_or_else(|| format!("в версии {} нет пакета {}/{}", protocol, section, name))?;
    read_dir(protocol, section, dir, name, payload, fields)
}

/// То же, но с указанием направления: серверный пакет читаем из toClient.
pub fn read_dir(
    protocol: u32,
    section: &str,
    dir: &str,
    name: &str,
    payload: &[u8],
    fields: &[&str],
) -> Result<Value, String> {
    let Some((_, spec)) = packet(protocol, section, dir, name) else {
        return Ok(Value::Obj(Vec::new()));
    };
    let mut reader = Reader::new(payload);
    let wanted: Option<&[&str]> = if fields.is_empty() { None } else { Some(fields) };

    /* верхний уровень — контейнер: читаем по полю, чтобы можно было остановиться */
    let (kind, args) = match &spec {
        Value::Str(kind) => (kind.clone(), Value::Null),
        Value::Arr(items) if !items.is_empty() => {
            (items[0].text(), items.get(1).cloned().unwrap_or(Value::Null))
        }
        _ => return Ok(Value::Obj(Vec::new())),
    };
    if kind != "container" {
        return reader.read(&spec);
    }
    let mut frame = Vec::new();
    for field in args.as_arr() {
        if field.get("anon").map(|v| v.as_bool()).unwrap_or(false) {
            continue;
        }
        let field_name = field.get("name").map(|v| v.text()).unwrap_or_default();
        let field_type = field.get("type").cloned().unwrap_or(Value::Null);
        match reader.read(&field_type) {
            Ok(value) => frame.push((field_name, value)),
            Err(err) => {
                /* поля не хватило — отдаём то, что успели прочитать */
                if frame.is_empty() {
                    return Err(err);
                }
                break;
            }
        }
        if let Some(wanted) = wanted {
            if wanted.iter().all(|name| frame.iter().any(|(key, _)| key == name)) {
                break;
            }
        }
    }
    Ok(Value::Obj(frame))
}

/* ─────────────────────────────── запись ─────────────────────────────── */

struct Writer {
    out: Vec<u8>,
    stack: Vec<Value>,
}

impl Writer {
    fn write(&mut self, spec: &Value, value: &Value) -> Result<(), String> {
        let (name, args) = match spec {
            Value::Str(name) => (name.clone(), Value::Null),
            Value::Arr(items) if !items.is_empty() => {
                (items[0].text(), items.get(1).cloned().unwrap_or(Value::Null))
            }
            _ => return Err("непонятное описание поля".to_string()),
        };
        match name.as_str() {
            "void" => {}
            "bool" => self.out.push(if value.as_bool() { 1 } else { 0 }),
            "u8" | "i8" => {
                let number = value.as_f64().unwrap_or(0.0) as i64;
                self.out.push(if name == "u8" {
                    number.clamp(0, 255) as u8
                } else {
                    (number as i8) as u8
                });
            }
            "u16" | "i16" => {
                let number = value.as_f64().unwrap_or(0.0) as i64;
                let raw = if name == "u16" { number.clamp(0, 65535) as u16 } else { number as i16 as u16 };
                self.out.extend_from_slice(&raw.to_be_bytes());
            }
            "u32" | "i32" => {
                let number = value.as_f64().unwrap_or(0.0) as i64;
                let raw = if name == "u32" { number.clamp(0, u32::MAX as i64) as u32 } else { number as i32 as u32 };
                self.out.extend_from_slice(&raw.to_be_bytes());
            }
            "u64" | "i64" => {
                let number = value.as_f64().unwrap_or(0.0);
                let raw = if name == "i64" { (number as i64) as u64 } else { number as u64 };
                self.out.extend_from_slice(&raw.to_be_bytes());
            }
            "f32" => self
                .out
                .extend_from_slice(&(value.as_f64().unwrap_or(0.0) as f32).to_be_bytes()),
            "f64" => self.out.extend_from_slice(&value.as_f64().unwrap_or(0.0).to_be_bytes()),
            "varint" => write_varint(&mut self.out, value.as_f64().unwrap_or(0.0) as i32),
            "varlong" => write_varlong(&mut self.out, value.as_f64().unwrap_or(0.0) as i64),
            "pstring" => {
                let text = value.text();
                let bytes = text.as_bytes();
                self.write(&args.get("countType").cloned().unwrap_or(Value::str("varint")), &Value::Num(bytes.len() as f64))?;
                self.out.extend_from_slice(bytes);
            }
            "buffer" => {
                let bytes = unbase64(&value.text());
                if args.get("rest").map(|v| v.as_bool()).unwrap_or(false) {
                    self.out.extend_from_slice(&bytes);
                } else if let Some(count) = args.get("count").filter(|c| !c.is_null()) {
                    let length = count.as_f64().unwrap_or(0.0) as usize;
                    self.out.resize(self.out.len() + length, 0);
                    let end = self.out.len();
                    let start = end - length;
                    let copy = bytes.len().min(length);
                    self.out[start..start + copy].copy_from_slice(&bytes[..copy]);
                } else {
                    self.write(&args.get("countType").cloned().unwrap_or(Value::str("varint")), &Value::Num(bytes.len() as f64))?;
                    self.out.extend_from_slice(&bytes);
                }
            }
            "restBuffer" => self.out.extend_from_slice(&unbase64(&value.text())),
            "UUID" => {
                let clean: String = value
                    .text()
                    .chars()
                    .filter(|c| c.is_ascii_hexdigit())
                    .collect();
                let mut bytes = vec![0u8; 16];
                for index in 0..16 {
                    let pair = clean.get(index * 2..index * 2 + 2).unwrap_or("00");
                    bytes[index] = u8::from_str_radix(pair, 16).unwrap_or(0);
                }
                self.out.extend_from_slice(&bytes);
            }
            "option" => {
                if value.is_null() {
                    self.out.push(0);
                } else {
                    self.out.push(1);
                    self.write(&args, value)?;
                }
            }
            "mapper" => {
                let mappings = args.get("mappings").cloned().unwrap_or(Value::Null);
                let mut key = value.text();
                if mappings.get(&key).is_none() {
                    if let Value::Obj(pairs) = &mappings {
                        if let Some((found, _)) = pairs.iter().find(|(_, v)| v.text() == key) {
                            key = found.clone();
                        }
                    }
                }
                let number = if key.starts_with("0x") {
                    i64::from_str_radix(&key[2..], 16).unwrap_or(0)
                } else {
                    key.parse::<f64>().unwrap_or(0.0) as i64
                };
                self.write(&args.get("type").cloned().unwrap_or(Value::str("varint")), &Value::Num(number as f64))?;
            }
            "container" => {
                let frame = value.clone();
                self.stack.push(frame.clone());
                for field in args.as_arr() {
                    if field.get("anon").map(|v| v.as_bool()).unwrap_or(false) {
                        continue;
                    }
                    let field_name = field.get("name").map(|v| v.text()).unwrap_or_default();
                    let field_type = field.get("type").cloned().unwrap_or(Value::Null);
                    let given = frame.get(&field_name).cloned();
                    let to_write = match given {
                        Some(given) if !given.is_null() => given,
                        other => other.unwrap_or_else(|| default_value(&field_type)),
                    };
                    self.write(&field_type, &to_write)?;
                }
                self.stack.pop();
            }
            "switch" => {
                let compare = args.get("compareTo").map(|v| v.text()).unwrap_or_default();
                let mut parts: Vec<&str> = compare.split('/').collect();
                let mut frame = self.stack.last().cloned().unwrap_or(Value::Null);
                if parts.first() == Some(&"..") {
                    parts.remove(0);
                    frame = self
                        .stack
                        .get(self.stack.len().saturating_sub(2))
                        .cloned()
                        .unwrap_or(Value::Null);
                }
                let mut value_at = frame;
                for part in parts {
                    value_at = value_at.get(part).cloned().unwrap_or(Value::Null);
                }
                let key = value_at.text();
                let chosen = args
                    .get("fields")
                    .and_then(|fields| fields.get(&key))
                    .cloned()
                    .or_else(|| args.get("default").cloned());
                if let Some(spec) = chosen {
                    if !spec.is_null() {
                        let inner = if value.is_null() { default_value(&spec) } else { value.clone() };
                        self.write(&spec, &inner)?;
                    }
                }
            }
            "array" => {
                self.stack.push(Value::Obj(vec![("count".to_string(), Value::Num(0.0))]));
                let items = value.as_arr().to_vec();
                if args.get("count").filter(|c| !c.is_null()).is_none() {
                    let count_type = args.get("countType").cloned().unwrap_or(Value::str("varint"));
                    self.write(&count_type, &Value::Num(items.len() as f64))?;
                }
                let item_spec = args.get("type").cloned().unwrap_or(Value::Null);
                for item in &items {
                    self.write(&item_spec, item)?;
                }
                self.stack.pop();
            }
            "bitfield" => {
                let fields = args.as_arr().to_vec();
                let total: usize = fields
                    .iter()
                    .map(|f| f.get("size").and_then(|v| v.as_f64()).unwrap_or(0.0) as usize)
                    .sum();
                let bytes = (total + 7) / 8;
                let mut packed: u128 = 0;
                for field in &fields {
                    let size = field.get("size").and_then(|v| v.as_f64()).unwrap_or(0.0) as u32;
                    let name = field.get("name").map(|v| v.text()).unwrap_or_default();
                    let mut part = value.get(&name).and_then(|v| v.as_f64()).unwrap_or(0.0) as i128;
                    if part < 0 && size < 127 {
                        part += 1i128 << size;
                    }
                    let mask = if size >= 127 { i128::MAX } else { (1i128 << size) - 1 };
                    packed = (packed << size) | ((part & mask) as u128);
                }
                let mut buffer = vec![0u8; bytes];
                for index in (0..bytes).rev() {
                    buffer[index] = (packed & 0xff) as u8;
                    packed >>= 8;
                }
                self.out.extend_from_slice(&buffer);
            }
            "bitflags" => {
                let flags = args.get("flags").cloned().unwrap_or(Value::Null);
                let list: Vec<(String, usize)> = match &flags {
                    Value::Arr(items) => items
                        .iter()
                        .enumerate()
                        .map(|(index, item)| (item.text(), index))
                        .collect(),
                    Value::Obj(pairs) => pairs
                        .iter()
                        .enumerate()
                        .map(|(index, (name, flag))| {
                            let bit = flag
                                .get("bit")
                                .and_then(|v| v.as_f64())
                                .map(|v| v as usize)
                                .unwrap_or(index);
                            (name.clone(), bit)
                        })
                        .collect(),
                    _ => Vec::new(),
                };
                let mut bits: u64 = 0;
                for (name, bit) in list {
                    if value.get(&name).map(|v| v.as_bool()).unwrap_or(false) {
                        bits |= 1u64 << bit;
                    }
                }
                self.write(&args.get("type").cloned().unwrap_or(Value::str("varint")), &Value::Num(bits as f64))?;
            }
            other => return Err(format!("запись типа {} не поддержана", other)),
        }
        Ok(())
    }
}

/// Собирает тело пакета (без номера). Недостающие поля заполняются сами —
/// боту не нужно расписывать всё, что сервер ждёт в «настройках клиента».
pub fn write(protocol: u32, section: &str, name: &str, values: &Value) -> Result<Vec<u8>, String> {
    let dir = packet_any(protocol, section, name)
        .map(|(_, _, dir)| dir)
        .ok_or_else(|| format!("в версии {} нет пакета {}/{}", protocol, section, name))?;
    write_dir(protocol, section, dir, name, values)
}

/// То же, но с указанием направления: пакет от сервера собираем в toClient.
pub fn write_dir(protocol: u32, section: &str, dir: &str, name: &str, values: &Value) -> Result<Vec<u8>, String> {
    let Some((_, spec)) = packet(protocol, section, dir, name) else {
        return Err(format!("пакет {} нет в таблицах этой версии", name));
    };
    let mut writer = Writer { out: Vec::new(), stack: Vec::new() };
    writer.write(&spec, values)?;
    Ok(writer.out)
}

fn default_value(spec: &Value) -> Value {
    let (name, args) = match spec {
        Value::Str(name) => (name.clone(), Value::Null),
        Value::Arr(items) if !items.is_empty() => {
            (items[0].text(), items.get(1).cloned().unwrap_or(Value::Null))
        }
        _ => return Value::Num(0.0),
    };
    match name.as_str() {
        "bool" => Value::Bool(false),
        "pstring" => Value::str(""),
        "UUID" => Value::str("00000000-0000-0000-0000-000000000000"),
        "option" | "void" => Value::Null,
        "buffer" => {
            let length = args.get("count").filter(|c| !c.is_null()).map(|c| c.as_f64().unwrap_or(0.0) as usize).unwrap_or(0);
            Value::str(base64(&vec![0u8; length]))
        }
        "restBuffer" => Value::str(""),
        "container" => {
            let mut pairs = Vec::new();
            for field in args.as_arr() {
                if field.get("anon").map(|v| v.as_bool()).unwrap_or(false) {
                    continue;
                }
                let field_name = field.get("name").map(|v| v.text()).unwrap_or_default();
                let field_type = field.get("type").cloned().unwrap_or(Value::Null);
                pairs.push((field_name, default_value(&field_type)));
            }
            Value::Obj(pairs)
        }
        "array" => Value::Arr(Vec::new()),
        "bitflags" | "bitfield" => Value::Obj(Vec::new()),
        "mapper" => {
            let first = args
                .get("mappings")
                .and_then(|m| match m {
                    Value::Obj(pairs) => pairs.first().map(|(_, value)| value.clone()),
                    _ => None,
                })
                .unwrap_or(Value::Num(0.0));
            first
        }
        _ => Value::Num(0.0),
    }
}

/* ─────────────────────────── мелкие помощники ─────────────────────────── */

pub fn write_varint(out: &mut Vec<u8>, value: i32) {
    let mut v = value;
    loop {
        let byte = (v as u8) & 0x7f;
        v = ((v as u32) >> 7) as i32;
        if v == 0 {
            out.push(byte);
            break;
        }
        out.push(byte | 0x80);
    }
}

pub fn write_varlong(out: &mut Vec<u8>, value: i64) {
    let mut v = value as u64;
    loop {
        let byte = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(byte);
            break;
        }
        out.push(byte | 0x80);
    }
}

pub fn varint_bytes(value: i32) -> Vec<u8> {
    let mut out = Vec::new();
    write_varint(&mut out, value);
    out
}

/// Читает varint из начала буфера: значение и сколько байт занял.
pub fn read_varint(buf: &[u8]) -> Option<(i32, usize)> {
    let mut value: i32 = 0;
    let mut shift = 0;
    for (index, byte) in buf.iter().enumerate().take(5) {
        value |= ((byte & 0x7f) as i32) << shift;
        if byte & 0x80 == 0 {
            return Some((value, index + 1));
        }
        shift += 7;
    }
    None
}

fn base64(data: &[u8]) -> String {
    crate::b64::encode(data)
}

fn unbase64(text: &str) -> Vec<u8> {
    crate::b64::decode(text).unwrap_or_default()
}
