// Обновления панели: проверка канала и установка кода.
//
// Сервер тот же приём, что и в тестах синхронизации: маленький HTTP-сервер
// на 127.0.0.1, который отдаёт `update.json`, релиз и архив кода. Проверяется
// главное правило — код ставится сам и никогда не трогает данные серверов,
// а архив с неверной суммой не распаковывается вообще.
use omnipanel_core::b64;
use omnipanel_core::http::percent_decode;
use omnipanel_core::json;
use omnipanel_core::sha256;
use omnipanel_core::update::{self, Updater};
use omnipanel_core::zip;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

struct Fake {
    port: u16,
    files: Arc<Mutex<Vec<(String, Vec<u8>)>>>,
}

impl Fake {
    fn start(files: Vec<(&str, Vec<u8>)>) -> Fake {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let store: Arc<Mutex<Vec<(String, Vec<u8>)>>> = Arc::new(Mutex::new(
            files.into_iter().map(|(name, data)| (name.to_string(), data)).collect(),
        ));
        let shared = Arc::clone(&store);
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let _ = serve(stream, &shared);
            }
        });
        Fake { port, files: store }
    }

    fn raw(&self) -> String {
        format!("http://127.0.0.1:{}/raw", self.port)
    }

    fn api(&self) -> String {
        format!("http://127.0.0.1:{}/api", self.port)
    }

    fn put(&self, name: &str, data: Vec<u8>) {
        let mut files = self.files.lock().unwrap();
        match files.iter_mut().find(|(key, _)| key == name) {
            Some(slot) => slot.1 = data,
            None => files.push((name.to_string(), data)),
        }
    }
}

fn serve(mut stream: TcpStream, files: &Arc<Mutex<Vec<(String, Vec<u8>)>>>) -> std::io::Result<()> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            return Ok(());
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(pos) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buffer[..pos]).to_string();
            break_ready(&head, &mut stream, files)?;
            return Ok(());
        }
    }
}

fn break_ready(head: &str, stream: &mut TcpStream, files: &Arc<Mutex<Vec<(String, Vec<u8>)>>>) -> std::io::Result<()> {
    let first = head.lines().next().unwrap_or("");
    let path = first.split_whitespace().nth(1).unwrap_or("/");
    let clean = percent_decode(path.split('?').next().unwrap_or("/"));
    let store = files.lock().unwrap();
    let body = store
        .iter()
        .find(|(name, _)| clean == format!("/{}", name) || clean.ends_with(&format!("/{}", name)))
        .map(|(_, data)| data.clone());
    let (status, payload) = match body {
        Some(data) => (200u16, data),
        None => (404, "{\"message\":\"Not Found\"}".as_bytes().to_vec()),
    };
    let head = format!(
        "HTTP/1.1 {} OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        status,
        payload.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(&payload)?;
    stream.flush()
}

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("omnipanel-update-{}-{}", std::process::id(), tag));
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

/// Архив кода панели, какой его выкладывает сборка.
fn code_zip(main_js: &str) -> Vec<u8> {
    zip::create(&[
        zip::NewEntry { name: "main.js".into(), data: main_js.as_bytes().to_vec() },
        zip::NewEntry { name: "package.json".into(), data: b"{\"version\":\"1.27.0\"}".to_vec() },
        zip::NewEntry { name: "ui/index.html".into(), data: b"<title>OmniPanel</title>".to_vec() },
        zip::NewEntry { name: "ui/app.js".into(), data: b"console.log('ok')".to_vec() },
        /* в архиве «случайно» оказались данные серверов — их ставить нельзя */
        zip::NewEntry { name: "OmniPanelData/servers.json".into(), data: "[{\"чужой\":true}]".as_bytes().to_vec() },
    ])
}

fn app_dir(tag: &str) -> PathBuf {
    let dir = temp_dir(tag);
    write(&dir, "main.js", "старая версия");
    write(&dir, "package.json", "{\"version\":\"1.26.0\"}");
    write(&dir, "ui/index.html", "старый интерфейс");
    write(&dir, "ui/app.js", "старый скрипт");
    write(&dir, "OmniPanelData/servers.json", "{\"мои\":\"серверы\"}");
    write(&dir, "OmniPanelData/panel.json", "{\"тема\":\"чёрная\"}");
    dir
}

fn manifest(version: &str, sha: &str) -> Vec<u8> {
    format!(
        r#"{{"version":"{}","notes":"правки","code":{{"file":"OmniPanel-code.zip","size":0,"sha256":"{}"}}}}"#,
        version, sha
    )
    .into_bytes()
}

