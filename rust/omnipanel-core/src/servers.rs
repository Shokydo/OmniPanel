//! Управление серверами: настройки, запуск, живой лог, остановка.
//!
//! Поведение повторяет прежний `core/manager.js` один в один, потому что
//! интерфейс и файл `servers.json` у игроков уже есть:
//!
//! * сервер запускается **строкой команды через оболочку** (`sh -c` / `cmd /C`),
//!   как в Node с `shell: true` — поэтому работают и `java -jar server.jar nogui`,
//!   и `start.bat`, и `./run.sh`;
//! * рабочая папка — `cwd`, если задана, иначе папка панели;
//! * состояние `running` ставится сразу после запуска — интерфейс знает только
//!   `stopped`, `running` и `stopping`, поэтому других значений ядро не выдумывает;
//! * в лог попадает не больше 1500 строк;
//! * мягкая остановка отправляет `stopCommand` в консоль, ждёт `stopTimeout`
//!   и только потом убивает процесс;
//! * жёсткая остановка на Windows — `taskkill /pid <pid> /T /F`.

use crate::json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// Сколько строк лога держим в памяти на один сервер.
pub const LOG_LIMIT: usize = 1500;

/// Сколько точек TPS держим для мини-графика в шапке.
pub const TPS_HISTORY: usize = 60;

/// Пауза перед автоперезапуском (мс) — как в панели.
pub const RESTART_DELAY: u64 = 3000;

/// Сколько ждём ответа на команду остановки (мс), если в настройках пусто.
pub const DEFAULT_STOP_TIMEOUT: u64 = 20000;

/// Состояние сервера. В интерфейс уходит строкой в нижнем регистре.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServerState {
    Stopped,
    Running,
    Stopping,
}

impl ServerState {
    pub fn as_str(&self) -> &'static str {
        match self {
            ServerState::Stopped => "stopped",
            ServerState::Running => "running",
            ServerState::Stopping => "stopping",
        }
    }
}

/// Настройки одного сервера — ровно те поля, что лежат в `servers.json`.
///
/// Незнакомые поля (например, от более новых версий панели) сохраняются
/// в `extra` и записываются обратно: ручные правки файла не пропадают.
#[derive(Debug, Clone, PartialEq)]
pub struct ServerConfig {
    pub id: String,
    pub name: String,
    /// Строка команды целиком, например `java -Xmx4G -jar server.jar nogui`.
    pub command: String,
    pub cwd: String,
    pub stop_command: String,
    pub auto_restart: bool,
    pub auto_start: bool,
    pub env: Vec<(String, String)>,
    pub icon: String,
    pub encoding: String,
    pub tps_command: String,
    pub tps_interval: u32,
    /// Таймаут мягкой остановки в миллисекундах, 0 — по умолчанию.
    pub stop_timeout: u64,
    pub extra: Vec<(String, Value)>,
}

impl ServerConfig {
    /// Новый сервер с разумными значениями по умолчанию.
    pub fn new(id: impl Into<String>, name: impl Into<String>, command: impl Into<String>) -> Self {
        ServerConfig {
            id: id.into(),
            name: name.into(),
            command: command.into(),
            cwd: String::new(),
            stop_command: "stop".to_string(),
            auto_restart: false,
            auto_start: false,
            env: Vec::new(),
            icon: String::new(),
            encoding: "auto".to_string(),
            tps_command: String::new(),
            tps_interval: 10,
            stop_timeout: 0,
            extra: Vec::new(),
        }
    }

    /// Приводим настройки к тому виду, к которому привык интерфейс
    /// (`manager.add` в прежней панели).
    pub fn normalize(mut self) -> Self {
        self.name = self.name.trim().to_string();
        if self.name.is_empty() {
            self.name = "Новый сервер".to_string();
        }
        self.command = self.command.trim().to_string();
        self.cwd = self.cwd.trim().to_string();
        if self.encoding.trim().is_empty() {
            self.encoding = "auto".to_string();
        }
        if self.tps_interval == 0 {
            self.tps_interval = 10;
        }
        self
    }

