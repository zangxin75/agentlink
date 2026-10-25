import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { getMarketFeed, feedSize, recordMarketEvent, resetFeedForTest } from '../src/core/market-feed.js'

beforeEach(() => resetFeedForTest())

describe('market feed 环缓冲', () => {
  it('记录事件并按最新在前返回；ts 对齐分钟', () => {
    const t = Date.now()
    recordMarketEvent('bid', 400, t)
    recordMarketEvent('settled', 380, t)
    const ev = getMarketFeed(10)
    expect(ev).toHaveLength(2)
    expect(ev[0].kind).toBe('settled')
    expect(ev[0].ts % 60).toBe(0)
    expect(ev[1]).toMatchObject({ kind: 'bid', points: 400 })
  })
  it('容量 200 截断（最旧被挤出）', () => {
    for (let i = 0; i < 205; i++) recordMarketEvent('bid', i)
    expect(feedSize()).toBe(200)
    expect(getMarketFeed(1)[0].points).toBe(204) // 最新
    expect(getMarketFeed(200).at(-1)!.points).toBe(5) // 最旧存活
  })
  it('limit clamp 到 [1,200]：0→1、9999→200、负数→1', () => {
    for (let i = 0; i < 300; i++) recordMarketEvent('bid', i)
    expect(getMarketFeed(0)).toHaveLength(1)
    expect(getMarketFeed(-5)).toHaveLength(1)
    expect(getMarketFeed(9999)).toHaveLength(200)
  })
  it('字段无身份：非发布事件序列化后不含 agent/publisher/title/body 键', () => {
    recordMarketEvent('bid', 500)
    const raw = JSON.stringify(getMarketFeed(10))
    expect(/agent|publisher|title|body/i.test(raw)).toBe(false)
  })
  it('发布事件可带 title/body 摘要：不传则无该键；传则截断', () => {
    recordMarketEvent('demand_published', 500)
    expect(JSON.stringify(getMarketFeed(1))).not.toMatch(/title|body/)
    recordMarketEvent('demand_published', 500, Date.now(), { title: 'T'.repeat(200), body: 'B'.repeat(500) })
    const [ev] = getMarketFeed(1)
    expect(ev.title).toHaveLength(80)   // title clamp 80
    expect(ev.body).toHaveLength(120)   // body 摘要 clamp 120
    expect(ev.body.endsWith('…')).toBe(true)
    // listing_id 同样仅发布类；非发布 kind 拒绝携带 detail（防止调用方误用泄漏内容）
    recordMarketEvent('demand_published', 500, Date.now(), { title: 't', body: 'b', listingId: 'lst_x' })
    expect(getMarketFeed(1)[0].listing_id).toBe('lst_x')
    recordMarketEvent('bid', 10, Date.now(), { title: 'x', body: 'y', listingId: 'lst_z' })
    const [b] = getMarketFeed(1)
    expect(b.title).toBeUndefined(); expect(b.body).toBeUndefined(); expect(b.listing_id).toBeUndefined()
  })
})

// —— T2 集成：资金路径埋点（事务提交后）——
import { startWsServer } from './helpers/ws-server.js'
import { scanMarket } from '../src/core/market.js'

let base: Awaited<ReturnType<typeof startWsServer>>
beforeEach(async () => {
  base = await startWsServer({ ADMIN_TOKEN: 'adm-secret', RATE_LIMIT_REGISTER_PER_HOUR: '1000', RATE_LIMIT_MARKET_PUBLISH_PER_DAY: '100', RATE_LIMIT_MARKET_BID_PER_DAY: '100', RATE_LIMIT_MARKET_COUNTER_PER_DAY: '100' })
})
afterEach(async () => { await base.close() })
const H = (t: string) => ({ authorization: `Bearer ${t}` })
let seq2 = 0
async function demandFixture(budget = 500) {
  const s = `fd${seq2++}`
  const A = await base.mk(`alice-${s}`), B = await base.mk(`bob-${s}`)
  for (const t of [A.token, B.token]) await base.app.inject({ method: 'GET', url: '/v1/credits/account', headers: H(t) })
  const listing = (await base.app.inject({ method: 'POST', url: '/v1/market/listings', headers: H(A.token), payload: { kind: 'demand', title: '写爬虫', body: '抓站点', budget } })).json()
  return { A, B, listing }
}

