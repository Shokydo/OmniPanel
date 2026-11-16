// Проверки каналов: архивы, порты, server.properties, перетаскивание файлов.
use omnipanel_core::app::{App, AppInfo, READY_CHANNELS};
use omnipanel_core::json::Value;
use std::fs;
use std::path::{Path, PathBuf};

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("omnipanel-ch-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
}

fn args(values: &[&str]) -> Vec<Value> {
    values.iter().map(|v| Value::str(*v)).collect()
}

/// Панель с одним сервером, у которого есть папка.
fn panel(dir: &Path) -> (App, String) {
    let mut info = AppInfo::default();
    info.data_dir = dir.to_path_buf();
    info.config_path = dir.join("servers.json");
    let app = App::new(info);
    let created = app
        .invoke(
            "servers:add",
            &[Value::obj(vec![
                ("name", Value::str("Мир")),
                ("command", Value::str("echo")),
                ("cwd", Value::str(dir.to_string_lossy())),
            ])],
        )
        .unwrap();
    let id = created.get("id").unwrap().text();
    (app, id)
}

#[test]
fn новые_каналы_в_списке_готовых() {
    for channel in [
        "archive:open",
        "archive:read",
        "archive:extract",
        "ports:own",
        "ports:check",
        "ports:free",
        "ports:set",
        "props:read",
        "props:write",
        "files:upload",
        "shell:openPath",
        "server:autoFolder",
    ] {
        assert!(READY_CHANNELS.contains(&channel), "канала нет в списке: {channel}");
    }
}

