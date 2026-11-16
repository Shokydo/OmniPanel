// Синхронизация с GitHub и GitLab — на своём сервере, а не на живом GitHub.
//
// Тесты поднимают маленький сервер на 127.0.0.1, который притворяется GitHub
// и GitLab по тем адресам, которые нужны панели (ветки, блобы, деревья,
// коммиты, файлы). Так проверяется вся цепочка «собрал архив → отправил →
// забрал → распаковал», и никакие настоящие токены и репозитории не нужны.
use omnipanel_core::http::percent_decode;
use omnipanel_core::sha1;
use omnipanel_core::sha256;
use omnipanel_core::sync::{self, Options, Provider, Sync};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/* ─────────────────────────── крошечный слон ─────────────────────────── */

#[derive(Default)]
struct Repo {
    /// ветка → коммит
    branch: Option<String>,
    /// коммит → дерево
    tree_of_commit: HashMap<String, String>,
    /// дерево → файлы (путь → sha блоба)
    files_of_tree: HashMap<String, HashMap<String, String>>,
    /// блоб → содержимое
    blobs: HashMap<String, Vec<u8>>,
    /// сколько раз что-то записали (для проверки «ничего не изменилось»)
    commits: usize,
    counter: usize,
}

impl Repo {
    fn next(&mut self, prefix: &str) -> String {
        self.counter += 1;
        format!("{}{:04}", prefix, self.counter)
    }

    /// Файлы текущей ветки.
    fn files(&self) -> HashMap<String, String> {
        match &self.branch {
            Some(commit) => self
                .tree_of_commit
                .get(commit)
                .and_then(|tree| self.files_of_tree.get(tree))
                .cloned()
                .unwrap_or_default(),
            None => HashMap::new(),
        }
    }

    fn put_blob(&mut self, data: &[u8]) -> String {
        let sha = sha1::blob_hex(data);
        self.blobs.insert(sha.clone(), data.to_vec());
        sha
    }
}

struct Fake {
    port: u16,
    repo: Arc<Mutex<Repo>>,
    token_accepted: Arc<Mutex<bool>>,
}

impl Fake {
    fn start() -> Fake {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let repo = Arc::new(Mutex::new(Repo::default()));
        let token_accepted = Arc::new(Mutex::new(true));
        let shared = Arc::clone(&repo);
        let token = Arc::clone(&token_accepted);
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let _ = handle(stream, &shared, &token);
            }
        });
        Fake { port, repo, token_accepted }
    }

    fn github(&self) -> String {
        format!("http://127.0.0.1:{}/gh", self.port)
    }

    fn gitlab(&self) -> String {
        format!("http://127.0.0.1:{}/api/v4", self.port)
    }

    fn sync(&self, dir: &Path) -> Sync {
        Sync::with_bases(dir, &self.github(), &self.gitlab())
    }

    fn files(&self) -> HashMap<String, String> {
        self.repo.lock().unwrap().files()
    }

    fn content(&self, path: &str) -> Vec<u8> {
        let repo = self.repo.lock().unwrap();
        let files = repo.files();
        match files.get(path) {
            Some(sha) => repo.blobs.get(sha).cloned().unwrap_or_default(),
            None => Vec::new(),
        }
    }

    fn commits(&self) -> usize {
        self.repo.lock().unwrap().commits
    }
}

fn read_request(stream: &mut TcpStream) -> Option<(String, String, Vec<u8>)> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let read = stream.read(&mut chunk).ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(pos) = find(&buffer, b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buffer[..pos]).to_string();
            let mut lines = head.lines();
            let first = lines.next()?.to_string();
            let mut length = 0usize;
            for line in lines {
                let lower = line.to_lowercase();
                if let Some(value) = lower.strip_prefix("content-length:") {
                    length = value.trim().parse().unwrap_or(0);
                }
            }
            let body_start = pos + 4;
            let mut body = buffer[body_start..].to_vec();
            while body.len() < length {
                let read = stream.read(&mut chunk).ok()?;
                if read == 0 {
                    break;
                }
                body.extend_from_slice(&chunk[..read]);
            }
            body.truncate(length);
            let mut parts = first.split_whitespace();
            let method = parts.next()?.to_string();
            let path = parts.next()?.to_string();
            return Some((method, path, body));
        }
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|window| window == needle)
}

fn respond(stream: &mut TcpStream, status: u16, body: &[u8]) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        201 => "Created",
        404 => "Not Found",
        422 => "Unprocessable Entity",
        500 => "Error",
        _ => "OK",
    };
    let head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        status,
        reason,
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}

