#!/usr/bin/env bash
# scripts/test-publish-scrub.sh — 验证导出树去敏零命中
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/publish-public.sh || { echo "publish script failed"; exit 1; }
TREE=/tmp/agentlink-public-export
FAIL=0
# 门禁清单（spec §7）：真实凭据与拓扑零命中——与 publish-public.sh 共用同一清单（下方以变量复制保持同步）
PATTERNS='al_[A-Za-z0-9]{20,}|wl_[A-Za-z0-9]{20,}|203.0.113.10|203.0.113.20|203.0.113.30|192.0.2.107|192.0.2.117|im.example.com'
if grep -rEn "$PATTERNS" "$TREE" --exclude-dir=.git -q; then
  echo "LEAK FOUND:"; grep -rEn "$PATTERNS" "$TREE" --exclude-dir=.git | head -20; FAIL=1
fi
# 关键文件必须在
for f in README.md web/landing/index.html docs/deploy.md server/src/index.ts mcp/src/index.ts; do
  [ -f "$TREE/$f" ] || { echo "missing $f"; FAIL=1; }
done
# SDD 台账不入公开
[ ! -e "$TREE/.superpowers" ] || { echo ".superpowers leaked"; FAIL=1; }
# smoke 脚本不入公开（spec §8：含部署交互流程，私有）
[ ! -e "$TREE/scripts/daemon-smoke.sh" ] || { echo "daemon-smoke leaked"; FAIL=1; }
# squash 单提交
[ "$(git -C "$TREE" rev-list --count HEAD)" = "1" ] || { echo "history not squashed"; FAIL=1; }
exit $FAIL
