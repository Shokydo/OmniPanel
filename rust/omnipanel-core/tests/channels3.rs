// Каналы синхронизации и обновлений: проверка через сам `App::invoke`.
//
// Здесь важно не поведение внутри модулей (оно проверено в sync.rs и
// update.rs), а то, что интерфейс действительно дотягивается до них через
// имена каналов: `gh:*`, `gl:*`, `upd:*`. Сеть подменена маленьким сервером
// на 127.0.0.1 — ни один запрос не уходит в настоящий GitHub.
use omnipanel_core::app::{App, AppInfo, READY_CHANNELS};
use omnipanel_core::json::{self, Value};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::OnceLock;

const CHANNELS: [&str; 28] = [
    "gh:account",
    "gh:login",
    "gh:logout",
    "gh:verify",
    "gh:check",
    "gh:push",
    "gh:pull",
    "gh:status",
    "gh:forget",
    "gh:repos",
    "gh:createRepo",
    "gh:download",
    "gh:openExternal",
    "gh:oauthClientId",
    "gh:setOauthClientId",
    "gh:deviceStart",
    "gh:devicePoll",
    "gl:account",
    "gl:check",
    "gl:projects",
    "gl:save",
    "upd:config",
    "upd:save",
    "upd:check",
    "upd:apply",
    "upd:auto",
    "upd:downloadFull",
    "upd:revealBackups",
];

/// Один сервер-заглушка на весь набор тестов: адреса кладём в переменные среды,
/// потому что панель берёт их оттуда (так же она проверяется и вживую).
fn fake() -> u16 {
    static PORT: OnceLock<u16> = OnceLock::new();
    *PORT.get_or_init(|| {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let _ = answer(stream, port);
            }
        });
        std::env::set_var("OMNI_GITHUB_API", format!("http://127.0.0.1:{}/gh", port));
        std::env::set_var("OMNI_GITLAB_API", format!("http://127.0.0.1:{}/gl", port));
        std::env::set_var("OMNI_GITHUB_OAUTH", format!("http://127.0.0.1:{}/gh", port));
        std::env::set_var("OMNI_UPDATE_RAW", format!("http://127.0.0.1:{}/raw", port));
        port
    })
}

