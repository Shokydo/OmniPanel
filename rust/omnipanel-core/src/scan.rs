//! Поиск серверов на дисках.
//!
//! Панель умеет сама находить уже существующие серверы: обходит папки в
//! ширину, смотрит на содержимое и решает, что это — сервер Minecraft,
//! папка плагинов, бот на Node.js, скрипт на Python или обычный exe.
//!
//! Правила перенесены из `core/scan.js` один в один: те же признаки, те же
//! веса, та же предлагаемая команда запуска. Иначе уже настроенные папки
//! находились бы по-другому, и человек не понял бы, почему.

use crate::json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Куда не заходим никогда: служебные папки Windows, кеши, node_modules.
pub const SKIP_DIRS: [&str; 24] = [
    "windows", "winsxs", "programdata", "appdata", "node_modules", "$recycle.bin",
    "system volume information", "perflogs", "recovery", "msocache", "temp", "tmp",
    "proc", "sys", "dev", "run", "snap", "boot", "lost+found", "var", "usr", "lib",
    "bin", "sbin",
];

/// Сколько папок просматриваем за один запуск поиска.
const MAX_DIRS: usize = 120_000;

/// Что нашлось.
#[derive(Debug, Clone, PartialEq)]
pub struct Found {
    pub path: String,
    pub name: String,
    pub kind: &'static str,
    pub score: u32,
    pub hints: Vec<String>,
    pub command: String,
    pub stop_command: String,
}

impl Found {
    pub fn to_json(&self, added: bool) -> Value {
        Value::obj(vec![
            ("path", Value::str(&self.path)),
            ("name", Value::str(&self.name)),
            ("kind", Value::str(self.kind)),
            ("score", Value::Num(self.score as f64)),
            (
                "hints",
                Value::Arr(self.hints.iter().map(|h| Value::str(h.clone())).collect()),
            ),
            ("command", Value::str(&self.command)),
            ("stopCommand", Value::str(&self.stop_command)),
            ("added", Value::Bool(added)),
        ])
    }
}

/// Диски Windows или корень файловой системы.
pub fn roots() -> Vec<String> {
    if cfg!(windows) {
        let mut out = Vec::new();
        for letter in b'A'..=b'Z' {
            let drive = format!("{}:\\", letter as char);
            if Path::new(&drive).exists() {
                out.push(drive);
            }
        }
        if out.is_empty() {
            out.push("C:\\".to_string());
        }
        out
    } else {
        vec!["/".to_string()]
    }
}

fn skip_dir(name: &str) -> bool {
    let lower = name.to_lowercase();
    SKIP_DIRS.contains(&lower.as_str()) || lower.starts_with('.')
}

