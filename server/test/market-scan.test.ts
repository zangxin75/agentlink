// 市场 scanner（spec 2026-10-03 §2.1/§2.4/§6）：挂牌过期退款、bid 过期、deal 自动验收（RF2 幂等）、
// 派生 task 终结提醒买家（RF4）、expiring 清扫、auditInvariant 对账。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { startWsServer } from './helpers/ws-server.js'
import { scanMarket } from '../src/core/market.js'
import { scanTimeouts } from '../src/core/tasks.js'
import { auditInvariant, getOrCreateAccount, available } from '../src/core/credits.js'

let base: Awaited<ReturnType<typeof startWsServer>>
beforeEach(async () => {
  base = await startWsServer({ ADMIN_TOKEN: 'adm-secret', RATE_LIMIT_REGISTER_PER_HOUR: '1000', RATE_LIMIT_MARKET_PUBLISH_PER_DAY: '100', RATE_LIMIT_MARKET_BID_PER_DAY: '100', RATE_LIMIT_MARKET_COUNTER_PER_DAY: '100' })
})
afterEach(async () => { await base.close() })
const H = (t: string) => ({ authorization: `Bearer ${t}` })
const PAST = '2000-01-01T00:00:00.000Z'
const scan = () => scanMarket(base.db, base.cfg, base.bus, new Date())
const acct = (id: string) => { const a = getOrCreateAccount(base.db, id); return { locked: a.locked, available: available(a), permanent: a.permanent, expiring: a.expiring } }
const listingRow = (id: string) => base.db.prepare('SELECT * FROM listings WHERE id=?').get(id) as any
const bidRow = (id: string) => base.db.prepare('SELECT * FROM bids WHERE id=?').get(id) as any
const dbDeal = (id: string) => base.db.prepare('SELECT * FROM deals WHERE id=?').get(id) as any
const poolBalance = () => (base.db.prepare('SELECT balance FROM credit_pool WHERE id=1').get() as any).balance

let seq = 0
async function fixture(kind: 'demand' | 'service', points = 500) {
  const s = `scn${seq++}`
  const A = await base.mk(`alice-${s}`)
  const B = await base.mk(`bob-${s}`)
  for (const t of [A.token, B.token]) await base.app.inject({ method: 'GET', url: '/v1/credits/account', headers: H(t) })
  const listing = (await base.app.inject({
    method: 'POST', url: '/v1/market/listings', headers: H(A.token),
    payload: kind === 'demand'
      ? { kind, title: '悬赏', body: '干活', budget: points }
      : { kind, title: '服务', body: '干活', price: points },
  })).json()
  return { A, B, listing, alice: `alice-${s}`, bob: `bob-${s}` }
}

const postBid = (token: string, listingId: string, points: number, body = '提案') =>
  base.app.inject({ method: 'POST', url: `/v1/market/listings/${listingId}/bids`, headers: H(token), payload: { points, body } })
const postCounter = (token: string, bidId: string, points: number) =>
  base.app.inject({ method: 'POST', url: `/v1/market/bids/${bidId}/counter`, headers: H(token), payload: { points, body: '还价' } })
const postSelect = (token: string, listingId: string, bidId: string) =>
  base.app.inject({ method: 'POST', url: `/v1/market/listings/${listingId}/select/${bidId}`, headers: H(token) })
const postBuy = (token: string, listingId: string) =>
  base.app.inject({ method: 'POST', url: `/v1/market/listings/${listingId}/buy`, headers: H(token) })
const postDealOp = (token: string, dealId: string, op: 'deliver' | 'accept' | 'cancel') =>
  base.app.inject({ method: 'POST', url: `/v1/market/deals/${dealId}/${op}`, headers: H(token) })

describe('scanMarket：挂牌过期退款', () => {
  it('demand 过期：escrow 退回 permanent（refund）、status=expired、escrowed_points=0', async () => {
    const f = await fixture('demand', 500)
    const before = acct(f.alice)
    base.db.prepare('UPDATE listings SET expires_at=? WHERE id=?').run(PAST, f.listing.id)
    const r = scan()
    expect(r.expiredListings).toEqual([f.listing.id])
    expect(listingRow(f.listing.id).status).toBe('expired')
    expect(listingRow(f.listing.id).escrowed_points).toBe(0)
    const after = acct(f.alice)
    expect(after.available).toBe(before.available + 500)
    expect(base.db.prepare(`SELECT COUNT(*) c FROM credit_ledger WHERE agent_id=? AND kind='refund' AND ref_type='listing' AND ref_id=?`).get(f.alice, f.listing.id)).toMatchObject({ c: 1 })
    expect(auditInvariant(base.db)).toBe(true)
  })

  it('RF3：过期但已手工 canceled → 不双重退款', async () => {
    const f = await fixture('demand', 500)
    base.db.prepare(`UPDATE listings SET expires_at=?, status='canceled' WHERE id=?`).run(PAST, f.listing.id)
    const before = acct(f.alice)
    const r = scan()
    expect(r.expiredListings).toEqual([])
    expect(acct(f.alice).available).toBe(before.available)
  })

  it('service 过期：仅置 expired，无资金副作用', async () => {
    const f = await fixture('service', 100)
    const before = acct(f.alice)
    base.db.prepare('UPDATE listings SET expires_at=? WHERE id=?').run(PAST, f.listing.id)
    const r = scan()
    expect(r.expiredListings).toEqual([f.listing.id])
    expect(listingRow(f.listing.id).status).toBe('expired')
    expect(acct(f.alice)).toEqual(before)
  })
})

