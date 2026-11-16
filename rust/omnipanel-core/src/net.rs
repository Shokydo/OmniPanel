//! Запросы в интернет: GitHub, GitLab, файлы обновлений.
//!
//! Одно место на все внешние запросы — чтобы токены не утекали в логи, а
//! ошибки всегда были понятными по-русски. Токен передаётся здесь и только
//! в заголовок запроса; в сообщения об ошибках он не попадает никогда.

use crate::json::Value;

/// Отправляет запрос. В ureq 3 «запрос с телом» и «без тела» — разные типы,
/// поэтому каждая ветка собирается целиком.
fn send(
    agent: &ureq::Agent,
    method: &str,
    url: &str,
    headers: &[(&str, String)],
    body: Option<(&str, &str)>,
) -> Result<Reply, String> {
    let result = match (method, body) {
        ("POST", Some((content_type, text))) => {
            let mut req = agent.post(url);
            for (name, value) in headers {
                req = req.header(*name, value);
            }
            req.header("Content-Type", content_type).send(text)
        }
        ("PATCH", Some((content_type, text))) => {
            let mut req = agent.patch(url);
            for (name, value) in headers {
                req = req.header(*name, value);
            }
            req.header("Content-Type", content_type).send(text)
        }
        ("PATCH", None) => {
            let mut req = agent.patch(url);
            for (name, value) in headers {
                req = req.header(*name, value);
            }
            req.send("")
        }
        ("PUT", Some((content_type, text))) => {
            let mut req = agent.put(url);
            for (name, value) in headers {
                req = req.header(*name, value);
            }
            req.header("Content-Type", content_type).send(text)
        }
        ("POST", None) => {
            let mut req = agent.post(url);
            for (name, value) in headers {
                req = req.header(*name, value);
            }
            req.send("")
        }
        ("PUT", None) => {
            let mut req = agent.put(url);
            for (name, value) in headers {
                req = req.header(*name, value);
            }
            req.send("")
        }
        ("DELETE", _) => {
            let mut req = agent.delete(url);
            for (name, value) in headers {
                req = req.header(*name, value);
            }
            req.call()
        }
        _ => {
            let mut req = agent.get(url);
            for (name, value) in headers {
                req = req.header(*name, value);
            }
            req.call()
        }
    };
    match result {
        Ok(mut response) => Ok(Reply {
            status: response.status().as_u16(),
            body: response.body_mut().read_to_string().unwrap_or_default(),
        }),
        /* ureq считает 4xx/5xx ошибкой — для панели это обычный ответ с кодом */
        Err(ureq::Error::StatusCode(code)) => Ok(Reply { status: code, body: String::new() }),
        Err(err) => Err(format!("нет связи: {}", err)),
    }
}

/// Ответ сервера.
#[derive(Debug, Clone)]
pub struct Reply {
    pub status: u16,
    pub body: String,
}

impl Reply {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// Тело как JSON (пустое тело — пустой объект, а не ошибка).
    pub fn json(&self) -> Value {
        crate::json::parse(&self.body).unwrap_or(Value::Obj(Vec::new()))
    }

    /// Сообщение об ошибке для интерфейса: код и текст от сервера.
    pub fn error_text(&self, what: &str) -> String {
        let payload = self.json();
        let message = payload
            .get("message")
            .or_else(|| payload.get("error"))
            .map(|v| v.text())
            .unwrap_or_else(|| self.body.chars().take(200).collect());
        format!("{}: {} (код {})", what, message, self.status)
    }
}

/// Запрос без токена (обновления, публичные адреса).
pub fn get(url: &str) -> Result<Reply, String> {
    request("GET", url, None, None, None)
}

/// Запрос с токеном.
pub fn get_with_token(url: &str, token: &str) -> Result<Reply, String> {
    request("GET", url, Some(token), None, None)
}

/// Запрос с телом JSON.
pub fn post_json(url: &str, token: &str, body: &Value) -> Result<Reply, String> {
    let text = body.to_json();
    request("POST", url, Some(token), Some(&text), Some("application/json"))
}

/// Удаление.
pub fn delete(url: &str, token: &str) -> Result<Reply, String> {
    request("DELETE", url, Some(token), None, None)
}

