//! Сжатие DEFLATE: без него архив сервера весит как сама папка.
//!
//! Панель отправляет сервер в хранилище архивом, поэтому нужен свой
//! упаковщик: мир Minecraft — это текстовые NBT и таблицы, они сжимаются
//! втрое-впятеро. Реализация простая и предсказуемая — один блок с
//! фиксированными кодами Хаффмана и жадный поиск совпадений по хеш-цепочкам.
//! Распаковка уже есть в `zip.rs`, поэтому проверка честная: сжали —
//! распаковали — сравнили.

/// Максимальная длина совпадения в DEFLATE.
const MAX_MATCH: usize = 258;
/// Минимальная длина совпадения.
const MIN_MATCH: usize = 3;
/// Окно поиска.
const WINDOW: usize = 32768;
/// Сколько шагов по цепочке одинаковых хешей просматриваем.
const CHAIN: usize = 48;

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

/// Пишет биты «младшим вперёд» — так устроен DEFLATE.
struct BitWriter {
    out: Vec<u8>,
    buf: u32,
    bits: u32,
}

impl BitWriter {
    fn new() -> BitWriter {
        BitWriter { out: Vec::new(), buf: 0, bits: 0 }
    }

    /// Записать `count` бит значения `value`, начиная с младшего.
    fn write(&mut self, value: u32, count: u32) {
        self.buf |= value << self.bits;
        self.bits += count;
        while self.bits >= 8 {
            self.out.push((self.buf & 0xff) as u8);
            self.buf >>= 8;
            self.bits -= 8;
        }
    }

    /// Код Хаффмана записывается старшим битом вперёд, поэтому разворачиваем.
    fn write_code(&mut self, code: u32, len: u32) {
        let mut reversed = 0;
        for i in 0..len {
            reversed |= ((code >> i) & 1) << (len - 1 - i);
        }
        self.write(reversed, len);
    }

    fn finish(mut self) -> Vec<u8> {
        if self.bits > 0 {
            self.out.push((self.buf & 0xff) as u8);
        }
        self.out
    }
}

/// Код и длина для литерала/длины (фиксированное дерево DEFLATE).
fn fixed_literal(symbol: u16) -> (u32, u32) {
    match symbol {
        0..=143 => (0x30 + symbol as u32, 8),
        144..=255 => (0x190 + (symbol as u32 - 144), 9),
        256..=279 => (symbol as u32 - 256, 7),
        _ => (0xc0 + (symbol as u32 - 280), 8),
    }
}

fn length_code(length: usize) -> (u16, u8, u16) {
    let mut best = 0;
    for (i, base) in LENGTH_BASE.iter().enumerate() {
        if (*base as usize) <= length {
            best = i;
        }
    }
    (257 + best as u16, LENGTH_EXTRA[best], LENGTH_BASE[best])
}

fn distance_code(distance: usize) -> (u16, u8, u16) {
    let mut best = 0;
    for (i, base) in DIST_BASE.iter().enumerate() {
        if (*base as usize) <= distance {
            best = i;
        }
    }
    (best as u16, DIST_EXTRA[best], DIST_BASE[best])
}

/// Сжимает данные в поток DEFLATE (один блок, фиксированные коды).
pub fn compress(data: &[u8]) -> Vec<u8> {
    let mut w = BitWriter::new();
    /* последний блок, тип 01 — фиксированные коды Хаффмана */
    w.write(1, 1);
    w.write(1, 2);

    /* хеш 3 байт → последняя позиция; цепочку храним в prev */
    let mut head = vec![usize::MAX; 1 << 15];
    let mut prev = vec![usize::MAX; data.len().max(1)];
    let hash = |data: &[u8], at: usize| -> usize {
        let a = data[at] as usize;
        let b = data[at + 1] as usize;
        let c = data[at + 2] as usize;
        ((a << 10) ^ (b << 5) ^ c) & 0x7fff
    };

    let mut at = 0;
    while at < data.len() {
        let mut best_len = 0;
        let mut best_dist = 0;
        if at + MIN_MATCH <= data.len() {
            let h = hash(data, at);
            let mut candidate = head[h];
            let mut steps = 0;
            let limit = MAX_MATCH.min(data.len() - at);
            while candidate != usize::MAX && steps < CHAIN {
                let dist = at - candidate;
                if dist > WINDOW {
                    break;
                }
                if data[candidate + best_len.min(limit - 1)] == data[at + best_len.min(limit - 1)] {
                    let mut len = 0;
                    while len < limit && data[candidate + len] == data[at + len] {
                        len += 1;
                    }
                    if len > best_len {
                        best_len = len;
                        best_dist = dist;
                        if len == limit {
                            break;
                        }
                    }
                }
                candidate = prev[candidate];
                steps += 1;
            }
            /* ставим текущую позицию в цепочку */
            prev[at] = head[h];
            head[h] = at;
        }

        if best_len >= MIN_MATCH {
            let (code, extra_bits, base) = length_code(best_len);
            let (bits, len) = fixed_literal(code);
            w.write_code(bits, len);
            if extra_bits > 0 {
                w.write((best_len - base as usize) as u32, extra_bits as u32);
            }
            let (dcode, dextra, dbase) = distance_code(best_dist);
            let (dbits, dlen) = (dcode as u32, 5);
            w.write_code(dbits, dlen);
            if dextra > 0 {
                w.write((best_dist - dbase as usize) as u32, dextra as u32);
            }
            /* позиции внутри совпадения тоже попадают в цепочку — так лучше жмётся */
            for step in 1..best_len {
                let pos = at + step;
                if pos + MIN_MATCH <= data.len() {
                    let h = hash(data, pos);
                    prev[pos] = head[h];
                    head[h] = pos;
                }
            }
            at += best_len;
        } else {
            let (bits, len) = fixed_literal(data[at] as u16);
            w.write_code(bits, len);
            at += 1;
        }
    }

    let (end_bits, end_len) = fixed_literal(256);
    w.write_code(end_bits, end_len);
    w.finish()
}

/// Сжимает и решает, что выгоднее — сжатое или как есть.
/// Возвращает (данные, метод zip: 8 — сжатие, 0 — без него).
pub fn compress_best(data: &[u8]) -> (Vec<u8>, u16) {
    if data.is_empty() {
        return (Vec::new(), 0);
    }
    let packed = compress(data);
    if packed.len() < data.len() {
        (packed, 8)
    } else {
        (data.to_vec(), 0)
    }
}
