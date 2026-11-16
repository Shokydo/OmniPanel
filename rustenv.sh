#!/bin/sh
# Обёртка для сборки Rust в этой песочнице.
#
#   ./rustenv.sh <cargo-аргументы…>        — например: ./rustenv.sh test
#   ./rs/… нет; запускать из папки крейта:  ../..//rustenv.sh test
#
# Песочница чистит /tmp между сообщениями, поэтому Rust ставится заново
# (около 15 секунд) — скрипт делает это сам и только если его нет.
# На обычной машине этот скрипт не нужен: там достаточно `cargo`.

TC=/tmp/tc
CALLER=$(pwd)
if [ ! -x "$TC/rust/bin/cargo" ]; then
  echo "── ставлю Rust 1.85.1 ──" >&2
  mkdir -p "$TC/dl"
  cd "$TC/dl" || exit 1
  for crate in rustc rust-std cargo; do
    curl -sSL -o "$crate.tar.xz" \
      "https://static.rust-lang.org/dist/$crate-1.85.1-x86_64-unknown-linux-gnu.tar.xz" || exit 1
    tar -xf "$crate.tar.xz" || exit 1
    (cd "$crate-1.85.1-x86_64-unknown-linux-gnu" && \
      ./install.sh --prefix="$TC/rust" --disable-ldconfig >/dev/null 2>&1) || exit 1
    rm -rf "$crate-1.85.1-x86_64-unknown-linux-gnu" "$crate.tar.xz"
  done
  rm -rf "$TC/dl"
  echo "── готово ──" >&2
fi

PATH="$TC/rust/bin:$PATH"
CARGO_HOME="$TC/cargo"
CARGO_TARGET_DIR="$TC/work"
export PATH CARGO_HOME CARGO_TARGET_DIR
cd "$CALLER" || exit 1
exec cargo --offline "$@"