/// Разбор одной папки: сервер, плагины, бот или ничего.
pub fn analyze(dir: &Path, entries: &[(String, bool)]) -> Option<Found> {
    let has = |name: &str| entries.iter().any(|(n, _)| n.eq_ignore_ascii_case(name));
    let has_dir = |name: &str| entries.iter().any(|(n, is_dir)| *is_dir && n.eq_ignore_ascii_case(name));
    let find = |check: &dyn Fn(&str) -> bool| {
        entries
            .iter()
            .find(|(name, is_dir)| !*is_dir && check(name))
            .map(|(name, _)| name.clone())
    };
    let jar = find(&is_minecraft_jar);
    let mut hints: Vec<String> = Vec::new();
    let mut score = 0u32;
    let mut kind: Option<&'static str> = None;
    let mut stop_command = "";

    /* ── Minecraft ── */
    if has("server.properties") {
        score += 3;
        hints.push("server.properties".to_string());
    }
    if has("eula.txt") {
        score += 2;
        hints.push("eula.txt".to_string());
    }
    if let Some(jar) = &jar {
        score += 3;
        hints.push(jar.clone());
    }
    if has_dir("plugins") {
        score += 1;
        hints.push("plugins/".to_string());
    }
    if has_dir("mods") {
        score += 1;
        hints.push("mods/".to_string());
    }
    if has_dir("world") {
        score += 1;
        hints.push("world/".to_string());
    }
    if ["bukkit.yml", "spigot.yml", "paper.yml", "paper-global.yml"].iter().any(|n| has(n)) {
        score += 1;
        hints.push("bukkit/paper конфиг".to_string());
    }

    let server_marker = [
        "server.properties", "eula.txt", "bukkit.yml", "spigot.yml", "paper.yml",
        "paper-global.yml", "ops.json", "whitelist.json", "banned-ips.json",
    ]
    .iter()
    .any(|n| has(n));
    let server_jar = [
        "server.jar", "minecraft_server.jar", "paper.jar", "spigot.jar", "craftbukkit.jar",
        "purpur.jar", "pufferfish.jar", "fabric-server-launch.jar", "forge.jar",
        "neoforge.jar", "mohist.jar", "arclight.jar",
    ]
    .iter()
    .any(|n| has(n))
        || find(&is_server_jar).is_some();

    if server_marker || (server_jar && score >= 2) {
        kind = Some("minecraft");
        stop_command = "stop";
    } else if has_dir("plugins") || has_dir("mods") {
        let jars: Vec<String> = entries
            .iter()
            .filter(|(name, is_dir)| !*is_dir && name.to_lowercase().ends_with(".jar"))
            .map(|(name, _)| name.clone())
            .collect();
        if !jars.is_empty() && !has("server.properties") && !has("eula.txt") {
            let mut list = jars.iter().take(3).cloned().collect::<Vec<String>>().join(", ");
            list = format!("плагины/моды: {}", list);
            return Some(Found {
                path: path_text(dir),
                name: dir_name(dir),
                kind: "minecraft-plugin",
                score: 1,
                hints: vec![list],
                command: String::new(),
                stop_command: String::new(),
            });
        }
    }

    /* ── скрипт запуска ── */
    let starters = [
        "start.bat", "start.cmd", "run.bat", "run.cmd", "start.sh", "run.sh",
        "launch.bat", "launch.cmd", "server.bat", "server.cmd",
    ];
    let starter = starters.iter().find(|n| has(n)).map(|n| n.to_string());
    let any_bat = find(&|name: &str| {
        let lower = name.to_lowercase();
        lower.ends_with(".bat") || lower.ends_with(".cmd") || lower.ends_with(".sh")
    });
    if let Some(starter) = &starter {
        score += 3;
        hints.push(starter.clone());
        if kind.is_none() {
            kind = Some("script");
        }
    } else if let Some(bat) = &any_bat {
        score += 2;
        hints.push(bat.clone());
        if kind.is_none() {
            kind = Some("script");
        }
    }

    /* ── Node.js ── */
    let mut node_entry: Option<String> = None;
    if has("package.json") {
        node_entry = ["index.js", "bot.js", "app.js", "main.js", "server.js"]
            .iter()
            .find(|n| has(n))
            .map(|n| n.to_string())
            .or_else(|| {
                find(&|name: &str| {
                    let lower = name.to_lowercase();
                    matches!(lower.as_str(), "index.js" | "bot.js" | "app.js" | "main.js" | "server.js")
                        || lower.ends_with(".mjs")
                        || lower.ends_with(".cjs")
                        || lower.ends_with(".ts")
                })
            });
        score += if node_entry.is_some() { 3 } else { 1 };
        hints.push("package.json".to_string());
        if node_entry.is_some() && (kind.is_none() || kind == Some("script")) {
            kind = Some("node");
            stop_command = "";
        }
    }

    /* ── Python ── */
    let mut py_entry: Option<String> = None;
    if has("requirements.txt") || has("pyproject.toml") {
        py_entry = ["main.py", "bot.py", "app.py", "server.py", "run.py"]
            .iter()
            .find(|n| has(n))
            .map(|n| n.to_string());
        if py_entry.is_some() {
            score += 3;
            hints.push(py_entry.clone().unwrap_or_default());
            if kind.is_none() {
                kind = Some("python");
                stop_command = "";
            }
        } else {
            score += 1;
        }
    }

    /* ── готовый exe ── */
    let exe = find(&|name: &str| {
        let lower = name.to_lowercase();
        if !lower.ends_with(".exe") {
            return false;
        }
        ["server", "start", "run", "game", "service"]
            .iter()
            .any(|prefix| lower.starts_with(prefix))
    });
    if let Some(exe) = &exe {
        score += 2;
        hints.push(exe.clone());
        if kind.is_none() {
            kind = Some("exe");
        }
    }

    /* папка внутри plugins/libs — это не сервер */
    let parent = dir
        .parent()
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if ["libs", "lib", "plugins", "mods", "libraries"].contains(&parent.as_str()) && kind.is_none() {
        return None;
    }

    /* сама панель в результаты не попадает */
    if has("package.json") {
        if let Ok(text) = std::fs::read_to_string(dir.join("package.json")) {
            let lower = text.to_lowercase();
            if lower.contains("omnipanel") || lower.contains("local-server-panel") {
                return None;
            }
        }
    }
    if has("preload.js") && has_dir("core") && has_dir("ui") {
        return None;
    }

    if kind.is_none() {
        let jars: Vec<String> = entries
            .iter()
            .filter(|(name, is_dir)| !*is_dir && name.to_lowercase().ends_with(".jar"))
            .map(|(name, _)| name.clone())
            .collect();
        if !jars.is_empty() {
            let mut text = format!("jar-файлы: {}", jars.iter().take(3).cloned().collect::<Vec<_>>().join(", "));
            if jars.len() > 3 {
                text.push_str(&format!(" и ещё {}", jars.len() - 3));
            }
            return Some(Found {
                path: path_text(dir),
                name: dir_name(dir),
                kind: "minecraft-plugin",
                score: 1,
                hints: vec![text],
                command: String::new(),
                stop_command: String::new(),
            });
        }
        return None;
    }
    if score < 3 {
        return None;
    }

    /* ── предлагаемая команда запуска ── */
    let kind_str = kind.unwrap_or("script");
    let mut command = String::new();
    match kind_str {
        "minecraft" => {
            let is_bat = starter
                .as_ref()
                .map(|s| {
                    let lower = s.to_lowercase();
                    lower.ends_with(".bat") || lower.ends_with(".cmd")
                })
                .unwrap_or(false);
            if is_bat {
                command = starter.clone().unwrap_or_default();
            } else if let Some(jar) = &jar {
                command = format!("java -Xms1G -Xmx2G -jar \"{}\" nogui", jar);
            } else if let Some(starter) = &starter {
                command = starter.clone();
            }
        }
        "node" => {
            command = match &node_entry {
                Some(entry) => format!("node \"{}\"", entry),
                None => "npm start".to_string(),
            };
        }
        "python" => {
            command = format!("python \"{}\"", py_entry.clone().unwrap_or_default());
            stop_command = "";
        }
        "exe" => {
            if let Some(exe) = &exe {
                command = format!("\"{}\"", exe);
            }
        }
        _ => {
            if let Some(starter) = &starter {
                command = starter.clone();
            }
        }
    }

    let mut unique: Vec<String> = Vec::new();
    for hint in hints {
        if !unique.contains(&hint) {
            unique.push(hint);
        }
    }
    unique.truncate(8);
    Some(Found {
        path: path_text(dir),
        name: dir_name(dir),
        kind: kind_str,
        score,
        hints: unique,
        command,
        stop_command: stop_command.to_string(),
    })
}

