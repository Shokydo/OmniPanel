//! Ярлыки Windows (.lnk) — своими руками, без PowerShell и без COM.
//!
//! Раньше ярлык создавал PowerShell (`WScript.Shell.CreateShortcut`), и при
//! установке мигало его окно консоли. Здесь файл `.lnk` собирается по
//! спецификации MS-SHLLINK прямо в байты:
//!
//! * заголовок ShellLinkHeader (76 байт) с флагами «есть LinkInfo», «есть имя»,
//!   «есть рабочая папка», «есть значок», «строки в Unicode»;
//! * StringData в порядке спецификации: NAME_STRING, WORKING_DIR,
//!   ICON_LOCATION;
//! * LinkInfo с VolumeID и LocalBasePath — и в системной кодировке, и в
//!   Unicode (кириллица в пути не превращается в мусор).
//!
//! Правильность проверяется разбором готового файла крейтом `lnk` (он только в
//! тестах): если чужой парсер читает путь, рабочую папку и значок — ярлык
//! собран верно, и это видно на любой системе, а не «на глаз» на Windows.

use std::io::Write;
use std::path::{Path, PathBuf};

const HEADER_SIZE: u32 = 0x4c;
const LINK_INFO_HEADER_SIZE: u32 = 0x24;
const VOLUME_ID_SIZE: u32 = 0x11;

/* флаги ShellLinkHeader */
const HAS_LINK_INFO: u32 = 0x0000_0002;
const HAS_NAME: u32 = 0x0000_0004;
const HAS_WORKING_DIR: u32 = 0x0000_0010;
const HAS_ICON_LOCATION: u32 = 0x0000_0040;
const IS_UNICODE: u32 = 0x0000_0080;

/* CLSID {00021401-0000-0000-C000-000000000046} — «это ярлык» */
const LINK_CLSID: [u8; 16] = [
    0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46,
];

