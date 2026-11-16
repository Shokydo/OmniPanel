//! Архивы ZIP и jar: показать содержимое и распаковать.
//!
//! Своими руками, без внешних крейтов: панель должна открывать `paper.jar`,
//! `plugins/*.jar` и обычные zip-архивы, а тянуть ради этого библиотеку и
//! терять скорость сборки не хочется. Внутри — разбор ZIP и распаковка
//! DEFLATE (метод 8), как в прежнем `core/zip.js`, только на Rust.

/// Один файл внутри архива.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZipEntry {
    pub name: String,
    pub size: u64,
    pub packed: u64,
    pub method: u16,
    local_offset: usize,
    crc: u32,
}

/// Разбор битового потока DEFLATE.
struct Bits<'a> {
    data: &'a [u8],
    pos: usize,
    buf: u32,
    count: u32,
}

impl<'a> Bits<'a> {
    fn new(data: &'a [u8]) -> Self {
        Bits { data, pos: 0, buf: 0, count: 0 }
    }

    fn bit(&mut self) -> Result<u32, String> {
        if self.count == 0 {
            if self.pos >= self.data.len() {
                return Err("архив оборвался посреди сжатых данных".to_string());
            }
            self.buf = self.data[self.pos] as u32;
            self.pos += 1;
            self.count = 8;
        }
        let bit = self.buf & 1;
        self.buf >>= 1;
        self.count -= 1;
        Ok(bit)
    }

    fn bits(&mut self, n: u32) -> Result<u32, String> {
        let mut value = 0;
        for i in 0..n {
            value |= self.bit()? << i;
        }
        Ok(value)
    }

    /// Выравнивание на границу байта (для несжатых блоков).
    fn align(&mut self) {
        self.buf = 0;
        self.count = 0;
    }
}

/// Таблица Хаффмана для DEFLATE (канонический код).
struct Huffman {
    counts: [u16; 16],
    symbols: Vec<u16>,
}

impl Huffman {
    fn new(lengths: &[u8]) -> Result<Huffman, String> {
        let mut counts = [0u16; 16];
        for &len in lengths {
            counts[len as usize] += 1;
        }
        counts[0] = 0;
        let mut left: i32 = 1;
        for len in 1..16 {
            left <<= 1;
            left -= counts[len] as i32;
            if left < 0 {
                return Err("повреждённое дерево сжатия в архиве".to_string());
            }
        }
        let mut offsets = [0u16; 16];
        for len in 1..15 {
            offsets[len + 1] = offsets[len] + counts[len];
        }
        let mut symbols = vec![0u16; lengths.len()];
        for (symbol, &len) in lengths.iter().enumerate() {
            if len != 0 {
                symbols[offsets[len as usize] as usize] = symbol as u16;
                offsets[len as usize] += 1;
            }
        }
        Ok(Huffman { counts, symbols })
    }

    fn decode(&self, bits: &mut Bits<'_>) -> Result<u16, String> {
        let mut code = 0i32;
        let mut first = 0i32;
        let mut index = 0i32;
        for len in 1..16 {
            code |= bits.bit()? as i32;
            let count = self.counts[len] as i32;
            if code - first < count {
                return Ok(self.symbols[(index + (code - first)) as usize]);
            }
            index += count;
            first = (first + count) << 1;
            code <<= 1;
        }
        Err("не удалось разобрать код сжатия".to_string())
    }
}

const LENGTH_BASE: [u16; 29] = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
    163, 195, 227, 258,
];
const LENGTH_EXTRA: [u8; 29] = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DIST_BASE: [u16; 30] = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
    2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA: [u8; 30] = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13,
    13,
];

fn fixed_tables() -> Result<(Huffman, Huffman), String> {
    let mut lengths = [0u8; 288];
    for (i, slot) in lengths.iter_mut().enumerate() {
        *slot = if i < 144 {
            8
        } else if i < 256 {
            9
        } else if i < 280 {
            7
        } else {
            8
        };
    }
    let dists = [5u8; 30];
    Ok((Huffman::new(&lengths)?, Huffman::new(&dists)?))
}

