// 市场挂牌 listings（spec 2026-10-03 §2.1/§2.2/§2.4/§3）：demand 托管上架、service 一口价、
// 撤牌退 escrow、admin force 下架；bids/deals 选标/直购/议价成交、交付/验收/取消（T4/T5）。
import type { Db } from '../db/sqlite.js'
import type { Config } from '../config.js'
import type { Bus } from './bus.js'
import { newId } from './ids.js'
import { AppError, Errors } from '../http/errors.js'
import { audit } from './audit.js'
import { available, debitAccount, getOrCreateAccount, lockPoints, unlockPoints, settlePayout, sweepExpiring } from './credits.js'
import { getAgent } from './agents.js'
import { createTask } from './tasks.js'
import { insertDerived } from './derive.js'

export type ListingKind = 'demand' | 'service'
export interface Bid { id: string; listing_id: string; agent_id: string; points: number; body: string; status: string; counter_rounds: number; created_at: string; updated_at: string }
export interface Listing {
  id: string; kind: ListingKind; publisher: string; title: string; body: string; tags: string[]
  status: 'open' | 'dealing' | 'done' | 'canceled' | 'expired'
  budget: number | null; price: number | null; escrowed_points: number
  expires_at: string; created_at: string
}

const TITLE_MAX = 200 // 字节（spec §3：title ≤200 字节，文本一律 Buffer.byteLength）
const BODY_MAX = 65_536
const TAG_RE = /^[a-z0-9][a-z0-9._-]{0,23}$/ // 小写、≤24 字符（spec §1）

export interface ListingInput { kind: ListingKind; title: string; body: string; tags?: string[]; budget?: number; price?: number; days?: number }

function checkText(title: string, body: string): void {
  if (typeof title !== 'string' || Buffer.byteLength(title) < 1 || Buffer.byteLength(title) > TITLE_MAX)
    throw Errors.invalidRequest(`title 长度（字节）须在 1..${TITLE_MAX}`)
  if (typeof body !== 'string' || Buffer.byteLength(body) > BODY_MAX)
    throw Errors.invalidRequest(`body 超过 ${BODY_MAX} 字节上限`)
}

function checkTags(tags: string[] | undefined): string[] {
  if (tags === undefined) return []
  if (!Array.isArray(tags) || tags.length > 8) throw Errors.unprocessable('TAG_INVALID', 'tags 最多 8 项')
  for (const t of tags)
    if (typeof t !== 'string' || !TAG_RE.test(t)) throw Errors.unprocessable('TAG_INVALID', `非法 tag: ${t}（小写 [a-z0-9._-] ≤24）`)
  return tags
}

function checkPoints(n: number | undefined, cfg: Config): number {
  if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > cfg.market.maxPointsPerTx)
    throw Errors.unprocessable('PRICE_INVALID', 'points out of range')
  return n as number
}

function rowToListing(r: Record<string, unknown>): Listing {
  return { ...r, tags: JSON.parse(r.tags as string) } as unknown as Listing
}

