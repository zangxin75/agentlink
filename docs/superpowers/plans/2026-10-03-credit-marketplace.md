# 信用点市场（Credit Marketplace）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AgentLink 增加信用点结算的能力市场：需求悬赏（投标/议价/选标）+ 服务直购 + 派生任务交付 + 自动验收放款分账。

**Architecture:** 服务端新增 `core/credits.ts`（账本）与 `core/market.ts`（市场状态机）两个纯函数模块，挂在现有 `db`+`bus` tier 路由层；交付复用现有 tasks（policy 预检 + 派生），事件复用 Bus/WS hub/`srv:` 派生消息三条通道；scanner 扩展负责过期与自动验收。CLI 加 `im market` / `im credits` 命令组（零依赖不变）。

**Tech Stack:** 现有栈不动：Fastify + better-sqlite3（事务）+ vitest；客户端 Node ≥20 全局。

**Spec:** `docs/superpowers/specs/2026-10-03-credit-marketplace-design.md`（r3，critic SHIP）——冲突时以 spec 为准。

## Global Constraints

- 单笔点数 1..1,000,000；账户余额上限 10,000,000（`payout`/`faucet`/`grant`/`transfer_in` 入账前检查，超限拒）。
- 会计不变量（fuzz 钉死）：每账户 `permanent + expiring − locked = sum(ledger.delta)`；池 `credit_pool.balance = sum(ledger where agent_id='_pool')`。`balance_after` 恒为该行落账后的**可用余额**（=P+E−L）。
- 托管冻结只加 `locked` 不动 P/E（记 `escrow_lock` delta 负）；放款时买方同时减 `locked` 并扣 P/E（先扣 expiring 再 permanent，买方无新 delta 行）；退款减 `locked` 加 permanent；expiry 清扫额 = `max(0, expiring − locked)`（锁定点不消耗 TTL、不被清扫）。
- 所有多行写操作必须包 `db.transaction`；better-sqlite3 同步单连接天然串行。
- 时间戳一律 TEXT ISO（`new Date().toISOString()`），与现有 schema 一致；`last_faucet_date` 为 UTC `YYYY-MM-DD`。
- 币种单位「点」整数；佣金 `MARKET_COMMISSION_PCT=5`、转账税 5%（`ceil`）、demand 上架费 1 点、bid 费 1 点，全部 burn。
- 文本限制：title ≤200 字节、body ≤64KB、tags ≤8 个每个 1..24 字符匹配 `^[a-z0-9][a-z0-9._-]*$`——全部 `Buffer.byteLength`。
- id 前缀：listing `lst_`、bid `bid_`、deal `deal_`（ulid，沿用 `core/ids.ts` 模式）。
- `im.mjs` 保持零依赖；服务端不加新依赖。
- ESM + NodeNext：相对导入带 `.js`。中文注释。迁移测试沿用 `test/migration-v3.test.ts` 手建旧表模式。
- 服务端测试用 `app.inject` / `startWsServer`（`server/test/helpers/ws-server.ts`）。

## Review Focus

1. **select 补冻结失败回滚**：bid.points > escrow 且买家可用不足时，不得留下 deal/bid 状态变化——测试进 Task 5。
2. **自动验收与人工 accept 竞态**（scanner 与 POST 同时到 delivered deal）——二次 accept 必须幂等报错不双放款——测试进 Task 6。
3. **escrow 双重退款**（listing 过期 scanner 与 cancel 并发）——退款前状态原子翻转——测试进 Task 6。
4. **派生 task 超时/reject 后 deal 兜底**：task 终态不放款不卡死，listing 过期退款——测试进 Task 6。
5. **老客户端兼容**：未知 `op:"market"` WS 帧与 `srv:market` 消息在旧 CLI 上不崩（默认分支兜底）——测试进 Task 7。

---

### Task 1: schema v5 迁移 + market 配置

**Files:**
- Modify: `server/src/db/schema.ts`
- Modify: `server/src/config.ts`
- Test: `server/test/migration-v5.test.ts`（新建）

**Interfaces:**
- Produces: `user_version 5`（credit_accounts/credit_ledger/listings/bids/deals/credit_pool 六表，DDL 逐字用 spec §10）；`Config` 新增 `market: MarketCfg` 与 `adminToken: string | null`，`rate` 新增 `marketPublishPerDay/marketBidPerDay/marketCounterPerDay`。

- [ ] **Step 1: 失败测试**（模式抄 `test/migration-v3.test.ts`：手建 v4 库→跑 migrate→断言）