#[test]
fn архив_открывается_и_показывает_содержимое() {
    let dir = temp_dir("arch-open");
    fs::copy(fixture("простой.zip"), dir.join("plugins.zip")).unwrap();
    let (app, id) = panel(&dir);

    let res = app.invoke("archive:open", &args(&[&id, "plugins.zip"])).unwrap();
    assert!(res.get("ok").unwrap().as_bool(), "ответ: {res}");
    assert_eq!(res.get("format").unwrap().text(), "zip");
    assert_eq!(res.get("total").unwrap().as_f64(), Some(4.0));
    let entries = res.get("entries").unwrap().as_arr();
    let names: Vec<String> = entries.iter().map(|e| e.get("name").unwrap().text()).collect();
    assert!(names.contains(&"plugins/config.yml".to_string()));
    assert!(res.get("raw").unwrap().as_f64().unwrap() > 0.0, "суммарный размер посчитан");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn текст_и_картинка_из_архива() {
    let dir = temp_dir("arch-read");
    fs::copy(fixture("простой.zip"), dir.join("a.zip")).unwrap();
    let (app, id) = panel(&dir);

    let text = app
        .invoke("archive:read", &args(&[&id, "a.zip", "plugins/config.yml"]))
        .unwrap();
    assert_eq!(text.get("kind").unwrap().text(), "text");
    assert_eq!(text.get("content").unwrap().text(), "motd: Привет, мир!\nslots: 20\n");

    let binary = app.invoke("archive:read", &args(&[&id, "a.zip", "world/level.dat"])).unwrap();
    assert!(!binary.get("ok").unwrap().as_bool(), "двоичный файл не показываем текстом");
    assert!(binary.get("error").unwrap().text().contains("Двоичный"));

    let missing = app.invoke("archive:read", &args(&[&id, "a.zip", "нет.txt"])).unwrap();
    assert!(missing.get("error").unwrap().text().contains("нет файла"));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn распаковка_через_канал() {
    let dir = temp_dir("arch-extract");
    fs::copy(fixture("несжатый.zip"), dir.join("архив.zip")).unwrap();
    let (app, id) = panel(&dir);

    let res = app.invoke("archive:extract", &args(&[&id, "архив.zip", "распаковано", ""])).unwrap();
    assert!(res.get("ok").unwrap().as_bool(), "ответ: {res}");
    assert_eq!(res.get("files").unwrap().as_f64(), Some(1.0));
    assert_eq!(res.get("dest").unwrap().text(), "распаковано");
    let text = fs::read_to_string(dir.join("распаковано/readme.txt")).unwrap();
    assert!(text.contains("просто текст без сжатия"));
    let list = res.get("list").unwrap().as_arr();
    assert_eq!(list[0].text(), "readme.txt");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn не_архив_и_семизначный_объясняются_по_русски() {
    let dir = temp_dir("arch-bad");
    fs::write(dir.join("текст.txt"), "привет").unwrap();
    fs::write(dir.join("сборка.7z"), "не настоящий 7z").unwrap();
    let (app, id) = panel(&dir);

    let res = app.invoke("archive:open", &args(&[&id, "текст.txt"])).unwrap();
    assert_eq!(res.get("error").unwrap().text(), "Это не архив");
    let res = app.invoke("archive:open", &args(&[&id, "сборка.7z"])).unwrap();
    assert!(res.get("error").unwrap().text().contains("7z"));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn порты_сервера_читаются_из_server_properties() {
    let dir = temp_dir("ports-own");
    fs::write(
        dir.join("server.properties"),
        "server-port=25570\nenable-query=true\nquery.port=25571\nenable-rcon=false\n",
    )
    .unwrap();
    let (app, id) = panel(&dir);

    let res = app.invoke("ports:own", &args(&[&id])).unwrap();
    assert!(res.get("ok").unwrap().as_bool());
    let ports = res.get("ports").unwrap().as_arr();
    let keys: Vec<String> = ports.iter().map(|p| p.get("key").unwrap().text()).collect();
    assert_eq!(keys, vec!["server-port", "query.port"], "rcon выключен — его не проверяем");
    assert_eq!(ports[0].get("port").unwrap().as_f64(), Some(25570.0));
    assert_eq!(ports[0].get("label").unwrap().text(), "Порт сервера");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn занятый_порт_даёт_предложение_сменить() {
    let dir = temp_dir("ports-check");
    fs::write(dir.join("server.properties"), "server-port=25565\n").unwrap();
    let (app, id) = panel(&dir);

    /* займём порт по-настоящему и проверим, что панель это заметит */
    let заняли = std::net::TcpListener::bind("0.0.0.0:25565");
    let Ok(listener) = заняли else {
        /* порт уже занят кем-то ещё — тоже годится для проверки */
        let res = app.invoke("ports:check", &args(&[&id])).unwrap();
        assert!(res.get("ok").unwrap().as_bool());
        let _ = fs::remove_dir_all(&dir);
        return;
    };
    let res = app.invoke("ports:check", &args(&[&id])).unwrap();
    assert!(res.get("ok").unwrap().as_bool(), "ответ: {res}");
    let busy = res.get("busy").unwrap().as_arr();
    assert_eq!(busy.len(), 1, "занятый порт найден: {res}");
    assert_eq!(busy[0].get("port").unwrap().as_f64(), Some(25565.0));
    assert_eq!(busy[0].get("key").unwrap().text(), "server-port");
    assert_eq!(busy[0].get("reason").unwrap().text(), "other-app");
    let suggest = busy[0].get("suggest").unwrap().as_f64().unwrap();
    assert!(suggest > 25565.0, "предложен соседний порт: {suggest}");
    assert!(app.invoke("ports:free", &args(&[&id, "25565"])).unwrap().get("port").unwrap().as_f64().unwrap() > 0.0);
    drop(listener);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn смена_порта_записывается_в_файл_и_сохраняет_остальное() {
    let dir = temp_dir("ports-set");
    fs::write(
        dir.join("server.properties"),
        "#Minecraft server properties\n#свои пометки\nserver-port=25565\nmotd=Мир\n",
    )
    .unwrap();
    let (app, id) = panel(&dir);

    let res = app.invoke("ports:set", &args(&[&id, "server-port", "25567"])).unwrap();
    assert!(res.get("ok").unwrap().as_bool(), "ответ: {res}");
    assert_eq!(res.get("port").unwrap().as_f64(), Some(25567.0));
    let text = fs::read_to_string(dir.join("server.properties")).unwrap();
    assert!(text.contains("server-port=25567"), "новый порт записан: {text}");
    assert!(text.contains("#свои пометки"), "комментарии на месте");
    assert!(text.contains("motd=\\u041c\\u0438\\u0440") || text.contains("motd=Мир"), "остальные настройки целы: {text}");

    let bad = app.invoke("ports:set", &args(&[&id, "не-порт", "25567"])).unwrap();
    assert!(bad.get("error").unwrap().text().contains("не меняет"));
    let bad = app.invoke("ports:set", &args(&[&id, "server-port", "0"])).unwrap();
    assert!(bad.get("error").unwrap().text().contains("от 1 до 65535"));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn настройки_server_properties_читаются_и_пишутся() {
    let dir = temp_dir("props");
    fs::write(
        dir.join("server.properties"),
        "server-port=25565\nmotd=Старый мир\nenable-rcon=false\ngamemode=survival\n",
    )
    .unwrap();
    let (app, id) = panel(&dir);

    let read = app.invoke("props:read", &args(&[&id])).unwrap();
    assert!(read.get("exists").unwrap().as_bool());
    let props = read.get("props").unwrap();
    assert_eq!(props.get("motd").unwrap().text(), "Старый мир");
    assert_eq!(props.get("gamemode").unwrap().text(), "survival");

    let patch = Value::obj(vec![
        ("motd", Value::str("Новый мир")),
        ("enable-rcon", Value::Bool(true)),
        ("rcon.password", Value::str("секрет")),
    ]);
    let res = app.invoke("props:write", &[Value::str(&id), patch]).unwrap();
    assert!(res.get("ok").unwrap().as_bool(), "ответ: {res}");

    let again = app.invoke("props:read", &args(&[&id])).unwrap();
    assert_eq!(again.get("props").unwrap().get("motd").unwrap().text(), "Новый мир");
    assert!(again.get("props").unwrap().get("enable-rcon").unwrap().as_bool());
    assert_eq!(again.get("props").unwrap().get("rcon.password").unwrap().text(), "секрет");
    assert_eq!(again.get("props").unwrap().get("gamemode").unwrap().text(), "survival", "старое не потерялось");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn перетаскивание_файла_в_окно() {
    let dir = temp_dir("upload");
    let (app, id) = panel(&dir);
    let data = [0x89u8, 0x50, 0x4e, 0x47, 0x0d];
    let encoded = omnipanel_core::b64::encode(&data);

    let res = app
        .invoke("files:upload", &args(&[&id, "plugins", "моя-картинка.png", &encoded]))
        .unwrap();
    assert!(res.get("ok").unwrap().as_bool(), "ответ: {res}");
    assert_eq!(res.get("rel").unwrap().text(), "plugins/моя-картинка.png");
    assert_eq!(fs::read(dir.join("plugins/моя-картинка.png")).unwrap(), data);

    /* имя с путём не должно писать вне папки сервера */
    let res = app.invoke("files:upload", &args(&[&id, "", "../../вонаружу.txt", &encoded])).unwrap();
    assert_eq!(res.get("name").unwrap().text(), "вонаружу.txt", "из имени убран путь");
    assert!(!dir.parent().unwrap().join("вонаружу.txt").exists());

    let res = app.invoke("files:upload", &args(&[&id, "", "", &encoded])).unwrap();
    assert!(res.get("error").unwrap().text().contains("Пустое имя"));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn папка_сервера_по_умолчанию_рядом_с_программой() {
    let dir = temp_dir("autofolder");
    let (app, _) = panel(&dir);
    let value = app.invoke("server:autoFolder", &[]).unwrap();
    assert!(value.text().ends_with("server"), "папка называется server: {}", value.text());
}

#[test]
fn открытие_папки_системой_проверяет_путь() {
    let dir = temp_dir("shellopen");
    let (app, _) = panel(&dir);
    let missing = app
        .invoke("shell:openPath", &[Value::str(dir.join("нет-такой").to_string_lossy())])
        .unwrap();
    assert!(missing.get("error").unwrap().text().contains("не найдена"), "ответ: {missing}");
    let empty = app.invoke("shell:openPath", &[Value::str("")]).unwrap();
    assert_eq!(empty.get("error").unwrap().text(), "Путь не указан");
    let _ = fs::remove_dir_all(&dir);
}
