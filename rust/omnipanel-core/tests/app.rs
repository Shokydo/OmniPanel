// Проверки каналов «интерфейс → Rust»: имена, аргументы и форма ответов должны
// совпадать с прежней панелью, иначе кнопки в интерфейсе сломаются молча.
use omnipanel_core::app::{App, AppInfo, READY_CHANNELS};
use omnipanel_core::json::Value;
use std::fs;
use std::path::PathBuf;

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("omnipanel-app-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn app_with_servers(dir: &PathBuf) -> App {
    let mut info = AppInfo::default();
    info.data_dir = dir.clone();
    info.config_path = dir.join("servers.json");
    App::new(info)
}

fn args(values: &[&str]) -> Vec<Value> {
    values.iter().map(|v| Value::str(*v)).collect()
}

#[test]
fn список_каналов_совпадает_с_мостом() {
    /* мост собирается из preload.js; сюда попадают каналы, уже живущие в Rust */
    assert!(READY_CHANNELS.contains(&"servers:list"));
    assert!(READY_CHANNELS.contains(&"files:list"));
    assert!(READY_CHANNELS.contains(&"server:start"));
    assert!(READY_CHANNELS.contains(&"app:info"));
    assert!(READY_CHANNELS.len() >= 26, "срез каналов: серверы, файлы, архивы, порты, настройки");
}

