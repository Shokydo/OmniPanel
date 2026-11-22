//! Передача сервера по токену.
//!
//! Как это работает с точки зрения человека: в панели выбираешь сервер,
//! нажимаешь «Создать токен», получаешь одну строку и передаёшь её кому
//! угодно. Получатель вставляет строку в своей панели, и сервер появляется
//! у него на диске и в списке.
//!
//! Что под этим лежит:
//!
//! 1. папка сервера пакуется своим ZIP-писателем ([`pack`]) — файл-за-файлом,
//!    блок-за-блоком, чтобы в памяти не оказался весь сервер;
//! 2. архив тут же шифруется ChaCha20 и получает MAC — наружу уходит только
//!    шифротекст, ключ едет внутри токена;
//! 3. шифротекст кладётся на анонимный файлообменник ([`upload`]);
//! 4. всё, что нужно получателю — адрес, ключ и контрольная сумма, — кладётся
//!    в одну строку [`Token`];
//! 5. получатель скачивает ([`fetch`]), сверяет сумму и распаковывает
//!    ([`unpack`]).
//!
//! Токен одноразовый и живёт сутки: [`ShareRecord`] помнит, что выдано,
//! [`mark_used`] закрывает токен после скачивания, [`revoke`] закрывает его
//! по просьбе отправителя.

use crate::json::Value;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

/// Сколько часов живёт токен.
pub const DEFAULT_TTL_HOURS: u64 = 24;

/// Сколько секунд запись о токене живёт после истечения срока (неделя).
///
/// Записи нужны и после использования: без них панель не отличит повторный
/// запрос по старому токену от первого.
pub const KEEP_AFTER_EXPIRY: u64 = 7 * 24 * 60 * 60;

/// Метка наших файлов: первые байты шифротекста.
pub const MAGIC: &[u8; 4] = b"OMS1";

/// Начало строки токена.
const TOKEN_PREFIX: &str = "OMNISHARE1";

/// Символы base32 без похожих друг на друга (нет 0/1/o/l/u — их путают).
const ALPHABET: &[u8; 32] = b"23456789abcdefghjkmnpqrstvwxyzAB";

/* ─────────────────────────── шифрование ─────────────────────────── */

/// ChaCha20 без зависимостей: 32-байтный ключ, 12-байтный nonce.
fn chacha20(key: &[u8; 32], nonce: &[u8; 12], data: &mut [u8]) {
    let mut state = [0u32; 16];
    state[0] = 0x6170_7865;
    state[1] = 0x3320_646e;
    state[2] = 0x7962_2d32;
    state[3] = 0x6b20_6574;
    for i in 0..8 {
        state[4 + i] = u32::from_le_bytes([
            key[i * 4],
            key[i * 4 + 1],
            key[i * 4 + 2],
            key[i * 4 + 3],
        ]);
    }
    state[13] = u32::from_le_bytes([nonce[0], nonce[1], nonce[2], nonce[3]]);
    state[14] = u32::from_le_bytes([nonce[4], nonce[5], nonce[6], nonce[7]]);
    state[15] = u32::from_le_bytes([nonce[8], nonce[9], nonce[10], nonce[11]]);

    for (index, block) in data.chunks_mut(64).enumerate() {
        state[12] = index as u32;
        let mut work = state;
        for _ in 0..10 {
            quarter(&mut work, 0, 4, 8, 12);
            quarter(&mut work, 1, 5, 9, 13);
            quarter(&mut work, 2, 6, 10, 14);
            quarter(&mut work, 3, 7, 11, 15);
            quarter(&mut work, 0, 5, 10, 15);
            quarter(&mut work, 1, 6, 11, 12);
            quarter(&mut work, 2, 7, 8, 13);
            quarter(&mut work, 3, 4, 9, 14);
        }
        for i in 0..16 {
            work[i] = work[i].wrapping_add(state[i]);
        }
        let mut stream = [0u8; 64];
        for i in 0..16 {
            stream[i * 4..i * 4 + 4].copy_from_slice(&work[i].to_le_bytes());
        }
        for (byte, mask) in block.iter_mut().zip(stream.iter()) {
            *byte ^= *mask;
        }
    }
}

fn quarter(state: &mut [u32; 16], a: usize, b: usize, c: usize, d: usize) {
    state[a] = state[a].wrapping_add(state[b]);
    state[d] = (state[d] ^ state[a]).rotate_left(16);
    state[c] = state[c].wrapping_add(state[d]);
    state[b] = (state[b] ^ state[c]).rotate_left(12);
    state[a] = state[a].wrapping_add(state[b]);
    state[d] = (state[d] ^ state[a]).rotate_left(8);
    state[c] = state[c].wrapping_add(state[d]);
    state[b] = (state[b] ^ state[c]).rotate_left(7);
}

/// Случайные байты для ключа.
///
/// На Linux и macOS берём `/dev/urandom`. В Windows его нет, а ключ обязан
/// быть настоящим: `RandomState` в стандартной библиотеке засевается
/// операционной системой, поэтому из него и строим — плюс счётчик, чтобы два
/// вызова подряд ни за что не совпали (на этом ловился тест `чужой_ключ`).
pub fn random_bytes(count: usize) -> Vec<u8> {
    if let Ok(mut file) = File::open("/dev/urandom") {
        let mut out = vec![0u8; count];
        if file.read_exact(&mut out).is_ok() {
            return out;
        }
    }

    use std::hash::{BuildHasher, Hasher};
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);

    let mut out = Vec::with_capacity(count + 32);
    while out.len() < count {
        /* засев берётся у ОС, счётчик и время делают каждый запрос уникальным */
        let state = std::collections::hash_map::RandomState::new();
        let mut hasher = state.build_hasher();
        let step = COUNTER.fetch_add(1, Ordering::Relaxed);
        hasher.write_u64(step);
        hasher.write_u64(nanos);
        hasher.write_u64(std::process::id() as u64);
        let first = hasher.finish();
        out.extend_from_slice(&first.to_le_bytes());

        let mut mix = first ^ step.wrapping_mul(0x9e37_79b9_7f4a_7c15);
        for _ in 0..3 {
            mix ^= mix << 13;
            mix ^= mix >> 7;
            mix ^= mix << 17;
            out.extend_from_slice(&mix.to_le_bytes());
        }
    }
    out.truncate(count);
    out
}

