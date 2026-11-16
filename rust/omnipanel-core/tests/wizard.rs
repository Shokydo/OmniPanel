// Мастер создания сервера — на своём сервере, а не на живых API.
//
// Поднимается маленький сервер, который отвечает как PaperMC, Purpur, Fabric,
// Mojang и Forge. Так проверяется вся цепочка: каталог ядер → список версий →
// ссылка на сборку → скачивание → eula.txt, server.properties, скрипт запуска.
use omnipanel_core::app::{App, AppInfo, READY_CHANNELS};
use omnipanel_core::json::{self, Value};
use omnipanel_core::kernels::{self, Bases};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/* ─────────────────── маленький сервер источников ─────────────────── */

struct Fake {
    port: u16,
    seen: Arc<Mutex<Vec<String>>>,
}

impl Fake {
    fn start() -> Fake {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let shared = Arc::clone(&seen);
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let _ = handle(stream, &shared, port);
            }
        });
        Fake { port, seen }
    }

    fn base(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    fn bases(&self) -> Bases {
        Bases::all_at(&self.base())
    }

    fn urls(&self) -> Vec<String> {
        self.seen.lock().unwrap().clone()
    }
}

fn handle(mut stream: TcpStream, seen: &Arc<Mutex<Vec<String>>>, port: u16) -> std::io::Result<()> {
    let mut buffer = [0u8; 8192];
    let read = stream.read(&mut buffer)?;
    let request = String::from_utf8_lossy(&buffer[..read]).to_string();
    let target = request.split_whitespace().nth(1).unwrap_or("/").to_string();
    seen.lock().unwrap().push(target.clone());

    /* журнал сборки по адресу, чтобы понять, куда панель ходила */
    let (content_type, body): (&str, String) = if target.ends_with("/paper/versions") {
        ("application/json", paper_versions())
    } else if target.contains("/paper/versions/") && target.ends_with("/builds") {
        ("application/json", paper_builds(port))
    } else if target.starts_with("/purpur/purpur") {
        ("application/json", r#"{"versions":["1.19.4","1.20.1","1.20.4"]}"#.to_string())
    } else if target.ends_with("/fabric/versions/game") {
        (
            "application/json",
            r#"[{"version":"1.20.4","stable":true},{"version":"1.21.1","stable":true},{"version":"24w14a","stable":false}]"#.to_string(),
        )
    } else if target.ends_with("/fabric/versions/loader") {
        ("application/json", r#"[{"version":"0.16.9","stable":true}]"#.to_string())
    } else if target.ends_with("/fabric/versions/installer") {
        ("application/json", r#"[{"version":"1.0.1","stable":true}]"#.to_string())
    } else if target.contains("/fabric/versions/loader/") && target.ends_with("/server/jar") {
        ("application/java-archive", "fabric jar".to_string())
    } else if target.ends_with("/forge/promotions_slim.json") {
        (
            "application/json",
            r#"{"promos":{"1.20.4-latest":"49.0.30","1.20.4-recommended":"49.0.19","1.19.2-latest":"43.2.0"}}"#.to_string(),
        )
    } else if target.ends_with("/neoforge/maven-metadata.xml") {
        (
            "application/xml",
            "<metadata><versioning><versions><version>21.1.9</version><version>21.1.10-beta</version></versions></versioning></metadata>".to_string(),
        )
    } else if target.ends_with("/mc/game/version_manifest_v2.json") {
        (
            "application/json",
            format!(
                r#"{{"versions":[{{"id":"1.20.4","type":"release","url":"http://127.0.0.1:{0}/mojang/meta/1.20.4.json"}},{{"id":"24w14a","type":"snapshot","url":"http://127.0.0.1:{0}/mojang/meta/24w14a.json"}}]}}"#,
                port
            ),
        )
    } else if target.contains("/meta/") {
        (
            "application/json",
            format!(
                r#"{{"downloads":{{"server":{{"url":"http://127.0.0.1:{}/files/server.jar","size":1234,"sha1":"abc"}}}}}}"#,
                port
            ),
        )
    } else if target.contains("/files/") {
        ("application/java-archive", "серверный jar".to_string())
    } else {
        ("application/json", r#"{"error":"нет такого адреса"}"#.to_string())
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

fn paper_versions() -> String {
    r#"{"versions":[
      {"version":{"id":"1.20.4","support":{"status":"SUPPORTED"},"java":{"version":{"minimum":17}}}},
      {"version":{"id":"1.21.1","support":{"status":"SUPPORTED"},"java":{"version":{"minimum":21}}}},
      {"version":{"id":"1.7.10","support":{"status":"UNSUPPORTED"}}}]}"#
        .to_string()
}

fn paper_builds(port: u16) -> String {
    format!(
        r#"[{{"id":"499","channel":"BETA","downloads":{{"server:default":{{"url":"http://127.0.0.1:{0}/files/paper.jar","name":"paper-1.20.4-499.jar","size":42,"checksums":{{"sha256":"ff"}}}}}}}},
        {{"id":"500","channel":"STABLE","downloads":{{"server:default":{{"url":"http://127.0.0.1:{0}/files/paper.jar","name":"paper-1.20.4-500.jar","size":100,"checksums":{{"sha256":"ee"}}}}}}}}]"#,
        port
    )
}

/* ──────────────────────────── помощники ──────────────────────────── */

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("omnipanel-wizard-{}-{}", std::process::id(), tag));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
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
        "wizard:catalog", "wizard:versions", "wizard:java", "wizard:openJava",
        "wizard:pickParent", "wizard:suggestDir", "wizard:create",
    ] {
        assert!(READY_CHANNELS.contains(&channel), "канала нет: {channel}");
    }
    assert_eq!(READY_CHANNELS.len(), 122, "каналов в Rust: {}", READY_CHANNELS.len());
}

