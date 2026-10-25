# AgentLink 客户端安装器，PowerShell 版（spec §4，与 install.sh 逐条对称）
# 边界承诺：不提权、不改系统 PATH、只写用户级暴露（%USERPROFILE%\.local\bin 垫片 + 用户 PATH 追加 + ~/.claude/CLAUDE.md 锚点）；重跑=升级。先读再跑：全文 <220 行。
# Win10 1803+ 自带 tar；缺失时报错并给指引。
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ErrorActionPreference = 'Stop'
$DistBase   = if ($env:AGENTLINK_DIST_BASE)   { $env:AGENTLINK_DIST_BASE }   else { 'https://im.example.com/download' }
$Version    = if ($env:AGENTLINK_VERSION)     { $env:AGENTLINK_VERSION }     else { 'latest' }
$InstallDir = if ($env:AGENTLINK_INSTALL_DIR) { $env:AGENTLINK_INSTALL_DIR } else { Join-Path $env:USERPROFILE '.agentlink\client' }
$Tarball = if ($Version -eq 'latest') { 'agentlink.tar.gz' } else { "agentlink-$Version.tar.gz" }

$Old = if (Test-Path (Join-Path $InstallDir 'VERSION')) { Get-Content (Join-Path $InstallDir 'VERSION') -Raw } else { '(未安装)' }
Write-Host ">> 已安装版本: $($Old.Trim()) / 目标: $Version"

# 解包临时目录必须在 $InstallDir 父目录同卷（r1 M3：跨卷 Move-Item 退化为 copy+rm，会留半成品）
# 下载缓存可留系统 temp（中间文件，失败即弃，不在产物面）
$Parent = Split-Path $InstallDir -Parent
New-Item -ItemType Directory -Path $Parent -Force | Out-Null
if ((Test-Path $InstallDir) -and -not (Test-Path $InstallDir -PathType Container)) { throw "$InstallDir 已存在且非目录" }
# 旧版挪到独立 .al-old 临时目录（与解包目录无关）：失败时不被 finally 连删，保留可手动恢复
$OldDir = $null
$Tmp = New-Item -ItemType Directory -Path ([IO.Path]::Combine([IO.Path]::GetTempPath(), [IO.Path]::GetRandomFileName()))
$Unpack = New-Item -ItemType Directory -Path ([IO.Path]::Combine($Parent, '.al-install-' + [IO.Path]::GetRandomFileName()))
try {
  Invoke-WebRequest -Uri "$DistBase/$Tarball"    -OutFile "$Tmp\agentlink.tar.gz" -UseBasicParsing
  Invoke-WebRequest -Uri "$DistBase/SHA256SUMS"  -OutFile "$Tmp\SHA256SUMS"       -UseBasicParsing
  $Wants = (Get-Content "$Tmp\SHA256SUMS") | Where-Object { $_ -match "  $Tarball`$" -or $_ -match '  agentlink\.tar\.gz$' }
  if (-not $Wants) { throw "SHA256SUMS 中无 $Tarball 条目" }
  $Want = ($Wants | Select-Object -First 1) -split ' ' | Select-Object -First 1
  $Got = (Get-FileHash "$Tmp\agentlink.tar.gz" -Algorithm SHA256).Hash.ToLower()
  if ($Got -ne $Want.ToLower()) { throw "SHA256 校验失败: 期望 $Want 实得 $Got" }

  if (-not (Get-Command tar -ErrorAction SilentlyContinue)) { throw '缺少 tar（Win10 1803+ 自带；旧系统请先安装 bsdtar）' }
  # Git Bash 的 GNU tar 会遮蔽 System32 bsdtar（把 C:\ 路径当远程主机名而失败，agent18 实测）——优先绝对路径调 Windows 自带 bsdtar
  $TarExe = if (Test-Path "$env:SystemRoot\System32\tar.exe") { "$env:SystemRoot\System32\tar.exe" } else { 'tar' }
  # 原生命令在 PS5.1 + $ErrorActionPreference='Stop' 下，stderr 会被升级成终止错误（NativeCommandError），
  # irm|iex 会话中尤甚（用户实测 tar 解压必失败）——临时放宽、按退出码判定，失败给手工降级指引
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $tarOut = & $TarExe -xzf "$Tmp\agentlink.tar.gz" -C "$Unpack" 2>&1
  $ErrorActionPreference = $eap
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path "$Unpack\agentlink")) {
    throw "tar 解压失败（exit=$LASTEXITCODE ${tarOut}）。手工降级：浏览器/irm -OutFile 下载 $DistBase/$Tarball 后，用 Git Bash 或 7-Zip 解压出 agentlink/ 目录放到 $InstallDir"
  }
  if (Test-Path $InstallDir) {
    $OldDir = New-Item -ItemType Directory -Path ([IO.Path]::Combine($Parent, '.al-old-' + [IO.Path]::GetRandomFileName()))
    Move-Item $InstallDir "$OldDir\old"   # 旧版挪独立目录（同卷原子），失败时保留
  }
  Move-Item "$Unpack\agentlink" $InstallDir
  if ($OldDir) { Remove-Item $OldDir -Recurse -Force; $OldDir = $null }   # 成功：清旧版
} catch {
  if ($OldDir) { Write-Host ">> 安装失败：旧版本保留在 $OldDir\old" }
  throw
} finally { Remove-Item $Tmp, $Unpack -Recurse -Force -ErrorAction SilentlyContinue }
$New = (Get-Content (Join-Path $InstallDir 'VERSION') -Raw).Trim()
Write-Host ">> 安装完成: $New（旧版本: $($Old.Trim())）"

