//! Каталог ядер Minecraft-серверов и мастер создания сервера.
//!
//! Источники те же, что в 1.26.0 (и это важно — ссылки меняются):
//!  * PaperMC `fill.papermc.io/v3` — paper, folia, velocity, waterfall;
//!  * Purpur `api.purpurmc.org/v2`;
//!  * Fabric `meta.fabricmc.net`;
//!  * Vanilla `piston-meta.mojang.com`;
//!  * Forge `files.minecraftforge.net` + maven;
//!  * NeoForge `maven.neoforged.net`.
//!
//! Адреса можно подменить через переменные окружения — так мастер проверяется
//! тестами без интернета и без настоящих сборок.

use crate::json::{self, Value};
use crate::net;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Флаги Aikar — те же, что панель ставит по умолчанию.
pub const AIKAR: &str = "-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 \
-XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC -XX:+AlwaysPreTouch \
-XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M \
-XX:G1ReservePercent=20 -XX:G1HeapWastePercent=5 -XX:G1MixedGCCountTarget=4 \
-XX:InitiatingHeapOccupancyPercent=15 -XX:G1MixedGCLiveThresholdPercent=90 \
-XX:G1RSetUpdatingPauseTimePercent=5 -XX:SurvivorRatio=32 -XX:+PerfDisableSharedMem \
-XX:MaxTenuringThreshold=1 -Dusing.aikars.flags=https://mcflags.emc.gs -Daikars.new.flags=true";

/// Адреса источников. Меняются окружением — для проверок и зеркал.
#[derive(Debug, Clone)]
pub struct Bases {
    pub papermc: String,
    pub purpur: String,
    pub fabric: String,
    pub mojang: String,
    pub forge: String,
    pub neoforge: String,
}

impl Default for Bases {
    fn default() -> Self {
        Bases::from_env()
    }
}

impl Bases {
    pub fn from_env() -> Bases {
        let env = |name: &str, fallback: &str| std::env::var(name).unwrap_or_else(|_| fallback.to_string());
        Bases {
            papermc: env("OMNI_PAPER_API", "https://fill.papermc.io/v3/projects"),
            purpur: env("OMNI_PURPUR_API", "https://api.purpurmc.org/v2"),
            fabric: env("OMNI_FABRIC_API", "https://meta.fabricmc.net/v2"),
            mojang: env("OMNI_MOJANG_API", "https://piston-meta.mojang.com"),
            forge: env(
                "OMNI_FORGE_API",
                "https://files.minecraftforge.net/net/minecraftforge/forge",
            ),
            neoforge: env("OMNI_NEOFORGE_API", "https://maven.neoforged.net/releases/net/neoforged/neoforge"),
        }
    }

    /// Все адреса на один сервер — удобно для проверок.
    pub fn all_at(base: &str) -> Bases {
        Bases {
            papermc: format!("{}/paper", base),
            purpur: format!("{}/purpur", base),
            fabric: format!("{}/fabric", base),
            mojang: base.to_string(),
            forge: format!("{}/forge", base),
            neoforge: format!("{}/neoforge", base),
        }
    }
}

fn get_json(url: &str) -> Result<Value, String> {
    let reply = net::get(url).map_err(|err| format!("нет связи: {}", err))?;
    if reply.status != 200 {
        return Err(format!("источник ответил {}", reply.status));
    }
    json::parse(&reply.body).map_err(|_| "Ответ источника не разобрать".to_string())
}

fn get_text(url: &str) -> Result<String, String> {
    let reply = net::get(url).map_err(|err| format!("нет связи: {}", err))?;
    if reply.status != 200 {
        return Err(format!("источник ответил {}", reply.status));
    }
    Ok(reply.body)
}

/* ───────────────────────────── каталог ядер ───────────────────────────── */

/// Описание ядра: то, что показывает окно мастера.
pub struct Kernel {
    pub id: &'static str,
    pub label: &'static str,
    pub group: &'static str,
    pub hint: &'static str,
    pub java_min: u32,
    pub recommended: bool,
    pub installer: bool,
    pub proxy: bool,
    pub custom: bool,
}