/// Распаковка сжатого потока DEFLATE (метод 8 в ZIP).
pub fn inflate_raw(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut bits = Bits::new(data);
    let mut out: Vec<u8> = Vec::with_capacity(data.len() * 3);
    loop {
        let last = bits.bits(1)?;
        let kind = bits.bits(2)?;
        match kind {
            0 => {
                bits.align();
                if bits.pos + 4 > data.len() {
                    return Err("архив оборвался на несжатом блоке".to_string());
                }
                let len = data[bits.pos] as usize | ((data[bits.pos + 1] as usize) << 8);
                let nlen = data[bits.pos + 2] as usize | ((data[bits.pos + 3] as usize) << 8);
                if len != (!nlen & 0xffff) {
                    return Err("повреждён несжатый блок в архиве".to_string());
                }
                bits.pos += 4;
                let end = bits.pos + len;
                if end > data.len() {
                    return Err("архив оборвался на данных".to_string());
                }
                out.extend_from_slice(&data[bits.pos..end]);
                bits.pos = end;
            }
            kind => {
                let (lit, dist) = if kind == 1 {
                    fixed_tables()?
                } else if kind == 2 {
                    dynamic_tables(&mut bits, data)?
                } else {
                    return Err("непонятный способ сжатия в архиве".to_string());
                };
                loop {
                    let symbol = lit.decode(&mut bits)?;
                    match symbol {
                        0..=255 => out.push(symbol as u8),
                        256 => break,
                        _ => {
                            let index = (symbol - 257) as usize;
                            if index >= LENGTH_BASE.len() {
                                return Err("повреждённый код длины в архиве".to_string());
                            }
                            let length = LENGTH_BASE[index] as usize
                                + bits.bits(LENGTH_EXTRA[index] as u32)? as usize;
                            let dist_symbol = dist.decode(&mut bits)? as usize;
                            if dist_symbol >= DIST_BASE.len() {
                                return Err("повреждённый код расстояния в архиве".to_string());
                            }
                            let distance = DIST_BASE[dist_symbol] as usize
                                + bits.bits(DIST_EXTRA[dist_symbol] as u32)? as usize;
                            if distance == 0 || distance > out.len() {
                                return Err("копирование за начало данных в архиве".to_string());
                            }
                            let start = out.len() - distance;
                            for i in 0..length {
                                let byte = out[start + i];
                                out.push(byte);
                            }
                        }
                    }
                }
            }
        }
        if last == 1 {
            break;
        }
    }
    Ok(out)
}

fn dynamic_tables(bits: &mut Bits<'_>, data: &[u8]) -> Result<(Huffman, Huffman), String> {
    let hlit = bits.bits(5)? as usize + 257;
    let hdist = bits.bits(5)? as usize + 1;
    let hclen = bits.bits(4)? as usize + 4;
    const ORDER: [usize; 19] = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
    let mut code_lengths = [0u8; 19];
    for &slot in ORDER.iter().take(hclen) {
        code_lengths[slot] = bits.bits(3)? as u8;
    }
    let code_huff = Huffman::new(&code_lengths)?;
    let mut lengths = vec![0u8; hlit + hdist];
    let mut i = 0;
    while i < lengths.len() {
        let symbol = code_huff.decode(bits)?;
        match symbol {
            0..=15 => {
                lengths[i] = symbol as u8;
                i += 1;
            }
            16 => {
                if i == 0 {
                    return Err("архив повреждён: повтор без предыдущей длины".to_string());
                }
                let prev = lengths[i - 1];
                let repeat = 3 + bits.bits(2)? as usize;
                for _ in 0..repeat {
                    if i >= lengths.len() {
                        return Err("архив повреждён: повтор длин вышел за границу".to_string());
                    }
                    lengths[i] = prev;
                    i += 1;
                }
            }
            17 | 18 => {
                let repeat = if symbol == 17 {
                    3 + bits.bits(3)? as usize
                } else {
                    11 + bits.bits(7)? as usize
                };
                for _ in 0..repeat {
                    if i >= lengths.len() {
                        return Err("архив повреждён: нули вышел за границу".to_string());
                    }
                    lengths[i] = 0;
                    i += 1;
                }
            }
            _ => return Err("архив повреждён: неверная длина кода".to_string()),
        }
    }
    let _ = data;
    Ok((Huffman::new(&lengths[..hlit])?, Huffman::new(&lengths[hlit..])?))
}

fn u16_at(data: &[u8], at: usize) -> u16 {
    (data[at] as u16) | ((data[at + 1] as u16) << 8)
}

fn u32_at(data: &[u8], at: usize) -> u32 {
    (data[at] as u32)
        | ((data[at + 1] as u32) << 8)
        | ((data[at + 2] as u32) << 16)
        | ((data[at + 3] as u32) << 24)
}

/// Похоже ли это на ZIP-архив.
pub fn is_zip(data: &[u8]) -> bool {
    find_eocd(data).is_some()
}

fn find_eocd(data: &[u8]) -> Option<usize> {
    if data.len() < 22 {
        return None;
    }
    let stop = data.len().saturating_sub(65557);
    let mut at = data.len() - 22;
    loop {
        if u32_at(data, at) == 0x0605_4b50 {
            return Some(at);
        }
        if at == stop {
            return None;
        }
        at -= 1;
    }
}

/// Имя файла в архиве: часть архиваторов не ставит флаг UTF-8.
fn decode_name(bytes: &[u8], utf8: bool) -> String {
    if utf8 {
        return String::from_utf8_lossy(bytes).to_string();
    }
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_string(),
        Err(_) => bytes.iter().map(|b| crate::files::cp1251_char(*b)).collect(),
    }
}

