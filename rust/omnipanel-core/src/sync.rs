//! Синхронизация сервера с GitHub и GitLab.
//!
//! Сервер уезжает в репозиторий архивом (плотнее, меньше запросов и нет
//! ошибки 422 «слишком большой файл»), а при желании — по файлам. Формат
//! манифеста и имена частей те же, что были в прежней панели, поэтому
//! репозитории, созданные версией 1.26.0, читаются и отсюда.
//!
//! Правила, которые нельзя нарушать:
//!   * токен живёт только в памяти запроса — ни в логи, ни в сообщения об
//!     ошибках он не попадает;
//!   * части архива после распаковки убираются из репозитория (по умолчанию),
//!     чтобы он не рос до гигабайтов;
//!   * всё, что видит пользователь, — по-русски и без подсказок.

use crate::b64;
use crate::json::{self, Value};
use crate::net;
use crate::sha1;
use crate::sha256;
use crate::zip;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Куда панель кладёт манифест и архив внутри репозитория.
pub const ARCHIVE_DIR: &str = ".omnipanel";
pub const MANIFEST_PATH: &str = ".omnipanel/манифест.json";
/// Размер одной части: GitHub отвечает 422, если тело запроса слишком большое,
/// а base64 раздувает часть почти на треть. 20 МБ → ~27 МБ тела.
pub const SPLIT_MB: u64 = 20;
/// Предел одного файла у GitHub.
pub const HARD_LIMIT: u64 = 95 * 1024 * 1024;
/// Сколько частей панель готова отправить (≈ 4 ГБ).
pub const MAX_PARTS: usize = 90;
/// Идентификатор приложения панели для входа по коду.
pub const OAUTH_CLIENT_ID: &str = "178c6fc778ccc68e1d6a";

const GITHUB_API: &str = "https://api.github.com";
const GITHUB_OAUTH: &str = "https://github.com";
const GITLAB_API: &str = "https://gitlab.com/api/v4";

/// Провайдер хранения.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    GitHub,
    GitLab,
}

impl Provider {
    pub fn name(&self) -> &'static str {
        match self {
            Provider::GitHub => "GitHub",
            Provider::GitLab => "GitLab",
        }
    }

    pub fn parse(text: &str) -> Provider {
        if text.trim().eq_ignore_ascii_case("gitlab") {
            Provider::GitLab
        } else {
            Provider::GitHub
        }
    }
}

/// Всё, что нужно одной операции синхронизации.
#[derive(Debug, Clone)]
pub struct Options {
    pub dir: PathBuf,
    pub repo: String,
    pub branch: String,
    pub token: String,
    /// world | config | all
    pub scope: String,
    /// archive | files
    pub mode: String,
    pub provider: Provider,
    pub cleanup: bool,
    pub state_file: PathBuf,
    pub message: String,
    pub split_mb: u64,
    /// Шаги операции — панель показывает их в логе сервера.
    pub logs: Vec<String>,
}

impl Options {
    pub fn log(&mut self, text: impl Into<String>) {
        self.logs.push(text.into());
    }
}

/* ────────────────────────────── мелочи ────────────────────────────── */

/// Кодирование пути для адреса: кириллица в именах файлов не должна ломать API.
pub fn url_encode(text: &str, keep_slash: bool) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        let plain = byte.is_ascii_alphanumeric()
            || matches!(byte, b'-' | b'_' | b'.' | b'~')
            || (keep_slash && byte == b'/');
        if plain {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{:02X}", byte));
        }
    }
    out
}

fn b64_clean(text: &str) -> Vec<u8> {
    let clean: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    b64::decode(&clean).unwrap_or_default()
}

/// Текущее время в виде `2026-11-14T10:00:00Z` — так его пишет манифест.
pub fn iso_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (days, rest) = ((secs / 86_400) as i64, secs % 86_400);
    let (hour, minute, second) = (rest / 3600, (rest % 3600) / 60, rest % 60);
    /* перевод дней от 1970-01-01 в календарь (алгоритм Говарда Хиннанта) */
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
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", year, month, day, hour, minute, second)
}

/* ─────────────────────────── клиент хранилища ─────────────────────────── */

/// Один файл в репозитории.
#[derive(Debug, Clone)]
pub struct RemoteFile {
    pub path: String,
    pub size: u64,
    pub sha: String,
}

/// Что сделать с файлом: `Some` — записать, `None` — удалить.
pub struct FileOp {
    pub path: String,
    pub data: Option<Vec<u8>>,
}

struct Client<'a> {
    provider: Provider,
    repo: String,
    branch: String,
    token: &'a str,
    github_api: String,
    gitlab_api: String,
}

