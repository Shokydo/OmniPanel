@echo off
chcp 65001 >nul
title Local Server Panel (браузер)
cd /d "%~dp0"
echo   Панель откроется в браузере: http://localhost:7777
echo   Это окно закрывать нельзя - в нём работает сервер панели.
echo.
start "" http://localhost:7777
node web.js
pause
