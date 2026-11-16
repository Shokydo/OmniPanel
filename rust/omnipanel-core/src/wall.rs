//! Обои панели: свои картинки и видео, а также подбор палитры под фон.
//!
//! Человек выбирает файл из проводника — панель копирует его в свою папку
//! данных и отдаёт интерфейсу по адресу `/api/wall/<имя>`. Так фон переживает
//! перезапуск и работает и в окне, и в браузере.
//!
//! Подбор палитры: картинка уменьшается до 64×64, пиксели собираются в
//! корзины по 16 оттенков на канал, из них берутся фон, панель, линии, текст
//! и акцент. Алгоритм перенесён из прежней панели один в один — иначе темы
//! на тех же обоях выглядели бы иначе.

use crate::image;
use crate::json::Value;
use std::path::{Path, PathBuf};

/// Форматы, которые панель принимает как фон (включая видео).
pub const EXTENSIONS: [&str; 8] = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "mp4", "webm"];
/// Больше 120 МБ фоном не берём: это уже не обои, а фильм.
const MAX_SIZE: u64 = 120 * 1024 * 1024;

/// Папка с обоями внутри данных панели.
pub fn dir(data_dir: &Path) -> PathBuf {
    data_dir.join("wallpapers")
}

fn ensure(data_dir: &Path) -> PathBuf {
    let path = dir(data_dir);
    let _ = std::fs::create_dir_all(&path);
    path
}

/// Копирует выбранный файл в папку обоев. Возвращает объект для интерфейса.
pub fn pick(data_dir: &Path, source: &str) -> Value {
    let src = PathBuf::from(source.trim());
    if src.as_os_str().is_empty() || !src.is_file() {
        return error("Файл фона не найден");
    }
    let extension = src
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if !EXTENSIONS.contains(&extension.as_str()) {
        return error(format!("Неподдерживаемый формат: {}", extension));
    }
    let size = std::fs::metadata(&src).map(|m| m.len()).unwrap_or(0);
    if size > MAX_SIZE {
        return error("Файл больше 120 МБ");
    }
    let base = src
        .file_stem()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "wall".to_string());
    let safe: String = base
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '.' || c == '_' { c } else { '_' })
        .take(40)
        .collect();
    let name = format!(
        "{}-{}.{}",
        if safe.is_empty() { "wall" } else { &safe },
        stamp(),
        extension
    );
    let target = ensure(data_dir).join(&name);
    match std::fs::copy(&src, &target) {
        Ok(_) => Value::obj(vec![
            ("ok", Value::Bool(true)),
            ("name", Value::str(&name)),
            ("url", Value::str(format!("/api/wall/{}", name))),
            ("size", Value::from(size)),
        ]),
        Err(err) => error(format!("Не удалось скопировать файл: {}", err)),
    }
}

/// Убирает обои из папки панели.
pub fn remove(data_dir: &Path, name: &str) -> Value {
    let safe = safe_name(name);
    let Some(safe) = safe else {
        return error("Неверное имя файла");
    };
    let file = dir(data_dir).join(&safe);
    if file.is_file() && std::fs::remove_file(&file).is_err() {
        return error("Не удалось удалить файл");
    }
    ok()
}

/// Список своих обоев.
pub fn list(data_dir: &Path) -> Value {
    let mut names: Vec<String> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir(data_dir)) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let extension = Path::new(&name)
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            if EXTENSIONS.contains(&extension.as_str()) {
                names.push(name);
            }
        }
    }
    names.sort();
    Value::Arr(
        names
            .iter()
            .map(|name| {
                Value::obj(vec![
                    ("name", Value::str(name.clone())),
                    ("url", Value::str(format!("/api/wall/{}", name))),
                ])
            })
            .collect(),
    )
}

