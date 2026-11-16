/*!
 * Иконки сервера: разбор картинок, которые люди берут откуда угодно.
 *
 * Панель обязана прочитать и палитровый PNG из интернета, и 16-битный из
 * фоторедактора, и чересстрочный, и с прозрачным цветом — иначе человек
 * выбирает картинку, а иконка «не ставится» без единого слова почему.
 */

use omnipanel_core::b64;
use omnipanel_core::image;

fn png(text: &str) -> Vec<u8> {
    b64::decode(text.trim()).expect("картинка из теста не разобралась")
}

/// 4×2, палитра из четырёх цветов с прозрачностью, 4 бита на пиксель.
/// Строки: 0,1,2,3 и 3,0,1,2.
const PALETTE_4BIT: &str = "iVBORw0KGgoAAAANSUhEUgAAAAQAAAACBAMAAACNhmBQAAAADFBMVEX/AAAA/wAAAP/////7AGD2AAAABHRSTlP/gAD/oaGUZgAAAA5JREFUeNpjYFRmMBACAAEJAGeeX+qHAAAAAElFTkSuQmCC";

/// 2×1, RGB по 16 бит на канал.
const RGB_16BIT: &str = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABEAIAAAAr0DSeAAAAFUlEQVR42mP4/7+BgYFByCSsYtYeACIWBOn+nLK2AAAAAElFTkSuQmCC";

/// 3×3, чересстрочный (Adam7), сплошной цвет 10,20,30.
const ADAM7: &str = "iVBORw0KGgoAAAANSUhEUgAAAAMAAAADCAIAAAGuTRJ+AAAAE0lEQVR42mPgEpFjgGIkJpQLRAAhLQIdKtXSbAAAAABJRU5ErkJggg==";

/// 2×1, оттенки серого, второй пиксель помечен прозрачным.
const GREY_CLEAR: &str = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAAAAADRSSBWAAAAAnRSTlMAgJsrThgAAAALSURBVHjaY2BoAAAAgwCBFGubQwAAAABJRU5ErkJggg==";

#[test]
fn палитровый_png_читается() {
    let image = image::decode_png(&png(PALETTE_4BIT)).expect("палитровый PNG не прочитался");
    assert_eq!((image.width, image.height), (4, 2));
    /* цвета берутся из палитры, прозрачность — из tRNS */
    assert_eq!(image.pixel(0, 0), [255, 0, 0, 255], "первый цвет палитры");
    assert_eq!(image.pixel(1, 0), [0, 255, 0, 128], "второй цвет полупрозрачный");
    assert_eq!(image.pixel(2, 0), [0, 0, 255, 0], "третий цвет прозрачный");
    assert_eq!(image.pixel(3, 0), [255, 255, 255, 255]);
    assert_eq!(image.pixel(0, 1), [255, 255, 255, 255], "вторая строка читается отдельно");
    assert_eq!(image.pixel(1, 1), [255, 0, 0, 255], "индексы во второй строке свои");
}

#[test]
fn шестнадцатибитный_png_читается() {
    let image = image::decode_png(&png(RGB_16BIT)).expect("16-битный PNG не прочитался");
    assert_eq!((image.width, image.height), (2, 1));
    /* берём старший байт: 0xFFFF → 255, 0x8000 → 128, 0x0000 → 0 */
    assert_eq!(image.pixel(0, 0), [255, 128, 0, 255]);
    assert_eq!(image.pixel(1, 0), [0x12, 0x56, 0x9A, 255]);
}

#[test]
fn чересстрочный_png_читается() {
    let image = image::decode_png(&png(ADAM7)).expect("чересстрочный PNG не прочитался");
    assert_eq!((image.width, image.height), (3, 3));
    for y in 0..3 {
        for x in 0..3 {
            assert_eq!(image.pixel(x, y), [10, 20, 30, 255], "пиксель {x},{y}");
        }
    }
}

#[test]
fn прозрачный_цвет_в_сером_png() {
    let image = image::decode_png(&png(GREY_CLEAR)).expect("серый PNG не прочитался");
    assert_eq!(image.pixel(0, 0), [0, 0, 0, 255]);
    /* второй пиксель помечен в tRNS — он прозрачный */
    assert_eq!(image.pixel(1, 0), [0, 0, 0, 0]);
}

