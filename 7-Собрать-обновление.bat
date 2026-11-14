@echo off
chcp 65001 >nul
title OmniPanel — сборка обновления
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Не найден Node.js. Собрать обновление можно только на машине с Node.js.
  pause
  exit /b 1
)
node tools\make-update.js %*
echo.
echo Готово. Файлы для репозитория лежат в папке dist:
echo    dist\OmniPanel-code.zip  (код панели)
echo    dist\OmniPanel-win64.zip (полная сборка — её прикладывай к релизу)
echo    update.json
pause
