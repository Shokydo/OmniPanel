//! Приложение целиком: мост между интерфейсом и Rust.
//!
//! Интерфейс зовёт `window.desktop.*`, мост (`ui/tauri-bridge.js`) превращает
//! это в `ipc_invoke { channel, args }`, а здесь канал разбирается на модуль и
//! действие. Ничего не переписано «по-новому»: имена каналов, набор аргументов
//! и форма ответа — ровно те же, что были в Electron, иначе интерфейс сломается.
//!
//! Пока канал не перенесён, он отвечает понятной ошибкой по-русски —
//! панель не падает и не показывает пустоту.

use crate::b64;
use crate::files::{kind_of, Entry, FileError, Files, READ_LIMIT, WRITE_LIMIT};
use crate::ports;
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
    "archive:open",
    "archive:read",
    "archive:extract",
    "ports:own",
    "ports:check",
    "ports:free",
    "ports:set",
    "props:read",
    "props:write",
    "files:upload",
    "files:openExternal",
    "files:editor",
    "shell:openPath",
    "server:editor",
    "server:autoFolder",
    "bans:list",
    "bans:unban",
    "bans:ban",
    "tps:history",
    "tps:clear",
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
            "bans" => Ok(wrap_files(self.bans(action, args))),
            "tps" => self.tps(action, args),
            "archive" => Ok(wrap_files(self.archive(action, args))),
            "ports" => Ok(wrap_files(self.ports(action, args))),
            "props" => Ok(wrap_files(self.props(action, args))),
            "shell" => Ok(wrap_files(self.shell(action, args))),
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
            "editor" => {
                let root = self
                    .manager
                    .find(&id)
                    .map(|c| c.root_dir())
                    .unwrap_or_default();
                if root.is_empty() {
                    return Err("У сервера не задана рабочая папка".to_string());
                }
                open_in_system(&root)?;
                Ok(Value::obj(vec![("ok", Value::Bool(true))]))
            }
            "autoFolder" => {
                /* папка `server` рядом с программой — как в панели */
                let base = self.info.app_dir.clone();
                Ok(Value::str(base.join("server").to_string_lossy()))
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
            "upload" => {
                /* перетаскивание файлов в окно: байты приходят base64-строкой */
                let rel_dir = text(args, 1);
                let name = text(args, 2);
                let data = b64::decode(&text(args, 3))?;
                let safe_name = sanitize_name(&name)?;
                let target = if rel_dir.trim().is_empty() {
                    safe_name.clone()
                } else {
                    format!("{}/{}", rel_dir.trim_matches('/'), safe_name)
                };
                let size = files.write_bytes(&target, &data).map_err(file_err)?;
                Ok(Value::obj(vec![
                    ("ok", Value::Bool(true)),
                    ("name", Value::str(safe_name)),
                    ("rel", Value::str(target)),
                    ("size", Value::from(size)),
                ]))
            }
            "openExternal" => {
                let rel = text(args, 1);
                let path = files.resolve(&rel).map_err(file_err)?;
                open_in_system(&path.to_string_lossy())?;
                Ok(Value::obj(vec![("ok", Value::Bool(true))]))
            }
            "editor" => {
                let rel = text(args, 1);
                let path = files.resolve(&rel).map_err(file_err)?;
                open_in_system(&path.to_string_lossy())?;
                Ok(Value::obj(vec![("ok", Value::Bool(true))]))
            }
            other => Err(not_migrated("files", other)),
        }
    }

    /* ───────────── archive:* ───────────── */

    /// Архив целиком с диска: панель не открывает архивы больше 512 МБ.
    fn archive_bytes(&self, files: &Files, rel: &str) -> Result<Vec<u8>, String> {
        let (size, _) = files.meta(rel).map_err(file_err)?;
        if size > 512 * 1024 * 1024 {
            return Err("Архив больше 512 МБ — открой его архиватором".to_string());
        }
        files.read_bytes(rel).map_err(file_err)
    }

    fn archive(&self, action: &str, args: &[Value]) -> Result<Value, String> {
        let id = text(args, 0);
        let rel = text(args, 1);
        let files = self.files_of(&id)?;
        match action {
            "open" => {
                let name = rel.to_lowercase();
                if name.ends_with(".7z") {
                    return Err("7z панель пока не распаковывает сама — открой архив архиватором".to_string());
                }
                if !(name.ends_with(".zip")
                    || name.ends_with(".jar")
                    || name.ends_with(".mcpack")
                    || name.ends_with(".whl")
                    || name.ends_with(".epub"))
                {
                    return Err("Это не архив".to_string());
                }
                let data = self.archive_bytes(&files, &rel)?;
                let entries = crate::zip::list(&data)?;
                let raw: u64 = entries.iter().map(|e| e.size).sum();
                let list: Vec<Value> = entries
                    .iter()
                    .map(|e| {
                        Value::obj(vec![
                            ("name", Value::str(&e.name)),
                            ("size", Value::from(e.size)),
                            ("packed", Value::from(e.packed)),
                        ])
                    })
                    .collect();
                Ok(Value::obj(vec![
                    ("path", Value::str(&rel)),
                    ("size", Value::from(data.len() as u64)),
                    ("total", Value::from(entries.len())),
                    ("raw", Value::from(raw)),
                    ("entries", Value::Arr(list)),
                    ("format", Value::str("zip")),
                ]))
            }
            "read" => {
                let entry = text(args, 2);
                let data = self.archive_bytes(&files, &rel)?;
                let content = crate::zip::read_by_name(&data, &entry)?;
                describe_entry(&entry, &content)
            }
            "extract" => {
                let dest_rel = text(args, 2);
                let only = text(args, 3);
                let data = self.archive_bytes(&files, &rel)?;
                let dest = files.resolve(&dest_rel).map_err(file_err)?;
                std::fs::create_dir_all(&dest).map_err(|e| format!("не удалось создать папку: {}", e))?;
                let (count, bytes, names) = crate::zip::extract(&data, &dest, &only)?;
                let list: Vec<Value> = names.iter().take(20).map(|n| Value::str(n)).collect();
                Ok(Value::obj(vec![
                    ("files", Value::from(count)),
                    ("bytes", Value::from(bytes)),
                    ("list", Value::Arr(list)),
                    ("dest", Value::str(if dest_rel.is_empty() { "/" } else { &dest_rel })),
                ]))
            }
            other => Err(not_migrated("archive", other)),
        }
    }

    /* ───────────── bans:* и tps:* ───────────── */

    fn bans(&self, action: &str, args: &[Value]) -> Result<Value, String> {
        let id = text(args, 0);
        let files = self.files_of(&id)?;
        let dir = files.root().to_path_buf();
        let running = self.manager.state(&id) == ServerState::Running;
        match action {
            "list" => {
                let bans = crate::players::list(&dir);
                let entry = |b: &crate::players::BanEntry| {
                    Value::obj(vec![
                        ("kind", Value::str(&b.kind)),
                        ("name", Value::str(&b.name)),
                        ("uuid", Value::str(&b.uuid)),
                        ("ip", Value::str(&b.ip)),
                        ("reason", Value::str(&b.reason)),
                        ("source", Value::str(&b.source)),
                        ("created", Value::str(&b.created)),
                        ("expires", Value::str(&b.expires)),
                        ("until", Value::str(crate::players::until_human(b))),
                    ])
                };
                Ok(Value::obj(vec![
                    ("players", Value::Arr(bans.players.iter().map(entry).collect())),
                    ("ips", Value::Arr(bans.ips.iter().map(entry).collect())),
                ]))
            }
            "unban" => {
                let target = args.get(1).cloned().unwrap_or(Value::Obj(Vec::new()));
                let name = target.get("name").map(|v| v.text()).unwrap_or_default();
                let ip = target.get("ip").map(|v| v.text()).unwrap_or_default();
                if running {
                    /* на запущенном сервере команду выполняет ядро — оно и файл перепишет */
                    let command = if ip.is_empty() {
                        format!("unban {}", name)
                    } else {
                        format!("pardon-ip {}", ip)
                    };
                    self.manager.command(&id, &command)?;
                    return Ok(Value::obj(vec![("ok", Value::Bool(true)), ("byCommand", Value::str(command))]));
                }
                let removed = crate::players::unban(&dir, &name, &ip)?;
                Ok(Value::obj(vec![("ok", Value::Bool(true)), ("removed", Value::from(removed))]))
            }
            "ban" => {
                let target = args.get(1).cloned().unwrap_or(Value::Obj(Vec::new()));
                let name = target.get("name").map(|v| v.text()).unwrap_or_default();
                let ip = target.get("ip").map(|v| v.text()).unwrap_or_default();
                let reason = target.get("reason").map(|v| v.text()).unwrap_or_default();
                if name.trim().is_empty() && ip.trim().is_empty() {
                    return Err("Не выбран игрок для блокировки".to_string());
                }
                if running {
                    let command = if ip.is_empty() {
                        if reason.is_empty() {
                            format!("ban {}", name)
                        } else {
                            format!("ban {} {}", name, reason)
                        }
                    } else if reason.is_empty() {
                        format!("ban-ip {}", ip)
                    } else {
                        format!("ban-ip {} {}", ip, reason)
                    };
                    self.manager.command(&id, &command)?;
                    return Ok(Value::obj(vec![("ok", Value::Bool(true)), ("byCommand", Value::str(command))]));
                }
                crate::players::add(&dir, &name, &ip, &reason)?;
                Ok(Value::obj(vec![("ok", Value::Bool(true))]))
            }
            other => Err(not_migrated("bans", other)),
        }
    }

    fn tps(&self, action: &str, args: &[Value]) -> Result<Value, String> {
        let id = text(args, 0);
        match action {
            "history" => {
                let points = self.manager.tps_history(&id);
                Ok(Value::Arr(points.iter().map(|p| p.to_json()).collect()))
            }
            "clear" => {
                self.manager.clear_tps(&id);
                Ok(Value::Bool(true))
            }
            other => Err(not_migrated("tps", other)),
        }
    }

    /* ───────────── ports:* ───────────── */

    fn props_text(&self, files: &Files) -> String {
        files.read_text("server.properties").unwrap_or_default()
    }

    /// Чужие занятые порты для проверки: только запущенные серверы панели.
    fn busy_ports(&self, except: &str) -> Vec<(String, String, Vec<(String, u16)>)> {
        let mut out = Vec::new();
        for cfg in self.manager.servers() {
            if cfg.id == except || self.manager.state(&cfg.id) == ServerState::Stopped {
                continue;
            }
            let root = cfg.root_dir();
            if root.is_empty() {
                continue;
            }
            let text = Files::new(&root).read_text("server.properties").unwrap_or_default();
            let list: Vec<(String, u16)> =
                ports::own(&text).into_iter().map(|p| (p.key, p.port)).collect();
            out.push((cfg.id, cfg.name, list));
        }
        out
    }

    fn ports(&self, action: &str, args: &[Value]) -> Result<Value, String> {
        let id = text(args, 0);
        let files = self.files_of(&id)?;
        match action {
            "own" => {
                let list: Vec<Value> = ports::own(&self.props_text(&files))
                    .into_iter()
                    .map(|p| {
                        Value::obj(vec![
                            ("key", Value::str(p.key)),
                            ("label", Value::str(p.label)),
                            ("port", Value::from(p.port as u64)),
                        ])
                    })
                    .collect();
                Ok(Value::obj(vec![("ports", Value::Arr(list))]))
            }
            "check" => {
                let report = ports::check_all(&self.props_text(&files), &self.busy_ports(&id));
                let ports_json: Vec<Value> = report
                    .ports
                    .iter()
                    .map(|p| {
                        Value::obj(vec![
                            ("key", Value::str(&p.key)),
                            ("label", Value::str(&p.label)),
                            ("port", Value::from(p.port as u64)),
                        ])
                    })
                    .collect();
                let conflicts_json: Vec<Value> = report
                    .conflicts
                    .iter()
                    .map(|c| {
                        Value::obj(vec![
                            ("key", Value::str(&c.key)),
                            ("label", Value::str(&c.label)),
                            ("port", Value::from(c.port as u64)),
                            ("serverId", Value::str(&c.server_id)),
                            ("serverName", Value::str(&c.server_name)),
                            ("otherKey", Value::str(&c.other_key)),
                        ])
                    })
                    .collect();
                /* для занятого порта сразу предлагаем свободный — панель показывает
                 * уведомление с кнопкой «сменить порт», и ей нужно значение */
                let taken: Vec<u16> = report.ports.iter().map(|p| p.port).collect();
                let busy_json: Vec<Value> = report
                    .busy
                    .iter()
                    .map(|b| {
                        let suggestion = report.suggestion(b.port, &taken);
                        Value::obj(vec![
                            ("key", Value::str(&b.key)),
                            ("label", Value::str(&b.label)),
                            ("port", Value::from(b.port as u64)),
                            ("reason", Value::str("other-app")),
                            (
                                "suggest",
                                suggestion.map(|p| Value::from(p as u64)).unwrap_or(Value::Null),
                            ),
                        ])
                    })
                    .collect();
                Ok(Value::obj(vec![
                    ("ports", Value::Arr(ports_json)),
                    ("conflicts", Value::Arr(conflicts_json)),
                    ("busy", Value::Arr(busy_json)),
                ]))
            }
            "free" => {
                let from = text(args, 1).parse::<u16>().unwrap_or(25565);
                let taken: Vec<u16> = self.busy_ports(&id)
                    .iter()
                    .flat_map(|(_, _, list)| list.iter().map(|(_, p)| *p))
                    .collect();
                let mut candidate = from.max(1024);
                let mut found = 0u16;
                for _ in 0..300 {
                    if candidate >= 65535 {
                        break;
                    }
                    if !taken.contains(&candidate) && !ports::is_busy(candidate) {
                        found = candidate;
                        break;
                    }
                    candidate += 1;
                }
                Ok(Value::obj(vec![
                    ("port", Value::from(found as u64)),
                    ("ok", Value::Bool(found > 0)),
                ]))
            }
            "set" => {
                let key = text(args, 1);
                let port = text(args, 2).parse::<u16>().unwrap_or(0);
                let known = ports::SERVER_PORTS.iter().any(|(k, _, _, _)| *k == key);
                if !known {
                    return Err("Такой порт панель не меняет".to_string());
                }
                if port == 0 {
                    return Err("Порт должен быть от 1 до 65535".to_string());
                }
                let old = self.props_text(&files);
                let patch: std::collections::BTreeMap<String, String> =
                    [(key.clone(), port.to_string())].into_iter().collect();
                let parsed = crate::props::PropsFile::parse(&old);
                let text_new = parsed.apply(&patch, &["enable-query", "enable-rcon"]);
                files.write_text("server.properties", &text_new).map_err(file_err)?;
                Ok(Value::obj(vec![
                    ("key", Value::str(&key)),
                    ("port", Value::from(port as u64)),
                ]))
            }
            other => Err(not_migrated("ports", other)),
        }
    }

    /* ───────────── props:* и shell:* ───────────── */

    fn props(&self, action: &str, args: &[Value]) -> Result<Value, String> {
        let id = text(args, 0);
        let files = self.files_of(&id)?;
        match action {
            "read" => {
                let text_props = self.props_text(&files);
                if text_props.is_empty() {
                    return Ok(Value::obj(vec![
                        ("exists", Value::Bool(false)),
                        ("path", Value::str("server.properties")),
                        ("props", Value::Obj(Vec::new())),
                        ("other", Value::Obj(Vec::new())),
                    ]));
                }
                let parsed = crate::props::PropsFile::parse(&text_props);
                let view = crate::props::Props::parse(&text_props).view();
                let props: Vec<(String, Value)> = view
                    .into_iter()
                    .map(|(k, v)| (k, v.map(Value::Str).unwrap_or(Value::Null)))
                    .collect();
                let other: Vec<(String, Value)> = parsed
                    .extra(&crate::props::Props::all_keys())
                    .into_iter()
                    .map(|(k, v)| (k, Value::Str(v)))
                    .collect();
                Ok(Value::obj(vec![
                    ("exists", Value::Bool(true)),
                    ("path", Value::str("server.properties")),
                    ("props", Value::Obj(props)),
                    ("other", Value::Obj(other)),
                ]))
            }
            "write" => {
                let patch_value = args.get(1).cloned().unwrap_or(Value::Obj(Vec::new()));
                let Value::Obj(pairs) = patch_value else {
                    return Err("Настройки пришли в неверном виде".to_string());
                };
                let patch: std::collections::BTreeMap<String, String> =
                    pairs.into_iter().map(|(k, v)| (k, v.text())).collect();
                let old = self.props_text(&files);
                let parsed = crate::props::PropsFile::parse(&old);
                let text_new = parsed.apply(&patch, &["enable-query", "enable-rcon"]);
                files.write_text("server.properties", &text_new).map_err(file_err)?;
                Ok(Value::obj(vec![
                    ("ok", Value::Bool(true)),
                    ("path", Value::str("server.properties")),
                ]))
            }
            other => Err(not_migrated("props", other)),
        }
    }

    fn shell(&self, action: &str, args: &[Value]) -> Result<Value, String> {
        match action {
            "openPath" => {
                let path = text(args, 0);
                if path.is_empty() {
                    return Err("Путь не указан".to_string());
                }
                if !std::path::Path::new(&path).exists() {
                    return Err(format!("Папка не найдена: {}", path));
                }
                open_in_system(&path)?;
                Ok(Value::obj(vec![("ok", Value::Bool(true))]))
            }
            other => Err(not_migrated("shell", other)),
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

/// Ответ на чтение файла из архива — как `describeEntry` в панели.
fn describe_entry(name: &str, content: &[u8]) -> Result<Value, String> {
    let lower = name.to_lowercase();
    let is_image = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico"]
        .iter()
        .any(|ext| lower.ends_with(ext));
    if is_image {
        const MAX_ENTRY_IMAGE: u64 = 8 * 1024 * 1024;
        if content.len() as u64 > MAX_ENTRY_IMAGE {
            return Err("Картинка слишком большая для просмотра".to_string());
        }
        let mime = if lower.ends_with(".png") {
            "image/png"
        } else if lower.ends_with(".gif") {
            "image/gif"
        } else if lower.ends_with(".webp") {
            "image/webp"
        } else if lower.ends_with(".bmp") {
            "image/bmp"
        } else {
            "image/jpeg"
        };
        return Ok(Value::obj(vec![
            ("kind", Value::str("image")),
            ("name", Value::str(name)),
            ("size", Value::from(content.len())),
            ("dataUrl", Value::str(format!("data:{};base64,{}", mime, b64::encode(content)))),
        ]));
    }
    if content[..content.len().min(8000)].contains(&0) {
        return Err("Двоичный файл — можно только распаковать".to_string());
    }
    Ok(Value::obj(vec![
        ("kind", Value::str("text")),
        ("name", Value::str(name)),
        ("size", Value::from(content.len())),
        ("content", Value::str(crate::files::decode_bytes(content))),
    ]))
}

/// Имя файла без разделителей пути — чтобы перетаскивание не писало куда попало.
fn sanitize_name(name: &str) -> Result<String, String> {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("").trim();
    let clean: String = base
        .chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) { '_' } else { c })
        .collect();
    if clean.is_empty() {
        return Err("Пустое имя файла".to_string());
    }
    Ok(clean)
}

/// Открыть файл или папку тем, чем это делает система.
fn open_in_system(path: &str) -> Result<(), String> {
    #[cfg(windows)]
    let result = std::process::Command::new("cmd").args(["/C", "start", "", path]).spawn();
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(path).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(path).spawn();
    result.map(|_| ()).map_err(|e| format!("не удалось открыть: {}", e))
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
        ("dataUrl", Value::str(format!("data:{};base64,{}", mime, b64::encode(&bytes)))),
    ]))
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
