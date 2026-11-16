// Бэкапы папки сервера: архив, список, восстановление, удаление.
//
// Проверяем на настоящей папке сервера. 7-Zip в системе может быть, а может
// и не быть — панель обязана сделать плотный архив в любом случае, поэтому
// тесты смотрят на результат, а не на имя упаковщика.
use omnipanel_core::app::{App, AppInfo, READY_CHANNELS};
use omnipanel_core::backup::{self, Count};
use omnipanel_core::json::{self, Value};
use std::path::{Path, PathBuf};

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("omnipanel-backup-{}-{}", std::process::id(), tag));
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

/// Папка сервера с миром, плагинами и тем, что в «лёгкий» бэкап не идёт.
fn server_dir(root: &Path) -> PathBuf {
    let dir = root.join("мир");
    write(&dir, "server.properties", "level-name=world\nmax-players=20\n");
    write(&dir, "eula.txt", "eula=true\n");
    write(&dir, "paper.jar", &"J".repeat(5000));
    write(&dir, "world/level.dat", "уровень мира");
    write(&dir, "world/region/r.0.0.mca", &"R".repeat(20000));
    write(&dir, "plugins/Чат.jar", &"P".repeat(3000));
    /* это сервер восстановит сам — в лёгкий бэкап не нужно */
    write(&dir, "libraries/гуава.jar", &"L".repeat(8000));
    write(&dir, "versions/1.20.4/1.20.4.jar", &"V".repeat(8000));
    write(&dir, "logs/latest.log", "журнал");
    write(&dir, "crash-reports/сбой.txt", "отчёт");
    /* служебный мусор не пакуем никогда */
    write(&dir, ".git/config", "репозиторий");
    write(&dir, "cache/мусор.bin", "кеш");
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

fn add_server(app: &App, name: &str, cwd: &Path) -> String {
    let cfg = json::parse(&format!(
        r#"{{"name":"{}","command":"java -jar paper.jar nogui","cwd":"{}"}}"#,
        name,
        cwd.display().to_string().replace('\\', "\\\\")
    ))
    .unwrap();
    app.manager().add(omnipanel_core::servers::ServerConfig::from_json(&cfg)).id
}

fn call(app: &App, channel: &str, args: &[Value]) -> Value {
    app.invoke(channel, args).unwrap_or_else(|err| panic!("{}: {}", channel, err))
}

#[test]
fn новые_каналы_объявлены() {
    for channel in [
        "backup:list", "backup:create", "backup:restore", "backup:delete", "backup:reveal", "backup:size",
    ] {
        assert!(READY_CHANNELS.contains(&channel), "канала нет: {channel}");
    }
    assert_eq!(READY_CHANNELS.len(), 122, "каналов в Rust: {}", READY_CHANNELS.len());
}

#[test]
fn подсчёт_файлов_пропускает_лишнее() {
    let root = temp_dir("measure");
    let dir = server_dir(&root);

    let full = backup::measure(&dir, false);
    let lean = backup::measure(&dir, true);
    assert!(full.files > lean.files, "лёгкий бэкап должен быть меньше: {} и {}", full.files, lean.files);
    assert!(full.bytes > lean.bytes);
    /* служебный мусор не считается никогда */
    assert!(backup::skipped(".git/config", false), ".git попал в архив");
    assert!(backup::skipped("cache/мусор.bin", false), "cache попал в архив");
    assert!(backup::skipped("libraries/гуава.jar", true), "libraries попали в лёгкий бэкап");
    assert!(!backup::skipped("libraries/гуава.jar", false), "в полном бэкапе libraries нужны");
    assert!(!backup::skipped("world/region/r.0.0.mca", true), "мир обязан быть в бэкапе");

    /* самое тяжёлое видно, чтобы человек понимал размер архива */
    let heavy = backup::top_dirs(&dir, 3);
    assert!(!heavy.is_empty());
    assert_eq!(heavy[0].0, "world", "самое тяжёлое — {:?}", heavy);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn архив_создаётся_и_читается_обратно() {
    let root = temp_dir("create");
    let dir = server_dir(&root);
    let dest = root.join("бэкапы");

    let info = backup::create(&dir, &dest, "Мир: Кактус", true, "auto", 0).expect("архив не создался");
    assert!(info.file.is_file(), "файла архива нет");
    assert!(info.name.starts_with("Мир__Кактус_"), "имя архива: {}", info.name);
    assert!(info.name.ends_with(".7z") || info.name.ends_with(".zip"), "{}", info.name);
    assert!(info.size > 0);
    assert_eq!(info.sha256.len(), 64, "sha256 не посчитан");
    assert!(info.ratio > 0.0, "сжатие не посчитано");
    assert!(info.files > 0);
    /* 7-Zip мог не найтись — тогда архив zip, и панель честно пишет причину */
    let _ = &info.warning;

    /* в списке архив есть */
    let list = backup::list(&dest);
    assert_eq!(list.len(), 1, "{}", list.len());
    assert_eq!(list[0].name, info.name);

    /* восстановление в пустую папку возвращает файлы мира */
    let restored = root.join("восстановлено");
    backup::restore(&info.file, &restored).expect("не распаковалось");
    assert!(restored.join("server.properties").is_file());
    assert!(restored.join("world").join("region").join("r.0.0.mca").is_file());
    assert!(restored.join("plugins").join("Чат.jar").is_file());
    /* лёгкий бэкап не тащит libraries и логи */
    assert!(!restored.join("libraries").exists(), "libraries попали в лёгкий бэкап");
    assert!(!restored.join("logs").exists(), "логи попали в лёгкий бэкап");
    assert!(!restored.join(".git").exists(), ".git попал в архив");

    /* удаление убирает архив */
    assert!(backup::delete(&info.file));
    assert!(!info.file.exists());
    assert!(backup::list(&dest).is_empty());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn полный_бэкап_кладёт_библиотеки() {
    let root = temp_dir("full");
    let dir = server_dir(&root);
    let info = backup::create(&dir, &root.join("бэкапы"), "полный", false, "zip", 0).expect("архив не создался");
    let restored = root.join("восстановлено");
    backup::restore(&info.file, &restored).expect("не распаковалось");
    assert!(restored.join("libraries").join("гуава.jar").is_file(), "полный бэкап обязан вернуть libraries");
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn без_7zip_архив_всё_равно_появляется() {
    let root = temp_dir("no7z");
    let dir = server_dir(&root);
    /* просим именно 7z: если бинарника нет, панель соберёт zip и скажет причину */
    let info = backup::create(&dir, &root.join("бэкапы"), "семь", true, "7z", 0).expect("бэкап не появился");
    if !backup::available() {
        assert!(info.name.ends_with(".zip"), "без 7-Zip должен быть zip: {}", info.name);
        assert!(info.warning.contains("7-Zip"), "нет объяснения: {}", info.warning);
        assert_eq!(info.packer, "zip deflate");
    }
    assert!(info.file.is_file());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn разбитый_архив_удаляется_целиком() {
    let root = temp_dir("volumes");
    let dest = root.join("бэкапы");
    std::fs::create_dir_all(&dest).unwrap();
    for index in 1..=3 {
        std::fs::write(dest.join(format!("мир.7z.{:03}", index)), "том").unwrap();
    }
    let parts = backup::volumes(&dest.join("мир.7z"));
    assert_eq!(parts.len(), 3, "тома не найдены: {:?}", parts);
    let list = backup::list(&dest);
    assert_eq!(list.len(), 1, "разбитый архив должен быть одной строкой: {:?}", list.len());
    assert_eq!(list[0].parts, 3);
    assert!(backup::delete(&list[0].file), "тома не удалились");
    assert!(backup::list(&dest).is_empty(), "остались куски архива");
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn отметка_времени_и_имя_папки_аккуратные() {
    let stamp = backup::stamp_from(1_700_000_000);
    assert_eq!(stamp.len(), 19, "отметка: {stamp}");
    assert_eq!(&stamp[4..5], "-");
    assert_eq!(&stamp[10..11], "_");
    assert_eq!(backup::slug("Мир «Кактус» / 2026"), "Мир__Кактус____2026");
    assert_eq!(backup::slug(""), "server");
    assert!(Count::default().files == 0);
}

#[test]
fn каналы_бэкапов_работают_через_приложение() {
    let (app, panel_dir) = panel("channels");
    let root = temp_dir("channels-src");
    let dir = server_dir(&root);
    let id = add_server(&app, "Мир", &dir);

    /* создание */
    let opts = json::parse(r#"{"lean":true,"format":"auto"}"#).unwrap();
    let created = call(&app, "backup:create", &[Value::str(&id), opts]);
    assert!(
        created.get("ok").map(|v| v.as_bool()).unwrap_or(false),
        "бэкап не создался: {}",
        created.to_json()
    );
    let file = created.get("file").map(|v| v.text()).unwrap_or_default();
    assert!(PathBuf::from(&file).is_file());

    /* список */
    let list = call(&app, "backup:list", &[Value::str(&id)]);
    assert_eq!(list.as_arr().len(), 1, "{}", list.to_json());

    /* размер папки */
    let size = call(&app, "backup:size", &[Value::str(&id)]);
    assert!(size.get("bytes").and_then(|v| v.as_f64()).unwrap_or(0.0) > 0.0, "{}", size.to_json());
    assert!(size.get("files").and_then(|v| v.as_f64()).unwrap_or(0.0) > 0.0);

    /* восстановление без страховочной копии — папка на месте, файлы вернулись */
    let opts = json::parse(r#"{"safety":false}"#).unwrap();
    let restored = call(&app, "backup:restore", &[Value::str(&id), Value::str(&file), opts]);
    assert!(
        restored.get("ok").map(|v| v.as_bool()).unwrap_or(false),
        "не восстановилось: {}",
        restored.to_json()
    );
    assert!(dir.join("server.properties").is_file());

    /* удаление */
    assert!(call(&app, "backup:delete", &[Value::str(&id), Value::str(&file)]).as_bool());
    assert!(call(&app, "backup:list", &[Value::str(&id)]).as_arr().is_empty());

    /* бэкап несуществующего сервера — понятная ошибка, а не паника */
    let missing = call(&app, "backup:create", &[Value::str("нет-такого"), Value::Null]);
    assert!(!missing.get("ok").map(|v| v.as_bool()).unwrap_or(true));
    let _ = std::fs::remove_dir_all(&panel_dir);
    let _ = std::fs::remove_dir_all(&root);
}
