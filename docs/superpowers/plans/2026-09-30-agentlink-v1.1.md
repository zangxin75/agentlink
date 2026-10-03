# AgentLink v1.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 v1 之上交付五个特性：消息线程（thread_id 打通）、人类可观测（任务事件流 + webhook 通知）、声誉（客观统计 + 任务评价）、交付验收（result_schema）、预算记账（budget + append-only ledger）。

**Architecture:** 全部为 v1 单体（Fastify REST + ws + better-sqlite3）内的增量扩展：新列走 ALTER + `PRAGMA user_version 0→2` 事务迁移；新端点沿用 v1 路由/错误码/限流模式；webhook 出站为进程内异步队列（at-most-once）；ledger 为 append-only 事件表，与任务终态同事务写入。零新运行时依赖。

**Tech Stack:** Node ≥20、TypeScript、Fastify、ws、better-sqlite3、vitest、原生 fetch/AbortController/node:dns。

**Spec:** `docs/superpowers/specs/2026-09-30-agentlink-v1.1-design.md`（v3 定稿；执行者必读，特别是 §1/§2/§5 与 §11 钉子）

## Global Constraints

- 运行时依赖维持 v1 红线，**不新增任何依赖**（result_schema 校验器自研）。
- 大小红线（core 层按字节 `Buffer.byteLength` 校验，route schema 双层）：thread_id ≤64 字符、webhook_url ≤512、result_schema ≤8KB、review comment ≤1KB、budget note ≤256、budget amount 整数 1..10^13。
- 错误格式 `{error:{code,message}}`；新码只增不重载：`SCHEMA_UNSUPPORTED`(422)、`RESULT_SCHEMA_MISMATCH`(422)、`REVIEW_WINDOW_CLOSED`(422)、`TASK_NOT_FINISHED`(422)、`ALREADY_REVIEWED`(409)。
- 兼容承诺：v1 客户端零改动可用；不传新字段 = v1 行为；WS `message` 帧 `thread_id` 字段始终存在（null=v1 值）；DB 前向迁移幂等（user_version + transaction），不承诺降级。
- SSRF：webhook 出站**每次请求发起时**按当次解析 IP 复检（私网/环回/link-local 默认拒绝），重定向逐跳复检（redirect:'manual'）；`WEBHOOK_ALLOW_PRIVATE=true` 放开。
- 事务性：任务终态 UPDATE + ledger INSERT + audit INSERT 同一 `db.transaction()`。
- 代码风格跟随 v1：单行紧凑、中文行注释解释"为什么"、无死代码、测试文件与被测模块同名。
- 每任务：先写失败测试→跑红→实现→跑绿→`git commit`。全量回归 `npm test`（根工作区）。

## Review Focus（spec §11 五钉，测试必须落在对应任务）

1. **同 peer 双线程互不串扰**；NULL 消息不入任何 thread 过滤；`peer` 缺省 + `thread_id` 全局过滤正确 → Task 2
2. **Webhook 出站零阻塞**：目标挂起时消息/任务路径延迟无退化；重试耗尽 audit `webhook.failed`；SSRF 默认拒绝私网、`WEBHOOK_ALLOW_PRIVATE` 放开 → Task 5/6
3. **验收失败可重交**：422 后仍 RUNNING、修正重交 COMPLETED、deadline 不顺延、心跳停摆被 TIMEOUT；校验器操作符矩阵正反全覆盖 → Task 8/9
4. **账本不变量**：无 agreed 不可能有 settled；settled/voided 互斥至多其一；EXPIRED/REJECTED/policy/pre-accept-CANCELLED 零事件；终态+ledger+audit 同事务（故障注入） → Task 10
5. **声誉不可自评**：非 requester 403、非终态 422、重复 409、归责口径正确、列表批量聚合（断言 SQL 次数） → Task 3/7

---

### Task 1: 迁移 v2 + 新配置项

**Files:**
- Modify: `server/src/db/schema.ts`、`server/src/config.ts`、`server/src/core/ratelimit.ts`、`server/src/http/errors.ts`
- Test: `server/test/migration-v2.test.ts`

**Interfaces:**
- Produces: `migrate()` 幂等升级到 `PRAGMA user_version=2`；agents 新列 `webhook_url TEXT`、`webhook_secret TEXT`；tasks 新列 `result_schema TEXT`、`budget_amount INTEGER`、`budget_currency TEXT NOT NULL DEFAULT 'credit'`；新表 `task_reviews`、`ledger_events`；新索引 `idx_messages_thread(thread_id,id) WHERE thread_id IS NOT NULL`、`idx_audit_task(audit_log 上 json_extract(detail,'$.task_id'))`
- Produces: `Config.webhookAllowPrivate: boolean`（env `WEBHOOK_ALLOW_PRIVATE==='true'`）、`Config.rate.webhookTestPerMin: number`（env `RATE_LIMIT_WEBHOOK_TEST_PER_MIN` 默认 6）
- Produces: `RateLimiter.checkWebhookTest(agentId: string): void`
- Produces: `Errors.unprocessable(code: string, message: string): AppError`（status 422）

- [ ] **Step 1: 写失败测试**

```ts
// server/test/migration-v2.test.ts
import { describe, it, expect } from 'vitest'
import { openDb, migrate } from '../src/db/sqlite.js'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { loadConfig } from '../src/config.js'

const fresh = () => { const db = openDb(join(mkdtempSync(join(tmpdir(), 'al-')), 't.db')); migrate(db); return db }

describe('migration v2', () => {
  it('fresh db has v2 columns/tables/indexes and user_version=2', () => {
    const db = fresh()
    expect((db.prepare('PRAGMA user_version').get() as any).user_version).toBe(2)
    const agentCols = (db.prepare('PRAGMA table_info(agents)').all() as any[]).map(c => c.name)
    expect(agentCols).toEqual(expect.arrayContaining(['webhook_url', 'webhook_secret']))
    const taskCols = (db.prepare('PRAGMA table_info(tasks)').all() as any[]).map(c => c.name)
    expect(taskCols).toEqual(expect.arrayContaining(['result_schema', 'budget_amount', 'budget_currency']))
    for (const t of ['task_reviews', 'ledger_events']) expect(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t)).toBeTruthy()
    expect(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_messages_thread'`).get()).toBeTruthy()
    expect(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_audit_task'`).get()).toBeTruthy()
  })
  it('migrate is idempotent (second run no-throw)', () => { const db = fresh(); expect(() => migrate(db)).not.toThrow() })
  it('v1 INSERT paths unaffected by new columns (explicit column lists)', () => {
    const db = fresh()
    db.prepare(`INSERT INTO messages (id, client_msg_id, from_agent, to_agent, type, body, thread_id, created_at) VALUES ('m1','c1','a','b','text','{}',NULL,'2026-01-01T00:00:00Z')`).run()
    expect(db.prepare(`SELECT budget_currency FROM tasks LIMIT 1`).all().length).toBe(0) // 空表可查即列在
    expect((db.prepare('SELECT COUNT(*) c FROM messages').get() as any).c).toBe(1)
  })
  it('config reads new envs', () => {
    expect(loadConfig({ WEBHOOK_ALLOW_PRIVATE: 'true' } as never).webhookAllowPrivate).toBe(true)
    expect(loadConfig({} as never).webhookAllowPrivate).toBe(false)
    expect(loadConfig({ RATE_LIMIT_WEBHOOK_TEST_PER_MIN: '3' } as never).rate.webhookTestPerMin).toBe(3)
    expect(loadConfig({} as never).rate.webhookTestPerMin).toBe(6)
  })
})
```

- [ ] **Step 2: 跑红**

Run: `cd server && npx vitest run test/migration-v2.test.ts`
Expected: FAIL（user_version=0、列不存在）

- [ ] **Step 3: 实现**

`schema.ts`：保留现有 v1 `db.exec(...)` 原样（CREATE IF NOT EXISTS 全体），随后追加：

```ts
  // v1.1 迁移：user_version 门控（SQLite ALTER ADD COLUMN 无 IF NOT EXISTS，靠版本号防重跑）；
  // user_version 写入是事务性的，DDL+版本号同事务原子提交（r1-M2/r2 已核）
  const v = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  if (v < 2) {
    db.transaction(() => {
      db.exec(`
      ALTER TABLE agents ADD COLUMN webhook_url TEXT;
      ALTER TABLE agents ADD COLUMN webhook_secret TEXT;
      ALTER TABLE tasks ADD COLUMN result_schema TEXT;
      ALTER TABLE tasks ADD COLUMN budget_amount INTEGER;
      ALTER TABLE tasks ADD COLUMN budget_currency TEXT NOT NULL DEFAULT 'credit';
      CREATE TABLE IF NOT EXISTS task_reviews (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id),
        rater TEXT NOT NULL, ratee TEXT NOT NULL,
        rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
        comment TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ledger_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        type TEXT NOT NULL CHECK(type IN ('agreed','settled','voided')),
        payer TEXT NOT NULL, payee TEXT NOT NULL,
        amount INTEGER NOT NULL, currency TEXT NOT NULL,
        created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, id) WHERE thread_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_audit_task ON audit_log(json_extract(detail,'$.task_id'));
      `)
      db.prepare('PRAGMA user_version = 2').run()
    })()
  }
```

`config.ts`：`Config` 接口加 `webhookAllowPrivate: boolean`；`rate` 加 `webhookTestPerMin: number`；`loadConfig` 加 `webhookAllowPrivate: env.WEBHOOK_ALLOW_PRIVATE === 'true'` 与 `webhookTestPerMin: Number(env.RATE_LIMIT_WEBHOOK_TEST_PER_MIN ?? 6)`。

`ratelimit.ts` 加：`checkWebhookTest(agentId: string) { this.check(`wht:${agentId}`, this.rate.webhookTestPerMin, 'webhook-test') }`

`errors.ts` 加：`unprocessable: (code: string, m: string) => new AppError(code, 422, m),`

- [ ] **Step 4: 跑绿 + 全量回归**

Run: `cd server && npx vitest run test/migration-v2.test.ts && npx vitest run`
Expected: 全 PASS（既有 82 用例不受影响）

- [ ] **Step 5: 提交**

```bash
git add server/src server/test/migration-v2.test.ts
git commit -m "feat: v1.1 migration (user_version 2), config and rate bucket for webhook"
```

---

### Task 2: thread 端到端（core 校验单点 + REST + WS）

**Files:**
- Modify: `server/src/core/messages.ts`、`server/src/http/routes/messages.ts`、`server/src/http/routes/send.ts`、`server/src/ws/hub.ts`
- Test: `server/test/thread.test.ts`

**Interfaces:**
- Consumes: Task 1 迁移（`idx_messages_thread`）
- Produces: `sendMessage(db, bus, from, input: { to; type; body; client_msg_id; thread_id?: string | null })`——校验 `THREAD_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/`，非法 400；合法写入；缺省 NULL
- Produces: `history(db, agentId, q: { peer?: string; thread_id?: string; before?; after?; limit })`——`thread_id` 存在时按 thread 过滤（peer 存在再叠加方向）；`getInbox(db, agentId, limit, threadId?: string)`
- Produces: REST `POST /v1/messages` 可选 `thread_id`；`GET /v1/history` 的 `peer` 改可选 + `thread_id` 参数（peer 出现时保留 404 存在性校验）；`GET /v1/inbox?thread_id=`；WS `send` 帧支持 `thread_id`

- [ ] **Step 1: 写失败测试**

```ts
// server/test/thread.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import WebSocket from 'ws'
import { startWsServer } from './helpers/ws-server.js'

let srv: Awaited<ReturnType<typeof startWsServer>> | null = null
afterEach(async () => { await srv?.close(); srv = null })
const H = (t: string) => ({ authorization: `Bearer ${t}` })
const send = async (token: string, body: any) => (await srv!.app.inject({ method: 'POST', url: '/v1/messages', headers: H(token), payload: body })).json()

