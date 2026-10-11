// 市场成交 deals（spec §2.1/§2.2/§2.4）：demand 选标（escrow 差额调整 + policy 预检 + 派生 task）、
// service 直购/议价成交、deliver→accept 放款结算、cancel 全额退款、状态机与不变量。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { startWsServer } from './helpers/ws-server.js'
import { auditInvariant, getOrCreateAccount, available } from '../src/core/credits.js'

let base: Awaited<ReturnType<typeof startWsServer>>
beforeEach(async () => {
  base = await startWsServer({ ADMIN_TOKEN: 'adm-secret', RATE_LIMIT_REGISTER_PER_HOUR: '1000', RATE_LIMIT_MARKET_PUBLISH_PER_DAY: '100', RATE_LIMIT_MARKET_BID_PER_DAY: '100', RATE_LIMIT_MARKET_COUNTER_PER_DAY: '100' })
})
afterEach(async () => { await base.close() })
const H = (t: string) => ({ authorization: `Bearer ${t}` })

const acct = (id: string) => { const a = getOrCreateAccount(base.db, id); return { locked: a.locked, available: available(a) } }
const dbDeal = (id: string) => base.db.prepare('SELECT * FROM deals WHERE id=?').get(id) as any
const listingRow = (id: string) => base.db.prepare('SELECT * FROM listings WHERE id=?').get(id) as any
const bidRow = (id: string) => base.db.prepare('SELECT * FROM bids WHERE id=?').get(id) as any
const setPolicy = (id: string, mode: 'open' | 'closed') =>
  base.db.prepare(`UPDATE agents SET task_policy=? WHERE id=?`).run(JSON.stringify({ mode, allowlist: [], scope: 'read-only' }), id)

let seq = 0 // 每次夹具用独立 agent id（同库内唯一）
// demand 挂牌夹具：alice 悬赏、bob/carol 投标方
async function demandFixture(budget = 500) {
  const s = `sel${seq++}`
  const A = await base.mk(`alice-${s}`)
  const B = await base.mk(`bob-${s}`)
  const C = await base.mk(`carol-${s}`)
  for (const t of [A.token, B.token, C.token]) await base.app.inject({ method: 'GET', url: '/v1/credits/account', headers: H(t) })
  const listing = (await base.app.inject({
    method: 'POST', url: '/v1/market/listings', headers: H(A.token),
    payload: { kind: 'demand', title: '写爬虫', body: '抓三个站点', budget },
  })).json()
  return { A, B, C, listing, alice: `alice-${s}`, bob: `bob-${s}` }
}

// service 挂牌夹具：alice 卖、bob/carol 买
async function serviceFixture(price = 100) {
  const s = `svc${seq++}`
  const A = await base.mk(`alice-${s}`)
  const B = await base.mk(`bob-${s}`)
  const C = await base.mk(`carol-${s}`)
  for (const t of [A.token, B.token, C.token]) await base.app.inject({ method: 'GET', url: '/v1/credits/account', headers: H(t) })
  const listing = (await base.app.inject({
    method: 'POST', url: '/v1/market/listings', headers: H(A.token),
    payload: { kind: 'service', title: '代码审查', body: '一次全面 review', price },
  })).json()
  return { A, B, C, listing, alice: `alice-${s}`, bob: `bob-${s}` }
}

const postBid = (token: string, listingId: string, points: number, body = '提案') =>
  base.app.inject({ method: 'POST', url: `/v1/market/listings/${listingId}/bids`, headers: H(token), payload: { points, body } })
const postCounter = (token: string, bidId: string, points: number, body = '还价') =>
  base.app.inject({ method: 'POST', url: `/v1/market/bids/${bidId}/counter`, headers: H(token), payload: { points, body } })
const postSelect = (token: string, listingId: string, bidId: string) =>
  base.app.inject({ method: 'POST', url: `/v1/market/listings/${listingId}/select/${bidId}`, headers: H(token) })
const postBuy = (token: string, listingId: string) =>
  base.app.inject({ method: 'POST', url: `/v1/market/listings/${listingId}/buy`, headers: H(token) })
const postAcceptBid = (token: string, bidId: string) =>
  base.app.inject({ method: 'POST', url: `/v1/market/bids/${bidId}/accept`, headers: H(token) })
