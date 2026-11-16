//! Приложение целиком: мост между интерфейсом и Rust.
//!
//! Интерфейс зовёт `window.desktop.*`, мост (`ui/tauri-bridge.js`) превращает
//! это в `ipc_invoke { channel, args }`, а здесь канал разбирается на модуль и
//! действие. Ничего не переписано «по-новому»: имена каналов, набор аргументов
//! и форма ответа — ровно те же, что были в Electron, иначе интерфейс сломается.
//!
//! Пока канал не перенесён, он отвечает понятной ошибкой по-русски —
//! панель не падает и не показывает пустоту.

use crate::files::{kind_of, Entry, FileError, Files, READ_LIMIT, WRITE_LIMIT};
use crate::json::Value;
use crate::servers::{Manager, ServerConfig, ServerState, Store};
use std::path::PathBuf;
use std::sync::Mutex;

/// Настройки запуска: всё, что панель показывает в «О программе».
#[derive(Debug, Clone)]
pub struct AppInfo {
    pub version: String,
    pub platform: String,
    pub data_dir: PathBuf,
    pub config_path: PathBuf,
    pub app_dir: PathBuf,
    pub sep: String,
}

impl Default for AppInfo {
    fn default() -> Self {
        AppInfo {
            version: env!("CARGO_PKG_VERSION").to_string(),
            platform: std::env::consts::OS.to_string(),
            data_dir: PathBuf::from("."),
            config_path: PathBuf::from("servers.json"),
            app_dir: PathBuf::from("."),
            sep: if cfg!(windows) { "\\".to_string() } else { "/".to_string() },
        }
    }
}

impl AppInfo {
    fn to_json(&self) -> Value {
        Value::obj(vec![
            ("version", Value::str(&self.version)),
            ("configPath", Value::str(self.config_path.to_string_lossy())),
            ("platform", Value::str(&self.platform)),
            ("mode", Value::str("desktop")),
            ("dataDir", Value::str(self.data_dir.to_string_lossy())),
            ("home", Value::str(self.data_dir.to_string_lossy())),
            ("sep", Value::str(&self.sep)),
            ("packaged", Value::Bool(true)),
            ("appDir", Value::str(self.app_dir.to_string_lossy())),
            ("rust", Value::Bool(true)),
        ])
    }
}

/// Панель: менеджер серверов, хранилище настроек и разбор каналов.
pub struct App {
    manager: Manager,
    /// `None` — настройки не сохраняются на диск (удобно в тестах).
    store: Mutex<Option<Store>>,
    info: AppInfo,
    /// Последняя ошибка сохранения настроек, если она была.
    last_save_error: Mutex<Option<String>>,
}

/// Какие каналы уже живут в Rust. Список нужен и тестам, и генератору моста:
/// расхождение между ними — это сломанная кнопка в интерфейсе.
pub const READY_CHANNELS: &[&str] = &[
    "app:info",
    "servers:list",
    "servers:add",
    "servers:update",
    "servers:remove",
    "servers:reorder",
    "servers:startAll",
    "servers:stopAll",
    "servers:restartAll",
    "server:start",
    "server:stop",
    "server:restart",
    "server:kill",
    "server:command",
    "server:logs",
    "server:clearLogs",
    "files:list",
    "files:read",
    "files:write",
    "files:mkdir",
    "files:remove",
    "files:rename",
    "files:search",
    "files:move",
    "files:image",
    "path:check",
];

impl App {
    pub fn new(info: AppInfo) -> App {
        App {
            manager: Manager::new(),
            store: Mutex::new(None),
            info,
            last_save_error: Mutex::new(None),
        }
    }

    /// Панель с сохранением настроек: сразу читает `servers.json`.
    pub fn with_store(info: AppInfo, store: Store) -> App {
        let app = App::new(info);
        let list = store.load();
        app.manager.set_servers(list);
        *app.store.lock().unwrap() = Some(store);
        app
    }

    pub fn manager(&self) -> Manager {
        self.manager.clone()
    }

    pub fn info(&self) -> &AppInfo {
        &self.info
    }

    pub fn last_save_error(&self) -> Option<String> {
        self.last_save_error.lock().unwrap().clone()
    }

    fn persist(&self) {
        let guard = self.store.lock().unwrap();
        if let Some(store) = guard.as_ref() {
            if let Err(err) = store.save(&self.manager.servers()) {
                *self.last_save_error.lock().unwrap() = Some(format!("настройки не сохранены: {}", err));
            }
        }
    }

