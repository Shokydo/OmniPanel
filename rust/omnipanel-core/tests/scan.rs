// Поиск серверов на дисках, иконки и вспомогательные каналы.
//
// Поиск проверяется на настоящей папке, собранной как сервер Minecraft:
// так видно, что разбор папок не «на глаз», а по тем же признакам, что
// в прежней панели (`core/scan.js`).
use omnipanel_core::app::{App, AppInfo, READY_CHANNELS};
use omnipanel_core::autostart;
use omnipanel_core::image;
use omnipanel_core::json::{self, Value};
use omnipanel_core::scan;
use std::path::{Path, PathBuf};

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("omnipanel-scan-{}-{}", std::process::id(), tag));
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

/// Папка, которая выглядит как настоящий сервер Minecraft.
fn minecraft_server(root: &Path, name: &str) -> PathBuf {
    let dir = root.join(name);
    write(&dir, "server.properties", "level-name=world\n");
    write(&dir, "eula.txt", "eula=true\n");
    write(&dir, "paper.jar", "не настоящий jar");
    write(&dir, "world/level.dat", "уровень");
    write(&dir, "plugins/Чат/config.yml", "чат: включён");
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

fn ok(value: &Value) -> bool {
    value.get("ok").map(|v| v.as_bool()).unwrap_or(false)
}

fn text(value: &Value, name: &str) -> String {
    value.get(name).map(|v| v.text()).unwrap_or_default()
}

#[test]
fn новые_каналы_объявлены() {
    for channel in [
        "scan:roots", "scan:start", "scan:cancel", "dialog:pickFolder", "dialog:pickFile",
        "dialog:pickFolders", "icon:pick", "icon:fromServer", "icon:toServer",
        "autostart:get", "autostart:set", "shell:editor", "server:moveToApp",
    ] {
        assert!(READY_CHANNELS.contains(&channel), "канала нет в списке: {channel}");
    }
    assert_eq!(READY_CHANNELS.len(), 135, "каналов в Rust: {}", READY_CHANNELS.len());
}

#[test]
fn находит_сервер_на_диске() {
    let root = temp_dir("find");
    let server = minecraft_server(&root, "Мир «Кактус»");
    /* рядом — мусор, который сервером не считается */
    write(&root, "просто папка/заметка.txt", "привет");
    write(&root, "бот/package.json", r#"{"name":"bot","version":"1.0.0"}"#);
    write(&root, "бот/bot.js", "console.log('бот');");

    let found = scan::analyze(&server, &scan::entries(&server));
    let found = found.expect("сервер не найден");
    assert_eq!(found.kind, "minecraft");
    assert_eq!(found.stop_command, "stop");
    assert!(found.command.contains("paper.jar"), "команда запуска: {}", found.command);
    assert!(found.hints.iter().any(|h| h == "server.properties"));

    let bot = scan::analyze(&root.join("бот"), &scan::entries(&root.join("бот"))).expect("бот не найден");
    assert_eq!(bot.kind, "node");
    assert_eq!(bot.command, "node \"bot.js\"");

    let empty = root.join("просто папка");
    let none = scan::analyze(&empty, &scan::entries(&empty));
    assert!(none.is_none(), "обычная папка попала в серверы: {:?}", none);
}

#[test]
fn папка_плагинов_и_служебные_папки() {
    let root = temp_dir("plugins");
    let plugins = root.join("plugins");
    write(&plugins, "Чат.jar", "jar");
    write(&plugins, "Экономика.jar", "jar");
    let found = scan::analyze(&plugins, &scan::entries(&plugins)).expect("папка плагинов не найдена");
    assert_eq!(found.kind, "minecraft-plugin");
    assert_eq!(found.score, 1);
    assert!(found.command.is_empty(), "у папки плагинов нет команды запуска");

    /* папка с одними jar внутри plugins в списке не появляется:
       она часть сервера, а не отдельный сервер */
    let inside = plugins.join("внутри");
    write(&inside, "Ещё.jar", "jar");
    let none = scan::analyze(&inside, &scan::entries(&inside));
    assert!(none.is_none(), "папка внутри plugins принята за сервер");

    /* а папка с настоящими признаками сервера — сервер, как и в 1.26.0 */
    let real = plugins.join("настоящий");
    write(&real, "server.properties", "level-name=world\n");
    write(&real, "eula.txt", "eula=true\n");
    write(&real, "spigot.jar", "jar");
    let found = scan::analyze(&real, &scan::entries(&real)).expect("сервер внутри plugins не найден");
    assert_eq!(found.kind, "minecraft");
}

#[test]
fn обход_папок_находит_и_отменяется() {
    let root = temp_dir("walk");
    minecraft_server(&root, "сервер-один");
    minecraft_server(&root, "вложенная/сервер-два");
    write(&root, "логи/latest.log", "журнал");

    let scanner = scan::Scanner::new();
    let mut seen: Vec<String> = Vec::new();
    let mut progress = 0;
    let found = scanner.scan(
        &[root.display().to_string()],
        4,
        &[],
        &[],
        &std::collections::HashSet::new(),
        |item, _added| seen.push(item.name.clone()),
        |_| progress += 1,
    );
    assert_eq!(found.len(), 2, "найдено: {:?}", found.iter().map(|f| &f.name).collect::<Vec<_>>());
    assert!(seen.contains(&"сервер-один".to_string()));
    assert!(seen.contains(&"сервер-два".to_string()));
    assert!(progress >= 1, "о ходе поиска не сообщили");

    /* второй сервер лежит внутри первого — вглубь панель не идёт */
    let deep = temp_dir("walk2");
    let outer = minecraft_server(&deep, "внешний");
    minecraft_server(&outer, "вложенный");
    let scanner = scan::Scanner::new();
    let found = scanner.scan(
        &[deep.display().to_string()],
        6,
        &[],
        &[],
        &std::collections::HashSet::new(),
        |_, _| {},
        |_| {},
    );
    assert_eq!(found.len(), 1, "внутрь сервера заходить нельзя: {:?}", found.len());

    /* отмена останавливает обход */
    let scanner = scan::Scanner::new();
    scanner.cancel();
    let found = scanner.scan(
        &[deep.display().to_string()],
        6,
        &[],
        &[],
        &std::collections::HashSet::new(),
        |_, _| {},
        |_| {},
    );
    assert!(found.is_empty(), "отменённый поиск всё равно что-то нашёл");
    assert!(scanner.is_cancelled());
    scanner.reset();
    assert!(!scanner.is_cancelled());
}

#[test]
fn поиск_через_канал_отмечает_уже_добавленные() {
    let (app, dir) = panel("channel");
    let root = temp_dir("channel-root");
    let server = minecraft_server(&root, "готовый");

    /* сервер уже в списке панели */
    let cfg = json::parse(&format!(
        r#"{{"name":"готовый","command":"java -jar paper.jar nogui","cwd":"{}"}}"#,
        server.display().to_string().replace('\\', "\\\\")
    ))
    .unwrap();
    app.manager().add(omnipanel_core::servers::ServerConfig::from_json(&cfg));

    let opts = json::parse(&format!(
        r#"{{"roots":["{}"],"maxDepth":3}}"#,
        root.display().to_string().replace('\\', "\\\\")
    ))
    .unwrap();
    let found = call(&app, "scan:start", &[opts]);
    let items = found.as_arr().to_vec();
    assert_eq!(items.len(), 1, "{}", found.to_json());
    assert_eq!(text(&items[0], "kind"), "minecraft");
    assert!(items[0].get("added").map(|v| v.as_bool()).unwrap_or(false), "сервер не отмечен как добавленный");

    /* корни и отмена */
    let roots = call(&app, "scan:roots", &[]);
    assert!(!roots.as_arr().is_empty(), "не отдал ни одного корня");
    assert!(call(&app, "scan:cancel", &[]).as_bool());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn иконка_сервера_сохраняется_в_png_64() {
    let (app, dir) = panel("icon");
    let server_dir = dir.join("сервер");
    std::fs::create_dir_all(&server_dir).unwrap();

    /* картинка 10×10 из интерфейса */
    let mut picture = image::Image::new(10, 10);
    for index in 0..100 {
        picture.pixels[index * 4] = (index * 2) as u8;
        picture.pixels[index * 4 + 1] = 40;
        picture.pixels[index * 4 + 2] = 200;
        picture.pixels[index * 4 + 3] = 255;
    }
    let data_url = image::to_data_url(&picture);
    assert!(data_url.starts_with("data:image/png;base64,"));

    let reply = call(
        &app,
        "icon:toServer",
        &[Value::str(server_dir.display().to_string()), Value::str(&data_url)],
    );
    assert!(ok(&reply), "{}", reply.to_json());
    let saved = std::fs::read(server_dir.join("server-icon.png")).unwrap();
    let back = image::decode_png(&saved).expect("сохранённая иконка не читается");
    assert_eq!((back.width, back.height), (64, 64), "Minecraft ждёт ровно 64×64");

    /* иконка из папки сервера читается обратно */
    let from_server = call(&app, "icon:fromServer", &[Value::str(server_dir.display().to_string())]);
    let url = from_server.as_str().map(|s| s.to_string()).unwrap_or_default();
    assert!(url.starts_with("data:image/png;base64,"), "иконка не прочиталась: {}", from_server.to_json());

    /* не PNG — понятный отказ */
    let bad = call(
        &app,
        "icon:toServer",
        &[Value::str(server_dir.display().to_string()), Value::str("data:image/jpeg;base64,AAAA")],
    );
    assert!(!ok(&bad), "битую иконку приняли: {}", bad.to_json());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn png_свой_кодировщик_и_декодер() {
    let mut picture = image::Image::new(3, 2);
    for index in 0..6 {
        picture.pixels[index * 4] = 10;
        picture.pixels[index * 4 + 1] = 20;
        picture.pixels[index * 4 + 2] = 30;
        picture.pixels[index * 4 + 3] = 255;
    }
    let png = image::encode_png(&picture);
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    let back = image::decode_png(&png).expect("свой PNG не читается");
    assert_eq!(back, picture);

    /* испорченный файл — понятная ошибка, а не паника */
    let broken = image::decode_png("не PNG вовсе".as_bytes());
    assert!(broken.is_err());
}

#[test]
fn автозапуск_пишет_файл_и_содержимое_верное() {
    let entry = autostart::Entry {
        program: "C:\\Program Files\\OmniPanel\\OmniPanel.exe".to_string(),
        args: vec![],
    };
    let command = entry.command_line();
    assert!(command.starts_with('"') && command.ends_with('"'), "путь с пробелами должен быть в кавычках: {command}");

    let desktop = autostart::desktop_entry(&entry);
    assert!(desktop.starts_with("[Desktop Entry]"));
    assert!(desktop.contains("Exec=C:\\Program Files\\OmniPanel\\OmniPanel.exe"));
    assert!(desktop.contains("Name=OmniPanel"));
    /* нет подсказок и лишних слов — только понятные строки */
    assert!(!desktop.to_lowercase().contains("terminal=true"));
}

#[test]
fn перенос_папки_сервера_внутрь_программы() {
    let (app, dir) = panel("move");
    let source = temp_dir("move-src");
    write(&source, "server.properties", "level-name=world\n");
    write(&source, "world/region/r.0.0.mca", "регион");
    write(&source, "plugins/Чат/config.yml", "чат");

    let cfg = json::parse(&format!(
        r#"{{"name":"Мир: Кактус","command":"java -jar server.jar nogui","cwd":"{}"}}"#,
        source.display().to_string().replace('\\', "\\\\")
    ))
    .unwrap();
    let saved = app.manager().add(omnipanel_core::servers::ServerConfig::from_json(&cfg));

    let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let sink = std::sync::Arc::clone(&events);
    app.on_event(move |channel, payload| {
        sink.lock().unwrap().push(format!("{} {}", channel, payload));
    });

    let reply = call(&app, "server:moveToApp", &[Value::str(&saved.id), Value::Null]);
    assert!(ok(&reply), "{}", reply.to_json());
    let dest = PathBuf::from(text(&reply, "path"));
    assert!(dest.exists(), "папка не перенесена");
    assert!(dest.join("world").join("region").join("r.0.0.mca").exists());
    assert!(dest.join("plugins").join("Чат").join("config.yml").exists());
    /* имя папки без запрещённых символов */
    let folder = dest.file_name().unwrap().to_string_lossy().to_string();
    assert!(!folder.contains(':'), "в имени папки остался запрещённый символ: {folder}");
    /* шаги переноса видны интерфейсу */
    let seen = events.lock().unwrap().clone();
    assert!(seen.iter().any(|e| e.contains("move-progress")), "шаги переноса не ушли: {:?}", seen);
    /* настройки сервера указывают на новую папку */
    let updated = app.manager().find(&saved.id).unwrap();
    assert_eq!(updated.work_dir(), dest.display().to_string());

    /* второй раз — «уже там» */
    let again = call(&app, "server:moveToApp", &[Value::str(&saved.id), Value::Null]);
    assert!(again.get("unchanged").map(|v| v.as_bool()).unwrap_or(false), "{}", again.to_json());
    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&source);
}

#[test]
fn редактор_и_открытие_путей_говорят_по_русски() {
    let (app, dir) = panel("editor");
    let file = dir.join("start.bat");
    std::fs::write(&file, "@echo off").unwrap();
    /* редактора в песочнице может не быть — канал всё равно отвечает объектом */
    let reply = call(&app, "shell:editor", &[Value::str(file.display().to_string())]);
    assert!(!reply.is_null(), "канал ничего не ответил");
    assert!(reply.get("ok").is_some(), "нет поля ok: {}", reply.to_json());

    let missing = call(&app, "shell:editor", &[Value::str("нет-такого-файла")]);
    assert!(!ok(&missing));
    assert!(text(&missing, "error").contains("Не найдено"));
    let _ = std::fs::remove_dir_all(&dir);
}
