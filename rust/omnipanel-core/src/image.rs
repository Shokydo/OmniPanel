//! PNG своими руками: иконки серверов и обои панели.
//!
//! Minecraft ждёт `server-icon.png` ровно 64×64, а панель показывает иконку
//! сервера в списке. Значит нужно две вещи: прочитать PNG, который выбрал
//! человек, и записать свой. Сжатие уже есть в `deflate` (DEFLATE), остаётся
//! обёртка zlib и фильтры строк — они простые, поэтому внешняя библиотека
//! картинок не нужна.
//!
//! Что не поддерживается: палитровые PNG (тип 3), 16-битная глубина и
//! чересстрочная развёртка — такие файлы панель честно не берёт. JPEG тоже:
//! свой декодер JPEG — это уже отдельный проект, а иконки делают в PNG.

/// Картинка в памяти: RGBA, восемь бит на канал.
#[derive(Debug, Clone, PartialEq)]
pub struct Image {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

impl Image {
    pub fn new(width: u32, height: u32) -> Image {
        Image {
            width,
            height,
            pixels: vec![0; (width as usize) * (height as usize) * 4],
        }
    }

    /// Цвет пикселя — нужен тестам и подбору палитры под обои.
    pub fn pixel(&self, x: u32, y: u32) -> [u8; 4] {
        self.at(x, y)
    }

    fn at(&self, x: u32, y: u32) -> [u8; 4] {
        let index = ((y as usize) * (self.width as usize) + x as usize) * 4;
        [
            self.pixels[index],
            self.pixels[index + 1],
            self.pixels[index + 2],
            self.pixels[index + 3],
        ]
    }

    fn set(&mut self, x: u32, y: u32, pixel: [u8; 4]) {
        let index = ((y as usize) * (self.width as usize) + x as usize) * 4;
        self.pixels[index..index + 4].copy_from_slice(&pixel);
    }

