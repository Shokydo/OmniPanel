#!/usr/bin/env python3
"""Проверка кода, который собирается только под Windows — без Windows.

В песочнице нет ни MSVC, ни mingw, поэтому `cargo check --target
x86_64-pc-windows-gnu` падает на C-зависимости (ring). Зато можно заставить
rustc собрать наш крейт так, будто мы на Windows:

    cargo rustc --bin … -- -A explicit_builtin_cfgs_in_flags --cfg windows

Зависимости при этом остаются линуксовыми, а вот `#[cfg(windows)]`-ветки
нашего кода компилируются по-настоящему — именно так ловится «удалил функцию,
а её зовут» (однажды так и вышло с `shortcuts`).

Единственная ожидаемая ошибка — `std::os::windows::*`: стандартная библиотека
здесь собрана под Linux, и этого модуля в ней нет. Такие ошибки отбрасываем,
любые другие — провал проверки.

Запуск:  python3 rust/windows-код.py
"""

import re
import subprocess
import sys

# вывод в консоль Windows — в UTF-8: иначе кириллица в отчёте роняет скрипт
for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass


ROOT = __import__("pathlib").Path(__file__).resolve().parent.parent
ENV_WRAPPER = ROOT / "rustenv.sh"
# чего ждём на Linux: в стандартной библиотеке нет std::os::windows::*
EXPECTED = [
    "could not find `windows` in `os`",
    "no method named `creation_flags`",
    "no method named `raw_arg`",
    "could not compile",  # итоговая строка после ожидаемых ошибок
]

TARGETS = [
    ("omnipanel-core", ["check"]),
    ("omnipanel-setup", ["rustc", "--bin", "omnipanel-setup", "--"]),
]


def run(crate, args):
    command = ["sh", str(ENV_WRAPPER)] + args
    if args and args[0] != "rustc":
        command += ["-p", crate]
    if args and args[0] == "rustc":
        command += ["-A", "explicit_builtin_cfgs_in_flags", "--cfg", "windows", "--emit=metadata"]
    return subprocess.run(
        command,
        cwd=ROOT / "rust" / crate,
        capture_output=True,
        text=True,
    )


def real_errors(text):
    """Оставляет только те ошибки, которых не ждём."""
    blocks = re.split(r"(?m)^error", text)
    problems = []
    for block in blocks[1:]:
        if any(marker in block for marker in EXPECTED):
            continue
        first = "error" + block.strip().splitlines()[0]
        problems.append(first.strip()[:200])
    return problems


def main():
    if sys.platform == "win32":
        # на Windows код и так собирается по-настоящему — кросс-проверка не нужна
        print("windows-код: не требуется (мы уже на Windows)")
        return 0
    failed = False
    for crate, args in TARGETS:
        print(f"── {crate} ──")
        result = run(crate, args)
        problems = real_errors(result.stdout + result.stderr)
        if problems:
            failed = True
            for text in problems:
                print("  ✗", text)
        elif result.returncode != 0:
            print("  ok (только ожидаемые ошибки std::os::windows)")
        else:
            print("  ok")
    if failed:
        print("windows-код: есть ошибки")
        return 1
    print("windows-код: проверено")
    return 0


if __name__ == "__main__":
    sys.exit(main())
