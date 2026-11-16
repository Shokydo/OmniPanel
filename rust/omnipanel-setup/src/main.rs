//! Установщик OmniPanel — один exe, внутри которого лежит панель.
//!
//! Первый запуск: распаковывает панель в `%LOCALAPPDATA%\OmniPanel`, делает
//! ярлыки на рабочем столе и в меню «Пуск», запускает панель.
//! Дальше:      тот же exe просто запускает уже установленную панель.
//!
//! Внутри exe zip-архив дописан в конец файла и помечен трейлером
//! `OMNIUPD1` + размер (8 байт, little-endian) — так же, как в прежнем
//! установщике на C, поэтому старые сборки и скрипты остаются совместимыми.
//!
//! Ничего внешнего не нужно: распаковка своя (модуль `zip` ядра), ярлыки —
//! через PowerShell, который в Windows есть всегда.

use omnipanel_core::zip;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

/// Метка встроенного архива.
const TRAILER_MAGIC: &[u8; 8] = b"OMNIUPD1";
const TRAILER_LEN: u64 = 16;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let command = args.get(1).map(|s| s.as_str()).unwrap_or("");

    match command {
        "--append" => {
            /* используется сборкой: дописать архив к готовому exe */
            let Some(exe) = args.get(2) else {
                fail("нужен путь к exe");
            };
            let Some(archive) = args.get(3) else {
                fail("нужен путь к архиву с панелью");
            };
            match append_payload(Path::new(exe), Path::new(archive)) {
                Ok(size) => println!(
                    "панель вложена в {} ({} МБ)",
                    exe,
                    size as f64 / 1048576.0
                ),
                Err(err) => fail(&err),
            }
        }
        "--selftest" => {
            /* проверка полезной нагрузки без установки: распаковать в папку */
            let (Some(exe), Some(dest)) = (args.get(2), args.get(3)) else {
                fail("нужен exe и папка для распаковки");
            };
            match self_test(Path::new(exe), Path::new(dest)) {
                Ok(count) => println!("проверка пройдена: {} файлов", count),
                Err(err) => fail(&err),
            }
        }
        "--uninstall" => match uninstall() {
            Ok(()) => println!("OmniPanel удалён"),
            Err(err) => fail(&err),
        },
        _ => match install_and_run() {
            Ok(()) => {}
            Err(err) => fail(&err),
        },
    }
}

fn fail(message: &str) -> ! {
    eprintln!("Ошибка: {}", message);
    #[cfg(windows)]
    {
        /* окна у установщика нет, поэтому показываем сообщение системой */
        let _ = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!(
                    "[System.Windows.Forms.MessageBox]::Show('{}','OmniPanel')",
                    message.replace('\'', " ")
                ),
            ])
            .status();
    }
    std::process::exit(1);
}

/* ───────────── полезная нагрузка ───────────── */

/// Дописывает архив в конец exe и ставит трейлер.
pub fn append_payload(exe: &Path, archive: &Path) -> Result<u64, String> {
    let data = std::fs::read(archive).map_err(|e| format!("не прочитать архив: {}", e))?;
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(exe)
        .map_err(|e| format!("не открыть exe: {}", e))?;
    file.write_all(&data).map_err(|e| format!("не записать архив: {}", e))?;
    file.write_all(TRAILER_MAGIC).map_err(|e| e.to_string())?;
    file.write_all(&(data.len() as u64).to_le_bytes()).map_err(|e| e.to_string())?;
    file.flush().map_err(|e| e.to_string())?;
    Ok(data.len() as u64)
}

/// Находит встроенный архив: смещение и размер в файле.
pub fn payload_offset(path: &Path) -> Result<(u64, u64), String> {
    let mut file = std::fs::File::open(path).map_err(|e| format!("не открыть файл: {}", e))?;
    let total = file.metadata().map_err(|e| e.to_string())?.len();
    if total < TRAILER_LEN {
        return Err("это не установщик OmniPanel — внутри нет панели".to_string());
    }
    file.seek(SeekFrom::End(-(TRAILER_LEN as i64))).map_err(|e| e.to_string())?;
    let mut trailer = [0u8; 16];
    file.read_exact(&mut trailer).map_err(|e| e.to_string())?;
    if &trailer[..8] != TRAILER_MAGIC {
        return Err("это не установщик OmniPanel — внутри нет панели".to_string());
    }
    let mut size = 0u64;
    for byte in trailer[8..].iter().rev() {
        size = (size << 8) | *byte as u64;
    }
    if size == 0 || size > total - TRAILER_LEN {
        return Err("панель внутри установщика повреждена".to_string());
    }
    Ok((total - TRAILER_LEN - size, size))
}

