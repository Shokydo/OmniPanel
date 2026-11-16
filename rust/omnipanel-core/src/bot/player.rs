//! Сам бот: настоящее подключение к серверу Minecraft по протоколу.
//!
//! Как устроено (и почему так):
//!  * бот работает без своего потока — движок зовёт `tick()` по расписанию,
//!    поэтому двести ботов не превращаются в двести потоков;
//!  * сокет читается коротким таймаутом, недособранный пакет ждёт в буфере;
//!  * после входа бот обязан подтверждать `keep_alive`, иначе сервер его
//!    выкинет через полминуты — и «нагрузка» окажется фиктивной;
//!  * с 1.20.2 вход идёт через фазу настройки (configuration), а с 1.21.4 —
//!    ещё и с подтверждением `player_loaded`, без него сервер телепортирует
//!    игрока назад на спавн.

use super::protocol;
use crate::json::Value;
use crate::md5;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

/// Как часто бот шлёт своё положение (мс) — раз в тик, как настоящий клиент.
pub const TICK_MS: u64 = 50;
/// Выше этого шага сервер начинает ругаться «слишком быстро».
pub const MAX_STEP: f64 = 0.32;
/// Скорость шага: обычная ходьба и бег, блоков за тик.
const SPEED_WALK: f64 = 0.2158;
const SPEED_SPRINT: f64 = 0.2806;
/// С такой скоростью игрок отталкивается от земли.
const JUMP_VY: f64 = 0.42;

/// Что бот делает на сервере.
#[derive(Debug, Clone, PartialEq)]
pub struct Actions {
    pub walk: bool,
    pub walk_ms: u64,
    pub jump: bool,
    pub jump_ms: u64,
    /// Расходиться в разные стороны, а не идти толпой.
    pub spread: bool,
    /// Подпрыгивать на ходу.
    pub hop: bool,
    pub chat: bool,
    pub chat_text: String,
    pub chat_ms: u64,
    pub cmd: bool,
    pub commands: Vec<String>,
    pub cmd_ms: u64,
    pub swing: bool,
    pub swing_ms: u64,
}

impl Default for Actions {
    fn default() -> Self {
        Actions {
            walk: true,
            walk_ms: 50,
            jump: false,
            jump_ms: 3000,
            spread: true,
            hop: true,
            chat: false,
            chat_text: "нагрузочный тест OmniPanel".to_string(),
            chat_ms: 1000,
            cmd: false,
            commands: Vec::new(),
            cmd_ms: 1500,
            swing: true,
            swing_ms: 700,
        }
    }
}

impl Actions {
    /// Разбирает действия из интерфейса — те же поля и границы, что в прежней панели.
    pub fn from_json(raw: &Value) -> Actions {
        let flag = |name: &str, fallback: bool| {
            raw.get(name).map(|v| v.as_bool()).unwrap_or(fallback)
        };
        let number = |name: &str, fallback: u64, min: u64, max: u64| {
            match raw.get(name).and_then(|v| v.as_f64()) {
                Some(value) if value > 0.0 => (value.round() as u64).clamp(min, max),
                _ => fallback,
            }
        };
        let commands: Vec<String> = match raw.get("commands") {
            Some(Value::Arr(items)) => items
                .iter()
                .map(|item| item.text().trim_start_matches('/').trim().to_string())
                .filter(|item| !item.is_empty())
                .take(40)
                .collect(),
            Some(other) => other
                .text()
                .split(|c| c == '\n' || c == ',' || c == ';')
                .map(|item| item.trim().trim_start_matches('/').trim().to_string())
                .filter(|item| !item.is_empty())
                .take(40)
                .collect(),
            None => Vec::new(),
        };
        let text = raw
            .get("chatText")
            .map(|v| v.text())
            .unwrap_or_else(|| "нагрузочный тест OmniPanel".to_string());
        Actions {
            walk: flag("walk", true),
            walk_ms: number("walkMs", 50, 20, 5000),
            jump: flag("jump", false),
            jump_ms: number("jumpMs", 3000, 500, 600_000),
            spread: flag("spread", true),
            hop: flag("hop", true),
            chat: flag("chat", false),
            chat_text: text.chars().take(240).collect(),
            chat_ms: number("chatMs", 1000, 200, 600_000),
            cmd: flag("cmd", false) && !commands.is_empty(),
            commands,
            cmd_ms: number("cmdMs", 1500, 200, 600_000),
            swing: flag("swing", true),
            swing_ms: number("swingMs", 700, 100, 600_000),
        }
    }
}

