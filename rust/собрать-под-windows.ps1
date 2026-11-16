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
  [switch]$SkipInstall,
  # Заодно скачать 7-Zip (7zr.exe, 590 КБ) — тогда бэкапы делаются плотным .7z
  # и панель открывает чужие .7z-архивы. Без него панель работает, но бэкапы
  # будут zip.
  [switch]$With7z
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

# HTTPS-клиент панели (GitHub, GitLab, обновления) требует rustc 1.91 или новее
$verText = (& rustc --version) -replace '^rustc ', '' -replace ' .*$', ''
$verParts = $verText.Split('.')
$verMajor = [int]$verParts[0]
$verMinor = [int]$verParts[1]
if ($verMajor -lt 1 -or ($verMajor -eq 1 -and $verMinor -lt 91)) {
  Write-Host "Rust $verText старый — панели нужен 1.91 или новее" -ForegroundColor Yellow
  if (Get-Command rustup -ErrorAction SilentlyContinue) {
    rustup update stable
  } else {
    throw "Обновите Rust: https://rustup.rs (нужен 1.91 или новее)"
  }
}

# ── 1б. 7-Zip рядом с панелью (по желанию) ─────────────────────────────────
if ($With7z) {
  Write-Step "скачиваю 7-Zip (7zr.exe)"
  $binDir = Join-Path $Root "assets\bin"
  New-Item -ItemType Directory -Force -Path $binDir | Out-Null
  $seven = Join-Path $binDir "7za.exe"
  if (Test-Path $seven) {
    Write-Host "7-Zip уже на месте: $seven"
  } else {
    Invoke-WebRequest -Uri "https://www.7-zip.org/a/7zr.exe" -OutFile $seven -UseBasicParsing
    Write-Host ("7-Zip скачан: {0:N0} КБ" -f ((Get-Item $seven).Length / 1KB))
  }
}

$tauri = Join-Path $Root "src-tauri"

# ── 1в. Версия ─────────────────────────────────────────────────────────────
# Версию пишем в двух местах: её показывают окно панели и мастер установки.
Write-Step "версия $Version"
# без BOM: метка в начале ломает и JSON, и чтение номера версии
$noBom = New-Object System.Text.UTF8Encoding($false)
$manifests = @(
  (Join-Path $Rust "omnipanel-core\Cargo.toml"),
  (Join-Path $Rust "omnipanel-setup\Cargo.toml"),
  (Join-Path $tauri "Cargo.toml"),
  (Join-Path $tauri "tauri.conf.json")
)
foreach ($file in $manifests) {
  $text = [System.IO.File]::ReadAllText($file)
  $text = $text -replace '(?m)^version = "[^"]*"', ('version = "' + $Version + '"')
  $text = $text -replace '"version":\s*"[^"]*"', ('"version": "' + $Version + '"')
  [System.IO.File]::WriteAllText($file, $text, $noBom)
}

# ── 2. Сборка ──────────────────────────────────────────────────────────────
# если в проекте уже есть окно на Tauri — собираем его, а не консольную панель
$windowed = Test-Path (Join-Path $tauri "Cargo.toml")
if ($windowed) {
  Write-Step "собираю окно на Tauri"
  Push-Location $tauri
  # номер версии зашивается в exe при сборке, поэтому окно собираем заново:
  # иначе cargo отдаёт готовый файл со старой версией
  cargo clean --release -p omnipanel 2>$null
  cargo build --release
  Pop-Location
} else {
  Write-Step "собираю панель (окно на Tauri ещё не перенесено)"
  Push-Location (Join-Path $Rust "omnipanel-core")
  cargo clean --release -p omnipanel-core 2>$null
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

# проверка, что окно собралось именно этой версией
$panelText = [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($panelExe))
if ($panelText -notmatch [regex]::Escape("OmniPanel/$Version")) {
  throw "панель собралась со старым номером версии — нужен $Version. Удалите target и запустите снова."
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

# встроенные аддоны и обои едут рядом с программой: панель ищет их в assets\
$assets = Join-Path $Root "assets"
if (Test-Path $assets) {
  New-Item -ItemType Directory -Force -Path (Join-Path $portable "assets") | Out-Null
  Copy-Item (Join-Path $assets "*") (Join-Path $portable "assets") -Recurse -Force
}

@"
OmniPanel $Version на Rust
=========================

Запуск:  OmniPanel.exe — открывается окно панели на весь экран.
Ничего ставить не нужно: папка ui и assets идут рядом с exe.

Установка насовсем — exe-установщик из релиза: он спросит, куда ставить.

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
Write-Host "Установщик показывает окно мастера: куда ставить (по умолчанию"
Write-Host "%LOCALAPPDATA%\OmniPanel), ярлык на рабочем столе, кнопки «Установить»"
Write-Host "и «Запустить». Ставится в выбранную папку и попадает в «Программы и"
Write-Host "компоненты». Удаление: тот же exe с ключом --uninstall"
