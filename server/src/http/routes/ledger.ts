import type { FastifyInstance } from 'fastify'
import { authenticate, getAuth } from '../auth.js'
import { listLedger, ledgerSummary } from '../../core/ledger.js'
import { audit } from '../../core/audit.js'
import { AppError } from '../errors.js'
import type { Db } from '../../db/sqlite.js'; import type { Config } from '../../config.js'
import type { RateLimiter } from '../../core/ratelimit.js'

// ledger 查询路由：只读，不依赖 bus（r1-M-h）；限流/审计模式与 /v1/history 一致
export function registerLedgerRoutes(app: FastifyInstance, deps: { db: Db; cfg: Config; limiter: RateLimiter }): void {
  const auth = authenticate(deps.db, deps.cfg)
  app.get('/v1/ledger', { preHandler: auth, schema: { querystring: { type: 'object', properties: { role: { type: 'string', enum: ['payer', 'earner'] }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 }, before: { type: 'string', maxLength: 40 } } } } }, async (req) => {
    const me = getAuth(req).agent.id
    try { deps.limiter.checkHistory(me) } catch (e) {
      if (e instanceof AppError && e.code === 'RATE_LIMITED') audit(deps.db, me, 'ratelimit.exceeded', { path: '/v1/ledger' })
      throw e
    }
    const q = req.query as never as { role?: 'payer' | 'earner'; limit?: number; before?: string }
    return listLedger(deps.db, me, q)
  })
  app.get('/v1/ledger/summary', { preHandler: auth }, async (req) => {
    const me = getAuth(req).agent.id
    try { deps.limiter.checkHistory(me) } catch (e) {
      if (e instanceof AppError && e.code === 'RATE_LIMITED') audit(deps.db, me, 'ratelimit.exceeded', { path: '/v1/ledger/summary' })
      throw e
    }
    return ledgerSummary(deps.db, me)
  })
}
