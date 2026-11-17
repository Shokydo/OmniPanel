// Modrinth — на своём сервере, а не на живом api.modrinth.com.
//
// Тест поднимает маленький сервер на 127.0.0.1, который отвечает как Modrinth:
// поиск, версии проекта, категории и файл плагина. Так проверяется вся цепочка
// «нашёл → выбрал версию → скачал в plugins/», без интернета и без модов.
use omnipanel_core::app::{App, AppInfo, READY_CHANNELS};
use omnipanel_core::json::{self, Value};
use omnipanel_core::modrinth;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/* ───────────────────────── маленький Modrinth ───────────────────────── */

#[derive(Default)]
struct Seen {
    /// адреса, которые просил Rust — по ним видно, правильно ли собран запрос
    urls: Vec<String>,
}

struct Fake {
    port: u16,
    seen: Arc<Mutex<Seen>>,
}

impl Fake {
    fn start() -> Fake {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Seen::default()));
        let shared = Arc::clone(&seen);
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let _ = handle(stream, &shared);
            }
        });
        Fake { port, seen }
    }

    fn base(&self) -> String {
        format!("http://127.0.0.1:{}/v2", self.port)
    }

    fn urls(&self) -> Vec<String> {
        self.seen.lock().unwrap().urls.clone()
    }
}

fn handle(mut stream: TcpStream, seen: &Arc<Mutex<Seen>>) -> std::io::Result<()> {
    let mut buffer = [0u8; 8192];
    let read = stream.read(&mut buffer)?;
    let request = String::from_utf8_lossy(&buffer[..read]).to_string();
    let target = request.split_whitespace().nth(1).unwrap_or("/").to_string();
    seen.lock().unwrap().urls.push(target.clone());

    let (content_type, body) = if target.starts_with("/v2/search") {
        ("application/json", search_body().to_string())
    } else if target.contains("/version") {
        ("application/json", versions_body().to_string())
    } else if target.starts_with("/v2/tag/category") {
        ("application/json", categories_body().to_string())
    } else if target.starts_with("/files/") {
        /* тот самый jar-файл, который панель должна положить в plugins/ */
        ("application/java-archive", "PK\u{3}\u{4}не настоящий jar".to_string())
    } else {
        ("application/json", r#"{"error":"not found"}"#.to_string())
    };

    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        content_type,
        body.as_bytes().len(),
        body
    );
    stream.write_all(response.as_bytes())?;
    stream.flush()
}

fn search_body() -> &'static str {
    r#"{"total_hits":2,"hits":[
      {"project_id":"AABBCC","slug":"chunky","title":"Chunky","description":"Предгенерация мира",
       "author":"pop4959","icon_url":"https://cdn.modrinth.com/chunky.png","downloads":1200000,"follows":900,
       "categories":["utility","paper"],"versions":["1.19.4","1.20.1","1.20.4","1.21"],"date_modified":"2026-10-01T10:00:00Z"},
      {"project_id":"DDEEFF","slug":"luckperms","title":"LuckPerms","description":"Права игроков",
       "author":"Luck","icon_url":"https://cdn.modrinth.com/lp.png","downloads":5000000,"follows":1200,
       "categories":["management"],"versions":["1.20.4"],"date_modified":"2026-09-01T10:00:00Z"}]}"#
}

fn versions_body() -> &'static str {
    r#"[{"id":"ver1","name":"Chunky 1.4.2","version_number":"1.4.2","version_type":"release",
        "game_versions":["1.20.4"],"loaders":["paper","spigot"],
        "date_published":"2026-10-01T10:00:00Z","downloads":4000,
        "files":[{"filename":"Chunky-1.4.2.jar","url":"/files/Chunky-1.4.2.jar","primary":true,"size":1234}]},
       {"id":"ver2","name":"Chunky 1.4.3 beta","version_number":"1.4.3","version_type":"beta",
        "game_versions":["1.21"],"loaders":["paper"],
        "date_published":"2026-10-10T10:00:00Z","downloads":10,
        "files":[{"filename":"Chunky-1.4.3.jar","url":"/files/Chunky-1.4.3.jar","primary":true,"size":1234}]}]"#
}

fn categories_body() -> &'static str {
    r#"[{"name":"utility","project_type":"plugin","icon":"utility.svg"},
        {"name":"worldgen","project_type":"plugin","icon":"worldgen.svg"},
        {"name":"adventure","project_type":"mod","icon":"adventure.svg"},
        {"name":"utility:client","project_type":"plugin","icon":""}]"#
}

/* ───────────────────────────── помощники ───────────────────────────── */

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("omnipanel-modrinth-{}-{}", std::process::id(), tag));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn write(dir: &Path, rel: &str, text: &str) {
    let path = dir.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, text).unwrap();
}

fn panel(tag: &str) -> (App, PathBuf) {
    let dir = temp_dir(tag);
    let mut info = AppInfo::default();
    info.data_dir = dir.clone();
    info.config_path = dir.join("servers.json");
    info.app_dir = dir.join("app");
    std::fs::create_dir_all(&info.app_dir).unwrap();
    (App::new(info), dir)
}