    /// Читаем из JSON. Число вместо строки не пугает: интерфейс присылает разное.
    pub fn from_json(value: &Value) -> ServerConfig {
        let text = |key: &str| value.get(key).map(|v| v.text()).unwrap_or_default();
        let flag = |key: &str| value.get(key).map(|v| v.as_bool()).unwrap_or(false);
        let mut env = Vec::new();
        if let Some(Value::Obj(pairs)) = value.get("env") {
            for (k, v) in pairs {
                env.push((k.clone(), v.text()));
            }
        }
        let known = [
            "id", "name", "command", "cwd", "stopCommand", "autoRestart", "autoStart", "env",
            "icon", "encoding", "tpsCommand", "tpsInterval", "stopTimeout",
        ];
        let mut extra = Vec::new();
        if let Value::Obj(pairs) = value {
            for (k, v) in pairs {
                if !known.contains(&k.as_str()) {
                    extra.push((k.clone(), v.clone()));
                }
            }
        }
        ServerConfig {
            id: text("id"),
            name: text("name"),
            command: text("command"),
            cwd: text("cwd"),
            stop_command: text("stopCommand"),
            auto_restart: flag("autoRestart"),
            auto_start: flag("autoStart"),
            env,
            icon: text("icon"),
            encoding: if text("encoding").is_empty() { "auto".to_string() } else { text("encoding") },
            tps_command: text("tpsCommand"),
            tps_interval: value.get("tpsInterval").and_then(|v| v.as_f64()).unwrap_or(10.0) as u32,
            stop_timeout: value.get("stopTimeout").and_then(|v| v.as_f64()).unwrap_or(0.0) as u64,
            extra,
        }
    }

    /// Запись в JSON тем же набором ключей, что понимает интерфейс.
    pub fn to_json(&self) -> Value {
        let env = Value::Obj(self.env.iter().map(|(k, v)| (k.clone(), Value::str(v))).collect());
        let mut pairs: Vec<(String, Value)> = vec![
            ("id".into(), Value::str(&self.id)),
            ("name".into(), Value::str(&self.name)),
            ("command".into(), Value::str(&self.command)),
            ("cwd".into(), Value::str(&self.cwd)),
            ("stopCommand".into(), Value::str(&self.stop_command)),
            ("autoRestart".into(), Value::Bool(self.auto_restart)),
            ("autoStart".into(), Value::Bool(self.auto_start)),
            ("env".into(), env),
            ("icon".into(), Value::str(&self.icon)),
            ("encoding".into(), Value::str(&self.encoding)),
            ("tpsCommand".into(), Value::str(&self.tps_command)),
            ("tpsInterval".into(), Value::from(self.tps_interval as u64)),
        ];
        if self.stop_timeout > 0 {
            pairs.push(("stopTimeout".into(), Value::from(self.stop_timeout)));
        }
        for (k, v) in &self.extra {
            pairs.push((k.clone(), v.clone()));
        }
        Value::Obj(pairs)
    }

    /// Команда оболочки, которая запустит сервер.
    pub fn shell_command(&self) -> (String, Vec<String>) {
        if cfg!(windows) {
            ("cmd".to_string(), vec!["/C".to_string(), self.command.clone()])
        } else {
            ("/bin/sh".to_string(), vec!["-c".to_string(), self.command.clone()])
        }
    }

    /// Папка сервера для файлов — это `cwd` (как `rootOf` в панели).
    /// Пустая строка означает «папка не задана»: панель об этом скажет.
    pub fn root_dir(&self) -> String {
        self.cwd.trim().to_string()
    }

    /// Рабочая папка: пустая настройка означает «папка панели».
    pub fn work_dir(&self) -> String {
        if self.cwd.trim().is_empty() {
            std::env::current_dir()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| ".".to_string())
        } else {
            self.cwd.clone()
        }
    }
}

/// Строка живого лога.
#[derive(Debug, Clone, PartialEq)]
pub struct LogLine {
    /// `system`, `stdout` или `stderr`.
    pub kind: String,
    pub text: String,
    pub at: u64,
}

impl LogLine {
    pub fn kind_str(&self) -> &'static str {
        match self.kind.as_str() {
            "stderr" => "stderr",
            "stdout" => "stdout",
            _ => "system",
        }
    }
}