/// Читает встроенный архив в память.
pub fn payload_bytes(path: &Path) -> Result<Vec<u8>, String> {
    let (offset, size) = payload_offset(path)?;
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut data = vec![0u8; size as usize];
    file.read_exact(&mut data).map_err(|e| e.to_string())?;
    Ok(data)
}

/// Распаковывает панель в папку. Возвращает число файлов.
pub fn unpack(exe: &Path, dest: &Path) -> Result<usize, String> {
    let data = payload_bytes(exe)?;
    std::fs::create_dir_all(dest).map_err(|e| format!("не создать папку {}: {}", dest.display(), e))?;
    let (count, _, _) = zip::extract(&data, dest, "")?;
    if count == 0 {
        return Err("внутри установщика нет файлов панели".to_string());
    }
    Ok(count)
}

/* ───────────── установка ───────────── */

/// Куда ставим панель.
pub fn install_dir() -> PathBuf {
    #[cfg(windows)]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            return PathBuf::from(local).join("OmniPanel");
        }
    }
    std::env::temp_dir().join("OmniPanel")
}

/// Имя запускаемого файла панели.
fn app_exe(dir: &Path) -> PathBuf {
    /* окно на Tauri называется OmniPanel.exe, консольная панель — omnipanel-core */
    let names = if cfg!(windows) {
        ["OmniPanel.exe", "omnipanel-core.exe", "omnipanel.exe", "omnipanel-core", "omnipanel"]
    } else {
        ["omnipanel-core", "omnipanel", "OmniPanel", "omnipanel-core.exe", "OmniPanel.exe"]
    };
    for name in names {
        let candidate = dir.join(name);
        if candidate.exists() {
            return candidate;
        }
    }
    dir.join(names[0])
}

fn install_and_run() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = install_dir();

    /* уже установлено — просто запускаем */
    let installed = app_exe(&dir);
    if !installed.exists() {
        let count = unpack(&exe, &dir)?;
        shortcuts(&dir)?;
        println!("OmniPanel установлен в {} ({} файлов)", dir.display(), count);
    }
    launch(&installed, &dir)
}

fn launch(exe: &Path, dir: &Path) -> Result<(), String> {
    let mut command = std::process::Command::new(exe);
    command.current_dir(dir);
    /* установщик запустил панель — сам он больше не нужен */
    command
        .spawn()
        .map_err(|e| format!("не удалось запустить панель: {}", e))?;
    Ok(())
}

fn uninstall() -> Result<(), String> {
    let dir = install_dir();
    if !dir.exists() {
        return Err("панель не установлена".to_string());
    }
    /* панель может работать — закрываем её, иначе Windows не даст удалить файлы */
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/IM", "omnipanel-core.exe", "/F"])
            .status();
        let _ = std::process::Command::new("taskkill")
            .args(["/IM", "omnipanel.exe", "/F"])
            .status();
        let _ = std::process::Command::new("taskkill")
            .args(["/IM", "OmniPanel.exe", "/F"])
            .status();
    }
    std::fs::remove_dir_all(&dir).map_err(|e| format!("не удалить {}: {}", dir.display(), e))?;
    #[cfg(windows)]
    {
        let desktop = std::env::var("USERPROFILE")
            .map(|p| PathBuf::from(p).join("Desktop").join("OmniPanel.lnk"))
            .unwrap_or_default();
        let _ = std::fs::remove_file(desktop);
    }
    Ok(())
}

