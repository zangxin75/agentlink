#!/usr/bin/env bash
# scripts/test-client-dist.sh — 客户端分发产物测试（spec §8）：构建 → 清单/扫描/SKILL 断言 → 裸目录冒烟
set -euo pipefail
cd "$(dirname "$0")/.."
FAIL=0; ok(){ echo "ok  - $1"; }; bad(){ echo "FAIL: $1"; FAIL=1; }
DL=web/download; TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

BUILD_OUT=$(bash scripts/build-client-dist.sh) || { echo 'FAIL: build 脚本失败'; exit 1; }

# 1. 产物清单（spec §2）
[ -f "$DL/agentlink.tar.gz" ] && ok latest tarball || bad 缺latest
# 选包弃 ls -t（mtime 同分钟不可靠）：从 build 输出解析刚构建的版本化文件名（r2 m2；排除 agentlink.tar.gz 由 -.* 保证）
V=$(printf '%s\n' "$BUILD_OUT" | sed -n 's/^built: \(agentlink-.*\.tar\.gz\) (.*/\1/p')
[ -n "$V" ] || { echo 'FAIL: 未能从 build 输出解析版本化 tarball 名'; exit 1; }
[ -n "$V" ] && ok "版本化 tarball: $V" || bad 缺版本化tarball
grep -qE '^[0-9a-f]{64}  agentlink\.tar\.gz$' "$DL/SHA256SUMS" && ok SHA256SUMS-latest || bad SHA256SUMS不含latest
(cd "$DL" && sha256sum -c SHA256SUMS >/dev/null) && ok SHA256SUMS校验通过 || bad SHA256校验失败
# 双 tarball 内容一致（spec §2「latest 副本（与版本文件内容一致）」；r1 m7——gzip 压缩时间戳致字节可差，
# 故比成员清单+VERSION 内容而非 cmp 字节）
diff <(tar -tzf "$DL/agentlink.tar.gz") <(tar -tzf "$DL/$V") >/dev/null && ok 双tarball清单一致 || bad 双tarball清单不一致
diff <(tar -xzOf "$DL/agentlink.tar.gz" agentlink/VERSION) <(tar -xzOf "$DL/$V" agentlink/VERSION) >/dev/null && ok 双tarball版本一致 || bad 双tarball版本不一致
TARBALL="$DL/agentlink.tar.gz"

# 2. tarball 结构：顶层 agentlink/、VERSION 在、test/ 不在、vendor/contrib 在
tar -tzf "$TARBALL" >"$TMP/list"
grep -q '^agentlink/VERSION$' "$TMP/list" && ok VERSION在 || bad 缺VERSION
grep -q '^agentlink/vendor/ws/wrapper.mjs$' "$TMP/list" && ok vendor在 || bad 缺vendor
grep -q '^agentlink/contrib/agentlink-daemon.service$' "$TMP/list" && ok contrib在 || bad 缺contrib
grep -q '^agentlink/contrib/agentlink-daemon-startup.ps1$' "$TMP/list" && ok win自启脚本在 || bad 缺win自启脚本
if grep -qE '^agentlink/test/' "$TMP/list"; then bad "test/未被排除"; else ok test已排除; fi
tar -xzf "$TARBALL" -C "$TMP"

# 3. 敏感扫描零命中（tarball 侧全量清单；install 源文件用 INSTALL 清单——其默认域 im.example.com 是刻意公开信息，豁免；
#    token 与内网 IP 项保留。两清单与 build 脚本逐字同源，r1 C4）
PATTERNS='al_[A-Za-z0-9]{20,}|wl_[A-Za-z0-9]{20,}|203.0.113.10|203.0.113.20|203.0.113.30|192.0.2.107|192.0.2.117|im.example.com'
PATTERNS_INSTALL='al_[A-Za-z0-9]{20,}|wl_[A-Za-z0-9]{20,}|203.0.113.10|203.0.113.20|203.0.113.30|192.0.2.107|192.0.2.117'
if grep -rEn "$PATTERNS" "$TMP/agentlink" -q; then bad 敏感串命中tarball; else ok 敏感扫描零命中-tarball; fi
if grep -rEn "$PATTERNS_INSTALL" scripts/install.sh scripts/install.ps1 -q 2>/dev/null; then bad 敏感串命中install; else ok 敏感扫描零命中-install; fi

# 4. 分发版 SKILL.md 断言（spec §8）：无仓库布局路径、命令带安装前缀
SK="$TMP/agentlink/SKILL.md"
grep -q 'skills/agentlink' "$SK" && bad SKILL残留仓库路径 || ok SKILL无仓库路径
grep -q 'bin/im ' "$SK" && bad SKILL残留bin/im裸用 || ok SKILL无bin/im裸用
grep -q 'node ~/.agentlink/client/im.mjs' "$SK" && ok SKILL安装前缀 || bad SKILL缺安装前缀
grep -q '注册码向你的 AgentLink 服务器管理员' "$SK" && ok 注册码来源 || bad SKILL缺注册码来源   # 与 sed 插入文本逐字对齐（r1 M2）

