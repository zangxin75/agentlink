import type { FastifyInstance } from 'fastify'
import { authenticate, getAuth } from '../auth.js'
import { getInbox, ackMessages, markRead, unreadCounts, receipts, history } from '../../core/messages.js'
import { getAgent } from '../../core/agents.js'
import { audit } from '../../core/audit.js'
import { AppError } from '../errors.js'
import type { Db } from '../../db/sqlite.js'; import type { Config } from '../../config.js'
import type { Bus } from '../../core/bus.js'; import type { RateLimiter } from '../../core/ratelimit.js'

export function registerInboxRoutes(app: FastifyInstance, deps: { db: Db; cfg: Config; bus: Bus; limiter: RateLimiter }): void {
  const auth = authenticate(deps.db, deps.cfg)
  app.get('/v1/inbox', { preHandler: auth, schema: { querystring: { type: 'object', properties: { wait: { type: 'integer', minimum: 0, maximum: 30, default: 25 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 }, thread_id: { type: 'string', maxLength: 64 }, topic: { type: 'string', maxLength: 32 } } } } }, async (req) => {
    const me = getAuth(req).agent.id
    const { wait, limit } = req.query as never as { wait: number; limit: number; thread_id?: string; topic?: string }
    const deadline = Date.now() + wait * 1000
    for (;;) {
      const rows = getInbox(deps.db, me, limit, (req.query as any).thread_id, (req.query as any).topic)
      if (rows.length || Date.now() >= deadline) return rows
      await deps.bus.waitFor(me, ['new-message'], Math.min(500, deadline - Date.now()))
    }
  })
  app.post('/v1/messages/ack', { preHandler: auth, schema: { body: { type: 'object', required: ['ids'], properties: { ids: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' } } } } } }, async (req) => {
    return ackMessages(deps.db, deps.bus, getAuth(req).agent.id, (req.body as any).ids)
  })
  app.get('/v1/messages/receipts', { preHandler: auth }, async (req) => {
    const ids = String((req.query as any).ids ?? '').split(',').filter(Boolean)
    return receipts(deps.db, getAuth(req).agent.id, ids)
  })
  app.post('/v1/messages/:id/read', { preHandler: auth }, async (req, reply) => {
    markRead(deps.db, deps.bus, getAuth(req).agent.id, (req.params as any).id)
    return reply.status(204).send()
  })
  app.get('/v1/unread', { preHandler: auth }, async (req) => unreadCounts(deps.db, getAuth(req).agent.id))
  app.get('/v1/history', { preHandler: auth, schema: { querystring: { type: 'object', properties: { peer: { type: 'string', maxLength: 32 }, thread_id: { type: 'string', maxLength: 64 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 }, before: { type: 'string', maxLength: 40 }, after: { type: 'string', maxLength: 40 }, topic: { type: 'string', maxLength: 32 } } } } }, async (req) => {
    const me = getAuth(req).agent.id
    try { deps.limiter.checkHistory(me) } catch (e) {
      if (e instanceof AppError && e.code === 'RATE_LIMITED') audit(deps.db, me, 'ratelimit.exceeded', { path: '/v1/history' })
      throw e
    }
    const q = req.query as never as { peer?: string; thread_id?: string; topic?: string; before?: string; after?: string; limit?: number }
    if (q.peer) getAgent(deps.db, q.peer) // peer 出现时保留 v1 存在性校验（r2-R2-3）
    return history(deps.db, me, { ...q, limit: q.limit ?? 50 })
  })
}