impl<'a> Client<'a> {
    fn new(
        provider: Provider,
        repo: String,
        branch: String,
        token: &'a str,
        github_api: String,
        gitlab_api: String,
    ) -> Client<'a> {
        Client { provider, repo, branch, token, github_api, gitlab_api }
    }

    fn gitlab_project(&self) -> String {
        url_encode(&self.repo, false)
    }

    /// Заголовок авторизации: GitHub ждёт `Bearer`, GitLab — `PRIVATE-TOKEN`.
    fn header(&self) -> (&'static str, String) {
        match self.provider {
            Provider::GitHub => ("Authorization", format!("Bearer {}", self.token.trim())),
            Provider::GitLab => ("PRIVATE-TOKEN", self.token.trim().to_string()),
        }
    }

    fn github(&self, path: &str) -> Result<net::Reply, String> {
        net::get_with_token(&format!("{}{}", self.github_api, path), self.token)
    }

    fn gitlab(&self, path: &str) -> Result<net::Reply, String> {
        let (name, value) = self.header();
        net::request_with_header("GET", &format!("{}{}", self.gitlab_api, path), Some((name, &value)), None)
    }

    fn write_json(&self, method: &str, url: &str, body: &Value) -> Result<net::Reply, String> {
        let text = body.to_json();
        let (name, value) = self.header();
        net::request_with_header(
            method,
            url,
            Some((name, &value)),
            Some(("application/json", &text)),
        )
    }

    /// Коммит последней версии ветки (None — ветки ещё нет, репозиторий пуст).
    fn head(&self) -> Result<Option<String>, String> {
        match self.provider {
            Provider::GitHub => {
                let reply = self.github(&format!("/repos/{}/git/ref/heads/{}", self.repo, url_encode(&self.branch, false)))?;
                if reply.status == 404 || reply.status == 409 {
                    return Ok(None);
                }
                if !reply.ok() {
                    return Err(reply.error_text("GitHub не отдал ветку"));
                }
                let sha = reply.json().get("object").and_then(|o| o.get("sha")).map(|v| v.text());
                Ok(sha.filter(|s| !s.is_empty()))
            }
            Provider::GitLab => {
                let reply = self.gitlab(&format!(
                    "/projects/{}/repository/branches/{}",
                    self.gitlab_project(),
                    url_encode(&self.branch, false)
                ))?;
                if reply.status == 404 {
                    return Ok(None);
                }
                if !reply.ok() {
                    return Err(reply.error_text("GitLab не отдал ветку"));
                }
                let sha = reply.json().get("commit").and_then(|c| c.get("id")).map(|v| v.text());
                Ok(sha.filter(|s| !s.is_empty()))
            }
        }
    }

    /// Дерево коммита (GitHub отдаёт его отдельным запросом).
    fn commit_tree(&self, commit: &str) -> Result<String, String> {
        let reply = self.github(&format!("/repos/{}/git/commits/{}", self.repo, commit))?;
        if !reply.ok() {
            return Err(reply.error_text("GitHub не отдал коммит"));
        }
        Ok(reply
            .json()
            .get("tree")
            .map(|t| t.get("sha").map(|s| s.text()).unwrap_or_default())
            .unwrap_or_default())
    }

    /// Все файлы коммита.
    fn tree(&self, commit: &str) -> Result<Vec<RemoteFile>, String> {
        let mut files = Vec::new();
        match self.provider {
            Provider::GitHub => {
                /* дерево адресуется по sha дерева, а на руках у нас коммит */
                let tree_sha = self.commit_tree(commit)?;
                let reply = self.github(&format!("/repos/{}/git/trees/{}?recursive=1", self.repo, tree_sha))?;
                if !reply.ok() {
                    return Err(reply.error_text("GitHub не отдал список файлов"));
                }
                let body = reply.json();
                for item in body.get("tree").map(|t| t.as_arr()).unwrap_or(&[]) {
                    if item.get("type").map(|t| t.text()) .as_deref() != Some("blob") {
                        continue;
                    }
                    files.push(RemoteFile {
                        path: item.get("path").map(|p| p.text()).unwrap_or_default(),
                        size: item.get("size").and_then(|s| s.as_f64()).unwrap_or(0.0) as u64,
                        sha: item.get("sha").map(|s| s.text()).unwrap_or_default(),
                    });
                }
            }
            Provider::GitLab => {
                let mut page = 1;
                loop {
                    let reply = self.gitlab(&format!(
                        "/projects/{}/repository/tree?ref={}&recursive=true&per_page=100&page={}",
                        self.gitlab_project(),
                        url_encode(&self.branch, false),
                        page
                    ))?;
                    if reply.status == 404 {
                        break;
                    }
                    if !reply.ok() {
                        return Err(reply.error_text("GitLab не отдал список файлов"));
                    }
                    let body = reply.json();
                    let items = body.as_arr();
                    if items.is_empty() {
                        break;
                    }
                    for item in items {
                        if item.get("type").map(|t| t.text()).as_deref() != Some("blob") {
                            continue;
                        }
                        files.push(RemoteFile {
                            path: item.get("path").map(|p| p.text()).unwrap_or_default(),
                            size: 0,
                            sha: item.get("id").map(|s| s.text()).unwrap_or_default(),
                        });
                    }
                    if items.len() < 100 {
                        break;
                    }
                    page += 1;
                }
            }
        }
        Ok(files)
    }

    /// Чтение файла ветки. None — файла нет.
    fn read(&self, rel: &str) -> Result<Option<Vec<u8>>, String> {
        match self.provider {
            Provider::GitHub => {
                let reply = self.github(&format!(
                    "/repos/{}/contents/{}?ref={}",
                    self.repo,
                    url_encode(rel, true),
                    url_encode(&self.branch, false)
                ))?;
                if reply.status == 404 {
                    return Ok(None);
                }
                if !reply.ok() {
                    return Err(reply.error_text("GitHub не отдал файл"));
                }
                let body = reply.json();
                if let Some(text) = body.get("content") {
                    return Ok(Some(b64_clean(&text.text())));
                }
                /* очень большие файлы приходят без содержимого — берём по sha */
                if let Some(sha) = body.get("sha") {
                    return self.blob(&sha.text()).map(Some);
                }
                Ok(None)
            }
            Provider::GitLab => {
                let url = format!(
                    "{}/projects/{}/repository/files/{}/raw?ref={}",
                    self.gitlab_api,
                    self.gitlab_project(),
                    url_encode(rel, false),
                    url_encode(&self.branch, false)
                );
                let (name, value) = self.header();
                let (status, body) = net::get_bytes(&url, Some((name, &value)))?;
                if status == 404 {
                    return Ok(None);
                }
                if status >= 400 {
                    return Err(format!("GitLab не отдал файл {} (код {})", rel, status));
                }
                Ok(Some(body))
            }
        }
    }

    /// Двоичный файл по его sha (GitHub отдаёт его только так).
    fn blob(&self, sha: &str) -> Result<Vec<u8>, String> {
        let reply = self.github(&format!("/repos/{}/git/blobs/{}", self.repo, sha))?;
        if !reply.ok() {
            return Err(reply.error_text("GitHub не отдал содержимое файла"));
        }
        let body = reply.json();
        Ok(b64_clean(&body.get("content").map(|c| c.text()).unwrap_or_default()))
    }

    /// Записывает набор файлов одним коммитом. Возвращает sha коммита.
    fn write(&self, ops: &[FileOp], message: &str) -> Result<String, String> {
        match self.provider {
            Provider::GitHub => self.write_github(ops, message),
            Provider::GitLab => self.write_gitlab(ops, message),
        }
    }

    fn write_github(&self, ops: &[FileOp], message: &str) -> Result<String, String> {
        let head = self.head()?;
        let mut base_tree = String::new();
        if let Some(head) = &head {
            let reply = self.github(&format!("/repos/{}/git/commits/{}", self.repo, head))?;
            if !reply.ok() {
                return Err(reply.error_text("GitHub не отдал коммит ветки"));
            }
            base_tree = reply.json().get("tree").map(|t| t.get("sha").map(|s| s.text()).unwrap_or_default()).unwrap_or_default();
        }

        let mut tree: Vec<Value> = Vec::new();
        for op in ops {
            let sha = match &op.data {
                Some(data) => {
                    let body = Value::obj(vec![
                        ("content", Value::str(b64::encode(data))),
                        ("encoding", Value::str("base64")),
                    ]);
                    let reply = self.write_json("POST", &format!("{}/repos/{}/git/blobs", self.github_api, self.repo), &body)?;
                    if !reply.ok() {
                        return Err(reply.error_text(&format!("GitHub не принял файл {}", op.path)));
                    }
                    Value::str(reply.json().get("sha").map(|s| s.text()).unwrap_or_default())
                }
                None => Value::Null,
            };
            tree.push(Value::obj(vec![
                ("path", Value::str(&op.path)),
                ("mode", Value::str("100644")),
                ("type", Value::str("blob")),
                ("sha", sha),
            ]));
        }

        let mut tree_body = vec![("tree", Value::Arr(tree))];
        if !base_tree.is_empty() {
            tree_body.push(("base_tree", Value::str(base_tree)));
        }
        let reply = self.write_json("POST", &format!("{}/repos/{}/git/trees", self.github_api, self.repo), &Value::obj(tree_body))?;
        if !reply.ok() {
            return Err(reply.error_text("GitHub не собрал дерево файлов"));
        }
        let tree_sha = reply.json().get("sha").map(|s| s.text()).unwrap_or_default();

        let parents = match &head {
            Some(head) => Value::Arr(vec![Value::str(head)]),
            None => Value::Arr(Vec::new()),
        };
        let commit_body = Value::obj(vec![
            ("message", Value::str(message)),
            ("tree", Value::str(tree_sha)),
            ("parents", parents),
        ]);
        let reply = self.write_json("POST", &format!("{}/repos/{}/git/commits", self.github_api, self.repo), &commit_body)?;
        if !reply.ok() {
            return Err(reply.error_text("GitHub не создал коммит"));
        }
        let commit = reply.json().get("sha").map(|s| s.text()).unwrap_or_default();

        if head.is_some() {
            let body = Value::obj(vec![("sha", Value::str(&commit)), ("force", Value::Bool(false))]);
            let reply = self.write_json(
                "PATCH",
                &format!("{}/repos/{}/git/refs/heads/{}", self.github_api, self.repo, url_encode(&self.branch, false)),
                &body,
            )?;
            if !reply.ok() {
                return Err(reply.error_text("GitHub не сдвинул ветку"));
            }
        } else {
            let body = Value::obj(vec![
                ("ref", Value::str(format!("refs/heads/{}", self.branch))),
                ("sha", Value::str(&commit)),
            ]);
            let reply = self.write_json("POST", &format!("{}/repos/{}/git/refs", self.github_api, self.repo), &body)?;
            if !reply.ok() {
                return Err(reply.error_text("GitHub не создал ветку"));
            }
        }
        Ok(commit)
    }

    fn write_gitlab(&self, ops: &[FileOp], message: &str) -> Result<String, String> {
        let head = self.head()?;
        let existing: HashSet<String> = match &head {
            Some(sha) => self.tree(sha)?.into_iter().map(|f| f.path).collect(),
            None => HashSet::new(),
        };

        let mut actions: Vec<Value> = Vec::new();
        for op in ops {
            let action = match (&op.data, existing.contains(&op.path)) {
                (Some(_), true) => "update",
                (Some(_), false) => "create",
                (None, _) => "delete",
            };
            let mut fields = vec![
                ("action", Value::str(action)),
                ("file_path", Value::str(&op.path)),
            ];
            if let Some(data) = &op.data {
                fields.push(("content", Value::str(b64::encode(data))));
                fields.push(("encoding", Value::str("base64")));
            }
            actions.push(Value::obj(fields));
        }

        let body = Value::obj(vec![
            ("branch", Value::str(&self.branch)),
            ("commit_message", Value::str(message)),
            ("actions", Value::Arr(actions)),
        ]);
        let url = format!("{}/projects/{}/repository/commits", self.gitlab_api, self.gitlab_project());
        let reply = self.write_json("POST", &url, &body)?;
        if reply.ok() {
            return Ok(reply.json().get("id").map(|s| s.text()).unwrap_or_default());
        }

        /* Пустой проект: у него ещё нет ветки, и GitLab отказывается делать
           коммит. Тогда первый файл кладём файловым API — он создаёт ветку сам. */
        let first = ops.iter().find(|op| op.data.is_some());
        if head.is_none() {
            if let Some(op) = first {
                let data = op.data.as_ref().expect("данные проверены выше");
                let body = Value::obj(vec![
                    ("branch", Value::str(&self.branch)),
                    ("commit_message", Value::str(message)),
                    ("content", Value::str(b64::encode(data))),
                    ("encoding", Value::str("base64")),
                ]);
                let url = format!(
                    "{}/projects/{}/repository/files/{}",
                    self.gitlab_api,
                    self.gitlab_project(),
                    url_encode(&op.path, false)
                );
                let reply = self.write_json("POST", &url, &body)?;
                if !reply.ok() {
                    return Err(reply.error_text("GitLab не принял первый файл"));
                }
                let rest: Vec<FileOp> = ops
                    .iter()
                    .filter(|other| other.path != op.path)
                    .map(|other| FileOp { path: other.path.clone(), data: other.data.clone() })
                    .collect();
                if rest.is_empty() {
                    return Ok(self.head()?.unwrap_or_default());
                }
                return self.write_gitlab(&rest, message);
            }
        }
        Err(reply.error_text("GitLab не принял изменения"))
    }
}

