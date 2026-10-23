# Windows daemon 保活注册：计划任务 agentlink-daemon-keepalive 每 5 分钟拉起 daemon.mjs
# daemon 自带单实例锁（state 目录 daemon.lock）：已在运行则新进程秒退 0，幂等不双开——
# 计划任务实例与启动文件夹 .lnk、手工启动可任意并存。组策略禁任务注册时降级用启动文件夹 .lnk（仅开机拉起）。
# 用法：powershell -ExecutionPolicy Bypass -File agentlink-daemon-keepalive.ps1 [-Remove]
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$Client = Split-Path $PSScriptRoot -Parent   # contrib/ 上级即客户端根（含 daemon.mjs）
$Daemon = Join-Path $Client 'daemon.mjs'
$Task = 'agentlink-daemon-keepalive'
if ($Remove) {
  Unregister-ScheduledTask -TaskName $Task -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host ">> 已移除保活任务: $Task"
  exit 0
}
try {
  # ExecutionTimeLimit 0 = 不限时（daemon 常驻；默认 72h 会在三天后掐死健康 daemon）
  # MultipleInstances 默认 IgnoreNew：健康 daemon 作为任务实例常驻时，后续 tick 自动跳过；daemon 一死实例结束、下个 tick 拉起新的
  $Action = New-ScheduledTaskAction -Execute 'node.exe' -Argument "`"$Daemon`"" -WorkingDirectory $Client
  $Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
  $Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
  Register-ScheduledTask -TaskName $Task -Action $Action -Trigger $Trigger -Settings $Settings -Force | Out-Null
  Write-Host ">> 已注册 daemon 保活计划任务: $Task（每 5 分钟检查拉起；已在运行则秒退不双开）"
} catch {
  Write-Host ">> 保活任务注册失败: $($_.Exception.Message)"
  Write-Host ">> 降级方案（仅开机拉起、中途挂掉不自动恢复）: powershell -ExecutionPolicy Bypass -File `"$PSScriptRoot\agentlink-daemon-startup.ps1`""
  exit 1
}
