/*!
 * Аддоны через каналы панели: `addons:*`.
 *
 * Аддон — это папка с `addon.json`, своим HTML для панели и разрешениями.
 * Проверяем то, что видит человек: список с включённостью, переключатель,
 * открытие панели, мост «аддон → панель» и то, что мост не пускает лишнего.
 */

use omnipanel_core::app::{App, AppInfo, READY_CHANNELS};
use omnipanel_core::json::{self, Value};
use std::path::{Path, PathBuf};

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "omnipanel-addons-{}-{}-{}",
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

/// Готовит панель: папка данных, папка программы и один сервер.
fn setup(name: &str) -> (App, PathBuf, String) {
    let root = temp_dir(name);
    let data = root.join("data");
    let app_dir = root.join("app");
    std::fs::create_dir_all(&data).unwrap();
    std::fs::create_dir_all(&app_dir).unwrap();

    let mut info = AppInfo::default();
    info.data_dir = data.clone();
    info.config_path = data.join("servers.json");
    info.app_dir = app_dir.clone();
    let app = App::new(info);

    let server = root.join("Мир");
    std::fs::create_dir_all(server.join("plugins")).unwrap();
    std::fs::write(server.join("server.properties"), "server-port=25599\nmotd=Мир\n").unwrap();
    std::fs::write(server.join("plugins/миры.jar"), b"PK").unwrap();
    let cfg = json::parse(&format!(
        r#"{{"name":"Мир","command":"java -jar paper.jar nogui","cwd":"{}"}}"#,
        server.display().to_string().replace('\\', "\\\\")
    ))
    .unwrap();
    let id = app
        .manager()
        .add(omnipanel_core::servers::ServerConfig::from_json(&cfg))
        .id;
    (app, root, id)
}

/// Кладёт аддон в папку данных.
fn addon(data_root: &Path, id: &str, manifest: &str, panel: Option<&str>) {
    let dir = data_root.join("data").join("addons").join(id);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("addon.json"), manifest).unwrap();
    if let Some(html) = panel {
        std::fs::write(dir.join("panel.html"), html).unwrap();
    }
}

fn call(app: &App, channel: &str, args: &[Value]) -> Value {
    app.invoke(channel, args)
        .unwrap_or_else(|err| panic!("{}: {}", channel, err))
}

fn list_of(app: &App) -> Vec<Value> {
    call(app, "addons:list", &[]).as_arr().to_vec()
}

#[test]
fn каналы_аддонов_объявлены() {
    for channel in [
        "addons:list",
        "addons:setEnabled",
        "addons:panel",
        "addons:dirs",
        "addons:reveal",
        "addons:call",
    ] {
        assert!(READY_CHANNELS.contains(&channel), "канала нет: {channel}");
    }
    assert_eq!(READY_CHANNELS.len(), 135, "каналов в Rust: {}", READY_CHANNELS.len());
}

#[test]
fn аддон_виден_в_списке() {
    let (app, root, _) = setup("list");
    addon(
        &root,
        "mythic-mobs",
        r#"{"id":"mythic-mobs","name":"Мифические мобы","version":"2.1.0","author":"OmniPanel",
            "description":"Мобы посерьёзнее","icon":"MM","panel":{"title":"Мобы","file":"panel.html"},
            "permissions":["files","command"]}"#,
        Some("<h1>Мобы</h1>"),
    );
    /* второй аддон без панели: он тоже должен быть в списке */
    addon(&root, "cleaner", r#"{"id":"cleaner","name":"Чистка логов"}"#, None);

    let items = list_of(&app);
    assert_eq!(items.len(), 2, "аддонов: {}", items.len());

    let mobs = items
        .iter()
        .find(|a| a.get("id").map(|v| v.text()) == Some("mythic-mobs".to_string()))
        .expect("аддона нет в списке");
    assert_eq!(mobs.get("name").map(|v| v.text()), Some("Мифические мобы".to_string()));
    assert_eq!(mobs.get("version").map(|v| v.text()), Some("2.1.0".to_string()));
    assert_eq!(mobs.get("author").map(|v| v.text()), Some("OmniPanel".to_string()));
    assert_eq!(mobs.get("icon").map(|v| v.text()), Some("MM".to_string()));
    assert_eq!(mobs.get("enabled").map(|v| v.text()), Some("true".to_string()), "по умолчанию включён");
    assert_eq!(mobs.get("hasPanel").map(|v| v.text()), Some("true".to_string()));
    assert_eq!(mobs.get("panelTitle").map(|v| v.text()), Some("Мобы".to_string()));
    assert_eq!(mobs.get("builtin").map(|v| v.text()), Some("false".to_string()));
    assert_eq!(mobs.get("permissions").map(|v| v.as_arr().len()), Some(2));

    /* у аддона без панели панели нет — и это не ошибка */
    let cleaner = items
        .iter()
        .find(|a| a.get("id").map(|v| v.text()) == Some("cleaner".to_string()))
        .unwrap();
    assert_eq!(cleaner.get("hasPanel").map(|v| v.text()), Some("false".to_string()));
    assert_eq!(cleaner.get("panelTitle").map(|v| v.text()), Some("".to_string()));
    /* значок берётся из имени, если своего нет */
    assert_eq!(cleaner.get("icon").map(|v| v.text()), Some("Ч".to_string()));

    /* где лежат аддоны — окно показывает эти две папки */
    let dirs = call(&app, "addons:dirs", &[]);
    let user = dirs.get("user").map(|v| v.text()).unwrap_or_default();
    assert!(user.ends_with("addons"), "папка своих аддонов: {user}");
    assert!(Path::new(&user).is_dir(), "папка своих аддонов не создана");
    assert!(dirs.get("builtin").is_some());
}

