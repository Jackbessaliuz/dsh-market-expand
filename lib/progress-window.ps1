# market-expand update progress window (ASCII only -- all user-facing text
# comes from the UTF-8 state JSON so this file never needs a BOM).
#
# State fields the window understands:
#   title, badge, phase, step (0-3), percent, detail, steps[4]
# phase: preparing | installing | verifying | rollingback | restarting | done | error
param(
  [Parameter(Mandatory = $true)][string]$StateFile,
  [switch]$NoShow
)
$ErrorActionPreference = 'SilentlyContinue'

if ($NoShow) { exit 0 }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:StateFile = $StateFile
$script:closingAt = $null
$script:lastWrite = $null
$script:lastChange = Get-Date

$C_BG = [System.Drawing.Color]::FromArgb(20, 24, 36)
$C_TEXT = [System.Drawing.Color]::White
$C_MUTED = [System.Drawing.Color]::FromArgb(150, 160, 180)
$C_DIM = [System.Drawing.Color]::FromArgb(78, 88, 108)
$C_BLUE = [System.Drawing.Color]::FromArgb(86, 122, 255)
$C_CYAN = [System.Drawing.Color]::FromArgb(70, 200, 220)
$C_ORANGE = [System.Drawing.Color]::FromArgb(240, 160, 70)
$C_GREEN = [System.Drawing.Color]::FromArgb(94, 214, 143)
$C_RED = [System.Drawing.Color]::FromArgb(240, 110, 100)
$C_TRACK = [System.Drawing.Color]::FromArgb(44, 52, 70)

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Plugin update'
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.TopMost = $true
$form.ShowInTaskbar = $true
$form.Width = 470
$form.Height = 306
$form.BackColor = $C_BG
$form.MaximizeBox = $false
$form.MinimizeBox = $false

# --- title ---
$lblTitle = New-Object System.Windows.Forms.Label
$lblTitle.AutoSize = $false
$lblTitle.Left = 18
$lblTitle.Top = 16
$lblTitle.Width = 300
$lblTitle.Height = 26
$lblTitle.ForeColor = $C_TEXT
$lblTitle.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 12, [System.Drawing.FontStyle]::Bold)
$lblTitle.Text = 'Plugin update'
$form.Controls.Add($lblTitle)

# --- badge (top right) ---
$lblBadge = New-Object System.Windows.Forms.Label
$lblBadge.AutoSize = $false
$lblBadge.Left = 322
$lblBadge.Top = 18
$lblBadge.Width = 130
$lblBadge.Height = 22
$lblBadge.TextAlign = [System.Drawing.ContentAlignment]::MiddleRight
$lblBadge.ForeColor = $C_MUTED
$lblBadge.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
$lblBadge.Text = ''
$form.Controls.Add($lblBadge)

# --- progress bar (track + fill) ---
$track = New-Object System.Windows.Forms.Panel
$track.Left = 18
$track.Top = 50
$track.Width = 434
$track.Height = 10
$track.BackColor = $C_TRACK
$form.Controls.Add($track)

$fill = New-Object System.Windows.Forms.Panel
$fill.Left = 0
$fill.Top = 0
$fill.Width = 0
$fill.Height = 10
$fill.BackColor = $C_BLUE
$track.Controls.Add($fill)

# --- detail ---
$lblDetail = New-Object System.Windows.Forms.Label
$lblDetail.AutoSize = $false
$lblDetail.Left = 18
$lblDetail.Top = 70
$lblDetail.Width = 434
$lblDetail.Height = 44
$lblDetail.ForeColor = [System.Drawing.Color]::FromArgb(180, 190, 210)
$lblDetail.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
$lblDetail.Text = ''
$form.Controls.Add($lblDetail)

# --- log tail: last few real log lines (this is the part users can actually see
# when DSH itself failed; keep it monospace and dark) ---
$lblLog = New-Object System.Windows.Forms.Label
$lblLog.AutoSize = $false
$lblLog.Left = 18
$lblLog.Top = 112
$lblLog.Width = 434
$lblLog.Height = 82
$lblLog.ForeColor = [System.Drawing.Color]::FromArgb(152, 164, 184)
$lblLog.BackColor = [System.Drawing.Color]::FromArgb(28, 33, 46)
$lblLog.Font = New-Object System.Drawing.Font('Consolas', 8)
$lblLog.TextAlign = [System.Drawing.ContentAlignment]::TopLeft
$lblLog.Padding = New-Object System.Windows.Forms.Padding(6, 4, 6, 4)
$lblLog.Text = ''
$form.Controls.Add($lblLog)

# --- close button (top-right) ---
$btnClose = New-Object System.Windows.Forms.Button
$btnClose.Text = [char]0x00D7
$btnClose.Width = 22
$btnClose.Height = 22
$btnClose.Left = $form.Width - 30
$btnClose.Top = 6
$btnClose.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
$btnClose.FlatAppearance.BorderSize = 0
$btnClose.BackColor = $C_BG
$btnClose.ForeColor = $C_MUTED
$btnClose.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 11)
$btnClose.Cursor = [System.Windows.Forms.Cursors]::Hand
$btnClose.Add_Click({ $timer.Stop(); $form.Close() })
$form.Controls.Add($btnClose)

