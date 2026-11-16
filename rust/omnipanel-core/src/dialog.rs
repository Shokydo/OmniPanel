//! Системные окна выбора файла и папки.
//!
//! Панель показывает свои окна в собственном дизайне, но выбор файла на диске
//! система умеет лучше: там диски, избранное, поиск. Поэтому здесь зовём
//! штатный диалог своей платформы: на Windows — PowerShell с WinForms
//! (ничего ставить не надо), на Linux — zenity или kdialog, на macOS — osascript.
//!
//! Если ни одного способа нет (например, панель открыта в браузере на сервере
//! без графики), отвечаем `null` — интерфейс тогда просто не меняет поле.

use std::path::PathBuf;

/// Что просим у пользователя.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pick {
    Folder,
    File,
    Folders,
}

/// Итог выбора: пути. Пусто — пользователь отказался.
pub fn pick(kind: Pick, title: &str) -> Vec<String> {
    match std::env::consts::OS {
        "windows" => pick_windows(kind, title),
        "macos" => pick_macos(kind, title),
        _ => pick_linux(kind, title),
    }
}

/* ───────────────────────────── Windows ───────────────────────────── */

/// Скрипт PowerShell для диалога. Собирается отдельно, чтобы его можно было
/// проверить тестом: ошибка в кавычках здесь означает «кнопка молчит».
pub fn powershell_script(kind: Pick, title: &str) -> String {
    let safe = title.replace('\'', "''");
    let head = concat!(
        "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ",
        "Add-Type -AssemblyName System.Windows.Forms; ",
        "$owner = New-Object System.Windows.Forms.Form; ",
        "$owner.TopMost = $true; $owner.ShowInTaskbar = $false; ",
        "$owner.WindowState = 'Minimized'; $owner.Show(); $owner.Hide(); ",
    );
    match kind {
        Pick::Folder => format!(
            "{}$f = New-Object System.Windows.Forms.FolderBrowserDialog; \
             $f.Description = '{}'; $f.ShowNewFolderButton = $true; \
             if ($f.ShowDialog($owner) -eq 'OK') {{ 'OMNI:' + $f.SelectedPath }}; \
             $owner.Dispose()",
            head, safe
        ),
        Pick::File => format!(
            "{}$f = New-Object System.Windows.Forms.OpenFileDialog; \
             $f.Title = '{}'; $f.CheckFileExists = $true; $f.Multiselect = $false; \
             if ($f.ShowDialog($owner) -eq 'OK') {{ 'OMNI:' + $f.FileName }}; \
             $owner.Dispose()",
            head, safe
        ),
        Pick::Folders => {
            /* WinForms не умеет выбирать несколько папок — берём одну за раз */
            format!(
                "{}$f = New-Object System.Windows.Forms.FolderBrowserDialog; \
                 $f.Description = '{}'; $f.ShowNewFolderButton = $false; \
                 if ($f.ShowDialog($owner) -eq 'OK') {{ 'OMNI:' + $f.SelectedPath }}; \
                 $owner.Dispose()",
                head, safe
            )
        }
    }
}

fn pick_windows(kind: Pick, title: &str) -> Vec<String> {
    let script = powershell_script(kind, title);
    let output = run(
        "powershell",
        &["-NoProfile", "-STA", "-Command", &script],
    );
    parse_powershell(&output)
}

/// Из вывода PowerShell берём только строки с меткой: остальное — служебный шум.
pub fn parse_powershell(output: &str) -> Vec<String> {
    output
        .lines()
        .filter_map(|line| line.trim().strip_prefix("OMNI:"))
        .map(|path| path.trim().to_string())
        .filter(|path| !path.is_empty())
        .collect()
}

/* ───────────────────────────── Linux ───────────────────────────── */

fn pick_linux(kind: Pick, title: &str) -> Vec<String> {
    if which("zenity") {
        let mut args: Vec<String> = vec![
            "--file-selection".to_string(),
            format!("--title={}", title),
        ];
        if kind != Pick::File {
            args.push("--directory".to_string());
        }
        if kind == Pick::Folders {
            args.push("--multiple".to_string());
            args.push("--separator=\n".to_string());
        }
        let refs: Vec<&str> = args.iter().map(|a| a.as_str()).collect();
        let output = run("zenity", &refs);
        return split_paths(&output);
    }
    if which("kdialog") {
        let mut args: Vec<String> = vec![format!("--title={}", title)];
        match kind {
            Pick::File => args.push("--getopenfilename".to_string()),
            _ => args.push("--getexistingdirectory".to_string()),
        }
        args.push(".".to_string());
        let refs: Vec<&str> = args.iter().map(|a| a.as_str()).collect();
        let output = run("kdialog", &refs);
        return split_paths(&output);
    }
    Vec::new()
}

fn split_paths(output: &str) -> Vec<String> {
    output
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect()
}

fn which(name: &str) -> bool {
    let path = match std::env::var("PATH") {
        Ok(path) => path,
        Err(_) => return false,
    };
    std::env::split_paths(&path).any(|dir| dir.join(name).is_file())
}

/* ───────────────────────────── macOS ───────────────────────────── */

fn pick_macos(kind: Pick, title: &str) -> Vec<String> {
    let script = if kind == Pick::File {
        format!(
            "POSIX path of (choose file with prompt \"{}\")",
            title.replace('"', "")
        )
    } else {
        format!(
            "POSIX path of (choose folder with prompt \"{}\")",
            title.replace('"', "")
        )
    };
    let output = run("osascript", &["-e", &script]);
    split_paths(&output)
}

/* ───────────────────────────── запуск ───────────────────────────── */

fn run(program: &str, args: &[&str]) -> String {
    let result = std::process::Command::new(program).args(args).output();
    match result {
        Ok(output) => String::from_utf8_lossy(&output.stdout).to_string(),
        Err(_) => String::new(),
    }
}

/// Язык интерфейса — русский, поэтому и подписи в диалогах русские.
pub fn default_title(kind: Pick) -> &'static str {
    match kind {
        Pick::Folder => "Выберите папку",
        Pick::File => "Выберите файл",
        Pick::Folders => "Выберите папку или диск",
    }
}

/// Где панель ищет свои файлы при открытии диалога.
pub fn start_dir() -> PathBuf {
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}
