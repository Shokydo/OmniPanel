//! HTTP-режим панели: Rust отдаёт интерфейс и отвечает на его запросы.
//!
//! Зачем это нужно до появления окна: интерфейс панели уже умеет работать через
//! `httpApi` (см. `ui/app.js:5`), поэтому достаточно поднять сервер — и настоящий
//! интерфейс запускается на Rust без единой правки в нём. Это же удобно для
//! проверки: всё, что работает здесь, будет работать и в окне.
//!
//! Своими руками, на стандартной библиотеке: ни одного внешнего крейта.

use crate::app::App;
use crate::json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// Соединения, которым надо отправить событие (открытые страницы).
type Listeners = Arc<Mutex<Vec<TcpStream>>>;

/// Сервер панели.
pub struct PanelServer {
    app: Arc<App>,
    ui_dir: PathBuf,
    /// Где искать папку `assets`: иконки, обои, встроенные аддоны. Интерфейс
    /// ссылается на них как `../assets/…`, то есть просит `/assets/…` у этого
    /// сервера — раньше он отвечал 404, и картинки в окне не грузились.
    /// Путей несколько: рядом с exe, на уровень выше, в ресурсах — смотря как
    /// собрана и установлена панель.
    assets_dirs: Vec<PathBuf>,
    listeners: Listeners,
    stop: Arc<AtomicBool>,
}

impl PanelServer {
    /// Где лежат картинки панели: папка `assets` рядом с программой.
    pub fn with_assets(mut self, dir: impl Into<PathBuf>) -> PanelServer {
        let dir = dir.into();
        if !self.assets_dirs.contains(&dir) {
            self.assets_dirs.push(dir);
        }
        self
    }

    /// Первая существующая папка с картинками (для лога и проверок).
    pub fn assets_found(&self) -> Option<&PathBuf> {
        self.assets_dirs.iter().find(|dir| dir.is_dir())
    }