/// Все ядра чёрным по белому: порядок как в прежней панели.
pub const KERNELS: [Kernel; 10] = [
    Kernel {
        id: "paper",
        label: "Paper",
        group: "Оптимизированные",
        hint: "Самый популярный оптимизированный сервер. Плагины Bukkit/Spigot.",
        java_min: 21,
        recommended: true,
        installer: false,
        proxy: false,
        custom: false,
    },
    Kernel {
        id: "folia",
        label: "Folia",
        group: "Оптимизированные",
        hint: "Многопоточный Paper для больших ферм. Многие плагины несовместимы.",
        java_min: 21,
        recommended: false,
        installer: false,
        proxy: false,
        custom: false,
    },
    Kernel {
        id: "purpur",
        label: "Purpur",
        group: "Оптимизированные",
        hint: "Форк Paper с большим числом настроек геймплея.",
        java_min: 21,
        recommended: false,
        installer: false,
        proxy: false,
        custom: false,
    },
    Kernel {
        id: "fabric",
        label: "Fabric",
        group: "Моды",
        hint: "Лёгкий загрузчик модов. Подходит для клиент-серверных модпаков.",
        java_min: 21,
        recommended: false,
        installer: false,
        proxy: false,
        custom: false,
    },
    Kernel {
        id: "vanilla",
        label: "Vanilla",
        group: "Официальные",
        hint: "Чистый сервер от Mojang, без плагинов и модов.",
        java_min: 21,
        recommended: false,
        installer: false,
        proxy: false,
        custom: false,
    },
    Kernel {
        id: "forge",
        label: "Forge",
        group: "Моды",
        hint: "Классический загрузчик модов. Устанавливается через установщик.",
        java_min: 17,
        recommended: false,
        installer: true,
        proxy: false,
        custom: false,
    },
    Kernel {
        id: "neoforge",
        label: "NeoForge",
        group: "Моды",
        hint: "Современный форк Forge для 1.20.2+. Устанавливается через установщик.",
        java_min: 21,
        recommended: false,
        installer: true,
        proxy: false,
        custom: false,
    },
    Kernel {
        id: "velocity",
        label: "Velocity",
        group: "Прокси",
        hint: "Быстрый прокси для объединения нескольких серверов.",
        java_min: 17,
        recommended: false,
        installer: false,
        proxy: true,
        custom: false,
    },
    Kernel {
        id: "waterfall",
        label: "Waterfall",
        group: "Прокси",
        hint: "Прокси на базе BungeeCord (устаревает, лучше Velocity).",
        java_min: 17,
        recommended: false,
        installer: false,
        proxy: true,
        custom: false,
    },
    Kernel {
        id: "custom",
        label: "Своя ссылка",
        group: "Другое",
        hint: "Любой jar по прямой ссылке (GitHub Releases, maven, свой хостинг).",
        java_min: 0,
        recommended: false,
        installer: false,
        proxy: false,
        custom: true,
    },
];

/// Какое ядро выбрано (пусто — неизвестное).
pub fn kernel(id: &str) -> Option<&'static Kernel> {
    KERNELS.iter().find(|k| k.id == id)
}

/// Список ядер для окна мастера.
pub fn catalog() -> Value {
    Value::Arr(
        KERNELS
            .iter()
            .map(|k| {
                Value::obj(vec![
                    ("id", Value::str(k.id)),
                    ("label", Value::str(k.label)),
                    ("group", Value::str(k.group)),
                    ("hint", Value::str(k.hint)),
                    ("recommended", Value::Bool(k.recommended)),
                    ("installer", Value::Bool(k.installer)),
                    ("proxy", Value::Bool(k.proxy)),
                    ("custom", Value::Bool(k.custom)),
                    (
                        "javaMin",
                        if k.java_min == 0 { Value::Null } else { Value::Num(k.java_min as f64) },
                    ),
                ])
            })
            .collect(),
    )
}

/* ─────────────────────────── версии и ссылки ─────────────────────────── */

/// Куда качать ядро и как его запускать.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Resolved {
    pub url: String,
    pub file_name: String,
    pub size: u64,
    pub sha256: String,
    pub sha1: String,
    pub build: String,
    pub java: Option<u32>,
    pub run_installer: bool,
    pub note: String,
}

impl Resolved {
    pub fn to_json(&self) -> Value {
        Value::obj(vec![
            ("url", Value::str(&self.url)),
            ("fileName", Value::str(&self.file_name)),
            ("size", Value::from(self.size)),
            ("sha256", Value::str(&self.sha256)),
            ("sha1", Value::str(&self.sha1)),
            ("build", Value::str(&self.build)),
            (
                "java",
                match self.java {
                    Some(java) => Value::Num(java as f64),
                    None => Value::Null,
                },
            ),
            ("runInstaller", Value::Bool(self.run_installer)),
            ("note", Value::str(&self.note)),
        ])
    }
}

fn number(value: &Value, name: &str) -> u64 {
    value.get(name).and_then(|v| v.as_f64()).unwrap_or(0.0) as u64
}

fn text_of(value: &Value, name: &str) -> String {
    value.get(name).map(|v| v.text()).unwrap_or_default()
}

