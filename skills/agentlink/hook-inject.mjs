#!/usr/bin/env node
// Claude Code SessionStart / UserPromptSubmit hook：会话起点与每条用户消息前注入 AgentLink 未读
// 两个事件下 stdout 均直接并入上下文（与 Stop 的 JSON block 不同），故打印纯文本注入块
// 顺序契约沿用 hook-stop：stdout 先行、认领在后——打印后认领前被杀 → 下次注入重放（at-least-once）
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { hostname as osHostname } from 'node:os'
import { agentIdFor, parseEnvFile, matchAgentForCwd, AGENTS_DIR } from './lib/identity.mjs'
import { unreadListMulti, unreadAll, claim } from './lib/spool.mjs'
import { projectTopics, pushTopics } from './lib/topics.mjs'
import { formatInjection } from './lib/inject.mjs'

export async function runHook({ cwd, hostname = osHostname() }) {
  let entries = []
  try { entries = readdirSync(AGENTS_DIR).filter(f => f.endsWith('.env')).map(f => {
    try { return parseEnvFile(readFileSync(join(AGENTS_DIR, f), 'utf8')) } catch { return null }
  }).filter(Boolean) } catch { return null } // agents.d 不存在：no-op
  const e = matchAgentForCwd(entries, cwd)
  if (!e) return null
  const agentId = agentIdFor(e.name, hostname, e.dir)
  // T4：按项目声明的 topics + _default 过滤注入（spec §4.1/§6），并异步续期服务器注册表
  const mine = projectTopics(cwd)
  pushTopics({ agentId, token: e.token, server: e.server, topics: mine }).catch(() => {}) // 异步续期,失败静默
  const see = [...new Set([...mine, '_default'])]
  const msgs = unreadListMulti(agentId, see)
  const others = unreadAll(agentId).filter(x => !see.includes(x.topic))
  let text = formatInjection(msgs)
  if (others.length) {
    const detail = others.map(x => `${x.msgs.length} 封落在 topic「${x.topic}」`).join('、')
    text += `\n⚠ 存在 ${detail} 的待处理信（本会话未订阅），用 im inbox --all 查看`
  }
  if (!msgs.length && !others.length) return null
  return { text, agentId, ids: msgs.map(m => [m.topic ?? '_default', m.id]) } // [topic, msgId] 对,未注入的信不认领
}

export function claimIds(agentId, pairs) {
  // T4：ids 为 [topic, msgId] 对，逐对 claim
  for (const [topic, id] of pairs) { try { claim(agentId, topic, id) } catch { /* ENOENT：并发输家，静默 */ } }
}

if (process.argv[1] && process.argv[1].endsWith('hook-inject.mjs')) {
  let input = {}
  try { input = JSON.parse(readFileSync(0, 'utf8')) } catch {}
  const r = await runHook({ cwd: input.cwd ?? process.cwd() })
  if (r) {
    console.log(r.text)     // 先打印
    claimIds(r.agentId, r.ids) // 后认领
  }
  // 无未读：空输出 exit 0，不污染 Claude Code
}
