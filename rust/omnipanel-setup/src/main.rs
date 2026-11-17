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
//! Окно установки рисуем сами (egui, `gui.rs`): выбор папки, поле для пути,
//! список шагов и кнопки — часть exe. Ни PowerShell, ни системных диалогов.
//! Если окно не открылось, работает запасной путь на Win32 (`mod win`).
//!
//! Распаковка своя (модуль `zip` ядра), ярлыки —
//! через PowerShell, который в Windows есть всегда.

#![cfg_attr(all(windows, not(test)), windows_subsystem = "windows")]

use omnipanel_core::zip;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

/* окно установщика рисуем сами (egui) — см. gui.rs */
mod gui;

/* ───────────── окна Windows своими руками, без PowerShell ───────────── */
///
/// Раньше окно мастера рисовал PowerShell-скрипт. Если PowerShell на машине
/// недоступен или сценарий падает, человек оставался без выбора папки — и
/// установщик молча ставил панель куда захотел. Теперь на этот случай есть
/// обычные окна Windows: выбор папки (shell32) и вопрос «Запустить?» (user32).
#[cfg(windows)]
mod win {
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Path, PathBuf};

    type Handle = *mut core::ffi::c_void;

    #[repr(C)]
    struct BrowseInfoW {
        owner: Handle,
        root: *const core::ffi::c_void,
        display_name: *mut u16,
        title: *const u16,
        flags: u32,
        callback: Option<extern "system" fn(Handle, u32, usize, isize) -> i32>,
        callback_data: isize,
        image: i32,
    }

    const BIF_RETURNONLYFSDIRS: u32 = 0x0001;
    const BIF_NEWDIALOGSTYLE: u32 = 0x0040;
    const BIF_EDITBOX: u32 = 0x0010;
    const BFFM_INITIALIZED: u32 = 0x0001;
    const BFFM_SETSELECTIONW: u32 = 0x0467;
    const MAX_PATH_LONG: usize = 1024;

    #[link(name = "shell32")]
    extern "system" {
        fn SHBrowseForFolderW(info: *mut BrowseInfoW) -> *mut core::ffi::c_void;
        fn SHGetPathFromIDListW(pidl: *const core::ffi::c_void, path: *mut u16) -> i32;
    }
    #[link(name = "ole32")]
    extern "system" {
        fn CoInitializeEx(reserved: *mut core::ffi::c_void, flags: u32) -> i32;
        fn CoTaskMemFree(ptr: *mut core::ffi::c_void);
    }
    #[link(name = "user32")]
    extern "system" {
        fn SendMessageW(hwnd: Handle, msg: u32, wparam: usize, lparam: isize) -> isize;
        fn MessageBoxW(hwnd: Handle, text: *const u16, caption: *const u16, utype: u32) -> i32;
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    extern "system" fn browse_callback(hwnd: Handle, msg: u32, _lp: usize, data: isize) -> i32 {
        if msg == BFFM_INITIALIZED && data != 0 {
            unsafe {
                SendMessageW(hwnd, BFFM_SETSELECTIONW, 1, data);
            }
        }
        0
    }

    /// Обычное окно Windows «выбери папку». Возвращает путь или None, если отменили.
    pub fn pick_folder(start: &Path) -> Option<PathBuf> {
        /* диалогу нужен COM: без него BIF_NEWDIALOGSTYLE не открывается */
        unsafe {
            CoInitializeEx(std::ptr::null_mut(), 0x2);
        }
        let title = wide("Куда установить OmniPanel");
        let mut start_wide = wide(&start.display().to_string());
        let mut buffer = [0u16; MAX_PATH_LONG];
        let mut info = BrowseInfoW {
            owner: std::ptr::null_mut(),
            root: std::ptr::null(),
            display_name: buffer.as_mut_ptr(),
            title: title.as_ptr(),
            flags: BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE | BIF_EDITBOX,
            callback: Some(browse_callback),
            callback_data: start_wide.as_mut_ptr() as isize,
            image: 0,
        };
        unsafe {
            let pidl = SHBrowseForFolderW(&mut info);
            if pidl.is_null() {
                return None;
            }
            let ok = SHGetPathFromIDListW(pidl, buffer.as_mut_ptr());
            CoTaskMemFree(pidl);
            if ok == 0 {
                return None;
            }
        }
        let len = buffer.iter().position(|c| *c == 0).unwrap_or(0);
        if len == 0 {
            return None;
        }
        Some(PathBuf::from(String::from_utf16_lossy(&buffer[..len])))
    }

    /// Сколько свободно на диске, где лежит папка (в байтах).
    pub fn free_space(path: &Path) -> Option<u64> {
        #[link(name = "kernel32")]
        extern "system" {
            fn GetDiskFreeSpaceExW(
                dir: *const u16,
                free_to_caller: *mut u64,
                total: *mut u64,
                total_free: *mut u64,
            ) -> i32;
        }
        let dir = wide(&path.display().to_string());
        let mut available: u64 = 0;
        let mut total: u64 = 0;
        let mut free: u64 = 0;
        let ok = unsafe { GetDiskFreeSpaceExW(dir.as_ptr(), &mut available, &mut total, &mut free) };
        if ok == 0 {
            None
        } else {
            Some(available)
        }
    }

    /// Вопрос с кнопками «Да / Нет».
    pub fn ask(text: &str) -> bool {
        let body = wide(text);
        let caption = wide("OmniPanel");
        const MB_YESNO: u32 = 0x0004;
        const MB_ICONQUESTION: u32 = 0x20;
        const IDYES: i32 = 6;
        let answer = unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                body.as_ptr(),
                caption.as_ptr(),
                MB_YESNO | MB_ICONQUESTION,
            )
        };
        answer == IDYES
    }
}