    /// Точка входа для Tauri: `ipc_invoke { channel, args }` → ответ.
    pub fn invoke(&self, channel: &str, args: &[Value]) -> Result<Value, String> {
        let (module, action) = channel
            .split_once(':')
            .ok_or_else(|| format!("канал «{}» назван неправильно", channel))?;
        match module {
            "servers" => self.servers(action, args),
            "server" => self.server(action, args),
            /* файловые каналы в панели никогда не бросают ошибку наружу:
             * `fsWrap` отдаёт `{ ok: false, error }`, и интерфейс смотрит именно
             * на `ok`. Здесь так же — иначе кнопки молча перестанут работать. */
            "files" => Ok(wrap_files(self.files(action, args))),
            "app" => self.app(action, args),
            "path" => self.path(action, args),
            _ => Err(format!(
                "команда «{}» ещё не перенесена в Rust — она появится в следующем шаге",
                channel
            )),
        }
    }

    /* ───────────── servers:* ───────────── */

    fn servers(&self, action: &str, args: &[Value]) -> Result<Value, String> {
        match action {
            "list" => Ok(self.manager.list_json()),
            "add" => {
                let mut cfg = ServerConfig::from_json(&args[0]);
                if cfg.id.trim().is_empty() {
                    cfg.id = new_id();
                }
                let cfg = self.manager.add(cfg);
                self.persist();
                Ok(cfg.to_json())
            }
            "update" => {
                let id = text(args, 0);
                let patch = ServerConfig::from_json(&args[1]);
                let cfg = self
                    .manager
                    .update(&id, patch)
                    .ok_or_else(|| "сервер не найден".to_string())?;
                self.persist();
                Ok(cfg.to_json())
            }
            "remove" => {
                let ok = self.manager.remove(&text(args, 0));
                self.persist();
                Ok(Value::Bool(ok))
            }
            "reorder" => {
                let ids: Vec<String> = args.first().map(|v| v.as_arr().iter().map(|x| x.text()).collect()).unwrap_or_default();
                self.manager.reorder(&ids);
                self.persist();
                Ok(Value::Bool(true))
            }
            "startAll" => {
                for cfg in self.manager.servers() {
                    let _ = self.manager.start(&cfg.id);
                }
                Ok(self.manager.list_json())
            }
            "stopAll" => {
                for cfg in self.manager.servers() {
                    if self.manager.state(&cfg.id) != ServerState::Stopped {
                        self.manager.stop(&cfg.id);
                    }
                }
                Ok(self.manager.list_json())
            }
            "restartAll" => {
                for cfg in self.manager.servers() {
                    if self.manager.state(&cfg.id) != ServerState::Stopped {
                        let _ = self.manager.restart(&cfg.id);
                    }
                }
                Ok(self.manager.list_json())
            }
            other => Err(not_migrated("servers", other)),
        }
    }

    /* ───────────── server:* ───────────── */

    fn server(&self, action: &str, args: &[Value]) -> Result<Value, String> {
        let id = text(args, 0);
        let _ = &id;
        match action {
            "start" => {
                self.manager.start(&id)?;
                Ok(self.manager.status_json(&id))
            }
            "stop" => {
                self.manager.stop(&id);
                Ok(self.manager.status_json(&id))
            }
            "restart" => {
                self.manager.restart(&id)?;
                Ok(self.manager.status_json(&id))
            }
            "kill" => {
                self.manager.kill(&id);
                Ok(self.manager.status_json(&id))
            }
            "command" => {
                self.manager.command(&id, &text(args, 1))?;
                Ok(Value::Bool(true))
            }
            "logs" => {
                let lines = self.manager.logs(&id);
                Ok(Value::Arr(lines.into_iter().map(Value::Str).collect()))
            }
            "clearLogs" => {
                self.manager.clear_logs(&id);
                Ok(Value::Bool(true))
            }
            other => Err(not_migrated("server", other)),
        }
    }

    /* ───────────── files:* ───────────── */

    /// Папка сервера: сначала `cwd` из настроек, потом `dir`.
    fn files_of(&self, id: &str) -> Result<Files, String> {
        let cfg = self
            .manager
            .find(id)
            .ok_or_else(|| "сервер не найден — открой список серверов".to_string())?;
        let root = cfg.root_dir();
        if root.trim().is_empty() {
            return Err("У сервера не задана рабочая папка".to_string());
        }
        Ok(Files::new(root))
    }