    /// Уменьшение или увеличение «по ближайшему» — для иконок этого хватает,
    /// а интерфейс всё равно рисует их с собственным сглаживанием.
    pub fn resize(&self, width: u32, height: u32) -> Image {
        let mut out = Image::new(width.max(1), height.max(1));
        for y in 0..out.height {
            let src_y = (y as f64 * self.height as f64 / out.height as f64) as u32;
            for x in 0..out.width {
                let src_x = (x as f64 * self.width as f64 / out.width as f64) as u32;
                out.set(x, y, self.at(src_x.min(self.width - 1), src_y.min(self.height - 1)));
            }
        }
        out
    }
}

/// Ошибка чтения — всегда по-русски и по делу.
fn fail(message: &str) -> String {
    message.to_string()
}

/// Читает PNG: любая глубина цвета (1, 2, 4, 8, 16 бит), палитра,
/// прозрачность и чересстрочная запись (Adam7). Этого хватает иконкам,
/// которые люди берут из интернета: половина из них — палитровые.
pub fn decode_png(data: &[u8]) -> Result<Image, String> {
    if data.len() < 8 || &data[..8] != b"\x89PNG\r\n\x1a\n" {
        return Err(fail("Это не PNG-файл"));
    }
    let mut at = 8;
    let (mut width, mut height) = (0u32, 0u32);
    let mut depth = 0u8;
    let mut color = 0u8;
    let mut interlace = 0u8;
    let mut compressed: Vec<u8> = Vec::new();
    let mut palette: Vec<[u8; 3]> = Vec::new();
    let mut palette_alpha: Vec<u8> = Vec::new();
    let mut transparent: Option<Vec<u16>> = None;

    while at + 8 <= data.len() {
        let length = u32::from_be_bytes([data[at], data[at + 1], data[at + 2], data[at + 3]]) as usize;
        let kind = &data[at + 4..at + 8];
        let start = at + 8;
        let end = start + length;
        if end > data.len() {
            return Err(fail("PNG оборвался посреди данных"));
        }
        let body = &data[start..end];
        match kind {
            b"IHDR" => {
                if body.len() < 13 {
                    return Err(fail("Заголовок PNG испорчен"));
                }
                width = u32::from_be_bytes([body[0], body[1], body[2], body[3]]);
                height = u32::from_be_bytes([body[4], body[5], body[6], body[7]]);
                depth = body[8];
                color = body[9];
                interlace = body[12];
            }
            b"PLTE" => {
                palette = body
                    .chunks(3)
                    .filter(|part| part.len() == 3)
                    .map(|part| [part[0], part[1], part[2]])
                    .collect();
            }
            b"tRNS" => {
                match color {
                    3 => palette_alpha = body.to_vec(),
                    /* серый: одно число; RGB: три числа — это и есть прозрачный цвет */
                    0 => transparent = Some(vec![u16::from_be_bytes([body[0], body.get(1).copied().unwrap_or(0)])]),
                    2 => {
                        if body.len() >= 6 {
                            transparent = Some(vec![
                                u16::from_be_bytes([body[0], body[1]]),
                                u16::from_be_bytes([body[2], body[3]]),
                                u16::from_be_bytes([body[4], body[5]]),
                            ]);
                        }
                    }
                    _ => {}
                }
            }
            b"IDAT" => compressed.extend_from_slice(body),
            b"IEND" => break,
            _ => {}
        }
        at = end + 4; /* + CRC */
    }

    if width == 0 || height == 0 {
        return Err(fail("В PNG нет размеров картинки"));
    }
    if !matches!(depth, 1 | 2 | 4 | 8 | 16) {
        return Err(fail("Такая глубина цвета в PNG панели не по силам"));
    }
    let channels = match color {
        0 => 1, /* оттенки серого */
        2 => 3, /* RGB */
        3 => 1, /* палитра */
        4 => 2, /* серый + прозрачность */
        6 => 4, /* RGBA */
        _ => return Err(fail("Такой вид PNG панель не читает")),
    };
    if color == 3 && palette.is_empty() {
        return Err(fail("В палитровом PNG нет самой палитры"));
    }
    if interlace != 0 && interlace != 1 {
        return Err(fail("Неизвестный способ чередования PNG"));
    }

    let raw = super::zip::inflate_raw(&un_zlib(&compressed)?)?;
    let mut out = Image::new(width, height);

    /* Чересстрочный PNG — это семь проходов, каждый со своими строками.
       Без чередования проход один и совпадает со всей картинкой. */
    let passes: Vec<(u32, u32, u32, u32)> = if interlace == 0 {
        vec![(0, 0, 1, 1)]
    } else {
        vec![
            (0, 0, 8, 8),
            (4, 0, 8, 8),
            (0, 4, 4, 8),
            (2, 0, 4, 4),
            (0, 2, 2, 4),
            (1, 0, 2, 2),
            (0, 1, 1, 2),
        ]
    };

    let bits_per_pixel = channels * depth as usize;
    let mut cursor = 0usize;
    for (start_x, start_y, step_x, step_y) in passes {
        let pass_width = if width > start_x {
            (width - start_x + step_x - 1) / step_x
        } else {
            0
        };
        let pass_height = if height > start_y {
            (height - start_y + step_y - 1) / step_y
        } else {
            0
        };
        if pass_width == 0 || pass_height == 0 {
            continue;
        }
        let stride = (pass_width as usize * bits_per_pixel + 7) / 8;
        let mut previous = vec![0u8; stride];
        let mut line = vec![0u8; stride];
        for row in 0..pass_height {
            if cursor + 1 + stride > raw.len() {
                return Err(fail("В PNG не хватает данных"));
            }
            let filter = raw[cursor];
            line.copy_from_slice(&raw[cursor + 1..cursor + 1 + stride]);
            cursor += 1 + stride;
            /* фильтры считаются по байтам, а не по пикселям — минимум один байт */
            let step = ((bits_per_pixel + 7) / 8).max(1);
            unfilter(filter, &mut line, &previous, step)?;

            for column in 0..pass_width as usize {
                let pixel = pick(&line, column, depth, color, &palette, &palette_alpha, &transparent);
                let x = start_x + column as u32 * step_x;
                let y = start_y + row * step_y;
                out.set(x, y, pixel);
            }
            previous.copy_from_slice(&line);
        }
    }
    Ok(out)
}

/// Достаёт один пиксель из строки с учётом глубины цвета, палитры и прозрачности.
fn pick(
    line: &[u8],
    index: usize,
    depth: u8,
    color: u8,
    palette: &[[u8; 3]],
    palette_alpha: &[u8],
    transparent: &Option<Vec<u16>>,
) -> [u8; 4] {
    let channels = match color {
        0 | 3 => 1,
        2 => 3,
        4 => 2,
        _ => 4,
    };

    /* один отсчёт: 1, 2 и 4 бита упакованы в байт; 16 бит занимают два байта */
    let sample = |which: usize| -> u16 {
        match depth {
            16 => {
                let at = (index * channels + which) * 2;
                u16::from_be_bytes([*line.get(at).unwrap_or(&0), *line.get(at + 1).unwrap_or(&0)])
            }
            8 => *line.get(index * channels + which).unwrap_or(&0) as u16,
            bits => {
                let per_byte = (8 / bits) as usize;
                let at = (index * channels + which) / per_byte;
                let shift = 8 - bits as usize * ((index * channels + which) % per_byte + 1);
                let byte = *line.get(at).unwrap_or(&0);
                ((byte >> shift) & ((1u16 << bits) - 1) as u8) as u16
            }
        }
    };
    /* к восьми битам: 1/2/4 бита растягиваются, у 16 бит берём старший байт */
    let to8 = |value: u16| -> u8 {
        match depth {
            16 => (value >> 8) as u8,
            1 => (value * 255) as u8,
            2 => (value * 85) as u8,
            4 => (value * 17) as u8,
            _ => value as u8,
        }
    };

    if color == 3 {
        let entry = sample(0) as usize;
        let rgb = palette.get(entry).copied().unwrap_or([0, 0, 0]);
        let alpha = palette_alpha.get(entry).copied().unwrap_or(255);
        return [rgb[0], rgb[1], rgb[2], alpha];
    }

    let first = sample(0);
    if let Some(clear) = transparent {
        /* серый: одно значение; RGB: три — сравниваем весь цвет */
        let is_clear = if color == 0 {
            *clear.first().unwrap_or(&u16::MAX) == first
        } else if color == 2 {
            clear.len() >= 3
                && clear[0] == first
                && clear[1] == sample(1)
                && clear[2] == sample(2)
        } else {
            false
        };
        if is_clear {
            return [0, 0, 0, 0];
        }
    }

    match channels {
        1 => {
            let grey = to8(first);
            [grey, grey, grey, 255]
        }
        2 => {
            let grey = to8(first);
            [grey, grey, grey, to8(sample(1))]
        }
        3 => [to8(first), to8(sample(1)), to8(sample(2)), 255],
        _ => [to8(first), to8(sample(1)), to8(sample(2)), to8(sample(3))],
    }
}

fn unfilter(filter: u8, line: &mut [u8], previous: &[u8], channels: usize) -> Result<(), String> {
    match filter {
        0 => {}
        1 => {
            for i in channels..line.len() {
                line[i] = line[i].wrapping_add(line[i - channels]);
            }
        }
        2 => {
            for i in 0..line.len() {
                line[i] = line[i].wrapping_add(previous[i]);
            }
        }
        3 => {
            for i in 0..line.len() {
                let left = if i >= channels { line[i - channels] as u16 } else { 0 };
                let up = previous[i] as u16;
                line[i] = line[i].wrapping_add(((left + up) / 2) as u8);
            }
        }
        4 => {
            for i in 0..line.len() {
                let a = if i >= channels { line[i - channels] as i16 } else { 0 };
                let b = previous[i] as i16;
                let c = if i >= channels { previous[i - channels] as i16 } else { 0 };
                let p = a + b - c;
                let (pa, pb, pc) = ((p - a).abs(), (p - b).abs(), (p - c).abs());
                let value = if pa <= pb && pa <= pc { a } else if pb <= pc { b } else { c };
                line[i] = line[i].wrapping_add(value as u8);
            }
        }
        _ => return Err(fail("Неизвестный фильтр PNG")),
    }
    Ok(())
}

/// Снимает обёртку zlib: два байта заголовка и четыре байта суммы.
fn un_zlib(data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() < 6 {
        return Err(fail("Данные PNG слишком короткие"));
    }
    let (_, rest) = data.split_at(2);
    Ok(rest[..rest.len() - 4].to_vec())
}

/* ─────────────────────────────── JPEG ───────────────────────────────
   Иконки часто берут из фоторедакторов и из интернета, а там JPEG.
   Здесь обычный (baseline, SOF0) JPEG: таблицы Хаффмана и квантования из
   файла, обратное косинусное преобразование, цвет из YCbCr в RGB.
   Прогрессивный (SOF2) не поддерживаем — о нём честно говорим текстом.
*/

/// Таблица квантования: 64 числа.
type Quant = [u16; 64];

/// Таблица Хаффмана: коды по длинам, как их задаёт сам файл.
struct Huffman {
    counts: [u16; 17],
    symbols: Vec<u8>,
    /// Первый код каждой длины — по нему и ищем символ.
    first: [i32; 18],
}

impl Huffman {
    fn new(counts: [u16; 17], symbols: Vec<u8>) -> Huffman {
        let mut first = [0i32; 18];
        let mut code = 0i32;
        for length in 1..=16usize {
            first[length] = code;
            code = (code + counts[length] as i32) << 1;
        }
        Huffman { counts, symbols, first }
    }

