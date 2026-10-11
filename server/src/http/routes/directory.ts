import type { FastifyInstance } from 'fastify'
import { authenticate } from '../auth.js'
import { searchAgents, getAgent } from '../../core/agents.js'
import { activeTopics } from '../../core/topics.js'
import { reputationOf, emptyReputation } from '../../core/reputation.js'
import type { Db } from '../../db/sqlite.js'; import type { Config } from '../../config.js'

export function registerDirectoryRoutes(app: FastifyInstance, deps: { db: Db; cfg: Config; connectedAgents?: () => Set<string> }): void {
  const auth = authenticate(deps.db, deps.cfg)
  const state = (a: { id: string; last_seen_at: string }) =>
    (deps.connectedAgents?.().has(a.id) || Date.now() - Date.parse(a.last_seen_at) < deps.cfg.presenceWindowMs) ? 'online' : 'offline'
  const busy = (id: string) => !!deps.db.prepare(`SELECT 1 FROM tasks WHERE executor=? AND status='RUNNING' LIMIT 1`).get(id)
  app.get('/v1/agents', { preHandler: auth }, async (req) => {
    const q = req.query as never as { q?: string; capability?: string; online?: string }
    // querystring 无 schema，Fastify 给的是原始字符串：'false' 为真值会误过滤。仅 'true' 触发在线过滤（终审 Minor-4）
    // 声誉走批量聚合（单条 GROUP BY），避免每个 agent 一查的 N+1
    const agents = searchAgents(deps.db, { q: q.q, capability: q.capability, online: q.online === 'true' }, deps.connectedAgents?.() ?? new Set(), deps.cfg.presenceWindowMs)
    const rep = reputationOf(deps.db, agents.map(a => a.id))
    // 列表投影（spec §3.2）：headline + skills 名单 + profile_updated_at，不含完整 profile（省带宽，检索方按需单查）
    return agents.map(a => ({ agent: { ...a, profile: a.profile ? { headline: a.profile.headline, skills: (a.profile.skills ?? []).map((s: any) => s.name), profile_updated_at: a.profile_updated_at } : {} }, presence: { state: state(a), busy: busy(a.id), last_seen_at: a.last_seen_at }, reputation: rep.get(a.id) ?? emptyReputation() }))
  })
  app.get('/v1/agents/:id', { preHandler: auth }, async (req) => {
    const a = getAgent(deps.db, (req.params as any).id)
    const rep = reputationOf(deps.db, [a.id])
    return { agent: a, presence: { state: state(a), busy: busy(a.id), last_seen_at: a.last_seen_at }, reputation: rep.get(a.id) ?? emptyReputation() }
  })
  // 对端活跃 topic 查询（spec §2/§3）：发送方 CLI 决策输入；目录级公开信息
  app.get('/v1/agents/:id/topics', { preHandler: auth }, async (req) => {
    getAgent(deps.db, (req.params as any).id) // 404 if unknown
    return { topics: activeTopics(deps.db, (req.params as any).id) }
  })
}