fn b64(data: &[u8]) -> String {
    omnipanel_core::b64::encode(data)
}

fn un_b64(text: &str) -> Vec<u8> {
    omnipanel_core::b64::decode(text.trim()).unwrap_or_default()
}

fn json_field<'a>(body: &'a str, name: &str) -> Option<String> {
    omnipanel_core::json::parse(body)
        .ok()
        .and_then(|value| value.get(name).map(|v| v.text()))
}

fn handle(stream: TcpStream, repo: &Arc<Mutex<Repo>>, token_ok: &Arc<Mutex<bool>>) -> std::io::Result<()> {
    let mut stream = stream;
    let Some((method, path, body)) = read_request(&mut stream) else {
        return Ok(());
    };
    let text = String::from_utf8_lossy(&body).to_string();
    if std::env::var("SYNC_DEBUG").is_ok() {
        eprintln!("{} {}", method, path);
    }
    let mut repo = repo.lock().unwrap();
    let ok_token = *token_ok.lock().unwrap();

    /* ─── GitHub ─── */
    if let Some(rest) = path.strip_prefix("/gh") {
        let clean = rest.split('?').next().unwrap_or("");
        /* аккаунт */
        if clean == "/user" && method == "GET" {
            if !ok_token {
                return respond(&mut stream, 401, b"{\"message\":\"Bad credentials\"}");
            }
            return respond(&mut stream, 200, r#"{"login":"тестер","name":"Тест","avatar_url":"https://example/аватар.png"}"#.as_bytes());
        }
        if clean == "/user/repos" && method == "GET" {
            return respond(
                &mut stream,
                200,
                r#"[{"full_name":"тестер/сервер","name":"сервер","private":false},{"full_name":"тестер/второй","name":"второй","private":true}]"#.as_bytes(),
            );
        }
        if clean == "/user/repos" && method == "POST" {
            let name = json_field(&text, "name").unwrap_or_default();
            let payload = format!(r#"{{"full_name":"тестер/{}","private":true}}"#, name);
            return respond(&mut stream, 201, payload.as_bytes());
        }
        /* вход по коду */
        if clean == "/login/device/code" && method == "POST" {
            return respond(
                &mut stream,
                200,
                r#"{"device_code":"device-code-1","user_code":"ABCD-1234","verification_uri":"https://github.com/login/device","expires_in":900,"interval":5}"#.as_bytes(),
            );
        }
        if clean == "/login/oauth/access_token" && method == "POST" {
            if text.contains("device_code=device-code-1") {
                return respond(&mut stream, 200, r#"{"access_token":"gh-token-from-code","token_type":"bearer"}"#.as_bytes());
            }
            return respond(&mut stream, 200, br#"{"error":"authorization_pending"}"#);
        }
        if clean.starts_with("/repos/") {
            /* адрес вида /repos/владелец/имя/остальное */
            let rest = clean.trim_start_matches("/repos/");
            let mut parts = rest.splitn(3, '/');
            let _owner = parts.next().unwrap_or("");
            let _name = parts.next().unwrap_or("");
            let tail = parts.next().unwrap_or("");
            if tail.is_empty() {
                return respond(
                    &mut stream,
                    200,
                    r#"{"full_name":"тестер/сервер","permissions":{"push":true}}"#.as_bytes(),
                );
            }
            if let Some(branch) = tail.strip_prefix("git/ref/heads/") {
                return match &repo.branch {
                    Some(commit) => {
                        let payload = format!(r#"{{"object":{{"sha":"{}"}}}}"#, commit);
                        respond(&mut stream, 200, payload.as_bytes())
                    }
                    None => respond(&mut stream, 404, b"{}"),
                };
            }
            if let Some(sha) = tail.strip_prefix("git/commits/") {
                return match repo.tree_of_commit.get(sha) {
                    Some(tree) => {
                        let payload = format!(r#"{{"sha":"{}","tree":{{"sha":"{}"}}}}"#, sha, tree);
                        respond(&mut stream, 200, payload.as_bytes())
                    }
                    None => respond(&mut stream, 404, b"{}"),
                };
            }
            if let Some(sha) = tail.strip_prefix("git/blobs/") {
                return match repo.blobs.get(sha) {
                    Some(data) => {
                        let payload = format!(r#"{{"sha":"{}","content":"{}","encoding":"base64"}}"#, sha, b64(data));
                        respond(&mut stream, 200, payload.as_bytes())
                    }
                    None => respond(&mut stream, 404, b"{}"),
                };
            }
            if tail == "git/blobs" && method == "POST" {
                let content = json_field(&text, "content").unwrap_or_default();
                let sha = repo.put_blob(&un_b64(&content));
                let payload = format!(r#"{{"sha":"{}"}}"#, sha);
                return respond(&mut stream, 201, payload.as_bytes());
            }
            if tail == "git/trees" && method == "POST" {
                let value = omnipanel_core::json::parse(&text).unwrap_or(omnipanel_core::Value::Null);
                let base = value.get("base_tree").map(|v| v.text());
                let mut files = base
                    .and_then(|tree| repo.files_of_tree.get(&tree).cloned())
                    .unwrap_or_default();
                for item in value.get("tree").map(|t| t.as_arr().to_vec()).unwrap_or_default() {
                    let path = item.get("path").map(|v| v.text()).unwrap_or_default();
                    let sha = item.get("sha").map(|v| v.text()).unwrap_or_default();
                    if sha.is_empty() {
                        files.remove(&path);
                    } else {
                        files.insert(path, sha);
                    }
                }
                let tree = repo.next("дерево");
                repo.files_of_tree.insert(tree.clone(), files);
                let payload = format!(r#"{{"sha":"{}"}}"#, tree);
                return respond(&mut stream, 201, payload.as_bytes());
            }
            if tail == "git/commits" && method == "POST" {
                let value = omnipanel_core::json::parse(&text).unwrap_or(omnipanel_core::Value::Null);
                let tree = value.get("tree").map(|v| v.text()).unwrap_or_default();
                let commit = repo.next("коммит");
                repo.tree_of_commit.insert(commit.clone(), tree);
                repo.commits += 1;
                let payload = format!(r#"{{"sha":"{}"}}"#, commit);
                return respond(&mut stream, 201, payload.as_bytes());
            }
            if tail.starts_with("git/trees/") && method == "GET" {
                let sha = tail.trim_start_matches("git/trees/");
                let files = repo.files_of_tree.get(sha).cloned().unwrap_or_default();
                let mut items = Vec::new();
                for (path, blob) in files {
                    let size = repo.blobs.get(&blob).map(|d| d.len()).unwrap_or(0);
                    items.push(format!(
                        r#"{{"path":"{}","type":"blob","size":{},"sha":"{}"}}"#,
                        path, size, blob
                    ));
                }
                let payload = format!(r#"{{"tree":[{}],"truncated":false}}"#, items.join(","));
                return respond(&mut stream, 200, payload.as_bytes());
            }
            if tail == "git/refs" && method == "POST" {
                let value = omnipanel_core::json::parse(&text).unwrap_or(omnipanel_core::Value::Null);
                repo.branch = value.get("sha").map(|v| v.text());
                return respond(&mut stream, 201, b"{}");
            }
            if let Some(branch) = tail.strip_prefix("git/refs/heads/") {
                let value = omnipanel_core::json::parse(&text).unwrap_or(omnipanel_core::Value::Null);
                repo.branch = value.get("sha").map(|v| v.text());
                let payload = format!(r#"{{"ref":"refs/heads/{}"}}"#, branch);
                return respond(&mut stream, 200, payload.as_bytes());
            }
            if let Some(path) = tail.strip_prefix("contents/") {
                let want = percent_decode(path);
                let files = repo.files();
                return match files.get(&want) {
                    Some(sha) => {
                        let data = repo.blobs.get(sha).cloned().unwrap_or_default();
                        let payload = format!(r#"{{"path":"{}","sha":"{}","content":"{}","encoding":"base64"}}"#, want, sha, b64(&data));
                        respond(&mut stream, 200, payload.as_bytes())
                    }
                    None => respond(&mut stream, 404, b"{\"message\":\"Not Found\"}"),
                };
            }
        }
        return respond(&mut stream, 404, b"{\"message\":\"Not Found\"}");
    }

    /* ─── GitLab ─── */
    if let Some(rest) = path.strip_prefix("/api/v4") {
        let clean = rest.split('?').next().unwrap_or("");
        let query = rest.split('?').nth(1).unwrap_or("");
        if clean == "/user" {
            if !ok_token {
                return respond(&mut stream, 401, b"{\"message\":\"401 Unauthorized\"}");
            }
            return respond(&mut stream, 200, r#"{"username":"гитлабовец","name":"Гитлаб"}"#.as_bytes());
        }
        if clean == "/projects" {
            return respond(
                &mut stream,
                200,
                r#"[{"path_with_namespace":"группа/сервер","name":"сервер","visibility":"private"}]"#.as_bytes(),
            );
        }
        if let Some(tail) = clean.strip_prefix("/projects/") {
            let (project, tail) = match tail.split_once('/') {
                Some(pair) => pair,
                None => (tail, ""),
            };
            let project = percent_decode(project);
            if project != "тестер/сервер" && project != "группа/сервер" {
                return respond(&mut stream, 404, b"{\"message\":\"404 Project Not Found\"}");
            }
            if tail.is_empty() {
                return respond(
                    &mut stream,
                    200,
                    r#"{"path_with_namespace":"группа/сервер","visibility":"private"}"#.as_bytes(),
                );
            }
            if let Some(branch) = tail.strip_prefix("repository/branches/") {
                let _ = branch;
                return match &repo.branch {
                    Some(commit) => {
                        let payload = format!(r#"{{"commit":{{"id":"{}"}}}}"#, commit);
                        respond(&mut stream, 200, payload.as_bytes())
                    }
                    None => respond(&mut stream, 404, b"{\"message\":\"404 Branch Not Found\"}"),
                };
            }
            if tail == "repository/tree" {
                let mut items = Vec::new();
                let files = repo.files();
                let mut names: Vec<&String> = files.keys().collect();
                names.sort();
                for path in names {
                    items.push(format!(r#"{{"path":"{}","type":"blob","id":"{}"}}"#, path, files[path]));
                }
                let payload = format!("[{}]", items.join(","));
                return respond(&mut stream, 200, payload.as_bytes());
            }
            if tail.starts_with("repository/files/") && !tail.contains("/raw") {
                /* создание первого файла: GitLab делает коммит сам */
                let path = percent_decode(tail.trim_start_matches("repository/files/"));
                let content = json_field(&text, "content").unwrap_or_default();
                let data = un_b64(&content);
                let sha = repo.put_blob(&data);
                let mut files = repo.files();
                files.insert(path.clone(), sha);
                let tree = repo.next("дерево");
                repo.files_of_tree.insert(tree.clone(), files);
                let commit = repo.next("коммит");
                repo.tree_of_commit.insert(commit.clone(), tree);
                repo.branch = Some(commit.clone());
                repo.commits += 1;
                let payload = format!(r#"{{"file_path":"{}","branch":"main"}}"#, path);
                return respond(&mut stream, 201, payload.as_bytes());
            }
            if let Some(rest) = tail.strip_prefix("repository/files/") {
                if let Some(path) = rest.strip_suffix("/raw") {
                    let want = percent_decode(path);
                    let files = repo.files();
                    return match files.get(&want) {
                        Some(sha) => {
                            let data = repo.blobs.get(sha).cloned().unwrap_or_default();
                            respond(&mut stream, 200, &data)
                        }
                        None => respond(&mut stream, 404, b"{\"message\":\"404 File Not Found\"}"),
                    };
                }
            }
            if tail == "repository/commits" && method == "POST" {
                if repo.branch.is_none() && !query.is_empty() {
                    return respond(&mut stream, 400, "{\"message\":\"ветки нет\"}".as_bytes());
                }
                let value = omnipanel_core::json::parse(&text).unwrap_or(omnipanel_core::Value::Null);
                let mut files = repo.files();
                for action in value.get("actions").map(|a| a.as_arr().to_vec()).unwrap_or_default() {
                    let kind = action.get("action").map(|v| v.text()).unwrap_or_default();
                    let path = action.get("file_path").map(|v| v.text()).unwrap_or_default();
                    match kind.as_str() {
                        "delete" => {
                            files.remove(&path);
                        }
                        _ => {
                            let content = action.get("content").map(|v| v.text()).unwrap_or_default();
                            let sha = repo.put_blob(&un_b64(&content));
                            files.insert(path, sha);
                        }
                    }
                }
                let tree = repo.next("дерево");
                repo.files_of_tree.insert(tree.clone(), files);
                let commit = repo.next("коммит");
                repo.tree_of_commit.insert(commit.clone(), tree);
                repo.branch = Some(commit.clone());
                repo.commits += 1;
                let payload = format!(r#"{{"id":"{}"}}"#, commit);
                return respond(&mut stream, 201, payload.as_bytes());
            }
        }
        return respond(&mut stream, 404, b"{\"message\":\"404 Not Found\"}");
    }

    respond(&mut stream, 404, b"{}")
}

/* ─────────────────────────── вспомогательное ─────────────────────────── */

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("omnipanel-sync-{}-{}", std::process::id(), tag));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn write(dir: &Path, rel: &str, text: &str) {
    let path = dir.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, text).unwrap();
}

fn server_dir(tag: &str) -> PathBuf {
    let dir = temp_dir(tag);
    write(&dir, "server.properties", "level-name=world\nmotd=OmniPanel\n");
    write(&dir, "world/level.dat", "уровень\n");
    write(&dir, "world/region/r.0.0.mca", &"данные мира ".repeat(200));
    write(&dir, "plugins/Чат/config.yml", "чат: включён\n");
    write(&dir, "logs/latest.log", "этот файл не отправляем\n");
    write(&dir, "eula.txt", "eula=true\n");
    dir
}

fn options(dir: &Path, state: &Path) -> Options {
    Options {
        dir: dir.to_path_buf(),
        repo: "тестер/сервер".to_string(),
        branch: "main".to_string(),
        token: "test-token".to_string(),
        scope: "all".to_string(),
        mode: "archive".to_string(),
        provider: Provider::GitHub,
        cleanup: true,
        state_file: state.to_path_buf(),
        message: "OmniPanel: тестовый сервер".to_string(),
        split_mb: 20,
        logs: Vec::new(),
    }
}

fn ok(value: &omnipanel_core::Value) -> bool {
    value.get("ok").map(|v| v.as_bool()).unwrap_or(false)
}

fn field(value: &omnipanel_core::Value, name: &str) -> String {
    value.get(name).map(|v| v.text()).unwrap_or_default()
}

/* ─────────────────────────────── тесты ─────────────────────────────── */

#[test]
fn отправка_архивом_и_забор_в_другую_папку() {
    let fake = Fake::start();
    let sync = fake.sync(&temp_dir("sync-gh-settings"));
    let source = server_dir("gh-source");
    let state = temp_dir("gh-state").join("сервер.json");

    let mut opts = options(&source, &state);
    let pushed = sync::push(&sync, &mut opts);
    assert!(ok(&pushed), "отправка не удалась: {}", pushed.to_json());
    assert_eq!(field(&pushed, "format"), "zip");
    let files = fake.files();
    assert!(files.contains_key(".omnipanel/манифест.json"), "нет манифеста: {:?}", files.keys());
    assert!(files.contains_key(".omnipanel/сервер.zip"), "нет архива: {:?}", files.keys());
    assert!(!files.keys().any(|path| path.contains("logs/")), "журналы отправлять нельзя");

    /* забираем в пустую папку — она должна наполниться тем же содержимым */
    let target = temp_dir("gh-target");
    let mut pull_opts = options(&target, &temp_dir("gh-state-2").join("сервер.json"));
    let pulled = sync::pull(&sync, &mut pull_opts);
    assert!(ok(&pulled), "забор не удался: {}", pulled.to_json());
    assert_eq!(std::fs::read_to_string(target.join("world").join("level.dat")).unwrap(), "уровень\n");
    assert!(target.join("plugins").join("Чат").join("config.yml").exists());
    assert!(!target.join("logs").exists(), "журналы не должны возвращаться");
    assert!(pulled.to_json().contains("готово"), "нет отчёта о шагах: {}", pulled.to_json());
}

#[test]
fn повторная_отправка_ничего_не_меняет() {
    let fake = Fake::start();
    let sync = fake.sync(&temp_dir("sync-keep-settings"));
    let source = server_dir("keep-source");
    let state = temp_dir("keep-state").join("сервер.json");
    let first = sync::push(&sync, &mut options(&source, &state));
    assert!(ok(&first));
    let commits = fake.commits();
    let second = sync::push(&sync, &mut options(&source, &state));
    assert!(ok(&second), "{}", second.to_json());
    assert!(second.get("upToDate").map(|v| v.as_bool()).unwrap_or(false), "должно быть «уже актуально»");
    assert_eq!(fake.commits(), commits, "лишний коммит в хранилище");
}

#[test]
fn изменение_файла_меняет_архив() {
    let fake = Fake::start();
    let sync = fake.sync(&temp_dir("sync-change-settings"));
    let source = server_dir("change-source");
    let state = temp_dir("change-state").join("сервер.json");
    assert!(ok(&sync::push(&sync, &mut options(&source, &state))));
    write(&source, "world/level.dat", "уровень другой\n");
    let pushed = sync::push(&sync, &mut options(&source, &state));
    assert!(ok(&pushed));
    assert!(!pushed.get("upToDate").map(|v| v.as_bool()).unwrap_or(false), "изменение не заметили");
    assert!(pushed.get("commit").map(|v| v.text()).is_some());

    let target = temp_dir("change-target");
    let pulled = sync::pull(&sync, &mut options(&target, &temp_dir("change-state-2").join("с.json")));
    assert!(ok(&pulled), "{}", pulled.to_json());
    assert_eq!(std::fs::read_to_string(target.join("world").join("level.dat")).unwrap(), "уровень другой\n");
}

#[test]
fn битая_часть_архива_не_распаковывается() {
    let fake = Fake::start();
    let sync = fake.sync(&temp_dir("sync-broken-settings"));
    let source = server_dir("broken-source");
    let state = temp_dir("broken-state").join("сервер.json");
    assert!(ok(&sync::push(&sync, &mut options(&source, &state))));
    /* подменяем содержимое части, оставляя имя */
    {
        let mut repo = fake.repo.lock().unwrap();
        let files = repo.files();
        let sha = files.get(".omnipanel/сервер.zip").unwrap().clone();
        repo.blobs.insert(sha, "это не архив".as_bytes().to_vec());
    }
    let target = temp_dir("broken-target");
    let pulled = sync::pull(&sync, &mut options(&target, &temp_dir("broken-state-2").join("с.json")));
    assert!(!ok(&pulled), "битый архив распаковался: {}", pulled.to_json());
    assert!(field(&pulled, "error").contains("битой"), "{}", pulled.to_json());
}

#[test]
fn после_забора_части_уходят_из_хранилища() {
    let fake = Fake::start();
    let sync = fake.sync(&temp_dir("sync-clean-settings"));
    let source = server_dir("clean-source");
    let state = temp_dir("clean-state").join("сервер.json");
    assert!(ok(&sync::push(&sync, &mut options(&source, &state))));
    let target = temp_dir("clean-target");
    let pulled = sync::pull(&sync, &mut options(&target, &temp_dir("clean-state-2").join("с.json")));
    assert!(ok(&pulled), "{}", pulled.to_json());
    assert!(pulled.get("repoCleaned").map(|v| v.as_bool()).unwrap_or(false));
    let files = fake.files();
    assert!(!files.contains_key(".omnipanel/сервер.zip"), "архив остался в хранилище: {:?}", files.keys());
    assert!(files.contains_key(".omnipanel/манифест.json"), "манифест должен остаться");
}

#[test]
fn отправка_по_файлам() {
    let fake = Fake::start();
    let sync = fake.sync(&temp_dir("sync-files-settings"));
    let source = server_dir("files-source");
    let state = temp_dir("files-state").join("сервер.json");
    let mut opts = options(&source, &state);
    opts.mode = "files".to_string();
    let pushed = sync::push(&sync, &mut opts);
    assert!(ok(&pushed), "{}", pushed.to_json());
    let files = fake.files();
    assert!(files.contains_key("world/level.dat"), "нет файла мира: {:?}", files.keys());
    assert!(files.contains_key("server.properties"));
    assert!(!files.keys().any(|path| path.contains("logs/")), "журналы отправлять нельзя");

    /* второй раз — отправлять нечего */
    let again = sync::push(&sync, &mut opts);
    assert!(again.get("upToDate").map(|v| v.as_bool()).unwrap_or(false), "{}", again.to_json());

    /* правим один файл — уезжает только он */
    write(&source, "eula.txt", "eula=false\n");
    let third = sync::push(&sync, &mut opts);
    assert!(ok(&third));
    assert_eq!(third.get("uploaded").and_then(|v| v.as_f64()).unwrap_or(0.0) as i64, 1);

    let target = temp_dir("files-target");
    let mut pull_opts = options(&target, &temp_dir("files-state-2").join("с.json"));
    pull_opts.mode = "files".to_string();
    let pulled = sync::pull(&sync, &mut pull_opts);
    assert!(ok(&pulled), "{}", pulled.to_json());
    assert_eq!(std::fs::read_to_string(target.join("eula.txt")).unwrap(), "eula=false\n");
}

#[test]
fn gitlab_отправка_и_забор() {
    let fake = Fake::start();
    let sync = fake.sync(&temp_dir("sync-gl-settings"));
    let source = server_dir("gl-source");
    let mut opts = options(&source, &temp_dir("gl-state").join("сервер.json"));
    opts.provider = Provider::GitLab;
    let pushed = sync::push(&sync, &mut opts);
    assert!(ok(&pushed), "{}", pushed.to_json());
    assert!(fake.files().contains_key(".omnipanel/манифест.json"));

    let target = temp_dir("gl-target");
    let mut pull_opts = options(&target, &temp_dir("gl-state-2").join("с.json"));
    pull_opts.provider = Provider::GitLab;
    let pulled = sync::pull(&sync, &mut pull_opts);
    assert!(ok(&pulled), "{}", pulled.to_json());
    assert_eq!(std::fs::read_to_string(target.join("eula.txt")).unwrap(), "eula=true\n");
}

#[test]
fn проверка_хранилища_и_состояние() {
    let fake = Fake::start();
    let sync = fake.sync(&temp_dir("sync-check-settings"));
    let source = server_dir("check-source");
    let state = temp_dir("check-state").join("сервер.json");
    assert!(ok(&sync::push(&sync, &mut options(&source, &state))));

    let opts = options(&source, &state);
    let checked = sync::check(&sync, &opts);
    assert!(ok(&checked), "{}", checked.to_json());
    assert_eq!(checked.get("parts").and_then(|v| v.as_f64()).unwrap_or(0.0) as i64, 1);
    assert!(checked.get("manifest").map(|v| !v.is_null()).unwrap_or(false), "манифест не прочитан");

    let status = sync::status(&state);
    assert!(!field(&status, "commit").is_empty());
    assert!(!field(&status, "at").is_empty());
    assert!(ok(&sync::forget(&state)));
    assert!(field(&sync::status(&state), "commit").is_empty(), "состояние не забыто");
}

#[test]
fn вход_по_коду_и_аккаунт() {
    let fake = Fake::start();
    let settings = temp_dir("sync-login-settings");
    let sync = fake.sync(&settings);
    let start = sync.device_start();
    assert!(ok(&start), "{}", start.to_json());
    assert_eq!(field(&start, "userCode"), "ABCD-1234");
    let poll = sync.device_poll(&field(&start, "deviceCode"));
    assert!(ok(&poll), "{}", poll.to_json());
    assert_eq!(field(&poll, "login"), "тестер");

    let account = sync.account();
    assert!(account.get("hasToken").map(|v| v.as_bool()).unwrap_or(false));
    assert_eq!(field(&account, "login"), "тестер");
    assert_eq!(field(&account, "token"), "••••••••", "токен наружу отдавать нельзя");

    /* файл настроек: токен есть, но в открытом виде только он */
    let saved = std::fs::read_to_string(sync.path()).unwrap();
    assert!(saved.contains("gh-token-from-code"), "токен не сохранён");
    assert!(!saved.contains("••••"), "маска попала в файл");

    assert!(ok(&sync.logout()));
    assert!(!sync.account().get("hasToken").map(|v| v.as_bool()).unwrap_or(true));
}

#[test]
fn список_репозиториев_и_создание() {
    let fake = Fake::start();
    let sync = fake.sync(&temp_dir("sync-repos-settings"));
    assert!(!ok(&sync.repos("")), "без токена список отдавать нельзя");
    assert!(ok(&sync.login("new-token")), "вход по токену не удался");
    let repos = sync.repos("");
    assert!(ok(&repos), "{}", repos.to_json());
    assert_eq!(repos.get("repos").map(|v| v.as_arr().len()).unwrap_or(0), 2);
    let created = sync.create_repo("мой сервер", true);
    assert!(ok(&created), "{}", created.to_json());
    assert_eq!(field(&created, "full"), "тестер/мой-сервер");
}

#[test]
fn проверка_токена_и_репозитория() {
    let fake = Fake::start();
    let sync = fake.sync(&temp_dir("sync-verify-settings"));
    let cfg = omnipanel_core::json::parse(r#"{"token":"mine","repo":"https://github.com/тестер/сервер.git"}"#).unwrap();
    assert!(ok(&sync.verify(&cfg)), "{}", sync.verify(&cfg).to_json());
    let bad = omnipanel_core::json::parse(r#"{"token":"wrong","repo":""}"#).unwrap();
    *fake.token_accepted.lock().unwrap() = false;
    let reply = sync.verify(&bad);
    assert!(!ok(&reply), "неверный токен приняли: {}", reply.to_json());
    assert!(field(&reply, "error").contains("токен"));
}

#[test]
fn gitlab_токен_и_проекты() {
    let fake = Fake::start();
    let sync = fake.sync(&temp_dir("sync-gl-settings2"));
    assert!(!sync.gitlab_account().get("hasToken").map(|v| v.as_bool()).unwrap_or(true));
    assert!(ok(&sync.gitlab_save("gl-token")));
    assert!(sync.gitlab_account().get("hasToken").map(|v| v.as_bool()).unwrap_or(false));
    let projects = sync.gitlab_projects("");
    assert!(ok(&projects), "{}", projects.to_json());
    assert_eq!(projects.get("repos").map(|v| v.as_arr().len()).unwrap_or(0), 1);
    let cfg = omnipanel_core::json::parse(r#"{"repo":"группа/сервер"}"#).unwrap();
    assert!(ok(&sync.gitlab_check(&cfg)), "{}", sync.gitlab_check(&cfg).to_json());
}

#[test]
fn область_синхронизации_и_служебные_файлы() {
    let dir = server_dir("scope-source");
    let all = sync::collect(&dir, "all").unwrap();
    let names: Vec<String> = all.iter().map(|f| f.name.clone()).collect();
    assert!(names.contains(&"server.properties".to_string()));
    assert!(names.contains(&"world/level.dat".to_string()));
    assert!(!names.iter().any(|n| n.starts_with("logs/")), "журналы в список не попадают");

    let world = sync::collect(&dir, "world").unwrap();
    let world_names: Vec<String> = world.iter().map(|f| f.name.clone()).collect();
    assert!(world_names.iter().all(|n| n.starts_with("world")), "{:?}", world_names);
    assert!(world_names.contains(&"world/region/r.0.0.mca".to_string()));

    let config = sync::collect(&dir, "config").unwrap();
    let config_names: Vec<String> = config.iter().map(|f| f.name.clone()).collect();
    assert!(config_names.contains(&"server.properties".to_string()));
    assert!(config_names.contains(&"plugins/Чат/config.yml".to_string()));
    assert!(!config_names.contains(&"eula.txt".to_string()), "eula.txt — не конфиг плагинов");
}

#[test]
fn адреса_и_ветки_приводятся_к_виду() {
    assert_eq!(sync::norm_repo("https://github.com/тестер/сервер.git"), "тестер/сервер");
    assert_eq!(sync::norm_repo("  тестер/сервер/  "), "тестер/сервер");
    assert_eq!(sync::norm_branch(""), "main");
    assert_eq!(sync::norm_branch("refs/heads/мир"), "мир");
    assert_eq!(sync::url_encode("манифест.json/путь", true), "%D0%BC%D0%B0%D0%BD%D0%B8%D1%84%D0%B5%D1%81%D1%82.json/%D0%BF%D1%83%D1%82%D1%8C");
    let now = sync::iso_now();
    assert_eq!(now.len(), 20, "{}", now);
    assert!(now.ends_with('Z'));
}

#[test]
fn архив_больше_части_режется_на_тома() {
    let fake = Fake::start();
    let sync = fake.sync(&temp_dir("sync-split-settings"));
    let source = server_dir("split-source");
    /* несжимаемые данные, чтобы архив перевалил за мегабайт */
    let mut data = Vec::new();
    let mut state = 0x2468_ACE0u32;
    for _ in 0..3_000_000 {
        state = state.wrapping_mul(1_103_515_245).wrapping_add(12345);
        data.push((state >> 16) as u8);
    }
    std::fs::create_dir_all(source.join("world")).unwrap();
    std::fs::write(source.join("world").join("большой.bin"), &data).unwrap();

    let mut opts = options(&source, &temp_dir("split-state").join("с.json"));
    opts.split_mb = 1;
    let pushed = sync::push(&sync, &mut opts);
    assert!(ok(&pushed), "{}", pushed.to_json());
    assert!(pushed.get("parts").and_then(|v| v.as_f64()).unwrap_or(0.0) as i64 > 1, "{}", pushed.to_json());
    let files = fake.files();
    assert!(files.keys().any(|p| p.ends_with("сервер.zip.001")), "{:?}", files.keys());

    let target = temp_dir("split-target");
    let mut pull_opts = options(&target, &temp_dir("split-state-2").join("с.json"));
    pull_opts.split_mb = 1;
    let pulled = sync::pull(&sync, &mut pull_opts);
    assert!(ok(&pulled), "{}", pulled.to_json());
    let back = std::fs::read(target.join("world").join("большой.bin")).unwrap();
    assert_eq!(sha256::hex(&back), sha256::hex(&data), "склеенный архив распаковался неверно");
}