# --- step rail: 4 slots ---
$stepLabels = @()
for ($i = 0; $i -lt 4; $i++) {
  $sl = New-Object System.Windows.Forms.Label
  $sl.AutoSize = $false
  $sl.Left = 18 + ($i * 110)
  $sl.Top = 204
  $sl.Width = 100
  $sl.Height = 24
  $sl.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
  $sl.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
  $sl.ForeColor = $C_DIM
  $sl.Text = ''
  $form.Controls.Add($sl)
  $stepLabels += $sl
}

# --- hint line ---
$lblHint = New-Object System.Windows.Forms.Label
$lblHint.AutoSize = $false
$lblHint.Left = 18
$lblHint.Top = 238
$lblHint.Width = 434
$lblHint.Height = 24
$lblHint.ForeColor = [System.Drawing.Color]::FromArgb(110, 120, 140)
$lblHint.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 8)
$lblHint.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
$lblHint.Text = ''
$form.Controls.Add($lblHint)

$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form.Left = $wa.Right - $form.Width - 24
$form.Top = $wa.Bottom - $form.Height - 24

$script:phaseColor = @{
  'waiting-exit' = $C_CYAN
  'preparing'  = $C_BLUE
  'installing' = $C_BLUE
  'verifying'  = $C_CYAN
  'rollingback'= $C_ORANGE
  'restarting' = $C_CYAN
  'done'       = $C_GREEN
  'error'      = $C_RED
  'canceled'   = $C_MUTED
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 250
$timer.Add_Tick({
    if (-not (Test-Path -LiteralPath $script:StateFile)) { return }
    try {
      $fi = Get-Item -LiteralPath $script:StateFile
      if ($fi.LastWriteTime -ne $script:lastWrite) {
        $script:lastWrite = $fi.LastWriteTime
        $script:lastChange = Get-Date
      }
      $raw = [System.IO.File]::ReadAllText($script:StateFile, [System.Text.Encoding]::UTF8)
      $s = $raw | ConvertFrom-Json
    } catch { return }

    $phase = [string]$s.phase
    $color = $C_BLUE
    if ($script:phaseColor.ContainsKey($phase)) { $color = $script:phaseColor[$phase] }

    if ($s.title) { $lblTitle.Text = [string]$s.title }
    $lblTitle.ForeColor = if ($phase -eq 'done' -or $phase -eq 'error') { $color } else { $C_TEXT }
    if ($s.badge) { $lblBadge.Text = [string]$s.badge; $lblBadge.ForeColor = $color }

    $pct = 0
    if ($null -ne $s.percent) { $pct = [int]$s.percent }
    if ($pct -lt 0) { $pct = 0 }
    if ($pct -gt 100) { $pct = 100 }
    $fill.Width = [int]($track.Width * $pct / 100)
    $fill.BackColor = $color

    if ($s.detail) { $lblDetail.Text = [string]$s.detail }

    # step rail
    $cur = -1
    if ($null -ne $s.step) { $cur = [int]$s.step }
    $names = @('1', '2', '3', '4')
    if ($s.steps -and $s.steps.Count -ge 4) { $names = @($s.steps[0], $s.steps[1], $s.steps[2], $s.steps[3]) }
    for ($i = 0; $i -lt 4; $i++) {
      $sl = $stepLabels[$i]
      $sl.Text = [string]$names[$i]
      if ($phase -eq 'done') {
        $sl.ForeColor = $C_GREEN
        $sl.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
      } elseif ($phase -eq 'error') {
        $sl.ForeColor = if ($i -le $cur) { $C_RED } else { $C_DIM }
        $sl.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9, $(if ($i -eq $cur) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }))
      } elseif ($i -lt $cur) {
        $sl.ForeColor = $C_GREEN
        $sl.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
      } elseif ($i -eq $cur) {
        $sl.ForeColor = $color
        $sl.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9, [System.Drawing.FontStyle]::Bold)
      } else {
        $sl.ForeColor = $C_DIM
        $sl.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
      }
    }

    if ($s.hint) { $lblHint.Text = [string]$s.hint }

    # log tail: real log lines so the user (and a screenshot) can see what happened
    $logText = ''
    if ($s.logLines) {
      $arr = @($s.logLines)
      $start = [Math]::Max(0, $arr.Count - 6)
      $shown = @()
      for ($i = $start; $i -lt $arr.Count; $i++) { $shown += [string]$arr[$i] }
      $logText = ($shown -join "`r`n")
    }
    $lblLog.Text = $logText

    if ($phase -eq 'done') {
      # 60s 而不是 3s：用户很可能不在屏幕前，一闪而过等于没提示
      if ($null -eq $script:closingAt) { $script:closingAt = (Get-Date).AddSeconds(60) }
    } elseif ($phase -eq 'canceled') {
      if ($null -eq $script:closingAt) { $script:closingAt = (Get-Date).AddSeconds(5) }
    } elseif ($phase -eq 'error') {
      # 失败时一直留着，等用户自己关（点右上角 ×）
      $script:closingAt = $null
    }

    if ($phase -ne 'error' -and $null -eq $script:closingAt -and ((Get-Date) - $script:lastChange).TotalMinutes -gt 10) {
      $timer.Stop()
      $form.Close()
      return
    }
    if ($null -ne $script:closingAt -and (Get-Date) -gt $script:closingAt) {
      $timer.Stop()
      $form.Close()
    }
})
$timer.Start()

$form.Add_Shown({ $form.Activate() })
$form.ShowDialog() | Out-Null
