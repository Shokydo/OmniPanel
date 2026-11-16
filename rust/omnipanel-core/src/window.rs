//! Управление окном: свернуть, закрыть, развернуть, полный экран.
//!
//! Интерфейс панели сам рисует свою шапку и сам зовёт эти команды
//! (`winMinimize`, `winClose`, `winToggleMax`, `winToggleFull`). Между
//! интерфейсом и оконным слоем стоит этот мост: интерфейс кладёт команду,
//! оконный поток её забирает, а состояние окна возвращается обратно.
//!
//! Зачем так: HTTP-режим и окно — разные потоки, а окно живёт только в
//! оконном слое (Tauri). Мост позволяет проверять всю логику тестами здесь,
//! не поднимая окно.

use crate::json::Value;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

/// Что попросил интерфейс.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowCommand {
    Minimize,
    /// Свернуть в трей (кнопка «закрыть» в шапке панели).
    Close,
    ToggleMaximize,
    ToggleFullscreen,
    Show,
    Quit,
}

impl WindowCommand {
    pub fn parse(text: &str) -> Option<WindowCommand> {
        match text {
            "minimize" => Some(WindowCommand::Minimize),
            "close" => Some(WindowCommand::Close),
            "toggleMax" | "toggle-max" => Some(WindowCommand::ToggleMaximize),
            "toggleFull" | "toggle-full" => Some(WindowCommand::ToggleFullscreen),
            "show" => Some(WindowCommand::Show),
            "quit" => Some(WindowCommand::Quit),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            WindowCommand::Minimize => "minimize",
            WindowCommand::Close => "close",
            WindowCommand::ToggleMaximize => "toggleMax",
            WindowCommand::ToggleFullscreen => "toggleFull",
            WindowCommand::Show => "show",
            WindowCommand::Quit => "quit",
        }
    }
}

/// Общее состояние: очередь команд и то, что окно о себе сообщает.
#[derive(Debug, Default)]
struct Shared {
    queue: VecDeque<WindowCommand>,
    visible: bool,
    maximized: bool,
    fullscreen: bool,
}

/// Мост «интерфейс ↔ окно».
#[derive(Clone)]
pub struct WindowBridge {
    shared: Arc<Mutex<Shared>>,
}

impl Default for WindowBridge {
    fn default() -> Self {
        Self::new()
    }
}

impl WindowBridge {
    pub fn new() -> WindowBridge {
        WindowBridge {
            shared: Arc::new(Mutex::new(Shared {
                queue: VecDeque::new(),
                visible: true,
                maximized: false,
                fullscreen: false,
            })),
        }
    }

    /// Интерфейс просит выполнить команду.
    pub fn request(&self, command: WindowCommand) {
        self.shared.lock().unwrap().queue.push_back(command);
    }

    /// Оконный поток забирает все накопившиеся команды.
    pub fn take_commands(&self) -> Vec<WindowCommand> {
        let mut shared = self.shared.lock().unwrap();
        shared.queue.drain(..).collect()
    }

    /// Оконный поток сообщает, как выглядит окно сейчас.
    pub fn set_state(&self, visible: bool, maximized: bool, fullscreen: bool) {
        let mut shared = self.shared.lock().unwrap();
        shared.visible = visible;
        shared.maximized = maximized;
        shared.fullscreen = fullscreen;
    }

    /// Состояние для интерфейса (ответ на `winState`).
    pub fn state_json(&self) -> Value {
        let shared = self.shared.lock().unwrap();
        Value::obj(vec![
            ("visible", Value::Bool(shared.visible)),
            ("maximized", Value::Bool(shared.maximized)),
            ("fullscreen", Value::Bool(shared.fullscreen)),
        ])
    }

    pub fn is_visible(&self) -> bool {
        self.shared.lock().unwrap().visible
    }

    /// Сколько команд ждёт окно (для тестов).
    pub fn pending(&self) -> usize {
        self.shared.lock().unwrap().queue.len()
    }
}
