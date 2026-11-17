// Проверки управления серверами: запуск настоящего процесса через строку команды,
// живой лог, отправка команды, мягкая и жёсткая остановка, автоперезапуск,
// рабочая папка, переменные окружения, хранилище настроек.
use omnipanel_core::servers::{
    parse_servers, to_json, Event, EventKind, Manager, ServerConfig, ServerState, Store, LOG_LIMIT,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("omnipanel-srv-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// Кладём рядом с тестом маленький shell-скрипт и возвращаем путь к нему.
fn script(dir: &Path, name: &str, body: &str) -> String {
    let path = dir.join(name);
    fs::write(&path, format!("#!/bin/sh\n{body}")).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&path, perms).unwrap();
    }
    path.to_string_lossy().to_string()
}

/// Тестовый «сервер»: печатает приветствие, отвечает на команды, выходит по stop.
fn fake_server(dir: &Path) -> String {
    script(
        dir,
        "fake-server.sh",
        "echo 'Starting minecraft server version 1.20.4'\n\
         echo 'Done (1.2s)! For help, type \"help\"'\n\
         while read -r line; do\n\
           if [ \"$line\" = \"stop\" ]; then echo 'Stopping server'; exit 0; fi\n\
           echo \"команда: $line\"\n\
         done\n",
    )
}