```ts
// server/test/migration-v5.test.ts
import { describe, it, expect, beforeAll } from 'vitest'
import { DatabaseSync } from 'node:sqlite' // 或沿用现有测试打开 better-sqlite3 的方式——抄 migration-v3.test.ts 的实际 import
import { migrate } from '../src/db/schema.js'
// 手建 v4 库：agents 表最小列 + PRAGMA user_version=4；然后 migrate(db)
// 断言：
// - db.pragma('user_version', {simple:true}) === 5
// - 六表存在：SELECT name FROM sqlite_master WHERE type='table' AND name IN (...)
// - credit_pool 单行 balance=0
// - 对旧表数据无损：插入的 agent 行还在
```

（实现者：先读 `server/test/migration-v3.test.ts`，复用其建库/导入/断言写法与 import 路径，逐字对齐后把上述断言补全为真实代码。）

- [ ] **Step 2: 跑测试确认失败**：`cd server && npx vitest run test/migration-v5.test.ts` → FAIL（版本还是 4）
- [ ] **Step 3: 实现**：`schema.ts` 在 v4 块后追加 `else if (v === 4)` 分支，`db.transaction` 包裹 spec §10 的 DDL（TEXT 时间戳、deals FK、INSERT OR IGNORE credit_pool、`PRAGMA user_version = 5`）。
  `config.ts`：

```ts
export interface MarketCfg { commissionPct: number; faucetDaily: number; faucetRepCap: number; faucetInitial: number; listingDays: number; bidDays: number; autoAcceptHours: number; counterMaxRounds: number; transferFeePct: number; maxPointsPerTx: number; maxBalance: number }
// loadConfig 内：
adminToken: env.ADMIN_TOKEN || null,
market: {
  commissionPct: Number(env.MARKET_COMMISSION_PCT ?? 5),
  faucetDaily: Number(env.FAUCET_DAILY ?? 100),
  faucetRepCap: Number(env.FAUCET_REPUTATION_CAP ?? 200),
  faucetInitial: Number(env.FAUCET_INITIAL ?? 500),
  listingDays: Number(env.MARKET_LISTING_DAYS ?? 7),
  bidDays: Number(env.MARKET_BID_DAYS ?? 3),
  autoAcceptHours: Number(env.MARKET_AUTO_ACCEPT_HOURS ?? 48),
  counterMaxRounds: Number(env.COUNTER_MAX_ROUNDS ?? 5),
  transferFeePct: Number(env.MARKET_TRANSFER_FEE_PCT ?? 5),
  maxPointsPerTx: 1_000_000, maxBalance: 10_000_000,
},
// rate 追加：
marketPublishPerDay: Number(env.RATE_LIMIT_MARKET_PUBLISH_PER_DAY ?? 5),
marketBidPerDay: Number(env.RATE_LIMIT_MARKET_BID_PER_DAY ?? 30),
marketCounterPerDay: Number(env.RATE_LIMIT_MARKET_COUNTER_PER_DAY ?? 20),
```

  `AppDeps`/其余不动（market cfg 经 `deps.cfg.market` 传递）。
- [ ] **Step 4: 测试通过 + 全量**：`npx vitest run test/migration-v5.test.ts` PASS；`npx tsc -p tsconfig.json --noEmit` OK
- [ ] **Step 5: Commit**：`git commit -m "feat: schema v5 市场六表与 market 配置"`

---

### Task 2: core/credits.ts 账本 + credits 路由 + 日桶限频

**Files:**
- Create: `server/src/core/credits.ts`
- Create: `server/src/http/routes/credits.ts`
- Modify: `server/src/http/app.ts`（挂 credits 路由，db tier）
- Modify: `server/src/core/ratelimit.ts`（三桶）
- Test: `server/test/credits.test.ts`

**Interfaces:**
- Produces（后续任务全部依赖）:

```ts
export interface Account { agent_id: string; permanent: number; expiring: number; expiring_expires_at: string | null; locked: number; last_faucet_date: string | null }
export type LedgerKind = 'faucet'|'grant'|'initial'|'escrow_lock'|'escrow_release'|'escrow_extra'|'payout'|'commission'|'burn'|'transfer_in'|'transfer_out'|'expiry'|'refund'
export function getOrCreateAccount(db: Db, agentId: string): Account            // 懒创建：无行则 INSERT 并记 initial +cfg.market.faucetInitial
export function available(a: Account): number                                   // permanent+expiring-locked
export function creditAccount(db: Db, agentId: string, kind: LedgerKind, amount: number, o: { bucket?: 'permanent'|'expiring'|'pool'; refType?: string; refId?: string; note?: string; ttlHours?: number }): void // 入账（pool 走 credit_pool+_pool ledger）；余额上限检查抛 MARKET_BALANCE_OVERFLOW；入 expiring 桶时 expiring_expires_at = max(旧值, now+ttlHours)（TTL 只延不缩）
export function debitAccount(db: Db, agentId: string, kind: LedgerKind, amount: number, o: { refType?: string; refId?: string; note?: string }): void // 可用不足抛 AppError('INSUFFICIENT_CREDITS')；先扣 expiring 再 permanent
export function lockPoints(db: Db, agentId: string, amount: number, kind: LedgerKind, o: { refType?: string; refId?: string }): void  // locked+=amount + ledger delta=-amount
export function unlockPoints(db: Db, agentId: string, amount: number, kind: LedgerKind, o: {...}): void // locked-=amount, permanent+=amount（不写新 ledger 行——lock 行已记负；若 kind='escrow_extra' 补冻结行同样）
export function settlePayout(db: Db, buyer: string, seller: string, points: number, commissionPct: number, refId: string): { payout: number; commission: number } // 单事务：买方 P/E 扣 points+locked 扣 points；卖方 permanent += payout（走 creditAccount，MARKET_BALANCE_OVERFLOW 则整个 payout 抛错回滚——调用方保持 deal 不结算、scanner 重试并 srv 提醒卖家清账户；提醒用 deal 级幂等 client_msg_id=`srv:mkt:ovf:${deal.id}`，derive 幂等键冲突静默跳过防 30s tick 刷屏）；池 += commission（ledger commission 行 agent_id='_pool'）
export function claimFaucet(db: Db, cfg: Config, agentId: string, acceptedDeals: number): { granted: number; bonus: number } // UTC 日期幂等；bonus=min(faucetRepCap, 5*acceptedDeals)；入 expiring 桶 ttlHours=2160（90 天）
export function transferPoints(db: Db, cfg: Config, from: string, to: string, points: number, note?: string): void
  // spec §1"双向各 5% burn"（Ruling：采方案甲——to 行为 transfer_in(+points)+burn(-fee)，净得 points-fee；spec §1"transfer_in +(points−税)"字面与其"双方 burn 行各 1 行"自相矛盾，按字面净收 90 会凭空多销毁 5 点且 burn 行合计与销毁额不符，故 transfer_in 记全额、税单列 burn 行）：fee=ceil(points*5%)；from 两行 transfer_out(-points)+burn(-fee)；to 两行 transfer_in(+points)+burn(-fee)；共销毁 2×fee；to 必须在 agents 表
export function sweepExpiring(db: Db, now: Date): number // expiring=max(0,expiring-locked) 清零 + ledger expiry 行
export function auditInvariant(db: Db): boolean // 全账户+池对账
```

  路由（全认证）：`GET /v1/credits/account`（余额+今日 faucet，**GET 即自动 claimFaucet**，acceptedDeals 取 `SELECT COUNT(*) FROM deals WHERE seller=? AND status='accepted'`）；`POST /v1/credits/transfer {to, points, note?}`（SELF_DEAL/AGENT_NOT_FOUND）；`GET /v1/credits/ledger?cursor=&limit=`；`GET /v1/market/pool`（公开余额，无认证也可——Ruling: 需认证保持一致，挂 db tier）。
  限频（H1 修正：spec §3 Ruling——日桶必须走 **SlidingWindow**，不能复用 TokenBucket 的 `check`，后者连续补充会让 5/日变成持续超额）。`ratelimit.ts` 追加：

```ts
// core/ratelimit.ts — 市场日桶（spec §3：SlidingWindow windowMs=86_400_000）
private daily = new Map<string, SlidingWindow>() // key→窗口；构造器里 setInterval 不需要——SlidingWindow 自惰性过期
private checkDaily(key: string, quota: number, label: string): void {
  let w = this.daily.get(key)
  if (!w) { w = new SlidingWindow(quota, 86_400_000); this.daily.set(key, w) }
  // SlidingWindow 第 1 参=capacity、第 2 参=windowMs（ratelimit.ts:20 实现签名）；方法名以 ratelimit.ts:18-34 实现为准（实现者先读该类，用其 hit+count 完成判定；超 quota 抛 AppError('RATE_LIMITED', label)，
  // 429 响应里 retry_after_ms = 窗口最早命中滑出剩余毫秒——该类已暴露此值（ratelimit.ts:27 注释））
}
checkMarketPublish(agentId: string) { this.checkDaily(`mpub:${agentId}`, this.rate.marketPublishPerDay, 'market-publish') }
checkMarketBid(agentId: string) { this.checkDaily(`mbid:${agentId}`, this.rate.marketBidPerDay, 'market-bid') }
checkMarketCounter(agentId: string) { this.checkDaily(`mctr:${agentId}`, this.rate.marketCounterPerDay, 'market-counter') }
```

  （实现者注意：`SlidingWindow` 的公共 API 与上面伪码的方法名可能有出入——以 `ratelimit.ts:18` 起的实际实现为准，语义 = 滚动 24h 窗口内计数 ≤ quota。窗口 Map 不清理也可接受——key 按 agentId 有界。）

- [ ] **Step 1: 失败测试** `server/test/credits.test.ts`（用 app.inject + 全栈 app；模式抄 `test/topic-api.test.ts` 的 base 夹具——`base.mk(id)` 返回 `{agent, token}`）:

```ts
// 用例（每个都是真实断言）：
// 1. 首次 GET /v1/credits/account：permanent=500(initial)+faucet(100+bonus0)=600，返回 available/permanent/expiring/locked 分列
// 2. 再 GET 同日：余额不变（faucet 幂等）
// 3. transfer：A→B 100 点 → A 减 105（transfer_out −100 + burn −5），B 加 95（transfer_in +100 + burn −5，双向各 5%、共销毁 10）；ledger 各自可查到行且 balance_after 正确
// 4. transfer 给自己 → SELF_DEAL；给未注册 id → AGENT_NOT_FOUND；超可用 → INSUFFICIENT_CREDITS
// 5. auditInvariant 全程 true（随机 20 步操作 fuzz：transfer/锁/解锁/清扫混合）
// 6. GET /v1/market/pool 返回 {balance:0}
```

- [ ] **Step 2: 确认失败** → Step 3: 实现 credits.ts + credits.ts 路由 + ratelimit 三桶 + app.ts 挂载（db tier，模式抄 `registerAgentsRoutes`）
- [ ] **Step 4: 全量 `npm test` + tsc** → Step 5: Commit `feat: 信用账本 core/credits 与账户/转账/池端点`

---

### Task 3: core/market listings + 路由

**Files:**
- Create: `server/src/core/market.ts`
- Create: `server/src/http/routes/market.ts`（本任务先挂 listings CRUD 部分）
- Modify: `server/src/http/app.ts`（挂 market 路由，db+bus tier）
- Test: `server/test/market-listings.test.ts`

**Interfaces:**
- Consumes: Task 2 全部 credits 函数；Task 1 cfg.market。
- Produces:

```ts
export type ListingKind = 'demand' | 'service'
export interface Listing { id: string; kind: ListingKind; publisher: string; title: string; body: string; tags: string[]; status: 'open'|'dealing'|'done'|'canceled'|'expired'; budget: number|null; price: number|null; escrowed_points: number; expires_at: string; created_at: string }
export function createListing(db: Db, cfg: Config, publisher: string, input: { kind: ListingKind; title: string; body: string; tags?: string[]; budget?: number; price?: number; days?: number }): Listing
  // demand：校验 budget 整数 1..maxPointsPerTx；burn 上架费 1；lockPoints(min(budget, available))→escrowed_points；缺额 INSUFFICIENT_CREDITS（上架费已 burn 也要整单回滚——同事务内先校验后 burn）
  // service：price 同校验，无锁定无费用
export function listListings(db: Db, q: { kind?: ListingKind; tag?: string; text?: string; status?: string; cursor?: string; limit?: number }): { items: Listing[]; next_cursor: string|null }
  // LIKE 检索 title/body（%text%）；tag 命中 tags（EXISTS json_each(tags)）；limit 默认 20 上限 50
  // 复合游标（仓内无先例，此处给出完整实现——listings/ledger/deals 三处分页共用此模式）：
  //   next_cursor = `${created_at}|${id}`（ISO 里无 '|'，安全拼接；decode 时 split('|') 恰 2 段否则 400）
  //   SQL: ... WHERE <filters> AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?
  //   取 limit+1 行：多出 1 行 → 有下一页，next_cursor=第 limit 行的 `${created_at}|${id}`；否则 null
export function getListing(db: Db, id: string): { listing: Listing; bids: Bid[] } // bids T4 才有，本任务返回 []
export function patchListing(db: Db, id: string, actor: string, input: { title?: string; body?: string; tags?: string[] }): Listing // 仅 publisher+open；价格字段出现在 body → 400 INVALID_REQUEST
export function deleteListing(db: Db, cfg: Config, id: string, actor: string, opts: { adminForce?: boolean }): void
  // 本人且 open：demand 退 escrow（unlockPoints）→canceled；非 open 拒 LISTING_NOT_OPEN
  // adminForce（x-admin-token 头匹配 cfg.adminToken）：open 同上；dealing→先 cancel 未终态 deal（退 escrow）再 canceled；done 不动；落 audit_log（actor='admin'）
```

  路由：`GET/POST /v1/market/listings`、`GET/PATCH/DELETE /v1/market/listings/:id`（POST 前 `limiter.checkMarketPublish`）。

- [ ] **Step 1: 失败测试**（inject）：

```ts
// 1. 发 demand budget=500：账户 locked=500、available 减 501（含上架费 burn）、escrowed_points=500、status=open、expires_at≈7d
// 2. 余额不足发 demand：INSUFFICIENT_CREDITS，且上架费未被 burn（事务回滚）
// 3. 发 service price=50：不锁定不扣费
// 4. 校验矩阵：title 201 字节、body>64KB、tags 9 个/25 字符/大写、budget 0/1e6+1 → PRICE_INVALID/TAG_INVALID/INVALID_REQUEST
// 5. list 过滤：kind/tag/文本 LIKE/status/cursor 翻页正确
// 6. PATCH：open 可改 title；带 price 字段 → 400；dealing 后 PATCH → LISTING_NOT_OPEN
// 7. DELETE open demand：escrow 退回 permanent；DELETE 别人的 → 403 NOT_PARTY
// 8. admin force：无 token 403；带错 token 403；带对 token 可下架 dealing demand 且 escrow 退回
```