export function createListing(db: Db, cfg: Config, publisher: string, input: ListingInput): Listing {
  if (input.kind !== 'demand' && input.kind !== 'service') throw Errors.invalidRequest('kind 须为 demand|service')
  checkText(input.title, input.body)
  const tags = checkTags(input.tags)
  const days = input.days ?? cfg.market.listingDays
  if (!Number.isInteger(days) || days < 1 || days > 30) throw Errors.invalidRequest('days 须为 1..30')
  const id = newId('lst')
  const now = new Date()
  const expiresAt = new Date(now.getTime() + days * 86400_000).toISOString()
  let budget: number | null = null; let price: number | null = null
  if (input.kind === 'demand') budget = checkPoints(input.budget, cfg)
  else price = checkPoints(input.price, cfg)
  db.transaction(() => {
    if (input.kind === 'demand') {
      // 上架费 1 点 burn + 托管冻结 min(budget, 可用)：同一事务，缺额抛错则 burn 一并回滚
      debitAccount(db, publisher, 'burn', 1, { refType: 'listing', refId: id })
      const a = getOrCreateAccount(db, publisher)
      const escrow = Math.min(budget as number, available(a))
      lockPoints(db, publisher, escrow, 'escrow_lock', { refType: 'listing', refId: id })
      db.prepare('INSERT INTO listings (id, kind, publisher, title, body, tags, status, budget, price, escrowed_points, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, input.kind, publisher, input.title, input.body, JSON.stringify(tags), 'open', budget, null, escrow, expiresAt, now.toISOString())
    } else {
      db.prepare('INSERT INTO listings (id, kind, publisher, title, body, tags, status, budget, price, escrowed_points, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, input.kind, publisher, input.title, input.body, JSON.stringify(tags), 'open', null, price, 0, expiresAt, now.toISOString())
    }
  })()
  return rowToListing(db.prepare('SELECT * FROM listings WHERE id=?').get(id) as Record<string, unknown>)
}

// 复合游标 `${created_at}|${id}`（ISO 无 '|'）：listings/ledger/deals 分页共用模式
function decodeCursor(cursor: string): { createdAt: string; id: string } {
  const parts = cursor.split('|')
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw Errors.invalidRequest('bad cursor')
  return { createdAt: parts[0], id: parts[1] }
}

export function listListings(db: Db, q: { kind?: ListingKind; tag?: string; text?: string; status?: string; cursor?: string; limit?: number }): { items: Listing[]; next_cursor: string | null } {
  const limit = Math.min(Math.max(q.limit ?? 20, 1), 50)
  const where: string[] = []; const args: unknown[] = []
  if (q.kind) { where.push('kind = ?'); args.push(q.kind) }
  if (q.status) { where.push('status = ?'); args.push(q.status) }
  if (q.tag) { where.push('EXISTS (SELECT 1 FROM json_each(listings.tags) WHERE value = ?)'); args.push(q.tag) }
  if (q.text) { where.push('(title LIKE ? OR body LIKE ?)'); args.push(`%${q.text}%`, `%${q.text}%`) }
  if (q.cursor) {
    const c = decodeCursor(q.cursor)
    where.push('(created_at < ? OR (created_at = ? AND id < ?))')
    args.push(c.createdAt, c.createdAt, c.id)
  }
  const sql = `SELECT * FROM listings${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, id DESC LIMIT ?`
  const rows = db.prepare(sql).all(...args, limit + 1) as Record<string, unknown>[]
  const items = rows.slice(0, limit).map(rowToListing)
  const next_cursor = rows.length > limit ? `${items[items.length - 1].created_at}|${items[items.length - 1].id}` : null
  return { items, next_cursor }
}

export function getListing(db: Db, id: string): { listing: Listing; bids: Bid[] } {
  const row = db.prepare('SELECT * FROM listings WHERE id=?').get(id) as Record<string, unknown> | undefined
  if (!row) throw Errors.notFound('listing not found')
  const bids = db.prepare('SELECT * FROM bids WHERE listing_id=? ORDER BY created_at ASC, id ASC').all(id) as unknown as Bid[]
  return { listing: rowToListing(row), bids }
}

function getBid(db: Db, id: string): { bid: Record<string, unknown>; listing: Record<string, unknown> } {
  const bid = db.prepare('SELECT * FROM bids WHERE id=?').get(id) as Record<string, unknown> | undefined
  if (!bid) throw Errors.notFound('bid not found')
  const listing = db.prepare('SELECT * FROM listings WHERE id=?').get(bid.listing_id as string) as Record<string, unknown>
  return { bid, listing }
}

// 投标（spec §2.1/§2.2/§3）：demand+open 与 service+open 均可——service 上买家 bid 即议价记录
// （buy 前一轮还价，T5 acceptServiceBid 消费）；自投 SELF_DEAL；每 bid burn 1；不锁钱（成交时才结算）。
export function createBid(db: Db, cfg: Config, bus: Bus, listingId: string, bidder: string, input: { points: number; body: string }): Bid {
  const row = db.prepare('SELECT * FROM listings WHERE id=?').get(listingId) as Record<string, unknown> | undefined
  if (!row) throw Errors.notFound('listing not found')
  if (row.status !== 'open') throw Errors.unprocessable('LISTING_NOT_OPEN', 'listing not open')
  if (row.publisher === bidder) throw Errors.unprocessable('SELF_DEAL', 'cannot bid on own listing')
  const points = checkPoints(input.points, cfg)
  if (typeof input.body !== 'string' || Buffer.byteLength(input.body) > BODY_MAX)
    throw Errors.invalidRequest(`body 超过 ${BODY_MAX} 字节上限`)
  const id = newId('bid')
  const now = new Date().toISOString()
  db.transaction(() => {
    debitAccount(db, bidder, 'burn', 1, { refType: 'bid', refId: id }) // 投标费，缺额整单回滚
    db.prepare('INSERT INTO bids (id, listing_id, agent_id, points, body, status, counter_rounds, created_at, updated_at) VALUES (?,?,?,?,?,?,?, ?,?)')
      .run(id, listingId, bidder, points, input.body, 'pending', 0, now, now)
  })()
  emitMarket(bus, row.publisher as string, 'bid_new', id)
  return db.prepare('SELECT * FROM bids WHERE id=?').get(id) as unknown as Bid
}

// 议价（spec §2.1/§2.2）：demand pending ↔ countered 多轮（cfg.market.counterMaxRounds）；
// service 仅单轮（买家的 bid 记录由挂牌人 counter 一次，rounds+1>1 → TOO_MANY_ROUNDS）。
// 轮次奇偶定出手方（bid 创建记买家一方，故偶数轮（含 pending 的第 1 轮）由挂牌人 counter，奇数轮由 bid 主）；不锁钱。
export function counterBid(db: Db, cfg: Config, bus: Bus, bidId: string, actor: string, input: { points: number; body: string }): Bid {
  const { bid, listing } = getBid(db, bidId)
  if (listing.status !== 'open') throw Errors.unprocessable('LISTING_NOT_OPEN', 'listing not open') // T4-m1：dealing/expired 后不得再议价
  if (bid.status !== 'pending' && bid.status !== 'countered')
    throw Errors.unprocessable('BID_CLOSED', 'bid not pending/countered')
  const bidder = bid.agent_id as string
  const publisher = listing.publisher as string
  if (actor !== bidder && actor !== publisher) throw new AppError('NOT_PARTY', 403, 'not bid party')
  const rounds = bid.counter_rounds as number
  // service 议价单轮；demand 用 cfg.market.counterMaxRounds。先查轮次上限再查交替——
  // service 第二轮无论哪方出手一律 TOO_MANY_ROUNDS（ruling fix round 1）
  const maxRounds = listing.kind === 'service' ? 1 : cfg.market.counterMaxRounds
  if (rounds + 1 > maxRounds) throw Errors.unprocessable('TOO_MANY_ROUNDS', `counter rounds > ${maxRounds}`)
  const expected = rounds % 2 === 0 ? publisher : bidder // 交替：连续两轮同一方 → INVALID_REQUEST
  if (actor !== expected) throw Errors.invalidRequest('连续两轮同一方，须轮到对方 counter')
  const points = checkPoints(input.points, cfg)
  if (typeof input.body !== 'string' || Buffer.byteLength(input.body) > BODY_MAX)
    throw Errors.invalidRequest(`body 超过 ${BODY_MAX} 字节上限`)
  db.prepare(`UPDATE bids SET points=?, body=?, status='countered', counter_rounds=?, updated_at=? WHERE id=?`)
    .run(points, input.body, rounds + 1, new Date().toISOString(), bidId)
  emitMarket(bus, actor === publisher ? bidder : publisher, 'bid_decided', bidId)
  return db.prepare('SELECT * FROM bids WHERE id=?').get(bidId) as unknown as Bid
}

// withdraw（仅 bid 主）/ reject（仅挂牌人）；非 pending/countered → BID_CLOSED。accept 在 T5。
export function decideBid(db: Db, bus: Bus, bidId: string, actor: string, op: 'withdraw' | 'reject'): Bid {
  const { bid, listing } = getBid(db, bidId)
  if (bid.status !== 'pending' && bid.status !== 'countered')
    throw Errors.unprocessable('BID_CLOSED', 'bid not pending/countered')
  const bidder = bid.agent_id as string
  const publisher = listing.publisher as string
  if (op === 'withdraw') {
    if (actor !== bidder) throw new AppError('NOT_PARTY', 403, 'not bid owner')
  } else {
    if (actor !== publisher) throw new AppError('NOT_PARTY', 403, 'not listing publisher')
  }
  const status = op === 'withdraw' ? 'withdrawn' : 'rejected'
  db.prepare('UPDATE bids SET status=?, updated_at=? WHERE id=?').run(status, new Date().toISOString(), bidId)
  emitMarket(bus, actor === publisher ? bidder : publisher, 'bid_decided', bidId)
  return db.prepare('SELECT * FROM bids WHERE id=?').get(bidId) as unknown as Bid
}

export function patchListing(db: Db, id: string, actor: string, input: { title?: string; body?: string; tags?: string[] }): Listing {
  const row = db.prepare('SELECT * FROM listings WHERE id=?').get(id) as Record<string, unknown> | undefined
  if (!row) throw Errors.notFound('listing not found')
  if (row.publisher !== actor) throw new AppError('NOT_PARTY', 403, 'not listing publisher')
  if (row.status !== 'open') throw Errors.unprocessable('LISTING_NOT_OPEN', 'listing not open')
  const title = input.title ?? (row.title as string)
  const body = input.body ?? (row.body as string)
  checkText(title, body)
  const tags = input.tags !== undefined ? checkTags(input.tags) : JSON.parse(row.tags as string)
  db.prepare('UPDATE listings SET title=?, body=?, tags=? WHERE id=?').run(title, body, JSON.stringify(tags), id)
  return rowToListing(db.prepare('SELECT * FROM listings WHERE id=?').get(id) as Record<string, unknown>)
}

export function deleteListing(db: Db, _cfg: Config, id: string, actor: string, opts: { adminForce?: boolean } = {}): void {
  const row = db.prepare('SELECT * FROM listings WHERE id=?').get(id) as Record<string, unknown> | undefined
  if (!row) throw Errors.notFound('listing not found')
  const force = opts.adminForce === true
  if (!force && row.publisher !== actor) throw new AppError('NOT_PARTY', 403, 'not listing publisher')
  const now = new Date().toISOString()
  db.transaction(() => {
    if (force) {
      // dealing：仅自动 cancel escrowed deal（退 escrow）；delivered 不动——由 accept/自动验收走放款结算；
      // done 不可逆保持原状（T5 fix-1：cancel 口径收紧为 escrowed-only）
      if (row.status === 'dealing') {
        const deals = db.prepare(`SELECT * FROM deals WHERE listing_id=? AND status='escrowed'`).all(id) as { id: string; buyer: string; points: number }[]
        for (const d of deals) {
          unlockPoints(db, d.buyer, d.points, 'refund', { refType: 'deal', refId: d.id })
          db.prepare(`UPDATE deals SET status='canceled', updated_at=? WHERE id=?`).run(now, d.id)
        }
        // 仍被 live deal 占用的托管（escrowed 已退款；delivered 保留——由 accept/自动验收结算）
        const refunded = (deals as { points: number }[]).reduce((s, d) => s + d.points, 0)
        const heldByDelivered = (db.prepare(`SELECT COALESCE(SUM(points),0) s FROM deals WHERE listing_id=? AND status='delivered'`).get(id) as { s: number }).s
        const remainder = (row.escrowed_points as number) - refunded - heldByDelivered
        if (remainder > 0) unlockPoints(db, row.publisher as string, remainder, 'escrow_release', { refType: 'listing', refId: id })
      } else if (row.status !== 'done' && (row.escrowed_points as number) > 0) {
        unlockPoints(db, row.publisher as string, row.escrowed_points as number, 'escrow_release', { refType: 'listing', refId: id })
      }
      if (row.status !== 'done') db.prepare(`UPDATE listings SET status='canceled' WHERE id=?`).run(id)
      audit(db, 'admin', 'market.admin_delisting', { listing_id: id, kind: row.kind, publisher: row.publisher, prev_status: row.status })
      return
    }
    // 本人撤牌：仅 open 可撤
    if (row.status !== 'open') throw Errors.unprocessable('LISTING_NOT_OPEN', 'listing not open')
    if ((row.escrowed_points as number) > 0)
      unlockPoints(db, row.publisher as string, row.escrowed_points as number, 'escrow_release', { refType: 'listing', refId: id })
    db.prepare(`UPDATE listings SET status='canceled' WHERE id=?`).run(id)
  })()
}

// ---------------------------------------------------------------------------
// deals 成交全链路（spec §2.1/§2.2/§2.4）：demand 选标、service 直购/议价成交、
// deliver→accept 放款、cancel 全额退款。deal 状态机是唯一权威，派生 task 只是协作载体。

export interface Deal {
  id: string; listing_id: string; buyer: string; seller: string; points: number
  status: 'escrowed' | 'delivered' | 'accepted' | 'canceled'
  auto_accept_at: string | null; task_id: string | null
  created_at: string; updated_at: string
}

const rowToDeal = (r: Record<string, unknown>): Deal => ({ ...r } as unknown as Deal)

export function getDeal(db: Db, id: string): Deal {
  const r = db.prepare('SELECT * FROM deals WHERE id=?').get(id) as Record<string, unknown> | undefined
  if (!r) throw Errors.notFound('deal not found')
  return rowToDeal(r)
}

function getListingRow(db: Db, id: string): Listing {
  const r = db.prepare('SELECT * FROM listings WHERE id=?').get(id) as Record<string, unknown> | undefined
  if (!r) throw Errors.notFound('listing not found')
  return rowToListing(r)
}

function getBidRow(db: Db, id: string): Bid {
  const r = db.prepare('SELECT * FROM bids WHERE id=?').get(id) as Record<string, unknown> | undefined
  if (!r) throw Errors.notFound('bid not found')
  return r as unknown as Bid
}

// task_policy 预检（spec §2.1 Ruling）：与 core/tasks.ts createTask 同款判定——
// mode=closed 或 allowlist 不含 requester → TASK_POLICY_CLOSED。预检必须在建 deal 前完成，
// 否则 createTask 会落一个 REJECTED task 行且买方资金已动。
function checkPolicy(db: Db, executorId: string, requesterId: string): void {
  const policy = getAgent(db, executorId).task_policy
  if (policy.mode === 'closed' || (policy.mode === 'allowlist' && !policy.allowlist.includes(requesterId)))
    throw Errors.unprocessable('TASK_POLICY_CLOSED', `seller task_policy mode=${policy.mode} rejects market deal`)
}

// 派生 task + 回填 task_id（调用方事务内执行）；createTask 仍返回 policyRejected 时防御性抛错回滚
function deriveMarketTask(db: Db, cfg: Config, bus: Bus, buyer: string, seller: string, dealId: string, listing: Listing): string {
  const { task, policyRejected } = createTask(db, bus, cfg, buyer, {
    to: seller, action: 'market_deal', context: { deal_id: dealId, listing_id: listing.id, title: listing.title },
  })
  if (policyRejected) throw Errors.unprocessable('TASK_POLICY_CLOSED', 'derived task rejected by policy')
  db.prepare('UPDATE deals SET task_id=? WHERE id=?').run(task.id, dealId)
  return task.id
}

// srv:market 派生消息（spec §2.5）：body 只给摘要行，不回显对方 body 全文。
// client_msg_id 每个收件人一个（幂等键按 from_agent+client_msg_id 唯一，同键双发第二条会被吞）
function notifyParty(db: Db, bus: Bus, from: string, to: string, key: string, body: Record<string, unknown>): void {
  insertDerived(db, bus, from, to, 'system', body, key)
}

// 市场轻量 WS 信号（task-7）：{op:'market',evt,ref} 下行帧；仅在成功路径、事务提交后发出。
// evt ∈ bid_new|bid_decided|deal_created|deal_delivered|deal_accepted|deal_canceled，ref 为 bid/deal id。
function emitMarket(bus: Bus, agentId: string, evt: string, ref: string): void {
  bus.emit({ type: 'market', agentId, evt, ref })
}

function insertDeal(db: Db, listingId: string, buyer: string, seller: string, points: number): { id: string; now: string } {
  const id = newId('deal')
  const now = new Date().toISOString()
  db.prepare('INSERT INTO deals (id, listing_id, buyer, seller, points, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, listingId, buyer, seller, points, 'escrowed', now, now)
  return { id, now }
}

// demand 选标（spec §2.1）：挂牌人选中一条 bid；escrow 差额补扣/退回；
// 其余 pending/countered bids → rejected 并通知；listing→dealing
export function selectBid(db: Db, cfg: Config, bus: Bus, listingId: string, bidId: string, actor: string): Deal {
  const listing = getListingRow(db, listingId)
  if (listing.kind !== 'demand') throw Errors.invalidRequest('仅 demand 挂牌可 select')
  if (listing.status !== 'open') throw Errors.unprocessable('LISTING_NOT_OPEN', 'listing not open')
  if (listing.publisher !== actor) throw new AppError('NOT_PARTY', 403, 'not party')
  const bid = getBidRow(db, bidId)
  if (bid.listing_id !== listingId) throw Errors.notFound('bid not found')
  if (bid.status !== 'pending' && bid.status !== 'countered') throw Errors.unprocessable('BID_CLOSED', `bid ${bid.status}`)
  const buyer = listing.publisher, seller = bid.agent_id, points = bid.points
  checkPolicy(db, seller, buyer) // 预检先行：不动资金、不落 task
  return db.transaction((): Deal => {
    // escrow 调整：> 补冻结（escrow_extra，不足整单回滚）；< 差额解冻退回
    const esc = listing.escrowed_points
    if (points > esc) lockPoints(db, buyer, points - esc, 'escrow_extra', { refType: 'listing', refId: listingId })
    else if (points < esc) unlockPoints(db, buyer, esc - points, 'escrow_release', { refType: 'listing', refId: listingId })
    const { id } = insertDeal(db, listingId, buyer, seller, points)
    deriveMarketTask(db, cfg, bus, buyer, seller, id, listing)
    db.prepare(`UPDATE bids SET status='accepted', updated_at=? WHERE id=?`).run(new Date().toISOString(), bidId)
    // 其余 pending/countered bids 自动 rejected + srv 通知
    const others = db.prepare(`SELECT id, agent_id FROM bids WHERE listing_id=? AND id!=? AND status IN ('pending','countered')`).all(listingId, bidId) as { id: string; agent_id: string }[]
    db.prepare(`UPDATE bids SET status='rejected', updated_at=? WHERE listing_id=? AND id!=? AND status IN ('pending','countered')`)
      .run(new Date().toISOString(), listingId, bidId)
    for (const o of others)
      notifyParty(db, bus, actor, o.agent_id, `srv:mkt:rej:${o.id}`, { code: 'MARKET_BID_REJECTED', deal_id: id, listing_id: listingId })
    db.prepare(`UPDATE listings SET status='dealing', escrowed_points=? WHERE id=?`).run(points, listingId)
    audit(db, actor, 'market.select', { deal_id: id, listing_id: listingId, bid_id: bidId, points })
    notifyParty(db, bus, actor, seller, `srv:mkt:sel:${id}:s`, { code: 'MARKET_SELECTED', deal_id: id, listing_id: listingId, points, task_pending: true })
    notifyParty(db, bus, actor, buyer, `srv:mkt:sel:${id}:b`, { code: 'MARKET_DEAL', deal_id: id, listing_id: listingId, points })
    emitMarket(bus, seller, 'deal_created', id); emitMarket(bus, buyer, 'deal_created', id)
    return getDeal(db, id)
  })()
}

// service 议价成交（spec §2.2）：挂牌人接受买家的 service bid（T4 createBid 生成）
export function acceptServiceBid(db: Db, cfg: Config, bus: Bus, bidId: string, actor: string): Deal {
  const bid = getBidRow(db, bidId)
  const listing = getListingRow(db, bid.listing_id)
  if (listing.kind !== 'service') throw Errors.invalidRequest('仅 service 挂牌可 accept bid')
  if (listing.status !== 'open') throw Errors.unprocessable('LISTING_NOT_OPEN', 'listing not open')
  if (listing.publisher !== actor) throw new AppError('NOT_PARTY', 403, 'not party')
  if (bid.status !== 'pending' && bid.status !== 'countered') throw Errors.unprocessable('BID_CLOSED', `bid ${bid.status}`)
  const buyer = bid.agent_id, seller = listing.publisher, points = bid.points
  checkPolicy(db, seller, buyer)
  return db.transaction((): Deal => {
    const { id } = insertDeal(db, listing.id, buyer, seller, points)
    lockPoints(db, buyer, points, 'escrow_lock', { refType: 'deal', refId: id }) // 不足 INSUFFICIENT_CREDITS 整单回滚
    deriveMarketTask(db, cfg, bus, buyer, seller, id, listing)
    db.prepare(`UPDATE bids SET status='accepted', updated_at=? WHERE id=?`).run(new Date().toISOString(), bidId)
    audit(db, actor, 'market.accept_bid', { deal_id: id, listing_id: listing.id, bid_id: bidId, points })
    notifyParty(db, bus, actor, buyer, `srv:mkt:sel:${id}:b`, { code: 'MARKET_DEAL', deal_id: id, listing_id: listing.id, points })
    notifyParty(db, bus, actor, seller, `srv:mkt:sel:${id}:s`, { code: 'MARKET_DEAL', deal_id: id, listing_id: listing.id, points })
    emitMarket(bus, buyer, 'deal_created', id); emitMarket(bus, seller, 'deal_created', id)
    return getDeal(db, id)
  })()
}

// service 直购（spec §2.2）：冻结 price → deal(escrowed)；listing 保持 open 可重复成交
export function buyService(db: Db, cfg: Config, bus: Bus, listingId: string, actor: string): Deal {
  const listing = getListingRow(db, listingId)
  if (listing.kind !== 'service') throw Errors.invalidRequest('仅 service 挂牌可 buy')
  if (listing.status !== 'open') throw Errors.unprocessable('LISTING_NOT_OPEN', 'listing not open')
  if (listing.publisher === actor) throw Errors.unprocessable('SELF_DEAL', 'cannot buy own listing')
  const buyer = actor, seller = listing.publisher, points = listing.price as number
  checkPolicy(db, seller, buyer) // closed 卖家先拒：不冻结资金、不落 REJECTED task
  return db.transaction((): Deal => {
    const { id } = insertDeal(db, listingId, buyer, seller, points)
    lockPoints(db, buyer, points, 'escrow_lock', { refType: 'deal', refId: id })
    deriveMarketTask(db, cfg, bus, buyer, seller, id, listing)
    audit(db, actor, 'market.buy', { deal_id: id, listing_id: listingId, points })
    notifyParty(db, bus, actor, buyer, `srv:mkt:sel:${id}:b`, { code: 'MARKET_DEAL', deal_id: id, listing_id: listingId, points })
    notifyParty(db, bus, actor, seller, `srv:mkt:sel:${id}:s`, { code: 'MARKET_DEAL', deal_id: id, listing_id: listingId, points, buyer })
    emitMarket(bus, buyer, 'deal_created', id); emitMarket(bus, seller, 'deal_created', id)
    return getDeal(db, id)
  })()
}

// 卖家交付（spec §2.1）：escrowed→delivered，auto_accept_at = now + autoAcceptHours；srv 提醒买家验收
export function deliverDeal(db: Db, cfg: Config, bus: Bus, dealId: string, actor: string, note?: string): Deal {
  const deal = getDeal(db, dealId)
  if (deal.seller !== actor) throw new AppError('NOT_PARTY', 403, 'not party')
  if (deal.status !== 'escrowed') throw Errors.invalidRequest(`状态非法迁移：deliver 仅允许 escrowed（当前 ${deal.status}）`)
  const now = new Date().toISOString()
  const autoAcceptAt = new Date(Date.now() + cfg.market.autoAcceptHours * 3600_000).toISOString()
  db.transaction(() => {
    db.prepare('UPDATE deals SET status=?, auto_accept_at=?, updated_at=? WHERE id=?').run('delivered', autoAcceptAt, now, dealId)
    audit(db, actor, 'market.deliver', { deal_id: dealId, note: note?.slice(0, 200) })
  })()
  notifyParty(db, bus, actor, deal.buyer, `srv:mkt:dlv:${dealId}:b`, { code: 'MARKET_DELIVERED', deal_id: dealId, auto_accept_at: autoAcceptAt })
  emitMarket(bus, deal.buyer, 'deal_delivered', dealId)
  return getDeal(db, dealId)
}

// 成交结算共用段（路由 acceptDeal 与 scanner 自动验收共用，RF2 竞态幂等）：
// 原子 UPDATE ... WHERE status='delivered'，changes>0 才放款——人工 accept 与 scanner 并发只结算一次
function settleAccepted(db: Db, cfg: Config, bus: Bus, deal: Deal, actor: string): boolean {
  const now = new Date().toISOString()
  const won = db.transaction((): boolean => {
    const r = db.prepare(`UPDATE deals SET status='accepted', updated_at=? WHERE id=? AND status='delivered'`).run(now, deal.id)
    if (r.changes === 0) return false
    settlePayout(db, deal.buyer, deal.seller, deal.points, cfg.market.commissionPct, deal.id, cfg)
    const listing = getListingRow(db, deal.listing_id)
    if (listing.kind === 'demand') db.prepare(`UPDATE listings SET status='done', escrowed_points=0 WHERE id=?`).run(deal.listing_id)
    audit(db, actor, 'market.accept', { deal_id: deal.id, points: deal.points, commission_pct: cfg.market.commissionPct, auto: actor === 'server' })
    return true
  })() as unknown as boolean
  if (won) {
    notifyParty(db, bus, actor, deal.buyer, `srv:mkt:pay:${deal.id}:b`, { code: 'MARKET_ACCEPTED', deal_id: deal.id, points: deal.points, auto: actor === 'server' })
    notifyParty(db, bus, actor, deal.seller, `srv:mkt:pay:${deal.id}:s`, { code: 'MARKET_PAYOUT', deal_id: deal.id, points: deal.points })
    emitMarket(bus, deal.seller, 'deal_accepted', deal.id) // scanner 自动验收也走这里（task-7）
  }
  return won
}

// 买家验收（spec §2.1/§1）：delivered→accepted；settlePayout 放款（佣金入池）；demand listing→done
export function acceptDeal(db: Db, cfg: Config, bus: Bus, dealId: string, actor: string): Deal {
  const deal = getDeal(db, dealId)
  if (deal.buyer !== actor) throw new AppError('NOT_PARTY', 403, 'not party')
  if (deal.status !== 'delivered') throw Errors.invalidRequest(`状态非法迁移：accept 仅允许 delivered（当前 ${deal.status}）`)
  if (!settleAccepted(db, cfg, bus, deal, actor))
    throw Errors.invalidRequest(`状态非法迁移：accept 仅允许 delivered（当前 ${getDeal(db, dealId).status}）`) // 竞态窗口：校验后被人先行 accept
  return getDeal(db, dealId)
}

// 市场扫描器（spec §2.1/§2.4/§6，index.ts 定时调用；纯函数供测试直接调）：
// 1) 过期挂牌：demand 退 escrow（unlock kind='refund'）→ expired；service 仅置 expired（M3 无资金副作用）
// 2) 过期 bid：pending/countered 超 bidDays → expired
// 3) 自动验收：delivered 且 auto_accept_at<now → settleAccepted（RF2 幂等，人工已 accept 则跳过）
// 4) sweepExpiring：expiring 到期超额清零（locked 保留）
export function scanMarket(db: Db, cfg: Config, bus: Bus, now: Date = new Date()): { expiredListings: string[]; expiredBids: string[]; autoAccepted: string[]; sweptExpired: number } {
  const nowIso = now.toISOString()
  const expiredListings: string[] = [], expiredBids: string[] = [], autoAccepted: string[] = []
  // 1) 挂牌过期：条件 UPDATE status='open' 才退款——已 canceled/done 的不重复处理（RF3 不双重退款）
  for (const l of db.prepare(`SELECT id, kind, publisher, escrowed_points FROM listings WHERE status='open' AND expires_at < ?`).all(nowIso) as { id: string; kind: string; publisher: string; escrowed_points: number }[]) {
    const won = db.transaction((): boolean => {
      const r = db.prepare(`UPDATE listings SET status='expired', escrowed_points=0 WHERE id=? AND status='open'`).run(l.id)
      if (r.changes === 0) return false
      if (l.kind === 'demand' && l.escrowed_points > 0)
        unlockPoints(db, l.publisher, l.escrowed_points, 'refund', { refType: 'listing', refId: l.id })
      audit(db, 'server', 'market.listing_expired', { listing_id: l.id, refund: l.kind === 'demand' ? l.escrowed_points : 0 })
      return true
    })() as unknown as boolean
    if (won) {
      expiredListings.push(l.id)
      if (l.kind === 'demand' && l.escrowed_points > 0)
        notifyParty(db, bus, 'server', l.publisher, `srv:mkt:exp:${l.id}`, { code: 'MARKET_LISTING_EXPIRED', listing_id: l.id, refund: l.escrowed_points })
    }
  }
  // 1b) dealing 过期兜底（终审 Medium-1，spec §2.1 Ruling）：托管中的 deal 取消全额退款、listing→expired；
  // 条件 UPDATE WHERE status='dealing' 防 RF3 双退；delivered deal 不动（托管留给验收结算）
  for (const l of db.prepare(`SELECT id, publisher FROM listings WHERE status='dealing' AND kind='demand' AND expires_at < ?`).all(nowIso) as { id: string; publisher: string }[]) {
    const deal = db.prepare(`SELECT id, buyer, seller, points, status FROM deals WHERE listing_id=? ORDER BY created_at DESC LIMIT 1`).get(l.id) as { id: string; buyer: string; seller: string; points: number; status: string } | undefined
    if (deal && deal.status !== 'escrowed') continue // delivered/accepted/canceled 的托管归结算或已处理，本步不动
    const won = db.transaction((): boolean => {
      const r = db.prepare(`UPDATE listings SET status='expired', escrowed_points=0 WHERE id=? AND status='dealing'`).run(l.id)
      if (r.changes === 0) return false
      if (deal) {
        unlockPoints(db, deal.buyer, deal.points, 'refund', { refType: 'deal', refId: deal.id })
        db.prepare(`UPDATE deals SET status='canceled', updated_at=? WHERE id=? AND status='escrowed'`).run(nowIso, deal.id)
      }
      audit(db, 'server', 'market.listing_expired', { listing_id: l.id, refund: deal?.points ?? 0, dealing: true })
      return true
    })() as unknown as boolean
    if (won) {
      expiredListings.push(l.id)
      if (deal) {
        notifyParty(db, bus, 'server', deal.buyer, `srv:mkt:exp:${l.id}:b`, { code: 'MARKET_LISTING_EXPIRED', listing_id: l.id, deal_id: deal.id, refund: deal.points })
        notifyParty(db, bus, 'server', deal.seller, `srv:mkt:exp:${l.id}:s`, { code: 'MARKET_LISTING_EXPIRED', listing_id: l.id, deal_id: deal.id })
      }
    }
  }
  // 2) bid 过期：pending/countered 超 bidDays 未成交
  const bidCutoff = new Date(now.getTime() - cfg.market.bidDays * 86400_000).toISOString()
  const expiredBidRows = db.prepare(`SELECT id, agent_id, listing_id FROM bids WHERE status IN ('pending','countered') AND updated_at < ?`).all(bidCutoff) as { id: string; agent_id: string; listing_id: string }[]
  for (const b of expiredBidRows) {
    db.prepare(`UPDATE bids SET status='expired', updated_at=? WHERE id=?`).run(nowIso, b.id)
    audit(db, 'server', 'market.bid_expired', { bid_id: b.id, listing_id: b.listing_id })
    expiredBids.push(b.id)
  }
  // 3) 自动验收：settleAccepted 内部条件 UPDATE 保证幂等（RF2）
  for (const d of db.prepare(`SELECT id FROM deals WHERE status='delivered' AND auto_accept_at IS NOT NULL AND auto_accept_at < ?`).all(nowIso) as { id: string }[]) {
    const deal = getDeal(db, d.id)
    if (deal.status !== 'delivered') continue // 竞态兜底（getDeal 与 settle 之间可能被人工 accept）
    if (settleAccepted(db, cfg, bus, deal, 'server')) autoAccepted.push(d.id)
  }
  // 4) expiring 清扫
  const sweptExpired = sweepExpiring(db, now)
  return { expiredListings, expiredBids, autoAccepted, sweptExpired }
}

// 取消（spec §2.4）：双方任一；仅 escrowed 可取消（delivered 前才可取消）；unlockPoints 全额退 buyer（kind='refund'）；
// demand listing→open 且 bids 全清为 expired；service 无 listing 副作用；done 不可逆
export function cancelDeal(db: Db, cfg: Config, bus: Bus, dealId: string, actor: string): Deal {
  const deal = getDeal(db, dealId)
  if (deal.buyer !== actor && deal.seller !== actor) throw new AppError('NOT_PARTY', 403, 'not party')
  if (deal.status !== 'escrowed') throw Errors.invalidRequest(`状态非法迁移：cancel 仅允许 escrowed（当前 ${deal.status}）`) // spec §2.4：delivered 前才可取消
  const now = new Date().toISOString()
  db.transaction(() => {
    unlockPoints(db, deal.buyer, deal.points, 'refund', { refType: 'deal', refId: dealId })
    db.prepare('UPDATE deals SET status=?, updated_at=? WHERE id=?').run('canceled', now, dealId)
    const listing = getListingRow(db, deal.listing_id)
    if (listing.kind === 'demand' && listing.status === 'dealing') {
      db.prepare(`UPDATE listings SET status='open', escrowed_points=? WHERE id=?`)
        .run(Math.max(0, listing.escrowed_points - deal.points), deal.listing_id)
      db.prepare(`UPDATE bids SET status='expired', updated_at=? WHERE listing_id=? AND status IN ('pending','countered','accepted')`).run(now, deal.listing_id)
    }
    audit(db, actor, 'market.cancel', { deal_id: dealId, refund: deal.points })
  })()
  notifyParty(db, bus, actor, deal.buyer, `srv:mkt:cxl:${dealId}:b`, { code: 'MARKET_CANCELED', deal_id: dealId, refund: deal.points })
  notifyParty(db, bus, actor, deal.seller, `srv:mkt:cxl:${dealId}:s`, { code: 'MARKET_CANCELED', deal_id: dealId })
  emitMarket(bus, actor === deal.buyer ? deal.seller : deal.buyer, 'deal_canceled', dealId)
  return getDeal(db, dealId)
}

// 成交列表（spec §3）：role=buyer|seller（默认 buyer）；游标与 listListings 同款 `${created_at}|${id}`
export function listDeals(db: Db, agentId: string, q: { role?: 'buyer' | 'seller'; cursor?: string; limit?: number }): { items: Deal[]; next_cursor: string | null } {
  const limit = Math.min(Math.max(q.limit ?? 20, 1), 50)
  const role = q.role ?? 'buyer'
  if (role !== 'buyer' && role !== 'seller') throw Errors.invalidRequest('role must be buyer or seller')
  const where = [`${role} = ?`]; const args: unknown[] = [agentId]
  if (q.cursor) {
    const c = decodeCursor(q.cursor)
    where.push('(created_at < ? OR (created_at = ? AND id < ?))')
    args.push(c.createdAt, c.createdAt, c.id)
  }
  const rows = db.prepare(`SELECT * FROM deals WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...args, limit + 1) as Record<string, unknown>[]
  const items = rows.slice(0, limit).map(rowToDeal)
  const last = items[items.length - 1]
  const next_cursor = rows.length > limit && last ? `${last.created_at}|${last.id}` : null
  return { items, next_cursor }
}
