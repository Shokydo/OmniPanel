//! Обновление панели из GitHub.
//!
//! Два канала, как и раньше:
//!   * `update.json` в ветке — мелкие правки кода (архив ~2 МБ);
//!   * релизы GitHub — там же полная сборка и установщик.
//! Код ставится сам (это быстро и не ломает серверы — папка данных
//! неприкосновенна), а полная сборка только по согласию пользователя.
//!
//! Перед установкой архива панель делает копию своих файлов, проверяет
//! SHA-256 и никогда не трогает настройки серверов, бэкапы и профиль.

use crate::json::{self, Value};
use crate::net;
use crate::sha256;
use crate::zip;
use std::path::{Path, PathBuf};

pub const CODE_ASSET: &str = "OmniPanel-code.zip";
pub const FULL_ASSET: &str = "OmniPanel-win64.zip";
/// Что обязано быть в архиве кода, иначе это не панель.
pub const MUST_HAVE: [&str; 4] = ["main.js", "package.json", "ui/index.html", "ui/app.js"];
/// Файлы и папки панели, которые обновление имеет право заменить.
pub const CODE_ROOTS: [&str; 12] = [
    "main.js", "preload.js", "web.js", "package.json", "README.md", "ЧИТАЙ-МЕНЯ.txt",
    "servers.example.json", "ui", "core", "assets", "tools", "demo",
];
/// Данные пользователя: обновление их не касается.
const PROTECTED_DIRS: [&str; 6] = ["omnipaneldata", "data", "backups", "tps", "logs", "updates"];
const PROTECTED_FILES: [&str; 2] = ["servers.json", "panel.json"];

/// `1.10.0` → [1, 10, 0]; мусор → нули.
pub fn parse_version(text: &str) -> [u32; 3] {
    let trimmed = text.trim().trim_start_matches(['v', 'V']);
    let digits: String = trimmed
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let mut out = [0u32; 3];
    for (index, part) in digits.split('.').take(3).enumerate() {
        out[index] = part.parse().unwrap_or(0);
    }
    out
}

/// 1 — `a` новее `b`, -1 — старее, 0 — равны.
pub fn compare_versions(a: &str, b: &str) -> i32 {
    let x = parse_version(a);
    let y = parse_version(b);
    for i in 0..3 {
        if x[i] > y[i] {
            return 1;
        }
        if x[i] < y[i] {
            return -1;
        }
    }
    0
}

/// Путь, который обновление не имеет права ни менять, ни удалять.
pub fn is_protected(rel: &str) -> bool {
    let clean = rel.replace('\\', "/");
    let parts: Vec<&str> = clean.split('/').collect();
    let first = parts.first().map(|p| p.to_lowercase()).unwrap_or_default();
    if PROTECTED_DIRS.contains(&first.as_str()) {
        return true;
    }
    parts.len() == 1 && PROTECTED_FILES.contains(&first.as_str())
}

/// Канал обновлений и его настройки.
pub struct Updater {
    data_dir: PathBuf,
    pub app_dir: PathBuf,
    pub current: String,
    pub raw_base: String,
    pub api_base: String,
    pub repo_default: String,
    /// Токен нужен только чтобы не упираться в лимит GitHub для чужих сборок.
    pub token: String,
}

impl Updater {
    pub fn new(data_dir: &Path, app_dir: &Path, current: &str) -> Updater {
        Updater {
            data_dir: data_dir.to_path_buf(),
            app_dir: app_dir.to_path_buf(),
            current: current.to_string(),
            raw_base: std::env::var("OMNI_UPDATE_RAW")
                .unwrap_or_else(|_| "https://raw.githubusercontent.com".to_string())
                .trim_end_matches('/')
                .to_string(),
            api_base: std::env::var("OMNI_GITHUB_API")
                .unwrap_or_else(|_| "https://api.github.com".to_string())
                .trim_end_matches('/')
                .to_string(),
            repo_default: "Shokydo/OmniPanel".to_string(),
            token: String::new(),
        }
    }

    /// Адреса подменяются в тестах: так проверка идёт без настоящего GitHub.
    pub fn with_bases(data_dir: &Path, app_dir: &Path, current: &str, raw_base: &str, api_base: &str) -> Updater {
        let mut updater = Updater::new(data_dir, app_dir, current);
        updater.raw_base = raw_base.trim_end_matches('/').to_string();
        updater.api_base = api_base.trim_end_matches('/').to_string();
        updater
    }