#[test]
fn неперенесённый_канал_отвечает_по_русски() {
    let dir = temp_dir("notmigrated");
    let app = app_with_servers(&dir);
    /* все команды интерфейса уже живут в Rust: остались только события,
       поэтому «неперенесённым» проверяем выдуманное действие настоящего канала */
    let err = app.invoke("servers:переезд", &[]).unwrap_err();
    assert!(err.contains("ещё не перенесена в Rust"), "ошибка: {err}");
    let err = app.invoke("servers:прыжок", &[]).unwrap_err();
    assert!(err.contains("servers:прыжок"), "в ошибке видно, что именно не готово: {err}");
    let err = app.invoke("мусор", &[]).unwrap_err();
    assert!(err.contains("назван неправильно"), "ошибка: {err}");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn добавление_и_список_серверов() {
    let dir = temp_dir("add");
    let app = app_with_servers(&dir);
    let created = app
        .invoke("servers:add", &[Value::obj(vec![
            ("name", Value::str("Мир «Кактус»")),
            ("command", Value::str("java -Xmx4G -jar server.jar nogui")),
            ("cwd", Value::str(dir.to_string_lossy())),
        ])])
        .unwrap();
    let id = created.get("id").unwrap().text();
    assert!(!id.is_empty(), "сервер получил свой id");
    assert_eq!(created.get("name").unwrap().text(), "Мир «Кактус»");
    assert_eq!(created.get("encoding").unwrap().text(), "auto", "значения по умолчанию как в панели");
    assert_eq!(created.get("tpsInterval").unwrap().as_f64(), Some(10.0));

    let list = app.invoke("servers:list", &[]).unwrap();
    let items = list.as_arr();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].get("state").unwrap().text(), "stopped");
    assert!(items[0].get("pid").unwrap().is_null());
    assert!(items[0].get("autoStart").unwrap().as_bool() == false);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn настройки_сохраняются_на_диск_самой_панелью() {
    let dir = temp_dir("persist");
    let path = dir.join("servers.json");
    let mut info = AppInfo::default();
    info.data_dir = dir.clone();
    info.config_path = path.clone();
    let app = App::with_store(info.clone(), omnipanel_core::servers::Store::new(&path));

    app.invoke(
        "servers:add",
        &[Value::obj(vec![
            ("name", Value::str("Первый")),
            ("command", Value::str("echo 1")),
        ])],
    )
    .unwrap();
    assert!(path.exists(), "файл настроек создан");
    let text = fs::read_to_string(&path).unwrap();
    assert!(text.contains("Первый"), "имя записалось: {text}");

    /* новая панель читает тот же файл — как после перезапуска */
    let again = App::with_store(info.clone(), omnipanel_core::servers::Store::new(&path));
    let list = again.invoke("servers:list", &[]).unwrap();
    assert_eq!(list.as_arr().len(), 1);
    assert_eq!(list.as_arr()[0].get("name").unwrap().text(), "Первый");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn изменение_порядка_и_удаление_через_каналы() {
    let dir = temp_dir("reorder");
    let app = app_with_servers(&dir);
    let mut ids = Vec::new();
    for name in ["A", "B", "C"] {
        let created = app
            .invoke("servers:add", &[Value::obj(vec![("name", Value::str(name)), ("command", Value::str("echo"))])])
            .unwrap();
        ids.push(created.get("id").unwrap().text());
    }
    app.invoke(
        "servers:reorder",
        &[Value::Arr(vec![Value::str(&ids[2]), Value::str(&ids[0])])],
    )
    .unwrap();
    let list = app.invoke("servers:list", &[]).unwrap();
    let order: Vec<String> = list.as_arr().iter().map(|s| s.get("name").unwrap().text()).collect();
    assert_eq!(order, vec!["C", "A", "B"]);

    let removed = app.invoke("servers:remove", &args(&[&ids[0]])).unwrap();
    assert!(removed.as_bool());
    assert_eq!(app.invoke("servers:list", &[]).unwrap().as_arr().len(), 2);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn запуск_и_логи_через_каналы() {
    let dir = temp_dir("run");
    /*
     * Подставной «сервер» должен уметь две вещи: напечатать строку и отвечать
     * на команды, приходящие в stdin. На Linux это sh-сценарий, на Windows —
     * PowerShell: панель там запускает команду через `cmd /c`, а cmd не умеет
     * читать stdin построчно и уходит в бесконечный цикл на конце файла.
     */
    let (script, command_text) = if cfg!(windows) {
        let script = dir.join("run.ps1");
        fs::write(
            &script,
            "Write-Output 'Done (1.0s)!'\n\
             while ($null -ne ($line = [Console]::In.ReadLine())) { Write-Output \"эхо: $line\" }\n",
        )
        .unwrap();
        (
            script.clone(),
            format!(
                "powershell -NoProfile -ExecutionPolicy Bypass -File \"{}\"",
                script.display()
            ),
        )
    } else {
        let script = dir.join("run.sh");
        fs::write(
            &script,
            "#!/bin/sh\necho 'Done (1.0s)!'\nwhile read -r l; do echo \"эхо: $l\"; done\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&script).unwrap().permissions();
            perms.set_mode(0o755);
            fs::set_permissions(&script, perms).unwrap();
        }
        (script.clone(), script.to_string_lossy().to_string())
    };
    let _ = script;

    let app = app_with_servers(&dir);
    let created = app
        .invoke(
            "servers:add",
            &[Value::obj(vec![
                ("name", Value::str("Тест")),
                ("command", Value::str(command_text.clone())),
                ("cwd", Value::str(dir.to_string_lossy())),
            ])],
        )
        .unwrap();
    let id = created.get("id").unwrap().text();

    let status = app.invoke("server:start", &args(&[&id])).unwrap();
    assert_eq!(status.get("state").unwrap().text(), "running");
    assert!(status.get("pid").unwrap().as_f64().unwrap() > 0.0);

    std::thread::sleep(std::time::Duration::from_millis(400));
    app.invoke("server:command", &args(&[&id, "say привет"])).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let mut logs = Vec::new();
    while std::time::Instant::now() < deadline {
        let value = app.invoke("server:logs", &args(&[&id])).unwrap();
        logs = value.as_arr().iter().map(|v| v.text()).collect();
        if logs.iter().any(|l| l.contains("эхо: say привет")) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    assert!(logs.iter().any(|l| l.contains("Done (")), "лог живой: {logs:?}");
    assert!(logs.iter().any(|l| l.contains("эхо: say привет")), "команда дошла: {logs:?}");

    app.invoke("server:kill", &args(&[&id])).unwrap();
    let cleared = app.invoke("server:clearLogs", &args(&[&id])).unwrap();
    assert!(cleared.as_bool());
    assert!(app.invoke("server:logs", &args(&[&id])).unwrap().as_arr().is_empty());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn команда_на_выключенный_сервер_не_роняет_панель() {
    let dir = temp_dir("cmdstop");
    let app = app_with_servers(&dir);
    let created = app
        .invoke("servers:add", &[Value::obj(vec![("name", Value::str("Пусто")), ("command", Value::str("echo"))])])
        .unwrap();
    let id = created.get("id").unwrap().text();
    let err = app.invoke("server:command", &args(&[&id, "list"])).unwrap_err();
    assert!(err.contains("не запущен"), "ошибка: {err}");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn файлы_список_и_чтение() {
    let dir = temp_dir("files");
    let world = dir.join("world");
    fs::create_dir_all(&world).unwrap();
    fs::write(dir.join("server.properties"), "motd=Привет\n").unwrap();
    fs::write(dir.join("paper.jar"), [0u8, 1, 2, 3]).unwrap();
    fs::write(dir.join("icon.png"), [0x89, 0x50, 0x4e, 0x47]).unwrap();

    let app = app_with_servers(&dir);
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

    let listed = app.invoke("files:list", &args(&[&id, ""])).unwrap();
    assert!(listed.get("ok").unwrap().as_bool(), "ответ как в панели: {listed}");
    let items = listed.get("items").unwrap().as_arr();
    let names: Vec<String> = items.iter().map(|i| i.get("name").unwrap().text()).collect();
    assert_eq!(names[0], "world", "папки идут первыми: {names:?}");
    assert!(names.contains(&"server.properties".to_string()));
    let props = items.iter().find(|i| i.get("name").unwrap().text() == "server.properties").unwrap();
    assert_eq!(props.get("kind").unwrap().text(), "properties", "вид файла как в панели");
    assert_eq!(props.get("ext").unwrap().text(), ".properties");
    assert!(props.get("mtime").unwrap().as_f64().unwrap() > 0.0);
    let jar = items.iter().find(|i| i.get("name").unwrap().text() == "paper.jar").unwrap();
    assert_eq!(jar.get("kind").unwrap().text(), "archive");

    let read = app.invoke("files:read", &args(&[&id, "server.properties"])).unwrap();
    assert_eq!(read.get("binary").unwrap().as_bool(), false);
    assert_eq!(read.get("content").unwrap().text(), "motd=Привет\n");
    assert_eq!(read.get("lines").unwrap().as_f64(), Some(2.0));

    /* картинки и архивы текстом не редактируются — с понятным сообщением */
    let image = app.invoke("files:read", &args(&[&id, "icon.png"])).unwrap();
    assert!(image.get("binary").unwrap().as_bool());
    assert!(image.get("message").unwrap().text().contains("Картинка"));
    let jar_read = app.invoke("files:read", &args(&[&id, "paper.jar"])).unwrap();
    assert!(jar_read.get("message").unwrap().text().contains("Архив"));

    let data = app.invoke("files:image", &args(&[&id, "icon.png"])).unwrap();
    assert_eq!(data.get("kind").unwrap().text(), "image");
    assert_eq!(data.get("dataUrl").unwrap().text(), "data:image/png;base64,iVBORw==");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn файлы_создание_запись_переименование_перенос_удаление() {
    let dir = temp_dir("fswrite");
    let app = app_with_servers(&dir);
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

    app.invoke("files:mkdir", &args(&[&id, "plugins"])).unwrap();
    assert!(dir.join("plugins").is_dir());

    let written = app
        .invoke("files:write", &args(&[&id, "plugins/config.yml", "motd: привет\n"]))
        .unwrap();
    assert!(written.get("ok").unwrap().as_bool());
    assert!(written.get("size").unwrap().as_f64().unwrap() > 0.0);
    assert_eq!(fs::read_to_string(dir.join("plugins/config.yml")).unwrap(), "motd: привет\n");

    let renamed = app
        .invoke("files:rename", &args(&[&id, "plugins/config.yml", "main.yml"]))
        .unwrap();
    assert_eq!(renamed.get("path").unwrap().text(), "plugins/main.yml");
    assert!(dir.join("plugins/main.yml").is_file());

    app.invoke("files:mkdir", &args(&[&id, "backup"])).unwrap();
    let moved = app.invoke("files:move", &args(&[&id, "plugins/main.yml", "backup"])).unwrap();
    assert_eq!(moved.get("path").unwrap().text(), "backup/main.yml");
    assert!(dir.join("backup/main.yml").is_file());

    app.invoke("files:remove", &args(&[&id, "backup"])).unwrap();
    assert!(!dir.join("backup").exists());

    /* поиск по имени, регистр не важен */
    app.invoke("files:write", &args(&[&id, "World/level.dat", "x"])).unwrap();
    let found = app.invoke("files:search", &args(&[&id, "level"])).unwrap();
    let results = found.get("results").unwrap().as_arr();
    assert!(results.iter().any(|r| r.get("name").unwrap().text() == "level.dat"), "поиск нашёл файл");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn выход_за_папку_сервера_запрещён() {
    let dir = temp_dir("escape");
    let app = app_with_servers(&dir);
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
    /* файловые каналы отвечают объектом с ok:false и текстом причины — как в панели */
    let res = app.invoke("files:read", &args(&[&id, "../../etc/passwd"])).unwrap();
    assert!(!res.get("ok").unwrap().as_bool(), "выход наружу запрещён");
    assert!(res.get("error").unwrap().text().contains("вне папки сервера"), "ошибка: {res}");
    let res = app.invoke("files:write", &args(&[&id, "../вонаружу.txt", "нет"])).unwrap();
    assert!(!res.get("ok").unwrap().as_bool(), "писать наружу нельзя");
    assert!(res.get("error").unwrap().text().contains("вне папки сервера"));
    assert!(!dir.parent().unwrap().join("вонаружу.txt").exists());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn ошибки_файловых_каналов_не_бросаются_наружу() {
    /* интерфейс проверяет res.ok === false || res.error, а не перехватом исключения */
    let dir = temp_dir("okwrap");
    let app = app_with_servers(&dir);
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
    let res = app.invoke("files:read", &args(&[&id, "нет-такого.txt"])).unwrap();
    assert!(!res.get("ok").unwrap().as_bool());
    assert!(!res.get("error").unwrap().text().is_empty(), "причина словами: {res}");
    let ok = app.invoke("files:mkdir", &args(&[&id, "новая"])).unwrap();
    assert!(ok.get("ok").unwrap().as_bool(), "успех тоже помечен ok: {ok}");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn сервер_без_папки_объясняет_что_делать() {
    let dir = temp_dir("noroot");
    let app = app_with_servers(&dir);
    let created = app
        .invoke("servers:add", &[Value::obj(vec![("name", Value::str("Без папки")), ("command", Value::str("echo"))])])
        .unwrap();
    let id = created.get("id").unwrap().text();
    let res = app.invoke("files:list", &args(&[&id, ""])).unwrap();
    assert!(!res.get("ok").unwrap().as_bool());
    assert!(res.get("error").unwrap().text().contains("рабочая папка"), "ответ: {res}");
    let res = app.invoke("files:list", &args(&["нет-такого", ""])).unwrap();
    assert!(res.get("error").unwrap().text().contains("сервер не найден"), "ответ: {res}");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn сведения_о_программе_и_проверка_пути() {
    let dir = temp_dir("info");
    let mut info = AppInfo::default();
    info.data_dir = dir.clone();
    info.config_path = dir.join("servers.json");
    info.version = "1.26.0".to_string();
    let app = App::new(info);

    let value = app.invoke("app:info", &[]).unwrap();
    assert_eq!(value.get("version").unwrap().text(), "1.26.0");
    assert_eq!(value.get("mode").unwrap().text(), "desktop");
    assert!(value.get("rust").unwrap().as_bool(), "интерфейс может отличить Rust-сборку");

    let here = app
        .invoke("path:check", &[Value::str(dir.to_string_lossy())])
        .unwrap();
    assert!(here.get("exists").unwrap().as_bool());
    assert!(here.get("isDir").unwrap().as_bool());
    let missing = app
        .invoke("path:check", &[Value::str(dir.join("нет-такого").to_string_lossy())])
        .unwrap();
    assert!(!missing.get("exists").unwrap().as_bool());
    let _ = fs::remove_dir_all(&dir);
}
