//! Аддоны панели — расширения вроде тех, что бывают у редакторов кода.
//!
//! Аддон — это папка с `addon.json`:
//! ```json
//! {
//!   "id": "mythic-mobs", "name": "Мифические мобы", "version": "1.0.0",
//!   "author": "OmniPanel", "description": "…", "icon": "M",
//!   "panel": { "title": "Мифические мобы", "file": "panel.html" },
//!   "permissions": ["files", "command"]
//! }
//! ```
//! Лежат они в двух местах: свои — в `<данные>/addons/<id>`, встроенные —
//! в `assets/addons/<id>` рядом с панелью. Своя версия важнее встроенной.
//!
//! Панель аддона — обычный HTML, который интерфейс показывает в песочнице.
//! Всё, что аддону нужно от панели, он просит через мост `call`, и мост
//! пропускает только разрешённые действия и только к своему серверу:
//! ни путей наружу, ни чужих серверов, ни команд без разрешения.

use crate::json::{self, Value};
use std::path::{Path, PathBuf};

/// Имя файла с описанием аддона.
const MANIFEST: &str = "addon.json";
/// Имя файла состояния «включён / выключен».
const STATE: &str = "addons.json";

/// Описание одного аддона.
#[derive(Debug, Clone)]
pub struct Addon {
    pub id: String,
    pub name: String,
    pub version: String,
    pub author: String,
    pub description: String,
    pub icon: String,
    pub builtin: bool,
    pub dir: PathBuf,
    pub has_panel: bool,
    pub panel_title: String,
    pub panel_file: PathBuf,
    pub permissions: Vec<String>,
    pub default_enabled: bool,
}

impl Addon {
    /// Запись для интерфейса — ровно те поля, что читает окно аддонов.
    pub fn to_json(&self, enabled: bool) -> Value {
        Value::obj(vec![
            ("id", Value::str(&self.id)),
            ("name", Value::str(&self.name)),
            ("version", Value::str(&self.version)),
            ("author", Value::str(&self.author)),
            ("description", Value::str(&self.description)),
            ("icon", Value::str(&self.icon)),
            ("builtin", Value::Bool(self.builtin)),
            ("dir", Value::str(self.dir.to_string_lossy())),
            ("hasPanel", Value::Bool(self.has_panel)),
            ("panelTitle", Value::str(&self.panel_title)),
            ("permissions", Value::Arr(self.permissions.iter().map(|p| Value::str(p)).collect())),
            ("enabled", Value::Bool(enabled)),
            ("defaultEnabled", Value::Bool(self.default_enabled)),
        ])
    }

    /// Разрешено ли аддону действие.
    pub fn allows(&self, permission: &str) -> bool {
        self.permissions.iter().any(|p| p == permission)
    }
}

/// Папка своих аддонов рядом с данными панели (создаётся при первом обращении).
pub fn user_dir(data_dir: &Path) -> PathBuf {
    let dir = data_dir.join("addons");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Папка встроенных аддонов — они едут вместе с панелью.
pub fn builtin_dir(app_dir: &Path) -> PathBuf {
    let direct = app_dir.join("assets").join("addons");
    if direct.is_dir() {
        return direct;
    }
    /* рядом с exe вложенные папки могут лежать иначе — ищем на шаг выше */
    if let Some(parent) = app_dir.parent() {
        let other = parent.join("assets").join("addons");
        if other.is_dir() {
            return other;
        }
    }
    direct
}

/// Годится ли id аддона: только латиница, цифры, точка, дефис, подчёркивание.
pub fn id_ok(id: &str) -> bool {
    let bytes = id.as_bytes();
    if bytes.len() < 2 || bytes.len() > 41 {
        return false;
    }
    let first = bytes[0] as char;
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return false;
    }
    bytes.iter().all(|b| {
        let c = *b as char;
        c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_' || c == '.'
    })
}

