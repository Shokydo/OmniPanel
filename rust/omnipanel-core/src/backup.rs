//! Бэкапы папки сервера.
//!
//! Основной формат — `.7z` с LZMA2 и максимальным сжатием: консольный 7-Zip
//! едет вместе с панелью (`assets/bin/7za.exe`), ставить ничего не нужно.
//! Если бинарника рядом не оказалось (запуск из исходников, Linux без 7-Zip),
//! панель **не ломается**: архив собирается своим zip-писателем с deflate 9.
//! Старые `.zip` и `.tar.gz` восстанавливаются всегда.
//!
//! Что не кладём в архив: `.git`, `cache`, служебный мусор систем. В «лёгком»
//! бэкапе не тащим `libraries`, `versions`, `logs`, `crash-reports` — сервер
//! восстановит их сам при первом запуске.

use crate::zip;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Сколько ждём 7-Zip: большой мир на медленном диске архивируется долго.
const TIMEOUT_SECS: u64 = 6 * 60 * 60;

/// Что не попадает в архив никогда (те же правила, что в 1.26.0).
pub const SKIP_ALWAYS: [&str; 5] = ["/.git/", "/cache/", "/.DS_Store", "/Thumbs.db", "/session.lock"];
/// Что можно не тащить в «лёгком» бэкапе.
pub const LEAN_NAMES: [&str; 4] = ["libraries", "versions", "logs", "crash-reports"];

/// Результат подсчёта: сколько файлов и байт реально попадёт в архив.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Count {
    pub files: u64,
    pub bytes: u64,
}

/// Сводка по готовому архиву — то, что показывает интерфейс.
#[derive(Debug, Clone, Default)]
pub struct Info {
    pub file: PathBuf,
    pub name: String,
    pub size: u64,
    pub created_at: u64,
    pub sha256: String,
    pub files: u64,
    pub raw: u64,
    pub format: String,
    pub packer: String,
    pub parts: Vec<PathBuf>,
    pub warning: String,
    pub ratio: f64,
}

impl Info {
    pub fn to_json(&self) -> crate::json::Value {
        use crate::json::Value;
        let mut fields = vec![
            ("ok", Value::Bool(true)),
            ("file", Value::str(self.file.to_string_lossy())),
            ("name", Value::str(&self.name)),
            ("size", Value::from(self.size)),
            ("createdAt", Value::from(self.created_at)),
            ("sha256", Value::str(&self.sha256)),
            ("files", Value::from(self.files)),
            ("raw", Value::from(self.raw)),
            ("format", Value::str(&self.format)),
            ("packer", Value::str(&self.packer)),
            ("ratio", Value::Num(self.ratio)),
            ("warning", Value::str(&self.warning)),
        ];
        fields.push((
            "parts",
            Value::Arr(
                self.parts
                    .iter()
                    .map(|p| Value::str(p.to_string_lossy()))
                    .collect(),
            ),
        ));
        fields.push((
            "partNames",
            Value::Arr(
                self.parts
                    .iter()
                    .map(|p| {
                        Value::str(
                            p.file_name()
                                .map(|n| n.to_string_lossy().to_string())
                                .unwrap_or_default(),
                        )
                    })
                    .collect(),
            ),
        ));
        Value::obj(fields)
    }
}

/* ───────────────────────── 7-Zip рядом с панелью ───────────────────────── */

