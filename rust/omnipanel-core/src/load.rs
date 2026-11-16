//! Нагрузочный тест через панель: поднимаем настоящих ботов, снимаем показания,
//! показываем их человеку и отдаём отчёт.
//!
//! Правила те же, что в прежней панели:
//!  * боты входят с разбегом (`rampMs`), чтобы вход не выглядел одной пачкой;
//!  * раз в секунду снимаются пакеты/с, байты/с, число ботов в игре;
//!  * выпавший бот возвращается в игру, но не больше трёх раз;
//!  * тест останавливается сам по времени или по команде человека.

use crate::bot::{Actions, Bot, Config as BotConfig, Stage};
use crate::json::Value;
use std::time::Instant;

/// Раз в секунду снимаем показания — так их видно в панели.
pub const SAMPLE_MS: u64 = 1000;
/// В истории держим десять минут.
const TIMELINE_LIMIT: usize = 600;
/// Больше двухсот ботов один компьютер честно не вытянет.
pub const MAX_BOTS: usize = 200;
/// Сколько раз возвращаем выпавшего бота в игру.
const RESPAWN_LIMIT: usize = 3;

/// Настройки теста.
#[derive(Debug, Clone)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub protocol: u32,
    pub version: String,
    pub count: usize,
    pub ramp_ms: u64,
    pub duration_ms: u64,
    pub prefix: String,
    pub respawn: bool,
    pub actions: Actions,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            host: "127.0.0.1".to_string(),
            port: 25565,
            protocol: 765,
            version: "1.20.4".to_string(),
            count: 5,
            ramp_ms: 3000,
            duration_ms: 0,
            prefix: "Bot".to_string(),
            respawn: true,
            actions: Actions::default(),
        }
    }
}

impl Config {
    /// Разбирает настройки из интерфейса, приводя их к разумным границам.
    pub fn from_json(raw: &Value) -> Config {
        let text = |name: &str, fallback: &str| {
            let value = raw.get(name).map(|v| v.text()).unwrap_or_default();
            if value.trim().is_empty() {
                fallback.to_string()
            } else {
                value
            }
        };
        let number = |name: &str, fallback: f64| raw.get(name).and_then(|v| v.as_f64()).unwrap_or(fallback);
        let prefix: String = translit(&text("prefix", "Bot"))
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
            .take(10)
            .collect();
        let version = text("version", "1.20.4");
        let protocol = raw
            .get("protocol")
            .and_then(|v| v.as_f64())
            .map(|v| v as u32)
            .filter(|value| *value > 0)
            .unwrap_or_else(|| crate::bot::protocol_for_version(&version));
        Config {
            host: text("host", "127.0.0.1"),
            port: number("port", 25565.0).clamp(1.0, 65535.0) as u16,
            protocol,
            version,
            count: number("count", 5.0).clamp(1.0, MAX_BOTS as f64) as usize,
            ramp_ms: number("rampMs", 3000.0).clamp(0.0, 60_000.0) as u64,
            duration_ms: number("durationMs", 0.0).clamp(0.0, 24.0 * 3600.0 * 1000.0) as u64,
            prefix: if prefix.is_empty() { "Bot".to_string() } else { prefix },
            respawn: raw.get("respawn").map(|v| v.as_bool()).unwrap_or(true),
            actions: Actions::from_json(raw.get("actions").unwrap_or(&Value::Null)),
        }
    }

    /// Имя бота: `Bot1`, `Bot2`… — сервер пускает только латиницу и цифры.
    pub fn name_for(&self, index: usize) -> String {
        format!("{}{}", self.prefix, index + 1)
    }

    /// Что сохраняем в настройки сервера, чтобы в следующий раз было как было.
    pub fn to_settings(&self) -> Value {
        Value::obj(vec![
            ("host", Value::str(&self.host)),
            ("port", Value::from(self.port as u64)),
            ("version", Value::str(&self.version)),
            ("protocol", Value::from(self.protocol as u64)),
            ("count", Value::from(self.count as u64)),
            ("rampMs", Value::from(self.ramp_ms)),
            ("durationMs", Value::from(self.duration_ms)),
            ("prefix", Value::str(&self.prefix)),
            ("actions", self.actions.to_json()),
        ])
    }
}

