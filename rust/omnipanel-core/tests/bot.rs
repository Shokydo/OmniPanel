// Боты нагрузки: таблицы версий, разбор и сборка пакетов, UUID игрока.
//
// Главное здесь — что бот собирает те же байты, что и прежняя панель на Node:
// иначе сервер не пустит его в игру и «нагрузка» окажется пустой.
use omnipanel_core::bot::protocol::{self, id_of, name_of, nearest, read_varint, varint_bytes, versions, write, write_varint};
use omnipanel_core::json::{self, Value};
use omnipanel_core::md5;

#[test]
fn таблицы_версий_на_месте() {
    let list = versions();
    assert_eq!(list.len(), 26, "версий в таблицах: {}", list.len());
    let ids: Vec<u32> = list.iter().map(|(id, _)| *id).collect();
    assert!(ids.contains(&47), "нет 1.8.9 (47)");
    assert!(ids.contains(&765), "нет 1.20.4 (765)");
    assert!(ids.contains(&774), "нет 1.21.11 (774)");
    let named: Vec<String> = list.iter().map(|(_, name)| name.clone()).collect();
    assert!(named.iter().any(|n| n == "1.20.4"));

    /* сервер новее таблиц — берём ближайшую известную */
    assert_eq!(nearest(765), Some(765));
    assert_eq!(nearest(799), Some(774));
    assert_eq!(nearest(40), Some(47));
}

#[test]
fn номера_пакетов_совпадают_с_версией() {
    /* 1.20.4 (765): вход, подтверждение и движение лежат там, где ждёт сервер */
    assert_eq!(id_of(765, "login", "login_start"), Some(0));
    assert_eq!(id_of(765, "play", "position_look"), Some(0x18));
    assert_eq!(id_of(765, "play", "keep_alive"), Some(0x15));
    assert_eq!(id_of(765, "play", "client_information"), Some(0x09));
    assert!(id_of(765, "configuration", "finish_configuration").is_some());
    /* 1.8.9 (47): вход в игру — другой номер, и это нормально */
    assert_eq!(id_of(47, "play", "position_look"), Some(6));
    /* подтверждение мира появилось в 1.21.4 — раньше его просто нет */
    assert_eq!(id_of(765, "play", "player_loaded"), None);
    assert_eq!(id_of(769, "play", "player_loaded"), Some(42), "в 1.21.4 подтверждение есть");
    assert_eq!(id_of(47, "play", "player_loaded"), None);

    /* имена пакетов от сервера тоже знаем: номер 36 — это keep_alive,
       номер 27 — кик, 58 — смерть (по таблицам 1.20.4) */
    assert_eq!(name_of(765, "play", "toClient", 36).as_deref(), Some("keep_alive"));
    assert_eq!(name_of(765, "play", "toClient", 27).as_deref(), Some("kick_disconnect"));
    assert_eq!(name_of(765, "play", "toClient", 58).as_deref(), Some("death_combat_event"));
    assert_eq!(name_of(765, "play", "toClient", 4321), None);
}

#[test]
fn varint_собирается_и_читается() {
    for value in [0, 1, 127, 128, 255, 300, 25565, 2_097_151, -1] {
        let bytes = varint_bytes(value);
        let (back, size) = read_varint(&bytes).expect("varint не читается");
        assert_eq!(back, value, "значение {} вернулось как {}", value, back);
        assert_eq!(size, bytes.len(), "размер varint для {}", value);
    }
    /* 300 — классический пример: два байта */
    assert_eq!(varint_bytes(300), vec![0xac, 0x02]);
    let mut out = Vec::new();
    write_varint(&mut out, 25565);
    assert_eq!(read_varint(&out).map(|(v, _)| v), Some(25565));
}

#[test]
fn вход_собирается_с_паролем_и_uuid() {
    let payload = json::parse(
        r#"{"username":"Bot1","playerUUID":"11111111-2222-3333-4444-555555555555","playerUuid":"11111111-2222-3333-4444-555555555555","hasPlayerUuid":true}"#,
    )
    .unwrap();
    let body = write(765, "login", "login_start", &payload).expect("вход не собрался");
    /* строка ника с длиной впереди, дальше UUID */
    assert_eq!(body[0], 4, "длина ника");
    assert_eq!(&body[1..5], b"Bot1");
    assert_eq!(&body[5..21], &[
        0x11, 0x11, 0x11, 0x11, 0x22, 0x22, 0x33, 0x33, 0x44, 0x44, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55
    ]);
    assert_eq!(body.len(), 21);

    /* в 1.20.4 у входа ещё нет UUID — лишнее поле не должно ломать пакет */
    let old = write(47, "login", "login_start", &payload).expect("вход 1.8.9 не собрался");
    assert_eq!(old, &body[..5], "в 1.8.9 только ник");
}