/// Новый ключ и nonce для одной передачи.
pub fn new_key() -> ([u8; 32], [u8; 12]) {
    let bytes = random_bytes(44);
    let mut key = [0u8; 32];
    let mut nonce = [0u8; 12];
    key.copy_from_slice(&bytes[..32]);
    nonce.copy_from_slice(&bytes[32..44]);
    (key, nonce)
}

/// Сравнение MAC без раннего выхода: время сравнения не зависит от данных.
fn mac_matches(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in left.iter().zip(right.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

/// Шифрует файл целиком: `MAGIC | nonce | mac | тело`. Тело читается
/// блоками, так что память не зависит от размера сервера.
pub fn seal(
    src: &Path,
    dest: &Path,
    key: &[u8; 32],
    nonce: &[u8; 12],
    progress: &mut impl FnMut(u64, u64),
) -> Result<u64, String> {
    let total = std::fs::metadata(src).map_err(|e| format!("не прочитать архив: {}", e))?.len();
    let mut input = File::open(src).map_err(|e| format!("не открыть архив: {}", e))?;
    let mut output = File::create(dest).map_err(|e| format!("не создать файл: {}", e))?;

    output.write_all(MAGIC).map_err(|e| e.to_string())?;
    output.write_all(nonce).map_err(|e| e.to_string())?;

    /* MAC считаем по мере чтения, поэтому тело пишется сразу после заголовка
       с запасом под 32 байта, а потом перезаписывается на своё место */
    let mac_at = MAGIC.len() + nonce.len();
    output.write_all(&[0u8; 32]).map_err(|e| e.to_string())?;

    /* тело целиком уходит в SHA-256 как «ключ + данные»: так MAC нельзя
       подделать, не зная ключа. Считаем потоком — память не растёт */
    let mut hasher = crate::sha256::Hasher::new();
    hasher.update(key);
    let mut buffer = vec![0u8; 256 * 1024];
    let mut done = 0u64;
    let mut counter = 0u32;
    loop {
        let read = input.read(&mut buffer).map_err(|e| format!("не прочитать архив: {}", e))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        let mut chunk = buffer[..read].to_vec();
        let mut block_nonce = *nonce;
        /* каждый блок шифруется своим счётчиком: nonce + номер блока */
        let block = counter.to_le_bytes();
        for (i, byte) in block.iter().enumerate() {
            block_nonce[8 + i] ^= *byte;
        }
        chacha20(key, &block_nonce, &mut chunk);
        output.write_all(&chunk).map_err(|e| format!("не записать файл: {}", e))?;
        done += read as u64;
        counter += 1;
        progress(done, total);
    }

    let mac = hasher.finish();
    output.seek(SeekFrom::Start(mac_at as u64)).map_err(|e| e.to_string())?;
    output.write_all(&mac).map_err(|e| e.to_string())?;
    output.flush().map_err(|e| e.to_string())?;
    let size = output
        .seek(SeekFrom::End(0))
        .map_err(|e| format!("не дочитать файл: {}", e))?;
    Ok(size)
}

/// Расшифровывает файл, проверяя MAC. Возвращает длину тела.
pub fn unseal(src: &Path, dest: &Path, key: &[u8; 32], nonce: &[u8; 12]) -> Result<u64, String> {
    let mut input = File::open(src).map_err(|e| format!("не открыть файл: {}", e))?;
    let mut head = [0u8; 48];
    input
        .read_exact(&mut head)
        .map_err(|_| "файл короче заголовка — это не наш архив".to_string())?;
    if &head[..4] != MAGIC {
        return Err("файл не похож на передачу OmniPanel".to_string());
    }
    if &head[4..16] != nonce {
        return Err("шифр не совпадает с токеном".to_string());
    }
    let mac = &head[16..48];

    let mut body = Vec::new();
    input.read_to_end(&mut body).map_err(|e| format!("не прочитать: {}", e))?;

    /* сначала сумма, потом расшифровка: испорченный файл не должен доходить
       до распаковки */
    /* сначала расшифровка — MAC считается по открытым данным, как и при
       запечатывании */
    let mut plain = body;
    for (index, block) in plain.chunks_mut(256 * 1024).enumerate() {
        let mut block_nonce = *nonce;
        let counter = (index as u32).to_le_bytes();
        for (i, byte) in counter.iter().enumerate() {
            block_nonce[8 + i] ^= *byte;
        }
        chacha20(key, &block_nonce, block);
    }

    let mut hasher = crate::sha256::Hasher::new();
    hasher.update(key);
    hasher.update(&plain);
    if !mac_matches(&hasher.finish(), mac) {
        return Err("контрольная сумма не сошлась — файл повреждён или это другой архив".to_string());
    }

    let length = plain.len() as u64;
    let mut out = File::create(dest).map_err(|e| format!("не создать файл: {}", e))?;
    out.write_all(&plain).map_err(|e| format!("не записать: {}", e))?;
    out.flush().map_err(|e| e.to_string())?;
    Ok(length)
}

/* ─────────────────────────── токен ─────────────────────────── */

/// Одна строка, которой передаётся сервер.
///
/// `OMNISHARE1:<адрес>:<ключ>:<sha256>:<размер>`
#[derive(Debug, Clone)]
pub struct Token {
    pub url: String,
    /// 44 байта ключа и nonce в base32.
    pub key: String,
    /// SHA-256 шифротекста: получатель проверяет, что скачал своё.
    pub sum: String,
    pub size: u64,
}

impl Token {
    pub fn to_line(&self) -> String {
        format!(
            "{}:{}:{}:{}:{}",
            TOKEN_PREFIX, self.url, self.key, self.sum, self.size
        )
    }

    /// Разбор строки: прощает пробелы и переносы — токен передают как удобно.
    pub fn parse(line: &str) -> Result<Token, String> {
        let clean: String = line.chars().filter(|c| !c.is_whitespace()).collect();
        let rest = clean
            .strip_prefix(TOKEN_PREFIX)
            .ok_or_else(|| "токен должен начинаться с OMNISHARE1".to_string())?;
        let rest = rest.strip_prefix(':').unwrap_or(rest);
        /* адрес содержит двоеточия (https://), поэтому делим с конца */
        let mut parts = rest.rsplitn(4, ':').collect::<Vec<_>>();
        parts.reverse();
        if parts.len() != 4 {
            return Err("токен обрезан — попросите прислать его целиком".to_string());
        }
        let url = parts[0].to_string();
        let key = parts[1].to_string();
        let sum = parts[2].to_string();
        let size = parts[3].parse::<u64>().unwrap_or(0);
        if url.is_empty() || key.is_empty() {
            return Err("в токене нет адреса или ключа".to_string());
        }
        Ok(Token { url, key, sum, size })
    }

    /// Ключ и nonce из base32.
    pub fn key_bytes(&self) -> Result<([u8; 32], [u8; 12]), String> {
        let bytes = base32_decode(&self.key)?;
        if bytes.len() < 44 {
            return Err("ключ в токене короче, чем нужно".to_string());
        }
        let mut key = [0u8; 32];
        let mut nonce = [0u8; 12];
        key.copy_from_slice(&bytes[..32]);
        nonce.copy_from_slice(&bytes[32..44]);
        Ok((key, nonce))
    }
}

fn base32_decode(text: &str) -> Result<Vec<u8>, String> {
    let mut bits = 0u32;
    let mut collected = 0u32;
    let mut out = Vec::with_capacity(text.len() * 5 / 8 + 1);
    for ch in text.chars() {
        let value = match ALPHABET.iter().position(|&b| b as char == ch) {
            Some(pos) => pos as u32,
            None => return Err(format!("символ «{}» не бывает в токене", ch)),
        };
        bits = (bits << 5) | value;
        collected += 5;
        if collected >= 8 {
            collected -= 8;
            out.push(((bits >> collected) & 0xff) as u8);
        }
    }
    Ok(out)
}

/// Ключ и nonce одной строкой для токена.
pub fn encode_key(key: &[u8; 32], nonce: &[u8; 12]) -> String {
    let mut bytes = Vec::with_capacity(44);
    bytes.extend_from_slice(key);
    bytes.extend_from_slice(nonce);
    base32_encode(&bytes)
}

fn base32_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 8 / 5 + 1);
    let mut bits = 0u32;
    let mut collected = 0u32;
    for byte in bytes {
        bits = (bits << 8) | *byte as u32;
        collected += 8;
        while collected >= 5 {
            collected -= 5;
            out.push(ALPHABET[((bits >> collected) & 0x1f) as usize] as char);
        }
    }
    if collected > 0 {
        out.push(ALPHABET[((bits << (5 - collected)) & 0x1f) as usize] as char);
    }
    out
}