/// Свободное место — короткой строкой для окна установщика.
pub fn free_space_note(dir: &Path) -> String {
    #[cfg(windows)]
    {
        if let Some(bytes) = win::free_space(dir) {
            let gb = bytes as f64 / 1073741824.0;
            return if gb >= 1.0 {
                format!("свободно {:.0} ГБ", gb)
            } else {
                format!("свободно {:.0} МБ", bytes as f64 / 1048576.0)
            };
        }
        "место на диске не определить".to_string()
    }
    #[cfg(not(windows))]
    {
        let _ = dir;
        "место на диске не проверяется".to_string()
    }
}

/// Проверка папки ДО распаковки: создать, убедиться, что в неё можно писать.
/// Возвращает короткую строку для окна, ошибку — если папка не годится.
pub fn check_dir(dir: &Path) -> Result<String, String> {
    if dir.as_os_str().is_empty() {
        return Err("папка не указана".to_string());
    }
    std::fs::create_dir_all(dir).map_err(|err| format!("не создать папку: {}", err))?;
    let probe = dir.join(".omnipanel-проверка");
    std::fs::write(&probe, b"ok").map_err(|err| format!("в папку нельзя писать: {}", err))?;
    let _ = std::fs::remove_file(&probe);
    log_line(&format!("папка проверена: {}", dir.display()));
    Ok(format!("готова к записи, {}", free_space_note(dir)))
}

/// Установка обычными окнами Windows: выбрать папку → поставить → предложить запуск.
#[cfg(windows)]
fn native_install(reason: &str) -> Result<(), String> {
    log_line(&format!("перехожу на окна Windows: {}", reason));
    let start = default_dir();

    /* мастер не открылся — говорим причину прямо на экране, без журнала */
    if !reason.is_empty() {
        msgbox(&format!(
            "Мастер установки не открылся.\n\nПричина: {}\n\nСейчас выберу папку обычным окном Windows.",
            reason
        ));
    }

    let Some(dir) = win::pick_folder(&start) else {
        log_line("папку не выбрали — установка отменена");
        return Ok(());
    };
    log_line(&format!("выбрана папка: {}", dir.display()));

    match install_into(&dir, true, false) {
        Ok(()) => {
            let text = format!(
                "Панель установлена в:\n{}\n\nЗапустить её сейчас?",
                dir.display()
            );
            if win::ask(&text) {
                if let Err(err) = launch(&app_exe(&dir), &dir) {
                    let _ = err;
                    log_line("не удалось запустить панель после установки");
                    msgbox(&format!(
                        "Панель установлена, но запустить её не удалось.\n\nОткрой вручную:\n{}",
                        app_exe(&dir).display()
                    ));
                }
            }
            Ok(())
        }
        Err(err) => {
            log_line(&format!("установка не удалась: {}", err));
            msgbox(&format!(
                "OmniPanel не удалось установить в:\n{}\n\n{}\n\nЖурнал: {}",
                dir.display(),
                err,
                log_path().display()
            ));
            Err(err)
        }
    }
}