/* ─────────────────────────── настройки панели ─────────────────────────── */

/// Хранилище настроек синхронизации (токены, аккаунт, адреса API).
pub struct Sync {
    path: PathBuf,
    pub github_api: String,
    pub gitlab_api: String,
    pub oauth_base: String,
}

impl Sync {
    pub fn new(data_dir: &Path) -> Sync {
        Sync {
            path: data_dir.join("sync.json"),
            github_api: std::env::var("OMNI_GITHUB_API").unwrap_or_else(|_| GITHUB_API.to_string()),
            gitlab_api: std::env::var("OMNI_GITLAB_API").unwrap_or_else(|_| GITLAB_API.to_string()),
            oauth_base: std::env::var("OMNI_GITHUB_OAUTH").unwrap_or_else(|_| GITHUB_OAUTH.to_string()),
        }
    }

    /// Настройки с другими адресами — так тесты ходят в свой сервер.
    pub fn with_bases(data_dir: &Path, github_api: &str, gitlab_api: &str) -> Sync {
        Sync {
            path: data_dir.join("sync.json"),
            github_api: github_api.trim_end_matches('/').to_string(),
            gitlab_api: gitlab_api.trim_end_matches('/').to_string(),
            oauth_base: github_api.trim_end_matches('/').to_string(),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn read(&self) -> Value {
        std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|text| json::parse(&text).ok())
            .unwrap_or(Value::Obj(Vec::new()))
    }

    fn write(&self, patch: Vec<(&str, Value)>) -> Result<(), String> {
        let mut fields: Vec<(String, Value)> = match self.read() {
            Value::Obj(fields) => fields,
            _ => Vec::new(),
        };
        for (name, value) in patch {
            match fields.iter_mut().find(|(key, _)| key == name) {
                Some(slot) => slot.1 = value,
                None => fields.push((name.to_string(), value)),
            }
        }
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("не создать папку настроек: {}", e))?;
        }
        std::fs::write(&self.path, Value::Obj(fields).to_json_pretty())
            .map_err(|e| format!("не записать настройки: {}", e))
    }

    fn field(&self, name: &str) -> String {
        self.read().get(name).map(|v| v.text()).unwrap_or_default()
    }

    /// Токен GitHub (пустой — вход не выполнен).
    pub fn github_token(&self) -> String {
        self.field("githubToken").trim().to_string()
    }

    /// Токен GitLab.
    pub fn gitlab_token(&self) -> String {
        self.field("gitlabToken").trim().to_string()
    }

    /// Аккаунт GitHub для интерфейса. Токен наружу не отдаётся.
    pub fn account(&self) -> Value {
        let token = self.github_token();
        Value::obj(vec![
            ("token", Value::str(if token.is_empty() { String::new() } else { "•".repeat(8) })),
            ("hasToken", Value::Bool(!token.is_empty())),
            ("login", Value::str(self.field("githubLogin"))),
            ("name", Value::str(self.field("githubName"))),
            ("avatar", Value::str(self.field("githubAvatar"))),
        ])
    }

    /// Вход по токену: сначала проверяем, что GitHub его знает.
    pub fn login(&self, token: &str) -> Value {
        let token = if token.trim().is_empty() { self.github_token() } else { token.trim().to_string() };
        if token.is_empty() {
            return error_json("Вставь токен GitHub");
        }
        match self.github_user(&token) {
            Ok(user) => {
                let login = user.0.clone();
                let _ = self.write(vec![
                    ("githubToken", Value::str(&token)),
                    ("githubLogin", Value::str(user.0)),
                    ("githubName", Value::str(user.1.clone())),
                    ("githubAvatar", Value::str(user.2.clone())),
                ]);
                Value::obj(vec![
                    ("ok", Value::Bool(true)),
                    ("login", Value::str(login)),
                    ("name", Value::str(user.1)),
                    ("avatar", Value::str(user.2)),
                    ("hasToken", Value::Bool(true)),
                ])
            }
            Err(message) => error_json(message),
        }
    }

    /// Выход: токен и имя исчезают из файла настроек.
    pub fn logout(&self) -> Value {
        let _ = self.write(vec![
            ("githubToken", Value::str("")),
            ("githubLogin", Value::str("")),
            ("githubName", Value::str("")),
            ("githubAvatar", Value::str("")),
        ]);
        ok_json()
    }

    pub fn oauth_client_id(&self) -> String {
        let saved = self.field("githubOauthClientId");
        if saved.trim().is_empty() {
            OAUTH_CLIENT_ID.to_string()
        } else {
            saved
        }
    }

    pub fn set_oauth_client_id(&self, id: &str) -> Value {
        let value = id.trim().to_string();
        let _ = self.write(vec![("githubOauthClientId", Value::str(&value))]);
        Value::str(value)
    }

    /// Сведения об аккаунте GitHub: логин, имя, аватар.
    fn github_user(&self, token: &str) -> Result<(String, String, String), String> {
        let reply = net::get_with_token(&format!("{}/user", self.github_api), token)?;
        if !reply.ok() {
            return Err(reply.error_text("GitHub не принял токен"));
        }
        let body = reply.json();
        Ok((
            body.get("login").map(|v| v.text()).unwrap_or_default(),
            body.get("name").map(|v| v.text()).unwrap_or_default(),
            body.get("avatar_url").map(|v| v.text()).unwrap_or_default(),
        ))
    }

    /// Проверка токена и доступа к репозиторию (кнопка «Проверить» в настройках).
    pub fn verify(&self, cfg: &Value) -> Value {
        let token = cfg.get("token").map(|v| v.text()).unwrap_or_default();
        let token = if token.trim().is_empty() { self.github_token() } else { token.trim().to_string() };
        let repo = norm_repo(&cfg.get("repo").map(|v| v.text()).unwrap_or_default());
        if token.is_empty() {
            return error_json("Вставь токен GitHub");
        }
        match self.github_user(&token) {
            Ok((login, _, _)) => {
                let mut out = vec![
                    ("ok", Value::Bool(true)),
                    ("login", Value::str(login)),
                ];
                if !repo.is_empty() {
                    let reply = match net::get_with_token(&format!("{}/repos/{}", self.github_api, repo), &token) {
                        Ok(reply) => reply,
                        Err(message) => return error_json(message),
                    };
                    if reply.ok() {
                        out.push(("repo", Value::str(&repo)));
                        out.push(("canPush", Value::Bool(
                            reply.json().get("permissions").and_then(|p| p.get("push")).map(|v| v.as_bool()).unwrap_or(true),
                        )));
                    } else {
                        return error_json(reply.error_text("Репозиторий недоступен"));
                    }
                }
                Value::obj(out)
            }
            Err(message) => error_json(message),
        }
    }

    /// Репозитории аккаунта.
    pub fn repos(&self, query: &str) -> Value {
        let token = self.github_token();
        if token.is_empty() {
            return error_json("Сначала войди в GitHub");
        }
        let reply = match net::get_with_token(
            &format!("{}/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator", self.github_api),
            &token,
        ) {
            Ok(reply) => reply,
            Err(message) => return error_json(message),
        };
        if !reply.ok() {
            return error_json(reply.error_text("GitHub не отдал список репозиториев"));
        }
        let want = query.trim().to_lowercase();
        let mut repos = Vec::new();
        for item in reply.json().as_arr() {
            let full = item.get("full_name").map(|v| v.text()).unwrap_or_default();
            if !want.is_empty() && !full.to_lowercase().contains(&want) {
                continue;
            }
            repos.push(Value::obj(vec![
                ("full", Value::str(&full)),
                ("name", Value::str(item.get("name").map(|v| v.text()).unwrap_or_default())),
                ("private", Value::Bool(item.get("private").map(|v| v.as_bool()).unwrap_or(false))),
            ]));
        }
        Value::obj(vec![
            ("ok", Value::Bool(true)),
            ("repos", Value::Arr(repos)),
        ])
    }

    /// Новый репозиторий (с первым коммитом, чтобы ветка сразу существовала).
    pub fn create_repo(&self, name: &str, private: bool) -> Value {
        let token = self.github_token();
        if token.is_empty() {
            return error_json("Сначала войди в GitHub");
        }
        let clean = name.trim().replace(' ', "-");
        if clean.is_empty() {
            return error_json("Впиши имя репозитория");
        }
        let body = Value::obj(vec![
            ("name", Value::str(&clean)),
            ("private", Value::Bool(private)),
            ("auto_init", Value::Bool(true)),
        ]);
        let reply = match net::post_json(&format!("{}/user/repos", self.github_api), &token, &body) {
            Ok(reply) => reply,
            Err(message) => return error_json(message),
        };
        if !reply.ok() {
            return error_json(reply.error_text("GitHub не создал репозиторий"));
        }
        let body = reply.json();
        Value::obj(vec![
            ("ok", Value::Bool(true)),
            ("full", Value::str(body.get("full_name").map(|v| v.text()).unwrap_or_default())),
            ("private", Value::Bool(body.get("private").map(|v| v.as_bool()).unwrap_or(private))),
        ])
    }

    /* ─── вход по коду (device flow) ─── */

    /// Шаг 1: панель просит у GitHub код для входа.
    pub fn device_start(&self) -> Value {
        let client_id = self.oauth_client_id();
        let body = format!("client_id={}&scope={}", url_encode(&client_id, false), url_encode("repo read:user", false));
        let reply = match net::request_with_header(
            "POST",
            &format!("{}/login/device/code", self.oauth_base),
            Some(("Accept", "application/json")),
            Some(("application/x-www-form-urlencoded", &body)),
        ) {
            Ok(reply) => reply,
            Err(message) => return error_json(message),
        };
        if !reply.ok() {
            return error_json(reply.error_text("GitHub не выдал код"));
        }
        let body = reply.json();
        Value::obj(vec![
            ("ok", Value::Bool(true)),
            ("deviceCode", Value::str(body.get("device_code").map(|v| v.text()).unwrap_or_default())),
            ("userCode", Value::str(body.get("user_code").map(|v| v.text()).unwrap_or_default())),
            ("verificationUri", Value::str(body.get("verification_uri").map(|v| v.text()).unwrap_or_default())),
            ("expiresIn", Value::Num(body.get("expires_in").and_then(|v| v.as_f64()).unwrap_or(900.0))),
            ("interval", Value::Num(body.get("interval").and_then(|v| v.as_f64()).unwrap_or(5.0))),
        ])
    }

    /// Шаг 2: панель спрашивает, подтвердил ли пользователь вход.
    pub fn device_poll(&self, device_code: &str) -> Value {
        let client_id = self.oauth_client_id();
        let body = format!(
            "client_id={}&device_code={}&grant_type={}",
            url_encode(&client_id, false),
            url_encode(device_code, false),
            url_encode("urn:ietf:params:oauth:grant-type:device_code", false)
        );
        let reply = match net::request_with_header(
            "POST",
            &format!("{}/login/oauth/access_token", self.oauth_base),
            Some(("Accept", "application/json")),
            Some(("application/x-www-form-urlencoded", &body)),
        ) {
            Ok(reply) => reply,
            Err(message) => return error_json(message),
        };
        let body = reply.json();
        if let Some(err) = body.get("error").map(|v| v.text()) {
            if !err.is_empty() && err != "null" {
                let text = match err.as_str() {
                    "authorization_pending" => "Ждём подтверждения на github.com",
                    "slow_down" => "GitHub просит реже спрашивать — подожди немного",
                    "expired_token" => "Код устарел — начни вход заново",
                    "access_denied" => "Вход отменён на github.com",
                    other => other,
                };
                return Value::obj(vec![
                    ("ok", Value::Bool(false)),
                    ("pending", Value::Bool(err == "authorization_pending" || err == "slow_down")),
                    ("error", Value::str(text)),
                ]);
            }
        }
        let token = body.get("access_token").map(|v| v.text()).unwrap_or_default();
        if token.is_empty() {
            return Value::obj(vec![
                ("ok", Value::Bool(false)),
                ("pending", Value::Bool(true)),
                ("error", Value::str("Ждём подтверждения на github.com")),
            ]);
        }
        match self.github_user(&token) {
            Ok((login, name, avatar)) => {
                let _ = self.write(vec![
                    ("githubToken", Value::str(&token)),
                    ("githubLogin", Value::str(&login)),
                    ("githubName", Value::str(&name)),
                    ("githubAvatar", Value::str(&avatar)),
                ]);
                Value::obj(vec![
                    ("ok", Value::Bool(true)),
                    ("login", Value::str(login)),
                    ("name", Value::str(name)),
                    ("avatar", Value::str(avatar)),
                ])
            }
            Err(message) => error_json(message),
        }
    }

    /* ─── GitLab ─── */

    pub fn gitlab_account(&self) -> Value {
        let token = self.gitlab_token();
        Value::obj(vec![
            ("hasToken", Value::Bool(!token.is_empty())),
            ("token", Value::str(if token.is_empty() { String::new() } else { "***".to_string() })),
        ])
    }

    pub fn gitlab_save(&self, token: &str) -> Value {
        let _ = self.write(vec![("gitlabToken", Value::str(token.trim()))]);
        ok_json()
    }

    fn gitlab_get(&self, token: &str, path: &str) -> Result<net::Reply, String> {
        let header = ("PRIVATE-TOKEN", token.trim().to_string());
        net::request_with_header("GET", &format!("{}{}", self.gitlab_api, path), Some((header.0, header.1.as_str())), None)
    }

    /// Проверка токена GitLab и доступа к проекту.
    pub fn gitlab_check(&self, cfg: &Value) -> Value {
        let given = cfg.get("token").map(|v| v.text()).unwrap_or_default();
        let token = if given.trim().is_empty() { self.gitlab_token() } else { given.trim().to_string() };
        if token.is_empty() {
            return error_json("Впиши токен GitLab");
        }
        let reply = match self.gitlab_get(&token, "/user") {
            Ok(reply) => reply,
            Err(message) => return error_json(message),
        };
        if !reply.ok() {
            return error_json(reply.error_text("GitLab не принял токен"));
        }
        let login = reply.json().get("username").map(|v| v.text()).unwrap_or_default();
        if !given.trim().is_empty() {
            let _ = self.write(vec![("gitlabToken", Value::str(&token))]);
        }
        let repo = cfg.get("repo").map(|v| v.text()).unwrap_or_default();
        let mut out = vec![("ok", Value::Bool(true)), ("login", Value::str(&login))];
        if !repo.trim().is_empty() {
            let reply = match self.gitlab_get(&token, &format!("/projects/{}", url_encode(repo.trim(), false))) {
                Ok(reply) => reply,
                Err(message) => return error_json(message),
            };
            if reply.ok() {
                out.push(("repo", Value::str(repo.trim())));
            } else {
                return error_json(reply.error_text("Проект GitLab недоступен"));
            }
        }
        Value::obj(out)
    }

    /// Проекты GitLab, где пользователь состоит.
    pub fn gitlab_projects(&self, query: &str) -> Value {
        let token = self.gitlab_token();
        if token.is_empty() {
            return error_json("Нет токена GitLab — впиши его в настройках сервера");
        }
        let reply = match self.gitlab_get(&token, "/projects?membership=true&simple=true&per_page=100&order_by=last_activity_at") {
            Ok(reply) => reply,
            Err(message) => return error_json(message),
        };
        if !reply.ok() {
            return error_json(reply.error_text("GitLab не отдал список проектов"));
        }
        let want = query.trim().to_lowercase();
        let mut repos = Vec::new();
        for item in reply.json().as_arr() {
            let full = item.get("path_with_namespace").map(|v| v.text()).unwrap_or_default();
            if !want.is_empty() && !full.to_lowercase().contains(&want) {
                continue;
            }
            repos.push(Value::obj(vec![
                ("full", Value::str(&full)),
                ("name", Value::str(item.get("name").map(|v| v.text()).unwrap_or_default())),
                ("private", Value::Bool(item.get("visibility").map(|v| v.text()).as_deref() != Some("public"))),
            ]));
        }
        Value::obj(vec![("ok", Value::Bool(true)), ("repos", Value::Arr(repos))])
    }
}