/// Ярлыки на рабочем столе и в меню «Пуск» — через PowerShell, он есть всегда.
#[cfg(windows)]
fn shortcuts(dir: &Path) -> Result<(), String> {
    let exe = app_exe(dir);
    let script = format!(
        "$s=(New-Object -ComObject WScript.Shell); \
         foreach($p in @([Environment]::GetFolderPath('Desktop')+'\\OmniPanel.lnk', \
         [Environment]::GetFolderPath('Programs')+'\\OmniPanel.lnk')) {{ \
         $l=$s.CreateShortcut($p); $l.TargetPath='{}'; $l.WorkingDirectory='{}'; \
         $l.IconLocation='{},0'; $l.Save() }}",
        exe.display(),
        dir.display(),
        exe.display()
    );
    std::process::Command::new("powershell")
        .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &script])
        .status()
        .map_err(|e| format!("не удалось создать ярлыки: {}", e))?;
    Ok(())
}

#[cfg(not(windows))]
fn shortcuts(_dir: &Path) -> Result<(), String> {
    Ok(())
}

fn self_test(exe: &Path, dest: &Path) -> Result<usize, String> {
    unpack(exe, dest)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("omnipanel-setup-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Собираем крошечный zip сами: заголовок + файл без сжатия.
    fn tiny_zip(files: &[(&str, &str)]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut central = Vec::new();
        for (name, body) in files {
            let offset = out.len() as u32;
            let crc = omnipanel_core::zip::crc32(body.as_bytes());
            let size = body.len() as u32;
            out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
            out.extend_from_slice(&20u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&crc.to_le_bytes());
            out.extend_from_slice(&size.to_le_bytes());
            out.extend_from_slice(&size.to_le_bytes());
            out.extend_from_slice(&(name.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(body.as_bytes());

            central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
            central.extend_from_slice(&20u16.to_le_bytes());
            central.extend_from_slice(&20u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&crc.to_le_bytes());
            central.extend_from_slice(&size.to_le_bytes());
            central.extend_from_slice(&size.to_le_bytes());
            central.extend_from_slice(&(name.len() as u16).to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u32.to_le_bytes());
            central.extend_from_slice(&offset.to_le_bytes());
            central.extend_from_slice(name.as_bytes());
        }
        let central_offset = out.len() as u32;
        out.extend_from_slice(&central);
        out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&(files.len() as u16).to_le_bytes());
        out.extend_from_slice(&(files.len() as u16).to_le_bytes());
        out.extend_from_slice(&(central.len() as u32).to_le_bytes());
        out.extend_from_slice(&central_offset.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out
    }

    #[test]
    fn панель_вкладывается_и_находится() {
        let dir = temp("append");
        let exe = dir.join("setup.exe");
        std::fs::write(&exe, "MZ экзешник").unwrap();
        let archive = dir.join("panel.zip");
        let data = tiny_zip(&[("omnipanel-core.exe", "панель"), ("ui/index.html", "<html>")]);
        std::fs::write(&archive, &data).unwrap();

        let size = append_payload(&exe, &archive).unwrap();
        assert_eq!(size as usize, data.len());
        let (offset, length) = payload_offset(&exe).unwrap();
        assert_eq!(length as usize, data.len());
        assert_eq!(offset as usize, "MZ экзешник".len(), "архив лежит сразу за exe");

        let unpacked = dir.join("распаковано");
        let count = unpack(&exe, &unpacked).unwrap();
        assert_eq!(count, 2);
        assert_eq!(std::fs::read_to_string(unpacked.join("ui/index.html")).unwrap(), "<html>");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn обычный_exe_не_принимается_за_установщик() {
        let dir = temp("plain");
        let exe = dir.join("просто.exe");
        std::fs::write(&exe, "MZ без панели внутри").unwrap();
        let err = payload_offset(&exe).unwrap_err();
        assert!(err.contains("это не установщик"), "ошибка: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn битый_трейлер_объясняется_по_русски() {
        let dir = temp("broken");
        let exe = dir.join("битый.exe");
        let mut data = "MZ".as_bytes().to_vec();
        data.extend_from_slice(TRAILER_MAGIC);
        data.extend_from_slice(&(9999u64).to_le_bytes());
        std::fs::write(&exe, &data).unwrap();
        let err = payload_offset(&exe).unwrap_err();
        assert!(err.contains("повреждена"), "ошибка: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