/// Список файлов архива. Папки не попадают — панель показывает только файлы.
pub fn list(data: &[u8]) -> Result<Vec<ZipEntry>, String> {
    let eocd = find_eocd(data).ok_or_else(|| "файл не похож на zip-архив".to_string())?;
    let count = u16_at(data, eocd + 10) as usize;
    let mut offset = u32_at(data, eocd + 16) as usize;
    let mut entries = Vec::with_capacity(count);
    for _ in 0..count {
        if offset + 46 > data.len() || u32_at(data, offset) != 0x0201_4b50 {
            return Err("список файлов архива повреждён".to_string());
        }
        let flags = u16_at(data, offset + 8);
        let method = u16_at(data, offset + 10);
        let crc = u32_at(data, offset + 16);
        let packed = u32_at(data, offset + 20) as u64;
        let size = u32_at(data, offset + 24) as u64;
        let name_len = u16_at(data, offset + 28) as usize;
        let extra_len = u16_at(data, offset + 30) as usize;
        let comment_len = u16_at(data, offset + 32) as usize;
        let local_offset = u32_at(data, offset + 42) as usize;
        let name = decode_name(&data[offset + 46..offset + 46 + name_len], flags & 0x800 != 0);
        if !name.ends_with('/') && !name.is_empty() {
            entries.push(ZipEntry { name, size, packed, method, local_offset, crc });
        }
        offset += 46 + name_len + extra_len + comment_len;
    }
    Ok(entries)
}

/// Достаёт файл из архива.
pub fn read_entry(data: &[u8], entry: &ZipEntry) -> Result<Vec<u8>, String> {
    let at = entry.local_offset;
    if at + 30 > data.len() || u32_at(data, at) != 0x0403_4b50 {
        return Err(format!("локальный заголовок повреждён: {}", entry.name));
    }
    let name_len = u16_at(data, at + 26) as usize;
    let extra_len = u16_at(data, at + 28) as usize;
    let start = at + 30 + name_len + extra_len;
    let end = start + entry.packed as usize;
    if end > data.len() {
        return Err(format!("данные файла обрезаны: {}", entry.name));
    }
    let raw = &data[start..end];
    let out = match entry.method {
        0 => raw.to_vec(),
        8 => inflate_raw(raw)?,
        other => return Err(format!("сжатие zip не поддерживается (метод {})", other)),
    };
    Ok(out)
}

/// Достаёт файл по имени (панель ищет файл именно так).
pub fn read_by_name(data: &[u8], name: &str) -> Result<Vec<u8>, String> {
    let want = name.replace('\\', "/");
    let entries = list(data)?;
    let entry = entries
        .iter()
        .find(|e| e.name.replace('\\', "/") == want)
        .ok_or_else(|| format!("В архиве нет файла {}", name))?;
    read_entry(data, entry)
}

/// Имя файла внутри папки: `..` и абсолютные пути недопустимы.
fn safe_name(name: &str) -> Option<String> {
    let clean = name.replace('\\', "/");
    if clean.starts_with('/') || clean.contains(':') {
        return None;
    }
    let mut parts: Vec<&str> = Vec::new();
    for part in clean.split('/') {
        match part {
            "" | "." => {}
            ".." => return None,
            other => parts.push(other),
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

/// Распаковка в папку. `only` — имя одного файла, пустая строка — всё.
pub fn extract(data: &[u8], dest: &std::path::Path, only: &str) -> Result<(usize, u64, Vec<String>), String> {
    let entries = list(data)?;
    let want = if only.trim().is_empty() {
        None
    } else {
        Some(only.replace('\\', "/"))
    };
    let mut count = 0;
    let mut bytes = 0u64;
    let mut names = Vec::new();
    for entry in &entries {
        let plain = entry.name.replace('\\', "/");
        if let Some(want) = &want {
            if &plain != want {
                continue;
            }
        }
        let Some(safe) = safe_name(&plain) else {
            continue;
        };
        let target = dest.join(safe.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("не удалось создать папку: {}", e))?;
        }
        let content = read_entry(data, entry)?;
        std::fs::write(&target, &content).map_err(|e| format!("не удалось записать {}: {}", plain, e))?;
        count += 1;
        bytes += content.len() as u64;
        names.push(plain);
    }
    if count == 0 && want.is_some() {
        return Err("В архиве нет такого файла".to_string());
    }
    Ok((count, bytes, names))
}

/// Проверка контрольной суммы — нужна обновлениям, чтобы не распаковать битое.
pub fn crc32(data: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for (i, slot) in table.iter_mut().enumerate() {
        let mut c = i as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
        }
        *slot = c;
    }
    let mut crc = 0xFFFF_FFFFu32;
    for &byte in data {
        crc = table[((crc ^ byte as u32) & 0xff) as usize] ^ (crc >> 8);
    }
    crc ^ 0xFFFF_FFFF
}

impl ZipEntry {
    /// Совпадает ли содержимое с записанной контрольной суммой (для тестов и проверок).
    pub fn crc(&self) -> u32 {
        self.crc
    }
}
