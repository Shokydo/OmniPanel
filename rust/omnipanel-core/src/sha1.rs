//! SHA-1: по нему GitHub и GitLab адресуют файлы внутри репозитория.
//!
//! Панели нужно своими руками посчитать «sha блоба» (git считает его от
//! содержимого с заголовком `blob <длина>\0`), чтобы понять, какие файлы
//! изменились с прошлой отправки. Криптостойкость здесь не важна — важен
//! точный ответ, поэтому реализация нарочно простая.

/// SHA-1 как 20 байт.
pub fn digest(data: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [0x6745_2301, 0xEFCD_AB89, 0x98BA_DCFE, 0x1032_5476, 0xC3D2_E1F0];
    let mut message = data.to_vec();
    let bit_len = (data.len() as u64) * 8;
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in message.chunks(64) {
        let mut w = [0u32; 80];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([chunk[i * 4], chunk[i * 4 + 1], chunk[i * 4 + 2], chunk[i * 4 + 3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let (mut a, mut b, mut c, mut d, mut e) = (h[0], h[1], h[2], h[3], h[4]);
        for (i, word) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | (!b & d), 0x5A82_7999u32),
                20..=39 => (b ^ c ^ d, 0x6ED9_EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1B_BCDC),
                _ => (b ^ c ^ d, 0xCA62_C1D6),
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
    }

    let mut out = [0u8; 20];
    for (i, word) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

/// SHA-1 в виде шестнадцатеричной строки.
pub fn hex(data: &[u8]) -> String {
    let mut out = String::with_capacity(40);
    for byte in digest(data) {
        out.push_str(&format!("{:02x}", byte));
    }
    out
}

/// Хеш файла так, как его считает git: `blob <длина>\0<содержимое>`.
pub fn blob_hex(data: &[u8]) -> String {
    let mut header = format!("blob {}\0", data.len()).into_bytes();
    header.extend_from_slice(data);
    hex(&header)
}