fn push_u16(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn push_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn push_utf16z(out: &mut Vec<u8>, text: &str) {
    for unit in text.encode_utf16() {
        push_u16(out, unit);
    }
    push_u16(out, 0);
}

/// Строка в системной кодировке. Кириллицу в ANSI-поле не пишем: пусть лучше
/// останется пустым, чем превратится в «????» — Windows прочитает Unicode-поле.
fn ansi_or_empty(text: &str) -> Vec<u8> {
    if text.is_ascii() {
        let mut out = text.as_bytes().to_vec();
        out.push(0);
        out
    } else {
        vec![0]
    }
}

/// Собирает содержимое ярлыка целиком.
pub fn build(
    target: &Path,
    workdir: &Path,
    description: &str,
    icon: &Path,
    icon_index: i32,
) -> Vec<u8> {
    let target_text = target.display().to_string();
    let workdir_text = workdir.display().to_string();
    let icon_text = icon.display().to_string();

    let mut file: Vec<u8> = Vec::with_capacity(1024);

    /* ── ShellLinkHeader ── */
    push_u32(&mut file, HEADER_SIZE);
    file.extend_from_slice(&LINK_CLSID);
    push_u32(
        &mut file,
        HAS_LINK_INFO | HAS_NAME | HAS_WORKING_DIR | HAS_ICON_LOCATION | IS_UNICODE,
    );
    push_u32(&mut file, 0x0000_0020); /* FILE_ATTRIBUTE_ARCHIVE */
    file.extend_from_slice(&[0u8; 24]); /* creation / access / write time */
    push_u32(&mut file, 0); /* размер цели, если известен */
    push_u32(&mut file, icon_index as u32);
    push_u32(&mut file, 1); /* SW_SHOWNORMAL */
    push_u16(&mut file, 0); /* горячая клавиша */
    push_u16(&mut file, 0); /* Reserved1 */
    push_u32(&mut file, 0); /* Reserved2 */
    push_u32(&mut file, 0); /* Reserved3 */
    debug_assert_eq!(file.len() as u32, HEADER_SIZE, "заголовок ярлыка 76 байт");

    /* ── LinkInfo: где лежит цель ── */
    let volume_id_size = VOLUME_ID_SIZE;
    let local_ansi = ansi_or_empty(&target_text);
    let suffix_ansi: Vec<u8> = vec![0];
    let suffix_unicode: Vec<u8> = vec![0, 0];

    let volume_id_offset = LINK_INFO_HEADER_SIZE;
    let local_base_path_offset = volume_id_offset + volume_id_size;
    let common_path_suffix_offset = local_base_path_offset + local_ansi.len() as u32;
    let local_base_path_offset_unicode = common_path_suffix_offset + suffix_ansi.len() as u32;
    let mut local_unicode: Vec<u8> = Vec::new();
    push_utf16z(&mut local_unicode, &target_text);
    let common_path_suffix_offset_unicode =
        local_base_path_offset_unicode + local_unicode.len() as u32;
    let link_info_size = common_path_suffix_offset_unicode + suffix_unicode.len() as u32;

    push_u32(&mut file, link_info_size);
    push_u32(&mut file, LINK_INFO_HEADER_SIZE);
    push_u32(&mut file, 1); /* VolumeIDAndLocalBasePath */
    push_u32(&mut file, volume_id_offset);
    push_u32(&mut file, local_base_path_offset);
    push_u32(&mut file, 0); /* сетевого пути нет */
    push_u32(&mut file, common_path_suffix_offset);
    push_u32(&mut file, local_base_path_offset_unicode);
    push_u32(&mut file, common_path_suffix_offset_unicode);

    /* VolumeID: размер, тип диска, серийный номер, метка */
    push_u32(&mut file, volume_id_size);
    push_u32(&mut file, 3); /* DRIVE_FIXED */
    push_u32(&mut file, 0);
    push_u32(&mut file, 0x10); /* метка сразу после структуры */
    file.push(0);

    file.extend_from_slice(&local_ansi);
    file.extend_from_slice(&suffix_ansi);
    file.extend_from_slice(&local_unicode);
    file.extend_from_slice(&suffix_unicode);

    /* ── StringData: имя, рабочая папка, значок (строго в этом порядке) ── */
    for text in [
        description.to_string(),
        workdir_text.clone(),
        format!("{},{}", icon_text, icon_index),
    ] {
        let units: Vec<u16> = text.encode_utf16().collect();
        push_u16(&mut file, units.len() as u16);
        for unit in units {
            push_u16(&mut file, unit);
        }
    }

    debug_assert_eq!(
        file.len() as u32,
        HEADER_SIZE + 2 + description.encode_utf16().count() as u32 * 2
            + 2
            + workdir_text.encode_utf16().count() as u32 * 2
            + 2
            + format!("{},{}", icon_text, icon_index).encode_utf16().count() as u32 * 2
            + link_info_size
    );
    file
}

/// Создаёт ярлык: `link` — путь к .lnk, `target` — что запускать,
/// `workdir` — рабочая папка, `icon` — откуда брать значок (обычно сам exe).
pub fn create(
    link: &Path,
    target: &Path,
    workdir: &Path,
    description: &str,
    icon: Option<&Path>,
) -> Result<(), String> {
    if let Some(parent) = link.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("не создать папку для ярлыка {}: {}", parent.display(), err))?;
    }
    let icon = icon.unwrap_or(target);
    let bytes = build(target, workdir, description, icon, 0);
    let mut file = std::fs::File::create(link)
        .map_err(|err| format!("не создать ярлык {}: {}", link.display(), err))?;
    file.write_all(&bytes)
        .map_err(|err| format!("не записать ярлык {}: {}", link.display(), err))?;
    Ok(())
}