/// Что произошло на сервере (уходит в интерфейс событиями).
#[derive(Debug, Clone, PartialEq)]
pub enum EventKind {
    Log,
    State,
    Exit,
    Error,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Event {
    pub id: String,
    pub kind: EventKind,
    pub text: String,
    pub at: u64,
}

type Handler = Arc<dyn Fn(Event) + Send + Sync>;

/// Работающий сервер: процесс, вход в него и накопленный лог.
struct Runtime {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    state: ServerState,
    log: Vec<LogLine>,
    pid: Option<u32>,
    started_at: Option<u64>,
    exit_code: Option<i32>,
    /// Остановку попросил пользователь — автоперезапуск не нужен.
    manual_stop: bool,
    /// Ждём ответа на команду остановки.
    stopping: bool,
    encoding: Option<String>,
    /// Последнее значение TPS и история для графика.
    tps: Option<f32>,
    tps_history: Vec<crate::players::TpsPoint>,
}

impl Default for Runtime {
    fn default() -> Self {
        Runtime {
            child: None,
            stdin: None,
            state: ServerState::Stopped,
            log: Vec::new(),
            pid: None,
            started_at: None,
            exit_code: None,
            manual_stop: false,
            stopping: false,
            encoding: None,
            tps: None,
            tps_history: Vec::new(),
        }
    }
}

/// Общее состояние менеджера. Лежит в `Arc`, поэтому фоновый поток получает
/// обычную копию `Manager` и работает с теми же серверами, что и интерфейс.
struct Inner {
    configs: Mutex<Vec<ServerConfig>>,
    runtimes: Mutex<HashMap<String, Runtime>>,
    handlers: Mutex<Vec<Handler>>,
    clock: fn() -> u64,
    events: AtomicU64,
}

/// Управление всеми серверами сразу.
#[derive(Clone)]
pub struct Manager {
    inner: Arc<Inner>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl Default for Manager {
    fn default() -> Self {
        Self::new()
    }
}

impl Manager {
    pub fn new() -> Self {
        Manager {
            inner: Arc::new(Inner {
                configs: Mutex::new(Vec::new()),
                runtimes: Mutex::new(HashMap::new()),
                handlers: Mutex::new(Vec::new()),
                clock: now_ms,
                events: AtomicU64::new(0),
            }),
        }
    }

    /// Подписчик на события (в Tauri — отправка в окно, в тестах — сбор в вектор).
    pub fn subscribe<F: Fn(Event) + Send + Sync + 'static>(&self, handler: F) {
        self.inner.handlers.lock().unwrap().push(Arc::new(handler));
    }

    fn emit(&self, id: &str, kind: EventKind, text: impl Into<String>) {
        let event = Event {
            id: id.to_string(),
            kind,
            text: text.into(),
            at: (self.inner.clock)(),
        };
        for handler in self.inner.handlers.lock().unwrap().iter() {
            handler(event.clone());
        }
        self.inner.events.fetch_add(1, Ordering::Relaxed);
    }

    /// Сколько событий прошло через менеджер (для тестов).
    pub fn events_count(&self) -> u64 {
        self.inner.events.load(Ordering::Relaxed)
    }

    /* ───────────── настройки ───────────── */

    pub fn set_servers(&self, list: Vec<ServerConfig>) {
        *self.inner.configs.lock().unwrap() = list;
    }

    pub fn servers(&self) -> Vec<ServerConfig> {
        self.inner.configs.lock().unwrap().clone()
    }

    /// Новый id сервера: время плюс счётчик, чтобы не совпал с прежним.
    pub fn new_id(&self) -> String {
        use std::sync::atomic::{AtomicU32, Ordering};
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let step = COUNTER.fetch_add(1, Ordering::Relaxed);
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        format!("s{}{}", stamp, step)
    }

    pub fn find(&self, id: &str) -> Option<ServerConfig> {
        self.inner.configs.lock().unwrap().iter().find(|s| s.id == id).cloned()
    }

    pub fn add(&self, cfg: ServerConfig) -> ServerConfig {
        let mut cfg = cfg.normalize();
        /* у сервера обязан быть id: без него панель не найдёт его ни по одной кнопке */
        if cfg.id.trim().is_empty() {
            cfg.id = self.new_id();
        }
        self.inner.configs.lock().unwrap().push(cfg.clone());
        cfg
    }

