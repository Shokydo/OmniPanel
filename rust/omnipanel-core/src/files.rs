//! Файлы сервера: безопасные пути, чтение, запись, поиск, перенос.
//!
//! Главное правило: ни один путь не может выйти за папку сервера. Раньше это
//! проверялось строками в JS, теперь — здесь, и проверка общая для всех операций.

use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Что пошло не так при работе с файлами.
#[derive(Debug)]
pub enum FileError {
    /// Путь пытается выйти за папку сервера (`../`, абсолютный путь и т. п.).
    Outside(String),
    /// Файл или папка не найдены.
    NotFound(String),
    /// Это папка, а ожидался файл (или наоборот).
    WrongType(String),
    /// Файл слишком большой для просмотра в панели.
    TooLarge(u64),
    /// Ошибка файловой системы.
    Io(String),
}

impl std::fmt::Display for FileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FileError::Outside(p) => write!(f, "путь вне папки сервера: {p}"),
            FileError::NotFound(p) => write!(f, "не найдено: {p}"),
            FileError::WrongType(p) => write!(f, "не тот тип файла: {p}"),
            FileError::TooLarge(n) => write!(f, "файл слишком большой: {n} байт"),
            FileError::Io(e) => write!(f, "ошибка файловой системы: {e}"),
        }
    }
}

impl std::error::Error for FileError {}

impl From<io::Error> for FileError {
    fn from(err: io::Error) -> Self {
        match err.kind() {
            io::ErrorKind::NotFound => FileError::NotFound(err.to_string()),
            _ => FileError::Io(err.to_string()),
        }
    }
}

/// Одна строка списка файлов — то, что показывает панель.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub name: String,
    pub rel: String,
    pub dir: bool,
    pub size: u64,
    pub modified: u64,
}

/// Предел на файл, который панель открывает в редакторе (16 МБ, как в панели).
pub const READ_LIMIT: u64 = 16 * 1024 * 1024;

/// Предел на запись файла из редактора (32 МБ).
pub const WRITE_LIMIT: u64 = 32 * 1024 * 1024;

/// Старое имя предела чтения — оставлено, чтобы не ломать прежние вызовы.
pub const MAX_TEXT: u64 = READ_LIMIT;

/// Картинки показываем до 12 МБ, как в панели.
pub const IMAGE_LIMIT: u64 = 12 * 1024 * 1024;

/// Работа с папкой одного сервера.
#[derive(Debug, Clone)]
pub struct Files {
    root: PathBuf,
}

impl Files {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Files { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Превращает путь из интерфейса в настоящий путь внутри папки сервера.
    ///
    /// Точки и `..` схлопываются вручную, а не по файловой системе: так нельзя
    /// обмануть проверку символической ссылкой на этом шаге.
    pub fn resolve(&self, rel: &str) -> Result<PathBuf, FileError> {
        let rel = rel.replace('\\', "/");
        let mut parts: Vec<String> = Vec::new();
        for part in rel.split('/') {
            match part {
                "" | "." => continue,
                ".." => {
                    if parts.pop().is_none() {
                        return Err(FileError::Outside(rel.clone()));
                    }
                }
                _ => {
                    if part.contains(':') {
                        return Err(FileError::Outside(rel.clone()));
                    }
                    parts.push(part.to_string());
                }
            }
        }
        let mut path = self.root.clone();
        for part in parts {
            path.push(part);
        }
        if !path.starts_with(&self.root) {
            return Err(FileError::Outside(rel));
        }
        Ok(path)
    }

    /// Список папки: сначала папки, потом файлы, по алфавиту (как в проводнике).
    pub fn list(&self, rel: &str) -> Result<Vec<Entry>, FileError> {
        let dir = self.resolve(rel)?;
        let read = match fs::read_dir(&dir) {
            Ok(r) => r,
            Err(err) if err.kind() == io::ErrorKind::NotFound => {
                return Err(FileError::NotFound(rel.to_string()))
            }
            Err(err) => return Err(err.into()),
        };
        let base = rel.trim_matches('/').replace('\\', "/");
        let mut out = Vec::new();
        for item in read {
            let item = item?;
            let name = item.file_name().to_string_lossy().to_string();
            let meta = match item.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            out.push(Entry {
                name: name.clone(),
                rel: if base.is_empty() { name } else { format!("{base}/{name}") },
                dir: meta.is_dir(),
                size: if meta.is_file() { meta.len() } else { 0 },
                modified,
            });
        }
        out.sort_by(|a, b| match (a.dir, b.dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });
        Ok(out)
    }

