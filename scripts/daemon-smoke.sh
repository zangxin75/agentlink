#!/usr/bin/env bash
# AgentLink daemon smoke（spec §8）——真实环境 9 步端到端验证
# 前置 env（全部必填，脚本内零硬编码地址/凭据）：
#   AGENTLINK_SMOKE_SERVER       服务地址（https://… 或 http://ip:port）
#   AGENTLINK_SMOKE_CODE         注册码
#   AGENTLINK_SMOKE_SENDER_TOKEN 另一 agent 的 token（外部发消息用）
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=$(pwd)
S=${AGENTLINK_SMOKE_SERVER:?need env AGENTLINK_SMOKE_SERVER}
CODE=${AGENTLINK_SMOKE_CODE:?need env AGENTLINK_SMOKE_CODE}
ST=${AGENTLINK_SMOKE_SENDER_TOKEN:?need env AGENTLINK_SMOKE_SENDER_TOKEN}
W=$(mktemp -d)
trap 'for p in ${DPID:-} ${DPID2:-}; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done; rm -rf $W' EXIT
# 双套配置变量同指一处：identity.mjs 读 AGENTLINK_*，im.mjs 的 config.json 读 IM_CONFIG_DIR
export AGENTLINK_CONFIG=$W/cfg AGENTLINK_STATE=$W/state IM_CONFIG_DIR=$W/cfg
NAME=smoke-$RANDOM$RANDOM
im() { AGENTLINK_SERVER=$S node "$REPO/skills/agentlink/im.mjs" "$@"; }
# 1 注册，并按同一算法算出 agent_id（发送方须用完整 id）
im register "$NAME" --code "$CODE" --dir "$W" >/dev/null
AID=$(node --input-type=module -e "import os from 'node:os'; import { agentIdFor } from '$REPO/skills/agentlink/lib/identity.mjs'; console.log(agentIdFor('$NAME', os.hostname(), '$W'))")
# 2 启 daemon，等 WS 连上（心跳文件出现）
node "$REPO/skills/agentlink/daemon.mjs" & DPID=$!
for i in $(seq 20); do [ -f $W/state/heartbeat ] && break; sleep 0.5; done
[ -f $W/state/heartbeat ] || { echo 'FAIL: no heartbeat'; exit 1; }
# 3 外部发消息
curl -s -X POST "$S/v1/messages" -H "authorization: Bearer $ST" -H 'content-type: application/json' \
  -d "{\"to\":\"$AID\",\"type\":\"text\",\"body\":{\"text\":\"smoke $NAME\"},\"client_msg_id\":\"$(cat /proc/sys/kernel/random/uuid)\"}" >/dev/null
sleep 2
# 4 spool 落盘（顶层未读）
test -n "$(find $W/state/spool/$AID -maxdepth 1 -name '*.json')"
grep -q "smoke $NAME" $W/state/spool/$AID/*.json
# 5 Stop hook 注入（block + 不可信框定）
H=$(node "$REPO/skills/agentlink/hook-stop.mjs" <<< "{\"cwd\":\"$W\"}")
echo "$H" | grep -q '"decision":"block"'; echo "$H" | grep -q '不可信数据'
# 6 再跑：已认领 → 空输出；消息进 consumed/
H2=$(node "$REPO/skills/agentlink/hook-stop.mjs" <<< "{\"cwd\":\"$W\"}")
[ -z "$H2" ]
test -d $W/state/spool/$AID/consumed && ls $W/state/spool/$AID/consumed/*.json >/dev/null
# 7 im inbox 本地可见（在绑定目录 $W 内跑：心跳新鲜 → 只读本地；消息已 consumed → 本地空；冒烟目的=命令通路不炸）
( cd "$W" && im inbox ) >/dev/null
# 8 停 daemon、心跳过期 >30s → 新消息走 REST 兜底可见
kill $DPID; wait $DPID 2>/dev/null || true
curl -s -X POST "$S/v1/messages" -H "authorization: Bearer $ST" -H 'content-type: application/json' \
  -d "{\"to\":\"$AID\",\"type\":\"text\",\"body\":{\"text\":\"smoke2 $NAME\"},\"client_msg_id\":\"$(cat /proc/sys/kernel/random/uuid)\"}" >/dev/null
touch -d '40 seconds ago' $W/state/heartbeat
( cd "$W" && im inbox ) | grep -q 'smoke2'
# 9 重启 daemon：auth_ok 补洞 + 重连
node "$REPO/skills/agentlink/daemon.mjs" & DPID2=$!
sleep 3; kill $DPID2; wait $DPID2 2>/dev/null || true
echo "SMOKE OK"