/// Путь к 7-Zip: свой рядом с панелью, иначе из PATH. Пусто — не нашли.
pub fn binary() -> Option<PathBuf> {
    let exe = if cfg!(windows) { "7za.exe" } else { "7za" };
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = std::env::current_exe() {
        if let Some(folder) = dir.parent() {
            candidates.push(folder.join("assets").join("bin").join(exe));
            candidates.push(folder.join("bin").join(exe));
            candidates.push(folder.join(exe));
        }
    }
    candidates.push(PathBuf::from("assets").join("bin").join(exe));
    for path in candidates {
        if path.is_file() {
            return Some(path);
        }
    }
    /* ищем в PATH так же, как прежняя панель */
    let names: &[&str] = if cfg!(windows) { &["7za", "7z"] } else { &["7z", "7za", "7zr"] };
    let separator = if cfg!(windows) { ';' } else { ':' };
    let path_var = std::env::var("PATH").unwrap_or_default();
    for name in names {
        for dir in path_var.split(separator).filter(|d| !d.is_empty()) {
            let full = Path::new(dir).join(name);
            for candidate in [full.clone(), full.with_extension("exe")] {
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

/// Есть ли 7-Zip. От этого зависит, будет архив плотным или zip.
pub fn available() -> bool {
    binary().is_some()
}

fn run(args: &[String]) -> Result<String, String> {
    let Some(binary) = binary() else {
        return Err("7-Zip не найден".to_string());
    };
    let mut command = Command::new(binary);
    command.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command
        .output()
        .map_err(|err| format!("7-Zip не запустился: {}", err))?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).to_string());
    }
    let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if error.is_empty() {
        "Ошибка архивации".to_string()
    } else {
        error
    })
}

/* ───────────────────────────── имена и подсчёты ───────────────────────── */

/// Имя папки/сервера для архива: только буквы, цифры, дефис и подчёркивание.
pub fn slug(text: &str) -> String {
    let cleaned: String = text
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(40)
        .collect();
    if cleaned.is_empty() {
        "server".to_string()
    } else {
        cleaned
    }
}

/// Отметка времени `2026-11-14_21-30-05` — по ней архивы идут по порядку.
pub fn stamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    stamp_from(now)
}

/// Считает файлы и байты, которые попадут в архив (без служебного мусора).
pub fn measure(src: &Path, skip_lean: bool) -> Count {
    let mut count = Count::default();
    let mut stack = vec![String::new()];
    while let Some(rel) = stack.pop() {
        let dir = if rel.is_empty() { src.to_path_buf() } else { src.join(&rel) };
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let sub = if rel.is_empty() { name.clone() } else { format!("{}/{}", rel, name) };
            if skipped(&sub, skip_lean) {
                continue;
            }
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                stack.push(sub);
                continue;
            }
            if !kind.is_file() {
                /* символические ссылки не считаем и не пакуем */
                continue;
            }
            if let Ok(meta) = entry.metadata() {
                count.bytes += meta.len();
                count.files += 1;
            }
        }
    }
    count
}

/// Служебный ли путь: то, что не пакуем.
pub fn skipped(rel: &str, skip_lean: bool) -> bool {
    let marked = format!("/{}/", rel.replace('\\', "/"));
    if SKIP_ALWAYS
        .iter()
        .any(|rule| marked.contains(rule) || rel.ends_with(rule))
    {
        return true;
    }
    if rel.ends_with("/.DS_Store") || rel.ends_with("/Thumbs.db") || rel.ends_with("/session.lock") {
        return true;
    }
    if skip_lean {
        for name in LEAN_NAMES {
            if rel == name || rel.starts_with(&format!("{}/", name)) {
                return true;
            }
        }
    }
    false
}

/// Размер папки: сколько байт и файлов (для предупреждения перед бэкапом).
pub fn dir_size(dir: &Path) -> Count {
    let mut count = Count::default();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&current) else { continue };
        for entry in entries.flatten() {
            match entry.file_type() {
                Ok(kind) if kind.is_dir() => stack.push(entry.path()),
                Ok(kind) if kind.is_file() => {
                    if let Ok(meta) = entry.metadata() {
                        count.bytes += meta.len();
                        count.files += 1;
                    }
                }
                _ => {}
            }
        }
    }
    count
}

/// Самое тяжёлое в папке сервера: чтобы человек видел, из-за чего архив большой.
pub fn top_dirs(src: &Path, count: usize) -> Vec<(String, Count)> {
    let Ok(entries) = std::fs::read_dir(src) else { return Vec::new() };
    let mut list: Vec<(String, Count)> = entries
        .flatten()
        .filter(|e| e.file_type().map(|k| k.is_dir()).unwrap_or(false))
        .map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let size = dir_size(&e.path());
            (name, size)
        })
        .filter(|(_, size)| size.bytes > 0)
        .collect();
    list.sort_by(|a, b| b.1.bytes.cmp(&a.1.bytes));
    list.truncate(count);
    list
}

/* ───────────────────────────── список архивов ───────────────────────── */