describe('thread', () => {
  it('two threads with same peer do not cross; NULL excluded from any thread filter', async () => {
    srv = await startWsServer()
    const a = srv.mk('alice.dev'), b = srv.mk('bob.ops')
    await send(a.token, { to: 'bob.ops', type: 'text', body: { text: 't1-a' }, client_msg_id: 'x1', thread_id: 't1' })
    await send(a.token, { to: 'bob.ops', type: 'text', body: { text: 't2-a' }, client_msg_id: 'x2', thread_id: 't2' })
    await send(a.token, { to: 'bob.ops', type: 'text', body: { text: 'no-thread' }, client_msg_id: 'x3' })
    const h1 = await srv.app.inject({ method: 'GET', url: '/v1/history?peer=bob.ops&thread_id=t1', headers: H(b.token) })
    expect(h1.json().map((m: any) => m.body.text)).toEqual(['t1-a'])
    const h2 = await srv.app.inject({ method: 'GET', url: '/v1/history?thread_id=t2', headers: H(b.token) })
    expect(h2.json().map((m: any) => m.body.text)).toEqual(['t2-a'])
    const hAll = await srv.app.inject({ method: 'GET', url: '/v1/history?peer=bob.ops', headers: H(b.token) })
    expect(hAll.json().length).toBe(3) // 不过滤时全在（v1 行为）
    const inbox = await srv.app.inject({ method: 'GET', url: '/v1/inbox?wait=0&thread_id=t1', headers: H(b.token) })
    expect(inbox.json().map((m: any) => m.body.text)).toEqual(['t1-a'])
  })
  it('invalid thread_id rejected at core (REST and message field always present', async () => {
    srv = await startWsServer()
    const a = srv.mk('alice.dev'); srv.mk('bob.ops')
    const r = await srv.app.inject({ method: 'POST', url: '/v1/messages', headers: H(a.token), payload: { to: 'bob.ops', type: 'text', body: { text: 'x' }, client_msg_id: 'y1', thread_id: '带空格 错误!' } })
    expect(r.statusCode).toBe(400)
    const ok = await srv.app.inject({ method: 'POST', url: '/v1/messages', headers: H(a.token), payload: { to: 'bob.ops', type: 'text', body: { text: 'ok' }, client_msg_id: 'y2' } })
    expect(ok.json().message.thread_id).toBe(null) // 字段始终存在（兼容承诺 §9.2）
  })
  it('ws send carries thread_id; message frame echoes it', async () => {
    srv = await startWsServer()
    const a = srv.mk('alice.dev'), b = srv.mk('bob.ops')
    const ws = new WebSocket(srv.url)
    await new Promise(r => ws.on('open', r))
    ws.send(JSON.stringify({ op: 'auth', token: b.token }))
    await new Promise(r => ws.on('message', r)) // auth_ok
    const frameP = new Promise<any>(r => ws.on('message', (raw: any) => { const f = JSON.parse(String(raw)); if (f.op === 'message' && f.message.body.text === 'via-ws') r(f) }))
    ws.send(JSON.stringify({ op: 'send', to: 'bob.ops', from: 'alice.dev', body: { text: 'via-ws' }, client_msg_id: 'w1', thread_id: 42 }))
    // thread_id 非字符串由 hub String() 规整为 '42'，core 校验通过
    await frameP.catch(() => {}) // 自发消息不推给自己：由 alice 侧确认。见下：
    const wsA = new WebSocket(srv.url)
    await new Promise(r => wsA.on('open', r))
    wsA.send(JSON.stringify({ op: 'auth', token: a.token }))
    await new Promise(r => wsA.on('message', r))
    const sentP = new Promise<any>(r => wsA.on('message', (raw: any) => { const f = JSON.parse(String(raw)); if (f.op === 'sent') r(f) }))
    wsA.send(JSON.stringify({ op: 'send', to: 'bob.ops', body: { text: 'via-ws' }, client_msg_id: 'w2', thread_id: 'wt1' }))
    const sent = await sentP
    expect(sent.message.thread_id).toBe('wt1')
    ws.close(); wsA.close()
  })
  it('history with unknown peer still 404 (v1 semantics preserved)', async () => {
    srv = await startWsServer()
    const a = srv.mk('alice.dev')
    expect((await srv.app.inject({ method: 'GET', url: '/v1/history?peer=ghost.x', headers: H(a.token) })).statusCode).toBe(404)
    expect((await srv.app.inject({ method: 'GET', url: '/v1/history?thread_id=t', headers: H(a.token) })).statusCode).toBe(200) // 仅 thread：跳过 peer 校验
  })
})
```

（注意：第三个用例里 bob 收到推文的断言改到 `frameP`——实现者应让 bob 侧断言 `f.message.thread_id === '42'`，删去 `.catch`；上面已给两路，落地时保留 bob 侧断言 + alice 侧 `sent` 断言两条。）

- [ ] **Step 2: 跑红** — Run: `cd server && npx vitest run test/thread.test.ts`  Expected: FAIL

- [ ] **Step 3: 实现**

`core/messages.ts`：
```ts
export const THREAD_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/
```
`sendMessage` 签名 input 加 `thread_id?: string | null`；在 cmid 校验后加：
```ts
  const threadId = input.thread_id ?? null
  if (threadId !== null && !THREAD_ID_RE.test(threadId)) throw Errors.invalidRequest('thread_id must match ^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$')
```
INSERT 第 7 个占位符由 `NULL` 改为 `?`，实参 `threadId`。

`history` 重写（保持 after/前后语义）：
```ts
export function history(db: Db, agentId: string, q: { peer?: string; thread_id?: string; before?: string; after?: string; limit: number }): Message[] {
  const dir = q.peer ? `((from_agent=? AND to_agent=?) OR (from_agent=? AND to_agent=?))` : '(from_agent=? OR to_agent=?)'
  const dirArgs = q.peer ? [agentId, q.peer, q.peer, agentId] : [agentId, agentId]
  const th = q.thread_id ? ' AND thread_id=?' : ''; const thArgs = q.thread_id ? [q.thread_id] : []
  if (q.after) {
    const rows = db.prepare(`SELECT ${COLS} FROM messages WHERE ${dir}${th} AND id > ? ORDER BY id LIMIT ?`).all(...dirArgs, ...thArgs, q.after, q.limit)
    return rows.map(rowToMsg)
  }
  const before = q.before ? ' AND id < ?' : ''
  const rows = db.prepare(`SELECT ${COLS} FROM messages WHERE ${dir}${th}${before} ORDER BY id DESC LIMIT ?`).all(...dirArgs, ...thArgs, ...(q.before ? [q.before] : []), q.limit)
  return rows.map(rowToMsg)
}
```
`getInbox(db, agentId, limit, threadId?: string)`：`threadId ? ' AND thread_id=?' : ''` 追加（实参条件拼接）。

`routes/messages.ts`：`/v1/history` querystring 去掉 `required: ['peer']`，`peer` 改 `maxLength 32` 可选，加 `thread_id: { type: 'string', maxLength: 64 }`；handler 改：
```ts
    const q = req.query as never as { peer?: string; thread_id?: string; before?: string; after?: string; limit?: number }
    if (q.peer) getAgent(deps.db, q.peer) // peer 出现时保留 v1 存在性校验（r2-R2-3）
    return history(deps.db, me, q)
```
`/v1/inbox` querystring 加 `thread_id: { type: 'string', maxLength: 64 }`，长轮询循环 `getInbox(deps.db, me, limit, (req.query as any).thread_id)`。

`routes/send.ts`：POST `/v1/messages` schema properties 加 `thread_id: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$' }`，透传给 sendMessage。

`ws/hub.ts` send 分支：`const th = f.thread_id == null ? null : String(f.thread_id)`，sendMessage 调用加 `thread_id: th`。

- [ ] **Step 4: 跑绿 + 回归** — Run: `cd server && npx vitest run test/thread.test.ts test/history.test.ts test/inbox.test.ts test/send.test.ts test/ws.test.ts`
Expected: PASS（history/inbox 旧用例传 peer，可选化不破坏）

- [ ] **Step 5: 提交**

```bash
git add server/src server/test/thread.test.ts
git commit -m "feat: message threads end-to-end (core-validated, REST filters, WS passthrough)"
```

---

### Task 3: 声誉统计 + 目录接线

**Files:**
- Create: `server/src/core/reputation.ts`
- Modify: `server/src/http/routes/directory.ts`
- Test: `server/test/reputation.test.ts`

**Interfaces:**
- Produces: `interface Reputation { tasks_completed: number; tasks_failed: number; tasks_timeout: number; tasks_cancelled: number; tasks_rejected: number; completion_rate: number | null; avg_duration_s: number | null; active_30d: number; avg_rating: number | null; review_count: number }`
- Produces: `reputationOf(db: Db, ids: string[]): Map<string, Reputation>`——**单条 GROUP BY executor + 单条 GROUP BY ratee 两条 SQL**（列表接口禁止 N+1）；`GET /v1/agents` 与 `/v1/agents/{id}` 响应对象加 `reputation` 字段
- 归责：completed 正向；failed/timeout 计 executor 败绩；cancelled/rejected 中性单列；`completion_rate = completed/(completed+failed+timeout)`（分母 0 → null）

- [ ] **Step 1: 写失败测试**

```ts
// server/test/reputation.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { startWsServer } from './helpers/ws-server.js'
import { createTask, transitionTask } from '../src/core/tasks.js'

let srv: Awaited<ReturnType<typeof startWsServer>> | null = null
afterEach(async () => { await srv?.close(); srv = null })
const H = (t: string) => ({ authorization: `Bearer ${t}` })

describe('reputation', () => {
  it('attribution rules: timeout/failed count against executor, cancelled/rejected neutral', async () => {
    srv = await startWsServer()
    const a = srv.mk('alice.dev'), b = srv.mk('bob.ops')
    const mk = (i: number) => { const t = createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: `a${i}` }).task; transitionTask(srv.db, srv.bus, t.id, 'bob.ops', { kind: 'accept' }); return t }
    const done = mk(0); transitionTask(srv.db, srv.bus, done.id, 'bob.ops', { kind: 'result', status: 'completed', result: 'ok' })
    const failed = mk(1); transitionTask(srv.db, srv.bus, failed.id, 'bob.ops', { kind: 'result', status: 'failed', error: 'e' })
    const timed = mk(2); srv.db.prepare(`UPDATE tasks SET deadline='2020-01-01T00:00:00Z' WHERE id=?`).run(timed.id)
    const { scanTimeouts } = await import('../src/core/tasks.js'); scanTimeouts(srv.db, srv.bus, new Date('2020-01-02T00:00:00Z'))
    const rej = createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'a3' }).task
    transitionTask(srv.db, srv.bus, rej.id, 'bob.ops', { kind: 'reject', note: 'busy' })
    const can = mk(3); transitionTask(srv.db, srv.bus, can.id, 'alice.dev', { kind: 'cancel' })
    const r = await srv.app.inject({ method: 'GET', url: '/v1/agents/bob.ops', headers: H(a.token) })
    const rep = r.json().reputation
    expect(rep.tasks_completed).toBe(1); expect(rep.tasks_failed).toBe(1); expect(rep.tasks_timeout).toBe(1)
    expect(rep.tasks_cancelled).toBe(1); expect(rep.tasks_rejected).toBe(1)
    expect(rep.completion_rate).toBeCloseTo(1 / 3)
    expect(rep.avg_duration_s).not.toBeNull()
    expect(rep.avg_rating).toBe(null); expect(rep.review_count).toBe(0)
  })
  it('list endpoint uses batch aggregation (one GROUP BY, no N+1)', async () => {
    srv = await startWsServer()
    const a = srv.mk('alice.dev')
    for (let i = 0; i < 8; i++) srv.mk(`agent${i}.x`)
    const orig = srv.db.prepare.bind(srv.db)
    let aggSelects = 0
    // 只数批量聚合查询；busy() 每 agent 的单查（directory.ts 现状 N+1）不在本任务范围，明确排除（r1-I6）
    ;(srv.db as any).prepare = (sql: string, ...rest: unknown[]) => { if (/GROUP BY executor/.test(sql)) aggSelects++; return (orig as any)(sql, ...rest) }
    const r = await srv.app.inject({ method: 'GET', url: '/v1/agents', headers: { authorization: `Bearer ${a.token}` } })
    ;(srv.db as any).prepare = orig
    expect(r.statusCode).toBe(200)
    expect(r.json().every((x: any) => 'reputation' in x)).toBe(true)
    expect(aggSelects).toBe(1) // 无论多少 agent，聚合只发一条 GROUP BY executor
  })
})
```

- [ ] **Step 2: 跑红** — Run: `cd server && npx vitest run test/reputation.test.ts`  Expected: FAIL

- [ ] **Step 3: 实现**

`core/reputation.ts`：
```ts
import type { Db } from '../db/sqlite.js'

export interface Reputation {
  tasks_completed: number; tasks_failed: number; tasks_timeout: number; tasks_cancelled: number; tasks_rejected: number
  completion_rate: number | null; avg_duration_s: number | null; active_30d: number; avg_rating: number | null; review_count: number
}
export const emptyReputation = (): Reputation => ({ tasks_completed: 0, tasks_failed: 0, tasks_timeout: 0, tasks_cancelled: 0, tasks_rejected: 0, completion_rate: null, avg_duration_s: null, active_30d: 0, avg_rating: null, review_count: 0 })

export function reputationOf(db: Db, ids: string[]): Map<string, Reputation> {
  const out = new Map<string, Reputation>()
  if (!ids.length) return out
  const ph = ids.map(() => '?').join(',')
  const rows = db.prepare(`SELECT executor,
    COUNT(*) FILTER (WHERE status='COMPLETED') AS tasks_completed,
    COUNT(*) FILTER (WHERE status='FAILED') AS tasks_failed,
    COUNT(*) FILTER (WHERE status='TIMEOUT') AS tasks_timeout,
    COUNT(*) FILTER (WHERE status='CANCELLED') AS tasks_cancelled,
    COUNT(*) FILTER (WHERE status='REJECTED') AS tasks_rejected,
    AVG(CASE WHEN status='COMPLETED' THEN (julianday(finished_at) - julianday(accepted_at)) * 86400 END) AS avg_duration_s,
    COUNT(*) FILTER (WHERE status='COMPLETED' AND finished_at > ?) AS active_30d
    FROM tasks WHERE executor IN (${ph}) GROUP BY executor`).all(new Date(Date.now() - 30 * 86400_000).toISOString(), ...ids) as any[]
  const ratings = db.prepare(`SELECT ratee, AVG(rating) AS avg_rating, COUNT(*) AS review_count FROM task_reviews WHERE ratee IN (${ph}) GROUP BY ratee`).all(...ids) as any[]
  const rmap = new Map(ratings.map(r => [r.ratee, r]))
  const seen = new Set([...ids])
  for (const id of seen) {
    const r = rows.find(x => x.executor === id)
    const c = r?.tasks_completed ?? 0, f = r?.tasks_failed ?? 0, t = r?.tasks_timeout ?? 0
    const denom = c + f + t
    const rv = rmap.get(id)
    out.set(id, {
      tasks_completed: c, tasks_failed: f, tasks_timeout: t, tasks_cancelled: r?.tasks_cancelled ?? 0, tasks_rejected: r?.tasks_rejected ?? 0,
      completion_rate: denom ? c / denom : null,
      avg_duration_s: r?.avg_duration_s ?? null,
      active_30d: r?.active_30d ?? 0,
      avg_rating: rv?.avg_rating ?? null, review_count: rv?.review_count ?? 0,
    })
  }
  return out
}
```
（Reputation 接口与 emptyReputation 已定义在本文件顶部并导出，directory 路由复用。）

`routes/directory.ts`：import `reputationOf, emptyReputation`；列表分支 `.map(a => ({ agent: a, presence: {...}, reputation: rep.get(a.id) ?? emptyReputation() }))`，其中 `const rep = reputationOf(deps.db, 搜索结果.map(a => a.id))`；详情分支同样附加。busy 单查维持现状（不属本任务）。