/// Ждём состояние не дольше `secs` секунд.
fn wait_state(manager: &Manager, id: &str, want: ServerState, secs: u64) -> bool {
    let deadline = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < deadline {
        if manager.state(id) == want {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    manager.state(id) == want
}

#[test]
fn команда_идёт_через_оболочку_как_в_панели() {
    let cfg = ServerConfig::new("a", "Мир", "java -Xmx4G -jar server.jar nogui");
    let (program, args) = cfg.shell_command();
    if cfg!(windows) {
        assert_eq!(program, "cmd");
        assert_eq!(args, vec!["/C", "java -Xmx4G -jar server.jar nogui"]);
    } else {
        assert_eq!(program, "/bin/sh");
        assert_eq!(args, vec!["-c", "java -Xmx4G -jar server.jar nogui"]);
    }
}

#[test]
fn настройки_приводятся_к_виду_панели() {
    let mut cfg = ServerConfig::new("", "", "  java -jar a.jar  ");
    cfg.name = "   ".into();
    cfg.tps_interval = 0;
    cfg.encoding = String::new();
    let cfg = cfg.normalize();
    assert_eq!(cfg.name, "Новый сервер", "пустое имя заменяется");
    assert_eq!(cfg.command, "java -jar a.jar", "пробелы по краям убраны");
    assert_eq!(cfg.tps_interval, 10, "интервал tps по умолчанию");
    assert_eq!(cfg.encoding, "auto");
}

#[test]
fn рабочая_папка_по_умолчанию_это_папка_панели() {
    let mut cfg = ServerConfig::new("a", "a", "echo");
    let cwd = cfg.work_dir();
    assert_eq!(cwd, std::env::current_dir().unwrap().to_string_lossy());
    cfg.cwd = "  /srv/мир  ".into();
    assert_eq!(cfg.normalize().work_dir(), "/srv/мир");
}

#[test]
fn запуск_живой_лог_команда_и_мягкая_остановка() {
    let dir = temp_dir("start");
    let server = fake_server(&dir);
    let manager = Manager::new();
    let events: Arc<Mutex<Vec<Event>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&events);
    manager.subscribe(move |e| sink.lock().unwrap().push(e));

    let mut cfg = ServerConfig::new("srv1", "Мир", server);
    cfg.cwd = dir.to_string_lossy().to_string();
    manager.add(cfg);

    assert_eq!(manager.state("srv1"), ServerState::Stopped);
    assert!(manager.start("srv1").unwrap(), "первый запуск");
    assert_eq!(manager.state("srv1"), ServerState::Running, "интерфейс сразу видит «работает»");
    assert!(manager.pid("srv1").is_some(), "процесс получил номер");

    let deadline = Instant::now() + Duration::from_secs(5);
    while !manager.logs("srv1").iter().any(|l| l.contains("Done (")) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }

    assert!(!manager.start("srv1").unwrap(), "второй запуск не плодит процессы");

    manager.command("srv1", "list").unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !manager.logs("srv1").iter().any(|l| l.contains("команда: list")) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    let logs = manager.logs("srv1");
    assert!(logs.iter().any(|l| l.contains("Done (")), "лог доехал: {logs:?}");
    assert!(logs.iter().any(|l| l.contains("команда: list")), "команда ушла в сервер: {logs:?}");
    assert!(logs.iter().any(|l| l.contains("Запуск: ")), "в логе видно, чем запускали");

    assert!(manager.stop("srv1"), "мягкая остановка началась");
    assert!(wait_state(&manager, "srv1", ServerState::Stopped, 8), "сервер остановился сам");
    assert!(manager.pid("srv1").is_none());

    let collected = events.lock().unwrap();
    assert!(collected.iter().any(|e| e.kind == EventKind::Log && e.text.contains("Done (")));
    assert!(collected.iter().any(|e| e.kind == EventKind::State && e.text == "running"));
    assert!(collected.iter().any(|e| e.kind == EventKind::Exit), "выход сервера виден интерфейсу");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn жёсткая_остановка_убивает_процесс() {
    let dir = temp_dir("kill");
    let server = script(&dir, "long.sh", "echo 'Started'; while true; do sleep 1; done\n");
    let manager = Manager::new();
    let mut cfg = ServerConfig::new("srv2", "Долгий", server);
    cfg.cwd = dir.to_string_lossy().to_string();
    manager.add(cfg);
    manager.start("srv2").unwrap();
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(manager.state("srv2"), ServerState::Running);
    assert!(manager.kill("srv2"));
    assert_eq!(manager.state("srv2"), ServerState::Stopped);
    assert!(manager.pid("srv2").is_none());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn остановка_без_команды_гасит_сразу() {
    let dir = temp_dir("nostop");
    let server = script(&dir, "long.sh", "while true; do sleep 1; done\n");
    let manager = Manager::new();
    let mut cfg = ServerConfig::new("srv10", "Без команды", server);
    cfg.stop_command = String::new();
    cfg.cwd = dir.to_string_lossy().to_string();
    manager.add(cfg);
    manager.start("srv10").unwrap();
    std::thread::sleep(Duration::from_millis(200));
    assert!(manager.stop("srv10"), "остановка пошла");
    assert!(wait_state(&manager, "srv10", ServerState::Stopped, 5));
    assert!(
        manager.logs("srv10").iter().any(|l| l.contains("команда остановки не задана")),
        "в логе понятная причина: {:?}",
        manager.logs("srv10")
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn рабочая_папка_и_переменные_доходят_до_сервера() {
    let dir = temp_dir("cwd");
    let other = dir.join("папка мира");
    fs::create_dir_all(&other).unwrap();
    let server = script(&dir, "probe.sh", "pwd\necho \"переменная: $OMNI_TEST_VALUE\"\n");

    let manager = Manager::new();
    let mut cfg = ServerConfig::new("srv4", "Проба", server);
    cfg.cwd = other.to_string_lossy().to_string();
    cfg.env = vec![("OMNI_TEST_VALUE".to_string(), "кактус".to_string())];
    manager.add(cfg);
    manager.start("srv4").unwrap();

    let deadline = Instant::now() + Duration::from_secs(5);
    while !manager.logs("srv4").iter().any(|l| l.contains("переменная:")) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    let logs = manager.logs("srv4");
    assert!(logs.iter().any(|l| l.contains("папка мира")), "процесс работает в своей папке: {logs:?}");
    assert!(
        logs.iter().any(|l| l.contains("переменная: кактус")),
        "переменные окружения дошло: {logs:?}"
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn автоперезапуск_поднимает_сервер_после_падения() {
    let dir = temp_dir("restart");
    /* сервер живёт полсекунды и падает — как настоящий упавший сервер */
    let server = script(&dir, "crash.sh", "echo 'Started'; sleep 0.5; exit 1\n");
    let manager = Manager::new();
    let mut cfg = ServerConfig::new("srv5", "Падучий", server);
    cfg.cwd = dir.to_string_lossy().to_string();
    cfg.auto_restart = true;
    manager.add(cfg);

    manager.start("srv5").unwrap();
    let first = manager.pid("srv5");
    assert!(wait_state(&manager, "srv5", ServerState::Stopped, 5), "сервер упал");

    /* пауза перед перезапуском в панели — 3 секунды */
    let deadline = Instant::now() + Duration::from_secs(9);
    let mut restarted = false;
    while Instant::now() < deadline {
        if manager.state("srv5") == ServerState::Running && manager.pid("srv5") != first {
            restarted = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(restarted, "панель подняла сервер сама: {:?}", manager.logs("srv5"));
    assert!(
        manager.logs("srv5").iter().any(|l| l.contains("Автоперезапуск через 3 с")),
        "в логе сказано про перезапуск"
    );
    manager.kill("srv5");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn ручная_остановка_не_включает_автоперезапуск() {
    let dir = temp_dir("manual");
    let server = fake_server(&dir);
    let manager = Manager::new();
    let mut cfg = ServerConfig::new("srv6", "Мир", server);
    cfg.cwd = dir.to_string_lossy().to_string();
    cfg.auto_restart = true;
    manager.add(cfg);
    manager.start("srv6").unwrap();
    std::thread::sleep(Duration::from_millis(300));
    manager.stop("srv6");
    assert!(wait_state(&manager, "srv6", ServerState::Stopped, 8));
    std::thread::sleep(Duration::from_millis(3500));
    assert_eq!(manager.state("srv6"), ServerState::Stopped, "сам не поднялся");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn пустая_команда_объясняется_по_русски() {
    let manager = Manager::new();
    manager.add(ServerConfig::new("srv7", "Без команды", "   "));
    assert!(!manager.start("srv7").unwrap(), "запускать нечего");
    assert!(
        manager.logs("srv7").iter().any(|l| l.contains("Команда запуска не задана")),
        "в логе подсказка: {:?}",
        manager.logs("srv7")
    );
    assert_eq!(manager.state("srv7"), ServerState::Stopped);
}

#[test]
fn команда_на_остановленный_сервер_даёт_понятную_ошибку() {
    let manager = Manager::new();
    let err = manager.command("нет-такого", "list").unwrap_err();
    assert!(err.contains("не запущен"), "ошибка по-русски: {err}");
}

#[test]
fn неизвестный_сервер_не_запускается() {
    let manager = Manager::new();
    let err = manager.start("призрак").unwrap_err();
    assert_eq!(err, "сервер не найден");
}

#[test]
fn лог_не_растёт_бесконечно() {
    let dir = temp_dir("loglimit");
    let mut body = String::new();
    for i in 0..(LOG_LIMIT + 200) {
        body.push_str(&format!("echo 'строка {i}';\n"));
    }
    let server = script(&dir, "talker.sh", &body);
    let manager = Manager::new();
    let mut cfg = ServerConfig::new("srv8", "Болтун", server);
    cfg.cwd = dir.to_string_lossy().to_string();
    manager.add(cfg);
    manager.start("srv8").unwrap();

    let deadline = Instant::now() + Duration::from_secs(10);
    while manager.logs("srv8").len() < LOG_LIMIT && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    let lines = manager.log_lines("srv8");
    assert!(lines.len() <= LOG_LIMIT, "лог подрезан до {} строк, а не {}", LOG_LIMIT, lines.len());
    assert!(
        lines.iter().any(|l| l.text.contains("строка 1699")),
        "в конце лога свежие строки"
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn статус_отдаётся_в_виде_панели() {
    let dir = temp_dir("status");
    let server = fake_server(&dir);
    let manager = Manager::new();
    let mut cfg = ServerConfig::new("srv9", "Мир", server);
    cfg.cwd = dir.to_string_lossy().to_string();
    manager.add(cfg);

    let stopped = manager.status_json("srv9");
    assert_eq!(stopped.get("state").unwrap().text(), "stopped");
    assert!(stopped.get("pid").unwrap().is_null());
    assert!(stopped.get("metrics").unwrap().is_null());
    assert_eq!(stopped.get("uptime").unwrap().as_f64(), Some(0.0));

    manager.start("srv9").unwrap();
    std::thread::sleep(Duration::from_millis(300));
    let running = manager.status_json("srv9");
    assert_eq!(running.get("state").unwrap().text(), "running");
    assert!(running.get("pid").unwrap().as_f64().unwrap() > 0.0);
    assert!(running.get("startedAt").unwrap().as_f64().unwrap() > 0.0);

    let list = manager.list_json();
    let items = list.as_arr();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].get("name").unwrap().text(), "Мир");
    assert_eq!(items[0].get("state").unwrap().text(), "running");
    manager.kill("srv9");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn хранилище_сохраняет_и_читает_настройки() {
    let dir = temp_dir("store");
    let path = dir.join("OmniPanelData/servers.json");
    let store = Store::new(&path);
    assert!(store.load().is_empty(), "файла нет — пустой список");

    let mut first = ServerConfig::new("a", "Мир «Кактус»", "java -jar paper.jar nogui");
    first.cwd = "/srv/кактус".into();
    first.stop_command = "stop".into();
    first.auto_restart = true;
    first.auto_start = true;
    first.env = vec![("JAVA_OPTS".into(), "-Dfile.encoding=UTF-8".into())];
    first.icon = "кактус.ico".into();
    first.tps_command = "tps".to_string();
    first.tps_interval = 30;
    first.stop_timeout = 15000;

    let second = ServerConfig::new("b", "Второй", "python bot.py");
    let list = vec![first.clone(), second.clone()];
    store.save(&list).unwrap();

    let back = store.load();
    assert_eq!(back.len(), 2);
    assert_eq!(back[0], first, "кириллица и кавычки пережили запись");
    assert_eq!(back[1], second);

    let text = fs::read_to_string(&path).unwrap();
    assert!(text.contains("autoRestart"), "ключи как в панели: {text}");
    assert!(text.contains("Мир «Кактус»"), "текст хранится по-человечески, без \\uXXXX");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn незнакомые_поля_настроек_не_пропадают() {
    let text = r#"[{"id":"a","name":"Мир","command":"java -jar a.jar","port":25565,"memory":4096,"своё":true}]"#;
    let list = parse_servers(text);
    assert_eq!(list.len(), 1);
    let json = to_json(&list);
    assert!(json.contains("\"port\": 25565"), "порт сохранён: {json}");
    assert!(json.contains("\"memory\": 4096"), "память сохранена: {json}");
    assert!(json.contains("\"своё\": true"), "неизвестное поле тоже: {json}");
    let again = parse_servers(&json);
    assert_eq!(again.len(), 1);
    assert_eq!(again[0].command, "java -jar a.jar");
}

#[test]
fn битый_json_не_ломает_панель() {
    let dir = temp_dir("broken");
    let path = dir.join("servers.json");
    fs::write(&path, "{ это не json ][").unwrap();
    let store = Store::new(&path);
    assert!(store.load().is_empty());
    fs::write(&path, "[]").unwrap();
    assert!(store.load().is_empty(), "пустой список — тоже нормально");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn порядок_серверов_меняется_перетаскиванием() {
    let manager = Manager::new();
    for (id, name) in [("a", "A"), ("b", "B"), ("c", "C")] {
        manager.add(ServerConfig::new(id, name, "echo"));
    }
    manager.reorder(&["c".to_string(), "a".to_string()]);
    let ids: Vec<String> = manager.servers().into_iter().map(|s| s.id).collect();
    assert_eq!(ids, vec!["c", "a", "b"], "перечисленные вперёд, остальные следом");
}

#[test]
fn обновление_и_удаление_сервера() {
    let manager = Manager::new();
    manager.add(ServerConfig::new("x", "Старое", "echo 1"));
    let mut patch = ServerConfig::new("x", "Новое", "echo 2");
    patch.auto_start = true;
    let updated = manager.update("x", patch).unwrap();
    assert_eq!(updated.name, "Новое");
    assert!(updated.auto_start);
    assert!(manager.remove("x"));
    assert!(manager.servers().is_empty());
    assert!(!manager.remove("x"), "второй раз удалять нечего");
}

/* ───────── почему консоль молчала и почему сервер «не запускался» ───────── */

#[test]
fn у_строки_журнала_есть_уровень_и_время() {
    /* Интерфейс красит строку по уровню (system / stdout / stderr) и печатает
       время. Раньше событие несло только текст — строки приходили одинаково
       серыми, а страница вообще их не получала. */
    let dir = temp_dir("level");
    let server = script(
        &dir,
        "both.sh",
        "echo 'обычная строка'\necho 'ошибка в поток ошибок' >&2\nsleep 2\n",
    );
    let manager = Manager::new();
    let events: Arc<Mutex<Vec<Event>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&events);
    manager.subscribe(move |e| sink.lock().unwrap().push(e));

    let mut cfg = ServerConfig::new("lvl", "Уровни", server);
    cfg.cwd = dir.to_string_lossy().to_string();
    manager.add(cfg);
    manager.start("lvl").unwrap();

    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        let seen = events.lock().unwrap().clone();
        if seen.iter().any(|e| e.text.contains("ошибка в поток ошибок")) {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    manager.kill("lvl");
    let collected = events.lock().unwrap().clone();

    let system = collected.iter().find(|e| e.text.starts_with("Запуск:")).expect("строка запуска");
    assert_eq!(system.level, "system", "у строки запуска свой уровень");
    let out = collected.iter().find(|e| e.text == "обычная строка").expect("строка stdout");
    assert_eq!(out.level, "stdout");
    assert!(out.at > 0, "у строки есть время");
    let err = collected.iter().find(|e| e.text.contains("ошибка в поток ошибок")).expect("строка stderr");
    assert_eq!(err.level, "stderr", "ошибки видны отдельно");
    let running = collected
        .iter()
        .find(|e| e.kind == EventKind::State && e.text == "running")
        .expect("состояние running");
    assert!(running.pid.is_some(), "в состоянии есть номер процесса");
    assert!(running.started_at.is_some(), "в состоянии есть время запуска");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn tps_приходит_своим_событием_а_не_состоянием() {
    /* Раньше «tps 19.9» уходило как состояние сервера — плашка состояния
       показывала «tps 19.9» вместо «работает». */
    let dir = temp_dir("tps");
    let server = script(&dir, "tps.sh", "echo 'TPS from last 1m, 5m, 15m: 19.9, 20.0, 20.0'\nsleep 2\n");
    let manager = Manager::new();
    let events: Arc<Mutex<Vec<Event>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&events);
    manager.subscribe(move |e| sink.lock().unwrap().push(e));

    let mut cfg = ServerConfig::new("tps", "TPS", server);
    cfg.cwd = dir.to_string_lossy().to_string();
    manager.add(cfg);
    manager.start("tps").unwrap();

    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if events.lock().unwrap().iter().any(|e| e.kind == EventKind::Tps) {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    manager.kill("tps");
    let collected = events.lock().unwrap().clone();
    let tps = collected.iter().find(|e| e.kind == EventKind::Tps).expect("событие TPS");
    assert!(tps.text.trim().parse::<f64>().is_ok(), "в событии само значение: {}", tps.text);
    assert!(
        !collected
            .iter()
            .any(|e| e.kind == EventKind::State && e.text.starts_with("tps ")),
        "TPS больше не приходит как состояние"
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn запуск_с_несуществующей_папкой_объясняется_по_русски() {
    /* Самая частая причина «сервер не запускается» после переноса панели на
       другой диск: рабочей папки по старому пути больше нет. Раньше система
       отвечала невнятной ошибкой, и в консоли (которая не обновлялась) не
       было вообще ничего. */
    let manager = Manager::new();
    let mut cfg = ServerConfig::new("gone", "Нет папки", "java -jar server.jar nogui");
    cfg.cwd = "/нет/такой/папки".to_string();
    manager.add(cfg);

    let error = manager.start("gone").unwrap_err();
    assert!(error.contains("Рабочая папка не найдена"), "понятная причина: {error}");
    assert_eq!(manager.state("gone"), ServerState::Stopped);
    let logs = manager.logs("gone");
    assert!(logs.iter().any(|l| l.contains("Рабочая папка не найдена")), "причина в журнале: {logs:?}");
}
