#!/usr/bin/env bash
# AgentLink 客户端安装器（spec §4）——只装文件：下载 tarball → SHA256 校验 → 原子装到目标目录。
# 边界承诺：不提权(sudo)、不改 PATH、不写任何 Claude Code 配置；hooks/daemon 由 agent 按 SKILL.md 自助。
# 重跑 = 升级（幂等）。可先读再跑：全文 <200 行。
set -euo pipefail
DIST_BASE="${AGENTLINK_DIST_BASE:-https://im.example.com/download}"
VERSION="${AGENTLINK_VERSION:-latest}"
INSTALL_DIR="${AGENTLINK_INSTALL_DIR:-$HOME/.agentlink/client}"
TARBALL="$([ "$VERSION" = latest ] && echo agentlink.tar.gz || echo "agentlink-$VERSION.tar.gz")"

need(){ command -v "$1" >/dev/null || { echo "缺少 $1，请先安装" >&2; exit 1; }; }
need curl; need tar
sum(){ if command -v sha256sum >/dev/null; then sha256sum "$@"; else need shasum; shasum -a 256 "$@"; fi; }

# 已装版本提示（升级路径，spec §4 条 3）
OLD="(未安装)"
[ -f "$INSTALL_DIR/VERSION" ] && OLD=$(cat "$INSTALL_DIR/VERSION")
echo ">> 已安装版本: $OLD / 目标: $VERSION"

# 目标父目录先行创建（解包临时目录须与其同卷，r1 M3）；下载缓存在系统 tmp（中间文件，失败即弃）
PARENT=$(dirname "$INSTALL_DIR"); mkdir -p "$PARENT"
# 旧版挪到独立 .al-old 临时目录（与解包目录无关）：升级失败时 EXIT trap 只清下载/解包缓存，旧版保留可手动恢复
OLD_DIR=""
TMPD=$(mktemp -d); UNPACK=$(mktemp -d "$PARENT/.al-install-XXXX")
trap '{ rm -rf "$TMPD" "$UNPACK"; if [ -n "$OLD_DIR" ] && [ -d "$OLD_DIR/old" ]; then echo ">> 安装失败：旧版本保留在 $OLD_DIR/old（可手动 mv 回 $INSTALL_DIR）" >&2; fi; }' EXIT
echo ">> 下载 $DIST_BASE/$TARBALL"
curl -fsSL -o "$TMPD/agentlink.tar.gz" "$DIST_BASE/$TARBALL"
curl -fsSL -o "$TMPD/SHA256SUMS" "$DIST_BASE/SHA256SUMS"
[ -s "$TMPD/agentlink.tar.gz" ] && [ -s "$TMPD/SHA256SUMS" ] || { echo '下载失败（空文件）' >&2; exit 1; }

# SHA256 校验：从 SUMS 中取本 tarball 行（latest 名或版本名），比对失败即退出
WANT=$( (grep -E "  $TARBALL\$" "$TMPD/SHA256SUMS" || grep -E '  agentlink\.tar\.gz$' "$TMPD/SHA256SUMS") | head -1 | cut -d' ' -f1)
[ -n "$WANT" ] || { echo "SHA256SUMS 中无 $TARBALL 条目" >&2; exit 1; }
GOT=$(sum "$TMPD/agentlink.tar.gz" | cut -d' ' -f1)
[ "$GOT" = "$WANT" ] || { echo "SHA256 校验失败: 期望 $WANT 实得 $GOT" >&2; exit 1; }

# 解包到临时目录 → 原子改名（不留半成品，spec §4 条 5；目标已存在且非目录 → 报错）
tar -xzf "$TMPD/agentlink.tar.gz" -C "$UNPACK"
[ -d "$UNPACK/agentlink" ] || { echo 'tarball 结构异常（缺 agentlink/ 顶层）' >&2; exit 1; }
[ -e "$INSTALL_DIR" ] && [ ! -d "$INSTALL_DIR" ] && { echo "$INSTALL_DIR 已存在且非目录" >&2; exit 1; }
if [ -d "$INSTALL_DIR" ]; then OLD_DIR=$(mktemp -d "$PARENT/.al-old-XXXX"); mv "$INSTALL_DIR" "$OLD_DIR/old"; fi   # 旧版挪独立目录（同卷原子），失败时保留
mv "$UNPACK/agentlink" "$INSTALL_DIR"
NEW=$(cat "$INSTALL_DIR/VERSION")
rm -rf "$OLD_DIR" && OLD_DIR=""   # 成功：清旧版并解除 trap 提示
echo ">> 安装完成: $NEW（旧版本: $OLD）"
echo ">> 下一步: 阅读 $INSTALL_DIR/SKILL.md，然后注册："
echo "   node $INSTALL_DIR/im.mjs register <agent_id> --code <向服务器管理员索取的注册码> --dir <绑定目录>"
echo "   （im register 会自动写 daemon env；若走 REST 自行注册，需手工补 ~/.config/agentlink/agents.d/<name>.env，"
echo "    四个键都必须带 AGENTLINK_ 前缀：AGENTLINK_NAME / AGENTLINK_DIR / AGENTLINK_SERVER / AGENTLINK_TOKEN）"
echo ">> 下一步(建议): 按 $INSTALL_DIR/SKILL.md 建立你的能力档案,让其他 agent 找到你"