/// Разбирает ответ PaperMC/Folia/Velocity/Waterfall: список версий.
fn paper_versions(bases: &Bases, project: &str) -> Result<Vec<Value>, String> {
    let data = get_json(&format!("{}/{}/versions", bases.papermc, project))?;
    let mut out = Vec::new();
    for item in data.get("versions").map(|v| v.as_arr().to_vec()).unwrap_or_default() {
        let version = item.get("version").cloned().unwrap_or(Value::Null);
        let id = text_of(&version, "id");
        if id.is_empty() {
            continue;
        }
        /* неподдерживаемые версии не предлагаем: за них никто не отвечает */
        let status = version
            .get("support")
            .and_then(|s| s.get("status"))
            .map(|s| s.text())
            .unwrap_or_default();
        /* статус сравниваем целиком: «UNSUPPORTED» содержит «SUPPORTED»,
           и по вхождению старые версии просачивались в список */
        let status = status.to_uppercase();
        if !status.is_empty() && status != "SUPPORTED" && status != "SUPPORT" && status != "MAINTENANCE" {
            continue;
        }
        let java = version
            .get("java")
            .and_then(|j| j.get("version"))
            .map(|v| number(v, "minimum"));
        out.push(Value::obj(vec![
            ("id", Value::str(id)),
            (
                "java",
                match java {
                    Some(java) if java > 0 => Value::Num(java as f64),
                    _ => Value::Null,
                },
            ),
        ]));
    }
    Ok(out)
}

/// Разбирает сборки PaperMC: берём стабильную, иначе первую.
fn paper_resolve(bases: &Bases, project: &str, version: &str, fallback_name: &str) -> Result<Resolved, String> {
    let builds = get_json(&format!("{}/{}/versions/{}/builds", bases.papermc, project, encode(version)))?;
    let list = if builds.as_arr().is_empty() {
        builds.get("builds").map(|v| v.as_arr().to_vec()).unwrap_or_default()
    } else {
        builds.as_arr().to_vec()
    };
    if list.is_empty() {
        return Err(format!("Нет сборок {} для этой версии", project));
    }
    let stable = list
        .iter()
        .find(|b| {
            let channel = b.get("channel").map(|c| c.text()).unwrap_or_else(|| "STABLE".to_string());
            channel == "STABLE"
        })
        .unwrap_or(&list[0]);
    let downloads = stable.get("downloads").cloned().unwrap_or(Value::Null);
    let download = downloads
        .get("server:default")
        .cloned()
        .or_else(|| obj_pairs(&downloads).first().map(|(_, value)| value.clone()))
        .unwrap_or(Value::Null);
    let url = text_of(&download, "url");
    if url.is_empty() {
        return Err("У сборки нет ссылки на скачивание".to_string());
    }
    let name = text_of(&download, "name");
    Ok(Resolved {
        url,
        file_name: if name.is_empty() { fallback_name.to_string() } else { name },
        size: number(&download, "size"),
        sha256: download
            .get("checksums")
            .map(|c| text_of(c, "sha256"))
            .unwrap_or_default(),
        build: stable
            .get("id")
            .map(|v| v.text())
            .or_else(|| stable.get("build").map(|v| v.text()))
            .unwrap_or_default(),
        java: stable
            .get("java")
            .and_then(|j| j.get("version"))
            .map(|v| number(v, "minimum") as u32),
        ..Resolved::default()
    })
}

/// Пары «ключ — значение» объекта JSON (порядок сохраняется).
fn obj_pairs(value: &Value) -> Vec<(String, Value)> {
    match value {
        Value::Obj(pairs) => pairs.clone(),
        _ => Vec::new(),
    }
}

fn encode(text: &str) -> String {
    let mut out = String::new();
    for byte in text.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(*byte as char),
            _ => out.push_str(&format!("%{:02X}", byte)),
        }
    }
    out
}

