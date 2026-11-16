//! Порты серверов: занят ли, какой свободен рядом.
//!
//! Панель проверяет порт перед запуском и предлагает соседний, если занято —
//! это поведение переносим как есть, без «магии».

use std::net::{Ipv4Addr, SocketAddr, TcpListener, UdpSocket};

/// Занят ли TCP-порт на этой машине.
pub fn is_busy(port: u16) -> bool {
    if port == 0 {
        return false;
    }
    TcpListener::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, port))).is_err()
}

/// Свободен ли UDP-порт (Minecraft слушает и его: query, voice-chat).
pub fn is_busy_udp(port: u16) -> bool {
    if port == 0 {
        return false;
    }
    UdpSocket::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, port))).is_err()
}

/// Что именно мешает порту.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortCheck {
    pub port: u16,
    pub tcp: bool,
    pub udp: bool,
}

impl PortCheck {
    pub fn free(&self) -> bool {
        !self.tcp && !self.udp
    }
}

/// Проверяет порт по TCP и UDP сразу.
pub fn check(port: u16) -> PortCheck {
    PortCheck {
        port,
        tcp: is_busy(port),
        udp: is_busy_udp(port),
    }
}

/// Ищет свободный порт начиная с `from` (до 200 попыток вверх, потом вниз).
pub fn find_free(from: u16) -> Option<u16> {
    let start = from.max(1024);
    for step in 0..200u16 {
        let port = start.saturating_add(step);
        if port == 0 {
            break;
        }
        if !is_busy(port) && !is_busy_udp(port) {
            return Some(port);
        }
    }
    for step in 1..100u16 {
        let port = start.saturating_sub(step);
        if port >= 1024 && !is_busy(port) && !is_busy_udp(port) {
            return Some(port);
        }
    }
    None
}

/* ───────────── порты из настроек сервера ───────────── */

/// Какие порты берёт сервер и как они называются в интерфейсе.
pub const SERVER_PORTS: [(&str, &str, u16, Option<&str>); 3] = [
    ("server-port", "Порт сервера", 25565, None),
    ("query.port", "Порт query", 25565, Some("enable-query")),
    ("rcon.port", "Порт RCON", 25575, Some("enable-rcon")),
];

/// Один порт сервера.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnPort {
    pub key: String,
    pub label: String,
    pub port: u16,
}

/// Какие порты возьмёт сервер по своему `server.properties`.
///
/// `query` и `rcon` считаются только если они включены — иначе панель
/// не должна ругаться на занятый порт, которым сервер не пользуется.
pub fn own(props_text: &str) -> Vec<OwnPort> {
    let parsed = crate::props::PropsFile::parse(props_text);
    let mut out = Vec::new();
    for (key, label, default, needs) in SERVER_PORTS.iter() {
        if let Some(needs) = needs {
            if parsed.get_bool(needs) != Some(true) {
                continue;
            }
        }
        let port = parsed
            .get_number(key)
            .filter(|n| *n > 0.0 && *n <= 65535.0)
            .map(|n| n as u16)
            .unwrap_or(*default);
        out.push(OwnPort {
            key: key.to_string(),
            label: label.to_string(),
            port,
        });
    }
    out
}

/// Порт занят другим сервером панели.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Conflict {
    pub key: String,
    pub label: String,
    pub port: u16,
    pub server_id: String,
    pub server_name: String,
    pub other_key: String,
}

/// Занят посторонней программой.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Busy {
    pub key: String,
    pub label: String,
    pub port: u16,
}

/// Итог проверки портов перед запуском.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PortsReport {
    pub ports: Vec<OwnPort>,
    pub conflicts: Vec<Conflict>,
    pub busy: Vec<Busy>,
}

impl PortsReport {
    pub fn ok(&self) -> bool {
        self.conflicts.is_empty() && self.busy.is_empty()
    }

    /// Ближайший свободный порт для замены занятого — то, что предложит панель.
    pub fn suggestion(&self, port: u16, taken: &[u16]) -> Option<u16> {
        let skip: Vec<u16> = taken.iter().copied().chain(self.ports.iter().map(|p| p.port)).collect();
        let mut candidate = port.saturating_add(1);
        for _ in 0..300 {
            if candidate >= 65535 {
                break;
            }
            if !skip.contains(&candidate) && !is_busy(candidate) {
                return Some(candidate);
            }
            candidate += 1;
        }
        None
    }
}

/// Чужие занятые порты: `(id, имя, [(ключ, порт)])`.
pub fn check_all(props_text: &str, others: &[(String, String, Vec<(String, u16)>)]) -> PortsReport {
    let ports = own(props_text);
    let mut conflicts = Vec::new();
    let mut busy = Vec::new();
    for port in &ports {
        let mut matched = false;
        for (id, name, list) in others {
            if let Some((other_key, _)) = list.iter().find(|(_, p)| *p == port.port) {
                conflicts.push(Conflict {
                    key: port.key.clone(),
                    label: port.label.clone(),
                    port: port.port,
                    server_id: id.clone(),
                    server_name: name.clone(),
                    other_key: other_key.clone(),
                });
                matched = true;
                break;
            }
        }
        if matched {
            continue;
        }
        if is_busy(port.port) {
            busy.push(Busy { key: port.key.clone(), label: port.label.clone(), port: port.port });
        }
    }
    PortsReport { ports, conflicts, busy }
}