    pub fn update(&self, id: &str, patch: ServerConfig) -> Option<ServerConfig> {
        let mut list = self.inner.configs.lock().unwrap();
        let slot = list.iter_mut().find(|s| s.id == id)?;
        *slot = ServerConfig { id: id.to_string(), ..patch }.normalize();
        Some(slot.clone())
    }

    pub fn remove(&self, id: &str) -> bool {
        let state = self.state(id);
        if state != ServerState::Stopped {
            self.kill(id);
        }
        let mut list = self.inner.configs.lock().unwrap();
        let before = list.len();
        list.retain(|s| s.id != id);
        let changed = list.len() != before;
        drop(list);
        self.inner.runtimes.lock().unwrap().remove(id);
        changed
    }

    /// Порядок серверов в списке — как их перетащил пользователь.
    pub fn reorder(&self, ids: &[String]) {
        let mut list = self.inner.configs.lock().unwrap();
        let mut sorted: Vec<ServerConfig> = Vec::with_capacity(list.len());
        for id in ids {
            if let Some(pos) = list.iter().position(|s| &s.id == id) {
                sorted.push(list.remove(pos));
            }
        }
        sorted.extend(list.drain(..));
        *list = sorted;
    }

    /* ───────────── состояние ───────────── */

    pub fn state(&self, id: &str) -> ServerState {
        self.inner.runtimes
            .lock()
            .unwrap()
            .get(id)
            .map(|r| r.state)
            .unwrap_or(ServerState::Stopped)
    }

    pub fn pid(&self, id: &str) -> Option<u32> {
        self.inner.runtimes.lock().unwrap().get(id).and_then(|r| r.pid)
    }

    pub fn logs(&self, id: &str) -> Vec<String> {
        self.inner.runtimes
            .lock()
            .unwrap()
            .get(id)
            .map(|r| r.log.iter().map(|l| l.text.clone()).collect())
            .unwrap_or_default()
    }

    /// Лог с пометками, откуда пришла строка.
    pub fn log_lines(&self, id: &str) -> Vec<LogLine> {
        self.inner.runtimes
            .lock()
            .unwrap()
            .get(id)
            .map(|r| r.log.clone())
            .unwrap_or_default()
    }

    pub fn clear_logs(&self, id: &str) {
        if let Some(rt) = self.inner.runtimes.lock().unwrap().get_mut(id) {
            rt.log.clear();
        }
    }

    /// Статус ровно в том виде, в котором его ждёт интерфейс (`manager.status`).
    pub fn status_json(&self, id: &str) -> Value {
        let rt = self.inner.runtimes.lock().unwrap();
        let r = rt.get(id);
        let state = r.map(|x| x.state).unwrap_or(ServerState::Stopped);
        let started_at = r.and_then(|x| x.started_at);
        let uptime = match (state, started_at) {
            (ServerState::Running, Some(start)) => (self.inner.clock)().saturating_sub(start),
            _ => 0,
        };
        Value::obj(vec![
            ("state", Value::str(state.as_str())),
            ("pid", r.and_then(|x| x.pid).map(|p| Value::from(p as u64)).unwrap_or(Value::Null)),
            ("startedAt", started_at.map(|v| Value::from(v)).unwrap_or(Value::Null)),
            (
                "exitCode",
                r.and_then(|x| x.exit_code).map(|c| Value::from(c as i64)).unwrap_or(Value::Null),
            ),
            ("uptime", Value::from(uptime)),
            (
                "encoding",
                r.and_then(|x| x.encoding.clone()).map(Value::str).unwrap_or(Value::Null),
            ),
            (
                "tps",
                r.and_then(|x| x.tps).map(|t| Value::Num(t as f64)).unwrap_or(Value::Null),
            ),
            (
                "tpsHistory",
                Value::Arr(
                    r.map(|x| x.tps_history.iter().map(|p| p.to_json()).collect())
                        .unwrap_or_default(),
                ),
            ),
            ("metrics", Value::Null),
        ])
    }

    /// Список серверов с их статусами — то, что отдаёт `servers:list`.
    pub fn list_json(&self) -> Value {
        let configs = self.servers();
        Value::Arr(configs.iter().map(|cfg| merge(cfg.to_json(), self.status_json(&cfg.id))).collect())
    }

    /* ───────────── запуск и остановка ───────────── */

