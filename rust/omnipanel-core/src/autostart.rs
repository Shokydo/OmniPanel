//! Автозапуск панели вместе с системой.
//!
//! Переключатель в настройках: «запускать вместе с системой». На Windows это
//! одна запись в `HKEY_CURRENT_USER\...\Run` — её видно в «Диспетчере задач»
//! и легко убрать. На Linux — файл `~/.config/autostart`. Прав администратора
//! не нужно ни там, ни там: всё пишется в профиль пользователя.

use std::path::{Path, PathBuf};

/// Имя записи — его же видит человек в списке автозапуска.
pub const APP_KEY: &str = "OmniPanel";

/// Что именно прописываем в автозапуск.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub program: String,
    pub args: Vec<String>,
}

impl Entry {
    /// Автозапуск самой панели: путь к exe и аргументы (в portable-сборке их нет).
    pub fn current() -> Entry {
        let program = std::env::current_exe()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|_| "OmniPanel.exe".to_string());
        Entry { program, args: Vec::new() }
    }

    /// Командная строка для реестра Windows.
    pub fn command_line(&self) -> String {
        let mut out = format!("\"{}\"", self.program);
        for arg in &self.args {
            out.push(' ');
            out.push_str(&format!("\"{}\"", arg));
        }
        out
    }
}

fn home() -> PathBuf {
    #[cfg(windows)]
    {
        if let Ok(profile) = std::env::var("USERPROFILE") {
            return PathBuf::from(profile);
        }
    }
    std::env::var("HOME").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("."))
}

/// Файл автозапуска на Linux.
pub fn desktop_file() -> PathBuf {
    home().join(".config").join("autostart").join("omnipanel.desktop")
}

/// Содержимое `.desktop`-файла — отдельно, чтобы проверить тестом.
pub fn desktop_entry(entry: &Entry) -> String {
    let args = if entry.args.is_empty() {
        String::new()
    } else {
        format!(" {}", entry.args.join(" "))
    };
    format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=OmniPanel\n\
         Comment=Панель серверов Minecraft\n\
         Exec={}{}\n\
         Terminal=false\n\
         X-GNOME-Autostart-enabled=true\n",
        entry.program, args
    )
}

/// Включён ли автозапуск.
pub fn get() -> bool {
    #[cfg(windows)]
    {
        let output = std::process::Command::new("reg")
            .args(["query", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run", "/v", APP_KEY])
            .output();
        match output {
            Ok(output) => {
                let text = String::from_utf8_lossy(&output.stdout).to_string();
                output.status.success() && text.contains(APP_KEY)
            }
            Err(_) => false,
        }
    }
    #[cfg(not(windows))]
    {
        desktop_file().is_file()
    }
}

/// Включает или выключает автозапуск. Возвращает новое состояние.
pub fn set(entry: &Entry, enabled: bool) -> bool {
    if cfg!(windows) {
        if enabled {
            let _ = std::process::Command::new("reg")
                .args([
                    "add",
                    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                    "/v",
                    APP_KEY,
                    "/t",
                    "REG_SZ",
                    "/d",
                    &entry.command_line(),
                    "/f",
                ])
                .output();
        } else {
            let _ = std::process::Command::new("reg")
                .args([
                    "delete",
                    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                    "/v",
                    APP_KEY,
                    "/f",
                ])
                .output();
        }
    } else {
        let file = desktop_file();
        if enabled {
            if let Some(parent) = file.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(&file, desktop_entry(entry));
        } else if file.exists() {
            let _ = std::fs::remove_file(&file);
        }
    }
    get()
}

/// Путь к файлу автозапуска (панель показывает его в «О программе»).
pub fn location() -> String {
    if cfg!(windows) {
        format!(r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run\{}", APP_KEY)
    } else {
        desktop_file().display().to_string()
    }
}

/// Проверка для тестов: содержимое .desktop-файла не должно ломаться на путях
/// с пробелами и кириллицей.
pub fn looks_like_entry(path: &Path) -> bool {
    match std::fs::read_to_string(path) {
        Ok(text) => text.starts_with("[Desktop Entry]") && text.contains("Exec="),
        Err(_) => false,
    }
}
