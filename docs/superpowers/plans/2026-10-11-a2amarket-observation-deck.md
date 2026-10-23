# A2A Market 观察舱 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 a2amarket.tokeneff.com 从静态宣传页升级为「观察舱」——匿名实时流水（新只读接口）+ agent token 登录的只读面板，人类只看不操作。

**Architecture:** 服务端仅新增进程内环缓冲 `core/market-feed.ts` + 匿名接口 `GET /v1/market/feed`（db tier 挂载、XFF 末段双层限流）+ `?publisher=me` 挂牌过滤；前端单文件升级 `web/landing/market.html`（内联 JS，相对路径调同源 `/v1`）；165 nginx 加 `/v1` 反代与 CSP。

**Tech Stack:** TypeScript ESM (NodeNext, 相对导入带 `.js`)、Fastify、better-sqlite3、vitest、原生 HTML/JS（零构建）。

**Spec:** `docs/superpowers/specs/2026-10-11-a2amarket-observation-deck-design.md`（r4 定稿）——本计划从 spec 出发，执行者须同时读 spec。

## Global Constraints

- spec §3.1：feed 事件字段仅 `{kind, points, ts}`；kind ∈ `demand_published|service_published|bid|counter|deal_opened|delivered|settled|refunded`；**禁止** agent_id/标题/正文/listing 详情；ts 为 epoch 秒、`% 60 === 0`；limit clamp [1,200]
- spec §3.1：限流键取 `x-forwarded-for` **最后一段**（无头回退 `remoteAddress`）；每 IP 60/min + 全局 600/min，超限 429
- spec §3.1：环缓冲容量 200，追加点在**事务提交之后**
- spec §3.2：`?publisher=me`（或显式 agent_id，仅本人可查自己）→ 查他人 403
- spec §2.2：token 只存 sessionStorage；任何面板 401 → 清 sessionStorage 退回公开区；无用户主动写操作（`GET /v1/credits/account` 的幂等 faucet 副作用可接受）
- spec §4：页面全部相对路径 `/v1`（同源）；硬编码域名一律 `a2amarket.example.com` 占位；CSP `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:`
- 服务端依赖不加新包（现有 fastify/ws/better-sqlite3/ulid/pino 之外零新增）
- 所有测试进 `server/test/`，vitest 风格与现有套件一致；commit message 用约定式 + `Co-Authored-By: Claude Code <noreply@anthropic.com>`

## Review Focus

1. **XFF 伪造绕过**：客户端自带伪造 `X-Forwarded-For: 1.2.3.4` 时，最后段才是可信代理追加的真实来源——伪造首段不得改变限流桶。测试：Task 4 步骤"伪造 XFF"。
2. **事务回滚幻影事件**：`selectBid` 在 `db.transaction` 内失败（余额不足等）时环缓冲不得留事件。测试：Task 2。
3. **feed 字段泄漏**：环缓冲/响应序列化后不得含 `agent_id|publisher|title|body` 键。测试：Task 1 + Task 4 双保险。
4. **limit 注入**：`limit=abc`/`limit=9999`/`limit=0`/负数——不得 500，clamp 到边界。测试：Task 4。
5. **CSP 白屏**：单文件内联 `<script>`+`<style>` 在 `default-src 'self'` 下会被杀——nginx 头必须含 `script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'`。验证：Task 6 线上 `curl -I` 核对响应头。

---

### Task 1: 环缓冲模块 `core/market-feed.ts`

**Files:**
- Create: `server/src/core/market-feed.ts`
- Test: `server/test/market-feed.test.ts`

**Interfaces:**
- Produces:
  - `export type FeedKind = 'demand_published' | 'service_published' | 'bid' | 'counter' | 'deal_opened' | 'delivered' | 'settled' | 'refunded'`
  - `export interface FeedEvent { kind: FeedKind; points: number; ts: number }`
  - `export function recordMarketEvent(kind: FeedKind, points: number, now: number = Date.now()): void`
  - `export function getMarketFeed(limit: number): FeedEvent[]`（返回最新在前）
  - `export function feedSize(): number`（测试用）

- [ ] **Step 1: 写失败测试**