    fn files(&self, action: &str, args: &[Value]) -> Result<Value, String> {
        let id = text(args, 0);
        let files = self.files_of(&id)?;
        match action {
            "list" => {
                let rel = text(args, 1);
                let items = files.list(&rel).map_err(file_err)?;
                Ok(Value::obj(vec![
                    ("path", Value::str(rel.trim_matches('/'))),
                    ("items", Value::Arr(items.iter().map(entry_json).collect())),
                ]))
            }
            "read" => {
                let rel = text(args, 1);
                read_for_editor(&files, &rel)
            }
            "write" => {
                let rel = text(args, 1);
                let content = text(args, 2);
                if content.as_bytes().len() as u64 > WRITE_LIMIT {
                    return Err("Слишком большой файл для записи".to_string());
                }
                let size = files.write_text(&rel, &content).map_err(file_err)?;
                let meta = files.meta(&rel).map_err(file_err)?;
                Ok(Value::obj(vec![
                    ("ok", Value::Bool(true)),
                    ("path", Value::str(&rel)),
                    ("size", Value::from(size)),
                    ("mtime", Value::from(meta.1)),
                ]))
            }
            "mkdir" => {
                let rel = text(args, 1);
                files.mkdir(&rel).map_err(file_err)?;
                Ok(Value::obj(vec![("ok", Value::Bool(true)), ("path", Value::str(rel))]))
            }
            "remove" => {
                let rel = text(args, 1);
                files.remove(&rel).map_err(file_err)?;
                Ok(Value::obj(vec![("ok", Value::Bool(true))]))
            }
            "rename" => {
                let rel = text(args, 1);
                let name = text(args, 2);
                let path = files.rename(&rel, &name).map_err(file_err)?;
                Ok(Value::obj(vec![
                    ("ok", Value::Bool(true)),
                    ("path", Value::str(path)),
                    ("renamed", Value::Bool(true)),
                ]))
            }
            "search" => {
                let query = text(args, 1);
                let results = files.search(&query, 400).map_err(file_err)?;
                Ok(Value::obj(vec![("results", Value::Arr(results.iter().map(entry_json).collect()))]))
            }
            "move" => {
                let from = text(args, 1);
                let to_dir = text(args, 2);
                let path = files.move_to(&from, &to_dir).map_err(file_err)?;
                Ok(Value::obj(vec![("ok", Value::Bool(true)), ("path", Value::str(path))]))
            }
            "image" => {
                let rel = text(args, 1);
                image_json(&files, &rel)
            }
            other => Err(not_migrated("files", other)),
        }
    }

    /* ───────────── app:* и path:* ───────────── */

    fn app(&self, action: &str, _args: &[Value]) -> Result<Value, String> {
        match action {
            "info" => Ok(self.info.to_json()),
            other => Err(not_migrated("app", other)),
        }
    }

    fn path(&self, action: &str, args: &[Value]) -> Result<Value, String> {
        match action {
            "check" => {
                let path = PathBuf::from(text(args, 0));
                let meta = std::fs::metadata(&path);
                Ok(match meta {
                    Ok(m) => Value::obj(vec![
                        ("exists", Value::Bool(true)),
                        ("isDir", Value::Bool(m.is_dir())),
                        ("isFile", Value::Bool(m.is_file())),
                    ]),
                    Err(_) => Value::obj(vec![("exists", Value::Bool(false))]),
                })
            }
            other => Err(not_migrated("path", other)),
        }
    }
}

/* ───────────── помощники ───────────── */

/// Ответ файлового канала в том же виде, что у прежней панели.
fn wrap_files(result: Result<Value, String>) -> Value {
    match result {
        Ok(Value::Obj(mut pairs)) => {
            if !pairs.iter().any(|(k, _)| k == "ok") {
                pairs.insert(0, ("ok".to_string(), Value::Bool(true)));
            }
            Value::Obj(pairs)
        }
        Ok(other) => Value::obj(vec![("ok", Value::Bool(true)), ("result", other)]),
        Err(err) => Value::obj(vec![("ok", Value::Bool(false)), ("error", Value::str(err))]),
    }
}

fn not_migrated(module: &str, action: &str) -> String {
    format!(
        "команда «{}:{}» ещё не перенесена в Rust — она появится в следующем шаге",
        module, action
    )
}

fn text(args: &[Value], index: usize) -> String {
    args.get(index).map(|v| v.text()).unwrap_or_default()
}

