/*!
 * Крошечный сервер Minecraft для тестов панели.
 *
 * Понимает ровно столько, сколько нужно нагрузочному тесту: рукопожатие, вход,
 * фазу настройки и игру. Отвечает на keep_alive, считает, сколько ботов вошло,
 * и сколько пакетов от них пришло.
 */

use omnipanel_core::bot::protocol;
use omnipanel_core::json::Value;
use std::collections::HashSet;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};

/// Что сервер запомнил про ботов.
#[derive(Default, Debug, Clone)]
pub struct Seen {
    pub names: Vec<String>,
    pub moves: usize,
    pub chats: usize,
    pub keep_alives: usize,
}

pub struct Server {
    pub port: u16,
    seen: Arc<Mutex<Seen>>,
}

impl Server {
    pub fn start() -> Server {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("тестовый сервер не поднялся");
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Seen::default()));
        let shared = Arc::clone(&seen);
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let state = Arc::clone(&shared);
                std::thread::spawn(move || {
                    let _ = handle(stream, state);
                });
            }
        });
        Server { port, seen }
    }

    /// Сколько ботов вошло в игру.
    pub fn joined(&self) -> usize {
        self.seen.lock().unwrap().names.len()
    }

    pub fn moves(&self) -> usize {
        self.seen.lock().unwrap().moves
    }

    pub fn chats(&self) -> usize {
        self.seen.lock().unwrap().chats
    }
}

/// Рамка пакета: длина + тело (сжатие не включаем — так видно содержимое).
fn frame(payload: &[u8]) -> Vec<u8> {
    let mut out = protocol::varint_bytes(payload.len() as i32);
    out.extend_from_slice(payload);
    out
}

fn server_packet(section: &str, name: &str, values: &Value) -> Vec<u8> {
    let id = protocol::id_of_dir(765, section, "toClient", name).expect("пакет сервера известен");
    let body = protocol::write_dir(765, section, "toClient", name, values).expect("пакет собрался");
    let mut out = protocol::varint_bytes(id as i32);
    out.extend_from_slice(&body);
    out
}

fn handle(mut stream: TcpStream, seen: Arc<Mutex<Seen>>) -> std::io::Result<()> {
    stream.set_read_timeout(Some(std::time::Duration::from_millis(200))).ok();
    let mut buffer: Vec<u8> = Vec::new();
    let mut stage = "login";
    let mut handshook = false;
    let mut finish_offered = false;
    let mut alive: HashSet<String> = HashSet::new();
    let mut last_keep_alive = std::time::Instant::now();
    let mut keep_alive_sent = 0;

    loop {
        if stage == "play" && last_keep_alive.elapsed().as_millis() >= 400 {
            last_keep_alive = std::time::Instant::now();
            keep_alive_sent += 1;
            let packet = server_packet(
                "play",
                "keep_alive",
                &Value::obj(vec![("keepAliveId", Value::Num(500.0 + keep_alive_sent as f64))]),
            );
            stream.write_all(&frame(&packet))?;
        }

        let mut chunk = [0u8; 4096];
        match stream.read(&mut chunk) {
            Ok(0) => return Ok(()),
            Ok(read) => buffer.extend_from_slice(&chunk[..read]),
            Err(err)
                if matches!(
                    err.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                continue
            }
            Err(_) => return Ok(()),
        }

        while let Some((length, size)) = protocol::read_varint(&buffer) {
            if buffer.len() < size + length as usize {
                break;
            }
            let body = buffer[size..size + length as usize].to_vec();
            buffer.drain(..size + length as usize);
            let Some((id, id_size)) = protocol::read_varint(&body) else {
                continue;
            };
            let data = body[id_size..].to_vec();
            let data = data.as_slice();

            /* рукопожатие приходит первым и вне разделов */
            if !handshook {
                handshook = true;
                continue;
            }

            let section = if stage == "play" { "play" } else { stage };
            let Some(name) = protocol::name_of(765, section, "toServer", id as u32) else {
                continue;
            };
            match (stage, name.as_str()) {
                ("login", "login_start") => {
                    let parsed =
                        protocol::read(765, "login", "login_start", data, &["username", "playerUUID"])
                            .expect("вход разобрался");
                    let username = parsed.get("username").map(|v| v.text()).unwrap_or_default();
                    alive.insert(username.clone());
                    let success = server_packet(
                        "login",
                        "success",
                        &omnipanel_core::json::parse(&format!(
                            r#"{{"uuid":"00000000-0000-0000-0000-000000000001","username":"{}","properties":[]}}"#,
                            username
                        ))
                        .unwrap(),
                    );
                    stream.write_all(&frame(&success))?;
                    stage = "configuration";
                }
                ("configuration", "client_information") | ("configuration", "settings") => {
                    if !finish_offered {
                        finish_offered = true;
                        let finish =
                            server_packet("configuration", "finish_configuration", &Value::Obj(Vec::new()));
                        stream.write_all(&frame(&finish))?;
                    }
                }
                ("configuration", "finish_configuration") => {
                    stage = "play";
                    let mut guard = seen.lock().unwrap();
                    guard.names.push(alive.iter().next().cloned().unwrap_or_default());
                }
                ("play", "keep_alive") => {
                    seen.lock().unwrap().keep_alives += 1;
                }
                ("play", "position_look") | ("play", "position") | ("play", "flying") => {
                    seen.lock().unwrap().moves += 1;
                }
                ("play", "chat_message") | ("play", "chat") => {
                    seen.lock().unwrap().chats += 1;
                }
                _ => {}
            }
        }
    }
}
