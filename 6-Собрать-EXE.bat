@echo off
chcp 65001 >nul
title Сборка LocalServerPanel.exe
cd /d "%~dp0"
echo.
echo   Собираю один portable .exe (займёт несколько минут и ~350 МБ)...
echo.
call npm run dist
if errorlevel 1 (
  echo   [ОШИБКА] Сборка не удалась. Нужен интернет для скачивания electron-builder.
  pause
  exit /b 1
)
echo.
echo   Готово: папка release\LocalServerPanel.exe
echo   Его можно положить куда угодно и запускать без Node.js.
echo.
explorer "%~dp0release"
pause
