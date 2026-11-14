#!/bin/sh
# Сборка установщика OmniPanel: один exe с панелью внутри.
#   ./make.sh <версия> [путь к папке OmniPanel-win64]
# Нужен mingw-w64 (x86_64-w64-mingw32-gcc) и node с resedit для ресурсов.
set -e
VERSION="${1:-1.11.1}"
WIN64="${2:-/tmp/win64.zip}"
PATCH="${PATCH:-/home/user/.cache/bld/patch-installer.js}"
cd "$(dirname "$0")"

x86_64-w64-mingw32-gcc -O2 -Wall -Wextra -static -s -mwindows -o build-setup.exe installer.c -lgdi32 -lshell32 -lole32 -luuid
[ -f "$PATCH" ] && node "$PATCH" build-setup.exe "$VERSION" ../OmniPanel/assets/icon.ico

OUT="../OmniPanel-Установка-${VERSION}.exe"
cp build-setup.exe "$OUT"
python3 - "$OUT" "$WIN64" <<'PY'
import struct, sys, os
out, win64 = sys.argv[1], sys.argv[2]
payload = open(win64, 'rb').read()
with open(out, 'ab') as f:
    f.write(payload)
    f.write(b'OMNIUPD1' + struct.pack('<Q', len(payload)))
print('готово:', out, round(os.path.getsize(out) / 1048576, 2), 'МБ')
PY
