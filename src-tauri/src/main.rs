//! Окно OmniPanel на Tauri 2.
//!
//! Как устроено: панель (ядро на Rust) поднимает свой HTTP-сервер и отдаёт
//! настоящий интерфейс. Окно показывает ровно эту страницу — поэтому в окне
//! работают все уже перенесённые каналы, а шапка панели управляет настоящим
//! окном: команды из интерфейса приходят в ядро, оттуда — сюда.
//!
//! Свои окна панели — в её собственном дизайне: рамки Windows нет
//! (`decorations(false)`), шапку рисует интерфейс, кнопки «свернуть /
//! развернуть / закрыть в трей» уже есть в нём самом.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use omnipanel_core::app::{App, AppInfo};
use omnipanel_core::http::PanelServer;
use omnipanel_core::servers::Store;
use omnipanel_core::window::{WindowBridge, WindowCommand};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// Порт панели: если занят, берём следующий свободный.
fn pick_port(want: u16) -> u16 {
    for port in want..want + 40 {
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return port;
        }
    }
    want
}

/// Папка с данными рядом с программой (portable, как и было).
fn data_dir() -> PathBuf {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    exe_dir.join("OmniPanelData")
}

/// Папка с интерфейсом: рядом с программой, иначе встроенная.
fn ui_dir(app: &tauri::App) -> PathBuf {
    let near = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .map(|dir| dir.join("ui"))
        .filter(|dir| dir.join("index.html").exists());
    if let Some(dir) = near {
        return dir;
    }
    /* интерфейс внутри exe: tauri распаковывает его в ресурсы */
    app.path()
        .resource_dir()
        .map(|dir| dir.join("ui"))
        .unwrap_or_else(|_| PathBuf::from("ui"))
}

fn main() {
    let bridge = WindowBridge::new();
    let data = data_dir();
    let _ = std::fs::create_dir_all(&data);

    let port = pick_port(47800);

    tauri::Builder::default()
        .setup(move |tauri_app| {
            let mut info = AppInfo::default();
            info.version = tauri_app.package_info().version.to_string();
            info.data_dir = data.clone();
            info.config_path = data.join("servers.json");
            info.app_dir = std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|p| p.to_path_buf()))
                .unwrap_or_else(|| PathBuf::from("."));
            info.platform = std::env::consts::OS.to_string();

            /* картинки (иконки, обои, встроенные аддоны) лежат рядом с программой
               в папке assets — сервер панели отдаёт их по адресу /assets/… */
            let assets = info.app_dir.join("assets");
            let store = Store::new(info.config_path.clone());
            let app = App::with_store(info, store);
            app.attach_window(bridge.clone());
            let app_state = Arc::new(app);
            let panel = Arc::new(
                PanelServer::new(Arc::clone(&app_state), ui_dir(tauri_app)).with_assets(assets),
            );

            /* панель отвечает на запросы интерфейса в своём потоке */
            let serving = Arc::clone(&panel);
            std::thread::spawn(move || {
                if let Err(err) = serving.serve(port) {
                    eprintln!("панель не поднялась на порту {}: {}", port, err);
                }
            });

            /* главное окно: рамки нет, шапку рисует интерфейс */
            let url = format!("http://127.0.0.1:{}/", port);
            let window = WebviewWindowBuilder::new(
                tauri_app,
                "main",
                WebviewUrl::External(url.parse().expect("адрес панели")),
            )
            .title("OmniPanel")
            .inner_size(1280.0, 840.0)
            .min_inner_size(940.0, 620.0)
            .decorations(false)
            /* панель открывается сразу на весь экран: разворачивать вручную
               не нужно, кнопка в шапке просто возвращает окно в размер */
            .maximized(true)
            .visible(true)
            .build()?;

            /* на всякий случай: если разворот при создании не сработал,
               занимаем экран сами — панель должна открыться на весь экран */
            if !window.is_maximized().unwrap_or(false) && !window.is_fullscreen().unwrap_or(false) {
                let _ = window.maximize();
                std::thread::sleep(Duration::from_millis(150));
                if !window.is_maximized().unwrap_or(false) {
                    let _ = window.set_fullscreen(true);
                }
            }

            /* окно сообщает о себе правду сразу: иначе шапка рисует не ту кнопку */
            bridge.set_state(
                window.is_visible().unwrap_or(true),
                window.is_maximized().unwrap_or(true),
                window.is_fullscreen().unwrap_or(false),
            );

            /* трей: открыть, свернуть, выйти */
            let open = MenuItem::with_id(tauri_app, "open", "Открыть панель", true, None::<&str>)?;
            let hide = MenuItem::with_id(tauri_app, "hide", "Свернуть в трей", true, None::<&str>)?;
            let quit = MenuItem::with_id(tauri_app, "quit", "Выход", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(tauri_app)?;
            let menu = Menu::with_items(tauri_app, &[&open, &hide, &separator, &quit])?;

            TrayIconBuilder::with_id("omnipanel")
                .icon(tauri_app.default_window_icon().unwrap().clone())
                .tooltip("OmniPanel")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.unminimize();
                            let _ = win.set_focus();
                        }
                    }
                    "hide" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.hide();
                        }
                    }
                    "quit" => {
                        /* серверы не бросаем: сначала мягкая остановка */
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(tauri_app)?;

            /* команды из интерфейса применяем к окну 20 раз в секунду */
            let commands = bridge.clone();
            let handle = tauri_app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(50));
                for command in commands.take_commands() {
                    let Some(win) = handle.get_webview_window("main") else { continue };
                    match command {
                        WindowCommand::Minimize => {
                            let _ = win.minimize();
                        }
                        WindowCommand::Close => {
                            /* «закрыть» в шапке панели — свернуть в трей */
                            let _ = win.hide();
                        }
                        WindowCommand::ToggleMaximize => {
                            if win.is_fullscreen().unwrap_or(false) {
                                let _ = win.set_fullscreen(false);
                            } else if win.is_maximized().unwrap_or(false) {
                                let _ = win.unmaximize();
                                let _ = win.set_size(tauri::LogicalSize::new(1280.0, 840.0));
                                let _ = win.center();
                            } else {
                                let _ = win.maximize();
                                /* окно без рамки иногда не отзывается на
                                   разворот — тогда занимаем экран целиком */
                                std::thread::sleep(Duration::from_millis(180));
                                if !win.is_maximized().unwrap_or(false) {
                                    let _ = win.set_fullscreen(true);
                                }
                            }
                        }
                        WindowCommand::ToggleFullscreen => {
                            let now = win.is_fullscreen().unwrap_or(false);
                            let _ = win.set_fullscreen(!now);
                        }
                        WindowCommand::Show => {
                            let _ = win.show();
                            let _ = win.unminimize();
                            let _ = win.set_focus();
                        }
                        WindowCommand::Quit => handle.exit(0),
                    }
                    commands.set_state(
                        win.is_visible().unwrap_or(true),
                        win.is_maximized().unwrap_or(false),
                        win.is_fullscreen().unwrap_or(false),
                    );
                }
            });

            /* закрытие крестиком системой (если рамку включат) — в трей */
            let hide_on_close = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = hide_on_close.hide();
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("OmniPanel не запустился");
}