    pub fn new(app: Arc<App>, ui_dir: impl Into<PathBuf>) -> PanelServer {
        let listeners: Listeners = Arc::new(Mutex::new(Vec::new()));

        /* события серверов уходят в открытые страницы: лог, состояние, выход */
        let sink = Arc::clone(&listeners);
        let panel = Arc::clone(&app);
        app.manager().subscribe(move |event| {
            /* Формат событий — тот, который ждёт интерфейс.
               Раньше в строке журнала уходило { line, state, at }, а страница
               читает { entry: { t, m, s } }: строка журнала приходила как
               undefined, обработчик падал, и консоль не обновлялась вовсе. */
            use crate::servers::EventKind;
            match event.kind {
                EventKind::Log | EventKind::Error => {
                    let payload = Value::obj(vec![
                        ("id", Value::str(&event.id)),
                        (
                            "entry",
                            Value::obj(vec![
                                ("t", Value::from(event.at)),
                                ("m", Value::str(&event.text)),
                                (
                                    "s",
                                    Value::str(if event.level.is_empty() {
                                        "stdout".to_string()
                                    } else {
                                        event.level.clone()
                                    }),
                                ),
                            ]),
                        ),
                    ])
                    .to_json();
                    broadcast(&sink, "log", &payload);
                }
                EventKind::State | EventKind::Exit => {
                    let state = if matches!(event.kind, EventKind::Exit) {
                        "stopped".to_string()
                    } else {
                        event.text.clone()
                    };
                    let payload = Value::obj(vec![
                        ("id", Value::str(&event.id)),
                        ("state", Value::str(state)),
                        (
                            "pid",
                            event.pid.map(|p| Value::from(p as u64)).unwrap_or(Value::Null),
                        ),
                        (
                            "startedAt",
                            event.started_at.map(Value::from).unwrap_or(Value::Null),
                        ),
                        ("at", Value::from(event.at)),
                    ])
                    .to_json();
                    broadcast(&sink, "state", &payload);
                }
                EventKind::Tps => {
                    let value: f64 = event.text.trim().parse().unwrap_or(0.0);
                    let history: Vec<Value> = panel
                        .manager()
                        .tps_history(&event.id)
                        .iter()
                        .map(|point| point.to_json())
                        .collect();
                    let payload = Value::obj(vec![
                        ("id", Value::str(&event.id)),
                        ("tps", Value::Num(value)),
                        ("history", Value::Arr(history)),
                    ])
                    .to_json();
                    broadcast(&sink, "tps", &payload);
                }
            }
        });

        /* события панели (поиск серверов, шаги синхронизации, перенос папки)
           тоже уходят в открытые страницы — под своим именем */
        let sink = Arc::clone(&listeners);
        app.on_event(move |channel, payload| {
            broadcast(&sink, channel, payload);
        });

        /* Раз в несколько секунд отправляем в открытые страницы пустой
           комментарий: так видно, что связь жива, и прокси с антивирусом не
           закрывают «молчащий» поток. */
        let beat = Arc::downgrade(&listeners);
        std::thread::spawn(move || {
            let period = std::env::var("OMNI_SSE_PING")
                .ok()
                .and_then(|value| value.parse::<u64>().ok())
                .filter(|value| *value > 0)
                .unwrap_or(15);
            loop {
                std::thread::sleep(std::time::Duration::from_secs(period));
                let Some(listeners) = beat.upgrade() else { break };
                let mut list = listeners.lock().unwrap();
                if list.is_empty() {
                    continue;
                }
                list.retain_mut(|stream| write_chunk(stream, ": keep\n\n").is_ok());
            }
        });

        PanelServer {
            app,
            ui_dir: ui_dir.into(),
            assets_dirs: Vec::new(),
            listeners,
            stop: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Запускает сервер и работает, пока его не остановят.
    pub fn serve(self: Arc<Self>, port: u16) -> std::io::Result<()> {
        let listener = TcpListener::bind(("0.0.0.0", port))?;
        serve_on(listener, self)
    }

    /// Готовый слушатель: тесты берут порт 0, и система сама выбирает свободный.
    pub fn serve_listener(self: Arc<Self>, listener: TcpListener) -> std::io::Result<()> {
        serve_on(listener, self)
    }
}

/// Работа сервера на уже открытом слушателе.
fn serve_on(listener: TcpListener, server: Arc<PanelServer>) -> std::io::Result<()> {
    for stream in listener.incoming() {
        if server.stop.load(Ordering::Relaxed) {
            break;
        }
        let Ok(stream) = stream else { continue };
        let handler = Arc::clone(&server);
        std::thread::spawn(move || {
            let _ = handler.handle(stream);
        });
    }
    Ok(())
}

impl PanelServer {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }

    /// Приложение панели — окну оно нужно, чтобы показать состояние.
    pub fn app(&self) -> Arc<App> {
        Arc::clone(&self.app)
    }

    fn handle(&self, mut stream: TcpStream) -> std::io::Result<()> {
        let mut reader = BufReader::new(stream.try_clone()?);
        let mut request_line = String::new();
        reader.read_line(&mut request_line)?;
        if request_line.trim().is_empty() {
            return Ok(());
        }
        let mut parts = request_line.split_whitespace();
        let method = parts.next().unwrap_or("GET").to_string();
        let target = parts.next().unwrap_or("/").to_string();

        /* заголовки: нужна длина тела для POST */
        let mut length = 0usize;
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line)? == 0 {
                break;
            }
            let trimmed = line.trim_end();
            if trimmed.is_empty() {
                break;
            }
            if let Some((name, value)) = trimmed.split_once(':') {
                if name.eq_ignore_ascii_case("content-length") {
                    length = value.trim().parse().unwrap_or(0);
                }
            }
        }
        let mut body = vec![0u8; length];
        if length > 0 {
            reader.read_exact(&mut body)?;
        }

        let (path, query) = match target.split_once('?') {
            Some((p, q)) => (p.to_string(), q.to_string()),
            None => (target.clone(), String::new()),
        };

