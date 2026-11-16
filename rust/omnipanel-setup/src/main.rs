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

#![cfg_attr(all(windows, not(test)), windows_subsystem = "windows")]

use omnipanel_core::zip;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

/// Версия сборки — из Cargo.toml, её пишет скрипт сборки перед компиляцией.
fn setup_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

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
        "--default-dir" => println!("{}", default_dir().display()),
        /* мастер установки передаёт папку, выбранную человеком */
        "--install-dir" => {
            let dir = args.get(2).map(PathBuf::from).unwrap_or_else(default_dir);
            let run = !args.iter().any(|a| a == "--no-run");
            let desktop = !args.iter().any(|a| a == "--no-desktop");
            match install_into(&dir, desktop, run) {
                Ok(()) => println!("OmniPanel установлен в {}", dir.display()),
                Err(err) => fail(&err),
            }
        }
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

/// Куда ставим панель по умолчанию.
pub fn install_dir() -> PathBuf {
    #[cfg(windows)]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            return PathBuf::from(local).join("OmniPanel");
        }
    }
    std::env::temp_dir().join("OmniPanel")
}

/// Путь прошлой установки из реестра — чтобы при обновлении не спрашивать заново.
pub fn default_dir() -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(dir) = registry_value("InstallDir") {
            if !dir.trim().is_empty() {
                return PathBuf::from(dir);
            }
        }
    }
    install_dir()
}