fn ok(value: &json::Value) -> bool {
    value.get("ok").map(|v| v.as_bool()).unwrap_or(false)
}

fn text(value: &json::Value, name: &str) -> String {
    value.get(name).map(|v| v.text()).unwrap_or_default()
}

#[test]
fn сравнение_версий() {
    assert_eq!(update::parse_version("1.10.0"), [1, 10, 0]);
    assert_eq!(update::parse_version("v2.0"), [2, 0, 0]);
    assert_eq!(update::parse_version("мусор"), [0, 0, 0]);
    assert_eq!(update::compare_versions("1.27.0", "1.26.0"), 1);
    assert_eq!(update::compare_versions("1.26.0", "1.26.0"), 0);
    assert_eq!(update::compare_versions("1.9.0", "1.10.0"), -1);
}

#[test]
fn проверка_находит_новую_версию() {
    let archive = code_zip("новая версия");
    let files = vec![
        ("Shokydo/OmniPanel/main/update.json", manifest("1.27.0", &sha256::hex(&archive))),
        ("Shokydo/OmniPanel/main/OmniPanel-code.zip", archive),
    ];
    let fake = Fake::start(files);
    let data = temp_dir("upd-data");
    let app = app_dir("upd-app");
    let updater = Updater::with_bases(&data, &app, "1.26.0", &fake.raw(), &fake.api());
    let checked = updater.check();
    assert!(ok(&checked), "{}", checked.to_json());
    assert_eq!(text(&checked, "latest"), "1.27.0");
    assert!(checked.get("hasUpdate").map(|v| v.as_bool()).unwrap_or(false));
    assert_eq!(text(&checked, "source"), "файл update.json");
    assert!(text(&checked, "code").contains("OmniPanel-code.zip"), "{}", checked.to_json());
}

#[test]
fn без_новой_версии_обновления_нет() {
    let files = vec![("Shokydo/OmniPanel/main/update.json", manifest("1.26.0", ""))];
    let fake = Fake::start(files);
    let updater = Updater::with_bases(&temp_dir("upd-same"), &app_dir("upd-same-app"), "1.26.0", &fake.raw(), &fake.api());
    let checked = updater.check();
    assert!(ok(&checked), "{}", checked.to_json());
    assert!(!checked.get("hasUpdate").map(|v| v.as_bool()).unwrap_or(true), "лишнее обновление");
}

#[test]
fn релиз_новее_файла_update_json() {
    let release = r#"{"tag_name":"v1.28.0","body":"полная сборка","assets":[
        {"name":"OmniPanel-win64.zip","browser_download_url":"http://example/win64.zip","size":1000},
        {"name":"OmniPanel-Установка-1.28.0.exe","browser_download_url":"http://example/setup.exe","size":2000}
    ]}"#.as_bytes().to_vec();
    let files = vec![
        ("Shokydo/OmniPanel/main/update.json", manifest("1.27.0", "")),
        ("api/repos/Shokydo/OmniPanel/releases/latest", release),
    ];
    let fake = Fake::start(files);
    let updater = Updater::with_bases(&temp_dir("upd-rel"), &app_dir("upd-rel-app"), "1.26.0", &fake.raw(), &fake.api());
    let checked = updater.check();
    assert!(ok(&checked), "{}", checked.to_json());
    assert_eq!(text(&checked, "latest"), "1.28.0");
    assert!(text(&checked, "source").contains("1.28.0"));
    assert!(text(&checked, "setup").contains("setup.exe"), "установщик не найден: {}", checked.to_json());
    assert!(text(&checked, "full").contains("win64.zip"));
}

