// 信用账本：账户/faucet/transfer/ledger/池 + auditInvariant fuzz（spec 2026-10-03 §1/§2.3/§6）
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { startWsServer } from './helpers/ws-server.js'
import {
  auditInvariant, getOrCreateAccount, available, creditAccount, debitAccount,
  lockPoints, unlockPoints, sweepExpiring, settlePayout, transferPoints, type Account,
} from '../src/core/credits.js'
import { RateLimiter } from '../src/core/ratelimit.js'
import type { Db } from '../src/db/sqlite.js'
import type { Config } from '../src/config.js'

let base: Awaited<ReturnType<typeof startWsServer>>
beforeEach(async () => { base = await startWsServer({}) })
afterEach(async () => { await base.close() })
const H = (t: string) => ({ authorization: `Bearer ${t}` })

describe('GET /v1/credits/account', () => {
  it('首次 GET：initial 500 + faucet 100（bonus 0），分列返回', async () => {
    const A = await base.mk('alice-cr')
    const r = await base.app.inject({ method: 'GET', url: '/v1/credits/account', headers: H(A.token) })
    expect(r.statusCode).toBe(200)
    const j = r.json()
    expect(j.permanent).toBe(500)
    expect(j.expiring).toBe(100)
    expect(j.locked).toBe(0)
    expect(j.available).toBe(600)
    expect(j.faucet.granted).toBe(100)
    expect(j.faucet.bonus).toBe(0)
  })
  it('同日再 GET：余额不变（faucet 幂等），granted=0', async () => {
    const A = await base.mk('alice-cr2')
    await base.app.inject({ method: 'GET', url: '/v1/credits/account', headers: H(A.token) })
    const r = await base.app.inject({ method: 'GET', url: '/v1/credits/account', headers: H(A.token) })
    expect(r.json().available).toBe(600)
    expect(r.json().faucet.granted).toBe(0)
  })
})

describe('POST /v1/credits/transfer', () => {
  it('A→B 100：A 减 105、B 净加 95，ledger 行与 balance_after 正确', async () => {
    const A = await base.mk('alice-tx'); const B = await base.mk('bob-tx')
    await base.app.inject({ method: 'GET', url: '/v1/credits/account', headers: H(A.token) })
    await base.app.inject({ method: 'GET', url: '/v1/credits/account', headers: H(B.token) })
    const r = await base.app.inject({ method: 'POST', url: '/v1/credits/transfer', headers: H(A.token), payload: { to: B.agent.id, points: 100, note: 'hi' } })
    expect(r.statusCode).toBe(200)
    expect(r.json().fee).toBe(5)
    const a = (await base.app.inject({ method: 'GET', url: '/v1/credits/account', headers: H(A.token) })).json()
    const b = (await base.app.inject({ method: 'GET', url: '/v1/credits/account', headers: H(B.token) })).json()
    expect(a.available).toBe(495)
    expect(b.available).toBe(695) // B 600 + 100 - 5
    const la = (await base.app.inject({ method: 'GET', url: '/v1/credits/ledger?limit=50', headers: H(A.token) })).json().items
    const rowsA = la.filter((x: any) => x.kind === 'transfer_out' || x.kind === 'burn')
    expect(rowsA.map((x: any) => x.delta).sort()).toEqual([-100, -5])
    // A 的 transfer_out 行 balance_after = 600-100=500（burn 之前）
    expect(la.find((x: any) => x.kind === 'transfer_out').balance_after).toBe(500)
    expect(la.find((x: any) => x.kind === 'burn').balance_after).toBe(495)
    const lb = (await base.app.inject({ method: 'GET', url: '/v1/credits/ledger?limit=50', headers: H(B.token) })).json().items
    expect(lb.filter((x: any) => x.kind === 'transfer_in').map((x: any) => x.delta)).toEqual([100])
    expect(lb.filter((x: any) => x.kind === 'burn').map((x: any) => x.delta)).toEqual([-5])
    expect(auditInvariant(base.db)).toBe(true)
  })
  it('给自己 → SELF_DEAL；未注册 id → AGENT_NOT_FOUND；超可用 → INSUFFICIENT_CREDITS', async () => {
    const A = await base.mk('alice-tx2')
    await base.app.inject({ method: 'GET', url: '/v1/credits/account', headers: H(A.token) })
    const self = await base.app.inject({ method: 'POST', url: '/v1/credits/transfer', headers: H(A.token), payload: { to: A.agent.id, points: 10 } })
    expect(self.statusCode).toBe(422); expect(self.json().error.code).toBe('SELF_DEAL')
    const ghost = await base.app.inject({ method: 'POST', url: '/v1/credits/transfer', headers: H(A.token), payload: { to: 'ghost.agent', points: 10 } })
    expect(ghost.statusCode).toBe(404); expect(ghost.json().error.code).toBe('AGENT_NOT_FOUND')
    const poor = await base.app.inject({ method: 'POST', url: '/v1/credits/transfer', headers: H(A.token), payload: { to: 'bob-tx2b', points: 10 } })
    expect(poor.statusCode).toBe(404) // 未注册同样 AGENT_NOT_FOUND——先于余额检查
    await base.mk('bob-tx2b')
    const over = await base.app.inject({ method: 'POST', url: '/v1/credits/transfer', headers: H(A.token), payload: { to: 'bob-tx2b', points: 600 } })
    expect(over.statusCode).toBe(422); expect(over.json().error.code).toBe('INSUFFICIENT_CREDITS')
  })
})

