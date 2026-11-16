// Проверки архивов: список файлов, чтение и распаковка.
//
// Архивы в tests/fixtures собраны настоящим zip-архиватором (Python zipfile),
// а не нашим кодом — иначе тест проверял бы сам себя. Внутри есть и метод 0
// (без сжатия), и метод 8 на всех уровнях, и файл на 200 КБ с длинными
// совпадениями, и кириллица в именах.
use omnipanel_core::zip::{crc32, extract, inflate_raw, is_zip, list, read_by_name, read_entry};
use std::fs;
use std::path::{Path, PathBuf};

fn fixture(name: &str) -> Vec<u8> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name);
    fs::read(&path).unwrap_or_else(|e| panic!("нет файла {}: {e}", path.display()))
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("omnipanel-zip-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn архив_узнаётся_по_сигнатуре() {
    assert!(is_zip(&fixture("простой.zip")));
    assert!(!is_zip("это просто текст, а не архив".as_bytes()));
    assert!(!is_zip(b""));
    assert!(!is_zip(&vec![0u8; 100]));
}

#[test]
fn список_файлов_без_папок() {
    let data = fixture("простой.zip");
    let entries = list(&data).unwrap();
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names.len(), 4, "папка plugins/ в список не попадает: {names:?}");
    assert!(names.contains(&"plugins/config.yml"));
    assert!(names.contains(&"server.properties"));
    assert!(names.contains(&"world/level.dat"));
    assert!(names.contains(&"пусто/файл.txt"), "кириллица в имени файла: {names:?}");
    let config = entries.iter().find(|e| e.name == "plugins/config.yml").unwrap();
    assert_eq!(config.method, 8, "файл сжат");
    assert!(config.size > 0 && config.packed > 0, "размеры записаны");
}

#[test]
fn текст_из_архива_читается_по_русски() {
    let data = fixture("простой.zip");
    let content = read_by_name(&data, "plugins/config.yml").unwrap();
    assert_eq!(String::from_utf8(content).unwrap(), "motd: Привет, мир!\nslots: 20\n");
}

#[test]
fn файл_без_сжатия_читается() {
    let data = fixture("несжатый.zip");
    let entries = list(&data).unwrap();
    assert_eq!(entries[0].method, 0);
    let content = read_by_name(&data, "readme.txt").unwrap();
    assert_eq!(String::from_utf8(content).unwrap(), "просто текст без сжатия\n".repeat(3));
}

#[test]
fn все_уровни_сжатия_распаковываются() {
    let data = fixture("уровни.zip");
    let entries = list(&data).unwrap();
    assert_eq!(entries.len(), 9, "по файлу на каждый уровень сжатия");
    let mut texts = Vec::new();
    for entry in &entries {
        let content = read_entry(&data, entry).unwrap();
        let text = String::from_utf8(content).unwrap();
        assert!(text.contains("строка текста для сжатия 39"), "{} распакован", entry.name);
        texts.push(text);
    }
    assert!(texts.windows(2).all(|w| w[0] == w[1]), "все уровни дают одинаковый текст");
}

#[test]
fn большой_файл_распаковывается_целиком() {
    let data = fixture("большой.zip");
    let entries = list(&data).unwrap();
    let entry = &entries[0];
    assert!(entry.size > 500_000, "файл достаточно большой: {}", entry.size);
    let content = read_entry(&data, entry).unwrap();
    assert_eq!(content.len() as u64, entry.size, "длина совпала с записанной в архиве");
    assert_eq!(crc32(&content), entry.crc(), "контрольная сумма совпала");
}

#[test]
fn распаковка_в_папку_сохраняет_структуру() {
    let data = fixture("простой.zip");
    let dir = temp_dir("extract");
    let (count, bytes, names) = extract(&data, &dir, "").unwrap();
    assert_eq!(count, 4);
    assert!(bytes > 0);
    assert!(names.iter().any(|n| n == "plugins/config.yml"));
    assert_eq!(
        fs::read_to_string(dir.join("plugins/config.yml")).unwrap(),
        "motd: Привет, мир!\nslots: 20\n"
    );
    assert!(dir.join("world/level.dat").is_file());
    assert!(dir.join("пусто/файл.txt").is_file(), "кириллическая папка создана");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn распаковка_одного_файла() {
    let data = fixture("простой.zip");
    let dir = temp_dir("extract-one");
    let (count, _, names) = extract(&data, &dir, "server.properties").unwrap();
    assert_eq!(count, 1);
    assert_eq!(names, vec!["server.properties".to_string()]);
    assert!(dir.join("server.properties").is_file());
    assert!(!dir.join("plugins").exists(), "остальное не распаковано");
    let err = extract(&data, &dir, "нет-такого.txt").unwrap_err();
    assert!(err.contains("нет такого файла"), "ошибка: {err}");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn запрос_несуществующего_файла_объясняется_по_русски() {
    let data = fixture("простой.zip");
    let err = read_by_name(&data, "нет-такого.txt").unwrap_err();
    assert!(err.contains("В архиве нет файла"), "ошибка: {err}");
}

#[test]
fn распаковщик_понимает_простые_потоки() {
    /* «hello» сжатый deflate: 05 c8 48 cd c9 c9 07 00 */
    let packed = [0xcb, 0x48, 0xcd, 0xc9, 0xc9, 0x07, 0x00];
    assert_eq!(inflate_raw(&packed).unwrap(), b"hello");
    /* несжатый блок: last=1, type=0, len=5, nlen=~5 */
    let stored = [0x01, 0x05, 0x00, 0xfa, 0xff, b'w', b'o', b'r', b'l', b'd'];
    assert_eq!(inflate_raw(&stored).unwrap(), b"world");
    assert!(inflate_raw(&[]).unwrap_err().contains("оборвался"));
}

#[test]
fn битый_архив_не_роняет_панель() {
    let good = fixture("простой.zip");
    let broken = &good[..good.len() / 2];
    let result = list(broken);
    if let Ok(entries) = result {
        /* даже если список частично прочитан, чтение файла должно ругаться словами */
        if let Some(entry) = entries.first() {
            let err = read_entry(broken, entry).unwrap_err();
            assert!(!err.is_empty());
        }
    }
    let мусор = b"PK\x03\x04 this is garbage instead of headers";
    assert!(list(мусор).is_err());
}