const postDealOp = (token: string, dealId: string, op: 'deliver' | 'accept' | 'cancel', payload?: object) =>
  base.app.inject({ method: 'POST', url: `/v1/market/deals/${dealId}/${op}`, headers: H(token), payload })

describe('POST /v1/market/listings/:id/select/:bid（demand 选标）', () => {
  it('悬赏全链路：投标 450→counter 480→select→escrowed、差额退回、派生 task、其余 bid rejected', async () => {
    const f = await demandFixture(500)
    const { A, B, C, listing } = f
    const bidB = (await postBid(B.token, listing.id, 450)).json()
    const bidC = (await postBid(C.token, listing.id, 460)).json()
    await postCounter(A.token, bidB.id, 480)
    const beforeA = acct(f.alice) // escrow 500（faucet 600−1 burn）
    const r = await postSelect(A.token, listing.id, bidB.id)
    expect(r.statusCode).toBe(200)
    const deal = r.json()
    expect(deal.status).toBe('escrowed')
    expect(deal.points).toBe(480)
    expect(deal.buyer).toBe(f.alice)
    expect(deal.seller).toBe(f.bob)
    expect(deal.id).toMatch(/^deal_/)
    // escrow 差额退回：locked 499→480，available +19
    const afterA = acct(f.alice)
    expect(afterA.locked).toBe(beforeA.locked - 20)
    expect(afterA.available).toBe(beforeA.available + 20)
    // 派生 task：REQUESTED、context.deal_id 对应
    const task = base.db.prepare('SELECT * FROM tasks WHERE id=?').get(deal.task_id) as any
    expect(task.status).toBe('REQUESTED')
    expect(task.requester).toBe(f.alice)
    expect(task.executor).toBe(f.bob)
    expect(task.action).toBe('market_deal')
    expect(JSON.parse(task.context).deal_id).toBe(deal.id)
    // 其余 bid rejected、中标 bid accepted、listing dealing
    expect(bidRow(bidB.id).status).toBe('accepted')
    expect(bidRow(bidC.id).status).toBe('rejected')
    const l = listingRow(listing.id)
    expect(l.status).toBe('dealing')
    expect(l.escrowed_points).toBe(480)
    // srv 通知双方（type=system）
    const srv = base.db.prepare(`SELECT COUNT(*) c FROM messages WHERE client_msg_id LIKE 'srv:mkt:sel:${deal.id}%'`).get() as any
    expect(srv.c).toBe(2)
    expect(auditInvariant(base.db)).toBe(true)
  })

  it('补冻结失败：bid 600 > escrow 且买家可用不足 → INSUFFICIENT_CREDITS 整单回滚', async () => {
    const f = await demandFixture(500)
    const { A, B, listing } = f
    const esc = listingRow(listing.id).escrowed_points as number
    expect(acct(f.alice).available).toBe(99) // 600−1 burn−500 escrow
    const bid = (await postBid(B.token, listing.id, 600)).json()
    const r = await postSelect(A.token, listing.id, bid.id)
    expect(r.statusCode).toBe(422); expect(r.json().error.code).toBe('INSUFFICIENT_CREDITS')
    // deal 无、bids 状态原样、escrowed_points 原值、listing 仍 open
    expect((base.db.prepare('SELECT COUNT(*) c FROM deals').get() as any).c).toBe(0)
    expect(bidRow(bid.id).status).toBe('pending')
    expect(listingRow(listing.id).escrowed_points).toBe(esc)
    expect(listingRow(listing.id).status).toBe('open')
    expect(acct(f.alice).locked).toBe(esc)
  })

  it('policy 预检：卖家 task_policy closed → TASK_POLICY_CLOSED，bid/listing 原样、资金未动', async () => {
    const f = await demandFixture(500)
    const { A, B, listing } = f
    const bid = (await postBid(B.token, listing.id, 400)).json()
    setPolicy(f.bob, 'closed')
    const beforeA = acct(f.alice)
    const r = await postSelect(A.token, listing.id, bid.id)
    expect(r.statusCode).toBe(422); expect(r.json().error.code).toBe('TASK_POLICY_CLOSED')
    expect(bidRow(bid.id).status).toBe('pending')
    expect(listingRow(listing.id).status).toBe('open')
    expect(acct(f.alice)).toEqual(beforeA)
    expect((base.db.prepare('SELECT COUNT(*) c FROM deals').get() as any).c).toBe(0)
    expect((base.db.prepare('SELECT COUNT(*) c FROM tasks').get() as any).c).toBe(0)
  })

  it('非挂牌人 select / 非开放状态 → NOT_PARTY / LISTING_NOT_OPEN', async () => {
    const f = await demandFixture(500)
    const { A, B, C, listing } = f
    const bid = (await postBid(B.token, listing.id, 400)).json()
    const np = await postSelect(C.token, listing.id, bid.id)
    expect(np.statusCode).toBe(403); expect(np.json().error.code).toBe('NOT_PARTY')
    const ok = await postSelect(A.token, listing.id, bid.id)
    expect(ok.statusCode).toBe(200)
    const again = await postSelect(A.token, listing.id, bid.id)
    expect(again.statusCode).toBe(422); expect(again.json().error.code).toBe('LISTING_NOT_OPEN')
  })
})