fn is_minecraft_jar(name: &str) -> bool {
    let lower = name.to_lowercase();
    if !lower.ends_with(".jar") {
        return false;
    }
    let stem = lower.trim_end_matches(".jar");
    [
        "server", "paper", "spigot", "craftbukkit", "purpur", "pufferfish",
        "fabric-server", "forge", "neoforge", "minecraft_server", "mohist", "arclight",
    ]
    .iter()
    .any(|mark| stem.contains(mark))
}

fn is_server_jar(name: &str) -> bool {
    let lower = name.to_lowercase();
    if !lower.ends_with(".jar") {
        return false;
    }
    [
        "server", "paper", "spigot", "craftbukkit", "purpur", "mohist", "arclight",
    ]
    .iter()
    .any(|prefix| lower.starts_with(prefix))
}

fn path_text(dir: &Path) -> String {
    dir.display().to_string()
}

fn dir_name(dir: &Path) -> String {
    dir.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| dir.display().to_string())
}

/// Управление поиском: отмена из интерфейса и прогресс.
#[derive(Clone)]
pub struct Scanner {
    cancelled: Arc<AtomicBool>,
}

impl Default for Scanner {
    fn default() -> Self {
        Scanner::new()
    }
}

/// Снимок хода поиска — панель показывает его в окне.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Progress {
    pub scanned: u64,
    pub found: usize,
    pub queued: usize,
    pub current: String,
    pub percent: u32,
    pub done: bool,
    pub cancelled: bool,
}