    fn panel_path(&self) -> PathBuf {
        self.data_dir.join("panel.json")
    }

    fn panel(&self) -> Value {
        std::fs::read_to_string(self.panel_path())
            .ok()
            .and_then(|text| json::parse(&text).ok())
            .unwrap_or(Value::Obj(Vec::new()))
    }

    fn save_panel(&self, patch: Vec<(&str, Value)>) -> Result<(), String> {
        let mut fields: Vec<(String, Value)> = match self.panel() {
            Value::Obj(fields) => fields,
            _ => Vec::new(),
        };
        for (name, value) in patch {
            match fields.iter_mut().find(|(key, _)| key == name) {
                Some(slot) => slot.1 = value,
                None => fields.push((name.to_string(), value)),
            }
        }
        std::fs::create_dir_all(&self.data_dir).map_err(|e| format!("не создать папку данных: {}", e))?;
        std::fs::write(self.panel_path(), Value::Obj(fields).to_json_pretty())
            .map_err(|e| format!("не записать настройки: {}", e))
    }

    fn field(&self, name: &str) -> Value {
        self.panel().get(name).cloned().unwrap_or(Value::Null)
    }

    /// Настройки канала для окна обновлений.
    pub fn config(&self) -> Value {
        let saved_repo = self.field("updateRepo").text();
        let repo = if saved_repo.trim().is_empty() {
            self.repo_default.clone()
        } else {
            normalize_repo(&saved_repo)
        };
        let branch = self.field("updateBranch").text();
        Value::obj(vec![
            ("repo", Value::str(repo)),
            ("repoDefault", Value::str(&self.repo_default)),
            ("branch", Value::str(if branch.trim().is_empty() { "main".to_string() } else { branch })),
            ("auto", Value::Bool(!matches!(self.field("updateAuto"), Value::Bool(false)))),
            ("autoInstall", Value::Bool(!matches!(self.field("updateAutoInstall"), Value::Bool(false)))),
            ("lastCheck", self.field("updateLastCheck")),
            ("lastVersion", Value::str(self.field("updateLastVersion").text())),
            ("current", Value::str(&self.current)),
            ("packaged", Value::Bool(true)),
            ("appDir", Value::str(self.app_dir.display().to_string())),
        ])
    }

    /// Сохранить настройки канала (меняются только переданные поля).
    pub fn save(&self, patch: &Value) -> Value {
        let mut fields: Vec<(&str, Value)> = Vec::new();
        if let Some(repo) = patch.get("repo") {
            fields.push(("updateRepo", Value::str(repo.text().trim())));
        }
        if let Some(branch) = patch.get("branch") {
            let text = branch.text().trim().to_string();
            fields.push(("updateBranch", Value::str(if text.is_empty() { "main".to_string() } else { text })));
        }
        if let Some(auto) = patch.get("auto") {
            fields.push(("updateAuto", Value::Bool(auto.as_bool())));
        }
        if let Some(auto) = patch.get("autoInstall") {
            fields.push(("updateAutoInstall", Value::Bool(auto.as_bool())));
        }
        let _ = self.save_panel(fields);
        self.config()
    }

