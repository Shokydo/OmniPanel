/*!
 * Чтение `.7z` — глазами панели.
 *
 * Настоящий 7-Zip в тестах не нужен: панель разговаривает с консольным
 * 7-Zip обычным текстом и кодом возврата, поэтому тест подставляет свой
 * маленький «7-Zip» и проверяет, что панель читает список, файл и распаковку.
 * Главное, что проверяется: панель не падает, если 7-Zip нет вовсе, и честно
 * говорит об этом человеку.
 */

use omnipanel_core::backup;
use std::path::{Path, PathBuf};

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "omnipanel-7z-{}-{}-{}",
        name,
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Кладёт в папку свой «7-Zip», который отвечает как настоящий.
fn fake_seven(root: &Path) -> PathBuf {
    let dir = root.join("bin");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("7za");
    let script = r#"#!/bin/sh
# Подделка консольного 7-Zip: отвечает ровно тем, что читает панель.
mode=""
out=""
for arg in "$@"; do
  case "$arg" in
    l) mode="list" ;;
    x) mode="x" ;;
    -so) mode="stream" ;;
    -o*) out="${arg#-o}" ;;
  esac
done
if [ "$mode" = "list" ]; then
  cat <<'TXT'

Path = plugins/a.txt
Size = 12
Packed Size = 10
Attributes = A
Folder = -

Path = plugins
Size = 0
Packed Size = 0
Folder = +

Path = b.txt
Size = 6
Packed Size = 6
Attributes = A
Folder = -
TXT
  exit 0
fi
if [ "$mode" = "stream" ]; then
  printf 'привет, мир'
  exit 0
fi
if [ "$mode" = "x" ]; then
  mkdir -p "$out/plugins"
  printf 'привет, мир' > "$out/plugins/a.txt"
  printf 'второй' > "$out/b.txt"
  exit 0
fi
exit 1
"#;
    std::fs::write(&path, script).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).unwrap();
    }
    dir
}

#[test]
fn семь_зет_читается_своим_7_zip() {
    let root = temp_dir("read");
    let bin = fake_seven(&root);
    /* панель ищет 7-Zip в PATH — подставляем свою папку */
    std::env::set_var("PATH", format!("{}:/usr/bin:/bin", bin.display()));

    let archive = root.join("мир.7z");
    std::fs::write(&archive, b"7z\xbc\xaf\x27\x1c").unwrap();

    assert!(backup::available(), "свой 7-Zip не нашёлся");

    /* список: папки не считаются файлами, размеры разбираются */
    let entries = backup::list_7z(&archive).expect("список .7z не прочитался");
    assert_eq!(entries.len(), 2, "файлов: {}", entries.len());
    let first = &entries[0];
    assert_eq!(first.name, "plugins/a.txt");
    assert_eq!(first.size, 12);
    assert_eq!(first.packed, 10);
    assert_eq!(entries[1].name, "b.txt");

    /* файл целиком — через поток */
    let text = backup::read_7z(&archive, "plugins/a.txt").expect("файл из .7z не прочитался");
    assert_eq!(String::from_utf8_lossy(&text), "привет, мир");

    /* распаковка в папку и подсчёт */
    let dest = root.join("распаковано");
    std::fs::create_dir_all(&dest).unwrap();
    let (files, bytes) = backup::extract_7z(&archive, &dest, "").expect("распаковка .7z");
    assert_eq!(files, 2, "файлов распаковано: {}", files);
    assert!(bytes > 0);
    assert!(dest.join("b.txt").is_file());

    /* а теперь 7-Zip «пропал»: панель обязана не падать, а объяснить словами.
       Проверяем в том же тесте: PATH — общий на весь тестовый файл, и
       параллельный тест с другим PATH сломал бы этот. */
    std::env::set_var("PATH", "/nonexistent");
    assert!(!backup::available(), "7-Zip всё ещё находится");
    let err = backup::list_7z(&archive).unwrap_err();
    assert!(err.contains("7-Zip"), "ошибка: {err}");
    let err = backup::read_7z(&archive, "b.txt").unwrap_err();
    assert!(err.contains("7-Zip"), "ошибка: {err}");
    let err = backup::extract_7z(&archive, &dest, "").unwrap_err();
    assert!(err.contains("7-Zip"), "ошибка: {err}");
}