/* ─────────────────────────── общие ответы ─────────────────────────── */

pub fn ok_json() -> Value {
    Value::obj(vec![("ok", Value::Bool(true))])
}

pub fn error_json(message: impl Into<String>) -> Value {
    Value::obj(vec![("ok", Value::Bool(false)), ("error", Value::str(message))])
}

/// `owner/name` из любой записи адреса репозитория.
pub fn norm_repo(repo: &str) -> String {
    let mut text = repo.trim().to_string();
    for prefix in ["https://github.com/", "http://github.com/", "https://gitlab.com/", "http://gitlab.com/", "git@github.com:", "git@gitlab.com:"] {
        if let Some(rest) = text.strip_prefix(prefix) {
            text = rest.to_string();
            break;
        }
    }
    text = text.trim_end_matches('/').trim_end_matches(".git").to_string();
    text
}

/// Имя ветки: пустое → `main`.
pub fn norm_branch(branch: &str) -> String {
    let text = branch.trim().trim_start_matches("refs/heads/");
    if text.is_empty() {
        "main".to_string()
    } else {
        text.to_string()
    }
}

/* ───────────────────────── сбор файлов сервера ───────────────────────── */

/// Файл, готовый к упаковке: путь внутри сервера и место на диске.
pub use crate::zip::InputFile as Source;