    /// Строка в лог сервера от самой панели (синхронизация, обновления).
    /// Пишется и в лог, и в события — интерфейс увидит её сразу.
    pub fn note(&self, id: &str, text: impl Into<String>) {
        self.log(id, "system", text);
    }

    fn log(&self, id: &str, kind: &str, text: impl Into<String>) {
        let line = LogLine {
            kind: kind.to_string(),
            text: text.into(),
            at: (self.inner.clock)(),
        };
        {
            let mut rt = self.inner.runtimes.lock().unwrap();
            let r = rt.entry(id.to_string()).or_default();
            if r.log.len() >= LOG_LIMIT {
                let drop_count = r.log.len() + 1 - LOG_LIMIT;
                r.log.drain(0..drop_count);
            }
            r.log.push(line.clone());
        }
        self.emit(id, EventKind::Log, format!("{}", line.text));
        let _ = line.kind_str();
    }

    fn set_state(&self, id: &str, state: ServerState) {
        if let Some(rt) = self.inner.runtimes.lock().unwrap().get_mut(id) {
            rt.state = state;
        }
        self.emit(id, EventKind::State, state.as_str());
    }

    /// Запуск сервера. Ошибка настройки возвращается текстом, а не паникой.
    pub fn start(&self, id: &str) -> Result<bool, String> {
        let Some(cfg) = self.find(id) else {
            return Err("сервер не найден".to_string());
        };
        let state = self.state(id);
        if state == ServerState::Running || state == ServerState::Stopping {
            return Ok(false);
        }
        if cfg.command.trim().is_empty() {
            self.log(id, "system", "Команда запуска не задана — открой настройки сервера.");
            return Ok(false);
        }

        {
            let mut rt = self.inner.runtimes.lock().unwrap();
            let r = rt.entry(id.to_string()).or_default();
            r.manual_stop = false;
            r.stopping = false;
            r.exit_code = None;
            r.encoding = None;
            r.tps = None;
            r.tps_history.clear();
        }

        let (program, args) = cfg.shell_command();
        let mut command = Command::new(&program);
        #[cfg(windows)]
        {
            /* На Windows команда идёт в cmd как есть, одной строкой.
               Через `args` Rust экранирует кавычки как \" — а cmd такого не
               понимает и падает на первом же пути с пробелом, поэтому строку
               отдаём целиком, без правок. */
            let _ = &args;
            use std::os::windows::process::CommandExt;
            command.raw_arg("/d");
            command.raw_arg("/s");
            command.raw_arg("/c");
            command.raw_arg(format!("\"{}\"", cfg.command));
        }
        #[cfg(not(windows))]
        command.args(&args);
        command.current_dir(cfg.work_dir());
        for (key, value) in &cfg.env {
            command.env(key, value);
        }
        /* так же, как панель: Python-серверы на Windows иначе сыплют кракозябрами */
        command.env("PYTHONIOENCODING", "utf-8");
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        self.log(id, "system", format!("Запуск: {}", cfg.command));
        self.log(id, "system", format!("  Рабочая папка: {}", cfg.work_dir()));

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(err) => {
                self.log(id, "stderr", format!("Ошибка запуска: {}", err));
                self.set_state(id, ServerState::Stopped);
                return Err(format!("не удалось запустить сервер: {}", err));
            }
        };

        let pid = child.id();
        let stdin = child.stdin.take();
        {
            let mut rt = self.inner.runtimes.lock().unwrap();
            let r = rt.entry(id.to_string()).or_default();
            r.pid = Some(pid);
            r.started_at = Some((self.inner.clock)());
            r.stdin = stdin;
            r.state = ServerState::Running;
        }
        self.emit(id, EventKind::State, "running");

        /* оба потока читаем одинаково — через один тип, иначе не собрать в один вектор */
        let mut readers: Vec<Box<dyn Read + Send>> = Vec::new();
        if let Some(out) = child.stdout.take() {
            readers.push(Box::new(out));
        }
        if let Some(err) = child.stderr.take() {
            readers.push(Box::new(err));
        }

        self.inner.runtimes.lock().unwrap().entry(id.to_string()).or_default().child = Some(child);