- [ ] **Step 4: 跑绿 + 回归** — Run: `cd server && npx vitest run test/reputation.test.ts test/directory.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add server/src server/test/reputation.test.ts
git commit -m "feat: reputation stats (batch aggregation) on directory endpoints"
```

---

### Task 4: 任务事件流端点

**Files:**
- Modify: `server/src/http/routes/tasks.ts`
- Test: `server/test/task-events.test.ts`

**Interfaces:**
- Produces: `GET /v1/tasks/{id}/events` → `[{id, actor, event, detail, created_at}]`（detail 为解析后的 JSON 对象，时间正序）；仅参与者（requester/executor），其余 404；限流归 history 桶

- [ ] **Step 1: 写失败测试**

```ts
// server/test/task-events.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { startWsServer } from './helpers/ws-server.js'
import { createTask, transitionTask } from '../src/core/tasks.js'

let srv: Awaited<ReturnType<typeof startWsServer>> | null = null
afterEach(async () => { await srv?.close(); srv = null })
const H = (t: string) => ({ authorization: `Bearer ${t}` })

describe('task events', () => {
  it('returns ordered audit timeline for participants only', async () => {
    srv = await startWsServer()
    const a = srv.mk('alice.dev'), b = srv.mk('bob.ops'), c = srv.mk('carol.io')
    const t = createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'do' }).task
    transitionTask(srv.db, srv.bus, t.id, 'bob.ops', { kind: 'accept' })
    transitionTask(srv.db, srv.bus, t.id, 'bob.ops', { kind: 'result', status: 'completed', result: 'done' })
    const r = await srv.app.inject({ method: 'GET', url: `/v1/tasks/${t.id}/events`, headers: H(a.token) })
    expect(r.statusCode).toBe(200)
    const evs = r.json()
    expect(evs.map((e: any) => e.event)).toEqual(['task.created', 'task.accepted', 'task.result'])
    expect(evs[0].detail.task_id).toBe(t.id)
    expect((await srv.app.inject({ method: 'GET', url: `/v1/tasks/${t.id}/events`, headers: H(c.token) })).statusCode).toBe(404)
  })
})
```

- [ ] **Step 2: 跑红** — Run: `cd server && npx vitest run test/task-events.test.ts`  Expected: FAIL（404 路由不存在）

- [ ] **Step 3: 实现**

`routes/tasks.ts` 在 `/v1/tasks/:id` 后加：
```ts
  app.get('/v1/tasks/:id/events', { preHandler: auth }, async (req) => {
    const t = getTask(deps.db, (req.params as any).id)
    const me = getAuth(req).agent.id
    if (!t || (t.requester !== me && t.executor !== me)) throw Errors.notFound('task not found')
    try { deps.limiter.checkHistory(me) } catch (e) {
      if (e instanceof AppError && e.code === 'RATE_LIMITED') audit(deps.db, me, 'ratelimit.exceeded', { path: '/v1/tasks/:id/events' })
      throw e
    }
    const rows = deps.db.prepare(`SELECT id, actor, event, detail, created_at FROM audit_log WHERE json_extract(detail,'$.task_id')=? ORDER BY id`).all(t.id) as any[]
    return rows.map(r => ({ ...r, detail: JSON.parse(r.detail) }))
  })
```
（import `getAuth` from '../auth.js' 若未引入。）

- [ ] **Step 4: 跑绿** — Run: `cd server && npx vitest run test/task-events.test.ts test/task-create.test.ts test/task-transition.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add server/src server/test/task-events.test.ts
git commit -m "feat: task audit timeline endpoint (participants only)"
```

---

### Task 5: Webhook 出站核心（队列/签名/SSRF/重试）

**Files:**
- Create: `server/src/core/webhook.ts`
- Modify: `server/src/core/audit.ts`（AuditEvent union 扩 `'webhook.failed'`——r1-M-a，别漏）
- Test: `server/test/webhook-core.test.ts`

**Interfaces:**
- Produces: `type WebhookEventName = 'task.accepted' | 'task.rejected' | 'task.policy_rejected' | 'task.cancelled' | 'task.result' | 'task.timeout' | 'task.expired' | 'webhook.test'`
- Produces: `class WebhookDispatcher { constructor(deps: { db: Db; cfg: Config; retryDelaysMs?: number[] /* 默认 [0,5000,25000]，测试注入短延迟 */ }); notify(task: { id: string; requester: string; executor: string; status: string }, event: WebhookEventName, audience?: 'both' | 'requester'): void; test(agentId: string): void; inFlight(): number; close(): void }`
- 语义：at-most-once；并发 ≤50；单请求 5s 超时；签名 `X-AgentLink-Signature: sha256=HMAC-SHA256(secret, rawBody)`；payload `{event, task_id, role, task, ts}`；SSRF 每次出站按当次解析 IP 复检 + 重定向 `redirect:'manual'` 逐跳复检（≤3 跳）；重试耗尽 audit `webhook.failed`
- Task 6 才接路由/挂点；本任务纯 core 单测

- [ ] **Step 1: 写失败测试**

```ts
// server/test/webhook-core.test.ts（r1 修订：唯一版本，删除骨架块）
import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { createHmac } from 'node:crypto'
import { openDb, migrate } from '../src/db/sqlite.js'
import { loadConfig } from '../src/config.js'
import { WebhookDispatcher } from '../src/core/webhook.js'
import { registerAgent } from '../src/core/agents.js'
import { Bus } from '../src/core/bus.js'

const mkdb = () => { const db = openDb(join(mkdtempSync(join(tmpdir(), 'al-')), 't.db')); migrate(db); return db }
const cfgPriv = loadConfig({ REGISTRATION_CODE: 'x', WEBHOOK_ALLOW_PRIVATE: 'true' } as never)
const cfgNoPriv = loadConfig({ REGISTRATION_CODE: 'x' } as never)
let servers: Server[] = []
afterEach(() => { servers.forEach(s => s.close()); servers.length = 0 })
// status 可注入：默认 200，测重试时传 500（r1-C4：listener 内不能 throw——会 uncaughtException 且永不响应）
const listener = (fn: (req: any, body: string) => void, status = 200) => new Promise<{ srv: Server; url: string }>(resolve => {
  const srv = createServer((req, res) => { let b = ''; req.on('data', (d: Buffer) => b += d); req.on('end', () => { fn(req, b); res.writeHead(status); res.end('{}') }) })
  servers.push(srv); srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${(srv.address() as any).port}` }))
})

describe('webhook dispatcher', () => {
  it('delivers signed payload with correct role; HMAC verifies', async () => {
    const db = mkdb()
    registerAgent(db, cfgPriv, { agent_id: 'hook.eg', registration_code: 'x' })
    const secret = 'wl_test_secret_0123456789abcdef'
    const got: any[] = []
    const { url } = await listener((req, body) => got.push({ req, body }))
    db.prepare('UPDATE agents SET webhook_url=?, webhook_secret=? WHERE id=?').run(url, secret, 'hook.eg')
    const d = new WebhookDispatcher({ db, cfg: cfgPriv, retryDelaysMs: [0, 10, 10] })
    d.notify({ id: 'tsk_1', requester: 'hook.eg', executor: 'other.x', status: 'COMPLETED' }, 'task.result')
    await new Promise(r => setTimeout(r, 300))
    expect(got.length).toBeGreaterThanOrEqual(1)
    const p = JSON.parse(got[0].body)
    expect(p.event).toBe('task.result'); expect(p.task_id).toBe('tsk_1'); expect(p.role).toBe('requester'); expect(p.ts).toBeTruthy()
    const sig = got[0].req.headers['x-agentlink-signature']
    expect(sig).toBe('sha256=' + createHmac('sha256', secret).update(got[0].body).digest('hex'))
  })
  it('private target denied by default; allowed with WEBHOOK_ALLOW_PRIVATE', async () => {
    const db = mkdb()
    registerAgent(db, cfgNoPriv, { agent_id: 'hook.eg', registration_code: 'x' })
    db.prepare('UPDATE agents SET webhook_url=?, webhook_secret=? WHERE id=?').run('http://127.0.0.1:1/x', 'wl_s', 'hook.eg')
    const d = new WebhookDispatcher({ db, cfg: cfgNoPriv, retryDelaysMs: [0, 10, 10] })
    d.notify({ id: 't', requester: 'hook.eg', executor: 'o.x', status: 'COMPLETED' }, 'task.result')
    await new Promise(r => setTimeout(r, 200))
    const audits = db.prepare(`SELECT * FROM audit_log WHERE event='webhook.failed'`).all()
    expect(audits.length).toBeGreaterThan(0) // 拒绝即失败并审计
  })
  it('retries 3 times then audits webhook.failed; never blocks caller', async () => {
    const db = mkdb()
    registerAgent(db, cfgPriv, { agent_id: 'hook.eg', registration_code: 'x' })
    let hits = 0
    const { url } = await listener(() => { hits++ }, 500) // 恒 500（r1-C4：回调里 throw 会 uncaughtException）
    db.prepare('UPDATE agents SET webhook_url=?, webhook_secret=? WHERE id=?').run(url, 'wl_s', 'hook.eg')
    const t0 = Date.now()
    const d = new WebhookDispatcher({ db, cfg: cfgPriv, retryDelaysMs: [0, 10, 10] })
    d.notify({ id: 't2', requester: 'hook.eg', executor: 'o.x', status: 'FAILED' }, 'task.result')
    expect(Date.now() - t0).toBeLessThan(200) // 入队即返回，零阻塞
    await new Promise(r => setTimeout(r, 400))
    expect(hits).toBe(3)
    expect(db.prepare(`SELECT COUNT(*) c FROM audit_log WHERE event='webhook.failed'`).get()).toMatchObject({ c: 1 })
  })
  it('test() delivers webhook.test event to self', async () => {
    const db = mkdb()
    registerAgent(db, cfgPriv, { agent_id: 'hook.eg', registration_code: 'x' })
    const got: string[] = []
    const { url } = await listener((_r, body) => got.push(body))
    db.prepare('UPDATE agents SET webhook_url=?, webhook_secret=? WHERE id=?').run(url, 'wl_s', 'hook.eg')
    const d = new WebhookDispatcher({ db, cfg: cfgPriv, retryDelaysMs: [0] })
    d.test('hook.eg')
    await new Promise(r => setTimeout(r, 200))
    expect(JSON.parse(got[0]).event).toBe('webhook.test')
  })
  it('redirect re-check: local 302 chain to private target is dead by default (r2-R2-1 降级用例)', async () => {
    const db = mkdb()
    registerAgent(db, cfgNoPriv, { agent_id: 'hook.eg', registration_code: 'x' })
    let redirects = 0
    const url = await new Promise<string>(resolve => {
      const s = createServer((_q, res) => { redirects++; res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); res.end() })
      servers.push(s); s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(s.address() as any).port}`))
    })
    db.prepare('UPDATE agents SET webhook_url=?, webhook_secret=? WHERE id=?').run(url, 'wl_s', 'hook.eg')
    const d = new WebhookDispatcher({ db, cfg: cfgNoPriv, retryDelaysMs: [0, 10] })
    d.notify({ id: 't3', requester: 'hook.eg', executor: 'o.x', status: 'COMPLETED' }, 'task.result')
    await new Promise(r => setTimeout(r, 300))
    expect(redirects).toBe(0) // 首跳即被拒（127.0.0.1 私网）——默认配置下这条链路整体死亡
    expect(db.prepare(`SELECT COUNT(*) c FROM audit_log WHERE event='webhook.failed'`).get()).toMatchObject({ c: 1 })
  })
  it('ipIsPrivate unit matrix (hop-level判定直接单测，补重定向逐跳复检的覆盖)', async () => {
    const { ipIsPrivate } = await import('../src/core/webhook.js')
    for (const p of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.1.1', '0.0.0.0', '::1', 'fe80::1', 'fc00::1']) expect(ipIsPrivate(p)).toBe(true)
    for (const pub of ['8.8.8.8', '172.32.0.1', '1.1.1.1']) expect(ipIsPrivate(pub)).toBe(false)
  })
  // r2 保留项：post() 的 301/302 逐跳复检分支在本沙箱无法用可达公网首跳覆盖——执行阶段若 CI/环境能
  // 起公网可达端点，可加「首跳 302→私网」用例补上；否则以 ipIsPrivate 矩阵 + 降级用例为准，不阻塞。
})
```

- [ ] **Step 2: 跑红** — Run: `cd server && npx vitest run test/webhook-core.test.ts`  Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `core/webhook.ts`**

```ts
import { createHmac, randomBytes } from 'node:crypto'
import { lookup } from 'node:dns'
import type { Db } from '../db/sqlite.js'
import type { Config } from '../config.js'
import { audit } from './audit.js'

export type WebhookEventName = 'task.accepted' | 'task.rejected' | 'task.policy_rejected' | 'task.cancelled' | 'task.result' | 'task.timeout' | 'task.expired' | 'webhook.test'

// 每次出站按当次解析 IP 复检（防 DNS rebinding）；set 时校验只是提前报错，不是安全边界（spec §2.2 r2-R2-1）
// ipIsPrivate 定义在文件末尾并导出（供 hop 级单测）
const assertDeliverable = (host: string, allowPrivate: boolean) => new Promise<void>((resolve, reject) => {
  if (allowPrivate) return resolve()
  const bare = host.replace(/^\[|\]$/g, '')
  if (/^(\d+\.)+\d+$/.test(bare)) return ipIsPrivate(bare) ? reject(new Error('private ip')) : resolve()
  lookup(bare, { all: true }, (err, addrs) => {
    if (err) return reject(err)
    if (addrs.some(a => ipIsPrivate(a.address))) return reject(new Error(`resolves to private: ${addrs.map(a => a.address).join(',')}`))
    resolve()
  })
})

interface Job { url: string; secret: string; body: string; agentId: string }

export class WebhookDispatcher {
  private queue: Job[] = []
  private active = 0
  constructor(private deps: { db: Db; cfg: Config; retryDelaysMs?: number[] }) {}
  inFlight(): number { return this.active + this.queue.length }

  notify(task: { id: string; requester: string; executor: string; status: string }, event: WebhookEventName, audience: 'both' | 'requester' = 'both'): void {
    const ids = audience === 'both' ? [task.requester, task.executor] : [task.requester]
    const rows = this.deps.db.prepare(`SELECT id, webhook_url, webhook_secret FROM agents WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as any[]
    const ts = new Date().toISOString()
    for (const r of rows) {
      if (!r.webhook_url) continue
      for (const role of (r.id === task.requester ? ['requester'] : []).concat(r.id === task.executor ? ['executor'] : [])) {
        this.enqueue({ url: r.webhook_url, secret: r.webhook_secret, agentId: r.id,
          body: JSON.stringify({ event, task_id: task.id, role, task: { status: task.status }, ts }) })
      }
    }
  }
  test(agentId: string): void {
    const r: any = this.deps.db.prepare('SELECT webhook_url, webhook_secret FROM agents WHERE id=?').get(agentId)
    if (r?.webhook_url) this.enqueue({ url: r.webhook_url, secret: r.webhook_secret, agentId, body: JSON.stringify({ event: 'webhook.test', task_id: null, role: 'self', task: null, ts: new Date().toISOString() }) })
  }
  private enqueue(job: Job): void { this.queue.push(job); this.pump() }
  private pump(): void {
    while (this.active < 50 && this.queue.length) { this.active++; void this.deliver(this.queue.shift()!).finally(() => { this.active--; this.pump() }) }
  }
  // delays 语义：delays[i] = 第 i 次尝试前的等待（r1-C1：默认 [0,5000,25000] = 立即/+5s/+25s 共 3 次尝试，
  // 测试注入 [0,10,10] → 3 次 hits，[0] → 1 次——与 webhook-core 测试断言逐一对齐）
  private async deliver(job: Job, attempt = 0): Promise<void> {
    try {
      await assertDeliverable(new URL(job.url).hostname, this.deps.cfg.webhookAllowPrivate)
      const ok = await this.post(job.url, job.body, job.secret, 0)
      if (!ok) throw new Error('delivery failed')
    } catch (e) {
      const delays = this.deps.retryDelaysMs ?? [0, 5000, 25_000]
      if (attempt + 1 < delays.length) {
        await new Promise(r => setTimeout(r, delays[attempt + 1] ?? 0))
        return this.deliver(job, attempt + 1)
      }
      audit(this.deps.db, 'server', 'webhook.failed', { agent_id: job.agentId, url: job.url, error: String(e) })
    }
  }
  // redirect:'manual' 逐跳复检（≤3 跳），签名只签原始 body（重定向后同 body 重发）
  private async post(url: string, body: string, secret: string, hops: number): Promise<boolean> {
    if (hops > 3) return false
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 5000)
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agentlink-signature': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex') }, body, redirect: 'manual', signal: ctrl.signal })
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location'); if (!loc) return false
        const next = new URL(loc, url).toString()
        await assertDeliverable(new URL(next).hostname, this.deps.cfg.webhookAllowPrivate)
        return this.post(next, body, secret, hops + 1)
      }
      return res.ok
    } catch { return false } finally { clearTimeout(timer) }
  }
  close(): void { // at-most-once：关停丢弃队列，但按 spec §8「丢弃并记 audit」留痕（r1-M-c）
    const dropped = this.queue.length
    this.queue = []
    if (dropped) audit(this.deps.db, 'server', 'webhook.failed', { dropped, reason: 'shutdown' })
  }
}
export const newWebhookSecret = (): string => 'wl_' + randomBytes(32).toString('base64url')
export const ipIsPrivate = (ip: string): boolean => ip === '::1' || ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd') || (() => { const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip); if (!m) return true; const [a, b] = [Number(m[1]), Number(m[2])]; return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) })()
```
（`ipIsPrivate` 导出供 hop 级单测；内部 `assertDeliverable` 复用它。`audit.ts` 的 `AuditEvent` union 本任务扩 `'webhook.failed'`；`'task.reviewed'`/`'task.budget_*'` 由后续任务各自扩。）

- [ ] **Step 4: 跑绿** — Run: `cd server && npx vitest run test/webhook-core.test.ts`
Expected: PASS（6 用例；注意 retry 计数用例在慢机器上放宽 sleep 至 600ms）

- [ ] **Step 5: 提交**

```bash
git add server/src server/test/webhook-core.test.ts
git commit -m "feat: webhook dispatcher (signed, SSRF-checked at delivery, retry+audit)"
```

---

### Task 6: Webhook 接线（PATCH /me、三挂点、test 端点、限流）

**Files:**
- Modify: `server/src/core/agents.ts`（updateProfile 支持 webhook_url）、`server/src/core/tasks.ts`（三挂点）、`server/src/http/routes/agents.ts`、`server/src/http/app.ts`、`server/src/index.ts`、`server/test/helpers/ws-server.ts`
- Create: `server/src/http/routes/webhook.ts`
- Test: `server/test/webhook.test.ts`

**Interfaces:**
- Consumes: Task 5 `WebhookDispatcher`、Task 1 `checkWebhookTest`
- Produces: `updateProfile(db, agentId, patch: { ...v1 字段; webhook_url?: string }): { agent: Agent; webhook_secret?: string }`——`webhook_url` 非空须 `^https?://`（400），落库；无 secret 时生成 `wl_` 前缀密钥（`newWebhookSecret()`），**仅在本次返回值出现一次**；空串 = 关闭（保留 secret）
- Produces: `createTask(db, bus, cfg, requester, input, hooks?: { notify?: (t: {id;requester;executor;status}, e: WebhookEventName, a?: 'both'|'requester') => void })`、`transitionTask(db, bus, taskId, actor, op, hooks?)`、`scanTimeouts(db, bus, now?, hooks?)`、`startScanner(db, bus, cfg, log?, hooks?)` —— hooks 全部可选，v1 既有调用零改动
- Produces: `AppDeps.webhook?: WebhookDispatcher`；`POST /v1/webhook/test`（auth + checkWebhookTest）
- 挂点：accept/reject/cancel/result → `task.accepted/rejected/cancelled/result`（both）；createTask policy 路径 → `task.policy_rejected`（requester）；finalize → `task.timeout/task.expired`（timeout: both；expired: requester）

