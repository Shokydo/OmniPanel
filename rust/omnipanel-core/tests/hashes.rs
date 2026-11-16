// Проверки своих хешей: по ним панель понимает, что файл изменился.
//
// Значения в тестах — эталонные: такие же считают git и любой калькулятор
// SHA-1/SHA-256. Если совпало — сравнение с GitHub будет честным.
use omnipanel_core::{sha1, sha256};

#[test]
fn sha256_эталон() {
    assert_eq!(sha256::hex(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert_eq!(sha256::hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    let long = "a".repeat(1000);
    assert_eq!(
        sha256::hex(long.as_bytes()),
        "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3"
    );
}

#[test]
fn sha256_файл_считается_с_диска() {
    let path = std::env::temp_dir().join(format!("omnipanel-sha256-{}.txt", std::process::id()));
    std::fs::write(&path, b"abc").unwrap();
    assert_eq!(
        sha256::file_hex(&path).unwrap(),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    let _ = std::fs::remove_file(&path);
}

#[test]
fn sha1_эталон() {
    assert_eq!(sha1::hex(b""), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
    assert_eq!(sha1::hex(b"abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
}

#[test]
fn sha1_блоба_как_в_git() {
    /* git hash-object для файла «привет» — эталон из git */
    assert_eq!(sha1::blob_hex(b"test content\n"), "d670460b4b4aece5915caf5c68d12f560a9fe3e4");
    assert_eq!(sha1::blob_hex(b""), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
}