/// Версия сборки — из Cargo.toml, её пишет скрипт сборки перед компиляцией.
pub fn setup_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Куда писать журнал: временная папка, папка рядом с установщиком и
/// %LOCALAPPDATA%. Раньше журнала могло не быть вовсе — писали только в Temp.
pub fn log_paths() -> Vec<PathBuf> {
    let mut paths = vec![std::env::temp_dir().join("omnipanel-setup.log")];
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            paths.push(dir.join("OmniPanel-установка.log"));
        }
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        paths.push(PathBuf::from(local).join("OmniPanel-setup.log"));
    }
    paths
}

/// Первый журнал, который реально получилось создать (его и показываем людям).
pub fn log_path() -> PathBuf {
    log_paths()
        .into_iter()
        .find(|path| path.exists())
        .unwrap_or_else(|| std::env::temp_dir().join("omnipanel-setup.log"))
}

pub fn log_line(text: &str) {
    use std::io::Write;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut written = false;
    for path in log_paths() {
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            if writeln!(file, "[{}] {}", stamp, text).is_ok() {
                written = true;
            }
        }
    }
    if !written {
        eprintln!("[{}] {}", stamp, text);
    }
}

/// Своё окно с сообщением: системный MessageBox. Ошибка установщика не должна
/// исчезать молча — раньше установщик выходил без единого слова.
#[cfg(windows)]
pub fn msgbox(text: &str) {
    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(
            hwnd: *mut core::ffi::c_void,
            text: *const u16,
            caption: *const u16,
            utype: u32,
        ) -> i32;
    }
    let body: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let caption: Vec<u16> = "OmniPanel".encode_utf16().chain(std::iter::once(0)).collect();
    const MB_ICONWARNING: u32 = 0x30;
    unsafe {
        MessageBoxW(std::ptr::null_mut(), body.as_ptr(), caption.as_ptr(), MB_ICONWARNING);
    }
}

#[cfg(not(windows))]
pub fn msgbox(text: &str) {
    eprintln!("{}", text);
}

/// Метка встроенного архива.
const TRAILER_MAGIC: &[u8; 8] = b"OMNIUPD1";
const TRAILER_LEN: u64 = 16;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let command = args.get(1).map(|s| s.as_str()).unwrap_or("");
    /* журналы прошлого запуска убираем: нужен только свежий */
    for path in log_paths() {
        let _ = std::fs::remove_file(path);
    }
    log_line(&format!(
        "OmniPanel установщик {} — запуск: {:?}",
        setup_version(),
        args
    ));

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
        /* диагностика: если окно не открывается, видно, что установщик видит */
        "--diagnose" => {
            let exe = std::env::current_exe().unwrap_or_default();
            let dir = default_dir();
            let mut lines: Vec<String> = Vec::new();
            lines.push(format!("OmniPanel установщик {}", setup_version()));
            lines.push(format!("файл: {}", exe.display()));
            match payload_offset(&exe) {
                Ok((offset, size)) => {
                    let text = format!("панель внутри: {} байт со смещения {}", size, offset);
                    log_line(&text);
                    lines.push(text);
                }
                Err(err) => {
                    let text = format!("панель внутри НЕ найдена: {}", err);
                    log_line(&text);
                    lines.push(text);
                }
            }
            lines.push(format!("папка по умолчанию: {}", dir.display()));
            lines.push(format!(
                "панель там уже стоит: {}",
                if app_exe(&dir).exists() { "да" } else { "нет" }
            ));
            /* PowerShell больше не нужен: окно, ярлыки и выбор папки — свои */
            lines.push("PowerShell: не нужен".to_string());
            lines.push(String::new());
            lines.push(format!("Журнал: {}", log_path().display()));
            let report = lines.join("\n");
            log_line(&report.replace('\n', " | "));
            println!("{}", report);
            #[cfg(windows)]
            msgbox(&report);
        }
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
        _ => {
            /* окно установщика рисуем сами: ни PowerShell, ни системных окон.
               Если окно не открылось (нет OpenGL, урезанная среда) — работаем
               обычными окнами Windows, но папку всё равно выбирает человек. */
            log_line("открываю окно установщика");
            if let Err(err) = gui::run() {
                let reason = format!("окно установщика не открылось: {}", err);
                log_line(&reason);
                #[cfg(windows)]
                {
                    if let Err(err) = native_install(&reason) {
                        fail(&err);
                    }
                }
                #[cfg(not(windows))]
                {
                    if let Err(err) = install_and_run() {
                        fail(&err);
                    }
                }
            }
        }
    }
}

