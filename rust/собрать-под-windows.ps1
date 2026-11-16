# Сборка OmniPanel на Rust под Windows
#
#   powershell -ExecutionPolicy Bypass -File rust\собрать-под-windows.ps1
#
# Что делает:
#   1. проверяет Rust (если нет — ставит через winget, без прав администратора);
#   2. собирает панель и установщик;
#   3. складывает всё в папку dist\: портативную сборку и один exe-установщик;
#   4. печатает, что получилось и сколько весит.
#
# Ничего больше не нужно: ни node, ни python, ни mingw, ни Visual Studio —
# Rust под Windows сам берёт нужный компоновщик.

param(
  [string]$Version = "1.27.0",
  [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Rust = Join-Path $Root "rust"
$Dist = Join-Path $Root "dist"
$Work = Join-Path $env:TEMP "omnipanel-build"

function Write-Step($text) { Write-Host "── $text ──" -ForegroundColor Cyan }

# ── 1. Rust ────────────────────────────────────────────────────────────────
Write-Step "проверяю Rust"
$cargo = Get-Command cargo -ErrorAction SilentlyContinue
if (-not $cargo) {
  if ($SkipInstall) {
    throw "Rust не найден. Поставьте с https://rustup.rs и запустите снова."
  }
  Write-Host "Rust не найден — ставлю через winget (это займёт пару минут)"
  winget install --id Rustlang.Rustup -e --accept-source-agreements --accept-package-agreements
  $env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
  $cargo = Get-Command cargo -ErrorAction SilentlyContinue
  if (-not $cargo) {
    throw "Rust не установился. Поставьте вручную с https://rustup.rs и запустите снова."
  }
}
rustc --version
cargo --version

# ── 2. Сборка ──────────────────────────────────────────────────────────────
# если в проекте уже есть окно на Tauri — собираем его, а не консольную панель
$tauri = Join-Path $Root "src-tauri"
$windowed = Test-Path (Join-Path $tauri "Cargo.toml")
if ($windowed) {
  Write-Step "собираю окно на Tauri"
  Push-Location $tauri
  cargo build --release
  Pop-Location
} else {
  Write-Step "собираю панель (окно на Tauri ещё не перенесено)"
  Push-Location (Join-Path $Rust "omnipanel-core")
  cargo build --release
  Pop-Location
}

Write-Step "собираю установщик"
Push-Location (Join-Path $Rust "omnipanel-setup")
cargo build --release
Pop-Location

if ($windowed) {
  $panelExe = Join-Path $tauri "target\release\OmniPanel.exe"
} else {
  $panelExe = Join-Path $Rust "omnipanel-core\target\release\omnipanel-core.exe"
}
$setupExe = Join-Path $Rust "omnipanel-setup\target\release\omnipanel-setup.exe"
foreach ($file in @($panelExe, $setupExe)) {
  if (-not (Test-Path $file)) { throw "не собралось: $file" }
}

# ── 3. Портативная сборка ──────────────────────────────────────────────────
Write-Step "складываю портативную сборку"
$portable = Join-Path $Work "OmniPanel-win64"
if (Test-Path $portable) { Remove-Item $portable -Recurse -Force }
New-Item -ItemType Directory -Force -Path $portable | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $portable "ui") | Out-Null

if ($windowed) {
  Copy-Item $panelExe (Join-Path $portable "OmniPanel.exe")
} else {
  Copy-Item $panelExe (Join-Path $portable "omnipanel-core.exe")
}
Copy-Item (Join-Path $Root "ui\*") (Join-Path $portable "ui") -Recurse -Force

@"
OmniPanel $Version на Rust
=========================

Запуск:  omnipanel-core.exe
Панель откроется по адресу из окна консоли (по умолчанию http://127.0.0.1:47800/).

Ключи запуска:
  --port 47800        порт панели
  --data OmniPanelData  папка с настройками (servers.json)
  --ui ui             папка с интерфейсом

Настройки и серверы лежат в папке OmniPanelData рядом с программой —
сборка портативная, можно носить на флешке.
"@ | Set-Content -Path (Join-Path $portable "ЧИТАЙ-МЕНЯ.txt") -Encoding UTF8

New-Item -ItemType Directory -Force -Path $Dist | Out-Null
$zip = Join-Path $Dist "OmniPanel-win64.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $portable "*") -DestinationPath $zip -CompressionLevel Optimal

# ── 4. Установщик: один exe с панелью внутри ───────────────────────────────
Write-Step "вкладываю панель в установщик"
$setupOut = Join-Path $Dist "OmniPanel-Установка-$Version.exe"
Copy-Item $setupExe $setupOut -Force
& (Join-Path $Rust "omnipanel-setup\target\release\omnipanel-setup.exe") --append $setupOut $zip
if ($LASTEXITCODE -ne 0) { throw "не удалось вложить панель в установщик" }

# ── 5. Итог ────────────────────────────────────────────────────────────────
function Size($path) { "{0:N1} МБ" -f ((Get-Item $path).Length / 1MB) }
Write-Host ""
Write-Host "готово:" -ForegroundColor Green
Write-Host ("  портативная сборка: {0}  ({1})" -f $zip, (Size $zip))
Write-Host ("  установщик:         {0}  ({1})" -f $setupOut, (Size $setupOut))
Write-Host ""
Write-Host "Установщик кладёт панель в %LOCALAPPDATA%\OmniPanel,"
Write-Host "делает ярлыки на рабочем столе и в меню «Пуск» и запускает её."
Write-Host "Удаление: тот же exe с ключом --uninstall"