/// Настройки одного бота.
#[derive(Debug, Clone)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub protocol: u32,
    pub name: String,
    pub index: usize,
    pub total: usize,
    pub actions: Actions,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            host: "127.0.0.1".to_string(),
            port: 25565,
            protocol: 765,
            name: "Bot".to_string(),
            index: 0,
            total: 1,
            actions: Actions::default(),
        }
    }
}

/// Что бот успел сделать — эти числа видит панель.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Stats {
    pub packets_in: u64,
    pub packets_out: u64,
    pub bytes_in: u64,
    pub bytes_out: u64,
    pub chunks: u64,
    pub chat: u64,
    pub commands: u64,
    pub moves: u64,
    pub jumps: u64,
    pub keep_alives: u64,
    /// Сколько метров бот прошёл — это видно в списке ботов.
    pub distance: f64,
}

impl Stats {
    pub fn to_json(&self) -> Value {
        Value::obj(vec![
            ("packetsIn", Value::from(self.packets_in)),
            ("packetsOut", Value::from(self.packets_out)),
            ("bytesIn", Value::from(self.bytes_in)),
            ("bytesOut", Value::from(self.bytes_out)),
            ("chunks", Value::from(self.chunks)),
            ("chunksLoaded", Value::from(self.chunks)),
            ("distance", Value::Num((self.distance * 10.0).round() / 10.0)),
            ("chat", Value::from(self.chat)),
            ("cmd", Value::from(self.commands)),
            ("moves", Value::from(self.moves)),
            ("jumps", Value::from(self.jumps)),
            ("keepAlives", Value::from(self.keep_alives)),
        ])
    }
}

/// Этап входа.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Idle,
    Login,
    Config,
    Play,
    Closed,
}

impl Stage {
    pub fn as_str(&self) -> &'static str {
        match self {
            Stage::Idle => "idle",
            Stage::Login => "login",
            Stage::Config => "config",
            Stage::Play => "play",
            Stage::Closed => "closed",
        }
    }
}

/// Один бот.
pub struct Bot {
    cfg: Config,
    socket: Option<TcpStream>,
    stage: Stage,
    buffer: Vec<u8>,
    /// Порог сжатия: -1 — сжатия нет.
    compression: i32,
    stats: Stats,
    /// Где бот стоит и куда смотрит.
    x: f64,
    y: f64,
    z: f64,
    yaw: f64,
    pitch: f64,
    on_ground: bool,
    vel_y: f64,
    /// Свой сектор расхождения по кругу.
    heading: f64,
    joined: bool,
    player_loaded: bool,
    last_move: Instant,
    last_jump: Instant,
    last_chat: Instant,
    last_cmd: Instant,
    last_swing: Instant,
    cmd_index: usize,
    last_error: String,
    started: Instant,
    log: Vec<String>,
}

impl Bot {
    pub fn new(cfg: Config) -> Bot {
        let sector = if cfg.total > 1 {
            (cfg.index as f64) * std::f64::consts::TAU / cfg.total as f64
        } else {
            0.0
        };
        let now = Instant::now();
        Bot {
            x: 0.5,
            y: 64.0,
            z: 0.5,
            yaw: sector.to_degrees(),
            pitch: 0.0,
            on_ground: true,
            vel_y: 0.0,
            heading: sector,
            socket: None,
            stage: Stage::Idle,
            buffer: Vec::new(),
            compression: -1,
            stats: Stats::default(),
            joined: false,
            player_loaded: false,
            last_move: now,
            last_jump: now,
            last_chat: now,
            last_cmd: now,
            last_swing: now,
            cmd_index: 0,
            last_error: String::new(),
            started: now,
            log: Vec::new(),
            cfg,
        }
    }

    pub fn name(&self) -> &str {
        &self.cfg.name
    }

    pub fn stage(&self) -> Stage {
        self.stage
    }

    pub fn stats(&self) -> &Stats {
        &self.stats
    }

    pub fn last_error(&self) -> &str {
        &self.last_error
    }

    pub fn is_joined(&self) -> bool {
        self.joined
    }

    pub fn uptime_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    /// Забирает накопленный журнал бота (панель показывает его в логе теста).
    pub fn take_log(&mut self) -> Vec<String> {
        std::mem::take(&mut self.log)
    }