- [ ] **Step 1: 写失败测试**

```ts
// server/test/webhook.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { startWsServer } from './helpers/ws-server.js'
import { createTask, transitionTask } from '../src/core/tasks.js'
import type { WebhookDispatcher } from '../src/core/webhook.js'

let srv: Awaited<ReturnType<typeof startWsServer>> | null = null
let whSrv: Server | null = null
afterEach(async () => { await srv?.close(); srv = null; whSrv?.close(); whSrv = null })
const H = (t: string) => ({ authorization: `Bearer ${t}` })
const bodies: string[] = []
beforeEach(() => { bodies.length = 0 }) // r1-I11：跨用例共享会弱化计数断言
const listen = () => new Promise<string>(resolve => {
  whSrv = createServer((_q, res) => { bodies.push('x'); res.writeHead(200); res.end('{}') })
  whSrv.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(whSrv!.address() as any).port}`))
})

describe('webhook wiring', () => {
  it('PATCH /me sets webhook, secret shown once, GET never echoes; events fire on transitions', async () => {
    srv = await startWsServer({ WEBHOOK_ALLOW_PRIVATE: 'true' })
    const a = srv.mk('alice.dev'); srv.mk('bob.ops')
    const url = await listen()
    const set = await srv.app.inject({ method: 'PATCH', url: '/v1/me', headers: H(a.token), payload: { webhook_url: url } })
    expect(set.statusCode).toBe(200)
    const secret = set.json().webhook_secret
    expect(secret).toMatch(/^wl_/)
    const again = await srv.app.inject({ method: 'PATCH', url: '/v1/me', headers: H(a.token), payload: { display_name: 'x' } })
    expect(again.json().webhook_secret).toBeUndefined()
    expect(JSON.stringify(await srv.app.inject({ method: 'GET', url: '/v1/me', headers: H(a.token) }).then(r => r.json()))).not.toContain('webhook_secret')
    // task lifecycle → requester webhook (role=requester)
    const t = createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'go' }, { notify: (tk, e) => srv!.hooks.notify(tk, e) }).task
    transitionTask(srv.db, srv.bus, t.id, 'bob.ops', { kind: 'accept' }, srv.hooks)
    await new Promise(r => setTimeout(r, 300))
    expect(bodies.length).toBe(1) // 仅 alice 配了 webhook：accept → 1 条投递（bob 未配置，静默跳过）
  })
  it('policy reject notifies requester only; POST /v1/webhook/test fires; rate limited', async () => {
    srv = await startWsServer({ WEBHOOK_ALLOW_PRIVATE: 'true', RATE_LIMIT_WEBHOOK_TEST_PER_MIN: '1' })
    const a = srv.mk('alice.dev'); srv.mk('bob.ops')
    srv.db.prepare(`UPDATE agents SET task_policy='{"mode":"closed","allowlist":[],"scope":"read-only"}' WHERE id='bob.ops'`).run()
    const url = await listen()
    await srv.app.inject({ method: 'PATCH', url: '/v1/me', headers: H(a.token), payload: { webhook_url: url } })
    createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'x' }, srv.hooks)
    const t1 = await srv.app.inject({ method: 'POST', url: '/v1/webhook/test', headers: H(a.token) })
    expect(t1.statusCode).toBe(204)
    const t2 = await srv.app.inject({ method: 'POST', url: '/v1/webhook/test', headers: H(a.token) })
    expect(t2.statusCode).toBe(429)
    await new Promise(r => setTimeout(r, 300))
    expect(bodies.length).toBe(2) // 精确计数：policy_rejected 1 + webhook.test 1
  })
})
```

- [ ] **Step 2: 跑红** — Run: `cd server && npx vitest run test/webhook.test.ts`  Expected: FAIL

- [ ] **Step 3: 实现**

`core/agents.ts` `updateProfile`：patch 类型加 `webhook_url?: string`；返回类型改 `{ agent: Agent; webhook_secret?: string }`。逻辑（**webhook 块必须插在既有 `if (!sets.length) return cur`（r1-M-b）之前**，否则仅传 webhook_url 时提前 return）：
```ts
  let webhookSecret: string | undefined
  if (patch.webhook_url !== undefined) {
    if (patch.webhook_url !== '' && !/^https?:\/\//.test(patch.webhook_url)) throw Errors.invalidRequest('webhook_url must be http(s)')
    if (Buffer.byteLength(patch.webhook_url) > 512) throw Errors.invalidRequest('webhook_url too long')
    sets.push('webhook_url=?'); vals.push(patch.webhook_url)
    const cur: any = db.prepare('SELECT webhook_secret FROM agents WHERE id=?').get(agentId)
    if (!cur?.webhook_secret) { webhookSecret = newWebhookSecret(); sets.push('webhook_secret=?'); vals.push(webhookSecret) } // 关闭再开沿用旧 secret
  }
```
末尾 `return { agent: getAgent(db, agentId), webhook_secret: webhookSecret }`；`routes/agents.ts` **两处**：①PATCH body schema properties 加 `webhook_url: { type: 'string', maxLength: 512 }`（**不加会被 `additionalProperties: false` 静默剥离——r1-C5**，空串合法=关闭，http(s) 前缀与字节长校验留在 core 单点）；②PATCH handler 改 `({ agent, webhook_secret })` 解构（GET /v1/me 不变——rowToAgent 不读新列）。import `newWebhookSecret` from '../core/webhook.js'。

`core/tasks.ts`：import type `{ WebhookEventName }` from './webhook.js'；定义 `export interface TaskHooks { notify?: (t: { id: string; requester: string; executor: string; status: string }, e: WebhookEventName, audience?: 'both' | 'requester') => void }`；`createTask(..., hooks?: TaskHooks)`——policy 分支 `hooks?.notify?.({ ...task, status: 'REJECTED' }, 'task.policy_rejected', 'requester')`；`transitionTask(..., hooks?: TaskHooks)`——accept/reject/cancel/result 分支末尾 `hooks?.notify?.(next, 'task.accepted'|'task.rejected'|'task.cancelled'|'task.result')`（result 的 event 名固定 `task.result`，status 在 payload.task.status 区分）；`finalize(db, bus, row, status, event, hooks?)` 加参数，`scanTimeouts(db, bus, now?, hooks?)`：TIMEOUT→`hooks?.notify?.({...row, status:'TIMEOUT'}, 'task.timeout')`，EXPIRED→`(..., 'task.expired', 'requester')`；`startScanner(db, bus, cfg, log?, hooks?)` 透传。

`http/routes/webhook.ts`（新）：
```ts
import type { FastifyInstance } from 'fastify'
import { authenticate, getAuth } from '../auth.js'
import type { Db } from '../../db/sqlite.js'; import type { Config } from '../../config.js'
import type { RateLimiter } from '../../core/ratelimit.js'
import type { WebhookDispatcher } from '../../core/webhook.js'

export function registerWebhookRoutes(app: FastifyInstance, deps: { db: Db; cfg: Config; limiter: RateLimiter; webhook: WebhookDispatcher }): void {
  const auth = authenticate(deps.db, deps.cfg)
  app.post('/v1/webhook/test', { preHandler: auth }, async (req, reply) => {
    deps.limiter.checkWebhookTest(getAuth(req).agent.id)
    deps.webhook.test(getAuth(req).agent.id)
    return reply.status(204).send()
  })
}
```
`app.ts`：AppDeps 加 `webhook?: WebhookDispatcher`；`if (deps.db)` 块内（bus 分支外）`if (deps.webhook) registerWebhookRoutes(app, { db, cfg, limiter, webhook: deps.webhook })`（limiter 变量上移一行）。`index.ts`：创建 `const webhook = new WebhookDispatcher({ db, cfg })` 传入 buildApp；`startScanner(db, bus, cfg, app.log, { notify: (t, e, a) => webhook.notify(t, e, a) })`；shutdown 序列加 `webhook.close()`。`test/helpers/ws-server.ts`：创建 dispatcher 传入 buildApp，返回值加 `hooks: { notify: (t: any, e: any, a?: any) => webhook.notify(t, e, a) }` 与 `webhook`。

- [ ] **Step 4: 跑绿 + 回归** — Run: `cd server && npx vitest run test/webhook.test.ts test/me.test.ts test/task-create.test.ts test/task-timeout.test.ts test/ws.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add server/src server/test
git commit -m "feat: webhook wiring — PATCH /me, three hook points, test endpoint"
```

---

### Task 7: 任务评价（review）

**Files:**
- Create: `server/src/core/reviews.ts`
- Modify: `server/src/http/routes/tasks.ts`、`server/src/core/audit.ts`（union 加 `'task.reviewed'`）
- Test: `server/test/review.test.ts`

**Interfaces:**
- Produces: `submitReview(db, taskId, rater: string, { rating: number; comment?: string })`：仅 requester（403）；终态 COMPLETED/FAILED（422 `TASK_NOT_FINISHED`）；一任务一评（409 `ALREADY_REVIEWED`）；终态 30 天内（422 `REVIEW_WINDOW_CLOSED`）；rating 1..5 整数、comment ≤1KB；写 `task_reviews` + audit `task.reviewed`
- Produces: `POST /v1/tasks/{id}/review`（auth + task 桶限流）；声誉 `avg_rating/review_count` 由 Task 3 的查询自动带出

- [ ] **Step 1: 写失败测试**

```ts
// server/test/review.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { startWsServer } from './helpers/ws-server.js'
import { createTask, transitionTask } from '../src/core/tasks.js'

let srv: Awaited<ReturnType<typeof startWsServer>> | null = null
afterEach(async () => { await srv?.close(); srv = null })
const H = (t: string) => ({ authorization: `Bearer ${t}` })
const finish = () => { const t = createTask(srv!.db, srv!.bus, srv!.cfg, 'alice.dev', { to: 'bob.ops', action: 'a' }).task; transitionTask(srv!.db, srv!.bus, t.id, 'bob.ops', { kind: 'accept' }); transitionTask(srv!.db, srv!.bus, t.id, 'bob.ops', { kind: 'result', status: 'completed', result: 'ok' }); return t }

describe('review', () => {
  it('requester rates executor; reputation reflects it', async () => {
    srv = await startWsServer()
    const a = srv.mk('alice.dev'), b = srv.mk('bob.ops')
    const t = finish()
    const r = await srv.app.inject({ method: 'POST', url: `/v1/tasks/${t.id}/review`, headers: H(a.token), payload: { rating: 5, comment: 'great' } })
    expect(r.statusCode).toBe(201)
    const rep = (await srv.app.inject({ method: 'GET', url: '/v1/agents/bob.ops', headers: H(a.token) })).json().reputation
    expect(rep.avg_rating).toBe(5); expect(rep.review_count).toBe(1)
  })
  it('guards: non-requester 403, running 422, duplicate 409, window closed 422', async () => {
    srv = await startWsServer()
    const a = srv.mk('alice.dev'), b = srv.mk('bob.ops')
    const running = createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'a' }).task
    expect((await srv.app.inject({ method: 'POST', url: `/v1/tasks/${running.id}/review`, headers: H(a.token), payload: { rating: 4 } })).statusCode).toBe(422)
    const t = finish()
    expect((await srv.app.inject({ method: 'POST', url: `/v1/tasks/${t.id}/review`, headers: H(b.token), payload: { rating: 4 } })).statusCode).toBe(403)
    expect((await srv.app.inject({ method: 'POST', url: `/v1/tasks/${t.id}/review`, headers: H(a.token), payload: { rating: 4 } })).statusCode).toBe(201)
    const dup = await srv.app.inject({ method: 'POST', url: `/v1/tasks/${t.id}/review`, headers: H(a.token), payload: { rating: 3 } })
    expect(dup.statusCode).toBe(409)
    expect(dup.json().error.code).toBe('ALREADY_REVIEWED') // r1-I7：钉住新错误码，不只钉 409
    const t2 = finish()
    srv.db.prepare(`UPDATE tasks SET finished_at='2020-01-01T00:00:00Z' WHERE id=?`).run(t2.id)
    expect((await srv.app.inject({ method: 'POST', url: `/v1/tasks/${t2.id}/review`, headers: H(a.token), payload: { rating: 4 } })).statusCode).toBe(422)
  })
})
```

- [ ] **Step 2: 跑红** — Run: `cd server && npx vitest run test/review.test.ts`  Expected: FAIL

- [ ] **Step 3: 实现**

`core/reviews.ts`：
```ts
import type { Db } from '../db/sqlite.js'
import { Errors, AppError } from '../http/errors.js'
import { audit } from './audit.js'
import { getTask } from './tasks.js'