describe('scanMarket：bid 过期', () => {
  it('pending 超 bidDays → expired', async () => {
    const f = await fixture('demand', 500)
    const bid = (await postBid(f.B.token, f.listing.id, 450)).json()
    base.db.prepare('UPDATE bids SET updated_at=? WHERE id=?').run(PAST, bid.id)
    const r = scan()
    expect(r.expiredBids).toEqual([bid.id])
    expect(bidRow(bid.id).status).toBe('expired')
  })
})

describe('scanMarket：自动验收（RF2 幂等）', () => {
  it('delivered 且 auto_accept_at 过去 → accepted + 放款；再扫不双放款', async () => {
    const f = await fixture('service', 100)
    const deal = (await postBuy(f.B.token, f.listing.id)).json()
    await postDealOp(f.A.token, deal.id, 'deliver')
    base.db.prepare('UPDATE deals SET auto_accept_at=? WHERE id=?').run(PAST, deal.id)
    const poolBefore = poolBalance()
    const sellerBefore = acct(f.alice)
    const r = scan()
    expect(r.autoAccepted).toEqual([deal.id])
    expect(dbDeal(deal.id).status).toBe('accepted')
    const commission = Math.floor(100 * base.cfg.market.commissionPct / 100)
    expect(acct(f.alice).permanent).toBe(sellerBefore.permanent + 100 - commission)
    expect(poolBalance()).toBe(poolBefore + commission)
    expect(acct(deal.buyer).locked).toBe(0)
    // RF2：再扫一遍无变化
    const r2 = scan()
    expect(r2.autoAccepted).toEqual([])
    expect(acct(f.alice).permanent).toBe(sellerBefore.permanent + 100 - commission)
    expect(poolBalance()).toBe(poolBefore + commission)
    expect(auditInvariant(base.db)).toBe(true)
  })

  it('人工 accept 后 scanner 跳过同 deal', async () => {
    const f = await fixture('service', 100)
    const deal = (await postBuy(f.B.token, f.listing.id)).json()
    await postDealOp(f.A.token, deal.id, 'deliver')
    base.db.prepare('UPDATE deals SET auto_accept_at=? WHERE id=?').run(PAST, deal.id)
    await postDealOp(f.B.token, deal.id, 'accept')
    const seller = acct(f.alice)
    const r = scan()
    expect(r.autoAccepted).toEqual([])
    expect(acct(f.alice).permanent).toBe(seller.permanent)
    expect(dbDeal(deal.id).status).toBe('accepted')
  })
})

describe('RF4：派生 task 终结 → deal 保持 escrowed + srv:market 提醒买家', () => {
  it('task 被 reject → buyer 收提醒，deal 仍 escrowed，可 cancel 退款', async () => {
    const f = await fixture('demand', 500)
    const bid = (await postBid(f.B.token, f.listing.id, 450)).json()
    const deal = (await postSelect(f.A.token, f.listing.id, bid.id)).json()
    const task = base.db.prepare('SELECT * FROM tasks WHERE id=?').get(deal.task_id) as any
    await base.app.inject({ method: 'POST', url: `/v1/tasks/${task.id}/reject`, headers: H(f.B.token), payload: { note: 'no time' } })
    const reminder = base.db.prepare(`SELECT COUNT(*) c FROM messages WHERE to_agent=? AND client_msg_id LIKE 'srv:mkt:tend:${task.id}%'`).get(f.alice) as any
    expect(reminder.c).toBe(1)
    expect(dbDeal(deal.id).status).toBe('escrowed')
    // 买家仍可 cancel 拿回全额
    const before = acct(f.alice)
    await postDealOp(f.A.token, deal.id, 'cancel')
    expect(acct(f.alice).available).toBe(before.available + 450)
  })

  it('task 超时（scanner 置 TIMEOUT）→ buyer 收提醒，deal 仍 escrowed', async () => {
    const f = await fixture('demand', 500)
    const bid = (await postBid(f.B.token, f.listing.id, 450)).json()
    const deal = (await postSelect(f.A.token, f.listing.id, bid.id)).json()
    const task = base.db.prepare('SELECT * FROM tasks WHERE id=?').get(deal.task_id) as any
    // 请求超期（EXPIRED 路径）
    base.db.prepare('UPDATE tasks SET expires_at=? WHERE id=?').run(PAST, task.id)
    scanTimeouts(base.db, base.bus, new Date())
    const reminder = base.db.prepare(`SELECT COUNT(*) c FROM messages WHERE to_agent=? AND client_msg_id LIKE 'srv:mkt:tend:${task.id}%'`).get(f.alice) as any
    expect(reminder.c).toBe(1)
    expect(dbDeal(deal.id).status).toBe('escrowed')
  })
})