    /// Читает текстовый файл (не больше [`READ_LIMIT`]).
    pub fn read_text(&self, rel: &str) -> Result<String, FileError> {
        let path = self.resolve(rel)?;
        let meta = fs::metadata(&path)?;
        if meta.is_dir() {
            return Err(FileError::WrongType(rel.to_string()));
        }
        if meta.len() > READ_LIMIT {
            return Err(FileError::TooLarge(meta.len()));
        }
        let bytes = fs::read(&path)?;
        Ok(decode_bytes(&bytes))
    }

    /// Размер и время изменения файла (мс от 1970 года).
    pub fn meta(&self, rel: &str) -> Result<(u64, u64), FileError> {
        let path = self.resolve(rel)?;
        let meta = fs::metadata(&path)?;
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        Ok((meta.len(), modified))
    }

    /// Читает файл как байты (картинки, архивы).
    pub fn read_bytes(&self, rel: &str) -> Result<Vec<u8>, FileError> {
        let path = self.resolve(rel)?;
        let meta = fs::metadata(&path)?;
        if meta.is_dir() {
            return Err(FileError::WrongType(rel.to_string()));
        }
        Ok(fs::read(&path)?)
    }

    /// Записывает текст: папки на пути создаются сами.
    pub fn write_text(&self, rel: &str, text: &str) -> Result<u64, FileError> {
        let path = self.resolve(rel)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&path, text.as_bytes())?;
        Ok(text.len() as u64)
    }

    /// Создаёт папку.
    pub fn mkdir(&self, rel: &str) -> Result<(), FileError> {
        let path = self.resolve(rel)?;
        fs::create_dir_all(path)?;
        Ok(())
    }

    /// Удаляет файл или папку вместе с содержимым.
    pub fn remove(&self, rel: &str) -> Result<(), FileError> {
        let path = self.resolve(rel)?;
        if path == self.root {
            return Err(FileError::Outside(rel.to_string()));
        }
        if path.is_dir() {
            fs::remove_dir_all(path)?;
        } else if path.exists() {
            fs::remove_file(path)?;
        } else {
            return Err(FileError::NotFound(rel.to_string()));
        }
        Ok(())
    }

    /// Переименовывает в пределах той же папки.
    pub fn rename(&self, rel: &str, new_name: &str) -> Result<String, FileError> {
        let name = new_name.trim();
        if name.is_empty() || name.contains('/') || name.contains('\\') || name == "." || name == ".." {
            return Err(FileError::Outside(new_name.to_string()));
        }
        let from = self.resolve(rel)?;
        let to = match from.parent() {
            Some(parent) => parent.join(name),
            None => return Err(FileError::Outside(rel.to_string())),
        };
        if to.exists() {
            return Err(FileError::Io(format!("в папке уже есть «{name}»")));
        }
        fs::rename(&from, &to)?;
        Ok(relative_to(&self.root, &to))
    }

    /// Переносит файл или папку в другую папку сервера.
    pub fn move_to(&self, rel: &str, dest_dir: &str) -> Result<String, FileError> {
        let from = self.resolve(rel)?;
        let dest = self.resolve(dest_dir)?;
        if !dest.is_dir() {
            return Err(FileError::WrongType(dest_dir.to_string()));
        }
        let name = from
            .file_name()
            .ok_or_else(|| FileError::Outside(rel.to_string()))?
            .to_os_string();
        let to = dest.join(&name);
        if to == from {
            return Ok(relative_to(&self.root, &to));
        }
        if to.exists() {
            return Err(FileError::Io(format!(
                "в папке уже есть «{}»",
                name.to_string_lossy()
            )));
        }
        /* папку внутрь себя переносить нельзя */
        if from.is_dir() && to.starts_with(&from) {
            return Err(FileError::Io("нельзя перенести папку внутрь себя".into()));
        }
        if fs::rename(&from, &to).is_err() {
            /* другой диск: копируем и убираем исходник */
            copy_tree(&from, &to)?;
            if from.is_dir() {
                fs::remove_dir_all(&from)?;
            } else {
                fs::remove_file(&from)?;
            }
        }
        Ok(relative_to(&self.root, &to))
    }