export function submitReview(db: Db, taskId: string, rater: string, input: { rating: number; comment?: string }): void {
  const t = getTask(db, taskId)
  if (!t || (t.requester !== rater && t.executor !== rater)) throw Errors.notFound('task not found')
  if (t.requester !== rater) throw Errors.forbidden('only requester can review')
  if (t.status !== 'COMPLETED' && t.status !== 'FAILED') throw Errors.unprocessable('TASK_NOT_FINISHED', 'task not in terminal state')
  // r1-I7：Errors.conflict 的 code 固定 'CONFLICT'，新错误码必须直接 AppError 落地（spec §8 承诺）
  if (db.prepare('SELECT 1 FROM task_reviews WHERE task_id=?').get(taskId)) throw new AppError('ALREADY_REVIEWED', 409, 'task already reviewed')
  if (Date.now() - Date.parse(t.finished_at!) > 30 * 86400_000) throw Errors.unprocessable('REVIEW_WINDOW_CLOSED', 'review window (30d) closed')
  if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) throw Errors.invalidRequest('rating must be integer 1-5')
  if (Buffer.byteLength(input.comment ?? '') > 1024) throw Errors.invalidRequest('comment too long: max 1KB')
  db.prepare('INSERT INTO task_reviews (task_id, rater, ratee, rating, comment, created_at) VALUES (?,?,?,?,?,?)')
    .run(taskId, rater, t.executor, input.rating, input.comment ?? null, new Date().toISOString())
  audit(db, rater, 'task.reviewed', { task_id: taskId, rating: input.rating })
}
```
`routes/tasks.ts` 加：
```ts
  app.post('/v1/tasks/:id/review', { preHandler: auth, schema: { body: { type: 'object', required: ['rating'], additionalProperties: false, properties: { rating: { type: 'integer', minimum: 1, maximum: 5 }, comment: { type: 'string', maxLength: 1024 } } } } }, async (req, reply) => {
    const me = getAuth(req).agent.id
    try { deps.limiter.checkTask(me) } catch (e) {
      if (e instanceof AppError && e.code === 'RATE_LIMITED') audit(deps.db, me, 'ratelimit.exceeded', { path: '/v1/tasks/:id/review' })
      throw e
    }
    submitReview(deps.db, (req.params as any).id, me, req.body as never)
    return reply.status(201).send()
  })
```
（import submitReview；audit union 加 `'task.reviewed'`。）

- [ ] **Step 4: 跑绿** — Run: `cd server && npx vitest run test/review.test.ts test/reputation.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add server/src server/test/review.test.ts
git commit -m "feat: task review endpoint with guards and reputation wiring"
```

---

### Task 8: result_schema 受限校验器

**Files:**
- Create: `server/src/core/resultschema.ts`
- Test: `server/test/resultschema.test.ts`

**Interfaces:**
- Produces: `assertSchemaDraft(s: unknown): asserts s is ResultSchema`——非法/不支持操作符抛 422 `SCHEMA_UNSUPPORTED`；支持：顶层 `{type:'object', required?: string[], properties?: Record<string, Prop>}`；Prop：`type`（string|number|integer|boolean|array|object）、`enum`、`maxLength`/`minLength`（string）、`minimum`/`maximum`（number）、`items`（一层）、`properties`+`required`（一层嵌套，即嵌套层内不得再有 properties/items）
- Produces: `validateResult(schema: ResultSchema, value: unknown): string[]`——错误路径列表（如 `$.report: required`、`$.count: expected number, got string`），空数组 = 通过
- 操作符矩阵正反全覆盖是 M3 验收项（spec §4.1 r1 附条件）

- [ ] **Step 1: 写失败测试（操作符矩阵）**

```ts
// server/test/resultschema.test.ts
import { describe, it, expect } from 'vitest'
import { assertSchemaDraft, validateResult } from '../src/core/resultschema.js'

const S = (props: Record<string, unknown>, required?: string[]) => ({ type: 'object', properties: props, required })
const E = (s: unknown) => { try { assertSchemaDraft(s); return null } catch (e: any) { return e.code } }

describe('schema draft validation', () => {
  it('rejects unsupported operators and malformed drafts', () => {
    expect(E({ type: 'object', properties: { a: { pattern: '^x$' } } })).toBe('SCHEMA_UNSUPPORTED')
    expect(E({ type: 'object', properties: { a: { type: 'string', default: 'x' } } })).toBe('SCHEMA_UNSUPPORTED')
    expect(E({ type: 'array' })).toBe('SCHEMA_UNSUPPORTED') // 顶层必须 object
    expect(E('nope')).toBe('SCHEMA_UNSUPPORTED')
    expect(E({ type: 'object', properties: { a: { type: 'weird' } } })).toBe('SCHEMA_UNSUPPORTED')
    expect(E({ type: 'object', properties: { a: { type: 'array', items: { type: 'weird' } } })).toBe('SCHEMA_UNSUPPORTED') // r1-M-d
    expect(E({ type: 'object', properties: { a: { type: 'array', items: { pattern: '^x$' } } })).toBe('SCHEMA_UNSUPPORTED') // r1-M-d
    expect(E({ type: 'object', properties: { a: { properties: { b: { properties: {} } } } } })).toBe('SCHEMA_UNSUPPORTED') // 二层嵌套
  })
  it('operator matrix: positive cases all pass', () => {
    const s = S({
      name: { type: 'string', minLength: 1, maxLength: 5 }, level: { type: 'integer', minimum: 1, maximum: 3 },
      score: { type: 'number' }, ok: { type: 'boolean' }, tags: { type: 'array', items: { type: 'string' } },
      mode: { enum: ['fast', 'slow'] }, nested: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
    }, ['name', 'level'])
    expect(validateResult(s as never, { name: 'abc', level: 2, score: 1.5, ok: true, tags: ['a'], mode: 'fast', nested: { x: 1 } })).toEqual([])
  })
  it('operator matrix: negative cases report precise paths', () => {
    const s = S({ name: { type: 'string', minLength: 2, maxLength: 4 }, level: { type: 'integer', minimum: 1, maximum: 3 }, tags: { type: 'array', items: { type: 'string' } }, nested: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] }, mode: { enum: ['a', 'b'] } }, ['name', 'nested'])
    expect(validateResult(s as never, {})).toEqual(['$.name: required', '$.nested: required'])
    expect(validateResult(s as never, { name: 'x', nested: {} })).toContain('$.name: minLength 2')
    expect(validateResult(s as never, { name: 'xxxxx', nested: { x: 1 } })).toContain('$.name: maxLength 4')
    expect(validateResult(s as never, { name: 'ok', level: 0, nested: { x: 1 } })).toContain('$.level: minimum 1')
    expect(validateResult(s as never, { name: 'ok', level: 4, nested: { x: 1 } })).toContain('$.level: maximum 3')
    expect(validateResult(s as never, { name: 'ok', level: 1.5, nested: { x: 1 } })).toContain('$.level: expected integer')
    expect(validateResult(s as never, { name: 'ok', tags: [1], nested: { x: 1 } })).toContain('$.tags[0]: expected string')
    expect(validateResult(s as never, { name: 'ok', mode: 'c', nested: { x: 1 } })).toContain('$.mode: enum')
    expect(validateResult(s as never, { name: 'ok', nested: { x: 's' } })).toContain('$.nested.x: expected number')
  })
})
```

- [ ] **Step 2: 跑红** — Run: `cd server && npx vitest run test/resultschema.test.ts`  Expected: FAIL

- [ ] **Step 3: 实现 `core/resultschema.ts`**

```ts
// 受限 JSON Schema 子集（spec §4.1）：明确不支持完整 JSON Schema——支持范围即文档，
// 超出操作符直接 422，不静默忽略（静默忽略 = 用户以为校验了其实没有）
import { Errors } from '../http/errors.js'

const TYPES = ['string', 'number', 'integer', 'boolean', 'array', 'object'] as const
type Prim = typeof TYPES[number]
export interface Prop { type?: Prim; enum?: unknown[]; minLength?: number; maxLength?: number; minimum?: number; maximum?: number; items?: { type: Prim }; properties?: Record<string, Prop>; required?: string[] }
export interface ResultSchema { type: 'object'; properties?: Record<string, Prop>; required?: string[] }
const PRIM_KEYS = new Set(['type', 'enum', 'minLength', 'maxLength', 'minimum', 'maximum'])
const OBJ_KEYS = new Set([...PRIM_KEYS, 'properties', 'required', 'items'])

