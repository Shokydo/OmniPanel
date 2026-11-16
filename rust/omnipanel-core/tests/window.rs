// Проверки моста окна: интерфейс просит — окно получает команду.
//
// Сам оконный слой (Tauri) собирается на Windows, а вся логика «что должно
// произойти по кнопке» проверяется здесь, на обычных тестах.
use omnipanel_core::app::{App, AppInfo, READY_CHANNELS};
use omnipanel_core::json::Value;
use omnipanel_core::window::{WindowBridge, WindowCommand};
use std::sync::Arc;

fn app_with_bridge() -> (App, WindowBridge) {
    let bridge = WindowBridge::new();
    let app = App::with_window(AppInfo::default(), bridge.clone());
    (app, bridge)
}

#[test]
fn каналы_окна_перенесены() {
    for channel in [
        "win:minimize",
        "win:close",
        "win:quit",
        "win:toggleMax",
        "win:toggleFull",
        "win:isVisible",
        "win:state",
        "win:getStartMode",
        "win:setStartMode",
    ] {
        assert!(READY_CHANNELS.contains(&channel), "канала нет: {channel}");
    }
}

#[test]
fn свернуть_и_закрыть_доходят_до_окна() {
    let (app, bridge) = app_with_bridge();
    assert!(app.invoke("win:minimize", &[]).unwrap().as_bool());
    assert_eq!(bridge.take_commands(), vec![WindowCommand::Minimize]);

    /* «закрыть» в шапке панели — это свернуть в трей, а не выход */
    app.invoke("win:close", &[]).unwrap();
    assert_eq!(bridge.take_commands(), vec![WindowCommand::Close]);
}

#[test]
fn выход_из_панели_отдельная_команда() {
    let (app, bridge) = app_with_bridge();
    app.invoke("win:quit", &[]).unwrap();
    assert_eq!(bridge.take_commands(), vec![WindowCommand::Quit]);
}

#[test]
fn развернуть_и_полный_экран_переключаются() {
    let (app, bridge) = app_with_bridge();
    app.invoke("win:toggleMax", &[]).unwrap();
    app.invoke("win:toggleFull", &[]).unwrap();
    assert_eq!(
        bridge.take_commands(),
        vec![WindowCommand::ToggleMaximize, WindowCommand::ToggleFullscreen]
    );
    assert!(bridge.take_commands().is_empty(), "команды не повторяются");
}

#[test]
fn состояние_окна_возвращается_интерфейсу() {
    let (app, bridge) = app_with_bridge();
    /* окно сообщает, что оно развёрнуто и на виду */
    bridge.set_state(true, true, false);
    let state = app.invoke("win:state", &[]).unwrap();
    assert!(state.get("visible").unwrap().as_bool());
    assert!(state.get("maximized").unwrap().as_bool());
    assert!(!state.get("fullscreen").unwrap().as_bool());
    assert!(app.invoke("win:isVisible", &[]).unwrap().as_bool());

    /* свернули в трей */
    bridge.set_state(false, false, false);
    assert!(!app.invoke("win:isVisible", &[]).unwrap().as_bool());
}

#[test]
fn возврат_из_трея_даёт_команду_показать() {
    let (app, bridge) = app_with_bridge();
    app.invoke("win:show", &[]).unwrap();
    assert_eq!(bridge.take_commands(), vec![WindowCommand::Show]);
}

#[test]
fn режим_запуска_запоминается() {
    let (app, _) = app_with_bridge();
    assert_eq!(app.invoke("win:getStartMode", &[]).unwrap().text(), "tray");
    let set = app
        .invoke("win:setStartMode", &[Value::str("window")])
        .unwrap();
    assert_eq!(set.text(), "window");
}

#[test]
fn мост_общий_для_потоков() {
    /* интерфейс и оконный поток работают с одним мостом */
    let bridge = WindowBridge::new();
    let from_ui = bridge.clone();
    std::thread::spawn(move || {
        from_ui.request(WindowCommand::ToggleMaximize);
    })
    .join()
    .unwrap();
    assert_eq!(bridge.pending(), 1);
    assert_eq!(bridge.take_commands(), vec![WindowCommand::ToggleMaximize]);
}

#[test]
fn команды_разбираются_из_текста() {
    assert_eq!(WindowCommand::parse("minimize"), Some(WindowCommand::Minimize));
    assert_eq!(WindowCommand::parse("toggleMax"), Some(WindowCommand::ToggleMaximize));
    assert_eq!(WindowCommand::parse("toggleFull"), Some(WindowCommand::ToggleFullscreen));
    assert_eq!(WindowCommand::parse("не-команда"), None);
    assert_eq!(WindowCommand::Close.as_str(), "close");
}

#[test]
fn приложение_с_мостом_работает_как_обычное() {
    let bridge = WindowBridge::new();
    let app = App::with_window(AppInfo::default(), bridge.clone());
    let created = app
        .invoke(
            "servers:add",
            &[Value::obj(vec![
                ("name", Value::str("Мир")),
                ("command", Value::str("echo")),
            ])],
        )
        .unwrap();
    assert_eq!(created.get("name").unwrap().text(), "Мир");
    let shared: Arc<WindowBridge> = Arc::new(bridge);
    assert_eq!(shared.pending(), 0, "добавление сервера не трогает окно");
}
