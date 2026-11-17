//! Вшивает иконку и сведения о файле в установщик и деинсталлятор.
//!
//! Без секции ресурсов Windows показывает у exe стандартный значок приложения —
//! и в «Загрузках» непонятно, что это за файл. Здесь тот же значок, что у
//! панели (`src-tauri/icons/icon.ico`), плюс имя, описание и версия, чтобы в
//! свойствах файла было видно «OmniPanel 1.36.0».

#[cfg(windows)]
fn main() {
    let mut res = winresource::WindowsResource::new();
    res.set_icon("icons/icon.ico");
    res.set("ProductName", "OmniPanel");
    res.set("FileDescription", "OmniPanel — установка панели серверов");
    res.set("CompanyName", "OmniPanel");
    res.set("LegalCopyright", "OmniPanel");
    res.set("OriginalFilename", "OmniPanel-Setup.exe");
    res.set("InternalName", "OmniPanel-Setup");

    /* версия из Cargo.toml: 1.36.0 → 1,36,0,0 */
    let version = std::env::var("CARGO_PKG_VERSION").unwrap_or_default();
    let mut parts: Vec<u16> = version
        .split('.')
        .map(|part| part.parse::<u16>().unwrap_or(0))
        .collect();
    while parts.len() < 4 {
        parts.push(0);
    }
    let packed = ((parts[0] as u64) << 48)
        | ((parts[1] as u64) << 32)
        | ((parts[2] as u64) << 16)
        | parts[3] as u64;
    res.set_version_info(winresource::VersionInfo::FILEVERSION, packed);
    res.set_version_info(winresource::VersionInfo::PRODUCTVERSION, packed);
    res.set("FileVersion", &format!("{version}.0"));
    res.set("ProductVersion", &format!("{version}.0"));

    if let Err(err) = res.compile() {
        /* без иконки установщик работает — сообщаем и идём дальше */
        println!("cargo:warning=не удалось вшить ресурсы установщика: {err}");
    }
}

#[cfg(not(windows))]
fn main() {
    /* на Linux ресурсов Windows нет: файл нужен только ради cfg-ветки выше */
}
