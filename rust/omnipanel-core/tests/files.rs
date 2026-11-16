// Проверки файлового слоя: безопасные пути, список, чтение/запись, перенос, поиск.
use omnipanel_core::files::{FileError, Files};
use std::fs;
use std::path::PathBuf;

fn temp_root(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("omnipanel-core-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn путь_внутрь_папки_сервера() {
    let root = temp_root("inside");
    let files = Files::new(&root);
    assert_eq!(files.resolve("plugins/EssentialsX.jar").unwrap(), root.join("plugins/EssentialsX.jar"));
    assert_eq!(files.resolve("./logs/./latest.log").unwrap(), root.join("logs/latest.log"));
    assert_eq!(files.resolve("").unwrap(), root);
    assert_eq!(files.resolve("/server.properties").unwrap(), root.join("server.properties"));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn нельзя_выйти_за_папку_сервера() {
    let root = temp_root("outside");
    let files = Files::new(&root);
    assert!(matches!(files.resolve("../секрет.txt"), Err(FileError::Outside(_))));
    assert!(matches!(files.resolve("plugins/../../секрет.txt"), Err(FileError::Outside(_))));
    assert!(matches!(files.resolve("C:\\Windows\\win.ini"), Err(FileError::Outside(_))));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn список_папок_идёт_сначала_папки_и_по_алфавиту() {
    let root = temp_root("list");
    fs::create_dir_all(root.join("plugins")).unwrap();
    fs::write(root.join("b.txt"), "б").unwrap();
    fs::write(root.join("a.txt"), "а").unwrap();
    let files = Files::new(&root);
    let list = files.list("").unwrap();
    assert_eq!(list[0].name, "plugins");
    assert!(list[0].dir);
    assert_eq!(list[1].name, "a.txt");
    assert_eq!(list[2].name, "b.txt");
    assert_eq!(list[1].rel, "a.txt");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn чтение_и_запись_текста() {
    let root = temp_root("readwrite");
    let files = Files::new(&root);
    files.write_text("config/новый.yml", "привет\n").unwrap();
    assert_eq!(files.read_text("config/новый.yml").unwrap(), "привет\n");
    let list = files.list("config").unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].size, "привет\n".len() as u64);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn слишком_большой_файл_в_редактор_не_открывается() {
    let root = temp_root("big");
    let files = Files::new(&root);
    let big = "x".repeat((omnipanel_core::files::MAX_TEXT + 10) as usize);
    files.write_text("big.log", &big).unwrap();
    assert!(matches!(files.read_text("big.log"), Err(FileError::TooLarge(_))));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn переименование_и_запрет_подмены_имени() {
    let root = temp_root("rename");
    let files = Files::new(&root);
    files.write_text("a.txt", "1").unwrap();
    assert_eq!(files.rename("a.txt", "b.txt").unwrap(), "b.txt");
    assert!(files.read_text("b.txt").is_ok());
    assert!(matches!(files.rename("b.txt", "../убежал.txt"), Err(FileError::Outside(_))));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn перенос_в_другую_папку_и_запрет_внутрь_себя() {
    let root = temp_root("move");
    let files = Files::new(&root);
    files.write_text("a.txt", "1").unwrap();
    files.mkdir("plugins").unwrap();
    assert_eq!(files.move_to("a.txt", "plugins").unwrap(), "plugins/a.txt");
    assert!(files.read_text("plugins/a.txt").is_ok());
    assert!(files.read_text("a.txt").is_err(), "исходника больше нет");

    fs::create_dir_all(root.join("plugins/sub")).unwrap();
    assert!(matches!(files.move_to("plugins", "plugins/sub"), Err(FileError::Io(_))));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn удаление_папки_с_содержимым() {
    let root = temp_root("remove");
    let files = Files::new(&root);
    files.write_text("logs/1.log", "1").unwrap();
    files.write_text("logs/2.log", "2").unwrap();
    files.remove("logs").unwrap();
    assert!(matches!(files.list("logs"), Err(FileError::NotFound(_))));
    assert!(matches!(files.remove(""), Err(FileError::Outside(_))), "корень не удаляем");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn поиск_по_имени_без_учёта_регистра() {
    let root = temp_root("search");
    let files = Files::new(&root);
    files.write_text("plugins/EssentialsX.jar", "").unwrap();
    files.write_text("plugins/essentials-chat.jar", "").unwrap();
    files.write_text("logs/latest.log", "").unwrap();
    let found = files.search("ESSENTIALS", 10).unwrap();
    assert_eq!(found.len(), 2);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn подпись_папки_считает_файлы_и_байты() {
    let root = temp_root("signature");
    let files = Files::new(&root);
    files.write_text("a.txt", "12345").unwrap();
    files.write_text("sub/b.txt", "12").unwrap();
    let (count, bytes, _newest) = files.dir_signature();
    assert_eq!(count, 2);
    assert_eq!(bytes, 7);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn лог_в_windows_1251_читается_по_русски() {
    let root = temp_root("cp1251");
    let files = Files::new(&root);
    /* «Привет» в Windows-1251 */
    let bytes: Vec<u8> = vec![0xCF, 0xF0, 0xE8, 0xE2, 0xE5, 0xF2];
    fs::write(root.join("old.log"), &bytes).unwrap();
    assert_eq!(files.read_text("old.log").unwrap(), "Привет");
    let _ = fs::remove_dir_all(&root);
}
