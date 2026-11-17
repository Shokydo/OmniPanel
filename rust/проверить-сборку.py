#!/usr/bin/env python3
"""Проверка файла сборки до отправки на GitHub.

Зачем: если в `.github/workflows/build-windows.yml` нарушить отступы, GitHub
не запускает ни одного шага — запуск помечается «failure» с нулём заданий, и
по нему невозможно понять, что случилось. Такое уже случалось: строка описания
релиза потеряла отступ внутри `--notes @"…"@` и весь файл перестал быть YAML.

Запускать перед отправкой:
    python3 rust/проверить-сборку.py
"""
from __future__ import annotations

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
WORKFLOW = ROOT / ".github" / "workflows" / "build-windows.yml"


def main() -> int:
    text = WORKFLOW.read_text(encoding="utf-8")
    try:
        import yaml  # type: ignore
    except ImportError:
        print("нет PyYAML — проверяю только отступы")
        yaml = None

    problems: list[str] = []

    if yaml is not None:
        try:
            data = yaml.safe_load(text)
        except Exception as error:  # noqa: BLE001 — нужен любой текст ошибки
            print(f"сборка не разбирается как YAML: {error}")
            return 1
        jobs = data.get("jobs") or {}
        if not jobs:
            problems.append("в файле нет ни одного задания")
        for name, job in jobs.items():
            steps = job.get("steps") or []
            if not steps:
                problems.append(f"у задания {name} нет шагов")
            for step in steps:
                if not (step.get("run") or step.get("uses")):
                    problems.append(f"шаг «{step.get('name')}» ничего не делает")
        triggers = data.get("on") or data.get(True) or {}
        if not triggers:
            problems.append("нет раздела on: сборку нечем запустить")

    # строки, которые начинаются с колонки 0 внутри блока run:, ломают YAML
    inside_run = False
    for number, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if stripped.startswith("- run:") or stripped == "run: |":
            inside_run = True
            continue
        if inside_run and line and not line[0].isspace():
            problems.append(f"строка {number} вышла из блока run: — {line[:60]}")
            inside_run = False

    if problems:
        for problem in problems:
            print("  ✗", problem)
        return 1
    print("сборка: файл в порядке")
    return 0


if __name__ == "__main__":
    sys.exit(main())