    /// Проверка обновлений: `update.json` и последний релиз, что новее — то и берём.
    pub fn check(&self) -> Value {
        let cfg = self.config();
        let repo = cfg.get("repo").map(|v| v.text()).unwrap_or_default();
        let branch = cfg.get("branch").map(|v| v.text()).unwrap_or_default();
        if repo.is_empty() {
            return error("Не задан репозиторий обновлений (владелец/имя)");
        }
        let manifest = self.manifest(&repo, &branch);
        let release = self.release(&repo);
        let mut found: Vec<Value> = Vec::new();
        if let Some(value) = &manifest {
            found.push(value.clone());
        }
        if let Some(value) = &release {
            found.push(value.clone());
        }
        if found.is_empty() {
            return error(format!("На GitHub не нашлось ни update.json, ни релизов в {}", repo));
        }
        /* самая свежая версия из двух источников */
        let mut latest = found[0].clone();
        for item in &found[1..] {
            if compare_versions(&item.get("version").map(|v| v.text()).unwrap_or_default(),
                &latest.get("version").map(|v| v.text()).unwrap_or_default()) > 0 {
                latest = item.clone();
            }
        }
        let latest_version = latest.get("version").map(|v| v.text()).unwrap_or_default();
        let same: Vec<&Value> = found
            .iter()
            .filter(|f| compare_versions(&f.get("version").map(|v| v.text()).unwrap_or_default(), &latest_version) == 0)
            .collect();

        /* код берём из релиза, если он есть: raw-адрес отдаёт до пяти минут старое */
        let mut code = latest.get("code").cloned().filter(|v| !v.is_null());
        if code.is_none() {
            code = same.iter().filter_map(|f| f.get("code").cloned()).find(|v| !v.is_null());
        }
        let code_missing_sha = code
            .as_ref()
            .and_then(|c| c.get("sha256").map(|s| s.text()))
            .map(|s| s.is_empty())
            .unwrap_or(true);
        if code_missing_sha {
            let with_sha = same
                .iter()
                .filter_map(|f| f.get("code").cloned())
                .find(|c| c.get("sha256").map(|s| !s.text().is_empty()).unwrap_or(false));
            if let Some(with_sha) = with_sha {
                code = Some(with_sha);
            }
        }
        /* полная сборка и установщик — только той же версии, что признана свежей */
        let full = latest
            .get("full")
            .cloned()
            .filter(|v| !v.is_null())
            .or_else(|| same.iter().filter_map(|f| f.get("full").cloned()).find(|v| !v.is_null()));
        let setup = latest
            .get("setup")
            .cloned()
            .filter(|v| !v.is_null())
            .or_else(|| same.iter().filter_map(|f| f.get("setup").cloned()).find(|v| !v.is_null()));

        let has_update = compare_versions(&latest_version, &self.current) > 0;
        let _ = self.save_panel(vec![
            ("updateLastCheck", Value::str(crate::sync::iso_now())),
            ("updateLatest", Value::str(&latest_version)),
        ]);
        Value::obj(vec![
            ("ok", Value::Bool(true)),
            ("repo", Value::str(repo)),
            ("branch", Value::str(branch)),
            ("current", Value::str(&self.current)),
            ("latest", Value::str(latest_version)),
            ("hasUpdate", Value::Bool(has_update)),
            ("notes", Value::str(latest.get("notes").map(|v| v.text()).unwrap_or_default())),
            ("source", Value::str(latest.get("source").map(|v| v.text()).unwrap_or_default())),
            ("code", code.unwrap_or(Value::Null)),
            ("full", full.unwrap_or(Value::Null)),
            ("setup", setup.unwrap_or(Value::Null)),
            ("checkedAt", Value::str(crate::sync::iso_now())),
        ])
    }

    /// `update.json` из ветки.
    fn manifest(&self, repo: &str, branch: &str) -> Option<Value> {
        let url = format!("{}/{}/{}/update.json?_{}", self.raw_base, repo, branch, nanos());
        let reply = net::get(&url).ok()?;
        if !reply.ok() {
            return None;
        }
        let body = json::parse(&reply.body).ok()?;
        let version = body.get("version").map(|v| v.text()).unwrap_or_default();
        if version.is_empty() {
            return None;
        }
        Some(Value::obj(vec![
            ("source", Value::str("файл update.json")),
            ("version", Value::str(version)),
            ("notes", Value::str(body.get("notes").map(|v| v.text()).unwrap_or_default())),
            ("code", self.asset(body.get("code"), repo, branch)),
            ("full", self.asset(body.get("full"), repo, branch)),
        ]))
    }