/// Значение из `HKCU\Software\OmniPanel` (пусто, если нет).
#[cfg_attr(not(windows), allow(dead_code))]
fn registry_value(name: &str) -> Option<String> {
    let mut command = std::process::Command::new("reg");
    command.args(["query", "HKCU\\Software\\OmniPanel", "/v", name]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let out = command.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    /* строка вида:  InstallDir    REG_SZ    C:\Users\…\OmniPanel */
    text.lines()
        .find(|line| line.trim_start().starts_with(name))
        .and_then(|line| line.split("REG_SZ").nth(1))
        .map(|value| value.trim().to_string())
}

/// Запоминаем папку и версию — для «Программы и компоненты» и для обновлений.
fn remember_install(dir: &Path) {
    let exe = std::env::current_exe().unwrap_or_default();
    let pairs = [
        ("InstallDir".to_string(), dir.display().to_string()),
        ("Uninstall".to_string(), format!("\"{}\" --uninstall", exe.display())),
    ];
    for (name, value) in pairs {
        let mut command = std::process::Command::new("reg");
        command.args(["add", "HKCU\\Software\\OmniPanel", "/v", &name, "/t", "REG_SZ", "/d", &value, "/f"]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let _ = command.output();
    }
    /* запись в списке установленных программ Windows */
    let exe = std::env::current_exe().unwrap_or_default();
    let key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\OmniPanel";
    let values = [
        ("DisplayName".to_string(), "OmniPanel".to_string()),
        (
            "DisplayVersion".to_string(),
            setup_version().to_string(),
        ),
        ("Publisher".to_string(), "OmniPanel".to_string()),
        ("InstallLocation".to_string(), dir.display().to_string()),
        (
            "DisplayIcon".to_string(),
            app_exe(dir).display().to_string(),
        ),
        (
            "UninstallString".to_string(),
            format!("\"{}\" --uninstall", exe.display()),
        ),
        ("NoModify".to_string(), "1".to_string()),
        ("NoRepair".to_string(), "1".to_string()),
    ];
    for (name, value) in values {
        let mut command = std::process::Command::new("reg");
        command.args(["add", key, "/v", &name, "/t", "REG_SZ", "/d", &value, "/f"]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let _ = command.output();
    }
}

fn forget_install() {
    for key in [
        "HKCU\\Software\\OmniPanel",
        "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\OmniPanel",
    ] {
        let mut command = std::process::Command::new("reg");
        command.args(["delete", key, "/f"]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let _ = command.output();
    }
}

/// Закрывает уже запущенную панель: иначе Windows не даст перезаписать её файлы
/// («файл занят другим процессом») и обновление срывалось бы.
fn stop_running_panel() {
    #[cfg(windows)]
    {
        for name in ["OmniPanel.exe", "omnipanel-core.exe", "omnipanel.exe"] {
            let mut command = std::process::Command::new("taskkill");
            command.args(["/IM", name, "/F", "/T"]);
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
            let _ = command.output();
            /* даём Windows отпустить файлы */
            std::thread::sleep(std::time::Duration::from_millis(400));
        }
    }
}

/// Установка в выбранную папку — этим пользуется мастер установки.
pub fn install_into(dir: &Path, desktop: bool, run: bool) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    /* панель может быть запущена — закрываем её перед распаковкой */
    if app_exe(dir).exists() {
        println!("панель уже стоит в {} — обновляю", dir.display());
        stop_running_panel();
    }
    let count = unpack(&exe, dir)?;
    shortcuts(dir, desktop)?;
    remember_install(dir);
    println!("распаковано файлов: {}", count);
    if run {
        launch(&app_exe(dir), dir)?;
    }
    Ok(())
}

/// Окно установщика: раскрывается, только если внутри есть панель.
fn wizard() -> Result<(), String> {
    #[cfg(windows)]
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        let script = std::env::temp_dir().join("omnipanel-install.ps1");
        /* UTF-8 с BOM: Windows PowerShell 5.1 иначе читает файл как cp1251 */
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(include_str!("../installer.ps1").as_bytes());
        std::fs::write(&script, &bytes).map_err(|e| format!("не создать мастер: {}", e))?;
        let status = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-STA",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                &script.display().to_string(),
                "-SetupExe",
                &exe.display().to_string(),
                "-Version",
                setup_version(),
                "-DefaultDir",
                &default_dir().display().to_string(),
            ])
            .status();
        let _ = std::fs::remove_file(&script);
        return match status {
            Ok(_) => Ok(()),
            /* PowerShell почему-то нет — ставим без окна, в папку по умолчанию */
            Err(_) => install_into(&default_dir(), true, true),
        };
    }
    #[cfg(not(windows))]
    install_into(&default_dir(), true, true)
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

    /* Внутри есть панель — всегда показываем мастер: человек сам говорит,
       куда ставить. Раньше при уже установленной панели установщик молча
       запускал старую версию и ничего не обновлял. */
    if payload_offset(&exe).is_ok() {
        return wizard();
    }

    /* это не установщик, а сама панель (или её ярлык) — запускаем её */
    let dir = default_dir();
    let installed = app_exe(&dir);
    if !installed.exists() {
        return Err("панель не установлена — запустите установщик OmniPanel".to_string());
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
    let dir = default_dir();
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
    forget_install();
    #[cfg(windows)]
    {
        let script = "$s=(New-Object -ComObject WScript.Shell); \
             foreach($p in @([Environment]::GetFolderPath('Desktop')+'\\OmniPanel.lnk', \
             [Environment]::GetFolderPath('Programs')+'\\OmniPanel.lnk')) {{ \
             if (Test-Path $p) {{ Remove-Item $p -Force }} }}";
        let _ = std::process::Command::new("powershell")
            .args(["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-Command", script])
            .status();
    }
    Ok(())
}

/// Ярлыки на рабочем столе и в меню «Пуск» — через PowerShell, он есть всегда.
#[cfg(windows)]
fn shortcuts(dir: &Path, desktop: bool) -> Result<(), String> {
    let exe = app_exe(dir);
    /* меню «Пуск» — всегда, рабочий стол — если переключатель включён */
    let targets = if desktop {
        "@([Environment]::GetFolderPath('Desktop')+'\\OmniPanel.lnk', [Environment]::GetFolderPath('Programs')+'\\OmniPanel.lnk')"
    } else {
        "@([Environment]::GetFolderPath('Programs')+'\\OmniPanel.lnk')"
    };
    let script = format!(
        "$s=(New-Object -ComObject WScript.Shell); \
         foreach($p in {}) {{ \
         $l=$s.CreateShortcut($p); $l.TargetPath='{}'; $l.WorkingDirectory='{}'; \
         $l.IconLocation='{},0'; $l.Save() }}",
        targets,
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
fn shortcuts(_dir: &Path, _desktop: bool) -> Result<(), String> {
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
    fn ставится_в_выбранную_папку() {
        let dir = temp("install");
        let exe = dir.join("setup.exe");
        std::fs::write(&exe, "MZ установщик").unwrap();
        let archive = dir.join("panel.zip");
        let data = tiny_zip(&[("OmniPanel.exe", "панель"), ("ui/index.html", "<html>")]);
        std::fs::write(&archive, &data).unwrap();
        append_payload(&exe, &archive).unwrap();

        /* папку выбирает человек в мастере — установка идёт ровно туда */
        let target = dir.join("Мои игры/OmniPanel");
        let count = unpack(&exe, &target).unwrap();
        assert_eq!(count, 2);
        assert!(target.join("OmniPanel.exe").exists());
        assert!(target.join("ui/index.html").exists());
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