describe('service 直购与议价成交', () => {
  it('buy：冻结 price、listing 仍 open、可再买第二单、deals 列表按 role', async () => {
    const f = await serviceFixture(100)
    const { A, B, C, listing } = f
    const beforeB = acct(f.bob)
    const r = await postBuy(B.token, listing.id)
    expect(r.statusCode).toBe(200)
    const d1 = r.json()
    expect(d1.status).toBe('escrowed'); expect(d1.points).toBe(100)
    expect(d1.buyer).toBe(f.bob); expect(d1.seller).toBe(f.alice)
    expect(acct(f.bob).locked).toBe(beforeB.locked + 100)
    expect(acct(f.bob).available).toBe(beforeB.available - 100)
    expect(listingRow(listing.id).status).toBe('open') // 重复成交
    const r2 = await postBuy(C.token, listing.id)
    expect(r2.statusCode).toBe(200)
    expect((base.db.prepare('SELECT COUNT(*) c FROM deals WHERE listing_id=?').get(listing.id) as any).c).toBe(2)
    // 买自己的 → SELF_DEAL
    const self = await postBuy(A.token, listing.id)
    expect(self.statusCode).toBe(422); expect(self.json().error.code).toBe('SELF_DEAL')
    // GET deals?role=buyer
    const list = (await base.app.inject({ method: 'GET', url: '/v1/market/deals?role=buyer', headers: H(B.token) })).json()
    expect(list.items).toHaveLength(1)
    expect(list.items[0].id).toBe(d1.id)
    const asSeller = (await base.app.inject({ method: 'GET', url: '/v1/market/deals?role=seller', headers: H(A.token) })).json()
    expect(asSeller.items).toHaveLength(2)
    expect(auditInvariant(base.db)).toBe(true)
  })

  it('closed policy 卖家 buy → TASK_POLICY_CLOSED 且资金未动', async () => {
    const f = await serviceFixture(100)
    const { B, listing } = f
    setPolicy(f.alice, 'closed')
    const beforeB = acct(f.bob)
    const r = await postBuy(B.token, listing.id)
    expect(r.statusCode).toBe(422); expect(r.json().error.code).toBe('TASK_POLICY_CLOSED')
    expect(acct(f.bob)).toEqual(beforeB)
    expect((base.db.prepare('SELECT COUNT(*) c FROM deals').get() as any).c).toBe(0)
    expect((base.db.prepare('SELECT COUNT(*) c FROM tasks').get() as any).c).toBe(0)
  })

  it('议价成交：bid 80 → 挂牌人 accept → buyer 冻结 80、deal escrowed、listing 仍 open', async () => {
    const f = await serviceFixture(100)
    const { A, B, listing } = f
    const bid = (await postBid(B.token, listing.id, 80, '打个折')).json()
    const beforeB = acct(f.bob)
    const r = await postAcceptBid(A.token, bid.id)
    expect(r.statusCode).toBe(200)
    const deal = r.json()
    expect(deal.status).toBe('escrowed'); expect(deal.points).toBe(80)
    expect(deal.buyer).toBe(f.bob); expect(deal.seller).toBe(f.alice)
    expect(acct(f.bob).locked).toBe(beforeB.locked + 80)
    expect(bidRow(bid.id).status).toBe('accepted')
    expect(listingRow(listing.id).status).toBe('open')
    const task = base.db.prepare('SELECT * FROM tasks WHERE id=?').get(deal.task_id) as any
    expect(task.status).toBe('REQUESTED')
    expect(auditInvariant(base.db)).toBe(true)
  })

  it('非挂牌人 accept service bid → NOT_PARTY', async () => {
    const f = await serviceFixture(100)
    const { A, B, C, listing } = f
    const bid = (await postBid(B.token, listing.id, 80)).json()
    const np = await postAcceptBid(C.token, bid.id)
    expect(np.statusCode).toBe(403); expect(np.json().error.code).toBe('NOT_PARTY')
  })
})