impl Actions {
    pub fn to_json(&self) -> Value {
        let commands: Vec<Value> = self.commands.iter().map(|c| Value::str(c)).collect();
        Value::obj(vec![
            ("walk", Value::Bool(self.walk)),
            ("walkMs", Value::from(self.walk_ms)),
            ("jump", Value::Bool(self.jump)),
            ("jumpMs", Value::from(self.jump_ms)),
            ("spread", Value::Bool(self.spread)),
            ("hop", Value::Bool(self.hop)),
            ("chat", Value::Bool(self.chat)),
            ("chatText", Value::str(&self.chat_text)),
            ("chatMs", Value::from(self.chat_ms)),
            ("cmd", Value::Bool(self.cmd)),
            ("commands", Value::Arr(commands)),
            ("cmdMs", Value::from(self.cmd_ms)),
            ("swing", Value::Bool(self.swing)),
            ("swingMs", Value::from(self.swing_ms)),
        ])
    }
}

/// Время в миллисекундах — так интерфейс рисует часы в журнале.
fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Русские буквы в никах ботов заменяем латиницей: сервер пускает только
/// `[A-Za-z0-9_]`, иначе бот получит отказ ещё на входе.
pub fn translit(text: &str) -> String {
    let mut out = String::new();
    for chr in text.chars() {
        let low = chr.to_lowercase().next().unwrap_or(chr);
        let mapped: &str = match low {
            'а' => "a", 'б' => "b", 'в' => "v", 'г' => "g", 'д' => "d", 'е' | 'ё' => "e",
            'ж' => "zh", 'з' => "z", 'и' => "i", 'й' => "i", 'к' => "k", 'л' => "l",
            'м' => "m", 'н' => "n", 'о' => "o", 'п' => "p", 'р' => "r", 'с' => "s",
            'т' => "t", 'у' => "u", 'ф' => "f", 'х' => "h", 'ц' => "c", 'ч' => "ch",
            'ш' => "sh", 'щ' => "sch", 'ъ' | 'ь' => "", 'ы' => "y", 'э' => "e",
            'ю' => "yu", 'я' => "ya",
            other => {
                out.push(chr);
                let _ = other;
                continue;
            }
        };
        let upper = chr.is_uppercase();
        for (index, part) in mapped.chars().enumerate() {
            if upper && index == 0 {
                out.push(part.to_ascii_uppercase());
            } else {
                out.push(part);
            }
        }
    }
    out
}

/// Одно снятие показаний за секунду.
#[derive(Debug, Clone, Default)]
pub struct Sample {
    pub at_ms: u64,
    pub bots: usize,
    pub joined: usize,
    pub packets_out: u64,
    pub packets_in: u64,
    pub bytes_out: u64,
}

/// Бот в тесте: сам бот, недоделанные возвраты и ошибки.
struct Slot {
    bot: Option<Bot>,
    config: BotConfig,
    respawns: usize,
    errors: Vec<String>,
}

/// Сам тест.
pub struct Load {
    pub cfg: Config,
    slots: Vec<Slot>,
    started: Instant,
    running: bool,
    stop_reason: String,
    timeline: Vec<Sample>,
    logs: Vec<String>,
    last_sample: Instant,
    prev_totals: (u64, u64, u64),
    report: Value,
    /// Что показывать в панели прямо сейчас.
    status: Value,
}

impl Load {
    pub fn new(cfg: Config) -> Load {
        let slots = (0..cfg.count)
            .map(|index| Slot {
                config: BotConfig {
                    host: cfg.host.clone(),
                    port: cfg.port,
                    protocol: cfg.protocol,
                    name: cfg.name_for(index),
                    index,
                    total: cfg.count,
                    actions: cfg.actions.clone(),
                },
                bot: None,
                respawns: 0,
                errors: Vec::new(),
            })
            .collect();
        Load {
            cfg,
            slots,
            started: Instant::now(),
            running: true,
            stop_reason: String::new(),
            timeline: Vec::new(),
            logs: Vec::new(),
            last_sample: Instant::now(),
            prev_totals: (0, 0, 0),
            report: Value::Null,
            status: Value::Obj(Vec::new()),
        }
    }

    pub fn is_running(&self) -> bool {
        self.running
    }