/// Один архив в списке.
#[derive(Debug, Clone, PartialEq)]
pub struct Backup {
    pub file: PathBuf,
    pub name: String,
    pub size: u64,
    pub created_at: u64,
    pub parts: usize,
}

impl Backup {
    pub fn to_json(&self) -> crate::json::Value {
        use crate::json::Value;
        Value::obj(vec![
            ("file", Value::str(self.file.to_string_lossy())),
            ("name", Value::str(&self.name)),
            ("size", Value::from(self.size)),
            ("createdAt", Value::from(self.created_at)),
            ("parts", Value::Num(self.parts as f64)),
        ])
    }
}

/// Тома разбитого архива: `мир.7z.001`, `мир.7z.002`…
pub fn volumes(base: &Path) -> Vec<PathBuf> {
    let (Some(dir), Some(name)) = (base.parent(), base.file_name()) else {
        return Vec::new();
    };
    let prefix = format!("{}.", name.to_string_lossy());
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut parts: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| {
            let file = e.file_name().to_string_lossy().to_string();
            file.starts_with(&prefix) && file.len() == prefix.len() + 3
                && file[prefix.len()..].chars().all(|c| c.is_ascii_digit())
        })
        .map(|e| e.path())
        .collect();
    parts.sort();
    parts
}

fn modified(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Список архивов сервера, свежие сверху.
pub fn list(dir: &Path) -> Vec<Backup> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<Backup> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let lower = name.to_lowercase();
            let is_part = lower.ends_with(".7z.001");
            let is_single = lower.ends_with(".7z") || lower.ends_with(".zip") || lower.ends_with(".tar.gz");
            if !is_part && !is_single {
                /* второй и следующий тома разбитого архива отдельной строкой не показываем */
                return None;
            }
            let file = entry.path();
            let parts = if is_part {
                volumes(&file.with_file_name(name.trim_end_matches(".001")))
            } else {
                Vec::new()
            };
            let size = if parts.is_empty() {
                entry.metadata().map(|m| m.len()).unwrap_or(0)
            } else {
                parts
                    .iter()
                    .filter_map(|p| std::fs::metadata(p).ok().map(|m| m.len()))
                    .sum()
            };
            Some(Backup {
                created_at: modified(&file),
                file,
                name,
                size,
                parts: parts.len(),
            })
        })
        .collect();
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    out
}

/* ────────────────────────────── создание ────────────────────────────── */

/// Создаёт архив папки сервера. `format`: `auto`, `7z` или `zip`.
pub fn create(
    src: &Path,
    dest: &Path,
    label: &str,
    lean: bool,
    format: &str,
    volume_mb: u64,
) -> Result<Info, String> {
    if !src.is_dir() {
        return Err(format!("Папка сервера не найдена: {}", src.display()));
    }
    std::fs::create_dir_all(dest).map_err(|err| format!("Не удалось создать папку бэкапов: {}", err))?;

    let use_7z = format == "7z" || (format != "zip" && available());
    let name = format!(
        "{}_{}.{}",
        slug(label),
        stamp(),
        if use_7z { "7z" } else { "zip" }
    );
    let file = dest.join(&name);
    let count = measure(src, lean);

    if use_7z {
        let tmp = PathBuf::from(format!("{}.part", file.display()));
        match seven_pack(src, &tmp, lean, volume_mb) {
            Ok(parts) if parts.len() == 1 => {
                let one = parts[0].clone();
                std::fs::rename(&one, &file)
                    .map_err(|err| format!("Не удалось переименовать архив: {}", err))?;
                return Ok(finish(&file, count, "7z lzma2", "", Vec::new()));
            }
            Ok(parts) => {
                let mut renamed: Vec<PathBuf> = Vec::new();
                for (index, part) in parts.iter().enumerate() {
                    let target = PathBuf::from(format!("{}.{:03}", file.display(), index + 1));
                    std::fs::rename(part, &target)
                        .map_err(|err| format!("Не удалось переименовать том: {}", err))?;
                    renamed.push(target);
                }
                let first = renamed[0].clone();
                return Ok(finish(&first, count, "7z lzma2", "", renamed));
            }
            Err(err) => {
                /* 7-Zip не справился (права, антивирус, битый бинарник) —
                   бэкап всё равно обязан появиться */
                for part in volumes(&tmp) {
                    let _ = std::fs::remove_file(part);
                }
                let _ = std::fs::remove_file(&tmp);
                let fallback = dest.join(name.replace(".7z", ".zip"));
                let part = PathBuf::from(format!("{}.part", fallback.display()));
                let warning = format!("7-Zip не сработал — {}", err);
                zip_pack(src, &part, lean)?;
                std::fs::rename(&part, &fallback)
                    .map_err(|err| format!("Не удалось переименовать архив: {}", err))?;
                return Ok(finish(&fallback, count, "zip deflate", &warning, Vec::new()));
            }
        }
    }

    let part = PathBuf::from(format!("{}.part", file.display()));
    zip_pack(src, &part, lean)?;
    std::fs::rename(&part, &file).map_err(|err| format!("Не удалось переименовать архив: {}", err))?;
    Ok(finish(&file, count, "zip deflate", "", Vec::new()))
}

