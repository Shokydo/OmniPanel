//! Приложение целиком: мост между интерфейсом и Rust.
//!
//! Интерфейс зовёт `window.desktop.*`, мост (`ui/tauri-bridge.js`) превращает
//! это в `ipc_invoke { channel, args }`, а здесь канал разбирается на модуль и
//! действие. Ничего не переписано «по-новому»: имена каналов, набор аргументов
//! и форма ответа — ровно те же, что были в Electron, иначе интерфейс сломается.
//!
//! Пока канал не перенесён, он отвечает понятной ошибкой по-русски —
//! панель не падает и не показывает пустоту.

use crate::ask::Ask;
use crate::autostart;
use crate::backup;
use crate::notify;
use crate::wall;
use crate::b64;
use crate::dialog;
use crate::image;
use crate::scan::{self, Scanner};
use crate::files::{kind_of, Entry, FileError, Files, READ_LIMIT, WRITE_LIMIT};
use crate::ports;
use crate::sync::{self, Options, Provider, Sync};
use crate::update::Updater;
use crate::window::{WindowBridge, WindowCommand};
use crate::json::Value;
use crate::servers::{Manager, ServerConfig, ServerState, Store};
use std::path::{Path, PathBuf};
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
    /// Мост к окну (в HTTP-режиме без окна просто копит команды).
    window: Mutex<WindowBridge>,
    /// Поиск серверов на дисках: его можно отменить из интерфейса.
    scanner: Scanner,
    /// Куда панель отправляет события: окно, поток событий в браузере.
    event_sinks: Mutex<Vec<Box<dyn Fn(&str, &str) + Send + std::marker::Sync>>>,
    /// Свои окна вопросов вместо системных.
    ask: Ask,
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
    "win:minimize",
    "win:close",
    "win:quit",
    "win:toggleMax",
    "win:toggleFull",
    "win:show",
    "win:isVisible",
    "win:state",
    "win:getStartMode",
    "win:setStartMode",
    "bans:list",
    "bans:unban",
    "bans:ban",
    "tps:history",
    "tps:clear",
    "gh:account",
    "gh:login",
    "gh:logout",
    "gh:verify",
    "gh:check",
    "gh:push",
    "gh:pull",
    "gh:status",
    "gh:forget",
    "gh:repos",
    "gh:createRepo",
    "gh:download",
    "gh:openExternal",
    "gh:oauthClientId",
    "gh:setOauthClientId",
    "gh:deviceStart",
    "gh:devicePoll",
    "gl:account",
    "gl:check",
    "gl:projects",
    "gl:save",
    "upd:config",
    "upd:save",
    "upd:check",
    "upd:apply",
    "upd:auto",
    "upd:downloadFull",
    "upd:revealBackups",
    "scan:roots",
    "scan:start",
    "scan:cancel",
    "dialog:pickFolder",
    "dialog:pickFile",
    "dialog:pickFolders",
    "icon:pick",
    "icon:fromServer",
    "icon:toServer",
    "autostart:get",
    "autostart:set",
    "shell:editor",
    "server:moveToApp",
    "backup:list",
    "backup:create",
    "backup:restore",
    "backup:delete",
    "backup:reveal",
    "backup:size",
    "wall:pick",
    "wall:remove",
    "wall:palette",
    "ui:ready",
    "ui:answer",
    "notify:desktop",
];

impl App {
    pub fn new(info: AppInfo) -> App {
        App {
            manager: Manager::new(),
            store: Mutex::new(None),
            info,
            last_save_error: Mutex::new(None),
            window: Mutex::new(WindowBridge::new()),
            scanner: Scanner::new(),
            event_sinks: Mutex::new(Vec::new()),
            ask: Ask::new(),
        }
    }

    /// Подписка на события панели (окно, поток событий для браузера).
    pub fn on_event<F>(&self, handler: F)
    where
        F: Fn(&str, &str) + Send + std::marker::Sync + 'static,
    {
        self.event_sinks.lock().unwrap().push(Box::new(handler));
    }