# 4b. 建档引导断言（spec §5）：SKILL 建档节 + prompt 模板进包 + install 完成语
grep -q '## 建立能力档案' "$SK" && ok SKILL建档节 || bad SKILL缺建档节
grep -q 'im\.mjs profile scan' "$SK" && ok SKILL三步引导 || bad SKILL缺三步引导   # brief 原文 'im profile scan' 在 sed 改写后不存在——dist 形态是 im.mjs profile scan（见任务报告偏差节）
[ -f "$TMP/agentlink/lib/profile-prompt.md" ] && ok prompt模板在包 || bad 缺prompt模板
grep -q '建立你的能力档案' scripts/install.sh && ok install建档提示 || bad install缺建档提示

# 5. 裸目录冒烟（关键，spec §8）：无 checkout、无 node_modules，锁 vendor 自足性
#    AGENTLINK_CONFIG/STATE 指向 $TMP——不污染真实 HOME（r1 m4；daemon 心跳/spool 默认落 ~/.local/state）
BARE=$TMP/bare; mkdir "$BARE"; tar -xzf "$TARBALL" -C "$BARE"
node "$BARE/agentlink/im.mjs" --help >/dev/null 2>&1 && ok 裸目录im || bad 裸目录im失败
AGENTLINK_CONFIG="$TMP/smoke-cfg" AGENTLINK_STATE="$TMP/smoke-state" \
  node "$BARE/agentlink/daemon.mjs" >/dev/null 2>&1 & DPID=$!
sleep 3; kill "$DPID" 2>/dev/null || bad 裸目录daemon3秒内退出
ok 裸目录daemon可运行

# 6. install.sh 实装（spec §8）：本地 http.server 作 DIST_BASE，INSTALL_DIR 覆盖目标（r1 m2/m3 修法：
#    server 用 --bind + 可捕获 PID；坏 SUMS 场景起第二个 server 指向篡改副本，不向生产 install.sh 塞测试钩子）
cd web/download   # 测试进程工作目录切到产物目录；下文相对路径以此为基准
PORT=18923; python3 -m http.server $PORT --bind 127.0.0.1 >/dev/null 2>&1 & SRV_PID=$!
BADPORT=18924; BADDIR_CONTENT=$TMP/badsums; cp -r . "$BADDIR_CONTENT"
(cd "$BADDIR_CONTENT" && sed -i 's/^[0-9a-f]/0/; s/^[0-9a-f]\{64\}/0000000000000000000000000000000000000000000000000000000000000000/' SHA256SUMS)
(cd "$BADDIR_CONTENT" && python3 -m http.server $BADPORT --bind 127.0.0.1 >/dev/null 2>&1 & echo $! > "$TMP/badpid")
sleep 0.7; cd ../..
INST=$TMP/inst
run_inst(){ bash scripts/install.sh; }   # 直接执行（脚本自身来源无关紧要）；变量经 shell 前缀赋值传入（env 不能调 shell 函数）——管道形态在下一断言单独验
if AGENTLINK_DIST_BASE="http://127.0.0.1:$PORT" AGENTLINK_INSTALL_DIR="$INST" run_inst >/dev/null 2>&1 \
   && [ -f "$INST/VERSION" ] && [ -f "$INST/vendor/ws/wrapper.mjs" ] && [ -f "$INST/contrib/agentlink-daemon.service" ]; then
  ok install装毕结构
else bad install装毕结构失败; fi
# curl|bash 管道形态 + 变量经环境传入（Review Focus #2）
if curl -fsSL "file://$PWD/scripts/install.sh" | env AGENTLINK_DIST_BASE="http://127.0.0.1:$PORT" AGENTLINK_INSTALL_DIR="$INST" bash >/dev/null 2>&1; then
  ok install管道形态可用