        /* поток событий: соединение остаётся открытым */
        /* поток событий: соединение остаётся открытым */
        if path == "/api/events" {
            /* Ответ отдаём кусками (chunked). Без разметки кусков и без
               Content-Length браузер вправе считать, что тела нет вовсе, —
               тогда строки журнала остаются у него в буфере и консоль не
               обновляется, хотя сервер работает и строки в него приходят. */
            stream.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nCache-Control: no-cache, no-transform\r\nConnection: keep-alive\r\nTransfer-Encoding: chunked\r\nX-Accel-Buffering: no\r\n\r\n",
            )?;
            write_chunk(&mut stream, "retry: 2000\n\n")?;
            /* страница открылась позже тихой проверки — сразу расскажем,
               что уже известно про обновление */
            if let Some(state) = self.app.update_state() {
                let _ = write_chunk(
                    &mut stream,
                    &format!("event: upd:state\ndata: {}\n\n", state.to_json()),
                );
            }
            self.listeners.lock().unwrap().push(stream);
            return Ok(());
        }

        /* всё, что не /api, — файлы интерфейса */
        let response = if path.starts_with("/api/") {
            self.route(&method, &path, &query, &body)
        } else {
            self.static_file(&path).unwrap_or_else(Response::not_found)
        };
        write_response(&mut stream, response)
    }

    fn route(&self, method: &str, path: &str, query: &str, body: &[u8]) -> Response {
        /* сколько страниц сейчас слушает поток событий: по этому числу видно,
           работает ли живое обновление консоли в окне */
        if path == "/api/events/info" {
            let count = self.listeners.lock().unwrap().len();
            return Response::json(
                200,
                &Value::obj(vec![
                    ("ok", Value::Bool(true)),
                    ("listeners", Value::from(count as u64)),
                ])
                .to_json(),
            );
        }
        let params = parse_query(query);
        let body_json = if body.is_empty() {
            Value::Obj(Vec::new())
        } else {
            crate::json::parse(&String::from_utf8_lossy(body)).unwrap_or(Value::Obj(Vec::new()))
        };
        let arg = |key: &str| params.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone()).unwrap_or_default();

        /* ── файл обоев: отдаём как есть, чтобы фон работал и в браузере ── */
        if method == "GET" {
            if let Some(name) = path.strip_prefix("/api/wall/") {
                if name != "list" {
                    /* имя в адресе закодировано — кириллица и пробелы */
                    let name = percent_decode(name);
                    let Some(safe) = crate::wall::safe_name(&name) else {
                        return Response::not_found();
                    };
                    let file = crate::wall::dir(&self.app.info().data_dir).join(&safe);
                    return match std::fs::read(&file) {
                        Ok(bytes) => Response::binary(200, crate::wall::mime(&safe), bytes),
                        Err(_) => Response::not_found(),
                    };
                }
            }
        }

        /* ── всё, что уже умеет Rust, отвечает по своим каналам ── */
        let (channel, args): (&str, Vec<Value>) = match (method, path) {
            ("GET", "/api/servers") => ("servers:list", vec![]),
            ("POST", "/api/servers") => ("servers:add", vec![body_json.clone()]),
            ("GET", "/api/info") => ("app:info", vec![]),
            ("GET", "/api/checkPath") => ("path:check", vec![Value::str(arg("path"))]),
            ("POST", "/api/open") => ("shell:openPath", vec![Value::Str(body_json.get("path").map(|v| v.text()).unwrap_or_default())]),
            ("GET", "/api/props") => ("props:read", vec![Value::str(arg("id"))]),
            ("POST", "/api/props") => ("props:write", vec![Value::str(arg("id")), body_json.clone()]),
            ("POST", "/api/win/minimize") => ("win:minimize", vec![]),
            ("POST", "/api/win/close") => ("win:close", vec![]),
            ("POST", "/api/win/quit") => ("win:quit", vec![]),
            ("POST", "/api/win/toggleMax") => ("win:toggleMax", vec![]),
            ("POST", "/api/win/toggleFull") => ("win:toggleFull", vec![]),
            ("GET", "/api/win/state") => ("win:state", vec![]),
            ("GET", "/api/win/visible") => ("win:isVisible", vec![]),
            ("GET", "/api/win/startMode") => ("win:getStartMode", vec![]),
            ("POST", "/api/win/startMode") => (
                "win:setStartMode",
                vec![Value::Str(body_json.get("mode").map(|v| v.text()).unwrap_or_default())],
            ),
            ("GET", "/api/win") => ("win:state", vec![]),
            ("GET", "/api/ports/own") => ("ports:own", vec![Value::str(arg("id"))]),
            ("GET", "/api/ports/check") => ("ports:check", vec![Value::str(arg("id"))]),
            ("GET", "/api/ports/free") => ("ports:free", vec![Value::str(arg("id")), Value::str(arg("from"))]),
            ("POST", "/api/ports/set") => (
                "ports:set",
                vec![
                    Value::Str(body_json.get("id").map(|v| v.text()).unwrap_or_default()),
                    Value::Str(body_json.get("key").map(|v| v.text()).unwrap_or_default()),
                    body_json.get("port").cloned().unwrap_or(Value::Num(0.0)),
                ],
            ),
            ("POST", "/api/files/upload") => (
                "files:upload",
                vec![
                    Value::Str(body_json.get("id").map(|v| v.text()).unwrap_or_default()),
                    Value::Str(body_json.get("rel").map(|v| v.text()).unwrap_or_default()),
                    Value::Str(body_json.get("name").map(|v| v.text()).unwrap_or_default()),
                    Value::Str(body_json.get("data").map(|v| v.text()).unwrap_or_default()),
                ],
            ),
            ("GET", "/api/files/editor") | ("POST", "/api/files/editor") => (
                "files:editor",
                vec![
                    Value::Str(body_json.get("id").map(|v| v.text()).unwrap_or_else(|| arg("id"))),
                    Value::Str(body_json.get("rel").map(|v| v.text()).unwrap_or_else(|| arg("rel"))),
                ],
            ),
            ("POST", "/api/server/editor") => (
                "server:editor",
                vec![Value::Str(body_json.get("id").map(|v| v.text()).unwrap_or_default())],
            ),
            /* ── свои обои, окна вопросов, уведомления ── */
            /* ── мастер создания сервера ── */
            ("GET", "/api/wizard/catalog") => ("wizard:catalog", vec![]),
            ("GET", "/api/wizard/versions") => ("wizard:versions", vec![Value::str(arg("id"))]),
            ("GET", "/api/wizard/java") => ("wizard:java", vec![]),
            ("POST", "/api/wizard/openJava") => ("wizard:openJava", vec![]),
            ("POST", "/api/wizard/pickParent") => ("wizard:pickParent", vec![]),
            ("GET", "/api/wizard/suggestDir") => (
                "wizard:suggestDir",
                vec![Value::str(arg("parent")), Value::str(arg("name"))],
            ),
            ("POST", "/api/wizard/create") => ("wizard:create", vec![body_json.clone()]),
            /* ── передача сервера по токену ── */
            ("POST", "/api/share/create") => (
                "share:create",
                vec![
                    body_json.get("id").cloned().unwrap_or(Value::Null),
                    body_json.get("lean").cloned().unwrap_or(Value::Null),
                ],
            ),
            ("POST", "/api/share/receive") => (
                "share:receive",
                vec![
                    body_json.get("token").cloned().unwrap_or(Value::Null),
                    body_json.get("dir").cloned().unwrap_or(Value::Null),
                    body_json.get("name").cloned().unwrap_or(Value::Null),
                ],
            ),
            ("GET", "/api/share/list") => ("share:list", vec![]),
            ("POST", "/api/share/revoke") => (
                "share:revoke",
                vec![body_json.get("token").cloned().unwrap_or(Value::Null)],
            ),
            /* ── аддоны панели ── */
            ("GET", "/api/addons/list") => ("addons:list", vec![]),
            ("GET", "/api/addons/dirs") => ("addons:dirs", vec![]),
            ("GET", "/api/addons/panel") => ("addons:panel", vec![Value::str(arg("id"))]),
            ("POST", "/api/addons/toggle") => (
                "addons:setEnabled",
                vec![
                    Value::str(body_json.get("id").map(|v| v.text()).unwrap_or_default()),
                    Value::Bool(body_json.get("on").map(|v| v.as_bool()).unwrap_or(false)),
                ],
            ),
            ("POST", "/api/addons/reveal") => (
                "addons:reveal",
                vec![Value::str(body_json.get("id").map(|v| v.text()).unwrap_or_default())],
            ),
            ("POST", "/api/addons/call") => (
                "addons:call",
                vec![
                    Value::str(body_json.get("id").map(|v| v.text()).unwrap_or_default()),
                    Value::str(body_json.get("method").map(|v| v.text()).unwrap_or_default()),
                    body_json.get("args").cloned().unwrap_or(Value::Arr(Vec::new())),
                    Value::str(body_json.get("serverId").map(|v| v.text()).unwrap_or_default()),
                ],
            ),
            /* ── нагрузочный тест ботами ── */
            ("GET", "/api/load/info") => ("load:info", vec![Value::str(arg("id"))]),
            ("GET", "/api/load/status") => ("load:status", vec![]),
            ("GET", "/api/load/versions") => ("load:versions", vec![]),
            ("POST", "/api/load/start") => (
                "load:start",
                vec![
                    Value::str(body_json.get("id").map(|v| v.text()).unwrap_or_else(|| arg("id"))),
                    body_json.clone(),
                ],
            ),
            ("POST", "/api/load/stop") => ("load:stop", vec![]),
            /* ── каталог Modrinth ── */
            ("GET", "/api/modrinth/search") => (
                "modrinth:search",
                vec![Value::Obj(
                    params
                        .iter()
                        .map(|(key, value)| (key.clone(), Value::Str(value.clone())))
                        .collect(),
                )],
            ),
            ("GET", "/api/modrinth/versions") => (
                "modrinth:versions",
                vec![
                    Value::str(arg("id")),
                    Value::obj(vec![
                        ("loader", Value::str(arg("loader"))),
                        ("version", Value::str(arg("version"))),
                    ]),
                ],
            ),
            ("GET", "/api/modrinth/categories") => ("modrinth:categories", vec![Value::str(arg("type"))]),
            ("GET", "/api/modrinth/detect") => ("modrinth:detect", vec![Value::str(arg("id"))]),
            ("GET", "/api/modrinth/installed") => ("modrinth:installed", vec![Value::str(arg("id"))]),
            ("POST", "/api/modrinth/install") => (
                "modrinth:install",
                vec![
                    Value::str(body_json.get("serverId").map(|v| v.text()).unwrap_or_else(|| arg("id"))),
                    body_json.clone(),
                ],
            ),
            ("POST", "/api/backup/delete") => (
                "backup:delete",
                vec![
                    Value::str(""),
                    Value::str(body_json.get("file").map(|v| v.text()).unwrap_or_default()),
                ],
            ),
            ("GET", "/api/wall/list") => ("wall:list", vec![]),
            ("POST", "/api/wall/pick") => ("wall:pick", vec![]),
            ("POST", "/api/wall/remove") => ("wall:remove", vec![Value::str(arg("name"))]),
            ("POST", "/api/wall/palette") => ("wall:palette", vec![body_json.clone()]),
            ("POST", "/api/ui/ready") => ("ui:ready", vec![]),
            ("POST", "/api/ui/answer") => (
                "ui:answer",
                vec![
                    body_json.get("rid").cloned().unwrap_or(Value::Num(0.0)),
                    Value::str(body_json.get("id").map(|v| v.text()).unwrap_or_default()),
                ],
            ),
            ("POST", "/api/notify/desktop") => ("notify:desktop", vec![body_json.clone()]),
            /* ── поиск серверов, диалоги, иконки, автозапуск ── */
            ("GET", "/api/scan/roots") => ("scan:roots", vec![]),
            ("POST", "/api/scan/start") => ("scan:start", vec![body_json.clone()]),
            ("POST", "/api/scan/cancel") => ("scan:cancel", vec![]),
            ("POST", "/api/dialog/pickFolder") => ("dialog:pickFolder", vec![]),
            ("POST", "/api/dialog/pickFile") => ("dialog:pickFile", vec![]),
            ("POST", "/api/dialog/pickFolders") => ("dialog:pickFolders", vec![]),
            ("POST", "/api/icon/pick") => ("icon:pick", vec![]),
            ("GET", "/api/icon/fromServer") => ("icon:fromServer", vec![Value::str(arg("cwd"))]),
            ("POST", "/api/icon/toServer") => (
                "icon:toServer",
                vec![
                    Value::str(arg("cwd")),
                    Value::str(body_json.get("dataUrl").map(|v| v.text()).unwrap_or_default()),
                ],
            ),
            ("GET", "/api/autostart/get") => ("autostart:get", vec![]),
            ("POST", "/api/autostart/set") => (
                "autostart:set",
                vec![Value::Bool(body_json.get("value").map(|v| v.as_bool()).unwrap_or(false))],
            ),
            ("POST", "/api/server/moveToApp") => (
                "server:moveToApp",
                vec![Value::str(arg("id")), body_json.clone()],
            ),
            ("POST", "/api/shell/editor") => (
                "shell:editor",
                vec![Value::str(body_json.get("path").map(|v| v.text()).unwrap_or_else(|| arg("path")))],
            ),
            /* ── синхронизация сервера ── */
            ("GET", "/api/gh/account") => ("gh:account", vec![]),
            ("POST", "/api/gh/login") => ("gh:login", vec![Value::str(body_json.get("token").map(|v| v.text()).unwrap_or_default())]),
            ("POST", "/api/gh/logout") => ("gh:logout", vec![]),
            ("GET", "/api/gh/oauthClientId") => ("gh:oauthClientId", vec![]),
            ("POST", "/api/gh/setOauthClientId") => (
                "gh:setOauthClientId",
                vec![Value::str(body_json.get("id").map(|v| v.text()).unwrap_or_default())],
            ),
            ("POST", "/api/gh/deviceStart") => ("gh:deviceStart", vec![]),
            ("POST", "/api/gh/devicePoll") => (
                "gh:devicePoll",
                vec![Value::str(body_json.get("deviceCode").map(|v| v.text()).unwrap_or_default())],
            ),
            ("POST", "/api/gh/openExternal") => (
                "gh:openExternal",
                vec![Value::str(body_json.get("url").map(|v| v.text()).unwrap_or_default())],
            ),
            ("GET", "/api/gh/repos") => ("gh:repos", vec![Value::str(arg("q"))]),
            ("POST", "/api/gh/createRepo") => (
                "gh:createRepo",
                vec![
                    Value::str(body_json.get("name").map(|v| v.text()).unwrap_or_default()),
                    Value::Bool(body_json.get("private").map(|v| v.as_bool()).unwrap_or(true)),
                ],
            ),
            ("GET", "/api/gh/verify") => ("gh:verify", vec![Value::str(arg("id"))]),
            ("POST", "/api/gh/verify") => ("gh:verify", vec![body_json.clone()]),
            ("POST", "/api/gh/download") => ("gh:download", vec![body_json.clone()]),
            ("GET", "/api/gh/status") => ("gh:status", vec![Value::str(arg("id"))]),
            ("POST", "/api/gh/forget") => ("gh:forget", vec![Value::str(arg("id"))]),
            ("POST", "/api/gh/check") => ("gh:check", vec![Value::str(arg("id"))]),
            ("POST", "/api/gh/push") => ("gh:push", vec![Value::str(arg("id"))]),
            ("POST", "/api/gh/pull") => ("gh:pull", vec![Value::str(arg("id"))]),
            ("GET", "/api/gl/account") => ("gl:account", vec![]),
            ("POST", "/api/gl/save") => ("gl:save", vec![Value::str(body_json.get("token").map(|v| v.text()).unwrap_or_default())]),
            ("GET", "/api/gl/projects") => ("gl:projects", vec![Value::str(arg("q"))]),
            ("POST", "/api/gl/check") => ("gl:check", vec![body_json.clone()]),
            /* ── обновления ── */
            ("GET", "/api/upd/config") => ("upd:config", vec![]),
            ("POST", "/api/upd/save") => ("upd:save", vec![body_json.clone()]),
            ("POST", "/api/upd/check") => ("upd:check", vec![]),
            ("POST", "/api/upd/apply") => ("upd:apply", vec![]),
            ("POST", "/api/upd/auto") => ("upd:auto", vec![]),
            ("POST", "/api/upd/downloadFull") => ("upd:downloadFull", vec![]),
            ("GET", "/api/upd/lastResult") => ("upd:lastResult", vec![]),
            ("POST", "/api/upd/revealBackups") => ("upd:revealBackups", vec![]),
            _ => {
                /* пути вида /api/servers/<id>/... и /api/files/<действие> */
                if let Some(rest) = path.strip_prefix("/api/servers/") {
                    let mut parts = rest.splitn(2, '/');
                    let id = parts.next().unwrap_or("").to_string();
                    let tail = parts.next().unwrap_or("");
                    match (method, tail) {
                        ("DELETE", "") => ("servers:remove", vec![Value::str(id)]),
                        ("PUT", "") | ("POST", "") => ("servers:update", vec![Value::str(id), body_json.clone()]),
                        ("POST", "start") => ("server:start", vec![Value::str(id)]),
                        ("POST", "stop") => ("server:stop", vec![Value::str(id)]),
                        ("POST", "restart") => ("server:restart", vec![Value::str(id)]),
                        ("POST", "kill") => ("server:kill", vec![Value::str(id)]),
                        ("POST", "command") => (
                            "server:command",
                            vec![
                                Value::str(id),
                                Value::Str(body_json.get("cmd").map(|v| v.text()).unwrap_or_default()),
                            ],
                        ),
                        ("GET", "logs") => ("server:logs", vec![Value::str(id)]),
                        ("POST", "clearLogs") => ("server:clearLogs", vec![Value::str(id)]),
                        ("GET", "bans") => ("bans:list", vec![Value::str(id)]),
                        ("POST", "bans/unban") => ("bans:unban", vec![Value::str(id), body_json.clone()]),
                        ("POST", "bans/ban") => ("bans:ban", vec![Value::str(id), body_json.clone()]),
                        ("GET", "tps") => ("tps:history", vec![Value::str(id)]),
                        ("GET", "backups") => ("backup:list", vec![Value::str(id)]),
                        ("POST", "backups/create") => ("backup:create", vec![Value::str(id), body_json.clone()]),
                        ("POST", "backups/restore") => (
                            "backup:restore",
                            vec![
                                Value::str(id),
                                Value::str(body_json.get("file").map(|v| v.text()).unwrap_or_default()),
                                body_json.clone(),
                            ],
                        ),
                        ("POST", "backups/delete") => (
                            "backup:delete",
                            vec![
                                Value::str(id),
                                Value::str(body_json.get("file").map(|v| v.text()).unwrap_or_default()),
                            ],
                        ),
                        ("GET", "backups/size") => ("backup:size", vec![Value::str(id)]),
                        ("POST", "backups/reveal") => ("backup:reveal", vec![Value::str(id)]),
                        _ => {
                            return Response::json(
                                200,
                                &Value::obj(vec![
                                    ("ok", Value::Bool(false)),
                                    ("error", Value::str(format!("адрес {} ещё не перенесён", path))),
                                ])
                                .to_json(),
                            )
                        }
                    }
                } else if let Some(action) = path.strip_prefix("/api/archive/") {
                    /* архивы: список содержимого, файл из архива, распаковка */
                    let channel = format!("archive:{}", action);
                    let id = Value::str(arg("id"));
                    let rel = Value::Str(
                        body_json
                            .get("rel")
                            .map(|v| v.text())
                            .unwrap_or_else(|| arg("rel")),
                    );
                    let args = match action {
                        "open" => vec![id, rel],
                        "read" => vec![
                            id,
                            rel,
                            Value::Str(
                                body_json
                                    .get("name")
                                    .map(|v| v.text())
                                    .unwrap_or_else(|| arg("name")),
                            ),
                        ],
                        "extract" => vec![
                            id,
                            rel,
                            Value::Str(
                                body_json
                                    .get("dest")
                                    .map(|v| v.text())
                                    .unwrap_or_else(|| arg("dest")),
                            ),
                            Value::Str(
                                body_json
                                    .get("only")
                                    .map(|v| v.text())
                                    .unwrap_or_else(|| arg("only")),
                            ),
                        ],
                        _ => {
                            return Response::json(
                                200,
                                &Value::obj(vec![
                                    ("ok", Value::Bool(false)),
                                    (
                                        "error",
                                        Value::str(format!("архивное действие «{}» неизвестно", action)),
                                    ),
                                ])
                                .to_json(),
                            )
                        }
                    };
                    return match self.app.invoke(&channel, &args) {
                        Ok(value) => Response::json(200, &value.to_json()),
                        Err(err) => Response::json(
                            200,
                            &Value::obj(vec![
                                ("ok", Value::Bool(false)),
                                ("error", Value::str(err)),
                            ])
                            .to_json(),
                        ),
                    };
                } else if let Some(action) = path.strip_prefix("/api/files/") {
                    let channel = match action {
                        "list" | "read" | "search" => format!("files:{}", action),
                        _ => format!("files:{}", action),
                    };
                    let mut args = vec![Value::str(arg("id"))];
                    match action {
                        "list" | "read" | "remove" | "mkdir" => {
                            args.push(Value::Str(body_json.get("rel").map(|v| v.text()).unwrap_or_else(|| arg("rel"))));
                        }
                        "search" => args.push(Value::str(arg("q"))),
                        "write" => {
                            args.push(Value::Str(body_json.get("rel").map(|v| v.text()).unwrap_or_default()));
                            args.push(Value::Str(body_json.get("content").map(|v| v.text()).unwrap_or_default()));
                        }
                        "rename" => {
                            args.push(Value::Str(body_json.get("rel").map(|v| v.text()).unwrap_or_default()));
                            args.push(Value::Str(body_json.get("name").map(|v| v.text()).unwrap_or_default()));
                        }
                        "move" => {
                            args.push(Value::Str(body_json.get("from").map(|v| v.text()).unwrap_or_else(|| arg("from"))));
                            args.push(Value::Str(body_json.get("toDir").map(|v| v.text()).unwrap_or_else(|| arg("to"))));
                        }
                        "image" => args.push(Value::str(arg("rel"))),
                        _ => {}
                    }
                    return match self.app.invoke(&channel, &args) {
                        Ok(value) => Response::json(200, &value.to_json()),
                        Err(err) => Response::json(
                            200,
                            &Value::obj(vec![("ok", Value::Bool(false)), ("error", Value::str(err))]).to_json(),
                        ),
                    };
                } else {
                    /* адрес есть, но его часть ещё не перенесена — говорим об этом словами */
                    let (module, action) = match path.trim_start_matches("/api/").split_once('/') {
                        Some((m, a)) => (m.to_string(), a.to_string()),
                        None => (path.trim_start_matches("/api/").to_string(), String::new()),
                    };
                    return Response::json(
                        200,
                        &Value::obj(vec![
                            ("ok", Value::Bool(false)),
                            (
                                "error",
                                Value::str(format!(
                                    "команда «{}:{}» ещё не перенесена в Rust — она появится в следующем шаге",
                                    module, action
                                )),
                            ),
                        ])
                        .to_json(),
                    );
                }
            }
        };

        match self.app.invoke(channel, &args) {
            Ok(value) => Response::json(200, &value.to_json()),
            Err(err) => Response::json(
                200,
                &Value::obj(vec![("ok", Value::Bool(false)), ("error", Value::str(err))]).to_json(),
            ),
        }
    }

    /// Отдаёт файл интерфейса.
    fn static_file(&self, path: &str) -> Option<Response> {
        let mut rel = if path == "/" { "index.html" } else { path.trim_start_matches('/') };
        if rel.contains("..") {
            return None;
        }
        if rel.is_empty() {
            rel = "index.html";
        }
        let mut file = self.ui_dir.join(rel);
        /* картинки и встроенные аддоны лежат не в ui, а рядом с программой:
           интерфейс просит `../assets/…`, то есть `/assets/…` — отдаём их
           отсюда, иначе в окне остаются пустые места вместо иконок и обоев */
        if !file.exists() {
            let inner = rel.strip_prefix("assets/").unwrap_or(rel);
            for assets in &self.assets_dirs {
                let outside = assets.join(inner);
                if outside.exists() {
                    file = outside;
                    break;
                }
            }
        }
        if !file.exists() && !rel.contains('.') {
            /* адрес без файла — это раздел интерфейса, отдаём главную страницу */
            file = self.ui_dir.join("index.html");
            rel = "index.html";
        }
        /* папки интерфейса нет рядом с программой — вместо пустого 404
           показываем понятную страницу: так человек сразу видит, что делать */
        if rel == "index.html" && !file.exists() {
            return Some(Response::binary(200, "text/html; charset=utf-8", missing_ui_page().into_bytes()));
        }
        let bytes = std::fs::read(&file).ok()?;
        Some(Response::binary(200, mime_of(Path::new(rel)), bytes))
    }
}

