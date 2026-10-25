// 信用账本（spec 2026-10-03-credit-marketplace-design.md §1/§2.3/§6/§7）：
// credit_accounts 三列余额 + credit_ledger 每行带 balance_after 快照；
// 不变量 permanent+expiring-locked = sum(delta)（含 '_pool' 虚拟账户）由 auditInvariant 对账。
import type { Db } from '../db/sqlite.js'
import type { Config } from '../config.js'
import { newId } from './ids.js'
import { AppError, Errors } from '../http/errors.js'

export interface Account {
  agent_id: string; permanent: number; expiring: number; expiring_expires_at: string | null
  locked: number; last_faucet_date: string | null
}
export type LedgerKind =
  | 'faucet' | 'grant' | 'initial' | 'escrow_lock' | 'escrow_release' | 'escrow_extra'
  | 'payout' | 'commission' | 'burn' | 'transfer_in' | 'transfer_out' | 'expiry' | 'refund'

export const POOL_ID = '_pool'
// cfg 缺席时的兜底（与 config.ts market 默认值一致；有 cfg 时一律读 cfg.market）
export const MAX_BALANCE = 10_000_000
const DEFAULT_INITIAL = 500 // cfg 缺席时的开户赠予（与 FAUCET_INITIAL 默认一致）

export interface LedgerOpts { bucket?: 'permanent' | 'expiring' | 'pool'; refType?: string; refId?: string; note?: string; ttlHours?: number }
export interface RefOpts { refType?: string; refId?: string; note?: string }

export function getOrCreateAccount(db: Db, agentId: string, cfg?: Config): Account {
  const row = db.prepare('SELECT agent_id, permanent, expiring, expiring_expires_at, locked, last_faucet_date FROM credit_accounts WHERE agent_id=?').get(agentId) as Account | undefined
  if (row) return row
  const initial = cfg ? cfg.market.faucetInitial : DEFAULT_INITIAL
  db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO credit_accounts (agent_id, permanent, expiring, locked, created_at) VALUES (?, ?, 0, 0, ?)')
      .run(agentId, 0, new Date().toISOString())
    if ((db.prepare('SELECT changes() c').get() as { c: number }).c === 0) return // 行已存在（并发插入）：不再记 initial
    creditKnown(db, agentId, 'initial', initial, { bucket: 'permanent' }, cfg)
  })()
  return db.prepare('SELECT agent_id, permanent, expiring, expiring_expires_at, locked, last_faucet_date FROM credit_accounts WHERE agent_id=?').get(agentId) as Account
}

export function available(a: Account): number { return a.permanent + a.expiring - a.locked }

