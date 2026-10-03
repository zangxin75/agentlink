// 市场投标 bids（spec §2.1/§3）：demand 投标 burn 1、双向多轮议价（轮次上限/交替）、
// withdraw/reject 状态机、reject 后可再投标、议价不动账。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { startWsServer } from './helpers/ws-server.js'
import { auditInvariant, getOrCreateAccount, available, transferPoints } from '../src/core/credits.js'

let base: Awaited<ReturnType<typeof startWsServer>>
beforeEach(async () => {
  base = await startWsServer({ ADMIN_TOKEN: 'adm-secret', RATE_LIMIT_MARKET_PUBLISH_PER_DAY: '100', RATE_LIMIT_MARKET_BID_PER_DAY: '100', RATE_LIMIT_MARKET_COUNTER_PER_DAY: '100' })
})
afterEach(async () => { await base.close() })
const H = (t: string) => ({ authorization: `Bearer ${t}` })

const acct = (id: string) => { const a = getOrCreateAccount(base.db, id); return { locked: a.locked, available: available(a) } }
const dbBid = (id: string) => base.db.prepare('SELECT * FROM bids WHERE id=?').get(id) as any

// demand 挂牌 + 双方开户的通用夹具
async function demandFixture(budget = 500) {
  const A = await base.mk('alice-bid')
  const B = await base.mk('bob-bid')
  for (const t of [A.token, B.token]) await base.app.inject({ method: 'GET', url: '/v1/credits/account', headers: H(t) })
  const c = (await base.app.inject({
    method: 'POST', url: '/v1/market/listings', headers: H(A.token),
    payload: { kind: 'demand', title: '写爬虫', body: '抓三个站点', budget },
  })).json()
  return { A, B, listing: c }
}

const postBid = (token: string, listingId: string, points: number, body = '提案') =>
  base.app.inject({ method: 'POST', url: `/v1/market/listings/${listingId}/bids`, headers: H(token), payload: { points, body } })
const postCounter = (token: string, bidId: string, points: number, body = '还价') =>
  base.app.inject({ method: 'POST', url: `/v1/market/bids/${bidId}/counter`, headers: H(token), payload: { points, body } })
const postDecide = (token: string, bidId: string, op: 'withdraw' | 'reject') =>
  base.app.inject({ method: 'POST', url: `/v1/market/bids/${bidId}/${op}`, headers: H(token) })

describe('POST /v1/market/listings/:id/bids', () => {
  it('demand 投标：pending、burn 1、listing 含 bids', async () => {
    const { A, B, listing } = await demandFixture()
    const r = await postBid(B.token, listing.id, 400)
    expect(r.statusCode).toBe(200)
    const j = r.json()
    expect(j.status).toBe('pending')
    expect(j.points).toBe(400)
    expect(j.agent_id).toBe('bob-bid')
    expect(j.counter_rounds).toBe(0)
    const a = acct('bob-bid')
    expect(a.available).toBe(599) // 600 - 1 burn；议价不锁钱
    const g = (await base.app.inject({ method: 'GET', url: `/v1/market/listings/${listing.id}`, headers: H(A.token) })).json()
    expect(g.bids).toHaveLength(1)
    expect(g.bids[0].id).toBe(j.id)
    expect(auditInvariant(base.db)).toBe(true)
  })

  it('投自己的 demand → SELF_DEAL', async () => {
    const { A, listing } = await demandFixture()
    const self = await postBid(A.token, listing.id, 100)
    expect(self.statusCode).toBe(422); expect(self.json().error.code).toBe('SELF_DEAL')
  })
})