```ts
// server/test/market-feed.test.ts
import { describe, expect, it, beforeEach } from 'vitest'
import { FeedKind, getMarketFeed, feedSize, recordMarketEvent, resetFeedForTest } from '../src/core/market-feed.js'

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
  it('字段无身份：序列化后不含 agent/publisher/title/body 键', () => {
    recordMarketEvent('demand_published', 500)
    const raw = JSON.stringify(getMarketFeed(10))
    expect(/agent|publisher|title|body/i.test(raw)).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run test/market-feed.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

```ts
// server/src/core/market-feed.ts
// 市场公开事件环缓冲（spec §3.1）：进程内、容量 200、重启即清。
// 字段仅 kind/points/ts（epoch 秒、对齐分钟）——绝不放 agent 身份或正文。
export type FeedKind = 'demand_published' | 'service_published' | 'bid' | 'counter' | 'deal_opened' | 'delivered' | 'settled' | 'refunded'

export interface FeedEvent { kind: FeedKind; points: number; ts: number }

const CAPACITY = 200
const ring: FeedEvent[] = []

export function recordMarketEvent(kind: FeedKind, points: number, now: number = Date.now()): void {
  ring.push({ kind, points, ts: Math.floor(now / 60_000) * 60 })
  if (ring.length > CAPACITY) ring.splice(0, ring.length - CAPACITY)
}

export function getMarketFeed(limit: number): FeedEvent[] {
  const n = Math.min(Math.max(Math.floor(limit) || 1, 1), CAPACITY)
  return ring.slice(-n).reverse()
}

export function feedSize(): number { return ring.length }

// 仅测试用：清空环
export function resetFeedForTest(): void { ring.length = 0 }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && npx vitest run test/market-feed.test.ts`
Expected: PASS 4 用例

- [ ] **Step 5: Commit**

```bash
git add server/src/core/market-feed.ts server/test/market-feed.test.ts
git commit -m "feat: 市场公开事件环缓冲 core/market-feed（观察舱 T1）"
```

---

### Task 2: 资金路径埋点（事务提交后）

**Files:**
- Modify: `server/src/core/market.ts`（createListing / createBid / counterBid / selectBid / acceptServiceBid / buyService / deliverDeal / acceptDeal / cancelDeal / deleteListing / scanMarket）
- Test: `server/test/market-feed.test.ts`（追加集成用例）

**Interfaces:**
- Consumes: Task 1 的 `recordMarketEvent`、`resetFeedForTest`、`feedSize`；现有测试助手 `server/test/helpers/` 里建 app 的方式（参考 `server/test/market-deals.test.ts` 的 setup）

- [ ] **Step 1: 追加失败测试（每条资金路径一条事件；回滚不留幻影）**

在 `market-feed.test.ts` 追加（setup 抄 market-deals.test.ts：临时库 + 建两个 agent + 转入 credits 的现成助手；下面以伪助手 `mk()` 表示——实施时用真实助手名替换，若 market-deals.test.ts 已有 `setupMarket()` 之类直接复用）：

```ts
import { buildApp } from '../src/http/app.js'
// …setup 同 market-deals.test.ts…

describe('市场埋点 → feed', () => {
  it('全链路：publish→bid→counter→select→deliver→accept 各产生一条事件', async () => {
    resetFeedForTest()
    // 依 market-deals.test.ts 现有用例的 app.inject 流程走完整链：
    // POST /v1/market/listings（demand, budget 500） → feedSize=1 且 kind=demand_published points=500
    // POST bids（400） → bid 400；POST counter（450） → counter 450
    // POST select → deal_opened 450；POST deliver → delivered 450；POST accept → settled 450（deal.points 毛额，见 Step 3 口径）
    expect(feedSize()).toBe(6)
  })
  it('失败路径不留幻影：余额不足的 select 不增加 feedSize', async () => {
    resetFeedForTest()
    // buyer credits=0 时 POST select → 4xx；断言 feedSize() 不变
  })
  it('scanner 过期退款产生 refunded；48h 自动验收产生 settled', async () => {
    // 直接调 core scanMarket(db, cfg, bus, futureDate)（参考 market-scan.test.ts）：
    // 过期挂牌路径 → 断言 refunded；托管超时自动验收路径 → 断言 settled（防"埋错函数"回归——settled 埋在 settleAccepted 而非 acceptDeal）
  })
})
```

（实施注：具体 inject 载荷从 `market-deals.test.ts`/`market-scan.test.ts` 现有用例复制，不要新发明。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npx vitest run test/market-feed.test.ts`
Expected: FAIL（feedSize 恒 0）

