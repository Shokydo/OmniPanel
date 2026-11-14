#!/bin/bash
# Публикация OmniPanel одной командой: код в main → релиз с установщиком → вики.
#
#   GITHUB_TOKEN=github_pat_... bash tools/publish-release.sh
#
# Что делает:
#   1) клонирует репозиторий во временную папку;
#   2) кладёт туда текущие файлы панели (без dist, .build, node_modules);
#   3) коммитит и пушит в main;
#   4) заливает релиз: ассет-установщик + update.json + dist/OmniPanel-code.zip;
#   5) публикует вики из docs/wiki (если она включена в настройках репозитория).
#
# Токен нужен только на время запуска, в файлы он не пишется.
set -e

REPO="${OMNI_REPO:-Shokydo/OmniPanel}"
TOKEN="${GITHUB_TOKEN:-}"
APP="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('$APP/package.json').version")"
EXE="${OMNI_EXE:-/home/user/OmniPanel-Установка-$VERSION.exe}"
CODE="$APP/dist/OmniPanel-code.zip"

if [ -z "$TOKEN" ]; then
  echo "Нужен токен: GITHUB_TOKEN=... bash tools/publish-release.sh"
  exit 1
fi
if [ ! -f "$EXE" ]; then
  echo "Нет установщика: $EXE"
  echo "Собери: bash installer/build-all.sh $VERSION \"заметки\""
  exit 1
fi
if [ ! -f "$CODE" ]; then
  echo "Нет файла обновления кода: $CODE"
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "── версия $VERSION → $REPO ──"
echo "── клонирую репозиторий ──"
git clone --depth 1 "https://x-access-token:$TOKEN@github.com/$REPO.git" "$WORK/repo" >/dev/null 2>&1 || {
  echo "Клон не удался: проверь токен и доступ к репозиторию"; exit 1;
}

echo "── синхронизирую файлы панели ──"
for item in main.js preload.js web.js package.json update.json core ui assets tools docs installer tests demo \
            servers.example.json README.md LICENSE "ЧИТАЙ-МЕНЯ.txt" \
            "7-Собрать-обновление.bat" "8-Выложить-обновление.bat" .gitattributes .gitignore; do
  [ -e "$APP/$item" ] || continue
  rm -rf "$WORK/repo/$item"
  cp -r "$APP/$item" "$WORK/repo/$item"
done
# update.json в репозитории — тот, что раздаётся клиентам; dist едет в релиз, но и в репозитории нужен
mkdir -p "$WORK/repo/dist"
cp "$APP/dist/OmniPanel-code.zip" "$WORK/repo/dist/OmniPanel-code.zip"
cp "$APP/dist/update.json" "$WORK/repo/dist/update.json"
cp "$APP/dist/update.json" "$WORK/repo/update.json"

cd "$WORK/repo"
git add -A
if git diff --cached --quiet; then
  echo "── в репозитории уже всё актуально ──"
else
  git -c user.name=OmniPanel -c user.email=omnipanel@local commit -q -m "OmniPanel $VERSION"
  echo "── пушу в main ──"
  git push origin HEAD:main
fi
COMMIT="$(git rev-parse HEAD)"
echo "   коммит: $COMMIT"

cd "$APP"
echo "── заливаю релиз v$VERSION ──"
GITHUB_TOKEN="$TOKEN" node tools/upload-update.js \
  --repo "$REPO" \
  --code "$CODE" \
  --exe "$EXE"

echo "── публикую вики ──"
GITHUB_TOKEN="$TOKEN" node tools/publish-wiki.js --repo "$REPO" || \
  echo "   вики не опубликована — включи Settings → Features → Wikis (для вики нужен classic-токен с правом repo)"

echo
echo "готово:"
echo "  код:    https://github.com/$REPO/commit/$COMMIT"
echo "  релиз:  https://github.com/$REPO/releases/tag/v$VERSION"
echo "  вики:   https://github.com/$REPO/wiki"
echo
echo "не забудь отозвать токен: https://github.com/settings/tokens"