describe('POST /v1/market/bids/:id/counter', () => {
  it('买卖双方各 counter 一轮成功且 points 覆写；非双方 → NOT_PARTY', async () => {
    const { A, B, listing } = await demandFixture()
    const bid = (await postBid(B.token, listing.id, 400)).json()
    // 买家自己连 counter（bid 创建即买家一方）→ INVALID_REQUEST（连续同方）
    const same = await postCounter(B.token, bid.id, 380)
    expect(same.statusCode).toBe(400); expect(same.json().error.code).toBe('INVALID_REQUEST')
    // 挂牌人 counter 第 1 轮
    const c1 = await postCounter(A.token, bid.id, 300)
    expect(c1.statusCode).toBe(200)
    expect(c1.json().points).toBe(300)
    expect(c1.json().status).toBe('countered')
    expect(c1.json().counter_rounds).toBe(1)
    // 买家 counter 第 2 轮（points 覆写）
    const c2 = await postCounter(B.token, bid.id, 320)
    expect(c2.statusCode).toBe(200)
    expect(c2.json().points).toBe(320)
    expect(c2.json().counter_rounds).toBe(2)
    // 第三方 → NOT_PARTY
    const C = await base.mk('carol-ctr')
    const np = await postCounter(C.token, bid.id, 310)
    expect(np.statusCode).toBe(403); expect(np.json().error.code).toBe('NOT_PARTY')
    // 挂牌人连续再 counter（第 2 轮是买家，第 3 轮该买家；挂牌人此时出手 = 连续同方？不——
    // 轮次 2 后轮到挂牌人，合法；真正的连续同方已在开头 pending→bid 主覆盖）
    const c3 = await postCounter(A.token, bid.id, 315)
    expect(c3.statusCode).toBe(200)
  })

  it('第 6 轮 → TOO_MANY_ROUNDS', async () => {
    const { A, B, listing } = await demandFixture()
    const bid = (await postBid(B.token, listing.id, 400)).json()
    for (let i = 1; i <= 5; i++) {
      const actor = i % 2 === 1 ? A.token : B.token
      const r = await postCounter(actor, bid.id, 400 - i)
      expect(r.statusCode).toBe(200)
    }
    const sixth = await postCounter(B.token, bid.id, 394)
    expect(sixth.statusCode).toBe(422); expect(sixth.json().error.code).toBe('TOO_MANY_ROUNDS')
    expect(dbBid(bid.id).counter_rounds).toBe(5)
  })

  it('议价不锁钱：counter 全程双方账户不动', async () => {
    const { A, B, listing } = await demandFixture()
    const bid = (await postBid(B.token, listing.id, 400)).json()
    const beforeB = acct('bob-bid'); const beforeA = acct('alice-bid')
    await postCounter(A.token, bid.id, 300)
    await postCounter(B.token, bid.id, 320)
    expect(acct('bob-bid')).toEqual(beforeB)
    expect(acct('alice-bid')).toEqual(beforeA)
    expect(auditInvariant(base.db)).toBe(true)
  })
})