describe('scanMarket：expiring 清扫', () => {
  it('过期账户 expiring 超额部分清零、locked 保留', async () => {
    const f = await fixture('service', 100)
    // 经账本入 100 expiring（TTL 1h）再锁 40，到期后超额 60 被清——保持 auditInvariant 可对账
    const { creditAccount, lockPoints } = await import('../src/core/credits.js')
    creditAccount(base.db, f.bob, 'grant', 100, { bucket: 'expiring', ttlHours: 1 }, base.cfg)
    lockPoints(base.db, f.bob, 40, 'escrow_lock', { refType: 'test', refId: 'x' })
    base.db.prepare('UPDATE credit_accounts SET expiring_expires_at=? WHERE agent_id=?').run(PAST, f.bob)
    const r = scan()
    expect(r.sweptExpired).toBe(1)
    const a = base.db.prepare('SELECT expiring, locked FROM credit_accounts WHERE agent_id=?').get(f.bob) as any
    expect(a.expiring).toBe(40)
    expect(a.locked).toBe(40)
    expect(auditInvariant(base.db)).toBe(true)
  })
})

describe('T4-m1：counterBid 须挂牌 open', () => {
  it('listing 非 open 时 counter → LISTING_NOT_OPEN', async () => {
    const f = await fixture('demand', 500)
    const bid = (await postBid(f.B.token, f.listing.id, 450)).json()
    base.db.prepare(`UPDATE listings SET status='dealing' WHERE id=?`).run(f.listing.id)
    const res = await postCounter(f.A.token, bid.id, 480)
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    expect(res.json().error?.code ?? res.json().code).toBe('LISTING_NOT_OPEN')
  })
})

describe('终审 Medium-1：dealing 挂牌过期兜底退款', () => {
  it('dealing 过期 → escrowed deal 取消退款、listing expired；二扫无副作用', async () => {
    const f = await fixture('demand', 500)
    const bid = (await postBid(f.B.token, f.listing.id, 450)).json()
    const deal = (await postSelect(f.A.token, f.listing.id, bid.id)).json()
    const before = acct(f.alice)
    base.db.prepare('UPDATE listings SET expires_at=? WHERE id=?').run(PAST, f.listing.id)
    const r = scan()
    expect(r.expiredListings).toEqual([f.listing.id])
    expect(dbDeal(deal.id).status).toBe('canceled')
    expect(listingRow(f.listing.id).status).toBe('expired')
    expect(listingRow(f.listing.id).escrowed_points).toBe(0)
    expect(acct(f.alice).available).toBe(before.available + 450)
    expect(acct(f.alice).locked).toBe(0)
    expect(auditInvariant(base.db)).toBe(true)
    // 二扫：无变化、不双退
    const after = acct(f.alice)
    const r2 = scan()
    expect(r2.expiredListings).toEqual([])
    expect(acct(f.alice).available).toBe(after.available)
  })

  it('dealing 过期但 deal 已 delivered → 不取消，托管留给结算', async () => {
    const f = await fixture('demand', 500)
    const bid = (await postBid(f.B.token, f.listing.id, 450)).json()
    const deal = (await postSelect(f.A.token, f.listing.id, bid.id)).json()
    await postDealOp(f.B.token, deal.id, 'deliver') // deliver 未验收购（demand 无 listing 副作用）
    base.db.prepare('UPDATE listings SET expires_at=? WHERE id=?').run(PAST, f.listing.id)
    scan()
    expect(dbDeal(deal.id).status).toBe('delivered')
    expect(listingRow(f.listing.id).status).toBe('dealing')
  })
})

describe('终审 Minor-2/3', () => {
  it('force DELETE done 挂牌 → 响应报告实际最终状态 done', async () => {
    const f = await fixture('demand', 500)
    const bid = (await postBid(f.B.token, f.listing.id, 450)).json()
    const deal = (await postSelect(f.A.token, f.listing.id, bid.id)).json()
    await postDealOp(f.B.token, deal.id, 'deliver')
    await postDealOp(f.A.token, deal.id, 'accept')
    expect(listingRow(f.listing.id).status).toBe('done')
    const res = await base.app.inject({ method: 'DELETE', url: `/v1/market/listings/${f.listing.id}?force=1`, headers: { ...H(f.A.token), 'x-admin-token': 'adm-secret' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe(listingRow(f.listing.id).status)
  })

  it('非数字 limit → 400 INVALID_REQUEST（listings 与 deals）', async () => {
    const A = await base.mk('lim-x')
    for (const url of ['/v1/market/listings?limit=abc', '/v1/market/deals?limit=abc']) {
      const res = await base.app.inject({ method: 'GET', url, headers: H(A.token) })
      expect(res.statusCode).toBe(400)
      expect(res.json().error?.code ?? res.json().code).toBe('INVALID_REQUEST')
    }
  })
})
