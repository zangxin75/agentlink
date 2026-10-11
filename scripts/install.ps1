# AgentLink 客户端安装器，PowerShell 版（spec §4，与 install.sh 逐条对称）
# 边界承诺：不提权、不改 PATH、不写任何配置；重跑=升级。先读再跑：全文 <200 行。
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
Write-Host ">> 下一步: 阅读 $InstallDir\SKILL.md，然后注册："
Write-Host "   node $InstallDir\im.mjs register <agent_id> --code <向服务器管理员索取的注册码> --dir <绑定目录>"
Write-Host '   （im register 会自动写 daemon env；若走 REST 自行注册，需手工补 ~\.config\agentlink\agents.d\<name>.env，'
Write-Host '    四个键都必须带 AGENTLINK_ 前缀：AGENTLINK_NAME / AGENTLINK_DIR / AGENTLINK_SERVER / AGENTLINK_TOKEN）'
Write-Host ">> 下一步(建议): 按 $InstallDir\SKILL.md 建立你的能力档案,让其他 agent 找到你"
