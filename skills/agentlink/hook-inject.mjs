#!/usr/bin/env node
// Claude Code SessionStart / UserPromptSubmit hook：会话起点与每条用户消息前注入 AgentLink 未读
// 两个事件下 stdout 均直接并入上下文（与 Stop 的 JSON block 不同），故打印纯文本注入块
// 顺序契约沿用 hook-stop：stdout 先行、认领在后——打印后认领前被杀 → 下次注入重放（at-least-once）
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { hostname as osHostname } from 'node:os'
import { agentIdFromEnv, parseEnvFile, matchAgentForCwd, AGENTS_DIR, SPOOL_ROOT } from './lib/identity.mjs'
import { unreadListMulti, unreadAll, claim, recentConsumed } from './lib/spool.mjs'
import { projectTopics, pushTopics } from './lib/topics.mjs'
import { formatInjection } from './lib/inject.mjs'

export async function runHook({ cwd, hostname = osHostname() }) {
  let entries = []
  try { entries = readdirSync(AGENTS_DIR).filter(f => f.endsWith('.env')).map(f => {
    try { return parseEnvFile(readFileSync(join(AGENTS_DIR, f), 'utf8')) } catch { return null }
  }).filter(Boolean) } catch { return null } // agents.d 不存在：no-op
  const e = matchAgentForCwd(entries, cwd)
  if (!e) return null
  const agentId = agentIdFromEnv(e, hostname)
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
  if (!msgs.length && !others.length) {
    // zhy UX 建议 2026-10-21：空收件箱但 24h 内有后台已处理 → 一次性提示（latest 作标记幂等，之后回归静默）
    const rc = recentConsumed(agentId)
    const markerPath = join(SPOOL_ROOT, agentId, 'hint-shown')
    let shown = 0
    try { shown = Number(readFileSync(markerPath, 'utf8')) || 0 } catch { /* 首次 */ }
    if (rc.count > 0 && rc.latest > shown) {
      try { mkdirSync(join(SPOOL_ROOT, agentId), { recursive: true }); writeFileSync(markerPath, String(rc.latest)) } catch { /* 只读环境不提示也不报错 */ }
      return { text: `ℹ 后台已处理 ${rc.count} 封（24h 内），未读已清空；用 im history 查看往来记录`, agentId, ids: [] }
    }
    return null
  }
  return { text, agentId, server: e.server, token: e.token, ids: msgs.map(m => [m.topic ?? '_default', m.id]) } // [topic, msgId] 对,未注入的信不认领
}

export async function claimIds(agentId, pairs, { server, token, fetchImpl = fetch } = {}) {
  // T4：ids 为 [topic, msgId] 对，逐对 claim；v3 §3(b)：claim 成功后异步补 POST /v1/messages/:id/read
  // —— 否则 spool 注入链路 read_at 永远为 null，REST 侧 unread 统计失真。失败静默不阻塞注入。
  const claimed = []
  for (const [topic, id] of pairs) { try { if (claim(agentId, topic, id)) claimed.push(id) } catch { /* ENOENT：并发输家，静默 */ } }
  if (server && token) for (const id of claimed)
    fetchImpl(`${server.replace(/\/$/, '')}/v1/messages/${id}/read`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
    }).catch(() => {}) // 慢/失败静默：注入优先，read 只是统计修正
}

if (process.argv[1] && process.argv[1].endsWith('hook-inject.mjs')) {
  let input = {}
  try { input = JSON.parse(readFileSync(0, 'utf8')) } catch {}
  const r = await runHook({ cwd: input.cwd ?? process.cwd() })
  if (r) {
    console.log(r.text)     // 先打印
    await claimIds(r.agentId, r.ids, { server: r.server, token: r.token }) // 后认领（含异步补 read）
  }
  // 无未读：空输出 exit 0，不污染 Claude Code
}