/// Имя файла обоев без пути — чтобы нельзя было выйти из папки панели.
pub fn safe_name(name: &str) -> Option<String> {
    let base = Path::new(name.trim())
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let extension = Path::new(&base)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if base.is_empty() || base.contains("..") || !EXTENSIONS.contains(&extension.as_str()) {
        return None;
    }
    Some(base)
}

/// Тип содержимого для отдачи файла обоев браузеру.
pub fn mime(name: &str) -> &'static str {
    let lower = name.to_lowercase();
    if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".bmp") {
        "image/bmp"
    } else if lower.ends_with(".mp4") {
        "video/mp4"
    } else if lower.ends_with(".webm") {
        "video/webm"
    } else {
        "application/octet-stream"
    }
}

/// Откуда взять картинку для подбора палитры.
pub fn resolve(data_dir: &Path, app_dir: &Path, source: &Value) -> Option<PathBuf> {
    let kind = source.get("kind").map(|v| v.text()).unwrap_or_default();
    match kind.as_str() {
        "builtin" => {
            let name = safe_name(&source.get("src").map(|v| v.text()).unwrap_or_default())?;
            let file = app_dir.join("assets").join("wallpapers").join(name);
            file.is_file().then_some(file)
        }
        "custom" => {
            let name = safe_name(&source.get("name").map(|v| v.text()).unwrap_or_default())?;
            let file = dir(data_dir).join(name);
            file.is_file().then_some(file)
        }
        "file" => {
            let file = PathBuf::from(source.get("path").map(|v| v.text()).unwrap_or_default());
            file.is_file().then_some(file)
        }
        _ => {
            /* просто строка с путём или именем обоев */
            let text = source.text();
            if text.trim().is_empty() {
                return None;
            }
            let direct = PathBuf::from(&text);
            if direct.is_file() {
                return Some(direct);
            }
            let name = safe_name(&text)?;
            let file = dir(data_dir).join(name);
            file.is_file().then_some(file)
        }
    }
}