#[test]
fn настройки_канала_сохраняются() {
    let fake = Fake::start(Vec::new());
    let data = temp_dir("upd-cfg");
    let app = app_dir("upd-cfg-app");
    let updater = Updater::with_bases(&data, &app, "1.26.0", &fake.raw(), &fake.api());
    let cfg = updater.config();
    assert_eq!(text(&cfg, "repo"), "Shokydo/OmniPanel");
    assert_eq!(text(&cfg, "branch"), "main");
    assert!(cfg.get("auto").map(|v| v.as_bool()).unwrap_or(false));
    assert!(cfg.get("autoInstall").map(|v| v.as_bool()).unwrap_or(false));

    let patch = json::parse(r#"{"repo":"https://github.com/тестер/панель","branch":"мир","autoInstall":false}"#).unwrap();
    let saved = updater.save(&patch);
    assert_eq!(text(&saved, "repo"), "тестер/панель");
    assert_eq!(text(&saved, "branch"), "мир");
    assert!(!saved.get("autoInstall").map(|v| v.as_bool()).unwrap_or(true));
    /* файл настроек общий с панелью: panel.json */
    let stored = std::fs::read_to_string(data.join("panel.json")).unwrap();
    assert!(stored.contains("updateRepo"));
}

#[test]
fn установка_кода_не_трогает_данные_серверов() {
    let archive = code_zip("новая версия панели");
    let files = vec![
        ("Shokydo/OmniPanel/main/update.json", manifest("1.27.0", &sha256::hex(&archive))),
        ("Shokydo/OmniPanel/main/OmniPanel-code.zip", archive.clone()),
    ];
    let fake = Fake::start(files);
    let data = temp_dir("upd-apply-data");
    let app = app_dir("upd-apply-app");
    let updater = Updater::with_bases(&data, &app, "1.26.0", &fake.raw(), &fake.api());
    let applied = updater.apply();
    assert!(ok(&applied), "{}", applied.to_json());
    assert_eq!(text(&applied, "version"), "1.27.0");

    assert_eq!(std::fs::read_to_string(app.join("main.js")).unwrap(), "новая версия панели");
    assert_eq!(std::fs::read_to_string(app.join("ui").join("index.html")).unwrap(), "<title>OmniPanel</title>");
    /* данные серверов остались своими */
    assert_eq!(
        std::fs::read_to_string(app.join("OmniPanelData").join("servers.json")).unwrap(),
        "{\"мои\":\"серверы\"}"
    );
    assert_eq!(
        std::fs::read_to_string(app.join("OmniPanelData").join("panel.json")).unwrap(),
        "{\"тема\":\"чёрная\"}"
    );
    /* копия старых файлов и список установленного на месте */
    let backup = PathBuf::from(text(&applied, "backup"));
    assert!(backup.join("main.js").exists(), "нет копии старых файлов");
    assert!(app.join("update-installed.json").exists(), "нет списка установленного");
    let installed = std::fs::read_to_string(app.join("update-installed.json")).unwrap();
    assert!(installed.contains("ui/app.js"));
    assert!(!installed.contains("OmniPanelData"), "данные серверов попали в список кода");
}

#[test]
fn битая_сумма_не_ставится() {
    let archive = code_zip("подмена");
    let files = vec![
        ("Shokydo/OmniPanel/main/update.json", manifest("1.27.0", "неверная-сумма")),
        ("Shokydo/OmniPanel/main/OmniPanel-code.zip", archive),
    ];
    let fake = Fake::start(files);
    let data = temp_dir("upd-broken-data");
    let app = app_dir("upd-broken-app");
    let updater = Updater::with_bases(&data, &app, "1.26.0", &fake.raw(), &fake.api());
    let applied = updater.apply();
    assert!(!ok(&applied), "битый архив поставили: {}", applied.to_json());
    assert!(text(&applied, "error").contains("Контрольная сумма"), "{}", applied.to_json());
    assert_eq!(std::fs::read_to_string(app.join("main.js")).unwrap(), "старая версия");
}

#[test]
fn автообновление_ждёт_остановки_серверов() {
    let archive = code_zip("новая версия панели");
    let files = vec![
        ("Shokydo/OmniPanel/main/update.json", manifest("1.27.0", &sha256::hex(&archive))),
        ("Shokydo/OmniPanel/main/OmniPanel-code.zip", archive),
    ];
    let fake = Fake::start(files);
    let data = temp_dir("upd-auto-data");
    let app = app_dir("upd-auto-app");
    let updater = Updater::with_bases(&data, &app, "1.26.0", &fake.raw(), &fake.api());

    /* сервер работает — обновление откладывается, файлы не тронуты */
    let waiting = updater.auto(true);
    assert!(waiting.get("deferred").map(|v| v.as_bool()).unwrap_or(false), "{}", waiting.to_json());
    assert_eq!(std::fs::read_to_string(app.join("main.js")).unwrap(), "старая версия");

    /* серверы стоят — код ставится */
    let applied = updater.auto(false);
    assert!(ok(&applied), "{}", applied.to_json());
    assert_eq!(std::fs::read_to_string(app.join("main.js")).unwrap(), "новая версия панели");
}

#[test]
fn полная_сборка_скачивается() {
    let data = vec![7u8; 4096];
    let release = format!(
        r#"{{"tag_name":"v1.28.0","body":"","assets":[
            {{"name":"OmniPanel-win64.zip","browser_download_url":"http://127.0.0.1:PORT/dl/OmniPanel-win64.zip","size":4096}}
        ]}}"#
    );
    let fake = Fake::start(vec![
        ("Shokydo/OmniPanel/main/update.json", manifest("1.27.0", "")),
        ("api/repos/Shokydo/OmniPanel/releases/latest", b"".to_vec()),
        ("dl/OmniPanel-win64.zip", data.clone()),
    ]);
    fake.put("api/repos/Shokydo/OmniPanel/releases/latest", release.replace("PORT", &fake.port.to_string()).into_bytes());
    let updater = Updater::with_bases(&temp_dir("upd-full-data"), &app_dir("upd-full-app"), "1.26.0", &fake.raw(), &fake.api());
    let result = updater.download_full();
    assert!(ok(&result), "{}", result.to_json());
    let file = PathBuf::from(text(&result, "file"));
    assert!(file.exists(), "файл не скачался");
    assert_eq!(std::fs::read(&file).unwrap(), data);
}

