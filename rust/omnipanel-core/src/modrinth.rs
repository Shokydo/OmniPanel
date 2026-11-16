//! Modrinth: поиск плагинов и модов, версии под конкретный сервер,
//! скачивание файла сразу в `plugins/` или `mods/`.
//!
//! Ничего не хранит: работает напрямую с `api.modrinth.com`. Правила разбора
//! сервера (что это — моды или плагины, какая версия игры и загрузчик) взяты
//! из `core/modrinth.js` один в один, иначе панель предлагала бы не те файлы.

use crate::json::{self, Value};
use crate::net;
use std::path::{Path, PathBuf};

/// Адрес API. Меняется переменной окружения — так проверяются тесты.
pub fn api() -> String {
    std::env::var("OMNI_MODRINTH_API").unwrap_or_else(|_| "https://api.modrinth.com/v2".to_string())
}

/// Панель представляется Modrinth честно: их правила требуют имя и ссылку.
pub const USER_AGENT: &str = concat!(
    "OmniPanel/",
    env!("CARGO_PKG_VERSION"),
    " (github.com/Shokydo/OmniPanel)"
);

/// Сколько берём за один запрос.
const PAGE_LIMIT: usize = 40;

fn get(url: &str) -> Result<Value, String> {
    let reply = net::request_with_header("GET", url, Some(("User-Agent", USER_AGENT)), None)
        .map_err(|err| format!("Modrinth не ответил: {}", err))?;
    if reply.status != 200 {
        return Err(format!("Modrinth ответил {}", reply.status));
    }
    let value = json::parse(&reply.body).map_err(|_| "Ответ Modrinth не разобрать".to_string())?;
    Ok(value)
}

fn encode(text: &str) -> String {
    /* адресная кодировка: Modrinth не принимает «сырые» пробелы и кавычки */
    let mut out = String::new();
    for byte in text.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{:02X}", byte)),
        }
    }
    out
}

fn quoted_list(items: &[String]) -> String {
    /* Modrinth ждёт JSON-массив в адресе: ["fabric"] */
    let inner: Vec<String> = items.iter().map(|i| format!("\"{}\"", i.replace('"', ""))).collect();
    format!("[{}]", inner.join(","))
}

/// Вид проекта: `mod`, `plugin` или `datapack`.
fn kind_of(text: &str) -> &'static str {
    match text {
        "plugin" => "plugin",
        "datapack" => "datapack",
        _ => "mod",
    }
}

/// Поиск проектов. Опции те же, что в прежней панели.
pub fn search(opts: &Value) -> Value {
    search_at(&api(), opts)
}

