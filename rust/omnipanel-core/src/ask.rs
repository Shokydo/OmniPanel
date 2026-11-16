//! Свои окна вопросов вместо системных.
//!
//! Панель не показывает системный MessageBox: он выбивается из её вида.
//! Вопрос рисует сам интерфейс в своём дизайне, а ядро ждёт ответ —
//! ровно как `askUI` в прежней панели.
//!
//! Если окно не ответило (свернуто в трей, страница перезагружается),
//! ждать вечно нельзя: через пять минут вопрос считается отменённым.

use crate::json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex};

/// Сколько ждём ответа, прежде чем считать вопрос снятым.
pub const TIMEOUT_SECS: u64 = 5 * 60;

/// Кнопка в своём окне.
#[derive(Debug, Clone, PartialEq)]
pub struct Button {
    pub id: String,
    pub label: String,
    pub primary: bool,
    pub danger: bool,
}

impl Button {
    pub fn new(id: &str, label: &str) -> Button {
        Button {
            id: id.to_string(),
            label: label.to_string(),
            primary: false,
            danger: false,
        }
    }

    pub fn primary(mut self) -> Button {
        self.primary = true;
        self
    }

    pub fn danger(mut self) -> Button {
        self.danger = true;
        self
    }

    pub fn to_json(&self) -> Value {
        Value::obj(vec![
            ("id", Value::str(&self.id)),
            ("label", Value::str(&self.label)),
            ("primary", Value::Bool(self.primary)),
            ("danger", Value::Bool(self.danger)),
        ])
    }
}

struct Waiting {
    answer: Mutex<Option<String>>,
    wake: Condvar,
}

/// Ящик вопросов: интерфейс получает событие `ui:ask`, отвечает `ui:answer`.
pub struct Ask {
    next: Mutex<u64>,
    waiting: Arc<Mutex<HashMap<u64, Arc<Waiting>>>>,
    ready: Mutex<bool>,
    /// Сколько раз интерфейс успел сказать «я готов».
    ready_count: Mutex<u64>,
}

impl Default for Ask {
    fn default() -> Self {
        Ask::new()
    }
}

impl Ask {
    pub fn new() -> Ask {
        Ask {
            next: Mutex::new(0),
            waiting: Arc::new(Mutex::new(HashMap::new())),
            ready: Mutex::new(false),
            ready_count: Mutex::new(0),
        }
    }

    /// Интерфейс загрузился и готов показывать окна.
    pub fn ready(&self) {
        *self.ready.lock().unwrap() = true;
        *self.ready_count.lock().unwrap() += 1;
    }

    pub fn is_ready(&self) -> bool {
        *self.ready.lock().unwrap()
    }

    /// Номер следующего вопроса (нужен событию `ui:ask`).
    pub fn next_id(&self) -> u64 {
        let mut next = self.next.lock().unwrap();
        *next += 1;
        *next
    }

    /// Описание вопроса для интерфейса.
    pub fn payload(&self, rid: u64, title: &str, text: &str, buttons: &[Button], kind: &str) -> Value {
        Value::obj(vec![
            ("rid", Value::from(rid)),
            ("title", Value::str(title)),
            ("text", Value::str(text)),
            ("kind", Value::str(kind)),
            (
                "buttons",
                Value::Arr(buttons.iter().map(|b| b.to_json()).collect()),
            ),
        ])
    }

    /// Ответ интерфейса: `ui:answer { rid, id }`.
    pub fn answer(&self, rid: u64, id: &str) -> bool {
        let waiting = self.waiting.lock().unwrap().remove(&rid);
        match waiting {
            Some(slot) => {
                *slot.answer.lock().unwrap() = Some(id.to_string());
                slot.wake.notify_all();
                true
            }
            None => false,
        }
    }

    /// Ждём ответа. Возвращает выбранный `id` или `None`, если не дождались.
    /// `send` вызывается с описанием вопроса — это и есть событие в интерфейс.
    pub fn ask(
        &self,
        title: &str,
        text: &str,
        buttons: &[Button],
        kind: &str,
        send: impl FnOnce(&Value),
    ) -> Option<String> {
        let fallback = buttons
            .iter()
            .find(|b| b.primary)
            .or_else(|| buttons.first())
            .map(|b| b.id.clone());
        let list: Vec<Button> = if buttons.is_empty() {
            vec![Button::new("ok", "Понятно").primary()]
        } else {
            buttons.to_vec()
        };
        let rid = self.next_id();
        let slot = Arc::new(Waiting {
            answer: Mutex::new(None),
            wake: Condvar::new(),
        });
        self.waiting.lock().unwrap().insert(rid, Arc::clone(&slot));
        send(&self.payload(rid, title, text, &list, kind));

        let guard = slot.answer.lock().unwrap();
        let (guard, timeout) = slot
            .wake
            .wait_timeout_while(guard, std::time::Duration::from_secs(TIMEOUT_SECS), |answer| answer.is_none())
            .unwrap();
        let answer = guard.clone();
        drop(guard);
        /* вопрос мог остаться в списке, если никто не ответил */
        self.waiting.lock().unwrap().remove(&rid);
        if timeout.timed_out() {
            return fallback;
        }
        answer.or(fallback)
    }

    /// Сколько вопросов сейчас ждёт ответа (для тестов и отладки).
    pub fn pending(&self) -> usize {
        self.waiting.lock().unwrap().len()
    }

    pub fn ready_count(&self) -> u64 {
        *self.ready_count.lock().unwrap()
    }
}
