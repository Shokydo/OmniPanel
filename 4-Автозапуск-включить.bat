@echo off
chcp 65001 >nul
title Автозапуск панели вместе с Windows
cd /d "%~dp0"

set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "VBS=%STARTUP%\LocalServerPanel.vbs"

> "%VBS%" echo Set sh = CreateObject("WScript.Shell")
>> "%VBS%" echo sh.CurrentDirectory = "%~dp0"
>> "%VBS%" echo sh.Run """%~dp0node_modules\.bin\electron.cmd"" .", 0, False

echo.
echo   Автозапуск включён.
echo   Панель будет стартовать вместе с Windows (свёрнутая в трей).
echo.
echo   Файл: %VBS%
echo   Отключить: запусти "5-Автозапуск-выключить.bat"
echo.
pause