/// Поиск по заданному адресу API (так его проверяют тесты).
pub fn search_at(base: &str, opts: &Value) -> Value {
    let text = |name: &str| opts.get(name).map(|v| v.text()).unwrap_or_default();
    let kind = kind_of(&text("type"));
    let mut facets: Vec<String> = vec![format!("[\"project_type:{}\"]", kind)];
    let loader = text("loader");
    if !loader.is_empty() {
        facets.push(format!("[\"categories:{}\"]", loader));
    }
    let version = text("version");
    if !version.is_empty() {
        facets.push(format!("[\"versions:{}\"]", version));
    }
    let category = text("category");
    if !category.is_empty() {
        facets.push(format!("[\"categories:{}\"]", category));
    }
    if text("side") == "server" {
        facets.push("[\"server_side:required\",\"server_side:optional\"]".to_string());
    }

    let sort = text("sort");
    let index = match sort.as_str() {
        "downloads" | "follows" | "newest" | "updated" => sort.clone(),
        _ => "relevance".to_string(),
    };
    let limit = opts
        .get("limit")
        .and_then(|v| v.as_f64())
        .map(|v| v as usize)
        .unwrap_or(20)
        .clamp(5, PAGE_LIMIT);
    let offset = opts
        .get("offset")
        .and_then(|v| v.as_f64())
        .map(|v| v.max(0.0) as usize)
        .unwrap_or(0);

    let url = format!(
        "{}/search?query={}&facets={}&index={}&limit={}&offset={}",
        base,
        encode(&text("query")),
        encode(&format!("[{}]", facets.join(","))),
        index,
        limit,
        offset
    );
    let data = match get(&url) {
        Ok(data) => data,
        Err(err) => return error(&err),
    };
    let total = data.get("total_hits").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let mut hits: Vec<Value> = Vec::new();
    for hit in data.get("hits").map(|v| v.as_arr().to_vec()).unwrap_or_default() {
        let id = hit
            .get("project_id")
            .map(|v| v.text())
            .filter(|v| !v.is_empty())
            .or_else(|| hit.get("slug").map(|v| v.text()))
            .unwrap_or_default();
        let versions: Vec<Value> = {
            let list = hit.get("versions").map(|v| v.as_arr().to_vec()).unwrap_or_default();
            let start = list.len().saturating_sub(6);
            list[start..].iter().cloned().collect()
        };
        hits.push(Value::obj(vec![
            ("id", Value::str(id)),
            ("slug", Value::str(hit.get("slug").map(|v| v.text()).unwrap_or_default())),
            ("title", Value::str(hit.get("title").map(|v| v.text()).unwrap_or_default())),
            ("description", Value::str(hit.get("description").map(|v| v.text()).unwrap_or_default())),
            ("author", Value::str(hit.get("author").map(|v| v.text()).unwrap_or_default())),
            ("icon", Value::str(hit.get("icon_url").map(|v| v.text()).unwrap_or_default())),
            ("downloads", hit.get("downloads").cloned().unwrap_or(Value::Num(0.0))),
            ("follows", hit.get("follows").cloned().unwrap_or(Value::Num(0.0))),
            (
                "categories",
                hit.get("categories").cloned().unwrap_or(Value::Arr(Vec::new())),
            ),
            ("versions", Value::Arr(versions)),
            ("updated", Value::str(hit.get("date_modified").map(|v| v.text()).unwrap_or_default())),
            ("type", Value::str(kind)),
        ]));
    }
    let total = if total > 0.0 { total } else { hits.len() as f64 };
    Value::obj(vec![
        ("ok", Value::Bool(true)),
        ("total", Value::Num(total)),
        ("hits", Value::Arr(hits)),
    ])
}

/// Версии проекта под загрузчик и версию игры.
pub fn versions(id: &str, opts: &Value) -> Value {
    versions_at(&api(), id, opts)
}

pub fn versions_at(base: &str, id: &str, opts: &Value) -> Value {
    let mut parts: Vec<String> = Vec::new();
    let loader = opts.get("loader").map(|v| v.text()).unwrap_or_default();
    if !loader.is_empty() {
        parts.push(format!("loaders={}", encode(&quoted_list(&[loader]))));
    }
    let version = opts.get("version").map(|v| v.text()).unwrap_or_default();
    if !version.is_empty() {
        parts.push(format!("game_versions={}", encode(&quoted_list(&[version]))));
    }
    let url = format!(
        "{}/project/{}/version{}",
        base,
        encode(id),
        if parts.is_empty() { String::new() } else { format!("?{}", parts.join("&")) }
    );
    let list = match get(&url) {
        Ok(list) => list,
        Err(err) => return error(&err),
    };
    let mut out: Vec<Value> = Vec::new();
    for version in list.as_arr().iter() {
        let files = version.get("files").map(|v| v.as_arr().to_vec()).unwrap_or_default();
        let primary = files
            .iter()
            .find(|f| f.get("primary").map(|v| v.as_bool()).unwrap_or(false))
            .or_else(|| files.first());
        let Some(file) = primary else { continue };
        out.push(Value::obj(vec![
            ("id", Value::str(version.get("id").map(|v| v.text()).unwrap_or_default())),
            ("name", Value::str(version.get("name").map(|v| v.text()).unwrap_or_default())),
            (
                "number",
                Value::str(version.get("version_number").map(|v| v.text()).unwrap_or_default()),
            ),
            (
                "type",
                Value::str(version.get("version_type").map(|v| v.text()).unwrap_or_default()),
            ),
            (
                "gameVersions",
                version.get("game_versions").cloned().unwrap_or(Value::Arr(Vec::new())),
            ),
            (
                "loaders",
                version.get("loaders").cloned().unwrap_or(Value::Arr(Vec::new())),
            ),
            (
                "date",
                Value::str(version.get("date_published").map(|v| v.text()).unwrap_or_default()),
            ),
            (
                "downloads",
                version.get("downloads").cloned().unwrap_or(Value::Num(0.0)),
            ),
            (
                "file",
                Value::obj(vec![
                    ("filename", Value::str(file.get("filename").map(|v| v.text()).unwrap_or_default())),
                    ("url", Value::str(file.get("url").map(|v| v.text()).unwrap_or_default())),
                    ("size", file.get("size").cloned().unwrap_or(Value::Num(0.0))),
                ]),
            ),
        ]));
    }
    Value::obj(vec![
        ("ok", Value::Bool(true)),
        ("versions", Value::Arr(out)),
    ])
}