fn file_err(err: FileError) -> String {
    match &err {
        FileError::Outside(_) => "Путь вне папки сервера — отказано".to_string(),
        FileError::NotFound(p) => format!("Не найдено: {}", p),
        FileError::WrongType(p) => format!("Это папка, а не файл: {}", p),
        FileError::TooLarge(n) => {
            format!("Файл больше {} МБ — редактор его не откроет", n / 1048576)
        }
        FileError::Io(e) => format!("Ошибка файловой системы: {}", e),
    }
}

fn entry_json(entry: &Entry) -> Value {
    let ext = match entry.name.rsplit_once('.') {
        Some((_, e)) if !entry.name.starts_with('.') => format!(".{}", e.to_lowercase()),
        _ => String::new(),
    };
    Value::obj(vec![
        ("name", Value::str(&entry.name)),
        ("path", Value::str(&entry.rel)),
        ("isDir", Value::Bool(entry.dir)),
        ("size", Value::from(entry.size)),
        ("mtime", Value::from(entry.modified)),
        ("kind", Value::str(if entry.dir { "dir" } else { kind_of(&entry.name) })),
        ("ext", Value::str(ext)),
    ])
}

/// Чтение файла в редактор — с теми же ответами, что были в панели.
fn read_for_editor(files: &Files, rel: &str) -> Result<Value, String> {
    let (size, mtime) = files.meta(rel).map_err(file_err)?;
    if size > READ_LIMIT {
        return Err(format!(
            "Файл больше {} МБ — редактор его не откроет",
            READ_LIMIT / 1048576
        ));
    }
    let kind = kind_of(rel);
    if matches!(kind, "image" | "archive" | "archive-other") {
        let hint = match kind {
            "image" => "Картинка — открою в просмотрщике",
            "archive" => "Архив — покажу содержимое",
            _ => "Этот формат архива не поддерживается",
        };
        return Ok(Value::obj(vec![
            ("path", Value::str(rel)),
            ("kind", Value::str(kind)),
            ("size", Value::from(size)),
            ("binary", Value::Bool(true)),
            ("content", Value::str("")),
            ("message", Value::str(hint)),
        ]));
    }
    let bytes = files.read_bytes(rel).map_err(file_err)?;
    let probe = &bytes[..bytes.len().min(8000)];
    if matches!(kind, "binary") || probe.contains(&0) {
        return Ok(Value::obj(vec![
            ("path", Value::str(rel)),
            ("kind", Value::str("binary")),
            ("size", Value::from(size)),
            ("binary", Value::Bool(true)),
            ("content", Value::str("")),
            ("message", Value::str("Двоичный файл — редактирование недоступно")),
        ]));
    }
    let text = crate::files::decode_bytes(&bytes);
    let text = text.strip_prefix('\u{FEFF}').map(|t| t.to_string()).unwrap_or(text);
    Ok(Value::obj(vec![
        ("path", Value::str(rel)),
        ("kind", Value::str(kind)),
        ("size", Value::from(size)),
        ("mtime", Value::from(mtime)),
        ("binary", Value::Bool(false)),
        ("content", Value::str(text.clone())),
        ("lines", Value::from(text.split('\n').count())),
    ]))
}

fn image_json(files: &Files, rel: &str) -> Result<Value, String> {
    let (size, mtime) = files.meta(rel).map_err(file_err)?;
    const IMAGE_LIMIT: u64 = 12 * 1024 * 1024;
    if size > IMAGE_LIMIT {
        return Err(format!("Картинка больше {} МБ — не показываю", IMAGE_LIMIT / 1048576));
    }
    let bytes = files.read_bytes(rel).map_err(file_err)?;
    let mime = match rel.rsplit_once('.').map(|(_, e)| e.to_lowercase()).unwrap_or_default().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    };
    Ok(Value::obj(vec![
        ("path", Value::str(rel)),
        ("kind", Value::str("image")),
        ("size", Value::from(size)),
        ("mtime", Value::from(mtime)),
        ("dataUrl", Value::str(format!("data:{};base64,{}", mime, base64(&bytes)))),
    ]))
}

fn base64(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(triple >> 18) as usize & 63] as char);
        out.push(TABLE[(triple >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(triple >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[triple as usize & 63] as char } else { '=' });
    }
    out
}

/// Идентификатор нового сервера. Без внешних крейтов: время + счётчик.
fn new_id() -> String {
    use std::sync::atomic::{AtomicU32, Ordering};
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{:x}-{:04x}", now, n & 0xffff)
}