    fn note(&mut self, text: impl Into<String>) {
        let text = text.into();
        if self.log.len() < 50 {
            self.log.push(text);
        }
    }

    /* ─────────────────────────── подключение ─────────────────────────── */

    /// Подключается к серверу и отправляет рукопожатие с ником.
    pub fn connect(&mut self) -> Result<(), String> {
        let address = format!("{}:{}", self.cfg.host, self.cfg.port);
        let socket = TcpStream::connect(&address)
            .map_err(|err| format!("сервер не отвечает на порту: {}", err))?;
        socket.set_nodelay(true).ok();
        socket
            .set_read_timeout(Some(Duration::from_millis(20)))
            .map_err(|err| format!("не настроить соединение: {}", err))?;
        self.socket = Some(socket);
        self.stage = Stage::Login;
        self.started = Instant::now();
        self.handshake()?;
        self.note(format!("{}: подключился к {}", self.cfg.name, address));
        Ok(())
    }

    fn handshake(&mut self) -> Result<(), String> {
        let host = self.cfg.host.as_bytes();
        let mut payload = protocol::varint_bytes(0x00);
        payload.extend_from_slice(&protocol::varint_bytes(self.cfg.protocol as i32));
        protocol::write_varint(&mut payload, host.len() as i32);
        payload.extend_from_slice(host);
        payload.extend_from_slice(&self.cfg.port.to_be_bytes());
        payload.extend_from_slice(&protocol::varint_bytes(2));
        self.send_raw(&payload)?;

        let uuid = md5::offline_uuid(&self.cfg.name);
        let values = Value::obj(vec![
            ("username", Value::str(&self.cfg.name)),
            ("playerUUID", Value::str(&uuid)),
            ("playerUuid", Value::str(&uuid)),
            ("hasPlayerUuid", Value::Bool(true)),
        ]);
        self.send_packet("login", "login_start", &values);
        Ok(())
    }

    /* ───────────────────────────── отправка ───────────────────────────── */

    fn send_raw(&mut self, payload: &[u8]) -> Result<(), String> {
        let Some(socket) = self.socket.as_mut() else {
            return Err("соединение закрыто".to_string());
        };
        let mut frame = Vec::new();
        if self.compression >= 0 {
            if payload.len() >= self.compression as usize {
                protocol::write_varint(&mut frame, payload.len() as i32);
                frame.extend_from_slice(&crate::deflate::compress(payload));
            } else {
                protocol::write_varint(&mut frame, 0);
                frame.extend_from_slice(payload);
            }
        } else {
            frame.extend_from_slice(payload);
        }
        let mut out = protocol::varint_bytes(frame.len() as i32);
        out.extend_from_slice(&frame);
        socket
            .write_all(&out)
            .map_err(|err| format!("не отправить пакет: {}", err))?;
        self.stats.packets_out += 1;
        self.stats.bytes_out += out.len() as u64;
        Ok(())
    }

    /// Отправляет пакет по описанию версии. Если такого пакета в таблицах нет —
    /// тихо пропускаем: у каждой версии свой набор, и это нормально.
    fn send_packet(&mut self, section: &str, name: &str, values: &Value) -> bool {
        let protocol_id = self.cfg.protocol;
        let Some(id) = protocol::id_of(protocol_id, section, name) else {
            return false;
        };
        let body = match protocol::write(protocol_id, section, name, values) {
            Ok(body) => body,
            Err(err) => {
                self.last_error = format!("пакет {}: {}", name, err);
                self.note(format!("{}: ошибка сборки {} — {}", self.cfg.name, name, err));
                return false;
            }
        };
        let mut payload = protocol::varint_bytes(id as i32);
        payload.extend_from_slice(&body);
        if self.send_raw(&payload).is_err() {
            return false;
        }
        true
    }

    /* ─────────────────────────────── приём ─────────────────────────────── */

    /// Один шаг бота: прочитать, что пришло, ответить, сделать действие.
    pub fn tick(&mut self) {
        if self.stage == Stage::Closed {
            return;
        }
        self.read_available();
        if self.stage == Stage::Closed {
            return;
        }
        self.actions_tick();
    }

