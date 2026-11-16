//! Системные уведомления — те, что показываются, когда окно свёрнуто.
//!
//! Внутри окна панель рисует свои уведомления, а вот когда она свёрнута в
//! трей (например, сервер упал или обновление готово), нужен системный
//! воздушный шар. Берём то, что есть в системе: PowerShell + NotifyIcon на
//! Windows, `notify-send` на Linux, `osascript` на macOS. Ничего доустанавливать
//! не нужно; если ничего нет — просто возвращаем `false`, панель не ломается.

use std::process::Command;

/// Имя приложения в уведомлениях.
pub const APP_NAME: &str = "OmniPanel";

/// Показать уведомление. Возвращает `true`, если система его приняла.
pub fn show(title: &str, text: &str) -> bool {
    let (title, text) = (clip(title), clip(text));
    #[cfg(windows)]
    {
        returns_ok(powershell(&powershell_script(&title, &text)))
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

#[cfg(windows)]
fn powershell(script: &str) -> std::io::Result<std::process::Output> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
}

/// Уведомление через значок в области уведомлений — работает без модулей.
pub fn powershell_script(title: &str, text: &str) -> String {
    format!(
        "Add-Type -AssemblyName System.Windows.Forms;\
$n = New-Object System.Windows.Forms.NotifyIcon;\
$n.Icon = [System.Drawing.SystemIcons]::Information;\
$n.BalloonTipTitle = '{}';\
$n.BalloonTipText = '{}';\
$n.Visible = $true;\
$n.ShowBalloonTip(6000);\
Start-Sleep -Milliseconds 6500;\
$n.Dispose()",
        escape_single(title),
        escape_single(text)
    )
}

/// Текст без переводов строк и без лишнего: в уведомлении одна строка.
fn clip(text: &str) -> String {
    let flat: String = text
        .chars()
        .map(|c| if c == '\n' || c == '\r' || c == '\t' { ' ' } else { c })
        .collect();
    let trimmed = flat.trim();
    if trimmed.chars().count() > 180 {
        let short: String = trimmed.chars().take(177).collect();
        format!("{}…", short)
    } else {
        trimmed.to_string()
    }
}

fn escape_single(text: &str) -> String {
    text.replace('\'', "''")
}

#[cfg(target_os = "macos")]
fn escape_osascript(text: &str) -> String {
    text.replace('\\', "\\\\").replace('"', "\\\"")
}
