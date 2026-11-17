# Окно установщика OmniPanel.
#
# Скрипт рисует тёмное окно в духе панели: выбираешь папку, жмёшь «Установить» —
# установщик распаковывает панель именно туда. Распаковку делает сам
# exe-установщик (omnipanel-setup.exe --install-dir …), здесь только окно и вызов.
#
# Запускается из установщика: powershell -STA -NoProfile -File installer.ps1
#   -SetupExe <путь к exe> -Version <версия> -DefaultDir <папка>

param(
  [Parameter(Mandatory = $true)][string]$SetupExe,
  [string]$Version = "",
  [string]$DefaultDir = ""
)

$ErrorActionPreference = 'Stop'

# Без этого Windows на масштабе 125–200 % растягивает окно как картинку:
# шрифты мылятся, а кнопки уезжают за край. С этим флагом окно рисуется ровно.
try {
  Add-Type -Namespace OmniPanel -Name Dpi -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
'@ -ErrorAction Stop
  [void][OmniPanel.Dpi]::SetProcessDPIAware()
} catch { }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

# ── цвета панели: чёрно-белые ──────────────────────────────────────────────
$C = @{
  bg    = [System.Drawing.Color]::FromArgb(9, 9, 11)
  panel = [System.Drawing.Color]::FromArgb(20, 20, 23)
  line  = [System.Drawing.Color]::FromArgb(48, 48, 54)
  text  = [System.Drawing.Color]::FromArgb(236, 236, 238)
  muted = [System.Drawing.Color]::FromArgb(146, 146, 154)
  acc   = [System.Drawing.Color]::FromArgb(255, 255, 255)
  bad   = [System.Drawing.Color]::FromArgb(230, 120, 120)
}
$fontMain = New-Object System.Drawing.Font('Segoe UI', 10)
$fontTiny = New-Object System.Drawing.Font('Consolas', 9)
$fontHead = New-Object System.Drawing.Font('Segoe UI Semibold', 16)

if (-not $DefaultDir) {
  $DefaultDir = Join-Path $env:LOCALAPPDATA 'OmniPanel'
}

# ── папка: проверки ────────────────────────────────────────────────────────