- [ ] **Step 2-5**: 同前模式。Commit `feat: 市场挂牌 listings 核心与端点`

---

### Task 4: bids 投标/议价 + 路由

**Files:**
- Modify: `server/src/core/market.ts`
- Modify: `server/src/http/routes/market.ts`
- Test: `server/test/market-bids.test.ts`

**Interfaces:**
- Consumes: `debitAccount`（bid 费 1 burn）、`getListing`。
- Produces:

```ts
export interface Bid { id: string; listing_id: string; agent_id: string; points: number; body: string; status: 'pending'|'countered'|'accepted'|'rejected'|'withdrawn'|'expired'; counter_rounds: number; created_at: string; updated_at: string }
export function createBid(db: Db, cfg: Config, listingId: string, bidder: string, input: { points: number; body: string }): Bid
  // 仅 demand+open；bidder≠publisher（SELF_DEAL）；burn 1；points 1..maxPointsPerTx
export function counterBid(db: Db, cfg: Config, bidId: string, actor: string, input: { points: number; body: string }): Bid
  // 仅 pending|countered；actor 必须是 bid 主或挂牌人（双向议价）；rounds+1>cfg.market.counterMaxRounds → TOO_MANY_ROUNDS；points 覆写、status='countered'、updated_at 刷新
  // 交替校验：连续两轮同一方 → INVALID_REQUEST
export function decideBid(db: Db, bidId: string, actor: string, op: 'withdraw'|'reject'): Bid // withdraw 仅 bid 主；reject 仅挂牌人；状态回 pending/countered 之外的 → BID_CLOSED
// （H3 修正：acceptBid/select 建 deal 的逻辑整体移到 Task 5——它依赖 createTask/lockPoints，T4 只做 bid 状态机）
```

  路由：`POST /v1/market/listings/:id/bids`（checkMarketBid）、`POST /v1/market/bids/:id/counter`（checkMarketCounter）、`POST /v1/market/bids/:id/withdraw|reject`。

  T4 测试同步删去原第 3 条中涉及 accept 的断言，聚焦 bid 状态机（议价轮次、burn、自投拒绝）。

- [ ] **Step 1: 失败测试**：

```ts
// 1. demand 投标：bid pending、投标者 burn 1；投自己 → SELF_DEAL；service 上投标 → INVALID_REQUEST
// 2. counter：买卖双方各 counter 一轮成功且 points 覆写；第 6 轮 → TOO_MANY_ROUNDS；连续同方 → INVALID_REQUEST；非双方 → NOT_PARTY
// 3. withdraw/reject：状态转移正确；对非 pending/countered（手工 UPDATE bids 置 rejected）再操作 → BID_CLOSED（accepted 态的 BID_CLOSED 断言移到 T5——accept 端点在 T5）
// 4. service：买家 bid（即议价）→ 挂牌人 reject 后买家可再 bid 新价
// 5. 议价不锁钱：counter 全程账户不动（只在成交时结算）
```

- [ ] **Step 2-5**: Commit `feat: 市场投标与多轮议价`

---

### Task 5: deals 选标/直购/交付/验收 + payout + 派生 task

**Files:**
- Modify: `server/src/core/market.ts`
- Modify: `server/src/http/routes/market.ts`
- Test: `server/test/market-deals.test.ts`

**Interfaces:**
- Consumes: `createTask`（`core/tasks.ts`，返回 `{task, policyRejected}`）、`insertDerived`（`core/derive.ts`，签名 `insertDerived(db, bus, from, to, type, body, clientMsgId, threadId?)`）、`settlePayout`、`lockPoints`、`unlockPoints`。
- Produces:

```ts
export interface Deal { id: string; listing_id: string; buyer: string; seller: string; points: number; status: 'escrowed'|'delivered'|'accepted'|'canceled'; auto_accept_at: string|null; task_id: string|null; created_at: string; updated_at: string }
export function selectBid(db: Db, cfg: Config, bus: Bus, listingId: string, bidId: string, actor: string): Deal
  // actor=挂牌人；listing demand+open；单事务：
  //  a. policy 预检：卖家(=bid 主) task_policy.mode==='closed' || (allowlist 且不含 buyer) → TASK_POLICY_CLOSED（不动任何状态；预检必要——直接 createTask 会落一个 REJECTED task 行且买方资金已动）
  //  b. escrow 调整：bid.points > escrowed → lockPoints 差额（不足→INSUFFICIENT_CREDITS 整单回滚）；< → unlockPoints 差额
  //  c. createDeal + createTask(requester=buyer, executor=seller, action='market_deal', context={deal_id,listing_id,title}) → deal.task_id
  //  d. 其余 pending/countered bids → rejected；insertDerived srv 提示双方（client_msg_id=`srv:mkt:sel:${deal.id}`，type='system'）
  //  e. listing→dealing；bid→accepted
export function acceptServiceBid(db: Db, cfg: Config, bus: Bus, bidId: string, actor: string): Deal
  // service listing 的挂牌人接受买家议价出价（T4 createBid/counterBid 已就绪）：actor=publisher；bid pending|countered；
  // policy 预检同上（对 buyer）；buyer lockPoints(bid.points)（不足 INSUFFICIENT_CREDITS 整单回滚）；deal(escrowed)；bid→accepted；listing 保持 open；task 派生同 selectBid c 段
export function buyService(db: Db, cfg: Config, bus: Bus, listingId: string, actor: string): Deal
  // service+open；actor≠publisher；policy 预检同上（对 publisher——M1 修正：closed 卖家先拒，不冻结资金不落 REJECTED task）；lockPoints(price)（不足 INSUFFICIENT_CREDITS）；deal(escrowed)；listing 保持 open；task 派生同上
export function deliverDeal(db: Db, cfg: Config, dealId: string, actor: string, note?: string): Deal // seller 且 escrowed→delivered；auto_accept_at=now+autoAcceptHours；srv 提醒买家
export function acceptDeal(db: Db, cfg: Config, bus: Bus, dealId: string, actor: string): Deal // buyer 且 delivered→accepted；settlePayout（commission 入池）；demand listing→done
export function cancelDeal(db: Db, cfg: Config, bus: Bus, dealId: string, actor: string): Deal // 双方任一；escrowed|delivered→canceled；unlockPoints 全额退 buyer（kind='refund'）；demand listing→open 且 bids 全部清为 expired；srv 双方
```

  路由：`POST /v1/market/listings/:id/select/:bid`、`POST /v1/market/bids/:id/accept`（service 议价成交）、`POST /v1/market/listings/:id/buy`、`GET /v1/market/deals?role=&cursor=`、`POST /v1/market/deals/:id/deliver|accept|cancel`。

- [ ] **Step 1: 失败测试**（Review Focus #1 在此）：

```ts
// 1. 悬赏全链路：发布(500)→投标(450)→counter(480)→select→deal escrowed(差额 20 退回 buyer available)→task REQUESTED 且 context.deal_id 对应→其余 bid rejected
// 2. select 补冻结失败：bid 600 > escrow 500 且 buyer 可用不足 → INSUFFICIENT_CREDITS，断言 deal 无、bids 状态原样、escrowed_points 原值（RF1）
// 3. policy 预检：卖家 task_policy closed → TASK_POLICY_CLOSED，bid/listing 原样
// 4. buy service：冻结 price、listing 仍 open 可再买第二单（两个 deal 并存）；closed policy 卖家 buy → TASK_POLICY_CLOSED 且资金未动（M1）
// 4b. service 议价成交：bid 80 → 挂牌人 POST /v1/market/bids/:id/accept → buyer 冻结 80、deal escrowed、bid accepted、listing 仍 open
// 5. deliver→accept：payout=points−5% 入 seller permanent、池=5%、buyer locked 归零、listing done（demand）
// 6. cancel 三处：escrowed 时 buyer 全额回 permanent；delivered 时也可 cancel；demand 回 open 且旧 bids expired
// 7. 非当事方操作 → NOT_PARTY；状态非法迁移（accept escrowed 的）→ INVALID_REQUEST
// 8. auditInvariant 在全链路后仍 true
```

- [ ] **Step 2-5**: Commit `feat: 市场成交 deals 全链路与派生任务`

---

### Task 6: scanner 过期/自动验收/清扫 + admin force 下架

**Files:**
- Modify: `server/src/core/market.ts`（`scanMarket`）
- Modify: `server/src/core/tasks.ts`（H4c 修正：`startScanner` 的 tick 闭包在 `tasks.ts:174` 内部，index.ts 只有一行调用无回调可追加——改 `startScanner` 签名加可选 `marketScan?: (now: Date) => void` 参数，tick 内**独立 try/catch** 追加调用，market 异常不吞掉 task 扫描；`index.ts` 传 `(now) => scanMarket(db, cfg, bus, now)`。既有 `startScanner` 测试不受影响——参数可选）
- Test: `server/test/market-scan.test.ts`

**Interfaces:**
- Consumes: `acceptDeal`/`cancelDeal` 内部段（抽出 `settleAccepted(db,cfg,bus,deal)` 供 scanner 与路由共用，幂等：UPDATE ... WHERE status='delivered' 返回 changes>0 才结算）、`sweepExpiring`、`createListing` 过期退款 `unlockPoints`。
- Produces:

```ts
export function scanMarket(db: Db, cfg: Config, bus: Bus, now: Date = new Date()): { expiredListings: string[]; expiredBids: string[]; autoAccepted: string[]; sweptExpired: number }
// 1. listings: open 且 expires_at<now → demand 退 escrow(unlock kind='refund') → 'expired'
// 2. bids: pending|countered 且 updated_at<now-bidDays → 'expired'
// 3. deals: delivered 且 auto_accept_at<now → 原子 UPDATE status='accepted' WHERE id=? AND status='delivered'，changes>0 才 settlePayout+listing done（RF2 竞态幂等）
// 4. sweepExpiring
```

- [ ] **Step 1: 失败测试**（直接调 `scanMarket(db,cfg,bus,fakeNow)`，不依赖定时器）：

```ts
// 1. 过期 listing：demand escrow 退回 permanent（kind='refund'）；service open 过期仅置 'expired' 无资金副作用（M3）；RF3：先手工置 canceled 再跑 scanner，不双重退款——断言 permanent 不变
// 2. bid 过期：pending→expired
// 3. 自动验收：delivered+auto_accept_at 过去 → accepted+放款；再跑一次 → 无变化不双放款（RF2）
// 4. 人工 accept 后 scanner 再扫同 deal → 跳过
// 5. 派生 task 被 scanner 超时（REQUESTED expires）后：deal 仍 escrowed，等 listing 过期退款（RF4：两段各断言）
// 6. expiring 到期清扫：faucet 点 90 天后清零、locked 部分保留（expiring=100,locked=40 → 清 60）
// 7. auditInvariant 扫描后 true
```

- [ ] **Step 2-5**: Commit `feat: 市场 scanner 过期/自动验收/信用清扫`
- admin force DELETE 已在 Task 3 实现，此处测试补 dealing+force 路径若 Task 3 未覆盖。

---

### Task 7: 事件出口 BusEvent market + WS op + srv 消息补全

**Files:**
- Modify: `server/src/core/bus.ts`（BusEvent 加 `{ type: 'market'; agentId: string; evt: string; ref: string }`）
- Modify: `server/src/ws/hub.ts`（subscribe 处 case 'market' → `{op:'market', evt, ref}`）
- Modify: `server/src/core/market.ts`（selectBid/buyService/deliverDeal/acceptDeal/cancelDeal/createBid 成功路径 `bus.emit({type:'market',...})`——evt 取 'bid_new'|'bid_decided'|'deal_created'|'deal_delivered'|'deal_accepted'|'deal_canceled'，agentId 发给关注方：挂牌人/买卖双方）
- Test: `server/test/market-events.test.ts`

**Interfaces:**
- Consumes: `startWsServer`（test/helpers/ws-server.ts）。
- Produces: WS 下行帧 `{op:'market', evt, ref}`；`srv:market` 消息（T5 已插的 insertDerived 保留）。

- [ ] **Step 1: 失败测试**：

```ts
// 1. WS 客户端（买家+卖家各一连接，先 auth）：买家 buy → 卖家连接收到 {op:'market',evt:'deal_created',ref:<deal_id>}；买家也收到
// 2. 投标 → 挂牌人收到 bid_new
// 3. 老客户端兼容（RF5）：对 hub 发未知 op 不崩——直接向 WS 发 {op:'market_subscribe'} 收到 error 帧而非断连；收到 srv:market 消息的旧 CLI 逻辑无 op 分支也不崩（客户端测试在 T8 钉）
// 4. bus.emit 的 waiters 不受 market 事件干扰（inbox 长轮询仍只等 new-message）
```

- [ ] **Step 2-5**: Commit `feat: 市场 WS 事件 op:market 与 srv 提示补全`

---

### Task 8: CLI im market / im credits + SKILL.md + 客户端测试

**Files:**
- Create: `skills/agentlink/lib/market-cli.mjs`（纯函数 `buildMarketRequest(cmd, sub, rest, flags)` → `{path, method, body}`；零依赖、无 fetch——H4b 修正：仓内 CLI 测试无 fetch stub 先例，topic-cli.test.mjs 的模式是测导出的纯函数并注入依赖，故把参数解析/端点映射抽成本模块）
- Modify: `skills/agentlink/im.mjs`（顶层 `market`、`credits` 命令：调 `buildMarketRequest` 再走现有 `api(path,{method,body})` 帮助函数（im.mjs:35 已核实存在）；`--body-file` 在此读文件）
- Modify: `skills/agentlink/SKILL.md`（市场节）
- Test: `skills/agentlink/test/market-cli.test.mjs`

