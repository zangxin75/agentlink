# Windows 自启动注册（无 systemd、计划任务被组策略拒绝时的降级方案：启动文件夹 .lnk）
# 用法：powershell -ExecutionPolicy Bypass -File agentlink-daemon-startup.ps1 [-Remove]
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$Client = Split-Path $PSScriptRoot -Parent   # contrib/ 的上级即客户端根（含 daemon.mjs）
$Lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'agentlink-daemon.lnk'
if ($Remove) {
  if (Test-Path $Lnk) { Remove-Item $Lnk -Force; Write-Host ">> 已移除自启动: $Lnk" }
  else { Write-Host '>> 未安装（无 .lnk 可移除）' }
  exit 0
}
$sh = New-Object -ComObject WScript.Shell
$s = $sh.CreateShortcut($Lnk)
$s.TargetPath = 'powershell.exe'
$s.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command `"node `"$Client\daemon.mjs`""
$s.WorkingDirectory = $Client
$s.Description = 'AgentLink daemon（开机后台常驻，见 ~/.agentlink/client/SKILL.md）'
$s.Save()
Write-Host ">> 已注册自启动: $Lnk（重启生效；如需立即启动: node `"$Client\daemon.mjs`"）"