#[test]
fn служебные_пути_защищены() {
    assert!(update::is_protected("OmniPanelData/servers.json"));
    assert!(update::is_protected("data/panel.json"));
    assert!(update::is_protected("servers.json"));
    assert!(!update::is_protected("ui/app.js"));
    assert!(!update::is_protected("core/github.js"));
    /* base64 нужен сборке обновлений — проверяем, что модуль под рукой */
    assert_eq!(b64::encode(b"ok"), "b2s=");
}

#[test]
fn без_установщика_в_релизе_понятная_ошибка() {
    /* в релизе только архив кода: обновляться установщиком нечем — говорим прямо,
       а не молчим, как раньше молчала кнопка «Обновить и перезапустить» */
    let release = r#"{"tag_name":"v1.28.0","body":"","assets":[
        {"name":"OmniPanel-code.zip","browser_download_url":"http://example/code.zip","size":100}
    ]}"#.as_bytes().to_vec();
    let files = vec![("api/repos/Shokydo/OmniPanel/releases/latest", release)];
    let fake = Fake::start(files);
    let updater = Updater::with_bases(&temp_dir("upd-nosetup"), &app_dir("upd-nosetup-app"), "1.27.0", &fake.raw(), &fake.api());
    let result = updater.apply_setup();
    assert!(!ok(&result), "должна быть ошибка: {}", result.to_json());
    assert!(text(&result, "error").contains("установщик"), "{}", result.to_json());
}

#[test]
fn когда_версия_свежая_установка_не_начинается() {
    let release = r#"{"tag_name":"v1.27.0","body":"","assets":[
        {"name":"OmniPanel-Setup-1.27.0.exe","browser_download_url":"http://example/s.exe","size":100}
    ]}"#.as_bytes().to_vec();
    let files = vec![("api/repos/Shokydo/OmniPanel/releases/latest", release)];
    let fake = Fake::start(files);
    let updater = Updater::with_bases(&temp_dir("upd-fresh"), &app_dir("upd-fresh-app"), "1.27.0", &fake.raw(), &fake.api());
    let result = updater.apply_setup();
    assert!(!ok(&result), "{}", result.to_json());
    assert!(text(&result, "error").contains("самая свежая"), "{}", result.to_json());
}

#[test]
fn установщик_не_скачался_и_это_видно() {
    let release = r#"{"tag_name":"v1.28.0","body":"","assets":[
        {"name":"OmniPanel-Setup-1.28.0.exe","browser_download_url":"http://127.0.0.1:1/нет.exe","size":100}
    ]}"#.as_bytes().to_vec();
    let files = vec![("api/repos/Shokydo/OmniPanel/releases/latest", release)];
    let fake = Fake::start(files);
    let updater = Updater::with_bases(&temp_dir("upd-badurl"), &app_dir("upd-badurl-app"), "1.27.0", &fake.raw(), &fake.api());
    let result = updater.apply_setup();
    assert!(!ok(&result), "обновление не должно «получиться»: {}", result.to_json());
    assert!(!text(&result, "error").is_empty());
}

/* ───────── тихая проверка: панель сама узнаёт о новой версии ───────── */