/// Список версий ядра (новые сверху, не больше 60).
pub fn versions(bases: &Bases, kernel_id: &str) -> Result<Vec<Value>, String> {
    let Some(kernel) = kernel(kernel_id) else {
        return Err(format!("Неизвестное ядро: {}", kernel_id));
    };
    let mut list = match kernel.id {
        "paper" | "folia" | "velocity" | "waterfall" => paper_versions(bases, kernel.id)?,
        "purpur" => {
            let data = get_json(&format!("{}/purpur", bases.purpur))?;
            let mut items: Vec<Value> = data
                .get("versions")
                .map(|v| v.as_arr().to_vec())
                .unwrap_or_default();
            /* новые сверху */
            items.reverse();
            items
                .into_iter()
                .map(|v| Value::obj(vec![("id", Value::str(v.text()))]))
                .collect()
        }
        "fabric" => {
            let data = get_json(&format!("{}/versions/game", bases.fabric))?;
            data.as_arr()
                .iter()
                .filter(|v| v.get("stable").map(|s| s.as_bool()).unwrap_or(false))
                .map(|v| Value::obj(vec![("id", Value::str(text_of(v, "version")))]))
                .collect()
        }
        "vanilla" => {
            let data = get_json(&format!("{}/mc/game/version_manifest_v2.json", bases.mojang))?;
            data.get("versions")
                .map(|v| v.as_arr().to_vec())
                .unwrap_or_default()
                .into_iter()
                .filter(|v| text_of(v, "type") == "release")
                .map(|v| {
                    Value::obj(vec![
                        ("id", Value::str(text_of(&v, "id"))),
                        ("url", Value::str(text_of(&v, "url"))),
                    ])
                })
                .collect()
        }
        "forge" => {
            let data = get_json(&format!("{}/promotions_slim.json", bases.forge))?;
            let promos = data.get("promos").cloned().unwrap_or(Value::Null);
            let mut pairs: Vec<(String, String, bool)> = Vec::new();
            for (key, build) in obj_pairs(&promos) {
                let (version, kind) = match key.rsplit_once('-') {
                    Some((version, kind)) => (version.to_string(), kind.to_string()),
                    None => continue,
                };
                let recommended = kind == "recommended";
                match pairs.iter_mut().find(|(v, _, _)| *v == version) {
                    Some(slot) => {
                        if recommended {
                            slot.1 = build.text();
                            slot.2 = true;
                        }
                    }
                    None => pairs.push((version, build.text(), recommended)),
                }
            }
            let mut list: Vec<(String, String, bool)> = pairs;
            list.sort_by(|a, b| cmp_ver(&b.0, &a.0).cmp(&0));
            list.into_iter()
                .map(|(version, build, recommended)| {
                    Value::obj(vec![
                        ("id", Value::str(version)),
                        ("build", Value::str(build)),
                        (
                            "type",
                            Value::str(if recommended { "recommended" } else { "latest" }),
                        ),
                    ])
                })
                .collect()
        }
        "neoforge" => {
            let xml = get_text(&format!("{}/maven-metadata.xml", bases.neoforge))?;
            let mut items: Vec<String> = Vec::new();
            let mut rest = xml.as_str();
            while let Some(start) = rest.find("<version>") {
                let after = &rest[start + "<version>".len()..];
                let Some(end) = after.find("</version>") else { break };
                items.push(after[..end].to_string());
                rest = &after[end..];
            }
            items.retain(|v| !v.to_lowercase().contains("beta") && !v.to_lowercase().contains("alpha"));
            items.sort_by(|a, b| cmp_ver(b, a).cmp(&0));
            items
                .into_iter()
                .map(|v| Value::obj(vec![("id", Value::str(v))]))
                .collect()
        }
        /* у своей ссылки версий нет */
        _ => Vec::new(),
    };
    list.truncate(60);
    Ok(list)
}

/// Прямая ссылка на ядро нужной версии.
pub fn resolve(bases: &Bases, kernel_id: &str, version: &str) -> Result<Resolved, String> {
    let Some(kernel) = kernel(kernel_id) else {
        return Err(format!("Неизвестное ядро: {}", kernel_id));
    };
    match kernel.id {
        "paper" => paper_resolve(bases, "paper", version, &format!("paper-{}.jar", version)),
        "folia" => paper_resolve(bases, "folia", version, &format!("folia-{}.jar", version)),
        "velocity" => paper_resolve(bases, "velocity", version, "velocity.jar"),
        "waterfall" => paper_resolve(bases, "waterfall", version, "waterfall.jar"),
        "purpur" => Ok(Resolved {
            url: format!("{}/purpur/{}/latest/download", bases.purpur, encode(version)),
            file_name: format!("purpur-{}.jar", version),
            ..Resolved::default()
        }),
        "fabric" => {
            let loaders = get_json(&format!("{}/versions/loader", bases.fabric))?;
            let installers = get_json(&format!("{}/versions/installer", bases.fabric))?;
            let pick = |list: &Value| -> String {
                let items = list.as_arr().to_vec();
                items
                    .iter()
                    .find(|v| v.get("stable").map(|s| s.as_bool()).unwrap_or(false))
                    .or_else(|| items.first())
                    .map(|v| text_of(v, "version"))
                    .unwrap_or_default()
            };
            let loader = pick(&loaders);
            let installer = pick(&installers);
            if loader.is_empty() {
                return Err("Fabric не отдал версию загрузчика".to_string());
            }
            Ok(Resolved {
                url: format!(
                    "{}/versions/loader/{}/{}/{}/server/jar",
                    bases.fabric,
                    encode(version),
                    encode(&loader),
                    encode(&installer)
                ),
                file_name: "fabric-server.jar".to_string(),
                note: format!("Fabric loader {}", loader),
                ..Resolved::default()
            })
        }
        "vanilla" => {
            let manifest = get_json(&format!("{}/mc/game/version_manifest_v2.json", bases.mojang))?;
            let entry = manifest
                .get("versions")
                .map(|v| v.as_arr().to_vec())
                .unwrap_or_default()
                .into_iter()
                .find(|v| text_of(v, "id") == version)
                .ok_or_else(|| "Версия не найдена в манифесте Mojang".to_string())?;
            let meta_url = text_of(&entry, "url");
            let meta = get_json(&meta_url)?;
            let server = meta
                .get("downloads")
                .and_then(|d| d.get("server"))
                .cloned()
                .ok_or_else(|| "У этой версии нет серверного jar".to_string())?;
            Ok(Resolved {
                url: text_of(&server, "url"),
                file_name: format!("minecraft_server-{}.jar", version),
                size: number(&server, "size"),
                sha1: text_of(&server, "sha1"),
                ..Resolved::default()
            })
        }
        "forge" => {
            let data = get_json(&format!("{}/promotions_slim.json", bases.forge))?;
            let promos = data.get("promos").cloned().unwrap_or(Value::Null);
            let build = promos
                .get(&format!("{}-recommended", version))
                .map(|v| v.text())
                .or_else(|| promos.get(&format!("{}-latest", version)).map(|v| v.text()))
                .unwrap_or_default();
            if build.is_empty() {
                return Err("Не удалось определить версию Forge".to_string());
            }
            Ok(Resolved {
                url: format!(
                    "https://maven.minecraftforge.net/net/minecraftforge/forge/{}-{}/forge-{}-{}-installer.jar",
                    version, build, version, build
                ),
                file_name: "forge-installer.jar".to_string(),
                run_installer: true,
                note: format!("Forge {}", build),
                ..Resolved::default()
            })
        }
        "neoforge" => Ok(Resolved {
            url: format!(
                "{}/{}/neoforge-{}-installer.jar",
                bases.neoforge, version, version
            ),
            file_name: "neoforge-installer.jar".to_string(),
            run_installer: true,
            note: format!("NeoForge {}", version),
            ..Resolved::default()
        }),
        _ => Err("Для своей ссылки версия не нужна".to_string()),
    }
}

