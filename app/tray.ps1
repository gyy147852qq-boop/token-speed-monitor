# Token Speed Monitor - tray companion (always-on, no console window needed)
#   - tray icon with a live tooltip (latest tok/s + today's tokens)
#   - menu: open panel, benchmark, autostart toggle, desktop shortcut, quit
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$Port = 7391
$root = Split-Path -Parent $PSScriptRoot
$url = "http://127.0.0.1:$Port/"
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$runName = "TokenSpeedMonitor"
$debugLog = Join-Path $env:TEMP "tsm-tray.log"

function Test-Server {
  try { $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2 -UseBasicParsing; return ($r.StatusCode -eq 200) }
  catch { return $false }
}

function Start-Server {
  if (Test-Server) { return $null }
  $p = Start-Process -FilePath "node" -ArgumentList "app/server.mjs" -WorkingDirectory $root -WindowStyle Hidden -PassThru
  for ($i = 0; $i -lt 30; $i++) { Start-Sleep -Milliseconds 300; if (Test-Server) { break } }
  return $p
}

function Get-Summary {
  try { return Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/summary?since=24h" -TimeoutSec 6 }
  catch { return $null }
}

function Get-Tooltip {
  $s = Get-Summary
  if (-not $s) { return "TSM: server offline" }
  $all = $s.totals.all
  # weighted average speed across models that have samples
  $n = 0; $sum = 0
  foreach ($m in $s.byModel) { if ($m.speed -and $m.speed.n -gt 0) { $n += $m.speed.n; $sum += $m.speed.avg * $m.speed.n } }
  $spd = if ($n -gt 0) { [math]::Round($sum / $n, 1) } else { $null }
  $txt = if ($null -ne $spd) { "$spd tok/s" } else { "no speed yet" }
  $tok = "{0:N0}" -f [math]::Round($all.total / 1000) + "k tok/24h"
  return "TSM  $txt  |  $tok  |  $($all.requests) req"
}

$serverProc = Start-Server

# ------------------------------- tray icon ---------------------------------

$icon = [System.Drawing.SystemIcons]::Application
$menu = New-Object System.Windows.Forms.ContextMenuStrip

$itemOpen = $menu.Items.Add("打开面板 / Open panel")
$itemOpen.Click += { Start-Process -FilePath "powershell" -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "$PSScriptRoot\open-window.ps1" -WindowStyle Hidden }

$itemBench = $menu.Items.Add("本地模型测速 / Benchmark")
$itemBench.Click += {
  try {
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/bench?target=auto" -TimeoutSec 300
    $first = if ($r -is [array]) { $r[0] } else { $r }
    $msg = if ($first.speed) { "$($first.tool) $($first.model): $($first.speed) tok/s" } else { "no server responded" }
  } catch { $msg = "benchmark failed: $($_.Exception.Message)" }
  $notify.BalloonTipTitle = "Token Speed Monitor"
  $notify.BalloonTipText = $msg
  $notify.ShowBalloonTip(6000)
}

$itemAuto = $menu.Items.Add("开机自启 / Start with Windows")
$itemAuto.CheckOnClick = $true
$itemAuto.Checked = [bool](Get-ItemProperty -Path $runKey -Name $runName -ErrorAction SilentlyContinue)
$itemAuto.Click += {
  try {
    if ($itemAuto.Checked) {
      Set-ItemProperty -Path $runKey -Name $runName -Value "powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSScriptRoot\tray.ps1`"" -ErrorAction Stop
    } else {
      Remove-ItemProperty -Path $runKey -Name $runName -ErrorAction SilentlyContinue
    }
  } catch {
    $notify.BalloonTipTitle = "Token Speed Monitor"
    $notify.BalloonTipText = "autostart toggle failed: $($_.Exception.Message)"
    $notify.ShowBalloonTip(5000)
    $itemAuto.Checked = -not $itemAuto.Checked
  }
}

$itemShortcut = $menu.Items.Add("创建桌面快捷方式 / Desktop shortcut")
$itemShortcut.Click += {
  $desktop = [Environment]::GetFolderPath("Desktop")
  $lnk = Join-Path $desktop "Token Speed Monitor.lnk"
  $shell = New-Object -ComObject WScript.Shell
  $sc = $shell.CreateShortcut($lnk)
  $sc.TargetPath = "powershell.exe"
  $sc.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSScriptRoot\tray.ps1`""
  $sc.WorkingDirectory = $root
  $sc.IconLocation = "$env:SystemRoot\System32\shell32.dll,13"
  $sc.Description = "Token Speed Monitor"
  $sc.Save()
}

$menu.Items.Add("-") | Out-Null
$itemQuit = $menu.Items.Add("退出 / Quit")
$itemQuit.Click += { $form.Close() }

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $icon
$notify.Text = "Token Speed Monitor"
$notify.ContextMenuStrip = $menu
$notify.Visible = $true
$notify.DoubleClick += { Start-Process -FilePath "powershell" -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "$PSScriptRoot\open-window.ps1" -WindowStyle Hidden }

# ------------------------------- live tooltip ------------------------------

function Update-Tooltip {
  $txt = Get-Tooltip
  if ($txt.Length -gt 63) { $txt = $txt.Substring(0, 63) }
  $notify.Text = $txt
  if ($env:TSM_TRAY_DEBUG) { "$(Get-Date -Format 'HH:mm:ss')  $txt" | Out-File -FilePath $debugLog -Append -Encoding utf8 }
}

Update-Tooltip
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.Add_Tick({ Update-Tooltip })
$timer.Start()

# balloon hint on first start
$notify.BalloonTipTitle = "Token Speed Monitor"
$notify.BalloonTipText = "托盘常驻已启动。双击图标打开面板,右键菜单可设置开机自启。"
$notify.ShowBalloonTip(5000)

# ------------------------------- message loop ------------------------------

$form = New-Object System.Windows.Forms.Form
$form.ShowInTaskbar = $false
$form.WindowState = "Minimized"
$form.FormBorderStyle = "FixedToolWindow"
$form.StartPosition = "Manual"
$form.Location = New-Object System.Drawing.Point(-5000, -5000)
$form.Hide()

$form.Add_FormClosing({
  $timer.Stop()
  $notify.Visible = $false
  $notify.Dispose()
  if ($serverProc -and -not $serverProc.HasExited) { try { $serverProc.Kill() } catch { } }
})

[System.Windows.Forms.Application]::Run($form)