/* ─────────────────────────── файлообменники ─────────────────────────── */

/// Куда класть архив. Выбирается по размеру архива.
pub struct Host {
    pub name: &'static str,
    /// Сколько байт хостинг принимает за один раз.
    pub limit: u64,
}

const TEMP_SH: Host = Host { name: "temp.sh", limit: 2 * 1024 * 1024 * 1024 };
const X0_AT: Host = Host { name: "x0.at", limit: 1024 * 1024 * 1024 };

/// Подбирает хостинг под размер: `temp.sh` берёт больше, `x0.at` — запасной.
pub fn pick_host(size: u64) -> Result<Host, String> {
    for host in [TEMP_SH, X0_AT] {
        if size <= host.limit {
            return Ok(host);
        }
    }
    Err(format!(
        "архив {} — больше, чем принимает анонимный файлообменник. Исключите миры: «только настройки, без миров»",
        human_size(size)
    ))
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(3600)))
        .build()
        .new_agent()
}

/// Выкладывает файл на файлообменник и возвращает ссылку.
pub fn upload(host: &Host, archive: &Path, size: u64, progress: &mut impl FnMut(u64, u64)) -> Result<String, String> {
    let name = archive
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "server.oms".to_string());
    let file = File::open(archive).map_err(|e| format!("не открыть архив: {}", e))?;
    let boundary = format!("----omnipanel{:x}", now());
    let head = format!(
        "--{b}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{n}\"\r\nContent-Type: application/octet-stream\r\n\r\n",
        b = boundary,
        n = name
    );
    let tail = format!("\r\n--{}--\r\n", boundary);

    /* тело собирается из трёх частей, поэтому отправляем потоком, а не целиком
       в памяти; прогресс показываем по прочитанным байтам */
    struct Body {
        head: Vec<u8>,
        file: File,
        tail: Vec<u8>,
        left: u64,
        sent: u64,
    }
    impl Read for Body {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            if !self.head.is_empty() {
                let take = out.len().min(self.head.len());
                out[..take].copy_from_slice(&self.head[..take]);
                self.head.drain(..take);
                return Ok(take);
            }
            if self.left > 0 {
                let want = out.len().min(self.left as usize);
                let read = self.file.read(&mut out[..want])?;
                if read == 0 {
                    return Ok(0);
                }
                self.left -= read as u64;
                self.sent += read as u64;
                return Ok(read);
            }
            if !self.tail.is_empty() {
                let take = out.len().min(self.tail.len());
                out[..take].copy_from_slice(&self.tail[..take]);
                self.tail.drain(..take);
                return Ok(take);
            }
            Ok(0)
        }
    }

    let mut body = Body {
        head: head.into_bytes(),
        file,
        tail: tail.into_bytes(),
        left: size,
        sent: 0,
    };
    let url = match host.name {
        "x0.at" => "https://x0.at/",
        _ => "https://temp.sh/upload",
    };
    let response = agent()
        .post(url)
        .header("Content-Type", &format!("multipart/form-data; boundary={}", boundary))
        .send(ureq::SendBody::from_reader(&mut body))
        .map_err(|e| format!("файлообменник {} не ответил: {}", host.name, e))?;
    progress(size, size);
    let text = response
        .into_body()
        .read_to_string()
        .map_err(|e| format!("не прочитать ответ файлообменника: {}", e))?;
    let link = text.trim();
    if !link.starts_with("http") {
        return Err(format!("файлообменник ответил непонятно: {}", short_text(link)));
    }
    Ok(link.to_string())
}

