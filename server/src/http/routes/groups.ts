import type { FastifyInstance } from 'fastify'
import { authenticate, getAuth } from '../auth.js'
import { getAgent } from '../../core/agents.js'
import { Errors } from '../errors.js'
import { createGroup, listGroupsFor, renameGroup, addMember, removeMember, dissolveGroup, visibleTo, groupTimeline } from '../../core/groups.js'
import { sendGroupMessage } from '../../core/group-send.js'
import type { Db } from '../../db/sqlite.js'; import type { Config } from '../../config.js'
import type { Bus } from '../../core/bus.js'; import type { RateLimiter } from '../../core/ratelimit.js'

export function registerGroupRoutes(app: FastifyInstance, deps: { db: Db; cfg: Config; bus: Bus; limiter: RateLimiter }): void {
  const auth = authenticate(deps.db, deps.cfg)
  const requireHuman = (req: any) => { if (getAuth(req).agent.role !== 'human') throw Errors.forbidden('human only') }

  app.post('/v1/groups', { preHandler: auth }, async (req, reply) => {
    requireHuman(req)
    const me = getAuth(req).agent.id
    const { id } = createGroup(deps.db, me, req.body as { name: string; members: string[] })
    return reply.status(201).send({ id })
  })
  app.get('/v1/groups', { preHandler: auth }, async (req) => {
    requireHuman(req)
    return { groups: listGroupsFor(deps.db, getAuth(req).agent.id) }
  })
  app.patch('/v1/groups/:id', { preHandler: auth }, async (req, reply) => {
    requireHuman(req); renameGroup(deps.db, getAuth(req).agent.id, (req.params as any).id, (req.body as any).name); return reply.status(204).send()
  })
  app.post('/v1/groups/:id/members', { preHandler: auth }, async (req, reply) => {
    requireHuman(req); addMember(deps.db, getAuth(req).agent.id, (req.params as any).id, (req.body as any).agent_id); return reply.status(204).send()
  })
  app.delete('/v1/groups/:id/members/:agentId', { preHandler: auth }, async (req, reply) => {
    requireHuman(req); const p = req.params as any; removeMember(deps.db, getAuth(req).agent.id, p.id, p.agentId); return reply.status(204).send()
  })
  app.delete('/v1/groups/:id', { preHandler: auth }, async (req, reply) => {
    requireHuman(req); dissolveGroup(deps.db, getAuth(req).agent.id, (req.params as any).id); return reply.status(204).send()
  })
  app.post('/v1/groups/:id/messages', { preHandler: auth }, async (req, reply) => {
    const me = getAuth(req).agent.id
    deps.limiter.checkMessage(me) // 群发按 1 条预算（spec §6）
    const out = sendGroupMessage(deps.db, deps.bus, me, { ...(req.body as any), to: (req.params as any).id }) // to 在后兜底：body 里的 to 不可覆盖路径参数（r1-Minor1）
    return reply.status(out.deduplicated ? 200 : 201).send(out)
  })
  app.get('/v1/groups/:id/messages', { preHandler: auth }, async (req) => {
    const me = getAuth(req).agent.id; const id = (req.params as any).id
    if (!visibleTo(deps.db, id, me)) throw Errors.forbidden('group not visible')
    deps.limiter.checkHistory(me) // 与 DM history 同一预算（终审 Important-1）
    const q = req.query as any
    const lim = Number(q.limit) // 非法/非正值回退 50：负数直传 SQLite 是 LIMIT -1 = 无限行（终审 Important-1）
    return groupTimeline(deps.db, id, { after: q.after, limit: !lim || lim < 1 ? 50 : Math.min(lim, 200) })
  })
}