fn junk(rel: &str) -> bool {
    let lower = rel.to_lowercase();
    let named = |name: &str| lower == name || lower.starts_with(&format!("{}/", name)) || lower.contains(&format!("/{}/", name)) || lower.ends_with(&format!("/{}", name));
    let mut parts = lower.split('/');
    if parts.any(|part| matches!(part, ".git" | "logs" | "log" | "crash-reports" | "cache" | "libraries" | "versions" | "backup" | "backups")) {
        return true;
    }
    lower.ends_with(".ds_store")
        || lower.ends_with("thumbs.db")
        || lower.ends_with(".log")
        || lower.ends_with("session.lock")
        || (lower.ends_with(".lock") && !lower.ends_with("level.dat"))
        || named("session.lock")
}

/// Каталоги мира: `level-name` из настроек плюс стандартные измерения.
pub fn world_dirs(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = vec!["world".into(), "world_nether".into(), "world_the_end".into()];
    if let Ok(text) = std::fs::read_to_string(dir.join("server.properties")) {
        for line in text.lines() {
            if let Some(value) = line.trim().strip_prefix("level-name") {
                let name = value.trim_start_matches(['=', ' ']).trim();
                if !name.is_empty() && !names.iter().any(|n| n == name) {
                    names.push(name.to_string());
                }
            }
        }
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            if entry.path().join("level.dat").exists() {
                let name = entry.file_name().to_string_lossy().to_string();
                if !names.iter().any(|n| n == &name) {
                    names.push(name);
                }
            }
        }
    }
    names
}

/// Подходит ли файл под выбранную область синхронизации.
pub fn in_scope(rel: &str, scope: &str, worlds: &[String]) -> bool {
    if junk(rel) {
        return false;
    }
    let lower = rel.to_lowercase();
    if lower.ends_with(".zip") || lower.ends_with(".tar") || lower.ends_with(".gz") || lower.ends_with(".7z") {
        return false;
    }
    if scope == "all" {
        return true;
    }
    if lower.ends_with(".jar") {
        return false;
    }
    let in_world = worlds.iter().any(|w| rel == w || rel.starts_with(&format!("{}/", w)));
    if in_world {
        return true;
    }
    if scope == "config" {
        if matches!(rel, "server.properties" | "bukkit.yml" | "spigot.yml" | "paper.yml") {
            return true;
        }
        let config_ext = [".yml", ".yaml", ".json", ".properties", ".txt", ".conf", ".cfg", ".toml", ".xml", ".ini", ".md", ".mcmeta", ".snbt"];
        let in_config_dir = lower.split('/').any(|part| matches!(part, "plugins" | "config" | "data"));
        return config_ext.iter().any(|ext| lower.ends_with(ext)) && in_config_dir;
    }
    false
}

/// Обходит папку сервера и собирает файлы для отправки.
pub fn collect(dir: &Path, scope: &str) -> Result<Vec<Source>, String> {
    if !dir.exists() {
        return Err(format!("Папка сервера не найдена: {}", dir.display()));
    }
    let worlds = world_dirs(dir);
    let mut out = Vec::new();
    let mut stack = vec![String::new()];
    while let Some(rel) = stack.pop() {
        let current = if rel.is_empty() { dir.to_path_buf() } else { dir.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR)) };
        let entries = match std::fs::read_dir(&current) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let child = if rel.is_empty() { name.clone() } else { format!("{}/{}", rel, name) };
            let path = entry.path();
            let meta = match std::fs::symlink_metadata(&path) {
                Ok(meta) => meta,
                Err(_) => continue,
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                if junk(&format!("{}/", child)) {
                    continue;
                }
                stack.push(child);
            } else if meta.is_file() && in_scope(&child, scope, &worlds) {
                out.push(Source { name: child, path });
            }
        }
        if out.len() > 200_000 {
            return Err("В папке сервера слишком много файлов — проверь, что выбрана верная папка".into());
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Команда запуска по содержимому папки (после скачивания сервера из сети).
pub fn guess_command(dir: &Path) -> String {
    let known = [
        ("fabric-server-launch.jar", "java -Xmx4G -jar fabric-server-launch.jar nogui"),
        ("paper.jar", "java -Xmx4G -jar paper.jar nogui"),
        ("purpur.jar", "java -Xmx4G -jar purpur.jar nogui"),
        ("spigot.jar", "java -Xmx4G -jar spigot.jar nogui"),
        ("velocity.jar", "java -Xmx2G -jar velocity.jar"),
        ("server.jar", "java -Xmx4G -jar server.jar nogui"),
    ];
    for (name, command) in known {
        if dir.join(name).exists() {
            return command.to_string();
        }
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let lower = name.to_lowercase();
            if lower.ends_with(".jar") && !lower.contains("install") {
                return format!("java -Xmx4G -jar \"{}\" nogui", name);
            }
        }
    }
    String::new()
}

/* ─────────────────────────── состояние синхронизации ─────────────────────────── */

fn load_state(path: &Path) -> Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| json::parse(&text).ok())
        .unwrap_or(Value::Obj(Vec::new()))
}

fn save_state(path: &Path, commit: &str, branch: &str, extra: Vec<(&str, Value)>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("не создать папку состояния: {}", e))?;
    }
    let mut fields = vec![
        ("commit".to_string(), Value::str(commit)),
        ("branch".to_string(), Value::str(branch)),
        ("at".to_string(), Value::str(iso_now())),
    ];
    for (name, value) in extra {
        fields.push((name.to_string(), value));
    }
    std::fs::write(path, Value::Obj(fields).to_json_pretty())
        .map_err(|e| format!("не записать состояние: {}", e))
}

/// Что известно о прошлой синхронизации сервера.
pub fn status(state_file: &Path) -> Value {
    let state = load_state(state_file);
    Value::obj(vec![
        ("commit", Value::str(state.get("commit").map(|v| v.text()).unwrap_or_default())),
        ("at", Value::str(state.get("at").map(|v| v.text()).unwrap_or_default())),
        ("branch", Value::str(state.get("branch").map(|v| v.text()).unwrap_or_default())),
        ("files", Value::Num(state.get("files").map(|v| v.as_arr().len()).unwrap_or(0) as f64)),
    ])
}

/// Забыть состояние (кнопка «Забыть» — панель начнёт сравнивать заново).
pub fn forget(state_file: &Path) -> Value {
    match std::fs::remove_file(state_file) {
        Ok(_) => ok_json(),
        Err(_) => ok_json(),
    }
}

/* ─────────────────────────── отправка и забор ─────────────────────────── */

/// Отправка сервера в хранилище.
pub fn push(sync: &Sync, opts: &mut Options) -> Value {
    let repo = norm_repo(&opts.repo);
    let branch = norm_branch(&opts.branch);
    if repo.is_empty() || !repo.contains('/') {
        return error_json("Не указан репозиторий вида владелец/имя");
    }
    if opts.token.trim().is_empty() {
        return error_json(format!("Нет токена {} — войди в аккаунт", opts.provider.name()));
    }
    if !opts.dir.exists() {
        return error_json(format!("Папка сервера не найдена: {}", opts.dir.display()));
    }
    let token = opts.token.trim().to_string();
    let client = Client::new(
        opts.provider,
        repo.clone(),
        branch.clone(),
        &token,
        sync.github_api.clone(),
        sync.gitlab_api.clone(),
    );
    let result = if opts.mode == "files" || opts.scope != "all" {
        push_files(&client, opts)
    } else {
        push_archive(&client, opts)
    };
    match result {
        Ok(mut value) => {
            value = with_logs(value, &opts.logs);
            value
        }
        Err(message) => with_logs(error_json(message), &opts.logs),
    }
}

/// Забор сервера из хранилища.
pub fn pull(sync: &Sync, opts: &mut Options) -> Value {
    let repo = norm_repo(&opts.repo);
    let branch = norm_branch(&opts.branch);
    if repo.is_empty() || !repo.contains('/') {
        return error_json("Не указан репозиторий вида владелец/имя");
    }
    if opts.token.trim().is_empty() {
        return error_json(format!("Нет токена {} — войди в аккаунт", opts.provider.name()));
    }
    if !opts.dir.exists() {
        return error_json(format!("Папка сервера не найдена: {}", opts.dir.display()));
    }
    let token = opts.token.trim().to_string();
    let client = Client::new(
        opts.provider,
        repo,
        branch,
        &token,
        sync.github_api.clone(),
        sync.gitlab_api.clone(),
    );
    let result = if opts.mode == "files" || opts.scope != "all" {
        pull_files(&client, opts)
    } else {
        pull_archive(&client, opts)
    };
    match result {
        Ok(value) => with_logs(value, &opts.logs),
        Err(message) => with_logs(error_json(message), &opts.logs),
    }
}