    pub fn elapsed_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    /// Журнал для панели: строки с временем, как их рисует интерфейс.
    pub fn take_logs(&mut self) -> Vec<Value> {
        let lines = std::mem::take(&mut self.logs);
        lines
            .into_iter()
            .map(|line| {
                Value::obj(vec![
                    ("t", Value::from(now_millis())),
                    ("text", Value::str(line)),
                ])
            })
            .collect()
    }

    /// Последние строки журнала — их отдаём вместе с состоянием.
    pub fn logs_json(&self, limit: usize) -> Value {
        let start = self.logs.len().saturating_sub(limit);
        Value::Arr(
            self.logs[start..]
                .iter()
                .map(|line| {
                    Value::obj(vec![
                        ("t", Value::from(now_millis())),
                        ("text", Value::str(line)),
                    ])
                })
                .collect(),
        )
    }

    fn log(&mut self, text: impl Into<String>) {
        let text = text.into();
        self.logs.push(text);
        if self.logs.len() > 300 {
            self.logs.remove(0);
        }
    }

    fn totals(&self) -> (u64, u64, u64) {
        let mut out = (0, 0, 0);
        for slot in &self.slots {
            if let Some(bot) = &slot.bot {
                let stats = bot.stats();
                out.0 += stats.packets_out;
                out.1 += stats.packets_in;
                out.2 += stats.bytes_out;
            }
        }
        out
    }

    fn joined(&self) -> usize {
        self.slots
            .iter()
            .filter(|slot| slot.bot.as_ref().map(|bot| bot.is_joined()).unwrap_or(false))
            .count()
    }

    /// Шаг теста: поднять, кто по расписанию, дать поработать всем ботам,
    /// раз в секунду снять показания.
    pub fn tick(&mut self) {
        if !self.running {
            return;
        }
        let elapsed = self.elapsed_ms();

        /* 1. время вышло — закрываемся сами */
        if self.cfg.duration_ms > 0 && elapsed >= self.cfg.duration_ms {
            self.stop("время теста вышло");
            return;
        }

        /* 2. поднимаем ботов по расписанию (разбег) */
        let step = if self.cfg.count > 1 {
            self.cfg.ramp_ms / (self.cfg.count as u64 - 1)
        } else {
            0
        };
        for index in 0..self.slots.len() {
            let due = step * index as u64;
            if due > elapsed {
                continue;
            }
            if self.slots[index].bot.is_some() {
                continue;
            }
            let name = self.slots[index].config.name.clone();
            let mut bot = Bot::new(self.slots[index].config.clone());
            match bot.connect() {
                Ok(_) => {
                    self.log(format!("{}: подключаюсь к {}:{}", name, self.cfg.host, self.cfg.port));
                    self.slots[index].bot = Some(bot);
                }
                Err(err) => {
                    self.log(format!("{}: {}", name, err));
                    if self.slots[index].errors.len() < 5 {
                        self.slots[index].errors.push(err);
                    }
                }
            }
        }

        /* 3. работаем */
        let mut closed: Vec<usize> = Vec::new();
        for (index, slot) in self.slots.iter_mut().enumerate() {
            if let Some(bot) = slot.bot.as_mut() {
                bot.tick();
                for line in bot.take_log() {
                    if self.logs.len() < 300 {
                        self.logs.push(line);
                    }
                }
                if bot.is_closed() {
                    closed.push(index);
                }
            }
        }

        /* 4. выпавших возвращаем в игру — но не бесконечно */
        for index in closed {
            let reason = self.slots[index]
                .bot
                .as_ref()
                .map(|bot| bot.last_error().to_string())
                .unwrap_or_default();
            self.slots[index].bot = None;
            if self.cfg.respawn && self.slots[index].respawns < RESPAWN_LIMIT {
                self.slots[index].respawns += 1;
                self.log(format!(
                    "{}: {} — возвращаю в игру ({}/{})",
                    self.slots[index].config.name,
                    reason,
                    self.slots[index].respawns,
                    RESPAWN_LIMIT
                ));
                /* новый бот подключится на следующем шаге */
            } else if self.slots[index].errors.len() < 5 {
                self.slots[index].errors.push(reason.clone());
                self.log(format!("{}: {}", self.slots[index].config.name, reason));
            }
        }

        /* 5. показания раз в секунду */
        if self.last_sample.elapsed().as_millis() as u64 >= SAMPLE_MS {
            self.last_sample = Instant::now();
            let totals = self.totals();
            let sample = Sample {
                at_ms: self.elapsed_ms(),
                bots: self.slots.iter().filter(|slot| slot.bot.is_some()).count(),
                joined: self.joined(),
                packets_out: totals.0.saturating_sub(self.prev_totals.0),
                packets_in: totals.1.saturating_sub(self.prev_totals.1),
                bytes_out: totals.2.saturating_sub(self.prev_totals.2),
            };
            self.prev_totals = totals;
            self.timeline.push(sample);
            if self.timeline.len() > TIMELINE_LIMIT {
                self.timeline.remove(0);
            }
            self.status = self.status_json();
        }

        /* 6. все боты выпали и возвращать их больше нельзя — тест закончен */
        let alive = self.slots.iter().filter(|slot| slot.bot.is_some()).count();
        if alive == 0 && elapsed > 2000 && !self.slots.is_empty() {
            self.stop("все боты выпали");
        }
    }