    /// Ищет файлы по части имени (без учёта регистра), до `limit` штук.
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<Entry>, FileError> {
        let needle = query.trim().to_lowercase();
        if needle.is_empty() {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        let mut stack = vec![String::new()];
        while let Some(rel) = stack.pop() {
            if out.len() >= limit {
                break;
            }
            let list = match self.list(&rel) {
                Ok(l) => l,
                Err(_) => continue,
            };
            for entry in list {
                if entry.dir {
                    stack.push(entry.rel.clone());
                } else if entry.name.to_lowercase().contains(&needle) {
                    out.push(entry);
                    if out.len() >= limit {
                        break;
                    }
                }
            }
        }
        Ok(out)
    }

    /// Сколько всего файлов и байт в папке (для бэкапов и синхронизации).
    pub fn dir_signature(&self) -> (u64, u64, u64) {
        let mut files = 0u64;
        let mut bytes = 0u64;
        let mut newest = 0u64;
        let mut stack = vec![String::new()];
        while let Some(rel) = stack.pop() {
            let list = match self.list(&rel) {
                Ok(l) => l,
                Err(_) => continue,
            };
            for entry in list {
                if entry.dir {
                    stack.push(entry.rel);
                } else {
                    files += 1;
                    bytes += entry.size;
                    newest = newest.max(entry.modified);
                }
            }
        }
        (files, bytes, newest)
    }
}

/// Путь относительно корня — в том виде, в котором его понимает интерфейс.
fn relative_to(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .filter_map(|c| match c {
            Component::Normal(part) => Some(part.to_string_lossy().to_string()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// Текст в UTF-8; если файл в другой кодировке — читаем как Windows-1251.
pub fn decode_bytes(bytes: &[u8]) -> String {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.strip_prefix('\u{feff}').unwrap_or(text).to_string();
    }
    bytes.iter().map(|b| cp1251(*b)).collect()
}

/// Windows-1251 для русских логов сервера.
fn cp1251(byte: u8) -> char {
    if byte < 0x80 {
        return byte as char;
    }
    const TABLE: [char; 128] = [
        'Ђ', 'Ѓ', '‚', 'ѓ', '„', '…', '†', '‡', '€', '‰', 'Љ', '‹', 'Њ', 'Ќ', 'Ћ', 'Џ', 'ђ', '‘', '’', '“', '”',
        '•', '–', '—', '', '™', 'љ', '›', 'њ', 'ќ', 'ћ', 'џ', ' ', 'Ў', 'ў', 'Ј', '¤', 'Ґ', '¦', '§', 'Ё', '©',
        'Є', '«', '¬', '­', '®', 'Ї', '°', '±', 'І', 'і', 'ґ', 'µ', '¶', '·', 'ё', '№', 'є', '»', 'ј', 'Ѕ', 'ѕ',
        'ї', 'А', 'Б', 'В', 'Г', 'Д', 'Е', 'Ж', 'З', 'И', 'Й', 'К', 'Л', 'М', 'Н', 'О', 'П', 'Р', 'С', 'Т', 'У', 'Ф',
        'Х', 'Ц', 'Ч', 'Ш', 'Щ', 'Ъ', 'Ы', 'Ь', 'Э', 'Ю', 'Я', 'а', 'б', 'в', 'г', 'д', 'е', 'ж', 'з', 'и', 'й', 'к',
        'л', 'м', 'н', 'о', 'п', 'р', 'с', 'т', 'у', 'ф', 'х', 'ц', 'ч', 'ш', 'щ', 'ъ', 'ы', 'ь', 'э', 'ю', 'я',
    ];
    TABLE[(byte - 0x80) as usize]
}

/// Вид файла по расширению — чтобы в дереве были те же значки, что раньше.
pub fn kind_of(name: &str) -> &'static str {
    let ext = match name.rsplit_once('.') {
        Some((_, e)) if !name.starts_with('.') => e.to_lowercase(),
        _ => return "text",
    };
    let ext = ext.as_str();
    match ext {
        "yml" | "yaml" => "yaml",
        "json" | "json5" => "json",
        "properties" | "env" | "conf" | "ini" | "cfg" | "toml" => "properties",
        "txt" | "log" | "md" | "mcfunction" | "sh" | "bat" => "text",
        "js" | "mjs" | "ts" => "js",
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "ico" => "image",
        "zip" | "jar" | "mcpack" | "whl" | "epub" => "archive",
        "rar" | "7z" | "tar" | "gz" | "tgz" | "bz2" | "xz" => "archive-other",
        "dat" | "mca" | "lock" => "binary",
        _ => "text",
    }
}

/// Копирование папки целиком (для переноса между дисками).
pub fn copy_tree(from: &Path, to: &Path) -> Result<(), FileError> {
    if from.is_file() {
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(from, to)?;
        return Ok(());
    }
    fs::create_dir_all(to)?;
    for item in fs::read_dir(from)? {
        let item = item?;
        let target = to.join(item.file_name());
        copy_tree(&item.path(), &target)?;
    }
    Ok(())
}
