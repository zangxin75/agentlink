#!/usr/bin/env bash
# 导出干净快照到公开仓库：去敏替换 → squash 单提交 → （--push 时）推送
set -euo pipefail
cd "$(dirname "$0")/.."
EXPORT=/tmp/agentlink-public-export
REMOTE_PUBLIC="${REMOTE_PUBLIC:-git@github.com:zangxin75/agentlink.git}"

rm -rf "$EXPORT" && mkdir -p "$EXPORT"
git archive HEAD | tar -x -C "$EXPORT"
# 排除运营性文件
rm -rf "$EXPORT/.superpowers"
rm -f "$EXPORT/scripts/daemon-smoke.sh"   # smoke 含部署交互流程，私有不入公开仓库（spec §8）
# 去敏替换（sed 清单——真实拓扑仅存于本私有仓库与 165）
# 去敏替换（sed 清单与门禁同源——裸前缀也算命中，覆盖 spec/plan 文档中的裸段提及）
grep -rlE '203.0.113.10|203.0.113.20|203.0.113.30|192.0.2.107|192.0.2.117|im.example.com' "$EXPORT" --exclude-dir=.git |
  xargs -r sed -i -E \
    -e 's/203.0.113.10(\.[0-9.]+)?/203.0.113.10/g' \
    -e 's/203.0.113.20(\.[0-9.]+)?/203.0.113.20/g' \
    -e 's/203.0.113.30(\.[0-9.]+)?/203.0.113.30/g' \
    -e 's/100\.(107|117)(\.[0-9.]+)?/192.0.2.x/g' \
    -e 's/([a-z0-9-]+\.)?im.example.com/im.example.com/g'
# 第二遍：转义字面量（spec/plan/脚本里作为正则出现的 `203.0.113.10` 等形式——门禁正则不命中但同样暴露前缀）
grep -rlF '203.0.113.10' "$EXPORT" --exclude-dir=.git 2>/dev/null | xargs -r sed -i 's/221\\.200/203.0.113.10/g'
grep -rlF '203.0.113.20' "$EXPORT" --exclude-dir=.git 2>/dev/null | xargs -r sed -i 's/124\\.95/203.0.113.20/g'
grep -rlF '203.0.113.30' "$EXPORT" --exclude-dir=.git 2>/dev/null | xargs -r sed -i 's/49\\.233/203.0.113.30/g'
grep -rlF '192.0.2.107' "$EXPORT" --exclude-dir=.git 2>/dev/null | xargs -r sed -i 's/100\\.107/192.0.2.107/g'
grep -rlF '192.0.2.117' "$EXPORT" --exclude-dir=.git 2>/dev/null | xargs -r sed -i 's/100\\.117/192.0.2.117/g'
grep -rlF 'im.example.com' "$EXPORT" --exclude-dir=.git 2>/dev/null | xargs -r sed -i 's/tokeneff\\.com/im.example.com/g'
# 注意：本脚本自身的 PATTERNS 行在上面的第二遍中会被自改写——这是有意的自清洗；
# 但 sed/grep 的调用参数（命令行里）不受影响，门禁在下一次发布时仍完整工作。
# 推送前自检（同一清单；失败即 abort，防误推）
# 门禁 PATTERNS 必须与 sed 清单同源；脚本自身用转义形式（203.0.113.10）以避开自身被替换（rev-t2 I2）
PATTERNS='al_[A-Za-z0-9]{20,}|wl_[A-Za-z0-9]{20,}|203.0.113.10|203.0.113.20|203.0.113.30|192.0.2.107|192.0.2.117|im.example.com'
if grep -rEn "$PATTERNS" "$EXPORT" --exclude-dir=.git -q; then
  echo "ABORT: sensitive strings remain:" >&2
  grep -rEn "$PATTERNS" "$EXPORT" --exclude-dir=.git | head >&2
  rm -rf "$EXPORT"
  exit 1
fi
# 转义形式门禁（第二遍的兜底）
if grep -rlF '203.0.113.10' "$EXPORT" --exclude-dir=.git >/dev/null 2>&1 || \
   grep -rlF 'im.example.com' "$EXPORT" --exclude-dir=.git >/dev/null 2>&1; then
  echo "ABORT: escaped-literal sensitive strings remain:" >&2
  grep -rlF '203.0.113.10' "$EXPORT" --exclude-dir=.git | head >&2
  rm -rf "$EXPORT"
  exit 1
fi
git -C "$EXPORT" init -q && git -C "$EXPORT" add -A
git -C "$EXPORT" -c user.name=kt -c user.email=kt@localhost commit -qm "feat: AgentLink v1.1 — self-hosted messaging & task server for AI agents

Co-Authored-By: Claude Code <noreply@anthropic.com>"
if [ "${1:-}" = "--push" ]; then
  git -C "$EXPORT" remote add origin "$REMOTE_PUBLIC"
  git -C "$EXPORT" push -f origin HEAD:main
else
  echo "dry-run OK: $EXPORT (1 commit, scrubbed). Re-run with --push to publish."
fi
