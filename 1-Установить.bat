@echo off
chcp 65001 >nul
title Local Server Panel - установка
cd /d "%~dp0"

echo.
echo   === Local Server Panel: установка ===
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [ОШИБКА] Node.js не найден.
  echo.
  echo   Скачай и установи Node.js LTS: https://nodejs.org/ru
  echo   После установки запусти этот файл снова.
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -v') do echo   Node.js: %%v
echo.
echo   Ставлю зависимости (первый раз ~1-3 минуты)...
echo.
call npm install
if errorlevel 1 (
  echo.
  echo   [ОШИБКА] Не удалось установить зависимости.
  echo   Проверь интернет и попробуй снова.
  pause
  exit /b 1
)

echo.
echo   Готово! Теперь запускай "2-Запустить.bat"
echo.
pause