/// Сравнение версий вида 1.21.4 / 26.3 / 0.20.1.
pub fn cmp_ver(a: &str, b: &str) -> i64 {
    let split = |text: &str| -> Vec<i64> {
        text.split(|c| c == '.' || c == '-' || c == '+')
            .map(|piece| {
                let digits: String = piece.chars().take_while(|c| c.is_ascii_digit()).collect();
                digits.parse::<i64>().unwrap_or(0)
            })
            .collect()
    };
    let (left, right) = (split(a), split(b));
    for index in 0..left.len().max(right.len()) {
        let difference = left.get(index).copied().unwrap_or(0) - right.get(index).copied().unwrap_or(0);
        if difference != 0 {
            return difference;
        }
    }
    0
}

/* ───────────────────────────── Java в системе ───────────────────────── */

/// Главная версия Java: `21.0.5` → 21, `1.8.0_402` → 8.
pub fn java_major(version: &str) -> u32 {
    let digits: String = version.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    let first = digits.split('.').next().unwrap_or("").parse::<u32>().unwrap_or(0);
    if first == 1 {
        digits
            .split('.')
            .nth(1)
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or(0)
    } else {
        first
    }
}

fn parse_java_version(output: &str) -> String {
    let marker = "version \"";
    if let Some(start) = output.find(marker) {
        let rest = &output[start + marker.len()..];
        if let Some(end) = rest.find('"') {
            return rest[..end].to_string();
        }
    }
    if let Some(start) = output.to_lowercase().find("openjdk ") {
        let rest = &output[start + "openjdk ".len()..];
        return rest.split_whitespace().next().unwrap_or("").to_string();
    }
    String::new()
}

fn run_java(binary: &Path) -> Option<String> {
    let mut command = Command::new(binary);
    command.arg("-version");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command.output().ok()?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let version = parse_java_version(&text);
    if version.is_empty() {
        None
    } else {
        Some(version)
    }
}

/// Ищет установленные Java: PATH, JAVA_HOME и типовые папки Windows.
pub fn detect_java() -> Value {
    let mut found: Vec<(String, String, String)> = Vec::new();
    if let Some(version) = run_java(Path::new("java")) {
        found.push(("java".to_string(), version, "PATH".to_string()));
    }
    if let Ok(home) = std::env::var("JAVA_HOME") {
        let exe = Path::new(&home).join("bin").join(if cfg!(windows) { "java.exe" } else { "java" });
        if exe.is_file() {
            if let Some(version) = run_java(&exe) {
                found.push((exe.to_string_lossy().to_string(), version, "JAVA_HOME".to_string()));
            }
        }
    }
    if cfg!(windows) {
        let roots = [
            "C:\\Program Files\\Java",
            "C:\\Program Files\\Eclipse Adoptium",
            "C:\\Program Files\\Amazon Corretto",
            "C:\\Program Files\\Microsoft\\jdk",
            "C:\\Program Files\\Zulu",
            "C:\\Program Files\\BellSoft",
        ];
        for root in roots {
            let Ok(entries) = std::fs::read_dir(root) else { continue };
            for entry in entries.flatten() {
                let exe = entry.path().join("bin").join("java.exe");
                if !exe.is_file() {
                    continue;
                }
                let version = run_java(&exe).unwrap_or_else(|| {
                    entry.file_name().to_string_lossy().to_string()
                });
                found.push((exe.to_string_lossy().to_string(), version, root.to_string()));
            }
        }
    }
    let mut seen: Vec<String> = Vec::new();
    let mut out: Vec<Value> = Vec::new();
    for (path, version, source) in found {
        let key = format!("{}|{}", version, path);
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        out.push(Value::obj(vec![
            ("path", Value::str(path)),
            ("version", Value::str(&version)),
            ("source", Value::str(source)),
            ("major", Value::Num(java_major(&version) as f64)),
        ]));
    }
    Value::Arr(out)
}