else bad install管道形态失败; fi
# 重跑=升级：打印新旧版本（断言锚点与脚本输出逐字对齐——「已安装版本」行任何一次安装都打印，r1 C2）
OUT2=$(AGENTLINK_DIST_BASE="http://127.0.0.1:$PORT" AGENTLINK_INSTALL_DIR="$INST" run_inst 2>&1 || true)
echo "$OUT2" | grep -q '已安装版本' && echo "$OUT2" | grep -q '旧版本' && ok install重跑打印新旧版本 || bad install重跑未打印新旧版本
# 兄弟目录不受影响（spool/config 在 ~/.agentlink 下但 client 之外，Review Focus #3）
mkdir -p "$(dirname "$INST")/state"; echo keep > "$(dirname "$INST")/state/keepme"
AGENTLINK_DIST_BASE="http://127.0.0.1:$PORT" AGENTLINK_INSTALL_DIR="$INST" run_inst >/dev/null 2>&1
[ -f "$(dirname "$INST")/state/keepme" ] && ok install不动兄弟目录 || bad install动了兄弟目录
# 损坏 SHA256SUMS（篡改服务端副本）→ 失败退出无半成品（Review Focus #4）
BADINST=$TMP/badinst
if AGENTLINK_DIST_BASE="http://127.0.0.1:$BADPORT" AGENTLINK_INSTALL_DIR="$BADINST" run_inst >/dev/null 2>&1; then
  bad 坏SUMS未失败
else ok 坏SUMS失败退出; fi
[ ! -e "$BADINST" ] && ok 坏SUMS无半成品 || bad 坏SUMS留半成品
# 安装器旧版保护/ps1 非目录检查（终审 minor 1/2）：mv 失败窗口无法不塞测试钩子地模拟，以结构断言钉死
grep -q 'al-old' scripts/install.sh && grep -q 'al-old' scripts/install.ps1 && ok 安装器旧版保护 || bad 安装器缺旧版保护
grep -q '已存在且非目录' scripts/install.ps1 && ok ps1非目录检查 || bad ps1缺非目录检查
# 用户实测反馈 4 缺陷（2026-10-01）：ps1 tar 退出码检查 / env 键名报错自描述 / daemon 自建 state 目录 / win 自启 contrib
grep -q 'LASTEXITCODE' scripts/install.ps1 && ok ps1-tar退出码 || bad ps1-tar无退出码检查
grep -q 'env file requires' skills/agentlink/lib/identity.mjs && ok env键名报错自描述 || bad env键名报错不自描述
grep -q "mkdirSync(dirname(HEARTBEAT)" skills/agentlink/daemon.mjs && ok daemon自建state目录 || bad daemon不自建state目录
grep -q "basename(c.envPath)" skills/agentlink/daemon.mjs && ok daemon-env删除判定跨平台 || bad daemon-env删除判定split误用（Windows 1006 循环）
# agent18 二轮实测：Git Bash GNU tar 遮蔽 System32 bsdtar；WinPS 5.1 解析无 BOM 的 UTF-8 ps1 按 GBK 误读崩解析器
grep -q 'System32\\tar.exe' scripts/install.ps1 && ok ps1-绝对路径bsdtar || bad ps1未规避GNU-tar遮蔽
[ "$(head -c3 scripts/install.ps1 | od -An -tx1 | tr -d ' \n')" = 'efbbbf' ] && ok ps1-UTF8BOM || bad ps1缺UTF8BOM（WinPS5.1 GBK误读）
[ "$(head -c3 web/download/install.ps1 | od -An -tx1 | tr -d ' \n')" = 'efbbbf' ] && ok 分发ps1-UTF8BOM || bad 分发ps1缺UTF8BOM
kill $SRV_PID "$(cat "$TMP/badpid")" 2>/dev/null || true

# 7. install.ps1 结构断言（spec §8：无 Windows CI 时静态核对；有 pwsh 加语法检查）
PS=scripts/install.ps1
# 首个可执行语句 = TLS1.2（Review Focus #5）
FIRST=$(sed '1s/^\xEF\xBB\xBF//' "$PS" | grep -vE '^\s*(#|$)' | head -1)
echo "$FIRST" | grep -q 'SecurityProtocol.*Tls12' && ok ps1首语句TLS12 || bad "ps1首语句非TLS12: $FIRST"
grep -q 'AGENTLINK_DIST_BASE' "$PS" && grep -q 'AGENTLINK_VERSION' "$PS" && grep -q 'AGENTLINK_INSTALL_DIR' "$PS" && ok ps1三变量契约 || bad ps1缺变量契约
grep -q 'Get-FileHash' "$PS" && ok ps1-GetFileHash || bad ps1缺Get-FileHash
grep -qE 'tar -xzf|tar.*xzf' "$PS" && ok ps1-tar || bad ps1缺tar解压
grep -q "ErrorActionPreference = 'Stop'" "$PS" && ok ps1-Stop偏好 || bad ps1缺Stop偏好
if command -v pwsh >/dev/null; then
  pwsh -NoProfile -Command "[scriptblock]::Create((Get-Content -Raw '$PS'))" >/dev/null 2>&1 && ok ps1语法检查 || bad ps1语法错误
else echo 'ok  - pwsh 不存在，跳过语法检查（人工核对清单见 spec §8）'; fi

[ "$FAIL" = 0 ] && echo 'ALL OK' || { echo 'CHECK FAILED'; exit 1; }