fn fail(message: &str) -> ! {
    eprintln!("Ошибка: {}", message);
    log_line(&format!("ошибка: {}", message));
    #[cfg(windows)]
    {
        msgbox(&format!("{}\n\nЖурнал: {}", message, log_path().display()));
        if log_path().exists() {
            let _ = std::process::Command::new("notepad").arg(log_path()).spawn();
        }
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
pub fn remember_install(dir: &Path) {
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
pub fn stop_running_panel() {
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
    log_line(&format!("распаковано файлов: {} → {}", count, dir.display()));
    shortcuts(dir, desktop)?;
    remember_install(dir);
    println!("распаковано файлов: {}", count);
    if run {
        launch(&app_exe(dir), dir)?;
    }
    Ok(())
}

/// Окно установщика: раскрывается, только если внутри есть панель.
pub fn app_exe(dir: &Path) -> PathBuf {
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

    /* Внутри есть панель — открываем окно установки: человек сам говорит,
       куда ставить. Раньше при уже установленной панели установщик молча
       запускал старую версию и ничего не обновлял. */
    if payload_offset(&exe).is_ok() {
        gui::run().map_err(|err| format!("окно установщика не открылось: {}", err))?;
        return Ok(());
    }

    /* это не установщик, а сама панель (или её ярлык) — запускаем её */
    let dir = default_dir();
    let installed = app_exe(&dir);
    if !installed.exists() {
        return Err("панель не установлена — запустите установщик OmniPanel".to_string());
    }
    launch(&installed, &dir)
}

pub fn launch(exe: &Path, dir: &Path) -> Result<(), String> {
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
        let removed = omnipanel_core::shortcut::remove("OmniPanel.lnk");
        log_line(&format!("ярлыков удалено: {}", removed));
    }
    Ok(())
}

/// Ярлыки на рабочем столе и в меню «Пуск» — своим кодом, без PowerShell.
///
/// Раньше их создавал PowerShell (`WScript.Shell`), и при установке мигало его
/// окно. Теперь файл .lnk собирается по спецификации MS-SHLLINK (модуль
/// `shortcut` ядра) — окно не появляется вовсе.
#[cfg(windows)]
pub fn shortcuts(dir: &Path, desktop: bool) -> Result<(), String> {
    use omnipanel_core::shortcut;
    let exe = app_exe(dir);
    let mut made = 0;

    if desktop {
        if let Some(desk) = shortcut::desktop_dir() {
            shortcut::create(&desk.join("OmniPanel.lnk"), &exe, dir, "OmniPanel", Some(&exe))?;
            made += 1;
        }
    }
    if let Some(programs) = shortcut::programs_dir() {
        let folder = programs.join("OmniPanel");
        shortcut::create(&folder.join("OmniPanel.lnk"), &exe, dir, "OmniPanel", Some(&exe))?;
        made += 1;
    }
    if made == 0 {
        return Err("не найти папку рабочего стола и меню «Пуск»".to_string());
    }
    log_line(&format!("ярлыков создано: {}", made));
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

    #[test]
    fn пустая_папка_отвергается() {
        assert!(check_dir(Path::new("")).is_err());
    }

    #[test]
    fn папка_создаётся_и_проверяется_на_запись() {
        let dir = temp("проверка-папки");
        let _ = std::fs::remove_dir_all(&dir);
        let note = check_dir(&dir).expect("папка должна приниматься");
        assert!(note.contains("готова к записи"), "подпись: {note}");
        assert!(!dir.join(".omnipanel-проверка").exists(), "пробный файл удаляется");
        /* второй раз тоже без ошибки: папка уже есть */
        assert!(check_dir(&dir).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn свободное_место_описывается_строкой() {
        let note = free_space_note(&std::env::temp_dir());
        assert!(!note.is_empty());
    }
}