#[test]
fn каталог_ядер_как_в_панели() {
    let list = kernels::catalog();
    let items = list.as_arr();
    assert_eq!(items.len(), 10, "ядер: {}", items.len());
    let ids: Vec<String> = items.iter().map(|k| text(k, "id")).collect();
    for id in ["paper", "folia", "purpur", "fabric", "vanilla", "forge", "neoforge", "velocity", "waterfall", "custom"] {
        assert!(ids.contains(&id.to_string()), "нет ядра {id}");
    }
    let paper = items.iter().find(|k| text(k, "id") == "paper").unwrap();
    assert!(paper.get("recommended").map(|v| v.as_bool()).unwrap_or(false), "Paper должен быть рекомендован");
    assert_eq!(text(paper, "group"), "Оптимизированные");
    assert_eq!(paper.get("javaMin").and_then(|v| v.as_f64()), Some(21.0));
    let velocity = items.iter().find(|k| text(k, "id") == "velocity").unwrap();
    assert!(velocity.get("proxy").map(|v| v.as_bool()).unwrap_or(false));
}

#[test]
fn версии_берутся_из_источников() {
    let fake = Fake::start();
    let bases = fake.bases();

    /* PaperMC: неподдерживаемые версии не предлагаем */
    let paper = kernels::versions(&bases, "paper").expect("версии Paper");
    let ids: Vec<String> = paper.iter().map(|v| text(v, "id")).collect();
    assert_eq!(ids, vec!["1.20.4", "1.21.1"], "версии Paper: {:?}", ids);
    assert_eq!(paper[1].get("java").and_then(|v| v.as_f64()), Some(21.0));

    /* Purpur: новые сверху */
    let purpur = kernels::versions(&bases, "purpur").expect("версии Purpur");
    assert_eq!(text(&purpur[0], "id"), "1.20.4", "Purpur: {:?}", purpur.iter().map(|v| text(v, "id")).collect::<Vec<_>>());

    /* Fabric: только стабильные */
    let fabric = kernels::versions(&bases, "fabric").expect("версии Fabric");
    let fabric_ids: Vec<String> = fabric.iter().map(|v| text(v, "id")).collect();
    assert_eq!(fabric_ids, vec!["1.20.4", "1.21.1"]);
    assert!(!fabric_ids.iter().any(|id| id.contains("24w")), "снапшот попал в список");

    /* Vanilla: только релизы */
    let vanilla = kernels::versions(&bases, "vanilla").expect("версии Vanilla");
    assert_eq!(vanilla.len(), 1, "{:?}", vanilla.iter().map(|v| text(v, "id")).collect::<Vec<_>>());
    assert_eq!(text(&vanilla[0], "id"), "1.20.4");

    /* Forge: recommended важнее latest */
    let forge = kernels::versions(&bases, "forge").expect("версии Forge");
    let first = &forge[0];
    assert_eq!(text(first, "id"), "1.20.4");
    assert_eq!(text(first, "type"), "recommended");
    assert_eq!(text(first, "build"), "49.0.19");

    /* NeoForge: без beta */
    let neoforge = kernels::versions(&bases, "neoforge").expect("версии NeoForge");
    assert_eq!(neoforge.len(), 1, "{:?}", neoforge.iter().map(|v| text(v, "id")).collect::<Vec<_>>());
    assert_eq!(text(&neoforge[0], "id"), "21.1.9");

    /* неизвестное ядро — понятная ошибка */
    assert!(kernels::versions(&bases, "нет-такого").is_err());
}