    fn read_available(&mut self) {
        let mut chunk = [0u8; 16 * 1024];
        loop {
            let read = match self.socket.as_mut() {
                Some(socket) => match socket.read(&mut chunk) {
                    Ok(0) => {
                        self.close("сервер закрыл соединение");
                        return;
                    }
                    Ok(read) => read,
                    Err(err) => {
                        if matches!(
                            err.kind(),
                            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                        ) {
                            return;
                        }
                        self.close(&format!("соединение прервалось: {}", err));
                        return;
                    }
                },
                None => return,
            };
            self.stats.bytes_in += read as u64;
            self.buffer.extend_from_slice(&chunk[..read]);
            if self.buffer.len() > 8 * 1024 * 1024 {
                self.close("сервер прислал слишком много данных сразу");
                return;
            }
            if !self.drain() {
                return;
            }
        }
    }

    /// Разбирает всё, что уже пришло целиком. `false` — соединение закрыто.
    fn drain(&mut self) -> bool {
        loop {
            let Some((length, size)) = protocol::read_varint(&self.buffer) else {
                return true;
            };
            if length < 0 || self.buffer.len() < size + length as usize {
                return true;
            }
            let mut body = self.buffer[size..size + length as usize].to_vec();
            self.buffer.drain(..size + length as usize);

            if self.compression >= 0 {
                let Some((data_length, header)) = protocol::read_varint(&body) else {
                    continue;
                };
                body = body[header..].to_vec();
                if data_length > 0 {
                    match crate::zip::inflate_raw(&body) {
                        Ok(data) => body = data,
                        Err(_) => continue,
                    }
                }
            }
            self.stats.packets_in += 1;
            self.handle_packet(&body);
            if self.stage == Stage::Closed {
                return false;
            }
        }
    }