        /* чтение вывода — в отдельных потоках, чтобы запуск не блокировал панель */
        let id_owned = id.to_string();
        for (index, reader) in readers.into_iter().enumerate() {
            let manager = self.clone();
            let id_for_thread = id_owned.clone();
            let kind = if index == 0 { "stdout" } else { "stderr" };
            std::thread::spawn(move || {
                let buf = BufReader::new(reader);
                for line in buf.split(b'\n') {
                    let Ok(bytes) = line else { break };
                    let text = String::from_utf8_lossy(&bytes).trim_end_matches('\r').to_string();
                    if text.is_empty() {
                        continue;
                    }
                    manager.on_output(&id_for_thread, kind, &text);
                }
            });
        }

        self.start_tps_loop(&id_owned, cfg.tps_command.clone(), cfg.tps_interval);

        /* сторож: ждём выхода процесса и только потом меняем состояние.
         * `try_wait` под замком ненадолго — так `kill` не ждёт окончания ожидания. */
        let watchdog = self.clone();
        let id_watch = id_owned.clone();
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(std::time::Duration::from_millis(100));
                let status = {
                    let mut rt = watchdog.inner.runtimes.lock().unwrap();
                    match rt.get_mut(&id_watch).and_then(|r| r.child.as_mut()) {
                        Some(child) => match child.try_wait() {
                            Ok(Some(status)) => Some(status.code()),
                            Ok(None) => None,
                            Err(_) => Some(None),
                        },
                        None => return, /* процесс уже снят жёсткой остановкой */
                    }
                };
                if let Some(code) = status {
                    watchdog.mark_exited(&id_watch, code);
                    return;
                }
            }
        });

        Ok(true)
    }

    /// Обработка одной строки вывода сервера.
    fn on_output(&self, id: &str, kind: &str, text: &str) {
        self.log(id, kind, text);
        if let Some(value) = crate::players::parse_tps(text) {
            let point = crate::players::TpsPoint { at: (self.inner.clock)(), value };
            let mut rt = self.inner.runtimes.lock().unwrap();
            if let Some(r) = rt.get_mut(id) {
                r.tps = Some(value);
                r.tps_history.push(point);
                if r.tps_history.len() > TPS_HISTORY {
                    let extra = r.tps_history.len() - TPS_HISTORY;
                    r.tps_history.drain(0..extra);
                }
            }
            drop(rt);
            self.emit(id, EventKind::State, format!("tps {}", value));
        }
    }

    /// История TPS для мини-графика.
    pub fn tps_history(&self, id: &str) -> Vec<crate::players::TpsPoint> {
        self.inner
            .runtimes
            .lock()
            .unwrap()
            .get(id)
            .map(|r| r.tps_history.clone())
            .unwrap_or_default()
    }

    /// Очистить историю TPS (кнопка в интерфейсе).
    pub fn clear_tps(&self, id: &str) {
        if let Some(r) = self.inner.runtimes.lock().unwrap().get_mut(id) {
            r.tps = None;
            r.tps_history.clear();
        }
    }

    /// Опрос TPS: раз в `tps_interval` секунд панель спрашивает сервер.
    ///
    /// Команда берётся из настроек сервера (`tpsCommand`); если она пустая,
    /// панель TPS не спрашивает — как и раньше.
    fn start_tps_loop(&self, id: &str, command: String, interval_secs: u32) {
        if command.trim().is_empty() {
            return;
        }
        let manager = self.clone();
        let target = id.to_string();
        std::thread::spawn(move || {
            let step = std::time::Duration::from_secs(interval_secs.max(1) as u64);
            loop {
                std::thread::sleep(step);
                if manager.state(&target) != ServerState::Running {
                    return;
                }
                let _ = manager.command(&target, &command);
            }
        });
    }

    /// Отправить команду в консоль сервера.
    pub fn command(&self, id: &str, text: &str) -> Result<(), String> {
        let mut rt = self.inner.runtimes.lock().unwrap();
        let r = rt.get_mut(id).ok_or("сервер не запущен")?;
        if r.state != ServerState::Running {
            return Err("сервер не запущен".to_string());
        }
        let stdin = r.stdin.as_mut().ok_or("консоль сервера недоступна")?;
        writeln!(stdin, "{}", text).map_err(|e| format!("не удалось отправить команду: {}", e))?;
        stdin.flush().map_err(|e| format!("не удалось отправить команду: {}", e))?;
        Ok(())
    }

    /// Перезапуск: мягко останавливаем и поднимаем заново.
    ///
    /// Ждём остановки не дольше таймаута из настроек: интерфейс после перезапуска
    /// сразу спрашивает статус, и «останавливается» в ответ выглядело бы поломкой.
    pub fn restart(&self, id: &str) -> Result<bool, String> {
        if self.find(id).is_none() {
            return Err("сервер не найден".to_string());
        }
        let state = self.state(id);
        if state != ServerState::Stopped {
            self.stop(id);
            let timeout = self.find(id).map(|c| c.stop_timeout).unwrap_or(0);
            let wait = if timeout > 0 { timeout } else { DEFAULT_STOP_TIMEOUT };
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(wait.min(15000));
            while self.state(id) != ServerState::Stopped && std::time::Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            if self.state(id) != ServerState::Stopped {
                self.kill(id);
            }
        }
        self.start(id)
    }

    /// Мягкая остановка: команда в консоль, при отсутствии — жёсткая.
    pub fn stop(&self, id: &str) -> bool {
        let Some(cfg) = self.find(id) else { return false };
        let state = self.state(id);
        if state != ServerState::Running {
            return false;
        }
        {
            let mut rt = self.inner.runtimes.lock().unwrap();
            if let Some(r) = rt.get_mut(id) {
                r.manual_stop = true;
            }
        }

        let graceful = cfg.stop_command.trim().to_string();
        if graceful.is_empty() {
            self.log(id, "system", "⏹ Остановка (принудительно): команда остановки не задана.");
            return self.kill(id);
        }

        self.log(id, "system", format!("⏹ Остановка: отправляю «{}» в консоль…", graceful));
        if self.command(id, &graceful).is_err() {
            self.log(id, "system", "Не удалось отправить команду остановки, завершаю принудительно.");
            return self.kill(id);
        }
        self.inner.runtimes.lock().unwrap().entry(id.to_string()).or_default().stopping = true;
        self.set_state(id, ServerState::Stopping);

        let timeout = if cfg.stop_timeout > 0 { cfg.stop_timeout } else { DEFAULT_STOP_TIMEOUT };
        let manager = self.clone();
        let target = id.to_string();
        std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout);
            while std::time::Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(50));
                if manager.state(&target) != ServerState::Stopping {
                    return;
                }
            }
            if manager.state(&target) == ServerState::Stopping {
                manager.log(
                    &target,
                    "system",
                    format!("Сервер не ответил за {} с — принудительное завершение.", timeout / 1000),
                );
                manager.force_kill(&target);
            }
        });
        true
    }

    /// Жёсткая остановка: процесс и всё его дерево.
    pub fn kill(&self, id: &str) -> bool {
        let pid = self.pid(id);
        if let Some(pid) = pid {
            self.log(id, "system", format!("Принудительное завершение процесса (PID {})", pid));
        }
        {
            let mut rt = self.inner.runtimes.lock().unwrap();
            if let Some(r) = rt.get_mut(id) {
                r.manual_stop = true;
                r.stopping = false;
            }
        }
        self.force_kill(id);
        pid.is_some()
    }

    fn force_kill(&self, id: &str) {
        let mut rt = self.inner.runtimes.lock().unwrap();
        let Some(r) = rt.get_mut(id) else { return };
        if let Some(pid) = r.pid {
            #[cfg(windows)]
            {
                let _ = Command::new("taskkill")
                    .args(["/pid", &pid.to_string(), "/T", "/F"])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
            #[cfg(not(windows))]
            {
                /* на Unix процесс запущен в своей группе — гасим всю группу */
                let _ = Command::new("kill")
                    .args(["-9", &format!("-{}", pid)])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
                let _ = Command::new("kill")
                    .args(["-9", &pid.to_string()])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
        }
        if let Some(mut child) = r.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        r.stdin = None;
        r.pid = None;
        r.started_at = None;
        r.state = ServerState::Stopped;
        r.stopping = false;
    }

    /// Остановить всё — при закрытии панели.
    pub fn stop_all(&self) {
        for cfg in self.servers() {
            if self.state(&cfg.id) != ServerState::Stopped {
                self.kill(&cfg.id);
            }
        }
    }

    /// Отметить завершение процесса — вызывается сторожем, когда сервер вышел сам.
    pub fn mark_exited(&self, id: &str, code: Option<i32>) {
        let (manual, lived_ms) = {
            let mut rt = self.inner.runtimes.lock().unwrap();
            match rt.get_mut(id) {
                Some(r) => {
                    /* сколько прожил процесс — чтобы отличить «не запустился»
                       от «поработал и упал» */
                    let lived = r.started_at.map(|t| (self.inner.clock)() - t).unwrap_or(0);
                    r.child = None;
                    r.pid = None;
                    r.stdin = None;
                    r.exit_code = code;
                    r.started_at = None;
                    r.state = ServerState::Stopped;
                    r.stopping = false;
                    (r.manual_stop, lived)
                }
                None => return,
            }
        };
        let код = code.map(|c| c.to_string()).unwrap_or_else(|| "—".to_string());
        self.log(id, "system", format!("Процесс завершён (код: {})", код));
        /* запуск провалился сразу же — чаще всего не нашлась сама программа
           (`java`, `node`): говорим об этом прямым текстом, а не «процесс завершён» */
        if !manual && code.map(|c| c != 0).unwrap_or(false) {
            let quick = lived_ms < 5000;
            let tail: Vec<String> = self
                .logs(id)
                .into_iter()
                .rev()
                .take(8)
                .map(|line| line.to_lowercase())
                .collect();
            let not_found = tail.iter().any(|line| {
                line.contains("is not recognized")
                    || line.contains("не является внутренней")
                    || line.contains("no such file")
                    || line.contains("не найден")
                    || line.contains("cannot find")
            });
            if quick && not_found {
                self.log(
                    id,
                    "system",
                    "Похоже, программы из команды нет в этой системе — проверь путь в команде запуска или поставь её.",
                );
            } else if quick {
                self.log(
                    id,
                    "system",
                    "Сервер завершился сразу после запуска — смотри строки выше: обычно там причина.",
                );
            }
        }
        self.emit(id, EventKind::Exit, код);

        let auto_restart = self.find(id).map(|c| c.auto_restart).unwrap_or(false);
        if auto_restart && !manual {
            self.log(id, "system", format!("Автоперезапуск через {} с…", RESTART_DELAY / 1000));
            let manager = self.clone();
            let target = id.to_string();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(RESTART_DELAY));
                if manager.find(&target).is_some() && manager.state(&target) == ServerState::Stopped {
                    let _ = manager.start(&target);
                }
            });
        }
    }
}

