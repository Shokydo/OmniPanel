#!/usr/bin/env python3
"""Правки 1.40.0: поток событий отдаётся кусками, стук и счётчик слушателей."""
import pathlib

p = pathlib.Path('/home/user/OmniPanel/rust/omnipanel-core/src/http.rs')
t = p.read_text()

# 1) поток событий: правильная кадровая разметка (chunked)
old = """        if path == "/api/events" {
            stream.write_all(
                b"HTTP/1.1 200 OK\\r\\nContent-Type: text/event-stream\\r\\nCache-Control: no-cache\\r\\nConnection: keep-alive\\r\\n\\r\\nretry: 2000\\n\\n",
            )?;
            /* страница открылась позже тихой проверки — сразу расскажем,
               что уже известно про обновление */
            if let Some(state) = self.app.update_state() {
                let _ = write!(stream, "event: upd:state\\ndata: {}\\n\\n", state.to_json());
                let _ = stream.flush();
            }
            self.listeners.lock().unwrap().push(stream);
            return Ok(());
        }"""
new = """        /* поток событий: соединение остаётся открытым */
        if path == "/api/events" {
            /* Ответ отдаём кусками (chunked). Без разметки кусков и без
               Content-Length браузер вправе считать, что тела нет вовсе, —
               тогда строки журнала остаются у него в буфере и консоль не
               обновляется, хотя сервер работает и строки в него приходят. */
            stream.write_all(
                b"HTTP/1.1 200 OK\\r\\nContent-Type: text/event-stream; charset=utf-8\\r\\nCache-Control: no-cache, no-transform\\r\\nConnection: keep-alive\\r\\nTransfer-Encoding: chunked\\r\\nX-Accel-Buffering: no\\r\\n\\r\\n",
            )?;
            write_chunk(&mut stream, "retry: 2000\\n\\n")?;
            /* страница открылась позже тихой проверки — сразу расскажем,
               что уже известно про обновление */
            if let Some(state) = self.app.update_state() {
                let _ = write_chunk(
                    &mut stream,
                    &format!("event: upd:state\\ndata: {}\\n\\n", state.to_json()),
                );
            }
            self.listeners.lock().unwrap().push(stream);
            return Ok(());
        }"""
assert old in t, "не нашёл обработчик /api/events"
t = t.replace(old, new, 1)

# 2) broadcast через куски + сам помощник
old = """fn broadcast(listeners: &Listeners, event: &str, payload: &str) {
    let mut list = listeners.lock().unwrap();
    let message = format!("event: {}\\ndata: {}\\n\\n", event, payload);
    list.retain_mut(|stream| stream.write_all(message.as_bytes()).is_ok());
}"""
new = """fn broadcast(listeners: &Listeners, event: &str, payload: &str) {
    let message = format!("event: {}\\ndata: {}\\n\\n", event, payload);
    let mut list = listeners.lock().unwrap();
    list.retain_mut(|stream| write_chunk(stream, &message).is_ok());
}

/// Один кусок ответа `Transfer-Encoding: chunked`.
fn write_chunk(stream: &mut TcpStream, payload: &str) -> std::io::Result<()> {
    stream.write_all(format!("{:x}\\r\\n", payload.len()).as_bytes())?;
    stream.write_all(payload.as_bytes())?;
    stream.write_all(b"\\r\\n")?;
    stream.flush()
}"""
assert old in t, "не нашёл broadcast"
t = t.replace(old, new, 1)

# 3) стук в открытые страницы
old = """        PanelServer {
            app,
            ui_dir: ui_dir.into(),"""
new = """        /* Раз в несколько секунд отправляем в открытые страницы пустой
           комментарий: так видно, что связь жива, и прокси с антивирусом не
           закрывают «молчащий» поток. */
        let beat = Arc::downgrade(&listeners);
        std::thread::spawn(move || {
            let period = std::env::var("OMNI_SSE_PING")
                .ok()
                .and_then(|value| value.parse::<u64>().ok())
                .filter(|value| *value > 0)
                .unwrap_or(15);
            loop {
                std::thread::sleep(std::time::Duration::from_secs(period));
                let Some(listeners) = beat.upgrade() else { break };
                let mut list = listeners.lock().unwrap();
                if list.is_empty() {
                    continue;
                }
                list.retain_mut(|stream| write_chunk(stream, ": keep\\n\\n").is_ok());
            }
        });

        PanelServer {
            app,
            ui_dir: ui_dir.into(),"""
assert old in t, "не нашёл сборку PanelServer"
t = t.replace(old, new, 1)

# 4) сколько страниц слушает события
old = """    fn route(&self, method: &str, path: &str, query: &str, body: &[u8]) -> Response {"""
new = """    fn route(&self, method: &str, path: &str, query: &str, body: &[u8]) -> Response {
        /* сколько страниц сейчас слушает поток событий: по этому числу видно,
           работает ли живое обновление консоли в окне */
        if path == "/api/events/info" {
            let count = self.listeners.lock().unwrap().len();
            return Response::json(
                200,
                &Value::obj(vec![
                    ("ok", Value::Bool(true)),
                    ("listeners", Value::from(count as u64)),
                ])
                .to_json(),
            );
        }"""
assert old in t, "не нашёл route"
t = t.replace(old, new, 1)

p.write_text(t)
print("http.rs: поток событий кусками, стук, счётчик слушателей")