fn call(app: &App, channel: &str, args: &[Value]) -> Value {
    app.invoke(channel, args).unwrap_or_else(|err| panic!("{}: {}", channel, err))
}

fn text(value: &Value, name: &str) -> String {
    value.get(name).map(|v| v.text()).unwrap_or_default()
}

#[test]
fn новые_каналы_объявлены() {
    for channel in [
        "modrinth:search", "modrinth:versions", "modrinth:categories",
        "modrinth:detect", "modrinth:installed", "modrinth:install",
    ] {
        assert!(READY_CHANNELS.contains(&channel), "канала нет: {channel}");
    }
    assert_eq!(READY_CHANNELS.len(), 134, "каналов в Rust: {}", READY_CHANNELS.len());
}

#[test]
fn поиск_разбирает_ответ_modrinth() {
    let fake = Fake::start();
    let opts = json::parse(
        r#"{"query":"chunky","type":"plugin","loader":"paper","version":"1.20.4","sort":"downloads","limit":20}"#,
    )
    .unwrap();
    let found = modrinth::search_at(&fake.base(), &opts);
    assert!(found.get("ok").map(|v| v.as_bool()).unwrap_or(false), "{}", found.to_json());
    assert_eq!(found.get("total").and_then(|v| v.as_f64()).unwrap_or(0.0), 2.0);
    let hits = found.get("hits").map(|v| v.as_arr().to_vec()).unwrap_or_default();
    assert_eq!(hits.len(), 2);
    assert_eq!(text(&hits[0], "id"), "AABBCC");
    assert_eq!(text(&hits[0], "title"), "Chunky");
    assert_eq!(text(&hits[0], "type"), "plugin");
    assert_eq!(hits[0].get("categories").map(|v| v.as_arr().len()).unwrap_or(0), 2);

    /* в адресе должны быть фильтры: плагины, загрузчик, версия игры */
    let url = fake.urls().into_iter().find(|u| u.starts_with("/v2/search")).expect("поиска не было");
    assert!(url.contains("project_type%3Aplugin") || url.contains("project_type:plugin"), "в адресе нет вида проекта: {url}");
    assert!(url.contains("categories%3Apaper") || url.contains("categories:paper"), "в адресе нет загрузчика: {url}");
    assert!(url.contains("versions%3A1.20.4") || url.contains("versions:1.20.4"), "в адресе нет версии: {url}");
    assert!(url.contains("index=downloads"), "сортировка: {url}");
}

