# smart-proxy 卸载脚本
# 顺序很重要：先注销计划任务，否则它会把刚杀掉的进程重新拉起来。

param(
  [switch]$RemoveFiles
)

$ErrorActionPreference = 'Stop'
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$tools   = Join-Path $dshHome 'tools'
$startup = [Environment]::GetFolderPath('Startup')

# 1) 注销计划任务（先看护、再主任务，否则看护会把它拉回来）
$watchdogTask = 'DSH-SmartProxy-Watchdog'
$taskName = 'DSH-SmartProxy'
try {
  schtasks.exe /delete /tn $watchdogTask /f 2>$null | Out-Null
  Write-Host "已注销看护任务 $watchdogTask"
} catch { }
try {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop | Out-Null
  Write-Host "已注销计划任务 $taskName"
} catch { }

# 2) 删除旧版启动文件夹快捷方式
$lnk = Join-Path $startup 'SmartProxy.lnk'
if (Test-Path $lnk) { Remove-Item $lnk -Force; Write-Host "已删除 $lnk" }

# 3) 停止进程树：优先 PID 文件，其次按命令行匹配
$pidFile = Join-Path $tools 'smart-proxy.pid'
if (Test-Path $pidFile) {
  try {
    $relayPid = [int]((Get-Content $pidFile -Raw).Trim())
    if (Get-Process -Id $relayPid -ErrorAction SilentlyContinue) {
      & taskkill.exe /PID $relayPid /T /F 2>$null | Out-Null
      Write-Host "已结束转发进程 PID $relayPid"
    }
  } catch { }
}
Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*smart-proxy.js*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# 4) 从 .env 移除代理两项
$envPath = Join-Path $dshHome '.env'
if (Test-Path $envPath) {
  $kept = Get-Content $envPath | Where-Object { $_ -notmatch '^\s*(https?_proxy|all_proxy|no_proxy)\s*=' }
  if ($kept.Count -eq 0) { Remove-Item $envPath -Force; Write-Host "已删除 $envPath" }
  else { Set-Content -Path $envPath -Value $kept -Encoding ascii; Write-Host "已清理 $envPath 中的代理行" }
}

if ($RemoveFiles -and (Test-Path $tools)) {
  Remove-Item $tools -Recurse -Force
  Write-Host "已删除 $tools"
}

Write-Host "完成。请重启 DeepSeek Harness 以恢复直连。"
