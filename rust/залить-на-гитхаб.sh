#!/bin/sh
# Заливка переезда на GitHub.
#
#   GITHUB_TOKEN=ghp_… ./rust/залить-на-гитхаб.sh
#
# Токен берётся только из переменной окружения: в файлы и в вывод он не пишется.
# Что делает: отправляет текущую ветку как `rust-migration` и открывает
# пул-реквест в main. Ни main, ни релизы не трогает.
set -e
cd "$(dirname "$0")/.."

TOKEN=${GITHUB_TOKEN:-${GH_TOKEN:-}}
if [ -z "$TOKEN" ]; then
  echo "Нужен токен. Возьмите его на https://github.com/settings/tokens"
  echo "и запустите:  GITHUB_TOKEN=ghp_… $0"
  exit 1
fi

REPO=${REPO:-Shokydo/OmniPanel}
BRANCH=${BRANCH:-rust-migration}
REMOTE="https://x-access-token:${TOKEN}@github.com/${REPO}.git"

echo "── отправляю ветку ${BRANCH} в ${REPO} ──"
git push "$REMOTE" "HEAD:refs/heads/${BRANCH}"

echo "── открываю пул-реквест ──"
/usr/bin/env python3 - <<'PY'
import json, os, urllib.request

token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
repo = os.environ.get("REPO", "Shokydo/OmniPanel")
branch = os.environ.get("BRANCH", "rust-migration")
title = "Переезд на Rust: ядро, каналы интерфейса, установщик"
body = """Переезд панели на Rust, по шагам и с проверками на каждом.

* `rust/omnipanel-core` — ядро: серверы, файлы, архивы (свой распаковщик ZIP),
  порты, `server.properties`, баны, TPS, HTTP-режим панели.
* `rust/omnipanel-setup` — установщик на Rust: один exe с панелью внутри.
* `tools/gen-tauri-bridge.js` — мост интерфейса на Rust, собирается из `preload.js`.
* `tools/gen-props-schema.js` — 64 настройки `server.properties` из схемы интерфейса.

Рабочая версия 1.26.0 на Electron не тронута, релизы не выпускались.
"""

def call(url, data=None, method=None):
    req = urllib.request.Request(url, data=json.dumps(data).encode() if data else None,
                                 method=method or ("POST" if data else "GET"))
    req.add_header("Authorization", f"token {token}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as err:
        text = err.read().decode()
        if err.code == 422 and "already exists" in text:
            print("пул-реквест уже открыт")
            return None
        raise SystemExit(f"GitHub ответил {err.code}: {text[:300]}")

existing = call(f"https://api.github.com/repos/{repo}/pulls?head=Shokydo:{branch}&state=open")
if existing:
    print("пул-реквест уже есть:", existing[0]["html_url"])
else:
    pr = call(f"https://api.github.com/repos/{repo}/pulls",
              {"title": title, "head": branch, "base": "main", "body": body})
    if pr:
        print("пул-реквест:", pr["html_url"])
PY