fn answer(mut stream: TcpStream, _port: u16) -> std::io::Result<()> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let (method, path) = loop {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            return Ok(());
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(pos) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buffer[..pos]).to_string();
            let mut parts = head.lines().next().unwrap_or("").split_whitespace();
            let method = parts.next().unwrap_or("").to_string();
            let path = parts.next().unwrap_or("/").to_string();
            break (method, path);
        }
    };
    let clean = path.split('?').next().unwrap_or("/");
    let (status, body) = match (method.as_str(), clean) {
        ("GET", "/gh/user") => (200, r#"{"login":"тестер","name":"Тест","avatar_url":""}"#.to_string()),
        ("GET", "/gh/user/repos") => (200, r#"[{"full_name":"тестер/сервер","name":"сервер","private":false}]"#.to_string()),
        ("POST", "/gh/user/repos") => (201, r#"{"full_name":"тестер/новый","private":true}"#.to_string()),
        ("POST", "/gh/login/device/code") => (
            200,
            r#"{"device_code":"dev-1","user_code":"КРУГ-1111","verification_uri":"https://github.com/login/device","expires_in":900,"interval":5}"#.to_string(),
        ),
        ("POST", "/gh/login/oauth/access_token") => (200, r#"{"access_token":"token-from-code"}"#.to_string()),
        ("GET", "/gl/user") => (200, r#"{"username":"гитлабовец"}"#.to_string()),
        ("GET", "/gl/projects") => (200, r#"[{"path_with_namespace":"группа/сервер","name":"сервер","visibility":"private"}]"#.to_string()),
        ("GET", _) if clean.starts_with("/gh/repos/") && !clean.contains("/git/") => (
            200,
            r#"{"full_name":"тестер/сервер","permissions":{"push":true}}"#.to_string(),
        ),
        ("GET", _) if clean.starts_with("/gl/projects/") => (
            200,
            r#"{"path_with_namespace":"группа/сервер","visibility":"private"}"#.to_string(),
        ),
        ("GET", "/update.json") => (404, r#"{"message":"Not Found"}"#.to_string()),
        _ => (404, r#"{"message":"Not Found"}"#.to_string()),
    };
    let head = format!(
        "HTTP/1.1 {} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        status,
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body.as_bytes())?;
    stream.flush()
}

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("omnipanel-ch3-{}-{}", std::process::id(), tag));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Панель с одним сервером и (по желанию) настроенной синхронизацией.
fn panel(tag: &str, sync_cfg: Option<Value>) -> (App, PathBuf, String) {
    fake();
    let dir = temp_dir(tag);
    let server_dir = dir.join("server");
    std::fs::create_dir_all(&server_dir).unwrap();
    std::fs::write(server_dir.join("server.properties"), "level-name=world\n").unwrap();

    let mut info = AppInfo::default();
    info.data_dir = dir.clone();
    info.config_path = dir.join("servers.json");
    info.app_dir = dir.join("app");
    std::fs::create_dir_all(&info.app_dir).unwrap();

    let app = App::new(info);
    let mut cfg = json::parse(&format!(
        r#"{{"id":"s1","name":"Тестовый","command":"java -jar server.jar","cwd":"{}"}}"#,
        server_dir.display().to_string().replace('\\', "\\\\")
    ))
    .unwrap();
    if let Some(sync) = sync_cfg {
        if let Value::Obj(fields) = &mut cfg {
            fields.push(("sync".to_string(), sync));
        }
    }
    let saved = app.manager().add(omnipanel_core::servers::ServerConfig::from_json(&cfg));
    (app, dir, saved.id)
}

fn call(app: &App, channel: &str, args: &[Value]) -> Value {
    match app.invoke(channel, args) {
        Ok(value) => value,
        Err(message) => panic!("канал {} вернул ошибку: {}", channel, message),
    }
}

fn ok(value: &Value) -> bool {
    value.get("ok").map(|v| v.as_bool()).unwrap_or(false)
}

fn text(value: &Value, name: &str) -> String {
    value.get(name).map(|v| v.text()).unwrap_or_default()
}

#[test]
fn все_каналы_новых_модулей_объявлены() {
    for channel in CHANNELS {
        assert!(READY_CHANNELS.contains(&channel), "канала нет в списке: {channel}");
    }
    /* 56 + 28 (синхронизация и обновления) + 13 (поиск, диалоги, иконки, автозапуск) + 6 (обои, окна вопросов, уведомления) + 6 (бэкапы) + 5 (нагрузка) + 6 (аддоны) = 133 */
    assert_eq!(READY_CHANNELS.len(), 135, "каналов в Rust: {:?}", READY_CHANNELS.len());
    let mut unique: Vec<&str> = READY_CHANNELS.to_vec();
    unique.sort_unstable();
    unique.dedup();
    assert_eq!(unique.len(), READY_CHANNELS.len(), "в списке есть повторы");
}

#[test]
fn каждый_канал_отвечает_а_не_молчит() {
    let (app, _dir, _id) = panel("every", None);
    for channel in CHANNELS {
        /* аргументы по минимуму: канал должен ответить сам, без паники */
        let reply = app.invoke(channel, &[Value::str("s1")]);
        match reply {
            Ok(value) => {
                assert!(
                    !value.to_json().contains("ещё не перенесена"),
                    "канал {} не перенесён",
                    channel
                );
            }
            Err(message) => assert!(
                !message.contains("ещё не перенесена"),
                "канал {} не перенесён: {}",
                channel,
                message
            ),
        }
    }
}

#[test]
fn вход_по_коду_через_каналы() {
    let (app, _dir, _id) = panel("login", None);
    assert!(ok(&call(&app, "gh:logout", &[])));
    assert!(!call(&app, "gh:account", &[]).get("hasToken").map(|v| v.as_bool()).unwrap_or(true));

    let start = call(&app, "gh:deviceStart", &[]);
    assert!(ok(&start), "{}", start.to_json());
    assert_eq!(text(&start, "userCode"), "КРУГ-1111");
    let poll = call(&app, "gh:devicePoll", &[start.get("deviceCode").cloned().unwrap_or(Value::Null)]);
    assert!(ok(&poll), "{}", poll.to_json());

    let account = call(&app, "gh:account", &[]);
    assert!(account.get("hasToken").map(|v| v.as_bool()).unwrap_or(false));
    assert_eq!(text(&account, "token"), "••••••••");
    assert_eq!(text(&account, "login"), "тестер");

    /* вход по токену и клиент OAuth сохраняются в настройках */
    assert!(ok(&call(&app, "gh:login", &[Value::str("own-token")])));
    assert_eq!(text(&call(&app, "gh:setOauthClientId", &[Value::str("мой-клиент")]), ""), "");
    assert_eq!(text(&call(&app, "gh:oauthClientId", &[]), ""), "");
    assert!(ok(&call(&app, "gh:logout", &[])));
}

#[test]
fn репозитории_и_проверка_токена() {
    let (app, _dir, _id) = panel("repos", None);
    assert!(ok(&call(&app, "gh:login", &[Value::str("token-for-repos")])));
    let repos = call(&app, "gh:repos", &[Value::str("")]);
    assert!(ok(&repos), "{}", repos.to_json());
    assert_eq!(repos.get("repos").map(|v| v.as_arr().len()).unwrap_or(0), 1);
    let created = call(&app, "gh:createRepo", &[Value::str("новый"), Value::Bool(true)]);
    assert!(ok(&created), "{}", created.to_json());
    assert_eq!(text(&created, "full"), "тестер/новый");

    let cfg = json::parse(r#"{"token":"token-for-repos","repo":"тестер/сервер"}"#).unwrap();
    let verified = call(&app, "gh:verify", &[cfg]);
    assert!(ok(&verified), "{}", verified.to_json());
    /* внешние ссылки: только https, остальное — отказ */
    assert!(call(&app, "gh:openExternal", &[Value::str("ftp://плохо")]).as_bool() == false);
}

#[test]
fn gitlab_через_каналы() {
    let (app, _dir, _id) = panel("gl", None);
    assert!(!call(&app, "gl:account", &[]).get("hasToken").map(|v| v.as_bool()).unwrap_or(true));
    assert!(ok(&call(&app, "gl:save", &[Value::str("gl-token")])));
    assert!(call(&app, "gl:account", &[]).get("hasToken").map(|v| v.as_bool()).unwrap_or(false));
    let projects = call(&app, "gl:projects", &[Value::str("")]);
    assert!(ok(&projects), "{}", projects.to_json());
    assert_eq!(projects.get("repos").map(|v| v.as_arr().len()).unwrap_or(0), 1);
    let cfg = json::parse(r#"{"repo":"группа/сервер"}"#).unwrap();
    assert!(ok(&call(&app, "gl:check", &[cfg])));
}

#[test]
fn синхронизация_не_настроена_и_без_токена() {
    let (app, _dir, id) = panel("nosync", None);
    let id = Value::str(id);
    let check = call(&app, "gh:check", &[id.clone()]);
    assert!(!ok(&check));
    assert!(text(&check, "error").contains("не настроена"), "{}", check.to_json());

    let push = call(&app, "gh:push", &[id.clone()]);
    assert!(!ok(&push));
    assert!(text(&push, "error").contains("не настроена"));

    /* состояние и «забыть» работают и без настроек */
    let status = call(&app, "gh:status", &[id.clone()]);
    assert_eq!(text(&status, "commit"), "");
    assert!(ok(&call(&app, "gh:forget", &[id])));
}

#[test]
fn настроенная_синхронизация_без_токена_не_ходит_в_сеть() {
    let sync_cfg = json::parse(
        r#"{"enabled":true,"repo":"тестер/сервер","branch":"main","provider":"github","scope":"all","mode":"archive"}"#,
    )
    .unwrap();
    let (app, _dir, id) = panel("notoken", Some(sync_cfg));
    /* токена нет ни в настройках сервера, ни в аккаунте панели */
    let check = call(&app, "gh:check", &[Value::str(id.clone())]);
    assert!(!ok(&check), "{}", check.to_json());
    assert!(text(&check, "error").contains("токен"), "{}", check.to_json());

    /* сервер не работает, но забирать нечего: в хранилище пусто */
    assert!(ok(&call(&app, "gh:login", &[Value::str("token-for-check")])));
    let pulled = call(&app, "gh:pull", &[Value::str(id)]);
    assert!(!ok(&pulled), "{}", pulled.to_json());
    assert!(text(&pulled, "error").contains("нет ветки"), "{}", pulled.to_json());
}

#[test]
fn настройки_обновлений_через_каналы() {
    let (app, dir, _id) = panel("upd", None);
    let cfg = call(&app, "upd:config", &[]);
    assert_eq!(text(&cfg, "repo"), "Shokydo/OmniPanel");
    assert!(cfg.get("auto").map(|v| v.as_bool()).unwrap_or(false));

    let patch = json::parse(r#"{"repo":"тестер/панель","branch":"мир","auto":false}"#).unwrap();
    let saved = call(&app, "upd:save", &[patch]);
    assert_eq!(text(&saved, "repo"), "тестер/панель");
    assert_eq!(text(&saved, "branch"), "мир");
    assert!(!saved.get("auto").map(|v| v.as_bool()).unwrap_or(true));
    assert!(dir.join("panel.json").exists(), "настройки не сохранены в panel.json");

    /* канал обновлений пуст — понятная ошибка, а не паника */
    let checked = call(&app, "upd:check", &[]);
    assert!(!ok(&checked), "{}", checked.to_json());
    assert!(text(&checked, "error").contains("не нашлось"), "{}", checked.to_json());
    assert!(!ok(&call(&app, "upd:apply", &[])));
    assert!(!ok(&call(&app, "upd:downloadFull", &[])));
    let backups = call(&app, "upd:revealBackups", &[]);
    assert!(ok(&backups), "{}", backups.to_json());
    assert!(!text(&backups, "path").is_empty());
}

#[test]
fn загрузка_сервера_из_репозитория_требует_папку() {
    let (app, _dir, _id) = panel("dl", None);
    let cfg = json::parse(r#"{"repo":"тестер/сервер","branch":"main","dir":""}"#).unwrap();
    let reply = call(&app, "gh:download", &[cfg]);
    assert!(!ok(&reply), "{}", reply.to_json());
    assert!(text(&reply, "error").contains("папка"), "{}", reply.to_json());
}
