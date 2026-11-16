// Проверки упаковки архива: сжали — распаковали — сравнили.
//
// Синхронизация отправляет сервер архивом, поэтому упаковщик обязан быть
// честным: любая ошибка в сжатии испортит мир на другой машине. Тесты
// гоняют и мелочь, и данные, которые не сжимаются, и русские имена файлов.
use omnipanel_core::deflate;
use omnipanel_core::zip;

fn roundtrip(data: &[u8]) {
    let packed = deflate::compress(data);
    let back = zip::inflate_raw(&packed).expect("распаковка сжатого");
    assert_eq!(back, data, "содержимое не совпало (длина {})", data.len());
}

#[test]
fn сжимает_и_возвращает_текст() {
    let text = "Сервер OmniPanel. ".repeat(200);
    roundtrip(text.as_bytes());
}

#[test]
fn пустые_и_короткие_данные() {
    roundtrip(b"");
    roundtrip(b"a");
    roundtrip(b"ab");
    roundtrip(b"abc");
}

#[test]
fn несжимаемые_данные() {
    /* псевдослучайные байты: совпадений почти нет, алгоритм не должен ломаться */
    let mut data = Vec::with_capacity(5000);
    let mut state = 0x1234_5678u32;
    for _ in 0..5000 {
        state = state.wrapping_mul(1_103_515_245).wrapping_add(12345);
        data.push((state >> 16) as u8);
    }
    roundtrip(&data);
}

#[test]
fn длинные_повторы() {
    /* совпадения длиннее окна и ровно 258 байт — крайние случаи кодов длины */
    roundtrip(&vec![7u8; 70_000]);
    roundtrip(&vec![0u8; 258]);
}

#[test]
fn архив_создаётся_и_читается() {
    let entries = vec![
        zip::NewEntry { name: "server.properties".to_string(), data: b"motd=OmniPanel\n".to_vec() },
        zip::NewEntry { name: "world/level.dat".to_string(), data: vec![0u8; 3000] },
        zip::NewEntry { name: "плагины/читай-меня.txt".to_string(), data: "привет".repeat(50).into_bytes() },
    ];
    let archive = zip::create(&entries);
    assert!(zip::is_zip(&archive), "архив должен опознаваться");
    let list = zip::list(&archive).unwrap();
    assert_eq!(list.len(), 3);
    for entry in &entries {
        let got = zip::read_by_name(&archive, &entry.name).unwrap();
        assert_eq!(got, entry.data, "файл {} распаковался неверно", entry.name);
    }
}

#[test]
fn архив_распаковывается_в_папку() {
    let dir = std::env::temp_dir().join(format!("omnipanel-archive-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let entries = vec![
        zip::NewEntry { name: "a.txt".to_string(), data: "раз".as_bytes().to_vec() },
        zip::NewEntry { name: "вложенная/б.txt".to_string(), data: "два".as_bytes().to_vec() },
    ];
    let archive = zip::create(&entries);
    let (count, bytes, _) = zip::extract(&archive, &dir, "").unwrap();
    assert_eq!(count, 2);
    assert_eq!(bytes, 12, "по шесть байт в кириллице на строку");
    assert_eq!(std::fs::read(dir.join("a.txt")).unwrap(), "раз".as_bytes());
    assert_eq!(std::fs::read(dir.join("вложенная").join("б.txt")).unwrap(), "два".as_bytes());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn архив_сжимает_лучше_исходника() {
    let text = "level.dat ".repeat(2000);
    let (packed, method) = deflate::compress_best(text.as_bytes());
    assert_eq!(method, 8, "текст должен сжиматься");
    assert!(packed.len() < text.len() / 5, "сжатие слабое: {} из {}", packed.len(), text.len());
}