    /// Последний релиз через API GitHub.
    fn release(&self, repo: &str) -> Option<Value> {
        let url = format!("{}/repos/{}/releases/latest", self.api_base, repo);
        let reply = if self.token.trim().is_empty() {
            net::get(&url).ok()?
        } else {
            net::get_with_token(&url, &self.token).ok()?
        };
        if !reply.ok() {
            return None;
        }
        let body = reply.json();
        let tag = body.get("tag_name").map(|v| v.text()).unwrap_or_default();
        if tag.is_empty() {
            return None;
        }
        let assets = body.get("assets").map(|a| a.as_arr().to_vec()).unwrap_or_default();
        let find = |name: &str| -> Option<Value> {
            assets.iter().find(|a| a.get("name").map(|n| n.text()).as_deref() == Some(name)).map(|a| {
                Value::obj(vec![
                    ("url", Value::str(a.get("browser_download_url").map(|v| v.text()).unwrap_or_default())),
                    ("size", Value::Num(a.get("size").and_then(|v| v.as_f64()).unwrap_or(0.0))),
                    ("sha256", Value::str(String::new())),
                ])
            })
        };
        let setup = assets
            .iter()
            .find(|a| {
                let name = a.get("name").map(|n| n.text()).unwrap_or_default();
                let lower = name.to_lowercase();
                lower.starts_with("omnipanel") && lower.ends_with(".exe")
                    && (lower.contains("setup") || lower.contains("установка") || lower.contains("installer"))
            })
            .map(|a| {
                Value::obj(vec![
                    ("url", Value::str(a.get("browser_download_url").map(|v| v.text()).unwrap_or_default())),
                    ("size", Value::Num(a.get("size").and_then(|v| v.as_f64()).unwrap_or(0.0))),
                    ("name", Value::str(a.get("name").map(|v| v.text()).unwrap_or_default())),
                    ("sha256", Value::str(String::new())),
                ])
            });
        Some(Value::obj(vec![
            ("source", Value::str(format!("релиз {}", tag))),
            ("version", Value::str(tag.trim_start_matches(['v', 'V']).to_string())),
            ("notes", Value::str(body.get("body").map(|v| v.text()).unwrap_or_default())),
            ("code", find(CODE_ASSET).unwrap_or(Value::Null)),
            ("full", find(FULL_ASSET).unwrap_or(Value::Null)),
            ("setup", setup.unwrap_or(Value::Null)),
        ]))
    }

    /// Ссылка на файл из `update.json`: строка или `{file, size, sha256}`.
    fn asset(&self, spec: Option<&Value>, repo: &str, branch: &str) -> Value {
        let Some(spec) = spec else {
            return Value::Null;
        };
        match spec {
            Value::Str(name) => Value::obj(vec![
                ("url", Value::str(format!("{}/{}/{}/{}", self.raw_base, repo, branch, name.trim_start_matches('/')))),
                ("size", Value::Num(0.0)),
                ("sha256", Value::str(String::new())),
            ]),
            Value::Obj(_) => {
                if let Some(url) = spec.get("url") {
                    return Value::obj(vec![
                        ("url", Value::str(url.text())),
                        ("size", Value::Num(spec.get("size").and_then(|v| v.as_f64()).unwrap_or(0.0))),
                        ("sha256", Value::str(spec.get("sha256").map(|v| v.text()).unwrap_or_default())),
                    ]);
                }
                let file = spec.get("file").map(|v| v.text()).unwrap_or_default();
                if file.is_empty() {
                    return Value::Null;
                }
                Value::obj(vec![
                    ("url", Value::str(format!("{}/{}/{}/{}", self.raw_base, repo, branch, file.trim_start_matches('/')))),
                    ("size", Value::Num(spec.get("size").and_then(|v| v.as_f64()).unwrap_or(0.0))),
                    ("sha256", Value::str(spec.get("sha256").map(|v| v.text()).unwrap_or_default())),
                ])
            }
            _ => Value::Null,
        }
    }

    fn updates_dir(&self) -> PathBuf {
        self.data_dir.join("updates")
    }

    fn backups_dir(&self) -> PathBuf {
        self.data_dir.join("backups").join("updates")
    }

    /// Скачать архив кода (проверка суммы — если она объявлена).
    fn download_code(&self, code: &Value) -> Result<PathBuf, String> {
        let url = code.get("url").map(|v| v.text()).unwrap_or_default();
        if url.is_empty() {
            return Err("В update.json нет ссылки на архив кода".into());
        }
        let want = code.get("sha256").map(|v| v.text()).unwrap_or_default();
        let dest = self.updates_dir().join(CODE_ASSET);
        std::fs::create_dir_all(self.updates_dir()).map_err(|e| format!("не создать папку обновлений: {}", e))?;
        let mut last = String::new();
        /* до трёх попыток: связь бывает рвётся на средине большого файла */
        for attempt in 0..3 {
            match net::download(&url, &dest, Some(&self.token)) {
                Ok(_) => {
                    if want.is_empty() {
                        return Ok(dest);
                    }
                    let got = sha256::file_hex(&dest)?;
                    if got == want.to_lowercase() {
                        return Ok(dest);
                    }
                    last = format!("Контрольная сумма не совпала (получили {}, ждали {})", &got[..8.min(got.len())], &want[..8.min(want.len())]);
                }
                Err(message) => last = message,
            }
            if attempt < 2 {
                std::thread::sleep(std::time::Duration::from_millis(400));
            }
        }
        Err(last)
    }

