#!/bin/sh
# Достаёт zip с панелью из готового установщика.
#   ./unpack-payload.sh OmniPanel-Установка-1.11.1.exe out.zip
set -e
EXE="$1"
OUT="${2:-payload.zip}"
python3 - "$EXE" "$OUT" <<'PY'
import struct, sys, hashlib
exe, out = sys.argv[1], sys.argv[2]
data = open(exe, 'rb').read()
magic, size = data[-16:-8], struct.unpack('<Q', data[-8:])[0]
assert magic == b'OMNIUPD1', 'в файле нет встроенного архива'
payload = data[-16 - size:-16]
open(out, 'wb').write(payload)
print('готово:', out, round(len(payload) / 1048576, 2), 'МБ, sha256', hashlib.sha256(payload).hexdigest()[:16])
PY
