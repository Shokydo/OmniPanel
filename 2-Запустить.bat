@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "node_modules\electron" (
  echo   Сначала запусти "1-Установить.bat"
  pause
  exit /b 1
)
start "" /b cmd /c "npx electron ."
exit