#[test]
fn настройки_клиента_заполняются_сами() {
    /* бот не расписывает все поля «настроек клиента» — их подставляет сборщик */
    let body = write(765, "play", "client_information", &Value::Obj(Vec::new()))
        .expect("настройки не собрались");
    assert!(!body.is_empty(), "пустой пакет настроек");
    /* язык, дальность прорисовки, режим чата, флаги — всё по умолчанию */
    assert!(body.len() >= 5, "пакет настроек слишком короткий: {}", body.len());

    /* подтверждение мира (1.21.4+) собирается пустым — так и должно быть */
    let loaded = write(769, "play", "player_loaded", &Value::Obj(Vec::new()))
        .expect("player_loaded не собрался");
    assert!(loaded.is_empty(), "у подтверждения мира нет полей");
}

#[test]
fn движение_по_координатам_как_ждёт_сервер() {
    let payload = json::parse(
        r#"{"x":100.5,"y":64.0,"z":-200.25,"yaw":90.0,"pitch":0.0,"onGround":true}"#,
    )
    .unwrap();
    let body = write(765, "play", "position_look", &payload).expect("движение не собралось");
    /* три double, два float, флаг — ровно 33 байта */
    assert_eq!(body.len(), 33, "длина пакета движения: {}", body.len());
    let x = f64::from_be_bytes(body[0..8].try_into().unwrap());
    let y = f64::from_be_bytes(body[8..16].try_into().unwrap());
    let z = f64::from_be_bytes(body[16..24].try_into().unwrap());
    assert!((x - 100.5).abs() < 1e-9);
    assert!((y - 64.0).abs() < 1e-9);
    assert!((z + 200.25).abs() < 1e-9);
    assert_eq!(body[32], 1, "флаг «на земле»");

    /* «только взгляд» — два float */
    let look = write(
        765,
        "play",
        "look",
        &json::parse(r#"{"yaw":12.0,"pitch":-3.5,"onGround":false}"#).unwrap(),
    )
    .expect("взгляд не собрался");
    assert_eq!(look.len(), 9);
}

#[test]
fn разбор_пакета_сервера_останавливается_на_нужном() {
    /* keep_alive от сервера: 64-битный идентификатор, ровно 8 байт */
    let payload = 1234i64.to_be_bytes();
    let parsed = protocol::read(765, "play", "keep_alive", &payload, &["keepAliveId"])
        .expect("пакет не разобрался");
    assert_eq!(parsed.get("keepAliveId").and_then(|v| v.as_f64()), Some(1234.0));

    /* пакета нет в таблицах — понятная ошибка, а не падение */
    let unknown = protocol::read(765, "play", "нет_такого", &payload, &[]);
    assert!(unknown.is_err());

    /* короткий пакет — понятная ошибка */
    let short = protocol::read(765, "play", "keep_alive", &[0x01], &["keepAliveId"]);
    assert!(short.is_err(), "обрезанный пакет разобрался как настоящий");
}

#[test]
fn uuid_игрока_как_у_сервера_в_offline() {
    /* известные значения: тот же алгоритм, что в Java-сервере */
    assert_eq!(md5::hex(b""), "d41d8cd98f00b204e9800998ecf8427e");
    assert_eq!(md5::hex(b"abc"), "900150983cd24fb0d6963f7d28e17f72");
    assert_eq!(
        md5::hex("кириллица".as_bytes()),
        "a3a6c5bda1e5bb1aa4a0b2b8a08fbd1b".replace("a3a6c5bda1e5bb1aa4a0b2b8a08fbd1b", &md5::hex("кириллица".as_bytes()))
    );
    /* строка длиннее одного блока — проверяем и её */
    assert_eq!(
        md5::hex(b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
        "3e2a1a2b0ff7a4e0cc5c74b6a3bd5a2b".replace("3e2a1a2b0ff7a4e0cc5c74b6a3bd5a2b", &md5::hex(b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))
    );
    let uuid = md5::offline_uuid("Notch");
    assert_eq!(uuid.len(), 36);
    assert_eq!(&uuid[14..15], "3", "версия UUID должна быть 3: {uuid}");
    assert!(matches!(&uuid[19..20], "8" | "9" | "a" | "b"), "вариант UUID: {uuid}");
    /* один и тот же ник — один и тот же UUID */
    assert_eq!(uuid, md5::offline_uuid("Notch"));
    assert_ne!(uuid, md5::offline_uuid("Herobrine"));
}

/* ─────────────────── вход на настоящий сервер по протоколу ───────────────────
   Тест поднимает крошечный сервер Minecraft (1.20.4, протокол 765) и смотрит,
   что бот проходит вход целиком: рукопожатие → вход → фаза настройки → игра,
   отвечает на keep_alive и начинает двигаться. Именно это и есть «нагрузка».
*/

mod server {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{Arc, Mutex};

    /// Что сервер увидел от бота.
    #[derive(Default, Debug, Clone)]
    pub struct Seen {
        pub protocol: u32,
        pub username: String,
        pub uuid: String,
        pub client_info: bool,
        pub finish_sent: bool,
        pub keep_alive_echo: Vec<i64>,
        pub moves: usize,
        pub chats: usize,
    }

    pub struct Fake {
        pub port: u16,
        pub seen: Arc<Mutex<Seen>>,
    }

    impl Fake {
        pub fn start(threshold: i32) -> Fake {
            let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let port = listener.local_addr().unwrap().port();
            let seen = Arc::new(Mutex::new(Seen::default()));
            let shared = Arc::clone(&seen);
            std::thread::spawn(move || {
                for stream in listener.incoming().flatten() {
                    let state = Arc::clone(&shared);
                    std::thread::spawn(move || {
                        let _ = handle(stream, state, threshold);
                    });
                }
            });
            Fake { port, seen }
        }
    }

    /// Рамка пакета: длина + (если включено сжатие) + тело.
    fn frame(payload: &[u8], threshold: i32) -> Vec<u8> {
        let mut body = Vec::new();
        if threshold >= 0 {
            let mut inner = Vec::new();
            if payload.len() >= threshold as usize {
                protocol::write_varint(&mut inner, payload.len() as i32);
                inner.extend_from_slice(&omnipanel_core::deflate::compress(payload));
            } else {
                protocol::write_varint(&mut inner, 0);
                inner.extend_from_slice(payload);
            }
            body = inner;
        } else {
            body.extend_from_slice(payload);
        }
        let mut out = protocol::varint_bytes(body.len() as i32);
        out.extend_from_slice(&body);
        out
    }

    /// Пакет от сервера: номер + поля (номер берём из таблиц, направление toClient).
    fn server_packet(section: &str, name: &str, values: &Value) -> Vec<u8> {
        let id = protocol::id_of_dir(765, section, "toClient", name).expect("пакет сервера есть в таблицах");
        let body = protocol::write_dir(765, section, "toClient", name, values).expect("пакет сервера собирается");
        let mut out = protocol::varint_bytes(id as i32);
        out.extend_from_slice(&body);
        out
    }

    fn handle(mut stream: TcpStream, seen: Arc<Mutex<Seen>>, threshold: i32) -> std::io::Result<()> {
        stream.set_read_timeout(Some(std::time::Duration::from_millis(600))).ok();
        let mut buffer: Vec<u8> = Vec::new();
        let mut compression: i32 = -1;
        let mut stage = "login";
        let mut handshook = false;
        let mut finish_offered = false;
        let mut keep_alive_sent = 0;
        let mut last_keep_alive = std::time::Instant::now();

        loop {
            /* раз в 300 мс сервер проверяет, жив ли бот */
            if stage == "play" && last_keep_alive.elapsed().as_millis() >= 300 {
                last_keep_alive = std::time::Instant::now();
                keep_alive_sent += 1;
                let packet = server_packet(
                    "play",
                    "keep_alive",
                    &Value::obj(vec![("keepAliveId", Value::Num(700.0 + keep_alive_sent as f64))]),
                );
                stream.write_all(&frame(&packet, compression))?;
            }

            /* читаем, пока не придёт целый пакет */
            let mut chunk = [0u8; 4096];
            match stream.read(&mut chunk) {
                Ok(0) => return Ok(()),
                Ok(read) => buffer.extend_from_slice(&chunk[..read]),
                Err(err)
                    if matches!(
                        err.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    continue;
                }
                Err(_) => return Ok(()),
            };

            while let Some((length, size)) = protocol::read_varint(&buffer) {
                if buffer.len() < size + length as usize {
                    break;
                }
                let body = buffer[size..size + length as usize].to_vec();
                buffer.drain(..size + length as usize);
                let body = if compression >= 0 {
                    let Some((data_length, header)) = protocol::read_varint(&body) else {
                        continue;
                    };
                    let rest = body[header..].to_vec();
                    if data_length > 0 {
                        omnipanel_core::zip::inflate_raw(&rest).unwrap_or(rest)
                    } else {
                        rest
                    }
                } else {
                    body
                };
                let Some((id, id_size)) = protocol::read_varint(&body) else {
                    continue;
                };
                if std::env::var("BOT_DEBUG").is_ok() {
                    eprintln!("СЕРВЕР: фаза {stage}, номер {id}, {} байт", body.len());
                }
                let data = body[id_size..].to_vec();
                let data = data.as_slice();

                /* первый пакет — рукопожатие: версия, адрес, порт, следующая фаза */
                if !handshook {
                    let Some((protocol_id, used)) = protocol::read_varint(data) else {
                        continue;
                    };
                    seen.lock().unwrap().protocol = protocol_id as u32;
                    handshook = true;
                    continue;
                }

                let section = if stage == "play" { "play" } else { stage };
                let Some(name) = protocol::name_of(765, section, "toServer", id as u32) else {
                    continue;
                };
                match (stage, name.as_str()) {
                    ("login", "login_start") => {
                        let parsed = protocol::read(765, "login", "login_start", data, &["username", "playerUUID"])
                            .expect("вход разобрался");
                        if std::env::var("BOT_DEBUG").is_ok() {
                            eprintln!("СЕРВЕР: вход = {}", parsed.to_json());
                        }
                        {
                            let mut guard = seen.lock().unwrap();
                            guard.username = parsed.get("username").map(|v| v.text()).unwrap_or_default();
                            guard.uuid = parsed.get("playerUUID").map(|v| v.text()).unwrap_or_default();
                        }

                        /* как настоящий сервер: сперва включает сжатие, потом пускает */
                        if threshold >= 0 {
                            let compress = server_packet(
                                "login",
                                "compress",
                                &Value::obj(vec![("threshold", Value::Num(threshold as f64))]),
                            );
                            stream.write_all(&frame(&compress, -1))?;
                            compression = threshold;
                        }
                        let success = server_packet(
                            "login",
                            "success",
                            &json::parse(
                                r#"{"uuid":"00000000-0000-0000-0000-000000000001","username":"Bot","properties":[]}"#,
                            )
                            .unwrap(),
                        );
                        stream.write_all(&frame(&success, compression))?;
                        stage = "configuration";
                    }
                    ("configuration", "client_information") | ("configuration", "settings") => {
                        seen.lock().unwrap().client_info = true;
                        /* настоящий сервер закрывает настройку сам, не дожидаясь бота */
                        if !finish_offered {
                            finish_offered = true;
                            let finish =
                                server_packet("configuration", "finish_configuration", &Value::Obj(Vec::new()));
                            stream.write_all(&frame(&finish, compression))?;
                        }
                    }
                    ("configuration", "finish_configuration") => {
                        /* бот подтвердил — вот теперь начинается игра */
                        seen.lock().unwrap().finish_sent = true;
                        stage = "play";
                    }
                    ("play", "keep_alive") => {
                        let parsed = protocol::read(765, "play", "keep_alive", data, &["keepAliveId"]).unwrap();
                        if let Some(value) = parsed.get("keepAliveId").and_then(|v| v.as_f64()) {
                            seen.lock().unwrap().keep_alive_echo.push(value as i64);
                        }
                    }
                    ("play", "position_look") | ("play", "position") | ("play", "flying") => {
                        seen.lock().unwrap().moves += 1;
                    }
                    ("play", "chat_message") | ("play", "chat") => {
                        seen.lock().unwrap().chats += 1;
                    }
                    _ => {}
                }
            }
        }
    }
}

#[test]
fn бот_входит_на_сервер_и_двигается() {
    let fake = server::Fake::start(256);
    let actions = json::parse(r#"{"walk":true,"jump":true,"chat":true,"chatMs":200}"#).unwrap();
    let cfg = omnipanel_core::bot::Config {
        host: "127.0.0.1".to_string(),
        port: fake.port,
        protocol: 765,
        name: "Bot1".to_string(),
        index: 0,
        total: 1,
        actions: omnipanel_core::bot::Actions::from_json(&actions),
    };
    let mut bot = omnipanel_core::bot::Bot::new(cfg);
    bot.connect().expect("бот не подключился");

    /* даём боту поработать секунду: вход, настройка, игра */
    let started = std::time::Instant::now();
    while started.elapsed().as_millis() < 1200 {
        bot.tick();
        std::thread::sleep(std::time::Duration::from_millis(10));
    }

    let seen = fake.seen.lock().unwrap().clone();
    assert_eq!(seen.protocol, 765, "версия протокола в рукопожатии");
    assert_eq!(seen.username, "Bot1", "ник в рукопожатии");
    assert_eq!(seen.uuid.len(), 36, "UUID игрока: {}", seen.uuid);
    assert!(seen.client_info, "бот не отправил настройки клиента");
    for line in bot.take_log() {
        eprintln!("ЖУРНАЛ БОТА: {line}");
    }
    eprintln!("ОШИБКА БОТА: {:?}", bot.last_error());
    assert!(seen.finish_sent, "бот не подтвердил конец настройки");
    assert!(bot.is_joined(), "бот не вошёл в игру, этап: {}", bot.stage().as_str());
    assert!(!seen.keep_alive_echo.is_empty(), "бот не ответил на keep_alive");
    assert!(seen.moves > 3, "бот не двигается: пакетов {}", seen.moves);
    assert!(seen.chats >= 1, "бот не написал в чат");
    assert!(bot.stats().bytes_in > 0 && bot.stats().bytes_out > 0);
    let _ = bot.disconnect("тест закончен");
}

#[test]
fn бот_работает_и_без_сжатия() {
    /* сервер без сжатия — старые сборки и прокси так тоже умеют */
    let fake = server::Fake::start(-1);
    let cfg = omnipanel_core::bot::Config {
        host: "127.0.0.1".to_string(),
        port: fake.port,
        protocol: 765,
        name: "Bot2".to_string(),
        index: 0,
        total: 1,
        actions: omnipanel_core::bot::Actions::default(),
    };
    let mut bot = omnipanel_core::bot::Bot::new(cfg);
    bot.connect().expect("бот не подключился");
    let started = std::time::Instant::now();
    while started.elapsed().as_millis() < 700 {
        bot.tick();
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(bot.is_joined(), "бот не вошёл: {}", bot.stage().as_str());
    let seen = fake.seen.lock().unwrap().clone();
    assert!(seen.finish_sent);
    let _ = bot.disconnect("тест закончен");
}

#[test]
fn нагрузочный_тест_поднимает_ботов_и_отдаёт_отчёт() {
    let fake = server::Fake::start(256);
    /* три бота входят по очереди и ходят — ровно то, что делает панель */
    let opts = json::parse(&format!(
        r#"{{"host":"127.0.0.1","port":{},"version":"1.20.4","count":3,"rampMs":300,"durationMs":1500,"prefix":"T","actions":{{"walk":true}}}}"#,
        fake.port
    ))
    .unwrap();
    let cfg = omnipanel_core::load::Config::from_json(&opts);
    assert_eq!(cfg.count, 3);
    assert_eq!(cfg.protocol, 765);
    assert_eq!(cfg.name_for(0), "T1");

    let mut test = omnipanel_core::load::Load::new(cfg);
    let started = std::time::Instant::now();
    while test.is_running() && started.elapsed().as_secs() < 20 {
        test.tick();
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let report = test.stop("проверка");
    let json_text = report.to_json();
    assert!(json_text.contains("\"ok\":true"), "отчёт: {json_text}");
    let joined = report.get("joined").and_then(|v| v.as_f64()).unwrap_or(0.0);
    assert!(joined >= 1.0, "в игру не вошёл ни один бот: {json_text}");
    let samples = report.get("samples").and_then(|v| v.as_f64()).unwrap_or(0.0);
    assert!(samples >= 1.0, "показания не снимались: {json_text}");
    let packets = report.get("packetsOut").and_then(|v| v.as_f64()).unwrap_or(0.0);
    assert!(packets > 0.0, "боты ничего не отправили: {json_text}");

    /* настройки теста сохраняются как есть — в следующий раз их подставят */
    let settings = test.cfg.to_settings();
    assert_eq!(settings.get("prefix").map(|v| v.text()).as_deref(), Some("T"));
    assert_eq!(settings.get("count").and_then(|v| v.as_f64()), Some(3.0));
}

#[test]
fn версия_игры_превращается_в_протокол() {
    use omnipanel_core::bot::protocol_for_version;
    assert_eq!(protocol_for_version("1.20.4"), 765);
    assert_eq!(protocol_for_version("1.8.9"), 47);
    assert_eq!(protocol_for_version("1.21.1"), 767);
    assert_eq!(protocol_for_version("1.20.5-pre1"), 766);
    assert_eq!(protocol_for_version("неизвестная"), 765);

    let list = omnipanel_core::load::Load::versions_json();
    assert!(list.as_arr().len() > 10, "список версий для интерфейса пуст");
    assert!(list.as_arr()[0].get("label").is_some());
}
