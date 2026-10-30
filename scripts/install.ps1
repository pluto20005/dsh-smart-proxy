# dsh-smart-proxy installer
#
# Installs a loopback HTTP relay that lets DeepSeek Harness use a local proxy
# (Clash / Bluelayer / mihomo, etc.) when it is reachable and fall back to a
# direct connection when it is not.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -UpstreamPort 7890
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -DshExe "C:\path\DeepSeek Harness.exe"

param(
  [string]$DshExe = '',
  [int]$ListenPort = 7900,
  [int]$UpstreamPort = 7897,
  [string]$Probe = 'www.google.com:443'
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path $PSScriptRoot -Parent
$dshHome  = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$tools    = Join-Path $dshHome 'tools'
$startup  = [Environment]::GetFolderPath('Startup')
$taskName = 'DSH-SmartProxy'
$watchdogTask = 'DSH-SmartProxy-Watchdog'

function Resolve-Runner {
  param([string]$explicit)
  if ($explicit) {
    if (-not (Test-Path $explicit)) { throw "Runtime not found: $explicit" }
    return @{ Path = (Resolve-Path $explicit).Path; Kind = 'electron' }
  }

  $cands = New-Object System.Collections.Generic.List[string]
  if ($env:DSH_DESKTOP_NODE_EXECUTABLE) { $cands.Add($env:DSH_DESKTOP_NODE_EXECUTABLE) }
  if ($env:LOCALAPPDATA) { $cands.Add((Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe')) }
  if ($env:ProgramFiles) { $cands.Add((Join-Path $env:ProgramFiles 'DeepSeek Harness\DeepSeek Harness.exe')) }
  if (${env:ProgramFiles(x86)}) { $cands.Add((Join-Path ${env:ProgramFiles(x86)} 'DeepSeek Harness\DeepSeek Harness.exe')) }
  if ($env:LOCALAPPDATA) { $cands.Add((Join-Path $env:LOCALAPPDATA 'DeepSeek Harness\DeepSeek Harness.exe')) }

  # Portable installs live directly under a drive root (e.g. D:\deepseek_harness).
  foreach ($drive in (Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue)) {
    $root = $drive.Root
    if (-not $root) { continue }
    $cands.Add((Join-Path $root 'deepseek_harness\DeepSeek Harness.exe'))
    $cands.Add((Join-Path $root 'DeepSeek Harness\DeepSeek Harness.exe'))
    $cands.Add((Join-Path $root 'Program Files\DeepSeek Harness\DeepSeek Harness.exe'))
  }

  $wsh = New-Object -ComObject WScript.Shell
  foreach ($dir in @((Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'),
                     (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'))) {
    $lnk = Join-Path $dir 'DeepSeek Harness.lnk'
    if (Test-Path $lnk) {
      try {
        $t = $wsh.CreateShortcut($lnk).TargetPath
        if ($t) { $cands.Add($t) }
      } catch { }
    }
  }

  foreach ($c in $cands) {
    if ($c -and (Test-Path $c) -and ((Split-Path $c -Leaf) -like 'DeepSeek Harness.exe')) {
      return @{ Path = (Resolve-Path $c).Path; Kind = 'electron' }
    }
  }

  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node) { return @{ Path = $node.Source; Kind = 'node' } }

  throw "Neither DeepSeek Harness nor Node.js was found. Install DSH, or pass -DshExe <path to DeepSeek Harness.exe>."
}

$runner = Resolve-Runner $DshExe
Write-Host "== runtime: $($runner.Path) ($($runner.Kind))"
Write-Host "== install to: $tools"

$srcJs = Join-Path $repoRoot 'src\smart-proxy.js'
if (-not (Test-Path $srcJs)) { $srcJs = Join-Path $PSScriptRoot 'smart-proxy.js' }
if (-not (Test-Path $srcJs)) { throw "smart-proxy.js not found (expected src\smart-proxy.js)" }

New-Item -ItemType Directory -Force -Path $tools | Out-Null

# Remove old tasks first so they do not restart the relay mid-install.
try { Unregister-ScheduledTask -TaskName $watchdogTask -Confirm:$false -ErrorAction Stop | Out-Null } catch { }
try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop | Out-Null } catch { }

# Stop the previous relay: PID file first, then whatever listens on the port.
function Stop-SmartProxy {
  param([int]$procId)
  if ($procId -le 0) { return $false }
  $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if (-not $proc) { return $false }
  $cmdline = $null
  try { $cmdline = (Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction Stop).CommandLine } catch { }
  if ($cmdline) {
    if ($cmdline -notlike '*smart-proxy.js*') { return $false }
  } elseif ($proc.ProcessName -notmatch '^(DeepSeek Harness|node)$') {
    return $false
  }
  Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
  return $true
}

$pidFile = Join-Path $tools 'smart-proxy.pid'
if (Test-Path $pidFile) {
  try { Stop-SmartProxy ([int]((Get-Content $pidFile -Raw).Trim())) | Out-Null } catch { }
}
try {
  foreach ($c in (Get-NetTCPConnection -LocalPort $ListenPort -State Listen -ErrorAction Stop)) {
    Stop-SmartProxy $c.OwningProcess | Out-Null
  }
} catch { }

for ($i = 0; $i -lt 10; $i++) {
  $busy = $false
  try { $busy = [bool](Get-NetTCPConnection -LocalPort $ListenPort -State Listen -ErrorAction Stop) } catch { }
  if (-not $busy) { break }
  Start-Sleep -Milliseconds 300
}

Copy-Item $srcJs (Join-Path $tools 'smart-proxy.js') -Force
$readme = Join-Path $repoRoot 'README.md'
if (Test-Path $readme) { Copy-Item $readme (Join-Path $tools 'README.md') -Force }
$oldReadme = Join-Path $tools 'README.txt'
if (Test-Path $oldReadme) { Remove-Item $oldReadme -Force }
foreach ($f in @('uninstall.ps1','smart-proxy-watchdog.vbs')) {
  $p = Join-Path $PSScriptRoot $f
  if (Test-Path $p) { Copy-Item $p (Join-Path $tools $f) -Force }
}

# Manual launcher (no wait): handy for testing but not used by the task.
$vbsPath = Join-Path $tools 'smart-proxy.vbs'
$vbs = New-Object System.Collections.Generic.List[string]
$vbs.Add('Set fso = CreateObject("Scripting.FileSystemObject")')
$vbs.Add('Set sh = CreateObject("WScript.Shell")')
$vbs.Add('dir = fso.GetParentFolderName(WScript.ScriptFullName)')
$vbs.Add('sh.CurrentDirectory = dir')
$vbs.Add('Set env = sh.Environment("PROCESS")')
if ($runner.Kind -eq 'electron') { $vbs.Add('env("ELECTRON_RUN_AS_NODE") = "1"') }
$vbs.Add("env(`"SMART_PROXY_PORT`") = `"$ListenPort`"")
$vbs.Add("env(`"SMART_PROXY_UPSTREAM_PORT`") = `"$UpstreamPort`"")
$vbs.Add("env(`"SMART_PROXY_PROBE`") = `"$Probe`"")
$vbs.Add('env("SMART_PROXY_LOG") = dir & "\smart-proxy.log"')
$vbs.Add("sh.Run Chr(34) & `"$($runner.Path)`" & Chr(34) & `" `" & Chr(34) & dir & `"\smart-proxy.js`" & Chr(34), 0, False")
[IO.File]::WriteAllText($vbsPath, ($vbs -join "`r`n") + "`r`n", [Text.Encoding]::Unicode)

# Task action: start the runtime directly and wait, so Task Scheduler sees a
# long-running task and can restart it when the relay exits.
$runVbsPath = Join-Path $tools 'smart-proxy-run.vbs'
$run = New-Object System.Collections.Generic.List[string]
$run.Add('Set fso = CreateObject("Scripting.FileSystemObject")')
$run.Add('Set sh = CreateObject("WScript.Shell")')
$run.Add('dir = fso.GetParentFolderName(WScript.ScriptFullName)')
$run.Add('sh.CurrentDirectory = dir')
$run.Add('Set env = sh.Environment("PROCESS")')
if ($runner.Kind -eq 'electron') { $run.Add('env("ELECTRON_RUN_AS_NODE") = "1"') }
$run.Add("env(`"SMART_PROXY_PORT`") = `"$ListenPort`"")
$run.Add("env(`"SMART_PROXY_UPSTREAM_PORT`") = `"$UpstreamPort`"")
$run.Add("env(`"SMART_PROXY_PROBE`") = `"$Probe`"")
$run.Add('env("SMART_PROXY_LOG") = dir & "\smart-proxy.log"')
$run.Add("code = sh.Run(Chr(34) & `"$($runner.Path)`" & Chr(34) & `" `" & Chr(34) & dir & `"\smart-proxy.js`" & Chr(34), 0, True)")
$run.Add('WScript.Quit code')
[IO.File]::WriteAllText($runVbsPath, ($run -join "`r`n") + "`r`n", [Text.Encoding]::Unicode)

# Debug launcher (ANSI, console visible).
$cmdPath = Join-Path $tools 'smart-proxy.cmd'
$cmd = New-Object System.Collections.Generic.List[string]
$cmd.Add('@echo off')
$cmd.Add('setlocal')
if ($runner.Kind -eq 'electron') { $cmd.Add('set "ELECTRON_RUN_AS_NODE=1"') }
$cmd.Add("set `"SMART_PROXY_PORT=$ListenPort`"")
$cmd.Add("set `"SMART_PROXY_UPSTREAM_PORT=$UpstreamPort`"")
$cmd.Add("set `"SMART_PROXY_PROBE=$Probe`"")
$cmd.Add('set "SMART_PROXY_LOG=%~dp0smart-proxy.log"')
$cmd.Add("`"$($runner.Path)`" `"%~dp0smart-proxy.js`" >> `"%~dp0smart-proxy.out.log`" 2>&1")
$ansi = [Text.Encoding]::GetEncoding([Globalization.CultureInfo]::CurrentCulture.TextInfo.ANSICodePage)
[IO.File]::WriteAllText($cmdPath, ($cmd -join "`r`n") + "`r`n", $ansi)

# Point DSH at the relay (only DSH reads this file).
$envPath = Join-Path $dshHome '.env'
$kept = @()
if (Test-Path $envPath) {
  $kept = Get-Content $envPath | Where-Object { $_ -notmatch '^\s*(https?_proxy|all_proxy|no_proxy)\s*=' }
}
$lines = @($kept) + @(
  "HTTPS_PROXY=http://127.0.0.1:$ListenPort",
  "HTTP_PROXY=http://127.0.0.1:$ListenPort"
)
Set-Content -Path $envPath -Value $lines -Encoding ascii
Write-Host "== wrote $envPath"

# Autostart: logon trigger, normal user token, restart on failure.
$action = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\wscript.exe') `
  -Argument ('"' + $runVbsPath + '"')
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "== registered task $taskName (logon, restart on failure every minute)"

# Watchdog: ask Task Scheduler to start the relay every minute; IgnoreNew
# makes it a no-op while the relay is already running.
$wdVbs = Join-Path $tools 'smart-proxy-watchdog.vbs'
if (Test-Path $wdVbs) {
  & schtasks.exe /create /tn $watchdogTask /tr "wscript.exe $wdVbs" /sc minute /mo 1 /f 2>$null | Out-Null
  Write-Host "== registered watchdog task $watchdogTask"
}

$oldLnk = Join-Path $startup 'SmartProxy.lnk'
if (Test-Path $oldLnk) { Remove-Item $oldLnk -Force }

Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 3

$ok = $false
for ($i = 0; $i -lt 10; $i++) {
  try {
    $c = New-Object Net.Sockets.TcpClient
    $c.Connect('127.0.0.1', $ListenPort)
    $c.Close()
    $ok = $true
    break
  } catch { Start-Sleep -Milliseconds 500 }
}
if (-not $ok) { throw "smart-proxy is not listening on 127.0.0.1:$ListenPort; see $tools\smart-proxy.log" }

try {
  $status = Invoke-RestMethod -Uri "http://127.0.0.1:$ListenPort/__smart_proxy/status" -TimeoutSec 5
} catch {
  throw "127.0.0.1:$ListenPort did not answer the status endpoint; the port may be used by another program. See $tools\smart-proxy.log"
}
Write-Host "== status:"
$status | ConvertTo-Json -Depth 3

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) { Write-Host "== task state: $($task.State)" }
if (Test-Path $pidFile) {
  try {
    $relayPid = [int]((Get-Content $pidFile -Raw).Trim())
    $relay = Get-CimInstance Win32_Process -Filter "ProcessId=$relayPid" -ErrorAction Stop
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($relay.ParentProcessId)" -ErrorAction SilentlyContinue
    $parentName = if ($parent) { $parent.Name } else { '(exited)' }
    Write-Host "== relay pid $relayPid, parent $parentName"
  } catch { }
}

Write-Host ""
Write-Host "Done. Fully quit DeepSeek Harness (tray -> Quit) and start it again so it reads the new .env."
