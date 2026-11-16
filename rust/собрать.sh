#!/bin/sh
# Сборка и проверка Rust-ядра OmniPanel.
#
#   ./rust/собрать.sh          — прогнать все тесты
#   ./rust/собрать.sh build    — просто собрать
#   ./rust/собрать.sh run      — запустить панель (интерфейс откроется по адресу из вывода)
#
# Если Rust не установлен, скрипт скачает его сам (rustc, cargo и стандартную
# библиотеку 1.85.1) в ~/toolchain — без прав администратора и без сети после
# первой загрузки.

set -e
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=${OMNI_RUST_HOME:-$HOME/toolchain}
export PATH="$ROOT/rust/bin:$PATH"
export CARGO_HOME="$ROOT/cargo"
export CARGO_TARGET_DIR="$ROOT/work"
export CARGO_NET_OFFLINE=${CARGO_NET_OFFLINE:-true}

install_rust() {
  echo "Rust не найден — скачиваю 1.85.1 в $ROOT"
  mkdir -p "$ROOT/dl"
  cd "$ROOT/dl"
  for crate in rustc rust-std cargo; do
    curl -sSL -o "$crate.tar.xz" \
      "https://static.rust-lang.org/dist/$crate-1.85.1-x86_64-unknown-linux-gnu.tar.xz"
    tar -xf "$crate.tar.xz"
    (cd "$crate-1.85.1-x86_64-unknown-linux-gnu" && ./install.sh --prefix="$ROOT/rust" --disable-ldconfig >/dev/null)
    rm -rf "$crate-1.85.1-x86_64-unknown-linux-gnu" "$crate.tar.xz"
  done
  cd "$HERE"
}

if ! command -v cargo >/dev/null 2>&1; then
  install_rust
fi

cd "$HERE/omnipanel-core"

case "${1:-test}" in
  test)  cargo test  ;;
  build) cargo build --release ;;
  run)   cargo run --release -- --port "${2:-47800}" --ui "$HERE/../ui" ;;
  *)     cargo "$@" ;;
esac