/// Скачивает файл по ссылке.
///
/// `temp.sh` отдаёт файл **POST-ом** на выданный адрес: по обычному GET
/// приходит HTML-страница. Поэтому сначала пробуем POST, а признак успеха —
/// наша сигнатура в начале файла.
pub fn fetch(url: &str, dest: &Path, progress: &mut impl FnMut(u64, Option<u64>)) -> Result<u64, String> {
    if let Ok(size) = try_download(url, dest, true, progress) {
        return Ok(size);
    }
    /* второй заход: GET — на случай, если хостинг отдаёт файл обычным путём */
    match try_download(url, dest, false, progress) {
        Ok(size) => Ok(size),
        Err(err) => Err(format!(
            "не удалось скачать архив: {}. Возможно, ссылка устарела — попросите новый токен",
            err
        )),
    }
}

fn try_download(
    url: &str,
    dest: &Path,
    post: bool,
    progress: &mut impl FnMut(u64, Option<u64>),
) -> Result<u64, String> {
    let agent = agent();
    let response = if post {
        agent.post(url).send_empty()
    } else {
        agent.get(url).call()
    }
    .map_err(|e| e.to_string())?;
    let total = response
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    let mut reader = response.into_body().into_reader();
    let mut file = File::create(dest).map_err(|e| format!("не создать файл: {}", e))?;
    let mut first = [0u8; 4];
    let mut got_header = false;
    let mut buffer = vec![0u8; 128 * 1024];
    let mut done = 0u64;
    loop {
        let read = reader.read(&mut buffer).map_err(|e| format!("не прочитать: {}", e))?;
        if read == 0 {
            break;
        }
        if !got_header {
            let take = read.min(4);
            first[..take].copy_from_slice(&buffer[..take]);
            if take == 4 {
                got_header = true;
                if &first != MAGIC {
                    /* это не наш файл: скорее всего HTML-страница хостинга */
                    let _ = std::fs::remove_file(dest);
                    return Err("ответ не является архивом передачи".to_string());
                }
            }
        }
        file.write_all(&buffer[..read]).map_err(|e| format!("не записать: {}", e))?;
        done += read as u64;
        progress(done, total);
    }
    file.flush().map_err(|e| e.to_string())?;
    if !got_header {
        let _ = std::fs::remove_file(dest);
        return Err("скачался слишком короткий ответ".to_string());
    }
    Ok(done)
}

/// Пытается стереть файл с файлообменника.
///
/// `temp.sh` на DELETE отвечает 405, так что полагаться на это нельзя:
/// настоящая блокировка живёт в записи токена ([`revoke`]).
pub fn remove_remote(url: &str) -> Result<(), String> {
    match agent().delete(url).call() {
        Ok(_) => Ok(()),
        Err(err) => Err(format!("файлообменник не удалил файл: {}", err)),
    }
}

/* ─────────────────────────── сбор файлов ─────────────────────────── */

/// Файл, который войдёт в архив.
pub struct Entry {
    /// Путь внутри архива: всегда через `/`.
    pub name: String,
    pub path: PathBuf,
}

const SKIP_DIRS: [&str; 6] = [".git", "cache", "logs", "crash-reports", "backups", "backup"];
const SKIP_FILES: [&str; 6] = [
    "session.lock",
    ".DS_Store",
    "Thumbs.db",
    "hs_err_pid.log",
    "eula.txt.bak",
    "usercache.json.lock",
];

/// Собирает список файлов сервера.
///
/// `lean` — без миров (только конфиги и плагины); `keep_logs` — оставить логи.
pub fn collect(server_dir: &Path, lean: bool, keep_logs: bool) -> Result<Vec<Entry>, String> {
    if !server_dir.is_dir() {
        return Err(format!("Папка сервера не найдена: {}", server_dir.display()));
    }
    let mut out = Vec::new();
    walk(server_dir, server_dir, lean, keep_logs, &mut out, 0)?;
    if out.is_empty() {
        return Err("в папке сервера нет файлов для передачи".to_string());
    }
    Ok(out)
}

fn walk(
    root: &Path,
    dir: &Path,
    lean: bool,
    keep_logs: bool,
    out: &mut Vec<Entry>,
    depth: usize,
) -> Result<(), String> {
    if depth > 24 {
        return Ok(());
    }
    let list = std::fs::read_dir(dir).map_err(|e| format!("не прочитать {}: {}", dir.display(), e))?;
    for item in list.flatten() {
        let path = item.path();
        let name = item.file_name().to_string_lossy().to_string();
        let rel = path
            .strip_prefix(root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| name.clone());
        if path.is_dir() {
            let lower = name.to_lowercase();
            if SKIP_DIRS.contains(&lower.as_str()) {
                continue;
            }
            /* миры — это папки с level.dat; при «только настройки» их пропускаем,
               но сама папка сервера миром не считается */
            if lean && path != root && path.join("level.dat").exists() {
                continue;
            }
            if !keep_logs && lower == "logs" {
                continue;
            }
            walk(root, &path, lean, keep_logs, out, depth + 1)?;
            continue;
        }
        if SKIP_FILES.contains(&name.as_str()) {
            continue;
        }
        if !keep_logs && (name.ends_with(".log") || name.contains(".log.")) {
            continue;
        }
        out.push(Entry { name: rel, path });
    }
    Ok(())
}

