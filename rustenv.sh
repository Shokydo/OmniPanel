#!/bin/sh
# Обёртка для сборки Rust в этой песочнице.
#
#   ./rustenv.sh <cargo-аргументы…>        — например: ./rustenv.sh test
#   ./rs/… нет; запускать из папки крейта:  ../..//rustenv.sh test
#
# В песочнице /tmp — это tmpfs на 1 ГБ, а Rust с зависимостями занимает ~860 МБ,
# поэтому инструменты живут в ~/build/tc (папка build не попадает ни в git, ни в
# снимок рабочей папки). Если её нет и создать нельзя — берём /tmp/tc.
# На обычной машине этот скрипт не нужен: там достаточно `cargo`.

if [ -n "$OMNI_TC" ]; then
  TC="$OMNI_TC"
elif [ -w /home/user ]; then
  TC=/home/user/build/tc
else
  TC=/tmp/tc
fi
CALLER=$(pwd)
if [ ! -x "$TC/rust/bin/cargo" ]; then
  echo "── ставлю Rust 1.91.0 ──" >&2
  mkdir -p "$TC/dl"
  cd "$TC/dl" || exit 1
  for crate in rustc rust-std cargo; do
    curl -sSL -o "$crate.tar.xz" \
      "https://static.rust-lang.org/dist/$crate-1.91.0-x86_64-unknown-linux-gnu.tar.xz" || exit 1
    tar -xf "$crate.tar.xz" || exit 1
    (cd "$crate-1.91.0-x86_64-unknown-linux-gnu" && \
      ./install.sh --prefix="$TC/rust" --disable-ldconfig >/dev/null 2>&1) || exit 1
    rm -rf "$crate-1.91.0-x86_64-unknown-linux-gnu" "$crate.tar.xz"
  done
  rm -rf "$TC/dl"
  echo "── готово ──" >&2
fi

PATH="$TC/rust/bin:$PATH"
CARGO_HOME="$TC/cargo"
CARGO_TARGET_DIR="$TC/work"
export PATH CARGO_HOME CARGO_TARGET_DIR
cd "$CALLER" || exit 1
exec cargo "$@"
