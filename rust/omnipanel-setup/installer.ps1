# Окно установщика OmniPanel.
#
# Скрипт рисует тёмное окно в духе панели: куда ставить, ярлык на рабочем
# столе, кнопки «Установить» и «Отмена». Распаковку делает сам exe-установщик
# (omnipanel-setup.exe --install-dir …) — здесь только окно и вызов.
#
# Запускается из установщика: powershell -STA -NoProfile -File installer.ps1
#   -SetupExe <путь к exe> -Version <версия> -DefaultDir <папка>

param(
  [Parameter(Mandatory = $true)][string]$SetupExe,
  [string]$Version = "",
  [string]$DefaultDir = ""
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

# ── цвета панели: чёрно-белые ──────────────────────────────────────────────
$C = @{
  bg     = [System.Drawing.Color]::FromArgb(9, 9, 11)
  panel  = [System.Drawing.Color]::FromArgb(20, 20, 23)
  line   = [System.Drawing.Color]::FromArgb(48, 48, 54)
  text   = [System.Drawing.Color]::FromArgb(236, 236, 238)
  muted  = [System.Drawing.Color]::FromArgb(146, 146, 154)
  acc    = [System.Drawing.Color]::FromArgb(255, 255, 255)
}
$fontMain = New-Object System.Drawing.Font('Segoe UI', 10)
$fontTiny = New-Object System.Drawing.Font('Consolas', 9)
$fontHead = New-Object System.Drawing.Font('Segoe UI Semibold', 16)

if (-not $DefaultDir) {
  $DefaultDir = Join-Path $env:LOCALAPPDATA 'OmniPanel'
}

$form = New-Object System.Windows.Forms.Form
$form.Text = "OmniPanel $Version — установка"
$form.Size = New-Object System.Drawing.Size(700, 470)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedSingle'
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

# шапка
$title = New-Label 26, 20, 620, 34 "OmniPanel $Version" $fontHead $C.acc
$sub = New-Label 26, 56, 640, 22 "Панель управления серверами для Windows" $fontMain $C.muted
$form.Controls.AddRange(@($title, $sub))

# разделитель
$sep = New-Object System.Windows.Forms.Panel
$sep.Location = New-Object System.Drawing.Point(26, 88)
$sep.Size = New-Object System.Drawing.Size(636, 1)
$sep.BackColor = $C.line
$form.Controls.Add($sep)

# путь установки
$form.Controls.Add((New-Label 26, 104, 300, 20 "Куда установить панель" $fontMain $C.muted))
$pathBox = New-Object System.Windows.Forms.TextBox
$pathBox.Location = New-Object System.Drawing.Point(26, 128)
$pathBox.Size = New-Object System.Drawing.Size(520, 26)
$pathBox.Text = $DefaultDir
$pathBox.BackColor = $C.panel
$pathBox.ForeColor = $C.text
$pathBox.BorderStyle = 'FixedSingle'
$pathBox.Font = $fontTiny
$form.Controls.Add($pathBox)

$browse = New-Button 556, 127 106, 28 "Обзор…"
$form.Controls.Add($browse)

$browse.add_Click({
  $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
  $dlg.Description = 'Куда установить OmniPanel'
  $dlg.ShowNewFolderButton = $true
  if (Test-Path $pathBox.Text) { $dlg.SelectedPath = $pathBox.Text }
  if ($dlg.ShowDialog() -eq 'OK') { $pathBox.Text = $dlg.SelectedPath }
})

# переключатель ярлыка — только переключатели, не флажки
$script:desktop = $true
$toggle = New-Button 26, 170 300, 30 "Ярлык на рабочем столе: вкл"
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

$hint = New-Label 26, 208, 640, 40 "Права администратора не нужны: панель ставится в вашу папку и не трогает систему." $fontTiny $C.muted
$form.Controls.Add($hint)

# журнал
$log = New-Object System.Windows.Forms.TextBox
$log.Location = New-Object System.Drawing.Point(26, 250)
$log.Size = New-Object System.Drawing.Size(636, 120)
$log.Multiline = $true
$log.ReadOnly = $true
$log.ScrollBars = 'Vertical'
$log.BackColor = $C.panel
$log.ForeColor = $C.muted
$log.BorderStyle = 'FixedSingle'
$log.Font = $fontTiny
$log.Text = "Готов к установке.`r`nНажмите «Установить» — панель распакуется в выбранную папку."
$form.Controls.Add($log)

# кнопки
$install = New-Button 416, 384 130, 34 "Установить"
$install.BackColor = $C.acc
$install.ForeColor = [System.Drawing.Color]::Black
$form.Controls.Add($install)

$launch = New-Button 276, 384 130, 34 "Запустить"
$launch.Visible = $false
$form.Controls.Add($launch)

$close = New-Button 556, 384 106, 34 "Отмена"
$form.Controls.Add($close)

$close.add_Click({ $form.Close() })

function Write-Log($text) {
  $log.AppendText("`r`n$text")
  $log.SelectionStart = $log.Text.Length
  $log.ScrollToCaret()
  [System.Windows.Forms.Application]::DoEvents()
}

$form.AcceptButton = $install

$install.add_Click({
  $dir = $pathBox.Text.Trim()
  if (-not $dir) {
    Write-Log 'Укажите папку для установки.'
    return
  }
  $install.Enabled = $false
  $browse.Enabled = $false
  $toggle.Enabled = $false
  $pathBox.Enabled = $false
  Write-Log "Ставлю панель в $dir"

  $setupArgs = @('--install-dir', $dir, '--no-run')
  if (-not $script:desktop) { $setupArgs += '--no-desktop' }

  try {
    $form.Cursor = [System.Windows.Forms.Cursors]::WaitCursor
    $proc = Start-Process -FilePath $SetupExe -ArgumentList $setupArgs -Wait -PassThru -WindowStyle Hidden
    if ($proc.ExitCode -eq 0) {
      Write-Log 'Готово: панель установлена.'
      Write-Log "Папка: $dir"
      $form.Cursor = [System.Windows.Forms.Cursors]::Default
      $launch.Visible = $true
      $install.Visible = $false
      $close.Text = 'Закрыть'
    } else {
      Write-Log "Не получилось (код $($proc.ExitCode)). Попробуйте другую папку."
      $install.Enabled = $true
      $browse.Enabled = $true
      $toggle.Enabled = $true
      $pathBox.Enabled = $true
    }
  } catch {
    Write-Log "Ошибка: $($_.Exception.Message)"
    $install.Enabled = $true
    $browse.Enabled = $true
    $toggle.Enabled = $true
    $pathBox.Enabled = $true
  }
})

$launch.add_Click({
  try {
    Start-Process -FilePath (Join-Path $pathBox.Text.Trim() 'OmniPanel.exe') -WorkingDirectory $pathBox.Text.Trim()
  } catch {
    Write-Log "Не удалось запустить: $($_.Exception.Message)"
  }
  $form.Close()
})

[void]$form.ShowDialog()