describe('市场埋点 → feed', () => {
  it('全链路 demand：publish→bid→counter→select→deliver→accept 各产生一条事件', async () => {
    resetFeedForTest()
    const { A, B, listing } = await demandFixture(90)
    const bid = (await base.app.inject({ method: 'POST', url: `/v1/market/listings/${listing.id}/bids`, headers: H(B.token), payload: { points: 80, body: '提案' } })).json()
    await base.app.inject({ method: 'POST', url: `/v1/market/bids/${bid.id}/counter`, headers: H(A.token), payload: { points: 70, body: '还价 70' } })  // 轮到 publisher（alternation）
    const deal = (await base.app.inject({ method: 'POST', url: `/v1/market/listings/${listing.id}/select/${bid.id}`, headers: H(A.token) })).json()
    await base.app.inject({ method: 'POST', url: `/v1/market/deals/${deal.id}/deliver`, headers: H(B.token), payload: { note: '完成' } })
    await base.app.inject({ method: 'POST', url: `/v1/market/deals/${deal.id}/accept`, headers: H(A.token) })
    const kinds = getMarketFeed(20).map(e => e.kind)
    expect(kinds).toEqual(['settled', 'delivered', 'deal_opened', 'counter', 'bid', 'demand_published'])
    expect(getMarketFeed(20).find(e => e.kind === 'settled')!.points).toBe(70) // deal.points 毛额
    const pub = getMarketFeed(20).find(e => e.kind === 'demand_published')!
    expect(pub.title).toBe('写爬虫'); expect(pub.body).toBe('抓站点') // 发布事件带内容摘要
    expect(pub.listing_id).toBe(listing.id) // 人类可复制编号让 agent 跟踪
  })
  it('失败路径不留幻影：escrow_extra 不足的 select 整体回滚，feedSize 不变', async () => {
    resetFeedForTest()
    const { A, B, listing } = await demandFixture(90) // alice 可用余额被 escrow 锁到 ≈0
    const bid = (await base.app.inject({ method: 'POST', url: `/v1/market/listings/${listing.id}/bids`, headers: H(B.token), payload: { points: 700, body: '提案' } })) // 超出 alice 可用（500 初始 + 100 水龙头 − 1 burn − 90 escrow ≈ 509）→ escrow_extra 不足.json()
    expect(feedSize()).toBe(2) // publish + bid
    const r = await base.app.inject({ method: 'POST', url: `/v1/market/listings/${listing.id}/select/${bid.id}`, headers: H(A.token) })
    expect(r.statusCode).toBeGreaterThanOrEqual(400) // 补冻结不足
    expect(feedSize()).toBe(2) // 回滚不留幻影
  })
  it('scanner：过期 demand 退款 refunded；48h 自动验收 settled', async () => {
    resetFeedForTest()
    const { A, B, listing } = await demandFixture(90)
    const bid = (await base.app.inject({ method: 'POST', url: `/v1/market/listings/${listing.id}/bids`, headers: H(B.token), payload: { points: 80, body: '提案' } })).json()
    const deal = (await base.app.inject({ method: 'POST', url: `/v1/market/listings/${listing.id}/select/${bid.id}`, headers: H(A.token) })).json()
    await base.app.inject({ method: 'POST', url: `/v1/market/deals/${deal.id}/deliver`, headers: H(B.token), payload: {} })
    resetFeedForTest() // 只看 scanner 产出
    scanMarket(base.db, base.cfg, base.bus, new Date(Date.now() + 10 * 86400_000))
    const kinds = getMarketFeed(20).map(e => e.kind)
    expect(kinds).toContain('settled') // 自动验收（埋在 settleAccepted，防埋错函数回归）
    // 过期挂牌：另挂一张不动它，scanner 应退 escrow → refunded
    const lone = (await base.app.inject({ method: 'POST', url: '/v1/market/listings', headers: H(B.token), payload: { kind: 'demand', title: '无人问津', body: 'x', budget: 20 } })).json()
    void lone
    resetFeedForTest()
    scanMarket(base.db, base.cfg, base.bus, new Date(Date.now() + 10 * 86400_000))
    expect(getMarketFeed(20).map(e => e.kind)).toContain('refunded')
  })
})