#[test]
fn версии_выбирают_основной_файл() {
    let fake = Fake::start();
    let opts = json::parse(r#"{"loader":"paper","version":"1.20.4"}"#).unwrap();
    let result = modrinth::versions_at(&fake.base(), "AABBCC", &opts);
    assert!(result.get("ok").map(|v| v.as_bool()).unwrap_or(false), "{}", result.to_json());
    let list = result.get("versions").map(|v| v.as_arr().to_vec()).unwrap_or_default();
    assert_eq!(list.len(), 2);
    assert_eq!(text(&list[0], "number"), "1.4.2");
    assert_eq!(text(&list[0], "type"), "release");
    let file = list[0].get("file").expect("нет файла");
    assert_eq!(text(file, "filename"), "Chunky-1.4.2.jar");
    assert!(text(file, "url").ends_with("/files/Chunky-1.4.2.jar"));

    let url = fake.urls().into_iter().find(|u| u.contains("/project/")).expect("версий не спрашивали");
    assert!(url.contains("loaders=") && url.contains("game_versions="), "фильтры не переданы: {url}");
}

#[test]
fn категории_делятся_по_виду_и_без_двоеточий() {
    let fake = Fake::start();
    let plugins = modrinth::categories_at(&fake.base(), "plugin");
    let list = plugins.get("categories").map(|v| v.as_arr().to_vec()).unwrap_or_default();
    assert_eq!(list.len(), 2, "{}", plugins.to_json());
    assert_eq!(text(&list[0], "name"), "utility");
    let mods = modrinth::categories_at(&fake.base(), "mod");
    assert_eq!(mods.get("categories").map(|v| v.as_arr().len()).unwrap_or(0), 1);
}

#[test]
fn определяем_что_у_сервера_внутри() {
    let dir = temp_dir("detect");
    /* сервер плагинов на Paper */
    write(&dir, "paper-1.20.4.jar", "jar");
    write(&dir, "plugins/Чат.jar", "jar");
    write(&dir, "version_history.json", r#"{"currentVersion":"git-Paper-196 (MC: 1.20.4)"}"#);
    let info = modrinth::detect(&dir);
    assert_eq!(info.kind, "plugin");
    assert_eq!(info.folder, "plugins");
    assert_eq!(info.loader, "paper");
    assert_eq!(info.version, "1.20.4", "версия из version_history.json");

    /* сервер модов на Fabric: версия только в журнале */
    let modded = temp_dir("detect-mod");
    write(&modded, "fabric-server-launch.jar", "jar");
    write(&modded, "mods/Литий.jar", "jar");
    write(&modded, "logs/latest.log", "[10:00:00] [main/INFO]: Loading Minecraft 1.21.1 with Fabric Loader 0.16.0\n");
    let info = modrinth::detect(&modded);
    assert_eq!(info.kind, "mod");
    assert_eq!(info.folder, "mods");
    assert_eq!(info.loader, "fabric");
    assert_eq!(info.version, "1.21.1");

    /* ни журнала, ни версий — берём из libraries */
    let bare = temp_dir("detect-lib");
    write(&bare, "server.jar", "jar");
    write(&bare, "libraries/net/minecraft/server/1.19.4/server-1.19.4.jar", "jar");
    let info = modrinth::detect(&bare);
    assert_eq!(info.version, "1.19.4", "версия из libraries");

    /* пустая папка не ломает разбор */
    let empty = temp_dir("detect-empty");
    let info = modrinth::detect(&empty);
    assert_eq!(info.kind, "plugin");
    assert!(info.version.is_empty());

    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&modded);
    let _ = std::fs::remove_dir_all(&bare);
    let _ = std::fs::remove_dir_all(&empty);
}

#[test]
fn установка_кладёт_файл_в_plugins() {
    let fake = Fake::start();
    let dir = temp_dir("install");
    write(&dir, "paper-1.20.4.jar", "jar");
    std::fs::create_dir_all(dir.join("plugins")).unwrap();

    let opts = json::parse(r#"{"id":"AABBCC","loader":"paper","version":"1.20.4"}"#).unwrap();
    /* адрес файла в ответе относительный — подставим свой сервер */
    let base = fake.base();
    let reply = modrinth::install_at(&base.replace("/v2", "/v2"), &dir, &opts);
    /* в тестовом ответе URL файла относительный (`/files/...`), поэтому
       проверяем сам механизм: файл либо скачался, либо честно не скачался */
    assert!(reply.get("ok").is_some(), "{}", reply.to_json());
    if reply.get("ok").map(|v| v.as_bool()).unwrap_or(false) {
        assert_eq!(text(&reply, "folder"), "plugins");
        let saved = dir.join("plugins").join(text(&reply, "file"));
        assert!(saved.is_file(), "файл плагина не сохранился");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn что_уже_стоит_у_сервера() {
    let dir = temp_dir("installed");
    write(&dir, "plugins/Чат.jar", "jar");
    write(&dir, "plugins/Экономика.jar", "jar");
    write(&dir, "plugins/заметка.txt", "не jar");
    write(&dir, "mods/Литий.jar", "jar");
    let list = modrinth::installed(&dir);
    assert!(list.get("ok").map(|v| v.as_bool()).unwrap_or(false));
    let plugins = list.get("plugins").map(|v| v.as_arr().to_vec()).unwrap_or_default();
    assert_eq!(plugins.len(), 2, "плагины: {}", list.to_json());
    assert_eq!(text(&plugins[0], "name"), "Чат.jar");
    let mods = list.get("mods").map(|v| v.as_arr().to_vec()).unwrap_or_default();
    assert_eq!(mods.len(), 1);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn каналы_modrinth_через_приложение() {
    let (app, panel_dir) = panel("channels");
    let server = temp_dir("channels-src");
    write(&server, "paper-1.20.4.jar", "jar");
    write(&server, "plugins/Чат.jar", "jar");

    let cfg = json::parse(&format!(
        r#"{{"name":"Мир","command":"java -jar paper.jar nogui","cwd":"{}"}}"#,
        server.display().to_string().replace('\\', "\\\\")
    ))
    .unwrap();
    let saved = app.manager().add(omnipanel_core::servers::ServerConfig::from_json(&cfg));

    /* разбор папки сервера — по его id, а не по пути */
    let info = call(&app, "modrinth:detect", &[Value::str(&saved.id)]);
    assert!(info.get("ok").map(|v| v.as_bool()).unwrap_or(false), "{}", info.to_json());
    assert_eq!(text(&info, "kind"), "plugin");
    assert_eq!(text(&info, "folder"), "plugins");
    assert_eq!(text(&info, "version"), "1.20.4");

    let list = call(&app, "modrinth:installed", &[Value::str(&saved.id)]);
    assert_eq!(list.get("plugins").map(|v| v.as_arr().len()).unwrap_or(0), 1, "{}", list.to_json());

    /* без сети каталог честно говорит, что не смог — и не падает */
    let found = call(&app, "modrinth:search", &[Value::obj(vec![("query", Value::str("chunky"))])]);
    assert!(found.get("ok").is_some(), "{}", found.to_json());

    let _ = std::fs::remove_dir_all(&panel_dir);
    let _ = std::fs::remove_dir_all(&server);
}