/// Категории для фильтров.
pub fn categories(kind: &str) -> Value {
    categories_at(&api(), kind)
}

pub fn categories_at(base: &str, kind: &str) -> Value {
    let kind = kind_of(kind);
    let url = format!("{}/tag/category", base);
    let list = match get(&url) {
        Ok(list) => list,
        Err(err) => return error(&err),
    };
    let mut out: Vec<Value> = Vec::new();
    for category in list.as_arr().iter() {
        let project_type = category
            .get("project_type")
            .map(|v| v.text())
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| "mod".to_string());
        let name = category.get("name").map(|v| v.text()).unwrap_or_default();
        if project_type != kind || name.contains(':') {
            continue;
        }
        out.push(Value::obj(vec![
            ("name", Value::str(&name)),
            ("label", Value::str(&name)),
            ("icon", Value::str(category.get("icon").map(|v| v.text()).unwrap_or_default())),
        ]));
    }
    Value::obj(vec![
        ("ok", Value::Bool(true)),
        ("categories", Value::Arr(out)),
    ])
}

/* ─────────────────────── что внутри папки сервера ─────────────────────── */

/// Что у сервера внутри: папка plugins или mods, версия игры, загрузчик.
#[derive(Debug, Clone, PartialEq)]
pub struct Detected {
    pub dir: String,
    pub kind: String,
    pub folder: String,
    pub version: String,
    pub loader: String,
}

impl Default for Detected {
    fn default() -> Self {
        Detected {
            dir: String::new(),
            kind: "plugin".to_string(),
            folder: "plugins".to_string(),
            version: String::new(),
            loader: String::new(),
        }
    }
}

impl Detected {
    pub fn to_json(&self) -> Value {
        Value::obj(vec![
            ("dir", Value::str(&self.dir)),
            ("kind", Value::str(&self.kind)),
            ("folder", Value::str(&self.folder)),
            ("version", Value::str(&self.version)),
            ("loader", Value::str(&self.loader)),
        ])
    }
}

