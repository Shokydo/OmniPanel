//! Системные окна выбора файла и папки.
//!
//! Панель показывает свои окна в собственном дизайне, но выбор файла на диске
//! система умеет лучше: там диски, избранное, поиск. Поэтому здесь зовём
//! штатный диалог своей платформы. На Windows — родные окна (`win32`:
//! `SHBrowseForFolderW` и `GetOpenFileNameW`); раньше их рисовал PowerShell со
//! WinForms, из-за чего при каждом выборе мигало окно консоли.
//!
//! Если ни одного способа нет (например, панель открыта в браузере на сервере
//! без графики), отвечаем пустым списком — интерфейс тогда просто не меняет поле.

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
    pick_in(kind, title, None)
}

/// То же, но окно откроется в указанном месте (папка сервера, папка модов).
pub fn pick_in(kind: Pick, title: &str, start: Option<&std::path::Path>) -> Vec<String> {
    match std::env::consts::OS {
        "windows" => pick_windows(kind, title, start),
        "macos" => pick_macos(kind, title),
        _ => pick_linux(kind, title),
    }
}

/* ───────────────────────────── Windows ───────────────────────────── */

#[cfg(windows)]
fn pick_windows(kind: Pick, title: &str, start: Option<&std::path::Path>) -> Vec<String> {
    use crate::win32;
    match kind {
        /* «выбрать несколько папок» система одним окном не умеет — берём одну */
        Pick::Folder | Pick::Folders => win32::pick_folder(title, start)
            .map(|path| vec![path.display().to_string()])
            .unwrap_or_default(),
        Pick::File => win32::pick_file(title)
            .map(|path| vec![path.display().to_string()])
            .unwrap_or_default(),
    }
}

#[cfg(not(windows))]
fn pick_windows(_kind: Pick, _title: &str, _start: Option<&std::path::Path>) -> Vec<String> {
    Vec::new()
}

/// Оставляем только реально существующие пути: окно могло закрыться отменой.
pub fn parse_paths(lines: &[String]) -> Vec<String> {
    lines
        .iter()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
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