describe('POST /v1/market/bids/:id/withdraw|reject', () => {
  it('withdraw 仅 bid 主；reject 仅挂牌人；状态转移正确', async () => {
    const { A, B, listing } = await demandFixture()
    const bid = (await postBid(B.token, listing.id, 400)).json()
    // 挂牌人不能 withdraw；bid 主不能 reject
    const wByA = await postDecide(A.token, bid.id, 'withdraw')
    expect(wByA.statusCode).toBe(403); expect(wByA.json().error.code).toBe('NOT_PARTY')
    const rByB = await postDecide(B.token, bid.id, 'reject')
    expect(rByB.statusCode).toBe(403); expect(rByB.json().error.code).toBe('NOT_PARTY')
    // 挂牌人 reject → rejected
    const r = await postDecide(A.token, bid.id, 'reject')
    expect(r.statusCode).toBe(200)
    expect(r.json().status).toBe('rejected')
    expect(dbBid(bid.id).status).toBe('rejected')

    const bid2 = (await postBid(B.token, listing.id, 380)).json()
    const w = await postDecide(B.token, bid2.id, 'withdraw')
    expect(w.statusCode).toBe(200)
    expect(w.json().status).toBe('withdrawn')
  })

  it('非 pending/countered 再操作 → BID_CLOSED（含 counter）', async () => {
    const { A, B, listing } = await demandFixture()
    const bid = (await postBid(B.token, listing.id, 400)).json()
    base.db.prepare(`UPDATE bids SET status='rejected' WHERE id=?`).run(bid.id)
    for (const [token, op] of [[B.token, 'withdraw'], [A.token, 'reject'], [A.token, 'counter' as const]] as const) {
      const r = op === 'counter'
        ? await postCounter(token, bid.id, 300)
        : await postDecide(token, bid.id, op as 'withdraw' | 'reject')
      expect(r.statusCode).toBe(422); expect(r.json().error.code).toBe('BID_CLOSED')
    }
  })

  it('rejected 后买家可再 bid 新价（同一 listing 可多次投标）', async () => {
    const { A, B, listing } = await demandFixture()
    const bid = (await postBid(B.token, listing.id, 400)).json()
    await postDecide(A.token, bid.id, 'reject')
    const again = await postBid(B.token, listing.id, 350, '降价再谈')
    expect(again.statusCode).toBe(200)
    expect(again.json().status).toBe('pending')
    expect(again.json().points).toBe(350)
    expect(again.json().id).not.toBe(bid.id)
    const a = acct('bob-bid')
    expect(a.available).toBe(598) // 两次 bid 各 burn 1
    expect(auditInvariant(base.db)).toBe(true)
  })

  it('service：买家 bid 即议价（单轮 counter）；reject 后可再 bid 新价', async () => {
    const S = await base.mk('carol-svc')
    const B = await base.mk('bob-svc')
    for (const t of [S.token, B.token]) await base.app.inject({ method: 'GET', url: '/v1/credits/account', headers: H(t) })
    const svc = (await base.app.inject({ method: 'POST', url: '/v1/market/listings', headers: H(S.token), payload: { kind: 'service', title: '代码审查', body: 'PR 审查', price: 50 } })).json()
    // 买家 bid（即议价记录）：pending、burn 1
    const bid = (await postBid(B.token, svc.id, 40, '40 点可以做吗')).json()
    expect(bid.status).toBe('pending')
    expect(acct('bob-svc').available).toBe(599)
    // 挂牌人 counter 一轮成功，points 覆写
    const c1 = await postCounter(S.token, bid.id, 45)
    expect(c1.statusCode).toBe(200)
    expect(c1.json().points).toBe(45)
    expect(c1.json().counter_rounds).toBe(1)
    // service 议价仅单轮：第二轮（无论哪方）→ TOO_MANY_ROUNDS
    const c2 = await postCounter(B.token, bid.id, 42)
    expect(c2.statusCode).toBe(422); expect(c2.json().error.code).toBe('TOO_MANY_ROUNDS')
    const c3 = await postCounter(S.token, bid.id, 46)
    expect(c3.statusCode).toBe(422); expect(c3.json().error.code).toBe('TOO_MANY_ROUNDS')
    // 挂牌人 reject 后买家可再 bid 新价
    await postDecide(S.token, bid.id, 'reject')
    const again = await postBid(B.token, svc.id, 45, '按你的价来')
    expect(again.statusCode).toBe(200)
    expect(again.json().status).toBe('pending')
    expect(again.json().points).toBe(45)
    expect(auditInvariant(base.db)).toBe(true)
  })
})

// T4 评审补充：投标失败整单回滚、议价出价下界
describe('bids 回滚与出价校验（T4-review riders）', () => {
  it('createBid 余额不足：transferPoints 清零后投标 → INSUFFICIENT_CREDITS，无 bid 行、无 ref_type=bid 账本行', async () => {
    const { A, B, listing } = await demandFixture()
    // 把 bob 余额转空：找 p 使 p + ceil(5%·p) = available（转账税双向 burn）
    const avail = acct('bob-bid').available
    let p = 0
    for (let x = 1; x <= avail; x++) if (x + Math.ceil(x * 0.05) === avail) { p = x; break }
    expect(p).toBeGreaterThan(0)
    transferPoints(base.db, base.cfg, 'bob-bid', 'alice-bid', p)
    expect(acct('bob-bid').available).toBe(0)
    const r = await postBid(B.token, listing.id, 100)
    expect(r.statusCode).toBe(422); expect(r.json().error.code).toBe('INSUFFICIENT_CREDITS')
    expect((base.db.prepare('SELECT COUNT(*) c FROM bids WHERE listing_id=?').get(listing.id) as any).c).toBe(0)
    expect((base.db.prepare(`SELECT COUNT(*) c FROM credit_ledger WHERE agent_id='bob-bid' AND ref_type='bid'`).get() as any).c).toBe(0)
    expect(auditInvariant(base.db)).toBe(true)
  })

  it('counterBid points=0 → PRICE_INVALID', async () => {
    const { A, B, listing } = await demandFixture()
    const bid = (await postBid(B.token, listing.id, 400)).json()
    const c = await postCounter(A.token, bid.id, 0)
    expect(c.statusCode).toBe(422); expect(c.json().error.code).toBe('PRICE_INVALID')
  })
})