impl Progress {
    pub fn to_json(&self) -> Value {
        Value::obj(vec![
            ("scanned", Value::from(self.scanned)),
            ("found", Value::from(self.found)),
            ("queued", Value::from(self.queued)),
            ("current", Value::str(&self.current)),
            ("percent", Value::from(self.percent)),
            ("done", Value::Bool(self.done)),
            ("cancelled", Value::Bool(self.cancelled)),
        ])
    }
}

impl Scanner {
    pub fn new() -> Scanner {
        Scanner { cancelled: Arc::new(AtomicBool::new(false)) }
    }

    /// Начать новый поиск: прежняя отмена сбрасывается.
    pub fn reset(&self) {
        self.cancelled.store(false, Ordering::SeqCst);
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    /// Обход папок в ширину. `on_found` и `on_progress` — обратные вызовы панели.
    pub fn scan(
        &self,
        dirs: &[String],
        max_depth: usize,
        ignore: &[String],
        types: &[String],
        known: &HashSet<String>,
        mut on_found: impl FnMut(&Found, bool),
        mut on_progress: impl FnMut(&Progress),
    ) -> Vec<Found> {
        let allowed: HashSet<&str> = if types.is_empty() {
            ["minecraft", "minecraft-plugin", "node", "python", "exe", "script"].iter().copied().collect()
        } else {
            types.iter().map(|t| t.as_str()).collect()
        };
        let ignored: HashSet<String> = ignore.iter().map(|p| p.to_lowercase()).collect();
        let mut queue: Vec<(PathBuf, usize)> = dirs.iter().map(|d| (PathBuf::from(d), 0)).collect();
        let mut results: Vec<Found> = Vec::new();
        let mut seen: HashSet<PathBuf> = HashSet::new();
        let mut scanned = 0u64;
        let mut visited = 0usize;

        while let Some((dir, depth)) = queue.pop() {
            if self.is_cancelled() || visited >= MAX_DIRS {
                break;
            }
            if !seen.insert(dir.clone()) {
                continue;
            }
            if ignored.contains(&dir.display().to_string().to_lowercase()) {
                continue;
            }
            visited += 1;
            scanned += 1;

            let entries = match read_dir(&dir) {
                Some(entries) => entries,
                None => continue,
            };
            let found = analyze(&dir, &entries);
            let mut container = false;
            if let Some(item) = &found {
                container = item.kind == "minecraft-plugin";
                if allowed.contains(item.kind) {
                    results.push(item.clone());
                    let added = known.contains(&item.path.to_lowercase());
                    on_found(item, added);
                }
            }
            /* из настоящего сервера вглубь не идём, из папки плагинов — идём */
            if found.is_some() && !container {
                continue;
            }
            continue_inner(&dir, depth, max_depth, &entries, &mut queue);

            if scanned % 40 == 0 {
                on_progress(&Progress {
                    scanned,
                    found: results.len(),
                    queued: queue.len(),
                    current: dir.display().to_string(),
                    percent: percent(visited, visited + queue.len()),
                    done: false,
                    cancelled: false,
                });
            }
        }

        on_progress(&Progress {
            scanned,
            found: results.len(),
            queued: 0,
            current: String::new(),
            percent: 100,
            done: true,
            cancelled: self.is_cancelled(),
        });
        results
    }
}

fn continue_inner(
    dir: &Path,
    depth: usize,
    max_depth: usize,
    entries: &[(String, bool)],
    queue: &mut Vec<(PathBuf, usize)>,
) {
    if depth >= max_depth {
        return;
    }
    for (name, is_dir) in entries {
        if !*is_dir || skip_dir(name) {
            continue;
        }
        queue.push((dir.join(name), depth + 1));
    }
}

fn percent(done: usize, total: usize) -> u32 {
    if total == 0 {
        return 0;
    }
    ((done * 100 / total).min(99)) as u32
}

fn read_dir(dir: &Path) -> Option<Vec<(String, bool)>> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        /* символические ссылки пропускаем: на Windows они дают петли */
        let meta = match std::fs::symlink_metadata(entry.path()) {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        out.push((name, meta.is_dir()));
    }
    Some(out)
}

/// Список содержимого папки для разбора (панель и тесты).
pub fn entries(dir: &Path) -> Vec<(String, bool)> {
    read_dir(dir).unwrap_or_default()
}