fn with_logs(mut value: Value, logs: &[String]) -> Value {
    if !logs.is_empty() {
        if let Value::Obj(fields) = &mut value {
            fields.push(("log".to_string(), Value::Arr(logs.iter().map(|line| Value::str(line.clone())).collect())));
        }
    }
    value
}

/// Архивирование: шаг 1 — собрать архив, шаг 2 — отправить частями.
fn push_archive(client: &Client, opts: &mut Options) -> Result<Value, String> {
    let sources = collect(&opts.dir, "all")?;
    let raw: u64 = sources
        .iter()
        .filter_map(|s| std::fs::metadata(&s.path).ok().map(|m| m.len()))
        .sum();
    let files = sources.len();
    opts.log(format!(
        "шаг 1 из 2: архивирую сервер (файлов {}, {} МБ)…",
        files,
        megabytes(raw)
    ));

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = std::env::temp_dir().join(format!("omnipanel-sync-{}-{}", std::process::id(), stamp));
    std::fs::create_dir_all(&tmp).map_err(|e| format!("не создать временную папку: {}", e))?;
    let guard = TempDir(tmp.clone());
    let archive_path = tmp.join("сервер.zip");
    let packed = zip::create_from_files(&archive_path, &sources)?;
    debug_assert!(packed > 0 || sources.is_empty(), "архив пуст");
    let (parts, bytes) = split_file(&archive_path, &tmp, opts.split_mb)?;
    opts.log(format!(
        "архив готов: {} МБ из {} МБ, частей {}",
        megabytes(bytes),
        megabytes(raw),
        parts.len()
    ));
    if parts.len() > MAX_PARTS {
        return Err(format!(
            "Сервер упакован в {} МБ — это больше, чем {} готов принять ({} частей по {} МБ). Убери крупные файлы из папки сервера.",
            megabytes(bytes),
            client.provider.name(),
            MAX_PARTS,
            opts.split_mb
        ));
    }
    if let Some(big) = parts.iter().find(|p| p.size > HARD_LIMIT) {
        return Err(format!(
            "Одна часть архива получилась {} МБ — хранилище не принимает файлы больше {} МБ.",
            megabytes(big.size),
            megabytes(HARD_LIMIT)
        ));
    }

    let manifest = Value::obj(vec![
        ("createdAt", Value::str(iso_now())),
        ("format", Value::str("zip")),
        ("files", Value::Num(files as f64)),
        ("raw", Value::Num(raw as f64)),
        ("packed", Value::Num(bytes as f64)),
        (
            "parts",
            Value::Arr(
                parts
                    .iter()
                    .map(|part| {
                        Value::obj(vec![
                            ("name", Value::str(&part.name)),
                            ("size", Value::Num(part.size as f64)),
                            ("sha256", Value::str(&part.sha256)),
                        ])
                    })
                    .collect(),
            ),
        ),
        ("cleanup", Value::Bool(opts.cleanup)),
    ]);
    let manifest_text = manifest.to_json_pretty();

    /* если в хранилище лежит ровно такой же архив — отправлять нечего */
    let head = client.head()?;
    if let Some(head) = &head {
        if let Some(remote) = client.read(MANIFEST_PATH)? {
            let same = same_parts(&remote, &parts);
            if same {
                save_state(
                    &opts.state_file,
                    head,
                    &client.branch,
                    vec![
                        ("mode", Value::str("archive")),
                        ("manifest", Value::str(sha256::hex(&remote))),
                    ],
                )?;
                return Ok(Value::obj(vec![
                    ("ok", Value::Bool(true)),
                    ("upToDate", Value::Bool(true)),
                    ("commit", Value::str(head)),
                    ("uploaded", Value::Num(0.0)),
                    ("archive", Value::str(parts[0].name.clone())),
                    ("size", Value::Num(bytes as f64)),
                    ("raw", Value::Num(raw as f64)),
                    ("format", Value::str("zip")),
                    ("parts", Value::Num(parts.len() as f64)),
                ]));
            }
        }
    }

    opts.log(format!(
        "шаг 2 из 2: отправляю {} {} ({} МБ)…",
        if parts.len() > 1 { "части архива" } else { "архив" },
        client.provider.name(),
        megabytes(bytes)
    ));
    let mut ops: Vec<FileOp> = Vec::new();
    for part in &parts {
        let data = std::fs::read(&part.path).map_err(|e| format!("не прочитать часть архива: {}", e))?;
        ops.push(FileOp { path: format!("{}/{}", ARCHIVE_DIR, part.name), data: Some(data) });
    }
    ops.push(FileOp { path: MANIFEST_PATH.to_string(), data: Some(manifest_text.clone().into_bytes()) });

    /* убираем из хранилища прошлые части и старые архивы, которых больше нет */
    let mut removed = 0usize;
    if let Some(head) = &head {
        let keep: HashSet<String> = ops.iter().map(|op| op.path.clone()).collect();
        for file in client.tree(head)? {
            if file.path.starts_with(&format!("{}/", ARCHIVE_DIR)) && !keep.contains(&file.path) {
                ops.push(FileOp { path: file.path, data: None });
                removed += 1;
            }
        }
    }
    let commit = client.write(&ops, &opts.message)?;
    save_state(
        &opts.state_file,
        &commit,
        &client.branch,
        vec![
            ("mode", Value::str("archive")),
            ("manifest", Value::str(sha256::hex(manifest_text.as_bytes()))),
            ("parts", Value::Num(parts.len() as f64)),
        ],
    )?;
    drop(guard);
    Ok(Value::obj(vec![
        ("ok", Value::Bool(true)),
        ("upToDate", Value::Bool(false)),
        ("commit", Value::str(commit)),
        ("uploaded", Value::Num(ops.len() as f64)),
        ("removed", Value::Num(removed as f64)),
        ("archive", Value::str(parts[0].name.clone())),
        ("size", Value::Num(bytes as f64)),
        ("raw", Value::Num(raw as f64)),
        ("format", Value::str("zip")),
        ("parts", Value::Num(parts.len() as f64)),
        ("files", Value::Num(files as f64)),
    ]))
}

struct Part {
    name: String,
    path: PathBuf,
    size: u64,
    sha256: String,
}

/// Режет архив на части по `split_mb` мегабайт.
fn split_file(archive: &Path, tmp: &Path, split_mb: u64) -> Result<(Vec<Part>, u64), String> {
    let bytes = std::fs::metadata(archive)
        .map_err(|e| format!("не прочитать архив: {}", e))?
        .len();
    let limit = split_mb.max(1) * 1024 * 1024;
    let mut parts = Vec::new();
    if bytes <= limit {
        let data = std::fs::read(archive).map_err(|e| format!("не прочитать архив: {}", e))?;
        parts.push(Part {
            name: "сервер.zip".to_string(),
            path: archive.to_path_buf(),
            size: bytes,
            sha256: sha256::hex(&data),
        });
        return Ok((parts, bytes));
    }
    let source = std::fs::read(archive).map_err(|e| format!("не прочитать архив: {}", e))?;
    for (index, chunk) in source.chunks(limit as usize).enumerate() {
        let name = format!("сервер.zip.{:03}", index + 1);
        let path = tmp.join(&name);
        std::fs::write(&path, chunk).map_err(|e| format!("не записать часть архива: {}", e))?;
        parts.push(Part { name, path, size: chunk.len() as u64, sha256: sha256::hex(chunk) });
    }
    Ok((parts, bytes))
}

/// Совпадает ли манифест в хранилище с нашими частями (побайтово по sha256).
fn same_parts(remote: &[u8], parts: &[Part]) -> bool {
    let text = String::from_utf8_lossy(remote).to_string();
    let Ok(manifest) = json::parse(&text) else {
        return false;
    };
    let remote_parts = manifest.get("parts").map(|p| p.as_arr().to_vec()).unwrap_or_default();
    if remote_parts.len() != parts.len() {
        return false;
    }
    remote_parts.iter().zip(parts).all(|(remote, mine)| {
        let sha = remote.get("sha256").map(|v| v.text()).unwrap_or_default();
        if !sha.is_empty() {
            return sha == mine.sha256;
        }
        /* манифест старой панели мог не хранить сумму — сверяем по размеру */
        remote.get("size").and_then(|v| v.as_f64()).unwrap_or(0.0) as u64 == mine.size
    })
}