/* ─────────────────────────── архив ─────────────────────────── */

fn put16(vec: &mut Vec<u8>, value: u16) {
    vec.extend_from_slice(&value.to_le_bytes());
}

fn put32(vec: &mut Vec<u8>, value: u32) {
    vec.extend_from_slice(&value.to_le_bytes());
}

/// CLA-хранилище без сжатия: файлы пишутся как есть.
///
/// Собственный писатель нужен, чтобы не тянуть в панель ещё одну библиотеку
/// и чтобы читать архив можно было нашим же `zip`. Формат строгий: заголовки
/// ровно 30, 46 и 22 байта — иначе оглавление уезжает.
pub fn pack(
    entries: &[Entry],
    dest: &Path,
    key: &[u8; 32],
    nonce: &[u8; 12],
    progress: &mut impl FnMut(usize, usize),
) -> Result<u64, String> {
    let plain = dest.with_extension("zip");
    {
        let mut out = File::create(&plain).map_err(|e| format!("не создать архив: {}", e))?;
        let mut central: Vec<u8> = Vec::new();
        let mut local_offset: u32 = 0;
        for (index, entry) in entries.iter().enumerate() {
            let data = std::fs::read(&entry.path)
                .map_err(|e| format!("не прочитать {}: {}", entry.name, e))?;
            let crc = crate::zip::crc32(&data);
            let name = entry.name.as_bytes();
            let size = data.len() as u32;

            /* локальный заголовок — ровно 30 байт */
            let mut local = Vec::with_capacity(30 + name.len() + data.len());
            put32(&mut local, 0x0403_4b50);
            put16(&mut local, 20);
            put16(&mut local, 0x0800);
            put16(&mut local, 0);
            put16(&mut local, 0);
            put16(&mut local, 0);
            put32(&mut local, crc);
            put32(&mut local, size);
            put32(&mut local, size);
            put16(&mut local, name.len() as u16);
            put16(&mut local, 0);
            local.extend_from_slice(name);
            local.extend_from_slice(&data);
            out.write_all(&local).map_err(|e| format!("не записать архив: {}", e))?;

            /* запись оглавления — ровно 46 байт */
            put32(&mut central, 0x0201_4b50);
            put16(&mut central, 20);
            put16(&mut central, 20);
            put16(&mut central, 0x0800);
            put16(&mut central, 0);
            put16(&mut central, 0);
            put16(&mut central, 0);
            put32(&mut central, crc);
            put32(&mut central, size);
            put32(&mut central, size);
            put16(&mut central, name.len() as u16);
            put16(&mut central, 0);
            put16(&mut central, 0);
            put16(&mut central, 0);
            put16(&mut central, 0);
            put32(&mut central, 0);
            put32(&mut central, local_offset);
            central.extend_from_slice(name);

            /* смещение следующего заголовка — фактическое, а не «на глаз» */
            local_offset += 30 + name.len() as u32 + size;
            progress(index + 1, entries.len());
        }

        out.write_all(&central).map_err(|e| format!("не записать оглавление: {}", e))?;
        /* EOCD — ровно 22 байта; размер оглавления берём из фактической длины */
        let mut eocd = Vec::with_capacity(22);
        put32(&mut eocd, 0x0605_4b50);
        put16(&mut eocd, 0);
        put16(&mut eocd, 0);
        put16(&mut eocd, entries.len() as u16);
        put16(&mut eocd, entries.len() as u16);
        put32(&mut eocd, central.len() as u32);
        put32(&mut eocd, local_offset);
        put16(&mut eocd, 0);
        out.write_all(&eocd).map_err(|e| format!("не записать конец архива: {}", e))?;
        out.flush().map_err(|e| e.to_string())?;
    }
    let size = seal(&plain, dest, key, nonce, &mut |_, _| {})?;
    let _ = std::fs::remove_file(&plain);
    Ok(size)
}

/// Сколько байт занимает архив: ищет EOCD с конца, а не «по объявленному».
pub fn archive_len(data: &[u8]) -> Option<usize> {
    if data.len() < 22 {
        return None;
    }
    let mut at = data.len() - 22;
    loop {
        if data[at..at + 4] == [0x50, 0x4b, 0x05, 0x06] {
            return Some(at + 22);
        }
        if at == 0 {
            return None;
        }
        at -= 1;
    }
}

/// Распаковывает архив в папку. Возвращает число файлов.
pub fn unpack(
    archive: &Path,
    key: &[u8; 32],
    nonce: &[u8; 12],
    dest: &Path,
    progress: &mut impl FnMut(u64, u64),
) -> Result<usize, String> {
    let plain = archive.with_extension("zip");
    let total = unseal(archive, &plain, key, nonce)?;
    let data = std::fs::read(&plain).map_err(|e| format!("не прочитать архив: {}", e))?;
    let size = archive_len(&data).unwrap_or(data.len());
    let slice = &data[..size];
    let entries = crate::zip::list(slice)?;
    std::fs::create_dir_all(dest).map_err(|e| format!("не создать папку: {}", e))?;
    let count = entries.len();
    for (index, entry) in entries.iter().enumerate() {
        let out_path = safe_join(dest, &entry.name)?;
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("не создать папку: {}", e))?;
        }
        let bytes = crate::zip::read_entry(slice, entry)?;
        std::fs::write(&out_path, &bytes).map_err(|e| format!("не записать {}: {}", entry.name, e))?;
        progress((index + 1) as u64, count as u64);
    }
    let _ = std::fs::remove_file(&plain);
    let _ = total;
    Ok(count)
}

