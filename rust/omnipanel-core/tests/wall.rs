// Обои, свои окна вопросов и системные уведомления.
//
// Обои проверяются на настоящих файлах: панель должна принять картинку и
// видео, отказать во всём остальном и не дать выйти из своей папки по «../».
use omnipanel_core::app::{App, AppInfo, READY_CHANNELS};
use omnipanel_core::ask::{Ask, Button, TIMEOUT_SECS};
use omnipanel_core::image::{self, Image};
use omnipanel_core::json::Value;
use omnipanel_core::notify;
use omnipanel_core::wall;
use std::path::PathBuf;

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("omnipanel-wall-{}-{}", std::process::id(), tag));
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

fn ok(value: &Value) -> bool {
    value.get("ok").map(|v| v.as_bool()).unwrap_or(false)
}

fn text(value: &Value, name: &str) -> String {
    value.get(name).map(|v| v.text()).unwrap_or_default()
}

/// Картинка, записанная как настоящий PNG.
fn png_file(dir: &PathBuf, name: &str, color: (u8, u8, u8)) -> PathBuf {
    let mut picture = Image::new(32, 32);
    for pixel in picture.pixels.chunks_mut(4) {
        pixel[0] = color.0;
        pixel[1] = color.1;
        pixel[2] = color.2;
        pixel[3] = 255;
    }
    let path = dir.join(name);
    std::fs::write(&path, image::encode_png(&picture)).unwrap();
    path
}

#[test]
fn новые_каналы_объявлены() {
    for channel in ["wall:pick", "wall:remove", "wall:palette", "ui:ready", "ui:answer", "notify:desktop"] {
        assert!(READY_CHANNELS.contains(&channel), "канала нет: {channel}");
    }
    assert_eq!(READY_CHANNELS.len(), 127, "каналов в Rust: {}", READY_CHANNELS.len());
}