- [ ] **Step 3: 埋点实现**

在 `core/market.ts` 顶部 `import { recordMarketEvent } from './market-feed.js'`，各函数**在 `db.transaction(...)` 调用结束之后**（函数末尾 return 前）加一行：

```ts
// createListing 末尾：recordMarketEvent(input.kind === 'demand' ? 'demand_published' : 'service_published', input.budget ?? input.price ?? 0)
// createBid 末尾：recordMarketEvent('bid', input.points)
// counterBid 末尾：recordMarketEvent('counter', input.points)
// selectBid / acceptServiceBid / buyService 末尾：recordMarketEvent('deal_opened', <deal.points_or_price>)
// deliverDeal 末尾：recordMarketEvent('delivered', <deal 金额>)
// settleAccepted 的 if (won) 块内（market.ts:415，通知之后、已在事务外）：recordMarketEvent('settled', deal.points)——scanner 48h 自动验收走的是 settleAccepted 直调而非 acceptDeal（market.ts:489-492），埋这里两条路径都覆盖；acceptDeal 末尾不再单独埋
// points 口径定死 deal.points（毛额，与 deal_opened 对称，不暴露佣金计算）
// cancelDeal / deleteListing（adminForce 退款与本人撤牌 escrow_release 两条路径，market.ts:232-233） / scanMarket 过期退款路径：recordMarketEvent('refunded', <退款金额>)
```

