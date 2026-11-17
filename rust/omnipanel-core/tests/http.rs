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
    /// Само ядро панели: тесты проверяют и его состояние, не только ответы.
    app: Arc<App>,
}

impl Drop for Panel {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

/// Поднимает панель на свободном порту. Папка у каждого теста своя —
/// тесты идут параллельно и не должны мешать друг другу.
fn start_panel() -> Panel {
    start_panel_with_assets(false)
}

/// Тот же сервер, но с папкой `assets` рядом с программой (как в окне на Tauri).
fn start_panel_with_assets(with_assets: bool) -> Panel {
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
    let mut panel_server = PanelServer::new(Arc::clone(&app), ui);
    if with_assets {
        let assets = dir.join("assets");
        fs::create_dir_all(assets.join("wallpapers")).unwrap();
        fs::write(assets.join("icon.png"), "PNG-картинка".as_bytes()).unwrap();
        fs::write(assets.join("wallpapers/grid.png"), "PNG-обои".as_bytes()).unwrap();
        panel_server = panel_server.with_assets(assets);
    }
    let server = Arc::new(panel_server);

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
    Panel { port, dir, app }
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
fn неизвестный_адрес_отвечает_по_русски() {
    let panel = start_panel();
    /* даже если адрес выдуман, панель отвечает по-русски и с кодом 200,
       чтобы интерфейс показал сообщение, а не «сломалось всё» */
    let (status, body) = request(panel.port, "GET", "/api/такого-нет", "");
    assert_eq!(status, 200);
    assert!(body.contains("ещё не перенес") || body.contains("не перенесён"), "ответ: {body}");

    /* а аддоны уже работают: список приходит пустым массивом, а не ошибкой */
    let (status, body) = request(panel.port, "GET", "/api/addons/list", "");
    assert_eq!(status, 200);
    assert!(body.trim_start().starts_with('['), "список аддонов: {body}");
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

#[test]
fn нагрузочный_тест_по_http() {
    let panel = start_panel();
    /* список версий и пустое состояние — панель спрашивает их при открытии окна */
    let (status, body) = request(panel.port, "GET", "/api/load/versions", "");
    assert_eq!(status, 200);
    assert!(body.contains("1.20.4"), "версии: {body}");

    let (status, body) = request(panel.port, "GET", "/api/load/status", "");
    assert_eq!(status, 200);
    assert!(body.contains("\"running\":false"), "состояние: {body}");

    /* без сервера тест не запускается — и это понятная ошибка, а не 500 */
    let (status, body) = request(panel.port, "POST", "/api/load/start", r#"{"id":"нет-такого"}"#);
    assert_eq!(status, 200);
    assert!(body.contains("не найден") || body.contains("не выбран"), "ответ: {body}");

    /* остановка, когда ничего не идёт */
    let (status, body) = request(panel.port, "POST", "/api/load/stop", "");
    assert_eq!(status, 200);
    assert!(body.contains("не идёт"), "ответ: {body}");
}

#[test]
fn картинки_рядом_с_программой_отдаются_сервером() {
    let panel = start_panel_with_assets(true);
    /* интерфейс пишет `../assets/icon.png` — браузер просит именно такой адрес */
    let (status, body) = request(panel.port, "GET", "/assets/icon.png", "");
    assert_eq!(status, 200, "иконка панели");
    assert!(body.contains("картинка"), "это та самая картинка: {:?}", body);
    let (status, body) = request(panel.port, "GET", "/assets/wallpapers/grid.png", "");
    assert_eq!(status, 200, "обои");
    assert!(body.contains("обои"));
    /* чужих файлов через этот адрес не отдаём */
    let (status, _) = request(panel.port, "GET", "/assets/../servers.json", "");
    assert_ne!(status, 200, "выход за папку запрещён");
}

#[test]
fn без_папки_картинок_панель_жива() {
    let panel = start_panel_with_assets(false);
    let (status, _) = request(panel.port, "GET", "/assets/icon.png", "");
    assert_eq!(status, 404, "картинки нет — так и отвечаем");
    let (status, _) = request(panel.port, "GET", "/", "");
    assert_eq!(status, 200, "интерфейс при этом работает");
}

#[test]
fn картинки_ищутся_и_в_соседней_папке() {
    /* так выглядит установленная панель: ui и assets рядом с exe, а сервер
       получает путь к интерфейсу — картинки всё равно должны находиться */
    let panel = start_panel();
    let assets = panel.dir.join("assets");
    fs::create_dir_all(&assets).unwrap();
    fs::write(assets.join("icon.png"), "PNG-иконка".as_bytes()).unwrap();

    let mut info = AppInfo::default();
    info.data_dir = panel.dir.clone();
    info.config_path = panel.dir.join("servers.json");
    let app = Arc::new(App::new(info));
    let server = Arc::new(
        PanelServer::new(app, panel.dir.join("ui"))
            .with_assets(panel.dir.join("нет-такой-папки"))
            .with_assets(assets),
    );
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        let _ = server.serve_listener(listener);
    });
    for _ in 0..50 {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let (status, body) = request(port, "GET", "/assets/icon.png", "");
    assert_eq!(status, 200, "берём вторую папку из списка");
    assert!(body.contains("PNG-иконка"));
}

/* ───────────── перенос файлов и архивы через HTTP ───────────── */

/// Добавляет сервер с рабочей папкой и возвращает его id.
fn server_with_dir(port: u16, cwd: &std::path::Path) -> String {
    let body = format!(
        r#"{{"name":"Тест","command":"echo hi","cwd":"{}"}}"#,
        cwd.display().to_string().replace('\\', "\\\\")
    );
    let (_, answer) = request(port, "POST", "/api/servers", &body);
    answer
        .split("\"id\":\"")
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .expect("сервер создан")
        .to_string()
}

#[test]
fn перенос_файла_перетаскиванием_работает() {
    /* Так делает интерфейс: API.filesMove → POST /api/files/move {from, toDir} */
    let panel = start_panel();
    let work = panel.dir.join("сервер");
    fs::create_dir_all(work.join("plugins")).unwrap();
    fs::create_dir_all(work.join("mods")).unwrap();
    fs::write(work.join("plugins/a.jar"), "данные").unwrap();
    let id = server_with_dir(panel.port, &work);

    let (status, body) = request(
        panel.port,
        "POST",
        &format!("/api/files/move?id={id}"),
        r#"{"from":"plugins/a.jar","toDir":"mods"}"#,
    );
    assert_eq!(status, 200, "{body}");
    assert!(body.contains("\"ok\":true"), "перенос не прошёл: {body}");
    assert!(body.contains("mods/a.jar"), "не тот путь в ответе: {body}");
    assert!(work.join("mods/a.jar").exists(), "файл не переехал");
    assert!(!work.join("plugins/a.jar").exists(), "исходник остался");
}

#[test]
fn перенос_папки_и_запрет_вложить_в_себя() {
    let panel = start_panel();
    let work = panel.dir.join("сервер");
    fs::create_dir_all(work.join("plugins/внутри")).unwrap();
    fs::create_dir_all(work.join("mods")).unwrap();
    let id = server_with_dir(panel.port, &work);

    let (_, body) = request(
        panel.port,
        "POST",
        &format!("/api/files/move?id={id}"),
        r#"{"from":"plugins","toDir":"mods"}"#,
    );
    assert!(body.contains("mods/plugins"), "папка не переехала: {body}");
    assert!(work.join("mods/plugins/внутри").exists());

    let (_, body) = request(
        panel.port,
        "POST",
        &format!("/api/files/move?id={id}"),
        r#"{"from":"mods","toDir":"mods/plugins"}"#,
    );
    assert!(body.contains("\"ok\":false"), "папку внутрь себя переносить нельзя: {body}");
    assert!(body.contains("внутрь себя"), "причина не объяснена: {body}");
}

#[test]
fn архивы_открываются_и_распаковываются_через_http() {
    let panel = start_panel();
    let work = panel.dir.join("сервер");
    fs::create_dir_all(work.join("plugins")).unwrap();
    let id = server_with_dir(panel.port, &work);

    /* крошечный zip собираем тем же кодом ядра, что и бэкапы */
    let zip = omnipanel_core::zip::create(&[
        omnipanel_core::zip::NewEntry {
            name: "config.yml".to_string(),
            data: "a: 1\n".as_bytes().to_vec(),
        },
        omnipanel_core::zip::NewEntry {
            name: "plugin.jar".to_string(),
            data: "JARDATA".as_bytes().to_vec(),
        },
    ]);
    fs::write(work.join("сборка.zip"), &zip).unwrap();
    let rel = "%D1%81%D0%B1%D0%BE%D1%80%D0%BA%D0%B0.zip"; /* «сборка.zip» */

    let (status, body) = request(panel.port, "GET", &format!("/api/archive/open?id={id}&rel={rel}"), "");
    assert_eq!(status, 200);
    assert!(body.contains("config.yml"), "список архива пуст: {body}");
    assert!(body.contains("\"total\":2"), "не все файлы видны: {body}");

    let (_, body) = request(
        panel.port,
        "GET",
        &format!("/api/archive/read?id={id}&rel={rel}&name=config.yml"),
        "",
    );
    assert!(body.contains("a: 1"), "файл из архива не прочитался: {body}");

    let (_, body) = request(
        panel.port,
        "POST",
        &format!("/api/archive/extract?id={id}"),
        r#"{"rel":"сборка.zip","dest":"plugins","only":"config.yml"}"#,
    );
    assert!(body.contains("\"ok\":true"), "распаковка не прошла: {body}");
    assert!(work.join("plugins/config.yml").exists(), "файл не появился на диске");
    assert!(fs::read_to_string(work.join("plugins/config.yml")).unwrap().contains("a: 1"));
}

#[test]
fn страница_узнаёт_о_проверке_обновлений_при_подключении() {
    /* Тихая проверка идёт в ядре раз в 20 минут. Если страница открылась
       после неё, событие уже улетело — поэтому при подключении отдаём
       последний результат сразу, иначе плашка «доступно обновление»
       не появится до следующей проверки. */
    let panel = start_panel();
    panel.app.set_update_state(omnipanel_core::json::Value::obj(vec![
        ("ok", omnipanel_core::json::Value::Bool(true)),
        ("latest", omnipanel_core::json::Value::str("1.38.0")),
        ("hasUpdate", omnipanel_core::json::Value::Bool(true)),
    ]));

    let mut stream = std::net::TcpStream::connect(("127.0.0.1", panel.port)).unwrap();
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
        .unwrap();
    use std::io::{Read, Write};
    stream
        .write_all(b"GET /api/events HTTP/1.1\r\nHost: localhost\r\nAccept: text/event-stream\r\n\r\n")
        .unwrap();
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 1024];
    while !String::from_utf8_lossy(&buffer).contains("event: upd:state\ndata: {") {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => buffer.extend_from_slice(&chunk[..read]),
            Err(_) => break,
        }
    }
    let text = String::from_utf8_lossy(&buffer).to_string();
    assert!(text.contains("event: upd:state"), "нет события проверки: {text}");
    assert!(text.contains("1.38.0"), "версия не передана: {text}");
}

/* ───────── консоль: строки журнала в том виде, в каком их ждёт страница ───────── */

/// Открывает поток событий и собирает всё, что придёт за отведённое время.
fn collect_events(port: u16, millis: u64) -> String {
    use std::io::{Read, Write};
    let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream
        .set_read_timeout(Some(std::time::Duration::from_millis(400)))
        .unwrap();
    stream
        .write_all(b"GET /api/events HTTP/1.1\r\nHost: localhost\r\nAccept: text/event-stream\r\n\r\n")
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(millis);
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    while std::time::Instant::now() < deadline {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => buffer.extend_from_slice(&chunk[..read]),
            Err(_) => {}
        }
    }
    String::from_utf8_lossy(&buffer).to_string()
}