function insertLedger(db: Db, agentId: string, delta: number, kind: LedgerKind, o: RefOpts, balanceAfter: number): void {
  db.prepare('INSERT INTO credit_ledger (id, agent_id, delta, kind, ref_type, ref_id, balance_after, note, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(newId('led'), agentId, delta, kind, o.refType ?? null, o.refId ?? null, balanceAfter, o.note ?? null, new Date().toISOString())
}

// creditAccount 的内部路径：不递归 getOrCreate（懒创建在入口已做）
function creditKnown(db: Db, agentId: string, kind: LedgerKind, amount: number, o: LedgerOpts, cfg?: Config): void {
  const now = new Date()
  if (o.bucket === 'pool') {
    db.prepare('UPDATE credit_pool SET balance = balance + ?, updated_at = ? WHERE id = 1').run(amount, now.toISOString())
    const pool = db.prepare('SELECT balance FROM credit_pool WHERE id = 1').get() as { balance: number }
    insertLedger(db, POOL_ID, amount, kind, o, pool.balance)
    return
  }
  const a = getRaw(db, agentId)
  const maxBalance = cfg ? cfg.market.maxBalance : MAX_BALANCE
  if (amount > 0 && available(a) + amount > maxBalance)
    throw Errors.unprocessable('MARKET_BALANCE_OVERFLOW', 'account balance cap exceeded')
  if (o.bucket === 'expiring') {
    // TTL 只延不缩：新到期时间与旧值取大
    const next = new Date(now.getTime() + (o.ttlHours ?? 2160) * 3600_000).toISOString()
    const expires = !a.expiring_expires_at || next > a.expiring_expires_at ? next : a.expiring_expires_at
    db.prepare('UPDATE credit_accounts SET expiring = expiring + ?, expiring_expires_at = ? WHERE agent_id = ?').run(amount, expires, agentId)
  } else {
    db.prepare('UPDATE credit_accounts SET permanent = permanent + ? WHERE agent_id = ?').run(amount, agentId)
  }
  insertLedger(db, agentId, amount, kind, o, available(getRaw(db, agentId)))
}

function getRaw(db: Db, agentId: string): Account {
  return db.prepare('SELECT agent_id, permanent, expiring, expiring_expires_at, locked, last_faucet_date FROM credit_accounts WHERE agent_id=?').get(agentId) as Account
}

export function creditAccount(db: Db, agentId: string, kind: LedgerKind, amount: number, o: LedgerOpts = {}, cfg?: Config): void {
  getOrCreateAccount(db, agentId, cfg) // 懒开户：任何入账方无行则先建 + initial（spec §6 懒开户规则）
  creditKnown(db, agentId, kind, amount, o, cfg)
}

export function debitAccount(db: Db, agentId: string, kind: LedgerKind, amount: number, o: RefOpts = {}): void {
  const a = getOrCreateAccount(db, agentId)
  if (available(a) < amount) throw Errors.unprocessable('INSUFFICIENT_CREDITS', 'insufficient credits')
  // 扣款顺序：permanent 优先，不足部分扣 expiring（spec §1）
  const fromPermanent = Math.min(a.permanent, amount)
  const fromExpiring = amount - fromPermanent
  db.prepare('UPDATE credit_accounts SET expiring = expiring - ?, permanent = permanent - ? WHERE agent_id = ?')
    .run(fromExpiring, fromPermanent, agentId)
  insertLedger(db, agentId, -amount, kind, o, available(getRaw(db, agentId)))
}

export function lockPoints(db: Db, agentId: string, amount: number, kind: LedgerKind, o: RefOpts = {}): void {
  const a = getOrCreateAccount(db, agentId)
  if (available(a) < amount) throw Errors.unprocessable('INSUFFICIENT_CREDITS', 'insufficient credits')
  db.prepare('UPDATE credit_accounts SET locked = locked + ? WHERE agent_id = ?').run(amount, agentId)
  insertLedger(db, agentId, -amount, kind, o, available(getRaw(db, agentId)))
}

// 解冻：locked−=amount，退回金额一律落 permanent（spec §1 Ruling：退款不区分原桶）——
// expiring 等额结转进 permanent（P+E 不变），不变量不受影响；写一行 delta=+amount 抵消 lock 行的负记账
export function unlockPoints(db: Db, agentId: string, amount: number, kind: LedgerKind, o: RefOpts = {}): void {
  const a = getOrCreateAccount(db, agentId)
  if (a.locked < amount) throw Errors.unprocessable('INSUFFICIENT_CREDITS', 'locked below unlock amount')
  // 退款金额中落在 expiring 桶的部分等额结转进 permanent（不区分原桶、不参与到期清扫）；
  // 结转量取 min(expiring, amount)——超出部分本就在 permanent，P+E 保持不变，§7 不变量恒成立
  const moved = Math.min(a.expiring, amount)
  db.prepare('UPDATE credit_accounts SET locked = locked - ?, permanent = permanent + ?, expiring = expiring - ? WHERE agent_id = ?')
    .run(amount, moved, moved, agentId)
  insertLedger(db, agentId, amount, kind, o, available(getRaw(db, agentId)))
}

// 成交结算：买方 P/E 与 locked 各扣 points；卖方 permanent += payout；池吃佣金。
// 单事务——卖方 MARKET_BALANCE_OVERFLOW 抛错则整体回滚，调用方保持 deal 不结算由 scanner 重试（brief T2）
export function settlePayout(db: Db, buyer: string, seller: string, points: number, commissionPct: number, refId: string, cfg?: Config): { payout: number; commission: number } {
  const commission = Math.floor(points * commissionPct / 100)
  const payout = points - commission
  db.transaction(() => {
    const b = getOrCreateAccount(db, buyer)
    if (b.locked < points) throw Errors.unprocessable('INSUFFICIENT_CREDITS', 'buyer lock below payout')
    // 余额充足以 P+E 计：托管锁会压低 available（=P+E−locked），按 available 判会把"钱都锁着"的正常成交误判为不足（T5 发现）
    if (b.permanent + b.expiring < points) throw Errors.unprocessable('INSUFFICIENT_CREDITS', 'buyer funds below payout')
    // 买方无新 delta 行——lock 行已把可用记负，本步只是列间结转（spec §1"放款"，fix B2）
    const fromPermanent = Math.min(b.permanent, points)
    db.prepare('UPDATE credit_accounts SET expiring = expiring - ?, permanent = permanent - ?, locked = locked - ? WHERE agent_id = ?')
      .run(points - fromPermanent, fromPermanent, points, buyer)
    getOrCreateAccount(db, seller, cfg)
    creditKnown(db, seller, 'payout', payout, { bucket: 'permanent', refType: 'deal', refId }, cfg)
    creditKnown(db, POOL_ID, 'commission', commission, { bucket: 'pool', refType: 'deal', refId })
  })()
  return { payout, commission }
}

// 每日 faucet：UTC 日期幂等；bonus = min(faucetRepCap, 5*acceptedDeals)；入 expiring 桶 TTL 90 天
export function claimFaucet(db: Db, cfg: Config, agentId: string, acceptedDeals: number): { granted: number; bonus: number } {
  const today = new Date().toISOString().slice(0, 10)
  const a = getOrCreateAccount(db, agentId, cfg)
  if (a.last_faucet_date === today) return { granted: 0, bonus: 0 }
  const bonus = Math.min(cfg.market.faucetRepCap, 5 * acceptedDeals)
  const granted = cfg.market.faucetDaily
  db.transaction(() => {
    creditKnown(db, agentId, 'faucet', granted + bonus, { bucket: 'expiring', ttlHours: 2160 }, cfg)
    db.prepare('UPDATE credit_accounts SET last_faucet_date = ? WHERE agent_id = ?').run(today, agentId)
  })()
  return { granted, bonus }
}

// 转账（方案甲，brief T2 Ruling）：fee = ceil(points*transferFeePct/100)；
// from 记 transfer_out(-points)+burn(-fee)；to 记 transfer_in(+points)+burn(-fee)；共销毁 2×fee
export function transferPoints(db: Db, cfg: Config, from: string, to: string, points: number, note?: string): void {
  if (!Number.isInteger(points) || points < 1 || points > cfg.market.maxPointsPerTx)
    throw Errors.unprocessable('PRICE_INVALID', 'points out of range')
  if (from === to) throw Errors.unprocessable('SELF_DEAL', 'cannot transfer to self')
  if (!db.prepare('SELECT id FROM agents WHERE id = ?').get(to)) throw new AppError('AGENT_NOT_FOUND', 404, 'agent not found')
  const fee = Math.ceil(points * cfg.market.transferFeePct / 100)
  db.transaction(() => {
    getOrCreateAccount(db, to, cfg)
    debitAccount(db, from, 'transfer_out', points, { note })
    debitAccount(db, from, 'burn', fee, { note })
    creditKnown(db, to, 'transfer_in', points, { bucket: 'permanent', note }, cfg)
    debitAccount(db, to, 'burn', fee, { note })
  })()
}

// 过期清扫：expiring 中未被 locked 覆盖的部分清零 + expiry 行；返回清扫账户数
export function sweepExpiring(db: Db, now: Date): number {
  const nowIso = now.toISOString()
  const rows = db.prepare(`SELECT agent_id, expiring, locked FROM credit_accounts WHERE expiring > 0 AND expiring_expires_at IS NOT NULL AND expiring_expires_at <= ?`).all(nowIso) as { agent_id: string; expiring: number; locked: number }[]
  let swept = 0
  for (const r of rows) {
    const keep = Math.min(r.expiring, r.locked) // 锁定仍需余额支撑，只清超额部分
    const excess = r.expiring - keep
    if (excess <= 0) continue
    db.transaction(() => {
      db.prepare('UPDATE credit_accounts SET expiring = ? WHERE agent_id = ?').run(keep, r.agent_id)
      insertLedger(db, r.agent_id, -excess, 'expiry', {}, available(getRaw(db, r.agent_id)))
    })()
    swept++
  }
  return swept
}

// 全账本对账：每账户及池 permanent+expiring-locked（池为 balance）= sum(delta)
export function auditInvariant(db: Db): boolean {
  const accts = db.prepare('SELECT agent_id, permanent, expiring, locked FROM credit_accounts').all() as { agent_id: string; permanent: number; expiring: number; locked: number }[]
  const sums = new Map<string, number>()
  for (const r of db.prepare('SELECT agent_id, SUM(delta) s FROM credit_ledger GROUP BY agent_id').all() as { agent_id: string; s: number }[])
    sums.set(r.agent_id, r.s)
  for (const a of accts) {
    if (a.permanent + a.expiring - a.locked !== (sums.get(a.agent_id) ?? 0)) return false
  }
  const pool = db.prepare('SELECT balance FROM credit_pool WHERE id = 1').get() as { balance: number }
  return pool.balance === (sums.get(POOL_ID) ?? 0)
}
