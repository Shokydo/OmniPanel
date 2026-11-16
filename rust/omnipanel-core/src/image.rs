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

/// Читает PNG (8 бит, без палитры и без чередования).
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
            b"IDAT" => compressed.extend_from_slice(body),
            b"IEND" => break,
            _ => {}
        }
        at = end + 4; /* + CRC */
    }

    if width == 0 || height == 0 {
        return Err(fail("В PNG нет размеров картинки"));
    }
    if depth != 8 {
        return Err(fail("PNG с глубиной цвета не 8 бит панель не читает"));
    }
    if interlace != 0 {
        return Err(fail("Чересстрочный PNG панель не читает"));
    }
    let channels = match color {
        0 => 1, /* оттенки серого */
        2 => 3, /* RGB */
        4 => 2, /* серый + прозрачность */
        6 => 4, /* RGBA */
        _ => return Err(fail("Палитровый PNG панель не читает")),
    };
    let raw = super::zip::inflate_raw(&un_zlib(&compressed)?)?;
    let stride = (width as usize) * channels;
    if raw.len() < (stride + 1) * height as usize {
        return Err(fail("В PNG не хватает данных"));
    }

    let mut image = Image::new(width, height);
    let mut previous = vec![0u8; stride];
    let mut line = vec![0u8; stride];
    for y in 0..height as usize {
        let row = y * (stride + 1);
        let filter = raw[row];
        line.copy_from_slice(&raw[row + 1..row + 1 + stride]);
        unfilter(filter, &mut line, &previous, channels)?;
        for x in 0..width as usize {
            let pixel = match channels {
                1 => [line[x], line[x], line[x], 255],
                2 => [line[x * 2], line[x * 2], line[x * 2], line[x * 2 + 1]],
                3 => [line[x * 3], line[x * 3 + 1], line[x * 3 + 2], 255],
                _ => [line[x * 4], line[x * 4 + 1], line[x * 4 + 2], line[x * 4 + 3]],
            };
            image.set(x as u32, y as u32, pixel);
        }
        previous.copy_from_slice(&line);
    }
    Ok(image)
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
    decode_png(&data)
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
