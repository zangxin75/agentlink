import type { FastifyInstance } from 'fastify'
import { authenticate } from '../auth.js'
import { presenceOf } from '../../core/presence.js'
import type { Db } from '../../db/sqlite.js'; import type { Config } from '../../config.js'

export function registerPresenceRoutes(app: FastifyInstance, deps: { db: Db; cfg: Config; connectedAgents?: () => Set<string> }): void {
  const auth = authenticate(deps.db, deps.cfg)
  app.get('/v1/presence', { preHandler: auth }, async (req) => {
    const ids = String((req.query as any).ids ?? '').split(',').filter(Boolean)
    return presenceOf(deps.db, deps.connectedAgents?.() ?? new Set(), ids, deps.cfg.presenceWindowMs)
  })
}