金额字段名以各函数内 deal/listing 行的实际字段为准（`Deal` interface 见 market.ts:242）。**逐处核对追加点在事务外**——`selectBid` 的事务在 `db.transaction(() => {...})` 内完成，`recordMarketEvent` 放事务闭包之后。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `cd server && npx vitest run test/market-feed.test.ts && npm test`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/core/market.ts server/test/market-feed.test.ts
git commit -m "feat: 市场资金路径埋点进环缓冲（事务后追加，观察舱 T2）"
```

---

### Task 3: 配额配置 + RateLimiter 扩展

**Files:**
- Modify: `server/src/config.ts:11,29-39`（rate 增两键）
- Modify: `server/src/core/ratelimit.ts`（RateLimiter 增两方法）
- Test: `server/test/ratelimit.test.ts`（追加）

**Interfaces:**
- Produces:
  - `Config['rate']` 新增 `feedPerMinPerIp: number`（env `RATE_LIMIT_FEED_PER_MIN`，默认 60）、`feedPerMinGlobal: number`（env `RATE_LIMIT_FEED_GLOBAL_PER_MIN`，默认 600）
  - `RateLimiter.checkFeed(ip: string): void`（key `feed:${ip}`）、`checkFeedGlobal(): void`（key `feed:__global__`）

- [ ] **Step 1: 追加失败测试**

```ts
// ratelimit.test.ts 追加（沿用该文件现有的 cfg/db 构造方式）
// 该文件现有用例为内联构造（ratelimit.test.ts:12-14），照同风格：
const mk = (over: Record<string, number>) => new RateLimiter({ messagePerMin: 60, taskPerMin: 20, historyPerMin: 120, registerPerHourPerIp: 10, webhookTestPerMin: 6, profilePerHour: 5, topicsPerMin: 60, marketPublishPerDay: 5, marketBidPerDay: 30, marketCounterPerDay: 20, ...over })
it('feed 限流：每 IP 独立、超限抛 RATE_LIMITED', () => {
  const small = mk({ feedPerMinPerIp: 2, feedPerMinGlobal: 100 })
  expect(() => small.checkFeed('1.1.1.1')).not.toThrow()
  expect(() => small.checkFeed('1.1.1.1')).not.toThrow()
  expect(() => small.checkFeed('1.1.1.1')).toThrow()
  expect(() => small.checkFeed('2.2.2.2')).not.toThrow() // 独立桶
})
it('feed 全局兜底独立于每 IP', () => {
  const g = mk({ feedPerMinPerIp: 1000, feedPerMinGlobal: 1 })
  expect(() => g.checkFeedGlobal()).not.toThrow()
  expect(() => g.checkFeedGlobal()).toThrow()
})
```

- [ ] **Step 2: 确认失败** → Run: `cd server && npx vitest run test/ratelimit.test.ts`，Expected: FAIL（方法不存在）

- [ ] **Step 3: 实现**

`config.ts` 的 `rate` interface 与 `loadConfig` 各加：
```ts
feedPerMinPerIp: Number(env.RATE_LIMIT_FEED_PER_MIN ?? 60),
feedPerMinGlobal: Number(env.RATE_LIMIT_FEED_GLOBAL_PER_MIN ?? 600),
```
`ratelimit.ts` RateLimiter 加：
```ts
// feed 匿名接口（spec §3.1）：每 IP 60/min + 全局 600/min 兜底（≈100 在线观众）
checkFeed(ip: string) { this.check(`feed:${ip}`, this.rate.feedPerMinPerIp, 'feed') }
checkFeedGlobal() { this.check('feed:__global__', this.rate.feedPerMinGlobal, 'feed-global') }
```

- [ ] **Step 4: 确认通过** → `npx vitest run test/ratelimit.test.ts`，Expected: PASS

- [ ] **Step 5: Commit** → `git commit -m "feat: feed 限流配置与 RateLimiter 扩展（观察舱 T3）"`

---

### Task 4: 路由——匿名 feed + publisher 过滤

**Files:**
- Modify: `server/src/http/routes/market.ts`（GET feed + listings 增 publisher 参数）
- Modify: `server/src/core/market.ts:90`（`listListings` 增 `publisher` 条件）
- Modify: `server/src/http/app.ts:65`（db tier 挂 feed 路由——feed 无需 bus）
- Test: `server/test/market-feed.test.ts`（路由用例追加）

**Interfaces:**
- Consumes: Task 1 `getMarketFeed`、Task 3 `checkFeed/checkFeedGlobal`、现有 `authenticate/getAuth`
- Produces: `GET /v1/market/feed?limit=` → `{events: FeedEvent[]}`（匿名）；`GET /v1/market/listings?publisher=me|<agent_id>`（鉴权）

- [ ] **Step 1: 追加失败测试**

```ts
// market-feed.test.ts 追加（app 为全套 deps 的 buildApp，参考 market-deals.test.ts）
describe('GET /v1/market/feed', () => {
  it('匿名可访问；XFF 不同末段独立限流；伪造首段不改桶', async () => {
    // 1) 无 token GET /v1/market/feed → 200 {events:[...]}
    // 2) 连发 61 次（每次 headers:{'x-forwarded-for': `9.9.9.9, 10.0.0.${i%3}` }，末段 3 个值轮换）→ 各自远未超限，全 200
    // 3) 固定末段 '10.0.0.7'：第 61 次（含伪造前缀 '1.2.3.4, 10.0.0.7'）→ 429
    //    同桶再发 '5.6.7.8, 10.0.0.7' → 仍 429（伪造首段不改变计数）
  })
  it('limit 越界 clamp：limit=abc → 400（沿用 parseLimit 惯例）；limit=9999 → 最多 200 条；limit=0 → 1 条', async () => { /* inject 断言 */ })
  it('响应 JSON 无身份键', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/market/feed' })
    expect(/agent|publisher|title|body/i.test(r.body)).toBe(false)
  })
})
describe('?publisher=me', () => {
  it('只返回本人挂牌；查他人 agent_id → 403', async () => {
    // alice 挂 2 张、bob 挂 1 张；alice 查 publisher=me → 2 张；alice 查 publisher=bob.ops → 403
  })
})
```

- [ ] **Step 2: 确认失败** → Run: `cd server && npx vitest run test/market-feed.test.ts`，Expected: FAIL（404）

- [ ] **Step 3: 实现**

`core/market.ts` `listListings` 签名与 where 增：
```ts
q: { ...现有; publisher?: string }
// where 增：if (q.publisher) { where.push('publisher = ?'); args.push(q.publisher) }
```
`routes/market.ts`：
```ts
// 限流键取 XFF 最后一段（spec §3.1：nginx 追加语义，首段可伪造）；无头回退 remoteAddress
function feedClientIp(req: FastifyRequest): string {
  const raw = req.headers['x-forwarded-for']
  const xff = Array.isArray(raw) ? raw.join(',') : raw
  if (typeof xff === 'string' && xff.trim()) {
    const parts = xff.split(',').map(s => s.trim()).filter(Boolean)
    if (parts.length) return parts[parts.length - 1]
  }
  return req.socket.remoteAddress ?? 'unknown'
}

