//! Системные окна и уведомления Windows — напрямую, без PowerShell.
//!
//! Раньше выбор папки и уведомления шли через PowerShell со WinForms: работало,
//! но при каждом вызове мигало окно консоли, а на машине, где PowerShell
//! порезан политикой, кнопка просто молчала. Здесь те же окна, но родными
//! вызовами Windows: `SHBrowseForFolderW` (выбор папки), `GetOpenFileNameW`
//! (выбор файла) и `Shell_NotifyIconW` (уведомление в области уведомлений).
//!
//! Всё, что можно проверить без Windows, вынесено наружу без `cfg(windows)` —
//! преобразование строк и буферов тестируется на любой системе.

/* ───────────────────────── переносимая часть ───────────────────────── */

/// Строка в UTF-16 с завершающим нулём — так Windows ждёт все строки.
pub fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Достаёт строку из буфера до первого нуля.
pub fn from_wide(buffer: &[u16]) -> String {
    let len = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..len])
}

/// Записывает строку в буфер фиксированной длины, обрезая по границе.
pub fn put_wide(buffer: &mut [u16], text: &str) {
    let mut filled = 0;
    for unit in text.encode_utf16() {
        if filled + 1 >= buffer.len() {
            break;
        }
        buffer[filled] = unit;
        filled += 1;
    }
    buffer[filled] = 0;
}

/// Строка фильтров для окна выбора файла: «подпись\0шаблон\0 … \0».
pub fn filter_string(pairs: &[(&str, &str)]) -> Vec<u16> {
    let mut out: Vec<u16> = Vec::new();
    for (label, pattern) in pairs {
        out.extend(wide(label));
        out.extend(wide(pattern));
    }
    out.push(0);
    out
}

/* ───────────────────────── Windows ───────────────────────── */

#[cfg(windows)]
mod native {
    use super::{filter_string, from_wide, put_wide, wide};
    use std::path::PathBuf;

    type Handle = *mut core::ffi::c_void;

    /* ── выбор папки ── */

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

    #[link(name = "shell32")]
    extern "system" {
        fn SHBrowseForFolderW(info: *mut BrowseInfoW) -> *mut core::ffi::c_void;
        fn SHGetPathFromIDListW(pidl: *const core::ffi::c_void, path: *mut u16) -> i32;
        fn SHGetFolderPathW(
            hwnd: Handle,
            csidl: i32,
            token: Handle,
            flags: u32,
            path: *mut u16,
        ) -> i32;
    }
    #[link(name = "ole32")]
    extern "system" {
        pub fn CoInitializeEx(reserved: Handle, flags: u32) -> i32;
        fn CoTaskMemFree(ptr: *mut core::ffi::c_void);
    }
    #[link(name = "user32")]
    extern "system" {
        fn SendMessageW(hwnd: Handle, msg: u32, wparam: usize, lparam: isize) -> isize;
        fn CreateWindowExW(
            ex_style: u32,
            class_name: *const u16,
            window_name: *const u16,
            style: u32,
            x: i32,
            y: i32,
            width: i32,
            height: i32,
            parent: Handle,
            menu: Handle,
            instance: Handle,
            param: *mut core::ffi::c_void,
        ) -> Handle;
        fn DestroyWindow(hwnd: Handle) -> i32;
        fn LoadIconW(instance: Handle, name: *const u16) -> Handle;
        fn PeekMessageW(msg: *mut Msg, hwnd: Handle, first: u32, last: u32, remove: u32) -> i32;
        fn TranslateMessage(msg: *const Msg) -> i32;
        fn DispatchMessageW(msg: *const Msg) -> isize;
    }
    #[link(name = "comdlg32")]
    extern "system" {
        fn GetOpenFileNameW(ofn: *mut OpenFileNameW) -> i32;
    }
    #[link(name = "shell32")]
    extern "system" {
        fn Shell_NotifyIconW(message: u32, data: *mut NotifyIconDataW) -> i32;
    }

    const MAX_PATH_LONG: usize = 1024;
    /* CSIDL рабочего стола и меню «Программы» */
    pub const CSIDL_DESKTOPDIRECTORY: i32 = 0x0010;
    pub const CSIDL_PROGRAMS: i32 = 0x0002;

    extern "system" fn browse_callback(hwnd: Handle, msg: u32, _lp: usize, data: isize) -> i32 {
        if msg == BFFM_INITIALIZED && data != 0 {
            unsafe {
                SendMessageW(hwnd, BFFM_SETSELECTIONW, 1, data);
            }
        }
        0
    }