describe('GET /v1/market/pool 与 /v1/credits/ledger', () => {
  it('pool 初始 {balance:0}', async () => {
    const A = await base.mk('alice-pool')
    const r = await base.app.inject({ method: 'GET', url: '/v1/market/pool', headers: H(A.token) })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ balance: 0 })
  })
  it('ledger 游标分页：limit 生效、cursor 续页无重叠', async () => {
    const A = await base.mk('alice-led')
    await base.app.inject({ method: 'GET', url: '/v1/credits/account', headers: H(A.token) }) // initial+faucet 两行
    const p1 = (await base.app.inject({ method: 'GET', url: '/v1/credits/ledger?limit=1', headers: H(A.token) })).json()
    expect(p1.items).toHaveLength(1)
    expect(p1.next_cursor).toBeTruthy()
    const p2 = (await base.app.inject({ method: 'GET', url: `/v1/credits/ledger?limit=1&cursor=${p1.next_cursor}`, headers: H(A.token) })).json()
    expect(p2.items).toHaveLength(1)
    expect(p2.items[0].id).not.toBe(p1.items[0].id)
  })
})

describe('core 不变量 fuzz', () => {
  it('lock→unlock 后不变量成立（fix B1）', async () => {
    const db: Db = base.db; const cfg: Config = base.cfg
    await base.mk('lk.a'); getOrCreateAccount(db, 'lk.a', cfg) // 500
    lockPoints(db, 'lk.a', 50, 'escrow_lock', { refType: 't' })
    expect(auditInvariant(db)).toBe(true)
    unlockPoints(db, 'lk.a', 50, 'refund', { refType: 't' })
    expect(auditInvariant(db)).toBe(true)
    const a = getOrCreateAccount(db, 'lk.a', cfg)
    expect(a.locked).toBe(0)
    expect(available(a)).toBe(500) // unlock 不改变可用（锁定只是标记）
    const rows = db.prepare(`SELECT delta, kind, balance_after FROM credit_ledger WHERE agent_id='lk.a' ORDER BY id`).all() as any[]
    expect(rows.map(r => [r.kind, r.delta])).toEqual([['initial', 500], ['escrow_lock', -50], ['refund', 50]])
  })
  it('退款回永久桶：expiring 占满余额时 lock→unlock，金额落 permanent、expiring 等额减少（fix-1 Major-2）', async () => {
    const db: Db = base.db; const cfg: Config = base.cfg
    await base.mk('rf.a')
    // 余额全部放 expiring 桶（grant 入 expiring；initial 500 已在 permanent，直接 debit 掉）
    creditAccount(db, 'rf.a', 'grant', 300, { bucket: 'expiring' }, cfg)
    debitAccount(db, 'rf.a', 'burn', 500, { refType: 't' })
    const a0 = getOrCreateAccount(db, 'rf.a', cfg)
    expect(a0.permanent).toBe(0); expect(a0.expiring).toBe(300)
    lockPoints(db, 'rf.a', 200, 'escrow_lock', { refType: 't' })
    unlockPoints(db, 'rf.a', 200, 'refund', { refType: 't' })
    const a = getOrCreateAccount(db, 'rf.a', cfg)
    expect(a.locked).toBe(0)
    expect(a.permanent).toBe(200) // 退款落 permanent
    expect(a.expiring).toBe(100) // expiring 等额减少
    expect(available(a)).toBe(300) // 可用不变
    expect(auditInvariant(db)).toBe(true)
  })
  it('settlePayout 后不变量成立；买方无新 delta 行、lock 行 balance_after 即结算后可用（fix B2/B3）', async () => {
    const db: Db = base.db; const cfg: Config = base.cfg
    await base.mk('pay.buy'); await base.mk('pay.sel')
    getOrCreateAccount(db, 'pay.buy', cfg) // 500
    lockPoints(db, 'pay.buy', 60, 'escrow_lock', { refType: 'deal', refId: 'd1' })
    const lockRow = db.prepare(`SELECT balance_after FROM credit_ledger WHERE agent_id='pay.buy' AND kind='escrow_lock'`).get() as any
    const { payout, commission } = settlePayout(db, 'pay.buy', 'pay.sel', 60, 5, 'd1', cfg)
    expect(payout).toBe(57); expect(commission).toBe(3)
    expect(auditInvariant(db)).toBe(true)
    // 买方只有 initial + escrow_lock 两行——结算不新增 delta（spec §1）
    const buyerRows = db.prepare(`SELECT kind, delta, balance_after FROM credit_ledger WHERE agent_id='pay.buy' ORDER BY id`).all() as any[]
    expect(buyerRows.map(r => [r.kind, r.delta])).toEqual([['initial', 500], ['escrow_lock', -60]])
    expect(buyerRows[1].balance_after).toBe(440) // 与 lock 行同值：可用在结算前后不变
    expect(lockRow.balance_after).toBe(440)
    const s = getOrCreateAccount(db, 'pay.sel', cfg)
    expect(s.permanent).toBe(557)
    expect((db.prepare('SELECT balance FROM credit_pool WHERE id=1').get() as any).balance).toBe(3)
    expect(auditInvariant(db)).toBe(true)
  })
  it('随机 20 步（transfer/锁/解锁/结算/入账/扣账/清扫）每步 auditInvariant 恒真', async () => {
    const db: Db = base.db; const cfg: Config = base.cfg
    const ids = ['fz.a', 'fz.b', 'fz.c'].map(id => id) // 3 字符起满足 id 正则
    for (const id of ids) await base.mk(id)
    for (const id of ids) getOrCreateAccount(db, id, cfg)
    const locked = new Map<string, number>(ids.map(id => [id, 0]))
    let seed = 42
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
    for (let i = 0; i < 20; i++) {
      const id = ids[Math.floor(rnd() * ids.length)]
      const amt = 1 + Math.floor(rnd() * 50)
      try {
        const op = Math.floor(rnd() * 7)
        if (op === 0) { const to = ids[Math.floor(rnd() * ids.length)]; if (to !== id) transferPoints(db, cfg, id, to, amt) }
        else if (op === 1) { lockPoints(db, id, amt, 'escrow_lock', { refType: 'fuzz' }); locked.set(id, locked.get(id)! + amt) }
        else if (op === 2) { if (locked.get(id)! >= amt) { unlockPoints(db, id, amt, 'escrow_release', {}); locked.set(id, locked.get(id)! - amt) } }
        else if (op === 3) { // settle：从有锁的账户结给随机对手
          const buyer = ids.find(x => locked.get(x)! >= amt)
          if (buyer) { const seller = ids.find(x => x !== buyer)!; settlePayout(db, buyer, seller, amt, 5, 'fz', cfg); locked.set(buyer, locked.get(buyer)! - amt) }
        }
        else if (op === 4) creditAccount(db, id, 'grant', amt, { bucket: 'expiring', ttlHours: 1 }, cfg)
        else if (op === 5) debitAccount(db, id, 'burn', amt, {})
        else sweepExpiring(db, new Date(Date.now() + 10 * 3600_000))
      } catch { /* INSUFFICIENT_CREDITS 等合法拒绝，跳过 */ }
      expect(auditInvariant(db)).toBe(true)
    }
  })
})

describe('市场日桶限频', () => {
  it('checkMarketPublish 超 5/日抛 RATE_LIMITED，带 retry-after', () => {
    const l = new RateLimiter(base.cfg.rate)
    for (let i = 0; i < 5; i++) l.checkMarketPublish('a.daily')
    expect(() => l.checkMarketPublish('a.daily')).toThrowError(/rate limited/)
    l.checkMarketBid('a.daily'); l.checkMarketCounter('a.daily') // 三桶互不影响
  })
})