#[test]
fn строки_журнала_приходят_в_том_виде_что_ждёт_страница() {
    /* Интерфейс читает { id, entry: { t, m, s } }. Раньше ядро отправляло
       { id, line, state, at } — entry был undefined, обработчик падал на
       entry.m, и консоль не обновлялась вообще. */
    let panel = start_panel();
    let work = panel.dir.join("сервер");
    fs::create_dir_all(&work).unwrap();
    let script = work.join("run.sh");
    fs::write(&script, "#!/bin/sh\necho 'Done (1.0s)!'\nsleep 5\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&script, perms).unwrap();
    }
    let id = server_with_dir(panel.port, &work);
    /* сервер, который печатает строку и живёт дальше */
    let cfg = format!(
        r#"{{"name":"Тест","command":"{}","cwd":"{}"}}"#,
        script.display(),
        work.display()
    );
    request(panel.port, "PUT", &format!("/api/servers/{id}"), &cfg);

    let stream = std::thread::spawn(move || collect_events(panel.port, 3000));
    std::thread::sleep(std::time::Duration::from_millis(300));
    let (_, body) = request(panel.port, "POST", &format!("/api/servers/{id}/start"), "");
    assert!(body.contains("running"), "сервер не запустился: {body}");
    let text = stream.join().unwrap();

    assert!(text.contains("event: log"), "строк журнала нет вовсе: {text}");
    assert!(text.contains("\"entry\":{"), "нет поля entry в строке журнала: {text}");
    assert!(text.contains("\"m\":\"Запуск:"), "нет текста строки: {text}");
    assert!(text.contains("\"s\":\"system\""), "нет уровня строки: {text}");
    assert!(text.contains("Done (1.0s)!"), "вывод сервера не дошёл: {text}");
    assert!(text.contains("event: state"), "нет события состояния: {text}");
    assert!(!text.contains("\"line\":"), "остался старый формат: {text}");
}