describe('deliver / accept / cancel', () => {
  async function selectedDeal() {
    const f = await demandFixture(500)
    const bid = (await postBid(f.B.token, f.listing.id, 480)).json()
    const deal = (await postSelect(f.A.token, f.listing.id, bid.id)).json()
    return { ...f, deal, bid }
  }

  it('deliver→accept：payout=points−5% 入 seller permanent、池=5%、buyer locked 归零、listing done', async () => {
    const f = await selectedDeal()
    const { A, B, listing, deal } = f
    const np = await postDealOp(A.token, deal.id, 'deliver')
    expect(np.statusCode).toBe(403); expect(np.json().error.code).toBe('NOT_PARTY')
    const d = await postDealOp(B.token, deal.id, 'deliver', { note: '已交付' })
    expect(d.statusCode).toBe(200)
    expect(d.json().status).toBe('delivered')
    expect(Date.parse(d.json().auto_accept_at)).toBeGreaterThan(Date.now() + 47 * 3600_000)
    // escrowed 直接 accept → INVALID_REQUEST（非法迁移）
    // 先再建一单 escrowed deal 验证
    const f2 = await demandFixture(300)
    const { A: A2, B: B2, listing: l2 } = f2
    const bid2 = (await postBid(B2.token, l2.id, 280)).json()
    const deal2 = (await postSelect(A2.token, l2.id, bid2.id)).json()
    const early = await postDealOp(A2.token, deal2.id, 'accept')
    expect(early.statusCode).toBe(400); expect(early.json().error.code).toBe('INVALID_REQUEST')
    // 非买方 accept → NOT_PARTY
    const np2 = await postDealOp(B.token, deal.id, 'accept')
    expect(np2.statusCode).toBe(403); expect(np2.json().error.code).toBe('NOT_PARTY')
    const beforeS = acct(f.bob)
    const poolBefore = (base.db.prepare('SELECT balance FROM credit_pool WHERE id=1').get() as any).balance
    const acc = await postDealOp(A.token, deal.id, 'accept')
    expect(acc.statusCode).toBe(200)
    expect(acc.json().status).toBe('accepted')
    expect(acct(f.bob).available).toBe(beforeS.available + 456) // 480 − 5% = 456
    expect((base.db.prepare('SELECT balance FROM credit_pool WHERE id=1').get() as any).balance).toBe(poolBefore + 24)
    expect(acct(f.alice).locked).toBe(0)
    expect(listingRow(listing.id).status).toBe('done')
    expect(auditInvariant(base.db)).toBe(true)
  })

  it('cancel escrowed：买家全额退款、demand 回 open、旧 bids expired', async () => {
    const f = await selectedDeal()
    const { A, B, C, listing, deal, bid } = f
    const beforeA = acct(f.alice)
    const r = await postDealOp(B.token, deal.id, 'cancel') // 卖家也可取消
    expect(r.statusCode).toBe(200)
    expect(r.json().status).toBe('canceled')
    expect(acct(f.alice).locked).toBe(0)
    expect(acct(f.alice).available).toBe(beforeA.available + 480)
    const l = listingRow(listing.id)
    expect(l.status).toBe('open')
    expect(l.escrowed_points).toBe(0)
    expect(bidRow(bid.id).status).toBe('expired')
    // 退回 open 后可重新投标
    const again = await postBid(C.token, listing.id, 300)
    expect(again.statusCode).toBe(200)
    expect(auditInvariant(base.db)).toBe(true)
  })

  it('delivered 后 cancel → INVALID_REQUEST（spec §2.4：delivered 前才可取消）；走完 accept 再 cancel 同样 400', async () => {
    const f = await selectedDeal()
    const { A, B, listing, deal } = f
    await postDealOp(B.token, deal.id, 'deliver')
    const c = await postDealOp(A.token, deal.id, 'cancel')
    expect(c.statusCode).toBe(400); expect(c.json().error.code).toBe('INVALID_REQUEST')
    expect(dbDeal(deal.id).status).toBe('delivered') // deal 原样，由 accept/自动验收结算
    expect(acct(f.alice).locked).toBe(480)
    // 重建一单走完 accept，再 cancel → 400
    const f2 = await demandFixture(300)
    const { A: A2, B: B2, listing: l2 } = f2
    const bid2 = (await postBid(B2.token, l2.id, 280)).json()
    const deal2 = (await postSelect(A2.token, l2.id, bid2.id)).json()
    await postDealOp(B2.token, deal2.id, 'deliver')
    await postDealOp(A2.token, deal2.id, 'accept')
    const late = await postDealOp(A2.token, deal2.id, 'cancel')
    expect(late.statusCode).toBe(400); expect(late.json().error.code).toBe('INVALID_REQUEST')
    expect(listingRow(l2.id).status).toBe('done') // done 不可逆
    expect(auditInvariant(base.db)).toBe(true)
  })

  it('非当事方操作 deal → NOT_PARTY；service deal cancel 无 listing 副作用', async () => {
    const f = await serviceFixture(100)
    const { A, B, C, listing } = f
    const deal = (await postBuy(B.token, listing.id)).json()
    const np = await postDealOp(C.token, deal.id, 'cancel')
    expect(np.statusCode).toBe(403); expect(np.json().error.code).toBe('NOT_PARTY')
    const r = await postDealOp(B.token, deal.id, 'cancel')
    expect(r.statusCode).toBe(200)
    expect(acct(f.bob).locked).toBe(0)
    expect(listingRow(listing.id).status).toBe('open') // service 不动 listing
  })

  it('admin force 下架带 delivered deal 的 demand：托管保留、deal 仍可 accept 放款（fix-2 BLK-1）', async () => {
    const f = await selectedDeal() // alice 480 escrow → bob
    const { A, B, listing, deal } = f
    await postDealOp(B.token, deal.id, 'deliver')
    const beforeA = acct(f.alice)
    const r = await base.app.inject({ method: 'DELETE', url: `/v1/market/listings/${listing.id}?force=1`, headers: { authorization: `Bearer ${A.token}`, 'x-admin-token': 'adm-secret' } })
    expect(r.statusCode).toBe(200)
    // listing 已下架，但 delivered deal 的托管仍在，不被当作剩余 escrow 退回
    expect(dbDeal(deal.id).status).toBe('delivered')
    expect(acct(f.alice).locked).toBe(480)
    expect(acct(f.alice).available).toBe(beforeA.available)
    // 买方仍可验收：payout 正常落 seller、佣金入池
    const beforeS = acct(f.bob)
    const acc = await postDealOp(A.token, deal.id, 'accept')
    expect(acc.statusCode).toBe(200)
    expect(acct(f.alice).locked).toBe(0)
    expect(acct(f.bob).available).toBe(beforeS.available + 456)
    expect(auditInvariant(base.db)).toBe(true)
  })

  it('全链路后 auditInvariant 仍 true（srv 消息落库）', async () => {
    const f = await selectedDeal()
    const { A, B, listing, deal } = f
    await postDealOp(B.token, deal.id, 'deliver')
    await postDealOp(A.token, deal.id, 'accept')
    expect(auditInvariant(base.db)).toBe(true)
    const srv = base.db.prepare(`SELECT COUNT(*) c FROM messages WHERE client_msg_id LIKE 'srv:mkt:%'`).get() as any
    expect(srv.c).toBeGreaterThan(0)
  })
})
