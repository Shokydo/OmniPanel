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
