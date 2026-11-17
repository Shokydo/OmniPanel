//! Системные уведомления — те, что показываются, когда окно свёрнуто.
//!
//! Внутри окна панель рисует свои уведомления, а вот когда она свёрнута в
//! трей (например, сервер упал или обновление готово), нужен системный
//! воздушный шар. На Windows — родной `Shell_NotifyIconW` (без PowerShell,
//! раньше из-за него мигало окно консоли), на Linux — `notify-send`, на macOS —
//! `osascript`. Ничего доустанавливать не нужно; если ничего нет — просто
//! возвращаем `false`, панель не ломается.

use std::process::Command;

/// Имя приложения в уведомлениях.
pub const APP_NAME: &str = "OmniPanel";

/// Показать уведомление. Возвращает `true`, если система его приняла.
pub fn show(title: &str, text: &str) -> bool {
    let (title, text) = (clip(title), clip(text));
    #[cfg(windows)]
    {
        crate::win32::balloon(&title, &text)
    }
    #[cfg(target_os = "macos")]
    {
        returns_ok(
            Command::new("osascript")
                .arg("-e")
                .arg(format!(
                    "display notification \"{}\" with title \"{}\"",
                    escape_osascript(&text),
                    escape_osascript(&title)
                ))
                .output(),
        )
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        returns_ok(
            Command::new("notify-send")
                .arg("-a")
                .arg(APP_NAME)
                .arg(&title)
                .arg(&text)
                .output(),
        )
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (title, text);
        false
    }
}

fn returns_ok(result: std::io::Result<std::process::Output>) -> bool {
    matches!(result, Ok(out) if out.status.success())
}

#[cfg(target_os = "macos")]
fn escape_osascript(text: &str) -> String {
    text.replace('\\', "\\\\").replace('"', "\\\"")
}
/// Обрезаем слишком длинный текст: шар в области уведомлений не резиновый.
fn clip(text: &str) -> String {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let line: String = text.lines().take(3).collect::<Vec<_>>().join("\n");
    if line.chars().count() > 240 {
        line.chars().take(240).collect::<String>() + "…"
    } else {
        line
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn длинный_текст_обрезается() {
        let long = "я".repeat(500);
        let short = clip(&long);
        assert!(short.chars().count() <= 241, "не обрезалось: {}", short.chars().count());
        assert!(short.ends_with('…'));
    }

    #[test]
    fn лишние_строки_убираются() {
        assert_eq!(clip("раз\nдва\nтри\nчетыре"), "раз\nдва\nтри");
    }
}
