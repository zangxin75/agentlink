// 市场挂牌 listings（spec 2026-10-03 §2.1/§2.4/§3）：demand 托管、service 一口价、校验矩阵、
// 列表过滤与复合游标、PATCH 限制、DELETE 退 escrow、admin force 下架。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { startWsServer } from './helpers/ws-server.js'
import { auditInvariant, getOrCreateAccount, available } from '../src/core/credits.js'

let base: Awaited<ReturnType<typeof startWsServer>>
beforeEach(async () => {
  base = await startWsServer({ ADMIN_TOKEN: 'adm-secret', RATE_LIMIT_MARKET_PUBLISH_PER_DAY: '100' })
})
afterEach(async () => { await base.close() })
const H = (t: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${t}`, ...extra })

// 直读 DB 的账户视图
const acct = (id: string) => { const a = getOrCreateAccount(base.db, id); return { locked: a.locked, available: available(a) } }
const dbListing = (id: string) => base.db.prepare('SELECT * FROM listings WHERE id=?').get(id) as any

describe('POST /v1/market/listings（demand）', () => {
  it('budget=500：burn 1 + 锁 500，escrowed_points=500，open，expires_at≈7d', async () => {
    const A = await base.mk('alice-mkt')
    await base.app.inject({ method: 'GET', url: '/v1/credits/account', headers: H(A.token) }) // 懒开户+faucet：600
    const r = await base.app.inject({
      method: 'POST', url: '/v1/market/listings', headers: H(A.token),
      payload: { kind: 'demand', title: '写爬虫', body: '抓三个站点', tags: ['crawler'], budget: 500 },
    })
    expect(r.statusCode).toBe(200)
    const j = r.json()
    expect(j.status).toBe('open')
    expect(j.escrowed_points).toBe(500)
    expect(j.budget).toBe(500)
    const a = acct('alice-mkt')
    expect(a.locked).toBe(500)
    expect(a.available).toBe(99) // 600 - 1(burn) - 500(锁定)
    const row = dbListing(j.id)
    expect(row.expires_at > new Date(Date.now() + 6.9 * 86400_000).toISOString()).toBe(true)
    expect(row.expires_at < new Date(Date.now() + 7.1 * 86400_000).toISOString()).toBe(true)
    expect(auditInvariant(base.db)).toBe(true)
  })

  it('余额不足（available=0）：INSUFFICIENT_CREDITS 且上架费未 burn（整单回滚）', async () => {
    const A = await base.mk('alice-poor'); const B = await base.mk('bob-sink')
    await base.app.inject({ method: 'GET', url: '/v1/credits/account', headers: H(A.token) })
    await base.app.inject({ method: 'GET', url: '/v1/credits/account', headers: H(B.token) })
    // 转走全部 600（费 30）→ available=0
    await base.app.inject({ method: 'POST', url: '/v1/credits/transfer', headers: H(A.token), payload: { to: 'bob-sink', points: 571 } })
    expect(acct('alice-poor').available).toBe(0)
    const before = base.db.prepare(`SELECT COUNT(*) c FROM credit_ledger WHERE agent_id='alice-poor'`).get() as any
    const r = await base.app.inject({
      method: 'POST', url: '/v1/market/listings', headers: H(A.token),
      payload: { kind: 'demand', title: 'x', body: 'y', budget: 10 },
    })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('INSUFFICIENT_CREDITS')
    const after = base.db.prepare(`SELECT COUNT(*) c FROM credit_ledger WHERE agent_id='alice-poor'`).get() as any
    expect(after.c).toBe(before.c) // 无 burn 行
    expect(auditInvariant(base.db)).toBe(true)
  })

  it('service price=50：不锁定不扣费', async () => {
    const A = await base.mk('alice-svc')
    await base.app.inject({ method: 'GET', url: '/v1/credits/account', headers: H(A.token) })
    const r = await base.app.inject({
      method: 'POST', url: '/v1/market/listings', headers: H(A.token),
      payload: { kind: 'service', title: '代码审查', body: 'PR 审查', price: 50 },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().escrowed_points).toBe(0)
    expect(r.json().price).toBe(50)
    const a = acct('alice-svc')
    expect(a.locked).toBe(0)
    expect(a.available).toBe(600)
  })
})

describe('POST 校验矩阵', () => {
  it('title 201 字节 / body >64KB → INVALID_REQUEST', async () => {
    const A = await base.mk('alice-val')
    await base.app.inject({ method: 'GET', url: '/v1/credits/account', headers: H(A.token) })
    const t1 = await base.app.inject({ method: 'POST', url: '/v1/market/listings', headers: H(A.token), payload: { kind: 'service', title: 'a'.repeat(201), body: 'b', price: 1 } })
    expect(t1.statusCode).toBe(400); expect(t1.json().error.code).toBe('INVALID_REQUEST')
    const t2 = await base.app.inject({ method: 'POST', url: '/v1/market/listings', headers: H(A.token), payload: { kind: 'service', title: 'ok', body: 'x'.repeat(65537), price: 1 } })
    expect(t2.statusCode).toBe(400); expect(t2.json().error.code).toBe('INVALID_REQUEST')
  })
  it('tags 9 个 / 25 字符 / 含大写 → TAG_INVALID', async () => {
    const A = await base.mk('alice-tag')
    await base.app.inject({ method: 'GET', url: '/v1/credits/account', headers: H(A.token) })
    const post = (tags: string[]) => base.app.inject({ method: 'POST', url: '/v1/market/listings', headers: H(A.token), payload: { kind: 'service', title: 't', body: 'b', price: 1, tags } })
    for (const tags of [[...Array(9).keys()].map(String), ['a'.repeat(25)], ['ABC']]) {
      const r = await post(tags as string[])
      expect(r.statusCode).toBe(422); expect(r.json().error.code).toBe('TAG_INVALID')
    }
  })
  it('budget 0 / 1_000_001 → PRICE_INVALID', async () => {
    const A = await base.mk('alice-px')
    await base.app.inject({ method: 'GET', url: '/v1/credits/account', headers: H(A.token) })
    for (const budget of [0, 1_000_001]) {
      const r = await base.app.inject({ method: 'POST', url: '/v1/market/listings', headers: H(A.token), payload: { kind: 'demand', title: 't', body: 'b', budget } })
      expect(r.statusCode).toBe(422); expect(r.json().error.code).toBe('PRICE_INVALID')
    }
  })
})

describe('GET /v1/market/listings', () => {
  it('kind/tag/文本/status 过滤 + 游标翻页', async () => {
    const A = await base.mk('alice-list')
    await base.app.inject({ method: 'GET', url: '/v1/credits/account', headers: H(A.token) })
    for (let i = 0; i < 5; i++)
      await base.app.inject({ method: 'POST', url: '/v1/market/listings', headers: H(A.token), payload: { kind: 'service', title: `服务 ${i}`, body: i % 2 ? 'python 自动化' : 'rust 重写', tags: ['dev'], price: 10 + i } })
    // kind 过滤
    const only = (await base.app.inject({ method: 'GET', url: '/v1/market/listings?kind=service', headers: H(A.token) })).json()
    expect(only.items).toHaveLength(5)
    // tag 过滤
    const tag = (await base.app.inject({ method: 'GET', url: '/v1/market/listings?tag=dev', headers: H(A.token) })).json()
    expect(tag.items).toHaveLength(5)
    // 文本 LIKE（body）
    const txt = (await base.app.inject({ method: 'GET', url: '/v1/market/listings?q=python', headers: H(A.token) })).json()
    expect(txt.items).toHaveLength(2)
    // status 过滤
    const st = (await base.app.inject({ method: 'GET', url: '/v1/market/listings?status=open', headers: H(A.token) })).json()
    expect(st.items).toHaveLength(5)
    // 翻页：limit=2 → 3 页
    const p1 = (await base.app.inject({ method: 'GET', url: '/v1/market/listings?limit=2', headers: H(A.token) })).json()
    expect(p1.items).toHaveLength(2); expect(p1.next_cursor).toBeTruthy()
    const p2 = (await base.app.inject({ method: 'GET', url: `/v1/market/listings?limit=2&cursor=${encodeURIComponent(p1.next_cursor)}`, headers: H(A.token) })).json()
    expect(p2.items).toHaveLength(2); expect(p2.next_cursor).toBeTruthy()
    const p3 = (await base.app.inject({ method: 'GET', url: `/v1/market/listings?limit=2&cursor=${encodeURIComponent(p2.next_cursor)}`, headers: H(A.token) })).json()
    expect(p3.items).toHaveLength(1); expect(p3.next_cursor).toBeNull()
    const ids = [...p1.items, ...p2.items, ...p3.items].map((x: any) => x.id)
    expect(new Set(ids).size).toBe(5)
    // 坏游标 → 400
    const bad = await base.app.inject({ method: 'GET', url: '/v1/market/listings?cursor=abc', headers: H(A.token) })
    expect(bad.statusCode).toBe(400)
  })
})

describe('GET/PATCH /v1/market/listings/:id', () => {
  it('GET 含 bids=[]；PATCH open 可改 title；带 price → 400；非本人 403', async () => {
    const A = await base.mk('alice-pat'); const B = await base.mk('bob-pat')
    await base.app.inject({ method: 'GET', url: '/v1/credits/account', headers: H(A.token) })
    const c = (await base.app.inject({ method: 'POST', url: '/v1/market/listings', headers: H(A.token), payload: { kind: 'service', title: 't', body: 'b', price: 5 } })).json()
    const g = await base.app.inject({ method: 'GET', url: `/v1/market/listings/${c.id}`, headers: H(A.token) })
    expect(g.statusCode).toBe(200); expect(g.json().bids).toEqual([])
    const p = await base.app.inject({ method: 'PATCH', url: `/v1/market/listings/${c.id}`, headers: H(A.token), payload: { title: '新标题' } })
    expect(p.statusCode).toBe(200); expect(p.json().title).toBe('新标题')
    const withPrice = await base.app.inject({ method: 'PATCH', url: `/v1/market/listings/${c.id}`, headers: H(A.token), payload: { title: 'x', price: 99 } })
    expect(withPrice.statusCode).toBe(400); expect(withPrice.json().error.code).toBe('INVALID_REQUEST')
    const other = await base.app.inject({ method: 'PATCH', url: `/v1/market/listings/${c.id}`, headers: H(B.token), payload: { title: 'x' } })
    expect(other.statusCode).toBe(403); expect(other.json().error.code).toBe('NOT_PARTY')
  })
  it('非 open 状态 PATCH → LISTING_NOT_OPEN', async () => {
    const A = await base.mk('alice-dl')
    await base.app.inject({ method: 'GET', url: '/v1/credits/account', headers: H(A.token) })
    const c = (await base.app.inject({ method: 'POST', url: '/v1/market/listings', headers: H(A.token), payload: { kind: 'service', title: 't', body: 'b', price: 5 } })).json()
    base.db.prepare(`UPDATE listings SET status='dealing' WHERE id=?`).run(c.id)
    const r = await base.app.inject({ method: 'PATCH', url: `/v1/market/listings/${c.id}`, headers: H(A.token), payload: { title: 'x' } })
    expect(r.statusCode).toBe(422); expect(r.json().error.code).toBe('LISTING_NOT_OPEN')
  })
})

describe('DELETE /v1/market/listings/:id', () => {
  it('本人撤 open demand：escrow 解冻回 permanent；别人的 → 403 NOT_PARTY；非 open → LISTING_NOT_OPEN', async () => {
    const A = await base.mk('alice-del'); const B = await base.mk('bob-del')
    await base.app.inject({ method: 'GET', url: '/v1/credits/account', headers: H(A.token) })
    await base.app.inject({ method: 'GET', url: '/v1/credits/account', headers: H(B.token) })
    const c = (await base.app.inject({ method: 'POST', url: '/v1/market/listings', headers: H(A.token), payload: { kind: 'demand', title: 't', body: 'b', budget: 200 } })).json()
    expect(acct('alice-del').locked).toBe(200)
    const other = await base.app.inject({ method: 'DELETE', url: `/v1/market/listings/${c.id}`, headers: H(B.token) })
    expect(other.statusCode).toBe(403); expect(other.json().error.code).toBe('NOT_PARTY')
    const r = await base.app.inject({ method: 'DELETE', url: `/v1/market/listings/${c.id}`, headers: H(A.token) })
    expect(r.statusCode).toBe(200)
    expect(dbListing(c.id).status).toBe('canceled')
    const a = acct('alice-del')
    expect(a.locked).toBe(0)
    expect(a.available).toBe(599) // 600 - 1 burn（托管全额退回）
    expect(auditInvariant(base.db)).toBe(true)
    // 再删（已 canceled 非 open）→ LISTING_NOT_OPEN
    const again = await base.app.inject({ method: 'DELETE', url: `/v1/market/listings/${c.id}`, headers: H(A.token) })
    expect(again.statusCode).toBe(422); expect(again.json().error.code).toBe('LISTING_NOT_OPEN')
  })

  it('admin force：无/错 token 403；对 token 可下架 dealing demand 且 escrow 退回、落 audit', async () => {
    const A = await base.mk('alice-adm'); await base.mk('bob-adm')
    await base.app.inject({ method: 'GET', url: '/v1/credits/account', headers: H(A.token) })
    const c = (await base.app.inject({ method: 'POST', url: '/v1/market/listings', headers: H(A.token), payload: { kind: 'demand', title: 't', body: 'b', budget: 300 } })).json()
    base.db.prepare(`UPDATE listings SET status='dealing' WHERE id=?`).run(c.id)
    const url = `/v1/market/listings/${c.id}?force=1`
    const no = await base.app.inject({ method: 'DELETE', url, headers: H(A.token) })
    expect(no.statusCode).toBe(403)
    const wrong = await base.app.inject({ method: 'DELETE', url, headers: H(A.token, { 'x-admin-token': 'nope' }) })
    expect(wrong.statusCode).toBe(403)
    // dealing 且有一条未终态 deal：force 需先 cancel deal 并退款
    base.db.prepare(`INSERT INTO deals (id, listing_id, buyer, seller, points, status, created_at, updated_at) VALUES ('deal_x', ?, 'alice-adm', 'bob-adm', 300, 'escrowed', ?, ?)`).run(c.id, new Date().toISOString(), new Date().toISOString())
    const ok = await base.app.inject({ method: 'DELETE', url, headers: H(A.token, { 'x-admin-token': 'adm-secret' }) })
    expect(ok.statusCode).toBe(200)
    expect(dbListing(c.id).status).toBe('canceled')
    const deal = base.db.prepare(`SELECT status FROM deals WHERE id='deal_x'`).get() as any
    expect(deal.status).toBe('canceled')
    const a = acct('alice-adm')
    expect(a.locked).toBe(0)
    expect(a.available).toBe(599) // 600 - 1 burn，escrow 全退
    expect(auditInvariant(base.db)).toBe(true)
    const audits = base.db.prepare(`SELECT * FROM audit_log WHERE event='market.admin_delisting'`).all() as any[]
    expect(audits).toHaveLength(1)
    expect(audits[0].actor).toBe('admin')
  })
})