#[test]
fn ссылка_на_сборку_стабильная() {
    let fake = Fake::start();
    let bases = fake.bases();

    let paper = kernels::resolve(&bases, "paper", "1.20.4").expect("ссылка Paper");
    assert!(paper.url.ends_with("/files/paper.jar"), "{}", paper.url);
    assert_eq!(paper.file_name, "paper-1.20.4-500.jar", "взята не стабильная сборка");
    assert_eq!(paper.build, "500");
    assert_eq!(paper.sha256, "ee");
    assert!(!paper.run_installer);

    let purpur = kernels::resolve(&bases, "purpur", "1.20.4").expect("ссылка Purpur");
    assert!(purpur.url.ends_with("/purpur/1.20.4/latest/download"));
    assert_eq!(purpur.file_name, "purpur-1.20.4.jar");

    let fabric = kernels::resolve(&bases, "fabric", "1.20.4").expect("ссылка Fabric");
    assert!(fabric.url.contains("/versions/loader/1.20.4/0.16.9/1.0.1/server/jar"), "{}", fabric.url);
    assert!(fabric.note.contains("0.16.9"));

    let vanilla = kernels::resolve(&bases, "vanilla", "1.20.4").expect("ссылка Vanilla");
    assert!(vanilla.url.ends_with("/files/server.jar"));
    assert_eq!(vanilla.sha1, "abc");
    assert_eq!(vanilla.size, 1234);

    let forge = kernels::resolve(&bases, "forge", "1.20.4").expect("ссылка Forge");
    assert!(forge.run_installer, "Forge ставится установщиком");
    assert!(forge.url.contains("forge-1.20.4-49.0.19-installer.jar"), "{}", forge.url);
    assert_eq!(forge.file_name, "forge-installer.jar");

    let neoforge = kernels::resolve(&bases, "neoforge", "21.1.9").expect("ссылка NeoForge");
    assert!(neoforge.url.ends_with("/neoforge/21.1.9/neoforge-21.1.9-installer.jar"), "{}", neoforge.url);
    assert!(neoforge.run_installer);
}

#[test]
fn файлы_нового_сервера_правильные() {
    /* server.properties: кириллица экранирована, порт и режим на месте */
    let props = kernels::server_properties(25565, "Мир «Кактус»", true, 20, "easy");
    assert!(props.contains("server-port=25565"));
    assert!(props.contains("motd=\\u041c\\u0438\\u0440"), "MOTD не экранирован: {props}");
    assert!(props.contains("online-mode=true"));
    assert!(props.contains("level-name=world"));

    /* скрипт запуска на Windows и на Linux */
    let (name, bat) = kernels::start_script("Мир", "paper.jar", "-Xmx4G", "java", false, true);
    assert_eq!(name, "start.bat");
    assert!(bat.starts_with("@echo off"), "{bat}");
    assert!(bat.contains("chcp 65001"), "без UTF-8 кириллица в окне ломается");
    assert!(bat.contains("-jar \"paper.jar\" nogui"), "{bat}");

    let (name, sh) = kernels::start_script("Мир", "paper.jar", "-Xmx4G", "java", false, false);
    assert_eq!(name, "start.sh");
    assert!(sh.starts_with("#!/bin/sh"));
    assert!(sh.contains("-jar \"paper.jar\" nogui"), "{sh}");

    /* у прокси нет «nogui» */
    let (_, proxy) = kernels::start_script("Прокси", "velocity.jar", "-Xmx1G", "java", true, false);
    assert!(!proxy.contains("nogui"), "{proxy}");

    /* путь с пробелами берётся в кавычки */
    assert_eq!(kernels::quote_exe("C:\\Program Files\\Java\\bin\\java.exe"), "\"C:\\Program Files\\Java\\bin\\java.exe\"");
    assert_eq!(kernels::quote_exe("java"), "java");

    /* версии Java */
    assert_eq!(kernels::java_major("21.0.5"), 21);
    assert_eq!(kernels::java_major("1.8.0_402"), 8);
    assert_eq!(kernels::java_major("17"), 17);

    /* папка сервера: без запрещённых символов */
    let suggested = kernels::suggest_dir("/tmp", "Мир: «Кактус»/2026");
    assert!(suggested.ends_with("Мир «Кактус»2026"), "папка: {suggested}");
    assert!(!suggested.contains(':'));
}