const bad = (m: string): never => { throw Errors.unprocessable('SCHEMA_UNSUPPORTED', m) }
const checkProp = (p: unknown, depth: number, path: string): Prop => {
  if (typeof p !== 'object' || p === null) bad(`${path}: property schema must be object`)
  const prop = p as Record<string, unknown>
  for (const k of Object.keys(prop)) if (!OBJ_KEYS.has(k)) bad(`${path}.${k}: unsupported operator`)
  if (prop.type !== undefined && !(TYPES as readonly string[]).includes(prop.type as string)) bad(`${path}.type: unsupported type`)
  if (prop.items !== undefined) { // r1-M-d：items 内容同型白名单校验，防 items:{type:'weird'} 或 items:{pattern} 溜进运行期
    const it = prop.items as Record<string, unknown>
    for (const k of Object.keys(it)) if (k !== 'type') bad(`${path}.items.${k}: unsupported operator`)
    if (it.type === undefined || !(TYPES as readonly string[]).includes(it.type as string)) bad(`${path}.items.type: unsupported type`)
  }
  if (depth === 1 && (prop.properties !== undefined || prop.items !== undefined)) bad(`${path}: nesting beyond one level unsupported`)
  if (prop.properties !== undefined) { for (const [k, v] of Object.entries(prop.properties as object)) checkProp(v, depth + 1, `${path}.properties.${k}`) }
  return prop as Prop
}
export function assertSchemaDraft(s: unknown): asserts s is ResultSchema {
  if (typeof s !== 'object' || s === null) bad('schema must be object')
  const o = s as Record<string, unknown>
  if (o.type !== 'object') bad('top-level type must be object')
  for (const k of Object.keys(o)) if (!['type', 'properties', 'required'].includes(k)) bad(`${k}: unsupported top-level operator`)
  if (o.required !== undefined && !Array.isArray(o.required)) bad('required must be array')
  if (o.properties !== undefined) for (const [k, v] of Object.entries(o.properties as object)) checkProp(v, 0, `properties.${k}`)
}
const typeOk = (v: unknown, t: Prim): boolean =>
  t === 'string' ? typeof v === 'string' : t === 'boolean' ? typeof v === 'boolean' : t === 'number' ? typeof v === 'number'
  : t === 'integer' ? Number.isInteger(v) : t === 'array' ? Array.isArray(v) : typeof v === 'object' && v !== null && !Array.isArray(v)
export function validateResult(schema: ResultSchema, value: unknown): string[] {
  const errs: string[] = []
  const obj = (typeof value === 'object' && value !== null && !Array.isArray(value)) ? value as Record<string, unknown> : null
  if (!obj) return [ '$: expected object' ]
  for (const key of schema.required ?? []) if (!(key in obj)) errs.push(`$.${key}: required`)
  for (const [key, p] of Object.entries(schema.properties ?? {})) {
    if (!(key in obj)) continue
    const v = obj[key]; const at = `$.${key}`
    if (p.type && !typeOk(v, p.type)) { errs.push(`${at}: expected ${p.type}`); continue }
    if (p.enum && !p.enum.includes(v)) errs.push(`${at}: enum`)
    if (typeof v === 'string') {
      if (p.minLength !== undefined && v.length < p.minLength) errs.push(`${at}: minLength ${p.minLength}`)
      if (p.maxLength !== undefined && v.length > p.maxLength) errs.push(`${at}: maxLength ${p.maxLength}`)
    }
    if (typeof v === 'number') {
      if (p.minimum !== undefined && v < p.minimum) errs.push(`${at}: minimum ${p.minimum}`)
      if (p.maximum !== undefined && v > p.maximum) errs.push(`${at}: maximum ${p.maximum}`)
    }
    if (Array.isArray(v) && p.items?.type) v.forEach((el, i) => { if (!typeOk(el, p.items!.type)) errs.push(`${at}[${i}]: expected ${p.items!.type}`) })
    if (p.properties && typeOk(v, 'object')) {
      const vo = v as Record<string, unknown>
      for (const key2 of p.required ?? []) if (!(key2 in vo)) errs.push(`${at}.${key2}: required`)
      for (const [k2, p2] of Object.entries(p.properties)) if (k2 in vo && p2.type && !typeOk(vo[k2], p2.type)) errs.push(`${at}.${k2}: expected ${p2.type}`)
    }
  }
  return errs
}
```

- [ ] **Step 4: 跑绿** — Run: `cd server && npx vitest run test/resultschema.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add server/src server/test/resultschema.test.ts
git commit -m "feat: restricted result-schema validator (zero-dep, operator matrix tested)"
```

---

### Task 9: result_schema 任务接入（创建 + 提交校验）

**Files:**
- Modify: `server/src/core/tasks.ts`、`server/src/http/routes/tasks.ts`
- Test: `server/test/task-schema.test.ts`

**Interfaces:**
- Consumes: Task 8 `assertSchemaDraft/validateResult`
- Produces: `Task` 接口加 `result_schema: string | null`（JSON 字符串原样存储/返回）；`createTask` input 加 `result_schema?: object`（≤8KB，413 超限；非法子集 422 `SCHEMA_UNSUPPORTED`）；`transitionTask` result 分支：任务带 schema 时 result 须合法 JSON 且过校验，否则 422 `RESULT_SCHEMA_MISMATCH`（任务保持 RUNNING，可重交；deadline 不顺延；心跳义务不豁免）

- [ ] **Step 1: 写失败测试**

```ts
// server/test/task-schema.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { startWsServer } from './helpers/ws-server.js'
import { createTask, transitionTask, scanTimeouts } from '../src/core/tasks.js'

let srv: Awaited<ReturnType<typeof startWsServer>> | null = null
afterEach(async () => { await srv?.close(); srv = null })
const SCHEMA = { type: 'object', required: ['report'], properties: { report: { type: 'string', maxLength: 10 }, n: { type: 'integer', minimum: 0 } } }

describe('result schema acceptance', () => {
  it('mismatch → 422 + still RUNNING; fixed resubmit → COMPLETED; deadline unchanged', async () => {
    srv = await startWsServer()
    srv.mk('alice.dev'); srv.mk('bob.ops') // 直接调 core 也必须先注册（getAgent 404，r1-C3 同类）
    const t = createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'a', result_schema: SCHEMA }).task
    expect(t.result_schema).toBeTruthy()
    transitionTask(srv.db, srv.bus, t.id, 'bob.ops', { kind: 'accept' })
    const deadline = (await import('../src/core/tasks.js')).getTask(srv.db, t.id).deadline
    let err: any
    try { transitionTask(srv.db, srv.bus, t.id, 'bob.ops', { kind: 'result', status: 'completed', result: 'not json' }) } catch (e) { err = e }
    expect(err.code).toBe('RESULT_SCHEMA_MISMATCH'); expect(err.status).toBe(422)
    const still = (await import('../src/core/tasks.js')).getTask(srv.db, t.id)
    expect(still.status).toBe('RUNNING'); expect(still.deadline).toBe(deadline) // 不顺延
    transitionTask(srv.db, srv.bus, t.id, 'bob.ops', { kind: 'result', status: 'completed', result: JSON.stringify({ report: 'ok', n: 1 }) })
    expect((await import('../src/core/tasks.js')).getTask(srv.db, t.id).status).toBe('COMPLETED')
  })
  it('near-deadline ordering: heartbeating executor can resubmit; stale one is TIMEOUT by scanner', async () => {
    srv = await startWsServer()
    srv.mk('alice.dev'); srv.mk('bob.ops')
    const t = createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'a', result_schema: SCHEMA }).task
    transitionTask(srv.db, srv.bus, t.id, 'bob.ops', { kind: 'accept' })
    transitionTask(srv.db, srv.bus, t.id, 'bob.ops', { kind: 'heartbeat' })
    try { transitionTask(srv.db, srv.bus, t.id, 'bob.ops', { kind: 'result', status: 'completed', result: 'bad' }) } catch { /* 422 */ }
    srv.db.prepare(`UPDATE tasks SET deadline='2020-01-01T00:00:00Z' WHERE id=?`).run(t.id)
    try { transitionTask(srv.db, srv.bus, t.id, 'bob.ops', { kind: 'result', status: 'completed', result: JSON.stringify({ report: 'late' }) }) } catch { /* 已被扫描前手动置 deadline：此处仍应成功或 TIMEOUT 由扫描器判 */ }
    scanTimeouts(srv.db, srv.bus, new Date('2020-01-02T00:00:00Z'))
    const fin = (await import('../src/core/tasks.js')).getTask(srv.db, t.id)
    expect(['COMPLETED', 'TIMEOUT']).toContain(fin.status) // 心跳在场者：deadline 人工回拨前的成功提交有效
    // r1-I9 钉 3 第二条腿：心跳停摆者（422 后不再 heartbeat）必须被 scanner 置 TIMEOUT
    const stale = createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'a2', result_schema: SCHEMA }).task
    transitionTask(srv.db, srv.bus, stale.id, 'bob.ops', { kind: 'accept' })
    transitionTask(srv.db, srv.bus, stale.id, 'bob.ops', { kind: 'heartbeat' })
    try { transitionTask(srv.db, srv.bus, stale.id, 'bob.ops', { kind: 'result', status: 'completed', result: 'bad' }) } catch { /* 422 后放弃心跳 */ }
    srv.db.prepare(`UPDATE tasks SET deadline='2020-01-01T00:00:00Z', last_heartbeat_at='2020-01-01T00:00:00Z' WHERE id=?`).run(stale.id)
    scanTimeouts(srv.db, srv.bus, new Date('2020-01-02T00:00:00Z'))
    expect((await import('../src/core/tasks.js')).getTask(srv.db, stale.id).status).toBe('TIMEOUT')
  })
  it('create validation: oversized 413, unsupported operator 422, absent schema keeps v1 free-text', async () => {
    srv = await startWsServer()
    srv.mk('alice.dev'); srv.mk('bob.ops')
    // r2-N1：toThrowError 的不对称匹配器无文档承诺，统一 try/catch 显式断言
    let e1: any; try { createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'a', result_schema: { type: 'object', properties: { pad: { enum: ['x'.repeat(9 * 1024)] } } } }) } catch (x) { e1 = x }
    expect(e1?.status).toBe(413) // r1-M-e：8KB 超限真断言
    let e2: any; try { createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'a', result_schema: { type: 'object', properties: { x: { type: 'string', pattern: 'a' } } } }) } catch (x) { e2 = x }
    expect(e2?.code).toBe('SCHEMA_UNSUPPORTED')
    const free = createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'a' }).task
    transitionTask(srv.db, srv.bus, free.id, 'bob.ops', { kind: 'accept' })
    transitionTask(srv.db, srv.bus, free.id, 'bob.ops', { kind: 'result', status: 'completed', result: '任意文本' })
    expect((await import('../src/core/tasks.js')).getTask(srv.db, free.id).status).toBe('COMPLETED')
  })
})
```

- [ ] **Step 2: 跑红** — Run: `cd server && npx vitest run test/task-schema.test.ts`  Expected: FAIL

- [ ] **Step 3: 实现**

`core/tasks.ts`：import `{ assertSchemaDraft, validateResult }` from './resultschema.js'。`Task` 接口加 `result_schema: string | null`（getTask 的 rowToTask 直读列，string|null 天然）。`createTask` input 加 `result_schema?: Record<string, unknown>`；在 maxDuration 计算前：
```ts
  let resultSchema: string | null = null
  if (input.result_schema !== undefined) {
    if (Buffer.byteLength(JSON.stringify(input.result_schema)) > 8 * 1024) throw Errors.payloadTooLarge('result_schema > 8KB')
    assertSchemaDraft(input.result_schema)
    resultSchema = JSON.stringify(input.result_schema)
  }
```
INSERT 列名加 `result_schema`（第 13 列，实参 resultSchema）。`transitionTask` result 分支在 64KB 检查后加：
```ts
      if (t.result_schema) {
        let parsed: unknown
        try { parsed = JSON.parse(op.result ?? '') } catch { throw Errors.unprocessable('RESULT_SCHEMA_MISMATCH', 'result must be valid JSON for schema tasks: parse error') }
        const errs = validateResult(JSON.parse(t.result_schema), parsed)
        if (errs.length) throw Errors.unprocessable('RESULT_SCHEMA_MISMATCH', `schema mismatch: ${errs.join('; ')}`)
      }
```
（校验失败抛错在 UPDATE 之前——状态自然保持 RUNNING。）

`routes/tasks.ts` POST `/v1/tasks` schema properties 加 `result_schema: { type: 'object' }`（additionalProperties 保持 false，大小/子集校验在 core）。

- [ ] **Step 4: 跑绿 + 回归** — Run: `cd server && npx vitest run test/task-schema.test.ts test/task-create.test.ts test/task-transition.test.ts test/task-timeout.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add server/src server/test/task-schema.test.ts
git commit -m "feat: result schema acceptance in task lifecycle"
```

---

### Task 10: budget 协议 + ledger 写入（三挂点 + 同事务）

**Files:**
- Create: `server/src/core/ledger.ts`
- Modify: `server/src/core/tasks.ts`、`server/src/core/audit.ts`（union 加 `'task.budget_agreed' | 'task.budget_settled' | 'task.budget_voided'`）
- Test: `server/test/ledger-write.test.ts`

**Interfaces:**
- Produces: `writeLedgerEvent(db: Db, task: { id: string; requester: string; executor: string; budget_amount: number | null; budget_currency: string }, type: 'agreed' | 'settled' | 'voided', actor: string): void`——`budget_amount` 为 null 时 no-op；`agreed` amount=budget；`settled` amount=budget；`voided` amount=0；同时 audit 对应事件（与调用方同事务）
- Produces: `Task` 接口加 `budget_amount: number | null; budget_currency: string`；`createTask` input 加 `budget?: { amount: number; currency?: string; note?: string }`（amount 整数 1..10^13，currency ≤16 默认 'credit'，note ≤256 → 落库仅 amount/currency）
- 事务性：transitionTask 的 accept/reject/cancel/result 分支与 finalize 的 UPDATE 改为 `db.transaction(() => { UPDATE; writeLedgerEvent(...); audit(...) })()`（ledger 与 audit 同事务；insertDerived 留在事务外，v1 行为）
- 写入矩阵（spec §5.2）：accept→agreed；COMPLETED→settled；FAILED/TIMEOUT/CANCELLED@RUNNING→voided；REJECTED/policy/EXPIRED/CANCELLED@REQUESTED→无事件

- [ ] **Step 1: 写失败测试**

```ts
// server/test/ledger-write.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { startWsServer } from './helpers/ws-server.js'
import { createTask, transitionTask, getTask, scanTimeouts } from '../src/core/tasks.js'