/// Путь из архива не должен выйти за пределы папки получателя.
fn safe_join(dest: &Path, name: &str) -> Result<PathBuf, String> {
    let clean = name.replace('\\', "/");
    if clean.starts_with('/') || clean.contains(':') || clean.split('/').any(|p| p == "..") {
        return Err(format!("подозрительный путь в архиве: {}", name));
    }
    let mut out = dest.to_path_buf();
    for part in clean.split('/').filter(|p| !p.is_empty()) {
        out.push(part);
    }
    Ok(out)
}

/* ─────────────────────────── записи о токенах ─────────────────────────── */

/// Что панель помнит о выданном токене.
#[derive(Debug, Clone)]
pub struct ShareRecord {
    pub token: String,
    pub server: String,
    pub created: u64,
    pub expires: u64,
    pub size: u64,
    pub used: bool,
    /// Токен отозван вручную. Такой токен не принимается даже со ссылкой
    /// на архив: файлообменник (temp.sh) удалять файлы не умеет.
    pub revoked: bool,
}

/// Куда складывать записи о выданных токенах.
pub fn records_path(data_dir: &Path) -> PathBuf {
    data_dir.join("share").join("tokens.json")
}

/// Строка токена укорочена для показа в списке — целиком её видно в окне.
fn short(token: &str) -> String {
    let clean: String = token.chars().filter(|c| !c.is_whitespace()).collect();
    if clean.chars().count() <= 34 {
        return clean;
    }
    let head: String = clean.chars().take(26).collect();
    let tail: String = clean.chars().rev().take(4).collect::<String>().chars().rev().collect();
    format!("{}…{}", head, tail)
}

/// Сколько сейчас секунд от начала эпохи.
pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Размер по-человечески: «244,2 КБ».
pub fn human_size(bytes: u64) -> String {
    let kb = bytes as f64 / 1024.0;
    let mb = kb / 1024.0;
    if mb >= 1.0 {
        format!("{:.1} МБ", mb).replace('.', ",")
    } else if kb >= 1.0 {
        format!("{:.1} КБ", kb).replace('.', ",")
    } else {
        format!("{} Б", bytes)
    }
}

fn short_text(text: &str) -> String {
    let clean: String = text.chars().take(80).collect();
    clean.replace('\n', " ")
}

impl ShareRecord {
    pub fn to_json(&self) -> Value {
        Value::obj(vec![
            ("token", Value::str(&self.token)),
            ("server", Value::str(&self.server)),
            ("created", Value::from(self.created)),
            ("expires", Value::from(self.expires)),
            ("size", Value::from(self.size)),
            ("used", Value::Bool(self.used)),
            ("revoked", Value::Bool(self.revoked)),
        ])
    }

    /// Разбор записи из файла. Испорченная строка пропускается, а не ломает
    /// весь список.
    pub fn from_json(value: &Value) -> Option<ShareRecord> {
        let text = |name: &str| value.get(name).map(|v| v.text()).unwrap_or_default();
        let number = |name: &str| value.get(name).and_then(|v| v.as_f64()).unwrap_or(0.0) as u64;
        let token = text("token");
        if token.is_empty() {
            return None;
        }
        Some(ShareRecord {
            token,
            server: text("server"),
            created: number("created"),
            expires: number("expires"),
            size: number("size"),
            used: value.get("used").map(|v| v.as_bool()).unwrap_or(false),
            revoked: value.get("revoked").map(|v| v.as_bool()).unwrap_or(false),
        })
    }
}

/// Запись для списка в интерфейсе.
pub fn record_json(record: &ShareRecord, now: u64) -> Value {
    Value::obj(vec![
        ("token", Value::str(&record.token)),
        ("short", Value::str(short(&record.token))),
        ("server", Value::str(&record.server)),
        ("created", Value::from(record.created)),
        ("expires", Value::from(record.expires)),
        ("size", Value::from(record.size)),
        ("sizeText", Value::str(human_size(record.size))),
        ("used", Value::Bool(record.used)),
        ("revoked", Value::Bool(record.revoked)),
        ("expired", Value::Bool(now > record.expires)),
        ("leftHours", Value::from(record.expires.saturating_sub(now) / 3600)),
    ])
}

/// Читает записи о токенах.
pub fn load_records(data_dir: &Path) -> Vec<ShareRecord> {
    let path = records_path(data_dir);
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let parsed = crate::json::parse(&text).unwrap_or(Value::Arr(Vec::new()));
    parsed
        .as_arr()
        .iter()
        .filter_map(ShareRecord::from_json)
        .collect()
}

/// Сохраняет выданные токены.
pub fn save_records(data_dir: &Path, records: &[ShareRecord]) -> Result<(), String> {
    let path = records_path(data_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("не создать папку данных: {}", e))?;
    }
    let list = Value::Arr(records.iter().map(|record| record.to_json()).collect());
    std::fs::write(&path, list.to_json()).map_err(|e| format!("не сохранить список токенов: {}", e))
}

/// Чистит совсем старые записи и возвращает оставшиеся.
pub fn tidy_records(data_dir: &Path) -> Vec<ShareRecord> {
    let current = now();
    /* Держим неделю после истечения срока — это в семь раз дольше жизни
       самого токена. Без записей панель не отличит повтор по старому токену
       от первого скачивания. */
    let records: Vec<ShareRecord> = load_records(data_dir)
        .into_iter()
        .filter(|record| record.expires.saturating_add(KEEP_AFTER_EXPIRY) > current)
        .collect();
    let _ = save_records(data_dir, &records);
    records
}

/// Отмечает токен использованным (после успешного скачивания у получателя).
pub fn mark_used(data_dir: &Path, token: &str) -> bool {
    let mut records = load_records(data_dir);
    let mut found = false;
    for record in records.iter_mut() {
        if record.token == token {
            record.used = true;
            found = true;
        }
    }
    if found {
        let _ = save_records(data_dir, &records);
    }
    found
}