#[test]
fn история_журнала_состоит_из_записей_а_не_из_строк() {
    /* Раньше /api/servers/<id>/logs отдавал массив строк — интерфейс рисовал
       «undefined» вместо времени и текста. */
    let panel = start_panel();
    let work = panel.dir.join("сервер");
    fs::create_dir_all(&work).unwrap();
    let id = server_with_dir(panel.port, &work);
    panel
        .app
        .invoke("server:logs", &[])
        .err(); /* канал есть, аргументов не хватает — это не ошибка теста */

    /* кладём строку в журнал тем же путём, что и запуск: через сообщение в никуда */
    let (_, body) = request(panel.port, "GET", &format!("/api/servers/{id}/logs"), "");
    assert_eq!(body.trim(), "[]", "журнал нового сервера пуст: {body}");

    /* стартуем сервер, который сразу печатает, и читаем историю снова */
    let script = work.join("run.sh");
    fs::write(&script, "#!/bin/sh\necho 'строка истории'\nsleep 3\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&script, perms).unwrap();
    }
    let cfg = format!(
        r#"{{"name":"Тест","command":"{}","cwd":"{}"}}"#,
        script.display(),
        work.display()
    );
    let (_, _) = request(panel.port, "PUT", &format!("/api/servers/{id}"), &cfg);
    request(panel.port, "POST", &format!("/api/servers/{id}/start"), "");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let mut body = String::new();
    while std::time::Instant::now() < deadline {
        let (_, answer) = request(panel.port, "GET", &format!("/api/servers/{id}/logs"), "");
        body = answer;
        if body.contains("строка истории") {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    assert!(body.contains("\"m\":\"строка истории\""), "нет записи журнала: {body}");
    assert!(body.contains("\"s\":\"stdout\""), "нет уровня строки: {body}");
    assert!(!body.contains("\"["), "журнал всё ещё массив строк: {body}");
}

/* ───────── живой поток: разметка кусками, стук, счётчик страниц ───────── */

#[test]
fn поток_событий_отдаётся_кусками() {
    /* Ответ без Content-Length и без разметки кусков браузер вправе считать
       пустым — тогда строки журнала остаются у него в буфере и консоль не
       обновляется, хотя сервер работает. Проверяем разметку прямо в ответе. */
    use std::io::{Read, Write};
    let panel = start_panel();
    let mut stream = std::net::TcpStream::connect(("127.0.0.1", panel.port)).unwrap();
    stream
        .set_read_timeout(Some(std::time::Duration::from_millis(700)))
        .unwrap();
    stream
        .write_all(b"GET /api/events HTTP/1.1\r\nHost: localhost\r\nAccept: text/event-stream\r\n\r\n")
        .unwrap();
    let mut raw = Vec::new();
    let mut chunk = [0u8; 2048];
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(1200);
    while std::time::Instant::now() < deadline {
        if let Ok(read) = stream.read(&mut chunk) {
            if read == 0 {
                break;
            }
            raw.extend_from_slice(&chunk[..read]);
        }
    }
    let text = String::from_utf8_lossy(&raw).to_string();
    assert!(text.contains("Content-Type: text/event-stream"), "не тот тип: {text}");
    assert!(text.contains("Transfer-Encoding: chunked"), "нет разметки кусков: {text}");
    /* первый кусок — «retry: 2000», перед ним его длина в шестнадцатеричном виде */
    let after_headers = text.split("\r\n\r\n").nth(1).unwrap_or("");
    let first_line = after_headers.lines().next().unwrap_or("");
    assert!(
        first_line.chars().all(|c| c.is_ascii_hexdigit()) && !first_line.is_empty(),
        "ответ не размечен на куски: {after_headers:?}"
    );
    assert!(text.contains("retry: 2000"), "нет указания на повтор: {text}");
}

#[test]
fn поток_событий_стучится_пока_молчит() {
    /* Сервер может долго ничего не печатать. Пустой комментарий раз в
       несколько секунд показывает, что связь жива, и не даёт прокси с
       антивирусом закрыть поток. */
    std::env::set_var("OMNI_SSE_PING", "1");
    let panel = start_panel();
    let mut stream = std::net::TcpStream::connect(("127.0.0.1", panel.port)).unwrap();
    stream
        .set_read_timeout(Some(std::time::Duration::from_millis(300)))
        .unwrap();
    use std::io::{Read, Write};
    stream
        .write_all(b"GET /api/events HTTP/1.1\r\nHost: localhost\r\n\r\n")
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(4);
    let mut raw = Vec::new();
    let mut chunk = [0u8; 2048];
    while std::time::Instant::now() < deadline {
        if let Ok(read) = stream.read(&mut chunk) {
            if read == 0 {
                break;
            }
            raw.extend_from_slice(&chunk[..read]);
        }
        if String::from_utf8_lossy(&raw).contains(": keep") {
            break;
        }
    }
    let text = String::from_utf8_lossy(&raw).to_string();
    assert!(text.contains(": keep"), "стука нет: {text}");
    std::env::remove_var("OMNI_SSE_PING");
}

#[test]
fn видно_сколько_страниц_слушает_события() {
    /* /api/events/info — короткий ответ для разбора жалоб «консоль не
       обновляется»: если слушателей ноль, значит страница не подключилась. */
    let panel = start_panel();
    let (status, body) = request(panel.port, "GET", "/api/events/info", "");
    assert_eq!(status, 200);
    assert!(body.contains("\"ok\":true"), "{body}");
    assert!(body.contains("\"listeners\":0"), "пока никто не слушает: {body}");

    use std::io::Write;
    let mut stream = std::net::TcpStream::connect(("127.0.0.1", panel.port)).unwrap();
    stream
        .write_all(b"GET /api/events HTTP/1.1\r\nHost: localhost\r\n\r\n")
        .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(300));
    let (_, body) = request(panel.port, "GET", "/api/events/info", "");
    assert!(body.contains("\"listeners\":1"), "страница подключилась: {body}");
}

/* ───────── ссылки из панели открываются системным браузером ───────── */

#[test]
fn ссылка_на_гитхаб_уходит_в_системный_браузер() {
    /* Кнопка «Открыть github.com/login/device» ничего не делала: интерфейс звал
       window.open, а в окне панели всплывающие окна закрыты. Теперь адрес
       передаётся ядру, и оно открывает системный браузер. */
    let panel = start_panel();
    let (status, body) = request(
        panel.port,
        "POST",
        "/api/gh/openExternal",
        r#"{"url":"https://github.com/login/device"}"#,
    );
    assert_eq!(status, 200, "{body}");
    assert!(body.contains("\"ok\""), "нет ответа: {body}");
    /* ответ либо «открыл», либо — если в системе нечем открывать — понятная
       причина со ссылкой, чтобы её можно было скопировать вручную */
    if !body.contains("\"ok\":true") {
        assert!(body.contains("github.com/login/device"), "нет ссылки в ответе: {body}");
    }
}

#[test]
fn не_ссылка_вместо_адреса_честно_отвергается() {
    let panel = start_panel();
    let (_, body) = request(
        panel.port,
        "POST",
        "/api/gh/openExternal",
        r#"{"url":"file:///C:/Windows/System32/calc.exe"}"#,
    );
    assert!(body.contains("\"ok\":false"), "открывать что попало нельзя: {body}");
    assert!(body.contains("не ссылка"), "причина не объяснена: {body}");
}
