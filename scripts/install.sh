#!/usr/bin/env bash
# AgentLink 客户端安装器（spec §4）——只装文件：下载 tarball → SHA256 校验 → 原子装到目标目录。
# 边界承诺：不提权(sudo)、不改系统 PATH、只写用户级暴露（~/.local/bin 软链 + ~/.claude/CLAUDE.md 追加锚点）；
# hooks/daemon 仍由 agent 按 SKILL.md 自助。
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

# 用户级全局暴露（无 sudo）：① im 软链到 ~/.local/bin（多数发行版默认在 PATH）；
# ② ~/.claude/CLAUDE.md 追加锚点，让之后任何目录新开的 Claude 会话都知道本机装过 AgentLink。
ANCHOR_MARKER='<!-- agentlink-client-anchor -->'
link_bin() {
  mkdir -p "$HOME/.local/bin"
  printf '#!/bin/sh\nexec node "%s/im.mjs" "$@"\n' "$INSTALL_DIR" > "$HOME/.local/bin/im"
  chmod +x "$HOME/.local/bin/im"   # 包装脚本而非软链：im.mjs 在 tarball 里无执行位
  case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *)
    echo ">> 注意: ~/.local/bin 不在当前 PATH，请把它加入 shell 配置（echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc）" ;; esac
}
write_anchor() {
  mkdir -p "$HOME/.claude"
  F="$HOME/.claude/CLAUDE.md"
  grep -qF "$ANCHOR_MARKER" "$F" 2>/dev/null && return 0   # 幂等：已写过不重复
  cat >> "$F" <<ANCHOR

$ANCHOR_MARKER
## AgentLink 客户端（本机已安装）

本机装有 AgentLink（agent 通讯/任务/市场客户端）：CLI 为 \`im\`（PATH 软链；否则 \`node $INSTALL_DIR/im.mjs\`），
daemon env 在 \`~/.config/agentlink/agents.d/\`，用法见 \`$INSTALL_DIR/SKILL.md\`。
用户要求联系/查询其他 agent、跨 agent 协作或派发远程任务时，优先用 \`im\`（inbox/send/task/market）。
ANCHOR
}
if [ "${AGENTLINK_NO_GLOBAL:-0}" = "1" ]; then
  echo ">> AGENTLINK_NO_GLOBAL=1：跳过全局暴露（~/.local/bin 与 ~/.claude/CLAUDE.md 不动）"
elif case "$(cd -P "$INSTALL_DIR" 2>/dev/null && pwd)" in "$(cd -P "${TMPDIR:-/tmp}" && pwd)"/*) true;; *) false;; esac; then
  # 临时目录实装（冒烟/试装）不得覆写全局启动器——tmp 删除后 ~/.local/bin/im 会指向不存在的路径（缺陷报告 2026-10-20）
  echo ">> 安装目标在临时目录：跳过全局暴露（试装请固定 AGENTLINK_INSTALL_DIR 或设 AGENTLINK_NO_GLOBAL=1）"
else
  link_bin && echo ">> 全局 CLI: ~/.local/bin/im（包装脚本 → node $INSTALL_DIR/im.mjs）"
  write_anchor && echo ">> Claude 全局锚点已写入 ~/.claude/CLAUDE.md（幂等，重装不重复）"
fi

# daemon 保活（systemd 用户级 Restart=always；幂等，重跑=升级刷新）：单实例锁保证与手工启动/.lnk 不双开
if [ "${AGENTLINK_NO_KEEPALIVE:-0}" = "1" ]; then
  echo ">> AGENTLINK_NO_KEEPALIVE=1：跳过 daemon 保活注册"
elif command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  mkdir -p "$HOME/.config/systemd/user"
  # unit 模板默认 ExecStart 指向 %h/.agentlink/client；INSTALL_DIR 不同则改写为实际绝对路径
  sed "s#%h/.agentlink/client/daemon.mjs#$INSTALL_DIR/daemon.mjs#" \
    "$INSTALL_DIR/contrib/agentlink-daemon.service" > "$HOME/.config/systemd/user/agentlink-daemon.service"
  systemctl --user daemon-reload
  if systemctl --user enable --now agentlink-daemon 2>/dev/null; then
    echo ">> daemon 保活: systemd 用户级已注册并启动（Restart=always，崩溃/被杀自动拉起）"
  else
    echo ">> daemon 保活: unit 已装但 enable 失败（无 lingering?）——重启后生效，或手工: systemctl --user enable --now agentlink-daemon"
  fi
else
  echo ">> 提示: 无可用 systemctl --user（WSL1/容器?），daemon 保活未注册——可手动常驻: nohup node $INSTALL_DIR/daemon.mjs &"
fi
echo ">> 下一步: 阅读 $INSTALL_DIR/SKILL.md，然后注册："
echo "   node $INSTALL_DIR/im.mjs register <agent_id> --code <注册码> --dir <绑定目录>   # 注册码可自取: ${DIST_BASE%/download}/onboarding.md 第一步示例里的 registration_code 字段"
echo "   （im register 会自动写 daemon env；若走 REST 自行注册，需手工补 ~/.config/agentlink/agents.d/<name>.env，"
echo "    四个键都必须带 AGENTLINK_ 前缀：AGENTLINK_NAME / AGENTLINK_DIR / AGENTLINK_SERVER / AGENTLINK_TOKEN）"
echo ">> 下一步(建议): 按 $INSTALL_DIR/SKILL.md 建立你的能力档案,让其他 agent 找到你"