    /// Поставить обновление кода: скачать, проверить, сделать копию, разложить.
    pub fn apply(&self) -> Value {
        let fresh = self.check();
        if !fresh.get("ok").map(|v| v.as_bool()).unwrap_or(false) {
            return fresh;
        }
        let code = fresh.get("code").cloned().unwrap_or(Value::Null);
        if code.is_null() {
            return error("В обновлении нет архива кода — поставь полную сборку");
        }
        let archive = match self.download_code(&code) {
            Ok(path) => path,
            Err(message) => return error(message),
        };
        let version = fresh.get("latest").map(|v| v.text()).unwrap_or_default();
        match self.apply_archive(&archive, &version) {
            Ok(mut value) => {
                let _ = self.save_panel(vec![
                    ("updateLastVersion", Value::str(&version)),
                    ("updateInstalledAt", Value::str(crate::sync::iso_now())),
                ]);
                if let Value::Obj(fields) = &mut value {
                    fields.push(("latest".to_string(), Value::str(&version)));
                }
                value
            }
            Err(message) => error(message),
        }
    }

    /// Разложить скачанный архив поверх панели (с копией старых файлов).
    pub fn apply_archive(&self, archive: &Path, version: &str) -> Result<Value, String> {
        if !archive.exists() {
            return Err("Архив обновления не найден".into());
        }
        let data = std::fs::read(archive).map_err(|e| format!("не прочитать архив: {}", e))?;
        let list = zip::list(&data).map_err(|e| format!("Архив обновления не читается: {}", e))?;
        let names: Vec<String> = list.iter().map(|entry| entry.name.replace('\\', "/")).collect();
        let missing: Vec<&str> = MUST_HAVE.iter().copied().filter(|need| !names.iter().any(|n| n == need)).collect();
        if !missing.is_empty() {
            return Err(format!("В архиве нет файлов панели: {}", missing.join(", ")));
        }
        let code_files: Vec<String> = names.iter().filter(|name| !is_protected(name)).cloned().collect();

        /* 1. копия текущих файлов панели на случай, если что-то пойдёт не так */
        let stamp = crate::sync::iso_now().replace([':', 'T'], "-");
        let backup = self.backups_dir().join(format!("before-{}-{}", if version.is_empty() { "обновление" } else { version }, &stamp[..19.min(stamp.len())]));
        let mut backed = 0usize;
        let _ = std::fs::create_dir_all(&backup);
        for root in CODE_ROOTS {
            let from = self.app_dir.join(root);
            if !from.exists() {
                continue;
            }
            if from.is_dir() {
                if copy_tree(&from, &backup.join(root)).is_ok() {
                    backed += 1;
                }
            } else if std::fs::copy(&from, backup.join(root)).is_ok() {
                backed += 1;
            }
        }

        /* 2. разложить новые файлы кода */
        let tmp = std::env::temp_dir().join(format!("omnipanel-upd-{}", nanos()));
        std::fs::create_dir_all(&tmp).map_err(|e| format!("не создать временную папку: {}", e))?;
        let extracted = zip::extract(&data, &tmp, "");
        let count = match extracted {
            Ok((count, _, _)) => count,
            Err(message) => {
                let _ = std::fs::remove_dir_all(&tmp);
                return Err(message);
            }
        };
        let mut applied = 0usize;
        for name in &code_files {
            let from = tmp.join(name.replace('/', std::path::MAIN_SEPARATOR_STR));
            if !from.is_file() {
                continue;
            }
            let to = self.app_dir.join(name.replace('/', std::path::MAIN_SEPARATOR_STR));
            if let Some(parent) = to.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if std::fs::copy(&from, &to).is_ok() {
                applied += 1;
            }
        }
        let _ = std::fs::remove_dir_all(&tmp);
        if applied == 0 {
            return Err("Не удалось разложить файлы обновления".into());
        }

        /* 3. запомнить состав: следующее обновление будет знать, что убирать */
        let installed = Value::obj(vec![
            ("version", Value::str(version)),
            ("at", Value::str(crate::sync::iso_now())),
            ("files", Value::Arr(code_files.iter().map(|f| Value::str(f)).collect())),
        ]);
        let _ = std::fs::write(
            self.app_dir.join("update-installed.json"),
            installed.to_json_pretty(),
        );

        Ok(Value::obj(vec![
            ("ok", Value::Bool(true)),
            ("applied", Value::Num(applied as f64)),
            ("files", Value::Num(count as f64)),
            ("backup", Value::str(backup.display().to_string())),
            ("backedUp", Value::Num(backed as f64)),
            ("version", Value::str(version)),
            ("restart", Value::Bool(true)),
        ]))
    }