/// Распаковка: шаг 1 — скачать части, шаг 2 — развернуть в папку сервера.
fn pull_archive(client: &Client, opts: &mut Options) -> Result<Value, String> {
    let head = client.head()?.ok_or_else(|| {
        format!(
            "В репозитории {} нет ветки {} — сначала отправь сервер.",
            client.repo, client.branch
        )
    })?;
    let manifest_bytes = client.read(MANIFEST_PATH)?.ok_or_else(|| {
        "В репозитории нет архива сервера. Отправь его из панели.".to_string()
    })?;
    let text = String::from_utf8_lossy(&manifest_bytes).to_string();
    let manifest = json::parse(&text).map_err(|_| "Манифест архива повреждён — отправь сервер заново".to_string())?;
    let parts = manifest.get("parts").map(|p| p.as_arr().to_vec()).unwrap_or_default();
    if parts.is_empty() {
        return Err("В манифесте нет ни одной части архива".into());
    }
    let format = manifest.get("format").map(|v| v.text()).unwrap_or_else(|| "zip".into());
    let manifest_sha = sha256::hex(&manifest_bytes);

    let state = load_state(&opts.state_file);
    let same_commit = state.get("commit").map(|v| v.text()).as_deref() == Some(head.as_str());
    let same_manifest = state.get("manifest").map(|v| v.text()).as_deref() == Some(manifest_sha.as_str());
    if same_commit && same_manifest {
        return Ok(Value::obj(vec![
            ("ok", Value::Bool(true)),
            ("upToDate", Value::Bool(true)),
            ("commit", Value::str(head)),
            ("downloaded", Value::Num(0.0)),
            ("format", Value::str(format)),
            ("parts", Value::Num(parts.len() as f64)),
        ]));
    }

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = std::env::temp_dir().join(format!("omnipanel-pull-{}-{}", std::process::id(), stamp));
    std::fs::create_dir_all(&tmp).map_err(|e| format!("не создать временную папку: {}", e))?;
    let _guard = TempDir(tmp.clone());

    let total: u64 = parts
        .iter()
        .map(|p| p.get("size").and_then(|v| v.as_f64()).unwrap_or(0.0) as u64)
        .sum();
    opts.log(format!(
        "шаг 1 из 2: скачиваю архив ({} МБ{})…",
        megabytes(total),
        if parts.len() > 1 { format!(", частей {}", parts.len()) } else { String::new() }
    ));

    let mut joined: Vec<u8> = Vec::with_capacity(total as usize);
    for (index, part) in parts.iter().enumerate() {
        let name = part.get("name").map(|v| v.text()).unwrap_or_default();
        if name.is_empty() {
            return Err("В манифесте у части архива нет имени".into());
        }
        let rel = format!("{}/{}", ARCHIVE_DIR, name);
        let data = client.read(&rel)?.ok_or_else(|| {
            format!("В репозитории нет файла {} — отправь сервер заново", rel)
        })?;
        let want = part.get("sha256").map(|v| v.text()).unwrap_or_default();
        if !want.is_empty() && sha256::hex(&data) != want {
            return Err(format!(
                "Часть {} скачалась битой — контрольная сумма не совпала. Повтори забор.",
                name
            ));
        }
        if parts.len() > 1 {
            opts.log(format!("  часть {} из {}: {} — {} МБ", index + 1, parts.len(), name, megabytes(data.len() as u64)));
        }
        joined.extend_from_slice(&data);
    }

    let archive_path = tmp.join("архив");
    std::fs::write(&archive_path, &joined).map_err(|e| format!("не записать архив: {}", e))?;
    let is7z = joined.starts_with(&[0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) || format == "7z";
    let extracted: usize;
    if is7z {
        opts.log("шаг 2 из 2: распаковываю архив 7z…");
        extracted = extract_7z(&archive_path, &opts.dir)?;
    } else {
        opts.log("шаг 2 из 2: распаковываю архив в папку сервера…");
        let (count, _, _) = zip::extract(&joined, &opts.dir, "")?;
        extracted = count;
    }

    /* части архива убираем из хранилища: репозиторий — канал, а не склад */
    let mut cleaned = 0usize;
    let mut final_commit = head.clone();
    if opts.cleanup {
        let mut ops = Vec::new();
        for part in &parts {
            let name = part.get("name").map(|v| v.text()).unwrap_or_default();
            ops.push(FileOp { path: format!("{}/{}", ARCHIVE_DIR, name), data: None });
        }
        match client.write(&ops, &format!("OmniPanel: архив получен, убираю части ({})", extracted)) {
            Ok(commit) => {
                cleaned = ops.len();
                final_commit = commit;
            }
            Err(message) => opts.log(format!("архив распакован, но убрать его из хранилища не удалось: {}", message)),
        }
    }

    save_state(
        &opts.state_file,
        &final_commit,
        &client.branch,
        vec![
            ("mode", Value::str("archive")),
            ("manifest", Value::str(manifest_sha)),
            ("parts", Value::Num(parts.len() as f64)),
        ],
    )?;
    opts.log(format!(
        "готово: распаковано файлов {}{}",
        extracted,
        if cleaned > 0 { format!(", части архива убраны из хранилища ({})", cleaned) } else { String::new() }
    ));
    Ok(Value::obj(vec![
        ("ok", Value::Bool(true)),
        ("upToDate", Value::Bool(false)),
        ("commit", Value::str(final_commit)),
        ("downloaded", Value::Num(extracted as f64)),
        ("changed", Value::Num(extracted as f64)),
        ("format", Value::str(if is7z { "7z" } else { "zip" })),
        ("parts", Value::Num(parts.len() as f64)),
        ("size", Value::Num(joined.len() as f64)),
        ("repoCleaned", Value::Bool(cleaned > 0)),
    ]))
}

/// Распаковка 7z: внешним `7za`, потому что свой 7z панель не пишет.
/// Если его нет — понятная ошибка, а не пустая папка.
fn extract_7z(archive: &Path, dest: &Path) -> Result<usize, String> {
    let tool = find_7z().ok_or_else(|| {
        "В репозитории архив .7z, а рядом с панелью нет 7-Zip — положи 7za.exe в assets/bin".to_string()
    })?;
    let output = std::process::Command::new(&tool)
        .arg("x")
        .arg("-y")
        .arg(format!("-o{}", dest.display()))
        .arg(archive)
        .output()
        .map_err(|e| format!("7-Zip не запустился: {}", e))?;
    if !output.status.success() {
        return Err("7-Zip не смог распаковать архив сервера".into());
    }
    Ok(count_files(dest))
}

fn find_7z() -> Option<PathBuf> {
    let names = ["7za.exe", "7z.exe", "7za"];
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            dirs.push(parent.join("assets").join("bin"));
            dirs.push(parent.to_path_buf());
        }
    }
    if let Ok(path) = std::env::var("PATH") {
        for part in std::env::split_paths(&path) {
            dirs.push(part);
        }
    }
    for dir in dirs {
        for name in names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn count_files(dir: &Path) -> usize {
    let mut count = 0;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        if let Ok(entries) = std::fs::read_dir(&current) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else {
                    count += 1;
                }
            }
        }
    }
    count
}

/// Временная папка, которая удаляется сама.
struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/* ─────────────────────────── по файлам ─────────────────────────── */

fn push_files(client: &Client, opts: &mut Options) -> Result<Value, String> {
    let sources = collect(&opts.dir, &opts.scope)?;
    opts.log(format!("сравниваю {} файлов с хранилищем…", sources.len()));
    let head = client.head()?;
    let remote: Vec<RemoteFile> = match &head {
        Some(commit) => client.tree(commit)?,
        None => Vec::new(),
    };
    let remote_map: std::collections::HashMap<&str, &RemoteFile> =
        remote.iter().map(|f| (f.path.as_str(), f)).collect();

    let mut ops: Vec<FileOp> = Vec::new();
    let mut local_paths: HashSet<String> = HashSet::new();
    for source in &sources {
        let data = std::fs::read(&source.path).map_err(|e| format!("не прочитать {}: {}", source.name, e))?;
        local_paths.insert(source.name.clone());
        let known = remote_map.get(source.name.as_str());
        if let Some(known) = known {
            if !known.sha.is_empty() && known.sha == sha1::blob_hex(&data) {
                continue;
            }
            if known.sha.is_empty() && known.size == data.len() as u64 && known.size > 0 {
                continue;
            }
        }
        if data.len() as u64 > HARD_LIMIT {
            opts.log(format!("пропущен большой файл {}", source.name));
            continue;
        }
        ops.push(FileOp { path: source.name.clone(), data: Some(data) });
    }

    let mut removed = 0usize;
    for file in &remote {
        if file.path.starts_with(&format!("{}/", ARCHIVE_DIR)) {
            continue;
        }
        if !local_paths.contains(&file.path) && in_scope(&file.path, &opts.scope, &world_dirs(&opts.dir)) {
            ops.push(FileOp { path: file.path.clone(), data: None });
            removed += 1;
        }
    }

    if ops.is_empty() {
        return Ok(Value::obj(vec![
            ("ok", Value::Bool(true)),
            ("upToDate", Value::Bool(true)),
            ("commit", Value::str(head.unwrap_or_default())),
            ("uploaded", Value::Num(0.0)),
            ("removed", Value::Num(0.0)),
        ]));
    }
    opts.log(format!("отправляю {} изменений…", ops.len()));
    let uploaded = ops.iter().filter(|op| op.data.is_some()).count();
    let commit = client.write(&ops, &opts.message)?;
    save_state(
        &opts.state_file,
        &commit,
        &client.branch,
        vec![("mode", Value::str("files")), ("files", Value::Arr(Vec::new()))],
    )?;
    Ok(Value::obj(vec![
        ("ok", Value::Bool(true)),
        ("upToDate", Value::Bool(false)),
        ("commit", Value::str(commit)),
        ("uploaded", Value::Num(uploaded as f64)),
        ("removed", Value::Num(removed as f64)),
        ("changed", Value::Num(ops.len() as f64)),
    ]))
}