#[test]
fn тихая_проверка_сама_сообщает_окну_о_новой_версии() {
    /* Раньше проверку запускал только человек кнопкой в настройках: ядро
       ни разу не спрашивало GitHub само и не отправляло ни одного события,
       поэтому плашка «доступно обновление» не появлялась никогда. */
    let fake = Fake::start(vec![(
        "Shokydo/OmniPanel/main/update.json",
        r#"{"version":"1.38.0","notes":"тихая проверка"}"#.as_bytes().to_vec(),
    )]);
    let updater = Updater::with_bases(
        &temp_dir("upd-auto-silent"),
        &app_dir("upd-auto-silent-app"),
        "1.37.0",
        &fake.raw(),
        &fake.api(),
    );

    let events: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&events);
    let result = updater.auto_announce(false, move |channel, payload| {
        sink.lock().unwrap().push((channel.to_string(), payload.get("latest").map(|v| v.text()).unwrap_or_default()));
    });

    assert!(ok(&result), "{}", result.to_json());
    assert!(result.get("hasUpdate").map(|v| v.as_bool()).unwrap_or(false), "{}", result.to_json());
    let seen = events.lock().unwrap().clone();
    let names: Vec<&str> = seen.iter().map(|(name, _)| name.as_str()).collect();
    assert!(names.contains(&"upd:state"), "окно не узнало о проверке: {:?}", names);
    assert!(names.contains(&"upd:available"), "нет плашки «доступно обновление»: {:?}", names);
    assert!(seen.iter().any(|(name, latest)| name == "upd:available" && latest == "1.38.0"));
}

#[test]
fn тихая_проверка_выключена_и_молчит() {
    let fake = Fake::start(vec![(
        "Shokydo/OmniPanel/main/update.json",
        r#"{"version":"1.38.0"}"#.as_bytes().to_vec(),
    )]);
    let data = temp_dir("upd-auto-off");
    let updater = Updater::with_bases(&data, &app_dir("upd-auto-off-app"), "1.37.0", &fake.raw(), &fake.api());
    updater.save(&json::Value::obj(vec![("auto", json::Value::Bool(false))]));

    let events: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&events);
    let result = updater.auto_announce(false, move |channel, _| {
        sink.lock().unwrap().push(channel.to_string());
    });

    assert!(result.get("skipped").map(|v| v.as_bool()).unwrap_or(false), "{}", result.to_json());
    assert!(events.lock().unwrap().is_empty(), "выключенная проверка не должна ничего слать");
}

#[test]
fn новая_сборка_без_архива_кода_сама_не_ставится() {
    /* В сборке с установщиком релиз несёт только его. Запускать установщик
       молча нельзя — панель перезапустится без спроса. Ждём плашку, а ставит
       человек кнопкой «Обновить и перезапустить». */
    let release = r#"{"tag_name":"v1.38.0","body":"","assets":[
        {"name":"OmniPanel-Setup-1.38.0.exe","browser_download_url":"http://127.0.0.1:1/s.exe","size":100}
    ]}"#.as_bytes().to_vec();
    let fake = Fake::start(vec![("api/repos/Shokydo/OmniPanel/releases/latest", release)]);
    let updater = Updater::with_bases(
        &temp_dir("upd-auto-setup"),
        &app_dir("upd-auto-setup-app"),
        "1.37.0",
        &fake.raw(),
        &fake.api(),
    );

    let events: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&events);
    let result = updater.auto_announce(false, move |channel, _| {
        sink.lock().unwrap().push(channel.to_string());
    });

    assert!(result.get("hasUpdate").map(|v| v.as_bool()).unwrap_or(false), "{}", result.to_json());
    let names = events.lock().unwrap().clone();
    assert!(names.iter().any(|n| n == "upd:available"), "{:?}", names);
    assert!(!names.iter().any(|n| n == "upd:ready"), "установщик запустился сам: {:?}", names);
}

#[test]
fn тихая_проверка_не_мешает_работающим_серверам() {
    /* Есть архив кода и автоустановка включена, но сервер работает —
       обновление ждёт, файлы панели не трогаем. */
    let archive = code_zip("новая версия панели");
    let files = vec![
        ("Shokydo/OmniPanel/main/update.json", manifest("1.38.0", &sha256::hex(&archive))),
        ("Shokydo/OmniPanel/main/OmniPanel-code.zip", archive),
    ];
    let fake = Fake::start(files);
    let app = app_dir("upd-auto-busy-app");
    let updater = Updater::with_bases(&temp_dir("upd-auto-busy"), &app, "1.37.0", &fake.raw(), &fake.api());

    let events: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&events);
    let waiting = updater.auto_announce(true, move |channel, _| {
        sink.lock().unwrap().push(channel.to_string());
    });

    assert!(waiting.get("deferred").map(|v| v.as_bool()).unwrap_or(false), "{}", waiting.to_json());
    assert_eq!(std::fs::read_to_string(app.join("main.js")).unwrap(), "старая версия");
    assert!(events.lock().unwrap().iter().any(|n| n == "upd:ready"));
}
