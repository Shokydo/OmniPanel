//! Ядро OmniPanel на Rust.
//!
//! Здесь живёт то, что раньше лежало в `core/*.js`: работа с серверами,
//! файлами, `server.properties` и портами. Всё на стандартной библиотеке —
//! никаких внешних зависимостей, поэтому собирается быстро и без сети.

pub mod app;
pub mod b64;
pub mod files;
pub mod json;
pub mod ports;
pub mod props;
pub mod props_schema;
pub mod servers;
pub mod zip;

pub use files::{Entry, FileError, Files};
pub use props::{Props, PropsFile};
pub use app::{App, AppInfo, READY_CHANNELS};
pub use json::Value;
pub use servers::{Event, EventKind, Manager, ServerConfig, ServerState, Store};
