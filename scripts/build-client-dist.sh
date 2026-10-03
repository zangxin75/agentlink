#!/usr/bin/env bash
# 构建客户端分发产物到 web/download/（spec §2/§6）——tarball 自足、压缩前敏感扫描、多版本保留
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd); cd "$ROOT"
OUT=web/download; STAGE=$(mktemp -d); trap 'rm -rf "$STAGE"' EXIT
VER=$(git describe --tags 2>/dev/null || echo "0.0.0-$(date +%Y%m%d)-$(git rev-parse --short HEAD)")

# 1. 干净源：git archive HEAD 取 skills/agentlink（排除 test/），重定层为 agentlink/
mkdir -p "$STAGE/tree"
git archive HEAD skills/agentlink | tar -x -C "$STAGE"
mv "$STAGE/skills/agentlink" "$STAGE/tree/agentlink"
rm -rf "$STAGE/tree/agentlink/test"

# 2. VERSION + 分发版 SKILL.md（sed 改写，两版命令语义一一对应——spec §2）
echo "$VER" > "$STAGE/tree/agentlink/VERSION"
SK="$STAGE/tree/agentlink/SKILL.md"
sed -i -E \
  -e 's#`bin/im #`node ~/.agentlink/client/im.mjs #g' \
  -e 's#`im #`node ~/.agentlink/client/im.mjs #g' \
  -e 's#<abs>/skills/agentlink/hook-stop\.mjs#~/.agentlink/client/hook-stop.mjs#g' \
  -e 's#<abs>/skills/agentlink/hook-inject\.mjs#~/.agentlink/client/hook-inject.mjs#g' \
  -e 's#deploy/agentlink-daemon\.service#~/.agentlink/client/contrib/agentlink-daemon.service#g' \
  -e 's#（ExecStart 路径按实际 checkout 调整）##g' \
  "$SK"
# 注册码来源插到 frontmatter（1-4 行）之后、正文标题之前（spec §2：分发版开头写明来源）
sed -i '5i\
> 注册码向你的 AgentLink 服务器管理员（即你的所有者）索取；其余注册步骤见下文。\
' "$SK"

# 3. 敏感扫描门禁——tar 压缩之前（spec §6；tarball 树用全量清单，与 publish-public.sh 逐字同源）。
#    install 源文件用 INSTALL 清单：其默认域 im.example.com 是刻意公开信息（install 器就是从那下载），豁免
#    im.example.com 单项；token 与内网 IP 项保留。tarball 内不含 install 源文件，产物树始终全量扫描，豁免不漏水（r1 C4）。
PATTERNS='al_[A-Za-z0-9]{20,}|wl_[A-Za-z0-9]{20,}|203.0.113.10|203.0.113.20|203.0.113.30|192.0.2.107|192.0.2.117|im.example.com'
PATTERNS_INSTALL='al_[A-Za-z0-9]{20,}|wl_[A-Za-z0-9]{20,}|203.0.113.10|203.0.113.20|203.0.113.30|192.0.2.107|192.0.2.117'
if grep -rEn "$PATTERNS" "$STAGE/tree" -q; then
  echo 'ABORT: 敏感串命中（客户端包是最高敏面）:' >&2
  grep -rEn "$PATTERNS" "$STAGE/tree" | head >&2; exit 1
fi
if grep -rEn "$PATTERNS_INSTALL" scripts/install.sh scripts/install.ps1 -q 2>/dev/null; then
  echo 'ABORT: install 源文件敏感串命中:' >&2
  grep -rEn "$PATTERNS_INSTALL" scripts/install.sh scripts/install.ps1 | head >&2; exit 1
fi

# 4. 打包（同内容两份：版本化 + latest）+ 校验和；不清理旧版本（spec §2 版本保留 N≥3）
mkdir -p "$OUT"
tar -czf "$OUT/agentlink-$VER.tar.gz" -C "$STAGE/tree" agentlink
tar -czf "$OUT/agentlink.tar.gz" -C "$STAGE/tree" agentlink
cd "$OUT" && sha256sum "agentlink-$VER.tar.gz" agentlink.tar.gz > SHA256SUMS
cp "$ROOT/scripts/install.sh" "$ROOT/scripts/install.ps1" "$ROOT/$OUT/"   # 双侧仓库根前缀（上一步 cd "$OUT" 后相对路径失效；此前目标侧相对路径致 cp 静默失败，产物 install 脚本停更）
echo "built: agentlink-$VER.tar.gz (+latest 副本, SHA256SUMS)"