# Возвращает текст ошибки или пустую строку, если папка годится.
function Test-InstallDir([string]$Dir) {
  $full = ''
  if ($Dir) { $full = $Dir.Trim().TrimEnd('\') }
  if (-not $full) { return 'Выбери папку для установки' }
  if ($full -match '^[A-Za-z]:$') { return 'Это целый диск — выбери папку на нём' }
  $bad = @($env:SystemRoot, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramData, $env:windir)
  foreach ($one in $bad) {
    if ($one -and $full.Equals($one.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
      return 'Сюда ставить нельзя — выбери другую папку'
    }
  }
  try {
    if (-not (Test-Path -LiteralPath $full)) {
      New-Item -ItemType Directory -Force -Path $full -ErrorAction Stop | Out-Null
    }
    $probe = Join-Path $full '.omnipanel-проверка-записи'
    Set-Content -LiteralPath $probe -Value 'ok' -Encoding utf8 -ErrorAction Stop
    Remove-Item -LiteralPath $probe -Force -ErrorAction Stop
  } catch {
    return 'В эту папку нельзя писать — выбери другую или папку в своих документах'
  }
  return ''
}

# Сколько места на диске выбранной папки (для строки под полем).
function Get-DiskNote([string]$Dir) {
  try {
    $root = [System.IO.Path]::GetPathRoot((Resolve-Path -LiteralPath $Dir -ErrorAction Stop).Path)
    $drive = New-Object System.IO.DriveInfo($root)
    if ($drive.IsReady) {
      return ('{0} · свободно {1:N1} ГБ' -f $drive.Name.TrimEnd('\'), ($drive.AvailableFreeSpace / 1GB))
    }
    return $drive.Name.TrimEnd('\')
  } catch {
    return ''
  }
}

# ── окно ───────────────────────────────────────────────────────────────────
$form = New-Object System.Windows.Forms.Form
$form.Text = "OmniPanel $Version — установка"
$form.ClientSize = New-Object System.Drawing.Size(820, 620)
$form.MinimumSize = New-Object System.Drawing.Size(780, 560)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'Sizable'
$form.MaximizeBox = $false
$form.BackColor = $C.bg
$form.ForeColor = $C.text
$form.Font = $fontMain

function New-Label($x, $y, $w, $h, $text, $font, $color) {
  $l = New-Object System.Windows.Forms.Label
  $l.Location = New-Object System.Drawing.Point($x, $y)
  $l.Size = New-Object System.Drawing.Size($w, $h)
  $l.Text = $text
  $l.Font = $font
  $l.ForeColor = $color
  $l.BackColor = [System.Drawing.Color]::Transparent
  return $l
}

function New-Button($x, $y, $w, $h, $text) {
  $b = New-Object System.Windows.Forms.Button
  $b.Location = New-Object System.Drawing.Point($x, $y)
  $b.Size = New-Object System.Drawing.Size($w, $h)
  $b.Text = $text
  $b.FlatStyle = 'Flat'
  $b.FlatAppearance.BorderColor = $C.line
  $b.BackColor = $C.panel
  $b.ForeColor = $C.text
  $b.Font = $fontMain
  return $b
}

# заголовок
$title = New-Label 24, 16, 640, 32 "OmniPanel $Version" $fontHead $C.acc
$sub = New-Label 24, 50, 760, 20 'Панель управления серверами для Windows' $fontMain $C.muted
$form.Controls.AddRange(@($title, $sub))

$sep = New-Object System.Windows.Forms.Panel
$sep.Location = New-Object System.Drawing.Point(24, 80)
$sep.Size = New-Object System.Drawing.Size(772, 1)
$sep.BackColor = $C.line
$sep.Anchor = 'Top,Left,Right'
$form.Controls.Add($sep)

# папка установки
$lblPath = New-Label 24, 96, 400, 18 'Куда установить панель' $fontMain $C.muted
$form.Controls.Add($lblPath)

$pathBox = New-Object System.Windows.Forms.TextBox
$pathBox.Location = New-Object System.Drawing.Point(24, 118)
$pathBox.Size = New-Object System.Drawing.Size(540, 26)
$pathBox.Text = $DefaultDir
$pathBox.BackColor = $C.panel
$pathBox.ForeColor = $C.text
$pathBox.BorderStyle = 'FixedSingle'
$pathBox.Font = $fontTiny
$pathBox.Anchor = 'Top,Left,Right'
$form.Controls.Add($pathBox)

$browse = New-Button 572, 116 112, 28 'Обзор…'
$browse.Anchor = 'Top,Right'
$form.Controls.Add($browse)

$reset = New-Button 692, 116 104, 28 'По умолчанию'
$reset.Anchor = 'Top,Right'
$form.Controls.Add($reset)

$note = New-Label 24, 150, 772, 18 '' $fontTiny $C.muted
$note.Anchor = 'Top,Left,Right'
$form.Controls.Add($note)

# переключатель ярлыка — только переключатели, не флажки
$script:desktop = $true
$toggle = New-Button 24, 180 320, 30 'Ярлык на рабочем столе: вкл'
$toggle.Anchor = 'Top,Left'
$form.Controls.Add($toggle)
$toggle.add_Click({
  $script:desktop = -not $script:desktop
  if ($script:desktop) {
    $toggle.Text = 'Ярлык на рабочем столе: вкл'
    $toggle.BackColor = $C.panel
  } else {
    $toggle.Text = 'Ярлык на рабочем столе: выкл'
    $toggle.BackColor = $C.bg
  }
})

$hint = New-Label 360, 186, 436, 20 'Права администратора не нужны' $fontTiny $C.muted
$hint.Anchor = 'Top,Right'
$form.Controls.Add($hint)

# журнал
$log = New-Object System.Windows.Forms.TextBox
$log.Location = New-Object System.Drawing.Point(24, 220)
$log.Size = New-Object System.Drawing.Size(772, 296)
$log.Multiline = $true
$log.ReadOnly = $true
$log.ScrollBars = 'Vertical'
$log.BackColor = $C.panel
$log.ForeColor = $C.muted
$log.BorderStyle = 'FixedSingle'
$log.Font = $fontTiny
$log.Anchor = 'Top,Bottom,Left,Right'
$form.Controls.Add($log)

# ход установки
$bar = New-Object System.Windows.Forms.ProgressBar
$bar.Location = New-Object System.Drawing.Point(24, 530)
$bar.Size = New-Object System.Drawing.Size(300, 18)
$bar.Style = 'Marquee'
$bar.MarqueeAnimationSpeed = 0
$bar.Anchor = 'Bottom,Left'
$form.Controls.Add($bar)

# кнопки
$install = New-Button 526, 528 130, 34 'Установить'
$install.BackColor = $C.acc
$install.ForeColor = [System.Drawing.Color]::Black
$install.Anchor = 'Bottom,Right'
$form.Controls.Add($install)

$openDir = New-Button 400, 528 118, 34 'Открыть папку'
$openDir.Visible = $false
$openDir.Anchor = 'Bottom,Right'
$form.Controls.Add($openDir)

$launch = New-Button 526, 528 130, 34 'Запустить'
$launch.Visible = $false
$launch.BackColor = $C.acc
$launch.ForeColor = [System.Drawing.Color]::Black
$launch.Anchor = 'Bottom,Right'
$form.Controls.Add($launch)

$close = New-Button 664, 528 132, 34 'Отмена'
$close.Anchor = 'Bottom,Right'
$form.Controls.Add($close)

$close.add_Click({ $form.Close() })
$form.AcceptButton = $install

# ── журнал и вид ───────────────────────────────────────────────────────────
function Write-Log([string]$text) {
  $log.AppendText("`r`n$text")
  $log.SelectionStart = $log.Text.Length
  $log.ScrollToCaret()
  [System.Windows.Forms.Application]::DoEvents()
}

function Show-Note([string]$text, [bool]$error) {
  $note.Text = $text
  if ($error) { $note.ForeColor = $C.bad } else { $note.ForeColor = $C.muted }
}

function Update-Note {
  $err = Test-InstallDir $pathBox.Text
  if ($err) {
    Show-Note $err $true
  } else {
    $disk = Get-DiskNote $pathBox.Text
    Show-Note "папка готова · $disk" $false
  }
}

function Set-Busy([bool]$busy) {
  $install.Enabled = -not $busy
  $browse.Enabled = -not $busy
  $reset.Enabled = -not $busy
  $toggle.Enabled = -not $busy
  $pathBox.Enabled = -not $busy
  if ($busy) {
    $bar.MarqueeAnimationSpeed = 30
    $form.Cursor = [System.Windows.Forms.Cursors]::WaitCursor
  } else {
    $bar.MarqueeAnimationSpeed = 0
    $form.Cursor = [System.Windows.Forms.Cursors]::Default
  }
}

# ── выбор папки ────────────────────────────────────────────────────────────
function Pick-Folder([string]$start) {
  try {
    $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
    $dlg.Description = 'Куда установить OmniPanel'
    $dlg.ShowNewFolderButton = $true
    if ($start -and (Test-Path -LiteralPath $start)) { $dlg.SelectedPath = $start }
    if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { return $dlg.SelectedPath }
    return ''
  } catch {
    /* если системное окно почему-то не открылось — пробуем оболочку Windows */
    try {
      $shell = New-Object -ComObject Shell.Application
      $folder = $shell.BrowseForFolder(0, 'Куда установить OmniPanel', 0x0001 -bor 0x0040, $start)
      if ($folder) { return $folder.Self.Path }
    } catch { }
    return ''
  }
}

$browse.add_Click({
  Write-Log 'Выбираю папку…'
  $picked = Pick-Folder $pathBox.Text
  if ($picked) {
    $pathBox.Text = $picked
    Write-Log "Выбрана папка: $picked"
  } else {
    Write-Log 'Папка не выбрана — осталась прежняя.'
  }
  Update-Note
})

$reset.add_Click({
  $pathBox.Text = Join-Path $env:LOCALAPPDATA 'OmniPanel'
  Write-Log "Папка по умолчанию: $($pathBox.Text)"
  Update-Note
})

$pathBox.add_TextChanged({ Update-Note })

$openDir.add_Click({
  try { Start-Process -FilePath 'explorer.exe' -ArgumentList $pathBox.Text.Trim() } catch { }
})

$launch.add_Click({
  $target = Join-Path $pathBox.Text.Trim() 'OmniPanel.exe'
  try {
    if (Test-Path -LiteralPath $target) {
      Start-Process -FilePath $target -WorkingDirectory $pathBox.Text.Trim()
      $form.Close()
    } else {
      Write-Log "Не нашёл $target — открой папку и запусти вручную."
      Start-Process -FilePath 'explorer.exe' -ArgumentList $pathBox.Text.Trim()
    }
  } catch {
    Write-Log "Не удалось запустить: $($_.Exception.Message)"
  }
})

# ── установка ──────────────────────────────────────────────────────────────
$install.add_Click({
  $dir = $pathBox.Text.Trim()
  $err = Test-InstallDir $dir
  if ($err) {
    Show-Note $err $true
    Write-Log "Стоп: $err"
    return
  }

  Set-Busy $true
  $dest = $dir.TrimEnd('\')
  $update = Test-Path -LiteralPath (Join-Path $dest 'OmniPanel.exe')
  if ($update) {
    Write-Log "Здесь уже стоит панель — обновляю её до $Version."
    Write-Log 'Запущенную панель закрою сам, настройки и серверы останутся на месте.'
  } else {
    Write-Log "Ставлю панель в $dest"
  }

  # панель закрывает сам установщик (taskkill), иначе Windows не даст заменить файлы
  $setupArgs = @('--install-dir', $dest, '--no-run')
  if (-not $script:desktop) { $setupArgs += '--no-desktop' }

  try {
    $proc = Start-Process -FilePath $SetupExe -ArgumentList $setupArgs -Wait -PassThru -WindowStyle Hidden
    if ($proc.ExitCode -eq 0) {
      Write-Log 'Готово: файлы на месте.'
      Write-Log "Папка: $dest"
      if ($script:desktop) { Write-Log 'Ярлык на рабочем столе и в меню «Пуск» создан.' }
      else { Write-Log 'Ярлык создан в меню «Пуск».' }
      $install.Visible = $false
      $launch.Visible = $true
      $openDir.Visible = $true
      $close.Text = 'Закрыть'
      $form.AcceptButton = $launch
    } else {
      Write-Log "Не получилось (код $($proc.ExitCode)). Попробуй другую папку."
      Set-Busy $false
    }
  } catch {
    Write-Log "Ошибка установки: $($_.Exception.Message)"
    Set-Busy $false
  }
})

# стартовое состояние
if (Test-Path -LiteralPath (Join-Path $DefaultDir 'OmniPanel.exe')) {
  $log.Text = "Здесь уже стоит панель — при установке она обновится до $Version.`r`nЗапущенную панель мастер закроет сам, настройки и серверы останутся на месте."
} else {
  $log.Text = "Готов к установке.`r`nВыбери папку и нажми «Установить» — панель распакуется туда."
}
Update-Note

[void]$form.ShowDialog()