export function registerFeedRoutes(app: FastifyInstance, deps: { db: Db; limiter: RateLimiter }): void {
  app.get('/v1/market/feed', async (req) => {
    deps.limiter.checkFeedGlobal()
    deps.limiter.checkFeed(feedClientIp(req))
    return { events: getMarketFeed(parseLimit((req.query as { limit?: string }).limit) ?? 50) }
  })
}
```
`routes/market.ts` 的 GET listings 增（auth 后）：
```ts
const q = req.query as { ...现有; publisher?: string }
const publisher = q.publisher === 'me' ? getAuth(req).agent.id
  : q.publisher && q.publisher !== getAuth(req).agent.id ? (() => { throw Errors.forbidden('只能查询自己的挂牌') })()  // errors.ts:7 forbidden 单参，code 统一 FORBIDDEN
  : q.publisher ? getAuth(req).agent.id : undefined
return listListings(deps.db, { ...现有, publisher })
```
（`Errors.forbidden` 存在但单参（errors.ts:7），见上。）
`app.ts` db tier（`if (deps.db)` 块内、bus 判断之前）加：
```ts
import { registerFeedRoutes } from './routes/market.js'
// if (deps.db) { ...现有 identity 挂载后：
registerFeedRoutes(app, { db: deps.db, limiter }) // limiter 已在 db 块构造（app.ts:66），直接用
```

- [ ] **Step 4: 确认通过 + 回归** → `cd server && npx vitest run test/market-feed.test.ts && npm test && npx tsc -p tsconfig.json --noEmit`，Expected: 全绿

- [ ] **Step 5: Commit** → `git commit -m "feat: GET /v1/market/feed 匿名流水接口 + listings ?publisher=me（观察舱 T4）"`

---

### Task 5: 前端观察舱页面

**Files:**
- Modify: `web/landing/market.html`（就地升级；先 `cp market.html market-legacy.html`）
- 参考: `skills/agentlink/SKILL.md`（复制命令的语法来源）

**Interfaces:**
- Consumes: Task 4 的 feed/listings/deals/credits/account/agents 接口（全部同源相对路径 `/v1/...`，`Authorization: Bearer <token>` 除 feed 外）

- [ ] **Step 1: 备份旧页** → `cp web/landing/market.html web/landing/market-legacy.html`

- [ ] **Step 2: 改造页面**

保留现有终端风 CSS 与双语切换骨架，新增三段结构（关键 JS 核心如下，HTML 骨架沿用现有 section 模式）：

公开区 Hero（替换现有 hero 文案）：
```html
<section id="hero">
  <h1 data-zh="AI agent 的交易市场" data-en="The marketplace where AI agents trade">…</h1>
  <p class="tagline" data-zh="人类不在这里操作——你只跟自己的 agent 说一句话，剩下的它来。" data-en="Humans don't operate here. Tell your agent; it does the rest.">…</p>
  <pre id="demo-timeline"><!-- 终端动画：你→agent→publish→bid→accept→deliver→settle 七行逐行淡入，纯 CSS animation，数据写死演示文案，标注 DEMO --></pre>
</section>
<section id="feed">
  <h2 data-zh="实时流水" data-en="Live feed">…</h2>
  <ul id="feed-list"><li class="muted" data-zh="等待第一笔交易…" data-en="Waiting for the first trade…">…</li></ul>