/// Смотрим папку сервера: имя jar-файлов подсказывает загрузчик, версия
/// берётся из `version_history.json`, журнала запуска или `libraries`.
pub fn detect(dir: &Path) -> Detected {
    let mut out = Detected {
        dir: dir.to_string_lossy().to_string(),
        ..Detected::default()
    };
    if !dir.is_dir() {
        return out;
    }
    let has_plugins = dir.join("plugins").is_dir();
    let has_mods = dir.join("mods").is_dir();
    let jars: Vec<String> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|name| name.to_lowercase().ends_with(".jar"))
                .collect()
        })
        .unwrap_or_default();
    let jar_text = jars.join(" ").to_lowercase();

    out.kind = if has_mods && !has_plugins {
        "mod".to_string()
    } else if has_plugins && !has_mods {
        "plugin".to_string()
    } else if has_mods && has_plugins {
        "mod".to_string()
    } else if ["fabric", "forge", "neoforge", "quilt"]
        .iter()
        .any(|mark| jar_text.contains(mark))
    {
        "mod".to_string()
    } else {
        "plugin".to_string()
    };
    out.folder = if out.kind == "mod" { "mods" } else { "plugins" }.to_string();

    out.loader = [
        "fabric", "neoforge", "forge", "quilt", "paper", "purpur", "spigot", "velocity", "bukkit",
    ]
    .iter()
    .find(|mark| jar_text.contains(**mark))
    .map(|mark| mark.to_string())
    .unwrap_or_default();

    /* версия: сначала файлы версий, потом журнал, потом библиотеки */
    out.version = version_from_json(dir)
        .or_else(|| version_from_logs(dir))
        .or_else(|| version_from_libraries(dir))
        .or_else(|| version_from_jars(&jars))
        .unwrap_or_default();
    out
}

fn first_version_number(text: &str) -> Option<String> {
    /* ищем что-то вида 1.20 или 1.20.4 */
    let bytes: Vec<char> = text.chars().collect();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index].is_ascii_digit() {
            let start = index;
            while index < bytes.len() && (bytes[index].is_ascii_digit() || bytes[index] == '.') {
                index += 1;
            }
            let candidate: String = bytes[start..index].iter().collect();
            let trimmed = candidate.trim_end_matches('.').to_string();
            if trimmed.contains('.') && trimmed.len() >= 3 {
                return Some(trimmed);
            }
        } else {
            index += 1;
        }
    }
    None
}

fn version_from_json(dir: &Path) -> Option<String> {
    for name in ["version_history.json", "version.json"] {
        let Ok(text) = std::fs::read_to_string(dir.join(name)) else { continue };
        let Ok(value) = json::parse(&text) else { continue };
        let candidate = value
            .get("currentVersion")
            .map(|v| v.text())
            .or_else(|| value.get("version").map(|v| v.text()))
            .or_else(|| {
                value
                    .get("versions")
                    .and_then(|v| v.as_arr().first())
                    .map(|v| v.text())
            })
            .unwrap_or_default();
        if let Some(found) = first_version_number(&candidate) {
            return Some(found);
        }
    }
    None
}

fn version_from_logs(dir: &Path) -> Option<String> {
    for rel in ["logs/latest.log", "logs/fml-server-latest.log", "log/latest.log"] {
        let Ok(text) = std::fs::read_to_string(dir.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR)))
        else {
            continue;
        };
        for marker in ["Starting minecraft server version", "Minecraft Version:", "Loading Minecraft"] {
            if let Some(position) = text.find(marker) {
                let tail: String = text[position + marker.len()..].chars().take(40).collect();
                if let Some(found) = first_version_number(&tail) {
                    return Some(found);
                }
            }
        }
    }
    None
}

/// Последняя подсказка — имя самого jar: `paper-1.20.4.jar`, `server-1.21.1.jar`.
fn version_from_jars(jars: &[String]) -> Option<String> {
    jars.iter().find_map(|name| first_version_number(name))
}

fn version_from_libraries(dir: &Path) -> Option<String> {
    let folder = dir.join("libraries").join("net").join("minecraft").join("server");
    let entries = std::fs::read_dir(folder).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some(found) = first_version_number(&name) {
            return Some(found);
        }
    }
    None
}

/// Что уже стоит у сервера в `plugins/` и `mods/`.
pub fn installed(dir: &Path) -> Value {
    let read = |folder: &str| -> Vec<Value> {
        let path = dir.join(folder);
        let Ok(entries) = std::fs::read_dir(path) else { return Vec::new() };
        let mut items: Vec<(String, u64)> = entries
            .flatten()
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().to_string();
                if !name.to_lowercase().ends_with(".jar") {
                    return None;
                }
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                Some((name, size))
            })
            .collect();
        items.sort_by(|a, b| a.0.cmp(&b.0));
        items
            .into_iter()
            .map(|(name, size)| {
                Value::obj(vec![("name", Value::str(name)), ("size", Value::from(size))])
            })
            .collect()
    };
    Value::obj(vec![
        ("ok", Value::Bool(true)),
        ("plugins", Value::Arr(read("plugins"))),
        ("mods", Value::Arr(read("mods"))),
    ])
}

