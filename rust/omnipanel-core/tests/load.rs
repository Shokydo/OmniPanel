/*!
 * Нагрузочный тест через каналы панели: `load:*`.
 *
 * Проверяем то, что видит интерфейс: настройки теста берутся из сервера,
 * границы не дают сломать панель, тест поднимает ботов, шлёт события
 * `load:log`, `load:change`, `load:done` и отдаёт отчёт. Рядом работает
 * крошечный сервер Minecraft — боты входят на него по-настоящему.
 */

use omnipanel_core::app::{App, AppInfo, READY_CHANNELS};
use omnipanel_core::json::{self, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

mod fake;

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "omnipanel-load-{}-{}-{}",
        name,
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn server_dir(root: &Path) -> PathBuf {
    let dir = root.join("Мир");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("server.properties"),
        "server-port=25599\nmotd=Мир\n",
    )
    .unwrap();
    std::fs::write(dir.join("eula.txt"), "eula=true\n").unwrap();
    dir
}

fn app_for(dir: &Path) -> App {
    let mut info = AppInfo::default();
    info.data_dir = dir.to_path_buf();
    info.config_path = dir.join("servers.json");
    App::new(info)
}

fn add_server(app: &App, name: &str, cwd: &Path) -> String {
    let cfg = json::parse(&format!(
        r#"{{"name":"{}","command":"java -jar paper.jar nogui","cwd":"{}"}}"#,
        name,
        cwd.display().to_string().replace('\\', "\\\\")
    ))
    .unwrap();
    app.manager()
        .add(omnipanel_core::servers::ServerConfig::from_json(&cfg))
        .id
}

fn call(app: &App, channel: &str, args: &[Value]) -> Value {
    app.invoke(channel, args)
        .unwrap_or_else(|err| panic!("{}: {}", channel, err))
}

#[test]
fn каналы_нагрузки_объявлены() {
    for channel in ["load:info", "load:start", "load:stop", "load:status", "load:versions"] {
        assert!(READY_CHANNELS.contains(&channel), "канала нет: {channel}");
    }
    assert_eq!(READY_CHANNELS.len(), 134, "каналов в Rust: {}", READY_CHANNELS.len());
}

#[test]
fn настройки_берутся_из_сервера() {
    let root = temp_dir("info");
    let app = app_for(&temp_dir("app"));
    let id = add_server(&app, "Мир", &server_dir(&root));

    let info = call(&app, "load:info", &[Value::str(&id)]);
    assert!(info.get("ok").map(|v| v.text()) != Some("false".to_string()));
    /* порт панель берёт из server.properties, версию — по папке сервера */
    assert_eq!(info.get("port").and_then(|v| v.as_f64()), Some(25599.0));
    assert!(info.get("version").map(|v| v.text().len()).unwrap_or(0) > 2);
    assert!(info.get("protocol").and_then(|v| v.as_f64()).unwrap_or(0.0) >= 47.0);
    assert_eq!(info.get("running").map(|v| v.text()), Some("false".to_string()));
    /* действия ботов по умолчанию: ходят и машут, чат выключен */
    let actions = info.get("actions").cloned().unwrap_or(Value::Null);
    assert_eq!(actions.get("walk").map(|v| v.text()), Some("true".to_string()));
    assert_eq!(actions.get("chat").map(|v| v.text()), Some("false".to_string()));

    /* у неведомого сервера — понятная ошибка, а не падение */
    let missing = call(&app, "load:info", &[Value::str("нет-такого")]);
    assert_eq!(missing.get("ok").map(|v| v.text()), Some("false".to_string()));
    assert!(missing.get("error").map(|v| v.text().contains("не найден")).unwrap_or(false));

    /* без аргумента вообще — тоже ответ, а не паника */
    let blank = call(&app, "load:info", &[]);
    assert!(blank.get("error").is_some(), "ответ: {}", blank.to_json());
}