let srv: Awaited<ReturnType<typeof startWsServer>> | null = null
afterEach(async () => { await srv?.close(); srv = null })
const events = () => srv!.db.prepare('SELECT * FROM ledger_events ORDER BY id').all() as any[]
const budget = { amount: 1000, currency: 'credit' }

describe('ledger write matrix', () => {
  it('accept→agreed; completed→settled (preceded by agreed)', async () => {
    srv = await startWsServer()
    srv.mk('alice.dev'); srv.mk('bob.ops')
    const t = createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'a', budget }).task
    expect(t.budget_amount).toBe(1000); expect(t.budget_currency).toBe('credit')
    expect(events()).toEqual([]) // REQUESTED 无事件
    transitionTask(srv.db, srv.bus, t.id, 'bob.ops', { kind: 'accept' })
    transitionTask(srv.db, srv.bus, t.id, 'bob.ops', { kind: 'result', status: 'completed', result: 'ok' })
    expect(events().map(e => e.type)).toEqual(['agreed', 'settled'])
    expect(events()[1].payer).toBe('alice.dev'); expect(events()[1].payee).toBe('bob.ops'); expect(events()[1].amount).toBe(1000)
  })
  it('failed/timeout/cancel@running → voided (amount 0); settled/voided mutually exclusive', async () => {
    srv = await startWsServer()
    srv.mk('alice.dev'); srv.mk('bob.ops')
    const f = createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'a', budget }).task
    transitionTask(srv.db, srv.bus, f.id, 'bob.ops', { kind: 'accept' })
    transitionTask(srv.db, srv.bus, f.id, 'bob.ops', { kind: 'result', status: 'failed', error: 'e' })
    const t2 = createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'a', budget }).task
    transitionTask(srv.db, srv.bus, t2.id, 'bob.ops', { kind: 'accept' })
    srv.db.prepare(`UPDATE tasks SET deadline='2020-01-01T00:00:00Z' WHERE id=?`).run(t2.id)
    scanTimeouts(srv.db, srv.bus, new Date('2020-01-02T00:00:00Z'))
    const c = createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'a', budget }).task
    transitionTask(srv.db, srv.bus, c.id, 'bob.ops', { kind: 'accept' })
    transitionTask(srv.db, srv.bus, c.id, 'alice.dev', { kind: 'cancel' })
    for (const id of [f.id, t2.id, c.id]) {
      const evs = events().filter(e => e.task_id === id)
      expect(evs.map(e => e.type)).toEqual(['agreed', 'voided'])
      expect(evs[1].amount).toBe(0)
    }
  })
  it('REJECTED / policy / EXPIRED / cancel@REQUESTED / no-budget produce zero events', async () => {
    srv = await startWsServer()
    srv.mk('alice.dev'); srv.mk('bob.ops'); srv.mk('carol.io') // r1-C3：carol.io 必须先注册，否则 createTask 在 getAgent 处 404
    const rej = createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'a', budget }).task
    transitionTask(srv.db, srv.bus, rej.id, 'bob.ops', { kind: 'reject', note: 'x' })
    srv.db.prepare(`UPDATE agents SET task_policy='{"mode":"closed","allowlist":[],"scope":"read-only"}' WHERE id='carol.io'`).run()
    createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'carol.io', action: 'a', budget })
    const exp = createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'a', budget }).task
    srv.db.prepare(`UPDATE tasks SET expires_at='2020-01-01T00:00:00Z' WHERE id=?`).run(exp.id)
    scanTimeouts(srv.db, srv.bus, new Date('2020-01-02T00:00:00Z'))
    const cr = createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'a', budget }).task
    transitionTask(srv.db, srv.bus, cr.id, 'alice.dev', { kind: 'cancel' })
    const nb = createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'a' }).task
    transitionTask(srv.db, srv.bus, nb.id, 'bob.ops', { kind: 'accept' })
    transitionTask(srv.db, srv.bus, nb.id, 'bob.ops', { kind: 'result', status: 'completed', result: 'ok' })
    expect(events()).toEqual([])
  })
  it('atomicity: ledger failure rolls back task status (fault injection)', async () => {
    srv = await startWsServer()
    srv.mk('alice.dev'); srv.mk('bob.ops')
    const t = createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'a', budget }).task
    transitionTask(srv.db, srv.bus, t.id, 'bob.ops', { kind: 'accept' })
    const orig = srv.db.prepare.bind(srv.db)
    ;(srv.db as any).prepare = (sql: string, ...rest: unknown[]) => { if (sql.includes('ledger_events')) throw new Error('inject') ; return (orig as any)(sql, ...rest) }
    expect(() => transitionTask(srv.db, srv.bus, t.id, 'bob.ops', { kind: 'result', status: 'completed', result: 'ok' })).toThrow('inject')
    ;(srv.db as any).prepare = orig
    expect(getTask(srv.db, t.id).status).toBe('RUNNING') // 回滚，无 settled 也无状态变更
  })
  it('budget validation: amount bounds, currency length', async () => {
    srv = await startWsServer()
    srv.mk('alice.dev'); srv.mk('bob.ops')
    expect(() => createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'a', budget: { amount: 0 } })).toThrow()
    expect(() => createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'a', budget: { amount: 10 ** 13 + 1 } })).toThrow()
    expect(() => createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'a', budget: { amount: 5, currency: 'x'.repeat(17) } })).toThrow()
    const ok = createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'a', budget: { amount: 5 } }).task
    expect(ok.budget_currency).toBe('credit')
  })
})
```

- [ ] **Step 2: 跑红** — Run: `cd server && npx vitest run test/ledger-write.test.ts`  Expected: FAIL

- [ ] **Step 3: 实现**

`core/ledger.ts`：
```ts
import type { Db } from '../db/sqlite.js'
import { audit } from './audit.js'