/// Свой заголовок авторизации (GitLab ждёт `PRIVATE-TOKEN`, GitHub — `Bearer`).
pub fn request_with_header(
    method: &str,
    url: &str,
    header: Option<(&str, &str)>,
    body: Option<(&str, &str)>,
) -> Result<Reply, String> {
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(60)))
        .user_agent("OmniPanel")
        .build();
    let agent: ureq::Agent = config.into();
    let headers: Vec<(&str, String)> = match header {
        Some((name, value)) => vec![(name, value.to_string())],
        None => Vec::new(),
    };
    send(&agent, method, url, &headers, body)
}

fn request(
    method: &str,
    url: &str,
    token: Option<&str>,
    body: Option<&str>,
    content_type: Option<&str>,
) -> Result<Reply, String> {
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(60)))
        .user_agent("OmniPanel")
        .build();
    let agent: ureq::Agent = config.into();

    let mut headers: Vec<(&str, String)> = vec![("Accept", "application/json".to_string())];
    if let Some(token) = token {
        if !token.trim().is_empty() {
            headers.push(("Authorization", format!("Bearer {}", token.trim())));
        }
    }
    let body = body.map(|text| (content_type.unwrap_or("application/json"), text));
    send(&agent, method, url, &headers, body)
}

/// Скачивает файл по адресу. Возвращает число байт.
pub fn download(url: &str, dest: &std::path::Path, token: Option<&str>) -> Result<u64, String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("не создать папку: {}", e))?;
    }
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(600)))
        .user_agent("OmniPanel")
        .build();
    let agent: ureq::Agent = config.into();
    let mut req = agent.get(url).header("Accept", "application/octet-stream");
    if let Some(token) = token {
        if !token.trim().is_empty() {
            req = req.header("Authorization", &format!("Bearer {}", token.trim()));
        }
    }
    let mut response = match req.call() {
        Ok(response) => response,
        Err(ureq::Error::StatusCode(code)) => return Err(format!("сервер ответил кодом {}", code)),
        Err(err) => return Err(format!("нет связи: {}", err)),
    };
    let mut file = std::fs::File::create(dest).map_err(|e| format!("не создать файл: {}", e))?;
    let copied = std::io::copy(&mut response.body_mut().as_reader(), &mut file)
        .map_err(|e| format!("не записать файл: {}", e))?;
    Ok(copied)
}

/// Есть ли интернет (для понятного сообщения вместо долгого ожидания).
pub fn online() -> bool {
    std::net::TcpStream::connect_timeout(
        &"1.1.1.1:443".parse().expect("адрес"),
        std::time::Duration::from_secs(3),
    )
    .is_ok()
}

/// Скачивание с произвольным заголовком (GitLab ждёт `PRIVATE-TOKEN`).
pub fn download_with_header(
    url: &str,
    dest: &std::path::Path,
    header: Option<(&str, &str)>,
) -> Result<u64, String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("не создать папку: {}", e))?;
    }
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(900)))
        .user_agent("OmniPanel")
        .build();
    let agent: ureq::Agent = config.into();
    let mut req = agent.get(url);
    if let Some((name, value)) = header {
        req = req.header(name, value);
    }
    let mut response = match req.call() {
        Ok(response) => response,
        Err(ureq::Error::StatusCode(code)) => return Err(format!("сервер ответил кодом {}", code)),
        Err(err) => return Err(format!("нет связи: {}", err)),
    };
    let mut file = std::fs::File::create(dest).map_err(|e| format!("не создать файл: {}", e))?;
    std::io::copy(&mut response.body_mut().as_reader(), &mut file)
        .map_err(|e| format!("не записать файл: {}", e))
}

/// Ответ двоичными данными: архивы, картинки, файлы репозитория.
/// Возвращает код ответа и тело — 4xx для панели такой же ответ, как 2xx.
pub fn get_bytes(url: &str, header: Option<(&str, &str)>) -> Result<(u16, Vec<u8>), String> {
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(300)))
        .user_agent("OmniPanel")
        .build();
    let agent: ureq::Agent = config.into();
    let mut req = agent.get(url);
    if let Some((name, value)) = header {
        req = req.header(name, value);
    }
    match req.call() {
        Ok(mut response) => {
            let status = response.status().as_u16();
            let mut body = Vec::new();
            if status < 400 {
                response
                    .body_mut()
                    .read_to_vec()
                    .map(|mut bytes| std::mem::swap(&mut body, &mut bytes))
                    .map_err(|e| format!("не прочитать ответ: {}", e))?;
            }
            Ok((status, body))
        }
        Err(ureq::Error::StatusCode(code)) => Ok((code, Vec::new())),
        Err(err) => Err(format!("нет связи: {}", err)),
    }
}