    /// Останавливает тест и собирает отчёт.
    pub fn stop(&mut self, reason: &str) -> Value {
        if !self.running && !self.report.is_null() {
            return self.report.clone();
        }
        self.running = false;
        self.stop_reason = reason.to_string();
        for slot in self.slots.iter_mut() {
            if let Some(bot) = slot.bot.as_mut() {
                let _ = bot.disconnect(reason);
            }
        }
        self.log(format!("тест остановлен: {}", reason));
        let totals = self.totals();
        let joined = self.joined();
        let mut errors: Vec<Value> = Vec::new();
        for slot in &self.slots {
            for error in &slot.errors {
                if errors.len() < 20 {
                    errors.push(Value::obj(vec![
                        ("bot", Value::str(&slot.config.name)),
                        ("error", Value::str(error)),
                    ]));
                }
            }
        }
        let peak_out = self.timeline.iter().map(|s| s.packets_out).max().unwrap_or(0);
        let peak_in = self.timeline.iter().map(|s| s.packets_in).max().unwrap_or(0);
        let peak_joined = self.timeline.iter().map(|s| s.joined).max().unwrap_or(joined);
        let average = if self.timeline.is_empty() {
            0.0
        } else {
            let sum: u64 = self.timeline.iter().map(|s| s.packets_out).sum();
            (sum as f64 / self.timeline.len() as f64 * 10.0).round() / 10.0
        };
        self.report = Value::obj(vec![
            ("ok", Value::Bool(true)),
            ("reason", Value::str(&self.stop_reason)),
            ("durationMs", Value::from(self.elapsed_ms())),
            ("durationSec", Value::from(self.elapsed_ms() / 1000)),
            ("bots", Value::from(self.slots.len() as u64)),
            ("joined", Value::from(peak_joined as u64)),
            ("online", Value::from(joined as u64)),
            ("onlineAtEnd", Value::from(joined as u64)),
            ("packetsOut", Value::from(totals.0)),
            ("packetsIn", Value::from(totals.1)),
            ("bytesOut", Value::from(totals.2)),
            ("peakPacketsOut", Value::from(peak_out)),
            ("peakPacketsIn", Value::from(peak_in)),
            ("averagePacketsOut", Value::Num(average)),
            ("samples", Value::from(self.timeline.len() as u64)),
            ("peak", Value::obj(vec![
                ("ppsOut", Value::from(peak_out)),
                ("ppsIn", Value::from(peak_in)),
                ("online", Value::from(peak_joined as u64)),
                ("cpu", Value::Null),
            ])),
            ("average", Value::obj(vec![
                ("ppsOut", Value::Num(average)),
                ("cpu", Value::Null),
                ("tps", Value::Null),
            ])),
            ("avg", Value::obj(vec![("cpu", Value::Null), ("tps", Value::Null)])),
            ("errors", Value::Arr(errors)),
            ("timeline", self.timeline_json(600)),
        ]);
        self.status = self.status_json();
        self.report.clone()
    }

