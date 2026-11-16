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
    /* читаем байтами: ответ бывает картинкой, а не текстом */
    let mut raw = Vec::new();
    let _ = stream.read_to_end(&mut raw);
    let response = String::from_utf8_lossy(&raw).to_string();
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
    /* адрес, который ещё не перенесён, обязан отвечать по-русски и с кодом 200,
       чтобы интерфейс показал сообщение, а не «сломалось всё» */
    let (status, body) = request(panel.port, "GET", "/api/addons/list", "");
    assert_eq!(status, 200);
    assert!(body.contains("ещё не перенес") || body.contains("не перенесён"), "ответ: {body}");
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

#[test]
fn синхронизация_и_обновления_по_http() {
    /* сервер-заглушка вместо настоящего GitHub: адреса берём из переменных среды */
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let fake = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut stream = stream;
            let mut buffer = Vec::new();
            let mut chunk = [0u8; 2048];
            loop {
                let read = match stream.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => read,
                };
                buffer.extend_from_slice(&chunk[..read]);
                if buffer.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            let head = String::from_utf8_lossy(&buffer).to_string();
            let path = head.lines().next().unwrap_or("").split_whitespace().nth(1).unwrap_or("/");
            let (status, body) = if path.contains("/gh/user") && !path.contains("/repos") {
                (200, r#"{"login":"тестер","name":"Тест","avatar_url":""}"#.to_string())
            } else if path.contains("/gl/user") {
                (200, r#"{"username":"гитлабовец"}"#.to_string())
            } else {
                (404, r#"{"message":"Not Found"}"#.to_string())
            };
            let head = format!(
                "HTTP/1.1 {} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                status,
                body.len()
            );
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(body.as_bytes());
            let _ = stream.flush();
        }
    });
    std::env::set_var("OMNI_GITHUB_API", format!("http://127.0.0.1:{}/gh", fake));
    std::env::set_var("OMNI_GITLAB_API", format!("http://127.0.0.1:{}/gl", fake));
    std::env::set_var("OMNI_GITHUB_OAUTH", format!("http://127.0.0.1:{}/gh", fake));
    std::env::set_var("OMNI_UPDATE_RAW", format!("http://127.0.0.1:{}/raw", fake));

    let panel = start_panel();

    /* аккаунт GitHub и вход по токену */
    let (status, body) = request(panel.port, "GET", "/api/gh/account", "");
    assert_eq!(status, 200);
    assert!(body.contains("\"hasToken\":false"), "нет аккаунта: {body}");
    let (_, body) = request(panel.port, "POST", "/api/gh/login", r#"{"token":"test-token"}"#);
    assert!(body.contains("\"ok\":true"), "вход не удался: {body}");
    assert!(body.contains("тестер"), "имя аккаунта не пришло: {body}");
    let (_, body) = request(panel.port, "GET", "/api/gh/account", "");
    assert!(body.contains("\"hasToken\":true"), "аккаунт не сохранился: {body}");
    assert!(body.contains("••••••••"), "токен наружу отдавать нельзя: {body}");

    /* GitLab: свой токен */
    let (_, body) = request(panel.port, "POST", "/api/gl/save", r#"{"token":"gl-token"}"#);
    assert!(body.contains("\"ok\":true"), "{body}");
    let (_, body) = request(panel.port, "POST", "/api/gl/check", r#"{"repo":""}"#);
    assert!(body.contains("гитлабовец"), "GitLab не ответил: {body}");

    /* обновления: настройки канала и пустой канал */
    let (_, body) = request(panel.port, "GET", "/api/upd/config", "");
    assert!(body.contains("Shokydo/OmniPanel"), "канал по умолчанию: {body}");
    let (_, body) = request(panel.port, "POST", "/api/upd/save", r#"{"branch":"мир"}"#);
    assert!(body.contains("мир"), "ветка не сохранилась: {body}");
    let (_, body) = request(panel.port, "POST", "/api/upd/check", "");
    assert!(body.contains("\"ok\":false"), "пустой канал должен давать понятный отказ: {body}");
    assert!(body.contains("не нашлось"), "текст отказа: {body}");
}

#[test]
fn поиск_серверов_по_http() {
    let panel = start_panel();
    let root = std::env::temp_dir().join(format!("omnipanel-http-scan-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let server = root.join("настоящий");
    fs::create_dir_all(&server).unwrap();
    fs::write(server.join("server.properties"), "level-name=world\n").unwrap();
    fs::write(server.join("paper.jar"), "jar").unwrap();
    fs::write(server.join("eula.txt"), "eula=true\n").unwrap();

    let (status, body) = request(panel.port, "GET", "/api/scan/roots", "");
    assert_eq!(status, 200);
    assert!(body.contains('/'), "корни для поиска: {body}");

    let payload = format!(
        r#"{{"roots":["{}"],"maxDepth":3}}"#,
        server.display().to_string().replace('\\', "\\\\")
    );
    let (_, body) = request(panel.port, "POST", "/api/scan/start", &payload);
    assert!(body.contains("minecraft"), "сервер не найден: {body}");
    assert!(body.contains("paper.jar"), "нет подсказок: {body}");
    let (_, body) = request(panel.port, "POST", "/api/scan/cancel", "");
    assert!(body.contains("true"), "{body}");

    /* автозапуск: чтение состояния не должно падать */
    let (_, body) = request(panel.port, "GET", "/api/autostart/get", "");
    assert!(body == "true" || body == "false", "состояние автозапуска: {body}");

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn обои_отдаются_браузеру() {
    use omnipanel_core::image::{self, Image};
    let panel = start_panel();
    let folder = panel.dir.join("wallpapers");
    fs::create_dir_all(&folder).unwrap();

    let mut picture = Image::new(8, 8);
    for pixel in picture.pixels.chunks_mut(4) {
        pixel[0] = 30;
        pixel[1] = 60;
        pixel[2] = 200;
        pixel[3] = 255;
    }
    fs::write(folder.join("синий.png"), image::encode_png(&picture)).unwrap();

    /* фон отдаётся как файл, а не как JSON — иначе браузер его не покажет */
    let (status, body) = request(panel.port, "GET", "/api/wall/%D1%81%D0%B8%D0%BD%D0%B8%D0%B9.png", "");
    assert_eq!(status, 200, "фон не отдался");
    assert!(body.contains("PNG") || body.len() > 50, "фон пришёл пустым");

    /* выйти из папки панели нельзя */
    let (status, _) = request(panel.port, "GET", "/api/wall/..%2Fservers.json", "");
    assert_ne!(status, 200, "панель отдала файл из чужой папки");

    /* палитра по своим обоям считается */
    let (status, body) = request(
        panel.port,
        "POST",
        "/api/wall/palette",
        r#"{"kind":"custom","name":"синий.png"}"#,
    );
    assert_eq!(status, 200);
    assert!(body.contains("\"ok\":true"), "палитра: {body}");
    assert!(body.contains("accent"), "в палитре нет акцента: {body}");
}

#[test]
fn бэкапы_по_http() {
    let panel = start_panel();
    let server_dir = panel.dir.join("мой сервер");
    fs::create_dir_all(server_dir.join("world")).unwrap();
    fs::write(server_dir.join("server.properties"), "level-name=world\n").unwrap();
    fs::write(server_dir.join("world").join("level.dat"), "уровень").unwrap();

    let body = format!(
        r#"{{"name":"Мир","command":"java -jar server.jar nogui","cwd":"{}"}}"#,
        server_dir.display().to_string().replace('\\', "\\\\")
    );
    let (status, created) = request(panel.port, "POST", "/api/servers", &body);
    assert_eq!(status, 200, "{created}");
    let id = omnipanel_core::json::parse(&created)
        .ok()
        .and_then(|v| v.get("id").map(|i| i.text()))
        .unwrap_or_default();
    assert!(!id.is_empty(), "сервер не добавился: {created}");

    /* создание бэкапа */
    let (_, made) = request(
        panel.port,
        "POST",
        &format!("/api/servers/{}/backups/create", id),
        r#"{"lean":true}"#,
    );
    assert!(made.contains("\"ok\":true"), "бэкап не создался: {made}");
    let file = omnipanel_core::json::parse(&made)
        .ok()
        .and_then(|v| v.get("file").map(|f| f.text()))
        .unwrap_or_default();
    assert!(std::path::Path::new(&file).is_file(), "файла архива нет: {made}");

    /* список и размер */
    let (_, list) = request(panel.port, "GET", &format!("/api/servers/{}/backups", id), "");
    assert!(list.contains("createdAt"), "список архивов: {list}");
    let (_, size) = request(panel.port, "GET", &format!("/api/servers/{}/backups/size", id), "");
    assert!(size.contains("bytes"), "размер папки: {size}");

    /* удаление по адресу без id — так зовёт интерфейс */
    let payload = format!(r#"{{"file":"{}"}}"#, file.replace('\\', "\\\\"));
    let (_, removed) = request(panel.port, "POST", "/api/backup/delete", &payload);
    assert!(removed.contains("true"), "не удалилось: {removed}");
    assert!(!std::path::Path::new(&file).exists());
}

#[test]
fn без_папки_интерфейса_понятная_страница() {
    /* панель без интерфейса не молчит: она объясняет, чего не хватает */
    let dir = std::env::temp_dir().join(format!("omnipanel-http-noui-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let mut info = AppInfo::default();
    info.data_dir = dir.clone();
    info.config_path = dir.join("servers.json");
    let app = Arc::new(App::new(info));
    let server = std::sync::Arc::new(PanelServer::new(Arc::clone(&app), dir.join("нет-ui")));
    let port = {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.local_addr().unwrap().port()
    };
    let serving = std::sync::Arc::clone(&server);
    std::thread::spawn(move || {
        let _ = serving.serve(port);
    });
    std::thread::sleep(Duration::from_millis(150));

    let (status, body) = request(port, "GET", "/", "");
    assert_eq!(status, 200);
    assert!(body.contains("папки с интерфейсом"), "страница: {body}");
    assert!(body.contains("ui"), "нет упоминания папки ui");
    let _ = fs::remove_dir_all(&dir);
}
