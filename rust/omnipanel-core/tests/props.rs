// Проверки `server.properties`: разбор, запись, кириллица, чужие ключи.
use omnipanel_core::props::{decode, escape, Props, PropsFile};

const SAMPLE: &str = "#Minecraft server properties\n#создано вручную\nonline-mode=false\nserver-port=25565\nmotd=\\u041f\\u0440\\u0438\\u0432\\u0435\\u0442\n";

#[test]
fn разбирает_ключи_и_значения() {
    let file = PropsFile::parse(SAMPLE);
    assert_eq!(file.get("online-mode"), Some("false"));
    assert_eq!(file.get("server-port"), Some("25565"));
    assert_eq!(file.get_bool("online-mode"), Some(false));
    assert_eq!(file.get_number("server-port"), Some(25565.0));
}

#[test]
fn комментарии_не_считаются_ключами() {
    let file = PropsFile::parse(SAMPLE);
    assert!(file.get("#Minecraft").is_none());
    assert_eq!(file.values.len(), 3);
}

#[test]
fn кириллица_читается_из_unicode_записи() {
    let file = PropsFile::parse(SAMPLE);
    assert_eq!(file.get_text("motd").as_deref(), Some("Привет"));
}

#[test]
fn кириллица_пишется_как_unicode() {
    assert_eq!(escape("Привет"), "\\u041f\\u0440\\u0438\\u0432\\u0435\\u0442");
    assert_eq!(decode("\\u041f\\u0440\\u0438\\u0432\\u0435\\u0442"), "Привет");
    /* латиница и обычные символы не трогаем */
    assert_eq!(escape("Мир 1.20.4!"), "\\u041c\\u0438\\u0440 1.20.4!");
}

#[test]
fn запись_меняет_только_указанные_ключи() {
    let file = PropsFile::parse(SAMPLE);
    let mut patch = std::collections::BTreeMap::new();
    patch.insert("server-port".to_string(), "25570".to_string());
    let text = file.apply(&patch, &["online-mode"]);
    assert!(text.contains("server-port=25570"), "порт обновился: {text}");
    assert!(text.contains("online-mode=false"), "остальное не тронуто: {text}");
    assert!(text.contains("#Minecraft server properties"), "комментарии сохранены: {text}");
    assert!(text.contains("\\u041f\\u0440\\u0438\\u0432\\u0435\\u0442"), "кириллица осталась в \\u: {text}");
}

#[test]
fn новые_ключи_дописываются_в_конец() {
    let file = PropsFile::parse(SAMPLE);
    let mut patch = std::collections::BTreeMap::new();
    patch.insert("allow-flight".to_string(), "true".to_string());
    let text = file.apply(&patch, &["allow-flight"]);
    assert!(text.contains("allow-flight=true"));
    let last = text.trim_end().lines().last().unwrap();
    assert_eq!(last, "allow-flight=true");
}

#[test]
fn булевы_ключи_всегда_true_или_false() {
    let file = PropsFile::parse("online-mode=false\n");
    let mut patch = std::collections::BTreeMap::new();
    patch.insert("online-mode".to_string(), "ДА".to_string());
    let text = file.apply(&patch, &["online-mode"]);
    assert!(text.contains("online-mode=false"), "не true → false: {text}");
}

#[test]
fn чужие_ключи_попадают_в_дополнительные() {
    let file = PropsFile::parse("online-mode=false\nmy.plugin.setting=42\n");
    let extra = file.extra(&Props::all_keys());
    assert_eq!(extra.get("my.plugin.setting").map(String::as_str), Some("42"));
    assert!(extra.get("online-mode").is_none(), "известные ключи не дублируются");
}

#[test]
fn схема_настроек_берётся_из_интерфейса() {
    /* в ui/props-schema.js 64 настройки; таблица собирается генератором */
    let keys = Props::all_keys();
    assert_eq!(keys.len(), 64, "все настройки окна: {}", keys.len());
    for key in ["motd", "server-port", "enable-rcon", "rcon.password", "gamemode", "view-distance"] {
        assert!(keys.contains(&key), "нет настройки {key}");
        assert!(Props::field(key).is_some(), "у {key} нет описания");
    }
    let port = Props::field("server-port").unwrap();
    assert_eq!(port.kind, omnipanel_core::props_schema::Kind::Num);
    assert_eq!(Props::field("motd").unwrap().kind, omnipanel_core::props_schema::Kind::Text);
    assert_eq!(Props::field("pvp").unwrap().kind, omnipanel_core::props_schema::Kind::Bool);
}

#[test]
fn окно_настроек_отдаёт_все_поля_схемы() {
    let props = Props::parse("server-port=25565\nmotd=Привет\npvp=false\n");
    let view = props.view();
    assert_eq!(view.len(), 64, "пустые значения тоже показываем");
    assert_eq!(view.get("motd").unwrap().as_deref(), Some("Привет"));
    assert_eq!(view.get("server-port").unwrap().as_deref(), Some("25565"));
    assert_eq!(view.get("pvp").unwrap().as_deref(), Some("false"));
    assert_eq!(view.get("difficulty").unwrap(), &None, "чего нет в файле — пусто");
}

#[test]
fn пустой_файл_получает_заголовок() {
    let file = PropsFile::parse("");
    let mut patch = std::collections::BTreeMap::new();
    patch.insert("motd".to_string(), "Мой сервер".to_string());
    let text = file.apply(&patch, &[]);
    assert!(text.starts_with("#Minecraft server properties"));
    assert!(text.contains("motd=\\u041c\\u043e\\u0439 сервер") || text.contains("motd=\\u041c\\u043e\\u0439 \\u0441\\u0435\\u0440\\u0432\\u0435\\u0440"));
}

#[test]
fn экран_настроек_отдаёт_базовые_ключи() {
    let props = Props::parse(SAMPLE);
    let view = props.view();
    assert_eq!(view.get("online-mode"), Some(&Some("false".to_string())));
    assert_eq!(view.get("motd"), Some(&Some("Привет".to_string())));
    assert_eq!(view.get("pvp"), Some(&None), "ключа нет — значения нет");
}