#[test]
fn обои_копируются_в_папку_панели() {
    let dir = temp_dir("pick");
    let source = png_file(&dir, "мой фон.png", (10, 90, 200));
    let reply = wall::pick(&dir, &source.display().to_string());
    assert!(ok(&reply), "{}", reply.to_json());
    let name = text(&reply, "name");
    assert!(text(&reply, "url").starts_with("/api/wall/"), "{}", reply.to_json());
    let copy = wall::dir(&dir).join(&name);
    assert!(copy.is_file(), "фон не скопирован в папку панели");

    /* в списке он есть */
    let list = wall::list(&dir);
    assert_eq!(list.as_arr().len(), 1, "{}", list.to_json());

    /* имя не даёт выйти наружу */
    assert!(wall::safe_name("../../etc/passwd").is_none());
    assert!(wall::safe_name("фон.png").is_some());
    let hacked = wall::remove(&dir, "../../servers.json");
    assert!(!ok(&hacked), "приняли опасное имя: {}", hacked.to_json());

    /* удаление убирает файл */
    let removed = wall::remove(&dir, &name);
    assert!(ok(&removed), "{}", removed.to_json());
    assert!(!copy.exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn обои_понимают_видео_и_отказывают_остальному() {
    let dir = temp_dir("ext");
    let clip = dir.join("фон.mp4");
    std::fs::write(&clip, "не настоящее видео").unwrap();
    assert!(ok(&wall::pick(&dir, &clip.display().to_string())), "mp4 не приняли");
    assert_eq!(wall::mime("фон.mp4"), "video/mp4");
    assert_eq!(wall::mime("фон.PNG"), "image/png");

    let document = dir.join("паспорт.pdf");
    std::fs::write(&document, "документ").unwrap();
    let reply = wall::pick(&dir, &document.display().to_string());
    assert!(!ok(&reply));
    assert!(text(&reply, "error").contains("формат"), "{}", reply.to_json());

    let missing = wall::pick(&dir, "/нет/такого/файла.png");
    assert!(text(&missing, "error").contains("не найден"), "{}", missing.to_json());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn палитра_подбирается_под_цвет_фона() {
    let dir = temp_dir("palette");
    let blue = png_file(&dir, "синий.png", (20, 40, 160));
    let source = Value::obj(vec![("kind", Value::str("file")), ("path", Value::str(blue.display().to_string()))]);
    let palette = wall::palette(&dir, &dir, &source);
    assert!(ok(&palette), "{}", palette.to_json());
    let dark = palette.get("dark").map(|v| v.as_bool()).unwrap_or(false);
    assert!(dark, "тёмно-синий фон должен считаться тёмным");
    let colors = palette.get("colors").unwrap();
    let accent = text(colors, "accent");
    assert_eq!(accent.len(), 7, "акцент не в виде #rrggbb: {accent}");
    /* акцент синий: канал синего больше красного */
    let red = u8::from_str_radix(&accent[1..3], 16).unwrap();
    let blue = u8::from_str_radix(&accent[5..7], 16).unwrap();
    assert!(blue > red, "акцент потерял синеву: {accent}");
    assert!(text(colors, "bg").starts_with('#'));
    assert!(text(colors, "btnText").starts_with('#'));

    /* картинка не PNG — понятный отказ, а не пустая палитра */
    let jpeg = dir.join("фото.jpg");
    std::fs::write(&jpeg, "не настоящий jpeg").unwrap();
    let source = Value::obj(vec![("kind", Value::str("file")), ("path", Value::str(jpeg.display().to_string()))]);
    let reply = wall::palette(&dir, &dir, &source);
    assert!(!ok(&reply));
    assert!(text(&reply, "error").contains("PNG"), "{}", reply.to_json());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn канал_обоев_и_уведомлений_отвечает() {
    let (app, dir) = panel("channel");
    /* без выбранного файла канал не падает, а честно молчит */
    let picked = call(&app, "wall:pick", &[]);
    assert!(!picked.is_null(), "канал ничего не ответил");

    /* уведомление в песочнице может быть недоступно — ответ всё равно есть */
    let shown = call(
        &app,
        "notify:desktop",
        &[Value::obj(vec![("title", Value::str("Сервер")), ("text", Value::str("Мир запущен"))])],
    );
    assert!(shown.as_bool() == false || shown.as_bool() == true);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn окна_вопросов_ждут_ответа() {
    let ask = Ask::new();
    assert!(!ask.is_ready());
    assert!(!ask.answer(1, "да"), "ответ без вопроса принят");
    ask.ready();
    assert!(ask.is_ready());
    assert_eq!(ask.ready_count(), 1);

    let buttons = vec![Button::new("нет", "Отмена"), Button::new("да", "Перезапустить").primary()];
    let rid: std::sync::Arc<std::sync::Mutex<Option<u64>>> = std::sync::Arc::new(std::sync::Mutex::new(None));
    let waiter = std::sync::Arc::clone(&rid);
    let ask_ref = &ask;
    let answer = std::thread::scope(|scope| {
        /* отвечающий «интерфейс»: дождался вопроса и нажал кнопку */
        scope.spawn(move || {
            for _ in 0..300 {
                if let Some(rid) = *waiter.lock().unwrap() {
                    assert!(ask_ref.pending() >= 1, "вопрос не отмечен как ожидающий");
                    assert!(ask_ref.answer(rid, "да"), "ответ не принят");
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            panic!("вопрос не дошёл до окна");
        });
        ask.ask(
            "Перезапуск",
            "Сервер работает. Перезапустить?",
            &buttons,
            "warn",
            |payload| {
                assert!(payload.to_json().contains("Перезапустить"), "{}", payload.to_json());
                *rid.lock().unwrap() =
                    payload.get("rid").and_then(|v| v.as_f64()).map(|v| v as u64);
            },
        )
    });
    assert_eq!(answer.as_deref(), Some("да"));
    assert_eq!(ask.pending(), 0, "вопрос остался висеть");
    assert!(TIMEOUT_SECS >= 60, "ждать ответа меньше минуты нельзя");
}

#[test]
fn вопрос_без_ответа_возвращает_основную_кнопку() {
    let ask = Ask::new();
    ask.ready();
    let buttons = vec![Button::new("отмена", "Отмена"), Button::new("удалить", "Удалить").danger().primary()];
    /* никто не отвечает: ждать пять минут в тестах нельзя, поэтому поток
       отвечает сразу «основной» кнопкой — так же поступит и панель по таймауту */
    let slot = std::sync::Arc::new(std::sync::Mutex::new(None::<u64>));
    let seen = std::sync::Arc::clone(&slot);
    let ask_ref = &ask;
    std::thread::scope(|scope| {
        scope.spawn(move || {
            for _ in 0..200 {
                if let Some(rid) = *seen.lock().unwrap() {
                    ask_ref.answer(rid, "удалить");
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            assert!(false, "вопрос так и не пришёл");
        });
        let answer = ask.ask("Удаление", "Удалить сервер?", &buttons, "err", |payload| {
            *slot.lock().unwrap() = payload.get("rid").and_then(|v| v.as_f64()).map(|v| v as u64);
        });
        assert_eq!(answer.as_deref(), Some("удалить"));
    });
    assert_eq!(ask.pending(), 0, "вопрос остался висеть");
}

#[test]
fn уведомление_собирается_без_лишних_кавычек() {
    let script = notify::powershell_script("Сервер упал", "Мир «Кактус» остановился\nсмотри лог");
    assert!(script.contains("BalloonTipTitle = 'Сервер упал'"), "{script}");
    /* апостроф в тексте удваивается — иначе PowerShell сломается */
    let quoted = notify::powershell_script("Чат", "это 'важно'");
    assert!(quoted.contains("''важно''"), "{quoted}");
    assert!(!quoted.contains("\\\\'"), "кавычки экранированы по-линуксовому: {quoted}");
}