    /// Отправить событие в интерфейс: `scan-progress`, `gh:stage`, `move-progress`…
    pub fn publish(&self, channel: &str, payload: &Value) {
        let body = payload.to_json();
        for sink in self.event_sinks.lock().unwrap().iter() {
            sink(channel, &body);
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

    /// Панель с готовым мостом окна — так её запускает оконная сборка.
    pub fn with_window(info: AppInfo, window: WindowBridge) -> App {
        let app = App::new(info);
        app.attach_window(window);
        app
    }

    /// Подключить мост окна (нужно оконной сборке и тестам).
    pub fn attach_window(&self, bridge: WindowBridge) {
        *self.window.lock().unwrap() = bridge;
    }

    /// Мост окна: через него интерфейс управляет окном.
    pub fn window(&self) -> WindowBridge {
        self.window.lock().unwrap().clone()
    }

    /// Менеджер серверов: им пользуются HTTP-режим и оконная сборка.
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
            "win" => self.win(action, args),
            "app" => self.app(action, args),
            "path" => self.path(action, args),
            "gh" => self.gh(action, args),
            "gl" => self.gl(action, args),
            "upd" => self.upd(action, args),
            "scan" => self.scan(action, args),
            "dialog" => self.dialog(action),
            "icon" => self.icon(action, args),
            "autostart" => self.autostart(action, args),
            "backup" => self.backup(action, args),
            "wall" => self.wall(action, args),
            "ui" => self.ui(action, args),
            "notify" => self.notify(action, args),
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
            "moveToApp" => self.move_to_app(args),
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
            "editor" => {
                Ok(open_in_editor(&text(args, 0)))
            }
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

    /* ───────────── win:* ───────────── */

    fn win(&self, action: &str, args: &[Value]) -> Result<Value, String> {
        match action {
            "minimize" => {
                self.window().request(WindowCommand::Minimize);
                Ok(Value::Bool(true))
            }
            "close" => {
                /* кнопка «закрыть» в шапке панели сворачивает в трей */
                self.window().request(WindowCommand::Close);
                Ok(Value::Bool(true))
            }
            "quit" => {
                self.window().request(WindowCommand::Quit);
                Ok(Value::Bool(true))
            }
            "toggleMax" => {
                self.window().request(WindowCommand::ToggleMaximize);
                Ok(self.window().state_json())
            }
            "toggleFull" => {
                self.window().request(WindowCommand::ToggleFullscreen);
                Ok(self.window().state_json())
            }
            "show" => {
                self.window().request(WindowCommand::Show);
                Ok(Value::Bool(true))
            }
            "isVisible" => Ok(Value::Bool(self.window().is_visible())),
            "state" => Ok(self.window().state_json()),
            "getStartMode" => Ok(Value::str("tray")),
            "setStartMode" => Ok(args.first().cloned().unwrap_or(Value::str("tray"))),
            other => Err(not_migrated("win", other)),
        }
    }



    /// Перенос папки сервера внутрь папки программы: `<программа>/server/<имя>`.
    /// Пока копируется, в интерфейс уходят шаги `move-progress`.
    fn move_to_app(&self, args: &[Value]) -> Result<Value, String> {
        let id = text(args, 0);
        let opts = args.get(1).cloned().unwrap_or(Value::Null);
        let remove_old = opts.get("removeOld").map(|v| v.as_bool()).unwrap_or(false);
        let Some(server) = self.manager.find(&id) else {
            return Ok(sync::error_json("Сервер не найден"));
        };
        if server.cwd.trim().is_empty() {
            return Ok(sync::error_json("У сервера не задана рабочая папка"));
        }
        if self.manager.state(&id) != ServerState::Stopped {
            return Ok(sync::error_json("Останови сервер перед переносом"));
        }

        let root = self.info.app_dir.join("server");
        if let Err(err) = std::fs::create_dir_all(&root) {
            return Ok(sync::error_json(format!("Не удалось создать папку: {}", err)));
        }
        let safe = safe_folder_name(&server.name);
        let mut dest = root.join(&safe);
        let mut index = 2;
        while dest.exists() && !same_path(&dest, PathBuf::from(&server.cwd).as_path()) {
            dest = root.join(format!("{}_{}", safe, index));
            index += 1;
        }
        let source = PathBuf::from(&server.cwd);
        if same_path(&dest, &source) {
            return Ok(Value::obj(vec![
                ("ok", Value::Bool(true)),
                ("path", Value::str(server.cwd.clone())),
                ("unchanged", Value::Bool(true)),
            ]));
        }

        self.publish(
            "move-progress",
            &Value::obj(vec![
                ("stage", Value::str("copy")),
                ("text", Value::str("Копирую файлы…")),
            ]),
        );
        let copied = copy_tree_with(&source, &dest, &|done, bytes| {
            self.publish(
                "move-progress",
                &Value::obj(vec![
                    ("stage", Value::str("copy")),
                    ("files", Value::from(done)),
                    ("bytes", Value::from(bytes)),
                ]),
            );
        });
        let copied = match copied {
            Ok(count) => count,
            Err(err) => {
                let _ = std::fs::remove_dir_all(&dest);
                return Ok(sync::error_json(format!("Перенос не удался: {}", err)));
            }
        };

        let mut patch = ServerConfig::from_json(&Value::obj(vec![(
            "cwd",
            Value::str(dest.display().to_string()),
        )]));
        patch.id = server.id.clone();
        patch.name = server.name.clone();
        patch.command = server.command.clone();
        patch.extra = server.extra.clone();
        self.manager.update(&id, patch);
        self.persist();
        self.publish(
            "move-progress",
            &Value::obj(vec![
                ("stage", Value::str("done")),
                ("text", Value::str(format!("Готово: {}", dest.display()))),
            ]),
        );

        let mut removed_old = false;
        if remove_old {
            if std::fs::remove_dir_all(&source).is_ok() {
                removed_old = true;
            } else {
                self.note(&id, "Старую папку удалить не удалось");
            }
        }
        self.note(&id, &format!("Папка сервера перенесена: {}", dest.display()));
        Ok(Value::obj(vec![
            ("ok", Value::Bool(true)),
            ("path", Value::str(dest.display().to_string())),
            ("files", Value::from(copied)),
            ("removedOld", Value::Bool(removed_old)),
        ]))
    }

    /* ───────────── gh:* и gl:* — синхронизация сервера ───────────── */

    /// Настройки синхронизации панели: токены, аккаунт, адреса API.
    fn sync_store(&self) -> Sync {
        Sync::new(&self.info.data_dir)
    }

    /// Настройки обновлений: канал лежит в panel.json, рядом с данными панели.
    fn updater(&self) -> Updater {
        let mut updater = Updater::new(&self.info.data_dir, &self.info.app_dir, &self.info.version);
        updater.token = self.sync_store().github_token();
        updater
    }

    /// Сервер и его настройки синхронизации из `servers.json` (поле `sync`).
    fn sync_options(&self, id: &str) -> Result<(ServerConfig, Options), String> {
        let server = self
            .manager
            .find(id)
            .ok_or_else(|| "Сервер не найден".to_string())?;
        let mut opts = Options {
            dir: PathBuf::from(server.work_dir()),
            repo: String::new(),
            branch: "main".to_string(),
            token: String::new(),
            scope: "all".to_string(),
            mode: "archive".to_string(),
            provider: Provider::GitHub,
            cleanup: true,
            state_file: self.info.data_dir.join("sync").join(format!(
                "{}.json",
                server.id.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect::<String>()
            )),
            message: format!("OmniPanel: {} — {}", server.name, sync::iso_now()),
            split_mb: sync::SPLIT_MB,
            logs: Vec::new(),
        };
        let sync_cfg = server
            .extra
            .iter()
            .find(|(key, _)| key == "sync")
            .map(|(_, value)| value.clone())
            .unwrap_or(Value::Null);
        let flag = |cfg: &Value, key: &str, default: bool| cfg.get(key).map(|v| v.as_bool()).unwrap_or(default);
        let cfg = &sync_cfg;
        if cfg.get("enabled").map(|v| v.as_bool()).unwrap_or(false) && cfg.get("repo").map(|v| !v.text().trim().is_empty()).unwrap_or(false) {
            let store = self.sync_store();
            let provider = Provider::parse(&cfg.get("provider").map(|v| v.text()).unwrap_or_default());
            let own_token = cfg.get("token").map(|v| v.text()).unwrap_or_default();
            let token = if own_token.trim().is_empty() {
                match provider {
                    Provider::GitLab => store.gitlab_token(),
                    Provider::GitHub => store.github_token(),
                }
            } else {
                own_token.trim().to_string()
            };
            opts.repo = cfg.get("repo").map(|v| v.text()).unwrap_or_default();
            opts.branch = sync::norm_branch(&cfg.get("branch").map(|v| v.text()).unwrap_or_default());
            opts.token = token;
            opts.provider = provider;
            opts.scope = {
                let scope = cfg.get("scope").map(|v| v.text()).unwrap_or_default();
                if scope.is_empty() { "all".to_string() } else { scope }
            };
            opts.mode = {
                let mode = cfg.get("mode").map(|v| v.text()).unwrap_or_default();
                if mode.is_empty() { "archive".to_string() } else { mode }
            };
            /* по умолчанию части архива убираются из хранилища после распаковки */
            opts.cleanup = !flag(cfg, "keepParts", false);
        }
        Ok((server, opts))
    }

    fn gh(&self, action: &str, args: &[Value]) -> Result<Value, String> {
        let store = self.sync_store();
        match action {
            "account" => Ok(store.account()),
            "login" => Ok(store.login(&text(args, 0))),
            "logout" => Ok(store.logout()),
            "verify" => Ok(store.verify(args.first().unwrap_or(&Value::Null))),
            "repos" => Ok(store.repos(&text(args, 0))),
            "createRepo" => Ok(store.create_repo(&text(args, 0), args.get(1).map(|v| v.as_bool()).unwrap_or(true))),
            "oauthClientId" => Ok(Value::str(store.oauth_client_id())),
            "setOauthClientId" => Ok(store.set_oauth_client_id(&text(args, 0))),
            "deviceStart" => Ok(store.device_start()),
            "devicePoll" => Ok(store.device_poll(&text(args, 0))),
            "openExternal" => {
                let url = text(args, 0);
                if !url.to_lowercase().starts_with("https://") {
                    return Ok(Value::Bool(false));
                }
                match open_in_system(&url) {
                    Ok(_) => Ok(Value::Bool(true)),
                    Err(_) => Ok(Value::Bool(false)),
                }
            }
            "download" => {
                let cfg = args.first().cloned().unwrap_or(Value::Null);
                let dir = cfg.get("dir").map(|v| v.text()).unwrap_or_default();
                if dir.trim().is_empty() {
                    return Ok(sync::error_json("Не выбрана папка, куда скачать сервер"));
                }
                let own_token = cfg.get("token").map(|v| v.text()).unwrap_or_default();
                let token = if own_token.trim().is_empty() { store.github_token() } else { own_token };
                Ok(sync::download_repo(
                    &store,
                    &cfg.get("repo").map(|v| v.text()).unwrap_or_default(),
                    &cfg.get("branch").map(|v| v.text()).unwrap_or_default(),
                    &PathBuf::from(dir),
                    &token,
                ))
            }
            "status" => Ok(sync::status(&self.sync_options(&text(args, 0))?.1.state_file)),
            "forget" => {
                let (_, opts) = self.sync_options(&text(args, 0))?;
                Ok(sync::forget(&opts.state_file))
            }
            "check" => {
                let (_, opts) = self.sync_options(&text(args, 0))?;
                if opts.repo.is_empty() {
                    return Ok(sync::error_json("Синхронизация не настроена"));
                }
                Ok(sync::check(&store, &opts))
            }
            "push" => {
                let (server, mut opts) = self.sync_options(&text(args, 0))?;
                if opts.repo.is_empty() {
                    return Ok(sync::error_json("Синхронизация не настроена"));
                }
                let who = opts.provider.name().to_string();
                self.note(&server.id, &format!("{}: отправляю изменения…", who));
                let result = sync::push(&store, &mut opts);
                self.publish_logs(&server.id, &opts.logs);
                self.note_push(&server.id, &who, &result);
                Ok(result)
            }
            "pull" => {
                let (server, mut opts) = self.sync_options(&text(args, 0))?;
                if opts.repo.is_empty() {
                    return Ok(sync::error_json("Синхронизация не настроена"));
                }
                let state = self.manager.state(&server.id);
                if matches!(state, ServerState::Running | ServerState::Stopping) {
                    return Ok(sync::error_json("Сначала останови сервер — файлы мира заняты"));
                }
                let who = opts.provider.name().to_string();
                self.note(&server.id, &format!("{}: забираю сервер…", who));
                let result = sync::pull(&store, &mut opts);
                self.publish_logs(&server.id, &opts.logs);
                self.note_push(&server.id, &who, &result);
                Ok(result)
            }
            other => Err(not_migrated("gh", other)),
        }
    }

    /// Шаги синхронизации — в окно настроек сервера, как в прежней панели.
    fn publish_logs(&self, id: &str, logs: &[String]) {
        for line in logs {
            self.publish(
                "gh:stage",
                &Value::obj(vec![
                    ("id", Value::str(id)),
                    ("text", Value::str(line.clone())),
                ]),
            );
        }
    }

    /// Строка в лог сервера: шаги синхронизации видны в его консоли.
    fn note(&self, id: &str, text: &str) {
        self.manager.note(id, text.to_string());
    }

    /// Итог синхронизации — одной строкой в лог сервера.
    fn note_push(&self, id: &str, who: &str, result: &Value) {
        let ok = result.get("ok").map(|v| v.as_bool()).unwrap_or(false);
        if !ok {
            let message = result.get("error").map(|v| v.text()).unwrap_or_default();
            self.note(id, &format!("{}: {}", who, message));
            return;
        }
        if result.get("upToDate").map(|v| v.as_bool()).unwrap_or(false) {
            self.note(id, &format!("{}: всё уже актуально", who));
            return;
        }
        let downloaded = result.get("downloaded").and_then(|v| v.as_f64()).unwrap_or(0.0) as i64;
        let uploaded = result.get("uploaded").and_then(|v| v.as_f64()).unwrap_or(0.0) as i64;
        let parts = result.get("parts").and_then(|v| v.as_f64()).unwrap_or(0.0) as i64;
        let size = result.get("size").and_then(|v| v.as_f64()).unwrap_or(0.0);
        if downloaded > 0 {
            self.note(id, &format!("{}: распаковано файлов {}", who, downloaded));
        } else if parts > 0 {
            self.note(id, &format!("{}: архив {} МБ, частей {}", who, sync::megabytes(size as u64), parts));
        } else if uploaded > 0 {
            self.note(id, &format!("{}: отправлено файлов {}", who, uploaded));
        }
    }

    fn gl(&self, action: &str, args: &[Value]) -> Result<Value, String> {
        let store = self.sync_store();
        match action {
            "account" => Ok(store.gitlab_account()),
            "save" => Ok(store.gitlab_save(&text(args, 0))),
            "projects" => Ok(store.gitlab_projects(&text(args, 0))),
            "check" => Ok(store.gitlab_check(args.first().unwrap_or(&Value::Null))),
            other => Err(not_migrated("gl", other)),
        }
    }

    /* ───────────── upd:* — обновления ───────────── */

    fn upd(&self, action: &str, args: &[Value]) -> Result<Value, String> {
        let updater = self.updater();
        match action {
            "config" => Ok(updater.config()),
            "save" => Ok(updater.save(args.first().unwrap_or(&Value::Null))),
            "check" => Ok(updater.check()),
            "apply" => Ok(updater.apply()),
            "auto" => {
                /* пока серверы работают, обновление ждёт: иначе мир оборвётся */
                let running = self
                    .manager
                    .servers()
                    .iter()
                    .any(|server| matches!(self.manager.state(&server.id), ServerState::Running | ServerState::Stopping));
                Ok(updater.auto(running))
            }
            "downloadFull" => Ok(updater.download_full()),
            "revealBackups" => {
                let result = updater.reveal_backups();
                if let Some(path) = result.get("path") {
                    let _ = open_in_system(&path.text());
                }
                Ok(result)
            }
            other => Err(not_migrated("upd", other)),
        }
    }


    /* ───────────── scan:* — поиск серверов на дисках ───────────── */

    fn scan(&self, action: &str, args: &[Value]) -> Result<Value, String> {
        match action {
            "roots" => Ok(Value::Arr(scan::roots().iter().map(|r| Value::str(r.clone())).collect())),
            "cancel" => {
                self.scanner.cancel();
                Ok(Value::Bool(true))
            }
            "start" => {
                let opts = args.first().cloned().unwrap_or(Value::Null);
                let roots: Vec<String> = match opts.get("roots") {
                    Some(Value::Arr(items)) => items.iter().map(|v| v.text()).filter(|v| !v.is_empty()).collect(),
                    _ => Vec::new(),
                };
                let roots = if roots.is_empty() { scan::roots() } else { roots };
                let depth = opts
                    .get("maxDepth")
                    .and_then(|v| v.as_f64())
                    .map(|v| v as usize)
                    .filter(|v| *v > 0)
                    .unwrap_or(4)
                    .min(8);
                let types: Vec<String> = match opts.get("types") {
                    Some(Value::Arr(items)) => items.iter().map(|v| v.text()).filter(|v| !v.is_empty()).collect(),
                    _ => Vec::new(),
                };
                /* панель сама себя в списке не показывает */
                let ignore = vec![
                    self.info.app_dir.display().to_string(),
                    self.info.data_dir.display().to_string(),
                ];
                let known: std::collections::HashSet<String> = self
                    .manager
                    .servers()
                    .iter()
                    .map(|server| server.work_dir().to_lowercase())
                    .collect();

                self.scanner.reset();
                let app = self;
                let found = self.scanner.scan(
                    &roots,
                    depth,
                    &ignore,
                    &types,
                    &known,
                    |item, added| app.publish("scan-found", &item.to_json(added)),
                    |progress| app.publish("scan-progress", &progress.to_json()),
                );
                Ok(Value::Arr(
                    found.iter().map(|item| item.to_json(known.contains(&item.path.to_lowercase()))).collect(),
                ))
            }
            other => Err(not_migrated("scan", other)),
        }
    }

    /* ───────────── dialog:* — выбор файла и папки ───────────── */

    fn dialog(&self, action: &str) -> Result<Value, String> {
        match action {
            "pickFolder" => {
                let picked = dialog::pick(dialog::Pick::Folder, "Выберите папку сервера");
                Ok(picked.into_iter().next().map(Value::str).unwrap_or(Value::Null))
            }
            "pickFile" => {
                let picked = dialog::pick(dialog::Pick::File, "Выберите файл запуска");
                Ok(picked.into_iter().next().map(Value::str).unwrap_or(Value::Null))
            }
            "pickFolders" => {
                let picked = dialog::pick(dialog::Pick::Folders, "Выберите папку или диск для поиска");
                Ok(Value::Arr(picked.into_iter().map(Value::str).collect()))
            }
            other => Err(not_migrated("dialog", other)),
        }
    }

    /* ───────────── icon:* — свои иконки серверов ───────────── */

    fn icon(&self, action: &str, args: &[Value]) -> Result<Value, String> {
        match action {
            /* выбор картинки: сразу отдаём её интерфейсу как data-адрес */
            "pick" => {
                let picked = dialog::pick(dialog::Pick::File, "Выберите иконку сервера");
                let Some(path) = picked.into_iter().next() else {
                    return Ok(Value::Null);
                };
                Ok(match icon_data_url(PathBuf::from(&path).as_path()) {
                    Some(url) => Value::str(url),
                    None => Value::Null,
                })
            }
            /* иконка, которая уже лежит в папке сервера */
            "fromServer" => {
                let dir = PathBuf::from(text(args, 0));
                if dir.as_os_str().is_empty() {
                    return Ok(Value::Null);
                }
                for name in ["server-icon.png", "icon.png", "logo.png", "server-icon.jpg"] {
                    if let Some(url) = icon_data_url(&dir.join(name)) {
                        return Ok(Value::str(url));
                    }
                }
                Ok(Value::Null)
            }
            /* иконка из интерфейса → server-icon.png 64×64 в папке сервера */
            "toServer" => {
                let dir = PathBuf::from(text(args, 0));
                let data_url = text(args, 1);
                if dir.as_os_str().is_empty() || data_url.is_empty() {
                    return Ok(sync::error_json("Нет папки или иконки"));
                }
                if !dir.exists() {
                    return Ok(sync::error_json(format!("Папка не найдена: {}", dir.display())));
                }
                match image::from_data_url(&data_url) {
                    Ok(picture) => {
                        let target = dir.join("server-icon.png");
                        match std::fs::write(&target, image::server_icon(&picture)) {
                            Ok(_) => Ok(Value::obj(vec![
                                ("ok", Value::Bool(true)),
                                ("path", Value::str(target.display().to_string())),
                            ])),
                            Err(err) => Ok(sync::error_json(format!("Не удалось записать иконку: {}", err))),
                        }
                    }
                    Err(message) => Ok(sync::error_json(format!(
                        "{} — сохрани иконку в PNG",
                        message
                    ))),
                }
            }
            other => Err(not_migrated("icon", other)),
        }
    }

    /* ───────────── autostart:* — запуск вместе с системой ───────────── */

    fn autostart(&self, action: &str, args: &[Value]) -> Result<Value, String> {
        match action {
            "get" => Ok(Value::Bool(autostart::get())),
            "set" => {
                let enabled = args.first().map(|v| v.as_bool()).unwrap_or(false);
                Ok(Value::Bool(autostart::set(&autostart::Entry::current(), enabled)))
            }
            other => Err(not_migrated("autostart", other)),
        }
    }

    /* ───────────── backup:* — архивы папки сервера ───────────── */

    /// Куда панель складывает бэкапы сервера.
    fn backups_dir(&self, id: &str) -> PathBuf {
        self.info.data_dir.join("backups").join(id)
    }

    /// Рабочая папка сервера (пусто, если сервера нет).
    fn server_cwd(&self, id: &str) -> Option<PathBuf> {
        let server = self.manager.find(id)?;
        let cwd = server.work_dir();
        if cwd.trim().is_empty() {
            return None;
        }
        Some(PathBuf::from(cwd))
    }

    fn backup(&self, action: &str, args: &[Value]) -> Result<Value, String> {
        let id = text(args, 0);
        match action {
            "list" => Ok(Value::Arr(
                backup::list(&self.backups_dir(&id))
                    .iter()
                    .map(|b| b.to_json())
                    .collect(),
            )),
            "create" => Ok(backup_create(self, &id, args.get(1))),
            "restore" => Ok(backup_restore(self, &id, args)),
            "delete" => Ok(Value::Bool(backup::delete(&PathBuf::from(text(args, 1))))),
            "reveal" => {
                let dir = self.backups_dir(&id);
                let _ = std::fs::create_dir_all(&dir);
                let _ = open_in_system(&dir.to_string_lossy());
                Ok(Value::Bool(true))
            }
            "size" => {
                let size = self
                    .server_cwd(&id)
                    .map(|dir| backup::dir_size(&dir))
                    .unwrap_or_default();
                Ok(Value::obj(vec![
                    ("bytes", Value::from(size.bytes)),
                    ("files", Value::from(size.files)),
                ]))
            }
            other => Err(not_migrated("backup", other)),
        }
    }

    /* ───────────── wall:* — свои обои и палитра под них ───────────── */

    fn wall(&self, action: &str, args: &[Value]) -> Result<Value, String> {
        match action {
            "list" => Ok(wall::list(&self.info.data_dir)),
            "pick" => {
                /* выбор файла — системным диалогом, дальше копия в папку панели */
                let chosen = crate::dialog::pick(crate::dialog::Pick::File, "Фон панели");
                let Some(path) = chosen.first() else {
                    return Ok(Value::obj(vec![("ok", Value::Bool(false)), ("cancelled", Value::Bool(true))]));
                };
                Ok(wall::pick(&self.info.data_dir, path))
            }
            "remove" => Ok(wall::remove(&self.info.data_dir, &text(args, 0))),
            "palette" => {
                let source = args.first().cloned().unwrap_or(Value::Null);
                Ok(wall::palette(&self.info.data_dir, &self.info.app_dir, &source))
            }
            other => Err(not_migrated("wall", other)),
        }
    }

    /* ───────────── ui:* — свои окна вопросов ───────────── */

    fn ui(&self, action: &str, args: &[Value]) -> Result<Value, String> {
        match action {
            "ready" => {
                self.ask.ready();
                Ok(Value::Bool(true))
            }
            "answer" => {
                let rid = args.first().and_then(|v| v.as_f64()).unwrap_or(0.0) as u64;
                let id = text(args, 1);
                Ok(Value::Bool(self.ask.answer(rid, &id)))
            }
            other => Err(not_migrated("ui", other)),
        }
    }

    /// Спросить человека своим окном. В окне Tauri вопрос уходит событием,
    /// в браузере — в поток событий; ответ возвращается сюда.
    pub fn ask_ui(&self, title: &str, text: &str, buttons: &[crate::ask::Button], kind: &str) -> Option<String> {
        self.ask
            .ask(title, text, buttons, kind, |payload| self.publish("ui:ask", payload))
    }

    /* ───────────── notify:* — уведомления системы ───────────── */

    fn notify(&self, action: &str, args: &[Value]) -> Result<Value, String> {
        match action {
            "desktop" => {
                let title = args
                    .first()
                    .and_then(|v| v.get("title"))
                    .map(|v| v.text())
                    .unwrap_or_else(|| notify::APP_NAME.to_string());
                let body = args
                    .first()
                    .and_then(|v| v.get("text"))
                    .map(|v| v.text())
                    .unwrap_or_default();
                Ok(Value::Bool(notify::show(&title, &body)))
            }
            other => Err(not_migrated("notify", other)),
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

/// Имя папки из названия сервера: без запрещённых символов и пробелов.
fn safe_folder_name(name: &str) -> String {
    let mut out = String::new();
    for symbol in name.chars() {
        if "\\/:*?\"<>|".contains(symbol) {
            continue;
        }
        out.push(if symbol.is_whitespace() { '_' } else { symbol });
    }
    let trimmed: String = out.chars().take(60).collect();
    if trimmed.is_empty() {
        "server".to_string()
    } else {
        trimmed
    }
}

fn same_path(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
}

/// Копирует папку целиком, сообщая о ходе (файлы и байты).
fn copy_tree_with(
    from: &Path,
    to: &Path,
    progress: &dyn Fn(usize, u64),
) -> Result<usize, String> {
    std::fs::create_dir_all(to).map_err(|e| format!("не создать папку: {}", e))?;
    let mut files = 0usize;
    let mut bytes = 0u64;
    let mut stack = vec![from.to_path_buf()];
    while let Some(current) = stack.pop() {
        let entries = match std::fs::read_dir(&current) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let rel = match path.strip_prefix(from) {
                Ok(rel) => rel.to_path_buf(),
                Err(_) => continue,
            };
            let target = to.join(&rel);
            let meta = match std::fs::symlink_metadata(&path) {
                Ok(meta) => meta,
                Err(_) => continue,
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                let _ = std::fs::create_dir_all(&target);
                stack.push(path);
            } else if meta.is_file() {
                if let Some(parent) = target.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let size = std::fs::copy(&path, &target).map_err(|e| format!("не скопировать {}: {}", rel.display(), e))?;
                files += 1;
                bytes += size;
                if files % 50 == 0 {
                    progress(files, bytes);
                }
            }
        }
    }
    progress(files, bytes);
    Ok(files)
}

/// Картинка из файла в виде data-адреса. Крупные файлы не берём.
fn icon_data_url(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > 4 * 1024 * 1024 {
        return None;
    }
    let data = std::fs::read(path).ok()?;
    if data.starts_with(b"\x89PNG") {
        /* PNG уменьшаем сами: в списке серверов иконка мелкая */
        if let Ok(picture) = image::decode_png(&data) {
            return Some(image::to_data_url(&picture.resize(128, 128)));
        }
    }
    let name = path.file_name()?.to_string_lossy().to_lowercase();
    let mime = if data.starts_with(b"\x89PNG") {
        "image/png"
    } else if data.starts_with(&[0xFF, 0xD8]) {
        "image/jpeg"
    } else if data.starts_with(b"GIF8") {
        "image/gif"
    } else if name.ends_with(".webp") {
        "image/webp"
    } else if name.ends_with(".bmp") {
        "image/bmp"
    } else if name.ends_with(".ico") {
        "image/x-icon"
    } else {
        return None;
    };
    Some(format!("data:{};base64,{}", mime, b64::encode(&data)))
}

/// Открыть файл в редакторе кода; если его нет — системным приложением.
fn open_in_editor(target: &str) -> Value {
    let path = if target.trim().is_empty() {
        return sync::error_json("Путь не указан");
    } else {
        PathBuf::from(target.trim())
    };
    if !path.exists() {
        return sync::error_json(format!("Не найдено: {}", path.display()));
    }
    for candidate in editor_candidates() {
        let result = std::process::Command::new(&candidate)
            .arg("--reuse-window")
            .arg(&path)
            .spawn();
        if result.is_ok() {
            return Value::obj(vec![
                ("ok", Value::Bool(true)),
                ("editor", Value::str("editor")),
                ("bin", Value::str(candidate)),
            ]);
        }
    }
    match open_in_system(&path.display().to_string()) {
        Ok(_) => Value::obj(vec![("ok", Value::Bool(true)), ("editor", Value::str("system"))]),
        Err(message) => sync::error_json(message),
    }
}

/// Какие редакторы ищем: сначала VS Code и его родня, потом «блокнот».
fn editor_candidates() -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if cfg!(windows) {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            for sub in [
                "Programs\\Microsoft VS Code\\bin\\code.cmd",
                "Programs\\Microsoft VS Code Insiders\\bin\\code-insiders.cmd",
                "Programs\\VSCodium\\bin\\codium.cmd",
            ] {
                out.push(format!("{}\\{}", local, sub));
            }
        }
        if let Ok(pf) = std::env::var("ProgramFiles") {
            out.push(format!("{}\\Microsoft VS Code\\bin\\code.cmd", pf));
        }
    }
    for name in ["code", "code-insiders", "codium", "subl", "notepad++"] {
        out.push(name.to_string());
    }
    out
}

/* ───────────────────── бэкапы: создание и восстановление ───────────────────── */

/// Собирает архив папки сервера. Опции: `lean`, `format`, `volumeMb`, `name`.
fn backup_create(app: &App, id: &str, opts: Option<&Value>) -> Value {
    let Some(server) = app.manager().find(id) else {
        return backup_error("Сервер не найден");
    };
    let Some(src) = app.server_cwd(id) else {
        return backup_error("У сервера не задана рабочая папка");
    };
    let opts = opts.cloned().unwrap_or(Value::Null);
    let lean = opts.get("lean").map(|v| v.as_bool()).unwrap_or(true);
    let format = opts
        .get("format")
        .map(|v| v.text())
        .filter(|f| !f.is_empty())
        .unwrap_or_else(|| "auto".to_string());
    let volume_mb = opts.get("volumeMb").and_then(|v| v.as_f64()).unwrap_or(0.0) as u64;
    let label = opts
        .get("name")
        .map(|v| v.text())
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| server.name.clone());

    match backup::create(&src, &app.backups_dir(id), &label, lean, &format, volume_mb) {
        Ok(info) => {
            app.publish(
                "toast",
                &Value::obj(vec![
                    ("kind", Value::str("ok")),
                    ("text", Value::str(format!("Бэкап создан: {}", info.name))),
                ]),
            );
            info.to_json()
        }
        Err(err) => backup_error(&err),
    }
}

/// Восстанавливает архив: останавливает сервер, делает страховочную копию,
/// распаковывает и при нужде запускает сервер снова.
fn backup_restore(app: &App, id: &str, args: &[Value]) -> Value {
    let Some(server) = app.manager().find(id) else {
        return backup_error("Сервер не найден");
    };
    let Some(dest) = app.server_cwd(id) else {
        return backup_error("У сервера не задана рабочая папка");
    };
    let file = PathBuf::from(text(args, 1));
    let opts = args.get(2).cloned().unwrap_or(Value::Null);
    let safety = opts.get("safety").map(|v| v.as_bool()).unwrap_or(true);
    let start_after = opts.get("startAfter").map(|v| v.as_bool()).unwrap_or(false);

    /* 1. сервер не должен писать в папку, пока её распаковывают */
    let was_running = app.manager().state(id) != crate::servers::ServerState::Stopped;
    if was_running {
        app.manager().stop(id);
        let waited = std::time::Instant::now();
        while app.manager().state(id) != crate::servers::ServerState::Stopped
            && waited.elapsed().as_secs() < 30
        {
            std::thread::sleep(std::time::Duration::from_millis(300));
        }
        if app.manager().state(id) != crate::servers::ServerState::Stopped {
            app.manager().kill(id);
        }
        std::thread::sleep(std::time::Duration::from_millis(800));
    }

    /* 2. страховочная копия текущего состояния — восстановление необратимо */
    let mut safety_info = Value::Null;
    if safety {
        let label = format!("{}_before_restore", server.name);
        if let Ok(info) = backup::create(&dest, &app.backups_dir(id), &label, true, "auto", 0) {
            safety_info = info.to_json();
        }
    }

    /* 3. распаковка */
    match backup::restore(&file, &dest) {
        Ok(_) => {
            let started = start_after && was_running && app.manager().start(id).is_ok();
            Value::obj(vec![
                ("ok", Value::Bool(true)),
                ("safety", safety_info),
                ("started", Value::Bool(started)),
            ])
        }
        Err(err) => backup_error(&err),
    }
}

fn backup_error(message: &str) -> Value {
    Value::obj(vec![
        ("ok", Value::Bool(false)),
        ("error", Value::str(message)),
    ])
}
