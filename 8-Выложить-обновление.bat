@echo off
chcp 65001 >nul
title OmniPanel — выложить обновление на GitHub
cd /d "%~dp0"

set "RUN="
if exist "%~dp0OmniPanel.exe" set "RUN=%~dp0OmniPanel.exe"
if not defined RUN if exist "%~dp0..\OmniPanel.exe" set "RUN=%~dp0..\OmniPanel.exe"
if not defined RUN if exist "%~dp0..\..\OmniPanel.exe" set "RUN=%~dp0..\..\OmniPanel.exe"

if defined RUN (
  set ELECTRON_RUN_AS_NODE=1
  set "APP=%~dp0tools\upload-update.js"
  if not exist "%APP%" set "APP=%~dp0..\resources\app\tools\upload-update.js"
  "%RUN%" "%APP%" --dir "%~dp0" %*
  goto done
)

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo Не нашёл ни OmniPanel.exe рядом, ни Node.js.
  echo Можно выложить и руками: перетащи в веб-интерфейс GitHub
  echo    update.json  ^(в корень репозитория^)
  echo    папку dist с файлом OmniPanel-code.zip
  echo.
  pause
  exit /b 1
)
node "%~dp0tools\upload-update.js" --dir "%~dp0" %*

:done
echo.
pause