fn pull_files(client: &Client, opts: &mut Options) -> Result<Value, String> {
    let head = client.head()?.ok_or_else(|| {
        format!("В репозитории {} нет ветки {} — сначала отправь сервер.", client.repo, client.branch)
    })?;
    let state = load_state(&opts.state_file);
    if state.get("commit").map(|v| v.text()).as_deref() == Some(head.as_str()) {
        return Ok(Value::obj(vec![
            ("ok", Value::Bool(true)),
            ("upToDate", Value::Bool(true)),
            ("commit", Value::str(head)),
            ("downloaded", Value::Num(0.0)),
            ("removed", Value::Num(0.0)),
        ]));
    }
    let worlds = world_dirs(&opts.dir);
    let remote: Vec<RemoteFile> = client
        .tree(&head)?
        .into_iter()
        .filter(|file| !file.path.starts_with(&format!("{}/", ARCHIVE_DIR)))
        .filter(|file| in_scope(&file.path, &opts.scope, &worlds))
        .collect();
    opts.log(format!("скачиваю {} файлов…", remote.len()));
    let mut downloaded = 0usize;
    for file in &remote {
        let target = opts.dir.join(file.path.replace('/', std::path::MAIN_SEPARATOR_STR));
        if target.exists() {
            if let Ok(data) = std::fs::read(&target) {
                if !file.sha.is_empty() && file.sha == sha1::blob_hex(&data) {
                    continue;
                }
            }
        }
        let data = match client.read(&file.path)? {
            Some(data) => data,
            None => continue,
        };
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("не создать папку: {}", e))?;
        }
        std::fs::write(&target, data).map_err(|e| format!("не записать {}: {}", file.path, e))?;
        downloaded += 1;
    }
    let mut removed = 0usize;
    let present: HashSet<&str> = remote.iter().map(|f| f.path.as_str()).collect();
    if let Some(known) = state.get("files").map(|v| v.as_arr().to_vec()) {
        for item in known {
            let path = item.text();
            if path.is_empty() || present.contains(path.as_str()) {
                continue;
            }
            let target = opts.dir.join(path.replace('/', std::path::MAIN_SEPARATOR_STR));
            if target.is_file() && std::fs::remove_file(&target).is_ok() {
                removed += 1;
            }
        }
    }
    save_state(
        &opts.state_file,
        &head,
        &client.branch,
        vec![
            ("mode", Value::str("files")),
            ("files", Value::Arr(remote.iter().map(|f| Value::str(&f.path)).collect())),
        ],
    )?;
    Ok(Value::obj(vec![
        ("ok", Value::Bool(true)),
        ("upToDate", Value::Bool(false)),
        ("commit", Value::str(head)),
        ("downloaded", Value::Num(downloaded as f64)),
        ("removed", Value::Num(removed as f64)),
        ("changed", Value::Num((downloaded + removed) as f64)),
    ]))
}

/* ─────────────────────────── проверка состояния ─────────────────────────── */

/// Что лежит в хранилище по этому серверу.
pub fn check(sync: &Sync, opts: &Options) -> Value {
    let repo = norm_repo(&opts.repo);
    let branch = norm_branch(&opts.branch);
    if repo.is_empty() {
        return error_json("Синхронизация не настроена");
    }
    if opts.token.trim().is_empty() {
        return error_json(format!("Нет токена {}", opts.provider.name()));
    }
    let client = Client::new(
        opts.provider,
        repo,
        branch,
        &opts.token,
        sync.github_api.clone(),
        sync.gitlab_api.clone(),
    );
    let head = match client.head() {
        Ok(Some(head)) => head,
        Ok(None) => {
            return Value::obj(vec![
                ("ok", Value::Bool(true)),
                ("empty", Value::Bool(true)),
                ("error", Value::str("В репозитории пока нет файлов сервера")),
            ])
        }
        Err(message) => return error_json(message),
    };
    let files = match client.tree(&head) {
        Ok(files) => files,
        Err(message) => return error_json(message),
    };
    let mut parts = 0usize;
    let mut size = 0u64;
    let mut manifest = Value::Null;
    for file in &files {
        if file.path.starts_with(&format!("{}/", ARCHIVE_DIR)) && file.path != MANIFEST_PATH {
            parts += 1;
            size += file.size;
        }
    }
    if let Ok(Some(bytes)) = client.read(MANIFEST_PATH) {
        manifest = json::parse(&String::from_utf8_lossy(&bytes)).unwrap_or(Value::Null);
    }
    Value::obj(vec![
        ("ok", Value::Bool(true)),
        ("empty", Value::Bool(false)),
        ("commit", Value::str(head)),
        ("parts", Value::Num(parts as f64)),
        ("size", Value::Num(size as f64)),
        ("files", Value::Num(files.len() as f64)),
        ("manifest", manifest),
    ])
}

/// Скачать репозиторий архивом и разложить в папку (кнопка «Забрать сервер»).
pub fn download_repo(sync: &Sync, repo: &str, branch: &str, dir: &Path, token: &str) -> Value {
    let repo = norm_repo(repo);
    let branch = norm_branch(branch);
    if repo.is_empty() {
        return error_json("Не указан репозиторий вида владелец/имя");
    }
    if !dir.exists() && std::fs::create_dir_all(dir).is_err() {
        return error_json(format!("Не удалось создать папку {}", dir.display()));
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = std::env::temp_dir().join(format!("omnipanel-repo-{}-{}", std::process::id(), stamp));
    std::fs::create_dir_all(&tmp).map_err(|e| format!("не создать временную папку: {}", e)).ok();
    let _guard = TempDir(tmp.clone());
    let zip_path = tmp.join("repo.zip");
    let url = format!("{}/repos/{}/zipball/{}", sync.github_api, repo, url_encode(&branch, false));
    if let Err(message) = net::download(&url, &zip_path, Some(token)) {
        return error_json(message);
    }
    let data = match std::fs::read(&zip_path) {
        Ok(data) => data,
        Err(e) => return error_json(format!("не прочитать архив: {}", e)),
    };
    let inner = tmp.join("inner");
    if let Err(message) = zip::extract(&data, &inner, "") {
        return error_json(message);
    }
    /* в архиве от GitHub всё лежит внутри папки «владелец-репозиторий-хеш» */
    let mut source = inner.clone();
    if let Ok(entries) = std::fs::read_dir(&inner) {
        let items: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
        if items.len() == 1 && items[0].is_dir() {
            source = items[0].clone();
        }
    }
    let mut files = 0usize;
    let mut stack = vec![source];
    while let Some(current) = stack.pop() {
        let entries = match std::fs::read_dir(&current) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let rel = path
                .strip_prefix(&tmp.join("inner"))
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| name.clone());
            let parts: Vec<&str> = rel.split(std::path::MAIN_SEPARATOR).collect();
            let rel = if parts.len() > 1 { parts[1..].join("/") } else { name };
            let target = dir.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
            if let Some(parent) = target.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if std::fs::copy(&path, &target).is_ok() {
                files += 1;
            }
        }
    }
    Value::obj(vec![
        ("ok", Value::Bool(true)),
        ("repo", Value::str(repo)),
        ("branch", Value::str(branch)),
        ("dir", Value::str(dir.display().to_string())),
        ("files", Value::Num(files as f64)),
        ("command", Value::str(guess_command(dir))),
    ])
}

/// Мегабайты для сообщений: одна цифра после запятой.
pub fn megabytes(bytes: u64) -> String {
    format!("{:.1}", bytes as f64 / 1_048_576.0)
}