#[test]
fn настройки_прижимаются_к_границам() {
    let cfg = omnipanel_core::load::Config::from_json(
        &json::parse(
            r#"{"port":99999,"count":900,"rampMs":999999,"durationMs":-5,
                "prefix":"Тест Тяжёлый","version":"1.21.4",
                "actions":{"walk":true,"jump":true,"chat":true,"chatMs":1,"chatText":"привет"}}"#,
        )
        .unwrap(),
    );
    /* 900 ботов не поднять на одном ноутбуке — панель прижимает к 200 */
    assert_eq!(cfg.count, 200, "ботов: {}", cfg.count);
    assert_eq!(cfg.port, 65535, "порт прижат к разумному пределу");
    assert!(cfg.ramp_ms <= 60_000, "разбег: {}", cfg.ramp_ms);
    assert_eq!(cfg.duration_ms, 0, "отрицательная длительность — «без ограничения»");
    /* «Тест Тяжёлый» сервер не пустит: ник только латиницей — панель переводит,
       а длиннее десяти знаков не берёт */
    assert_eq!(cfg.prefix, "TestTyazhe", "префикс: {}", cfg.prefix);
    assert_eq!(cfg.protocol, 769, "1.21.4 → протокол 769");
    assert_eq!(cfg.name_for(0), "TestTyazhe1");
    assert_eq!(cfg.name_for(1), "TestTyazhe2");
    assert!(cfg.actions.walk && cfg.actions.jump && cfg.actions.chat);
    /* пакет в чат не длиннее разрешённого сервером */
    assert!(cfg.actions.chat_text.len() <= 256, "текст чата: {}", cfg.actions.chat_text.len());

    /* ноль ботов — это один бот: тест без ботов не имеет смысла */
    let zero = omnipanel_core::load::Config::from_json(&json::parse(r#"{"count":0}"#).unwrap());
    assert_eq!(zero.count, 1);
}

#[test]
fn версии_для_выбора_отдаются_списком() {
    let app = app_for(&temp_dir("app"));
    let list = call(&app, "load:versions", &[]);
    let items = list.as_arr();
    assert!(items.len() >= 20, "версий: {}", items.len());
    for item in items.iter().take(3) {
        assert!(!item.get("label").map(|v| v.text()).unwrap_or_default().is_empty());
        assert!(item.get("protocol").and_then(|v| v.as_f64()).unwrap_or(0.0) >= 47.0);
    }
    /* самая свежая версия — первая в списке */
    let first = items[0].get("protocol").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let last = items[items.len() - 1].get("protocol").and_then(|v| v.as_f64()).unwrap_or(0.0);
    assert!(first >= last, "список не по порядку: {} и {}", first, last);
}

#[test]
fn тест_идёт_и_присылает_события() {
    let fake = fake::Server::start();
    let root = temp_dir("run");
    let app = app_for(&temp_dir("app"));
    let id = add_server(&app, "Мир", &server_dir(&root));

    /* события складываем в список: так панель и узнаёт о ходе теста */
    let events: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&events);
    app.on_event(move |channel, payload| {
        sink.lock().unwrap().push((channel.to_string(), payload.to_string()));
    });

    let options = json::parse(&format!(
        r#"{{"host":"127.0.0.1","port":{},"version":"1.20.4","count":2,
            "rampMs":200,"durationMs":2000,"prefix":"Тест",
            "actions":{{"walk":true,"chat":true,"chatMs":400}}}}"#,
        fake.port
    ))
    .unwrap();
    let started = call(&app, "load:start", &[Value::str(&id), options]);
    assert_eq!(started.get("ok").map(|v| v.text()), Some("true".to_string()));
    assert_eq!(
        started.get("status").and_then(|s| s.get("running")).map(|v| v.text()),
        Some("true".to_string())
    );

    /* второй запуск поверх первого не должен плодить ботов */
    let again = call(&app, "load:start", &[Value::str(&id), Value::Null]);
    assert_eq!(again.get("ok").map(|v| v.text()), Some("false".to_string()));
    assert!(again.get("error").map(|v| v.text().contains("идёт")).unwrap_or(false));

    /* ждём, пока боты войдут и тест закончится сам */
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(25);
    let mut status = Value::Null;
    while std::time::Instant::now() < deadline {
        status = call(&app, "load:status", &[]);
        let running = status
            .get("running")
            .map(|v| v.text() == "true")
            .unwrap_or(false);
        if !running {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    assert!(
        status.get("running").map(|v| v.text()) != Some("true".to_string()),
        "тест не закончился сам: {}",
        status.to_json()
    );

    /* боты действительно вошли на сервер */
    assert!(fake.joined() >= 1, "на сервер не вошёл ни один бот: {}", fake.joined());

    /* события дошли до интерфейса: последнее (о конце теста) приходит отдельным
       потоком, поэтому пару секунд ждём именно его, а не «сколько успело» */
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        if events
            .lock()
            .unwrap()
            .iter()
            .any(|(channel, _)| channel == "load:done")
        {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let list = events.lock().unwrap().clone();
    let channels: Vec<String> = list.iter().map(|(channel, _)| channel.clone()).collect();
    assert!(channels.iter().any(|c| c == "load:log"), "нет событий журнала");
    assert!(channels.iter().any(|c| c == "load:change"), "нет событий состояния");
    assert!(channels.iter().any(|c| c == "load:done"), "нет отчёта о конце");
    for (channel, payload) in &list {
        if channel != "load:log" && channel != "load:change" && channel != "load:done" {
            panic!("лишнее событие: {channel}");
        }
        assert!(payload.contains(&id), "событие без сервера: {payload}");
    }

    /* отчёт: время, боты, пакеты, ошибки */
    let (_, done) = list
        .iter()
        .find(|(channel, _)| channel == "load:done")
        .cloned()
        .expect("нет отчёта");
    let done = json::parse(&done).expect("отчёт о конце — это JSON");
    assert!(done.get("id").is_some(), "в отчёте нет сервера: {}", done.to_json());
    let report = done.get("report").cloned().unwrap_or(Value::Null);
    assert!(report.get("packetsOut").and_then(|v| v.as_f64()).unwrap_or(0.0) > 0.0);
    assert!(report.get("bots").and_then(|v| v.as_f64()).unwrap_or(0.0) >= 2.0);

    /* после теста сервер помнит настройки */
    let info = call(&app, "load:info", &[Value::str(&id)]);
    assert_eq!(info.get("count").and_then(|v| v.as_f64()), Some(2.0));
    assert_eq!(info.get("prefix").map(|v| v.text()), Some("Test".to_string()));
    assert_eq!(info.get("running").map(|v| v.text()), Some("false".to_string()));
}

#[test]
fn остановка_руками_отдаёт_отчёт() {
    let fake = fake::Server::start();
    let root = temp_dir("stop");
    let app = app_for(&temp_dir("app"));
    let id = add_server(&app, "Мир", &server_dir(&root));

    let options = json::parse(&format!(
        r#"{{"host":"127.0.0.1","port":{},"count":2,"rampMs":100,"durationMs":0,"prefix":"С"}}"#,
        fake.port
    ))
    .unwrap();
    call(&app, "load:start", &[Value::str(&id), options]);
    /* даём ботам войти */
    std::thread::sleep(std::time::Duration::from_millis(900));

    let stopped = call(&app, "load:stop", &[]);
    assert!(stopped.to_json().contains("\"ok\":true"), "ответ: {}", stopped.to_json());
    let report = stopped.get("report").cloned().unwrap_or(Value::Null);
    assert!(report.get("durationMs").and_then(|v| v.as_f64()).unwrap_or(0.0) >= 500.0);
    assert!(report.get("bots").and_then(|v| v.as_f64()).unwrap_or(0.0) >= 1.0);
    assert!(report.get("packetsOut").and_then(|v| v.as_f64()).unwrap_or(0.0) > 0.0);

    /* второй раз останавливать нечего */
    let nothing = call(&app, "load:stop", &[]);
    assert_eq!(nothing.get("ok").map(|v| v.text()), Some("false".to_string()));

    /* состояние после остановки — не «идёт» */
    let status = call(&app, "load:status", &[]);
    assert_eq!(status.get("running").map(|v| v.text()), Some("false".to_string()));
}

#[test]
fn состояние_без_теста_пустое_но_понятное() {
    let root = temp_dir("idle");
    let app = app_for(&temp_dir("app"));
    let id = add_server(&app, "Мир", &server_dir(&root));
    let info = call(&app, "load:info", &[Value::str(&id)]);
    assert_eq!(info.get("running").map(|v| v.text()), Some("false".to_string()));
    assert!(info.get("status").map(|v| v.is_null()).unwrap_or(false), "состояние пустое");
    let status = call(&app, "load:status", &[]);
    assert_eq!(status.get("running").map(|v| v.text()), Some("false".to_string()));
}

#[test]
fn неизвестное_действие_не_ломает_панель() {
    let app = app_for(&temp_dir("app"));
    let err = app.invoke("load:нет", &[]).unwrap_err();
    assert!(err.contains("load"), "ошибка: {err}");
}

#[test]
fn состояние_понятно_вкладке_ботов() {
    /* Поля называются ровно так, как их читает ui/app.js: иначе вкладка «Боты»
       показала бы прочерки вместо цифр. Это проверка договора, а не мелочь. */
    let cfg = omnipanel_core::load::Config::from_json(
        &json::parse(r#"{"count":3,"prefix":"Q","rampMs":0}"#).unwrap(),
    );
    let test = omnipanel_core::load::Load::new(cfg);
    let status = test.status_json();

    assert_eq!(status.get("running").map(|v| v.text()), Some("true".to_string()));
    assert!(status.get("elapsed").and_then(|v| v.as_f64()).is_some());

    let totals = status.get("totals").cloned().unwrap_or(Value::Null);
    assert_eq!(totals.get("bots").and_then(|v| v.as_f64()), Some(3.0));
    assert_eq!(totals.get("online").and_then(|v| v.as_f64()), Some(0.0));
    assert!(totals.get("chunksLoaded").is_some());

    let last = status.get("last").cloned().unwrap_or(Value::Null);
    for key in ["ppsOut", "ppsIn", "kbpsOut", "kbpsIn"] {
        assert!(last.get(key).and_then(|v| v.as_f64()).is_some(), "нет поля {key}");
    }

    assert!(status.get("timeline").map(|v| v.as_arr().is_empty()).unwrap_or(false));
    let bots = status.get("bots").map(|v| v.as_arr().to_vec()).unwrap_or_default();
    assert_eq!(bots.len(), 3, "в списке ботов: {}", bots.len());
    assert_eq!(bots[0].get("name").map(|v| v.text()), Some("Q1".to_string()));
    assert_eq!(bots[0].get("state").map(|v| v.text()), Some("idle".to_string()));
    assert!(bots[0].get("stats").is_some());

    /* отчёт: то, что панель показывает всплывающей строкой и в списке */
    let mut test = test;
    let report = test.stop("проверка");
    for key in ["bots", "online", "durationSec", "packetsOut", "packetsIn"] {
        assert!(report.get(key).is_some(), "в отчёте нет поля {key}");
    }
    assert!(report.get("peak").is_some(), "нет пиковых значений");
    assert!(report.get("average").is_some(), "нет средних значений");
    assert!(report.get("timeline").map(|v| v.as_arr().is_empty()).unwrap_or(false));
}