#[test]
fn сервер_создаётся_с_своей_ссылкой() {
    let fake = Fake::start();
    let bases = fake.bases();
    let dir = temp_dir("create");

    let opts = json::parse(&format!(
        r#"{{"kernel":"custom","customUrl":"{}/files/server.jar","dir":"{}","name":"Мир","port":25566,"motd":"Мой сервер","memoryMb":{{"min":512,"max":2048}}}}"#,
        fake.base(),
        dir.display().to_string().replace('\\', "\\\\")
    ))
    .unwrap();

    let mut stages: Vec<String> = Vec::new();
    let created = kernels::create_server(&bases, &opts, |stage, _text, _percent| {
        stages.push(stage.to_string());
    })
    .expect("сервер не создался");

    assert_eq!(created.jar, "server.jar");
    assert_eq!(created.stop_command, "stop");
    assert_eq!(created.tps_command, "tps");
    assert!(created.cwd.ends_with("create"));
    assert!(stages.contains(&"download".to_string()), "этапы: {:?}", stages);
    assert_eq!(stages.last().map(|s| s.as_str()), Some("done"));

    /* файлы на месте */
    let jar = dir.join("server.jar");
    assert!(jar.is_file(), "ядро не скачалось");
    assert_eq!(std::fs::read_to_string(&jar).unwrap(), "серверный jar");
    let eula = std::fs::read_to_string(dir.join("eula.txt")).unwrap();
    assert!(eula.contains("eula=true"));
    let props = std::fs::read_to_string(dir.join("server.properties")).unwrap();
    assert!(props.contains("server-port=25566"), "{props}");
    /* скрипт запуска: имя файла зависит от системы, но он обязан быть */
    let script = if cfg!(windows) { "start.bat" } else { "start.sh" };
    assert_eq!(created.command, script);
    let content = std::fs::read_to_string(dir.join(script)).unwrap();
    assert!(content.contains("-Xms512M"), "{content}");
    assert!(content.contains("-Xmx2048M"), "{content}");
    assert!(content.contains("aikars"), "флаги Aikar не попали в запуск");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn повторное_создание_не_качает_ядро_снова() {
    let fake = Fake::start();
    let bases = fake.bases();
    let dir = temp_dir("twice");
    let opts = json::parse(&format!(
        r#"{{"kernel":"custom","customUrl":"{}/files/server.jar","dir":"{}"}}"#,
        fake.base(),
        dir.display().to_string().replace('\\', "\\\\")
    ))
    .unwrap();
    kernels::create_server(&bases, &opts, |_, _, _| {}).expect("первый раз");
    let before = fake.urls().len();
    let mut said: Vec<String> = Vec::new();
    kernels::create_server(&bases, &opts, |_, text, _| said.push(text.to_string())).expect("второй раз");
    assert!(
        said.iter().any(|line| line.contains("уже есть")),
        "панель должна сказать, что файл уже скачан: {:?}",
        said
    );
    assert_eq!(fake.urls().len(), before, "ядро скачали повторно");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn мастер_работает_через_приложение() {
    let (app, panel_dir) = panel("channels");
    let target = temp_dir("channels-src");

    /* каталог и подсказка папки — без сети */
    let catalog = call(&app, "wizard:catalog", &[]);
    assert_eq!(catalog.as_arr().len(), 10, "{}", catalog.to_json());
    let suggested = call(&app, "wizard:suggestDir", &[Value::str(""), Value::str("Мир: Кактус")]);
    assert!(suggested.text().contains("Мир Кактус"), "{}", suggested.to_json());

    /* создание своего ядра по ссылке из локального сервера */
    let fake = Fake::start();
    let opts = json::parse(&format!(
        r#"{{"kernel":"custom","customUrl":"{}/files/server.jar","dir":"{}","name":"Через мастер"}}"#,
        fake.base(),
        target.display().to_string().replace('\\', "\\\\")
    ))
    .unwrap();
    let created = call(&app, "wizard:create", &[opts]);
    assert!(
        created.get("ok").map(|v| v.as_bool()).unwrap_or(false),
        "мастер не создал сервер: {}",
        created.to_json()
    );
    assert!(target.join("server.jar").is_file());
    assert!(target.join("eula.txt").is_file());

    /* без папки — понятная ошибка */
    let bad = call(&app, "wizard:create", &[json::parse(r#"{"kernel":"custom","customUrl":"https://x/y.jar"}"#).unwrap()]);
    assert!(!bad.get("ok").map(|v| v.as_bool()).unwrap_or(true));
    assert!(text(&bad, "error").contains("папка"), "{}", bad.to_json());

    /* Java в системе: список есть всегда, даже если её нет */
    let java = call(&app, "wizard:java", &[]);
    assert!(java.as_arr().is_empty() || java.as_arr().iter().all(|j| j.get("major").is_some()));

    let _ = std::fs::remove_dir_all(&panel_dir);
    let _ = std::fs::remove_dir_all(&target);
}