/* ─────────────────────── файлы сервера и запуск ─────────────────────── */

/// Путь с пробелами в bat/sh обязан быть в кавычках.
pub fn quote_exe(command: &str) -> String {
    let text = if command.trim().is_empty() { "java" } else { command };
    if (text.starts_with('"') && text.ends_with('"')) || (text.starts_with('\'') && text.ends_with('\'')) {
        return text.to_string();
    }
    if text.contains(' ') {
        format!("\"{}\"", text)
    } else {
        text.to_string()
    }
}

/// Кириллицу в `server.properties` экранируем: старые версии читают его
/// не в UTF-8, и тогда вместо MOTD появляются вопросики.
pub fn escape_props(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        if (' '..='~').contains(&ch) {
            out.push(ch);
        } else {
            out.push_str(&format!("\\u{:04x}", ch as u32));
        }
    }
    out
}

/// Скрипт запуска: `start.bat` на Windows, `start.sh` везде остальном.
pub fn start_script(name: &str, jar: &str, java_args: &str, java_cmd: &str, proxy: bool, windows: bool) -> (String, String) {
    let nogui = if proxy { "" } else { " nogui" };
    if windows {
        let content = [
            "@echo off".to_string(),
            "chcp 65001 >nul".to_string(),
            format!("title {}", name),
            "cd /d \"%~dp0\"".to_string(),
            format!(
                "{} {} -jar \"{}\"{}",
                quote_exe(java_cmd),
                java_args,
                jar,
                nogui
            ),
            "pause".to_string(),
        ]
        .join("\r\n");
        ("start.bat".to_string(), content)
    } else {
        let content = [
            "#!/bin/sh".to_string(),
            "cd \"$(dirname \"$0\")\"".to_string(),
            format!(
                "exec {} {} -jar \"{}\"{}",
                quote_exe(java_cmd),
                java_args,
                jar,
                nogui
            ),
        ]
        .join("\n");
        ("start.sh".to_string(), content)
    }
}

/// Настройки нового сервера.
pub fn server_properties(port: u16, motd: &str, online_mode: bool, max_players: u16, difficulty: &str) -> String {
    [
        "#Minecraft server properties".to_string(),
        "#создано панелью OmniPanel".to_string(),
        format!("server-port={}", port),
        format!("motd={}", escape_props(motd)),
        format!("online-mode={}", online_mode),
        format!("max-players={}", max_players),
        format!("difficulty={}", difficulty),
        "gamemode=survival".to_string(),
        "pvp=true".to_string(),
        "allow-flight=false".to_string(),
        "allow-nether=true".to_string(),
        "enable-command-block=true".to_string(),
        "spawn-protection=16".to_string(),
        "view-distance=10".to_string(),
        "simulation-distance=10".to_string(),
        "white-list=false".to_string(),
        "level-name=world".to_string(),
        "level-seed=".to_string(),
        "enable-rcon=false".to_string(),
        "sync-chunk-writes=true".to_string(),
        String::new(),
    ]
    .join("\n")
}

/// Куда предложить папку сервера: имя без запрещённых символов.
pub fn suggest_dir(parent: &str, name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| !matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .collect();
    let cleaned = cleaned.trim().to_string();
    let folder = if cleaned.is_empty() { "server".to_string() } else { cleaned };
    let base = if parent.trim().is_empty() {
        std::env::temp_dir().to_string_lossy().to_string()
    } else {
        parent.to_string()
    };
    Path::new(&base)
        .join(folder)
        .to_string_lossy()
        .to_string()
}

/// Итог создания сервера: что запускать и где.
#[derive(Debug, Clone, PartialEq)]
pub struct Created {
    pub command: String,
    pub cwd: String,
    pub stop_command: String,
    pub tps_command: String,
    pub is_proxy: bool,
    pub jar: String,
}