    /// Обычное окно Windows «выбери папку». `start` — где открыть.
    pub fn pick_folder(title: &str, start: Option<&std::path::Path>) -> Option<PathBuf> {
        unsafe {
            CoInitializeEx(std::ptr::null_mut(), 0x2);
        }
        let title = wide(title);
        let mut start_storage = start.map(|path| wide(&path.display().to_string()));
        let mut buffer = [0u16; MAX_PATH_LONG];
        let mut info = BrowseInfoW {
            owner: std::ptr::null_mut(),
            root: std::ptr::null(),
            display_name: buffer.as_mut_ptr(),
            title: title.as_ptr(),
            flags: BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE | BIF_EDITBOX,
            callback: Some(browse_callback),
            callback_data: start_storage
                .as_mut()
                .map(|text| text.as_mut_ptr() as isize)
                .unwrap_or(0),
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
        let path = from_wide(&buffer);
        if path.is_empty() {
            None
        } else {
            Some(PathBuf::from(path))
        }
    }

    /* ── выбор файла ── */

    #[repr(C)]
    struct OpenFileNameW {
        struct_size: u32,
        owner: Handle,
        instance: Handle,
        filter: *const u16,
        custom_filter: *mut u16,
        max_custom_filter: u32,
        filter_index: u32,
        file: *mut u16,
        max_file: u32,
        file_title: *mut u16,
        max_file_title: u32,
        initial_dir: *const u16,
        title: *const u16,
        flags: u32,
        file_offset: u16,
        file_extension: u16,
        default_ext: *const u16,
        custom_data: isize,
        hook: Option<extern "system" fn(Handle, u32, usize, isize) -> usize>,
        template_name: *const u16,
        reserved: *mut core::ffi::c_void,
        reserved_flag: u32,
        flags_ex: u32,
    }

    const OFN_PATHMUSTEXIST: u32 = 0x0000_0800;
    const OFN_FILEMUSTEXIST: u32 = 0x0001_0000;
    const OFN_NOCHANGEDIR: u32 = 0x0000_0008;
    const OFN_EXPLORER: u32 = 0x0008_0000;

    /// Обычное окно Windows «выбери файл».
    pub fn pick_file(title: &str) -> Option<PathBuf> {
        unsafe {
            CoInitializeEx(std::ptr::null_mut(), 0x2);
        }
        let title = wide(title);
        let filters = filter_string(&[("Все файлы", "*.*"), ("Программы", "*.exe;*.jar;*.bat")]);
        let mut buffer = [0u16; MAX_PATH_LONG];
        let mut info = OpenFileNameW {
            struct_size: std::mem::size_of::<OpenFileNameW>() as u32,
            owner: std::ptr::null_mut(),
            instance: std::ptr::null_mut(),
            filter: filters.as_ptr(),
            custom_filter: std::ptr::null_mut(),
            max_custom_filter: 0,
            filter_index: 1,
            file: buffer.as_mut_ptr(),
            max_file: MAX_PATH_LONG as u32,
            file_title: std::ptr::null_mut(),
            max_file_title: 0,
            initial_dir: std::ptr::null(),
            title: title.as_ptr(),
            flags: OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR | OFN_EXPLORER,
            file_offset: 0,
            file_extension: 0,
            default_ext: std::ptr::null(),
            custom_data: 0,
            hook: None,
            template_name: std::ptr::null(),
            reserved: std::ptr::null_mut(),
            reserved_flag: 0,
            flags_ex: 0,
        };
        let ok = unsafe { GetOpenFileNameW(&mut info) };
        if ok == 0 {
            return None;
        }
        let path = from_wide(&buffer);
        if path.is_empty() {
            None
        } else {
            Some(PathBuf::from(path))
        }
    }

    /* ── системные папки ── */

    /// Рабочий стол, меню «Программы» и другие папки оболочки.
    pub fn special_folder(csidl: i32) -> Option<PathBuf> {
        let mut buffer = [0u16; MAX_PATH_LONG];
        let ok = unsafe {
            SHGetFolderPathW(
                std::ptr::null_mut(),
                csidl,
                std::ptr::null_mut(),
                0,
                buffer.as_mut_ptr(),
            )
        };
        if ok != 0 {
            return None;
        }
        let path = from_wide(&buffer);
        if path.is_empty() {
            None
        } else {
            Some(PathBuf::from(path))
        }
    }

    /* ── уведомление в области уведомлений ── */

    #[repr(C)]
    struct Msg {
        hwnd: Handle,
        message: u32,
        wparam: usize,
        lparam: isize,
        time: u32,
        x: i32,
        y: i32,
    }

    #[repr(C)]
    struct NotifyIconDataW {
        size: u32,
        hwnd: Handle,
        id: u32,
        flags: u32,
        callback_message: u32,
        icon: Handle,
        tip: [u16; 128],
        state: u32,
        state_mask: u32,
        info: [u16; 256],
        timeout_or_version: u32,
        info_title: [u16; 64],
        info_flags: u32,
        guid: [u8; 16],
        balloon_icon: Handle,
    }

    const NIM_ADD: u32 = 0x0000_0000;
    const NIM_DELETE: u32 = 0x0000_0002;
    const NIF_ICON: u32 = 0x0000_0002;
    const NIF_TIP: u32 = 0x0000_0004;
    const NIF_INFO: u32 = 0x0000_0010;
    const NIIF_INFO: u32 = 0x0000_0001;
    const NIIF_NOSOUND: u32 = 0x0000_0010;
    const PM_REMOVE: u32 = 0x0001;
    /* IDI_INFORMATION — значок «i» из стандартных ресурсов системы */
    const IDI_INFORMATION: usize = 32516;

    /// Уведомление в области уведомлений («воздушный шар»).
    ///
    /// Показываем его в отдельном потоке: сама панель не должна ждать, пока
    /// шар исчезнет. Возвращаем `true`, если поток запустился — так же вёл
    /// себя прежний вариант, который просто ждал PowerShell.
    pub fn balloon(title: &str, text: &str) -> bool {
        let (title, text) = (title.to_string(), text.to_string());
        std::thread::spawn(move || unsafe {
            CoInitializeEx(std::ptr::null_mut(), 0x2);
            /* своё окно не нужно: хватает скрытого служебного окна Windows */
            let hwnd = CreateWindowExW(
                0,
                wide("STATIC").as_ptr(),
                wide("OmniPanel").as_ptr(),
                0,
                0,
                0,
                0,
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            );
            if hwnd.is_null() {
                return;
            }
            let mut data: NotifyIconDataW = std::mem::zeroed();
            data.size = std::mem::size_of::<NotifyIconDataW>() as u32;
            data.hwnd = hwnd;
            data.id = 1;
            data.flags = NIF_ICON | NIF_TIP | NIF_INFO;
            data.icon = LoadIconW(std::ptr::null_mut(), IDI_INFORMATION as *const u16);
            put_wide(&mut data.tip, "OmniPanel");
            put_wide(&mut data.info_title, &title);
            put_wide(&mut data.info, &text);
            data.info_flags = NIIF_INFO | NIIF_NOSOUND;
            data.timeout_or_version = 6000;

            if Shell_NotifyIconW(NIM_ADD, &mut data) == 0 {
                DestroyWindow(hwnd);
                return;
            }
            /* шар живёт в очереди сообщений — её надо прокручивать */
            let until = std::time::Instant::now() + std::time::Duration::from_millis(6500);
            let mut message: Msg = std::mem::zeroed();
            while std::time::Instant::now() < until {
                while PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                    TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
                std::thread::sleep(std::time::Duration::from_millis(40));
            }
            Shell_NotifyIconW(NIM_DELETE, &mut data);
            DestroyWindow(hwnd);
        });
        true
    }
}

#[cfg(windows)]
pub use native::{balloon, pick_file, pick_folder, special_folder};

#[cfg(windows)]
pub use native::{CSIDL_DESKTOPDIRECTORY, CSIDL_PROGRAMS};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn строка_в_utf16_закрыта_нулём() {
        let text = wide("Моя панель");
        assert_eq!(text.last(), Some(&0));
        assert_eq!(text.len(), "Моя панель".encode_utf16().count() + 1);
    }

