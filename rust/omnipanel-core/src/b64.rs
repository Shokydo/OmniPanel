//! Base64: картинки в интерфейс и файлы из интерфейса.
//!
//! Панель передаёт картинки как `data:image/png;base64,...`, а перетащенные
//! файлы — base64-строкой. Своими руками, чтобы не тянуть крейт.

const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Кодирование в base64.
pub fn encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(triple >> 18) as usize & 63] as char);
        out.push(TABLE[(triple >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(triple >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[triple as usize & 63] as char } else { '=' });
    }
    out
}

/// Разбор base64. Лишние пробелы и переводы строк игнорируются,
/// `data:...;base64,` в начале — тоже.
pub fn decode(text: &str) -> Result<Vec<u8>, String> {
    let body = match text.find(";base64,") {
        Some(at) => &text[at + 8..],
        None => text,
    };
    let mut out = Vec::with_capacity(body.len() * 3 / 4 + 3);
    let mut buf: u32 = 0;
    let mut bits: u32 = 0;
    for ch in body.chars() {
        let value = match ch {
            'A'..='Z' => ch as u32 - 'A' as u32,
            'a'..='z' => ch as u32 - 'a' as u32 + 26,
            '0'..='9' => ch as u32 - '0' as u32 + 52,
            '+' => 62,
            '/' => 63,
            '=' => break,
            ' ' | '\n' | '\r' | '\t' => continue,
            other => return Err(format!("непонятный символ в base64: «{}»", other)),
        };
        buf = (buf << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn короткие_строки_кодируются() {
        assert_eq!(encode(b""), "");
        assert_eq!(encode(b"f"), "Zg==");
        assert_eq!(encode(b"fo"), "Zm8=");
        assert_eq!(encode(b"foo"), "Zm9v");
        assert_eq!(encode(b"foob"), "Zm9vYg==");
    }

    #[test]
    fn картинка_из_интерфейса_разбирается() {
        let data = decode("data:image/png;base64,iVBORw0KGgo=").unwrap();
        assert_eq!(data, vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    }

    #[test]
    fn переводы_строк_не_мешают() {
        assert_eq!(decode("Zm9v\nYmFy").unwrap(), b"foobar");
    }

    #[test]
    fn мусор_даёт_понятную_ошибку() {
        assert!(decode("привет!!").unwrap_err().contains("base64"));
    }
}
