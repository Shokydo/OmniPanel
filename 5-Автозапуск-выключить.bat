@echo off
chcp 65001 >nul
title Автозапуск панели
set "VBS=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\LocalServerPanel.vbs"
if exist "%VBS%" (
  del "%VBS%"
  echo   Автозапуск отключён.
) else (
  echo   Автозапуск и так не был включён.
)
pause