#[test]
fn переключатель_сохраняется_и_влияет_на_панель() {
    let (app, root, _) = setup("toggle");
    addon(
        &root,
        "cleaner",
        r#"{"id":"cleaner","name":"Чистка логов","panel":{"file":"panel.html"}}"#,
        Some("<b>чистка</b>"),
    );

    /* выключаем */
    let off = call(&app, "addons:setEnabled", &[Value::str("cleaner"), Value::Bool(false)]);
    assert_eq!(off.get("ok").map(|v| v.text()), Some("true".to_string()));
    assert_eq!(off.get("enabled").map(|v| v.text()), Some("false".to_string()));
    assert_eq!(
        list_of(&app)[0].get("enabled").map(|v| v.text()),
        Some("false".to_string())
    );
    /* у выключенного аддона панель не открывается */
    let closed = call(&app, "addons:panel", &[Value::str("cleaner")]);
    assert_eq!(closed.get("ok").map(|v| v.text()), Some("false".to_string()));
    assert!(closed.get("error").map(|v| v.text().contains("выключен")).unwrap_or(false));

    /* включаем обратно — панель отдаётся целиком */
    call(&app, "addons:setEnabled", &[Value::str("cleaner"), Value::Bool(true)]);
    let panel = call(&app, "addons:panel", &[Value::str("cleaner")]);
    assert_eq!(panel.get("ok").map(|v| v.text()), Some("true".to_string()));
    assert_eq!(panel.get("html").map(|v| v.text()), Some("<b>чистка</b>".to_string()));
    assert_eq!(panel.get("title").map(|v| v.text()), Some("Чистка логов".to_string()));

    /* состояние переживает перезапуск панели: оно лежит в addons.json */
    let state = root.join("data").join("addons.json");
    assert!(state.is_file(), "файл состояния не создан");
    let text = std::fs::read_to_string(&state).unwrap();
    assert!(text.contains("cleaner"), "состояние: {text}");
}