/// Собирает описание аддона из `addon.json`, отбрасывая мусор.
fn normal(db_dir: &Path, builtin: bool) -> Option<Addon> {
    let raw = std::fs::read_to_string(db_dir.join(MANIFEST)).ok()?;
    let raw = json::parse(&raw).ok()?;
    let take = |key: &str, fallback: &str, limit: usize| -> String {
        let text = raw.get(key).map(|v| v.text()).unwrap_or_default();
        let text = if text.trim().is_empty() { fallback.to_string() } else { text };
        text.chars().take(limit).collect()
    };
    let folder = db_dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let id = take("id", &folder, 41);
    if !id_ok(&id) {
        return None;
    }
    let name = take("name", &id, 80);
    let panel = raw.get("panel").cloned().unwrap_or(Value::Null);
    let file = panel.get("file").map(|v| v.text()).unwrap_or_default();
    /* имя файла панели берём без каталогов: наружу из папки аддона не пускаем */
    let panel_file = if file.trim().is_empty() {
        PathBuf::new()
    } else {
        let base = Path::new(&file)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        db_dir.join(base)
    };
    let has_panel = !panel_file.as_os_str().is_empty() && panel_file.is_file();
    let permissions: Vec<String> = match raw.get("permissions") {
        Some(Value::Arr(items)) => items.iter().map(|v| v.text()).filter(|p| !p.is_empty()).collect(),
        _ => vec!["files".to_string()],
    };
    Some(Addon {
        icon: take("icon", &name.chars().take(1).collect::<String>().to_uppercase(), 3),
        id,
        name: name.clone(),
        version: take("version", "1.0.0", 20),
        author: take("author", "", 60),
        description: take("description", "", 400),
        builtin,
        dir: db_dir.to_path_buf(),
        has_panel,
        panel_title: if has_panel {
            panel
                .get("title")
                .map(|v| v.text())
                .filter(|t| !t.trim().is_empty())
                .unwrap_or(name)
                .chars()
                .take(40)
                .collect()
        } else {
            String::new()
        },
        panel_file,
        permissions,
        default_enabled: raw.get("defaultEnabled").map(|v| v.as_bool()).unwrap_or(true),
    })
}

/// Что человек выбрал сам: `id → включён`.
/// Состояние переключателей — для тех, кто проверяет включённость сам.
pub fn read_state_public(data_dir: &Path) -> Vec<(String, bool)> {
    read_state(data_dir)
}

fn read_state(data_dir: &Path) -> Vec<(String, bool)> {
    let Ok(text) = std::fs::read_to_string(data_dir.join(STATE)) else {
        return Vec::new();
    };
    let Ok(value) = json::parse(&text) else {
        return Vec::new();
    };
    let Some(Value::Obj(pairs)) = value.get("enabled") else {
        return Vec::new();
    };
    pairs.iter().map(|(id, on)| (id.clone(), on.as_bool())).collect()
}

fn write_state(data_dir: &Path, enabled: &[(String, bool)]) -> bool {
    let pairs: Vec<(String, Value)> = enabled
        .iter()
        .map(|(id, on)| (id.clone(), Value::Bool(*on)))
        .collect();
    let body = Value::obj(vec![("enabled", Value::Obj(pairs))]).to_json();
    if let Some(parent) = (data_dir.join(STATE)).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(data_dir.join(STATE), body).is_ok()
}

/// Все найденные аддоны: сперва свои, потом встроенные, без повторов по id.
pub fn scan(data_dir: &Path, app_dir: &Path) -> Vec<Addon> {
    let mut list: Vec<Addon> = Vec::new();
    for (dir, builtin) in [(user_dir(data_dir), false), (builtin_dir(app_dir), true)] {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut names: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect();
        names.sort();
        for path in names {
            let Some(item) = normal(&path, builtin) else {
                continue;
            };
            if list.iter().any(|known| known.id == item.id) {
                continue; /* своя версия важнее встроенной */
            }
            list.push(item);
        }
    }
    list
}

/// Включён ли аддон: что выбрал человек, иначе — как задумал автор.
pub fn is_enabled(chosen: &[(String, bool)], addon: &Addon) -> bool {
    match chosen.iter().find(|(id, _)| *id == addon.id) {
        Some((_, on)) => *on,
        None => addon.default_enabled,
    }
}

/// Список для окна аддонов.
pub fn list(data_dir: &Path, app_dir: &Path) -> Value {
    let chosen = read_state(data_dir);
    Value::Arr(
        scan(data_dir, app_dir)
            .iter()
            .map(|addon| addon.to_json(is_enabled(&chosen, addon)))
            .collect(),
    )
}

