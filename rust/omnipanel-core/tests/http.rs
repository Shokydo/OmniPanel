// Проверки HTTP-режима: Rust отдаёт интерфейс панели и отвечает на его запросы.
//
// Тест поднимает настоящий сервер на свободном порту и ходит в него так же,
// как это делает браузер — обычными HTTP-запросами.
use omnipanel_core::app::{App, AppInfo};
use omnipanel_core::http::PanelServer;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

struct Panel {
    port: u16,
    dir: PathBuf,
}

impl Drop for Panel {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

/// Поднимает панель на свободном порту. Папка у каждого теста своя —
/// тесты идут параллельно и не должны мешать друг другу.
fn start_panel() -> Panel {
    use std::sync::atomic::{AtomicU32, Ordering};
    static NEXT: AtomicU32 = AtomicU32::new(0);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("omnipanel-http-{}-{n}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let ui = dir.join("ui");
    fs::create_dir_all(&ui).unwrap();
    fs::write(ui.join("index.html"), "<!doctype html><title>OmniPanel</title>").unwrap();
    fs::write(ui.join("app.js"), "console.log('панель');").unwrap();

    let mut info = AppInfo::default();
    info.data_dir = dir.clone();
    info.config_path = dir.join("servers.json");
    let app = Arc::new(App::new(info));
    let server = Arc::new(PanelServer::new(app, ui));

    /* порт 0 — система сама выберет свободный, и тесты не мешают друг другу */
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let serving = Arc::clone(&server);
    std::thread::spawn(move || {
        let _ = serving.serve_listener(listener);
    });
    /* ждём, пока сервер начнёт отвечать */
    for _ in 0..50 {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Panel { port, dir }
}

fn request(port: u16, method: &str, path: &str, body: &str) -> (u16, String) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let text = format!(
        "{} {} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        method,
        path,
        port,
        body.as_bytes().len(),
        body
    );
    stream.write_all(text.as_bytes()).unwrap();
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    let status = response
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or(0);
    let body = response.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
    (status, body)
}

#[test]
fn интерфейс_отдаётся_из_rust() {
    let panel = start_panel();
    let (status, body) = request(panel.port, "GET", "/", "");
    assert_eq!(status, 200, "главная страница");
    assert!(body.contains("OmniPanel"), "это тот самый интерфейс: {body}");
    let (status, _) = request(panel.port, "GET", "/app.js", "");
    assert_eq!(status, 200, "скрипты интерфейса тоже отдаются");
    let (status, body) = request(panel.port, "GET", "/нет-такого.js", "");
    assert_eq!(status, 404);
    assert!(body.contains("не найдено"));
}

#[test]
fn список_серверов_и_работа_с_ним_по_http() {
    let panel = start_panel();

    let (status, body) = request(panel.port, "GET", "/api/servers", "");
    assert_eq!(status, 200);
    assert_eq!(body, "[]", "пока ни одного сервера: {body}");

    let (_, body) = request(
        panel.port,
        "POST",
        "/api/servers",
        r#"{"name":"Мир «Кактус»","command":"java -jar server.jar nogui"}"#,
    );
    assert!(body.contains("Мир «Кактус»"), "сервер добавлен: {body}");
    let id = body
        .split("\"id\":\"")
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .unwrap()
        .to_string();

    let (_, body) = request(panel.port, "GET", "/api/servers", "");
    assert!(body.contains(&id), "сервер в списке: {body}");
    assert!(body.contains("\"state\":\"stopped\""));

    let (_, body) = request(
        panel.port,
        "POST",
        &format!("/api/servers/{}/command", id),
        r#"{"cmd":"list"}"#,
    );
    assert!(body.contains("не запущен"), "ошибка по-русски: {body}");

    let (_, body) = request(panel.port, "DELETE", &format!("/api/servers/{}", id), "");
    assert!(body.contains("true"), "сервер удалён: {body}");
    let (_, body) = request(panel.port, "GET", "/api/servers", "");
    assert_eq!(body, "[]");
}

#[test]
fn настройки_и_порты_по_http() {
    let panel = start_panel();
    let server_dir = panel.dir.join("мир");
    fs::create_dir_all(&server_dir).unwrap();
    fs::write(
        server_dir.join("server.properties"),
        "server-port=25565\nmotd=Старый мир\nenable-rcon=false\n",
    )
    .unwrap();

    let payload = format!(
        r#"{{"name":"Мир","command":"echo","cwd":"{}"}}"#,
        server_dir.display()
    );
    let (_, body) = request(panel.port, "POST", "/api/servers", &payload);
    let id = body
        .split("\"id\":\"")
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .unwrap()
        .to_string();

    let (_, body) = request(panel.port, "GET", &format!("/api/props?id={}", id), "");
    assert!(body.contains("Старый мир"), "настройки сервера читаются: {body}");

    let (_, body) = request(panel.port, "GET", &format!("/api/ports/own?id={}", id), "");
    assert!(body.contains("server-port"), "порты читаются: {body}");
}

#[test]
fn ошибка_неперенесённого_адреса_понятная() {
    let panel = start_panel();
    let (status, body) = request(panel.port, "GET", "/api/modrinth/search?q=optifine", "");
    assert_eq!(status, 200);
    assert!(body.contains("ещё не перенес"), "ответ: {body}");
}

#[test]
fn история_tps_отдаётся_даже_для_нового_сервера() {
    let panel = start_panel();
    let (_, body) = request(
        panel.port,
        "POST",
        "/api/servers",
        r#"{"name":"Тихий","command":"echo"}"#,
    );
    let id = body
        .split("\"id\":\"")
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .unwrap()
        .to_string();
    let (status, body) = request(panel.port, "GET", &format!("/api/servers/{}/tps", id), "");
    assert_eq!(status, 200);
    assert_eq!(body, "[]", "история пустая, но формат правильный: {body}");
}
