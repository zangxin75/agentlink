#!/usr/bin/env node
// Claude Code Stop hook：回合边界注入 AgentLink 未读（spec §6）
// 顺序契约：stdout 先行、认领在后——打印后认领前被杀 → 下回合重注入（at-least-once）
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { hostname as osHostname } from 'node:os'
import { agentIdFor, parseEnvFile, matchAgentForCwd, AGENTS_DIR } from './lib/identity.mjs'
import { unreadListMulti, claim } from './lib/spool.mjs'
import { projectTopics } from './lib/topics.mjs'
import { formatInjection } from './lib/inject.mjs'

export async function runHook({ cwd, hostname = osHostname() }) {
  let entries = []
  try { entries = readdirSync(AGENTS_DIR).filter(f => f.endsWith('.env')).map(f => {
    try { return parseEnvFile(readFileSync(join(AGENTS_DIR, f), 'utf8')) } catch { return null }
  }).filter(Boolean) } catch { return null } // agents.d 不存在：no-op
  const e = matchAgentForCwd(entries, cwd)
  if (!e) return null
  const agentId = agentIdFor(e.name, hostname, e.dir)
  // critic-H1：claim 签名双参化后，Stop 注入只消费本项目声明的 topics + _default（spec §6）
  const msgs = unreadListMulti(agentId, [...new Set([...projectTopics(cwd), '_default'])])
  if (!msgs.length) return null
  return { decision: 'block', reason: formatInjection(msgs), agentId, items: msgs.map(m => ({ topic: m.topic ?? '_default', id: m.id })) } // 不认领
}

export function claimIds(agentId, items) {
  for (const { topic, id } of items) { try { claim(agentId, topic, id) } catch { /* ENOENT：并发输家，静默 */ } }
}

if (process.argv[1] && process.argv[1].endsWith('hook-stop.mjs')) {
  let input = {}
  try { input = JSON.parse(readFileSync(0, 'utf8')) } catch {}
  const r = await runHook({ cwd: input.cwd ?? process.cwd() })
  if (r) {
    console.log(JSON.stringify({ decision: r.decision, reason: r.reason })) // 先打印
    claimIds(r.agentId, r.items)                                           // 后认领（topic+id 对，T3 双参 claim）
  }
  // 无未读：空输出 exit 0，不污染 Claude Code
}