#[test]
fn иконка_сервера_собирается_из_любой_картинки() {
    /* человек выбрал палитровую картинку — она должна стать server-icon.png 64×64 */
    let small = image::decode_png(&png(PALETTE_4BIT)).unwrap();
    let big = small.resize(64, 64);
    assert_eq!((big.width, big.height), (64, 64));
    let file = image::server_icon(&big);
    let back = image::decode_png(&file).expect("своя иконка не читается обратно");
    assert_eq!((back.width, back.height), (64, 64));
}

#[test]
fn мусор_вместо_картинки_объясняет_отказ() {
    assert!(image::decode_png("не картинка".as_bytes()).is_err());
    /* правильная подпись, но пустые данные */
    let mut broken = b"\x89PNG\r\n\x1a\n".to_vec();
    broken.extend_from_slice(&[0, 0, 0, 13, b'I', b'H', b'D', b'R']);
    assert!(image::decode_png(&broken).is_err());
}

/* ─────────────────────────────── JPEG ─────────────────────────────── */

/// 16×16: левая половина красная, правая синяя (сжатие JPEG, качество 90).
const JPEG_RGB: &str = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAQABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDwSvMq9NrzKv1XwZ/5mH/cL/3IfqHjF/zAf9xf/cZ//9k=";

/// 8×8, оттенки серого, ровный серый 128.
const JPEG_GREY: &str = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAIBAQEBAQIBAQECAgICAgQDAgICAgUEBAMEBgUGBgYFBgYGBwkIBgcJBwYGCAsICQoKCgoKBggLDAsKDAkKCgr/wAALCAAIAAgBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/ACv/2Q==";

#[test]
fn jpeg_читается() {
    let image = image::decode_jpeg(&png(JPEG_RGB)).expect("JPEG не прочитался");
    assert_eq!((image.width, image.height), (16, 16));

    /* цвета при сжатии «плывут», но половины остаются красной и синей */
    let left = image.pixel(2, 8);
    let right = image.pixel(13, 8);
    assert!(left[0] > 150 && left[2] < 90, "слева красное: {:?}", left);
    assert!(right[2] > 150 && right[0] < 90, "справа синее: {:?}", right);
    assert_eq!(left[3], 255, "JPEG без прозрачности");

    /* ровная заливка не должна «звенеть» больше, чем на пару единиц */
    let almost = |a: u8, b: u8| (a as i16 - b as i16).abs() <= 12;
    let centre = image.pixel(4, 4);
    assert!(almost(centre[0], 200) && almost(centre[1], 30) && almost(centre[2], 40),
        "центр левой половины: {:?}", centre);
}

#[test]
fn серый_jpeg_читается() {
    let image = image::decode_jpeg(&png(JPEG_GREY)).expect("серый JPEG не прочитался");
    assert_eq!((image.width, image.height), (8, 8));
    let pixel = image.pixel(3, 3);
    assert!((pixel[0] as i16 - 128).abs() <= 3, "серый: {:?}", pixel);
    assert_eq!((pixel[0], pixel[1], pixel[2]), (pixel[0], pixel[0], pixel[0]));
}

#[test]
fn любая_картинка_определяется_сама() {
    /* панель не спрашивает «а это точно PNG?» — она смотрит на подпись файла */
    assert!(image::decode_any(&png(PALETTE_4BIT)).is_ok());
    assert!(image::decode_any(&png(JPEG_RGB)).is_ok());
    let err = image::decode_any(b"BM ....").unwrap_err();
    assert!(err.contains("PNG или JPEG"), "ошибка: {err}");
}

#[test]
fn прогрессивный_jpeg_объясняет_отказ() {
    /* прогрессивный JPEG (SOF2) — просим пересохранить обычным, а не молчим */
    let mut data = png(JPEG_GREY);
    /* меняем маркер SOF0 на SOF2 в первых байтах после таблиц */
    let at = data.windows(2).position(|w| w == [0xFF, 0xC0]).expect("SOF0 не найден");
    data[at + 1] = 0xC2;
    let err = image::decode_any(&data).unwrap_err();
    assert!(err.contains("Прогрессивный"), "ошибка: {err}");
}