    fn timeline_json(&self, limit: usize) -> Value {
        let start = self.timeline.len().saturating_sub(limit);
        Value::Arr(
            self.timeline[start..]
                .iter()
                .map(|sample| {
                    Value::obj(vec![
                        ("t", Value::from(sample.at_ms)),
                        ("bots", Value::from(sample.bots as u64)),
                        ("joined", Value::from(sample.joined as u64)),
                        ("out", Value::from(sample.packets_out)),
                        ("in", Value::from(sample.packets_in)),
                        ("ppsOut", Value::from(sample.packets_out)),
                        ("ppsIn", Value::from(sample.packets_in)),
                        ("bytesOut", Value::from(sample.bytes_out)),
                        ("cpu", Value::Null),
                    ])
                })
                .collect(),
        )
    }

    /// Что показываем в панели, пока тест идёт.
    ///
    /// Имена полей — те же, что читает `ui/app.js` (`status.totals.online`,
    /// `status.last.ppsOut`, `status.timeline[].t`, `bots[].state` и так далее),
    /// иначе вкладка «Боты» показала бы прочерки.
    pub fn status_json(&self) -> Value {
        let totals = self.totals();
        let last = self.timeline.last().cloned().unwrap_or_default();
        let mut bots: Vec<Value> = Vec::new();
        for slot in &self.slots {
            if bots.len() >= 40 {
                break;
            }
            let (state, stats, error) = match &slot.bot {
                Some(bot) => (
                    bot.stage().as_str().to_string(),
                    bot.stats().to_json(),
                    bot.last_error().to_string(),
                ),
                None => (
                    if slot.respawns > 0 { "respawn" } else { "idle" }.to_string(),
                    Value::Obj(Vec::new()),
                    slot.errors.last().cloned().unwrap_or_default(),
                ),
            };
            bots.push(Value::obj(vec![
                ("name", Value::str(&slot.config.name)),
                ("state", Value::str(&state)),
                ("stage", Value::str(&state)),
                ("joined", Value::Bool(state == "play")),
                ("stats", stats),
                ("error", Value::str(error)),
            ]));
        }
        let chunks: u64 = self
            .slots
            .iter()
            .filter_map(|slot| slot.bot.as_ref())
            .map(|bot| bot.stats().chunks)
            .sum();
        let online = self.joined();
        Value::obj(vec![
            ("running", Value::Bool(self.running)),
            ("elapsed", Value::from(self.elapsed_ms())),
            ("elapsedMs", Value::from(self.elapsed_ms())),
            ("stopReason", Value::str(&self.stop_reason)),
            ("reason", Value::str(&self.stop_reason)),
            ("botsCount", Value::from(self.slots.len() as u64)),
            ("totals", Value::obj(vec![
                ("bots", Value::from(self.slots.len() as u64)),
                ("online", Value::from(online as u64)),
                ("joined", Value::from(online as u64)),
                ("chunksLoaded", Value::from(chunks)),
                ("packetsOut", Value::from(totals.0)),
                ("packetsIn", Value::from(totals.1)),
                ("bytesOut", Value::from(totals.2)),
            ])),
            ("last", Value::obj(vec![
                ("ppsOut", Value::from(last.packets_out)),
                ("ppsIn", Value::from(last.packets_in)),
                ("kbpsOut", Value::Num(last.bytes_out as f64 / 1024.0)),
                ("kbpsIn", Value::Num(0.0)),
                ("cpu", Value::Null),
                ("rss", Value::Null),
                ("tps", Value::Null),
            ])),
            ("bots", Value::Arr(bots)),
            ("timeline", self.timeline_json(120)),
            ("logs", self.logs_json(120)),
            ("report", self.report.clone()),
        ])
    }

    /// Версии протокола, которые умеет бот (для выпадающего списка).
    pub fn versions_json() -> Value {
        let mut list: Vec<(u32, String)> = crate::bot::versions();
        list.sort_by(|a, b| b.0.cmp(&a.0));
        let mut seen: Vec<String> = Vec::new();
        let mut out: Vec<Value> = Vec::new();
        for (protocol, version) in list {
            if seen.contains(&version) {
                continue;
            }
            seen.push(version.clone());
            out.push(Value::obj(vec![
                ("protocol", Value::from(protocol as u64)),
                ("version", Value::str(&version)),
                ("label", Value::str(format!("{} (протокол {})", version, protocol))),
            ]));
        }
        Value::Arr(out)
    }
}

/// Где бот сейчас — для отчёта (нужно тестам и отладке).
pub fn stage_name(stage: Stage) -> &'static str {
    stage.as_str()
}