fn merge(base: Value, patch: Value) -> Value {
    match (base, patch) {
        (Value::Obj(mut pairs), Value::Obj(extra)) => {
            for (key, value) in extra {
                if let Some(slot) = pairs.iter_mut().find(|(k, _)| *k == key) {
                    slot.1 = value;
                } else {
                    pairs.push((key, value));
                }
            }
            Value::Obj(pairs)
        }
        (base, _) => base,
    }
}

/* ───────────── хранилище настроек ───────────── */

/// Хранилище `servers.json` рядом с программой.
pub struct Store {
    path: std::path::PathBuf,
}

impl Store {
    pub fn new(path: impl Into<std::path::PathBuf>) -> Self {
        Store { path: path.into() }
    }

    pub fn path(&self) -> &std::path::Path {
        &self.path
    }

    /// Читает файл. Если его нет или он битый — пустой список, как в панели.
    pub fn load(&self) -> Vec<ServerConfig> {
        let Ok(text) = std::fs::read_to_string(&self.path) else {
            return Vec::new();
        };
        parse_servers(&text)
    }

    /// Пишет файл (папка создаётся сама).
    pub fn save(&self, list: &[ServerConfig]) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&self.path, to_json(list))
    }
}

/// Список серверов в виде JSON-текста (для файла настроек).
pub fn to_json(list: &[ServerConfig]) -> String {
    let arr = Value::Arr(list.iter().map(|s| s.to_json()).collect());
    let mut text = arr.to_json_pretty();
    text.push('\n');
    text
}

/// Разбор `servers.json`. Битый файл не роняет панель — возвращается пусто.
pub fn parse_servers(text: &str) -> Vec<ServerConfig> {
    match crate::json::parse(text) {
        Ok(Value::Arr(items)) => items.iter().map(ServerConfig::from_json).collect(),
        _ => Vec::new(),
    }
}