#[test]
fn чужой_аддон_и_плохие_данные_не_ломают_список() {
    let (app, root, _) = setup("bad");
    /* нет addon.json — просто пропускаем */
    std::fs::create_dir_all(root.join("data/addons/пусто").join("addons")).unwrap();
    std::fs::create_dir_all(root.join("data/addons/пусто")).unwrap();
    /* id с запрещёнными знаками — не аддон */
    addon(&root, "плохой", r#"{"id":"Плохой Аддон!"}"#, None);
    /* сломанный JSON — не аддон */
    addon(&root, "сломанный", "{ это не json", None);
    /* панель просит файл вне своей папки: имя обрезается до файла,
       поэтому чужой HTML не подхватится никогда */
    std::fs::write(root.join("секрет.html"), "<h1>чужое</h1>").unwrap();
    addon(
        &root,
        "hityi",
        r#"{"id":"hityi","name":"Хитрый","panel":{"file":"../../секрет.html"}}"#,
        None,
    );
    /* и один нормальный */
    addon(&root, "normal", r#"{"id":"normal","name":"Обычный"}"#, None);

    let items = list_of(&app);
    assert_eq!(items.len(), 2, "в списке остались нормальный и хитрый: {}", items.len());
    assert_eq!(items[0].get("id").map(|v| v.text()), Some("hityi".to_string()));
    assert_eq!(
        items[0].get("hasPanel").map(|v| v.text()),
        Some("false".to_string()),
        "чужой HTML за панель не считается"
    );
    assert_eq!(items[1].get("id").map(|v| v.text()), Some("normal".to_string()));

    /* неизвестный id — понятный ответ, а не падение */
    let missing = call(&app, "addons:setEnabled", &[Value::str("нет-такого"), Value::Bool(true)]);
    assert_eq!(missing.get("ok").map(|v| v.text()), Some("false".to_string()));
    assert!(missing.get("error").map(|v| v.text().contains("не найден")).unwrap_or(false));
}

#[test]
fn мост_пускает_только_разрешённое() {
    let (app, root, server_id) = setup("bridge");
    /* аддон с полными правами и аддон только с файлами */
    addon(
        &root,
        "full",
        r#"{"id":"full","name":"Полный","permissions":["files","command"]}"#,
        None,
    );
    addon(
        &root,
        "files-only",
        r#"{"id":"files-only","name":"Только файлы","permissions":["files"]}"#,
        None,
    );

    let bridge = |addon: &str, method: &str, args: &str| {
        call(
            &app,
            "addons:call",
            &[
                Value::str(addon),
                Value::str(method),
                json::parse(args).unwrap(),
                Value::str(&server_id),
            ],
        )
    };

    /* файлы: список и чтение внутри папки сервера */
    let listed = bridge("files-only", "list", r#"["plugins"]"#);
    assert_eq!(listed.get("ok").map(|v| v.text()), Some("true".to_string()), "{}", listed.to_json());
    let items = listed.get("data").map(|v| v.as_arr().to_vec()).unwrap_or_default();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].get("name").map(|v| v.text()), Some("миры.jar".to_string()));

    let read = bridge("files-only", "read", r#"["plugins/миры.jar"]"#);
    assert_eq!(read.get("ok").map(|v| v.text()), Some("true".to_string()));

    /* запись — и она действительно на диске */
    let server_dir = app.manager().find(&server_id).unwrap().cwd.clone();
    let wrote = bridge("files-only", "write", r#"["plugins/аддон.txt","привет от аддона"]"#);
    assert_eq!(wrote.get("ok").map(|v| v.text()), Some("true".to_string()), "{}", wrote.to_json());
    let saved = std::fs::read_to_string(Path::new(&server_dir).join("plugins/аддон.txt")).unwrap();
    assert_eq!(saved, "привет от аддона");

    /* наружу из папки сервера нельзя */
    let outside = bridge("files-only", "read", r#"["../../../etc/passwd"]"#);
    assert_eq!(outside.get("ok").map(|v| v.text()), Some("false".to_string()));

    /* консоль без разрешения не даём */
    let denied = bridge("files-only", "command", r#"["say привет"]"#);
    assert_eq!(denied.get("ok").map(|v| v.text()), Some("false".to_string()));
    assert!(denied.get("error").map(|v| v.text().contains("консоль")).unwrap_or(false));

    /* с разрешением — но сервер-то стоит */
    let stopped = bridge("full", "command", r#"["say привет"]"#);
    assert_eq!(stopped.get("ok").map(|v| v.text()), Some("false".to_string()));
    assert!(stopped.get("error").map(|v| v.text().contains("не запущен")).unwrap_or(false));

    /* пустая команда не уходит никуда */
    let empty = bridge("full", "command", r#"["   "]"#);
    assert!(empty.get("error").map(|v| v.text().contains("Пустая")).unwrap_or(false));

    /* про свойства: аддон может поменять настройки своего сервера */
    let props = bridge("files-only", "props", r#"[{"motd":"Новый мир"}]"#);
    assert_eq!(props.get("ok").map(|v| v.text()), Some("true".to_string()), "{}", props.to_json());
    /* в файле кириллица лежит как в Java — \uXXXX, а читается обратно словами */
    let saved = std::fs::read_to_string(Path::new(&server_dir).join("server.properties")).unwrap();
    assert!(saved.contains("\\u041d"), "свойства записаны как в Java: {saved}");
    let read_back = call(&app, "props:read", &[Value::str(&server_id)]);
    let motd = read_back
        .get("props")
        .and_then(|p| p.get("motd"))
        .map(|v| v.text())
        .unwrap_or_default();
    assert_eq!(motd, "Новый мир", "свойства читаются обратно");

    /* неизвестное действие — отказ с понятным текстом */
    let unknown = bridge("full", "deleteEverything", "[]");
    assert!(unknown.get("error").map(|v| v.text().contains("неизвестно")).unwrap_or(false));

    /* плохой ник не уходит в Mojang */
    let nick = bridge("full", "lookupUuid", r#"["не ник!"]"#);
    assert!(nick.get("error").map(|v| v.text().contains("ник")).unwrap_or(false));
}

#[test]
fn выключенный_аддон_не_может_ничего() {
    let (app, root, server_id) = setup("off");
    addon(&root, "spy", r#"{"id":"spy","name":"Шпион","permissions":["files"]}"#, None);
    call(&app, "addons:setEnabled", &[Value::str("spy"), Value::Bool(false)]);

    let res = call(
        &app,
        "addons:call",
        &[
            Value::str("spy"),
            Value::str("list"),
            Value::Arr(Vec::new()),
            Value::str(&server_id),
        ],
    );
    assert_eq!(res.get("ok").map(|v| v.text()), Some("false".to_string()));
    assert!(res.get("error").map(|v| v.text().contains("выключен")).unwrap_or(false));
}

#[test]
fn без_папки_сервера_мост_отвечает_понятно() {
    let (app, root, _) = setup("nowhere");
    addon(&root, "helper", r#"{"id":"helper","name":"Помощник","permissions":["files"]}"#, None);
    let res = call(
        &app,
        "addons:call",
        &[
            Value::str("helper"),
            Value::str("list"),
            Value::Arr(Vec::new()),
            Value::str("нет-такого"),
        ],
    );
    assert_eq!(res.get("ok").map(|v| v.text()), Some("false".to_string()));
    let error = res.get("error").map(|v| v.text()).unwrap_or_default();
    assert!(
        error.contains("не найден") || error.contains("папк"),
        "ошибка: {error}"
    );
}

#[test]
fn встроенные_аддоны_панели_на_месте() {
    /* свои аддоны не должны затирать встроенные: у панели они уже есть
       (белый список и мифические мобы), и они едут вместе с программой */
    let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("assets")
        .join("addons");
    if !repo.is_dir() {
        return; /* панель собрана без папки assets — проверять нечего */
    }

    let root = temp_dir("builtin");
    let data = root.join("data");
    let app_dir = repo.parent().unwrap().parent().unwrap().to_path_buf();
    std::fs::create_dir_all(&data).unwrap();
    let mut info = AppInfo::default();
    info.data_dir = data.clone();
    info.config_path = data.join("servers.json");
    info.app_dir = app_dir;
    let app = App::new(info);

    let items = list_of(&app);
    let ids: Vec<String> = items.iter().map(|a| a.get("id").map(|v| v.text()).unwrap_or_default()).collect();
    assert!(ids.contains(&"whitelist".to_string()), "встроенные аддоны: {:?}", ids);
    assert!(ids.contains(&"mythic-mobs".to_string()), "встроенные аддоны: {:?}", ids);

    let whitelist = items
        .iter()
        .find(|a| a.get("id").map(|v| v.text()) == Some("whitelist".to_string()))
        .unwrap();
    assert_eq!(whitelist.get("builtin").map(|v| v.text()), Some("true".to_string()));
    assert_eq!(whitelist.get("hasPanel").map(|v| v.text()), Some("true".to_string()));
    assert_eq!(whitelist.get("enabled").map(|v| v.text()), Some("true".to_string()));

    /* панель встроенного аддона отдаётся целиком — в ней есть свой интерфейс */
    let panel = call(&app, "addons:panel", &[Value::str("whitelist")]);
    assert_eq!(panel.get("ok").map(|v| v.text()), Some("true".to_string()));
    let html = panel.get("html").map(|v| v.text()).unwrap_or_default();
    assert!(html.contains("<"), "панель аддона пустая");
    assert!(html.len() > 500, "панель аддона подозрительно короткая: {}", html.len());
}