    fn section(&self) -> &'static str {
        match self.stage {
            Stage::Login | Stage::Idle => "login",
            Stage::Config => "configuration",
            _ => "play",
        }
    }

    fn handle_packet(&mut self, body: &[u8]) {
        let Some((id, size)) = protocol::read_varint(body) else {
            return;
        };
        let data = &body[size..];
        let section = self.section();
        if std::env::var("BOT_DEBUG").is_ok() {
            eprintln!("БОТ: фаза {section}, номер {id}, {} байт", data.len());
        }
        let Some(name) = protocol::name_of(self.cfg.protocol, section, "toClient", id as u32) else {
            return;
        };
        match (section, name.as_str()) {
            /* ── вход ── */
            ("login", "compress") => {
                let threshold = protocol::read_varint(data).map(|(value, _)| value).unwrap_or(0);
                self.compression = threshold;
                self.note(format!("{}: сжатие от сервера — {}", self.cfg.name, threshold));
            }
            ("login", "disconnect") => {
                self.close("сервер отказал во входе");
            }
            ("login", "success") => {
                if self.cfg.protocol >= 764 {
                    self.stage = Stage::Config;
                    self.send_configuration();
                } else {
                    self.stage = Stage::Play;
                }
                self.note(format!("{}: вошёл ({})", self.cfg.name, self.stage.as_str()));
            }

            /* ── фаза настройки (1.20.2+) ── */
            ("configuration", "keep_alive") => {
                self.answer_keep_alive("configuration", data);
            }
            ("configuration", "ping") => {
                let payload = protocol::read_varint(data).map(|(value, _)| value).unwrap_or(0);
                self.send_packet(
                    "configuration",
                    "pong",
                    &Value::obj(vec![("id", Value::Num(payload as f64))]),
                );
            }
            ("configuration", "select_known_packs") => {
                /* сервер спрашивает, какие наборы данных знает клиент — отвечаем тем же */
                let packs = protocol::read(self.cfg.protocol, "configuration", "select_known_packs", data, &[])
                    .unwrap_or(Value::Obj(Vec::new()));
                self.send_packet("configuration", "select_known_packs", &packs);
            }
            ("configuration", "finish_configuration") => {
                self.send_packet("configuration", "finish_configuration", &Value::Obj(Vec::new()));
                self.stage = Stage::Play;
                self.after_join();
            }
            ("configuration", "disconnect") => {
                self.close("сервер разорвал настройку");
            }

            /* ── игра ── */
            ("play", "keep_alive") => {
                self.answer_keep_alive("play", data);
            }
            ("play", "kick_disconnect") => {
                self.close("кик от сервера");
            }
            ("play", "login") => {
                /* сервер пустил в мир: тут же сообщаем настройки клиента */
                self.send_client_information();
                self.note(format!("{}: в мире", self.cfg.name));
            }
            ("play", "position") => {
                /* сервер поправил положение — соглашаемся, как настоящий клиент */
                let parsed = protocol::read(self.cfg.protocol, "play", "position", data, &["x", "y", "z", "yaw", "pitch"])
                    .unwrap_or(Value::Obj(Vec::new()));
                if let Some(x) = parsed.get("x").and_then(|v| v.as_f64()) {
                    self.x = x;
                }
                if let Some(y) = parsed.get("y").and_then(|v| v.as_f64()) {
                    self.y = y;
                }
                if let Some(z) = parsed.get("z").and_then(|v| v.as_f64()) {
                    self.z = z;
                }
                self.send_packet(
                    "play",
                    "teleport_confirm",
                    &Value::obj(vec![("teleportId", Value::Num(1.0))]),
                );
            }
            ("play", "chunk_batch_start") => {
                self.stats.chunks += 1;
                self.maybe_player_loaded();
            }
            ("play", "map_chunk") => {
                self.stats.chunks += 1;
                self.maybe_player_loaded();
            }
            _ => {}
        }
    }

    fn answer_keep_alive(&mut self, section: &str, data: &[u8]) {
        let parsed = protocol::read(self.cfg.protocol, section, "keep_alive", data, &["keepAliveId", "id"])
            .unwrap_or(Value::Obj(Vec::new()));
        let value = parsed
            .get("keepAliveId")
            .or_else(|| parsed.get("id"))
            .cloned()
            .unwrap_or(Value::Num(0.0));
        let reply = Value::obj(vec![("keepAliveId", value.clone())]).map_with("id", value);
        self.send_packet(section, "keep_alive", &reply);
        self.stats.keep_alives += 1;
    }

    fn send_configuration(&mut self) {
        self.send_client_information();
        /* бренд клиента — сервер его показывает в списке игроков */
        self.send_packet(
            "configuration",
            "custom_payload",
            &Value::obj(vec![
                ("channel", Value::str("minecraft:brand")),
                ("data", Value::str(crate::b64::encode(b"OmniPanel"))),
            ]),
        );
    }

    fn send_client_information(&mut self) {
        let values = Value::obj(vec![
            ("locale", Value::str("ru_RU")),
            ("viewDistance", Value::Num(8.0)),
            ("chatFlags", Value::Num(0.0)),
            ("chatColors", Value::Bool(true)),
            ("skinParts", Value::Num(127.0)),
            ("mainHand", Value::Num(1.0)),
            ("enableTextFiltering", Value::Bool(false)),
            ("enableServerListing", Value::Bool(true)),
            ("language", Value::str("ru_RU")),
        ]);
        if !self.send_packet("configuration", "client_information", &values) {
            /* до 1.20.2 отдельной фазы настройки нет — настройки шлют в игре */
            self.send_packet("play", "client_information", &values);
        }
    }

    fn after_join(&mut self) {
        self.joined = true;
        self.stage = Stage::Play;
        self.send_client_information();
    }

    /// С 1.21.4 сервер ждёт подтверждения «мир загружен», иначе возвращает
    /// игрока на спавн каждые три секунды.
    fn maybe_player_loaded(&mut self) {
        if self.player_loaded {
            return;
        }
        if self.stats.chunks < 8 {
            return;
        }
        if self.send_packet("play", "player_loaded", &Value::Obj(Vec::new())) {
            self.player_loaded = true;
            self.note(format!("{}: мир загружен, сообщил серверу", self.cfg.name));
        }
    }

    /* ──────────────────────────── действия ──────────────────────────── */

    fn actions_tick(&mut self) {
        if self.stage != Stage::Play || !self.joined {
            return;
        }
        let actions = self.cfg.actions.clone();
        let now = Instant::now();

        if actions.walk && now.duration_since(self.last_move).as_millis() as u64 >= TICK_MS {
            self.last_move = now;
            self.walk_step(&actions);
        }
        if actions.jump && now.duration_since(self.last_jump).as_millis() as u64 >= actions.jump_ms {
            self.last_jump = now;
            self.jump();
        }
        if actions.chat && now.duration_since(self.last_chat).as_millis() as u64 >= actions.chat_ms {
            self.last_chat = now;
            let text = actions.chat_text.clone();
            self.send_chat(&text);
        }
        if actions.cmd && now.duration_since(self.last_cmd).as_millis() as u64 >= actions.cmd_ms {
            self.last_cmd = now;
            if !actions.commands.is_empty() {
                let index = self.cmd_index % actions.commands.len();
                let command = actions.commands[index].clone();
                self.cmd_index += 1;
                self.send_command(&command);
            }
        }
        if actions.swing && now.duration_since(self.last_swing).as_millis() as u64 >= actions.swing_ms {
            self.last_swing = now;
            self.send_packet(
                "play",
                "arm_animation",
                &Value::obj(vec![("hand", Value::Num(0.0))]),
            );
        }
    }

    fn walk_step(&mut self, actions: &Actions) {
        /* расходимся по кругу: у каждого бота свой сектор */
        if actions.spread {
            let drift = (self.stats.moves as f64 / 200.0).sin() * 0.25;
            self.heading += drift * 0.05;
        }
        let speed = if actions.hop { SPEED_SPRINT } else { SPEED_WALK };
        let step = speed.min(MAX_STEP);
        self.x += self.heading.cos() * step;
        self.z += self.heading.sin() * step;
        self.yaw = self.heading.to_degrees();

        /* прыжок: короткая дуга, приземление через несколько тиков */
        if actions.hop && self.on_ground && self.stats.moves % 24 == 0 {
            self.jump();
        }
        if !self.on_ground {
            self.vel_y -= 0.08;
            self.y += self.vel_y;
            if self.y <= 64.0 {
                self.y = 64.0;
                self.vel_y = 0.0;
                self.on_ground = true;
            }
        }

        let values = Value::obj(vec![
            ("x", Value::Num(self.x)),
            ("y", Value::Num(self.y)),
            ("z", Value::Num(self.z)),
            ("yaw", Value::Num(self.yaw)),
            ("pitch", Value::Num(self.pitch)),
            ("onGround", Value::Bool(self.on_ground)),
            (
                "flags",
                Value::obj(vec![
                    ("onGround", Value::Bool(self.on_ground)),
                    ("hasHorizontalCollision", Value::Bool(false)),
                ]),
            ),
        ]);
        if self.send_packet("play", "position_look", &values) {
            self.stats.moves += 1;
            self.stats.distance += step;
        }
    }

    fn jump(&mut self) {
        self.vel_y = JUMP_VY;
        self.on_ground = false;
        self.stats.jumps += 1;
        self.send_packet(
            "play",
            "position",
            &Value::obj(vec![
                ("x", Value::Num(self.x)),
                ("y", Value::Num(self.y)),
                ("z", Value::Num(self.z)),
                ("onGround", Value::Bool(false)),
            ]),
        );
    }

    fn send_chat(&mut self, text: &str) {
        let values = Value::obj(vec![
            ("message", Value::str(text)),
            ("timestamp", Value::Num(now_millis() as f64)),
            ("salt", Value::Num(0.0)),
            ("signature", Value::Null),
            ("offset", Value::Num(0.0)),
            ("acknowledged", Value::obj(vec![("count", Value::Num(0.0))])),
        ]);
        if self
            .send_packet("play", "chat_message", &values)
            || self.send_packet("play", "chat", &Value::obj(vec![("message", Value::str(text))]))
        {
            self.stats.chat += 1;
        }
    }

    fn send_command(&mut self, command: &str) {
        let values = Value::obj(vec![("command", Value::str(command))]);
        if self
            .send_packet("play", "chat_command", &values)
            || self.send_packet("play", "chat", &Value::obj(vec![("message", Value::str(format!("/{}", command)))]))
        {
            self.stats.commands += 1;
        }
    }

    /// Отключается от сервера.
    pub fn disconnect(&mut self, reason: &str) -> Result<(), String> {
        if self.stage != Stage::Closed {
            let _ = self.send_packet(
                "play",
                "client_command",
                &Value::obj(vec![("actionId", Value::Num(0.0))]),
            );
        }
        self.close(reason);
        Ok(())
    }

    fn close(&mut self, reason: &str) {
        if self.stage == Stage::Closed {
            return;
        }
        self.last_error = reason.to_string();
        self.note(format!("{}: {}", self.cfg.name, reason));
        self.socket = None;
        self.stage = Stage::Closed;
    }

    pub fn is_closed(&self) -> bool {
        self.stage == Stage::Closed
    }
}

/// Миллисекунды с начала эпохи — для поля `timestamp` в чате.
fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}