/// Рабочий стол пользователя (на не-Windows — None).
pub fn desktop_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        crate::win32::special_folder(crate::win32::CSIDL_DESKTOPDIRECTORY)
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// Меню «Пуск» → «Программы» (на не-Windows — None).
pub fn programs_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        crate::win32::special_folder(crate::win32::CSIDL_PROGRAMS)
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// Убирает ярлыки панели — при удалении из установщика.
pub fn remove(name: &str) -> usize {
    let mut removed = 0;
    for dir in [desktop_dir(), programs_dir()] {
        let Some(dir) = dir else { continue };
        for candidate in [dir.join(name), dir.join("OmniPanel").join(name)] {
            if candidate.exists() && std::fs::remove_file(&candidate).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;
    use lnk::encoding::WINDOWS_1251;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("omnipanel-ярлык-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn заголовок_и_размеры_по_спецификации() {
        let dir = temp("spec");
        let target = dir.join("OmniPanel.exe");
        let bytes = build(&target, &dir, "OmniPanel", &target, 0);
        assert_eq!(u32::from_le_bytes(bytes[0..4].try_into().unwrap()), 0x4c);
        assert_eq!(&bytes[4..20], &LINK_CLSID, "не тот CLSID ярлыка");
        let flags = u32::from_le_bytes(bytes[20..24].try_into().unwrap());
        for flag in [HAS_LINK_INFO, HAS_NAME, HAS_WORKING_DIR, HAS_ICON_LOCATION, IS_UNICODE] {
            assert_eq!(flags & flag, flag, "в ярлыке нет флага {flag:#x}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn готовый_ярлык_читается_чужим_парсером() {
        let dir = temp("read");
        let target = dir.join("OmniPanel.exe");
        std::fs::write(&target, b"MZ").unwrap();
        let link = dir.join("OmniPanel.lnk");
        create(&link, &target, &dir, "OmniPanel", Some(&target)).expect("ярлык не создался");

        let read = lnk::ShellLink::open(&link, WINDOWS_1251).expect("ярлык не разобрался");
        let found = read.link_target().expect("в ярлыке нет цели");
        assert!(
            found.to_lowercase().contains("omnipanel.exe"),
            "цель в ярлыке не та: {found}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn кириллица_в_пути_сохраняется() {
        let dir = temp("кир");
        let target = dir.join("Моя панель").join("OmniPanel.exe");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, b"MZ").unwrap();
        let link = dir.join("панель.lnk");
        create(&link, &target, target.parent().unwrap(), "Панель серверов", None).unwrap();

        let read = lnk::ShellLink::open(&link, WINDOWS_1251).expect("ярлык не разобрался");
        let found = read.link_target().expect("нет цели");
        assert!(found.contains("Моя панель"), "кириллица потерялась: {found}");
        let workdir = read
            .string_data()
            .working_dir()
            .clone()
            .unwrap_or_default();
        assert_eq!(workdir, target.parent().unwrap().display().to_string());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn значок_берётся_из_exe() {
        let dir = temp("икон");
        let target = dir.join("OmniPanel.exe");
        std::fs::write(&target, b"MZ").unwrap();
        let link = dir.join("OmniPanel.lnk");
        create(&link, &target, &dir, "OmniPanel", None).unwrap();
        let read = lnk::ShellLink::open(&link, WINDOWS_1251).unwrap();
        let icon = read
            .string_data()
            .icon_location()
            .clone()
            .unwrap_or_default();
        assert!(icon.contains("OmniPanel.exe"), "значок не из exe: {icon}");
        assert!(icon.ends_with(",0"), "не указан номер значка: {icon}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn несуществующий_путь_не_мешает_создать_ярлык() {
        /* target может ещё не существовать: установщик создаёт ярлык и для
           папки, которую создаст сам */
        let dir = temp("нет-цели");
        let target = dir.join("папка").join("OmniPanel.exe");
        let link = dir.join("OmniPanel.lnk");
        create(&link, &target, &dir, "OmniPanel", None).expect("ярлык обязан создаться");
        assert!(link.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