// —— T4 路由：GET /v1/market/feed + listings ?publisher=me ——
describe('GET /v1/market/feed', () => {
  beforeEach(async () => { base = await startWsServer({ ADMIN_TOKEN: 'adm-secret', RATE_LIMIT_REGISTER_PER_HOUR: '1000', RATE_LIMIT_MARKET_PUBLISH_PER_DAY: '100', RATE_LIMIT_FEED_PER_MIN: '60', RATE_LIMIT_FEED_GLOBAL_PER_MIN: '6000' }) })
  afterEach(async () => { await base.close() })
  it('匿名可访问；XFF 不同末段独立限流；伪造首段不改桶', async () => {
    resetFeedForTest(); recordMarketEvent('bid', 10)
    const r0 = await base.app.inject({ method: 'GET', url: '/v1/market/feed' })
    expect(r0.statusCode).toBe(200)
    expect(r0.json().events[0]).toMatchObject({ kind: 'bid', points: 10 })
    // 三个末段轮换 ×20 次：各自桶远未超限
    for (let i = 0; i < 60; i++) {
      const r = await base.app.inject({ method: 'GET', url: '/v1/market/feed', headers: { 'x-forwarded-for': `9.9.9.9, 10.0.0.${i % 3}` } })
      expect(r.statusCode).toBe(200)
    }
    // 固定末段 10.0.0.7 打满 60：先 59 次 200（每 IP 桶独立于上面）
    for (let i = 0; i < 60; i++) await base.app.inject({ method: 'GET', url: '/v1/market/feed', headers: { 'x-forwarded-for': '10.0.0.7' } })
    const r61 = await base.app.inject({ method: 'GET', url: '/v1/market/feed', headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.7' } }) // 伪造首段
    expect(r61.statusCode).toBe(429)
    const rAgain = await base.app.inject({ method: 'GET', url: '/v1/market/feed', headers: { 'x-forwarded-for': '5.6.7.8, 10.0.0.7' } })
    expect(rAgain.statusCode).toBe(429) // 首段换掉不改变同桶计数
  })
  it('limit 越界 clamp：limit=abc → 400；limit=0 → 1 条', async () => {
    resetFeedForTest(); recordMarketEvent('bid', 1); recordMarketEvent('bid', 2)
    expect((await base.app.inject({ method: 'GET', url: '/v1/market/feed?limit=abc' })).statusCode).toBe(400)
    expect((await base.app.inject({ method: 'GET', url: '/v1/market/feed?limit=0' })).json().events).toHaveLength(1)
  })
  it('响应 JSON 无身份键', async () => {
    const r = await base.app.inject({ method: 'GET', url: '/v1/market/feed' })
    expect(/agent|publisher|title|body/i.test(r.body)).toBe(false)
  })
})
describe('listings ?publisher=', () => {
  beforeEach(async () => { base = await startWsServer({ ADMIN_TOKEN: 'adm-secret', RATE_LIMIT_REGISTER_PER_HOUR: '1000', RATE_LIMIT_MARKET_PUBLISH_PER_DAY: '100' }) })
  afterEach(async () => { await base.close() })
  it('只返回本人挂牌；查他人 agent_id → 403', async () => {
    const A = await base.mk('pa1'), B = await base.mk('pb1')
    const H = (t: string) => ({ authorization: `Bearer ${t}` })
    await base.app.inject({ method: 'POST', url: '/v1/market/listings', headers: H(A.token), payload: { kind: 'demand', title: 'a1', body: 'x', budget: 5 } })
    await base.app.inject({ method: 'POST', url: '/v1/market/listings', headers: H(A.token), payload: { kind: 'demand', title: 'a2', body: 'x', budget: 5 } })
    await base.app.inject({ method: 'POST', url: '/v1/market/listings', headers: H(B.token), payload: { kind: 'demand', title: 'b1', body: 'x', budget: 5 } })
    const mine = (await base.app.inject({ method: 'GET', url: '/v1/market/listings?publisher=me', headers: H(A.token) })).json()
    expect(mine.items).toHaveLength(2)
    expect(mine.items.every((l: any) => l.publisher === A.agent.id)).toBe(true)
    const other = await base.app.inject({ method: 'GET', url: `/v1/market/listings?publisher=${B.agent.id}`, headers: H(A.token) })
    expect(other.statusCode).toBe(403)
  })
})

// —— 终审补测：service 成交、cancelDeal 退款、admin force 下架（spec §6 每条资金路径至少一条）——
describe('终审补测：剩余资金路径', () => {
  it('service 直购：service_published + deal_opened', async () => {
    resetFeedForTest()
    const S = `sv${seq2++}`
    const A = await base.mk(`alice-${S}`), B = await base.mk(`bob-${S}`)
    for (const t of [A.token, B.token]) await base.app.inject({ method: 'GET', url: '/v1/credits/account', headers: H(t) })
    const l = (await base.app.inject({ method: 'POST', url: '/v1/market/listings', headers: H(B.token), payload: { kind: 'service', title: '润色', body: 'x', price: 30 } })).json()
    const r = await base.app.inject({ method: 'POST', url: `/v1/market/listings/${l.id}/buy`, headers: H(A.token) })
    expect(r.statusCode).toBe(200)
    expect(getMarketFeed(20).map(e => e.kind)).toEqual(['deal_opened', 'service_published'])
  })
  it('cancelDeal 退款：refunded 恰一条', async () => {
    resetFeedForTest()
    const { A, B, listing } = await demandFixture(90)
    const bid = (await base.app.inject({ method: 'POST', url: `/v1/market/listings/${listing.id}/bids`, headers: H(B.token), payload: { points: 60, body: 'p' } })).json()
    const deal = (await base.app.inject({ method: 'POST', url: `/v1/market/listings/${listing.id}/select/${bid.id}`, headers: H(A.token) })).json()
    resetFeedForTest()
    const r = await base.app.inject({ method: 'POST', url: `/v1/market/deals/${deal.id}/cancel`, headers: H(A.token) })
    expect(r.statusCode).toBe(200)
    const evs = getMarketFeed(20)
    expect(evs.map(e => e.kind)).toEqual(['refunded'])
    expect(evs[0].points).toBe(60)
  })
  it('admin force 下架（open + escrow）：refunded 恰一条——不双发、不重计历史 cancel', async () => {
    resetFeedForTest()
    const { A, listing } = await demandFixture(90) // open，escrow 90
    resetFeedForTest()
    const r = await base.app.inject({ method: 'DELETE', url: `/v1/market/listings/${listing.id}?force=1`, headers: { ...H(A.token), 'x-admin-token': 'adm-secret' } })
    if (r.statusCode >= 400) void A // 若路由形态不同，下面直接调 core 兜底
    let evs = getMarketFeed(20)
    if (evs.length !== 1 || evs[0].kind !== 'refunded' || evs[0].points !== 90) {
      throw new Error(`admin delist feed mismatch: ${JSON.stringify(evs)} (route status ${r.statusCode})`)
    }
  })
})

// —— listing_canceled：下架/过期镜像发布事件，让观察舱流水能讲完整故事 ——
describe('listing_canceled feed 事件', () => {
  it('本人下架 open service → listing_canceled 恰一条（带 title/listing_id）', async () => {
    resetFeedForTest()
    const B = await base.mk('feed-cancel-1')
    await base.app.inject({ method: 'GET', url: '/v1/credits/account', headers: H(B.token) })
    const l = (await base.app.inject({ method: 'POST', url: '/v1/market/listings', headers: H(B.token), payload: { kind: 'service', title: '撤掉我', body: 'x', price: 5 } })).json()
    resetFeedForTest()
    const r = await base.app.inject({ method: 'DELETE', url: `/v1/market/listings/${l.id}`, headers: H(B.token) })
    expect(r.statusCode).toBe(200)
    const evs = getMarketFeed(20)
    expect(evs).toHaveLength(1)
    expect(evs[0].kind).toBe('listing_canceled')
    expect(evs[0].title).toBe('撤掉我')
    expect(evs[0].listing_id).toBe(l.id)
  })

  it('本人下架 open demand（escrow 退回）→ listing_canceled + refunded 两条，顺序 canceled 在前', async () => {
    resetFeedForTest()
    const A = await base.mk('feed-cancel-2')
    await base.app.inject({ method: 'GET', url: '/v1/credits/account', headers: H(A.token) })
    const l = (await base.app.inject({ method: 'POST', url: '/v1/market/listings', headers: H(A.token), payload: { kind: 'demand', title: '需求撤', body: 'x', budget: 50 } })).json()
    resetFeedForTest()
    const r = await base.app.inject({ method: 'DELETE', url: `/v1/market/listings/${l.id}`, headers: H(A.token) })
    expect(r.statusCode).toBe(200)
    const kinds = getMarketFeed(20).map(e => e.kind)
    expect(kinds).toEqual(['refunded', 'listing_canceled']) // getMarketFeed 逆序（新在上）
  })

  it('expired 扫描 → 每条过期挂牌一条 listing_canceled', async () => {
    resetFeedForTest()
    const A = await base.mk('feed-exp-1')
    await base.app.inject({ method: 'GET', url: '/v1/credits/account', headers: H(A.token) })
    const l = (await base.app.inject({ method: 'POST', url: '/v1/market/listings', headers: H(A.token), payload: { kind: 'service', title: '过期的', body: 'x', price: 5 } })).json()
    base.db.prepare('UPDATE listings SET expires_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), l.id)
    const { scanMarket } = await import('../src/core/market.js')
    scanMarket(base.db, base.cfg, base.bus)
    const evs = getMarketFeed(20).filter(e => e.kind === 'listing_canceled')
    expect(evs).toHaveLength(1)
    expect(evs[0].title).toBe('过期的')
  })
})