/// Архив через 7-Zip: LZMA2, максимум сжатия, при нужде — тома.
fn seven_pack(src: &Path, out: &Path, lean: bool, volume_mb: u64) -> Result<Vec<PathBuf>, String> {
    let mut args: Vec<String> = vec![
        "a".to_string(),
        "-t7z".to_string(),
        "-m0=lzma2".to_string(),
        "-mx=9".to_string(),
        "-md=64m".to_string(),
        "-mfb=64".to_string(),
        "-ms=on".to_string(),
        "-y".to_string(),
        "-bd".to_string(),
    ];
    if volume_mb > 0 {
        args.push(format!("-v{}m", volume_mb));
    }
    if lean {
        for name in LEAN_NAMES {
            args.push(format!("-x!{}", name));
        }
    }
    args.push("-x!.git".to_string());
    args.push("-x!cache".to_string());
    args.push(out.to_string_lossy().to_string());
    args.push(format!("{}/*", src.display()));
    let base = out.to_string_lossy().to_string();
    if volume_mb > 0 {
        let _ = std::fs::remove_file(out);
    }
    run(&args)?;
    let parts = volumes(&PathBuf::from(&base));
    if parts.is_empty() {
        if out.is_file() {
            return Ok(vec![out.to_path_buf()]);
        }
        return Err("7-Zip не создал архив".to_string());
    }
    Ok(parts)
}

/// Запасной архиватор: свой zip с deflate 9. Ставит файлы без служебного мусора.
fn zip_pack(src: &Path, out: &Path, lean: bool) -> Result<(), String> {
    let mut files: Vec<(PathBuf, String)> = Vec::new();
    let mut stack = vec![String::new()];
    while let Some(rel) = stack.pop() {
        let dir = if rel.is_empty() { src.to_path_buf() } else { src.join(&rel) };
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let sub = if rel.is_empty() { name.clone() } else { format!("{}/{}", rel, name) };
            if skipped(&sub, lean) {
                continue;
            }
            match entry.file_type() {
                Ok(kind) if kind.is_dir() => stack.push(sub),
                Ok(kind) if kind.is_file() => files.push((entry.path(), sub)),
                _ => {}
            }
        }
    }
    files.sort_by(|a, b| a.1.cmp(&b.1));
    let inputs: Vec<zip::InputFile> = files
        .iter()
        .map(|(full, rel)| zip::InputFile {
            name: rel.clone(),
            path: full.clone(),
        })
        .collect();
    /* архив пишется сразу в нужный файл: сначала `.part`, потом переименуем */
    let _ = std::fs::remove_file(out);
    zip::create_from_files(out, &inputs)?;
    if !out.is_file() {
        return Err("Архив не создался".to_string());
    }
    Ok(())
}