/// Переключатель «включён / выключен».
pub fn set_enabled(data_dir: &Path, app_dir: &Path, id: &str, on: bool) -> Value {
    if !scan(data_dir, app_dir).iter().any(|a| a.id == id) {
        return err("Аддон не найден");
    }
    let mut chosen = read_state(data_dir);
    match chosen.iter_mut().find(|(known, _)| known == id) {
        Some(slot) => slot.1 = on,
        None => chosen.push((id.to_string(), on)),
    }
    write_state(data_dir, &chosen);
    Value::obj(vec![
        ("ok", Value::Bool(true)),
        ("id", Value::str(id)),
        ("enabled", Value::Bool(on)),
    ])
}

/// HTML панели аддона — только у включённого аддона.
pub fn panel(data_dir: &Path, app_dir: &Path, id: &str) -> Value {
    let chosen = read_state(data_dir);
    let Some(addon) = scan(data_dir, app_dir).into_iter().find(|a| a.id == id) else {
        return err("Аддон не найден");
    };
    if !is_enabled(&chosen, &addon) {
        return err("Аддон выключен");
    }
    if !addon.has_panel {
        return err("У аддона нет панели");
    }
    let Ok(html) = std::fs::read_to_string(&addon.panel_file) else {
        return err("Не прочитать панель");
    };
    Value::obj(vec![
        ("ok", Value::Bool(true)),
        ("id", Value::str(&addon.id)),
        ("title", Value::str(&addon.panel_title)),
        (
            "permissions",
            Value::Arr(addon.permissions.iter().map(|p| Value::str(p)).collect()),
        ),
        ("html", Value::str(html)),
    ])
}

/// Где лежат аддоны — окно аддонов показывает эти две папки.
pub fn dirs(data_dir: &Path, app_dir: &Path) -> Value {
    Value::obj(vec![
        ("user", Value::str(user_dir(data_dir).to_string_lossy())),
        ("builtin", Value::str(builtin_dir(app_dir).to_string_lossy())),
    ])
}

/// Ошибка в том же виде, что ждёт окно аддонов.
pub fn err_json(text: &str) -> Value {
    err(text)
}

fn err(text: &str) -> Value {
    Value::obj(vec![
        ("ok", Value::Bool(false)),
        ("error", Value::str(text)),
    ])
}

/// Что аддон вправе попросить у панели.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    List,
    Read,
    Write,
    Props,
    Command,
    OpenEditor,
    LookupUuid,
}

impl Action {
    pub fn parse(method: &str) -> Option<Action> {
        Some(match method {
            "list" => Action::List,
            "read" => Action::Read,
            "write" => Action::Write,
            "props" => Action::Props,
            "command" => Action::Command,
            "openEditor" => Action::OpenEditor,
            "lookupUuid" => Action::LookupUuid,
            _ => return None,
        })
    }

    /// Какое разрешение нужно для действия (`None` — не нужно).
    pub fn permission(&self) -> Option<&'static str> {
        match self {
            Action::List | Action::Read | Action::Write | Action::Props => Some("files"),
            Action::Command => Some("command"),
            Action::OpenEditor | Action::LookupUuid => None,
        }
    }
}

/// Пропускает ли мост это действие для этого аддона.
pub fn check(addon: &Addon, action: Action) -> Result<(), String> {
    match action.permission() {
        Some(need) if !addon.allows(need) => Err(match need {
            "files" => "Аддону не разрешены файлы".to_string(),
            _ => "Аддону не разрешена консоль".to_string(),
        }),
        _ => Ok(()),
    }
}

/// UUID игрока по нику — так аддон показывает голову игрока.
pub fn mojang_uuid(nick: &str) -> Result<String, String> {
    let reply = crate::net::get(&format!(
        "https://api.mojang.com/users/profiles/minecraft/{}",
        nick
    ))?;
    if reply.status == 404 {
        return Err("Игрок не найден".to_string());
    }
    if reply.status != 200 {
        return Err(format!("Mojang ответил {}", reply.status));
    }
    let value = json::parse(&reply.body)?;
    let uuid = value.get("id").map(|v| v.text()).unwrap_or_default();
    if uuid.is_empty() {
        return Err("Ответ Mojang не разобрать".to_string());
    }
    Ok(uuid)
}

/// Ник игрока для поиска UUID: только латиница, цифры и подчёркивание.
pub fn nick_ok(nick: &str) -> bool {
    let len = nick.len();
    (3..=16).contains(&len)
        && nick
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
}
