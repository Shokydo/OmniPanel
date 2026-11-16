//! Запуск панели на Rust: `omnipanel [--port 47800] [--data OmniPanelData] [--ui ui]`
//!
//! Отдаёт интерфейс панели и отвечает на его запросы. Всё, что уже перенесено
//! в ядро, работает по-настоящему; что не перенесено — отвечает понятным
//! текстом, а не молчит.

use omnipanel_core::app::{App, AppInfo};
use omnipanel_core::http::PanelServer;
use omnipanel_core::servers::Store;
use std::path::PathBuf;
use std::sync::Arc;

fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    let mut i = 0;
    while i < args.len() {
        if args[i] == name && i + 1 < args.len() {
            return Some(args[i + 1].clone());
        }
        if let Some((key, value)) = args[i].split_once('=') {
            if key == name {
                return Some(value.to_string());
            }
        }
        i += 1;
    }
    None
}

fn main() {
    let port: u16 = arg("--port").and_then(|p| p.parse().ok()).unwrap_or(47800);
    let data_dir = PathBuf::from(arg("--data").unwrap_or_else(|| "OmniPanelData".to_string()));
    let ui_dir = PathBuf::from(arg("--ui").unwrap_or_else(|| "ui".to_string()));

    let _ = std::fs::create_dir_all(&data_dir);
    let store_path = data_dir.join("servers.json");
    let store = Store::new(&store_path);

    let mut info = AppInfo::default();
    info.data_dir = data_dir.clone();
    info.config_path = store_path.clone();
    info.app_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));

    let app = Arc::new(App::with_store(info, store));
    /* картинки лежат в папке assets рядом с интерфейсом или с программой */
    let mut panel = PanelServer::new(Arc::clone(&app), ui_dir.clone());
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(parent) = ui_dir.parent() {
        candidates.push(parent.join("assets"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("assets"));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("assets"));
    }
    for candidate in candidates {
        panel = panel.with_assets(candidate);
    }
    let assets_found = panel.assets_found().cloned();
    let server = Arc::new(panel);

    println!("OmniPanel на Rust {} — интерфейс: {}", env!("CARGO_PKG_VERSION"), ui_dir.display());
    println!("  данные: {}", data_dir.display());
    println!("  адрес:  http://127.0.0.1:{}/", port);
    println!("  серверов в списке: {}", app.manager().servers().len());
    match assets_found {
        Some(dir) => println!("  картинки: {}", dir.display()),
        None => println!("  картинки: папка assets не найдена"),
    }

    if let Err(err) = server.serve(port) {
        eprintln!("не удалось занять порт {}: {}", port, err);
        std::process::exit(1);
    }
}