fn finish(file: &Path, count: Count, packer: &str, warning: &str, parts: Vec<PathBuf>) -> Info {
    let list: Vec<PathBuf> = if parts.is_empty() { vec![file.to_path_buf()] } else { parts };
    let size: u64 = list
        .iter()
        .filter_map(|p| std::fs::metadata(p).ok().map(|m| m.len()))
        .sum();
    let hash = std::fs::read(file)
        .ok()
        .map(|bytes| crate::sha256::hex(&crate::sha256::digest(&bytes)))
        .unwrap_or_default();
    let ratio = if count.bytes > 0 && size > 0 {
        ((count.bytes as f64 / size as f64) * 100.0).round() / 100.0
    } else {
        0.0
    };
    let name = file
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let format = if name.to_lowercase().contains(".7z") { "7z" } else { "zip" };
    Info {
        file: file.to_path_buf(),
        name,
        size,
        created_at: modified(file),
        sha256: hash,
        files: count.files,
        raw: count.bytes,
        format: format.to_string(),
        packer: packer.to_string(),
        parts: if list.len() > 1 { list } else { Vec::new() },
        warning: warning.to_string(),
        ratio,
    }
}

/* ────────────────────────────── восстановление ────────────────────────── */

/// Распаковывает архив в папку сервера (существующие файлы перезаписываются).
pub fn restore(file: &Path, dest: &Path) -> Result<bool, String> {
    if !file.is_file() {
        return Err("Файл бэкапа не найден".to_string());
    }
    std::fs::create_dir_all(dest).map_err(|err| format!("Не удалось создать папку: {}", err))?;
    let lower = file.to_string_lossy().to_lowercase();
    if lower.contains(".7z") {
        if !available() {
            return Err("Для .7z нужен 7-Zip рядом с панелью или в PATH".to_string());
        }
        let args = vec![
            "x".to_string(),
            "-y".to_string(),
            "-bd".to_string(),
            format!("-o{}", dest.display()),
            file.to_string_lossy().to_string(),
        ];
        run(&args)?;
        return Ok(true);
    }
    if lower.ends_with(".zip") {
        let data = std::fs::read(file).map_err(|err| format!("Не удалось прочитать архив: {}", err))?;
        zip::extract(&data, dest, "")?;
        return Ok(true);
    }
    /* старые архивы .tar.gz — только системным tar */
    let mut command = Command::new("tar");
    command.args(["-xzf"]).arg(file).arg("-C").arg(dest);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command.output().map_err(|err| format!("tar не запустился: {}", err))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(true)
}

/// Удаляет архив; у разбитого — все тома, иначе они останутся мусором.
pub fn delete(file: &Path) -> bool {
    let lower = file.to_string_lossy().to_lowercase();
    let mut removed = false;
    if lower.ends_with(".7z.001") || lower.ends_with(".7z.002") {
        let base = PathBuf::from(file.to_string_lossy().trim_end_matches(|c: char| c.is_ascii_digit() || c == '.').to_string());
        let base = if base.extension().is_none() {
            file.with_file_name(
                file.file_name()
                    .map(|n| n.to_string_lossy().trim_end_matches(|c: char| c.is_ascii_digit() || c == '.').to_string())
                    .unwrap_or_default(),
            )
        } else {
            base
        };
        for part in volumes(&base) {
            if std::fs::remove_file(part).is_ok() {
                removed = true;
            }
        }
        return removed;
    }
    std::fs::remove_file(file).is_ok()
}

/// Читает первые байты архива — пригодится, чтобы не путать форматы.
pub fn peek(file: &Path, limit: usize) -> Vec<u8> {
    let mut buffer = Vec::new();
    if let Ok(handle) = std::fs::File::open(file) {
        let mut handle = handle;
        let mut chunk = vec![0u8; limit];
        if let Ok(read) = handle.read(&mut chunk) {
            buffer.extend_from_slice(&chunk[..read]);
        }
    }
    buffer
}

/// Время в формате отметки архива: 2026-11-14_21-30-05 (местное время не
/// нужно — важно только, чтобы архивы сортировались по порядку).
pub fn stamp_from(seconds: u64) -> String {
    let days = (seconds / 86_400) as i64;
    let rest = seconds % 86_400;
    let (hour, minute, second) = (rest / 3600, (rest % 3600) / 60, rest % 60);
    /* перевод дней в дату — обычный гражданский календарь */
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    format!(
        "{:04}-{:02}-{:02}_{:02}-{:02}-{:02}",
        year, month, day, hour, minute, second
    )
}

/// Сколько секунд ждём внешний архиватор.
pub const fn timeout_secs() -> u64 {
    TIMEOUT_SECS
}
