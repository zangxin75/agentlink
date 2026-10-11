// credits 路由（spec §3）：账户（GET 即自动领 faucet）、转账、账本游标分页、池余额。
// 只依赖 db（db tier），不依赖 bus；限流沿用 history 桶查 ledger。
import type { FastifyInstance } from 'fastify'
import { authenticate, getAuth } from '../auth.js'
import { AppError, Errors } from '../errors.js'
import { claimFaucet, getOrCreateAccount, available, transferPoints } from '../../core/credits.js'
import type { Db } from '../../db/sqlite.js'; import type { Config } from '../../config.js'
import type { RateLimiter } from '../../core/ratelimit.js'

export function registerCreditsRoutes(app: FastifyInstance, deps: { db: Db; cfg: Config; limiter: RateLimiter }): void {
  const auth = authenticate(deps.db, deps.cfg)

  // GET 即自动 claimFaucet（UTC 日期幂等）；acceptedDeals 取已成交（accepted）单数算 bonus
  app.get('/v1/credits/account', { preHandler: auth }, async (req) => {
    const me = getAuth(req).agent.id
    const accepted = (deps.db.prepare(`SELECT COUNT(*) c FROM deals WHERE seller = ? AND status = 'accepted'`).get(me) as { c: number }).c
    const faucet = claimFaucet(deps.db, deps.cfg, me, accepted)
    const a = getOrCreateAccount(deps.db, me, deps.cfg)
    return {
      agent_id: me, permanent: a.permanent, expiring: a.expiring, expiring_expires_at: a.expiring_expires_at,
      locked: a.locked, available: available(a),
      faucet: { date: a.last_faucet_date, granted: faucet.granted, bonus: faucet.bonus },
    }
  })

  app.post('/v1/credits/transfer', {
    preHandler: auth,
    schema: { body: { type: 'object', required: ['to', 'points'], properties: { to: { type: 'string', minLength: 3, maxLength: 32 }, points: { type: 'integer', minimum: 1 }, note: { type: 'string', maxLength: 200 } } } },
  }, async (req) => {
    const me = getAuth(req).agent.id
    const { to, points, note } = req.body as { to: string; points: number; note?: string }
    if (to === me) throw Errors.unprocessable('SELF_DEAL', 'cannot transfer to self')
    if (points > deps.cfg.market.maxPointsPerTx) throw Errors.unprocessable('PRICE_INVALID', 'points out of range')
    if (!deps.db.prepare('SELECT id FROM agents WHERE id = ?').get(to)) throw new AppError('AGENT_NOT_FOUND', 404, 'agent not found')
    transferPoints(deps.db, deps.cfg, me, to, points, note) // INSUFFICIENT_CREDITS 等核心错误原样抛
    const fee = Math.ceil(points * deps.cfg.market.transferFeePct / 100)
    return { from: me, to, points, fee, burned: fee * 2 }
  })

  app.get('/v1/credits/ledger', {
    preHandler: auth,
    schema: { querystring: { type: 'object', properties: { cursor: { type: 'string', maxLength: 40 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 } } } },
  }, async (req) => {
    const me = getAuth(req).agent.id
    deps.limiter.checkHistory(me)
    const q = req.query as { cursor?: string; limit?: number }
    const limit = q.limit ?? 50
    const rows = q.cursor
      ? deps.db.prepare('SELECT * FROM credit_ledger WHERE agent_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(me, q.cursor, limit + 1)
      : deps.db.prepare('SELECT * FROM credit_ledger WHERE agent_id = ? ORDER BY id DESC LIMIT ?').all(me, limit + 1)
    const items = (rows as unknown[]).slice(0, limit) as Record<string, unknown>[]
    const next_cursor = rows.length > limit ? (items[items.length - 1] as { id: string }).id : null
    return { items, next_cursor }
  })

  // 池余额：Ruling——保持与其他端点一致，需认证（db tier）
  app.get('/v1/market/pool', { preHandler: auth }, async () => {
    const pool = deps.db.prepare('SELECT balance FROM credit_pool WHERE id = 1').get() as { balance: number }
    return { balance: pool.balance }
  })
}