/* ─────────────────────────── установка файла ─────────────────────────── */

/// Ставит проект на сервер: подбирает версию и кладёт файл в `plugins/`/`mods/`.
pub fn install(dir: &Path, opts: &Value) -> Value {
    install_at(&api(), dir, opts)
}

pub fn install_at(base: &str, dir: &Path, opts: &Value) -> Value {
    let info = detect(dir);
    if !dir.is_dir() {
        return error("Папка сервера не найдена");
    }
    let id = opts.get("id").map(|v| v.text()).unwrap_or_default();
    if id.trim().is_empty() {
        return error("Не указан проект Modrinth");
    }
    let loader = {
        let chosen = opts.get("loader").map(|v| v.text()).unwrap_or_default();
        if chosen.is_empty() { info.loader.clone() } else { chosen }
    };
    let version = {
        let chosen = opts.get("version").map(|v| v.text()).unwrap_or_default();
        if chosen.is_empty() { info.version.clone() } else { chosen }
    };

    let mut list = versions_at(base, &id, &Value::obj(vec![
        ("loader", Value::str(&loader)),
        ("version", Value::str(&version)),
    ]));
    let mut all: Vec<Value> = list.get("versions").map(|v| v.as_arr().to_vec()).unwrap_or_default();
    if all.is_empty() {
        /* под фильтры ничего не подошло — берём последнюю подходящую версию */
        list = versions_at(base, &id, &Value::Null);
        all = list.get("versions").map(|v| v.as_arr().to_vec()).unwrap_or_default();
    }
    if all.is_empty() {
        let reason = list
            .get("error")
            .map(|v| v.text())
            .unwrap_or_else(|| "У проекта нет файлов".to_string());
        return error(&reason);
    }
    let pick = all
        .iter()
        .find(|v| v.get("type").map(|t| t.text()) == Some("release".to_string()))
        .cloned()
        .unwrap_or_else(|| all[0].clone());

    let Some(file) = pick.get("file") else {
        return error("У версии нет файла");
    };
    let filename = file.get("filename").map(|v| v.text()).unwrap_or_default();
    let url = file.get("url").map(|v| v.text()).unwrap_or_default();
    if filename.is_empty() || url.is_empty() {
        return error("У версии нет файла для скачивания");
    }
    /* имя файла — только имя: адрес из сети не должен вести наружу */
    let safe = Path::new(&filename)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    if safe.is_empty() {
        return error("Неправильное имя файла");
    }
    let target = dir.join(&info.folder);
    if std::fs::create_dir_all(&target).is_err() {
        return error("Не удалось создать папку для файлов");
    }
    let dest: PathBuf = target.join(&safe);
    let part = PathBuf::from(format!("{}.part", dest.display()));
    let saved = net::download_with_header(&url, &part, Some(("User-Agent", USER_AGENT)))
        .and_then(|_| {
            std::fs::rename(&part, &dest).map_err(|err| format!("Не удалось сохранить файл: {}", err))
        });
    if let Err(err) = saved {
        let _ = std::fs::remove_file(&part);
        return error(&err);
    }
    Value::obj(vec![
        ("ok", Value::Bool(true)),
        ("path", Value::str(dest.to_string_lossy())),
        ("folder", Value::str(&info.folder)),
        ("file", Value::str(&safe)),
        ("version", Value::str(pick.get("number").map(|v| v.text()).unwrap_or_default())),
        (
            "gameVersions",
            pick.get("gameVersions").cloned().unwrap_or(Value::Arr(Vec::new())),
        ),
    ])
}

fn error(message: &str) -> Value {
    Value::obj(vec![
        ("ok", Value::Bool(false)),
        ("error", Value::str(message)),
    ])
}
