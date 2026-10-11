// skills/agentlink/lib/inbox-local.mjs — im inbox/unread 本地优先读取（spec §6/r2-F14）
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { hostname as osHostname } from 'node:os'
import { parseEnvFile, matchAgentForCwd, agentIdFor, AGENTS_DIR, HEARTBEAT } from './identity.mjs'
import { unreadListMulti, maxCursor } from './spool.mjs'
import { projectTopics } from './topics.mjs'

export function heartbeatFresh(maxAgeMs) {
  try { return Date.now() - statSync(HEARTBEAT).mtimeMs < maxAgeMs } catch { return false } // 文件缺失=不新鲜
}
function boundAgent(cwd) {
  try {
    const entries = readdirSync(AGENTS_DIR).filter(f => f.endsWith('.env'))
      .map(f => { try { return parseEnvFile(readFileSync(join(AGENTS_DIR, f), 'utf8')) } catch { return null } }).filter(Boolean)
    return matchAgentForCwd(entries, cwd)
  } catch { return null }
}
// T5：send 决策链/本地 claim 需要当前 cwd 绑定的 agent id；无绑定返回 null（critic-M8 安全）
export function boundAgentId(cwd, hostname = osHostname()) {
  const e = boundAgent(cwd)
  return e ? agentIdFor(e.name, hostname, e.dir) : null
}
// T4：本地读取按项目声明 topics ∪ _default（spec §4.1）
const seeTopics = (cwd) => [...new Set([...projectTopics(cwd), '_default'])]
export function localInbox({ cwd, hostname = osHostname() }) {
  const e = boundAgent(cwd)
  return e ? unreadListMulti(agentIdFor(e.name, hostname, e.dir), seeTopics(cwd)) : []
}
export function localInboxPlan({ cwd, hostname = osHostname() }) {
  const e = boundAgent(cwd)
  if (!e) return { local: [], needRest: true, cursor: null, agentId: null } // 无绑定：im inbox 走原 REST inbox（to_agent/仅未投递语义）
  const id = agentIdFor(e.name, hostname, e.dir)
  // 判定条件仅心跳年龄（RF4）：心跳新鲜即只信本地，与本地未读是否为空无关
  return { local: unreadListMulti(id, seeTopics(cwd)), needRest: !heartbeatFresh(30_000), cursor: maxCursor(id), agentId: id }
}