/// Находит запись о выданном токене.
pub fn find_record(data_dir: &Path, token: &str) -> Option<ShareRecord> {
    load_records(data_dir).into_iter().find(|record| record.token == token)
}

/// Отзывает токен по просьбе человека.
///
/// Сначала пробуем стереть архив с файлообменника, но полагаться на это
/// нельзя: `temp.sh` на DELETE отвечает 405. Поэтому запись остаётся
/// в списке с пометкой «отозван», и токен больше не принимается.
pub fn revoke(data_dir: &Path, token: &str) -> bool {
    if let Ok(parsed) = Token::parse(token) {
        let _ = remove_remote(&parsed.url);
    }
    let mut records = load_records(data_dir);
    let mut found = false;
    for record in records.iter_mut() {
        if record.token == token {
            record.revoked = true;
            found = true;
        }
    }
    if found {
        let _ = save_records(data_dir, &records);
    }
    found
}

/// Список для интерфейса: что выдано, сколько живёт, скачали или нет.
pub fn list_json(data_dir: &Path) -> Value {
    let current = now();
    let records = tidy_records(data_dir);
    Value::Arr(records.iter().map(|record| record_json(record, current)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("omnipanel-share-{}-{}", std::process::id(), tag));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn шифрование_туда_и_обратно() {
        let dir = temp("cipher");
        let src = dir.join("данные.bin");
        let payload: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&src, &payload).unwrap();

        let (key, nonce) = new_key();
        let sealed = dir.join("шифр.oms");
        let size = seal(&src, &sealed, &key, &nonce, &mut |_, _| {}).unwrap();
        assert!(size > payload.len() as u64, "в файле должен быть заголовок");

        /* наружу уходит шифротекст, а не открытые данные */
        let raw = std::fs::read(&sealed).unwrap();
        assert_eq!(&raw[..4], MAGIC);
        assert!(!raw.windows(64).any(|w| w == &payload[..64]), "тело не зашифровано");

        let out = dir.join("обратно.bin");
        unseal(&sealed, &out, &key, &nonce).unwrap();
        assert_eq!(std::fs::read(&out).unwrap(), payload);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn два_ключа_подряд_разные() {
        /* на Windows /dev/urandom нет: ключи не имеют права совпасть */
        let (first_key, first_nonce) = new_key();
        let (second_key, second_nonce) = new_key();
        assert_ne!(first_key, second_key, "ключи совпали — токен станет предсказуемым");
        assert_ne!(first_nonce, second_nonce, "nonce совпал");
    }

    #[test]
    fn чужой_ключ_не_подходит() {
        let dir = temp("wrong-key");
        let src = dir.join("a.bin");
        std::fs::write(&src, "секрет".as_bytes()).unwrap();
        let (key, nonce) = new_key();
        let sealed = dir.join("a.oms");
        seal(&src, &sealed, &key, &nonce, &mut |_, _| {}).unwrap();

        let (other, _) = new_key();
        let out = dir.join("b.bin");
        assert!(unseal(&sealed, &out, &other, &nonce).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn испорченный_файл_не_проходит_проверку() {
        let dir = temp("broken");
        let src = dir.join("a.bin");
        std::fs::write(&src, vec![7u8; 5000]).unwrap();
        let (key, nonce) = new_key();
        let sealed = dir.join("a.oms");
        seal(&src, &sealed, &key, &nonce, &mut |_, _| {}).unwrap();

        let mut raw = std::fs::read(&sealed).unwrap();
        let at = raw.len() - 100;
        raw[at] ^= 0xff;
        std::fs::write(&sealed, &raw).unwrap();
        let out = dir.join("b.bin");
        let err = unseal(&sealed, &out, &key, &nonce).unwrap_err();
        assert!(err.contains("контрольная сумма"), "{}", err);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn токен_собирается_и_разбирается() {
        let token = Token {
            url: "https://temp.sh/abc/-1.oms".to_string(),
            key: base32_encode(&random_bytes(44)),
            sum: "ab".repeat(32),
            size: 12345,
        };
        let line = token.to_line();
        assert!(line.starts_with("OMNISHARE1:"));
        let back = Token::parse(&line).unwrap();
        assert_eq!(back.url, token.url);
        assert_eq!(back.key, token.key);
        assert_eq!(back.size, token.size);
        let (key, nonce) = back.key_bytes().unwrap();
        assert_eq!(key.len(), 32);
        assert_eq!(nonce.len(), 12);
    }

    #[test]
    fn токен_переживает_переносы_строк() {
        let token = Token {
            url: "https://temp.sh/xyz/-2.oms".to_string(),
            key: base32_encode(&random_bytes(44)),
            sum: "cd".repeat(32),
            size: 7,
        };
        let line = token.to_line();
        let wrapped = format!("{}\n  {}\n", &line[..30], &line[30..]);
        assert_eq!(Token::parse(&wrapped).unwrap().url, token.url);
    }

    #[test]
    fn обрезанный_токен_понятно_ругается() {
        let err = Token::parse("OMNISHARE1:https://temp.sh/abc").unwrap_err();
        assert!(err.contains("обрезан"), "{}", err);
        let err = Token::parse("чепуха").unwrap_err();
        assert!(err.contains("OMNISHARE1"), "{}", err);
    }

    #[test]
    fn размер_по_человечески() {
        assert_eq!(human_size(512), "512 Б");
        assert!(human_size(1536).contains("КБ"));
    }

    #[test]
    fn сбор_файлов_пропускает_лишнее() {
        let dir = temp("collect");
        std::fs::write(dir.join("server.properties"), "motd=тест").unwrap();
        std::fs::create_dir_all(dir.join("world")).unwrap();
        std::fs::write(dir.join("world/level.dat"), "мир").unwrap();
        std::fs::create_dir_all(dir.join("logs")).unwrap();
        std::fs::write(dir.join("logs/latest.log"), "лог").unwrap();
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::write(dir.join(".git/config"), "[core]").unwrap();

        let full = collect(&dir, false, false).unwrap();
        let names: Vec<&str> = full.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"server.properties"));
        assert!(names.contains(&"world/level.dat"));
        assert!(!names.iter().any(|n| n.starts_with(".git")), "git попал в архив: {:?}", names);
        assert!(!names.iter().any(|n| n.contains("latest.log")), "логи попали: {:?}", names);

        /* «только настройки» — миры не берём */
        let lean = collect(&dir, true, false).unwrap();
        assert!(!lean.iter().any(|e| e.name.starts_with("world")), "мир попал в лёгкий архив");
        assert!(lean.iter().any(|e| e.name == "server.properties"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn лёгкий_архив_берёт_мир_если_папка_сама_мир() {
        /* сервер может лежать прямо в папке мира: level.dat рядом с конфигами.
           «Только настройки» не должно оставить пустой архив */
        let dir = temp("collect-flat");
        std::fs::write(dir.join("server.properties"), "motd=плоский").unwrap();
        std::fs::write(dir.join("level.dat"), "мир").unwrap();
        std::fs::create_dir_all(dir.join("region")).unwrap();
        std::fs::write(dir.join("region/r.0.0.mca"), "чанки").unwrap();

        let lean = collect(&dir, true, false).unwrap();
        let names: Vec<&str> = lean.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"server.properties"), "конфиг потерялся: {:?}", names);
        assert!(names.contains(&"level.dat"), "мир потерялся: {:?}", names);
        assert!(names.contains(&"region/r.0.0.mca"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn архив_шифруется_и_распаковывается() {
        let dir = temp("pack");
        let src = dir.join("сервер");
        std::fs::create_dir_all(src.join("world/region")).unwrap();
        std::fs::write(src.join("server.properties"), "motd=привет").unwrap();
        std::fs::write(src.join("world/region/r.0.0.mca"), vec![1u8, 2, 3, 4, 5]).unwrap();
        std::fs::write(src.join("plugins.jar"), vec![9u8; 1000]).unwrap();

        let entries = collect(&src, false, false).unwrap();
        let (key, nonce) = new_key();
        let archive = dir.join("отправка.oms");
        let size = pack(&entries, &archive, &key, &nonce, &mut |_, _| {}).unwrap();
        assert!(size > 0);

        let out = dir.join("принято");
        let count = unpack(&archive, &key, &nonce, &out, &mut |_, _| {}).unwrap();
        assert_eq!(count, 3);
        assert_eq!(
            std::fs::read_to_string(out.join("server.properties")).unwrap(),
            "motd=привет"
        );
        assert_eq!(std::fs::read(out.join("plugins.jar")).unwrap(), vec![9u8; 1000]);
        assert_eq!(std::fs::read(out.join("world/region/r.0.0.mca")).unwrap(), vec![1u8, 2, 3, 4, 5]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn кириллица_в_именах_сохраняется() {
        let dir = temp("cyrillic");
        let src = dir.join("сервер");
        std::fs::create_dir_all(src.join("плагины")).unwrap();
        std::fs::write(src.join("плагины/Мой Плагин.jar"), b"jar").unwrap();
        std::fs::write(src.join("мир.txt"), "привет").unwrap();

        let entries = collect(&src, false, false).unwrap();
        let (key, nonce) = new_key();
        let archive = dir.join("a.oms");
        pack(&entries, &archive, &key, &nonce, &mut |_, _| {}).unwrap();
        let out = dir.join("вышло");
        unpack(&archive, &key, &nonce, &out, &mut |_, _| {}).unwrap();
        assert_eq!(std::fs::read_to_string(out.join("мир.txt")).unwrap(), "привет");
        assert!(out.join("плагины/Мой Плагин.jar").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn путь_из_архива_не_выходит_наружу() {
        let dir = temp("traversal");
        assert!(safe_join(&dir, "../секрет.txt").is_err());
        assert!(safe_join(&dir, "C:/windows/system32").is_err());
        assert!(safe_join(&dir, "мир/файл.txt").is_ok());
    }

    #[test]
    fn файлообменник_выбирается_по_размеру() {
        assert_eq!(pick_host(1000).unwrap().name, "temp.sh");
        /* больше гигабайта и до двух — всё ещё temp.sh */
        assert_eq!(pick_host(1500 * 1024 * 1024).unwrap().name, "temp.sh");
        assert!(pick_host(5 * 1024 * 1024 * 1024).is_err());
    }

    #[test]
    fn запись_живёт_дольше_токена_и_помнит_отзыв() {
        let dir = temp("records");
        let current = now();
        let records = vec![
            ShareRecord {
                token: "OMNISHARE1:старый".to_string(),
                server: "давно истёк".to_string(),
                created: current.saturating_sub(9 * 24 * 60 * 60),
                expires: current.saturating_sub(8 * 24 * 60 * 60),
                size: 10,
                used: false,
                revoked: false,
            },
            ShareRecord {
                token: "OMNISHARE1:недавний".to_string(),
                server: "скачали".to_string(),
                created: current.saturating_sub(60),
                expires: current.saturating_sub(30),
                size: 20,
                used: true,
                revoked: false,
            },
        ];
        save_records(&dir, &records).unwrap();

        let left = tidy_records(&dir);
        assert_eq!(left.len(), 1, "истёкшую неделю назад запись уже убираем");
        assert_eq!(left[0].token, "OMNISHARE1:недавний");
        /* использованный токен остаётся в списке — иначе не отличить повтор */
        assert!(left[0].used);

        assert!(revoke(&dir, "OMNISHARE1:недавний"));
        let after = find_record(&dir, "OMNISHARE1:недавний").unwrap();
        assert!(after.revoked, "отзыв должен остаться в записи");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
