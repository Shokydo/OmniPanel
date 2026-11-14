#!/bin/bash
# Полная сборка OmniPanel: Electron-сборка для Windows, установщик-одним-exe и файлы обновления.
# Использование:  ./build-all.sh [версия]
# Зависимости: mingw-w64, node+npm, unzip, curl.
set -e
VERSION="${1:-$(node -p "require('../OmniPanel/package.json').version")}"
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HERE/../OmniPanel"
BUILD="${OMNI_BUILD_DIR:-/home/user/.build}"
ELECTRON_VER="33.4.11"
CACHE="/home/user/.cache/bld"

echo "── версия: $VERSION ──"
mkdir -p "$BUILD" "$CACHE"

# 1. зависимости для правки ресурсов PE
if [ ! -d "$CACHE/node_modules/resedit" ]; then
  echo "── ставлю resedit (правка иконки и версии exe) ──"
  (cd "$CACHE" && npm init -y >/dev/null 2>&1 && npm i resedit >/dev/null 2>&1)
fi

# 2. electron для Windows
if [ ! -f "$BUILD/exe/OmniPanel.exe" ]; then
  echo "── качаю Electron $ELECTRON_VER для Windows ──"
  [ -f "$BUILD/electron.zip" ] || curl -sSL -o "$BUILD/electron.zip" \
    "https://github.com/electron/electron/releases/download/v$ELECTRON_VER/electron-v$ELECTRON_VER-win32-x64.zip"
  rm -rf "$BUILD/exe"
  mkdir -p "$BUILD/exe"
  unzip -q "$BUILD/electron.zip" -d "$BUILD/exe"
  mv "$BUILD/exe/electron.exe" "$BUILD/exe/OmniPanel.exe"
  find "$BUILD/exe/locales" -name "*.pak" ! -name "en-US.pak" ! -name "ru.pak" -delete
fi

# 3. файлы панели внутрь сборки
echo "── кладу файлы панели ──"
rm -rf "$BUILD/exe/resources/app"
mkdir -p "$BUILD/exe/resources/app"
( cd "$APP" && cp -r main.js preload.js web.js core ui assets tools package.json \
    servers.example.json README.md "ЧИТАЙ-МЕНЯ.txt" "$BUILD/exe/resources/app/" )

# 4. иконка и версия exe панели
echo "── ресурсы exe (иконка + версия) ──"
cat > "$CACHE/patch-pe.js" <<'JS'
const fs = require('fs');
const ResEdit = require('resedit');
const [exePath, version, icoPath, kind = 'panel'] = process.argv.slice(2);
const [maj, min, pat] = version.split('.').map((n) => Number(n) || 0);
const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
const res = ResEdit.NtExecutableResource.from(exe);
const ico = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath));
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, ico.icons.map((i) => i.data));
const list = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
if (list.length) {
  const vi = list[0];
  vi.setFileVersion(maj, min, pat, 0);
  vi.setProductVersion(maj, min, pat, 0);
  vi.setStringValues({ lang: 1033, codepage: 1200 }, {
    ProductName: 'OmniPanel',
    FileDescription: kind === 'setup' ? 'OmniPanel - ustanovshchik' : 'OmniPanel - panel upravleniya serverami',
    CompanyName: 'OmniPanel',
    LegalCopyright: 'MIT',
    OriginalFilename: kind === 'setup' ? 'OmniPanel-Setup.exe' : 'OmniPanel.exe',
    InternalName: kind === 'setup' ? 'OmniPanelSetup' : 'OmniPanel',
    FileVersion: `${maj}.${min}.${pat}.0`,
    ProductVersion: `${maj}.${min}.${pat}.0`,
  });
  vi.outputToResourceEntries(res.entries);
}
res.outputResource(exe);
fs.writeFileSync(exePath, Buffer.from(exe.generate()));
console.log('   ok:', exePath);
JS
node "$CACHE/patch-pe.js" "$BUILD/exe/OmniPanel.exe" "$VERSION" "$APP/assets/icon.ico" panel

# 5. архив сборки (то, что кладётся внутрь установщика и в релиз)
echo "── упаковываю сборку ──"
rm -f "$BUILD/win64.zip"
( cd "$BUILD/exe" && zip -qr9 "$BUILD/win64.zip" . )
ls -la "$BUILD/win64.zip"

# 6. установщик: сборочный rc под текущую версию + полезная нагрузка
echo "── собираю установщик ──"
cd "$HERE"
IFS='.' read -r MAJ MIN PATCH <<< "$VERSION"
sed -e "s/FILEVERSION .*/FILEVERSION $MAJ,$MIN,$PATCH,0/" \
    -e "s/PRODUCTVERSION .*/PRODUCTVERSION $MAJ,$MIN,$PATCH,0/" \
    -e "s/\"FileVersion\", \"[^\"]*\"/\"FileVersion\", \"$VERSION.0\"/" \
    -e "s/\"ProductVersion\", \"[^\"]*\"/\"ProductVersion\", \"$VERSION.0\"/" \
    -e "s/APP_VERSION \".*\"/APP_VERSION \"$VERSION\"/" omni.rc > omni.build.rc
sed -i 's/#define APP_VERSION.*//' omni.build.rc
x86_64-w64-mingw32-windres -c 65001 omni.build.rc -O coff -o omni.res.o
sed -i "s/#define APP_VERSION \".*\"/#define APP_VERSION \"$VERSION\"/" installer.c
x86_64-w64-mingw32-gcc -O2 -Wall -Wextra -static -s -o build-setup.exe installer.c omni.res.o

OUT="$HERE/../OmniPanel-Установка-$VERSION.exe"
cp build-setup.exe "$OUT"
python3 - "$OUT" "$BUILD/win64.zip" <<'PY'
import struct, sys, os
out, win64 = sys.argv[1], sys.argv[2]
payload = open(win64, 'rb').read()
with open(out, 'ab') as f:
    f.write(payload)
    f.write(b'OMNIUPD1' + struct.pack('<Q', len(payload)))
print('   установщик:', out, round(os.path.getsize(out) / 1048576, 2), 'МБ')
PY

# 7. файлы канала обновлений
echo "── файлы обновления ──"
cd "$APP"
node tools/make-update.js --notes "${2:-OmniPanel $VERSION}" | tail -8

echo
echo "готово:"
echo "  $OUT"
echo "  $BUILD/win64.zip"
echo "  $APP/dist/OmniPanel-code.zip, $APP/dist/update.json"
