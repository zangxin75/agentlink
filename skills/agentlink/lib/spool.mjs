// skills/agentlink/lib/spool.mjs — topic 布局版
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, unlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { SPOOL_ROOT } from './identity.mjs'

const exists = (p) => { try { statSync(p); return true } catch { return false } }
const PERM = { recursive: true, mode: 0o700 }
// topic 目录布局（spec §4.2）：spool/<agentId>/topics/<topic>/{*.json, consumed/}
export const spoolDir = (a, topic = '_default') => {
  const d = join(SPOOL_ROOT, a, 'topics', topic)
  mkdirSync(d, PERM); mkdirSync(join(d, 'consumed'), PERM)
  return d
}
const consumedDir = (a, topic) => join(SPOOL_ROOT, a, 'topics', topic, 'consumed')
const read1 = (p) => JSON.parse(readFileSync(p, 'utf8'))
// 遍历某 agent 全部 topic 名（目录名即 topic;无目录返回 [] 保持函数可调用）
export function topics(agentId) {
  const root = join(SPOOL_ROOT, agentId, 'topics')
  try { return readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) } catch { return [] }
}

export function writeMessage(agentId, msg) {
  const topic = msg.topic ?? '_default'
  const d = spoolDir(agentId, topic)
  const final = join(d, msg.id + '.json')
  if (exists(join(d, 'consumed', msg.id + '.json')) || exists(final)) return false // consumed 不复活(本 topic 目录内判定,RF2)
  const tmp = join(d, msg.id + '.tmp')
  writeFileSync(tmp, JSON.stringify({ ...msg, topic, received_at: Date.now() }), { mode: 0o600 })
  try { renameSync(tmp, final); return true } catch { unlinkSync(tmp); return false }
}
export function unreadList(agentId, topic = '_default') {
  const d = spoolDir(agentId, topic)
  return readdirSync(d).filter(f => f.endsWith('.json')).map(f => read1(join(d, f)))
    .sort((x, y) => (x.created_at ?? 0) - (y.created_at ?? 0))
}
export function unreadListMulti(agentId, list) {
  return list.flatMap(t => unreadList(agentId, t)).sort((x, y) => String(x.created_at ?? '').localeCompare(String(y.created_at ?? ''))) // ISO 字符串字典序=时间序(critic-L12:数值相减对 ISO 得 NaN)
}
export function unreadAll(agentId) {
  return topics(agentId).map(topic => ({ topic, msgs: unreadList(agentId, topic) })).filter(x => x.msgs.length)
}
export function claim(agentId, topic = '_default', msgId) {
  const d = spoolDir(agentId, topic)
  try { renameSync(join(d, msgId + '.json'), join(d, 'consumed', msgId + '.json')); return true } catch { return false }
}
export function maxCursor(agentId) {
  // 补洞游标跨 topic 全局取最大（RF3）：只看 pending+consumed 的文件名 id
  let ids = []
  for (const t of topics(agentId)) {
    const d = spoolDir(agentId, t)
    ids = [...ids, ...readdirSync(d), ...readdirSync(consumedDir(agentId, t))]
  }
  ids = ids.filter(f => f.endsWith('.json')).map(f => f.slice(0, -5))
  return ids.length ? ids.sort().at(-1) : null
}
export function cleanup(agentId, nowMs) {
  for (const t of topics(agentId)) for (const f of readdirSync(consumedDir(agentId, t))) {
    const p = join(consumedDir(agentId, t), f)
    if (nowMs - (read1(p).received_at ?? 0) > 7 * 86400_000) unlinkSync(p)
  }
}
export function clearTmp(agentId) {
  for (const t of topics(agentId)) for (const f of readdirSync(spoolDir(agentId, t))) if (f.endsWith('.tmp')) unlinkSync(join(spoolDir(agentId, t), f))
}