    #[test]
    fn буфер_читается_до_нуля() {
        let mut buffer = wide("D:\\Игры");
        buffer.extend_from_slice(&[0x41, 0x42]);
        assert_eq!(from_wide(&buffer), "D:\\Игры");
    }

    #[test]
    fn длинный_путь_обрезается_а_не_ломает_буфер() {
        let mut buffer = [0u16; 8];
        put_wide(&mut buffer, "Очень длинный путь к папке");
        assert_eq!(buffer[7], 0, "буфер обязан остаться закрытым нулём");
        assert!(from_wide(&buffer).len() < 20);
    }

    #[test]
    fn фильтры_файлов_идут_парами_и_кончаются_нулём() {
        let text = filter_string(&[("Все файлы", "*.*"), ("Программы", "*.exe")]);
        assert_eq!(text.last(), Some(&0));
        let parts: Vec<String> = {
            let mut out = Vec::new();
            let mut current = Vec::new();
            for unit in &text {
                if *unit == 0 {
                    out.push(String::from_utf16_lossy(&current));
                    current.clear();
                } else {
                    current.push(*unit);
                }
            }
            out
        };
        assert_eq!(parts[0], "Все файлы");
        assert_eq!(parts[1], "*.*");
        assert_eq!(parts[2], "Программы");
        assert_eq!(parts[3], "*.exe");
    }
}
