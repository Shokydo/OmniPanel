// Проверки собственного JSON: панель хранит настройки в файлах, и формат должен
// переживать кириллицу, кавычки, обратные слэши и переносы строк.
use omnipanel_core::json::{parse, parse_or, quote, Value};

#[test]
fn простой_объект_разбирается() {
    let value = parse(r#"{"id":"a","name":"Мир","port":25565,"auto":true,"нет":null}"#).unwrap();
    assert_eq!(value.get("id").unwrap().as_str(), Some("a"));
    assert_eq!(value.get("name").unwrap().text(), "Мир");
    assert_eq!(value.get("port").unwrap().as_f64(), Some(25565.0));
    assert!(value.get("auto").unwrap().as_bool());
    assert!(value.get("нет").unwrap().is_null());
    assert!(value.get("нет-такого").is_none());
}

#[test]
fn вложенные_списки_и_объекты() {
    let text = r#"{"env":{"A":"1","B":"2"},"args":["-jar","a.jar",["вложено",3]]}"#;
    let value = parse(text).unwrap();
    let env = value.get("env").unwrap();
    assert_eq!(env.get("B").unwrap().text(), "2");
    let args = value.get("args").unwrap().as_arr();
    assert_eq!(args.len(), 3);
    assert_eq!(args[2].as_arr()[0].text(), "вложено");
}

#[test]
fn кириллица_и_кавычки_пишутся_как_есть() {
    let value = Value::str("Мир «Кактус» и \"кавычки\"");
    let json = value.to_json();
    assert!(json.contains("Мир «Кактус»"), "кириллица не превращается в \\u: {json}");
    assert!(json.contains("\\\"кавычки\\\""), "кавычки экранируются: {json}");
    assert_eq!(parse(&json).unwrap(), value, "и разбираются обратно");
}

#[test]
fn переносы_строк_и_обратные_слэши() {
    let value = Value::str("строка1\nстрока2\tс табом\\и слэшем\r");
    let json = quote(value.as_str().unwrap());
    assert_eq!(json, "\"строка1\\nстрока2\\tс табом\\\\и слэшем\\r\"");
    assert_eq!(parse(&json).unwrap(), value);
}

#[test]
fn экранирование_юникода_читается() {
    let value = parse(r#""\u041c\u0438\u0440""#).unwrap();
    assert_eq!(value.text(), "Мир");
    /* суррогатная пара — эмодзи */
    let emoji = parse(r#""\ud83d\ude00""#).unwrap();
    assert_eq!(emoji.text(), "😀");
}

#[test]
fn запись_с_отступами_в_два_пробела() {
    let value = Value::obj(vec![
        ("id", Value::str("a")),
        ("args", Value::Arr(vec![Value::str("x"), Value::str("y")])),
        ("empty", Value::Arr(Vec::new())),
    ]);
    let pretty = value.to_json_pretty();
    assert_eq!(
        pretty,
        "{\n  \"id\": \"a\",\n  \"args\": [\n    \"x\",\n    \"y\"\n  ],\n  \"empty\": []\n}"
    );
    assert_eq!(parse(&pretty).unwrap(), value);
}

#[test]
fn порядок_ключей_сохраняется() {
    let value = parse(r#"{"id":"a","name":"b","command":"c"}"#).unwrap();
    let keys: Vec<String> = match value {
        Value::Obj(pairs) => pairs.into_iter().map(|(k, _)| k).collect(),
        _ => Vec::new(),
    };
    assert_eq!(keys, vec!["id", "name", "command"], "файлы не «прыгают» между записями");
}

#[test]
fn числа_и_флаги_приводятся_к_тексту() {
    assert_eq!(Value::Num(25565.0).text(), "25565");
    assert_eq!(Value::Num(1.5).text(), "1.5");
    assert_eq!(Value::Bool(true).text(), "true");
    assert_eq!(Value::Null.text(), "");
    assert!(Value::str("true").as_bool());
    assert!(Value::str("да").as_bool());
    assert!(!Value::str("нет").as_bool());
    assert_eq!(Value::str("4096").as_f64(), Some(4096.0), "порт и память приходят то числом, то строкой");
}

#[test]
fn битый_json_даёт_понятную_ошибку() {
    let err = parse("{ не json }").unwrap_err();
    assert!(err.contains("ожидался") || err.contains("непонятный"), "ошибка: {err}");
    let err = parse("").unwrap_err();
    assert!(err.contains("текст закончился"), "ошибка: {err}");
    let fallback = Value::Arr(Vec::new());
    assert_eq!(parse_or("][", fallback.clone()), fallback, "битый файл не роняет панель");
}

#[test]
fn лишние_символы_после_значения_ловятся() {
    let err = parse(r#"{"a":1} хвост"#).unwrap_err();
    assert!(err.contains("лишние символы"), "ошибка: {err}");
}

#[test]
fn повторный_ключ_берёт_последнее_значение() {
    let value = parse(r#"{"a":1,"a":2}"#).unwrap();
    assert_eq!(value.get("a").unwrap().as_f64(), Some(2.0));
}