    /// Ищет символ по битам потока.
    fn symbol(&self, bits: &mut Bits) -> Option<u8> {
        let mut code = 0i32;
        let mut index = 0usize;
        for length in 1..=16usize {
            code = (code << 1) | bits.bit()? as i32;
            let count = self.counts[length] as i32;
            let offset = code - self.first[length];
            if offset >= 0 && offset < count {
                return self.symbols.get(index + offset as usize).copied();
            }
            index += count as usize;
        }
        None
    }
}

/// Чтение битов из потока JPEG.
struct Bits<'a> {
    data: &'a [u8],
    at: usize,
    buffer: u32,
    bits: u8,
}

impl<'a> Bits<'a> {
    fn new(data: &'a [u8]) -> Bits<'a> {
        Bits { data, at: 0, buffer: 0, bits: 0 }
    }

    fn bit(&mut self) -> Option<u32> {
        if self.bits == 0 {
            let byte = *self.data.get(self.at)?;
            self.at += 1;
            /* 0xFF 0x00 — это байт данных, а не маркер */
            let byte = if byte == 0xFF {
                if *self.data.get(self.at)? == 0x00 {
                    self.at += 1;
                }
                byte
            } else {
                byte
            };
            self.buffer = byte as u32;
            self.bits = 8;
        }
        self.bits -= 1;
        Some((self.buffer >> self.bits) & 1)
    }

    fn read(&mut self, count: u8) -> Option<u32> {
        let mut value = 0;
        for _ in 0..count {
            value = (value << 1) | self.bit()?;
        }
        Some(value)
    }
}

/// Разворачивает прочитанные биты в число со знаком — так это делают в JPEG:
/// младшая половина значений отрицательная, остальные положительные.
fn extend(value: u32, bits: u8) -> i32 {
    if bits == 0 {
        return 0;
    }
    let value = value as i32;
    let half = 1 << (bits - 1);
    if value < half {
        value - (1 << bits) + 1
    } else {
        value
    }
}

/// Обратное косинусное преобразование 8×8 — простое и понятное, без затей.
fn idct(block: &mut [f32; 64]) {
    let mut out = [0f32; 64];
    for y in 0..8 {
        for x in 0..8 {
            let mut sum = 0f32;
            for v in 0..8 {
                for u in 0..8 {
                    let cu = if u == 0 { std::f32::consts::FRAC_1_SQRT_2 } else { 1.0 };
                    let cv = if v == 0 { std::f32::consts::FRAC_1_SQRT_2 } else { 1.0 };
                    let angle = ((2 * x + 1) as f32 * u as f32 * std::f32::consts::PI / 16.0).cos()
                        * ((2 * y + 1) as f32 * v as f32 * std::f32::consts::PI / 16.0).cos();
                    sum += cu * cv * block[v * 8 + u] * angle;
                }
            }
            out[y * 8 + x] = sum / 4.0 + 128.0;
        }
    }
    *block = out;
}

/// Читает JPEG (обычный, не прогрессивный) и отдаёт картинку в RGBA.
pub fn decode_jpeg(data: &[u8]) -> Result<Image, String> {
    if data.len() < 4 || data[0] != 0xFF || data[1] != 0xD8 {
        return Err(fail("Это не JPEG-файл"));
    }
    let mut quant: Vec<Quant> = vec![[0; 64]; 4];
    let mut dc_tables: Vec<Option<Huffman>> = (0..4).map(|_| None).collect();
    let mut ac_tables: Vec<Option<Huffman>> = (0..4).map(|_| None).collect();
    let mut width = 0usize;
    let mut height = 0usize;
    /* у каждого цвета: id, шаг выборки по X и Y, таблица квантования */
    let mut parts: Vec<(u8, usize, usize, usize)> = Vec::new();
    let mut scan_at = 0usize;
    /* таблицы Хаффмана для каждого цвета — из заголовка сканирования */
    let mut scan_tables: Vec<(usize, usize)> = Vec::new();

    let mut at = 2usize;
    while at + 4 <= data.len() {
        if data[at] != 0xFF {
            at += 1;
            continue;
        }
        let marker = data[at + 1];
        let length = u16::from_be_bytes([data[at + 2], data[at + 3]]) as usize;
        let body = &data[at + 4..(at + 2 + length).min(data.len())];
        match marker {
            0xD8 | 0x01 => {
                at += 2;
                continue;
            }
            0xD9 => break,
            0xDB => {
                /* таблицы квантования */
                let mut walk = 0usize;
                while walk < body.len() {
                    let info = body[walk];
                    let precise = info >> 4;
                    let id = (info & 0x0F) as usize;
                    walk += 1;
                    if id >= 4 {
                        break;
                    }
                    let mut table: Quant = [1; 64];
                    for k in 0..64 {
                        if precise == 0 {
                            table[ZIGZAG[k]] = *body.get(walk).unwrap_or(&1) as u16;
                            walk += 1;
                        } else {
                            let hi = *body.get(walk).unwrap_or(&1) as u16;
                            let lo = *body.get(walk + 1).unwrap_or(&1) as u16;
                            table[ZIGZAG[k]] = (hi << 8) | lo;
                            walk += 2;
                        }
                    }
                    quant[id] = table;
                }
            }
            0xC0 | 0xC1 => {
                if body.len() < 6 {
                    return Err(fail("Заголовок JPEG испорчен"));
                }
                height = u16::from_be_bytes([body[1], body[2]]) as usize;
                width = u16::from_be_bytes([body[3], body[4]]) as usize;
                let count = body[5] as usize;
                parts.clear();
                for index in 0..count {
                    let base = 6 + index * 3;
                    let id = body[base];
                    let sampling = body[base + 1];
                    parts.push((
                        id,
                        (sampling >> 4) as usize,
                        (sampling & 0x0F) as usize,
                        body[base + 2] as usize,
                    ));
                }
            }
            0xC2 => return Err(fail("Прогрессивный JPEG панель не читает — пересохрани обычным")),
            0xC4 => {
                /* таблицы Хаффмана */
                let mut walk = 0usize;
                while walk + 17 <= body.len() {
                    let info = body[walk];
                    let class = info >> 4;
                    let id = (info & 0x0F) as usize;
                    let mut counts = [0u16; 17];
                    for k in 1..=16 {
                        counts[k] = body[walk + k] as u16;
                    }
                    let total: usize = counts.iter().map(|c| *c as usize).sum();
                    walk += 17;
                    if walk + total > body.len() || id >= 4 {
                        break;
                    }
                    let symbols = body[walk..walk + total].to_vec();
                    walk += total;
                    let table = Huffman::new(counts, symbols);
                    if class == 0 {
                        dc_tables[id] = Some(table);
                    } else {
                        ac_tables[id] = Some(table);
                    }
                }
            }
            0xDA => {
                /* состав сканирования: сколько цветов и какие у них таблицы */
                let count = body.first().copied().unwrap_or(0) as usize;
                for index in 0..count.min(4) {
                    let base = 1 + index * 2;
                    let tables = body.get(base + 1).copied().unwrap_or(0);
                    scan_tables.push(((tables >> 4) as usize, (tables & 0x0F) as usize));
                }
                scan_at = at + 2 + length;
                break;
            }
            _ => {}
        }
        at += 2 + length;
    }

    if width == 0 || height == 0 || parts.is_empty() {
        return Err(fail("В JPEG нет размеров картинки"));
    }
    if scan_at == 0 || scan_at >= data.len() {
        return Err(fail("В JPEG нет самих данных картинки"));
    }

    /* какой цвет как читать — из заголовка сканирования: там же таблицы */
    let mut order: Vec<(usize, usize)> = Vec::new(); /* (dc, ac) по порядку цветов */
    for (index, _) in parts.iter().enumerate() {
        let (dc, ac) = scan_tables.get(index).copied().unwrap_or((0, 0));
        order.push((dc, ac));
    }

    let max_h = parts.iter().map(|p| p.1).max().unwrap_or(1).max(1);
    let max_v = parts.iter().map(|p| p.2).max().unwrap_or(1).max(1);
    let mcu_w = 8 * max_h;
    let mcu_h = 8 * max_v;
    let mcus_x = (width + mcu_w - 1) / mcu_w;
    let mcus_y = (height + mcu_h - 1) / mcu_h;

    /* плоскости цветов: ширина и высота с учётом выборки */
    let mut planes: Vec<Vec<u8>> = parts
        .iter()
        .map(|part| {
            let plane_w = mcus_x * 8 * part.1;
            let plane_h = mcus_y * 8 * part.2;
            vec![0u8; plane_w * plane_h]
        })
        .collect();

    let mut bits = Bits::new(&data[scan_at..]);
    let mut last_dc = vec![0i32; parts.len()];
    for my in 0..mcus_y {
        for mx in 0..mcus_x {
            for (component, part) in parts.iter().enumerate() {
                let (_, sample_x, sample_y, quant_id) = *part;
                let (dc_id, ac_id) = order[component];
                let dc = match dc_tables[dc_id].as_ref() {
                    Some(table) => table,
                    None => return Err(fail("В JPEG нет таблицы Хаффмана")),
                };
                let ac = match ac_tables[ac_id].as_ref() {
                    Some(table) => table,
                    None => return Err(fail("В JPEG нет таблицы Хаффмана")),
                };
                for by in 0..sample_y {
                    for bx in 0..sample_x {
                        let mut block = [0f32; 64];
                        /* DC */
                        let size = dc.symbol(&mut bits).ok_or_else(|| fail("Данные JPEG оборвались"))?;
                        let diff = if size == 0 {
                            0
                        } else {
                            let raw = bits
                                .read(size)
                                .ok_or_else(|| fail("Данные JPEG оборвались"))?;
                            extend(raw, size)
                        };
                        last_dc[component] += diff;
                        block[0] = (last_dc[component] * quant[quant_id][0] as i32) as f32;
                        /* AC: пары «сколько нулей, сколько бит» */
                        let mut k = 1usize;
                        while k < 64 {
                            let symbol = ac.symbol(&mut bits).ok_or_else(|| fail("Данные JPEG оборвались"))?;
                            if symbol == 0 {
                                break;
                            }
                            let zeros = (symbol >> 4) as usize;
                            let size = symbol & 0x0F;
                            k += zeros;
                            if k > 63 {
                                break;
                            }
                            let raw = bits
                                .read(size)
                                .ok_or_else(|| fail("Данные JPEG оборвались"))?;
                            let value = extend(raw, size);
                            /* квантование лежит уже в обычном порядке — сверяем по тому же месту */
                            block[ZIGZAG[k]] = (value * quant[quant_id][ZIGZAG[k]] as i32) as f32;
                            k += 1;
                        }
                        idct(&mut block);
                        let plane = &mut planes[component];
                        let stride = mcus_x * 8 * sample_x;
                        let origin_x = (mx * sample_x + bx) * 8;
                        let origin_y = (my * sample_y + by) * 8;
                        for y in 0..8 {
                            for x in 0..8 {
                                let value = block[y * 8 + x].round().clamp(0.0, 255.0) as u8;
                                let index = (origin_y + y) * stride + origin_x + x;
                                if let Some(slot) = plane.get_mut(index) {
                                    *slot = value;
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    /* собираем картинку: цвет берём из нужной точки с учётом выборки */
    let mut out = Image::new(width as u32, height as u32);
    let sample = |component: usize, x: usize, y: usize| -> u8 {
        let (_, sx, sy, _) = parts[component];
        let stride = mcus_x * 8 * sx;
        let px = (x * sx / max_h).min(stride.saturating_sub(1));
        let py = y * sy / max_v;
        planes[component].get(py * stride + px).copied().unwrap_or(0)
    };
    for y in 0..height {
        for x in 0..width {
            let pixel = if parts.len() >= 3 {
                let luma = sample(0, x, y) as f32;
                let cb = sample(1, x, y) as f32 - 128.0;
                let cr = sample(2, x, y) as f32 - 128.0;
                let r = luma + 1.402 * cr;
                let g = luma - 0.344136 * cb - 0.714136 * cr;
                let b = luma + 1.772 * cb;
                [
                    r.round().clamp(0.0, 255.0) as u8,
                    g.round().clamp(0.0, 255.0) as u8,
                    b.round().clamp(0.0, 255.0) as u8,
                    255,
                ]
            } else {
                let grey = sample(0, x, y);
                [grey, grey, grey, 255]
            };
            out.set(x as u32, y as u32, pixel);
        }
    }
    Ok(out)
}

/// Порядок обхода блока в JPEG (зигзаг).
const ZIGZAG: [usize; 64] = [
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
    13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59,
    52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

/// Читает картинку любого поддерживаемого вида: PNG или JPEG.
pub fn decode_any(data: &[u8]) -> Result<Image, String> {
    if data.len() >= 8 && &data[..8] == b"\x89PNG\r\n\x1a\n" {
        return decode_png(data);
    }
    if data.len() >= 2 && data[0] == 0xFF && data[1] == 0xD8 {
        return decode_jpeg(data);
    }
    Err(fail("Такую картинку панель не читает — нужен PNG или JPEG"))
}

/// Записывает PNG (RGBA). Своё сжатие — файл получается меньше несжатого.
pub fn encode_png(image: &Image) -> Vec<u8> {
    let stride = (image.width as usize) * 4;
    let mut raw = Vec::with_capacity((stride + 1) * image.height as usize);
    for y in 0..image.height as usize {
        raw.push(0); /* фильтр «нет» — так файл точно читается любой программой */
        raw.extend_from_slice(&image.pixels[y * stride..(y + 1) * stride]);
    }

    let mut out: Vec<u8> = Vec::new();
    out.extend_from_slice(b"\x89PNG\r\n\x1a\n");

    let mut header = Vec::new();
    header.extend_from_slice(&image.width.to_be_bytes());
    header.extend_from_slice(&image.height.to_be_bytes());
    header.extend_from_slice(&[8, 6, 0, 0, 0]); /* 8 бит, RGBA, без чередования */
    put_chunk(&mut out, b"IHDR", &header);
    put_chunk(&mut out, b"IDAT", &zlib(&raw));
    put_chunk(&mut out, b"IEND", &[]);
    out
}

fn put_chunk(out: &mut Vec<u8>, kind: &[u8; 4], body: &[u8]) {
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(body);
    let mut crc_data = Vec::with_capacity(4 + body.len());
    crc_data.extend_from_slice(kind);
    crc_data.extend_from_slice(body);
    out.extend_from_slice(&super::zip::crc32(&crc_data).to_be_bytes());
}

/// Обёртка zlib вокруг нашего DEFLATE: заголовок и контрольная сумма Adler-32.
fn zlib(data: &[u8]) -> Vec<u8> {
    let mut out = vec![0x78, 0x01];
    out.extend_from_slice(&super::deflate::compress(data));
    out.extend_from_slice(&adler32(data).to_be_bytes());
    out
}

fn adler32(data: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for byte in data {
        a = (a + *byte as u32) % 65521;
        b = (b + a) % 65521;
    }
    (b << 16) | a
}

/// Картинка из `data:image/...;base64,...` — так её присылает интерфейс.
pub fn from_data_url(url: &str) -> Result<Image, String> {
    let text = url.trim();
    let body = match text.find("base64,") {
        Some(index) => &text[index + 7..],
        None => return Err(fail("Это не картинка в формате data:image")),
    };
    let data = super::b64::decode(body)?;
    decode_any(&data)
}

/// Картинка в виде `data:image/png;base64,...` для интерфейса.
pub fn to_data_url(image: &Image) -> String {
    format!("data:image/png;base64,{}", super::b64::encode(&encode_png(image)))
}

/// Иконка сервера: ровно 64×64, как ждёт Minecraft.
pub fn server_icon(image: &Image) -> Vec<u8> {
    encode_png(&image.resize(64, 64))
}

/// Может ли панель показать этот файл как картинку (по имени).
pub fn is_image(name: &str) -> bool {
    let lower = name.to_lowercase();
    [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}
