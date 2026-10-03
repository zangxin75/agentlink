// 市场路由（spec §3）——本任务先挂 listings CRUD；bids/select/buy 在 T4+。
// db+bus tier 挂载；POST 前走日桶限流 checkMarketPublish。
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { authenticate, getAuth } from '../auth.js'
import { Errors } from '../errors.js'
import { acceptDeal, acceptServiceBid, buyService, cancelDeal, counterBid, createBid, createListing, decideBid, deliverDeal, deleteListing, getListing, listDeals, listListings, patchListing, selectBid, type ListingKind } from '../../core/market.js'
import type { Db } from '../../db/sqlite.js'
import type { Config } from '../../config.js'
import type { Bus } from '../../core/bus.js'
import type { RateLimiter } from '../../core/ratelimit.js'

// limit 查询参数数字校验（终审 Minor-3）：querystring 无 schema 时 Fastify 给原始字符串，NaN 落到 SQL 会 500
function parseLimit(raw: unknown): number | undefined {
  if (raw == null || raw === '') return undefined
  const n = Number(raw)
  if (!Number.isFinite(n)) throw Errors.invalidRequest('limit must be a number')
  return n
}

export function registerMarketRoutes(app: FastifyInstance, deps: { db: Db; cfg: Config; bus: Bus; limiter: RateLimiter }): void {
  const auth = authenticate(deps.db, deps.cfg)

  app.get('/v1/market/listings', { preHandler: auth }, async (req) => {
    const q = req.query as { kind?: ListingKind; tag?: string; q?: string; status?: string; cursor?: string; limit?: number }
    return listListings(deps.db, { kind: q.kind, tag: q.tag, text: q.q, status: q.status, cursor: q.cursor, limit: parseLimit(q.limit) })
  })

  app.post('/v1/market/listings', { preHandler: auth }, async (req) => {
    const me = getAuth(req).agent.id
    deps.limiter.checkMarketPublish(me)
    const b = req.body as Record<string, unknown>
    return createListing(deps.db, deps.cfg, me, {
      kind: b.kind as ListingKind, title: b.title as string, body: b.body as string,
      tags: b.tags as string[] | undefined, budget: b.budget as number | undefined,
      price: b.price as number | undefined, days: b.days as number | undefined,
    })
  })

  app.get('/v1/market/listings/:id', { preHandler: auth }, async (req) => {
    const { id } = req.params as { id: string }
    return getListing(deps.db, id)
  })

  // 仅 open 可改 title/body/tags；价格不可改（防钓鱼，spec §3）——价格字段出现即 400
  app.patch('/v1/market/listings/:id', { preHandler: auth }, async (req) => {
    const me = getAuth(req).agent.id
    const { id } = req.params as { id: string }
    const b = req.body as Record<string, unknown>
    if ('budget' in b || 'price' in b) throw Errors.invalidRequest('价格不可修改，改价=撤牌重挂')
    return patchListing(deps.db, id, me, { title: b.title as string | undefined, body: b.body as string | undefined, tags: b.tags as string[] | undefined })
  })

  app.delete('/v1/market/listings/:id', { preHandler: auth }, async (req, reply) => {
    const me = getAuth(req).agent.id
    const { id } = req.params as { id: string }
    const q = (req as FastifyRequest<{ Querystring: { force?: string } }>).query as { force?: string }
    const force = q.force === '1'
    if (force) {
      // admin 下架：x-admin-token 须与 cfg.adminToken 完全匹配（未配置即一律拒绝）
      const token = req.headers['x-admin-token']
      if (!deps.cfg.adminToken || token !== deps.cfg.adminToken) throw Errors.forbidden('invalid admin token')
      deleteListing(deps.db, deps.cfg, id, me, { adminForce: true })
    } else {
      deleteListing(deps.db, deps.cfg, id, me)
    }
    reply.status(200)
    // 报告 DB 实际最终状态：force 删 done/delivered 托管的挂牌不会变 canceled（终审 Minor-2）
    const row = deps.db.prepare('SELECT status FROM listings WHERE id=?').get(id) as { status: string } | undefined
    return { id, status: row?.status ?? 'canceled' }
  })

  // 投标（demand）——每 bid burn 1；议价不锁钱，成交时才结算（spec §2.1）
  app.post('/v1/market/listings/:id/bids', { preHandler: auth }, async (req) => {
    const me = getAuth(req).agent.id
    const { id } = req.params as { id: string }
    deps.limiter.checkMarketBid(me)
    const b = req.body as { points: number; body: string }
    return createBid(deps.db, deps.cfg, deps.bus, id, me, b)
  })

  app.post('/v1/market/bids/:id/counter', { preHandler: auth }, async (req) => {
    const me = getAuth(req).agent.id
    const { id } = req.params as { id: string }
    deps.limiter.checkMarketCounter(me)
    const b = req.body as { points: number; body: string }
    return counterBid(deps.db, deps.cfg, deps.bus, id, me, b)
  })

  // withdraw 仅 bid 主；reject 仅挂牌人（accept/select 在 T5）
  app.post('/v1/market/bids/:id/withdraw', { preHandler: auth }, async (req) => {
    const me = getAuth(req).agent.id
    const { id } = req.params as { id: string }
    return decideBid(deps.db, deps.bus, id, me, 'withdraw')
  })

  app.post('/v1/market/bids/:id/reject', { preHandler: auth }, async (req) => {
    const me = getAuth(req).agent.id
    const { id } = req.params as { id: string }
    return decideBid(deps.db, deps.bus, id, me, 'reject')
  })

  // ---- deals（spec §2.1/§2.2/§3）----

  // demand 选标：挂牌人选中一条 bid → deal(escrowed) + 派生 task
  app.post('/v1/market/listings/:id/select/:bid', { preHandler: auth }, async (req) => {
    const me = getAuth(req).agent.id
    const { id, bid } = req.params as { id: string; bid: string }
    return selectBid(deps.db, deps.cfg, deps.bus, id, bid, me)
  })

  // service 议价成交：挂牌人接受买家 bid
  app.post('/v1/market/bids/:id/accept', { preHandler: auth }, async (req) => {
    const me = getAuth(req).agent.id
    const { id } = req.params as { id: string }
    return acceptServiceBid(deps.db, deps.cfg, deps.bus, id, me)
  })

  // service 直购：冻结 price → deal(escrowed)；listing 保持 open
  app.post('/v1/market/listings/:id/buy', { preHandler: auth }, async (req) => {
    const me = getAuth(req).agent.id
    const { id } = req.params as { id: string }
    return buyService(deps.db, deps.cfg, deps.bus, id, me)
  })

  app.get('/v1/market/deals', { preHandler: auth }, async (req) => {
    const me = getAuth(req).agent.id
    const q = req.query as { role?: 'buyer' | 'seller'; cursor?: string; limit?: number }
    return listDeals(deps.db, me, { role: q.role, cursor: q.cursor, limit: parseLimit(q.limit) })
  })

  app.post('/v1/market/deals/:id/deliver', { preHandler: auth }, async (req) => {
    const me = getAuth(req).agent.id
    const { id } = req.params as { id: string }
    const b = (req.body ?? {}) as { note?: string }
    return deliverDeal(deps.db, deps.cfg, deps.bus, id, me, b.note)
  })

  app.post('/v1/market/deals/:id/accept', { preHandler: auth }, async (req) => {
    const me = getAuth(req).agent.id
    const { id } = req.params as { id: string }
    return acceptDeal(deps.db, deps.cfg, deps.bus, id, me)
  })

  app.post('/v1/market/deals/:id/cancel', { preHandler: auth }, async (req) => {
    const me = getAuth(req).agent.id
    const { id } = req.params as { id: string }
    return cancelDeal(deps.db, deps.cfg, deps.bus, id, me)
  })
}
