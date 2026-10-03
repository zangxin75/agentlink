// 账号 topic 注册表（spec §2）：会话上报活跃 topic，TTL 25h；发送方查询辅助决策
import type { Db } from '../db/sqlite.js'
import { TOPIC_RE } from './messages.js'
import { Errors } from '../http/errors.js'

const TTL_MS = 25 * 3600_000

export function upsertTopics(db: Db, agentId: string, topics: string[]): void {
  if (topics.length > 8) throw Errors.invalidRequest('topics 最多 8 项')
  const seen = new Set<string>()
  for (const t of topics) {
    if (!TOPIC_RE.test(t) || t === '_default') throw Errors.invalidRequest(`非法 topic: ${t}（小写 [a-z0-9._-] ≤32，_default 保留）`)
    if (seen.has(t)) throw Errors.invalidRequest(`topic 重复: ${t}`)
    seen.add(t)
  }
  const now = new Date(); const iso = now.toISOString()
  const exp = new Date(now.getTime() + TTL_MS).toISOString()
  const stmt = db.prepare(`INSERT INTO agent_topics (agent_id, topic, refreshed_at, expires_at) VALUES (?,?,?,?)
    ON CONFLICT(agent_id, topic) DO UPDATE SET refreshed_at=excluded.refreshed_at, expires_at=excluded.expires_at`)
  db.transaction(() => { for (const t of topics) stmt.run(agentId, t, iso, exp) })()
}

export function activeTopics(db: Db, agentId: string): { topic: string; refreshed_at: string }[] {
  db.prepare('DELETE FROM agent_topics WHERE expires_at < ?').run(new Date().toISOString()) // 惰性清理
  return db.prepare('SELECT topic, refreshed_at FROM agent_topics WHERE agent_id=? ORDER BY topic').all(agentId) as never
}

export function topicRegistered(db: Db, agentId: string, topic: string): boolean {
  if (topic === '_default') return true
  return !!db.prepare('SELECT 1 FROM agent_topics WHERE agent_id=? AND topic=? AND expires_at > ?').get(agentId, topic, new Date().toISOString())
}