/// Страница «нет папки ui» — на русском и без подсказок в интерфейсе панели.
fn missing_ui_page() -> String {
    r#"<!doctype html><html lang="ru"><head><meta charset="utf-8">
<title>OmniPanel</title><style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#0b0b0d;color:#e8e8ea;font:15px/1.6 "Segoe UI",system-ui,sans-serif}
.box{max-width:34rem;padding:2rem;border:1px solid #2a2a2e;border-radius:14px;background:#131316}
h1{margin:0 0 .8rem;font-size:1.15rem;letter-spacing:.02em}
code{background:#1c1c20;padding:.15rem .4rem;border-radius:6px}
p{margin:.6rem 0;color:#b9b9c0}
</style></head><body><div class="box">
<h1>Не хватает папки с интерфейсом</h1>
<p>Рядом с программой должна лежать папка <code>ui</code> — в ней сам интерфейс панели.</p>
<p>Распакуй архив целиком: папка <code>ui</code> идёт вместе с <code>OmniPanel.exe</code>.</p>
</div></body></html>"#
        .to_string()
}

fn broadcast(listeners: &Listeners, event: &str, payload: &str) {
    let message = format!("event: {}\ndata: {}\n\n", event, payload);
    let mut list = listeners.lock().unwrap();
    list.retain_mut(|stream| write_chunk(stream, &message).is_ok());
}

/// Один кусок ответа `Transfer-Encoding: chunked`.
fn write_chunk(stream: &mut TcpStream, payload: &str) -> std::io::Result<()> {
    stream.write_all(format!("{:x}\r\n", payload.len()).as_bytes())?;
    stream.write_all(payload.as_bytes())?;
    stream.write_all(b"\r\n")?;
    stream.flush()
}

/// Ответ сервера.
pub struct Response {
    status: u16,
    content_type: &'static str,
    body: Vec<u8>,
}

impl Response {
    pub fn json(status: u16, body: &str) -> Response {
        Response { status, content_type: "application/json; charset=utf-8", body: body.as_bytes().to_vec() }
    }

    pub fn binary(status: u16, content_type: &'static str, body: Vec<u8>) -> Response {
        Response { status, content_type, body }
    }

    pub fn not_found() -> Response {
        Response::json(404, r#"{"ok":false,"error":"не найдено"}"#)
    }
}

fn write_response(stream: &mut TcpStream, response: Response) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        response.status,
        if response.status == 200 { "OK" } else { "ERROR" },
        response.content_type,
        response.body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(&response.body)?;
    stream.flush()
}

fn parse_query(query: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let (key, value) = match pair.split_once('=') {
            Some((k, v)) => (k.to_string(), v.to_string()),
            None => (pair.to_string(), String::new()),
        };
        out.push((percent_decode(&key), percent_decode(&value)));
    }
    out
}

/// Разбор `%D0%9C` и `+` в адресе запроса.
pub fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(byte) => {
                        out.push(byte);
                        i += 3;
                    }
                    Err(_) => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            byte => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

fn mime_of(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}