**Interfaces:**
- Consumes: Task 2-7 的 REST 端点；`--body-file` 读文件为 body 文本（不存在 → 报错退出 1）。
- Produces: 子命令表（spec §4 逐字）：`list/publish demand|service/view/bid/counter/accept|reject|withdraw/select/buy/deals/deliver|accept|cancel`、`credits [send <peer> <points>]|ledger`。输出统一走现有 `out()`（JSON pretty）。

- [ ] **Step 1: 失败测试**（node:test，直接测 `buildMarketRequest` 纯函数——模式同 `test/topic-cli.test.mjs` 测纯函数的注入式写法，无 fetch stub）：

```js
// 1. im market list 解析 --kind/--tag/-q 成查询串
// 2. im market publish demand "t" --budget 500 --body-file f --tag a,b → POST body {kind:'demand',title,budget,tags:['a','b'],body:<file 内容>}
// 3. im market bid l1 --points 400 --body-file p → POST /v1/market/listings/l1/bids
// 4. im credits send bob 100 --note hi → POST /v1/credits/transfer {to:'bob',points:100,note:'hi'}
// 5. --body-file 缺文件 → buildMarketRequest 抛错（im.mjs 捕获打印后退出非 0 且错误信息含路径）——纯函数测试断言其 throw
// 6. im market accept b1 / select l1 b1 / buy l1 / deliver d1 --note … → 对应端点与 method 正确
```

- [ ] **Step 2-5**: Commit `feat: im market/credits CLI 与 SKILL 文档`
- SKILL.md 追加「信用市场」节（命令表 + 三行经济规则：faucet 100/日、5% 佣金、48h 自动验收），并更新 `web/onboarding.md` 市场命令段（`Ruling: onboarding 只加命令一览五行，不展开`）。

---

## Self-Review 记录

- Spec 覆盖：§1 数据模型→T1/T2；§2.1 悬赏流→T4/T5；§2.2 直购→T5；§2.3 账本 kind→T2；§2.4 过期退款→T3/T6；§2.5 事件→T7；§3 API→T2/T3/T4/T5；§4 CLI→T8；§5 配置→T1；§6 错误码→各任务测试矩阵；§7 安全→T2(fuzz)/T3(admin)；§8 测试面→各任务+T6；§9 RF1-5→对应任务（见 Review Focus 落点）；§10 DDL→T1。无缺口。
- 类型一致：`Deal/Bid/Listing` 三接口在 T3/T4/T5 间签名一致；`settleAccepted` 抽取在 T6 接口块写明供 T5 路由复用（实现顺序上 T5 先内联、T6 抽公共——T6 brief 注明改 T5 函数为调公共段）。
- 无占位符：T1 Step1 的迁移测试给了断言清单与「抄 migration-v3 模式」的精确指令（实现者需先读该文件——这是引用而非占位）。

## critic r1 修订记录（2026-10-03）

- H1：日桶限频改 SlidingWindow(86_400_000)（TokenBucket 连续补充会持续超额），方法名以 ratelimit.ts:18 实现为准。
- H2：transfer 采 spec 语义双向各 5% burn（A 出 105、B 得 95），测试同步改。
- H3：acceptBid/建 deal 逻辑整体移入 T5（T4 只做 bid 状态机）；T5 新增 `acceptServiceBid` 承接 service 议价成交，路由 `POST /v1/market/bids/:id/accept`。
- H4：游标分页给出完整复合游标实现（仓内无先例）；T8 抽 `lib/market-cli.mjs` 纯函数（CLI 测试无 fetch stub 先例）；scanner 接线改 `startScanner` 加可选 `marketScan` 参数（tick 闭包在 tasks.ts:174，index.ts 无回调）。
- M1：buyService/acceptServiceBid 补 policy 预检（closed 卖家先拒、资金不动）。
- M2：expiring TTL = max(旧值, now+ttlHours)，只延不缩。
- M3：service open listing 过期同置 expired（无资金副作用）。
- M4：settlePayout 走 creditAccount 上限检查，溢出整单回滚、deal 保持 delivered、scanner 重试 + srv 提醒。
- M5：pool 端点认证维持既有 Ruling。

## critic r2 修订记录（2026-10-03）

- H-1：`new SlidingWindow(quota, 86_400_000)`——第 1 参是 capacity（ratelimit.ts:20），r1 伪码参数顺序错误会致配额失效。
- H-2：transfer 采方案甲——to 行 `transfer_in(+points)+burn(-fee)` 净得 95；spec §1 字面（+（points−税）+ burn 行）自相矛盾（会凭空多销毁 5 点），此为对 spec 歧义的裁决并记录。
- 小1：T4 的 BID_CLOSED 断言改手工 UPDATE 造非 pending 态；accepted 态断言移 T5。
- 小2：payout 溢出 srv 提醒用 deal 级幂等 client_msg_id（derive 幂等冲突静默跳过，防 scanner tick 刷屏）。
- 小3：`MARKET_BALANCE_OVERFLOW` 为 spec §6 错误码表之外的扩展，记 Ruling。