    /// Автообновление: проверка и, если разрешено, установка кода.
    pub fn auto(&self, servers_running: bool) -> Value {
        let cfg = self.config();
        let check = self.check();
        let has_update = check.get("hasUpdate").map(|v| v.as_bool()).unwrap_or(false);
        if !has_update {
            return check;
        }
        let auto_install = cfg.get("autoInstall").map(|v| v.as_bool()).unwrap_or(true);
        if !auto_install {
            return check;
        }
        /* код ставим только когда серверы не работают: обновление не должно
           оборвать мир на половине сохранения */
        if servers_running {
            let mut value = check;
            if let Value::Obj(fields) = &mut value {
                fields.push(("deferred".to_string(), Value::Bool(true)));
                fields.push(("reason".to_string(), Value::str("Серверы работают — обновление поставлю после остановки")));
            }
            return value;
        }
        self.apply()
    }

    /// Скачать полную сборку (ставится не здесь, а отдельным установщиком).
    pub fn download_full(&self) -> Value {
        let fresh = self.check();
        if !fresh.get("ok").map(|v| v.as_bool()).unwrap_or(false) {
            return fresh;
        }
        let full = fresh.get("full").cloned().unwrap_or(Value::Null);
        let setup = fresh.get("setup").cloned().unwrap_or(Value::Null);
        let (asset, name) = if !setup.is_null() {
            (setup, fresh.get("setup").and_then(|v| v.get("name")).map(|v| v.text()).unwrap_or_else(|| "OmniPanel-Установка.exe".into()))
        } else if !full.is_null() {
            (full, FULL_ASSET.to_string())
        } else {
            return error("В обновлении нет ни установщика, ни полной сборки");
        };
        let url = asset.get("url").map(|v| v.text()).unwrap_or_default();
        if url.is_empty() {
            return error("У обновления нет ссылки на файл");
        }
        let dest = self.updates_dir().join(&name);
        match net::download(&url, &dest, Some(&self.token)) {
            Ok(bytes) => Value::obj(vec![
                ("ok", Value::Bool(true)),
                ("file", Value::str(dest.display().to_string())),
                ("size", Value::Num(bytes as f64)),
                ("version", fresh.get("latest").cloned().unwrap_or(Value::Null)),
            ]),
            Err(message) => error(message),
        }
    }

    /// Папка с копиями панели перед обновлениями.
    pub fn reveal_backups(&self) -> Value {
        let dir = self.backups_dir();
        let _ = std::fs::create_dir_all(&dir);
        Value::obj(vec![
            ("ok", Value::Bool(true)),
            ("path", Value::str(dir.display().to_string())),
            ("exists", Value::Bool(dir.exists())),
        ])
    }
}

fn nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

fn error(message: impl Into<String>) -> Value {
    Value::obj(vec![("ok", Value::Bool(false)), ("error", Value::str(message))])
}

/// `owner/name` из любой записи адреса.
pub fn normalize_repo(repo: &str) -> String {
    let raw = repo.trim();
    if raw.is_empty() {
        return String::new();
    }
    if let Some(rest) = raw
        .split("github.com/")
        .nth(1)
        .or_else(|| raw.split("github.com:").nth(1))
    {
        return rest.trim_end_matches('/').trim_end_matches(".git").to_string();
    }
    raw.trim_end_matches('/').trim_end_matches(".git").to_string()
}

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)?.flatten() {
        let path = entry.path();
        let target = to.join(entry.file_name());
        if path.is_dir() {
            copy_tree(&path, &target)?;
        } else {
            std::fs::copy(&path, &target)?;
        }
    }
    Ok(())
}