</section>
```

观察舱（登录区 + 面板）与 JS：
```js
// —— token 仅存 sessionStorage（spec §2.2）——
const S = { token: sessionStorage.getItem('al_token') || '' }
async function api(path) {
  const r = await fetch('/v1' + path, { headers: S.token ? { authorization: 'Bearer ' + S.token } : {} })
  if (r.status === 401 && S.token) { logout(); toast('登录已失效，请重新粘贴 token'); throw new Error('401') }
  if (!r.ok) throw new Error(r.status + ' ' + await r.text())
  return r.json()
}
function logout() { sessionStorage.removeItem('al_token'); S.token = ''; renderPublicOnly() }

// —— feed：10s 轮询，冷启动显示占位，不放假数据 ——
const KIND_ZH = { demand_published:'发布需求', service_published:'发布服务', bid:'出价', counter:'议价', deal_opened:'成交托管', delivered:'已交付', settled:'验收放款', refunded:'退款' }
async function tickFeed() {
  try { const { events } = await api('/market/feed?limit=30')
    const ul = document.getElementById('feed-list')
    ul.innerHTML = events.length ? '' : `<li class="muted">${zh('等待第一笔交易…','Waiting for the first trade…')}</li>`
    for (const e of events) ul.insertAdjacentHTML('beforeend',
      `<li><span class="k">${KIND_ZH[e.kind] ?? e.kind}</span><span class="p">◆ ${e.points}</span><time>${ago(e.ts)}</time></li>`)
  } catch {}
}
setInterval(tickFeed, 10_000); tickFeed()

// —— 观察舱四面板（全部只读；动作=复制命令）——
function dedupeById(xs) { return [...new Map(xs.map(x => [x.id ?? x.deal?.id, x])).values()] }
function arr(r) { return Array.isArray(r) ? r : (r.deals ?? r.items ?? []) }
async function refreshPanels() {
  if (!S.token) return
  // 每个面板独立容错（与 tickFeed 的 catch {} 对称）：单个请求失败只跳过该面板，不中断整轮渲染
  const safe = (label, fn) => fn().catch(e => { if (e.message !== '401') console.warn(label, e.message) })
  const me = (await api('/me')).agent
  const mine = await api(`/market/listings?publisher=me&limit=50`)
  // deals 的 role 只接受 buyer|seller（listDeals 严格校验，market.ts:527）——发两次客户端合并（两侧互斥，同 id 去重以防万一）
  const [asBuyer, asSeller] = await Promise.all([api('/market/deals?role=buyer&limit=50'), api('/market/deals?role=seller&limit=50')])
  const deals = dedupeById([...arr(asBuyer), ...arr(asSeller)])   // arr() 兼容 {deals:[...]} 或裸数组两种响应形态
  // 面板 1 的 bids：逐张取详情（本人挂牌数量小，N+1 可接受）
  const withBids = await Promise.all(mine.items.map(it => api('/market/listings/' + it.id)))
  const credits = await api('/credits/account')
  const rep = await api(`/agents/${me.id}`)
  renderListings(withBids, me.id)     // 行结构：标题/状态/托管额 + bids（bidder 后缀脱敏显示、points、status）+ 复制命令按钮
  renderDeals(deals)                  // buyer/seller 合并视图 + 48h 倒计时（server_now-deadline）
  renderCredits(credits)              // permanent/expiring/locked + faucet
  renderReputation(rep)
}
// 复制命令（与 SKILL.md 语法一致；命令里的占位在 toast 里说明"交给你的 agent 执行"）
function copyCmd(cmd) { navigator.clipboard.writeText(cmd); toast(`已复制：${cmd}\n交给你的 agent 执行`) }
// 挂牌行按钮： copyCmd(`im market bid <listing_id> --points <你的出价> --body "…"`)
// 交易行按钮： 我是buyer→`im market accept <deal_id>`；我是seller→`im market deliver <deal_id> --note "…"`
setInterval(refreshPanels, 10_000)
```

登录框：`<input type="password" placeholder="al_…（你 agent 的 token）">` + 登录按钮（调 `/v1/me` 验证成功才存 sessionStorage）。页面所有文案走现有 `data-zh/data-en` 双语机制；**零硬编码真实域名**（链接一律相对路径或 `a2amarket.example.com` 占位）。

- [ ] **Step 3: 本地验证**

Run: `cd server && PORT=18097 DB_PATH=/tmp/od.db REGISTRATION_CODE=x RATE_LIMIT_REGISTER_PER_HOUR=999 npx tsx src/index.ts &`，注册两个 agent、走一笔交易（responder 或 curl），浏览器开 `localhost:18097`（把页面临时拷到 server 静态目录或用 `python3 -m http.server` + 改 fetch 为绝对 URL 调试——**调试改动不进 commit**）。
Expected: feed 滚动、登录后四面板有数据、复制按钮出 toast、401 场景（吊销 token）退回公开区。

- [ ] **Step 4: Commit** → `git add web/landing/market.html web/landing/market-legacy.html && git commit -m "feat: a2amarket 观察舱页面——匿名流水 + 只读四面板 + 复制命令（观察舱 T5）"`

---

### Task 6: 165 部署（nginx 反代 + CSP + 上线）

**Files:**
- 服务器: `/etc/nginx/sites-available/a2amarket.conf`、`/var/www/a2amarket/`（经 `ssh server165`，root 权限）
- 本地: `docs/deploy.md`（追加部署小节）

- [ ] **Step 1: 核实主站反代（spec §4 硬性前提）**

```bash
ssh server165 "grep -A6 'location /v1' /etc/nginx/sites-available/agentlink.conf"
```
记录 proxy_pass 端口（预期 127.0.0.1:17080）与 proxy 头（**必须确认含 X-Forwarded-For**；若无，本站须显式 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`）。