// append-only：事件只插入不更新；调用方必须把本函数与任务终态 UPDATE 放同一事务（spec §5.2 r1-I2）
export function writeLedgerEvent(db: Db, task: { id: string; requester: string; executor: string; budget_amount: number | null; budget_currency: string }, type: 'agreed' | 'settled' | 'voided', actor: string): void {
  if (task.budget_amount == null) return // 无预算任务零记账
  const amount = type === 'voided' ? 0 : task.budget_amount
  db.prepare('INSERT INTO ledger_events (task_id, type, payer, payee, amount, currency, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(task.id, type, task.requester, task.executor, amount, task.budget_currency, new Date().toISOString())
  audit(db, actor, `task.budget_${type}` as never, { task_id: task.id, amount, currency: task.budget_currency })
}
```
`core/tasks.ts`：import writeLedgerEvent；`Task` 加 `budget_amount: number | null; budget_currency: string`；createTask input 加 `budget?: { amount: number; currency?: string; note?: string }`，校验：
```ts
  if (input.budget !== undefined) {
    if (!Number.isInteger(input.budget.amount) || input.budget.amount < 1 || input.budget.amount > 10 ** 13) throw Errors.invalidRequest('budget.amount must be integer 1..1e13')
    if ((input.budget.currency ?? 'credit').length > 16) throw Errors.invalidRequest('budget.currency too long: max 16')
    if ((input.budget.note ?? '').length > 256) throw Errors.invalidRequest('budget.note too long: max 256')
  }
```
task 对象与 INSERT 加 `budget_amount: input.budget?.amount ?? null`、`budget_currency: input.budget?.currency ?? 'credit'`。
transitionTask 各分支改事务包裹（以 accept 为例，其余同型）：
```ts
    case 'accept':
      require(actor === t.executor, Errors.forbidden('forbidden: only executor can accept'))
      require(t.status === 'REQUESTED', Errors.conflict(`conflict: cannot accept from ${t.status}`))
      next = { ...t, status: 'RUNNING', accepted_at: now, deadline: new Date(Math.min(Date.now() + t.max_duration_s * 1000, absCap)).toISOString() }
      db.transaction(() => {
        db.prepare('UPDATE tasks SET status=?, accepted_at=?, deadline=? WHERE id=?').run(next.status, now, next.deadline, t.id)
        writeLedgerEvent(db, next, 'agreed', actor)
        audit(db, actor, 'task.accepted', { task_id: t.id })
      })(); break
```
reject：无 ledger（pre-accept）；cancel：`writeLedgerEvent(db, next, 'voided', actor)`——**仅在 `t.status === 'RUNNING'` 时**（pre-accept cancel 无 agreed，不写：`if (t.status === 'RUNNING') writeLedgerEvent(...)`）；result：completed→`'settled'`、failed→`'voided'`（用 next.status 判断）。finalize 同样改事务包裹：TIMEOUT→`writeLedgerEvent(db, {...row, budget_amount: <查询>, budget_currency}, 'voided', 'server')`——finalize 的 row 目前只查 id/requester/executor，须改为 `SELECT id, requester, executor, budget_amount, budget_currency FROM tasks WHERE ...` 两处扫描查询同步加列；EXPIRED 无写。
（audit union 加三个 `'task.budget_*'` 字面量；`as never` cast 可去除。）

`routes/tasks.ts` POST schema properties 加 `budget: { type: 'object', properties: { amount: { type: 'integer', minimum: 1, maximum: 10000000000000 }, currency: { type: 'string', maxLength: 16 }, note: { type: 'string', maxLength: 256 } }, required: ['amount'] }`。

- [ ] **Step 4: 跑绿 + 回归** — Run: `cd server && npx vitest run test/ledger-write.test.ts test/task-*.test.ts test/webhook.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add server/src server/test/ledger-write.test.ts
git commit -m "feat: task budget protocol with append-only ledger (transactional writes)"
```

---

### Task 11: ledger 查询端点

**Files:**
- Modify: `server/src/core/ledger.ts`（查询函数）、`server/src/http/app.ts`、Create: `server/src/http/routes/ledger.ts`
- Test: `server/test/ledger-query.test.ts`

**Interfaces:**
- Produces: `listLedger(db, me, q: { role?: 'payer' | 'earner'; limit?: number; before?: string }): LedgerEvent[]`（`payer=me` / `payee=me`，id 倒序游标）
- Produces: `ledgerSummary(db, me): { counterparty: string; currency: string; settled_total: number; pending_total: number }[]`——pending = agreed − settled（voided 计 0，天然扣除）
- Produces: `GET /v1/ledger`、`GET /v1/ledger/summary`（auth + history 桶）

- [ ] **Step 1: 写失败测试**

```ts
// server/test/ledger-query.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { startWsServer } from './helpers/ws-server.js'
import { createTask, transitionTask } from '../src/core/tasks.js'

let srv: Awaited<ReturnType<typeof startWsServer>> | null = null
afterEach(async () => { await srv?.close(); srv = null })
const H = (t: string) => ({ authorization: `Bearer ${t}` })
const lifecycle = (budget: { amount: number; currency?: string }, result: 'completed' | 'failed' = 'completed') => {
  const t = createTask(srv!.db, srv!.bus, srv!.cfg, 'alice.dev', { to: 'bob.ops', action: 'a', budget }).task
  transitionTask(srv!.db, srv!.bus, t.id, 'bob.ops', { kind: 'accept' })
  transitionTask(srv!.db, srv!.bus, t.id, 'bob.ops', { kind: 'result', status: result, result: 'ok' })
  return t
}

describe('ledger query', () => {
  it('role filter + cursor style (id desc)', async () => {
    srv = await startWsServer()
    const a = srv.mk('alice.dev'), b = srv.mk('bob.ops')
    lifecycle({ amount: 100 }); lifecycle({ amount: 50 }, 'failed'); lifecycle({ amount: 70 })
    const payer = (await srv.app.inject({ method: 'GET', url: '/v1/ledger?role=payer', headers: H(a.token) })).json()
    expect(payer.length).toBe(6); expect(payer[0].type).toBe('settled') // 最新任务的事件在前
    const earner = (await srv.app.inject({ method: 'GET', url: '/v1/ledger?role=earner&limit=2', headers: H(b.token) })).json()
    expect(earner.length).toBe(2)
    const page2 = (await srv.app.inject({ method: 'GET', url: `/v1/ledger?role=earner&limit=2&before=${earner[1].id}`, headers: H(b.token) })).json()
    expect(page2.length).toBe(2); expect(page2[0].id).toBeLessThan(earner[1].id)
  })
  it('summary aggregates per counterparty and currency', async () => {
    srv = await startWsServer()
    const a = srv.mk('alice.dev'); srv.mk('bob.ops')
    lifecycle({ amount: 100 }); lifecycle({ amount: 60 }); lifecycle({ amount: 30 }, 'failed'); lifecycle({ amount: 5, currency: 'usd-cent' })
    const s = (await srv.app.inject({ method: 'GET', url: '/v1/ledger/summary', headers: H(a.token) })).json()
    const credit = s.find((x: any) => x.currency === 'credit')
    expect(credit).toMatchObject({ counterparty: 'bob.ops', settled_total: 160, pending_total: 0 }) // 30 的 voided 不算在途（r1-C2）
    expect(s.find((x: any) => x.currency === 'usd-cent').settled_total).toBe(5)
  })
})
```

- [ ] **Step 2: 跑红** — Run: `cd server && npx vitest run test/ledger-query.test.ts`  Expected: FAIL

- [ ] **Step 3: 实现**

`core/ledger.ts` 追加：
```ts
export interface LedgerEvent { id: number; task_id: string; type: 'agreed' | 'settled' | 'voided'; payer: string; payee: string; amount: number; currency: string; created_at: string }
export function listLedger(db: Db, me: string, q: { role?: 'payer' | 'earner'; limit?: number; before?: string }): LedgerEvent[] {
  const col = q.role === 'earner' ? 'payee' : 'payer'
  const where = `${col}=?${q.before ? ' AND id < ?' : ''}`
  const args = q.before ? [me, q.before, q.limit ?? 50] : [me, q.limit ?? 50]
  return db.prepare(`SELECT * FROM ledger_events WHERE ${where} ORDER BY id DESC LIMIT ?`).all(...args) as LedgerEvent[]
}
export function ledgerSummary(db: Db, me: string) {
  // r1-C2：voided 行金额为 0 但其 agreed 行仍是原值，不能靠金额轧差——在途 = agreed 且该任务尚无终局事件（settled/voided）
  return db.prepare(`SELECT CASE WHEN payer=? THEN payee ELSE payer END AS counterparty, currency,
    SUM(CASE WHEN le.type='settled' THEN le.amount ELSE 0 END) AS settled_total,
    SUM(CASE WHEN le.type='agreed' AND NOT EXISTS (SELECT 1 FROM ledger_events v WHERE v.task_id=le.task_id AND v.type IN ('settled','voided')) THEN le.amount ELSE 0 END) AS pending_total
    FROM ledger_events le WHERE payer=? OR payee=? GROUP BY 1, 2 ORDER BY counterparty`).all(me, me, me)
}
```
`http/routes/ledger.ts`（新，auth + checkHistory + audit 限流记录，模式同 history 路由）注册两个 GET；`app.ts` 在 bus 分支内 `registerLedgerRoutes(app, { db, cfg, limiter })`（两个 GET 均不需要 bus——r1-M-h）。

- [ ] **Step 4: 跑绿** — Run: `cd server && npx vitest run test/ledger-query.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add server/src server/test/ledger-query.test.ts
git commit -m "feat: ledger query endpoints (events + per-counterparty summary)"
```

---

### Task 12: CLI + SKILL.md 更新

**Files:**
- Modify: `skills/agentlink/im.mjs`、`skills/agentlink/SKILL.md`、`server/test/skill-doc.test.ts`、`server/test/cli-smoke.test.ts`

**Interfaces:**
- Consumes: Task 2/4/6/7/11 的端点
- Produces（CLI）：`im send <peer> <text> [--thread T]`；`im inbox [--wait N] [--thread T]`；`im history [peer] [--thread T]`（peer 可缺省）；`im task show <id>` 输出任务 + events 时间线；`im review <id> <1-5> [comment...]`；`im webhook set <url> | off | test`；`im ledger [--role payer|earner] [--summary]`
- Produces（SKILL.md）：命令表补 `--thread`/`im review`/`im ledger`/`im webhook`；礼仪补「带 result_schema 的任务 result 必须是 JSON」「重交期间 heartbeat 不中断」

- [ ] **Step 1: 写失败测试**

`server/test/skill-doc.test.ts` 断言块追加：
```ts
    expect(skill).toMatch(/--thread/)
    expect(skill).toMatch(/im review/)
    expect(skill).toMatch(/im ledger/)
    expect(skill).toMatch(/im webhook/)
    expect(skill).toMatch(/result_schema|JSON/) // schema 任务 result 须 JSON
```
`server/test/cli-smoke.test.ts` 追加用例：
```ts
  it('thread round-trip and review via cli', async () => {
    await im(['send', 'bob.ops', 'in thread', '--thread', 't-cli'], tokenA)
    const h = await im(['history', 'bob.ops', '--thread', 't-cli'], tokenB)
    expect(h.stdout).toContain('in thread')
    const send = await im(['task', 'send', 'bob.ops', 'cli work'], tokenA)
    const taskId = JSON.parse(send.stdout).id
    await im(['task', 'accept', taskId], tokenB)
    await im(['task', 'result', taskId, 'done'], tokenB)
    expect((await im(['task', 'show', taskId], tokenA)).stdout).toContain('task.accepted') // 时间线含事件
    expect((await im(['review', taskId, '5', 'nice'], tokenA)).status).toBe(0)
    expect((await im(['ledger', '--summary'], tokenA)).stdout).toContain('[]') // 无预算任务 → 空账
  })
  it('webhook set/off via cli', async () => {
    const set = await im(['webhook', 'set', 'http://127.0.0.1:9/x'], tokenA) // SSRF 默认拒绝在投递时，set 本身成功
    expect(set.status).toBe(0); expect(set.stdout).toContain('wl_')
    expect((await im(['webhook', 'off'], tokenA)).status).toBe(0)
  })
```

- [ ] **Step 2: 跑红** — Run: `cd server && npx vitest run test/skill-doc.test.ts test/cli-smoke.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`im.mjs`：
- `send`：body 加 `thread_id: flags.thread`（undefined 时 JSON.stringify 自动省略——注意 api() 的 body 序列化会保留 undefined 键？`JSON.stringify` 丢弃 undefined 值，安全）
- `inbox`：URL 追加 `${flags.thread ? `&thread_id=${encodeURIComponent(flags.thread)}` : ''}`
- `history`/`chat`：`peer` 由 `rest[0]` 改为可选（`rest[0] ? \`peer=${rest[0]}&\` : ''`）+ `--thread` 追加
- `task show`：`const [task, events] = await Promise.all([api(\`/tasks/${id}\`), api(\`/tasks/${id}/events\`)]); out({ task, events })`
- 新命令：
```js
  review: async () => { const [id, rating, ...comment] = rest; out(await api(`/tasks/${id}/review`, { method: 'POST', body: { rating: Number(rating), comment: comment.join(' ') || undefined } })) },
  // r1-I8：webhook 加入 sub 判定后，`im webhook off` 解析为 sub='off'、rest=[]——必须按 sub 分发，不能读 rest[0]
  webhook: async () => {
    if (sub === 'off') return out(await api('/me', { method: 'PATCH', body: { webhook_url: '' } }))
    if (sub === 'test') { await api('/webhook/test', { method: 'POST', body: {} }); return out('test event queued') }
    if (sub === 'set') return out(await api('/me', { method: 'PATCH', body: { webhook_url: rest[0] } }))
    die('usage: im webhook set <url> | off | test')
  },
  ledger: async () => out(await api(flags.summary ? '/ledger/summary' : `/ledger?role=${flags.role ?? 'payer'}${flags.before ? `&before=${flags.before}` : ''}`)),
```
  并把 `sub` 的判定命令集合从 `token|task` 扩为 `token|task|webhook`（第 18-19 行）。
- usage 提示行同步补 `review ledger webhook`。

`SKILL.md`：常用命令节补一行 `- 线程与记账：\`im send <peer> <text> --thread <t>\`（多话题并行不串流）、\`im review <task-id> <1-5> [评语]\`（给交付打分）、\`im ledger --summary\`（查账）、\`im webhook set <url>\`（任务事件通知到你的服务器）`；协作礼仪补 `5. 带 result_schema 的任务，result 必须是符合 schema 的 JSON；被 422 退回后修好重交，期间 heartbeat 不中断。`。既有断言内容不动。

- [ ] **Step 4: 跑绿** — Run: `cd server && npx vitest run test/skill-doc.test.ts test/cli-smoke.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add skills server/test
git commit -m "feat: cli threads/review/ledger/webhook commands and skill doc updates"
```

---

### Task 13: MCP 跟随

**Files:**
- Modify: `mcp/src/index.ts`
- Test: `mcp/test/mcp.test.ts`（追加）

**Interfaces:**
- Produces: `im_send` 加可选 `thread_id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/).optional()`；`im_history` 的 `peer` 改 optional + 可选 `thread_id`；其余工具响应为透传，reputation/budget 字段自动带出（零改动）
- Consumes: Task 2 端点

- [ ] **Step 1: 写失败测试（在 mcp.test.ts 追加）**

```ts
it('im_send tool schema accepts thread_id', async () => {
  // 按既有 mcp.test.ts 的 fixture 接入：该文件已有 `const { client } = await startClient(...)`（或等价）与
  // `await client.listTools()`（mcp/test/mcp.test.ts:23），追加用例沿用同一 client，不新建框架。
  const { tools } = await client.listTools()
  const send = tools.find((t: any) => t.name === 'im_send')
  expect(JSON.stringify(send.inputSchema)).toContain('thread_id')
})
```

- [ ] **Step 2: 跑红** — Run: `cd mcp && npx vitest run`  Expected: FAIL

- [ ] **Step 3: 实现**

`mcp/src/index.ts`：`im_send` 参数加 `thread_id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/).optional()`，body 加 `thread_id`；`im_history` 参数 `peer: z.string().optional()`、加 `thread_id: z.string().optional()`，URL 组装改为 `const qs = new URLSearchParams(); if (peer) qs.set('peer', peer); if (thread_id) qs.set('thread_id', thread_id); qs.set('limit', String(limit))`；描述补一句 `Optionally scope to a thread_id.`。不加新工具。

- [ ] **Step 4: 跑绿** — Run: `cd mcp && npx vitest run`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add mcp
git commit -m "feat: mcp thread support on im_send/im_history"
```

---

### Task 14: 文档 + 全量回归

**Files:**
- Modify: `README.md`、`docs/deploy.md`
- Test: 无新增（跑全量）

**Interfaces:**
- Consumes: 全部前序任务
- Produces: README 增补 v1.1 特性速览（threads/reputation/review/result_schema/budget+ledger/webhook 各一行 + 端点表新行）；deploy.md 增补：`WEBHOOK_ALLOW_PRIVATE`（含「放开后 webhook/test 失去私网防护」警示）、`RATE_LIMIT_WEBHOOK_TEST_PER_MIN`、webhook 接收方须知（验签 HMAC-SHA256、`ts` ±5min 防重放、secret 仅显示一次须即存）、迁移说明（user_version 0→2 自动、不承诺降级、升级前备份库文件）

- [ ] **Step 1: 更新 README**

在 API 概览表加行：`GET /tasks/{id}/events`、`POST /tasks/{id}/review`、`GET /ledger`、`GET /ledger/summary`、`POST /webhook/test`；`POST /messages`/`GET /history`/`GET /inbox` 行补 `thread_id`；消息/任务行补 `result_schema`/`budget`。新增「v1.1 新特性」小节（五特性各 1-2 行 + CLI 示例一条 `im send peer "hi" --thread ops-incident`）。

- [ ] **Step 2: 更新 docs/deploy.md**

按 Interfaces 清单逐项写（环境变量表 + webhook 接收方安全须知 + 迁移小节）。

- [ ] **Step 3: 全量回归**

Run: `npm test`（仓库根，全工作区） && `docker compose config -q`（需 `REGISTRATION_CODE=x`）
Expected: server + mcp 全 PASS；compose 配置合法

- [ ] **Step 4: 提交**

```bash
git add README.md docs/deploy.md
git commit -m "docs: v1.1 features, webhook ops guide, migration notes"
```

---

## 计划自审清单（r1 修订后）

1. **Spec 覆盖**：§1 thread（T2）｜§2.1 events（T4）§2.2 webhook（T5/T6）§2.3 CLI（T12）｜§3 reputation（T3）+ review（T7）｜§4 result_schema（T8/T9）｜§5 budget/ledger（T10/T11）｜§6 迁移（T1）｜§7 API 表（各任务+T14）｜§8 横切（audit union 分任务扩、限流归属各任务、MCP T13、SKILL T12）｜§9 兼容（T1 迁移、T2 字段始终存在）｜§10 里程碑：M1=T1-T3、M2=T4-T6、M3=T7-T9、M4=T10-T14 ｜§11 五钉：钉1→T2、钉2→T5（含重定向复检+ipIsPrivate 矩阵）/T6、钉3→T8/T9（含心跳停摆 TIMEOUT 腿）、钉4→T10、钉5→T3/T7。无缺口。
2. **占位符**：r1 修订删除了 T5 骨架示意块（原「完整版为准确认」声明因骨架自身有 C1/C4 错不成立）；T13 测试按既有 client fixture 给出可抄代码。无 TBD/TODO/「适当处理」。
3. **类型一致性**：`TaskHooks`（T6 定义）在 T9/T10 沿用可选参数不破坏 v1 调用；`WebhookDispatcher.notify` 签名 T5 定义、T6 挂点一致；`Reputation`/`emptyReputation`（T3 定义导出）与 review 字段（T7 写入侧）、directory 消费闭环；`writeLedgerEvent`（T10）入参为结构化 row 避免 tasks↔ledger 循环 import；`THREAD_ID_RE` 在 core/send route/MCP 三处一致；`ipIsPrivate`（T5 导出）供 hop 级单测。
4. **Review Focus**：五钉全部有具体测试代码落在 owner 任务，钉 2/钉 3 的缺失腿已在 r1 修订补齐。
5. **已知裁量（执行者照做不再问）**：review/`task.reviewed` 与 `task.budget_*` 进 audit union 是 spec §8 列举之外的必要扩展（v1 审计红线精神）；`result_schema` 以字符串原样返回（不二次 parse）；`im history` CLI peer 可选与 REST 对齐；T9 第二用例对 deadline 人工回拨的时序断言取 `['COMPLETED','TIMEOUT']` 包含式（扫描器与提交的先后由实现时序决定，两种都合法）；r1-M-c 的 close() 丢弃记 audit 已按 spec §8 改为记 `webhook.failed {dropped, reason:'shutdown'}`（原「静默丢弃」裁量撤销）。

## critic r1 修订记录（2026-09-30）

按 `critic-plan-v1.1-r1.md`（5C/6I/8M）修订：C1 retry 计数语义、C2 ledgerSummary 在途轧差、C3 carol.io 注册（并自查推广到 T6/T9/T10/T11 全部直接调 core 的用例补 `srv.mk`）、C4 500 listener、C5 PATCH schema 补 webhook_url、I6 聚合计数正则、I7 ALREADY_REVIEWED 走 AppError、I8 CLI webhook 按 sub 分发、I9 心跳停摆 TIMEOUT 腿、I10 重定向复检用例、I11 bodies beforeEach 清零+精确计数、M-a/b/d/e/f/h 全部采纳；M-c 由裁量撤销改为按 spec §8 记 audit；M-g 直接给干净代码（删自引用 import）。