/// Подбор палитры под фон. Понимает PNG; для остального честно говорит,
/// что подобрать не может — интерфейс тогда считает цвета сам в браузере.
pub fn palette(data_dir: &Path, app_dir: &Path, source: &Value) -> Value {
    let Some(file) = resolve(data_dir, app_dir, source) else {
        return error("Файл фона не найден");
    };
    let data = match std::fs::read(&file) {
        Ok(data) => data,
        Err(err) => return error(format!("Не удалось прочитать файл: {}", err)),
    };
    let picture = match image::decode_any(&data) {
        Ok(picture) => picture,
        Err(_) => return error("Цвета подбираются для PNG и JPEG — выбери такую картинку"),
    };
    let small = picture.resize(64, 64);
    let mut buckets: std::collections::HashMap<u16, (u64, f64, f64, f64)> = std::collections::HashMap::new();
    let (mut sum_r, mut sum_g, mut sum_b, mut count) = (0f64, 0f64, 0f64, 0u64);
    for pixel in small.pixels.chunks(4) {
        let (r, g, b, a) = (pixel[0], pixel[1], pixel[2], pixel[3]);
        if a < 40 {
            continue;
        }
        sum_r += r as f64;
        sum_g += g as f64;
        sum_b += b as f64;
        count += 1;
        let key = (((r as u16) >> 4) << 8) | (((g as u16) >> 4) << 4) | ((b as u16) >> 4);
        let slot = buckets.entry(key).or_insert((0, 0.0, 0.0, 0.0));
        slot.0 += 1;
        slot.1 += r as f64;
        slot.2 += g as f64;
        slot.3 += b as f64;
    }
    if count == 0 {
        return error("Картинка пустая");
    }
    let average = [sum_r / count as f64, sum_g / count as f64, sum_b / count as f64];
    let dark = luma(average[0], average[1], average[2]) < 0.55;

    /* акцент — самая насыщенная и достаточно частая корзина */
    let mut accent: Option<[f64; 3]> = None;
    let mut best = 0f64;
    for (n, r, g, b) in buckets.values() {
        let (r, g, b) = (r / *n as f64, g / *n as f64, b / *n as f64);
        let saturation = sat(r, g, b);
        let weight = saturation * ((1.0 + *n as f64).log2());
        if saturation > 0.22 && weight > best {
            best = weight;
            accent = Some([r, g, b]);
        }
    }
    let accent = accent.unwrap_or_else(|| {
        mix(average, if dark { [255.0, 255.0, 255.0] } else { [0.0, 0.0, 0.0] }, 0.55)
    });

    let base = if dark { [8.0, 8.0, 10.0] } else { [250.0, 250.0, 251.0] };
    let bg = mix(average, base, 0.82);
    let panel = mix(
        average,
        if dark { [255.0, 255.0, 255.0] } else { [0.0, 0.0, 0.0] },
        if dark { 0.08 } else { 0.04 },
    );
    let line = mix(bg, if dark { [255.0, 255.0, 255.0] } else { [0.0, 0.0, 0.0] }, 0.16);
    let text = if dark { [236.0, 236.0, 238.0] } else { [22.0, 22.0, 26.0] };
    let dim = mix(text, bg, 0.42);

    /* акцент должен читаться на фоне — при нужде светлим или темним */
    let mut accent_final = mix(
        accent,
        if dark { [255.0, 255.0, 255.0] } else { [0.0, 0.0, 0.0] },
        if dark { 0.12 } else { 0.1 },
    );
    if (luma(accent_final[0], accent_final[1], accent_final[2]) - luma(bg[0], bg[1], bg[2])).abs() < 0.18 {
        accent_final = mix(
            accent_final,
            if dark { [255.0, 255.0, 255.0] } else { [0.0, 0.0, 0.0] },
            0.3,
        );
    }
    let button_text = if luma(accent_final[0], accent_final[1], accent_final[2]) > 0.6 {
        "#0b0b0d"
    } else {
        "#f7f7f9"
    };
    Value::obj(vec![
        ("ok", Value::Bool(true)),
        ("dark", Value::Bool(dark)),
        (
            "colors",
            Value::obj(vec![
                ("bg", Value::str(hex(bg))),
                ("panel", Value::str(hex(panel))),
                ("line", Value::str(hex(line))),
                ("text", Value::str(hex(text))),
                ("dim", Value::str(hex(dim))),
                ("accent", Value::str(hex(accent_final))),
                ("btn", Value::str(hex(accent_final))),
                ("btnText", Value::str(button_text)),
            ]),
        ),
    ])
}

fn hex(color: [f64; 3]) -> String {
    let clamp = |v: f64| v.max(0.0).min(255.0).round() as u32;
    format!("#{:02x}{:02x}{:02x}", clamp(color[0]), clamp(color[1]), clamp(color[2]))
}

fn luma(r: f64, g: f64, b: f64) -> f64 {
    (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0
}

fn sat(r: f64, g: f64, b: f64) -> f64 {
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    if max == 0.0 {
        0.0
    } else {
        (max - min) / max
    }
}

fn mix(from: [f64; 3], to: [f64; 3], k: f64) -> [f64; 3] {
    [
        from[0] + (to[0] - from[0]) * k,
        from[1] + (to[1] - from[1]) * k,
        from[2] + (to[2] - from[2]) * k,
    ]
}

fn stamp() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    /* короткий номер в 36-ричной записи — как в прежней панели */
    let mut value = nanos as u64;
    let digits = "0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = String::new();
    while value > 0 {
        out.insert(0, digits.as_bytes()[(value % 36) as usize] as char);
        value /= 36;
    }
    out
}

fn ok() -> Value {
    Value::obj(vec![("ok", Value::Bool(true))])
}

fn error(message: impl Into<String>) -> Value {
    Value::obj(vec![("ok", Value::Bool(false)), ("error", Value::str(message))])
}