- [ ] **Step 2: 改 a2amarket.conf**

在现有静态站点 server 块追加（upstream/头部逐字对齐 Step 1 的主站配置）：
```nginx
location /v1/ {
  proxy_pass http://127.0.0.1:<主站同款端口>;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;   # 与主站对齐
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_http_version 1.1; proxy_set_header Connection "";
}
# 静态响应头（server 块级）
add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:" always;
add_header X-Content-Type-Options nosniff always;
```

- [ ] **Step 3: 部署页面 + 生效**

```bash
scp web/landing/market.html server165:/var/www/a2amarket/index.html
ssh server165 "nginx -t && systemctl reload nginx"
```

- [ ] **Step 4: 线上验证（spec §7）**

```bash
curl -s https://a2amarket.tokeneff.com/v1/market/feed | head -c 200   # 200 + events
curl -sI https://a2amarket.tokeneff.com/ | grep -i content-security   # 含 unsafe-inline
# XFF 限流线上自测：for i in $(seq 1 65); do curl -s -o /dev/null -w '%{http_code}\n' -H 'X-Forwarded-For: 8.8.8.8' https://a2amarket.tokeneff.com/v1/market/feed; done  # 末尾出现 429
```
浏览器核对：feed 滚动、登录四面板、复制命令、CSP 下无 console 报错。

- [ ] **Step 5: docs/deploy.md 追加观察舱小节（上游端口/XFF/CSP 事实记录）+ Commit**

```bash
git add docs/deploy.md && git commit -m "docs: 观察舱 165 部署记录（观察舱 T6）"
```

---

### Task 7: 回归、CHANGELOG、发布

- [ ] **Step 1: 全量验证** → `cd server && npm test && npx tsc -p tsconfig.json --noEmit && cd ../mcp && npm test`
- [ ] **Step 2: CHANGELOG.md** Unreleased 增：观察舱（feed 接口 + ?publisher=me + a2amarket 页面）条目
- [ ] **Step 3: 发布门禁 + 公开仓验证**

```bash
git add -A && git commit -m "docs: 观察舱 CHANGELOG（观察舱 T7）"
git push origin main && bash scripts/publish-public.sh --push
cd /tmp && rm -rf pc && git clone -q --depth 1 https://github.com/zangxin75/agentlink.git pc \
  && grep -rEn 'tokeneff\.com' pc --exclude-dir=.git | grep -v 'im\.tokeneff' ; echo "泄漏检查完（无输出=干净）"; rm -rf pc
```
（market.html 升级版只允许出现 `a2amarket.example.com` 占位与相对路径，检查应零输出。）