impl Created {
    pub fn to_json(&self) -> Value {
        Value::obj(vec![
            ("command", Value::str(&self.command)),
            ("cwd", Value::str(&self.cwd)),
            ("stopCommand", Value::str(&self.stop_command)),
            ("tpsCommand", Value::str(&self.tps_command)),
            ("isProxy", Value::Bool(self.is_proxy)),
            ("jar", Value::str(&self.jar)),
        ])
    }
}

/// Создаёт сервер: скачивает ядро, пишет конфиги и скрипт запуска.
/// `progress(stage, text, percent)` — то, что видно в окне мастера.
pub fn create_server(
    bases: &Bases,
    opts: &Value,
    mut progress: impl FnMut(&str, &str, Option<u32>),
) -> Result<Created, String> {
    let text = |name: &str| opts.get(name).map(|v| v.text()).unwrap_or_default();
    let number_of = |name: &str, fallback: f64| -> f64 {
        opts.get(name).and_then(|v| v.as_f64()).unwrap_or(fallback)
    };

    let dir_text = text("dir");
    if dir_text.trim().is_empty() {
        return Err("Не указана папка для сервера".to_string());
    }
    let dir = PathBuf::from(&dir_text);
    std::fs::create_dir_all(&dir).map_err(|err| format!("Не удалось создать папку: {}", err))?;

    let kernel_id = {
        let chosen = text("kernel");
        if chosen.is_empty() { "paper".to_string() } else { chosen }
    };
    let Some(kernel) = kernel(&kernel_id) else {
        return Err(format!("Неизвестное ядро: {}", kernel_id));
    };
    let version = text("version");
    let java_cmd = {
        let chosen = text("javaCmd");
        if chosen.is_empty() { "java".to_string() } else { chosen }
    };
    let memory_min = opts
        .get("memoryMb")
        .and_then(|v| v.get("min"))
        .and_then(|v| v.as_f64())
        .unwrap_or(1024.0);
    let memory_max = opts
        .get("memoryMb")
        .and_then(|v| v.get("max"))
        .and_then(|v| v.as_f64())
        .unwrap_or(4096.0);
    let flags_preset = {
        let chosen = text("flagsPreset");
        if chosen.is_empty() { "aikar".to_string() } else { chosen }
    };
    let extra_flags = text("extraFlags");
    let port = number_of("port", 25565.0) as u16;
    let motd = {
        let chosen = text("motd");
        if chosen.is_empty() { "OmniPanel".to_string() } else { chosen }
    };
    let online_mode = opts.get("onlineMode").map(|v| v.as_bool()).unwrap_or(true);
    let start_script_on = opts
        .get("generateStartScript")
        .map(|v| v.as_bool())
        .unwrap_or(true);

    /* 1. откуда брать ядро */
    let resolved = if kernel.custom {
        let url = text("customUrl");
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err("Нужна прямая http(s)-ссылка на jar".to_string());
        }
        let mut name = text("customName").trim().to_string();
        if name.is_empty() {
            let tail = url.rsplit('/').next().unwrap_or("");
            let tail = decode(tail);
            name = if tail.to_lowercase().ends_with(".jar") {
                tail
            } else {
                "server.jar".to_string()
            };
        }
        if !name.to_lowercase().ends_with(".jar") {
            name.push_str(".jar");
        }
        Resolved {
            url,
            file_name: name,
            ..Resolved::default()
        }
    } else {
        if version.trim().is_empty() {
            return Err("Не выбрана версия".to_string());
        }
        progress(
            "resolve",
            &format!("Ищу сборку {} {}…", kernel.label, version),
            None,
        );
        resolve(bases, kernel.id, &version)?
    };

    /* 2. скачивание — с прогрессом, как в прежней панели */
    let jar_path = dir.join(&resolved.file_name);
    let already = std::fs::metadata(&jar_path).map(|m| m.len() > 0).unwrap_or(false);
    if already {
        progress("download", &format!("Файл уже есть: {}", resolved.file_name), Some(100));
    } else {
        progress("download", &format!("Скачиваю {}…", resolved.file_name), Some(0));
        let part = PathBuf::from(format!("{}.part", jar_path.display()));
        let label = resolved.file_name.clone();
        let saved = net::download_streaming(&resolved.url, &part, None, |received, total| {
            let percent = total
                .filter(|total| *total > 0)
                .map(|total| (received * 100 / total) as u32);
            let megabytes = |bytes: u64| format!("{:.1}", bytes as f64 / 1_048_576.0).replace('.', ",");
            let text = match total {
                Some(total) => format!(
                    "Скачиваю {} — {}% ({} из {} МБ)",
                    label,
                    percent.unwrap_or(0),
                    megabytes(received),
                    megabytes(total)
                ),
                None => format!("Скачиваю {} — {} МБ", label, megabytes(received)),
            };
            progress("download", &text, percent);
        });
        if let Err(err) = saved {
            let _ = std::fs::remove_file(&part);
            return Err(err);
        }
        std::fs::rename(&part, &jar_path).map_err(|err| format!("Не удалось сохранить ядро: {}", err))?;
    }

    /* 3. установщик Forge/NeoForge: он сам собирает сервер */
    let mut installed_jar: Option<String> = None;
    if resolved.run_installer {
        progress(
            "install",
            "Запускаю установщик — это может занять несколько минут…",
            Some(0),
        );
        let mut command = Command::new(&java_cmd);
        command
            .arg("-jar")
            .arg(&resolved.file_name)
            .arg("--installServer")
            .current_dir(&dir);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let output = command
            .output()
            .map_err(|err| format!("Установщик не запустился: {}", err))?;
        if !output.status.success() {
            let tail = String::from_utf8_lossy(&output.stderr);
            let short: String = tail.chars().rev().take(300).collect::<Vec<char>>().into_iter().rev().collect();
            return Err(format!("Установщик не смог завершиться: {}", short.trim()));
        }
        /* чем запускать: run.bat, forge-*.jar или neoforge-*.jar */
        let entries: Vec<String> = std::fs::read_dir(&dir)
            .map(|list| {
                list.flatten()
                    .map(|e| e.file_name().to_string_lossy().to_string())
                    .collect()
            })
            .unwrap_or_default();
        installed_jar = if cfg!(windows) && entries.iter().any(|name| name == "run.bat") {
            Some("run.bat".to_string())
        } else {
            entries
                .iter()
                .find(|name| {
                    let lower = name.to_lowercase();
                    lower.starts_with("forge-") && lower.ends_with(".jar")
                        || lower.starts_with("neoforge-") && lower.ends_with(".jar")
                })
                .cloned()
        };
        progress("install", "Установщик завершён", Some(100));
    }

    /* 4. файлы сервера: EULA и настройки (у прокси их нет) */
    if !kernel.proxy {
        let eula = dir.join("eula.txt");
        if !eula.exists() {
            std::fs::write(
                &eula,
                "#Согласие с EULA Minecraft\n#https://aka.ms/MinecraftEULA\neula=true\n",
            )
            .map_err(|err| format!("Не удалось записать eula.txt: {}", err))?;
        }
        let props = dir.join("server.properties");
        if !props.exists() {
            std::fs::write(&props, server_properties(port, &motd, online_mode, 20, "easy"))
                .map_err(|err| format!("Не удалось записать server.properties: {}", err))?;
        }
    }

    /* 5. аргументы Java и скрипт запуска */
    let mut args: Vec<String> = vec![
        format!("-Xms{}M", memory_min as u64),
        format!("-Xmx{}M", memory_max as u64),
    ];
    if flags_preset == "aikar" {
        args.push(AIKAR.to_string());
    } else if flags_preset == "simple" {
        args.push("-XX:+UseG1GC -XX:+ParallelRefProcEnabled".to_string());
    }
    if !extra_flags.trim().is_empty() {
        args.push(extra_flags.trim().to_string());
    }
    if kernel.id == "fabric" {
        args.push("-Dfabric.server=true".to_string());
    }
    let args_text = args.join(" ");
    let jar = installed_jar.clone().unwrap_or_else(|| resolved.file_name.clone());

    let command = if start_script_on {
        if installed_jar.as_deref() == Some("run.bat") {
            "run.bat".to_string()
        } else {
            let (file_name, content) = start_script(
                if text("name").trim().is_empty() {
                    dir.file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| "server".to_string())
                } else {
                    text("name")
                }
                .as_str(),
                &jar,
                &args_text,
                &java_cmd,
                kernel.proxy,
                cfg!(windows),
            );
            let path = dir.join(&file_name);
            std::fs::write(&path, content)
                .map_err(|err| format!("Не удалось записать скрипт запуска: {}", err))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755));
            }
            file_name
        }
    } else {
        format!(
            "{} {} -jar \"{}\"{}",
            java_cmd,
            args_text,
            jar,
            if kernel.proxy { "" } else { " nogui" }
        )
    };

    progress("done", "Сервер готов", Some(100));
    Ok(Created {
        command,
        cwd: dir.to_string_lossy().to_string(),
        stop_command: if kernel.proxy { "end" } else { "stop" }.to_string(),
        tps_command: if kernel.proxy { "" } else { "tps" }.to_string(),
        is_proxy: kernel.proxy,
        jar,
    })
}

/// Декодирует «%D0%BC» в имени файла из ссылки.
fn decode(text: &str) -> String {
    crate::http::percent_decode(text)
}

/// Первая версия Java, подходящая ядру (для подсказки в мастере).
pub fn java_needed(kernel_id: &str) -> Option<u32> {
    kernel(kernel_id).map(|k| k.java_min).filter(|min| *min > 0)
}