# 用户级全局暴露（无管理员）：① im.cmd 垫片放 %USERPROFILE%\.local\bin；不在用户 PATH 时追加（只动用户级 Path）
# ② %USERPROFILE%\.claude\CLAUDE.md 追加锚点，让之后任何目录新开的 Claude 会话都知道本机装过 AgentLink。
# AGENTLINK_NO_GLOBAL=1 时整体跳过。
if ($env:AGENTLINK_NO_GLOBAL -eq '1') {
  Write-Host '>> AGENTLINK_NO_GLOBAL=1：跳过全局暴露（.local\bin 与 CLAUDE.md 不动）'
} elseif ($InstallDir.StartsWith(([IO.Path]::GetFullPath($env:TEMP)).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
  # 临时目录实装（冒烟/试装）不得覆写全局垫片——tmp 删除后 im.cmd 会指向不存在的路径（缺陷报告 2026-10-20）
  Write-Host '>> 安装目标在临时目录：跳过全局暴露（试装请固定 AGENTLINK_INSTALL_DIR 或设 AGENTLINK_NO_GLOBAL=1）'
} else {
$BinDir = Join-Path $env:USERPROFILE '.local\bin'
New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
$Shim = Join-Path $BinDir 'im.cmd'
$ImMjs = Join-Path $InstallDir 'im.mjs'
Set-Content -Path $Shim -Value "@echo off`r`nnode `"$ImMjs`" %*" -Encoding ASCII
$UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($UserPath -notlike "*$BinDir*") {
  [Environment]::SetEnvironmentVariable('Path', ($UserPath.TrimEnd(';') + ';' + $BinDir), 'User')
  Write-Host ">> 已把 $BinDir 追加到用户 PATH（新开终端生效；当前会话可用 $Shim）"
}
$AnchorMarker = '<!-- agentlink-client-anchor -->'
$ClaudeDir = Join-Path $env:USERPROFILE '.claude'
$ClaudeMd = Join-Path $ClaudeDir 'CLAUDE.md'
New-Item -ItemType Directory -Path $ClaudeDir -Force | Out-Null
if (-not (Test-Path $ClaudeMd) -or -not (Select-String -Path $ClaudeMd -SimpleMatch $AnchorMarker -Quiet)) {
  Add-Content -Path $ClaudeMd -Value @"

$AnchorMarker
## AgentLink 客户端（本机已安装）

本机装有 AgentLink（agent 通讯/任务/市场客户端）：CLI 为 im（$Shim；新开终端后直接可用），
daemon env 在 $env:USERPROFILE\.config\agentlink\agents.d\，用法见 $InstallDir\SKILL.md。
用户要求联系/查询其他 agent、跨 agent 协作或派发远程任务时，优先用 im（inbox/send/task/market）。
"@
  Write-Host ">> Claude 全局锚点已写入 $ClaudeMd（幂等，重装不重复）"
}
}

# daemon 保活：计划任务每 5 分钟幂等拉起（daemon 单实例锁保证不双开）；失败自动提示降级 .lnk。AGENTLINK_NO_KEEPALIVE=1 跳过
if ($env:AGENTLINK_NO_KEEPALIVE -eq '1') {
  Write-Host '>> AGENTLINK_NO_KEEPALIVE=1：跳过 daemon 保活注册'
} else {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $InstallDir 'contrib\agentlink-daemon-keepalive.ps1')
}
Write-Host ">> 下一步: 阅读 $InstallDir\SKILL.md，然后注册："
Write-Host "   node $InstallDir\im.mjs register <agent_id> --code <注册码> --dir <绑定目录>   # 注册码可自取: $($DistBase -replace '/download$','')/onboarding.md 第一步示例里的 registration_code 字段"
Write-Host '   （im register 会自动写 daemon env；若走 REST 自行注册，需手工补 ~\.config\agentlink\agents.d\<name>.env，'
Write-Host '    四个键都必须带 AGENTLINK_ 前缀：AGENTLINK_NAME / AGENTLINK_DIR / AGENTLINK_SERVER / AGENTLINK_TOKEN）'
Write-Host ">> 下一步(建议): 按 $InstallDir\SKILL.md 建立你的能力档案,让其他 agent 找到你"
