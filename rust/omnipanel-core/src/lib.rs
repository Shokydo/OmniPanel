//! Ядро OmniPanel на Rust.
//!
//! Здесь живёт то, что раньше лежало в `core/*.js`: работа с серверами,
//! файлами, `server.properties` и портами. Всё на стандартной библиотеке —
//! никаких внешних зависимостей, поэтому собирается быстро и без сети.

pub mod app;
pub mod backup;
pub mod bot;
pub mod ask;
pub mod autostart;
pub mod b64;
pub mod dialog;
pub mod deflate;
pub mod files;
pub mod json;
pub mod md5;
pub mod kernels;
pub mod load;
pub mod modrinth;
pub mod net;
pub mod notify;
pub mod players;
pub mod ports;
pub mod props;
pub mod image;
pub mod props_schema;
pub mod scan;
pub mod servers;
pub mod sha1;
pub mod sha256;
pub mod http;
pub mod sync;
pub mod update;
pub mod wall;
pub mod window;
pub mod zip;

pub use files::{Entry, FileError, Files};
pub use props::{Props, PropsFile};
pub use app::{App, AppInfo, READY_CHANNELS};
pub use json::Value;
pub use servers::{Event, EventKind, Manager, ServerConfig, ServerState, Store};
